#!/usr/bin/env node
// ============================================================================
// make-afscript.mjs —— 把 .js 源码打包成 Affinity 可导入的 .afscript（v0.4 重写）
//
// ── 容器格式（2026-10-06 逆向确认，Affinity 3.3.0.4850，三个真实样本逐字节对账）──
//
// 外层（未压缩）：
//   00 FF 4B 41 | u32 ver=12 | "prcS" | "#Inf"
//   u64 @16  = 尾部 "#FT4" 的偏移（= 76 + 帧长 + 4）
//   u64 @24  = 文件总长        u64 @32 = zstd 帧长      u64 @40 = 0
//   u64 @48  = Unix 时间戳     u32 @56 = 2    u32 @60 = 2
//   "Prot" | u32 4 | "#Fil" | [zstd 帧] | FF FF FF FF | "#FT4" 尾部：
//     u64 0, u64 时间戳, u64 文件长, u64 帧长, u64 0, u32 1, u32 0,
//     u32 0x36, u32 0x01000000, u32 0, u64 0x48,
//     u64 载荷长(解压), u64 帧长,
//     u32 CRC32(解压载荷), 5字节 02 20 00 00 00, u32 CRC32(zstd帧),
//     u16 文件名长(10), "Script.dat"
//
// 内层载荷（zstd 解压后）——所有 4CC 都是反读：
//   00 FF 4B 53 02 00 | "prcS" 01 00 20 00 00 00 | 31 "prcS" 01 00000000 00
//   | "tpcS" 03 00 00 02 | 2b "gfnC" u32len {asModule,code 的 JSON}
//   | 2b "ngnE" u32(42) "com.canva.affinity.scriptengine.playground"
//   | 2b "cseD" u32len 描述 | 2b "ltit" u32len 标题
//   | 04 "mreP" u64(0 权限) | 29 "rTnU" 00 17 "diuU" GUID(16) 00 00
//
// 权限说明：导出容器权限位恒为 0（官方安全设计）。导入后用 fix-script-perms.mjs 修复。
//
// ── v0.4 修复清单 ────────────────────────────────────────────────────────────
//   K1 参数解析拒绝 --title/--desc/--out 缺值，拒绝多余位置参数，退出码明确
//   K2 新增 --force：默认禁止覆盖已有输出文件
//   K3 校验标题/描述/JSON 载荷/文件长度是否超 u32/u64 字段范围（防隐式截断）
//   K4 所有结构回读**先查标签是否找到、长度是否越界**，不对 -1 偏移 readUInt32LE
//   K5 CRC 字段做**实际回读比对**，不再只是「重新计算后写进去」
//   K6 输出走临时文件 + 原子替换，避免中断产生半成品
//   K7 输出信息区分 UTF-8 字节数与 JS 字符数
//   K8 zstd 不兼容时明确报出当前 Node 版本与解决办法
//
// 用法：
//   node make-afscript.mjs <脚本.js> [--title 标题] [--desc 描述] [--out 输出.afscript] [--force]
//
// 需要 Node >= 22.15.0（zlib.zstdCompressSync 自 22.15.0 / 23.8.0 提供）；
// 推荐 Node 24+。实测：Node 22.22.2、24.15.0、24.19.0 均可用。
// 退出码: 0 成功 / 1 运行失败 / 2 参数错误
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    EXIT, UsageError, RunError, parseArgs, requireExistingFile,
    atomicWriteFileSync, runMain,
} from './lib/cli.mjs';

const U32_MAX = 0xFFFFFFFF;
const U64_MAX = BigInt(Number.MAX_SAFE_INTEGER);

const USAGE = `用法:
  node make-afscript.mjs <脚本.js> [--title 标题] [--desc 描述] [--out 输出.afscript] [--force]

选项:
  --title <标题>   脚本标题（默认取文件名）
  --desc<描述>    脚本描述
  --out <路径>     输出文件（默认 <同名>.afscript）
  --force          允许覆盖已存在的输出文件
  -h, --help       显示本帮助

要求: Node >= 22.15.0（需要 zlib zstd；推荐 Node 24+）。输出前做完整自校验（解压回读 + CRC 回读比对）。
退出码: 0 成功 / 1 运行失败 / 2 参数错误`;

export function parseCli(argv) {
    const p = parseArgs(argv, {
        flags: ['force', 'help', 'h'],
        values: ['title', 'desc', 'out', 'o'],
        maxPositional: 1,
        minPositional: 1,
    });
    return {
        js: p.positional[0],
        title: p.values.title ?? null,
        desc: p.values.desc ?? '',
        out: p.values.out ?? p.values.o ?? null,
        force: p.flags.has('force'),
        help: p.flags.has('help') || p.flags.has('h'),
    };
}

