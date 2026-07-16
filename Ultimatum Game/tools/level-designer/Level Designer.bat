@echo off
setlocal enabledelayedexpansion

REM Market Ultimatum - Level Designer launcher
REM Usage: double-clic, ou "Level Designer.bat nobrowser" pour ne pas ouvrir le navigateur.

set "PORT=8790"
set "URL=http://localhost:%PORT%/tools/level-designer/"

REM Le serveur doit servir la RACINE du repo : l'outil vit hors de web/ mais lit
REM /web/config_export.json et /web/sprites/. Servir web/ donnerait un 404.
cd /d "%~dp0..\.."
if not exist "web\config_export.json" (
  echo [X] Racine du repo introuvable depuis "%~dp0".
  echo     Garde ce .bat dans tools\level-designer\.
  pause
  exit /b 1
)

REM --- Python ---
set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
  echo [X] Python introuvable dans le PATH.
  echo     Installe-le depuis https://www.python.org/downloads/ ^(coche "Add to PATH"^).
  pause
  exit /b 1
)

REM --- Serveur deja actif ? ---
call :probe
if !errorlevel!==0 (
  echo [i] Serveur deja actif sur le port %PORT%.
  goto open
)

echo [+] Demarrage du serveur sur http://localhost:%PORT% ...
REM serve.py (et pas -m http.server) : il envoie Cache-Control: no-store, sinon
REM le navigateur resert un CSS/JS perime apres chaque edition de l'outil.
start "level-designer (ferme cette fenetre pour arreter)" /min %PY% "%~dp0serve.py" %PORT%

for /l %%i in (1,1,30) do (
  call :probe
  if !errorlevel!==0 goto open
  timeout /t 1 /nobreak >nul
)
echo [X] Le serveur n'a pas repondu sur le port %PORT%.
echo     Le port est peut-etre occupe par une autre application.
pause
exit /b 1

:open
if /i "%~1"=="nobrowser" (
  echo [i] %URL%
  exit /b 0
)

REM Chrome ou Edge : la sauvegarde directe dans leveldesign.json utilise
REM l'API File System Access, absente de Firefox et Safari.
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "!CHROME!" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "!CHROME!" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if exist "!CHROME!" (
  start "" "!CHROME!" "%URL%"
) else (
  start "" msedge "%URL%"
)
echo [OK] Level Designer ouvert : %URL%
exit /b 0

REM --- Le port repond-il ? errorlevel 0 = oui ---
:probe
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
exit /b !errorlevel!
