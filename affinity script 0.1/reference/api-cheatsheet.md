# Affinity 3.3 API 速查（按任务）

> 所有条目都来自本机 `Resources\JSLib` 实测。**用之前先用 `scripts/sdk-lookup.mjs` 复核签名与所属类**，
> 因为同名方法可能出现在多个类里。

## 目录

- [1. 文档与选区](#1-文档与选区)
- [2. 遍历节点](#2-遍历节点)
- [3. 变换与位置](#3-变换与位置)
- [4. 文字](#4-文字)
- [5. 导出](#5-导出)
- [6. 对话框（参数面板 + 实时预览）](#6-对话框参数面板--实时预览)
- [7. 颜色与填充](#7-颜色与填充)
- [8. 文件与日志](#8-文件与日志)
- [9. 命令与撤销](#9-命令与撤销)
- [10. 宏 / 参考线 / 画板](#10-宏--参考线--画板)
- [11. 能力边界（没有的东西）](#11-能力边界没有的东西)
- [附：MCP 通道速查](#附mcp-通道速查)

---

## 1. 文档与选区

```js
const { Document } = require('/document.js');

Document.current            // 当前文档，无文档时为 null
Document.all                // 所有打开的文档（批处理用）
Document.load(path)         // 同步打开
Document.loadAsync(path, cb)
Document.createFromPreset(preset, isLandscape)
Document.create(options) / createFromOptions(options)

doc.selection               // 当前选区（Selection 对象）
doc.selection.length        // 选中数量
doc.selection.nodes.toArray()
doc.selection = nodes       // 设置选区（传 null 清空）
doc.selectAll()             // 全选
doc.path                    // 文件路径
doc.dpi / doc.units
doc.layers / doc.spreads / doc.artboards / doc.rootNode
doc.hasArtboards            // 有画板时 doc.artboards 才有意义
doc.canUndo / doc.undoDescription
```

**Selection 成员**（`selections.js`）：
`length`、`at(i)`、`items`、`nodes`、`firstNode`、`hasKeyObject`、`add/addNode/addItem/addSelectable`、
`getFirstSubSelectionOfType(type)`、`removeNested()`、`containsItem(item)`、
`static create(document, items, removeNested)`、`static createEmpty(document)`

---

## 2. 遍历节点

Affinity 的节点是**树**，不是 Illustrator 那种扁平列表。

```js
node.children          // 直接子级（Collection）
node.children.all      // ★ 递归全部后代
node.enclosures        // enclosure 子级
node.isTextNode        // 是否文字（覆盖全部 7 种文字类型）
node.isGroupNode / isContainerNode / isImageNode / isShapeNode / isPolyCurveNode …
node.getSpreadBaseBox()   // 包围盒（含裁剪），有 .centre/.width/.height
node.opacity / node.blendMode / node.isVisible / node.isLocked
```

集合用 `.toArray()` 或 `for…of`。

**递归找文字的写法**（已实测）：

```js
function containsText(node) {
    if (node.isTextNode) return true;          // 一个条件覆盖 7 种文字类型
    for (const child of node.children.all)
        if (containsText(child)) return true;
    return false;
}
```

### ⚠️ 链接文本框会重复取到文字

**多个文本框可以共享同一个 story**（文字从一个框流到另一个框）。
直接遍历会把同一段文字**重复导出多次**。

```js
// 只取文本流的第一个框 —— 它的 .text 就是整段 story
const tf = node.textFrameInterface;
if (tf && tf.isMultiFrameTextFlow && tf.textFlowIndex !== 0)
    continue;   // 跳过后续框
```

相关成员：`isMultiFrameTextFlow`、`textFlowIndex`、`textFlowNodes`、`textBegin`。

> **原理**：`ArtTextNode / FrameTextNode / CurvePathTextNode / PolyCurveTextNode /
> ShapePathTextNode / TableTextNode / ShapeTextNode` **全部 `extends TextNode`**，
> 而 `TextNode` 上 `get isTextNode()` 返回 `true`。所以不需要枚举类型。

**层命名**走 Description 接口，没有 `name` 属性：

```js
node.description.userDescription        // 读
doc.setLayerDescription(desc, node)     // 写
node.description.tagColour              // 图层颜色标签
doc.setTagColour(colour, selection)
```

---

## 3. 变换与位置

**位置是增量，不是绝对值** —— 这与 Illustrator 的习惯相反。

```js
const { DocumentCommand } = require('/commands.js');
const { Selection } = require('/selections.js');
const { Transform } = require('/geometry.js');

const cmd = DocumentCommand.createTransform(
    Selection.create(doc, node),
    Transform.createTranslate(dx, dy));     // dx/dy 是位移量
doc.executeCommand(cmd);
```

要移动"到"某坐标：先读 `node.getSpreadBaseBox().centre`，再算差值。

其他几何操作：`doc.applyTransform(transform, selection)`、`doc.applyGroupTransform(...)`、
`createGroupTransform(selection, xData, yData)`、`GroupTransformAnchor/Order/Type`。

**布尔运算**（两种写法都行）：

```js
DocumentCommand.createBoolOpUnion(selection)     // 也有 Subtract / Intersect / Xor
doc.boolOpUnion(selection)                       // Document 上的便捷方法
```

**转曲**：

```js
doc.convertToCurves(selection);   // 或 createConvertToCurves(selection)
```

> 转曲后**原对象被替换**，必须**重新读取 `doc.selection`** 再做后续操作。

---

## 4. 文字

```js
const { TextSelection } = require('/selections.js');
const { StoryBuilder } = require('/storybuilder.js');

doc.setText(selection, text)              // 整段替换
doc.formatText(selection, delta)          // 套用格式增删
doc.insertGlyph(selection, glyph) / insertGlyphAt(...)

// 细粒度：story.js / glyphs.js / glyphatts.js / paragraphatts.js / fonts.js
const { Story } = require('/storyinterface.js');
story.ranges / getStoryRange(...)
```

字体：`fonts.js` 的 `Font`、`FontCollection`、`FontFamily`；`doc.getFontNames()` / `enumerateFontNames()`。

**没有内置查找替换** —— 需要遍历 story 范围自己实现；
底层可用 `story.js` 的 `rFindWordBegin / rFindWordEnd / rFindWordPart / rFindParagraphBreak`。

---

## 5. 导出

```js
const { FileExportOptions, FileExportArea } = require('/document.js');

// ① 预设名 —— ★ 随界面语言变化，必须运行时枚举
const names = FileExportOptions.allPresetNames;      // 实测 64 个
const options = FileExportOptions.createWithPresetName(presetName);
// 也有 FileExportOptions.createForCanvaExport(dpi)

// ② 导出范围
FileExportArea.createForWholeDocument()
FileExportArea.createForCurrentSpread() / createForCurrentPage()
FileExportArea.createForArtboard(artboardInterface)
FileExportArea.createForSpreads(pages) / createForPages(pages)
FileExportArea.createForSelection(selection)          // 只导出选中项
FileExportArea.createForSelectionArea(selection)      // 选区包围盒范围
FileExportArea.createForCanvaExport(dpi)

// ③ 执行
const records = doc.export(path, options, area, size);   // size 可为 null
doc.exportAsync(path, options, area, size, callback)

// ④ 读回结果（一定要看，才知道真实落盘路径）
records.count
records.all.forEach(r => {
    r.isSuccess; r.path; r.errorMessage; r.warningMessage;
});
```

**预设名本地化实测值：**

| 语言 | 值 |
|---|---|
| 中文 | `SVG (用于导出)`、`SVG (数字 - 高质量)`、`SVG (数字 - 小尺寸)`、`SVG (平面化)` |
| 英文 | `SVG (for export)`、`SVG (digital - high quality)`、… |

**多语言匹配写法：**

```js
const PRESET_PATTERNS = [
    /^SVG\s*[（(]\s*用于导出\s*[)）]/i,   // 中文
    /^SVG\s*\(\s*for export\s*\)/i,       // 英文
];
const available = FileExportOptions.allPresetNames || [];
let preset = null;
for (const p of PRESET_PATTERNS) { preset = available.find(n => p.test(n)); if (preset) break; }
if (!preset) preset = available.find(n => /^\s*svg\b/i.test(n));   // 兜底
```

> **路径扩展名不确定**：传入 `xxx.svg` 后 Affinity 是否再追加一次未验证。
> 因此**必须读 `record.path` 打印真实路径**，别假设。

---

## 6. 对话框（参数面板 + 实时预览）

```js
const { Dialog, DialogResult, DialogItemType } = require('/dialog.js');
const { UnitType } = require('/units.js');

const dlg = Dialog.create("标题");
const col = dlg.addColumn();
const grp = col.addGroup("分组");

dlg.radius = grp.addUnitValueEditor("半径", UnitType.Pixel, doc.units, 12, 0);
dlg.count  = grp.addUnitValueEditor("数量", UnitType.Number, UnitType.Number, 5, 1, 100).setPrecision(0);
// 控件类型：Switch / ComboBox / ButtonSet / RadioGroup / StaticText / TextBox /
//          UnitValueEditor / CheckBox / SpatialAnchor / ColourPicker /
//          FontPicker / FillEditor / StrokeEditor / Button

dlg.onControlValueChangedHandler = () => update(true);   // 改参数 → 重画预览
if ((dlg.runModal()?.value ?? dlg.runModal()) == DialogResult.Ok.value) { /* 提交 */ }
```

**实时预览的两段式提交**（官方范式，见 `assets/template-interactive.js`）：

```js
doc.executeCommand(cmd, true);    // true  = 只预览，不进撤销栈
doc.executeCommand(cmd, false);   // false = 真正提交
doc.clearPreviews();              // ★ 无论如何都要清，否则预览残留
```

---

## 7. 颜色与填充

```js
const { Colour, Gradient, ColourProfile } = require('/colours.js');
const { SolidFill, createTypedFill } = require('/fills.js');
const { FillDescriptor } = require('/fills.js');
const { LineStyle, LineStyleDescriptor } = require('/linestyle.js');

Colour.createRGB8(...) / createRGBA8 / createCMYKA8 / createLABA16 / createHSLAf / createDefault
colour.rgba8 / cmyk / hsl / lab / alpha / tint / overprint
Colour.random()

doc.setBrushFill(fillOrColour, ...) / setPenFill / setTransparencyFill
doc.setLineWeight(selection, w) / setLineWeightPts / setLineCap / setLineJoin / setDashPattern
doc.setStrokeAlignment(selection, alignment)
Gradient.create(stops) / gradient.stops / stopCount
ColourProfile.getAll() / find(name) / getDefaultForColourSpace(space)
```

**没有色板 / 全局色 API** —— 调色板要在脚本里自维护数组。

---

## 8. 文件与日志

### 8.1 读写 API

```js
const { File, fs } = require('/fs.js');
const { LogFile, LogLevel } = require('/logging.js');

// 目录与查询
fs.exists(path) / isDirectory(path) / isRegularFile(path)
fs.createDirectory(path) / createDirectories(path)          // 递归建目录
fs.copy(p1, p2, options) / copyFile / rename / remove / removeAll
fs.readAll(path) / readAllAsync(path, cb) / getFileSize / getSpace

// 文件对象
File.create(path, mode)            // mode 省略 = 'r'
File.readAll(path) / File.at(path)
file.isOpen / file.position / file.length / file.isEof
file.write(buffer, len) / writeStringAsUtf8(str) / writeStringAsUtf16(str) / writeString(str)
file.read(buf, len) / seek(off, FileOrigin) / tell() / flush() / close()

// 日志（原生组件，写文件不走 File API）
const logFile = LogFile.create(path, LogLevel.Info, append);
logFile.start(); console.info("…"); logFile.flush(); logFile.stop();
```

### 8.2 写文件：实测结论

**写入 API 是好的，别怀疑它。** 实测以下模式**全部可用**：

```
wb / w / wb+ / w+ / a / ab / r+
```

`writeStringAsUtf8` 正常返回写入字节数，`File.readAll` 能读回。

**两个必须注意的行为：**

1. **`File.create` 即使 `open` 失败也会返回对象**（返回值被丢掉），
   所以**必须检查 `file.isOpen`**，否则会一路静默走到 write 才报错。
2. **官方 `tests/filetests.js` 只有读测试**，且它 `require('/file.js')` —— 该模块在当前版本
   **已不存在**，测试是过时的。**不要指望从官方测试里抄到写入范例。**

**UTF-8 with BOM 的写法**：`\uFEFF` 的 UTF-8 编码正是 BOM 字节 `EF BB BF`，
所以直接 `writeStringAsUtf8("\uFEFF" + text)` 即可，不需要构造字节数组。

### 8.3 权限：唯一判据是 `fileSystemRoots`

```js
const roots = Environment.fileSystemRoots || [];   // 字符串数组
Environment.permissions                             // { fileSystem, network, genAI }
```

| 事实 | 说明 |
|---|---|
| 越界抛 `Error: PERMISSION_DENIED` | 不是静默失败 |
| **按目录生效，兄弟目录不覆盖** | 放行 `…\资产\SVG` ≠ 覆盖 `…\源文件\某项目` |
| 判断覆盖要按**路径分量** | 字符串前缀会误判：`…\SVG2` 不该被 `…\SVG` 覆盖 |
| **对话框不能授权访问** | `chooseFile()` 只是打开对话框，不授予权限 |

### 8.4 文件对话框：没有「另存为」

| 想做的事 | 可行做法 |
|---|---|
| 让用户选**保存位置** | `Application.prompt(msg, title, defaultPath)` 输入框 |
| 浏览选择 | **只有打开对话框**：`Application.chooseFile()`（无参数、无标题） |
| **保存对话框** | **不存在** |

`chooseFile()` 实测打开的是「**打开文件**」对话框，不是保存对话框 ——
拿它当"选保存位置"用，逻辑上说不通（用户得随便点一个已有文件来指示目录）。
`chooseFileAsync(callback)` 是它的异步版本。

### 8.5 四条硬规则（实测踩出来的）

> 与 `SKILL.md` 第 4 节的四条硬规则一一对应，编号相同。

1. **默认输出目录取自 `Environment.fileSystemRoots`**，不要默认用文档目录 ——
   文档目录常常不在白名单里，照搬必然 `PERMISSION_DENIED`。
   做法：文档目录若已被覆盖就用它，否则用 `roots[0]`，并把放行列表显示在提示里。

2. **不要加"权限预检"闸门。** 先 `fs.exists` 再 `createDirectories`、失败就中止 ——
   实测出现**假阴性**：目录合法、写入本来能成功，却被闸门挡下并报误导性的"没有写入权限"。
   **正确做法：直接尝试真正要做的操作，失败了再诊断。**

3. **必须检查 `file.isOpen`。** `File.create` 即使 `open` 失败也会返回对象，
   不检查就会一路静默走到 write 才报错。详见 8.2。

4. **文件名用 ASCII 更稳**，并准备回退。实测同一放行目录下纯 ASCII 名稳定可写；
   带中文和空格的文档名曾出现 `PERMISSION_DENIED`（未完成隔离验证）。
   稳妥做法：默认时间戳式名，失败时自动换名重试。

### 8.6 分诊：两种 `PERMISSION_DENIED`，解法完全不同

```js
const roots = Environment.fileSystemRoots || [];
if (!roots.length) {
    // ← 本脚本一个目录都看不到：多半是"导入的脚本"，不是设置问题
    //   导入的 .afscript 不继承「默认权限」的文件夹列表
    //   解法：粘贴到编辑器运行 / 在编辑器里另存为入库 / 用齿轮图标单独授权
} else {
    // ← 目标目录不在列表内：去 编辑 ▸ 设置 ▸ 脚本 ▸ 访问文件系统 添加
}
```

**这是本项目排查耗时最久的一个坑。** 设置里明明放行了目录，探针也能读到，
但导入的脚本报 `PERMISSION_DENIED` —— 原因是**脚本自身没有被授权**，
跟目录配置无关。

> `logToFile.js` 官方注释：*"The selected folder must be allowed in the application's Scripting settings."*

### 8.7 完整可运行范本

`assets/template-file-output.js` —— 把上面所有规则都实现了一遍，可直接改业务逻辑。


---

## 9. 命令与撤销

**改文档一律走命令**，否则撤销栈、预览、批量场景都可能出问题。

```js
const { DocumentCommand, CompoundCommandBuilder } = require('/commands.js');

const builder = CompoundCommandBuilder.create();
builder.addCommand(cmd1);
builder.addCommand(cmd2);
doc.executeCommand(builder.createCommand());

doc.undo() / doc.redo() / doc.history
doc.addDocumentSnapshot(desc) / doc.snapshots / doc.currentSnapshot
```

`commands.js` 有 **250+ 个 `create*` 命令**。用 `sdk-lookup.mjs --grep "static create"` 检索。

---

## 10. 宏 / 参考线 / 画板

```js
// 宏（相当于 Actions）
doc.startRecordingMacro() / stopRecordingMacro() / clearMacro()
doc.replayMacro() / importMacro(path) / exportMacro(path)

// 参考线
doc.addGuide(horizontal, at) / addHorizontalGuide(px) / addVerticalGuide(px)
doc.moveGuide(...) / removeGuide(...) / setGuidesColour(colour)

// 画板
doc.addArtboard(def, copyProps, copyGuides) / addRectangularArtboard(...)
doc.setArtboardSizeWithAnchor(artboard, w, h, anchor)
doc.setArtboardEnabled(selection, enabled)
artboardInterface.getArtboardBaseBox() / getArtboardDescription()

// 度量标注
doc 上的 MeasurementNode + createSetMeasurementUnits/Precision/AnnotationOffset

// 其他常用
doc.flatten() / mergeDown(selection) / mergeSelected / mergeVisible
doc.lockSelection(sel) / unlockSelection / unlockAll / hideSelection / showSelection / showAll
doc.flipCanvas(horizontal)
doc.imageTrace(selection, edgeThreshold, tolerance)
doc.rasteriseObjects(selection, contentsOnly, clipToSpread)
```

### 10.1 遍历画板并读取尺寸/名称/边距（v0.3 实测）

```js
const { Document } = require('/document.js');
const doc = Document.current;

for (const spread of doc.spreads.toArray()) {
    for (const ab of spread.artboards) {          // ★ 是数组，不是集合
        ab.description;      // 画板名（string）
        ab.baseBox;          // { x, y, width, height }，单位 = 文档像素
        ab.spreadBaseBox;    // 跨页坐标系下的框
        ab.marginBox;        // 已扣除边距后的框
        ab.isArtboardEnabled;

        // 安全边距（画板级，可逐画板不同）
        const props = ab.artboardProperties;      // 可能为 null
        const mi = props ? props.marginsInterface : null;
        mi.useMargins;   // 是否启用
        mi.hasMargins;   // 启用且四边不全为 0
        mi.margins;      // ★ LTRB：{ left, top, right, bottom }，不是 {x,y,w,h}
    }
}
// doc.artboards = 首个跨页的画板；doc.hasArtboards = 有无
```

**单位换算**：文档像素 → 其它单位按 `1 inch = doc.dpi 像素`；`1 inch = 25.4mm = 72pt`。

```js
const mm  = px * 25.4 / dpi;
const pt  = px * 72   / dpi;
const inch= px / dpi;
```

> ⚠️ **72dpi 时 1px = 1pt**，所以 px 与 pt 数值完全相同 —— 不是算错，别据此改公式。

**注意**：`doc.dpi` 是文档 DPI（`viewDpi` 已废弃）。
`doc.dimensions` / `widthPixels` / `heightPixels` 属于 **DocumentProperties**，**不在 `Document` 上**。

### 10.2 出血（bleed）：脚本层读不到（v0.3 确认）

- `ArtboardInterface` 原型链实测成员里**没有任何 bleed 成员**；
  `Document` 也没有 `documentProperties` getter（只有 `setDocumentProperties` 写入侧）
- 实测 `doc.bleed === undefined`、`doc.documentProperties === undefined`
- **底层其实存在**（`libpersona.dll` 符号）：
  `?GetBleedForSpread@ArtboardProperties@@…EdgeOffsetsT@N@…`（画板级）、
  `?GetBleedForSpread@SpreadNode@@…`、`?GetBleed@DocumentNode@@…`
  —— 即出血是 `EdgeOffsetsT<double>`（四边偏移），**但未导出到脚本层**

**交付处理**：做防御性探测（若某版本暴露了就采用），否则明确标注「未提供」，
**绝不用 0 或推测值冒充**，并提示用户以「文档设置 ▸ 出血」界面为准。

---

## 11. 能力边界（没有的东西）

| 缺失 | 绕行方案 |
|---|---|
| 对齐 / 分布命令 | 读 `getSpreadBaseBox()` 算位移 → `createTransform`（官方 `alignToPage.js` 是范本） |
| `item.name` 属性 | `node.description.userDescription` + `doc.setLayerDescription()` |
| 色板 / 全局色 | 脚本内自维护调色板数组 |
| 符号（Symbols） | 未暴露给脚本，做不到 |
| `app.executeMenuCommand` | 无等价物，依赖它的旧脚本必须重写 |
| 查找替换 | 遍历 Story 范围自己实现 |
| 路径简化（Simplify） | 自己写 Douglas-Peucker，用 `CurveBuilder` 重建 |
| 导出切片 | 用 `FileExportArea.createForArtboard/Pages` 替代 |
| `process` | 环境里是 `undefined`，不要用 |
| **出血（bleed）读取** | 脚本层无接口；底层有 `GetBleedForSpread`（`EdgeOffsetsT<double>`）但未导出 → 报告里标注「未提供」，不要编造 |

---

## 附：MCP 通道速查

Affinity 内置 MCP 服务（v0.3 打通）。**端口动态，必须先发现。**

```powershell
# 1. 发现端口（先按进程名定位，再回退全量扫描）
node scripts/mcp-client.mjs --discover

# 2. 列工具 / 列 SDK 文档 / 列脚本库
node scripts/mcp-client.mjs --tools
node scripts/mcp-client.mjs --docs
node scripts/mcp-client.mjs --lib

# 3. 跑脚本（调试）
node scripts/mcp-client.mjs --exec "console.log(typeof require)"
node scripts/mcp-client.mjs --exec-file .\我的脚本.js

# 4. 入库（权限位=3，无需修权限）
node scripts/mcp-client.mjs --save .\我的脚本.js --title "标题" --desc "描述"

# 5. 读回库内脚本 / 渲染预览
node scripts/mcp-client.mjs --read "标题"
node scripts/mcp-client.mjs --render-spread <document_session_uuid> 0

# 也可显式指定端口
node scripts/mcp-client.mjs --port 6767 --tools
```

**协议要点（踩坑记录）**：

| 项 | 值 |
|---|---|
| 传输 | SSE：`GET /sse` 取 `endpoint` → 向该路径 POST JSON-RPC |
| 协议版本 | **必须 `2025-11-25`**（传 `2024-11-05` → `Unsupported protocol version`） |
| SSE 行尾 | **`\r\n`**，事件块按 `/\r?\n\r?\n/` 切分 |
| 前置 | **必须先 `read_sdk_documentation_topic('preamble')`**，否则 `execute_script` 被拒 |
| 输出 | `execute_script` 只回传 `console.log()` 内容；返回值本身不返回 |
| 参数 | `execute_script` **只有 `script` 一个参数**（没有 `asModule`） |
| 工具集 | 11 个：`execute_script` / `save_script_to_library` / `list_library_scripts` / `read_library_script` / `list_sdk_documentation` / `read_sdk_documentation_topic` / `render_spread` / `render_selection` / `search_sdk_hints` / `add_sdk_hint` / `report_sdk_issue` |

**权限对比（v0.3 关键实测）**：

```
MCP save_script_to_library 入库 → mreP 权限=3（完整）  ← 无需 fix-script-perms
.afscript 导入                → mreP 权限=0（无权限）  ← 必须修
```

---

## 附：如何快速自查

```powershell
node scripts/sdk-lookup.mjs <符号名>                    # 找符号在哪个模块
node scripts/sdk-lookup.mjs --members nodes.js Node     # 列某个类的全部成员
node scripts/sdk-lookup.mjs --grep "static create"      # 正则搜
node scripts/sdk-lookup.mjs --files                     # 列出所有模块
node scripts/validate.mjs <你的脚本.js>                  # 交付前静态校验
```
