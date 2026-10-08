# affinity-script —— 技能包说明

> `SKILL.md` 是给Agent 读的指令；本文件是给人看的说明，不影响技能加载。

## 这是什么

一套把「从零摸清 Affinity 3.3 脚本体系」的全过程固化下来的技能包。
装上之后，任何会话遇到 Affinity 脚本任务，AI 会自动加载其中的全部经验，不必重新踩坑。

## 三条交付路径

| 路径 | 做法 | 权限位 | 适用 |
|---|---|---|---|
| **A（推荐）** | MCP `execute_script` 跑 → `save_script_to_library` 入库 | ✅ 3（完整） | 自己的机器调试与入库 |
| **B（兜底）** | 粘贴进脚本编辑器 → 运行 → 另存为 | ✅ 继承默认 | MCP 不可用 |
| **C（分发）** | 打包 `.afscript` → 导入 → 修权限 | ❌ 0，需修 | 把脚本交给别人 |

**为什么优先 A**：能拿到 `console.log` 的真实输出（不必来回粘贴），
且入库脚本权限位直接是设置默认值，绕开了 `.afscript` 导入权限清零的问题。

> `.afscript` 路径**仍然保留**——但只用于把脚本**分发给别人**，且对方导入后必须修权限。

## 快速上手

推荐用**稳定启动器**（自动定位 skill 与 Node，不用手写带空格/中文的路径）：

```powershell
<skill>\run-tool.ps1 validate        .\我的脚本.js
<skill>\run-tool.ps1 make-afscript   .\我的脚本.js --title "标题" --desc "描述"
<skill>\run-tool.ps1 fix-script-perms --list
<skill>\run-tool.ps1 mcp-client      --discover
<skill>\run-tool.ps1 mcp-client      --exec-file .\我的脚本.js
<skill>\run-tool.ps1 sdk-lookup      convertToCurves
<skill>\run-tool.ps1 tests
```

cmd用户用同名的 `run-tool.cmd`；仓库根目录另有`run-affinity-tool.ps1` / `.cmd`
作为转发壳（行为一致，保留是为了「从仓库根目录也能一条命令跑」的习惯）。

需要指定 Node 时设`$env:AFFINITY_NODE`。启动器优先级：
该变量 → Codex bundled Node → PATH 里的 `node.exe`。

## 包内内容

| 文件 | 用途 |
|---|---|
| `SKILL.md` | **主指令**（356 行）：交付原则、运行时事实、范式、权限、MCP、边界 |
| `run-tool.ps1` / `.cmd` | **稳定启动入口**：显式工具映射，自动定位 skill 与 Node |
| `reference/verified-vs-inferred.md` | **实测 vs 推断**对照+ 升级复查清单 |
| `reference/mcp-channel.md` | MCP 协议细节、工具清单、故障排查、实现要点 |
| `reference/api-cheatsheet.md` | 按任务查 API + 能力边界表 |
| `reference/illustrator-migration.md` | Illustrator 脚本迁移对照 + 可行性矩阵 |
| `reference/afscript-format.md` | **.afscript 容器格式逆向**（字段表、权限机制） |
| `scripts/mcp-client.mjs` | MCP 客户端：发现端口、执行、入库、列/读脚本库、渲染 |
| `scripts/validate.mjs` | 静态校验：语法 + SDK 符号 + **9 项陷阱** |
| `scripts/fix-script-perms.mjs` | 权限修复器（**默认 dry-run**，`--apply` 才写） |
| `scripts/make-afscript.mjs` | .afscript 打包器（zstd + 双 CRC32，**21 项自校验**） |
| `scripts/sdk-lookup.mjs` | 检索 JSLib：符号 / 类成员 / 正则 / 索引 |
| `scripts/scan-strings.mjs` | 流式扫二进制提取字符串（支持 UTF-16LE） |
| `scripts/lib/cli.mjs` | 共用基础设施：退出码、严格参数解析、原子写入、正则转义 |
| `scripts/lib/lex.mjs` | 轻量词法清洗（注释/字符串/模板/正则），供校验器使用 |
| `scripts/probe.js` | **放进 Affinity 运行**的环境探针（MCP 不可用时的兜底） |
| `tests/run-tests.mjs` | **离线测试套件（103 项）**，不需要 Affinity / MCP / AppData |
| `assets/template-interactive.js` | 官方交互式范式模板（对话框 + 实时预览） |
| `assets/template-file-output.js` | 文件输出类模板：写文件的全部硬规则 |

