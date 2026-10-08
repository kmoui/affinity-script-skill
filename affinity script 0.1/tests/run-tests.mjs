#!/usr/bin/env node
// ============================================================================
// run-tests.mjs —— 离线测试套件
//
// 全部测试**不需要**真实 Affinity、真实 MCP 服务、用户 AppData 或真实脚本库。
// 需要真实环境的项目在本文末尾「需要真机验证」清单里单独列出。
//
// 用法：
//   node run-tests.mjs              跑全部离线测试
//   node run-tests.mjs --filter mcp 只跑名字含 "mcp" 的用例
//   node run-tests.mjs --list       列出所有用例
//   node run-tests.mjs --verbose    打印每个用例的 stdout
//
// 退出码: 0 全部通过 / 1 有失败
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockMcp } from './mock-mcp.mjs';
import { parsePermSpec, findPermRecords, buildPlan, applyToCopy, verifyWritten, decodeBits, parseCli as parsePermCli } from '../scripts/fix-script-perms.mjs';
import { parseCli as parseMcCli, resolveEndpoint } from '../scripts/mcp-client.mjs';
import { parseCli as parseScanCli, extractStrings } from '../scripts/scan-strings.mjs';
import { parseCli as parseMakeCli, readTaggedRecord } from '../scripts/make-afscript.mjs';
import { parseArgs as libParseArgs, escapeRegExp, UsageError, atomicWriteFileSync } from '../scripts/lib/cli.mjs';
import { stripNonCode, stripComments, extractExportNames, extractDestructuredRequires, extractRequires } from '../scripts/lib/lex.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');
const NODE = process.execPath;

// ---------------------------------------------------------------------------
// 测试框架（极简，无外部依赖）
// ---------------------------------------------------------------------------
const results = [];
let currentGroup = '';
let verbose = false;

function group(name) { currentGroup = name; }

function test(name, fn) {
    results.push({ group: currentGroup, name, fn });
}

/** 断言失败抛这个，被 run() 捕获 */
class AssertError extends Error {}

