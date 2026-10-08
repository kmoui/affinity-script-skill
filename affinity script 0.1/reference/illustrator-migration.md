# Illustrator 脚本 → Affinity 3.3 迁移手册

> 目的：你以前在 Illustrator 上用的那些脚本，哪些能原样搬过来、哪些要改造、哪些目前搬不了。
> Affinity 侧的所有判定都来自本机 `3.3.0.4850` 的 SDK 源码实测，不是推测。

---

## 0. 一句话结论

**能迁的比例很高，但不是"改个 API 名"那么简单 —— 编程模型变了。**

Illustrator 的脚本是**直接改对象属性**：

```js
// Illustrator (ExtendScript)
app.activeDocument.pathItems[0].position = [100, 200];
```

Affinity 的脚本是**构造命令、交给文档执行**：

```js
// Affinity 3.3
const cmd = DocumentCommand.createTransform(
    Selection.create(doc, node),
    Transform.createTranslate(100 - x, 200 - y));
doc.executeCommand(cmd);
```

这个差异看着麻烦，其实是好事：命令式天然进撤销栈、天然支持**实时预览**（`doc.executeCommand(cmd, true)`），所以 Affinity 脚本能做出 Illustrator 脚本做不到的"拖参数实时看效果"面板。

另外语言层面是**升级**：ExtendScript 停留在 ES3 时代，Affinity 是 V8，箭头函数、`?.`、`??=`、class、`Symbol.iterator` 全都能用。

---

## 1. API 对照表（迁移时的速查）

| Illustrator (ExtendScript) | Affinity 3.3 | 说明 |
|---|---|---|
| `app.activeDocument` | `Document.current` | |
| `app.documents` | `Document.all` | 批处理多文档用 |
| `doc.selection` | `doc.selection.nodes` | 返回的是集合，用 `.toArray()` |
| `doc.pathItems[i]` | `doc.layers` + `getNodeChildrenRecursive()` | AI 是扁平列表，Affinity 是**树** |
| `doc.artboards[i]` | `doc.artboards` / `doc.spreads` | |
| `item.position = [x,y]` | `DocumentCommand.createTransform(...)` | ⚠️ 要算**增量**，不是绝对值 |
| `item.name` | `node.description.userDescription`<br>`doc.setLayerDescription(...)` | ⚠️ 走 Description 接口 |
| `item.opacity = v` | `createSetOpacity(selection, v)` | |
| `item.hidden = v` | `createSetVisibility(selection, v)` | |
| `item.locked = v` | `createSetEditable(selection, v)` | 反向语义，注意 |
| `item.zOrderPosition` | `createMoveNodes(sel, target, moveType, childListType)` | |
| `doc.swatches.add(...)` | ❌ 无对应 | 见 §4 |
| `doc.exportFile(...)` | `doc.export(path, options, area, size)` | Affinity 的范围控制更细 |
| `new File(path)` | `require('/fs.js')` → `fs.*` | |
| `file.read()` / `write()` | `File.readAll()` / `LogFile` | |
| `alert/confirm/prompt` | 同名可用 | 另有 `Dialog` 原生面板（更好） |
| `app.doScript()` | `doc.executeCommand()` | |
| `$` (dollar 库) | ❌ 无 | 少数用到的要重写 |
| `app.executeMenuCommand()` | ❌ 无 | 这是 AI 脚本的老套路，Affinity 必须走 API |

---

## 2. 迁移矩阵（按脚本类别）

图例：✅ 可直接迁移　⚠️ 要改造，但完全可行　❌ 目前做不到

### ✅ 可以放心迁的

