'use strict';

/*
 * probe.js —— Affinity 脚本环境总探针
 * ---------------------------------------------------------------------------
 * 在 Affinity 里运行（窗口 ▸ 脚本 ▸ 脚本编辑器 ▸ 新建脚本 ▸ 粘贴 ▸ 运行）。
 *
 * 设计原则：**整个文件不依赖 require**，任何运行环境都能跑出结果。
 *   · 有 require → 顺带把 SDK 版本、权限、允许目录、导出预设、当前文档全报出来
 *   · 没有 require → 报告当前有哪些全局，用于定位运行入口问题
 * console 不可用时自动退回 alert，保证一定看得到输出。
 *
 * 首次为某个用户/某台机器写脚本前，先让他跑这个——比反复猜快得多。
 */

function out(msg) {
    var text = String(msg);
    try {
        if (typeof console !== 'undefined' && console && console.info) {
            console.info(text);
            return;
        }
    }
    catch (e) { /* fall through */ }
    try { alert(text); } catch (e2) { /* nothing left */ }
}

function line(label, value) {
    out("[探针] " + label + "：" + value);
}

function safe(fn, fallback) {
    try { return fn(); }
    catch (e) { return fallback !== undefined ? fallback : ("出错: " + e); }
}

function main() {
    out("[探针] ================= Affinity 脚本环境总探针 =================");

    var g;
    try { g = (typeof globalThis !== 'undefined') ? globalThis : this; }
    catch (e) { g = this; }

    // ---------- 1. 运行环境 ----------
    // 注意：require/module/exports 是模块作用域的，**不在 globalThis 上**，
    // 所以必须用 typeof 判断，不能用 g["require"]。
    line("typeof require", typeof require);
    line("typeof module ", typeof module);
    line("typeof exports", typeof exports);
    line("typeof console", typeof console);
    line("typeof alert  ", typeof alert);
    line("typeof process", typeof process);

    var names = safe(function () { return Object.getOwnPropertyNames(g).sort(); }, []);
    line("全局名数量", names.length);
    out("[探针] 全局名列表：" + names.join(", "));

    // ---------- 2. 没有 require 就直接结束 ----------
    if (typeof require !== 'function') {
        out("[探针] ⚠ 当前环境没有 require，无法加载 Affinity SDK。");
        out("[探针]    改用：窗口 ▸ 脚本 ▸ 脚本编辑器 ▸ 新建脚本 ▸ 粘贴 ▸ 运行");
        out("[探针] ================= 探针结束 =================");
        return;
    }

    out("[探针] ---- require 可用，继续做 SDK 检查 ----");

    var Application, Environment, Document, FileExportOptions, fs;
    try {
        Application = require('/application.js').Application;
        Environment = require('/environment.js').Environment;
        Document = require('/document.js').Document;
        FileExportOptions = require('/document.js').FileExportOptions;
        fs = require('/fs.js').fs;
        out("[探针] SDK 模块加载：成功");
    }
    catch (e) {
        out("[探针] ✗ SDK 模块加载失败：" + e);
        out("[探针] ================= 探针结束 =================");
        return;
    }

    line("Affinity 版本", safe(function () { return Application.version; }));
    line("构建号", safe(function () { return Application.buildVersion; }));
    line("平台", safe(function () { return Application.platformName; }));
    line("SDK 版本", safe(function () { return Environment.sdkVersionStr; }));
    line("V8 版本", safe(function () { return Environment.v8VersionStr; }));
    line("权限", safe(function () { return JSON.stringify(Environment.permissions); }));

    // ---------- 3. 允许访问的目录（最容易卡住的地方） ----------
    out("[探针] ---- 允许脚本访问的目录 ----");
    var roots = safe(function () { return Environment.fileSystemRoots; }, null);
    if (!roots || roots.length === 0) {
        out("[探针]   （空）—— 说明还没在 编辑 ▸ 设置 ▸ 脚本 ▸ 访问文件系统 里放行任何目录");
    } else {
        for (var r = 0; r < roots.length; r++)
            out("[探针]   · " + roots[r]);
    }

    // ---------- 4. 导出目标目录连通性 ----------
    // 若调用方通过脚本参数传了目录，这里用参数；否则跳到预设检查
    out("[探针] ---- 目录可写性自检 ----");
    out("[探针]   提示：若要测试具体目录，把下面的 TEST_DIR 改成目标路径后重跑。");
    var TEST_DIR = null;   // 例："G:\\path\\to\\output"
    if (TEST_DIR) {
        line("路径", TEST_DIR);
        line("存在", safe(function () { return fs.exists(TEST_DIR); }));
        line("是目录", safe(function () { return fs.isDirectory(TEST_DIR); }));
    } else {
        out("[探针]   （未指定测试目录，已跳过）");
    }

    // ---------- 5. 导出预设（注意：名字随界面语言变化） ----------
    out("[探针] ---- 可用导出预设 ----");
    var presets = safe(function () { return FileExportOptions.allPresetNames; }, []);
    line("预设总数", presets.length);
    for (var p = 0; p < presets.length; p++)
        out("[探针]   · " + presets[p]);
    var svg = [];
    for (var q = 0; q < presets.length; q++)
        if (/svg/i.test(presets[q])) svg.push(presets[q]);
    out("[探针]   SVG 相关：" + (svg.length ? svg.join(" | ") : "（没找到）"));

    // ---------- 6. 当前文档 ----------
    out("[探针] ---- 当前文档 ----");
    var doc = safe(function () { return Document.current; }, null);
    if (!doc) {
        out("[探针]   没有打开的文档");
    } else {
        line("文档路径", safe(function () { return doc.path; }));
        line("DPI", safe(function () { return doc.dpi; }));
        line("画板数", safe(function () { return doc.hasArtboards ? doc.artboards.length : 0; }));
        line("选中对象数", safe(function () { return doc.selection ? doc.selection.length : "(无)"; }));
    }

    out("[探针] ================= 探针结束 =================");
}

main();
