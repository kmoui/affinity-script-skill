// ============================================================================
// mock-mcp.mjs —— 测试用的假 Affinity MCP 服务
//
// 用来离线验证 mcp-client 的**全部失败路径**，不需要真的开着 Affinity：
//   - endpoint 超时（连上了但不发 endpoint 事件）
//   - HTTP 错误（POST 返回 500）
//   - RPC error（返回 JSON-RPC error 对象）
//   - RPC 超时（收到请求但永不回应）
//   - 异常断开（握手中途切断 SSE）
//   - Content-Type 不对 / 非 SSE
//   - 空响应体
//   - 正常路径（握手 → tools/list → tools/call）
//
// 每个场景由 URL 路径前缀选择，例如 /sse?scenario=rpc-timeout
// ============================================================================

import http from 'node:http';

export const SCENARIOS = [
    'ok',                // 正常
    'no-endpoint',       // 连上但不发 endpoint 事件（测 endpoint 等待超时）
    'http-500',          // POST 返回 500
    'rpc-error',         // 返回 JSON-RPC error
    'rpc-timeout',       // 收到请求不回响应
    'abort',             // 握手中途断开 SSE
    'wrong-content-type',// Content-Type 不是 event-stream
    'empty-body',        // POST 返回空响应体
    'absolute-endpoint', // endpoint 给绝对 URL
    'no-session-cleanup',// 正常握手但工具调用返回错误，测 close 是否仍清理
];

/**
 * 启动假服务。
 * @param {number} port 传0 = 由系统分配空闲端口
 * @returns {Promise<{port:number, close:()=>Promise<void>, requests:string[]}>}
 */
