// Évaluation sur une vidéo de jeu de données, dans le navigateur (le suivi du visage a besoin
// de MediaPipe). extract() lit la vidéo image par image ; score() compare chaque fenêtre de 12 s
// à une référence { fs, windows: [{ t, bpm, ok }] } (tools/mcd-reference.mjs + mcd-refcheck.mjs).
import { slidingAnalysis, HrTracker, DEFAULT_MOTION } from '../js/dsp.js';
import { Extractor, faceRegions } from '../js/extract.js';
import { nextTs } from '../js/landmarker.js';
import { loadLandmarker } from '../js/landmarker.js';
import { videoFrames, measureFrame } from '../js/frames.js';

export async function extract(url, fps = 30, onProgress = () => {}) {
  const face = await loadLandmarker();
  // Chargée en mémoire (blob) : on peut toujours s'y déplacer, quel que soit le serveur.
  const blobUrl = URL.createObjectURL(await (await fetch(url)).blob());
  const v = Object.assign(document.createElement('video'), { muted: true, playsInline: true, src: blobUrl });
  const ex = new Extractor();
  const samples = [];
  let frames = 0, faces = 0;
  for await (const { time, duration } of videoFrames(v, fps)) {
    frames++;
    const res = measureFrame(v, v.videoWidth, v.videoHeight, { face }, ex);
    if (res) faces++;
    if (res?.m) samples.push({ t: time, r: res.m.r, g: res.m.g, b: res.m.b, zones: res.m.zones, raw: res.m.raw, motion: res.face.motion });
    if (frames % 150 === 0) onProgress(time / duration);
  }
  URL.revokeObjectURL(blobUrl);
  return { samples, frames, faces };
}

export const METHODS = {
  green: { source: 'raw', method: 'green', motion: null },
  v0: { source: 'raw', method: 'pos', motion: null },
  skin: { source: 'skin', method: 'pos', motion: null },
  zones: { source: 'skin', method: 'fusion', motion: null },
  motion: { source: 'skin', method: 'fusion', motion: DEFAULT_MOTION },
  full: { source: 'skin', method: 'fusion', motion: DEFAULT_MOTION, tracked: true },
};

export function score(samples, ref, id) {
  const m = METHODS[id];
  const src = m.source === 'raw' ? samples.map((s) => ({ t: s.t, ...s.raw })) : samples;
  const res = slidingAnalysis(src, { method: m.method, motion: m.motion });
  const tracker = new HrTracker();
  const shown = res.map((r) => {
    if (m.tracked) { tracker.update(r); return { t: r.t, v: tracker.value(r.t) }; }
    return { t: r.t, v: r.quality !== 'poor' ? r.bpm : null };
  });
  let n = 0, cov = 0, abs = 0, within5 = 0, wrong = 0;
  for (const w of ref.windows) {
    if (!w.ok) continue;
    const s = shown.find((x) => Math.abs(x.t - w.t) < 0.26);
    if (!s) continue;
    n++;
    if (s.v === null) continue;
    cov++;
    const e = Math.abs(s.v - w.bpm);
    abs += e;
    if (e <= 5) within5++; else wrong++;
  }
  return { windows: n, coverage: cov / n, mae: abs / cov, within5: within5 / cov, wrongShown: wrong };
}

// ---------- Expériences : plusieurs tailles de zones et options sur les mêmes images ----------
// Zones 0–2 : taille normale ; 3–5 : agrandies (front plus haut et plus large, joues ×1,5).
function bigger(regs) {
  const [f, a, b] = regs;
  return [
    { ...f, w: f.w * 1.25, h: f.h * 1.5 },
    { ...a, rx: a.rx * 1.5, ry: a.ry * 1.5 },
    { ...b, rx: b.rx * 1.5, ry: b.ry * 1.5 },
  ];
}

export async function extractExperiment(url, fps = 30, onProgress = () => {}) {
  const face = await loadLandmarker();
  const blobUrl = URL.createObjectURL(await (await fetch(url)).blob());
  const v = Object.assign(document.createElement('video'), { muted: true, playsInline: true, src: blobUrl });
  const ex = new Extractor();
  const samples = [];
  let frames = 0;
  for await (const { time, duration } of videoFrames(v, fps)) {
    frames++;
    const res = face.detectForVideo(v, nextTs());
    const lm = res.faceLandmarks?.[0];
    if (lm) {
      const { w, h } = ex.size(v.videoWidth, v.videoHeight);
      const fr = faceRegions(lm, w, h);
      const m = ex.measure(v, v.videoWidth, v.videoHeight, [...fr.regions, ...bigger(fr.regions)]);
      if (m) samples.push({ t: time, zones: m.zones, motion: fr.motion });
    }
    if (frames % 150 === 0) onProgress(time / duration);
  }
  URL.revokeObjectURL(blobUrl);
  return { samples, frames };
}

// Construit des échantillons pour une configuration : zones choisies, filtre de peau ou non.
export function variant(samples, { zones = [0, 1, 2], skin = true } = {}) {
  return samples.map((s) => {
    const zs = zones.map((i) => {
      const z = s.zones[i];
      if (!z) return null;
      return skin ? { r: z.r, g: z.g, b: z.b, n: z.n } : z.raw;
    });
    const ok = zs.filter(Boolean);
    const n = ok.reduce((a, z) => a + z.n, 0) || 1;
    const avg = (c) => ok.reduce((a, z) => a + z[c] * z.n, 0) / n;
    return { t: s.t, r: avg('r'), g: avg('g'), b: avg('b'), zones: zs, motion: s.motion };
  }).filter((s) => s.zones.some(Boolean));
}

export function scoreConfig(samples, ref, { method = 'fusion', motion = null, tracked = false, staleAfter = 5 } = {}) {
  const res = slidingAnalysis(samples, { method, motion });
  const tracker = new HrTracker({ staleAfter });
  const shown = res.map((r) => {
    if (tracked) { tracker.update(r); return { t: r.t, v: tracker.value(r.t), raw: r.bpm }; }
    return { t: r.t, v: r.quality !== 'poor' ? r.bpm : null, raw: r.bpm };
  });
  let n = 0, cov = 0, abs = 0, wrong = 0, rawOk = 0;
  for (const w of ref.windows) {
    if (!w.ok) continue;
    const s = shown.find((x) => Math.abs(x.t - w.t) < 0.26);
    if (!s) continue;
    n++;
    if (Math.abs(s.raw - w.bpm) <= 3) rawOk++;
    if (s.v === null) continue;
    cov++;
    const e = Math.abs(s.v - w.bpm);
    abs += e;
    if (e > 5) wrong++;
  }
  return { n, shown: cov / n, mae: abs / cov, wrong, rawOk: rawOk / n };
}
