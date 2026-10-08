#!/usr/bin/env node
// ============================================================================
// fix-script-perms.mjs —— Affinity 脚本库权限修复器（v0.4 重写）
//
// 解决的问题：
//   通过 UI「导入」进来的 .afscript 脚本，权限位为 0（导出容器时权限被清零、
//   导入不继承设置默认值），运行时报 PERMISSION_DENIED / fileSystemRoots 为空。
//   本工具修补脚本库 scripts.propcol 中每个脚本的 8 字节权限位掩码（mreP 记录，u64 LE）。
//
// ⚠️ 这是**高风险**工具：直接改写 Affinity 的二进制库文件。
//   v0.4 起**默认只打印计划（dry-run）**，必须显式 --apply 才真正写文件。
//
// ── 机制依据 ────────────────────────────────────────────────────────────────
//   【已验证】Affinity 3.3.0.4850 Win32，2026-10-06 实测：
//     - 权限模型：Script::GetPermissions()/SetPermissions(u64)（libpersona.dll）、
//       Scripting::Permissions::GetBits()→u64（libmcp.dll）
//     - 库内「编辑器另存为」的脚本 mreP u64 = 3（文件系统|网络，随设置默认值）
//     - 导出的 .afscript 容器内 mreP u64 = 0（导出剥离权限）
//   【推断】位语义由默认值组合推断：bit0=文件系统, bit1=网络, bit2=GenAI
//     —— bit2 **未实测**确认，标注为推断，不要据此做精细授权。
//
// ── v0.4 修复清单 ────────────────────────────────────────────────────────────
//   P1  默认 dry-run，只有 --apply 才写文件（原来默认直接改，极危险）
//   P2  --grant/--revoke 在**参数解析阶段**互斥；所有参数检查缺值
//   P3  权限数字严格 BigInt 校验：拒绝负数/空串/非法字符/超 u64 范围
//   P4  mreP 解析加完整边界检查（标签、长度、u64、后随标记全在 Buffer 内）
//   P5  检查记录重叠/重复/疑似误匹配/标题越界；损坏记录只报告跳过，绝不写入
//   P6  备份名带毫秒+随机后缀，不再同一秒内互相覆盖
//   P7  临时文件 + fsync + 原子 rename 替换；失败保留原文件
//   P8  写后**重新读盘**校验权限位 + 确认非目标字节完全一致
//   P9  --force 输出明确危险提示，且不绕过结构校验与写后验证
//   P10 默认遵循**最小权限**：不默认给网络权限，输出标注权限来源与推断字段
//
// 用法：
//   node fix-script-perms.mjs --list                      只列出，不改（默认行为）
//   node fix-script-perms.mjs                             打印修复计划（dry-run）
//   node fix-script-perms.mjs --apply                     ★ 真正写入
//   node fix-script-perms.mjs --apply --grant fs          只授予文件系统
//   node fix-script-perms.mjs --apply --title "SVG"       只处理标题含 SVG 的脚本
//   node fix-script-perms.mjs --list --file <propcol路径>  指定库文件（离线测试用）
//
// 退出码: 0 成功 / 1 运行失败 / 2 参数错误
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    EXIT, UsageError, RunError, parseArgs, requireExistingFile,
    atomicWriteFileSync, uniqueStamp, runMain,
} from './lib/cli.mjs';

// ---------------------------------------------------------------------------
// 常量（容器 4CC 全部是反读）
// ---------------------------------------------------------------------------
const MREP_TAG = Buffer.from('mreP', 'latin1');      // ← "Perm" 权限记录
const MREP_PREFIX = 0x04;                             // 记录前导类型字节（实测一致）
const MREP_TERM = 0x29;                               // 记录后随字节（实测一致，不修改）
const LTAG_TITL = Buffer.from('2b6c746974', 'hex');   // 0x2B + "ltit"（titl）标题记录
const U64_MAX = (1n << 64n) - 1n;

const BIT = { fs: 1n, network: 2n, genai: 4n };
const BIT_LABEL = [
    [BIT.fs, '文件系统'],
    [BIT.network, '网络'],
    [BIT.genai, 'GenAI(推断·未实测)'],
];

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

