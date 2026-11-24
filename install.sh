#!/bin/sh
# install.sh — 台灣通 一鍵安裝（macOS／Linux）：確認 Node.js 18 以上 → 執行 tools/setup.mjs
# 用法：sh install.sh [--yes] [--no-data] [--transit] [--test] [--start] [--force]
set -e
cd "$(dirname "$0")"
major=0
if command -v node >/dev/null 2>&1; then major=$(node -p 'process.versions.node.split(".")[0]'); fi
if [ "$major" -lt 18 ]; then
  if [ "$major" -eq 0 ]; then echo "找不到 Node.js。"; else echo "Node.js 版本太舊（$(node --version)），需要 18 以上。"; fi
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    printf "要用 Homebrew 安裝 Node.js LTS（brew install node@22）嗎？[Y/n] "; read a
    case "$a" in ""|y|Y|yes) brew install node@22 && brew link --overwrite --force node@22 ;; *) echo "請到 https://nodejs.org 安裝 LTS 版後再執行一次。"; exit 1 ;; esac
  else
    echo "請先安裝 Node.js 18 以上（建議 22 LTS）："
    echo "  • 官方安裝檔：https://nodejs.org"
    echo "  • 或用 nvm：https://github.com/nvm-sh/nvm  →  nvm install 22"
    exit 1
  fi
fi
exec node tools/setup.mjs "$@"
