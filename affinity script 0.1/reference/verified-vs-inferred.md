# 已验证 vs 推断 —— 交付前必读

> 本文件的目的：让Agent 和用户都能分清「哪些是**真的验证过**的」，
> 避免把推断当事实写进交付物，或据此做出错误的权限/兼容性判断。

标注约定：
- ✅ **【实测】** —— 在本机（Affinity 3.3.0.4850 / Win32）实际验证过，有可复现步骤。
- 🟡 **【推断】** —— 由实测证据推出，逻辑合理但**未直接验证**。
- ❌ **【已证伪】** —— 曾经 believed，现已证明不成立。

---

## 一、✅ 已实测（可放心依赖）

### 权限机制

| 结论 | 验证方式 |
|---|---|
| 脚本库每个脚本带一条 `mreP` 权限记录，**u64 LE 位掩码** | 解析真实 `scripts.propcol`，多脚本一致 |
| `mreP` 前导字节 `0x04`、后随字节 `0x29` | 三个真实样本逐字节对账 |
| **bit0 = 文件系统** | 默认值 3 的组合 + 行为观察 |
| **bit1 = 网络** | 同上 |
| 编辑器「另存为」产出的脚本权限 = 设置默认值（实测 3） | 另存为后解析 propcol |
| **`.afscript` 导出时权限位清零为 0** | 导出后解析容器内层载荷 |
| 导入 `.afscript` **不继承**默认权限 | 导入后解析 propcol，仍为 0 |
| MCP `save_script_to_library` 入库 → 权限 = 设置默认值（实测 3） | 入库后解析 propcol |
| `Script::GetPermissions()/SetPermissions(u64)` 存在 | libpersona.dll 符号 |
| `Scripting::Permissions::GetBits()→u64` 存在 | libmcp.dll 符号 |

### 运行时

| 结论 |
|---|
| V8 11.5.150.4；JavaScript（CommonJS） |
| `require`/`module`/`exports` 可用，但**不在 `globalThis` 上** |
| `process` 是 **undefined** |
| 全局仅标准内置 + `alert/alertAsync/confirm/confirmAsync/prompt/promptAsync/quit/console` |
| `Document`/`Selection`/`Application`/`fs`/`Environment` **都不是全局**，必须 require |
| 引擎 ID `com.canva.affinity.scriptengine.playground` |
| 20 个 `affinity:*` 原生命名空间 |
| 官方脚本库 **24/24** 都是「顶层 main + 自调用」 |
| 官方 preamble 明确要求**不要**用 `module.exports.main` |

### 权限/文件系统行为

| 结论 |
|---|
| `Environment.fileSystemRoots` + `Environment.permissions` 是判定依据 |
| 白名单**按目录**生效，兄弟目录不覆盖（`…\SVG2` 不被 `…\SVG` 覆盖） |
| 越界抛 `Error: PERMISSION_DENIED`（非静默失败） |
| **3.3 没有「另存为」对话框 API**；`Application.chooseFile()` 实为「打开文件」对话框 |
| **对话框不能授权访问**（社区脚本作者自述印证） |
| `File.create(path, mode)` 的 `wb/w/wb+/w+/a/ab/r+` 全部可用；`writeStringAsUtf8` 正常返回字节数 |
| **`File.create` 即使 open 失败也返回对象 → 必须检查 `file.isOpen`** |
| 「权限预检闸门」（先 exists 再写、失败即中止）会产生**假阴性** |
| ASCII 文件名比中文/空格文件名更稳（中文名**曾出现** PERMISSION_DENIED） |
| 设置运行时只存内存、**退出才写盘** |

### MCP 通道

| 结论 |
|---|
| 传输是 SSE：`GET /sse` → endpoint → 向该路径 POST JSON-RPC |
| **端口动态**（实测见过 6767 / 41596 / 39840），重启即变 |
| 协议版本必须 **2025-11-25**（2024-11-05 → `Unsupported protocol version`） |
| `serverInfo = {"name":"Affinity","version":"1.0.0"}` |
| SSE 行尾是 `\r\n`，必须按 `/\r?\n\r?\n/` 切事件块 |
| **POST 只回 202，JSON-RPC 响应通过 SSE 流回传** |
| 必须先读 `preamble`，否则 `execute_script` 返回 `The preamble documentation topic has not yet been read.` |
| `execute_script` 的 schema **只有 `script`**；输出只认 `console.log()` |
| 工具集 11 个（见 SKILL.md §5） |

### 容器格式

`.afscript` 的完整字段布局见 `afscript-format.md`，已用**三个官方样本**逐字节对账，
并由 `make-afscript.mjs` 的 **21 项自校验**（含解压回读逐字节比对 + 双 CRC32 回读比对）保证。

### 环境

| 结论 |
|---|
| Affinity **3.3.0.4850** / Win32 是当前验证环境 |
| Node **22.22.2** 与 **24.15.0** 均可用（含 zstd）；zstd API 自 **22.15.0 / 23.8.0** 提供 |
| 官方文档站从 Agent 环境**不可达**（`affinity.studio` 连接失败，论坛 CloudFront 403） |
| `Resources\JSLib` 是明文 SDK 源码，版本与本机严格一致 |
| 官方 `tests/filetests.js` 引用的 `/file.js` 在当前版本**已不存在**（测试过时） |

