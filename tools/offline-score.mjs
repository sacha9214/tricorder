// Évaluation hors ligne des mesures extraites (tools/batch-extract.js → recordings/out/*.bin).
// Chaque configuration (zones, grille du visage, règle de fusion…) est reconstruite à partir
// des mêmes images et comparée, fenêtre par fenêtre, à la référence du capteur au doigt.
// Usage : node tools/offline-score.mjs [config,config,…] [motif-de-nom]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'recordings', 'out');

// u : gauche-droite, v : haut-bas, en écarts des yeux depuis le milieu des yeux.
const REGION_OF = (c) => {
  if (c.v < -0.25) return 0;                              // front
  if (c.v >= 1.0) return 4;                               // menton, mâchoire
  if (Math.abs(c.u) < 0.25) return 1;                     // nez
  return c.u < 0 ? 2 : 3;                                 // joues
};

export const CONFIGS = {
  zones3: { kind: 'zones', off: 9 },
  zones3_raw: { kind: 'zones', off: 18 },
  grid_mean: { kind: 'grid_mean' },
  grid_regions: { kind: 'grid_regions' },
  grid_snr: { kind: 'grid', fusion: 'snr' },
  grid_top10: { kind: 'grid', fusion: 'topk', topK: 10 },
  grid_top25: { kind: 'grid', fusion: 'topk', topK: 25 },
  grid_equal: { kind: 'grid', fusion: 'equal' },
  grid_mem: { kind: 'grid', fusion: 'snr', memory: 0.2 },
  grid_mem02: { kind: 'grid', fusion: 'snr', memory: 0.02 },
  grid_mem10: { kind: 'grid', fusion: 'snr', memory: 0.1 },
  grid_mem10_half50: { kind: 'grid', fusion: 'snr', memory: 0.1, halfRatio: 0.5 },
  grid_mem10_half80: { kind: 'grid', fusion: 'snr', memory: 0.1, halfRatio: 0.8 },
  grid_mem10_nohalf: { kind: 'grid', fusion: 'snr', memory: 0.1, halfRatio: Infinity },
  grid_mem05_nohalf: { kind: 'grid', fusion: 'snr', memory: 0.05, halfRatio: Infinity },
  grid_mem20_nohalf: { kind: 'grid', fusion: 'snr', memory: 0.2, halfRatio: Infinity },
  zones3_nohalf: { kind: 'zones', off: 9, halfRatio: Infinity },
  // Configuration retenue pour la page : grille, mémoire 0,1, seuil 2 dB ; avec suivi pour comparer.
  final: { kind: 'grid', fusion: 'snr', memory: 0.1, thr: 2.0 },
  final_zones3: { kind: 'zones', off: 9, thr: 3.5 },
  mean_w12: { kind: 'grid_mean' },
  mean_w20: { kind: 'grid_mean', window: 20 },
  equal_w12: { kind: 'grid', fusion: 'equal' },
  final_w20: { kind: 'grid', fusion: 'snr', memory: 0.1, window: 20 },
  // Avec seuil de qualité calibré sur vraies vidéos (pour mesurer le suivi par-dessus).
  zones3_cal: { kind: 'zones', off: 9, thr: 3.75 },
  grid_mem05_cal: { kind: 'grid', fusion: 'snr', memory: 0.05, thr: 1.75 },
  grid_mem05: { kind: 'grid', fusion: 'snr', memory: 0.05 },
  grid_w16: { kind: 'grid', fusion: 'snr', window: 16 },
  grid_mem_w16: { kind: 'grid', fusion: 'snr', memory: 0.2, window: 16 },
};