const USAGE = `用法:
  node fix-script-perms.mjs [--list] [--file <propcol路径>]
  node fix-script-perms.mjs [--apply] [--grant fs,network|数字 | --revoke 数字]
                             [--title 关键词] [--all] [--force]

选项:
  --list只列出各脚本权限，不计算也不写入（默认）
  --apply             ★ 真正写入文件。不给这个参数时只打印计划（dry-run）
  --grant <权限>      授权。可用 fs,network,genai 组合或 u64 数字（不能与 --revoke 同用）
  --revoke <权限>     收回权限。同样接受组合或数字
  --title <关键词>    只处理标题包含该关键词的脚本
  --all               连已有权限的脚本也按 grant/revoke/默认值调整
  --file <路径>       指定 scripts.propcol（默认自动定位用户库）
  --force             Affinity 正在运行时仍继续（危险，不推荐）

权限位: bit0=文件系统  bit1=网络  bit2=GenAI（推断，未实测）
安全:   默认 dry-run；--apply 才写入；写前自动备份；写后回读校验
退出码: 0 成功 / 1 运行失败 / 2 参数错误`;

/**
 * 严格解析权限值：u64 BigInt 或权限名组合。
 * 拒绝：负数、空串、非法字符、超 u64 范围、小数、指数写法。
 */
export function parsePermSpec(spec, flagName) {
    if (spec === undefined || spec === null || spec === '') {
        throw new UsageError(`${flagName} 需要值`);
    }
    const s = String(spec).trim();
    if (s === '') throw new UsageError(`${flagName} 的值不能为空`);

    if (/^\d+$/.test(s)) {
        const v = BigInt(s);
        if (v < 0n) throw new UsageError(`${flagName} 不能是负数`);
        if (v > U64_MAX) throw new UsageError(`${flagName} 超出 u64 范围（最大 ${U64_MAX}）`);
        return v;
    }
    // 负数带符号 / 小数 / 科学计数法 一律拒绝，避免 /^-?\d+$/ 误判
    if (/^-/.test(s)) throw new UsageError(`${flagName} 不能是负数: ${s}`);
    if (/^\d+\.\d+$/.test(s)) throw new UsageError(`${flagName} 不能是小数: ${s}`);

    const parts = s.split(/[,+]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) throw new UsageError(`${flagName} 的值无法解析: ${s}`);
    let bits = 0n;
    for (const p of parts) {
        if (!(p in BIT)) {
            throw new UsageError(`未知权限名 ${JSON.stringify(p)}（可用: fs, network, genai，或直接给数字）`);
        }
        bits |= BIT[p];
    }
    return bits;
}

export function parseCli(argv) {
    const p = parseArgs(argv, {
        flags: ['list', 'apply', 'all', 'force', 'help', 'h'],
        values: ['grant', 'revoke', 'title', 'file'],
        maxPositional: 0,
    });
    const f = p.flags, v = p.values;
    const opt = {
        list: f.has('list'),
        apply: f.has('apply'),
        all: f.has('all'),
        force: f.has('force'),
        help: f.has('help') || f.has('h'),
        grant: v.grant !== undefined ? parsePermSpec(v.grant, '--grant') : null,
        revoke: v.revoke !== undefined ? parsePermSpec(v.revoke, '--revoke') : null,
        title: v.title ?? null,
        file: v.file ?? null,
    };

    // P2：互斥在解析阶段就报，不再拖到循环里逐条判断
    if (opt.grant !== null && opt.revoke !== null) {
        throw new UsageError('--grant 与 --revoke 不能同时使用',
            '一次运行只做一件事：要么授权，要么收回');
    }
    if (opt.apply && opt.list) {
        throw new UsageError('--apply 与 --list 不能同时使用',
            '--list 是只读的；要写入就去掉 --list');
    }
    return opt;
}

// ---------------------------------------------------------------------------
// 库文件定位与运行检测
// ---------------------------------------------------------------------------

export function defaultPropcol() {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Affinity', 'Common', '3.0', 'user', 'scripts.propcol');
}