| 类别 | Illustrator 里典型脚本 | Affinity 对应 API | 官方样例 |
|---|---|---|---|
| **批量导出** | 多格式/多尺寸批量导出、按画板导出 | `doc.export(path, opts, area, size)`、`FileExportArea.createForArtboard/Pages/Spreads/Selection/WholeDocument`、`Document.load`、`fs` | 社区 `smart_jpeg_export` |
| **宏录制回放** | Actions 面板操作 | **完整宏 API**：`startRecordingMacro` / `stopRecordingMacro` / `replayMacro` / `importMacro` / `exportMacro` / `clearMacro` | — |
| **布尔运算** | 路径finder 类脚本 | `createBoolOpUnion` / `Subtract` / `Intersect` / `Xor` | — |
| **路径节点编辑** | 圆角、加点、等分、角效果、路径特效 | `CurveBuilder`、`PolyCurve`、`createAddCurveNode`、`createDeleteCurveNodes`、`createSetCurveNodeStyle`、`createJoinCurves` | `addPoints` `roundAnyCorner` `divideLength` `cornerEffects` `pathEffects` `bulgedPolyline` |
| **转曲 / 轮廓化** | Create Outlines | `createConvertToCurves(selection)` | — |
| **参考线 / 网格 / 裁切标记** | 加参考线、裁切标记、网格 | `createAddGuide` / `createAddHorizontalGuide` / `createAddVerticalGuide` / `createMoveGuide` / `createRemoveGuide` / `createSetGuidesColour` | `addGuides` `cropMarks` `makeGrid` `artboardGrid` |
| **画板管理** | 新建/调整画板、按内容适配、网格排布 | `doc.artboards`、`ArtboardInterface`、`createAddArtboard`、`createSetArtboardSizeWithAnchor`、`artboardproperties.js` | `artboardGrid` `adjustPageItems` |
| **变换 / 随机化 / 步进重复** | Randomus、步进复制、网格复制 | `Transform`、`createGroupTransform`、`GroupTransformAnchor/Order/Type`、`createSetOpacity`、`createSetBlendMode` | `randomise` `stepAndRepeat` `makeGrid` |
| **图层效果 / 外观** | 投影、发光、斜角 | **完整图层效果 API**（投影/内阴影/外发光/内发光/描边/颜色叠加/渐变叠加/斜角浮雕/高斯模糊，每项都有独立 set 命令） | — |
| **滤镜 / 调整** | 各种效果脚本 | 60+ 实时节点：Levels、Curves、Selective Colour、HSL Shift、Vibrance、各类模糊、Halftone、Voronoi、Vignette… | — |
| **度量标注** | Measure 类脚本 | `MeasurementNode`、`createSetMeasurementUnits/Precision/AnnotationOffset/ShowEndpointMarkers` | — |
| **文本 / 排版** | 文本分割、沿路径排文、批量替换字体 | `story.js`、`glyphs.js`、`glyphatts.js`、`paragraphatts.js`、`fonts.js`、`TextSelection`、`StoryBuilder` | `splitStory` `textOnCurvesAndShapes` `boldItalics` |
| **按 JSON/CSV 生成内容** | Variables / 数据合并 | 脚本自己读文件（`fs.readAll`）+ 生成节点 | `tableFromJson` `makeNumbersSequence` |

### ⚠️ 能迁，但要换个做法

| 类别 | 为什么不能照搬 | 正确做法 |
|---|---|---|
| **对齐 / 分布 / 等距** | **没有内置 align/distribute 命令**（扫描 `Distribute` 命中 0 个符号） | 自己算：`node.getSpreadBaseBox()` 拿包围盒 → 算目标位置 → 发 `createTransform` 平移。官方 `alignToPage.js` 就是范本 |
| **图层/对象重命名** | 没有 `name` 属性 | 走 `DescriptionInterface`：读 `node.description.userDescription`，写 `doc.setLayerDescription(desc, node, preview)`。顺带还能设 `tagColour` 图层颜色标签 |
| **按属性筛选对象** | 没有 `findItem()` 之类 | 遍历 `doc.layers` + `getNodeChildrenRecursive()` 自己判断类型/填充/描边/字体 |
| **文本查找替换** | 没有内置 find/replace | 遍历 `Story` 范围自己匹配；底层有 `rFindWordBegin/End/Part/ParagraphBreak` 可用 |
| **文档色板 / 全局色管理** | **没有 swatch/palette 接口**（扫描命中 0） | 颜色对象本身很强（`Colour` 支持 RGB/CMYK/LAB/HSL/灰度/多色深 + `Gradient` + `ColourProfile`），把调色板做成脚本内数组即可 |
| **路径简化（Simplify）** | 没有 `simplify` 命令 | 自己按容差做 Douglas-Peucker，用 `CurveBuilder` 重建 —— 官方 `roundAnyCorner`、`divideLength` 都是这个套路 |
| **画板/图层重命名批处理** | 同"重命名" | 同 DescriptionInterface |

### ❌ 目前做不到

| 类别 | 原因 |
|---|---|
| **符号（Symbols）** | 脚本接口里没有 Symbol 对象，全 SDK 只扫到字体的 `createDefaultSymbol`。Affinity Designer 的符号功能**没有暴露给脚本** |
| **导出切片（Slices）** | 只扫到 `buffer.createSlice`（缓冲区切片，无关）。用 `FileExportArea` 按画板/页面导出可覆盖大部分需求 |
| **`app.executeMenuCommand`** | Illustrator 脚本的万能后门，Affinity 没有等价物。凡是依赖它的老脚本都必须重写 |
| **`$` (dollar 库)** | 未提供 |
| **插件级扩展** | `libscripting.dll` 里有 `NativePluginLibrary` / `AF_GetScriptEngineLibrary_1` 等符号，说明存在原生插件机制，但**无公开文档**，且要写 C++ |

---

## 3. 建议的迁移优先级

先做**投入产出比最高**的，也顺便把工具链跑通：

### 第一梯队（立刻能做，价值最大）

1. **批量导出工具** —— 素材导出是刚需，Affinity 的 `FileExportArea` 比 AI 更细
   → 参考社区已有的 `smart_jpeg_export`（按最大文件大小限制导出）
