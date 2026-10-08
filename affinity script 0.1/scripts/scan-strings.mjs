// ============================================================================
// scan-strings.mjs —— 流式扫描二进制文件提取可读字符串（二进制考古）
//
// 用途：当 SDK 源码里查不到答案时，程序二进制里往往有（函数修饰名、界面文案、
//       格式 ID、引擎标识、MCP 工具名…）。这些比任何文档都可信。
//
// 用法：
//   node scan-strings.mjs <文件> <正则1> [正则2 ...]
//   node scan-strings.mjs <文件> --utf16 <正则>      # 扫 UTF-16LE（.strings 文件）
//   node scan-strings.mjs <文件> --min 8 <正则>       # 提高最短串长
//   node scan-strings.mjs <文件> --raw--max 500      # 打印原始串（限量，防刷屏）
//
// 已实测有效的目标：
//   libmcp.dll        → MCP 工具名（snake_case）、preamble 文档机制
//   libscriptingjs.dll→ 引擎 ID、模块系统、require/asModule、affinity:* 命名空间
//   libpersona.dll→ 导出预设名（本地化）、设置项、格式 ID
//   app.asar          → skill 发现规则、配置项
//   *.lproj/*.strings → 界面文案（UTF-16LE！）
//
// ── v0.4 修复清单 ────────────────────────────────────────────────────────────
//   T1 UTF-16LE 跨 chunk 边界不再漏串（原来 carry 可能落在半个 code unit 上）
//   T2 超长字符串不再无限增长占用内存（加 MAX_STR 上限）
//   T3 文件描述符在异常路径也关闭（try/finally）
//   T4 文件不存在/目录不存在/读取失败有明确报错与退出码
//   T5 --raw 限量输出，避免一次性打印几十万行
//   T6 重复扫描去重（每条正则一个 Set），--raw 不建集合省内存
//   T7 退出码统一：0 成功 / 1 运行失败 / 2 参数错误
//
// 退出码: 0 成功 / 1 运行失败 / 2 参数错误
// ============================================================================

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    EXIT, UsageError, RunError, parseArgs, requirePositiveInt, tryCompileRegExp, runMain,
} from './lib/cli.mjs';

const USAGE = `用法:
  node scan-strings.mjs <文件> [选项] <正则1> [正则2 ...]

选项:
  --utf16        按 UTF-16LE 扫描（.strings / .lproj 文件）
  --min <N>      最短字符串长度（正整数，默认 4）
  --raw          打印全部原始字符串（慎用；配 --max 限量）
  --max <N>      --raw 模式最多打印多少条（正整数，默认 2000）
  -h, --help     显示本帮助

退出码: 0 成功 / 1 运行失败 / 2 参数错误`;

// 单条字符串的上限：二进制里可能有整段连续可打印字节（无分隔的表），
// 不设上限会为了一个「字符串」分配上百 MB。
const MAX_STR = 4096;
const CHUNK = 8 * 1024 * 1024;
const OVERLAP = 1024;

export function parseCli(argv) {
    const p = parseArgs(argv, {
        flags: ['utf16', 'raw', 'help', 'h'],
        values: ['min', 'max'],
        maxPositional: Number.MAX_SAFE_INTEGER,   // 文件 + 多个正则
    });
    const [file, ...rest] = p.positional;
    return {
        file,
        patterns: rest,
        utf16: p.flags.has('utf16'),
        raw: p.flags.has('raw'),
        min: p.values.min !== undefined ? requirePositiveInt(p.values.min, '--min') : 4,
        max: p.values.max !== undefined ? requirePositiveInt(p.values.max, '--max') : 2000,
        help: p.flags.has('help') || p.flags.has('h'),
    };
}

/**
 * 从一块数据里抽取可读字符串。
 * @param {Buffer} chunk
 * @param {boolean} utf16
 * @param {number} min
 * @param {(s:string)=>void} emit 逐条回调，避免先攒一个巨大数组
 */