/** 读取 ScriptingPreferences.xml 里的默认权限设置。 */
export function readDefaults(xmlPath) {
    const p = xmlPath || path.join(
        os.homedir(), 'AppData', 'Roaming', 'Affinity', 'Affinity', '3.0', 'Settings', 'ScriptingPreferences.xml');
    // 最小权限原则：兜底只给文件系统，不给网络（P10）
    let mask = BIT.fs;
    let src = '兜底值(仅文件系统·最小权限)';
    try {
        const xml = fs.readFileSync(p, 'utf8');
        const flag = (tag) => new RegExp(`<${tag}>\\s*(True|False)\\s*</${tag}>`, 'i').exec(xml)?.[1]?.toLowerCase() === 'true';
        const dfs = flag('DefaultAllowFileSystem');
        const dnw = flag('DefaultAllowNetwork');
        const dai = flag('DefaultAllowGenAI');
        mask = (dfs ? BIT.fs : 0n) | (dnw ? BIT.network : 0n) | (dai ? BIT.genai : 0n);
        src = `ScriptingPreferences.xml（文件系统=${dfs} 网络=${dnw} GenAI=${dai}）`;
    } catch { /* 用兜底 */ }
    return { mask, src, path: p };
}

function affinityRunning() {
    try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Affinity.exe', '/NH'],
            { encoding: 'utf8', windowsHide: true });
        return /affinity\.exe/i.test(out);
    } catch { return false; }
}

// ---------------------------------------------------------------------------
// 记录解析（P4/P5：完整边界检查 + 损坏记录只报告）
// ---------------------------------------------------------------------------

/**
 * 扫描 buf 里的 mreP 权限记录。
 *
 * 每条记录都做完整校验：标签位置、前导字节、u64 是否越界、后随标记、
 * 以及「前一个同类记录是否重叠」。任何一项不通过都标记 valid=false，
 * 调用方只报告并跳过，**绝不写入**。
 *
 * @returns {Array<{at:number, valid:boolean, reason?:string, bits?:bigint,
 *                  valueAt?:number, title?:string, term?:number|null}>}
 */
export function findPermRecords(buf) {
    const records = [];
    if (!Buffer.isBuffer(buf)) throw new RunError('findPermRecords 需要 Buffer');
    const len = buf.length;
    let i = 0;
    let prevEnd = -1;

    while ((i = buf.indexOf(MREP_TAG, i)) !== -1) {
        const at = i;
        i += MREP_TAG.length;

        const bad = (reason) => { records.push({ at, valid: false, reason }); };

        if (at < 1) { bad('标签前没有前导字节'); continue; }
        if (buf[at - 1] !== MREP_PREFIX) {
            bad(`前导字节 0x${buf[at - 1].toString(16)} ≠ 0x04`);
            continue;
        }
        // u64 需要 at+4 .. at+11；后随标记在 at+12
        if (at + 12 >= len) { bad('文件过早结束，u64 或后随标记越界'); continue; }

        // P5：与上一条记录范围重叠 → 疑似误匹配
        if (prevEnd >= 0 && at < prevEnd) {
            bad(`与上一条记录重叠（上一条结束于 ${prevEnd}）`);
            continue;
        }

        const bits = buf.readBigUInt64LE(at + 4);
        const term = buf[at + 12];
        if (term !== MREP_TERM) {
            bad(`后随字节 0x${term.toString(16)} ≠ 0x29`);
            continue;
        }

        // 关联标题：向前找最近的 ltit 记录
        let title = '(未知)';
        const tAt = buf.lastIndexOf(LTAG_TITL, at);
        if (tAt !== -1) {
            const need = tAt + 9;                       // 0x2B + 4CC + u32 长度
            if (need + 4 <= len) {
                const slen = buf.readUInt32LE(tAt + 5);
                const end = need + slen;
                if (slen > 0 && slen < 4096 && end <= at && end <= len) {
                    title = buf.subarray(need, end).toString('utf8');
                } else if (!(slen > 0 && slen < 4096 && end <= at && end <= len)) {
                    title = '(标题记录越界·已忽略)';
                }
            }
        }

        records.push({ at, valid: true, bits, title, valueAt: at + 4, term });
        prevEnd = at + 13;
    }

    // P5：检查同一 valueAt 是否被重复命中
    const seen = new Set();
    for (const r of records) {
        if (!r.valid) continue;
        if (seen.has(r.valueAt)) { r.valid = false; r.reason = '重复记录（同一偏移被命中两次）'; }
        else seen.add(r.valueAt);
    }
    return records;
}

export function decodeBits(bits) {
    if (bits === 0n) return '【无权限】';
    return BIT_LABEL.filter(([b]) => (bits & b) !== 0n).map(([, l]) => l).join(' + ')
        || `未知组合(${bits})`;
}

