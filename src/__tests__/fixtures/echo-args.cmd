@echo off
REM Fixture: echo each argument on its own line so the test can verify
REM every argument arrives byte-for-byte without shell mangling.
setlocal enabledelayedexpansion
set COUNT=0
:loop
if "%~1"=="" goto done
set /a COUNT+=1
echo arg!COUNT!=%~1
shift
goto loop
:done
exit /b 0
