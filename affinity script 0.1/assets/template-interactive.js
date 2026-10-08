'use strict';

/*
 * 交互式脚本地板 —— 官方范式可运行版本
 * ===========================================================================
 * 这个文件不是骨架，是**能直接跑**的最小完整功能：批量设置选中对象的透明度，
 * 带参数面板和实时预览。把它当模板，换掉「业务逻辑」那一段就是你的脚本。
 *
 * 覆盖了官方交互式脚本的全部机制：
 *   · 形态 A 入口（顶层 main + 自调用）→ 可导入 Affinity 脚本库
 *   · 前置条件校验 + 无对话框报错
 *   · Dialog 声明式参数面板
 *   · previewLoop 实时预览（预览 / 提交两段式）
 *   · 命令系统（进撤销栈）+ clearPreviews 收尾
 *
 * 运行：窗口 ▸ 脚本 ▸ 脚本编辑器 ▸ 新建脚本 ▸ 粘贴 ▸ 运行
 * 交付前先跑：node scripts/validate.mjs <本文件>
 */

const { Document } = require('/document.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
const { Selection } = require('/selections.js');
const { UnitType } = require('/units.js');

// ============================ 配置区 ============================

// 出错时是否弹窗。默认 false —— 保持"无对话框"，错误走 console
const SHOW_ERROR_ALERT = false;

const LOG_PREFIX = "[地板] ";

// ============================ 基础设施 ============================

function log(msg) {
    console.info(LOG_PREFIX + msg);
}

function fail(msg) {
    console.error(LOG_PREFIX + msg);
    if (SHOW_ERROR_ALERT)
        alert(msg);
}

// 对话框返回值判定。用 ?.value ?? result 兼容不同小版本的返回结构。
function isOk(result) {
    return (result?.value ?? result) == DialogResult.Ok.value;
}

// 命令聚合。**空数组必须返回 null** —— previewLoop 靠它识别"无可执行内容"。
function compound(cmds) {
    if (!cmds || cmds.length == 0)
        return null;
    const builder = CompoundCommandBuilder.create();
    for (const cmd of cmds)
        builder.addCommand(cmd);
    return builder.createCommand();
}

// 实时预览主循环 —— 官方所有交互式脚本都套这个结构
function previewLoop(doc, dlg, build, onCommit) {
    const update = (preview) => {
        const cmd = build();
        if (cmd)
            doc.executeCommand(cmd, preview);   // preview=true 只预览，不进撤销栈
        else
            doc.clearPreviews();
        return cmd;
    };
    dlg.onControlValueChangedHandler = () => update(true);  // 拖动参数 → 立即重画
    update(true);                                          // 打开面板先预览一次
    if (isOk(dlg.runModal())) {                            // 用户点确定
        const cmd = update(false);                         // preview=false 真正提交
        if (cmd && onCommit)
            onCommit(cmd);
    }
    doc.clearPreviews();                                   // ★ 无论如何都要清
}

// ============================ 参数面板 ============================

function buildDialog(doc) {
    const dlg = Dialog.create("批量设置透明度");

    const grp = dlg.addColumn().addGroup("外观");

    // UnitValueEditor 支持 单位 / 文档单位 / 默认值 / 最小值 / 最大值
    // UnitType.Number 用于纯数值；UnitType.Pixel 之类会跟随文档单位换算
    dlg.opacity = grp.addUnitValueEditor("透明度 (%)", UnitType.Number, UnitType.Number, 100, 0, 100)
        .setPrecision(0);

    return dlg;
}

// ============================ 业务逻辑（改这里） ============================

// 根据面板当前值构造命令。必须**幂等**：预览会反复调用它。
function buildOpacityCommand(doc, selection, dlg) {
    const percent = dlg.opacity.value;          // 0..100
    const opacity = Math.max(0, Math.min(1, percent / 100));

    // createSetOpacity 是「设置绝对值」，天然幂等 —— 适合放在预览循环里。
    // ⚠️ 如果换成 createTransform 这类「相对变换」，预览会累计叠加，
    //    那时需要自己记录上次应用的值并先做逆变换。
    return compound([
        DocumentCommand.createSetOpacity(selection, opacity),
    ]);
}

// ============================ 主流程 ============================

function main() {
    // ---- 前置条件：必须能明确说出缺什么 ----
    const doc = Document.current;
    if (!doc) {
        fail("没有打开的文档。");
        return;
    }

    const selection = doc.selection;
    if (!selection || selection.length === 0) {
        fail("没有选中任何对象，请先选中要处理的内容。");
        return;
    }

    log("选中对象数：" + selection.length);

    // ---- 参数面板 + 实时预览 ----
    const dlg = buildDialog(doc);
    previewLoop(
        doc,
        dlg,
        () => buildOpacityCommand(doc, selection, dlg),
        () => log("已应用：透明度 " + dlg.opacity.value + "%")
    );
}

main();
