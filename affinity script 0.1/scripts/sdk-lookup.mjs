// ============================================================================
// sdk-lookup.mjs —— 检索本机 Affinity SDK（Resources\JSLib）
//
// 用法：
//   node sdk-lookup.mjs convertToCurves              # 找符号出现在哪个模块
//   node sdk-lookup.mjs --grep "isText.*Node"        # 正则搜索（唯一允许正则的地方）
//   node sdk-lookup.mjs --members nodes.js Node      # 列出某个类的全部成员
//   node sdk-lookup.mjs --files                      # 列出所有 SDK 模块
//   node sdk-lookup.mjs --index <out.md>             # 生成符号索引文档
//   node sdk-lookup.mjs --stats                      # 统计信息
//
// 设计原则：任何 API 疑问都查这里，不要猜。签名要连同**所属类**一起确认，
// 因为同名方法可能出现在多个类里。
//
// ── v0.4 修复清单 ────────────────────────────────────────────────────────────
//   S1 用户输入的符号名不再直接拼进 RegExp（`foo(` 会抛 SyntaxError，
//      `a*` 会被当通配符返回一堆无关结果）。只有 --grep 才允许正则。
//   S2 目录/文件不存在、读取失败、正则非法都有明确报错与退出码
//   S3 退出码统一：0 成功 / 1 运行失败 / 2 参数错误
//   S4 缓存文件列表与文本，一次运行不重复读盘
//
// 退出码: 0 成功 / 1 运行失败 / 2 参数错误
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    EXIT, UsageError, RunError, parseArgs, escapeRegExp, tryCompileRegExp, runMain,
} from './lib/cli.mjs';
import { stripNonCode, stripComments, extractExportNames } from './lib/lex.mjs';

const USAGE = `用法:
  node sdk-lookup.mjs <符号名>
  node sdk-lookup.mjs --grep "<正则>"
  node sdk-lookup.mjs --members <模块.js> [类名]
  node sdk-lookup.mjs --files
  node sdk-lookup.mjs --index <输出.md>
  node sdk-lookup.mjs --stats

选项:
  --grep <正则>     正则搜索（唯一允许正则的入口）
  --members <模块> [类名]  列出模块里某个类（或全部类）的成员
  --files           列出所有 SDK 模块文件
  --index <路径>    生成符号 → 模块反查索引文档
  --stats           打印 SDK 规模统计
  -h, --help        显示本帮助

环境变量 AFFINITY_JSLIB 可指定 JSLib 目录。
退出码: 0 成功 / 1 运行失败 / 2 参数错误`;

// ---------------------------------------------------------------------------
// SDK 定位
// ---------------------------------------------------------------------------

function findSdkRoot() {
    //用户**显式**指定的路径：即使不存在也必须直接报错。
    // 原实现把它和默认候选混在一起遍历，于是用户设错了 AFFINITY_JSLIB 时会
    // 静默回退到本机真实安装目录 —— 看起来"成功"，实际检索的是别的 SDK，
    // 结论会完全错位。这属于必须暴露的错误。
    const explicit = process.env.AFFINITY_JSLIB;
    if (explicit) {
        let st = null;
        try { st = fs.statSync(explicit); } catch { /* 下面统一报错 */ }
        if (!st) {
            throw new RunError(`环境变量 AFFINITY_JSLIB 指向的目录不存在: ${explicit}`,
                '修正该变量，或删除它以改用默认安装路径');
        }
        if (!st.isDirectory()) {
            throw new RunError(`AFFINITY_JSLIB 不是目录: ${explicit}`);
        }
        return explicit;
    }

    const candidates = [
        String.raw`C:\Program Files\Affinity\Affinity\Resources\JSLib`,
        '/Applications/Affinity Designer 2.app/Contents/Resources/JSLib',
        '/Applications/Affinity.app/Contents/Resources/JSLib',
    ].filter(Boolean);
    for (const c of candidates) {
        try { if (fs.statSync(c).isDirectory()) return c; } catch { /* next */ }
    }
    throw new RunError('找不到 JSLib 目录',
        '设置环境变量 AFFINITY_JSLIB 指向 SDK 目录，或用 --help 看候选路径');
}

function listJs(dir) {
    try {
        return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
    } catch { return []; }
}

// ---------------------------------------------------------------------------
// 类成员提取（花括号配对，跳过注释与字符串里的括号）
// ---------------------------------------------------------------------------

function classBody(src, className) {
    // S1：类名来自用户输入 → 必须转义
    const re = new RegExp(`^class\\s+${escapeRegExp(className)}\\s+(?:extends\\s+[\\w.]+\\s*)?\\{`, 'm');
    const m = re.exec(src);
    if (!m) return null;
    const i = m.index + m[0].length - 1;
    // 跳过注释/字符串，否则里面的 '{' '}' 会打乱配对
    const text = stripNonCode(src);
    let depth = 0;
    for (let j = i; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(i + 1, j); }
    }
    return null;
}