export function buildSamples(h, data, cfg) {
  const { rowLen, frames, cells } = h;
  const N = cells.length;
  const out = [];
  const regionIdx = cells.map(REGION_OF);
  for (let f = 0; f < frames; f++) {
    const o = f * rowLen;
    if (data[o + 1] !== 1) continue;
    const t = data[o];
    const motion = Array.from(data.subarray(o + 2, o + 9));
    let zones;
    if (cfg.kind === 'zones') {
      zones = [0, 1, 2].map((z) => {
        const k = o + cfg.off + z * 3;
        return Number.isNaN(data[k]) ? null : { r: data[k], g: data[k + 1], b: data[k + 2] };
      });
    } else {
      const cellVals = [];
      for (let n = 0; n < N; n++) {
        const k = o + 27 + n * 3;
        cellVals.push(Number.isNaN(data[k]) ? null : { r: data[k], g: data[k + 1], b: data[k + 2] });
      }
      if (cfg.kind === 'grid') zones = cellVals;
      else {
        const groups = cfg.kind === 'grid_mean' ? [cellVals] : [0, 1, 2, 3, 4].map((g) => cellVals.filter((_, n) => regionIdx[n] === g));
        zones = groups.map((list) => {
          const ok = list.filter(Boolean);
          if (!ok.length) return null;
          const s = ok.reduce((a, z) => ({ r: a.r + z.r, g: a.g + z.g, b: a.b + z.b }), { r: 0, g: 0, b: 0 });
          return { r: s.r / ok.length, g: s.g / ok.length, b: s.b / ok.length };
        });
      }
    }
    const ok = zones.filter(Boolean);
    if (!ok.length) continue;
    const avg = (c) => ok.reduce((a, z) => a + z[c], 0) / ok.length;
    out.push({ t, r: avg('r'), g: avg('g'), b: avg('b'), zones, motion });
  }
  return out;
}

