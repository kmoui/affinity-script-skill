// ============================================================================
// lib/lex.mjs —— 轻量 JS 词法清洗
//
// 为什么需要它：原来的 validate.mjs 用正则扫描源码找 `.method(` 调用，
// 于是下面这段**注释里的示例代码**会全部变成误报：
//
//     // 记得 clearPreviews() 然后 doc.executeCommand(cmd, true)
//     const tip = "调用 fs.writeStringAsUtf8(path) 即可写入";
//
// 正则分不清「代码里的调用」和「字符串/注释里的字样」。
// 本模块用一个状态机把注释、字符串、模板字面量**替换成等长空格**，
// 保持所有偏移量不变（报错行列号仍然对得上），只留下真正的代码。
//
// 这是**词法级**而非完整 AST：能正确跳过注释/字符串/模板/正则字面量，
// 但不处理嵌套的复杂模板表达式 `${ ... }` 内部（已按保守方式处理，见下）。
//
// 依赖：零外部依赖。Node 18+。
// ============================================================================

/**
 * @param {string} src
 * @returns {string} 与 src 等长、但注释/字符串/模板/正则内容被空格替换的文本
 */
export function stripNonCode(src) {
    const out = src.split('');
    const n = src.length;
    let i = 0;

    // 记录一个「上一个有效字符」，用于消歧 `/` 到底是除号还是正则起始
    let prevSignificant = '';

    const blank = (from, to) => {
        for (let k = from; k < to && k < n; k++) {
            if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
        }
    };

    const isIdentChar = (c) => /[A-Za-z0-9_$]/.test(c);

    while (i < n) {
        const c = src[i];

        // ---- 行注释 ----
        if (c === '/' && src[i + 1] === '/') {
            const end = src.indexOf('\n', i);
            const stop = end === -1 ? n : end;
            blank(i, stop);
            i = stop;
            continue;
        }

        // ---- 块注释（含未闭合的情况）----
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end === -1 ? n : end + 2;
            blank(i, stop);
            i = stop;
            prevSignificant = ' ';   // 注释后不应再把 / 当正则起始
            continue;
        }

        // ---- 字符串：' " ----
        if (c === "'" || c === '"') {
            const quote = c;
            let j = i + 1;
            while (j < n) {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === quote) { j++; break; }
                if (src[j] === '\n') break;      // 未闭合就换行，保守退出
                j++;
            }
            blank(i, Math.min(j, n));
            i = j;
            prevSignificant = 'str';
            continue;
        }

        // ---- 模板字面量 ----
        if (c === '`') {
            let j = i + 1;
            let depth = 0;                       // 跟踪 ${ } 嵌套
            while (j < n) {
                const d = src[j];
                if (d === '\\') { j += 2; continue; }
                if (depth === 0 && d === '`') { j++; break; }
                if (depth === 0 && d === '$' && src[j + 1] === '{') { depth = 1; j += 2; continue; }
                if (depth > 0) {
                    // ${ ... } 内部：粗略处理嵌套大括号与字符串
                    if (d === '{') depth++;
                    else if (d === '}') { depth--; if (depth === 0) { j++; continue; } }
                    else if (d === "'" || d === '"') {
                        const q = d; let k = j + 1;
                        while (k < n) {
                            if (src[k] === '\\') { k += 2; continue; }
                            if (src[k] === q) { k++; break; }
                            if (src[k] === '\n') break;
                            k++;
                        }
                        blank(j, Math.min(k, n));
                        j = k; continue;
                    } else if (d === '/' && src[j + 1] === '/') {
                        const e2 = src.indexOf('\n', j); j = (e2 === -1 ? n : e2); continue;
                    } else if (d === '/' && src[j + 1] === '*') {
                        const e2 = src.indexOf('*/', j + 2); j = (e2 === -1 ? n : e2 + 2); continue;
                    }
                }
                j++;
            }
            blank(i, Math.min(j, n));
            i = j;
            prevSignificant = 'str';
            continue;
        }

        // ---- 正则字面量 ----
        // 消歧：前一个有效字符是标识符/数字/右括号/右方括号时，`/` 是除号；
        // 否则（= , : ! ? & | { } ; return 等之后）视为正则起始。
        if (c === '/' && !isIdentChar(prevSignificant) && prevSignificant !== ')' && prevSignificant !== ']') {
            let j = i + 1;
            let inClass = false;
            let closed = false;
            while (j < n) {
                const d = src[j];
                if (d === '\\') { j += 2; continue; }
                if (d === '\n') break;                 // 正则不能跨行 → 不是正则
                if (d === '[') inClass = true;
                else if (d === ']') inClass = false;
                else if (d === '/' && !inClass) { j++; closed = true; break; }
                j++;
            }
            if (closed) {
                blank(i, j);
                i = j;
                prevSignificant = 'regex';
                continue;
            }
            // 没闭合 → 就是除号，原样保留
        }

        if (!/\s/.test(c)) prevSignificant = c;
        i++;
    }

    return out.join('');
}

/**
 * 只清掉注释，**保留字符串字面量内容**。
 *
 * 与 stripNonCode 的区别：像 `exports["Quux"]`、`defineProperty(exports,"Zed")`
 * 这类模式的关键信息就在引号里面，全清掉就匹配不到了。
 * 用于「需要读出字面量内容」的正则（导出符号、require 模块名）。
 * 误报风险已由 stripNonCode 单独兜住（用于只看标识符的扫描）。
 *
 * @param {string} src
 * @returns {string} 与 src 等长，注释被替换为空格
 */
