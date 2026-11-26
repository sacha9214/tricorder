"""Prépare le jeu TU/e (Hoffman & Lakens, 4TU) extrait par tools/remote_zip.py :
conversion des vidéos pour le navigateur, référence par fenêtre à partir des intervalles RR
de l'ECG, et manifeste recordings/tue/manifest.json pour tools/batch-extract.js.
Tourne en boucle jusqu'à la fin de l'extraction (ligne « done » dans fetch.log).

Licence du jeu : usage personnel et de recherche, pas de redistribution — tout reste local.
"""
import glob
import json
import os
import re
import statistics
import subprocess
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "recordings", "tue")
MANIFEST = os.path.join(DIR, "manifest.json")
SKIN = {"P1": "bright", "P2": "intermediate", "P3": "dark"}  # étiquettes des auteurs


def reference(rr_path, duration):
    beats = []
    for line in open(rr_path):
        parts = line.split()
        if len(parts) >= 2:
            beats.append((float(parts[0]), float(parts[1])))
    windows = []
    t = 12.0
    while t <= duration + 1e-9:
        rr = [r for (bt, r) in beats if t - 12 < bt <= t]
        ok = len(rr) >= 6
        bpm = 60 / statistics.mean(rr) if rr else float("nan")
        if ok:
            med = statistics.median(rr)
            # Battement manqué ou parasite : intervalle très différent de la médiane.
            ok = all(abs(r - med) < 0.3 * med for r in rr)
        windows.append({"t": round(t, 2), "bpm": round(bpm, 2) if rr else None, "ok": ok})
        t += 0.5
    return {"fs": None, "windows": windows}


def main():
    while True:
        finished = os.path.exists(os.path.join(DIR, "fetch.log")) and "done" in open(os.path.join(DIR, "fetch.log")).read()
        m = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else {"complete": False, "videos": []}
        have = {v["name"] for v in m["videos"]}
        for avi in sorted(glob.glob(os.path.join(DIR, "*edited.avi"))):
            rec = re.match(r"(P\d)(\w+?)[-_]edited\.avi", os.path.basename(avi))
            if not rec:
                continue
            pid, cond = rec.group(1), rec.group(2)
            name = f"tue_{pid}{cond}"
            rr = [p for p in glob.glob(os.path.join(DIR, f"{pid}{cond}_*RR-intervals.rr"))]
            if name in have or not rr:
                continue
            mp4 = os.path.join(DIR, f"{pid}{cond}.mp4")
            # Les vidéos sont « portrait » avec l'image utile en bande au milieu (barres noires) :
            # on recadre sur l'image utile, en pleine résolution, pour garder un visage assez grand.
            det = subprocess.run(["ffmpeg", "-v", "info", "-ss", "30", "-t", "3", "-i", avi, "-vf", "cropdetect=24:2:0",
                                  "-f", "null", "-"], capture_output=True, text=True).stderr
            crops = re.findall(r"crop=\d+:\d+:\d+:\d+", det)
            crop = max(set(crops), key=crops.count) if crops else "crop=iw:ih:0:0"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", avi, "-vf", crop, "-c:v", "libx264", "-crf", "10",
                            "-preset", "fast", "-g", "10", "-bf", "0", "-pix_fmt", "yuv420p", "-an", mp4], check=True)
            dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
                                        "default=nw=1:nk=1", mp4], capture_output=True, text=True, check=True).stdout)
            nb = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-count_packets", "-show_entries",
                                 "stream=nb_read_packets", "-of", "default=nw=1:nk=1", mp4], capture_output=True, text=True,
                                check=True).stdout
            ref = reference(rr[0], dur)
            ref_path = os.path.join(DIR, f"ref_{pid}{cond}.json")
            json.dump(ref, open(ref_path, "w"))
            m = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else {"complete": False, "videos": []}
            m["videos"].append({"name": name, "mp4": f"recordings/tue/{os.path.basename(mp4)}",
                                "ref": f"recordings/tue/{os.path.basename(ref_path)}", "fps": int(nb) / dur,
                                "participant": pid, "skin_label": SKIN[pid], "condition": cond})
            json.dump(m, open(MANIFEST + ".tmp", "w"), indent=1)
            os.replace(MANIFEST + ".tmp", MANIFEST)
            os.remove(avi)
            open(avi + ".converted", "w").close()  # pour ne pas le retélécharger
            okw = sum(1 for w in ref["windows"] if w["ok"])
            print(f"ready {name}: {dur:.0f} s, {okw}/{len(ref['windows'])} reference windows", flush=True)
        if finished and not any(
            f"tue_{os.path.basename(a)[:2]}" for a in glob.glob(os.path.join(DIR, "*edited.avi"))
        ):
            m = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else {"complete": False, "videos": []}
            m["complete"] = True
            json.dump(m, open(MANIFEST, "w"), indent=1)
            print("complete", flush=True)
            return
        time.sleep(20)


if __name__ == "__main__":
    main()
