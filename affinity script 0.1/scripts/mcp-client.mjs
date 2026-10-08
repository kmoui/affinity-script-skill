#!/usr/bin/env node
// ============================================================================
// mcp-client.mjs —— Affinity 内置 MCP 客户端（v0.4 重写）
//
// 用途：让 Agent 直接操作 Affinity —— 执行脚本、读回 console 输出、把脚本入库。
//
// ── 已验证的协议事实（2026-10-07/08 在 Affinity 3.3.0.4850 Win32 实测）────────
//   ① 端口**动态**，每次重启都可能变（实测见过 6767 / 41596 / 39840）→ 用 --discover
//   ② 传输是 SSE：GET /sse 拿 endpoint，再向该路径 POST JSON-RPC
//   ③ 协议版本**必须** 2025-11-25（传 2024-11-05 会 Unsupported protocol version）
//   ④ SSE 行尾是 \r\n，事件块必须按 /\r?\n\r?\n/ 切分
//   ⑤ **必须先读 preamble**，否则 execute_script 一律拒绝
//   ⑥ execute_script 只有 script 一个参数；输出靠脚本里的 console.log()
//   ⑦ save_script_to_library 入库的脚本权限位=设置默认值（通常 3），无需修权限
//   —— 以上为**实测**；协议版本号属实现细节，Affinity 升级后需用 --discover 复验。
//
// ── v0.4 修复清单（安全/正确性）─────────────────────────────────────────────
//   F1  参数解析重写：缺值/非法值/重复使用一律退出码 2（原来 --port 无值会变 NaN）
//   F2  所有 fetch 加**真正可取消**的 AbortController 超时
//       （原来只给 pending Promise 设超时，底层 fetch 可永久挂起）
//   F3  区分 HTTP 状态码错误 / RPC error / RPC 超时 / 空响应，不再伪装成「空工具列表」
//   F4  正确处理相对 endpoint(/message?session_id=..) 与绝对 URL endpoint
//   F5  reader / pending / AbortController 全部在 finally 清理；
//       删除 setTimeout(() => process.exit()) 强退（会吞掉未处理 Promise、泄漏连接）
//   F6  discovery 探测用**局部 timeout**，不再改全局 opt.timeout（并发会互相覆盖）
//   F7  probe() 里 reader.read() 与超时 Promise 的竞态 → 单一 reader + 整体 abort
//   F8  端口扫描并发受控 + host/port 去重，避免连接风暴
//   F9  render-spread 输出文件名唯一（默认带时间戳），不再静默覆盖
//   F10 execFile 替代 shell 字符串；保留 IPv4/IPv6 loopback
//
// 依赖：Node 18+（用内置 fetch + AbortController）。零外部依赖。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
    EXIT, UsageError, RunError, parseArgs, requirePort, requirePositiveInt,
    requireIndex, requireExistingFile, runMain,
} from './lib/cli.mjs';

const execFileP = promisify(execFile);

export const PROTOCOL = '2025-11-25';        // ★ 必须；传 2024-11-05 会被拒
export const HOSTS = ['[::1]', '127.0.0.1']; // Affinity 有时只监听 IPv6 loopback

const TOOLS = {
    DEFAULT_TIMEOUT: 120_000,
    DISCOVERY_TIMEOUT: 6_000,     // 握手探测用，短超时避免 discovery 卡住
    PROBE_CONNECT_MS: 1_500,      // 单个端口的连接预算
    PROBE_TOTAL_MS: 3_000,        // 单个端口的总预算（等 endpoint 事件）
    ENDPOINT_WAIT_MS: 8_000,      // 正式会话等 endpoint 的上限
    SCAN_CONCURRENCY: 8,          // 端口扫描并发上限（F8）
    SCAN_BATCH: 64,
};

// ============================================================================
// 带真实超时的 fetch
// ============================================================================

/**
 * 带 AbortController 的 fetch。
 *
 * 为什么必须这样：只给「等待响应的 Promise」加 setTimeout 是**不够**的——
 * 底层 socket 可能永远不返回，Node 事件循环被挂住，进程既不退出也不报错。
 * 把 signal 传给 fetch 才会真正取消底层 I/O。
 *
 * @param {string} url
 * @param {RequestInit & {timeoutMs?:number}} opts
 */
async function fetchWithTimeout(url, opts = {}) {
    const { timeoutMs = TOOLS.DEFAULT_TIMEOUT, signal: outer, ...rest } = opts;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    const onOuterAbort = () => ctrl.abort();
    if (outer) {
        if (outer.aborted) ctrl.abort();
        else outer.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
        return await fetch(url, { ...rest, signal: ctrl.signal });
    } catch (e) {
        if (timedOut) {
            throw new RunError(`请求超时（${timeoutMs}ms）: ${url}`,
                '端口可能已变化，用 --discover 重新扫描；或用 --timeout 调大上限');
        }
        if (outer?.aborted) throw new RunError(`请求已取消: ${url}`);
        throw new RunError(`请求失败: ${url} —— ${e?.cause?.code || e?.message || e}`,
            /ECONNREFUSED|ECONNRESET|fetch failed/i.test(String(e?.message || e))
                ? '端口可能已变化 —— 用 --discover 重新扫描。' : null);
    } finally {
        clearTimeout(timer);
        if (outer) outer.removeEventListener('abort', onOuterAbort);
    }
}

