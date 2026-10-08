# MCP 通道细节（Affinity 内置 MCP 服务）

> SKILL.md §5 是速查版；本文件是完整协议、工具清单、踩坑与故障排查。
> 所有结论标注【实测】/【推断】。当前验证环境：Affinity 3.3.0.4850 / Win32。

---

## 1. 前置条件

`%APPDATA%\Affinity\Affinity\3.0\Settings\MCPPreferences.xml`：

```xml
<EnableMCPServer>True</EnableMCPServer>
<EnableReadScripts>True</EnableReadScripts>    <!-- 读脚本库 -->
<EnableWriteScripts>True</EnableWriteScripts>  <!-- 写入脚本库 -->
```

- **建议用 Canva 国际版**——国内版没有 MCP。
- 设置**运行时只存内存、退出才写盘**，改完可能要重启才生效。

---

## 2. 传输层：MCP over SSE（最容易理解错的地方）

```
客户端                              Affinity MCP
  │                                        │
  │───── GET /sse ────────────────────────▶│  建立长连接
  │◀──── event: endpoint ───────────────────│  data: /message?session_id=XXX
  │                                        │
  │───── POST /message?session_id=XXX ────▶│  JSON-RPC 请求
  │◀──── 202 Accepted ─────────────────────│  ★ 只表示"已收下"
  │                                        │
  │◀──── event: message ───────────────────│  ★ 真正的 JSON-RPC 响应
  │      data: {"jsonrpc":"2.0","id":1,…} │
```

### ★ 三个必须记住的点

1. **POST 只回 202，响应走 SSE 流。**
   把 POST 的响应体当结果解析 → 永远拿不到结果（v0.4 修掉的真实 bug）。
2. **SSE 行尾是 `\r\n`**，必须按 `/\r?\n\r?\n/` 切事件块；按 `\n\n` 切一个都拿不到。
3. **endpoint 可能是相对路径也可能是绝对 URL**，两种都要支持。

---

## 3. 协议

| 项 | 值 |
|---|---|
| 协议版本 | **`2025-11-25`**（传 `2024-11-05` → `Unsupported protocol version`） |
| serverInfo | `{"name":"Affinity","version":"1.0.0"}` |
| 事件分隔 | `/\r?\n\r?\n/` |
| 传输 | `text/event-stream` |
| endpoint | `/message?session_id=…` |

握手顺序（`openSession` 的实现）：

```
GET /sse                → 等 endpoint 事件（最多 8s）
POST initialize         → { protocolVersion, capabilities, clientInfo }
POST notifications/initialized  （通知，无返回）
POST tools/list         → 拿工具清单
POST read_sdk_documentation_topic { filename: 'preamble' }  ★ 必须，否则 execute_script 被拒
```

---

## 4. 端口发现

**端口是动态的**【实测】：同一台机先后出现过 `6767`、`41596`、`39840`，重启即变。
**不要硬编码。**

```
mcp-client.mjs --discover
```

策略（两条路线）：

1. **按进程名锁定**（快且准）：`tasklist` 找`Affinity.exe` 的 PID →
   `netstat -ano` 列出这些 PID 的 LISTENING 端口 → 逐个探测。
2. **全量扫描**（兜底）：所有 LISTENING 端口，分批 + **受控并发**（默认 8，避免连接风暴）。

探测判定：连上 `/sse` → 读第一个事件块 → 同时含 `event: endpoint` 与 `session_id`
才认为是 Affinity，再用 `tools/list` 的 `serverInfo.name` 二次确认。

> 主机同时试 **`[::1]`（IPv6 loopback）** 与 `127.0.0.1`——Affinity 有时只监听 IPv6。

---

## 5. 工具集（11 个，实测枚举）

| 工具 | 参数 | 用途 / 注意 |
|---|---|---|
| `execute_script` | `script` | **只有这一个参数**。输出靠脚本里的 `console.log()` |
| `save_script_to_library` | `title` `description` `code` | 入库 → **权限位 = 设置默认值（实测 3）** |
| `list_library_scripts` | — | 列脚本库 |
| `read_library_script` | `title` | 读回库内源码 |
| `read_sdk_documentation_topic` | `filename` | **必须先读 `preamble`** |
| `list_sdk_documentation` | — | 列出全部 SDK 文档 / 示例 / tests |
| `render_spread` | `document_session_uuid` `spread_index` | 渲染成 base64 JPEG，**可视化确认效果** |
| `render_selection` | `document_session_uuid` | 渲染当前选中项 |
| `search_sdk_hints` | — | 搜索全球 MCP 会话积累的 SDK 提示 |
| `add_sdk_hint` | — | 把踩坑经验写回 preamble（供未来会话） |
| `report_sdk_issue` | — | 上报 SDK 问题 |

> `asModule` **不是** MCP 参数——它是 `.afscript` 容器内层 `gfnC` 记录的字段。

---

## 6. 输出约定

preamble 原话【实测】：

> 「The script execution will not return output so you need to use `console.log()`.」

-脚本里的 `console.log()` 内容作为工具返回值回传。
- `alert()` 等 GUI 调用**不会**回传。

**所以走 MCP 调试时，把诊断信息打成 `console.log`。**

---

## 7. 常用命令