// Angle typologique individuel (ITA, Chardon 1991) à partir d'une couleur sRGB moyenne :
// > 55° très claire, 41–55 claire, 28–41 intermédiaire, 10–28 mate, −30–10 brune, < −30 foncée.
export function ita([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const L = 116 * f(Y) - 16, bb = 200 * (f(Y) - f(Z));
  return (Math.atan2(L - 50, bb) * 180) / Math.PI;
}
export const itaClass = (a) => (a > 55 ? 'very light' : a > 41 ? 'light' : a > 28 ? 'intermediate' : a > 10 ? 'tan' : a > -30 ? 'brown' : 'dark');

function meanSkin(h, data) {
  const acc = [0, 0, 0];
  let n = 0;
  for (let f = 0; f < h.frames; f += 10) {
    const o = f * h.rowLen;
    if (data[o + 1] !== 1) continue;
    for (let c = 0; c < h.cells.length; c++) {
      const k = o + 27 + c * 3;
      if (Number.isNaN(data[k])) continue;
      acc[0] += data[k]; acc[1] += data[k + 1]; acc[2] += data[k + 2]; n++;
    }
  }
  return acc.map((v) => v / n);
}

async function scoreVideo(name, configNames) {
  const { slidingAnalysis, HrTracker, ZoneMemory } = await import('../js/dsp.js');
  const h = JSON.parse(readFileSync(path.join(OUT, `${name}.json`), 'utf8'));
  const buf = readFileSync(path.join(OUT, `${name}.bin`));
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const ref = JSON.parse(readFileSync(path.join(ROOT, h.ref), 'utf8'));
  const res = { name, sex: h.sex, age: +h.age, bmi: +h.bmi, step: h.step, participant: h.participant, skin: h.skin_label, condition: h.condition, faceShare: 0 };
  let faces = 0;
  for (let f = 0; f < h.frames; f++) if (data[f * h.rowLen + 1] === 1) faces++;
  res.faceShare = faces / h.frames;
  res.skinRGB = meanSkin(h, data).map((v) => +v.toFixed(1));
  // ITA non publié : sur une vidéo non calibrée il mesure surtout l'exposition de la caméra.
  for (const cn of configNames) {
    const cfg = CONFIGS[cn];
    const samples = buildSamples(h, data, cfg);
    const opts = { step: 1, method: cfg.kind === 'grid_mean' ? 'pos' : 'fusion', fusion: cfg.fusion ?? 'snr', topK: cfg.topK, nfftZone: cfg.kind === 'grid' ? 1024 : 4096 };
    if (cfg.memory) opts.zoneWeights = new ZoneMemory({ alpha: cfg.memory }).weigh;
    if (cfg.window) { opts.window = cfg.window; opts.minWindow = cfg.window; }
    if (cfg.halfRatio !== undefined) opts.halfRatio = cfg.halfRatio;
    // Jeu TU/e : artefact de compression du caméscope à 30/12 = 2,5 Hz (images clés), mesuré à
    // 2,4993 ± 0,007 Hz sur P3. Retiré pour ce jeu seulement ; une webcam en direct n'en a pas.
    if (name.startsWith('tue_') && process.env.NOTCH !== '0') opts.exclude = [[2.45, 2.55]];
    const windows = samples.length > 300 ? slidingAnalysis(samples, opts) : [];
    const tracker = new HrTracker();
    const recs = [];
    let n = 0, shown = 0, shownT = 0, abs = 0, absT = 0, wrong = 0, wrongT = 0, raw3 = 0;
    for (const r of windows) {
      if (cfg.thr !== undefined) r.quality = r.snr >= cfg.thr ? 'good' : 'poor';
      const tv = (tracker.update(r), tracker.value(r.t));
      const w = ref.windows.find((x) => x.ok && Math.abs(x.t - r.t) < 0.26);
      if (!w) continue;
      n++;
      const e = Math.abs(r.bpm - w.bpm);
      if (e <= 3) raw3++;
      if (r.quality !== 'poor') { shown++; abs += e; if (e > 5) wrong++; }
      if (tv !== null) { shownT++; const et = Math.abs(tv - w.bpm); absT += et; if (et > 5) wrongT++; }
      recs.push([+r.t.toFixed(1), +r.snr.toFixed(2), +(r.bpm - w.bpm).toFixed(2), r.agreement === null ? 1 : +r.agreement.toFixed(3)]);
    }
    res[cn] = { n, raw3: raw3 / n, shown: shown / n, mae: abs / shown, wrong, shownT: shownT / n, maeT: absT / shownT, wrongT, recs };
  }
  return res;
}

if (isMainThread && process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const configNames = (process.argv[2] ?? Object.keys(CONFIGS).join(',')).split(',');
  const filter = new RegExp(process.argv[3] ?? '.');
  const names = readdirSync(OUT).filter((f) => f.endsWith('.json') && /^(mcd|tue)_/.test(f)).map((f) => f.slice(0, -5)).filter((n) => filter.test(n)).sort();
  const queue = [...names], results = [];
  const nWorkers = Math.max(1, Math.min(cpus().length - 1, names.length));
  await Promise.all(Array.from({ length: nWorkers }, () => new Promise((resolve) => {
    const next = (w) => {
      const name = queue.shift();
      if (!name) { w.terminate(); resolve(); return; }
      w.postMessage(name);
    };
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { configNames } });
    w.on('message', (r) => { results.push(r); process.stderr.write('.'); next(w); });
    w.on('error', (e) => { console.error(e); resolve(); });
    next(w);
  })));
  process.stderr.write('\n');
  results.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(path.join(OUT, process.argv[4] ?? 'scores.json'), JSON.stringify(results));
  const pct = (x) => `${(100 * x).toFixed(0)}%`.padStart(4);
  console.log(`${results.length} videos\n` + 'config'.padEnd(14) + ' raw±3   shown  MAE  wrong | tracked: shown  MAE  wrong');
  for (const cn of configNames) {
    const rs = results.map((r) => r[cn]).filter((x) => x && x.n);
    const mean = (k) => rs.reduce((a, x) => a + (Number.isFinite(x[k]) ? x[k] : 0), 0) / rs.length;
    const sum = (k) => rs.reduce((a, x) => a + x[k], 0);
    const wins = sum('n');
    console.log(`${cn.padEnd(14)} ${pct(mean('raw3'))}   ${pct(mean('shown'))}  ${mean('mae').toFixed(1).padStart(4)}  ${String(sum('wrong')).padStart(4)} |          ${pct(mean('shownT'))}  ${mean('maeT').toFixed(1).padStart(4)}  ${String(sum('wrongT')).padStart(4)}   (${wins} windows)`);
  }
} else if (!isMainThread) {
  parentPort.on('message', async (name) => {
    try { parentPort.postMessage(await scoreVideo(name, workerData.configNames)); }
    catch (e) { parentPort.postMessage({ name, error: String(e) }); }
  });
}
