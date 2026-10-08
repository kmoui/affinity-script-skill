// ============================================================================
// lib/cli.mjs —— 所有 Node 工具共用的基础设施
//
// 存在意义：把「退出码、参数解析、原子写入、正则转义」这些**跨工具必须一致**
// 的行为收敛到一处，避免每个脚本各写一套、各错一遍。
//
// 统一约定（全仓库一致，测试用例逐条覆盖）：
//   退出码 0 = 成功
//   退出码 1 = 输入或运行失败（文件不存在、校验不过、RPC 报错…）
//   退出码 2 = **用户参数错误**（缺值、非法值、未知参数、互斥冲突）
//
// 依赖：零外部依赖。Node 18+。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const EXIT = {
    OK: 0,
    FAIL: 1,
    USAGE: 2,
};

/** 参数错误 → 退出码 2。调用方不需要再判断，直接 throw 即可。 */
export class UsageError extends Error {
    constructor(message, hint) {
        super(message);
        this.name = 'UsageError';
        this.exitCode = EXIT.USAGE;
        this.hint = hint || null;
    }
}

/** 运行失败 → 退出码 1。 */
export class RunError extends Error {
    constructor(message, hint) {
        super(message);
        this.name = 'RunError';
        this.exitCode = EXIT.FAIL;
        this.hint = hint || null;
    }
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

/**
 * 严格的参数解析器。
 *
 * 与原来 `switch(argv[i++])` 手写循环相比，修掉了这些洞：
 *   - 缺值不再被当成 `undefined` 静默吞掉（`--port` 后面没了 → 原本变成 NaN）
 *   - 重复使用会报错（`--title a --title b` 原本后者静默覆盖前者）
 *   - `--port=8080` 与 `--port 8080` 都支持
 *   - 未知参数不再被当成位置参数
 *
 * @param {string[]} argv        process.argv.slice(2)
 * @param {object}   spec
 *   spec.flags        string[]   无值开关
 *   spec.values       string[]   需要值的选项
 *   spec.maxPositional number    位置参数上限，0 表示不允许位置参数
 *   spec.minPositional number    位置参数下限
 *   spec.stopAtDoubleDash       true 时 `--` 之后全部当位置参数（不解析）
 * @returns {{flags:Set<string>, values:Object, positional:string[]}}
 */
export function parseArgs(argv, spec) {
    const flags = new Set(spec.flags || []);
    const valueKeys = new Set(spec.values || []);
    const maxPos = spec.maxPositional ?? 0;
    const minPos = spec.minPositional ?? 0;
    const known = new Set([...flags, ...valueKeys]);

    const out = { flags: new Set(), values: Object.create(null), positional: [] };
    let i = 0;
    let noMoreFlags = false;

    for (; i < argv.length; i++) {
        const a = argv[i];

        if (noMoreFlags) { out.positional.push(a); continue; }
        if (a === '--') { noMoreFlags = true; continue; }

        // 非选项 → 位置参数
        if (a.length === 0 || a[0] !== '-') {
            out.positional.push(a);
            continue;
        }

        // 短选项簇（-h）与长选项（--help / --help=x）
        let name = a.startsWith('--') ? a.slice(2) : a.slice(1);
        let inlineValue = null;
        const eq = name.indexOf('=');
        if (eq >= 0) { inlineValue = name.slice(eq + 1); name = name.slice(0, eq); }
        // 长选项的 kebab-case → camelCase，两种拼法都认
        const camel = name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

        if (flags.has(name) || flags.has(camel)) {
            if (inlineValue !== null) {
                throw new UsageError(`--${name} 是开关，不接受值`);
            }
            out.flags.add(flags.has(name) ? name : camel);
            continue;
        }

        if (valueKeys.has(name) || valueKeys.has(camel)) {
            const key = valueKeys.has(name) ? name : camel;
            let v = inlineValue;
            if (v === null) {
                const next = argv[i + 1];
                // 下一个 token 不存在，或是个新的选项 → 缺值。
                // 需要以 '-' 开头当值的场景请用 `--key=-value` 显式写法。
                if (next === undefined || (next.length > 1 && next[0] === '-' && !/^-?\d/.test(next))) {
                    throw new UsageError(`--${key} 缺少值`);
                }
                v = next;
                i++;
            }
            if (v === '') throw new UsageError(`--${key} 的值不能为空`);
            if (key in out.values) throw new UsageError(`--${key} 不能重复使用（后一次会静默覆盖前一次）`);
            out.values[key] = v;
            continue;
        }

        throw new UsageError(`未知参数: ${a}`, '用 --help 查看支持的参数');
    }

    if (out.positional.length > maxPos) {
        const extra = out.positional.slice(maxPos);
        throw new UsageError(
            `多余的位置参数: ${extra.map((s) => JSON.stringify(s)).join(', ')}`,
            `本命令最多接受 ${maxPos} 个位置参数`,
        );
    }
    if (out.positional.length < minPos) {
        throw new UsageError(`缺少必需的位置参数（需要 ${minPos} 个）`);
    }
    return out;
}

// ---------------------------------------------------------------------------
// 值校验
// ---------------------------------------------------------------------------

export function requirePort(raw) {
    if (!/^\d{1,5}$/.test(raw)) throw new UsageError(`--port 必须是 1..65535 的整数，收到 ${JSON.stringify(raw)}`);
    const n = Number(raw);
    if (n < 1 || n > 65535) throw new UsageError(`--port 必须是 1..65535 的整数，收到 ${n}`);
    return n;
}

export function requirePositiveInt(raw, name) {
    if (!/^\d+$/.test(raw)) throw new UsageError(`${name} 必须是正整数，收到 ${JSON.stringify(raw)}`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`${name} 必须是正整数，收到 ${raw}`);
    return n;
}

/** 非负页索引（render-spread 用），允许 0。 */
export function requireIndex(raw, name) {
    if (!/^\d+$/.test(raw)) throw new UsageError(`${name} 必须是非负整数，收到 ${JSON.stringify(raw)}`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) throw new UsageError(`${name} 必须是非负整数，收到 ${raw}`);
    return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requireUuid(raw, name) {
    if (!UUID_RE.test(raw)) throw new UsageError(`${name} 必须是 UUID，收到 ${JSON.stringify(raw)}`);
    return raw;
}

/** 校验输入文件存在且是普通文件。 */
export function requireExistingFile(p, flagName) {
    let st;
    try { st = fs.statSync(p); }
    catch { throw new RunError(`找不到文件: ${p}`, `${flagName || '该参数'}指定的路径不存在`); }
    if (!st.isFile()) throw new RunError(`不是普通文件: ${p}`);
    return p;
}

export function requireExistingDir(p, flagName) {
    let st;
    try { st = fs.statSync(p); }
    catch { throw new RunError(`找不到目录: ${p}`, `${flagName || '该参数'}指定的路径不存在`); }
    if (!st.isDirectory()) throw new RunError(`不是目录: ${p}`);
    return p;
}

// ---------------------------------------------------------------------------
// 正则与字符串
// ---------------------------------------------------------------------------

/**
 * RegExp.escape 的等价实现（Node 24 才有内置，这里手写一份）。
 * 用户输入的符号名**绝不能**直接拼进 RegExp —— 否则 `foo(` 这类输入会抛
 * SyntaxError，`a*` 会被当通配符，静默返回一堆无关结果。
 */
export function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 判定字符串是否为合法的 RegExp 源，给出可读报错。 */
export function tryCompileRegExp(source, flags) {
    try { return new RegExp(source, flags); }
    catch (e) { throw new UsageError(`正则无效: ${e.message}`, `模式: ${source}`); }
}

// ---------------------------------------------------------------------------
// 文件写入
// ---------------------------------------------------------------------------

/** 唯一后缀：时间戳（到毫秒）+ 随机串，避免同一秒内重复执行互相覆盖。 */
export function uniqueStamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
    return `${ts}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 原子写入：先写同目录临时文件 → fsync → 关闭 → rename 覆盖目标。
 *
 * 为什么不能直接 writeFileSync 覆盖原始文件：
 *   1. 进程在写一半时被杀掉 / 断电 → 原文件已损坏，且**没有可用的原件**
 *   2. Affinity 的 propcol 是二进制库文件，半截文件会让整个脚本库打不开
 * rename 在同一文件系统内是原子的，失败时原文件保持不变。
 *
 * @param {string} target 最终路径
 * @param {Buffer} data
 */
export function atomicWriteFileSync(target, data) {
    const dir = path.dirname(path.resolve(target));
    const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now().toString(36)}`);
    let fd = null;
    try {
        fd = fs.openSync(tmp, 'wx', 0o600);
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);              // 落盘，避免 rename 后内容还在页缓存里
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmp, target);    // 同目录 → 原子替换
    } catch (e) {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
        try { fs.unlinkSync(tmp); } catch { /* 临时文件可能已 rename 成功 */ }
        throw new RunError(`写入失败: ${target}`, `${e.code || ''} ${e.message}`.trim());
    }
}