export function stripComments(src) {
    const out = src.split('');
    const n = src.length;
    let i = 0;
    const blank = (from, to) => {
        for (let k = from; k < to && k < n; k++) {
            if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
        }
    };
    while (i < n) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') {
            const e = src.indexOf('\n', i);
            const stop = e === -1 ? n : e;
            blank(i, stop); i = stop; continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const e = src.indexOf('*/', i + 2);
            const stop = e === -1 ? n : e + 2;
            blank(i, stop); i = stop; continue;
        }
        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < n) {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === c) { j++; break; }
                if (src[j] === '\n') break;
                j++;
            }
            i = j; continue;                      // 跳过整串，不动内容
        }
        if (c === '`') {
            let j = i + 1, depth = 0;
            while (j < n) {
                const d = src[j];
                if (d === '\\') { j += 2; continue; }
                if (depth === 0 && d === '`') { j++; break; }
                if (depth === 0 && d === '$' && src[j + 1] === '{') { depth = 1; j += 2; continue; }
                if (depth > 0) {
                    if (d === '{') depth++;
                    else if (d === '}') { depth--; if (depth === 0) { j++; continue; } }
                    else if (d === "'" || d === '"' || d === '`') {
                        const q = d; let k = j + 1;
                        while (k < n) {
                            if (src[k] === '\\') { k += 2; continue; }
                            if (src[k] === q) { k++; break; }
                            if (src[k] === '\n' && q !== '`') break;
                            k++;
                        }
                        j = k; continue;
                    }
                }
                j++;
            }
            i = j; continue;
        }
        if (c === '/' && !/[A-Za-z0-9_$)\]]/.test(src[i - 1] || '')) {
            let j = i + 1, inClass = false, closed = false;
            while (j < n) {
                const d = src[j];
                if (d === '\\') { j += 2; continue; }
                if (d === '\n') break;
                if (d === '[') inClass = true;
                else if (d === ']') inClass = false;
                else if (d === '/' && !inClass) { j++; closed = true; break; }
                j++;
            }
            if (closed) { i = j; continue; }      // 正则字面量整体跳过
        }
        i++;
    }
    return out.join('');
}

/**
 * 在**已清洗**的文本上做匹配，但把命中位置映射回原文的能力不需要——
 * 因为我们只取标识符名字，不取字面量内容。
 */

/** 取出所有 `require('x')` 的模块名（原文扫描，因为字符串内容必须读出来）。 */
export function extractRequires(src) {
    const out = [];
    const re = /require\s*\(\s*(['"])((?:[^'"\\]|\\.)*)\1\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[2]);
    return [...new Set(out)];
}

/**
 * 找出 `const { a, b: c } = require('mod')` 这类解构声明。
 * @returns {Array<{module:string, names:string[]}>}  names 是**本地名**（解构右侧）
 */
export function extractDestructuredRequires(src, _unused) {
    const res = [];
    // 必须用 stripComments（保留引号内容）——stripNonCode 会把 '/x.js' 抹成空格，
    // 导致整个 require(...) 匹配不上。
    const cleaned = stripComments(src);
    // 模块名直接在同一份文本里取即可（注释已排除，字符串内容保留）
    const re = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*require\s*\(\s*(['"])((?:[^'"\\]|\\.)*)\2\s*\)/g;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
        const names = m[1].split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
                const parts = s.split(':');
                return (parts[1] || parts[0]).trim();
            })
            .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
        if (names.length) res.push({ module: m[3], names, at: m.index });
    }
    return res;
}

/**
 * 提取模块文件的 CommonJS 导出符号名。覆盖常见形式：
 *   module.exports.Foo        module.exports['Foo']
 *   exports.Foo               module.exports = { Foo, bar: baz }
 *   Object.defineProperty(exports, "Foo", …)   exports["Foo"] = …
 *
 * @param {string} src 模块源码
 * @returns {Set<string>}
 */
export function extractExportNames(src) {
    const names = new Set();
    // 用 stripComments：只清注释、保留引号内容 —— 否则 exports["Quux"] 匹配不到
    const text = stripComments(src);

    // module.exports.NAME  /  exports.NAME
    for (const m of text.matchAll(/\b(?:module\.)?exports\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
        names.add(m[1]);
    }
    // module.exports['NAME'] / exports["NAME"]
    for (const m of text.matchAll(/\b(?:module\.)?exports\s*\[\s*['"]([^'"]+)['"]\s*\]/g)) {
        names.add(m[1]);
    }
    // Object.defineProperty(exports, 'NAME', …)
    for (const m of text.matchAll(/Object\.defineProperty\s*\(\s*exports\s*,\s*['"]([^'"]+)['"]/g)) {
        names.add(m[1]);
    }
    // module.exports = { a, b: c, 'd-e': f }
    for (const m of text.matchAll(/\bmodule\s*\.\s*exports\s*=\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
            const t = part.trim();
            if (!t) continue;
            const colon = t.indexOf(':');
            const key = (colon >= 0 ? t.slice(0, colon) : t).trim();
            const unquoted = key.replace(/^['"]|['"]$/g, '');
            if (/^[A-Za-z_$][\w$]*$/.test(unquoted)) names.add(unquoted);
        }
    }
    return names;
}