---
name: affinity-script
description: 为 Affinity（Canva）3.3+ 编写、调试 JavaScript 脚本；也用于把 Illustrator (.jsx) 脚本迁移到 Affinity。交付物始终是 .js 源码，可通过 MCP 通道直接调试并入库、或粘贴进脚本编辑器运行后另存为入库。Write, debug, and validate Affinity 3.3+ scripts, and port Adobe Illustrator ExtendScript/JSX scripts to Affinity. Use when a task mentions Affinity 脚本/scripting, Scripting Studio, script editor, affinity:* modules, JSLib, MCP, or converting Illustrator scripts to Affinity.
---

# Affinity 3.3+ 脚本编写

**v0.4** ｜ 适用 Affinity 3.3+ ｜ 已验证：3.3.0.4850 / Win32
> 标注约定：**【实测】**=在本机验证过；**【推断】**=由现有证据推出，未直接验证。
> 详见 `reference/verified-vs-inferred.md`。

## 0. 交付方式（先读这条）

**默认交付 `.js` 源码。** 优先级 A > B > C：

| 路径 | 做法 | 权限 | 适用|
|---|---|---|---|
| **A（首选）** | MCP `execute_script` 跑→ `save_script_to_library` 入库 | ✅ 设置默认值（实测 3） | 自己的机器调试与入库 |
| **B（兜底）** | 粘贴进脚本编辑器 → 运行 → 另存为 | ✅ 继承默认 | MCP 不可用 |
| **C（分发）** | 打包 `.afscript` → 导入 → 修权限 | ❌ 导入为 0，需修 | 把脚本交给别人 |

```powershell
# 统一用稳定启动器（自动定位 skill 与 Node，不用手写带空格的路径）
<skill>\run-tool.ps1 mcp-client --discover
<skill>\run-tool.ps1 mcp-client --exec-file .\我的脚本.js
<skill>\run-tool.ps1 mcp-client --save .\我的脚本.js --title "标题" --desc "描述"
```

**路径 C 的完整流程**（唯一需要额外步骤的路径）：

```powershell
<skill>\run-tool.ps1 validate        .\我的脚本.js      # ① 静态校验
<skill>\run-tool.ps1 make-afscript   .\我的脚本.js --title "标题"   # ② 打包
# ③ 用户导入 .afscript → 完全退出 Affinity
<skill>\run-tool.ps1 fix-script-perms                # ④ 权限修复（默认 dry-run）
<skill>\run-tool.ps1 fix-script-perms --apply        #    确认后真正写入
# ⑤ 重启 Affinity
```

---

## 1. 权威资料在本机，不在网上

**不要上网查 Affinity 脚本 API。**

1. **官方文档站从 Agent 环境不可达**【实测】——`affinity.studio` 连接失败，论坛返回 CloudFront 403。
2. **网上资料大多基于 3.2**，而 3.3 改了规范。
3. **整套SDK 以明文 JS 随程序安装**，版本与本机严格一致。

```
C:\Program Files\Affinity\Affinity\Resources\JSLib\   ← 权威 API 源码
├── document.js nodes.js commands.js dialog.js fs.js …
├── examples\   ← 官方示例，最正确的范本
└── tests\      ← 自测脚本（部分已过时，见 §4）
```

```powershell
<skill>\run-tool.ps1 sdk-lookup convertToCurves            # 找符号
<skill>\run-tool.ps1 sdk-lookup --members document.js Document # 列类成员
```

---

## 2. 运行时事实【实测】

| 项 | 值 |
|---|---|
| 语言 | JavaScript，V8 11.5 |
| 模块 | CommonJS；`require` 可用但**不在 globalThis 上** |
| `process` | **undefined** |
| 全局 | 仅标准内置 + `alert/confirm/prompt/quit/console` |

**关键推论**：`Document`/`Selection`/`Application`/`fs` **都不是全局**，必须 `require`。

```js
require('affinity:document')   // 原生命名空间（20 个，C++ 层）
require('/document.js')        // SDK 封装层，/ 开头 → JSLib 根
```

### 入口只有一种

```js
'use strict';
function main() { /* … */ }
main();
```

> 官方 MCP preamble 原话【实测】：
> 「Any script you write must be directly executable. **Don't use `module.exports.main = main;`**」

### 报错栈的 `main:行:列`

Affinity 把脚本包进名为 `main` 的函数执行，报错形如 `at main:21:25`。

