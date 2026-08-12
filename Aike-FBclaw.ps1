# Aike-FBclaw 桌面軟體啟動器（Phase 1 開發/便攜模式）
# 由桌面捷徑呼叫：隱藏 PowerShell 視窗執行，啟動 Electron 主進程。
# 負責：清掉會讓 Electron 無法啟動的環境變數、把受管 node 加入 PATH、
#       注入 DEEPSEEK_API_KEY、以 node 直接跑 electron cli（不閃黑色終端）。

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition

# 受管 node（開發機路徑；打包階段 Phase 2 會改為隨附 node 或不需要）
$nodeDir = "C:\Users\UR\.workbuddy\binaries\node\versions\22.22.2"
$nodeBin = Join-Path $nodeDir "node.exe"

# 清掉可能破壞 Electron 的環境變數
$env:NODE_OPTIONS = ""
$env:ELECTRON_RUN_AS_NODE = ""
$env:ELECTRON_NO_ATTACH_CONSOLE = ""
$env:NODE_ENV = "production"

# 讓 npx / tsx / openclaw 能解析到受管 node
$env:PATH = "$nodeDir;$env:PATH"

# API Key（若尚未設定則補預設；也可改由 .env 提供）
if (-not $env:DEEPSEEK_API_KEY) {
  $env:DEEPSEEK_API_KEY = "YOUR_DEEPSEEK_API_KEY"
}

# 用 node 直接執行 electron cli（避免 .cmd 包裝閃出終端）
$electronCli = Join-Path $root "node_modules\electron\cli.js"
Start-Process -FilePath $nodeBin -ArgumentList "$electronCli", "." -WorkingDirectory $root -WindowStyle Normal
