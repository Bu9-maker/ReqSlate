@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if "%ADMIN_PASSWORD%"=="" set "ADMIN_PASSWORD=admin123"
if "%PORT%"=="" set "PORT=3000"

echo.
echo   ReqSlate 工作任务清单
echo   ----------------------------------------
echo   访问地址： http://127.0.0.1:%PORT%
echo   管理密码： %ADMIN_PASSWORD%
echo.
echo   提示：要发给别人的链接，请用本机 IP 打开首页再复制
echo         例如 http://192.168.x.x:%PORT%
echo   停止：  按 Ctrl+C
echo.

node server.js

echo.
echo   服务已停止。
pause
