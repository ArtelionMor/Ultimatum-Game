"""Serveur statique du Level Designer.

Pourquoi pas `python -m http.server` : il renvoie Last-Modified, donc le
navigateur resert un style.css / app.js perimes apres chaque edition. Un
cache-buster `?v=` sur la page d'entree ne suffirait pas — il n'atteint pas les
imports de modules ES (model.js, charts.js, io.js), qui resteraient en cache.
On envoie donc Cache-Control: no-store : un simple F5 suffit toujours.

Sert la RACINE du repo : l'outil vit hors de web/ mais lit /web/config_export.json
et /web/sprites/.
"""

import functools
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_PORT = 8790


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    # 127.0.0.1, pas 0.0.0.0 : ce serveur expose tout le repo, il n'a rien a
    # faire sur le reseau local.
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print("Level Designer  ->  http://localhost:%d/tools/level-designer/" % port)
        print("racine servie   :  %s" % ROOT)
        print("(Ctrl+C ou fermer cette fenetre pour arreter)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\narret.")


if __name__ == "__main__":
    main()
