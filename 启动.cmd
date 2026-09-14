@echo off
rem ============================================================
rem  Dian Zi Kun Kun - drink water / take a break reminder
rem  1) Electron desktop app (recommended): can jump to the
rem     foreground and play the animation when time is up.
rem  2) Fallback: open in Edge/Chrome app mode.
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "EXE=%~dp0node_modules\electron\dist\electron.exe"
if exist "%EXE%" goto rundesktop

echo [!] Electron not found in node_modules.
echo     Run:  npm install      (one time, needs internet)
echo     Falling back to browser mode...
echo.

set "URL=file:///%~dp0index.html"
set "URL=!URL:\=/!"
set "SIZE=--window-size=1220,880"

set "B=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%B%" goto useedge
set "B=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%B%" goto useedge

set "B=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%B%" goto usechrome
set "B=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%B%" goto usechrome
set "B=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%B%" goto usechrome

echo [!] Edge / Chrome not found. Opening with the default browser...
start "" "!URL!"
goto end

:rundesktop
start "" "%EXE%" "%~dp0."
goto end

:useedge
start "" "%B%" --app="!URL!" %SIZE% --no-first-run
goto end

:usechrome
start "" "%B%" --app="!URL!" %SIZE% --no-first-run
goto end

:end
endlocal
