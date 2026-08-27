# status.ps1 — 检查本地 ai-voice-chat 服务是否运行，可选自动启动
# 用法：
#   status.ps1             查看状态（自动从 appdir.txt 读取应用目录）
#   status.ps1 -AppDir D:\path\to\ai-voice-chat  手动指定应用目录
#   status.ps1 -Start      未运行时自动 npm start
# 应用目录优先级：-AppDir 参数 > 本脚本同级的 appdir.txt > 默认路径
param(
  [string]$Server = "http://localhost:3000",
  [switch]$Start,
  [string]$AppDir = ""
)
$ErrorActionPreference = 'SilentlyContinue'

# 解析应用目录
if (-not $AppDir) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $appdirFile = Join-Path (Split-Path -Parent $scriptDir) 'appdir.txt'
  if (Test-Path $appdirFile) {
    $AppDir = (Get-Content $appdirFile -Raw -Encoding UTF8).Trim()
  }
}
if (-not $AppDir) {
  $AppDir = "C:\ai-voice-chat"
}

function Get-Cfg {
  try {
    return Invoke-RestMethod -Uri "$Server/api/config" -Method Get -TimeoutSec 5
  } catch {
    return $null
  }
}

$cfg = Get-Cfg
if ($cfg) {
  Write-Host "服务运行中: $Server"
  Write-Host "  LLM: $($cfg.model)"
  Write-Host "  TTS: $($cfg.ttsModel) / $($cfg.ttsVoice)"
  Write-Host "  ASR: $($cfg.asrModel)"
  exit 0
}

if (-not $Start) {
  Write-Host "服务未运行（$Server）。"
  Write-Host "  启动：cd $AppDir && npm start"
  Write-Host "  或本脚本加 -Start 参数自动启动。"
  exit 1
}

Write-Host "服务未运行，正在启动…"
if (-not (Test-Path (Join-Path $AppDir 'server\server.js'))) {
  Write-Host "找不到应用目录：$AppDir"
  Write-Host "请用 -AppDir 指定，或运行仓库里的 install.ps1 完成安装。"
  exit 1
}
Start-Process -FilePath 'node' -ArgumentList 'server/server.js' -WorkingDirectory $AppDir -WindowStyle Hidden
Start-Sleep -Seconds 4

$cfg = Get-Cfg
if ($cfg) {
  Write-Host "启动成功: $Server"
  Write-Host "  LLM: $($cfg.model)"
  exit 0
}
Write-Host "启动失败，请手动运行：cd $AppDir && npm start"
exit 1