| 报错 | 判读 |
|---|---|
| `Unexpected end of input at main:L:C`，**列号超过该行末尾** | 代码被**截断** |
| `require is not defined at main:L:C` **且同时**有上面那条 | 同上（模块包装未生效） |

**两个错误同时出现 → 根因是截断**，拿报错行列回源码数一遍即可确认。

---

## 3. 官方标准范式（交互式脚本）

```js
const { CompoundCommandBuilder } = require('/commands.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { Document } = require('/document.js');
const { UnitType } = require('/units.js');

function isOk(r) { return (r?.value ?? r) == DialogResult.Ok.value; }

function compound(cmds) {
    if (cmds.length == 0) return null;          // 空数组必须返回 null
    const b = CompoundCommandBuilder.create();
    for (const c of cmds) b.addCommand(c);
    return b.createCommand();
}

function previewLoop(doc, dlg, build) {
    const update = (preview) => {
        const cmd = build();
        if (cmd) doc.executeCommand(cmd, preview);  // true = 只预览
        else doc.clearPreviews();
        return cmd;
    };
    dlg.onControlValueChangedHandler = () => update(true);
    update(true);
    if (isOk(dlg.runModal())) update(false);
    doc.clearPreviews();                // 无论如何清理
}

function main() {
    const doc = Document.current;
    if (!doc) { alert('需要打开文档'); return; }
    previewLoop(doc, buildDialog(doc), buildCommand);
}
main();
```

**六个硬习惯**：① `preview=true` 只预览 ② 收尾 `clearPreviews()`
③ **先克隆快照再改**（预览会反复重算） ④ 空命令返回 `null`
⑤ `isOk()` 用 `result?.value ?? result` 防御 ⑥ 默认值按 `doc.dpi / 72` 换算。

完整范本：`assets/template-interactive.js`。

---

## 4. 权限与文件系统（最容易踩的坑）

**机制**：`Environment.fileSystemRoots`（允许目录）+ `Environment.permissions`。
白名单**按目录生效**，兄弟目录互不覆盖；越界抛 **`Error: PERMISSION_DENIED`**。
放行位置：编辑 ▸ 设置 ▸ 脚本 ▸ 访问文件系统。**设置运行时只存内存、退出才写盘。**

### 权限位机制

脚本库中每个脚本带一条 **`mreP`（= "Perm"）权限记录：u64 LE 位掩码**。

| 位 | 含义 | 状态 |
|---|---|---|
| bit0 | 文件系统 | 【实测】 |
| bit1 | 网络 | 【实测】 |
| bit2 | GenAI | **【推断】** 由默认值组合推出，未单独验证 |

| 脚本来源 | 权限位 |
|---|---|
| 编辑器粘贴运行 / 另存为 | 继承设置默认【实测】 |
| MCP `save_script_to_library` | = 设置默认（实测 3）【实测】 |
| **导入 `.afscript`** | **= 0**【实测】（导出时清零，导入不继承） |

修复工具（**默认 dry-run，必须 `--apply` 才写**）：

```powershell
<skill>\run-tool.ps1 fix-script-perms--list          # 只看
<skill>\run-tool.ps1 fix-script-perms                 # 打印计划
<skill>\run-tool.ps1 fix-script-perms --apply         # 真写入（自动备份+原子替换+写后校验）
<skill>\run-tool.ps1 fix-script-perms --apply --grant fs   # 只授文件系统（最小权限）
```

### 四条硬规则

1. **默认输出目录取自 `Environment.fileSystemRoots`**，不要默认用文档目录（常不在白名单）。
2. **不要加"权限预检"闸门。** 先 `fs.exists` 再写、失败就中止 —— 实测产生**假阴性**。
   **直接尝试真正要做的操作，失败后再诊断。**
3. **文件 API 是好的。** `File.create(path, mode)` 的各种模式都可用，
   但**即使 open 失败也会返回对象，必须检查 `file.isOpen`**。
4. **文件名用ASCII 更稳。** 带中文空格的文档名**曾出现** `PERMISSION_DENIED`；
   稳妥做法是默认时间戳式 ASCII 名，写入失败自动换名重试。

```js
try {
    const f = File.create(path, 'wb');
    if (!f || !f.isOpen) throw new Error('打开失败');
    f.writeStringAsUtf8(text);
    f.close();
} catch (e) {
    if (/PERMISSION_DENIED/i.test(String(e))) {
        const roots = Environment.fileSystemRoots || [];
        if (!roots.length) console.error('本脚本没有文件系统授权（多半是导入的脚本）');
        else { console.error('目标目录不在放行列表：'); roots.forEach(r => console.error('  · ' + r)); }
    }
}
```

