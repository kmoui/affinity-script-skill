#!/usr/bin/env node
// ============================================================================
// validate.mjs —— 交付前的静态校验（v0.4 重写）
//
// 在把脚本交给用户之前跑这个。它能提前抓出大部分「架构对、API 错」的问题。
//
// 用法：
//   node validate.mjs <脚本.js> [--sdk <JSLib目录>]
//
// ── v0.4 修复清单 ────────────────────────────────────────────────────────────
//   L1 CLI 重写：正确处理 --sdk 缺值、SDK 路径带空格、目标路径带空格/中文
//   L2 SDK 路径不存在时明确区分「脚本语法错误」与「SDK 不存在」
//   L3 导出符号检查覆盖 exports.X / 别名解构 / module.exports={} / 跨行写法
//   L4 词法清洗：方法扫描不再命中注释、字符串、模板字面量
//   L5 SDK 全量扫描缓存文件列表与文本，一次运行只读一遍
//   L6 缺 SDK 时给出清晰的诊断分类，不把 API 调用混进普通 warning
//   L7 陷阱检查统一为 **9 项**（此前文档声称 9 项、实现只有 7 类）
//   L8 退出码稳定：0 无错/ 1 有错 / 2 参数错误
//
// 退出码: 0 无错误 / 1 发现错误 / 2 参数错误
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
    EXIT, UsageError, RunError, parseArgs, requireExistingFile, runMain,
} from './lib/cli.mjs';
import {
    stripNonCode, stripComments, extractRequires,
    extractDestructuredRequires, extractExportNames,
} from './lib/lex.mjs';

const USAGE = `用法:
  node validate.mjs <脚本.js> [--sdk <JSLib目录>]

选项:
  --sdk <目录>   JSLib 路径（含空格/中文都可以）。
                 默认取环境变量 AFFINITY_JSLIB，其次是标准安装路径。
  -h, --help     显示本帮助

检查项：① 语法 ② SDK 符号回查 ③ 9 项已知陷阱
退出码: 0 无错误 / 1 发现错误 / 2 参数错误`;

// ---------------------------------------------------------------------------
// 标准库方法名（不算「SDK API」，否则全是噪音）
// ---------------------------------------------------------------------------
const STD = new Set([
    'push', 'map', 'filter', 'forEach', 'join', 'split', 'replace', 'test', 'match', 'toArray',
    'indexOf', 'lastIndexOf', 'includes', 'slice', 'substring', 'substr', 'trim', 'trimStart', 'trimEnd',
    'padStart', 'padEnd', 'repeat', 'charAt', 'charCodeAt', 'codePointAt', 'startsWith', 'endsWith',
    'shift', 'unshift', 'pop', 'splice', 'fill', 'flat', 'flatMap', 'findIndex', 'reduce', 'reduceRight',
    'reverse', 'at', 'find', 'findLast', 'some', 'every', 'sort', 'concat', 'keys', 'values', 'entries',
    'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'getFullYear', 'getMonth', 'getDate', 'getHours', 'getMinutes', 'getSeconds',
    'stringify', 'max', 'min', 'abs', 'round', 'floor', 'ceil', 'pow', 'sqrt', 'random',
    'info', 'warn', 'error', 'debug', 'log', 'trace', 'then', 'catch', 'finally', 'apply', 'call', 'bind',
    'hasOwnProperty', 'toString', 'valueOf', 'assign', 'freeze', 'getOwnPropertyNames',
]);

// ===========================================================================
// 9 项已知陷阱检查（每项一个函数，顺序即检查顺序，计数与文档一致）
// ===========================================================================