```powershell
<skill>\run-tool.ps1 mcp-client --discover
<skill>\run-tool.ps1 mcp-client --port <P> --tools
<skill>\run-tool.ps1 mcp-client --port <P> --docs
<skill>\run-tool.ps1 mcp-client --port <P> --exec "console.log(1+1)"
<skill>\run-tool.ps1 mcp-client --port <P> --exec-file .\我的脚本.js
<skill>\run-tool.ps1 mcp-client --port <P> --lib
<skill>\run-tool.ps1 mcp-client --port <P> --read "脚本标题"
<skill>\run-tool.ps1 mcp-client --port <P> --save .\我的脚本.js --title "标题" --desc "描述"
<skill>\run-tool.ps1 mcp-client --port <P> --render-spread <uuid> 0 --out 预览.jpg
<skill>\run-tool.ps1 mcp-client --port <P> --task '{"name":"工具名","arguments":{}}'
```

省略 `--port` 时会**自动先 discovery**。

### 渲染预览（F9 修复）

`render_spread` 的输出**默认写到带时间戳的唯一文件名**
（`render-spread-<index>-<日期时间>-<pid>.jpg`），**不会静默覆盖**已有文件。
用 `--out` 指定路径时，若文件已存在会**直接报错退出**（退出码 1），需自行换名或删除。

---

## 8. 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `未发现 Affinity MCP 服务` | Affinity 没开 / MCP 没启用 | 查 `MCPPreferences.xml`；确认 Affinity 在运行 |
| `不是 Affinity MCP（含 IPv6/IPv4 均试过）` | 端口变了 | `--discover` 重扫 |
| `Unsupported protocol version` | 协议版本错 | 必须 `2025-11-25` |
| `preamble ... not yet been read` | 未读前置文档 | 先调 `read_sdk_documentation_topic('preamble')` |
| `等待 SSE endpoint 事件超时（8000ms）` | 连上了但服务端不发 endpoint | 端口不是 MCP；或服务异常 |
| `SSE 响应 Content-Type 不对` | 该端口不是 MCP 服务 | 换端口 |
| `RPC 超时（120000ms）` | POST 成功但无响应 | `--timeout` 调大；先用 `--tools` 验证通道 |
| `请求超时` / `ECONNREFUSED` | 底层连接挂起或端口已关 | `--discover` 重扫 |
| 工具返回 `isError: true` | 脚本自身抛错 | 看返回的 content 文本 |
| 脚本在 MCP 里跑但没输出 | 用了 `alert()` 而非 `console.log()` | 改成 `console.log` |

调试开关：

```powershell
$env:MCP_DEBUG = '1'<skill>\run-tool.ps1 mcp-client --discover    # 打印每个端口的探测结果
```

---

## 9. 实现要点（v0.4 修复清单）

给后续维护者，避免重犯：

| # | 要点 |
|---|---|
| F1 | 参数解析重写：缺值/非法/重复一律退出码 2（`--port` 无值原本会变 NaN） |
| F2 | **所有 fetch 都要有真正可取消的 AbortController 超时**——只给等待 Promise 设超时不够，底层 socket 可能永不返回 |
| F3 | 区分 HTTP 状态码错误 / RPC error / RPC 超时 / 空响应，**不把失败伪装成「空工具列表」** |
| F4 | endpoint 要同时支持相对路径与绝对 URL |
| F5 | reader / pending / controller 全部在 `finally` 清理；**删除 `setTimeout(()=>process.exit())` 强退** |
| F6 | discovery 探测用**局部 timeout**，不要改全局配置（并发会互相覆盖） |
| F7 | `probe()` 里**单一 reader顺序读**，靠整体 abort 兜底；不要把 `read()` 塞进 `Promise.race`（超时后read 仍挂着，会对同一 reader 并发 read） |
| F8 | 端口扫描**受控并发 + host:port 去重**，避免连接风暴 |
| F9 | `render-spread` 输出用唯一文件名，不静默覆盖 |
| F10 | 用 `execFile` 而非 shell 字符串；保留 IPv4/IPv6 loopback |

### ★★ close() 的顺序陷阱（实测踩过）

```js
// 错：detach 会移除与 sessionCtrl 的 abort 联动 → abort 传不到流 →
//     pump 永远卡在 reader.read() → close() 死锁
detachSse();
sessionCtrl.abort();
await pump;

// 对：先 abort 再 detach
sessionCtrl.abort();
await pump;
detachSse();
```

### ★★ 不要「先 abort 再 reader.cancel()」

对同一个底层句柄先 `abort()` 再 `cancel()`，Node 退出时会打印：

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

v0.3 用 `setTimeout(() => process.exit(), 60)` 强退来掩盖这个噪音——
**根因是重复关闭，不是缺少强退**。v0.4 已删除强退，改为正确关闭。

### 离线测试

MCP 客户端的全部失败路径都有离线测试（假服务在 `tests/mock-mcp.mjs`）：

```powershell
<skill>\run-tool.ps1 tests --filter mcp
```

覆盖：正常握手、SSE 回传响应、直接 POST 回响应、绝对 endpoint、endpoint 超时、
HTTP 500、RPC error、RPC 超时、Content-Type 错误、SSE 异常断开、
close 幂等、工具失败后仍清理、死端口快速失败。