export async function startMockMcp(port = 0) {
    /** @type {Map<string, {res:http.ServerResponse, scenario:string}>} */
    const sessions = new Map();
    const requests = [];
    let sessionSeq = 0;
    let currentPort = 0;
    let openStreams = 0;   // 未关闭的 SSE 响应流数（泄漏检测用）

    /** 把 JSON-RPC 响应通过该会话的 SSE 流推回去 */
    const push = (sid, obj) => {
        const s = sessions.get(sid);
        if (!s) return;
        try {
            s.res.write(`event: message\r\ndata: ${JSON.stringify(obj)}\r\n\r\n`);
        } catch { /* 流已断 */ }
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const scenario = url.searchParams.get('scenario') || 'ok';

        if (req.method === 'GET' && url.pathname === '/sse') {
            if (scenario === 'wrong-content-type') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"not":"sse"}');
                return;
            }
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
            });
            const sid = 'sess' + (++sessionSeq);
            sessions.set(sid, { res, scenario });
            // 记录端口，供绝对 URL endpoint 场景使用
            currentPort = server.address()?.port ?? currentPort;
            // 跟踪未关闭的 SSE 流：客户端泄漏连接时 openStreams() 会 > 0
            openStreams++;
            res.on('close', () => { openStreams--; });

            if (scenario === 'no-endpoint') {
                // 什么都不发，让客户端等到 endpoint 超时
                return;
            }
            if (scenario === 'abort') {
                // 发一半就断
                res.write('event: endpoint\r\n');
                setTimeout(() => res.destroy(), 30);
                return;
            }
            // 正常发 endpoint（注意 Affinity 用 \r\n 行尾）
            const ep = scenario === 'absolute-endpoint'
                ? `http://127.0.0.1:${currentPort}/message?session_id=${sid}&scenario=${scenario}`
                : `/message?session_id=${sid}&scenario=${scenario}`;
            res.write(`event: endpoint\r\ndata: ${ep}\r\n\r\n`);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/message') {
            const scenario = url.searchParams.get('scenario') || 'ok';
            const sid = url.searchParams.get('session_id') || '';
            const sess = sessions.get(sid);
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                requests.push(body);
                if (scenario === 'http-500') {
                    res.writeHead(500, { 'content-type': 'text/plain' });
                    res.end('internal error');
                    return;
                }
                if (scenario === 'empty-body') {
                    // 收下了，但永远不回 SSE 响应 → 客户端应报「空响应」/超时
                    res.writeHead(202, { 'content-type': 'application/json' });
                    res.end('');
                    return;
                }
                let msg = {};
                try { msg = JSON.parse(body); } catch { /* ignore */ }
                if (scenario === 'rpc-timeout') {
                    // 故意不回应，让客户端的 RPC 超时触发
                    res.writeHead(202);
                    res.end('Accepted');
                    return;
                }
                if (scenario === 'rpc-error') {
                    res.writeHead(202);
                    res.end('Accepted');
                    push(sid, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'mock: method not found' } });
                    return;
                }

                // 握手阶段失败：initialize 成功，但 tools/list 返回 RPC error。
                // 用于验证「握手失败时 openSession 会自动关闭已建立的 SSE」。
                if (scenario === 'handshake-fail' && msg.method === 'tools/list') {
                    res.writeHead(202);
                    res.end('Accepted');
                    push(sid, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'mock: tools/list exploded' } });
                    return;
                }
                const result = handleRpc(msg, scenario);
                if (result === undefined) {
                    // 通知：202 就够了
                    res.writeHead(202);
                    res.end('Accepted');
                    return;
                }
                // 真实 MCP-over-SSE 语义：POST 只回 202，响应走 SSE 流
                if (scenario === 'direct-post-reply') {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(result));
                    return;
                }
                res.writeHead(202);
                res.end('Accepted');
                push(sid, result);
            });
            return;
        }

        res.writeHead(404);
        res.end('not found');
    });

    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    const actualPort = server.address().port;
    // 长连接 SSE 会让 server.close() 永远等不到：所有连接都要跟踪并在 close 时销毁，
    // 否则测试进程自身无法退出（离线测试必须能干净结束）。
    const sockets = new Set();
    server.on('connection', (sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
    });

    return {
        port: actualPort,
        requests,
        sessionCount: () => sessions.size,
        /** 当前仍然打开的 SSE 响应流数量 —— 用于检测客户端是否泄漏连接 */
        openStreams: () => openStreams,
        async close() {
            for (const [, s] of sessions) { try { s.res.destroy(); } catch { /* ignore */ } }
            for (const sock of sockets) { try { sock.destroy(); } catch { /* ignore */ } }
            sessions.clear();
            sockets.clear();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

function respond(res, obj) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function handleRpc(msg, scenario) {
    switch (msg.method) {
        case 'initialize':
            return {
                jsonrpc: '2.0', id: msg.id,
                result: {
                    protocolVersion: '2025-11-25',
                    serverInfo: scenario === 'not-affinity' ? { name: 'OtherServer', version: '0.0.1' } : { name: 'Affinity', version: '1.0.0' },
                    capabilities: {},
                },
            };
        case 'notifications/initialized':
            return undefined;                        // 通知
        case 'tools/list':
            return {
                jsonrpc: '2.0', id: msg.id,
                result: {
                    tools: [
                        { name: 'execute_script', description: 'Run a script', inputSchema: { properties: { script: { type: 'string' } } } },
                        { name: 'save_script_to_library', description: 'Save', inputSchema: { properties: { title: {}, description: {}, code: {} } } },
                        { name: 'read_sdk_documentation_topic', description: 'Read docs', inputSchema: { properties: { filename: {} } } },
                        { name: 'list_library_scripts', description: 'List', inputSchema: { properties: {} } },
                    ],
                },
            };
        case 'tools/call':
            if (msg.params?.name === 'execute_script') {
                return {
                    jsonrpc: '2.0', id: msg.id,
                    result: { content: [{ type: 'text', text: 'mock: script ran, console said hello' }] },
                };
            }
            if (msg.params?.name === 'read_sdk_documentation_topic') {
                return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'preamble loaded' }] } };
            }
            if (msg.params?.name === 'fail') {
                // 模拟工具级失败：close() 之后不应有残留连接
                return { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'mock tool failure' }] } };
            }
            return {
                jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'mock ok: ' + msg.params?.name }] },
            };
        default:
            return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method ' + msg.method } };
    }
}