// ---------------------------------------------------------------------------
// 长度守卫（K3）：任何写入 u32/u64 字段的值都必须先过这一关
// ---------------------------------------------------------------------------

function guardU32(n, what) {
    if (!Number.isInteger(n) || n < 0) throw new RunError(`${what} 长度非法: ${n}`);
    if (n > U32_MAX) {
        throw new RunError(`${what} 长度 ${n} 超出 u32 字段上限 ${U32_MAX}`,
            '内容过大，u32 长度字段会溢出并静默截断');
    }
    return n;
}
function guardU64(n, what) {
    if (!Number.isInteger(n) || n < 0) throw new RunError(`${what} 长度非法: ${n}`);
    if (BigInt(n) > U64_MAX) throw new RunError(`${what} 长度 ${n} 超出安全整数范围`);
    return n;
}

/**
 * 在 Buffer 里定位标签并安全读取其 u32 长度字段。
 * K4：原实现直接 `buf.readUInt32LE(at + 4)`，而 `at` 可能是 -1（标签没找到），
 * 于是抛出一个与真实原因完全无关的 ERR_OUT_OF_RANGE。
 *
 * @returns {{at:number, len:number, dataAt:number}}
 */
export function readTaggedRecord(buf, tagBuf, { extraSkip = 0, what = '记录' } = {}) {
    const at = buf.indexOf(tagBuf);
    if (at < 0) throw new RunError(`${what} 标签 ${JSON.stringify(tagBuf.toString('latin1'))} 在载荷里找不到`);
    const lenAt = at + 4 + extraSkip;
    if (lenAt + 4 > buf.length) {
        throw new RunError(`${what} 长度字段越界（@${lenAt}，缓冲区只有 ${buf.length} 字节）`);
    }
    const len = buf.readUInt32LE(lenAt);
    const dataAt = lenAt + 4;
    if (dataAt + len > buf.length) {
        throw new RunError(`${what} 内容越界（需要 ${dataAt + len} 字节，实际只有 ${buf.length}）`);
    }
    return { at, len, dataAt };
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
    const opt = parseCli(argv);

    requireExistingFile(opt.js, '输入');

    if (typeof zlib.zstdCompressSync !== 'function') {
        throw new RunError(
            `当前 Node ${process.version} 不支持 zstd 压缩，打包器无法工作`,
            'zstd API（zlib.zstdCompressSync）自 Node 22.15.0 / 23.8.0 起提供（推荐 Node 24+）。'
            + '请升级：https://nodejs.org/ 或 `nvm install 22.15 && nvm use 22.15`',
        );
    }

    // ---------- 输入 ----------
    let code = fs.readFileSync(opt.js, 'utf8');
    if (code.startsWith('\uFEFF')) code = code.slice(1);              // 去 BOM
    const title = opt.title || path.basename(opt.js).replace(/\.js$/i, '');
    const desc = opt.desc || '';
    const guid = crypto.randomBytes(16);

    // ---------- 内层载荷 ----------
    const ENGINE = 'com.canva.affinity.scriptengine.playground';
    const json = JSON.stringify({ asModule: false, code });
    const jsonBuf = Buffer.from(json, 'utf8');
    const titleBuf = Buffer.from(title, 'utf8');
    const descBuf = Buffer.from(desc, 'utf8');

    guardU32(jsonBuf.length, '代码 JSON 载荷');
    guardU32(titleBuf.length, '标题');
    guardU32(descBuf.length, '描述');
    guardU32(ENGINE.length, '引擎 ID');

    const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(guardU32(v, 'u32 字段')); return b; };
    const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(guardU64(v, 'u64 字段'))); return b; };
    const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
    const tag = (s) => Buffer.from(s, 'latin1');

    const inner = Buffer.concat([
        // 序言（固定 36 字节，三个真实样本逐字节一致）
        Buffer.from('00ff4b530200' + '707263530100200000' + '00' + '3170726353' + '01' + '00000000' + '00' + '74706353' + '03000002' + '2b', 'hex'),
        tag('gfnC'), u32(jsonBuf.length), jsonBuf,
        Buffer.from('2b', 'hex'), tag('ngnE'), u32(ENGINE.length), Buffer.from(ENGINE, 'utf8'),
        Buffer.from('2b', 'hex'), tag('cseD'), u32(descBuf.length), descBuf,
        Buffer.from('2b', 'hex'), tag('ltit'), u32(titleBuf.length), titleBuf,
        Buffer.from('04', 'hex'), tag('mreP'), u64(0),
        Buffer.from('29' + '72546e55' + '0017' + '64697555', 'hex'), guid,
        Buffer.from('0000', 'hex'),
    ]);

    // ---------- zstd 压缩 ----------
    const frame = zlib.zstdCompressSync(inner);

    // ---------- 外层容器 ----------
    const ts = Math.floor(Date.now() / 1000);
    const FILENAME = 'Script.dat';
    const fnBuf = Buffer.from(FILENAME, 'latin1');
    guardU16Check(fnBuf.length);

    const tailSize = 4 + 8 * 5 + 4 * 5 + 8 * 3 + 4 + 5 + 4 + 2 + fnBuf.length;
    const fileSize = guardU64(76 + frame.length + 4 + tailSize, '文件总长');

    const crcPayload = zlib.crc32(inner);
    const crcFrame = zlib.crc32(frame);

    const tailBuf = Buffer.concat([
        tag('#FT4'),
        u64(0), u64(ts), u64(fileSize), u64(frame.length), u64(0),
        u32(1), u32(0), u32(0x36), u32(0x01000000), u32(0),
        u64(0x48), u64(inner.length), u64(frame.length),
        u32(crcPayload),
        Buffer.from('0220000000', 'hex'),
        u32(crcFrame),
        u16(fnBuf.length),
        fnBuf,
    ]);

    const header = Buffer.concat([
        Buffer.from('00ff4b41', 'hex'), u32(12), tag('prcS'), tag('#Inf'),
        u64(76 + frame.length + 4),              // @16 → #FT4 偏移
        u64(fileSize),
        u64(frame.length),
        u64(0),
        u64(ts),
        u32(2), u32(2),
        tag('Prot'), u32(4), tag('#Fil'),
    ]);

    const out = Buffer.concat([header, frame, Buffer.from('ffffffff', 'hex'), tailBuf]);

    // ---------- 自校验 ----------
    const checks = [];
    function check(name, ok, detail = '') {
        checks.push([name, ok, detail]);
        if (!ok) throw new RunError(`自校验失败: ${name} ${detail}`.trim());
    }

    // 1. 头部字段回读
    check('magic', out.subarray(0, 4).equals(Buffer.from('00ff4b41', 'hex')));
    check('版本=12', out.readUInt32LE(4) === 12);
    const ft4Off = Number(out.readBigUInt64LE(16));
    check('@16 指向 #FT4', ft4Off + 4 <= out.length && out.subarray(ft4Off, ft4Off + 4).toString('latin1') === '#FT4',
        `(@16=${ft4Off}, 文件长=${out.length})`);
    check('@24=文件长', Number(out.readBigUInt64LE(24)) === out.length);
    check('@32=帧长', Number(out.readBigUInt64LE(32)) === frame.length);

    // 2. 尾部字段回读 + CRC **实际比对**（K5）
    const t = ft4Off;
    const tailTime = out.readBigUInt64LE(t + 4 + 8);
    check('尾部时间戳一致', tailTime === out.readBigUInt64LE(48));
    check('尾部文件长一致', Number(out.readBigUInt64LE(t + 4 + 16)) === out.length);
    check('尾部帧长一致', Number(out.readBigUInt64LE(t + 4 + 24)) === frame.length);
    check('尾部解压载荷长一致', Number(out.readBigUInt64LE(t + 72)) === inner.length,
        `(读 ${out.readBigUInt64LE(t + 72)} vs ${inner.length})`);
    check('尾部 zstd 帧长一致', Number(out.readBigUInt64LE(t + 80)) === frame.length);

    // CRC 字段位置：#FT4(4) u64×5(40) u32×5(20) u64 0x48(8) u64 载荷长(8) u64 帧长(8) → +4 CRC载荷
    // 尾部字段的精确偏移（全部按字节手工核算过）：
    //   t+0   "#FT4"(4)
    //   t+4   u64×5 = 40        → t+44
    //   t+44  u32×5 = 20        → t+64
    //   t+64  u64 0x48          → t+72
    //   t+72  u64 解压载荷长     → t+80
    //   t+80  u64 zstd 帧长      → t+88
    //   t+88  u32 CRC32(载荷)    → t+92
    //   t+92  5 字节常量        → t+97
    //   t+97  u32 CRC32(帧)      → t+101
    //   t+101 u16 文件名长       → t+103
    const crcPayloadAt = t + 88;
    const crcFrameAt = crcPayloadAt + 4 + 5;
    check('尾部 CRC32(载荷) 回读一致', out.readUInt32LE(crcPayloadAt) === crcPayload,
        `(读 ${out.readUInt32LE(crcPayloadAt)} vs 算 ${crcPayload})`);
    check('尾部 CRC32(zstd帧) 回读一致', out.readUInt32LE(crcFrameAt) === crcFrame,
        `(读 ${out.readUInt32LE(crcFrameAt)} vs 算 ${crcFrame})`);
    const nameLenAt = crcFrameAt + 4;
    const nameLen = out.readUInt16LE(nameLenAt);
    check('尾部文件名一致', out.subarray(nameLenAt + 2, nameLenAt + 2 + nameLen).toString('latin1') === FILENAME);

    // 3. 解压回读逐字节一致
    let reInner;
    try {
        reInner = zlib.zstdDecompressSync(out.subarray(76, 76 + frame.length));
    } catch (e) {
        throw new RunError(`zstd 解压失败: ${e.message}`);
    }
    check('zstd 解压回读一致', reInner.equals(inner), `(${reInner.length} vs ${inner.length})`);

    // 4. 记录结构回读（K4：每一步都先确认标签存在、长度不越界）
    const g = readTaggedRecord(reInner, Buffer.from('gfnC', 'latin1'), { what: 'gfnC(代码)' });
    const parsed = JSON.parse(reInner.subarray(g.dataAt, g.dataAt + g.len).toString('utf8'));
    check('code 逐字节还原', parsed.code === code);
    check('含 asModule=false', parsed.asModule === false);

    const tRec = readTaggedRecord(reInner, Buffer.from('2b6c746974', 'hex'), { extraSkip: 1, what: 'ltit(标题)' });
    check('标题还原', reInner.subarray(tRec.dataAt, tRec.dataAt + tRec.len).toString('utf8') === title);

    const dRec = readTaggedRecord(reInner, Buffer.from('2b63736544', 'hex'), { extraSkip: 1, what: 'cseD(描述)' });
    check('描述还原', reInner.subarray(dRec.dataAt, dRec.dataAt + dRec.len).toString('utf8') === desc);

    const eRec = readTaggedRecord(reInner, Buffer.from('2b6e676e45', 'hex'), { extraSkip: 1, what: 'ngnE(引擎)' });
    check('引擎 ID 正确', reInner.subarray(eRec.dataAt, eRec.dataAt + eRec.len).toString('utf8') === ENGINE);

    const mAt = reInner.indexOf(Buffer.from('046d726550', 'hex'));
    check('mreP 记录存在', mAt >= 0);
    check('权限位=0（待导入后修复）', reInner.readBigUInt64LE(mAt + 5) === 0n);

    // ---------- 输出（K2 覆盖保护 + K6 原子写）----------
    const outFile = opt.out || (path.basename(opt.js).replace(/\.js$/i, '') + '.afscript');
    if (fs.existsSync(outFile) && !opt.force) {
        throw new UsageError(`输出文件已存在: ${outFile}`,
            '换一个 --out 路径，或加 --force 覆盖');
    }
    atomicWriteFileSync(outFile, out);

    // K7：区分字节数与字符数（中文标题下两者差别很大）
    console.log(`✓ 已生成 ${outFile}`);
    console.log(`    文件大小: ${out.length} 字节`);
    console.log(`    标题: ${title}  (${title.length} 字符 / ${Buffer.byteLength(title, 'utf8')} UTF-8 字节)`);
    console.log(`    代码: ${code.length} 字符 / ${Buffer.byteLength(code, 'utf8')} UTF-8 字节`);
    console.log(`    压缩帧: ${frame.length} 字节   解压载荷: ${inner.length} 字节`);
    console.log(`    自校验: ${checks.length}/${checks.length} 通过（解压回读逐字节比对 + 双 CRC 回读比对）`);
    console.log(`
导入步骤：
  ① Affinity 脚本面板▸ 库菜单 ▸ 导入脚本 → 选这个文件
  ② 完全退出 Affinity（权限设置在退出时才写盘）
  ③ 用 fix-script-perms.mjs 修复权限（默认 dry-run，加--apply 才写入）
  ④ 重启 Affinity → 脚本可读写文件`);
    return EXIT.OK;
}

function guardU16Check(n) {
    if (n > 0xFFFF) throw new RunError(`文件名长度 ${n} 超出 u16 上限`);
}

const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    process.exitCode = await runMain(main);
}

export { main, USAGE };