<#
  run-tool.ps1 —— skill 内部稳定启动入口（**这是权威入口**）

  放在 skill 根目录（本文件所在目录），因此无论整个 skill 被复制到哪里都能工作：
    - <repo>\affinity script 0.1\run-tool.ps1
    - <anywhere>\.agents\skills\affinity-script\run-tool.ps1

  与仓库根目录的 run-affinity-tool.ps1 的关系：后者是本文件的转发壳，
  保留它是为了「从仓库根目录也能一条命令跑」的习惯。两边行为一致。

  用法：
    .\run-tool.ps1 validate .\我的脚本.js
    .\run-tool.ps1 make-afscript .\我的脚本.js --title "标题"
    .\run-tool.ps1 mcp-client --discover
    .\run-tool.ps1 probe.js

  从任意工作目录运行都可以：路径全部基于 $PSScriptRoot 解析，
  参数通过数组转发（不走字符串），因此含空格、中文、引号、
  以 - 开头的值都能原样送达。
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [string] $Tool,

    # ValueFromRemainingArguments：原样接收剩余 token，不做拆分/拼接
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]] $ToolArgs
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# 工具名 → 文件的**显式映射**
#
# 不能用"$Tool + '.mjs'" 拼扩展名：
#   - probe 是 .js（要丢进 Affinity 跑，不是 Node 工具）
#   - 将来可能有 .cjs / 无扩展名的工具
# 未知名字要报错退出（码 2），而不是让 Node 去报 MODULE_NOT_FOUND。
# ---------------------------------------------------------------------------
$script:TOOL_MAP = @{
    'validate'          = 'scripts\validate.mjs'
    'make-afscript'     = 'scripts\make-afscript.mjs'
    'mcp-client'        = 'scripts\mcp-client.mjs'
    'fix-script-perms'  = 'scripts\fix-script-perms.mjs'
    'sdk-lookup'        = 'scripts\sdk-lookup.mjs'
    'scan-strings'      = 'scripts\scan-strings.mjs'
    # 环境探针：要在 Affinity 里运行，不是用 Node 启动
    'probe'             = 'scripts\probe.js'
    'probe.js'          = 'scripts\probe.js'
    'tests'             = 'tests\run-tests.mjs'
}

if (-not $script:TOOL_MAP.ContainsKey($Tool)) {
    [Console]::Error.WriteLine(("未知工具: {0}`n可用: {1}" -f $Tool, (($script:TOOL_MAP.Keys | Sort-Object) -join ', ')))
    exit 2
}

$skillRoot = $PSScriptRoot
$scriptPath = Join-Path $skillRoot $script:TOOL_MAP[$Tool]

if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    [Console]::Error.WriteLine("找不到工具文件: $scriptPath")
    exit 1
}

# probe.js 是给 Affinity 的脚本，不能误用 Node 执行。输出路径后由调用方复制/粘贴到 Affinity。
if ($Tool -eq 'probe' -or $Tool -eq 'probe.js') {
    Write-Output $scriptPath
    exit 0
}


# ---------------------------------------------------------------------------
# 定位 Node.js
#   ① $env:AFFINITY_NODE 显式指定
#   ② Codex bundled runtime
#   ③ PATH 里的 node.exe
# 注意：打包器需要 Node >= 22.15.0（zstd API 自 22.15.0 / 23.8.0 提供）。
# ---------------------------------------------------------------------------
$node = $env:AFFINITY_NODE
if (-not $node) {
    $candidates = @(
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),
        (Join-Path $env:USERPROFILE '.codex\runtimes\node\node.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { $node = $c; break }
    }
}
if (-not $node) {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
    [Console]::Error.WriteLine('未找到 Node.js。安装 Node 18+（打包器需 22.15+，推荐 24+），或设置 $env:AFFINITY_NODE 指向 node.exe。')
    exit 1
}

if ($env:AFFINITY_TOOL_DEBUG) {
    Write-Host "[run-tool] node= $node"
    Write-Host "[run-tool] tool = $scriptPath"
}

# 数组 splatting：参数逐个传递，不经过字符串解析。
# 这样 `--title "含 空格 和中文"`、`--exec '-x'`、含引号的路径都能原样送达 Node。
& $node $scriptPath @ToolArgs
exit $LASTEXITCODE
