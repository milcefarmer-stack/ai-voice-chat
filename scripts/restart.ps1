# restart.ps1 — 重启 ai-voice-chat 服务（先停后启）
# 用法：npm run restart
$ErrorActionPreference = 'SilentlyContinue'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

& (Join-Path $scriptDir 'stop.ps1')
Start-Sleep -Milliseconds 500
& (Join-Path $scriptDir 'start.ps1')
