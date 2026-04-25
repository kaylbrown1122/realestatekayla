#!/usr/bin/env python3
"""
Local static server with SPA-style fallback: unknown paths serve index.html (like Vercel rewrites).
/api/* stays 404 unless you add files (use `vercel dev` for the API).
"""
import http.server
import os
import sys

DIRECTORY = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "3333"))


class SpaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        fpath = self.translate_path(self.path)
        if not os.path.exists(fpath) and not path.startswith("/api/"):
            self.path = "/index.html"
        return super().do_GET()


if __name__ == "__main__":
    os.chdir(DIRECTORY)
    try:
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), SpaHandler)
    except OSError as e:
        if e.errno == 48:  # Address already in use
            print(
                f"Port {PORT} is in use. Use another port, e.g.  "
                f"PORT=3333 python3 {os.path.basename(__file__)}",
                file=sys.stderr,
            )
            sys.exit(1)
        raise
    with httpd:
        print(f"http://127.0.0.1:{PORT}/")
        print(f"  (SPA fallback)  http://127.0.0.1:{PORT}/bu-seller-intake")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            sys.exit(0)
