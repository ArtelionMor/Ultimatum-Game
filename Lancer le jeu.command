#!/bin/bash
# Market Ultimatum : double-clic pour lancer le jeu (Mac).
# Demarre le petit serveur local (s'il ne tourne pas deja) puis ouvre le navigateur.
# Pour arreter le serveur : ferme cette fenetre du Terminal.
cd "$(dirname "$0")"

URL=http://localhost:8795/

if lsof -iTCP:8795 -sTCP:LISTEN >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

python3 tools/serve.py 8795 . &
sleep 1
open "$URL"
echo "Serveur lance sur $URL. Ferme cette fenetre pour l'arreter."
wait
