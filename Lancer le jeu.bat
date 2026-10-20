@echo off
rem Market Ultimatum v2 : double-clic pour lancer le jeu.
rem Demarre le petit serveur local (s'il ne tourne pas deja) puis ouvre le navigateur.
rem Pour arreter le serveur : ferme la fenetre "Market Ultimatum - serveur".
cd /d "%~dp0"

netstat -ano | findstr /r /c:":8795 .*LISTENING" >nul
if errorlevel 1 (
  where py >nul 2>nul
  if errorlevel 1 (
    start "Market Ultimatum - serveur" /min python tools\serve.py 8795 .
  ) else (
    start "Market Ultimatum - serveur" /min py -3 tools\serve.py 8795 .
  )
  timeout /t 2 /nobreak >nul
)

start "" http://localhost:8795/
