@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" http://127.0.0.1:8730
where node >nul 2>nul && (
  node "%~dp0server.js"
) || (
  echo 未找到 node，请安装 Node.js 18+ 或使用托管版本：
  echo   C:\Users\sunjg\.workbuddy\binaries\node\versions\22.22.2-3\node.exe server.js
  pause
)
