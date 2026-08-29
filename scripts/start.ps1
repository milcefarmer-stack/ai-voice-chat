# start.ps1 — 启动 ai-voice-chat 服务（后台运行，可反复复用）
# 特性：
#   - 若端口已被占用（旧实例/残留进程），自动先杀掉再启动，不会 EADDRINUSE
#   - 把进程 PID 写入 .server.pid，供 stop.ps1 精确停止
# 用法：
#   npm start                      （等价于本脚本）
#   .\scripts\start.ps1 -Port 3000
param(
  [int]$Port = 3000,
  [string]$AppDir = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'
Set-Location $AppDir
$pidFile = Join-Path $AppDir '.server.pid'

# ---------- 1. 若端口被占，先杀掉（复用无痛） ----------
function Get-ListenerPids([int]$port) {
  $pids = @()
  $lines = netstat -ano | Select-String ":$port\s.*LISTENING"
  foreach ($l in $lines) {
    $parts = ($l.Line -split '\s+') | Where-Object { $_ }
    if ($parts.Count -ge 5) { $pids += $parts[-1] }
  }
  return ($pids | Sort-Object -Unique)
}

$existing = @(Get-ListenerPids $Port)
if ($existing.Count -gt 0) {
  Write-Host "检测到端口 $Port 被占用（PID: $($existing -join ', ')），先停止旧实例…"
  foreach ($p in $existing) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
}

# ---------- 2. 选择可用的 Node（排除 Electron 内置运行时） ----------
# Electron 内置 Node（V8 版本号带 electron 字样）会拒绝原生 external buffer，
# 导致 sherpa-onnx 本地语音引擎不可用；优先选真正的 node.exe
function Get-RealNodeExe {
  try { $candidates = @(where.exe node 2>$null) | Where-Object { $_ } } catch { $candidates = @() }
  foreach ($n in $candidates) {
    try {
      $v = & $n -p 'process.versions.v8' 2>$null
      if ($v -and ($v -notmatch 'electron')) { return $n }
    } catch { }
  }
  return 'node'
}
$nodeExe = Get-RealNodeExe

# ---------- 3. 启动新实例（隐藏窗口，写 PID 文件） ----------
if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
$proc = Start-Process -FilePath $nodeExe -ArgumentList 'server/server.js' -WorkingDirectory $AppDir -WindowStyle Hidden -PassThru
[System.IO.File]::WriteAllText($pidFile, [string]$proc.Id, (New-Object System.Text.UTF8Encoding($false)))

# ---------- 4. 验证 ----------
Start-Sleep -Seconds 4
try {
  $cfg = Invoke-RestMethod -Uri "http://localhost:$Port/api/config" -TimeoutSec 10
  Write-Host "✅ 服务已启动: http://localhost:$Port （PID $($proc.Id)，Node: $nodeExe）"
  Write-Host "   LLM: $($cfg.model) / 识别: $($cfg.asrProvider) / 合成: $($cfg.ttsProvider)"
  if ($cfg.asrProvider -eq 'local-sherpa' -and -not $cfg.asrLocalReady) { Write-Host '   本地 ASR 模型加载中，几秒后就绪…' }
  if ($cfg.ttsProvider -eq 'local-sherpa' -and -not $cfg.ttsLocalReady) { Write-Host '   本地 TTS 模型加载中，几秒后就绪…' }
  Write-Host "   停止: npm run stop"
} catch {
  Write-Host "⚠️ 启动后未响应，请用前台模式看日志：npm run dev"
  exit 1
}
