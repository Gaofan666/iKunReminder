@echo off
rem DPI adaptation self-check: simulate several system scalings, measure the
rem on-screen PHYSICAL content size and save a screenshot for each.
rem Expectation: contentPhysical must be identical across all scalings.
setlocal
cd /d "%~dp0.."
set EXE=%CD%\node_modules\electron\dist\electron.exe
if not exist "%EXE%" ( echo [X] electron.exe not found & exit /b 1 )
if not exist "%CD%\.diag" mkdir "%CD%\.diag"
del /q "%CD%\.diag\summary.jsonl" 2>nul

for %%R in (1 1.25 1.5 2) do (
  echo === ratio=%%R ===
  "%EXE%" "%CD%" --diag=%%R --diag-shot="%CD%\.diag\shot-%%R.png" > "%CD%\.diag\run-%%R.log" 2>&1
)

echo === summary ===
type "%CD%\.diag\summary.jsonl" 2>nul
endlocal