## 测试

```powershell
<skill>\run-tool.ps1 tests                 # 全部离线测试（103 项）
<skill>\run-tool.ps1 tests --list          # 列出用例
<skill>\run-tool.ps1 tests --filter mcp    # 只跑 MCP 相关
```

**离线**（不需要 Affinity / MCP / 用户 AppData / 真实脚本库）：
CLI 参数边界、打包器、权限修复器（Buffer fixture）、
MCP 客户端（`tests/mock-mcp.mjs` 假服务覆盖全部失败路径）、
validate / sdk-lookup / scan-strings、`node --check`、退出码一致性。

**需要真机**的验证项清单见 `reference/verified-vs-inferred.md` 第四节。

## 核心结论（完整版见 SKILL.md）

1. **权威资料在本机**：`Resources\JSLib` 是明文 SDK 源码，版本与本机严格一致。
   官方文档站从 Agent 环境不可达，**不要上网查 API**。
2. **优先走 MCP 通道**：端口**动态**必须先发现；协议版本必须 `2025-11-25`；
   POST 只回 202、**响应走 SSE 流**；必须先读 `preamble`。
3. **权限根因已破译**：`mreP` = u64 位掩码（bit0=FS、bit1=网络【实测】，
   bit2=GenAI【推断】）。编辑器另存为 / MCP 入库继承默认；`.afscript` 导出清零、导入不继承。
4. 语言是 JS（V8 11.5）+ CommonJS，但 `require` **不在 `globalThis` 上**；
   `Document`/`Selection` 必须 `require`，`process` 是 `undefined`。
5. **入口只有一种**：顶层 `function main(){…}` + 末尾 `main();`（官方 preamble 明确要求）。
6. 报错栈里的 `main:行:列` 可精确定位——**列号超过行末就是代码被截断**。
7. 改文档必须走 Command；`executeCommand(cmd, true)` 是实时预览，配 `clearPreviews()`。
8. **不要加"权限预检"闸门**——会假阴性，把本来能成功的写入挡掉。
9. `File.create` 即使 open 失败也会返回对象，**必须检查 `file.isOpen`**。
10. 预设名等资源名**是本地化的**，一律运行时枚举 + 多语言正则。
11. 出血在脚本层**读不到**（未导出）——交付时标注「未提供」，不要编造。

## 环境要求

| 项 | 要求 |
|---|---|
| Affinity | **3.3+**（实测 3.3.0.4850 / Win32；**macOS 未验证**） |
| Node.js | 其余工具 **18+**；`make-afscript` 需 **≥ 22.15.0**（zstd API 自 22.15.0 / 23.8.0 提供；**推荐 Node 24+**） |
| MCP（可选但推荐） | `EnableMCPServer=True`；建议 **Canva 国际版**（国内版无 MCP） |
| Agent | 支持 `.agents/skills/` 目录约定 |

SDK 装在别处时：`$env:AFFINITY_JSLIB = "D:\...\JSLib"`

## 版本

**v0.4** —— 代码 review + bug 修复 + 性能优化：
新增 `run-tool` 稳定启动入口（显式工具映射，支持 probe）；
抽出 `scripts/lib/{cli,lex}.mjs` 统一退出码与词法清洗；
参数解析全面重写（缺值/非法/重复一律退出码 2）；
MCP 客户端修复 POST 响应来源、`close()` 死锁与超时可取消性；
权限修复器**默认改 dry-run**、加原子写入与写后回读校验；
打包器加`--force` 覆盖保护、长度守卫与 CRC 回读比对（21 项自校验）；
校验器统一为 **9 项陷阱**并消除注释/字符串误报；
新增 **103 项离线测试**（含 MCP 假服务、启动器静态校验）。

**v0.3** —— 打通 MCP 通道：`mcp-client.mjs` 自动发现动态端口、执行脚本、
`save_script_to_library` 入库且权限=3 无需修复。

**v0.2** —— 破译权限机制（`mreP` u64 位掩码），新增 `fix-script-perms.mjs`
与 `make-afscript.mjs`，`.afscript` 分发路径全链路可用。

**v0.1** —— 首个可用版本。基于一次完整的 Affinity 3.3 脚本开发会话沉淀。