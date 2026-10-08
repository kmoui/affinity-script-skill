'use strict';

/*
 * 文件输出类脚本地板
 * ===========================================================================
 * 这个文件不是骨架，是**能直接跑**的完整功能：把当前文档的基本信息写成一份 txt 报告。
 * 它的价值在于把「写文件」这一类脚本的**全部硬规则**都实现了一遍 ——
 * 这些规则都是实测踩出来的，照抄即可避开。
 *
 * 覆盖的硬规则：
 *   ① 默认输出目录取自 Environment.fileSystemRoots（不是文档目录！）
 *   ② 不做"权限预检"闸门 —— 预检会假阴性，把本来能成功的写入挡掉
 *   ③ 检查 file.isOpen —— File.create 即使 open 失败也会返回对象
 *   ④ 多种打开模式逐个尝试 + ASCII 文件名回退
 *   ⑤ PERMISSION_DENIED 的分诊：区分"目录不在列表"和"本脚本无授权"
 *
 * 换成你自己的功能时，只需改「业务逻辑」那一段。
 *
 * 运行：窗口 ▸ 脚本 ▸ 脚本编辑器 ▸ 新建脚本 ▸ 粘贴 ▸ 运行 ▸ 另存为
 * 交付前：node scripts/validate.mjs <本文件>
 */

const { Application } = require('/application.js');
const { Document, FileExportOptions } = require('/document.js');
const { Environment } = require('/environment.js');
const { File, fs } = require('/fs.js');

// ============================ 配置区 ============================

// 输出目录。null = 询问用户（预填一个保证可写的目录）；也可写死成常量
const OUTPUT_DIR = null;

// 文件名模式：'doc' = 用文档名；'timestamp' = 用日期时间（ASCII，更稳）
const FILENAME_MODE = 'timestamp';

// 编码：'utf8bom'（Windows 记事本友好）| 'utf8' | 'utf16'
const ENCODING = 'utf8bom';

// 是否允许在写入失败时自动换 ASCII 文件名重试
const ASCII_FILENAME_FALLBACK = true;

// 出错时是否弹窗。默认 false —— 错误走 console，便于无人值守
const SHOW_ERROR_ALERT = false;

const LOG_PREFIX = "[文件输出] ";

// ============================ 基础设施 ============================

function log(m) { console.info(LOG_PREFIX + m); }

function fail(m) {
    console.error(LOG_PREFIX + m);
    if (SHOW_ERROR_ALERT) alert(m);
}

// SDK 调用一律包一层，避免单个失败中断整个脚本
function safe(fn, fallback) {
    try {
        const v = fn();
        return (v === undefined || v === null) ? fallback : v;
    }
    catch (e) {
        return fallback;
    }
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }

function timeStamp() {
    const d = new Date();
    return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
         + "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

function baseName(p) {
    if (!p) return "untitled";
    const m = /([^\\/]+?)(\.[^\\/.]*)?$/.exec(String(p));
    return (m && m[1]) ? m[1] : "untitled";
}

function dirName(p) {
    if (!p) return null;
    const s = String(p);
    const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i > 0 ? s.substring(0, i) : null;
}

// ============================ 权限与目录 ============================

function allowedRoots() {
    const r = safe(function () { return Environment.fileSystemRoots; }, []);
    const out = [];
    for (let i = 0; i < (r ? r.length : 0); i++) out.push(String(r[i]));
    return out;
}

// 按路径分量判断覆盖关系 —— 不能只做字符串前缀（…\SVG2 不该被 …\SVG 覆盖）
function isCovered(dir, roots) {
    if (!dir) return false;
    const d = String(dir).toLowerCase().replace(/[\\/]+$/, "");
    for (let i = 0; i < roots.length; i++) {
        const r = String(roots[i]).toLowerCase().replace(/[\\/]+$/, "");
        if (!r) continue;
        if (d === r || d.indexOf(r + "\\") === 0 || d.indexOf(r + "/") === 0) return true;
    }
    return false;
}

// ★ 硬规则 ①：默认目录取自 fileSystemRoots，而不是文档目录
//   文档目录常常不在白名单里，照搬必然 PERMISSION_DENIED
function pickDefaultDir(docPath) {
    const roots = allowedRoots();
    if (OUTPUT_DIR) return OUTPUT_DIR;
    const docDir = dirName(docPath);
    if (docDir && isCovered(docDir, roots)) return docDir;
    if (roots.length) return roots[0];
    return docDir || safe(function () { return Application.userDesktopPath; }, "");
}

function askDir(defaultDir) {
    const roots = allowedRoots();
    let hint = "\n\n可写入的目录：";
    if (roots.length) {
        for (let i = 0; i < roots.length; i++) hint += "\n  " + (i + 1) + ". " + roots[i];
    } else {
        hint = "\n\n⚠ 本脚本看不到任何放行目录。若你是从外部导入的脚本，"
             + "请在编辑器里粘贴运行或另存为入库。";
    }

    const a = Application.prompt(
        "导出到哪个文件夹？\n· 直接确定 = 用预填目录（已确保可写）\n· 也可粘贴其它路径" + hint,
        "文件输出", defaultDir || "");
    if (a == null || String(a).trim() === "") return null;

    return String(a).trim()
        .replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "")
        .replace(/[\\/]+$/, "");
}