// ---------------------------------------------------------------------------
// 计划计算
// ---------------------------------------------------------------------------

/**
 * 计算每条记录的目标权限。
 * @returns {Array<{r:object, newBits:bigint, why:string}>}
 */
export function buildPlan(records, opt, defaultMask) {
    const plan = [];
    for (const r of records) {
        let newBits = r.bits;
        let why = '';
        if (opt.grant !== null) {
            newBits = r.bits | opt.grant;
            why = `显式授权 +${opt.grant}`;
        } else if (opt.revoke !== null) {
            newBits = r.bits & ~opt.revoke;
            why = `显式收回 -${opt.revoke}`;
        } else if (r.bits === 0n || (!(r.bits & (BIT.fs | BIT.network)) && !opt.all)) {
            newBits = defaultMask;
            why = `修复为设置默认权限(${defaultMask})`;
        } else if (opt.all && r.bits !== defaultMask) {
            newBits = defaultMask;
            why = `对齐设置默认权限(--all, ${defaultMask})`;
        }
        if (newBits !== r.bits) plan.push({ r, newBits, why });
    }
    return plan;
}

/** 在副本上应用修改，并校验「除目标 8 字节外没有其它差异」。 */
export function applyToCopy(raw, plan) {
    const out = Buffer.from(raw);
    for (const { r, newBits } of plan) {
        if (r.valueAt + 8 > out.length) throw new RunError(`记录 @${r.at} 越界，放弃写入`);
        out.writeBigUInt64LE(newBits, r.valueAt);
    }
    const diff = [];
    for (let i = 0; i < raw.length; i++) if (raw[i] !== out[i]) diff.push(i);
    const expected = new Set(plan.flatMap(({ r }) => Array.from({ length: 8 }, (_, k) => r.valueAt + k)));
    const unexpected = diff.filter((i) => !expected.has(i));
    return { out, diff, unexpected };
}

