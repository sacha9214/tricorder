"""Télécharge des sujets MCD-rPPG (caméra de face, repos + après effort), convertit les vidéos
pour le navigateur, calcule la référence par fenêtre et les ajoute à recordings/mcd/manifest.json.

Usage : python3 -I tools/mcd_fetch.py NOMBRE_DE_SUJETS [graine]
Les fichiers .avi d'origine sont supprimés après conversion. Tout reste dans recordings/ (hors Git).
"""
import csv
import json
import os
import random
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "recordings", "mcd")
BASE = "https://huggingface.co/datasets/kyegorov/mcd_rppg/resolve/main/"
MANIFEST = os.path.join(DIR, "manifest.json")


def log(msg):
    print(msg, flush=True)


def fetch(rel, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    tmp = dest + ".part"
    with urllib.request.urlopen(BASE + rel, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)


def load_manifest():
    if os.path.exists(MANIFEST):
        with open(MANIFEST) as f:
            return json.load(f)
    return {"complete": False, "videos": []}


def save_manifest(m):
    tmp = MANIFEST + ".tmp"
    with open(tmp, "w") as f:
        json.dump(m, f, indent=1)
    os.replace(tmp, MANIFEST)


def main():
    n = int(sys.argv[1])
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 7
    with open(os.path.join(DIR, "db.csv")) as f:
        rows = [r for r in csv.DictReader(f) if r["camera"] == "FullHDwebcam"]
    meta = {}
    for r in rows:
        meta.setdefault(r["patient_id"], {})[r["step"]] = r
    ids = sorted(i for i, v in meta.items() if "before" in v and "after" in v)
    random.Random(seed).shuffle(ids)
    chosen = ids[:n]
    if "1020" not in chosen:
        chosen = ["1020"] + chosen[: n - 1]
    m = load_manifest()
    done = {v["name"] for v in m["videos"]}
    for pid in chosen:
        for step in ("before", "after"):
            name = f"mcd_{pid}_{step}"
            if name in done:
                continue
            r = meta[pid][step]
            avi = os.path.join(DIR, f"{pid}_FullHDwebcam_{step}.avi")
            mp4 = os.path.join(DIR, f"{pid}_front_{step}.mp4")
            ppg = os.path.join(DIR, f"ppg_{pid}_{step}.txt")
            ref = os.path.join(DIR, f"ref_{pid}_{step}.json")
            try:
                fetch(r["ppg_sync"], ppg)
                if not os.path.exists(mp4):
                    fetch(r["video"], avi)
                    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", avi, "-c:v", "libx264", "-crf", "10",
                                    "-preset", "fast", "-g", "10", "-bf", "0", "-pix_fmt", "yuv420p", "-an", mp4],
                                   check=True, stderr=subprocess.DEVNULL)
                    os.remove(avi)
                frames = sum(1 for _ in open(ppg))
                out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                      "-of", "default=nw=1:nk=1", mp4], capture_output=True, text=True, check=True)
                duration = float(out.stdout.strip())
                with open(ref, "w") as f:
                    subprocess.run(["node", "tools/mcd-reference.mjs", ppg, str(duration)], cwd=ROOT, stdout=f, check=True,
                                   stderr=subprocess.DEVNULL)
                checked = subprocess.run(["node", "tools/mcd-refcheck.mjs", ppg, ref], cwd=ROOT, capture_output=True,
                                         text=True, check=True)
                with open(ref, "w") as f:
                    f.write(checked.stdout)
            except Exception as e:  # un sujet raté ne bloque pas les autres
                log(f"FAILED {name}: {e}")
                continue
            m = load_manifest()
            m["videos"].append({
                "name": name, "mp4": f"recordings/mcd/{os.path.basename(mp4)}",
                "ref": f"recordings/mcd/{os.path.basename(ref)}", "fps": frames / duration,
                "sex": r["sex"], "age": r["age"], "bmi": r["bmi"], "step": step,
            })
            save_manifest(m)
            log(f"ready {name} ({len(m['videos'])})")
    m = load_manifest()
    m["complete"] = True
    save_manifest(m)
    log("complete")


if __name__ == "__main__":
    main()
