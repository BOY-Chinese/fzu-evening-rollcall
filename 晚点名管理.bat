@echo off
chcp 936 >nul
title 晚点名自动签到 - 管理面板
cd /d "%~dp0"
setlocal

rem 开机自启入口（由 autorun.vbs 隐藏调用）
if /i "%~1"=="/AUTO" goto AUTOSTART

:MENU
cls
echo ==========================================
echo    晚点名自动签到 - 管理面板
echo ==========================================
echo.
echo   [1] 添加/修改 账号和签到地点
echo   [2] 显示已添加账号和签到地点
echo   [3] 开机自动运行 开/关
echo   [4] 立即测试一次签到
echo   [5] 退出
echo.
set "choice="
set /p choice=请输入序号后回车: 
if "%choice%"=="1" goto ADD
if "%choice%"=="2" goto SHOW
if "%choice%"=="3" goto AUTORUN
if "%choice%"=="4" goto TEST
if "%choice%"=="5" exit /b 0
goto MENU

:ADD
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 https://nodejs.org
  pause
  goto MENU
)
node manage.js
echo.
pause
goto MENU

:SHOW
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 https://nodejs.org
  pause
  goto MENU
)
node manage.js --show
echo.
pause
goto MENU

:AUTORUN
cscript //nologo "%~dp0scripts\toggle-autostart.vbs"
echo.
pause
goto MENU

:TEST
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 https://nodejs.org
  pause
  goto MENU
)
echo 提示：将跳过时间窗立即尝试一次签到，用于验证链路。
pause
node index.js --now
echo.
pause
goto MENU

:AUTOSTART
rem 隐藏运行入口：不显示任何窗口，日志写入 logs\watch.log
if not exist logs mkdir logs
node index.js --watch >> logs\watch.log 2>&1
exit /b 0
