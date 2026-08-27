# stop.ps1 — 停止 ai-voice-chat 服务并释放端口
# 双保险：先按 .server.pid 杀，再按端口扫描兜底，确保不留孤儿进程
# 用法：
#   npm run stop                 （等价于本脚本）
#   .\scripts\stop.ps1 -Port 3000
param(
  [int]$Port = 3000,
  [string]$AppDir = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'SilentlyContinue'
$pidFile = Join-Path $AppDir '.server.pid'
$killed = @()

# ---------- 1. 按 PID 文件精确停止 ----------
if (Test-Path $pidFile) {
  $saved = (Get-Content $pidFile -Raw).Trim()
  if ($saved) {
    Stop-Process -Id $saved -Force -ErrorAction SilentlyContinue
    $killed += $saved
    Write-Host "已按 PID 文件停止进程 $saved"
  }
  Remove-Item $pidFile -Force
}

# ---------- 2. 端口扫描兜底 ----------
$lines = netstat -ano | Select-String ":$Port\s.*LISTENING"
foreach ($l in $lines) {
  $parts = ($l.Line -split '\s+') | Where-Object { $_ }
  if ($parts.Count -ge 5) {
    $p = $parts[-1]
    if ($killed -notcontains $p) {
      Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
      $killed += $p
      Write-Host "已按端口扫描停止进程 $p"
    }
  }
}

Start-Sleep -Milliseconds 800
$still = netstat -ano | Select-String ":$Port\s.*LISTENING"
if ($still) {
  Write-Host "⚠️ 端口 $Port 仍被占用:" -ForegroundColor Yellow
  $still | ForEach-Object { Write-Host "   $($_.Line)" }
  exit 1
}
Write-Host "✅ 已停止，端口 $Port 已释放"
