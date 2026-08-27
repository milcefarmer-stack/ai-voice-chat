# speak.ps1 — 朗读文本（调用本地 ai-voice-chat 的 /api/tts）
# 用法：
#   speak.ps1 -Text "你好"           直接传文本
#   speak.ps1 -TextFile C:\tmp\a.txt 传 UTF-8 文本文件（中文推荐，避免命令行编码问题）
#   echo 你好 | speak.ps1            管道传入
#   speak.ps1 -Text "你好" -Speed 1.1 调语速（0.25~4.0）
param(
  [string]$Text,
  [string]$TextFile,
  [double]$Speed = 1.0,
  [string]$Server = "http://localhost:3000"
)
$ErrorActionPreference = 'Stop'

if ($TextFile) {
  $Text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
}
if (-not $Text) {
  $Text = ($input | Out-String).Trim()
}
if (-not $Text) {
  Write-Error '缺少文本：用 -Text "..." 或 -TextFile path 或管道传入'
  exit 1
}

$body = @{ text = $Text; stream = $false; format = 'wav'; speed = $Speed } | ConvertTo-Json -Compress
$tmp = Join-Path $env:TEMP ("voice_" + [guid]::NewGuid().ToString('N') + ".wav")

try {
  # 用 UTF-8 字节发送，避免中文乱码
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  Invoke-WebRequest -Uri "$Server/api/tts" -Method Post `
    -ContentType 'application/json; charset=utf-8' -Body $bytes `
    -OutFile $tmp -UseBasicParsing | Out-Null

  if ((Get-Item $tmp).Length -lt 100) {
    Write-Error '合成结果异常（音频过小），请检查服务日志'
    exit 1
  }
  $player = New-Object System.Media.SoundPlayer $tmp
  $player.PlaySync()
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
