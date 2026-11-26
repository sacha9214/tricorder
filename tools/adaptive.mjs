// Fenêtre adaptative : 12 s si le signal est bon, sinon 20 s (plus de battements pour un signal
// faible, au prix d'un temps de réaction plus long). Compare lectures affichées et fausses
// pour plusieurs seuils de la fenêtre longue, sur MCD (40 personnes) et TU/e par participant.
import { readFileSync, readdirSync } from 'node:fs';
import { slidingAnalysis, ZoneMemory } from '../js/dsp.js';
import { buildSamples } from './offline-score.mjs';

const THR12 = 2.0, THR20 = [99, 2, 3, 4, 5];
const names = readdirSync('recordings/out').filter((f) => /^(mcd|tue)_.*\.json$/.test(f)).map((f) => f.slice(0, -5)).filter((n) => new RegExp(process.env.FILTER ?? '.').test(n));
const tally = {};
for (const name of names) {
  const h = JSON.parse(readFileSync(`recordings/out/${name}.json`));
  const buf = readFileSync(`recordings/out/${name}.bin`);
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const ref = JSON.parse(readFileSync(h.ref));
  const samples = buildSamples(h, data, { kind: 'grid' });
  if (samples.length < 600) continue;
  const extra = name.startsWith('tue_') ? { exclude: [[2.45, 2.55]] } : {};
  const run = (window) => slidingAnalysis(samples, { step: 1, window, minWindow: window, nfftZone: 1024, zoneWeights: new ZoneMemory({ alpha: 0.1 }).weigh, ...extra });
  const a = run(12), b = new Map(run(20).map((r) => [Math.round(r.t), r]));
  if (process.env.DEBUG) console.log(name, "a windows", a.length, "b windows", b.size);
  const group = name.startsWith('mcd_') ? 'MCD' : `TU/e ${h.skin_label}${/^M/.test(h.condition) ? ' moving' : ''}`;
  for (const t20 of THR20) {
    const k = `${group} | 20 s ≥ ${t20 === 99 ? 'off' : t20 + ' dB'}`;
    tally[k] ??= { n: 0, shown: 0, wrong: 0, slow: 0 };
    for (const r of a) {
      if (r.t < 20) continue; // mêmes fenêtres pour toutes les variantes
      const w = ref.windows.find((x) => x.ok && Math.abs(x.t - r.t) < 0.26);
      if (!w) continue;
      tally[k].n++;
      let pick = r.snr >= THR12 ? r : null;
      const r20 = b.get(Math.round(r.t));
      if (!pick && r20 && r20.snr >= t20) { pick = r20; tally[k].slow++; }
      if (!pick) continue;
      tally[k].shown++;
      if (Math.abs(pick.bpm - w.bpm) > 5) tally[k].wrong++;
    }
  }
}
for (const [k, v] of Object.entries(tally).sort()) {
  console.log(`${k.padEnd(40)} shown ${(100 * v.shown / v.n).toFixed(0).padStart(3)}%  wrong ${(100 * v.wrong / (v.shown || 1)).toFixed(1).padStart(4)}%  (20 s used ${(100 * v.slow / v.n).toFixed(0)}%, ${v.n} w)`);
}
