import http.server, socketserver, os
os.chdir(os.path.join(os.path.dirname(__file__), "bin"))
PORT = 5200
with socketserver.TCPServer(("", PORT), http.server.SimpleHTTPRequestHandler) as httpd:
    print(f"Serving at http://localhost:{PORT}")
    httpd.serve_forever()