**其他事实**【实测】：3.3 **没有「另存为」对话框 API**（`Application.chooseFile()` 实为「打开」对话框）；
对话框**不能授权访问**；官方 `tests/filetests.js` 引用的 `/file.js` 在当前版本**已不存在**，不要照抄。

---

## 5. MCP 通道【实测】

Affinity 内置 MCP 服务，能直接执行脚本、拿回 `console.log`、并入库。

**前置**：`%APPDATA%\Affinity\Affinity\3.0\Settings\MCPPreferences.xml` 里
`EnableMCPServer=True`（读/写脚本库还需 `EnableReadScripts`/`EnableWriteScripts`）。
建议用 **Canva 国际版**（国内版无 MCP）。

| 项 | 值 |
|---|---|
| 端口 | **动态**，重启即变。**不要硬编码**，用 `--discover` |
| 传输 | **SSE**：`GET /sse` 拿 endpoint，再向该路径 **POST** JSON-RPC |
| 协议版本 | **必须是 `2025-11-25`**（传 2024-11-05 会Unsupported protocol version） |
| serverInfo | `{"name":"Affinity","version":"1.0.0"}` |
| 事件分隔 | 行尾是 **`\r\n`**，必须按 `/\r?\n\r?\n/` 切块 |
| 响应来源 | POST 只回 `202`，**真正的响应走 SSE 流** |
| 前置要求 | **必须先读 `preamble`**，否则 `execute_script` 一律被拒 |

```powershell
<skill>\run-tool.ps1 mcp-client --discover                        # 找端口
<skill>\run-tool.ps1 mcp-client --port<P> --tools                 # 列工具
<skill>\run-tool.ps1 mcp-client --port <P> --exec-file .\脚本.js   # 跑脚本
<skill>\run-tool.ps1 mcp-client --port <P> --save .\脚本.js --title "标题"   # 入库
```

> `execute_script` 的 schema **只有 `script`**，没有 `asModule`（那是容器内层字段）。
> 输出只认 `console.log()`——`alert()` 不会回传。

**工具集（11 个，实测枚举）**：`execute_script`、`save_script_to_library`、
`list_library_scripts`、`read_library_script`、`read_sdk_documentation_topic`、
`list_sdk_documentation`、`render_spread`、`render_selection`、`search_sdk_hints`、
`add_sdk_hint`、`report_sdk_issue`。

细节与踩坑见 `reference/mcp-channel.md`。

---

## 6. 交付规范

- 顶层 `main()` + 自调用（官方明确要求）
- 配置常量集中在顶部，不散落
- **不要静默失败**：前置不满足用 `console.error` 说明**缺什么、去哪改**
- 无人值守时避免对话框，保留 `SHOW_ERROR_ALERT` 开关
- 改文档**必须走 Command**，保证用户能 Ctrl+Z
- **交付前必跑 `validate`**；有条件再走 MCP 真机跑一遍

---

## 7. 排错速查

| 症状 | 原因 | 处理 |
|---|---|---|
| `Unexpected end of input`，列号超行尾 | **代码被截断** | 走 MCP 通道，或重新完整粘贴 |
| `require is not defined` + 上一条同时出现 | 截断导致模块包装失效 | 同上 |
| `require is not defined` 单独出现 | 运行入口不对 | 用 MCP，或「脚本编辑器 → 新建脚本」 |
| `PERMISSION_DENIED` 且放行目录=0 | **导入脚本权限=0** | 改用 MCP 入库；或修权限 |
| `PERMISSION_DENIED` 但目录非空 | 目标不在白名单 | 加目录或选列表内的目录 |
| `Cannot find module '/x.js'` | 模块名写错 | 对照 JSLib；SDK 层必须以 `/` 开头 |
| `Unsupported protocol version` | 协议版本错 | 必须 `2025-11-25` |
| `preamble ... not yet been read` | 未读前置文档 | 先调 `read_sdk_documentation_topic('preamble')` |
| 导出预设匹配不到 | **预设名本地化** | 运行时枚举 + 多语言正则 |
| 脚本报错位置对不上源码 | 粘贴截断 | 数总行数核对 |

---

## 8. 二进制考古（SDK 查不到时）

```powershell
<skill>\run-tool.ps1 scan-strings 'C:\Program Files\Affinity\Affinity\libmcp.dll' 'execute_script'
```