// ============================ 写文件 ============================

// ★ 硬规则 ④：多模式尝试 + isOpen 检查
function writeTextFile(path, text) {
    const utf8 = (ENCODING === 'utf8') ? text : "\uFEFF" + text;   // U+FEFF 的 UTF-8 编码就是 BOM
    const modes = ["wb", "w", "wb+", "w+"];
    let lastErr = null;

    for (let i = 0; i < modes.length; i++) {
        let f = null;
        try {
            f = File.create(path, modes[i]);
            // ★ 硬规则 ③：File.create 即使 open 失败也会返回对象，必须查 isOpen
            if (!f || !f.isOpen) {
                lastErr = new Error("模式 '" + modes[i] + "' 打开后 isOpen = false");
                try { if (f) f.close(); } catch (e2) { }
                continue;
            }
            if (ENCODING === 'utf16') f.writeStringAsUtf16(text);
            else f.writeStringAsUtf8(utf8);
            f.close();
            if (i > 0) log("（使用写入模式 '" + modes[i] + "'）");
            return true;
        }
        catch (e) {
            lastErr = e;
            try { if (f) f.close(); } catch (e2) { }
        }
    }
    throw (lastErr || new Error("所有写入模式均失败"));
}

// ★ 硬规则 ⑤：PERMISSION_DENIED 的分诊 —— 两种原因，解法完全不同
function reportFailure(path, e) {
    const msg = String(e);
    fail("写入失败：" + msg);
    log("目标文件：" + path);

    const dir = dirName(path);
    let ex;
    try { ex = String(fs.exists(dir)); } catch (e2) { ex = "抛错 " + e2; }
    log("诊断：fs.exists(目标目录) = " + ex);

    if (!/PERMISSION_DENIED/i.test(msg)) return;

    const roots = allowedRoots();
    log("诊断：本脚本可见的放行目录数 = " + roots.length);

    if (!roots.length) {
        // 关键区别：这不是设置问题，是**这个脚本**没被授权
        fail("本脚本看不到任何放行目录 —— 通常是「导入的脚本不继承默认权限」导致的。");
        fail("解法：① 粘贴到脚本编辑器运行；② 或在编辑器里打开后另存为入库；");
        fail("      ③ 或打开该脚本的设置（齿轮图标）单独授权。");
    }
    else {
        fail("目标目录不在本脚本的放行列表内：");
        for (let i = 0; i < roots.length; i++) console.error(LOG_PREFIX + "  · " + roots[i]);
        fail("请到  编辑 ▸ 设置 ▸ 脚本 ▸ 访问文件系统  添加该目录。");
    }
}

// ============================ 业务逻辑（改这里） ============================

function buildReport(doc) {
    const lines = [];
    lines.push("Affinity 文档信息报告");
    lines.push("生成时间：" + new Date().toString());
    lines.push("");
    lines.push("文件路径：" + safe(function () { return doc.path; }, "(未保存)"));
    lines.push("DPI：" + safe(function () { return doc.dpi; }, "?"));
    lines.push("画板数：" + safe(function () { return doc.hasArtboards ? doc.artboards.toArray().length : 0; }, "?"));
    lines.push("图层数：" + safe(function () { return doc.layers.toArray().length; }, "?"));
    lines.push("跨页数：" + safe(function () { return doc.spreads.toArray().length; }, "?"));
    lines.push("当前选中：" + safe(function () { return doc.selection.length; }, "?") + " 个对象");
    lines.push("");
    lines.push("可用导出预设数：" + safe(function () {
        return (FileExportOptions.allPresetNames || []).length;
    }, "?"));
    return lines.join("\r\n");   // Windows 换行
}

// ============================ 主流程 ============================

function main() {
    const doc = Document.current;
    if (!doc) { fail("没有打开的文档。"); return; }

    const text = buildReport(doc);

    // 决定输出路径
    const docPath = safe(function () { return doc.path; }, null);
    const name = (FILENAME_MODE === 'doc' && docPath) ? baseName(docPath) : timeStamp();

    let dir = OUTPUT_DIR;
    if (!dir) {
        const def = pickDefaultDir(docPath);
        log("默认目录：" + def + (isCovered(def, allowedRoots()) ? "（已放行 ✓）" : "（未放行 ⚠）"));
        dir = askDir(def);
        if (!dir) { log("已取消。"); return; }
    }
    log("目标目录：" + dir);

    const outPath = dir + "\\" + name + ".txt";

    // ★ 硬规则 ②：直接写，不做权限预检 —— 预检会假阴性，把本来能成功的写入挡掉
    try {
        writeTextFile(outPath, text);
    }
    catch (e) {
        if (ASCII_FILENAME_FALLBACK) {
            const fb = dir + "\\" + timeStamp() + ".txt";
            if (fb !== outPath) {
                log("用原文件名失败，改试：" + fb);
                try { writeTextFile(fb, text); }
                catch (e2) { reportFailure(fb, e2); return; }
                log("✔ 已导出 → " + fb + "（回退成功，说明原文件名有问题）");
                return;
            }
        }
        reportFailure(outPath, e);
        return;
    }

    log("✔ 已导出 → " + outPath);
    log("内容预览：" + text.replace(/\r?\n/g, "⏎").substring(0, 120));
}

main();
