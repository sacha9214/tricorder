// Référence de respiration synchronisée : à partir du capteur de pouls au doigt (MCD ppg_sync,
// une valeur par image), la respiration module la ligne de base (RIIV) et l'amplitude (RIAV) du
// signal. Fréquence par fenêtre de 32 s ; comparée à la valeur clinique de db.csv pour juger
// la référence, puis l'estimation vidéo comparée à cette référence fenêtre par fenêtre.
import { readFileSync, readdirSync } from 'node:fs';
import { bandpass, spectrum, median } from '../js/dsp.js';
import { estimateBreathing } from '../js/breath.js';
import { buildSamples } from './offline-score.mjs';

const FSP = 29.9;
function peakRate(x, fs, lo = 0.1, hi = 0.6) {
  const f = bandpass(x, fs, lo, hi);
  const { power, df } = spectrum(f, fs, 8192);
  let k = Math.ceil(lo / df), tot = 0, near = 0;
  for (let i = Math.ceil(lo / df); i <= Math.floor(hi / df); i++) { tot += power[i]; if (power[i] > power[k]) k = i; }
  for (let i = k - 3; i <= k + 3; i++) near += power[i] ?? 0;
  return { rate: k * df * 60, clarity: near / tot };
}
// Amplitude battement par battement (enveloppe) : max − min sur des tranches de 0,4 s.
function envelope(x, fs) {
  const w = Math.round(0.4 * fs), out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let mn = Infinity, mx = -Infinity;
    for (let j = Math.max(0, i - w); j <= Math.min(x.length - 1, i + w); j++) { mn = Math.min(mn, x[j]); mx = Math.max(mx, x[j]); }
    out[i] = mx - mn;
  }
  return out;
}

const db = readFileSync('recordings/mcd/db.csv', 'utf8').trim().split('\n');
const head = db[0].split(',');
const clin = {};
for (const line of db.slice(1)) { const c = line.split(','); const r = Object.fromEntries(head.map((h, i) => [h, c[i]])); if (r.camera === 'FullHDwebcam') clin[`${r.patient_id}_${r.step}`] = +r.respiratory; }

const rows = [];
for (const f of readdirSync('recordings/out').filter((f) => /^mcd_.*\.json$/.test(f))) {
  const name = f.slice(0, -5), key = name.slice(4);
  const ppg = readFileSync(`recordings/mcd/ppg_${key}.txt`, 'utf8').trim().split('\n').map((l) => parseFloat(l.split(/\s+/)[0]));
  const h = JSON.parse(readFileSync(`recordings/out/${f}`));
  const buf = readFileSync(`recordings/out/${name}.bin`);
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const samples = buildSamples(h, data, { kind: 'grid_mean' });
  for (let tEnd = 32; tEnd <= ppg.length / FSP; tEnd += 8) {
    const seg = Float64Array.from(ppg.slice(Math.round((tEnd - 32) * FSP), Math.round(tEnd * FSP)));
    const riiv = peakRate(seg, FSP), riav = peakRate(envelope(bandpass(seg, FSP, 0.7, 3), FSP), FSP);
    // Référence retenue seulement si les deux modulations s'accordent (à 2/min près).
    if (Math.abs(riiv.rate - riav.rate) > 2) continue;
    const ref = (riiv.rate + riav.rate) / 2;
    const win = samples.filter((s) => s.t > tEnd - 32.5 && s.t <= tEnd);
    const est = {};
    for (const src of ['all', 'y', 'scale', 'pitch', 'color']) {
      const r = estimateBreathing(win, { sources: src === 'all' ? ['y', 'scale', 'pitch', 'color'] : [src] });
      if (r.ready) est[src] = r.rate;
    }
    rows.push({ key, ref, clin: clin[key], est });
  }
}
const vids = [...new Set(rows.map((r) => r.key))];
const perVid = vids.map((k) => ({ ref: median(rows.filter((r) => r.key === k).map((r) => r.ref)), clin: rows.find((r) => r.key === k).clin }));
const corr = (a, b) => { const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length; let c = 0, va = 0, vb = 0; a.forEach((v, i) => { c += (v - ma) * (b[i] - mb); va += (v - ma) ** 2; vb += (b[i] - mb) ** 2; }); return c / Math.sqrt(va * vb); };
console.log(`${rows.length} windows where both finger-sensor methods agree, over ${vids.length} videos`);
console.log(`finger-derived vs clinical value (per video): mean diff ${(perVid.reduce((a, p) => a + Math.abs(p.ref - p.clin), 0) / perVid.length).toFixed(1)} /min, correlation ${corr(perVid.map((p) => p.ref), perVid.map((p) => p.clin)).toFixed(2)}`);
const refMed = median(rows.map((r) => r.ref));
console.log(`baseline (always ${refMed.toFixed(0)}/min) vs finger reference: within 3/min ${(100 * rows.filter((r) => Math.abs(r.ref - refMed) <= 3).length / rows.length).toFixed(0)}%`);
for (const src of ['all', 'y', 'scale', 'pitch', 'color']) {
  const ok = rows.filter((r) => r.est[src] !== undefined);
  const w3 = ok.filter((r) => Math.abs(r.est[src] - r.ref) <= 3).length;
  console.log(`video ${src.padEnd(6)} vs finger reference: within 3/min ${(100 * w3 / ok.length).toFixed(0)}% · mean error ${(ok.reduce((a, r) => a + Math.abs(r.est[src] - r.ref), 0) / ok.length).toFixed(1)}/min · correlation ${corr(ok.map((r) => r.est[src]), ok.map((r) => r.ref)).toFixed(2)}`);
}
