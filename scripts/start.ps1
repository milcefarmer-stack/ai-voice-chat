# start.ps1 — 启动 ai-voice-chat 服务（pipecat 版，后台运行，可反复复用）
# 特性：
#   - 若端口已被占用（旧实例/残留进程），自动先杀掉再启动，不会 EADDRINUSE
#   - 首次运行自动完成：uv 依赖同步（.venv）+ 前端构建（frontend/dist）
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

# ---------- 0. 定位 uv（依赖管理，首次运行时安装） ----------
function Get-UvPython {
  # 用 pip 装的 uv 可以 `python -m uv` 调起；返回可用的 python 解释器路径
  try { $candidates = @(where.exe python 2>$null) | Where-Object { $_ } } catch { $candidates = @() }
  foreach ($py in $candidates) {
    try {
      & $py -m uv --version 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { return $py }
    } catch { }
  }
  return $null
}
$uvPython = Get-UvPython
if (-not $uvPython) {
  Write-Host "未找到 uv，正在安装（pip install uv）…"
  & pip install uv -i https://pypi.org/simple
  $uvPython = Get-UvPython
  if (-not $uvPython) { Write-Host "❌ uv 安装失败，请手动运行: pip install uv"; exit 1 }
}

# ---------- 1. 依赖同步（.venv 不存在或缺失时执行，之后秒过） ----------
$venvPython = Join-Path $AppDir '.venv\Scripts\python.exe'
$needSync = -not (Test-Path $venvPython)
if (-not $needSync) {
  # pyproject/锁文件比 .venv 新（如刚拉取代码）时重新同步
  $lock = Get-ChildItem $AppDir -Filter 'uv.lock' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($lock -and $lock.LastWriteTime -gt (Get-Item $venvPython).LastWriteTime) { $needSync = $true }
}
if ($needSync) {
  Write-Host "同步 Python 依赖（首次可能需要几分钟）…"
  & $uvPython -m uv sync --quiet
  if ($LASTEXITCODE -ne 0) { Write-Host "❌ uv sync 失败"; exit 1 }
}

# ---------- 2. 前端构建（dist 缺失时执行） ----------
if (-not (Test-Path (Join-Path $AppDir 'frontend\dist\app.js'))) {
  Write-Host "构建前端（npm run build:web）…"
  & npm run build:web
  if ($LASTEXITCODE -ne 0) { Write-Host "❌ 前端构建失败（需要 Node.js）"; exit 1 }
}

# ---------- 3. 若端口被占，先杀掉（复用无痛） ----------
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

# ---------- 4. 启动新实例（隐藏窗口，日志落盘 logs/，写 PID 文件） ----------
$logDir = Join-Path $AppDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$serverLog = Join-Path $logDir 'server.log'
$serverErrLog = Join-Path $logDir 'server.err.log'
if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
$proc = Start-Process -FilePath $venvPython -ArgumentList '-m', 'voice_chat.main' -WorkingDirectory $AppDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError $serverErrLog
[System.IO.File]::WriteAllText($pidFile, [string]$proc.Id, (New-Object System.Text.UTF8Encoding($false)))

# ---------- 5. 验证（本地模型加载需要十几秒，轮询等待） ----------
$ready = $false
$cfg = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  try {
    $cfg = Invoke-RestMethod -Uri "http://localhost:$Port/api/config" -TimeoutSec 5
    $ready = $true
    break
  } catch { }
}
if ($ready) {
  Write-Host "✅ 服务已启动: http://localhost:$Port （PID $($proc.Id)，pipecat 管线）"
  Write-Host "   LLM: $($cfg.model) / 识别: $($cfg.asrProvider) / 合成: $($cfg.ttsProvider)"
  if ($cfg.asrProvider -eq 'local-sherpa' -and -not $cfg.asrLocalReady) { Write-Host '   本地 ASR 模型加载中，几秒后就绪…' }
  if ($cfg.ttsProvider -eq 'local-sherpa' -and -not $cfg.ttsLocalReady) { Write-Host '   本地 TTS 模型加载中，几秒后就绪…' }
  Write-Host "   停止: npm run stop"
} else {
  Write-Host "⚠️ 启动后未响应，请用前台模式看日志：npm run dev"
  exit 1
}
