# Zero-install fallback server (Python 3):  python serve.py [port]
# Python's built-in server can mislabel .js files on some Windows PCs (which breaks the app), so types are set explicitly.
import http.server, os, sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    def log_message(self, *a):  # keep the window quiet
        pass

with http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler) as s:
    print(f'PhysioNotes running at http://localhost:{port}  (close this window to stop)', flush=True)
    s.serve_forever()