/**
 * 建立 SSE 连接。
 *
 * 与 fetchWithTimeout 的区别（这一点很关键）：
 *   **不能**在 fetch 返回后就解除与调用方 AbortController 的联动。
 *   fetch 拿到响应头只代表「连接建立」，响应体还会持续流出很久；
 *   若此时把 listener 摘掉，调用方之后调 abort() 就传不到底层流，
 *   `reader.read()` 会永远挂着 —— 表现为 close() 永不返回、进程不退出。
 *   （v0.4 实测踩到：session.close() 死锁。）
 *
 * @param {string} url
 * @param {{headers?:object, signal?:AbortSignal, connectTimeoutMs?:number}} opts
 * @returns {Promise<{res:Response, detach:()=>void}>}
 */
async function fetchSse(url, { headers, signal, connectTimeoutMs = TOOLS.DEFAULT_TIMEOUT } = {}) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, connectTimeoutMs);

    const onOuterAbort = () => { try { ctrl.abort(); } catch { /* ignore */ } };
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', onOuterAbort);
    }

    const detach = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
    };

    try {
        const res = await fetch(url, { headers, signal: ctrl.signal });
        // 连接已建立：清掉连接超时定时器，但**保留** abort 联动（流还要用）
        clearTimeout(timer);
        if (timedOut) {
            try { await res.body?.cancel(); } catch { /* ignore */ }
            detach();
            throw new RunError(`SSE 连接超时（${connectTimeoutMs}ms）: ${url}`);
        }
        return { res, detach };
    } catch (e) {
        detach();
        if (e instanceof RunError) throw e;
        if (timedOut) {
            throw new RunError(`SSE 连接超时（${connectTimeoutMs}ms）: ${url}`);
        }
        if (signal?.aborted) throw new RunError(`SSE 请求已取消: ${url}`);
        throw new RunError(`SSE 连接失败: ${url} —— ${e?.cause?.code || e?.message || e}`,
            /ECONNREFUSED|ECONNRESET|fetch failed/i.test(String(e?.message || e))
                ? '端口可能已变化 —— 用 --discover 重新扫描。' : null);
    }
}

