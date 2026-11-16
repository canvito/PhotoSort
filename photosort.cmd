@echo off
rem Runs photosort.py with the "utils" conda env, so it works from any shell and any folder.
set "PY=%USERPROFILE%\miniconda3\envs\utils\python.exe"
if not exist "%PY%" (
    echo photosort: Python not found at %PY%
    echo Edit PY in this file, or see Setup in README.md.
    exit /b 2
)
"%PY%" "%~dp0photosort.py" %*
exit /b %ERRORLEVEL%