export function extractStrings(chunk, utf16, min, emit) {
    if (utf16) {
        // UTF-16LE：低字节可打印、高字节为 0
        let start = -1;
        for (let i = 0; i + 1 < chunk.length; i += 2) {
            const lo = chunk[i], hi = chunk[i + 1];
            if (hi === 0 && lo >= 32 && lo < 127) {
                if (start < 0) start = i;
                if (i - start >= MAX_STR) { emit(chunk.toString('utf16le', start, i)); start = i; }
            } else {
                if (start >= 0 && i - start >= min * 2) emit(chunk.toString('utf16le', start, i));
                start = -1;
            }
        }
        if (start >= 0 && chunk.length - start >= min * 2) {
            emit(chunk.toString('utf16le', start, start + MAX_STR));
        }
    } else {
        let start = -1;
        for (let i = 0; i <= chunk.length; i++) {
            const c = i < chunk.length ? chunk[i] : 0;
            if (c >= 32 && c < 127) {
                if (start < 0) start = i;
                if (i - start >= MAX_STR) { emit(chunk.toString('latin1', start, i)); start = i; }
            } else {
                if (start >= 0 && i - start >= min) emit(chunk.toString('latin1', start, i));
                start = -1;
            }
        }
    }
}

/** 扫描整个文件。回调式，避免把所有字符串攒在内存里。 */
export function scanFile(file, { utf16 = false, min = 4, onString }) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
    } catch (e) {
        throw new RunError(`无法打开文件: ${file}`, `${e.code || ''} ${e.message}`.trim());
    }
    try {
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.allocUnsafe(CHUNK + OVERLAP * 2);
        // T1：UTF-16 时 carry 必须按 2 字节对齐，否则会把半个 code unit 带到下一块，
        // 导致跨界处的字符串被截断或漏掉。
        const carryBytes = utf16 ? OVERLAP * 2 : OVERLAP;
        let carry = Buffer.alloc(0);
        let scanned = 0;
        let read;
        while ((read = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
            const chunk = Buffer.concat([carry, buf.subarray(0, read)]);
            scanned += read;
            extractStrings(chunk, utf16, min, onString);
            const keep = Math.min(carryBytes, chunk.length);
            carry = Buffer.from(chunk.subarray(chunk.length - keep));
            if (scanned >= size) break;
        }
        return { size, scanned };
    } catch (e) {
        throw new RunError(`扫描失败: ${file}`, `${e.code || ''} ${e.message}`.trim());
    } finally {
        // T3：无论正常还是抛异常，fd 都要关
        try { fs.closeSync(fd); } catch { /* ignore */ }
    }
}

async function main() {
    const opt = parseCli(process.argv.slice(2));
    if (opt.help) { console.log(USAGE); return EXIT.OK; }
    if (!opt.file) { console.log(USAGE); throw new UsageError('缺少目标文件'); }

    // T4：明确区分「文件不存在」与「是目录」
    let st;
    try { st = fs.statSync(opt.file); }
    catch { throw new RunError(`找不到文件: ${opt.file}`); }
    if (st.isDirectory()) throw new RunError(`${opt.file} 是目录`, '本工具只扫单个文件');

    let regs = [];
    if (!opt.raw) {
        if (!opt.patterns.length) {
            throw new UsageError('至少需要一个正则，或用 --raw 打印全部字符串');
        }
        regs = opt.patterns.map((p) => tryCompileRegExp(p, 'g'));   // 非法正则 → 退出码 2
    }

    console.log(`扫描 ${opt.file}  (${(st.size / 1048576).toFixed(1)} MB, ${opt.utf16 ? 'UTF-16LE' : 'ASCII'}, 最短串长 ${opt.min})`);

    if (opt.raw) {
        // T6：raw 模式不建去重集合，边扫边打印
        let printed = 0;
        const info = scanFile(opt.file, {
            utf16: opt.utf16, min: opt.min,
            onString: (s) => {
                if (printed >= opt.max) return;
                console.log(s.slice(0, 200));
                printed++;
            },
        });
        if (printed >= opt.max) {
            console.log(`\n(--raw 已达上限 ${opt.max} 条，共扫描 ${info.scanned} 字节)`);
        }
        return EXIT.OK;
    }

    const found = regs.map(() => new Set());
    const info = scanFile(opt.file, {
        utf16: opt.utf16, min: opt.min,
        onString: (s) => {
            const v = s.slice(0, 160);
            for (let k = 0; k < regs.length; k++) {
                regs[k].lastIndex = 0;
                if (regs[k].test(v)) found[k].add(v);
            }
        },
    });
    console.log(`已扫描 ${info.scanned} / ${info.size} 字节\n`);

    opt.patterns.forEach((pat, k) => {
        console.log(`=== /${pat}/  (${found[k].size} 个唯一串)`);
        [...found[k]].sort().slice(0, 100).forEach((s) => console.log('  ' + s));
        if (found[k].size > 100) console.log(`  …还有 ${found[k].size - 100} 个`);
    });
    return EXIT.OK;
}

const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    process.exitCode = await runMain(main);
}

export { main, USAGE, MAX_STR };