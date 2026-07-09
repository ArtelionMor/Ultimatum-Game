@echo off
:: 1. Aller dans le dossier du jeu (dossier du .bat lui-meme, portable)
cd /d "%~dp0"

:: 2. Lancer le serveur Python dans une nouvelle fenêtre PowerShell
start powershell -NoExit -Command "python -m http.server 8777 --directory 'Ultimatum Game/web'"

:: 3. Attendre 2 secondes pour laisser le temps au serveur de bien démarrer
timeout /t 2 /nobreak > NUL

:: 4. Ouvrir le lien automatiquement dans ton navigateur par défaut
start http://localhost:8777