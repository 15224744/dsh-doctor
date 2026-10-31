@echo off
setlocal
set "HERE=%~dp0"
set "NODE="

rem 1) DSH installed per-user (most common)
set "CAND=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if exist "%CAND%" set "NODE=%CAND%"

rem 2) DSH runtimes under the user's .dsh folder
if not defined NODE (
  set "CAND=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  if exist "%CAND%" set "NODE=%CAND%"
)

rem 3) DSH installed for all users
if not defined NODE (
  set "CAND=%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  if exist "%CAND%" set "NODE=%CAND%"
)

rem 4) node on PATH
if not defined NODE (
  for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
)

if not defined NODE (
  echo.
  echo  [!] Node.js not found.
  echo      DSH ships its own node.exe; if you installed DSH elsewhere,
  echo      open that folder and look for:
  echo        resources\runtime\primary-runtime\dependencies\node\bin\node.exe
  echo      then run:  "full\path\to\node.exe" "%HERE%dsh-doctor.mjs"
  echo.
  pause
  exit /b 2
)

echo Using node: %NODE%
echo.
"%NODE%" "%HERE%dsh-doctor.mjs" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" echo  [OK] nothing that would stop DSH from starting.
if "%RC%"=="1" echo  [!!] problems found - run again with:  fix
echo.
pause
exit /b %RC%