---

## 二、🟡 推断（不要当作事实）

| 结论 | 推断依据 | 风险 |
|---|---|---|
| **bit2 = GenAI / Canva AI** | 默认值组合里第3 个开关 `DefaultAllowGenAI` | **未单独验证**。不要据此做精细授权；`fix-script-perms` 输出里也标注为「推断」 |
| 「编辑器另存为 = 库产出 → 继承默认」 | 与 MCP 入库行为一致，且设置原文说「在脚本编辑器中创建的新脚本将默认继承这些权限」 | 官方措辞是「**创建**时」继承；「另存为」是否等同「创建」属推断 |
| 预设名本地化需多语言正则 | 中文界面实测为 `SVG (用于导出)`，英文为 `SVG (for export)` | 其他语言未穷举，靠运行时枚举 + 模糊兜底 |
| 单位换算 `72dpi 时 1px = 1pt` | 文档 DPI 定义 + 实测 300dpi 数值吻合 | 已在模板中处理，一般不会踩 |

---

## 三、❌ 已证伪 / 曾经的错误结论

| 曾经的结论 | 实际情况 |
|---|---|
| 「`.afscript` 导入后能继承编辑器默认权限」 | **错**。导出清零、导入不继承，必须跑修复工具 |
| 「Node 22 没有 zstd，打包器必须 Node 24+」 | **错**。zstd 自 **22.15.0/23.8.0** 就有；实测 22.22.2 可用。文档已更正 |
| 「MCP POST 的响应体就是 JSON-RPC 结果」 | **错**。POST 只回 202，结果走 SSE 流。这是 v0.4 修掉的真实 bug |
| 「可以照抄官方 `tests/filetests.js` 的写入范例」 | **错**。它 require 的 `/file.js` 已不存在 |
| 「用 `Application.chooseFile()` 让用户选保存位置」 | **语义是「打开」**，且对话框不能授权 |
| 「先 `fs.exists` 检查能避免权限报错」 | **错**。造成假阴性，把能成功的写入挡掉 |

---

## 四、🔬 必须真机验证才能确认的项

以下**离线无法验证**，需要真实 Affinity / MCP 环境。改动相关代码后请在真机上复验。

### MCP 通道

- [ ] 协议版本 `2025-11-25` 在目标 Affinity 版本上仍被接受（升级后可能变）
- [ ] `execute_script` 真实执行脚本，`console.log` 确实回传
- [ ] `alert()` 等 GUI 调用确实不会出现在返回内容里
- [ ] `save_script_to_library` 入库后权限位 = 设置默认值
- [ ] `render_spread` 返回的 base64 能否解成有效 JPEG；`--out` 写出正常
- [ ] `--discover` 在**真实**端口上能发现（离线只测了假服务）
- [ ] 端口扫描在真实机器上不会触发安全软件告警
- [ ] 长会话（多次 tools/call）不会中途断流

### 权限修复器

- [ ] 在**真实** `scripts.propcol` 上跑（会改动用户库，务必先备份）
- [ ] 写入后 Affinity 能正常打开脚本库、脚本能运行
- [ ] 权限位改大后，受限目录访问确实生效
- [ ] Affinity 运行中执行确实会被拦截（`--force` 除外）
- [ ] `readDefaults()` 读到的掩码与设置界面显示一致

### 打包器

- [ ] 生成的 `.afscript` 能被**真实** Affinity 导入并运行
- [ ] 导入后修权限，脚本可读写文件
- [ ] 超大脚本（>1 MB 代码）导入仍正常
- [ ] 标题/描述含 emoji 与特殊字符时导入正常

### 校验器 / SDK 检索

- [ ] `validate` 对真实 JSLib 的误报率可接受
- [ ] `sdk-lookup --members` 对复杂继承链的类成员提取完整
- [ ] 9 项陷阱检查在真实脚本上不产生噪音

### 启动器

- [ ] Windows 执行策略为 `Restricted` 时 `.cmd` 能否调用（默认需 `-ExecutionPolicy Bypass`）
- [ ] 路径含中文/空格时各工具均可正常调用
- [ ] 从任意工作目录调用均定位到正确的 skill

---

## 五、升级 Affinity 后的复查清单

版本一变，以下内容**必须重新验证**，不要沿用旧结论：

1. **MCP 协议版本**（`2025-11-25`）—— 最高频变化点
2. **端口是否仍动态**、SSE 事件分隔符是否仍为 `\r\n`
3. **工具集是否仍是 11 个**、各工具 schema 是否变化
4. `Resources\JSLib` 的文件数量与模块名
5. `preamble` 的强制要求是否仍在
6. **容器格式**（若官方改版，`.afscript` 打包需重新逆向）
7. 权限位语义（尤其 bit2）

快速复查：

```powershell
<skill>\run-tool.ps1 mcp-client --discover
<skill>\run-tool.ps1 mcp-client --port <P> --tools
(Get-Item 'C:\Program Files\Affinity\Affinity\Affinity.exe').VersionInfo.FileVersion
```