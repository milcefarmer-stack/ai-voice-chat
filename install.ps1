# ============================================================
#  ai-voice-chat 一键安装脚本（Windows / PowerShell）
#  用法：右键"使用 PowerShell 运行"，或：
#    powershell -ExecutionPolicy Bypass -File .\install.ps1
# ============================================================
$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoDir

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  ai-voice-chat 安装程序" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# ---------- 1. 环境检查 ----------
function Test-Cmd($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}
if (-not (Test-Cmd node)) { Write-Host "❌ 未找到 Node.js，请先安装：https://nodejs.org" -ForegroundColor Red; exit 1 }
if (-not (Test-Cmd npm))  { Write-Host "❌ 未找到 npm。" -ForegroundColor Red; exit 1 }
Write-Host "✅ Node.js: $(node --version) / npm: $(npm --version)"

# ---------- 2. 安装依赖（自动生成 public/vendor） ----------
Write-Host "`n[1/5] 安装 npm 依赖（自动生成 VAD 本地资源）…"
# 先停掉上次运行启动的服务，否则旧进程可能占用 public/vendor 下的 wasm 文件导致 postinstall 失败
& (Join-Path $RepoDir "scripts\stop.ps1") | Out-Null
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host "❌ npm install 失败" -ForegroundColor Red; exit 1 }

# ---------- 3. 配置文件 ----------
Write-Host "`n[2/5] 检查 .env 配置…"
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "   已生成 .env，请编辑填入 LLM 的 API Key（默认智谱 GLM 示例）："
  Write-Host "   LLM_API_KEY=你的key （智谱 https://open.bigmodel.cn 获取；也可换硅基流动/DeepSeek/Ollama）"
  Write-Host "   ✅ 语音识别/合成默认走本地 sherpa-onnx 离线引擎，不需要任何 Key"
  Write-Host "   ⚠️ 不填 LLM Key 则打字/语音对话无法回答（语音识别本地仍可用）"
} else {
  Write-Host "   .env 已存在，跳过。"
}

# ---------- 4. Python 依赖（listen.py 录音用） ----------
Write-Host "`n[3/5] 检查 Python 录音依赖…"
if (Test-Cmd python) {
  # PS 5.1 下原生命令 stderr 会触发 $ErrorActionPreference='Stop' 中断脚本，改由 cmd 做重定向
  $savedEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  cmd /c "python -c ""import sounddevice"" 2>nul"
  $sdOk = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $savedEap
  if (-not $sdOk) {
    Write-Host "   安装 sounddevice…"
    pip install sounddevice
  } else {
    Write-Host "   sounddevice 已就绪。"
  }
} else {
  Write-Host "   ⚠️ 未找到 Python，listen.py（录音识别）不可用；speak/status 不受影响。"
}

# ---------- 5. 安装 voice-chat skill ----------
Write-Host "`n[4/5] 安装 voice-chat skill…"
$skillSrc = Join-Path $RepoDir "skill\voice-chat"
$targets = @()
if (Test-Path "$env:USERPROFILE\.claude\skills")   { $targets += "$env:USERPROFILE\.claude\skills\voice-chat" }   # Claude Code
if (Test-Path "$env:USERPROFILE\.agents\skills")   { $targets += "$env:USERPROFILE\.agents\skills\voice-chat" }   # OpenClaw 等 agent
if ($targets.Count -eq 0) { $targets += "$env:USERPROFILE\.claude\skills\voice-chat" }

foreach ($t in $targets) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $t) -Force | Out-Null
  Copy-Item $skillSrc $t -Recurse -Force
  # 写入应用目录，供 skill 的 status.ps1 使用
  [System.IO.File]::WriteAllText((Join-Path $t "appdir.txt"), $RepoDir, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "   → $t"
}

# ---------- 6. 启动验证 ----------
Write-Host "`n[5/5] 启动验证…"
& (Join-Path $RepoDir "scripts\start.ps1")

Write-Host "`n==============================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "  1. 浏览器打开 http://localhost:3000 体验语音对话" -ForegroundColor Green
Write-Host "  2. 在 Claude Code 中说"读出来""语音问我"即可使用 voice-chat skill" -ForegroundColor Green
Write-Host "  3. 若未填 LLM API Key：编辑 $RepoDir\.env" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
