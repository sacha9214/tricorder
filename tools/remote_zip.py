"""Lit un .zip distant sans le télécharger en entier, grâce aux requêtes partielles (Range).

  python3 -I tools/remote_zip.py list URL
  python3 -I tools/remote_zip.py get URL DOSSIER_DE_SORTIE MOTIF_REGEX

Le zipfile de Python lit le répertoire central puis seulement les entrées demandées.
"""
import io
import os
import time
import re
import sys
import urllib.request
import zipfile

BLOCK = 4 << 20


class RangeFile(io.RawIOBase):
    def __init__(self, url):
        self.url, self.pos, self.cache = url, 0, {}
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def _block(self, i):
        if i not in self.cache:
            if len(self.cache) > 8:
                self.cache.pop(next(iter(self.cache)))
            start, end = i * BLOCK, min(self.size, (i + 1) * BLOCK) - 1
            for attempt in range(8):
                try:
                    req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}"})
                    with urllib.request.urlopen(req, timeout=120) as r:
                        self.cache[i] = r.read()
                    break
                except Exception:  # erreur passagère du serveur : on réessaie en attendant de plus en plus
                    if attempt == 7:
                        raise
                    time.sleep(2 ** attempt)
        return self.cache[i]

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        got = 0
        while got < n:
            i, off = divmod(self.pos, BLOCK)
            chunk = self._block(i)[off:off + n - got]
            b[got:got + len(chunk)] = chunk
            got += len(chunk)
            self.pos += len(chunk)
        return got


def main():
    cmd, url = sys.argv[1], sys.argv[2]
    z = zipfile.ZipFile(io.BufferedReader(RangeFile(url), buffer_size=1 << 20))
    if cmd == "list":
        for i in z.infolist():
            print(f"{i.file_size:>13} {i.compress_type} {i.filename}")
        return
    out, pat = sys.argv[3], re.compile(sys.argv[4])
    os.makedirs(out, exist_ok=True)
    for i in z.infolist():
        if i.is_dir() or not pat.search(i.filename):
            continue
        dest = os.path.join(out, os.path.basename(i.filename))
        if os.path.exists(dest + ".converted") or (os.path.exists(dest) and os.path.getsize(dest) == i.file_size):
            continue
        with z.open(i) as src, open(dest + ".part", "wb") as f:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        os.replace(dest + ".part", dest)
        print(f"got {os.path.basename(i.filename)} ({i.file_size} bytes)", flush=True)


if __name__ == "__main__":
    main()
