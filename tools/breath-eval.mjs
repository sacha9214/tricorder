// Évaluation de la fréquence respiratoire sur MCD-rPPG : la référence est la fréquence
// respiratoire notée pour chaque séance (colonne « respiratory » de db.csv, par minute).
// Pour chaque vidéo : estimation toutes les 4 s sur 32 s, médiane, comparée à la référence.
// Aussi chaque signal seul, pour voir lesquels portent vraiment la respiration.
// Usage : node tools/breath-eval.mjs [dégradation JSON]
import { readFileSync, readdirSync } from 'node:fs';
import { estimateBreathing } from '../js/breath.js';
import { buildSamples } from './offline-score.mjs';
import { median } from '../js/dsp.js';

const degrade = process.argv[2] ? JSON.parse(process.argv[2]) : null;
const db = readFileSync('recordings/mcd/db.csv', 'utf8').trim().split('\n');
const head = db[0].split(',');
const refOf = {};
for (const line of db.slice(1)) {
  const c = line.split(',');
  const row = Object.fromEntries(head.map((h, i) => [h, c[i]]));
  if (row.camera === 'FullHDwebcam') refOf[`mcd_${row.patient_id}_${row.step}`] = +row.respiratory;
}

const SETS = { all: ['y', 'scale', 'pitch', 'color'], y: ['y'], scale: ['scale'], pitch: ['pitch'], color: ['color'], motion: ['y', 'scale', 'pitch'] };
const res = Object.fromEntries(Object.keys(SETS).map((k) => [k, []]));
const refs = [];
for (const f of readdirSync('recordings/out').filter((f) => /^mcd_.*\.json$/.test(f))) {
  const name = f.slice(0, -5);
  const ref = refOf[name];
  if (!Number.isFinite(ref)) continue;
  const h = JSON.parse(readFileSync(`recordings/out/${f}`));
  const buf = readFileSync(`recordings/out/${name}.bin`);
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const samples = buildSamples(h, data, { kind: 'grid_mean', degrade });
  refs.push(ref);
  for (const [k, sources] of Object.entries(SETS)) {
    const rates = [];
    for (let tEnd = 32; tEnd <= samples[samples.length - 1].t; tEnd += 4) {
      const win = samples.filter((s) => s.t > tEnd - 32.5 && s.t <= tEnd);
      const r = estimateBreathing(win, { sources });
      if (r.ready) rates.push(r.rate);
    }
    res[k].push({ name, ref, est: median(rates) });
  }
}
const refMed = median(refs);
console.log(`${refs.length} videos · reference: median ${refMed} /min, range ${Math.min(...refs)}–${Math.max(...refs)}`);
const baseline = refs.reduce((a, r) => a + Math.abs(r - refMed), 0) / refs.length;
console.log(`baseline (always answer the median ${refMed}): mean error ${baseline.toFixed(1)} /min`);
for (const [k, rows] of Object.entries(res)) {
  const err = rows.map((r) => Math.abs(r.est - r.ref));
  const within3 = err.filter((e) => e <= 3).length / err.length;
  const mae = err.reduce((a, b) => a + b, 0) / err.length;
  // Corrélation entre estimation et référence.
  const mx = rows.reduce((a, r) => a + r.est, 0) / rows.length, my = rows.reduce((a, r) => a + r.ref, 0) / rows.length;
  const cov = rows.reduce((a, r) => a + (r.est - mx) * (r.ref - my), 0);
  const vx = rows.reduce((a, r) => a + (r.est - mx) ** 2, 0), vy = rows.reduce((a, r) => a + (r.ref - my) ** 2, 0);
  console.log(`${k.padEnd(7)} mean error ${mae.toFixed(1)} /min · within 3/min ${(100 * within3).toFixed(0)}% · correlation ${(cov / Math.sqrt(vx * vy)).toFixed(2)}`);
}