// ---------------------------------------------------------------------------
// 顶层错误处理
// ---------------------------------------------------------------------------

/**
 * 包装 main()：把异常翻译成稳定退出码，并保证清理逻辑一定执行。
 *
 * 重要：main() 的**返回值**就是最终退出码。没抛异常时用它，
 * 抛异常时用异常上的 exitCode（UsageError=2 / RunError=1）。
 * （v0.4 修复：此前忽略返回值，导致「发现 1 个错误」却仍然退出 0。）
 *
 * @param {() => Promise<number>} mainFn
 * @param {{cleanup?: () => any}} opts
 * @returns {Promise<number>} 退出码
 */
export async function runMain(mainFn, { cleanup } = {}) {
    let code = EXIT.OK;
    try {
        const r = await mainFn();
        code = typeof r === 'number' ? r : EXIT.OK;
    } catch (e) {
        if (e instanceof UsageError) {
            console.error(`✗ 参数错误: ${e.message}`);
            if (e.hint) console.error(`  ${e.hint}`);
            code = EXIT.USAGE;
        } else if (e instanceof RunError) {
            console.error(`✗ ${e.message}`);
            if (e.hint) console.error(`  ${e.hint}`);
            code = EXIT.FAIL;
        } else {
            console.error(`✗ 未预期的错误: ${e?.stack || e?.message || e}`);
            code = EXIT.FAIL;
        }
    } finally {
        if (cleanup) {
            try { await cleanup(); }
            catch (ce) { console.error(`⚠ 清理时出错: ${ce?.message || ce}`); }
        }
    }
    return code;
}