2. **画板工具集** —— 重命名（含序号补零）、按内容适配、网格排布
   → 官方 `artboardGrid` + `adjustPageItems` 已有骨架
3. **清理类** —— 删空组、找隐藏/锁定对象、清垃圾节点
   → 社区有 `DeleteEmptyGroups`，逻辑简单，适合练手
4. **路径工具集** —— 等分、圆角、随机化、布尔
   → 官方示例覆盖度高，改改就能用

### 第二梯队

5. **样式统一 / 检查** —— 字体、字号、描边宽度重映射
   → 社区已有 `Style Consistency Checker`
6. **颜色工具** —— 批量换色、按色相/明度重映射、生成渐变映射
   → 颜色对象能力强，但没有色板管理，要自己做调色板
7. **文本工具** —— 批量替换字体、编号序列、沿路径排文

### 第三梯队（要自己造轮子）

8. **对齐分布**、**文本查找替换**、**路径简化** —— 都得自己写算法

---

## 4. 迁移时的三个坑

1. **位置是增量不是绝对值**
   AI 习惯 `item.position = [x, y]`。Affinity 的 `Transform.createTranslate(dx, dy)` 要的是**位移量**。所以要先读当前包围盒 `getSpreadBaseBox()`，再算差值。

2. **对象是树不是列表**
   AI 的 `doc.pathItems[i]` 是扁平可索引的。Affinity 必须从 `doc.layers` 或 `doc.rootNode` 递归下去（`getNodeChildrenRecursive()`）。遍历代码要重写。

3. **改任何东西都要包成 Command**
   直接改属性可能在预览、撤销、批量场景下出问题。统一走：
   ```js
   const cmd = compound([cmd1, cmd2, cmd3]);   // 空数组返回 null
   if (cmd) doc.executeCommand(cmd);           // 交互式则传 preview=true
   ```

---

## 5. 现成的 Affinity 脚本资源（可以直接拿来改）

| 资源 | 内容 |
|---|---|
| 本机 `Resources\JSLib\examples\` | **35 个官方示例**，全部可读，是最正确的写法范本 |
| 本机 `Resources\JSLib\tests\` | 44 个自测脚本 + 测试用 `.afdesign` 文件 |
| `示例.afscripts` 解出的 24 个 | 官方脚本库内容，含完整交互式范式。可用解包工具自行提取，或直接读 SDK 的 `examples\` |
| [Affinity Hub](https://affinityhub.js.org/) | 社区脚本库，可一键装入 Affinity，含 Tile Generator、Blend Tool、ChartsPro 等几十个 |
| [Affinity Community Scripts](https://github.com/JiriKrblich/Affinity-Community-Scripts) | GitHub 社区脚本集合 |

---

## 6. Illustrator 脚本资源（迁移的来源）

| 资源 | 说明 |
|---|---|
| [creold/illustrator-scripts](https://github.com/creold/illustrator-scripts) | 最大的集合之一，按 Artboard / Color / Group / Path / Text / Transform / Export / Utility / Select 分类，每个类别有独立 md 文档 |
| [alexander-ladygin/illustrator-scripts](https://github.com/alexander-ladygin/illustrator-scripts) | 精品脚本集：RenameItems、AlignToArtboard、Randomus、ColorKit、TextSplit、PathArea、SelectMenu 等 |
| [borisboguslavsky/illustrator-scripts](https://github.com/borisboguslavsky/illustrator-scripts) | 免费脚本集合 |
| [Mapsoft Free Illustrator Scripts](https://mapsoft.com/illustrator-scripts.html) | 100 个 ExtendScript 工具，另有[批处理教程](https://mapsoft.com/posts/illustrator-batch-processing.html) |
| [hwangzhun/illustrator-script-compilation](https://github.com/hwangzhun/illustrator-script-compilation) | 中文整理的一些 Illustrator 脚本 |
| [35+ 免费 AI 脚本合集导读（中文）](https://blog.gitcode.com/cf9f7e616a59d261cb583ea0a6cdd134.html) | 中文上手介绍 |

> 注意：这些仓库的代码是 ExtendScript（.jsx，ES3 语法），**不能直接跑**，需要按 §1 的对照表重写。但**逻辑和算法可以照搬** —— 圆角怎么算、等分怎么算、重命名规则怎么设计，这部分是通用的。

---

## 7. 建议的第一步

不要说"我要把 XX 脚本迁过来"然后闷头写。建议按这个顺序：

1. **挑一个你以前最常用的 Illustrator 脚本**告诉我名字（或它的功能）
2. 我先判断它属于 ✅ / ⚠️ / ❌ 哪一档，指出 Affinity 侧的对应 API
3. 然后按官方范式（`previewLoop` + `Dialog`）写出来，直接能在 Affinity 里跑

这样第一个脚本跑通，工具链和模板就都有了，后面就是复制粘贴改业务逻辑。
