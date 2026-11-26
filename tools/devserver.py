"""Serveur de développement local (127.0.0.1 uniquement).

- Sert le dossier du projet AVEC les requêtes partielles (Range) : le navigateur peut se
  déplacer dans les vidéos (le serveur http.server standard ne le permet pas).
- POST /save?name=fichier.bin : écrit le corps de la requête dans recordings/out/ (noms
  limités à [A-Za-z0-9_.-], pas de sous-dossiers), pour garder les mesures extraites
  par le navigateur et les analyser ensuite hors ligne.

Usage : python3 tools/devserver.py [port]
"""
import http.server
import os
import re
import sys
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "recordings", "out")
SAFE = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or os.path.isdir(path) or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
        size = os.path.getsize(path)
        if not m:
            return super().send_head()
        start = int(m.group(1)) if m.group(1) else max(0, size - int(m.group(2) or 0))
        end = int(m.group(2)) if m.group(1) and m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        while remaining > 0:
            chunk = source.read(min(1 << 16, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)
        self._remaining = None

    def do_POST(self):
        u = urlparse(self.path)
        name = parse_qs(u.query).get("name", [""])[0]
        if u.path != "/save" or not SAFE.match(name):
            self.send_error(400, "bad request")
            return
        n = int(self.headers.get("Content-Length", "0"))
        if n <= 0 or n > 200_000_000:
            self.send_error(413, "bad size")
            return
        os.makedirs(OUT, exist_ok=True)
        data = self.rfile.read(n)
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8767
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
