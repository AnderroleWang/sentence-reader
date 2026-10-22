@echo off
setlocal
cd /d "%~dp0"
set "READER_PY=%~dp0runtime\python.exe"
if exist "%READER_PY%" (
  "%READER_PY%" -X utf8 server.py
  goto done
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -X utf8 server.py
  goto done
)
where python >nul 2>nul
if not errorlevel 1 (
  python -X utf8 server.py
  goto done
)
echo Python 3.9+ is required. Install Python and run start.cmd again.
:done
pause