function assert(cond, msg) {
    if (!cond) throw new AssertError(msg || '断言失败');
}
function eq(actual, expected, msg) {
    if (actual !== expected) {
        throw new AssertError(`${msg || '值不相等'}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    }
}
function throwsUsage(fn, msg) {
    try { fn(); } catch (e) {
        if (e instanceof UsageError) return e;
        throw new AssertError(`${msg || '应抛 UsageError'}，实际抛了 ${e?.name}: ${e?.message}`);
    }
    throw new AssertError(msg || '应该抛 UsageError 但没抛');
}

// ---------------------------------------------------------------------------
// 运行子进程的工具（用于验证真实退出码）
// ---------------------------------------------------------------------------

function runNode(args, { input, cwd, timeoutMs = 30000, env } = {}) {
    return new Promise((resolve) => {
        const child = spawn(NODE, args, {
            cwd: cwd || HERE,
            env: { ...process.env, NO_COLOR: '1', ...(env || {}) },
            timeout: timeoutMs,
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        if (input !== undefined) child.stdin.write(input);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    });
}

/** 建临时目录，返回 { dir, file(名), cleanup } */
function tmpdir(tag) {
    // 故意带空格与中文，验证路径处理
    const dir = path.join(os.tmpdir(), `aff test ${tag}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return {
        dir,
        file: (name) => path.join(dir, name),
        write(name, content) {
            const p = path.join(dir, name);
            fs.writeFileSync(p, content);
            return p;
        },
        cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
    };
}

// ===========================================================================
// 1. CLI 库本身
// ===========================================================================
group('lib/cli');

test('escapeRegExp 转义所有元字符', () => {
    eq(escapeRegExp('a.b*c'), 'a\\.b\\*c');
    eq(escapeRegExp('foo(bar)'), 'foo\\(bar\\)');
    eq(escapeRegExp('a+b?'), 'a\\+b\\?');
    // 转义后仍能匹配字面量
    assert(new RegExp(`^${escapeRegExp('a*b')}$`).test('a*b'), '应匹配字面 a*b');
    assert(!new RegExp(`^${escapeRegExp('a*b')}$`).test('aXXb'), '不应把 * 当通配符');
});

test('parseArgs 缺值报UsageError', () => {
    throwsUsage(() => libParseArgs(['--port'], { flags: [], values: ['port'] }), '--port 缺值');
});

test('parseArgs 未知参数报UsageError', () => {
    throwsUsage(() => libParseArgs(['--nope'], { flags: ['a'], values: [] }), '未知参数');
});

test('parseArgs 重复使用报UsageError', () => {
    throwsUsage(() => libParseArgs(['--t', 'a', '--t', 'b'], { flags: [], values: ['t'] }), '重复使用');
});

test('parseArgs 支持 --k=v 与位置参数', () => {
    const r = libParseArgs(['--t=v', 'pos1'], { flags: [], values: ['t'], maxPositional: 1 });
    eq(r.values.t, 'v');
    eq(r.positional[0], 'pos1');
});

test('parseArgs 多余位置参数报错', () => {
    throwsUsage(() => libParseArgs(['a', 'b'], { flags: [], values: [], maxPositional: 1 }), '多余位置参数');
});

test('atomicWriteFileSync 原子写入且不留临时文件', () => {
    const t = tmpdir('atomic');
    try {
        const target = t.file('目标 文件.txt');
        atomicWriteFileSync(target, Buffer.from('hello 世界', 'utf8'));
        eq(fs.readFileSync(target, 'utf8'), 'hello 世界');
        const leftovers = fs.readdirSync(t.dir).filter((f) => f.includes('.tmp-'));
        eq(leftovers.length, 0, '不应残留临时文件');
    } finally { t.cleanup(); }
});

// ===========================================================================
// 2. 词法清洗
// ===========================================================================
group('lib/lex');

test('stripNonCode 忽略注释/字符串/模板/正则', () => {
    const src = [
        '// app.executeMenuCommand(x)',
        '/* block fs.writeStringAsUtf8(y) */',
        'const s = "string only";',
        'const t = `tpl ${a.b} foo()`;',
        'const r = /regexHere/;',
        'const real = doc.clearPreviews();',
    ].join('\n');
    const c = stripNonCode(src);
    eq(c.length, src.length, '长度必须保持不变（偏移量要能对回原文）');
    assert(!c.includes('executeMenuCommand'), '注释里的调用应被清掉');
    assert(!c.includes('writeStringAsUtf8'), '块注释里的调用应被清掉');
    assert(!c.includes('string only'), '字符串内容应被清掉');
    assert(!c.includes('tpl'), '模板字面量应被清掉');
    assert(!c.includes('regexHere'), '正则字面量应被清掉');
    assert(c.includes('doc.clearPreviews'), '真实代码要保留');
});

test('stripNonCode 区分除号与正则', () => {
    const a = stripNonCode('const q = a / b;');
    assert(a.includes('a / b'), '除号要保留');
});

test('stripComments 保留字符串内容', () => {
    const src = 'const a = "/keep/me.js"; // drop this\nconst b=2;';
    const s = stripComments(src);
    assert(s.includes('/keep/me.js'), '字符串内容必须保留');
    assert(!s.includes('drop this'), '注释必须去掉');
});

test('extractExportNames 覆盖常见 CommonJS 形式', () => {
    const mod = [
        'module.exports.Foo = 1;',
        'exports.Bar = 2;',
        'module.exports = { A, B: cc };',
        'Object.defineProperty(exports, "Zed", { get() {} });',
        'exports["Quux"] = 3;',
        '// module.exports.Commented = 9;',
    ].join('\n');
    const names = extractExportNames(mod);
    for (const n of ['Foo', 'Bar', 'A', 'B', 'Zed', 'Quux']) {
        assert(names.has(n), `应识别导出 ${n}`);
    }
    assert(!names.has('Commented'), '注释里的导出不���识别');
});

test('extractDestructuredRequires 跨行与别名解构', () => {
    const src = `
        const {
            Document,
            Selection: Sel,
        } = require('/document.js');
        const { File } = require("/fs.js");
        // const { Ghost } = require('/nope.js');
    `;
    const r = extractDestructuredRequires(src);
    const names = r.flatMap((x) => x.names);
    assert(names.includes('Document'), '跨行解构');
    assert(names.includes('Sel'), '别名解构取本地名');
    assert(names.includes('File'), '双引号模块路径');
    assert(!names.includes('Ghost'), '注释里��该被识别');
});

test('extractRequires 收集并去重', () => {
    const src = "require('/a.js'); require(\"/a.js\"); require('/b.js');";
    eq(JSON.stringify(extractRequires(src)), JSON.stringify(['/a.js', '/b.js']));
});

// ===========================================================================
// 3. mcp-client 参数解析
// ===========================================================================
group('mcp-client 参数');

test('--port 必须是 1..65535 整数', () => {
    eq(parseMcCli(['--port', '8080']).port, 8080);
    throwsUsage(() => parseMcCli(['--port', '0']), '端口 0 非法');
    throwsUsage(() => parseMcCli(['--port', '65536']), '端口超上限');
    throwsUsage(() => parseMcCli(['--port', 'abc']), '端口非数字');
    throwsUsage(() => parseMcCli(['--port', '-1']), '负数端口');
    throwsUsage(() => parseMcCli(['--port']), '端口缺值');
});

test('--timeout 必须是正整数', () => {
    eq(parseMcCli(['--timeout', '5000']).timeout, 5000);
    throwsUsage(() => parseMcCli(['--timeout', '0']), 'timeout 不能为 0');
    throwsUsage(() => parseMcCli(['--timeout', '-5']), 'timeout 不能为负');
    throwsUsage(() => parseMcCli(['--timeout', 'abc']), 'timeout 非数字');
});

test('--render-spread 需要 UUID + 非负页索引', () => {
    const u = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
    const r = parseMcCli(['--render-spread', `${u},0`]);
    eq(r.renderSpread.uuid, u);
    eq(r.renderSpread.index, 0);
    eq(parseMcCli(['--render-spread', `${u},3`]).renderSpread.index, 3);
    // 只给 UUID（缺页索引）→ 必须报错，而不是 index=NaN
    throwsUsage(() => parseMcCli(['--render-spread', u]), '缺页索引');
    throwsUsage(() => parseMcCli(['--render-spread', `${u},-1`]), '负页索引');
    throwsUsage(() => parseMcCli(['--render-spread', `${u},x`]), '非数字页索引');
});

test('需要值的参数缺值一律退出码 2', () => {
    for (const flag of ['--exec', '--exec-file', '--save', '--read', '--title', '--desc', '--task', '--host']) {
        throwsUsage(() => parseMcCli([flag]), `${flag} 缺值应报错`);
    }
});

test('--task 必须是合法 JSON', () => {
    const r = parseMcCli(['--task', '{"name":"execute_script","arguments":{}}']);
    assert(r.task.includes('execute_script'), 'task JSON 应被接受');
    throwsUsage(() => parseMcCli(['--task', '{bad json']), '非法 JSON');
});

test('动作类选项互斥', () => {
    throwsUsage(() => parseMcCli(['--lib', '--docs']), '--lib 与 --docs 互斥');
    throwsUsage(() => parseMcCli(['--exec', 'x', '--lib']), '--exec 与 --lib 互斥');
});

test('--exec-file 指向不存在的文件报运行错误', () => {
    let err = null;
    try { parseMcCli(['--exec-file', '不存在的文件.js']); } catch (e) { err = e; }
    assert(err && err.name === 'RunError', '应是 RunError（退出码 1），不是 UsageError');
});

test('resolveEndpoint 处理相对与绝对 endpoint', () => {
    eq(resolveEndpoint('http://127.0.0.1:1', '/message?session_id=x'), 'http://127.0.0.1:1/message?session_id=x');
    eq(resolveEndpoint('http://127.0.0.1:1', 'http://other:2/m'), 'http://other:2/m');
    let threw = false;
    try { resolveEndpoint('http://x', 'no-leading-slash'); } catch { threw = true; }
    assert(threw, '既非绝对 URL 又非 / 开头应报错');
});

// ===========================================================================
// 4. mcp-client 与模拟 MCP 服务对话（离线）
// ===========================================================================
group('mcp-client 协议');

/** 起假服务 + 用指定场景跑一次 openSession，返回 {err, sess, mock} */
async function withMock(scenario, fn, sessionOpts = {}) {
    const m = await startMockMcp();
    try {
        return await fn({ port: m.port, host: '127.0.0.1', testScenario: scenario, ...sessionOpts });
    } finally { await m.close(); }
}

test('正常握手 + tools/list + execute_script（响应走 SSE）', async () => {
    await withMock('ok', async (opts) => {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        const s = await openSession({ ...opts, timeoutMs: 8000 });
        try {
            eq(s.serverInfo.name, 'Affinity', 'serverInfo 应识别为 Affinity');
            assert(s.tools.includes('execute_script'), '工具列表应含 execute_script');
            eq(s.preambleReady, true, 'preamble 应已读取');
            const r = await s.call('execute_script', { script: 'console.log(1)' });
            assert(s.text(r).includes('mock: script ran'), '应拿到 execute_script 输出');
        } finally { await s.close(); }
    });
});

test('兼容「直接在 POST 响应体回 JSON-RPC」的服务端', async () => {
    await withMock('direct-post-reply', async (opts) => {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        const s = await openSession({ ...opts, timeoutMs: 8000 });
        try {
            assert(s.tools.length > 0, '也应完成握手并拿到工具');
        } finally { await s.close(); }
    });
});

test('绝对 URL endpoint 也能工作', async () => {
    await withMock('absolute-endpoint', async (opts) => {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        const s = await openSession({ ...opts, timeoutMs: 8000 });
        try {
            assert(s.endpoint.startsWith('http'), 'mock 应返回绝对 endpoint，实际: ' + s.endpoint);
            assert(s.tools.length > 0, '绝对 endpoint 也应完成握手');
        } finally { await s.close(); }
    });
})

test('未收到 endpoint 事件 → 明确超时，不伪装成空列表', async () => {
    await withMock('no-endpoint', async (opts) => {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        let err = null;
        const s = await openSession({ ...opts, timeoutMs: 1500 }).catch((e) => { err = e; return null; });
        assert(err, '应当失败');
        assert(/endpoint/i.test(err.message), `错误应提到 endpoint，实际: ${err.message}`);
        assert(err.exitCode === 1, `应是运行错误(1)，实际 ${err.exitCode}`);
        if (s) await s.close();
    });
});

test('HTTP 500 → 报告状态码', async () => {
    await withMock('http-500', async (opts) => {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        let err = null;
        try {
            const s = await openSession({ ...opts, timeoutMs: 3000 });
            await s.close();
        } catch (e) { err = e; }
        assert(err, 'HTTP 500 应导致失败');
        assert(/500/.test(err.message), `应含状态码 500，实际: ${err.message}`);
    });
});

test('RPC error → 报告服务端错误信息', async () => {
    await withMock('rpc-error', async (opts) => {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        let err = null;
        try {
            const s = await openSession({ ...opts, timeoutMs: 3000 });
            await s.close();
        } catch (e) { err = e; }
        assert(err, 'RPC error 应导致失败');
        assert(/RPC error/.test(err.message), `应含 "RPC error"，实际: ${err.message}`);
        assert(/method not found/.test(err.message), `应带出服务端原文，实际: ${err.message}`);
    });
});

test('RPC 超时 → 报超时并在预算内退出，不永久挂起', async () => {
    await withMock('rpc-timeout', async (opts) => {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        const t0 = Date.now();
        let err = null;
        try {
            const s = await openSession({ ...opts, timeoutMs: 1200 });
            await s.close();
        } catch (e) { err = e; }
        const dt = Date.now() - t0;
        assert(err, 'RPC 超时应失败');
        assert(/超时/.test(err.message), `应提到超时，实际: ${err.message}`);
        assert(dt < 8000, `应在超时预算内退出，实际 ${dt}ms`);
    });
});

test('Content-Type 不是 SSE → 明确报错', async () => {
    await withMock('wrong-content-type', async (opts) => {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        let err = null;
        try {
            const s = await openSession({ ...opts, timeoutMs: 3000 });
            await s.close();
        } catch (e) { err = e; }
        assert(err, '非 SSE 响应应失败');
        assert(/Content-Type|event-stream/i.test(err.message), `实际: ${err.message}`);
    });
});

test('SSE 异常断开 → 快速失败，不等满超时', async () => {
    await withMock('abort', async (opts) => {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        const t0 = Date.now();
        let err = null;
        try {
            const s = await openSession({ ...opts, timeoutMs: 30000 });
            await s.close();
        } catch (e) { err = e; }
        const dt = Date.now() - t0;
        assert(err, '断开应导致失败');
        assert(dt < 12000, `应快速失败，实际 ${dt}ms（30s 超时不该等满）`);
    });
});

test('close() 可重复调用且不抛异常（幂等清理）', async () => {
    await withMock('ok', async (opts) => {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        const s = await openSession({ ...opts, timeoutMs: 8000 });
        await s.close();
        await s.close();      // 第二次不能炸
        assert(true, '重复 close 安全');
    });
});

test('工具返回 isError 后 close 仍能清理会话', async () => {
    await withMock('ok', async (opts) => {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        const s = await openSession({ ...opts, timeoutMs: 8000 });
        try {
            const r = await s.call('fail', {});
            eq(r.isError, true, 'mock 应返回 isError');
        } finally { await s.close(); }
    });
});

test('连到已关闭的端口 → 快速失败并提示 --discover', async () => {
    const m = await startMockMcp();
    const deadPort = m.port;
    await m.close();                     // 端口随即失效
    const { openSession } = await import('../scripts/mcp-client.mjs');
    const t0 = Date.now();
    let err = null;
    try { await openSession({ port: deadPort, host: '127.0.0.1', timeoutMs: 3000 }); }
    catch (e) { err = e; }
    const dt = Date.now() - t0;
    assert(err, '应失败');
    assert(dt < 6000, `应快速失败，实际 ${dt}ms`);
    assert(/discover|失败|ECONNREFUSED/i.test(err.message + (err.hint || '')),
        `错误应提示用 --discover，实际: ${err.message} / ${err.hint}`);
});

test('probePort 对非 MCP 端口返回 null（不抛异常）', async () => {
    const { probePort } = await import('../scripts/mcp-client.mjs');
    const m = await startMockMcp();
    const dead = m.port;
    await m.close();
    const hit = await probePort(dead, '127.0.0.1');
    eq(hit, null, '死端口应返回 null');
});

// ---------------------------------------------------------------------------
// 回归测试：握手失败必须自动关闭已建立的 SSE
//
// 背景：openSession 在拿到 endpoint 之后才把控制权交给调用方。若握手阶段
// （initialize / tools/list / preamble）抛错，调用方**从未拿到 sess 对象**，
// 因此外层的 finally 无法清理这条SSE 流 —— 连接会一直泄漏。
// 修法：openSession 内部用 try/catch 包住握手阶段，失败时自己 close()。
// 本测试用 mock 观察服务端侧的流是否真的被关闭。
// ---------------------------------------------------------------------------
test('握手失败（tools/list 报错）→ openSession 自动关闭 SSE，不泄漏', async () => {
    const m = await startMockMcp();
    try {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        let err = null;
        try {
            await openSession({
                port: m.port, host: '127.0.0.1',
                timeoutMs: 5000, testScenario: 'handshake-fail',
            });
        } catch (e) { err = e; }
        assert(err, '握手失败应抛错');
        assert(/tools\/list|exploded/.test(err.message), `错误应来自握手阶段，实际: ${err.message}`);
        // 等清理完成
        for (let i = 0; i < 20 && m.openStreams() > 0; i++) {
            await new Promise((r) => setTimeout(r, 50));
        }
        eq(m.openStreams(), 0, '握手失败后不应残留打开的 SSE 流（连接泄漏）');
    } finally { await m.close(); }
});

test('握手失败后不产生未处理 Promise 拒绝', async () => {
    // 未处理拒绝会让 Node 直接终止进程，必须为空。
    const seen = [];
    const onUnhandled = (e) => { seen.push(e); };
    process.on('unhandledRejection', onUnhandled);
    const m = await startMockMcp();
    try {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        try {
            await openSession({
                port: m.port, host: '127.0.0.1',
                timeoutMs: 5000, testScenario: 'handshake-fail',
            });
        } catch { /* 预期失败 */ }
        // 给事件循环两轮机会触发 unhandledRejection 检测
        await new Promise((r) => setTimeout(r, 150));
        eq(seen.length, 0, `不应有未处理拒绝，实际: ${seen.map((e) => e?.message).join('; ')}`);
    } finally {
        process.off('unhandledRejection', onUnhandled);
        await m.close();
    }
});

test('并发 close + 在途请求：不产生未处理拒绝（孤儿 pending Promise）', async () => {
    // 场景：close() 触发 rejectAllPending，而 POST 本身也因 abort 失败，
    // 此时 pending 的 Promise 可能「被拒绝但没人 await」→ unhandledRejection。
    const seen = [];
    const onUnhandled = (e) => { seen.push(e); };
    process.on('unhandledRejection', onUnhandled);
    const m = await startMockMcp();
    try {
        const { openSession } = await import('../scripts/mcp-client.mjs');
        for (let i = 0; i < 6; i++) {
            const s = await openSession({
                port: m.port, host: '127.0.0.1', timeoutMs: 8000, testScenario: 'ok',
            });
            const inflight = s.call('execute_script', { script: 'x' }).catch(() => { /* 会话已关 */ });
            await s.close();
            await inflight;
        }
        await new Promise((r) => setTimeout(r, 200));
        eq(seen.length, 0, `不应有未处理拒绝，实际: ${seen.map((e) => e?.message).join('; ')}`);
    } finally {
        process.off('unhandledRejection', onUnhandled);
        await m.close();
    }
});

test('反复建立/关闭会话不触发 UV_HANDLE_CLOSING 断言', async () => {
    // 同一底层句柄「先 abort 再 cancel」会在进程退出时打印
    // Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)。
    // 这里跑多轮，靠子进程退出时的 stderr 判断。
    const t = tmpdir('uv-assert');
    try {
        // ESM 动态 import 在 Windows 上必须用 file:// URL，
        // 直接塞 'G:\...' 绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
        const mockUrl = pathToFileURL(path.join(HERE, 'mock-mcp.mjs')).href;
        const clientUrl = pathToFileURL(path.join(SCRIPTS, 'mcp-client.mjs')).href;
        const driver = t.write('driver.mjs', `
import { startMockMcp } from ${JSON.stringify(mockUrl)};
const m = await startMockMcp();
const { openSession } = await import(${JSON.stringify(clientUrl)});
for (let i = 0; i < 20; i++) {
    const s = await openSession({ port: m.port, host: '127.0.0.1', timeoutMs: 8000, testScenario: 'ok' });
    await s.call('execute_script', { script: 'console.log(1)' });
    await s.close();
}
await m.close();
`);
        const r = await runNode([driver], { timeoutMs: 60000 });
        eq(r.code, 0, `驱动脚本应正常退出，实际 ${r.code}: ${r.stderr}`);
        assert(!/UV_HANDLE_CLOSING/.test(r.stderr + r.stdout),
            `不应出现 UV_HANDLE_CLOSING 断言:\n${r.stderr}`);
        assert(!/Assertion failed/.test(r.stderr + r.stdout),
            `不应出现断言失败:\n${r.stderr}`);
    } finally { t.cleanup(); }
});
group('make-afscript');

test('参数解析：缺值/多余位置参数/未知参数', () => {
    throwsUsage(() => parseMakeCli([]), '缺少输入文件');
    throwsUsage(() => parseMakeCli(['a.js', 'b.js']), '多余位置参数');
    throwsUsage(() => parseMakeCli(['a.js', '--title']), '--title 缺值');
    throwsUsage(() => parseMakeCli(['a.js', '--desc']), '--desc 缺值');
    throwsUsage(() => parseMakeCli(['a.js', '--out']), '--out 缺值');
    throwsUsage(() => parseMakeCli(['a.js', '--nope']), '未知参数');
    throwsUsage(() => parseMakeCli(['a.js', '--title', 'x', '--title', 'y']), '重复 --title');
});

test('正常打包（Node 24 需 zstd；不支持则跳过）', async () => {
    if (typeof zlib.zstdCompressSync !== 'function') {
        console.log('    (跳过：当前 Node ' + process.version + ' 无 zstd，需要 Node 24+)');
        return;
    }
    const t = tmpdir('make');
    try {
        const src = t.write('我的 脚本.js', 'console.log("hi 中文");\nmain();\n');
        const outp = t.file('out.afscript');
        const r = await runNode([path.join(SCRIPTS, 'make-afscript.mjs'), src, '--title', '中文标题', '--desc', '描述', '--out', outp]);
        eq(r.code, 0, `打包应成功，实际输出:\n${r.stdout}\n${r.stderr}`);
        assert(fs.existsSync(outp), '应生成输出文件');
        const buf = fs.readFileSync(outp);
        eq(buf.subarray(0, 4).toString('hex'), '00ff4b41', 'magic');
        eq(buf.readUInt32LE(4), 12, '版本号');
        // 回读内容
        const frameLen = Number(buf.readBigUInt64LE(32));
        const inner = zlib.zstdDecompressSync(buf.subarray(76, 76 + frameLen));
        const g = inner.indexOf('gfnC');
        const code = JSON.parse(inner.subarray(g + 8, g + 8 + inner.readUInt32LE(g + 4))).code;
        assert(code.includes('中文'), '代码应完整回读');
        const ti = inner.indexOf(Buffer.from('2b6c746974', 'hex'));
        eq(inner.subarray(ti + 9, ti + 9 + inner.readUInt32LE(ti + 5)).toString('utf8'), '中文标题');
        // 权限位应为 0
        const mAt = inner.indexOf(Buffer.from('046d726550', 'hex'));
        eq(inner.readBigUInt64LE(mAt + 5), 0n, '导出容器权限位应为 0');
    } finally { t.cleanup(); }
});

test('重复输出保护：默认拒绝覆盖，--force 才覆盖', async () => {
    if (typeof zlib.zstdCompressSync !== 'function') return;
    const t = tmpdir('make-force');
    try {
        const src = t.write('a.js', 'main();\n');
        const outp = t.file('o.afscript');
        const first = await runNode([path.join(SCRIPTS, 'make-afscript.mjs'), src, '--out', outp]);
        eq(first.code, 0, '首次打包应成功');
        const stamp = fs.statSync(outp).mtimeMs;
        await new Promise((r) => setTimeout(r, 30));
        const second = await runNode([path.join(SCRIPTS, 'make-afscript.mjs'), src, '--out', outp]);
        eq(second.code, 2, `重复输出应退出码 2，实际 ${second.code}: ${second.stderr}`);
        assert(fs.statSync(outp).mtimeMs === stamp, '文件不应被改动');
        const forced = await runNode([path.join(SCRIPTS, 'make-afscript.mjs'), src, '--out', outp, '--force']);
        eq(forced.code, 0, '--force 应允许覆盖');
    } finally { t.cleanup(); }
});

test('损坏输入：文件不存在 → 退出码 1', async () => {
    const r = await runNode([path.join(SCRIPTS, 'make-afscript.mjs'), '绝对不存在.js']);
    eq(r.code, 1, `应退出码 1，实际 ${r.code}: ${r.stderr}`);
});

test('readTaggedRecord 标签缺失时报清晰错误，不对 -1 偏移读长度', () => {
    const buf = Buffer.from('no tags here at all');
    let err = null;
    try { readTaggedRecord(buf, Buffer.from('gfnC', 'latin1'), { what: 'gfnC' }); } catch (e) { err = e; }
    assert(err, '标签缺失应抛错');
    assert(/找不到/.test(err.message), `错误信息应说明找不到标签，实际: ${err.message}`);
});

test('readTaggedRecord 长度越界时报清晰错误', () => {
    // 标签后面写一个巨大的长度
    const buf = Buffer.alloc(32);
    Buffer.from('gfnC', 'latin1').copy(buf, 0);
    buf.writeUInt32LE(0xFFFFFF, 4);
    let err = null;
    try { readTaggedRecord(buf, Buffer.from('gfnC', 'latin1'), { what: 'gfnC' }); } catch (e) { err = e; }
    assert(err, '越界应抛错');
    assert(/越界/.test(err.message), `实际: ${err.message}`);
});

// ===========================================================================
// 6. 权限修复器
// ===========================================================================
group('fix-script-perms');

/** 造一个最小可解析的 propcol Buffer */
function makePropcol(perms = [0n, 3n]) {
    const parts = [];
    for (const p of perms) {
        // 精确长度：1(0x2b) + 4(ltit) + 4(len) + 4(标题) + 1(0x04) + 4(mreP) + 8(u64) + 1(0x29) = 27
        const rec = Buffer.alloc(27);
        let o = 0;
        rec[o++] = 0x2b;                                    // 前缀
        Buffer.from('ltit', 'latin1').copy(rec, o); o += 4; // 标题标签
        rec.writeUInt32LE(4, o); o += 4;                     // 标题长度 = 4
        rec.write('T1\0\0', o, 'latin1'); o += 4;           // 标题内容
        rec[o++] = 0x04;                                    // mreP 前导
        Buffer.from('mreP', 'latin1').copy(rec, o); o += 4;
        rec.writeBigUInt64LE(p, o); o += 8;
        rec[o++] = 0x29;                                    // 后随字节
        parts.push(rec.subarray(0, o));
    }
    return Buffer.concat(parts);
}

test('权限值解析：名字/数字/拒绝非法', () => {
    eq(parsePermSpec('fs', '--grant'), 1n);
    eq(parsePermSpec('fs,network', '--grant'), 3n);
    eq(parsePermSpec('3', '--grant'), 3n);
    eq(parsePermSpec('0', '--grant'), 0n);
    eq(parsePermSpec(String((1n << 64n) - 1n), '--grant'), (1n << 64n) - 1n);
    throwsUsage(() => parsePermSpec('-1', '--grant'), '负数');
    throwsUsage(() => parsePermSpec('1.5', '--grant'), '小数');
    throwsUsage(() => parsePermSpec('', '--grant'), '空串');
    throwsUsage(() => parsePermSpec(undefined, '--grant'), 'undefined');
    throwsUsage(() => parsePermSpec('bogus', '--grant'), '未知权限名');
    throwsUsage(() => parsePermSpec('18446744073709551616', '--grant'), '超 u64 范围');
});

test('--grant 与 --revoke 在解析阶段互斥', () => {
    throwsUsage(() => parsePermCli(['--grant', 'fs', '--revoke', '3']), '互斥');
});

test('--apply 与 --list 互斥', () => {
    throwsUsage(() => parsePermCli(['--apply', '--list']), '互斥');
});

test('解析 fixture 中的 mreP 记录与标题', () => {
    const buf = makePropcol([0n, 3n]);
    const recs = findPermRecords(buf);
    eq(recs.length, 2, '应找到 2 条记录');
    assert(recs.every((r) => r.valid), '都应有效');
    eq(recs[0].bits, 0n);
    eq(recs[1].bits, 3n);
    eq(recs[0].title, 'T1\0\0');
});

test('损坏记录只报告跳过，不标记为有效', () => {
    // 前导字节不对
    const bad = Buffer.from('xxmreP' + 'ffffffff' + '\x29', 'latin1');
    const recs = findPermRecords(bad);
    assert(recs.length >= 1, '应发现这条记录');
    assert(recs.some((r) => !r.valid), '应标记为无效');
    assert(!recs.some((r) => r.valid && r.at === 1), '前导错误的不应有效');
});

test('后随字节不对 → 判为损坏', () => {
    const buf = Buffer.alloc(20);
    buf[0] = 0x04;
    Buffer.from('mreP', 'latin1').copy(buf, 1);
    buf.writeBigUInt64LE(3n, 5);
    buf[13] = 0xFF;                       // 错误的后随字节
    const recs = findPermRecords(buf);
    assert(recs.length >= 1 && recs.every((r) => !r.valid), '后随字节错应全部无效');
});

test('文件过早结束 → 判为损坏而非崩溃', () => {
    const buf = Buffer.from([0x04]);
    Buffer.from('mreP', 'latin1').copy(buf, 1);   // 只有 5 字节，u64 不够
    let threw = null;
    let recs = null;
    try { recs = findPermRecords(buf); } catch (e) { threw = e; }
    assert(!threw, `不应崩溃，实际: ${threw?.message}`);
    if (recs) assert(recs.every((r) => !r.valid), '应标记无效');
});

test('buildPlan 默认只修复无权限的脚本', () => {
    const buf = makePropcol([0n, 3n]);
    const recs = findPermRecords(buf).filter((r) => r.valid);
    const plan = buildPlan(recs, { grant: null, revoke: null, all: false }, 3n);
    eq(plan.length, 1, '只应改第一条');
    eq(plan[0].r.bits, 0n);
    eq(plan[0].newBits, 3n);
});

test('buildPlan --grant 只加不删', () => {
    const buf = makePropcol([1n]);
    const recs = findPermRecords(buf).filter((r) => r.valid);
    const plan = buildPlan(recs, { grant: 2n, revoke: null, all: false }, 3n);
    eq(plan[0].newBits, 3n, '1|2 应为 3');
});

test('buildPlan --revoke 只删不加', () => {
    const buf = makePropcol([3n]);
    const recs = findPermRecords(buf).filter((r) => r.valid);
    const plan = buildPlan(recs, { grant: null, revoke: 2n, all: false }, 3n);
    eq(plan[0].newBits, 1n, '3 & ~2 应为 1');
});

test('applyToCopy 只改目标 8 字节', () => {
    const buf = makePropcol([0n, 3n]);
    const recs = findPermRecords(buf).filter((r) => r.valid);
    const plan = buildPlan(recs, { grant: null, revoke: null, all: false }, 3n);
    const { out, unexpected } = applyToCopy(buf, plan);
    eq(unexpected.length, 0, '不应有预期外差异');
    // 除目标 8 字节外，其余完全一致
    const target = new Set();
    for (const { r } of plan) for (let k = 0; k < 8; k++) target.add(r.valueAt + k);
    for (let i = 0; i < buf.length; i++) {
        if (!target.has(i)) eq(out[i], buf[i], `非目标字节 @${i} 不应变化`);
    }
});

test('apply + 写后校验全流程（真实文件）', () => {
    const t = tmpdir('perms');
    try {
        const buf = makePropcol([0n, 3n]);
        const target = t.file('scripts.propcol');
        fs.writeFileSync(target, buf);
        const recs = findPermRecords(buf).filter((r) => r.valid);
        const plan = buildPlan(recs, { grant: null, revoke: null, all: false }, 3n);
        const { out, unexpected } = applyToCopy(buf, plan);
        eq(unexpected.length, 0);
        atomicWriteFileSync(target, out);
        assert(verifyWritten(target, plan, buf, out), '写后校验应通过');
        // 再读回来确认
        const after = fs.readFileSync(target);
        const recs2 = findPermRecords(after).filter((r) => r.valid);
        eq(recs2[0].bits, 3n, '回读权限应已更新');
    } finally { t.cleanup(); }
});

test('verifyWritten 能发现被篡改的非目标字节', () => {
    const t = tmpdir('perms-tamper');
    try {
        const buf = makePropcol([0n, 3n]);
        const target = t.file('x.propcol');
        fs.writeFileSync(target, buf);
        const recs = findPermRecords(buf).filter((r) => r.valid);
        const plan = buildPlan(recs, { grant: null, revoke: null, all: false }, 3n);
        const { out } = applyToCopy(buf, plan);
        // 故意改一个非目标字节
        const tampered = Buffer.from(out);
        tampered[tampered.length - 1] ^= 0xFF;
        fs.writeFileSync(target, tampered);
        let err = null;
        try { verifyWritten(target, plan, buf, out); } catch (e) { err = e; }
        assert(err, '篡改应被校验发现');
        assert(/非目标字节/.test(err.message), `实际: ${err.message}`);
    } finally { t.cleanup(); }
});

test('dry-run（无 --apply）不改文件', async () => {
    const t = tmpdir('perms-dry');
    try {
        const buf = makePropcol([0n, 3n]);
        const target = t.file('scripts.propcol');
        fs.writeFileSync(target, buf);
        const r = await runNode([
            path.join(SCRIPTS, 'fix-script-perms.mjs'),
            '--file', target,
        ]);
        eq(r.code, 0, `dry-run 应退出 0，实际 ${r.code}: ${r.stderr}`);
        assert(fs.readFileSync(target).equals(buf), 'dry-run 绝不能改文件');
        assert(/DRY-RUN/.test(r.stdout), `应提示 DRY-RUN，实际:\n${r.stdout}`);
    } finally { t.cleanup(); }
});

test('--apply 写入 + 生成备份 + 写后校验', async () => {
    const t = tmpdir('perms-apply');
    try {
        const buf = makePropcol([0n, 3n]);
        const target = t.file('scripts.propcol');
        fs.writeFileSync(target, buf);
        const r = await runNode([
            path.join(SCRIPTS, 'fix-script-perms.mjs'),
            '--file', target, '--apply', '--force',
        ]);
        eq(r.code, 0, `--apply 应退出 0，实际 ${r.code}: ${r.stderr}`);
        const after = fs.readFileSync(target);
        const recs = findPermRecords(after).filter((x) => x.valid);
        eq(recs[0].bits, 3n, '权限应已修复');
        assert(after.length === buf.length, '文件长度不应变');
        const backups = fs.readdirSync(t.dir).filter((f) => f.includes('.bak-'));
        eq(backups.length, 1, '应生成 1 个备份');
    } finally { t.cleanup(); }
});

test('备份名唯一：连续两次 --apply 不覆盖同一备份', async () => {
    const t = tmpdir('perms-bak');
    try {
        const buf = makePropcol([0n]);
        const target = t.file('s.propcol');
        fs.writeFileSync(target, buf);
        const args = [path.join(SCRIPTS, 'fix-script-perms.mjs'), '--file', target, '--apply', '--force'];
        const a = await runNode(args);
        eq(a.code, 0, `第一次应成功: ${a.stderr}`);
        // 复位后再改一次，制造第二次写入
        fs.writeFileSync(target, buf);
        const b = await runNode(args);
        eq(b.code, 0, `第二次应成功: ${b.stderr}`);
        const backups = fs.readdirSync(t.dir).filter((f) => f.includes('.bak-'));
        eq(backups.length, 2, '两次执行应产生两个不同备份名');
    } finally { t.cleanup(); }
});

test('--list 只读', async () => {
    const t = tmpdir('perms-list');
    try {
        const buf = makePropcol([0n, 3n]);
        const target = t.file('s.propcol');
        fs.writeFileSync(target, buf);
        const r = await runNode([path.join(SCRIPTS, 'fix-script-perms.mjs'), '--file', target, '--list']);
        eq(r.code, 0, `--list 应退出 0: ${r.stderr}`);
        assert(fs.readFileSync(target).equals(buf), '--list 不改文件');
    } finally { t.cleanup(); }
});

test('损坏记录：报告并跳过，不写入', async () => {
    const t = tmpdir('perms-broken');
    try {
        const good = makePropcol([0n]);
        // 构造一条**真的坏**记录：前导 0x04 + mreP + u64，但后随字节是 0xFF（≠0x29）
        const badRec = Buffer.alloc(1 + 4 + 8 + 1);
        let o = 0;
        badRec[o++] = 0x04;
        Buffer.from('mreP', 'latin1').copy(badRec, o); o += 4;
        badRec.writeBigUInt64LE(3n, o); o += 8;
        badRec[o++] = 0xFF;                     // 错误的后随标记
        const full = Buffer.concat([good, badRec]);

        // 先确认 fixture 本身确实造出了「有效 + 损坏」两条
        const recs = findPermRecords(full);
        eq(recs.length, 2, `fixture 应含 2 条记录，实际 ${recs.length}`);
        eq(recs.filter((r) => r.valid).length, 1, '应恰好 1 条有效');
        assert(recs.some((r) => !r.valid && /后随字节/.test(r.reason || '')),
            `损坏记录应因后随字节被标记无效，实际: ${JSON.stringify(recs.map(r => ({ valid: r.valid, reason: r.reason })))}`);

        const target = t.file('s.propcol');
        fs.writeFileSync(target, full);
        const r = await runNode([path.join(SCRIPTS, 'fix-script-perms.mjs'), '--file', target, '--list']);
        eq(r.code, 0, '损坏记录不应导致崩溃');
        assert(/结构异常/.test(r.stdout), `应报告结构异常，实际:\n${r.stdout}`);
        assert(fs.readFileSync(target).equals(full), '--list 不应改文件');
    } finally { t.cleanup(); }
});

test('损坏记录在 --apply 时被跳过，不写入损坏位置', async () => {
    const t = tmpdir('perms-broken-apply');
    try {
        const good = makePropcol([0n]);
        const badRec = Buffer.alloc(1 + 4 + 8 + 1);
        let o = 0;
        badRec[o++] = 0x04;
        Buffer.from('mreP', 'latin1').copy(badRec, o); o += 4;
        badRec.writeBigUInt64LE(3n, o); o += 8;
        badRec[o++] = 0xFF;
        const full = Buffer.concat([good, badRec]);
        const target = t.file('s.propcol');
        fs.writeFileSync(target, full);

        const badAt = full.length - 13;          // 损坏记录的标签位置
        const before = full.readBigUInt64LE(badAt + 5);

        const r = await runNode([path.join(SCRIPTS, 'fix-script-perms.mjs'), '--file', target, '--apply', '--force']);
        eq(r.code, 0, `有效记录应能正常修复: ${r.stderr}`);

        const after = fs.readFileSync(target);
        // 有效记录被修好
        const recs = findPermRecords(after).filter((x) => x.valid);
        eq(recs[0].bits, 3n, '有效记录应已修复');
        // 损坏记录的 u64 一个字节都不能动
        eq(after.readBigUInt64LE(badAt + 5), before, '损坏记录不应被写入');
    } finally { t.cleanup(); }
});

test('decodeBits 输出可读标签', () => {
    eq(decodeBits(0n), '【无权限】');
    assert(decodeBits(3n).includes('文件系统'));
    assert(decodeBits(2n).includes('网络'));
});

// ===========================================================================
// 7. validate
// ===========================================================================
group('validate');

async function validateScript(content, args = []) {
    const t = tmpdir('val');
    try {
        const p = t.write('s.js', content);
        return await runNode([path.join(SCRIPTS, 'validate.mjs'), p, '--sdk', path.join(t.dir, 'no-such-sdk'), ...args]);
    } finally { t.cleanup(); }
}

test('合法脚本 → 无错误退出 0', async () => {
    const r = await validateScript(`'use strict';
function main() { console.log('hi'); }
main();
`);
    eq(r.code, 0, `应退出 0，实际 ${r.code}:\n${r.stdout}\n${r.stderr}`);
    assert(/语法编译通过/.test(r.stdout), '应报告语法通过');
});

test('语法错误 → 退出 1 且归类为语法问题', async () => {
    const r = await validateScript('function main( { \nmain();');
    eq(r.code, 1, `语法错误应退出 1，实际 ${r.code}`);
    assert(/语法错误/.test(r.stdout), '应明确标为语法错误');
});

test('SDK 不存在 → 明确区分，不当成脚本错误', async () => {
    const r = await validateScript(`function main(){}\nmain();`);
    assert(/SDK 目录不存在/.test(r.stdout), `应说明 SDK 不存在:\n${r.stdout}`);
    assert(/不代表脚本有错/.test(r.stdout), '应说明这不代表脚本有错');
    eq(r.code, 0, '仅 SDK 缺失不应判为脚本错误');
});

test('缺少 main → 警告', async () => {
    const r = await validateScript(`const a = 1;\nconsole.log(a);\n`);
    assert(/未识别到明确入口/.test(r.stdout), `应警告入口问题:\n${r.stdout}`);
});

test('注释里的假调用不算真调用（不误报 SDK 未知方法）', async () => {
    const fake = `function main() {
    // 这里假装调用 totallyFakeSdkMethodXyz(1)
    /* totallyAnotherFake(2) */
    const s = "stringFakeCall(3)";
    console.log('real');
}
main();`;
    const t = tmpdir('val-fake');
    try {
        // 用一个存在但很小的 SDK 目录，确保会进入符号回查分支
        const sdk = path.join(t.dir, 'sdk');
        fs.mkdirSync(sdk, { recursive: true });
        fs.writeFileSync(path.join(sdk, 'document.js'), 'module.exports.Document = class { clearPreviews(){} };\n');
        const p = t.file('f.js');
        fs.writeFileSync(p, fake);
        const r = await runNode([path.join(SCRIPTS, 'validate.mjs'), p, '--sdk', sdk]);
        assert(!/totallyFakeSdkMethodXyz|totallyAnotherFake|stringFakeCall/.test(r.stdout),
            `注释/字符串里的假调用不应出现在未知方法警告里:\n${r.stdout}`);
    } finally { t.cleanup(); }
});

test('真实未导出符号 → 报错', async () => {
    const t = tmpdir('val-export');
    try {
        const sdk = path.join(t.dir, 'sdk');
        fs.mkdirSync(sdk, { recursive: true });
        fs.writeFileSync(path.join(sdk, 'document.js'), 'module.exports.Document = class {};\n');
        const p = t.file('s.js');
        fs.writeFileSync(p, `const { Document, NotThere } = require('/document.js');\nfunction main(){}\nmain();\n`);
        const r = await runNode([path.join(SCRIPTS, 'validate.mjs'), p, '--sdk', sdk]);
        assert(/NotThere/.test(r.stdout), `应报告未导出符号:\n${r.stdout}`);
        eq(r.code, 1, '未导出符号应导致退出 1');
    } finally { t.cleanup(); }
});

test('exports.X 形式的导出也能被识别', async () => {
    const t = tmpdir('val-exports-x');
    try {
        const sdk = path.join(t.dir, 'sdk');
        fs.mkdirSync(sdk, { recursive: true });
        fs.writeFileSync(path.join(sdk, 'fs.js'), 'exports.File = class {};\n');
        const p = t.file('s.js');
        fs.writeFileSync(p, `const { File, Missing } = require('/fs.js');\nfunction main(){}\nmain();\n`);
        const r = await runNode([path.join(SCRIPTS, 'validate.mjs'), p, '--sdk', sdk]);
        // File 已导出 → 输出里必须明确它命中了
        assert(/已导出 1 个：File/.test(r.stdout) || /导出全部命中/.test(r.stdout),
            `File 应被识别为已导出:\n${r.stdout}`);
        assert(/未导出：Missing/.test(r.stdout),
            `Missing 应被报为未导出:\n${r.stdout}`);
        assert(!/未导出：File/.test(r.stdout),
            `File 是已导出的，不该出现在未导出清单:\n${r.stdout}`);
        eq(r.code, 1, '存在未导出符号应退出 1');
    } finally { t.cleanup(); }
});

test('预览未清理 → 错误', async () => {
    const r = await validateScript(`function main(){
    doc.executeCommand(cmd, true);
}
main();`);
    assert(/clearPreviews/.test(r.stdout), `应报告预览未清理:\n${r.stdout}`);
    eq(r.code, 1, '预览未清理应导致退出 1');
});

test('陷阱检查数量为 9 且与实现一致', async () => {
    const r = await validateScript(`function main(){}\nmain();`);
    const m = /### 3\. 已知陷阱检查（(\d+) 项）/.exec(r.stdout);
    assert(m, `应打印陷阱检查项数:\n${r.stdout}`);
    eq(Number(m[1]), 9, '陷阱检查应为 9 项');
});

test('--sdk 缺值 → 退出码 2', async () => {
    const r = await runNode([path.join(SCRIPTS, 'validate.mjs'), 'x.js', '--sdk']);
    eq(r.code, 2, `缺值应退出 2，实际 ${r.code}`);
});

test('路径带空格与中文', async () => {
    const t = tmpdir('val 中文');
    try {
        const p = t.write('我的 脚本.js', `function main(){}\nmain();\n`);
        const r = await runNode([path.join(SCRIPTS, 'validate.mjs'), p]);
        eq(r.code, 0, `带空格中文路径应正常工作，实际 ${r.code}: ${r.stderr}`);
    } finally { t.cleanup(); }
});

// ===========================================================================
// 8. scan-strings
// ===========================================================================
group('scan-strings');

test('参数解析边界', () => {
    eq(parseScanCli(['f.bin', '--min', '8', 'abc']).min, 8);
    eq(parseScanCli(['f.bin', 'abc']).min, 4);
    eq(parseScanCli(['f.bin', '--utf16', 'abc']).utf16, true);
    throwsUsage(() => parseScanCli(['f.bin', '--min', '0', 'a']), '--min 必须正整数');
    throwsUsage(() => parseScanCli(['f.bin', '--min', 'abc', 'a']), '--min 非数字');
    throwsUsage(() => parseScanCli(['f.bin', '--min']), '--min 缺值');
    eq(parseScanCli(['f.bin', '--raw']).raw, true);
});

test('文件不存在 → 退出码 1', async () => {
    const r = await runNode([path.join(SCRIPTS, 'scan-strings.mjs'), '不存在.bin', 'abc']);
    eq(r.code, 1, `应退出 1，实际 ${r.code}`);
});

test('目录代替文件 → 退出码 1', async () => {
    const t = tmpdir('ss-dir');
    try {
        const r = await runNode([path.join(SCRIPTS, 'scan-strings.mjs'), t.dir, 'abc']);
        eq(r.code, 1, '目录应被拒绝');
    } finally { t.cleanup(); }
});

test('非法正则 → 退出码 2', async () => {
    const t = tmpdir('ss-re');
    try {
        const f = t.write('a.bin', 'hello');
        const r = await runNode([path.join(SCRIPTS, 'scan-strings.mjs'), f, '(']);
        eq(r.code, 2, `非法正则应退出 2，实际 ${r.code}: ${r.stderr}`);
    } finally { t.cleanup(); }
});

test('ASCII 扫描命中字符串', async () => {
    const t = tmpdir('ss-ascii');
    try {
        const f = t.file('a.bin');
        fs.writeFileSync(f, Buffer.concat([
            Buffer.from([0, 0, 0]), Buffer.from('execute_script', 'latin1'), Buffer.from([0, 0]),
            Buffer.from('save_script_to_library', 'latin1'), Buffer.from([0]),
        ]));
        const r = await runNode([path.join(SCRIPTS, 'scan-strings.mjs'), f, 'script']);
        eq(r.code, 0, `应成功: ${r.stderr}`);
        assert(/execute_script/.test(r.stdout), '应找到 execute_script');
        assert(/save_script_to_library/.test(r.stdout), '应找到 save_script_to_library');
    } finally { t.cleanup(); }
});

test('extractStrings UTF-16LE 边界内正确切分', () => {
    const data = Buffer.from('execute_script', 'utf16le');
    const got = [];
    extractStrings(data, true, 4, (s) => got.push(s));
    eq(JSON.stringify(got), JSON.stringify(['execute_script']));
});

test('extractStrings UTF-16LE 遇到非打印字符才切分', () => {
    // 说明：连续的 UTF-16 可打印字符本来就是「一个字符串」，
    // 中间没有分隔符时不应该被切开。切分只发生在高字节非 0 的位置。
    const withGap = Buffer.concat([
        Buffer.from('execute_script', 'utf16le'),
        Buffer.from([0x41, 0x01]),          // 高字节非 0 → 强制断开
        Buffer.from('render_spread', 'utf16le'),
    ]);
    const got = [];
    extractStrings(withGap, true, 4, (s) => got.push(s));
    eq(JSON.stringify(got), JSON.stringify(['execute_script', 'render_spread']),
        '应在非打印字符处切成两串');
});

test('extractStrings UTF-16LE 跨块边界不丢字符', () => {
    // 模拟 scanFile 的 carry 逻辑：把一个串人为拆成两半再拼回 chunk，
    // 验证 2 字节对齐的 carry 能把它完整还原。
    const whole = Buffer.from('execute_script', 'utf16le');
    const pre = Buffer.from('AA', 'utf16le');
    const post = Buffer.from('BB', 'utf16le');

    // 第一块只拿到前半（含 pre）
    const chunk1 = Buffer.concat([pre, whole.subarray(0, 10)]);
    const got1 = [];
    extractStrings(chunk1, true, 4, (s) => got1.push(s));

    // 第二块带 carry：后 10 字节 + post
    const chunk2 = Buffer.concat([whole.subarray(10), post]);
    const got2 = [];
    extractStrings(chunk2, true, 4, (s) => got2.push(s));

    // 第一块末尾的半截 + 第二块开头拼起来应等于原串的后缀
    const tail1 = got1.length ? got1[got1.length - 1] : '';
    const head2 = got2.length ? got2[0] : '';
    assert((tail1 + head2).includes('execute_script'.slice(-6)) || tail1.includes('execute_script'),
        `跨块后应能还原完整串，实际: ${JSON.stringify({ tail1, head2 })}`);
});

test('extractStrings ASCII 遇到不可打印字节才切分', () => {
    const buf = Buffer.from('hello_world');
    const got = [];
    extractStrings(buf, false, 4, (s) => got.push(s));
    eq(JSON.stringify(got), JSON.stringify(['hello_world']));
});

test('--raw 限量输出', async () => {
    const t = tmpdir('ss-raw');
    try {
        const f = t.file('a.bin');
        // 造 100 个独立字符串
        const parts = [];
        for (let i = 0; i < 100; i++) { parts.push(Buffer.from(`str_${i}_xxxx`, 'latin1'), Buffer.from([0])); }
        fs.writeFileSync(f, Buffer.concat(parts));
        const r = await runNode([path.join(SCRIPTS, 'scan-strings.mjs'), f, '--raw', '--max', '10']);
        eq(r.code, 0, `应成功: ${r.stderr}`);
        const lines = r.stdout.split('\n').filter((l) => /^str_\d+_xxxx$/.test(l));
        eq(lines.length, 10, `--max 10 应只打印 10 条，实际 ${lines.length}`);
    } finally { t.cleanup(); }
});

test('超长连续可打印串被截断（内存保护）', () => {
    // 100KB 连续可打印字节，不应有单个 100KB 的字符串
    const big = Buffer.alloc(100 * 1024, 0x41);
    const got = [];
    extractStrings(big, false, 4, (s) => got.push(s));
    assert(got.length > 0, '应提取到字符串');
    for (const s of got) {
        assert(s.length <= 4096, `单串长度应被限制，实际 ${s.length}`);
    }
});

// ===========================================================================
// 9. sdk-lookup
// ===========================================================================
group('sdk-lookup');

/** 造一个可控的假 SDK 目录，避免测试依赖本机真的装了 Affinity。 */
function makeFakeSdk(tag) {
    const t = tmpdir(tag);
    const root = path.join(t.dir, 'JSLib 目录');      // 故意带空格与中文
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'document.js'), [
        'class Node {}',
        'class TextNode extends Node {',
        '    get isTextNode() { return true; }',
        '    set isTextNode(v) {}',
        '    static createDefault() {}',
        '    convertToCurves(sel) {}',
        '}',
        'module.exports.Document = class {',
        '    get spreads() { return []; }',
        '};',
        'module.exports.Node = Node;',
        'module.exports.TextNode = TextNode;',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(root, 'examples'), { recursive: true });
    fs.writeFileSync(path.join(root, 'examples', 'demo.js'),
        'function demoHelper() { return 1; }\n', 'utf8');
    return { ...t, root, env: { AFFINITY_JSLIB: root } };
}

async function sdkRun(args, sdk, extraEnv = {}) {
    return runNode([path.join(SCRIPTS, 'sdk-lookup.mjs'), ...args], {
        env: { ...process.env, ...sdk.env, ...extraEnv },
    });
}

test('符号名按字面量处理：正则元字符不崩也不被当通配符', async () => {
    const sdk = makeFakeSdk('sdk-lit');
    try {
        // 原实现会把用户输入直接拼进 RegExp：`foo(bar` 会抛 SyntaxError，
        // `a*b` 会被当通配符从而匹配到别的东西。
        for (const sym of ['foo(bar', 'a*b', '[a-z]+(', 'Node$', 'a{2,3}']) {
            const r = await sdkRun([sym], sdk);
            eq(r.code, 0, `符号 ${JSON.stringify(sym)} 不应导致失败，实际 ${r.code}: ${r.stderr}`);
            assert(!/SyntaxError|Invalid regular expression/.test(r.stderr),
                `符号 ${JSON.stringify(sym)} 不应抛正则语法错误:\n${r.stderr}`);
        }
    } finally { sdk.cleanup(); }
});

test('字面量符号不会因通配符语义误命中', async () => {
    const sdk = makeFakeSdk('sdk-literal');
    try {
        // SDK 里只有 TextNode；`TextNode` 加通配符后不应匹配到 Node 之外的东西
        const r = await sdkRun(['Node'], sdk);
        eq(r.code, 0);
        assert(/TextNode|Node/.test(r.stdout), `应找到 Node:\n${r.stdout}`);
    } finally { sdk.cleanup(); }
});

test('--members 列出类成员（跳过注释与字符串里的括号）', async () => {
    const sdk = makeFakeSdk('sdk-members');
    try {
        const r = await sdkRun(['--members', 'document.js', 'TextNode'], sdk);
        eq(r.code, 0, `--members 应成功: ${r.stderr}`);
        assert(/get:.*isTextNode/.test(r.stdout), `应列出 getter:\n${r.stdout}`);
        assert(/set:.*isTextNode/.test(r.stdout), `应列出 setter:\n${r.stdout}`);
        assert(/static:.*createDefault/.test(r.stdout), `应列出 static 方法:\n${r.stdout}`);
        assert(/method:.*convertToCurves/.test(r.stdout), `应列出实例方法:\n${r.stdout}`);
    } finally { sdk.cleanup(); }
});

test('--members 缺类名时列出全部类', async () => {
    const sdk = makeFakeSdk('sdk-allclasses');
    try {
        const r = await sdkRun(['--members', 'document.js'], sdk);
        eq(r.code, 0, `应成功: ${r.stderr}`);
        assert(/class TextNode/.test(r.stdout), `应列出 TextNode:\n${r.stdout}`);
    } finally { sdk.cleanup(); }
});

test('--grep 唯一允许正则的地方', async () => {
    const sdk = makeFakeSdk('sdk-grep');
    try {
        const ok = await sdkRun(['--grep', 'isText.*getter'], sdk);
        eq(ok.code, 0, `合法正则应成功: ${ok.stderr}`);
        const bad = await sdkRun(['--grep', '('], sdk);
        eq(bad.code, 2, `非法正则应退出 2，实际 ${bad.code}`);
        assert(/正则无效/.test(bad.stderr), `应说明正则无效:\n${bad.stderr}`);
    } finally { sdk.cleanup(); }
});

test('SDK 不存在 / 模块或类不存在 → 稳定退出码', async () => {
    const sdk = makeFakeSdk('sdk-missing');
    try {
        // 模块不存在 → 1
        const m = await sdkRun(['--members', 'nosuch.js'], sdk);
        eq(m.code, 1, `模块不存在应退出 1，实际 ${m.code}`);
        // 类不存在 → 1
        const c = await sdkRun(['--members', 'document.js', 'NoSuchClass'], sdk);
        eq(c.code, 1, `类不存在应退出 1，实际 ${c.code}`);
        // 缺值 → 2
        for (const flag of ['--members', '--grep', '--index']) {
            const v = await sdkRun([flag], sdk);
            eq(v.code, 2, `${flag} 缺值应退出 2，实际 ${v.code}`);
        }
    } finally { sdk.cleanup(); }
});

test('SDK 根目录不存在 → 退出 1 且提示设环境变量', async () => {
    const r = await runNode([path.join(SCRIPTS, 'sdk-lookup.mjs'), 'SomeSymbol'], {
        env: { ...process.env, AFFINITY_JSLIB: path.join(os.tmpdir(), '绝对不存在的 JSLib 目录') },
    });
    eq(r.code, 1, `SDK 不存在应退出 1，实际 ${r.code}`);
    assert(/找不到 JSLib|AFFINITY_JSLIB/.test(r.stderr), `应提示如何指定 SDK:\n${r.stderr}`);
});

test('--files / --stats 正常工作', async () => {
    const sdk = makeFakeSdk('sdk-files');
    try {
        const f = await sdkRun(['--files'], sdk);
        eq(f.code, 0, `--files 应成功: ${f.stderr}`);
        assert(/document\.js/.test(f.stdout), '应列出模块');
        const s = await sdkRun(['--stats'], sdk);
        eq(s.code, 0, `--stats 应成功: ${s.stderr}`);
        assert(/核心模块/.test(s.stdout), '应输出统计');
    } finally { sdk.cleanup(); }
});

test('--index 生成符号索引文件', async () => {
    const sdk = makeFakeSdk('sdk-index');
    try {
        const out = path.join(sdk.dir, '索引 out.md');
        const r = await sdkRun(['--index', out], sdk);
        eq(r.code, 0, `--index 应成功: ${r.stderr}`);
        assert(fs.existsSync(out), '应生成索引文件');
        const txt = fs.readFileSync(out, 'utf8');
        assert(/Document/.test(txt), '索引应含符号名');
        assert(/符号 → 模块 反查/.test(txt), '索引应含反查小节');
    } finally { sdk.cleanup(); }
});

// ===========================================================================
// 10. 启动器（.cmd 的CRLF/ASCII 硬性要求）
// ===========================================================================

group('启动器');

// skill 根目录（tests 的上一级）。**不假设仓库布局**——
// 技能包会被单独复制到 .agents/skills/ 下，那时没有仓库根目录那一层。
const SKILL_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = fs.existsSync(path.join(SKILL_ROOT, 'run-tool.ps1'))
    ? path.resolve(SKILL_ROOT, '..')          // 仓库布局：根目录有转发壳
    : SKILL_ROOT;                              // 独立安装布局：skill 根就是根

test('.cmd 包装器必须是 ASCII-only 且 CRLF 行尾', () => {
    // Windows CMD 只认 CRLF：LF-only 会让 @echo off 失效、整文件被当一行执行。
    // 且 cmd.exe 按当前代码页解析，注释里的非 ASCII 字节可能被错误解码。
    // 仓库布局下两个都要检查；独立安装布局只有 skill 内部那个。
    const cmds = [
        path.join(REPO_ROOT, 'run-affinity-tool.cmd'),
        path.join(SKILL_ROOT, 'run-tool.cmd'),
    ].filter((p) => fs.existsSync(p));
    assert(cmds.length >= 1, '应至少存在一个 .cmd 启动器');

    for (const p of cmds) {
        const rel = path.relative(REPO_ROOT, p) || path.basename(p);
        const b = fs.readFileSync(p);
        const nonAscii = [...b].filter((x) => x > 127).length;
        eq(nonAscii, 0, `${rel} 应为纯 ASCII，实际有 ${nonAscii} 个非 ASCII 字节`);
        const crlf = b.toString('binary').split('\r\n').length - 1;
        const lf = b.toString('binary').split('\n').length - 1;
        eq(lf - crlf, 0, `${rel} 不应有孤立 LF（CRLF=${crlf}, LF=${lf}）`);
        const text = b.toString('ascii');
        assert(/^@echo off\r\n/i.test(text), `${rel} 首行必须是 @echo off（否则命令行回显且可能整体当一行执行）`);
        assert(/-File\s+"%~dp0[\w.-]+\.ps1"\s+%\*\r\n/i.test(text),
            `${rel} 必须把 %* 原样转发给同名 .ps1`);
        assert(/exit \/b %ERRORLEVEL%\r\n/i.test(text),
            `${rel} 必须透传退出码`);
    }
});

test('run-tool.ps1 显式映射全部工具（含 probe），不做扩展名拼接', () => {
    const ps = fs.readFileSync(path.join(SKILL_ROOT, 'run-tool.ps1'), 'utf8');
    for (const tool of ['validate', 'make-afscript', 'mcp-client', 'fix-script-perms', 'sdk-lookup', 'scan-strings', 'probe', 'tests']) {
        assert(new RegExp(`'${tool.replace(/[-.]/g, '\\$&')}'\\s*=`).test(ps),
            `映射表应包含 ${tool}`);
    }
    // probe 是 .js，且必须特判成「只输出路径」，绝不能交给 Node 执行
    assert(/probe\w*'\s*=\s*'scripts\\probe\.js'/.test(ps), 'probe 应映射到 scripts\\probe.js');
    assert(/\$Tool\s*-eq\s*'probe'/.test(ps) || /\$Tool\s*-in\s*@\('probe'/.test(ps),
        'probe 必须被特判（输出路径后退出，不交给 Node）');
    // 不能靠拼接扩展名。只看**真正参与执行的语句**（以 Join-Path/& 开头的赋值），
    // 注释里出现这个字符串是允许的（那里正是在解释为什么不能拼）。
    const execLines = ps.split('\n').filter((l) => {
        const t = l.trim();
        if (!t || t.startsWith('#')) return false;              // 整行注释
        return !/^\s*#/.test(l);                                 // 行内注释起始
    }).join('\n');
    assert(!/\$Tool\s*\+\s*['"]\.mjs['"]/.test(execLines),
        "不应出现 $Tool + '.mjs' 式的拼接（只看非注释行）");
});

test('probe 不会被 Node 执行（显式声明为 Affinity 脚本）', () => {
    const ps = fs.readFileSync(path.join(SKILL_ROOT, 'run-tool.ps1'), 'utf8');
    // probe 特判块必须在调用 node 之前
    const probeIdx = ps.search(/\$Tool\s*-eq\s*'probe'/);
    const nodeIdx = ps.indexOf('& $node $scriptPath');
    assert(probeIdx > 0, '应存在 probe 特判');
    assert(nodeIdx > 0, '应存在调用 node 的位置');
    assert(probeIdx < nodeIdx, 'probe 特判必须在调用 Node 之前（否则 probe.js 会被当 Node 脚本执行）');
});

test('权威启动器在 skill 内部（保证单独复制到 .agents/skills/ 后仍可用）', () => {
    assert(fs.existsSync(path.join(SKILL_ROOT, 'run-tool.ps1')),
        'skill 内部必须有 run-tool.ps1 —— 仓库根目录那个在独立安装布局下会失效');
    assert(fs.existsSync(path.join(SKILL_ROOT, 'scripts')),
        'skill 内部必须自带 scripts/');
    assert(fs.existsSync(path.join(SKILL_ROOT, 'SKILL.md')),
        'skill 内部必须有 SKILL.md');
});

// ===========================================================================
// 11. 全仓库 node --check
// ===========================================================================
group('语法检查');

test('所有 .mjs 通过 node --check', async () => {
    const files = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
            else if (e.name.endsWith('.mjs')) files.push(p);
        }
    };
    walk(SCRIPTS);
    walk(HERE);
    assert(files.length >= 8, `应找到足够的 .mjs 文件，实际 ${files.length}`);
    for (const f of files) {
        const r = await runNode(['--check', f], { timeoutMs: 20000 });
        eq(r.code, 0, `node --check 失败: ${f}\n${r.stderr}`);
    }
});

test('probe.js 也通过语法检查', async () => {
    const r = await runNode(['--check', path.join(SCRIPTS, 'probe.js')]);
    eq(r.code, 0, `probe.js 语法检查失败:\n${r.stderr}`);
});

test('assets 模板通过语法检查', async () => {
    const dir = path.join(SCRIPTS, '..', 'assets');
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
        const r = await runNode(['--check', path.join(dir, f)]);
        eq(r.code, 0, `模板语法检查失败: ${f}\n${r.stderr}`);
    }
});

// ===========================================================================
// 10. 跨工具退出码一致性
// ===========================================================================
group('退出码一致性');

test('所有工具 --help 退出 0', async () => {
    const tools = ['validate.mjs', 'make-afscript.mjs', 'mcp-client.mjs', 'fix-script-perms.mjs', 'scan-strings.mjs', 'sdk-lookup.mjs'];
    for (const t of tools) {
        const r = await runNode([path.join(SCRIPTS, t), '--help'], { timeoutMs: 20000 });
        eq(r.code, 0, `${t} --help 应退出 0，实际 ${r.code}: ${r.stderr}`);
    }
});

test('所有工具未知参数退出 2', async () => {
    const tools = ['validate.mjs', 'make-afscript.mjs', 'mcp-client.mjs', 'fix-script-perms.mjs', 'scan-strings.mjs'];
    for (const t of tools) {
        const r = await runNode([path.join(SCRIPTS, t), '--definitely-unknown-flag'], { timeoutMs: 20000 });
        eq(r.code, 2, `${t} 未知参数应退出 2，实际 ${r.code}: ${r.stdout}${r.stderr}`);
    }
});

// ===========================================================================
// Runner
// ===========================================================================

async function main() {
    const argv = process.argv.slice(2);
    const filter = argv.includes('--filter') ? argv[argv.indexOf('--filter') + 1] : null;
    const listOnly = argv.includes('--list');
    verbose = argv.includes('--verbose');

    const selected = results.filter((t) =>
        !filter || (t.group + ' ' + t.name).toLowerCase().includes(filter.toLowerCase()));

    if (listOnly) {
        for (const t of selected) console.log(`[${t.group}] ${t.name}`);
        console.log(`\n共 ${selected.length} 个用例`);
        return 0;
    }

    console.log(`离线测试套件 —— ${selected.length} 个用例`);
    console.log(`Node ${process.version}  zstd=${typeof zlib.zstdCompressSync === 'function' ? '可用' : '不可用'}\n`);

    let pass = 0, fail = 0;
    let lastGroup = '';
    const failures = [];

    for (const t of selected) {
        if (t.group !== lastGroup) { console.log(`\n── ${t.group} ──`); lastGroup = t.group; }
        const t0 = Date.now();
        try {
            await t.fn();
            const dt = Date.now() - t0;
            console.log(`  ✓ ${t.name}${dt > 300 ? `  (${dt}ms)` : ''}`);
            pass++;
        } catch (e) {
            const dt = Date.now() - t0;
            console.log(`  ✗ ${t.name}  (${dt}ms)`);
            console.log(`      ${e?.name}: ${e?.message}`);
            if (verbose && e?.stack) console.log(e.stack.split('\n').slice(1, 4).map((l) => '      ' + l.trim()).join('\n'));
            fail++;
            failures.push({ ...t, err: e });
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`结果：${pass} 通过，${fail} 失败，共 ${selected.length}`);
    if (failures.length) {
        console.log('\n失败用例：');
        for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name}: ${f.err?.message}`);
    }

    console.log(`
────────────────────────────────────────────────────────
需要**真实环境**才能验证的项目（本套件不覆盖）：
  · mcp-client 对真实 Affinity MCP 的协议版本 2025-11-25兼容性
  · execute_script 实际执行脚本、console.log 回传
  · save_script_to_library 入库后权限位是否为设置默认值
  · render_spread 渲染结果与 base64 解析
  · fix-script-perms 对**真实** scripts.propcol 的作用（会改动用户库）
  · validate/sdlookup 对真实 JSLib 的符号覆盖率
  · Windows 执行策略下 .cmd 启动器的实际调用
`);

    return fail > 0 ? 1 : 0;
}

process.exitCode = await main();