/** 把 endpoint（相对路径或绝对 URL）解析成可 POST 的 URL。 */
export function resolveEndpoint(base, endpoint) {
    if (/^https?:\/\//i.test(endpoint)) return endpoint;      // 服务端给了绝对 URL
    if (!endpoint.startsWith('/')) {
        throw new RunError(`无法识别的 SSE endpoint: ${JSON.stringify(endpoint)}`);
    }
    return base + endpoint;
}

// ============================================================================
// SSE 会话
// ============================================================================

/**
 * 建立 SSE 流 + JSON-RPC 通道。
 * 调用方**必须** await close()（用 finally 兜住），否则 socket 不会释放。
 *
 * @param {{port:number, host:string, endpointHint?:string|null,
 *          timeoutMs?:number, skipPreamble?:boolean, onDebug?:Function}} opts
 */
export async function openSession(opts) {
    const {
        port, host, endpointHint = null,
        timeoutMs = TOOLS.DEFAULT_TIMEOUT,
        skipPreamble = false,
        onDebug = () => {},
        // 仅供离线测试：让假服务切换失败场景（真实服务端忽略此参数）
        testScenario = null,
    } = opts;

    const BASE = `http://${host}:${port}`;
    // 整个会话共用一个 controller：close() 时 abort 掉底层流
    const sessionCtrl = new AbortController();
    const pending = new Map();          // id -> {resolve, reject, timer}
    let nextId = 1;
    let endpoint = endpointHint;
    let closed = false;
    let reader = null;
    let pump = null;

    // ---- 拒绝所有在途请求，保证 close() 后不留悬挂 Promise ----
    const rejectAllPending = (reason) => {
        for (const [, p] of pending) {
            clearTimeout(p.timer);
            p.reject(reason);
        }
        pending.clear();
    };

    const close = async () => {
        if (closed) return;
        closed = true;
        rejectAllPending(new RunError('会话已关闭'));

        // 顺序很关键：**先 abort，再 detach**。
        // detach() 会移除与 sessionCtrl 的 abort 联动；若先 detach 再 abort，
        // abort 就传不到底层 SSE 流，pump 会永远卡在 reader.read() 上 → close() 死锁。
        const wasAborted = sessionCtrl.signal.aborted;
        if (!wasAborted) { try { sessionCtrl.abort(); } catch { /* ignore */ } }

        if (pump) { try { await pump; } catch { /* ignore */ } }

        // 关键：只有「本次没有 abort 底层流」时才 cancel。
        // 对同一底层句柄先 abort 再 cancel，会在 Node 退出时打印
        //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
        // （v0.3 用 setTimeout(()=>process.exit()) 强退想掩盖的正是这个噪音——
        //   根因是重复关闭，而不是缺少强退。）
        if (reader && !wasAborted) { try { await reader.cancel(); } catch { /* ignore */ } }
        reader = null;
        if (detachSse) { detachSse(); detachSse = null; }
    };

    let res;
    let detachSse = null;
    const sseUrl = BASE + '/sse' + (testScenario ? `?scenario=${encodeURIComponent(testScenario)}` : '');
    try {
        const conn = await fetchSse(sseUrl, {
            headers: { accept: 'text/event-stream' },
            signal: sessionCtrl.signal,
            connectTimeoutMs: timeoutMs,
        });
        res = conn.res;
        detachSse = conn.detach;
    } catch (e) {
        throw e instanceof RunError ? e : new RunError(`SSE 连接失败: ${e?.message || e}`);
    }
    if (!res.ok) {
        if (detachSse) { detachSse(); detachSse = null; }
        try { await res.body?.cancel(); } catch { /* ignore */ }
        throw new RunError(`SSE 连接失败: HTTP ${res.status} ${res.statusText || ''}`.trim(),
            '端口可能已变，先用 --discover 重新扫描');
    }
    const ct = res.headers.get('content-type') || '';
    if (!/text\/event-stream/i.test(ct)) {
        if (detachSse) { detachSse(); detachSse = null; }
        try { await res.body?.cancel(); } catch { /* ignore */ }
        throw new RunError(`SSE 响应 Content-Type 不对: ${JSON.stringify(ct)}（期望 text/event-stream）`,
            '这个端口可能不是 Affinity MCP');
    }
    if (!res.body) {
        if (detachSse) { detachSse(); detachSse = null; }
        throw new RunError('SSE 响应没有 body（连接被立即关闭）');
    }

    reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let endpointReady = null;
    const endpointPromise = new Promise((resolve, reject) => { endpointReady = { resolve, reject }; });
    // endpointHint 路径不会 await endpointPromise；预先 resolve，避免 SSE
    // 关闭时 pump reject 一个无人消费的 Promise。
    if (endpoint) endpointReady.resolve(endpoint);

    /** SSE 行尾可能是 \r\n 或 \n，统一按空行切块 */
    function drain(text) {
        const re = /\r?\n\r?\n/g;
        let m, cut = -1;
        while ((m = re.exec(text)) !== null) cut = m.index + m[0].length;
        if (cut < 0) return { rest: text, blocks: [] };
        return { rest: text.slice(cut), blocks: text.slice(0, cut).split(/\r?\n\r?\n/).filter(Boolean) };
    }

    pump = (async () => {
        try {
            while (!closed) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const { rest, blocks } = drain(buf);
                buf = rest;
                for (const block of blocks) {
                    let ev = null;
                    const dl = [];
                    for (const line of block.split(/\r?\n/)) {
                        if (line.startsWith('event:')) ev = line.slice(6).trim();
                        else if (line.startsWith('data:')) dl.push(line.slice(5).replace(/^ /, ''));
                    }
                    const data = dl.join('\n');
                    // endpoint 事件：可能是 event: endpoint + data: /path?session_id=..
                    if (ev === 'endpoint' || (!ev && data.startsWith('/') && /session_?id/i.test(data))) {
                        endpoint = data;
                        endpointReady?.resolve(data);
                        continue;
                    }
                    if (!data) continue;
                    let j = null;
                    try { j = JSON.parse(data); } catch { continue; }   // 非 JSON 事件，忽略
                    if (j && j.id !== undefined && pending.has(j.id)) {
                        const p = pending.get(j.id);
                        pending.delete(j.id);
                        clearTimeout(p.timer);
                        p.resolve(j);
                    }
                }
            }
            // 流正常结束：让在途请求立刻失败，而不是等到超时
            rejectAllPending(new RunError('SSE 连接已被服务端关闭'));
            endpointReady?.reject(new RunError('SSE 流在收到 endpoint 前结束'));
        } catch (e) {
            if (!closed) {
                rejectAllPending(new RunError(`SSE 流异常: ${e?.message || e}`));
                endpointReady?.reject(new RunError(`SSE 流异常: ${e?.message || e}`));
            }
        }
    })();

    // ---- 等 endpoint（带真实超时，超时会 abort 整条流）----
    // 从这里开始，任何握手/RPC 失败都必须关闭已建立的 SSE；否则调用方尚未
    // 拿到 sess，外层 finally 无法接管这条流。
    try {
    if (!endpoint) {
        let timer;
        let gotEndpoint = false;
        try {
            endpoint = await Promise.race([
                endpointPromise,
                new Promise((_, rej) => {
                    timer = setTimeout(() => {
                        rej(new RunError(`等待 SSE endpoint 事件超时（${TOOLS.ENDPOINT_WAIT_MS}ms）`));
                        try { sessionCtrl.abort(); } catch { /* ignore */ }
                    }, TOOLS.ENDPOINT_WAIT_MS);
                }),
            ]);
            gotEndpoint = true;
        } finally {
            clearTimeout(timer);
            // 只有「没拿到 endpoint」才是失败路径；成功时绝不能 abort，
            // 否则后面的 POST 会被自己的 signal 取消。
            if (!gotEndpoint) {
                // 保留 fetchSse 的 abort 联动，先 abort 让 reader.read() 结束；
                // close() 会在 pump 收尾后再 detach。顺序反过来会造成死锁。
                try { sessionCtrl.abort(); } catch { /* ignore */ }
            }
        }
    }

    const postUrl = resolveEndpoint(BASE, endpoint);

/**
     * 发一次 JSON-RPC。
     *
     * MCP-over-SSE 的关键语义（实测 Affinity 行为，本实现据此编写）：
     *   POST /message?session_id=… 只回 `202 Accepted`（表示"已收下"），
     *   **真正的 JSON-RPC 响应是通过 SSE 流回传的**（一个 data: 事件）。
     *   所以流程是：POST 拿 2xx → 再等 pending 被 SSE pump 兑现。
     *
     * v0.4 修复：此前把 POST 的响应体直接当结果解析。在真实服务上 POST 体是空的，
     * 于是每次 RPC 都会等到超时，且失败会被伪装成「空工具列表」。
     *
     * 两条独立超时：
     *   - fetchWithTimeout 的 AbortController：HTTP 层挂起时可真正取消
     *   - pending 的 timer：POST 成功但服务端不回响应时兜底
     */
    const rpc = async (method, params, { notify = false, timeoutMs: tmo = timeoutMs } = {}) => {
        const msg = { jsonrpc: '2.0', method };
        if (params !== undefined) msg.params = params;

        const dropPending = () => {
            const e0 = pending.get(id);
            if (e0) { clearTimeout(e0.timer); pending.delete(id); }
        };

        if (notify) {
            const r = await fetchWithTimeout(postUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(msg),
                signal: sessionCtrl.signal,
                timeoutMs: tmo,
            });
            if (!r.ok) {
                const body = await r.text().catch(() => '');
                throw new RunError(`${method} 通知失败: HTTP ${r.status} ${r.statusText || ''}${body ? ' — ' + body.slice(0, 200) : ''}`.trim());
            }
            try { await r.text(); } catch { /* 响应体可有可无 */ }
            return null;
        }

        msg.id = nextId++;
        const id = msg.id;

        // 先挂 pending 再 POST —— 否则响应比 POST 返回更快时会丢包
        const p = new Promise((resolve, reject) => {
            const entry = { resolve, reject, timer: null };
            entry.timer = setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id);
                    reject(new RunError(`RPC 超时（${tmo}ms）: ${method}`,
                        '用 --timeout 调大上限；若服务端无响应，先用 --tools 验证通道'));
                }
            }, tmo);
            pending.set(id, entry);
        });
        // 关键：挂一个空的拒绝处理器。
        // 若POST 本身先失败（如会话被close() abort），我们会提前throw，
        // 这时 p 可能已被 rejectAllPending 拒绝但**没人 await**它 ——
        // Node 会报 unhandledRejection 并终止进程。
        // 这里只消费「未处理」标记，真正的 await 仍在下面进行。
        p.catch(() => { /* 见上方说明：防止孤儿 Promise */ });

        try {
            // ① POST：只判断传输层
            const r = await fetchWithTimeout(postUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify(msg),
                signal: sessionCtrl.signal,
                timeoutMs: tmo,
            });
            if (!r.ok) {
                const body = await r.text().catch(() => '');
                dropPending();
                throw new RunError(
                    `${method} 失败: HTTP ${r.status} ${r.statusText || ''}${body ? ' — ' + body.slice(0, 200) : ''}`.trim(),
                    'SSE 会话可能已失效，重新运行本命令');
            }
            const postBody = await r.text().catch(() => '');

            // ② 兼容「直接在 POST 响应体里回 JSON-RPC」的服务端
            if (postBody && postBody.trim() && !/^\s*Accepted\s*$/i.test(postBody)) {
                let direct = null;
                try { direct = JSON.parse(postBody); } catch { direct = null; }
                if (direct && direct.id === id) {
                    dropPending();
                    if (direct.error) {
                        throw new RunError(`${method} 返回 RPC error: ${direct.error.message || JSON.stringify(direct.error)}`);
                    }
                    return direct;
                }
            }

            // ③ 正常路径：等 SSE 流回传
            const j = await p;
            if (!j || j.id === undefined) {
                throw new RunError(`${method} 返回空响应`, 'SSE 会话可能已失效，重新运行本命令');
            }
            if (j.error) {
                throw new RunError(`${method} 返回 RPC error: ${j.error.message || JSON.stringify(j.error)}`);
            }
            if (j.id !== id) {
                throw new RunError(`${method} 响应 id 不匹配（期望 ${id}，收到 ${j.id}）`);
            }
            return j;
        } finally {
            const entry = pending.get(id);
            if (entry) { clearTimeout(entry.timer); pending.delete(id); }
        }
    };
    // ---- 握手 ----
    const init = await rpc('initialize', {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'affinity-script-skill', version: '0.4' },
    });
    const serverInfo = init?.result?.serverInfo || null;
    await rpc('notifications/initialized', undefined, { notify: true });

    const tl = await rpc('tools/list', {});
    const toolList = tl?.result?.tools;
    if (!Array.isArray(toolList)) {
        throw new RunError('tools/list 没有返回工具数组',
            `实际收到: ${JSON.stringify(tl).slice(0, 300)}`);
    }
    const tools = toolList.map((t) => t.name);

    const call = async (name, args) => {
        const r = await rpc('tools/call', { name, arguments: args });
        return r?.result ?? r;
    };
    const text = (r) => (r?.content || []).map((c) => c.text || '').join('\n');

    // 自动读 preamble（否则 execute_script 会被拒）
    let preambleReady = false;
    if (!skipPreamble && tools.includes('read_sdk_documentation_topic')) {
        try {
            await call('read_sdk_documentation_topic', { filename: 'preamble' });
            preambleReady = true;
        } catch (e) {
            onDebug(`preamble 读取失败: ${e?.message}`);
        }
    }

    return {
        BASE, endpoint, postUrl, serverInfo, tools, rpc, call, text, preambleReady, close,
    };
    } catch (e) {
        await close();
        throw e;
    }
}