/** 3.1 硬编码本地化的导出预设名 */
function trapPresetName(ctx) {
    const { code } = ctx;
    if (/createWithPresetName\(\s*["'][^"']*for\s+export/i.test(code)
        || /["']SVG\s*[（(]\s*for\s+export\s*[)）]["']/i.test(code)) {
        ctx.warn('硬编码了英文导出预设名。预设名随界面语言变化，应改用 allPresetNames 运行时枚举 + 多语言正则。');
    } else if (/createWithPresetName/.test(code)) {
        if (/allPresetNames/.test(code)) ctx.ok('导出预设做了运行时枚举');
        else ctx.warn('用了 createWithPresetName 但没见 allPresetNames，确认预设名来源可靠');
    }
}

/** 3.2 把 SDK 对象当全局用 */
function trapGlobalAccess(ctx) {
    const { code } = ctx;
    for (const n of ['Document', 'Selection', 'Application', 'Environment', 'Dialog']) {
        if (new RegExp(`globalThis\\s*\\.\\s*${n}\\b|\\bwindow\\s*\\.\\s*${n}\\b`).test(code)) {
            ctx.error(`把 ${n} 当全局访问——SDK 不在 globalThis 上，必须 require`);
        }
    }
    if (/\bprocess\s*\.\s*(argv|env)\b/.test(code)) {
        ctx.warn('用了 process——Affinity 脚本环境里 process 是 undefined');
    }
}

/** 3.3 入口形态 */
function trapEntryPoint(ctx) {
    const { code } = ctx;
    const hasTopMain = /^\s*function\s+main\s*\(/m.test(code);
    const hasSelfCall = /^\s*main\s*\(\s*\)\s*;?\s*$/m.test(code);
    const hasModuleExport = /module\s*\.\s*exports\s*\.\s*main\s*=/.test(code);
    if (hasTopMain && hasSelfCall) {
        ctx.ok('入口形态 A（顶层 main + 自调用）——可导入脚本库');
    } else if (hasModuleExport) {
        ctx.warn('用了 module.exports.main。官方 preamble 明确要求不要这样写（examples 才是这么写的）');
    } else if (/require\s*\(/.test(code) && /^\s*const[\s{]/m.test(code)) {
        ctx.ok('无 main 的顶层脚本（脚本编辑器里可直接运行）');
    } else {
        ctx.warn('未识别到明确入口（既无 main() 自调用，也无 module.exports.main）');
    }
    if (hasTopMain && !hasSelfCall) {
        ctx.warn('定义了 main() 但没有自调用——脚本库里会静默什么都不做');
    }
}

/** 3.4 权限：文件读写要有 PERMISSION_DENIED 处理 */
function trapPermissionHandling(ctx) {
    const { code } = ctx;
    const writes = /\bfs\s*\.\s*\w+|doc\s*\.\s*export\s*\(|LogFile\s*\.\s*create/.test(code);
    if (writes && !/PERMISSION_DENIED/.test(code)) {
        ctx.warn('有文件读写/导出，但没见 PERMISSION_DENIED 处理。建议捕获并提示用户去 设置 ▸ 脚本 ▸ 访问文件系统 放行目录。');
    }
    if (/PERMISSION_DENIED/.test(code)) ctx.ok('处理了 PERMISSION_DENIED');
}

/** 3.5 权限预检闸门（已知会造成假阴性的反模式） */
function trapPermissionPrecheck(ctx) {
    const { code } = ctx;
    // fs.exists / existsSync 之后才 create，且失败就 return/中止 —— 实测会假阴性
    const looksLikePrecheck = /\bfs\s*\.\s*(exists|existsSync)\s*\(/.test(code)
        && /\b(fs\s*\.\s*(create|write|writeStringAsUtf8|File\s*\.\s*create))\b/.test(code)
        && /PERMISSION_DENIED|没有写入权限|无写入权限/.test(code);
    if (looksLikePrecheck && /return|exit|quit/.test(code)) {
        ctx.warn('疑似「权限预检闸门」：先 exists 再写入、失败就 return。实测会造成假阴性——正确做法是直接尝试真正要做的操作，失败后再诊断。');
    }
}

/** 3.6 对话框 vs 无人值守 */
function trapDialog(ctx) {
    const { code } = ctx;
    if (/\balert\s*\(|\bconfirm\s*\(/.test(code) && !/SHOW_ERROR_ALERT/.test(code)) {
        ctx.warn('直接调用了 alert/confirm。若要求「无对话框」，请改成 console 输出并保留一个开关。');
    }
}

/** 3.7 预览未清理 */
function trapPreviewCleanup(ctx) {
    const { code } = ctx;
    const usesPreview = /executeCommand\s*\([^)]*,\s*true\s*\)/.test(code);
    if (usesPreview && !/clearPreviews\s*\(/.test(code)) {
        ctx.error('用了预览模式但没有 clearPreviews()，预览会残留');
    } else if (usesPreview) {
        ctx.ok('预览模式配了 clearPreviews()');
    }
}

/** 3.8 File.create 没检查 isOpen */
function trapFileIsOpen(ctx) {
    const { code } = ctx;
    if (/File\s*\.\s*create\s*\(/.test(code) && !/\.isOpen\b/.test(code)) {
        ctx.error('用了 File.create 但没检查 isOpen——实测即使 open 失败它也会返回对象，不检查会静默写入失败');
    }
}

/** 3.9 非 ASCII 文件名安全 */
function trapAsciiFilename(ctx) {
    const { code } = ctx;
    if (/\bcreateWithPresetName\b/.test(code) && /allPresetNames/.test(code)) {
        ctx.ok('导出预设名来源可靠（运行时枚举）');
    }
    // 中文/空格路径在某些宿主上会 PERMISSION_DENIED
    if (/["'][^"']*[\u4e00-\u9fff][^"']*\.(svg|png|jpg|pdf)["']/i.test(code)) {
        ctx.warn('输出文件名含中文——实测部分宿主上纯 ASCII 文件名更稳，建议用时间戳式 ASCII 名并保留回退重试。');
    }
}

const TRAP_CHECKS = [
    ['硬编码本地化预设名', trapPresetName],
    ['把 SDK 对象当全局', trapGlobalAccess],
    ['入口形态', trapEntryPoint],
    ['文件权限处理', trapPermissionHandling],
    ['权限预检闸门', trapPermissionPrecheck],
    ['对话框与无人值守', trapDialog],
    ['预览未清理', trapPreviewCleanup],
    ['File.create 未检查 isOpen', trapFileIsOpen],
    ['非 ASCII 文件名安全', trapAsciiFilename],
];

// ===========================================================================
// SDK 索引（L5：一次运行只读一遍文件）
// ===========================================================================

function buildSdkIndex(sdkDir) {
    const files = [];
    const seen = new Set();
    for (const d of [sdkDir, path.join(sdkDir, 'examples'), path.join(sdkDir, 'tests')]) {
        let entries = [];
        try { entries = fs.readdirSync(d); }
        catch { continue; }                      // 子目录不存在是正常的
        for (const f of entries) {
            if (!f.endsWith('.js') || seen.has(f)) continue;
            seen.add(f);
            const p = path.join(d, f);
            try { files.push({ name: f, path: p, text: fs.readFileSync(p, 'utf8') }); }
            catch { /* 单个文件读失败不影响整体 */ }
        }
    }
    // 汇总所有被调用过的名字：`name(` 的集合。用集合避免对每个调用名
    // 都跑一次全量正则（原来是 O(调用数 × SDK 全文)）。
    const definedNames = new Set();
    for (const f of files) {
        for (const m of stripNonCode(f.text).matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
            definedNames.add(m[1]);
        }
        for (const m of f.text.matchAll(/(?:module\s*\.\s*)?exports\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
            definedNames.add(m[1]);
        }
    }
    return { files, definedNames, fileCount: files.length };
}

// ===========================================================================
// 主流程
// ===========================================================================

async function main() {
    const argv = process.argv.slice(2);
    // --help 必须在参数校验**之前**处理，否则 `validate --help` 会先报
    // 「缺少必需的位置参数」，用户永远看不到帮助。
    if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
        console.log(USAGE);
        return EXIT.OK;
    }
    const parsed = parseArgs(argv, {
        flags: ['quiet'],
        values: ['sdk'],
        maxPositional: 1,
        minPositional: 1,
    });

    const target = parsed.positional[0];
    requireExistingFile(target, '目标脚本');

    const SDK = parsed.values.sdk
        || process.env.AFFINITY_JSLIB
        || String.raw`C:\Program Files\Affinity\Affinity\Resources\JSLib`;

    const src = fs.readFileSync(target, 'utf8');
    // 只清注释（保留字符串内容，后面要读 require 的模块名）
    const code = stripComments(src);
    // 全清（注释+字符串+模板+正则）——用来找真实的代码调用
    const codeOnly = stripNonCode(src);

    let errors = 0, warnings = 0, passed = 0;
    const out = parsed.flags.has('quiet') ? () => { } : (s) => console.log(s);
    const ok = (m) => { out('  ✓ ' + m); passed++; };
    const bad = (m) => { out('  ✗ ' + m); errors++; };
    const warn = (m) => { out('  ⚠ ' + m); warnings++; };

    out(`校验：${target}`);
    out(`SDK ：${SDK}\n`);

    // ---------- 1. 语法 ----------
    out('### 1. 语法');
    let syntaxOk = true;
    try {
        new vm.Script(src, { filename: target });
        ok('语法编译通过（等价于 node --check）');
    } catch (e) {
        syntaxOk = false;
        bad('语法错误：' + e.message);
    }

    // ---------- 2. SDK 符号回查 ----------
    out('\n### 2. SDK 符号回查');
    const requires = extractRequires(src);
    const core = requires.filter((r) => r.startsWith('/') && r.endsWith('.js'));
    const native = requires.filter((r) => r.startsWith('affinity:'));
    const other = requires.filter((r) => !r.startsWith('/') && !r.startsWith('affinity:'));

    let sdkIndex = null;
    let sdkMissingReason = null;
    if (!fs.existsSync(SDK)) {
        sdkMissingReason = `SDK 目录不存在: ${SDK}`;
    } else if (!fs.statSync(SDK).isDirectory()) {
        sdkMissingReason = `SDK 路径不是目录: ${SDK}`;
    } else {
        try { sdkIndex = buildSdkIndex(SDK); }
        catch (e) { sdkMissingReason = `SDK 读取失败: ${e.message}`; }
    }

    if (sdkMissingReason) {
        // L2/L6：明确分类，不把「SDK 缺失」和「API 不认识」混为一谈
        out(`  ⚠ ${sdkMissingReason}`);
        out('    → 无法做符号回查。设置 --sdk <目录> 或环境变量 AFFINITY_JSLIB 指向 JSLib。');
        out('    → 这**不代表脚本有错**；下面的语法检查与陷阱检查仍然有效。');
    } else {
        out(`  SDK 可用：${sdkIndex.fileCount} 个模块文件`);
        const exportCache = new Map();

        // 2a. 模块存在性
        for (const r of core) {
            const p = path.join(SDK, r.replace(/^\//, ''));
            if (!fs.existsSync(p)) bad(`模块不存在：${r}  (期望 ${p})`);
            else ok(`模块存在：${r}`);
        }
        if (native.length) ok('原生命名空间：' + native.join(', '));
        if (other.length) warn('非常规 require（确认是否支持）：' + other.join(', '));

        // 2b. 解构出来的符号是否真被导出（L3）
        for (const { module: r, names } of extractDestructuredRequires(src)) {
            if (!core.includes(r)) continue;
            const p = path.join(SDK, r.replace(/^\//, ''));
            if (!fs.existsSync(p)) continue;               // 已在 2a 报过
            if (!exportCache.has(p)) {
                try { exportCache.set(p, extractExportNames(fs.readFileSync(p, 'utf8'))); }
                catch { exportCache.set(p, new Set()); }
            }
            const exported = exportCache.get(p);
            const missing = names.filter((n) => !exported.has(n));
            const hit = names.filter((n) => exported.has(n));
            if (missing.length) {
                // 部分命中也要说清楚：命中的列出，未命中的报错，避免
                // 「只看到未导出清单」而误以为整组都没导出。
                bad(`${r} 未导出：${missing.join(', ')}`
                    + (hit.length ? `（已导出 ${hit.length} 个：${hit.join(', ')}）` : ''));
            } else {
                ok(`${r} 导出全部命中（${names.length} 个）`);
            }
        }

        // 2c. 方法调用是否在 SDK 里出现过（L4：基于词法清洗后的文本）
        const called = [...new Set(
            [...codeOnly.matchAll(/\.\s*([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
        )].filter((n) => !STD.has(n));
        const unknown = called.filter((n) => !sdkIndex.definedNames.has(n));
        if (unknown.length) {
            warn('SDK 源码中未见这些调用（可能是自定义函数或拼写错误）：' + unknown.join(', '));
        } else {
            ok(`调用的 ${called.length} 个方法名都能在 SDK 中找到`);
        }
    }

    // ---------- 3. 已知陷阱（9 项）----------
    out(`\n### 3. 已知陷阱检查（${TRAP_CHECKS.length} 项）`);
    const ctx = { code, codeOnly, ok, warn, error: bad, sdkAvailable: !!sdkIndex };
    for (const [name, fn] of TRAP_CHECKS) {
        const before = { e: errors, w: warnings };
        try { fn(ctx); }
        catch (e) { warn(`检查项「${name}」自身出错: ${e.message}`); }
        if (errors === before.e && warnings === before.w) passed++;  // 该项无发现也算通过
    }

    out(`\n结果：${passed} 通过，${warnings} 警告，${errors} 错误`);
    if (sdkMissingReason) out('提示：符号回查被跳过（SDK 不可用），不代表符号正确。');
    if (!syntaxOk) out('提示：先修语法错误，语法不过时后续检查意义有限。');
    return errors > 0 ? EXIT.FAIL : EXIT.OK;
}

const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    process.exitCode = await runMain(main);
}

export { main, USAGE, TRAP_CHECKS, buildSdkIndex };