| 目标 | 文件 |
|---|---|
| MCP 工具名 | `libmcp.dll` |
| 引擎 ID、模块系统 | `libscriptingjs.dll` |
| 导出预设名、格式 ID | `libpersona.dll` |
| 界面文案 | `*.lproj\*.strings`（**加 `--utf16`**） |

**Affinity 容器里的 4CC 全部是反读**：`mreP`→Perm、`gfnC`→Cnfg、`ltit`→titl、
`cseD`→Desc、`ngnE`→Engn、`prcS`→Scrp、`spcS`→Scps。

---

## 9. 能力边界（实测）

| 有 | 没有 →绕行 |
|---|---|
| 命令系统 + 实时预览 | 对齐/分布命令 → 读 `getSpreadBaseBox()` 算位移 |
| 布尔运算、转曲、宏录制回放 | 重命名属性 → `setLayerDescription` |
| 60+ 滤镜节点 | 色板/全局色 → 脚本内自维护 |
| 导出（整文档/跨页/页/画板/选区） | **保存对话框** → 不存在，用 `Application.prompt` |
| 对话框、文本、像素、文件读写 | `app.executeMenuCommand` → 无等价物，必须重写 |
| | **符号（Symbols）** → 未暴露 |

**节点体系**：`node.children`=直接子级，`node.children.all`=递归全部；
集合用 `.toArray()`；**所有文字类型都继承 `TextNode`**→判文字只需 `node.isTextNode`。

**出血【实测不可读】**：`ArtboardInterface` 无 bleed getter，`Document` 无
`documentProperties` getter。底层二进制有 `GetBleedForSpread` 但**未导出到脚本层**。
**交付时标注「未提供」，绝不用 0 或推测值冒充。**

按任务查API → `reference/api-cheatsheet.md`；Illustrator 迁移 → `reference/illustrator-migration.md`。

---

## 资源索引

> `<skill>` = 本skill 根目录。**推荐用 `run-tool.ps1` / `run-tool.cmd`**，避免手写带空格的路径。

| 文件 | 用途 |
|---|---|
| `run-tool.ps1` / `.cmd` | **稳定启动入口**（显式工具映射，自动找 Node，支持空格/中文路径） |
| `reference/api-cheatsheet.md` | 按任务查 API + 能力边界 |
| `reference/illustrator-migration.md` | Illustrator 迁移对照 + 可行性矩阵 |
| `reference/afscript-format.md` | **.afscript 容器格式逆向**（字段表、权限机制） |
| `reference/mcp-channel.md` | **MCP 通道细节**：协议、工具、踩坑、故障排查 |
| `reference/verified-vs-inferred.md` | **哪些是实测、哪些是推断**（交付前必读） |
| `scripts/mcp-client.mjs` | MCP 客户端：发现端口、执行、入库、渲染 |
| `scripts/validate.mjs` | 静态校验：语法 + SDK 符号 + **9 项陷阱** |
| `scripts/fix-script-perms.mjs` | 权限修复器（**默认 dry-run**，`--apply` 才写） |
| `scripts/make-afscript.mjs` | .afscript 打包器（**21 项自校验**） |
| `scripts/sdk-lookup.mjs` | 检索 JSLib：符号 / 类成员 / 正则 / 索引 |
| `scripts/scan-strings.mjs` | 流式扫二进制提取字符串（支持 UTF-16LE） |
| `scripts/probe.js` | **放进 Affinity 运行**的环境探针 |
| `tests/run-tests.mjs` | **离线测试套件**（103 项，不需要 Affinity） |
| `assets/template-*.js` | 可直接改的范本（交互式 / 文件输出） |

### 测试怎么跑

```powershell
# 离线：不需要 Affinity / MCP / 用户 AppData
<skill>\run-tool.ps1 tests                 # 全部 103 项
<skill>\run-tool.ps1 tests --list
<skill>\run-tool.ps1 tests --filter mcp    # 只跑 MCP 相关
```

**必须真机验证**的项见 `reference/verified-vs-inferred.md` 末节清单。

### 环境要求

| 项 | 要求 |
|---|---|
| Affinity | 3.3+【实测 3.3.0.4850Win32；macOS 未验证】 |
| Node.js | 其余工具 **18+**；`make-afscript` 需 **≥ 22.15.0**（zstd API 自 22.15.0 / 23.8.0 提供；**推荐 Node 24+**） |
| MCP（可选） | `EnableMCPServer=True`；建议 Canva 国际版 |

SDK 在别处时：`$env:AFFINITY_JSLIB = "D:\...\JSLib"`