function membersOf(body) {
    const out = [];
    const seen = new Set();
    const push = (kind, name) => {
        const key = `${kind} ${name}`;
        if (!seen.has(key)) { seen.add(key); out.push({ kind, name }); }
    };
    for (const m of body.matchAll(/^\s*(?:static\s+)?get\s+([A-Za-z_$][\w$]*)\s*\(/gm)) push('get', m[1]);
    for (const m of body.matchAll(/^\s*(?:static\s+)?set\s+([A-Za-z_$][\w$]*)\s*\(/gm)) push('set', m[1]);
    for (const m of body.matchAll(/^\s*(static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
        if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function'].includes(m[2])) continue;
        push(m[1] ? 'static' : 'method', m[2]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
    const argv = process.argv.slice(2);
    // --help 先于参数校验处理
    if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
        console.log(USAGE);
        return EXIT.OK;
    }
    const p = parseArgs(argv, {
        flags: ['files', 'stats'],
        values: ['grep', 'members', 'index', 'class', 'limit'],
        maxPositional: 1,
    });
    const flags = p.flags, v = p.values;

    const ROOT = findSdkRoot();
    const CORE = listJs(ROOT);
    const EXAMPLES = listJs(path.join(ROOT, 'examples'));
    const TESTS = listJs(path.join(ROOT, 'tests'));
    const ALL = [
        ...CORE.map((f) => ({ f, dir: ROOT, group: 'core' })),
        ...EXAMPLES.map((f) => ({ f, dir: path.join(ROOT, 'examples'), group: 'examples' })),
        ...TESTS.map((f) => ({ f, dir: path.join(ROOT, 'tests'), group: 'tests' })),
    ];

    // S4：文本缓存，一次运行不重复读盘
    const textCache = new Map();
    const read = (entry) => {
        const key = entry.dir + '\\' + entry.f;
        if (!textCache.has(key)) {
            try { textCache.set(key, fs.readFileSync(path.join(entry.dir, entry.f), 'utf8')); }
            catch (e) { textCache.set(key, ''); throw new RunError(`读取失败: ${key} —— ${e.message}`); }
        }
        return textCache.get(key);
    };
    const readSafe = (entry) => { try { return read(entry); } catch { return ''; } };

    if (flags.has('files')) {
        console.log('SDK 根目录：' + ROOT);
        console.log(`\n=== 核心模块 (${CORE.length}) ===`);
        console.log(CORE.join(', '));
        console.log(`\n=== 官方示例 (${EXAMPLES.length}) ===`);
        console.log(EXAMPLES.join(', '));
        console.log(`\n=== 自测脚本 (${TESTS.length}) ===`);
        console.log(TESTS.join(', '));
        return EXIT.OK;
    }

    if (flags.has('stats')) {
        let bytes = 0;
        for (const e of ALL) { try { bytes += fs.statSync(path.join(e.dir, e.f)).size; } catch { /* skip */ } }
        console.log(`SDK 根目录: ${ROOT}`);
        console.log(`核心模块: ${CORE.length}   示例: ${EXAMPLES.length}   自测: ${TESTS.length}`);
        console.log(`合计 ${ALL.length} 个文件，${(bytes / 1048576).toFixed(2)} MB`);
        return EXIT.OK;
    }

    // ---- --members ----
    if (v.members !== undefined) {
        const moduleName = v.members;
        const entry = ALL.find((e) => e.f === moduleName);
        if (!entry) throw new RunError(`找不到模块：${moduleName}`, '用 --files 看实际文件名');
        const src = stripComments(read(entry));
        const classes = [...src.matchAll(/^class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([\w.$]+))?/gm)]
            .map((m) => ({ name: m[1], base: m[2] || null }));
        if (!classes.length) {
            console.log(`模块 ${moduleName} 里没有识别到 class 声明。`);
            return EXIT.OK;
        }
        const want = v.class ?? p.positional[0] ?? null;
        const targets = want ? classes.filter((c) => c.name === want) : classes;
        if (want && targets.length === 0) {
            throw new RunError(`模块 ${moduleName} 里没有类 ${want}`,
                `现有类：${classes.map((c) => c.name).join(', ')}`);
        }
        for (const c of targets) {
            console.log(`\n=== class ${c.name}${c.base ? ' extends ' + c.base : ''}  (${moduleName}) ===`);
            const body = classBody(src, c.name);
            if (!body) { console.log('  (无法解析类体)'); continue; }
            const ms = membersOf(body);
            const by = (k) => ms.filter((m) => m.kind === k).map((m) => m.name);
            const g = by('get'), s = by('set'), st = by('static'), me = by('method');
            if (g.length) console.log('  get:    ' + g.join(', '));
            if (s.length) console.log('  set:    ' + s.join(', '));
            if (st.length) console.log('  static: ' + st.join(', '));
            if (me.length) console.log('  method: ' + me.join(', '));
            if (!ms.length) console.log('  (未识别到成员)');
        }
        return EXIT.OK;
    }

    // ---- --grep（唯一允许正则的入口）----
    if (v.grep !== undefined) {
        const re = tryCompileRegExp(v.grep, 'i');
        let hits = 0;
        const limit = v.limit ? Number(v.limit) : 400;
        if (!Number.isInteger(limit) || limit <= 0) throw new UsageError('--limit 必须是正整数');
        for (const e of ALL) {
            const lines = readSafe(e).split('\n');
            const found = [];
            lines.forEach((l, i) => { if (re.test(l)) found.push(`${i + 1}: ${l.trim()}`); });
            if (found.length) {
                console.log(`\n--- ${e.group}/${e.f}  (${found.length} 处)`);
                found.slice(0, 25).forEach((l) => console.log('  ' + l));
                hits += found.length;
                if (hits > limit) { console.log('\n(结果过多，已截断。请缩小正则范围)'); break; }
            }
        }
        if (!hits) console.log('没有匹配。');
        return EXIT.OK;
    }

    // ---- --index ----
    if (v.index !== undefined) {
        const L = [];
        L.push('# Affinity SDK 符号索引');
        L.push('');
        L.push(`由 \`sdk-lookup.mjs --index\` 自动生成。来源：\`${ROOT}\``);
        L.push('');
        const symbolMap = new Map();
        for (const e of ALL) {
            const src = readSafe(e);
            const exports = [...extractExportNames(src)].sort();
            const native = [...new Set([...src.matchAll(/require\s*\(\s*['"](affinity:[a-z]+)['"]\s*\)/g)].map((m) => m[1]))].sort();
            L.push(`### ${e.group}/${e.f}`);
            L.push('- exports: ' + (exports.join(', ') || '(无)'));
            if (native.length) L.push('- native: ' + native.join(', '));
            L.push('');
            const rel = e.group === 'core' ? e.f : `${e.group}/${e.f}`;
            for (const s of exports) symbolMap.set(s, (symbolMap.get(s) || []).concat(rel));
        }
        L.push('## 符号 → 模块 反查');
        L.push('');
        for (const k of [...symbolMap.keys()].sort()) L.push(`- \`${k}\` — ${symbolMap.get(k).join(', ')}`);
        fs.writeFileSync(v.index, L.join('\n'), 'utf8');
        console.log(`已写入 ${v.index}（${symbolMap.size} 个符号）`);
        return EXIT.OK;
    }

    // ---- 默认：符号名精确查找 ----
    // S1：把用户输入当作**字面量**，不做正则
    const symbol = p.positional[0];
    if (!symbol) {
        console.log(USAGE);
        return EXIT.OK;
    }
    const sym = escapeRegExp(symbol);
    console.log(`在 SDK 中查找符号：${symbol}\n`);
    let total = 0;
    for (const e of ALL) {
        const hits = [];
        const push = (label, i) => hits.push(`${label}  (行 ${i})`);
        const lineRe = new RegExp(
            `module\\s*\\.\\s*exports\\s*\\.\\s*${sym}\\b`      // 导出
            + `|^class\\s+${sym}\\b`                            // 类定义
            + `|(?:static\\s+)?get\\s+${sym}\\s*\\(`           // getter
            + `|(?:static\\s+)?set\\s+${sym}\\s*\\(`           // setter
            + `|(?:static\\s+)?${sym}\\s*\\(\s*[\\w$]`,         // 方法/函数调用
        );
        readSafe(e).split('\n').forEach((l, i) => {
            const n = i + 1;
            if (new RegExp(`module\\s*\\.\\s*exports\\s*\\.\\s*${sym}\\b`).test(l)) push('导出', n);
            else if (new RegExp(`^class\\s+${sym}\\b`).test(l)) push('类定义', n);
            else if (new RegExp(`(?:static\\s+)?get\\s+${sym}\\s*\\(`).test(l)) push('getter', n);
            else if (new RegExp(`(?:static\\s+)?set\\s+${sym}\\s*\\(`).test(l)) push('setter', n);
            else if (lineRe.test(l)) push('方法', n);
        });
        if (hits.length) {
            console.log(`--- ${e.group}/${e.f}`);
            hits.slice(0, 12).forEach((h) => console.log('    ' + h));
            total += hits.length;
        }
    }
    if (!total) {
        console.log('未找到。建议改用 --grep 做模糊搜索，例如：');
        console.log(`  node sdk-lookup.mjs --grep "${String(symbol).slice(0, 6)}"`);
    } else {
        console.log(`\n共 ${total} 处。用 --members <模块> <类名> 看完整成员列表。`);
    }
    return EXIT.OK;
}

const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    process.exitCode = await runMain(main);
}

export { main, USAGE, classBody, membersOf };