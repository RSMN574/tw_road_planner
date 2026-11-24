# install.ps1 — 台灣通 一鍵安裝（Windows）：確認 Node.js（沒有就詢問後用 winget 安裝 LTS）→ 執行 tools/setup.mjs
# 用法：雙擊 install.cmd，或在 PowerShell：  .install.ps1  [--yes] [--no-data] [--transit] [--test] [--start] [--force]
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Get-NodeMajor {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { return 0 }
  $v = (& node --version) -replace '^v', ''
  return [int]($v.Split('.')[0])
}
function Update-PathFromRegistry {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$m;$u"
}

$major = Get-NodeMajor
if ($major -lt 18) {
  if ($major -eq 0) { Write-Host '找不到 Node.js。' -ForegroundColor Yellow } else { Write-Host "Node.js 版本太舊（$(& node --version)），需要 18 以上。" -ForegroundColor Yellow }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    $a = Read-Host '要用 winget 安裝 Node.js LTS 嗎？（會顯示 winget 的條款請你同意）[Y/n]'
    if ($a -eq '' -or $a -match '^[yY]') {
      & winget install -e --id OpenJS.NodeJS.LTS
      if ($LASTEXITCODE -ne 0) { Write-Host 'winget 安裝失敗；請到 https://nodejs.org 下載 LTS 版安裝後再執行一次。' -ForegroundColor Red; exit 1 }
      Update-PathFromRegistry
      $major = Get-NodeMajor
      if ($major -lt 18) { Write-Host 'Node.js 已安裝，但這個視窗還找不到它：請關掉視窗後重新執行 install.cmd。' -ForegroundColor Yellow; exit 1 }
    } else { Write-Host '請到 https://nodejs.org 下載 LTS 版安裝後再執行一次。'; exit 1 }
  } else { Write-Host '請到 https://nodejs.org 下載 LTS 版（18 以上，建議 22）安裝後再執行一次。' -ForegroundColor Yellow; exit 1 }
}

& node tools/setup.mjs @args
exit $LASTEXITCODE
