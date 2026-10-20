# Static dev server that turns browser caching off, so edited modules
# show up on a plain reload (python -m http.server lets browsers reuse stale JS).
#   python tools/serve.py [port] [root]
import functools
import http.server
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8795
root = sys.argv[2] if len(sys.argv) > 2 else '.'
http.server.ThreadingHTTPServer(('', port), functools.partial(NoCache, directory=root)).serve_forever()
