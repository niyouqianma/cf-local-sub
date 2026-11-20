$ErrorActionPreference = 'Stop'
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $RootDir
if (-not $env:PORT) { $env:PORT = '8787' }
Write-Host "Starting cf-local-sub on http://127.0.0.1:$($env:PORT) ..." -ForegroundColor Green
Start-Job -ScriptBlock {
  param($u)
  Start-Sleep -Milliseconds 900
  Start-Process $u
} -ArgumentList "http://127.0.0.1:$($env:PORT)" | Out-Null
& node src/server.mjs
