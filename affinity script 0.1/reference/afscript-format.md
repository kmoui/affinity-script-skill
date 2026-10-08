# .afscript 容器格式（逆向确认，2026-10-06）

> 基于三个真实官方导出样本逐字节对账确认。Affinity 3.3.0.4850 / Windows。
> 容器版本 `12`（`.afdesign` 是 `11`，跨版本不保证兼容）。

## 0. 一句话结构

```
.afscript = [76 字节固定头] [zstd 压缩帧] [ff ff ff ff] [#FT4 尾部 113 字节]
```

两端各有一个校验和：**CRC32(解压载荷)** 与 **CRC32(zstd 帧)**，都在尾部。

## 1. 外层（未压缩，76 字节头 + 尾部）

| 偏移 | 长度 | 值 | 含义 |
|---|---|---|---|
| 0 | 4 | `00 FF 4B 41` | 魔数（Affinity 全系容器通用） |
| 4 | 4 | u32 `12` | 容器版本 |
| 8 | 4 | `prcS` | 类型标签 = **Scrp**（单脚本） |
| 12 | 4 | `#Inf` | 段标记 |
| 16 | 8 | u64 | **`#FT4` 尾部的偏移** = `76 + 帧长 + 4` |
| 24 | 8 | u64 | **文件总长** |
| 32 | 8 | u64 | **zstd 帧长度** |
| 40 | 8 | u64 `0` | 保留 |
| 48 | 8 | u64 | **Unix 时间戳**（导出时刻） |
| 56 | 4 | u32 `2` | 常量 |
| 60 | 4 | u32 `2` | 常量 |
| 64 | 4 | `Prot` | 段名 |
| 68 | 4 | u32 `4` | 常量 |
| 72 | 4 | `#Fil` | 数据段标记（载荷起点） |

紧随其后是 zstd 帧（魔数 `28 B5 2F FD`），帧结束后是 `ff ff ff ff`，然后 `#FT4` 尾部。

### `#FT4` 尾部（固定 113 字节，`Script.dat` 名长 10）

| 相对偏移 | 长度 | 值 | 含义 |
|---|---|---|---|
| +0 | 4 | `#FT4` | 段标记 |
| +4 | 8 | u64 `0` | 保留 |
| +12 | 8 | u64 | 时间戳（同头 @48） |
| +20 | 8 | u64 | 文件总长（同头 @24） |
| +28 | 8 | u64 | 帧长（同头 @32） |
| +36 | 8 | u64 `0` | 保留 |
| +44 | 4 | u32 `1` | 常量 |
| +48 | 4 | u32 `0` | 常量 |
| +52 | 4 | u32 `0x36` | 常量 |
| +56 | 4 | `00 00 00 01` | 常量 |
| +60 | 4 | u32 `0` | 常量 |
| +64 | 8 | u64 `0x48` | 常量 |
| +72 | 8 | u64 | **解压后载荷长度** |
| +80 | 8 | u64 | 帧长（重复一次） |
| +88 | 4 | u32 | **CRC32(解压载荷)** |
| +92 | 5 | `02 20 00 00 00` | 常量 |
| +97 | 4 | u32 | **CRC32(zstd 帧)** |
| +101 | 2 | u16 `10` | 文件名长度 |
| +103 | 10 | `Script.dat` | 内嵌文件名 |

## 2. 内层载荷（zstd 解压后）

所有记录都是 **4CC 标签（反读）** + 长度前缀：

```
00 FF 4B 53 02 00              KS 魔数 + 版本
"prcS" 01 00 20 00 00 00        头部
31 "prcS" 01 00000000 00
"tpcS" 03 00 00 02
2B "gfnC" u32len  {"asModule":false,"code":"<JS 源码 JSON 转义>"}
2B "ngnE" u32(42) "com.canva.affinity.scriptengine.playground"
2B "cseD" u32len  描述（UTF-8，可为空）
2B "ltit" u32len  标题（UTF-8）
04 "mreP" u64le  权限位（导出恒为 0，见下）
29 "rTnU" 0017 "diuU" <16 字节 GUID> 00 00
```

- **4CC 全部反读**：`gfnC`=Cnfg、`ngnE`=Engn、`ltit`=titl、`cseD`=Desc、`mreP`=Perm、`tpcS`=Scpt、`prcS`=Scrp
- 记录前缀字节：`2B` 表示后随长度前缀记录；`04` 用于 mreP；`29` 用于尾部
- **JSON 转义**与 `JSON.stringify` 完全一致（`\r` / `\n` / `\t`，非 ASCII 保持 UTF-8 原样）

## 3. 权限机制（重要）

`mreP` 记录的 u64 是**权限位掩码**：

| 位 | 权限 |
|---|---|
| bit0 | 文件系统 |
| bit1 | 网络 |
| bit2 | Canva AI（推断，未直接验证） |

- 编辑器「另存为」的脚本：`mreP = 3`（继承设置默认值）
- **导出 `.afscript` 时被清零** → 导入后 `mreP = 0` → 运行时 `PERMISSION_DENIED`
- 这是官方安全设计：权限不随文件旅行
- **解法**：`scripts/fix-script-perms.mjs` 离线修补脚本库里的权限位

二进制符号证据：
```
?GetPermissions@Script@@QEBA_KXZ          libpersona.dll
?SetPermissions@Script@@QEAAX_K@Z         libpersona.dll
?GetBits@Permissions@Scripting@@QEBA_KXZ  libmcp.dll
```

## 4. 脚本库（安装态）对照

| 文件 | 标签 | 压缩 | 说明 |
|---|---|---|---|
| `Resources\Affinity\scripts.propcol` | `spcS` | 无 | 程序自带示例库（24 个脚本） |
| `%APPDATA%\...\Common\3.0\user\scripts.propcol` | `spcS` | 无 | **用户脚本库**，权限位在这里 |
| `*.afscript` | `prcS` | zstd | 单脚本分发包 |
| `*.afscripts` | `rArB` | zstd | 多脚本集合包 |

容器 4CC 对照：`spcS`=Scps、`rArB`=BAr?、`nsrP`=Prsn（文档）、`gfnC`=Cnfg。

## 5. 打包/解包工具

| 工具 | 用途 |
|---|---|
| `scripts/make-afscript.mjs` | .js → .afscript（自动填所有尺寸与 CRC，**21 项自校验**：含解压回读逐字节比对 + 双 CRC32 回读比对） |
| `scripts/fix-script-perms.mjs` | 修补用户脚本库权限位 |
| 前期调研工具 | 一次性逆向脚本，能力已并入 `scripts/make-afscript.mjs` 的 21 项自校验 |

解包用 `zlib.createZstdDecompressSync()`（**需要 Node >= 22.15.0**；zstd API 自 22.15.0 / 23.8.0 提供。实测 22.22.2 与 24.15.0 均可用）。

## 6. 已知不确定项

- GUID（`diuU` 后 16 字节）是否被导入路径校验未验证 —— 待真机导入测试确认
- 时间戳语义（导出时刻 vs 其他）未完全确认
- `02 20 00 00 00`、`0x36`、`0x48`、`0x01000000` 等常量含义未知，但三样本一致，直接照抄
- 多脚本 `.afscripts`（`rArB`）的集合层结构未完整逆向，本工具只产出单脚本 `.afscript`