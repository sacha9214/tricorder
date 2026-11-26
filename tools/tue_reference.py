"""Recalcule les références TU/e avec un décalage temporel global (secondes) entre la vidéo et
l'ECG : la vidéo au temps t correspond à l'ECG au temps t + OFFSET. Le décalage est une
propriété du jeu de données (mesuré une fois, médiane sur tous les enregistrements avec
tools/lag-check.mjs), pas un réglage par vidéo.
Usage : python3 -I tools/tue_reference.py OFFSET
"""
import glob
import json
import os
import statistics
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "recordings", "tue")


def main():
    offset = float(sys.argv[1])
    m = json.load(open(os.path.join(DIR, "manifest.json")))
    for v in m["videos"]:
        rec = v["name"][4:]
        rr = glob.glob(os.path.join(DIR, f"{rec}_*RR-intervals.rr"))[0]
        beats = [tuple(map(float, l.split()[:2])) for l in open(rr) if len(l.split()) >= 2]
        ref_path = os.path.join(ROOT, v["ref"])
        old = json.load(open(ref_path))
        windows = []
        for w in old["windows"]:
            t = w["t"] + offset
            rrs = [r for (bt, r) in beats if t - 12 < bt <= t]
            ok = len(rrs) >= 6
            if ok:
                med = statistics.median(rrs)
                ok = all(abs(r - med) < 0.3 * med for r in rrs)
            windows.append({"t": w["t"], "bpm": round(60 / statistics.mean(rrs), 2) if rrs else None, "ok": ok})
        json.dump({"fs": None, "offset": offset, "windows": windows}, open(ref_path, "w"))
        print(f"{v['name']}: {sum(1 for w in windows if w['ok'])}/{len(windows)} windows")


if __name__ == "__main__":
    main()
