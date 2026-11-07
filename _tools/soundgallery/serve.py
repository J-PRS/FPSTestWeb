# Static server restricted to the three gallery dirs.
# Routes: /        -> soundgallery/
#         /vgs/... -> ../vgs_gallery/...
#         /ann/... -> ../announcer_gallery/...
import http.server, os, urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
MOUNTS = {'/vgs/': os.path.join(ROOT, '..', 'vgs_gallery'),
          '/ann/': os.path.join(ROOT, '..', 'announcer_gallery')}
MIME = {'.html':'text/html', '.js':'text/javascript', '.json':'application/json',
        '.wav':'audio/wav', '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.css':'text/css'}

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        # mounted under /voice on the tailscale funnel (game owns /)
        if path == '/voice':
            # no trailing slash would resolve relative refs to /data.js etc.
            self.send_response(301)
            self.send_header('Location', '/voice/')
            self.end_headers()
            return
        if path.startswith('/voice/'):
            path = path[6:] or '/'
        if path == '/':
            path = '/index.html'
        # files local to soundgallery (index.html, data.js) — no traversal
        if '/' not in path.strip('/'):
            full = os.path.normpath(os.path.join(ROOT, path.lstrip('/')))
            if full.startswith(os.path.normpath(ROOT)) and os.path.isfile(full):
                return self.send_file(full)
            return self.send_error(404)
        for mount, base in MOUNTS.items():
            if path.startswith(mount):
                rel = path[len(mount):].lstrip('/')
                if rel == '':
                    rel = 'index.html'
                full = os.path.normpath(os.path.join(base, rel))
                if not full.startswith(os.path.normpath(base)) or not os.path.isfile(full):
                    break
                return self.send_file(full)
        self.send_error(404)
    def send_file(self, full, mime=None):
        mime = mime or MIME.get(os.path.splitext(full)[1].lower(), 'application/octet-stream')
        data = open(full, 'rb').read()
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a):
        pass

http.server.ThreadingHTTPServer(('127.0.0.1', 8791), H).serve_forever()