/** P8：写后重新读盘校验权限位与非目标字节。 */
export function verifyWritten(filePath, plan, original, expectedBuf) {
    const after = fs.readFileSync(filePath);
    if (after.length !== original.length) {
        throw new RunError(`写后校验失败：文件长度变了 ${original.length} → ${after.length}`);
    }
    const targetSet = new Set(plan.flatMap(({ r }) => Array.from({ length: 8 }, (_, k) => r.valueAt + k)));
    for (let i = 0; i < after.length; i++) {
        if (targetSet.has(i)) {
            // 目标 8 字节：必须与期望缓冲区逐字节一致。
            // 不能用「这些字节都必须变了」来判定 —— 0→3 只改动 1 个字节，
            // 目标区间内本来就存在与原文件相同的字节。
            if (after[i] !== expectedBuf[i]) {
                throw new RunError(`写后校验失败：目标字节 @${i} = ${after[i]}，期望 ${expectedBuf[i]}`);
            }
        } else if (after[i] !== original[i]) {
            throw new RunError(`写后校验失败：非目标字节 @${i} 被意外改动（${original[i]} → ${after[i]}）`);
        }
    }
    // 重新解析目标记录，确认权限位确实写进去了
    const recs = findPermRecords(after);
    for (const { r, newBits } of plan) {
        const found = recs.find((x) => x.at === r.at);
        if (!found || !found.valid) {
            throw new RunError(`写后校验失败：记录 @${r.at} 解析异常`);
        }
        if (found.bits !== newBits) {
            throw new RunError(`写后校验失败：记录 @${r.at} 权限是 ${found.bits}，期望 ${newBits}`);
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
    const opt = parseCli(process.argv.slice(2));
    if (opt.help) { console.log(USAGE); return EXIT.OK; }

    const file = opt.file || defaultPropcol();
    if (!fs.existsSync(file)) {
        throw new RunError(`找不到脚本库文件: ${file}`,
            '用 --file 指定路径（离线测试可直接指向 propcol 副本）');
    }
    requireExistingFile(file, '--file');

    // 运行检测：只读操作不需要，--apply 时才拦
    if (opt.apply && !opt.force && affinityRunning()) {
        throw new RunError('检测到 Affinity 正在运行，拒绝写入',
            'Affinity 退出时才会把内存态写盘，运行中修改会被覆盖。请完全退出后重试（--force 可强行继续，不推荐）');
    }
    if (opt.apply && opt.force && affinityRunning()) {
        console.warn('⚠⚠ --force：已忽略「Affinity 正在运行」的保护，你的修改很可能被 Affinity 退出时覆盖！');
    }

    const raw = fs.readFileSync(file);
    const records = findPermRecords(raw);
    const { mask: defaultMask, src: defaultSrc } = readDefaults();

    console.log(`脚本库: ${file}  (${raw.length} 字节)`);
    console.log(`设置默认权限: ${defaultMask} (${decodeBits(defaultMask)})`);
    console.log(`  来源: ${defaultSrc}`);
    console.log(`  注意: bit2(GenAI) 为**推断**，未实测确认；读不到设置时兜底只给文件系统（最小权限，不含网络）。`);
    console.log(`找到 ${records.length} 条 mreP 权限记录\n`);

    const broken = records.filter((r) => !r.valid);
    for (const r of broken) {
        console.log(`  ⚠ @${r.at} 结构异常，将跳过（不写入）: ${r.reason}`);
    }
    const valid = records.filter((r) => r.valid);
    if (broken.length) {
        console.log(`  → ${broken.length} 条损坏记录被跳过；只对下面 ${valid.length} 条有效记录做计划。`);
    }

    if (!valid.length) {
        console.log('\n（没有可处理的记录）');
        return EXIT.OK;
    }

    // 标题过滤
    let targets = valid;
    if (opt.title) {
        targets = valid.filter((r) => r.title.includes(opt.title));
        if (!targets.length) {
            console.log(`\n没有标题含 ${JSON.stringify(opt.title)} 的脚本。`);
            return EXIT.OK;
        }
    }
    for (const r of targets) {
        console.log(`  @${r.at}  "${r.title}"  权限=${r.bits}  ${decodeBits(r.bits)}`);
    }
    if (opt.list) {
        console.log(`\n✓ --list：只读模式，未做任何修改（共 ${targets.length} 个脚本）`);
        return EXIT.OK;
    }

    const plan = buildPlan(targets, opt, defaultMask);
    if (!plan.length) {
        console.log('\n✓ 无需修改：所有目标脚本的权限已满足。');
        return EXIT.OK;
    }

    console.log(`\n将修改 ${plan.length} 条记录:`);
    for (const { r, newBits, why } of plan) {
        console.log(`  "${r.title}": ${r.bits} → ${newBits}  (${why}；结果: ${decodeBits(newBits)})`);
    }

    // 在副本上先做一遍非目标字节校验
    const { out, diff, unexpected } = applyToCopy(raw, plan);
    if (unexpected.length) {
        throw new RunError(`出现预期外的字节差异（${unexpected.length} 处，如 @${unexpected[0]}），放弃写入`);
    }

    // ---- P1：默认 dry-run ----
    if (!opt.apply) {
        console.log(`\n【DRY-RUN】这是预览，没有写入任何文件。`);
        console.log(`确认无误后加上 --apply 真正执行，例如：`);
        const repro = [path.basename(process.argv[1]), ...process.argv.slice(2), '--apply'].join(' ');
        console.log(`  node ${repro}`);
        console.log(`\n（会先备份到 ${path.basename(file)}.bak-<毫秒戳+随机>，再原子替换）`);
        return EXIT.OK;
    }

    // ---- P6：唯一备份名 ----
    const backup = `${file}.bak-${uniqueStamp()}`;
    fs.copyFileSync(file, backup);
    console.log(`\n已备份 → ${backup}`);

    // ---- P7：临时文件 + fsync + 原子 rename ----
    atomicWriteFileSync(file, out);
    console.log(`✓ 已原子写入 ${plan.length} 条权限记录（共改动 ${diff.length} 字节）`);

    // ---- P8：写后回读校验 ----
    verifyWritten(file, plan, raw, out);
    console.log('✓ 写后校验通过：所有目标权限位正确，非目标字节完全一致');
    console.log('  现在启动 Affinity，脚本即拥有对应权限。');
    console.log(`  如需回滚：把备份复制回去即可 →  ${backup}`);
    return EXIT.OK;
}

const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    process.exitCode = await runMain(main);
}

export { main, USAGE, MREP_TAG, MREP_PREFIX, MREP_TERM, BIT, U64_MAX };