// ============================================================================
// 端口发现
// ============================================================================

/** 按进程名锁定 Affinity 的 PID，只扫它自己的端口（快且准）。 */
async function affinityPorts() {
    try {
        const { stdout } = await execFileP('tasklist', ['/FO', 'CSV', '/NH'],
            { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
        const pids = new Set();
        for (const line of String(stdout).split(/\r?\n/)) {
            // "Affinity.exe","11404","Console","1","1,103,840 K"
            const m = /^"([^"]*[Aa]ffinity[^"]*\.exe)","(\d+)"/.exec(line.trim());
            if (m) pids.add(m[2]);
        }
        if (!pids.size) return null;
        const { stdout: ns } = await execFileP('netstat', ['-ano'],
            { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        const ports = new Set();
        for (const line of String(ns).split(/\r?\n/)) {
            const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
            if (m && pids.has(m[2])) ports.add(Number(m[1]));
        }
        return { pids: [...pids], ports: [...ports].sort((a, b) => a - b) };
    } catch { return null; }
}

function listeningPorts() {
    return execFileP('netstat', ['-ano'], { maxBuffer: 16 * 1024 * 1024, windowsHide: true })
        .then(({ stdout }) => {
            const set = new Set();
            for (const line of String(stdout).split(/\r?\n/)) {
                const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+\d+\s*$/.exec(line);
                if (m) set.add(Number(m[2]));
            }
            return [...set].sort((a, b) => a - b);
        })
        .catch(() => []);
}

/**
 * 探测单个 host:port 是否是 Affinity MCP。
 *
 * F7 修复：原实现把 `reader.read()` 和一个 600ms 的超时 Promise 放进 race，
 * 超时后 read() **仍在后台挂着**；下一轮又对同一个 reader 调 read() →
 * 同一 reader 上的并发 read，行为未定义且会漏事件。
 * 现在：单一 reader + 整体 AbortController，总预算到点就 abort 掉底层流。
 *
 * @returns {Promise<{port:number,host:string,endpoint:string}|null>}
 */
export async function probePort(port, host, { debug = false } = {}) {
    const ctrl = new AbortController();
    const budget = setTimeout(() => ctrl.abort(), TOOLS.PROBE_TOTAL_MS);
    let reader = null;
    try {
        const res = await fetch(`http://${host}:${port}/sse`, {
            headers: { accept: 'text/event-stream' },
            signal: ctrl.signal,
        });
        if (!res.ok) { try { res.body?.cancel(); } catch { /* ignore */ } return null; }
        const ct = res.headers.get('content-type') || '';
        if (!/text\/event-stream/i.test(ct)) { try { res.body?.cancel(); } catch { /* ignore */ } return null; }
        if (!res.body) return null;

        reader = res.body.getReader();
        const dec = new TextDecoder();
        let acc = '';
        let gotAny = false;

        // 单一 reader 顺序读取；deadline 由 abort 统一兜底
        const deadline = Date.now() + TOOLS.PROBE_TOTAL_MS;
        while (Date.now() < deadline) {
            const r = await reader.read();
            if (r.done) break;
            gotAny = true;
            acc += dec.decode(r.value, { stream: true });
            if (/\r?\n\r?\n/.test(acc)) break;         // 拿到第一个完整事件块就够了
        }
        if (!gotAny) return null;
        if (/event:\s*endpoint/i.test(acc) && /session_?id/i.test(acc)) {
            const m = /data:\s*(\S+)/.exec(acc);
            if (m) return { port, host, endpoint: m[1] };
        }
        return null;
    } catch {
        return null;                                    // 超时/连接失败 = 不是它
    } finally {
        clearTimeout(budget);
        ctrl.abort();                                  // 无论成功失败都断开会话
        // abort 会让唯一的 reader.read() 结束；这里不要再 cancel 同一底层流，
        // 否则 Node/undici 可能出现重复关闭句柄的竞态。
        if (debug) process.stderr.write(`  [dbg] probe(${host},${port}) → done\n`);
    }
}

/** 用 tools/list 确认是否真 Affinity（serverInfo.name 匹配）。局部 timeout，不改全局配置（F6）。 */
async function verifyAffinity(target) {
    let sess = null;
    try {
        sess = await openSession({
            port: target.port,
            host: target.host,
            endpointHint: null,       // ★ 不能复用 probe 的 endpoint：那属于已关闭的会话
            timeoutMs: TOOLS.DISCOVERY_TIMEOUT,
            skipPreamble: true,
        });
        const info = sess.serverInfo;
        return !!(info && /affinity/i.test(String(info.name || '')));
    } catch {
        return false;
    } finally {
        if (sess) await sess.close();                 // 每次握手都必须关，否则连接堆积
    }
}

/** 受控并发地跑任务（F8：避免端口扫描造成连接风暴）。 */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (idx < items.length) {
            const i = idx++;
            try { out[i] = await fn(items[i], i); }
            catch { out[i] = null; }
        }
    });
    await Promise.all(workers);
    return out;
}

export async function discover({ debug = false } = {}) {
    // 路线 1（快且准）：按进程名锁定 Affinity 的监听端口
    const ap = await affinityPorts();
    const tried = new Set();                            // host:port 去重（F8）
    const tryTarget = async (p, h) => {
        const key = `${h}:${p}`;
        if (tried.has(key)) return null;
        tried.add(key);
        const hit = await probePort(p, h, { debug });
        if (debug) process.stderr.write(`  [dbg] probe(${h}:${p}) → ${hit ? 'HIT' : 'miss'}\n`);
        if (!hit) return null;
        await new Promise((r) => setTimeout(r, 250));  // 让上一条 SSE 充分释放
        const ok = await verifyAffinity(hit);
        if (debug) process.stderr.write(`  [dbg] verify(${h}:${p}) → ${ok}\n`);
        return ok ? hit : null;
    };

    if (ap && ap.ports.length) {
        process.stderr.write(`Affinity PID=${ap.pids.join(',')}，监听端口 ${ap.ports.join(', ')}\n`);
        for (const p of ap.ports) {
            for (const h of HOSTS) {
                const hit = await tryTarget(p, h);
                if (hit) return hit;
            }
        }
    } else {
        process.stderr.write('未按进程名定位到 Affinity，回退全量扫描\n');
    }

    // 路线 2（兜底）：全量扫描；分批 + 受控并发
    const ports = await listeningPorts();
    process.stderr.write(`扫描 ${ports.length} 个监听端口…\n`);
    for (let i = 0; i < ports.length; i += TOOLS.SCAN_BATCH) {
        const batch = ports.slice(i, i + TOOLS.SCAN_BATCH);
        const targets = [];
        for (const p of batch) for (const h of HOSTS) {
            const key = `${h}:${p}`;
            if (tried.has(key)) continue;
            tried.add(key);
            targets.push({ p, h });
        }
        if (!targets.length) continue;
        const rs = await mapLimit(targets, TOOLS.SCAN_CONCURRENCY, ({ p, h }) => tryTarget(p, h));
        for (const hit of rs) if (hit) return hit;
    }
    return null;
}

// ============================================================================
// CLI
// ============================================================================

const USAGE = `用法:
  node mcp-client.mjs --discover
  node mcp-client.mjs [--port P] [--host H] --tools
  node mcp-client.mjs [--port P] --exec "<js>"
  node mcp-client.mjs [--port P] --exec-file <file.js>
  node mcp-client.mjs [--port P] --save <file.js> --title "T" --desc "D"
  node mcp-client.mjs [--port P] --lib | --read "T" | --docs
  node mcp-client.mjs [--port P] --render-spread <uuid> <index> [--out 文件.jpg]
  node mcp-client.mjs [--port P] --task '{"name":"工具名","arguments":{}}'

选项:
  --discover            扫描本机寻找 Affinity MCP 端口
  --port P              1..65535；省略时自动先 discovery
  --host H              默认依次试 [::1] 与 127.0.0.1
  --timeout MS          单次 RPC 超时毫秒数（正整数，默认 ${TOOLS.DEFAULT_TIMEOUT}）
  --out FILE            render-spread 的输出路径（默认生成唯一文件名）
  -h, --help            显示本帮助

退出码: 0 成功 / 1 运行失败 / 2 参数错误`;

export function parseCli(argv) {
    const p = parseArgs(argv, {
        flags: ['discover', 'tools', 'docs', 'lib', 'help', 'h', 'version'],
        values: ['port', 'host', 'timeout', 'exec', 'exec-file', 'save', 'title', 'desc',
            'read', 'render-spread', 'render-selection', 'task', 'out'],
        maxPositional: 0,
    });
    const flags = p.flags;
    const v = p.values;
    const opt = {
        discover: flags.has('discover'),
        tools: flags.has('tools'),
        docs: flags.has('docs'),
        lib: flags.has('lib'),
        help: flags.has('help') || flags.has('h'),
        version: flags.has('version'),
        port: v.port !== undefined ? requirePort(v.port) : null,
        host: v.host ?? null,
        timeout: v.timeout !== undefined ? requirePositiveInt(v.timeout, '--timeout') : TOOLS.DEFAULT_TIMEOUT,
        exec: v.exec ?? null,
        execFile: v['exec-file'] ?? null,
        save: v.save ?? null,
        title: v.title ?? null,
        desc: v.desc ?? '',
        read: v.read ?? null,
        task: v.task ?? null,
        out: v.out ?? null,
        renderSpread: null,
        renderSelection: v['render-selection'] ?? null,
    };

    if (opt.host && !/^\[?[0-9a-f:.]+\]?$/i.test(opt.host) && !/^[a-z0-9.-]+$/i.test(opt.host)) {
        throw new UsageError(`--host 不是合法的主机名或地址: ${JSON.stringify(opt.host)}`);
    }

    // --render-spread 需要「UUID + 页索引」两个值，缺一不可（原来会得到 NaN）
    if (v['render-spread'] !== undefined) {
        const parts = v['render-spread'].split(',');
        if (parts.length !== 2 || !parts[0] || parts[1] === '') {
            throw new UsageError('--render-spread 需要两个值：<sessionUuid>,<spreadIndex>',
                '例：--render-spread 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d,0');
        }
        opt.renderSpread = {
            uuid: parts[0],
            index: requireIndex(parts[1], 'spreadIndex'),
        };
    }

    // 互斥：同一时刻只允许一个「动作」
    const actions = [
        ['exec', opt.exec !== null], ['execFile', opt.execFile !== null],
        ['save', opt.save !== null], ['lib', opt.lib], ['read', opt.read !== null],
        ['docs', opt.docs], ['task', opt.task !== null],
        ['renderSpread', opt.renderSpread !== null], ['renderSelection', opt.renderSelection !== null],
    ].filter(([, on]) => on).map(([n]) => n);
    if (actions.length > 1) {
        throw new UsageError(`这些选项不能同时使用: ${actions.join(', ')}`);
    }

    if (opt.execFile) requireExistingFile(opt.execFile, '--exec-file');
    if (opt.save) requireExistingFile(opt.save, '--save');

    if (opt.task) {
        try { JSON.parse(opt.task); }
        catch (e) { throw new UsageError(`--task 不是合法 JSON: ${e.message}`); }
    }
    return opt;
}

// ============================================================================
// 主流程
// ============================================================================

/** 生成唯一输出文件名（F9：绝不静默覆盖已有文件）。 */
export function uniqueOutName(base) {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${base}-${ts}-${process.pid}.jpg`;
}

async function main() {
    const opt = parseCli(process.argv.slice(2));
    if (opt.help) { console.log(USAGE); return EXIT.OK; }
    if (opt.version) { console.log('mcp-client v0.4'); return EXIT.OK; }

    const debug = !!process.env.MCP_DEBUG;
    let target = null;

    if (opt.port) {
        const hosts = opt.host ? [opt.host] : HOSTS;
        for (const h of hosts) {
            const cand = { port: opt.port, host: h, endpoint: null };
            if (await verifyAffinity(cand)) { target = cand; break; }
        }
        if (!target) {
            throw new RunError(`${opt.port} 不是 Affinity MCP（IPv6/IPv4 均试过）`,
                '端口是动态的，用 --discover 重新扫描');
        }
    } else {
        target = await discover({ debug });
        if (!target) {
            throw new RunError('未发现 Affinity MCP 服务',
                '① 确认 Affinity 正在运行  ② MCPPreferences.xml 里 EnableMCPServer=True');
        }
    }

    console.log(`✓ Affinity MCP: http://${target.host}:${target.port}`);

    let sess = null;
    try {
        sess = await openSession({
            port: target.port, host: target.host,
            timeoutMs: opt.timeout,
        });
        console.log(`  serverInfo: ${JSON.stringify(sess.serverInfo)}`);
        console.log(`  工具数: ${sess.tools.length}`);
        if (!sess.preambleReady) {
            console.warn('  ⚠ preamble 未读到，execute_script 可能被拒');
        }

        const { call, text } = sess;
        let didSomething = false;

        if (opt.tools) {
            didSomething = true;
            console.log('\n=== 工具清单 ===');
            const tl = await sess.rpc('tools/list', {});
            for (const t of (tl?.result?.tools || [])) {
                const props = Object.keys(t.inputSchema?.properties || {}).join(', ');
                console.log(`  ${t.name}(${props})`);
                if (t.description) console.log(`      ${String(t.description).split('\n')[0].slice(0, 140)}`);
            }
        }

        if (opt.docs) {
            didSomething = true;
            console.log('\n=== SDK 文档 ===');
            const r = await call('list_sdk_documentation', {});
            console.log(text(r).slice(0, 4000) || JSON.stringify(r).slice(0, 1000));
        }

        if (opt.lib) {
            didSomething = true;
            console.log('\n=== 脚本库 ===');
            const r = await call('list_library_scripts', {});
            console.log(text(r) || '(空)');
        }

        if (opt.read !== null) {
            didSomething = true;
            console.log(`\n=== 读取库内脚本「${opt.read}」===`);
            const r = await call('read_library_script', { title: opt.read });
            const t = text(r);
            console.log(`长度: ${t.length} 字符`);
            console.log(t.slice(0, 1500));
        }

        if (opt.exec !== null) {
            didSomething = true;
            console.log('\n=== execute_script ===');
            const r = await call('execute_script', { script: opt.exec });
            console.log('isError=' + r?.isError);
            console.log(text(r) || '(无输出)');
        }

        if (opt.execFile) {
            didSomething = true;
            const src = fs.readFileSync(opt.execFile, 'utf8');
            console.log(`\n=== execute_script（${path.basename(opt.execFile)}，${Buffer.byteLength(src, 'utf8')} 字节）===`);
            const r = await call('execute_script', { script: src });
            console.log('isError=' + r?.isError);
            console.log(text(r) || '(无输出)');
        }

        if (opt.save) {
            didSomething = true;
            const src = fs.readFileSync(opt.save, 'utf8');
            const title = opt.title || path.basename(opt.save).replace(/\.js$/i, '');
            console.log(`\n=== save_script_to_library（title=${title}）===`);
            const r = await call('save_script_to_library', { title, description: opt.desc, code: src });
            console.log('isError=' + r?.isError);
            console.log(text(r) || JSON.stringify(r).slice(0, 400));
            console.log('\n提示：MCP 入库的脚本权限位=设置默认值（通常 3），无需 fix-script-perms.mjs');
        }

        if (opt.renderSpread) {
            didSomething = true;
            const { uuid, index } = opt.renderSpread;
            console.log('\n=== render_spread ===');
            const r = await call('render_spread', { document_session_uuid: uuid, spread_index: index });
            const t = text(r);
            const b64 = /base64,([A-Za-z0-9+/=]+)/.exec(t)?.[1]
                || (/^[A-Za-z0-9+/=]{100,}$/.test(t.trim()) ? t.trim() : null);
            if (!b64) {
                console.log(t.slice(0, 300) || JSON.stringify(r).slice(0, 300));
            } else {
                // F9：默认文件名带时间戳，天然不冲突；显式 --out 时禁止静默覆盖
                const outPath = opt.out || uniqueOutName(`render-spread-${index}`);
                if (fs.existsSync(outPath)) {
                    throw new RunError(`输出文件已存在，拒绝覆盖: ${outPath}`,
                        '换一个 --out 路径，或先删除旧文件');
                }
                fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
                console.log(`已写出: ${outPath}  (${fs.statSync(outPath).size} 字节)`);
            }
        }

        if (opt.renderSelection) {
            didSomething = true;
            console.log('\n=== render_selection ===');
            const r = await call('render_selection', { document_session_uuid: opt.renderSelection });
            console.log(text(r).slice(0, 300) || JSON.stringify(r).slice(0, 300));
        }

        if (opt.task) {
            didSomething = true;
            console.log('\n=== 自定义工具调用 ===');
            const parsed = JSON.parse(opt.task);
            if (!parsed.name) throw new UsageError('--task 的 JSON 里必须有 name 字段');
            const r = await call(parsed.name, parsed.arguments || {});
            console.log(JSON.stringify(r, null, 2).slice(0, 6000));
        }

        if (!didSomething) { console.log(USAGE); }
        return EXIT.OK;
    } finally {
        // F5：无论成功、失败还是抛异常，都必须关闭会话
        if (sess) await sess.close();
    }
}

// 直接运行时才执行（测试可 import 本模块而不触发 CLI）
const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    const code = await runMain(main);
    // 不再用 setTimeout(() => process.exit()) 强退：会话已在 finally 里关闭，
    // 事件循环会自然排空。强退会吞掉未处理的 Promise 拒绝并打印断言噪音。
    process.exitCode = code;
}

export { main, USAGE, TOOLS };