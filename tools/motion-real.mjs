// Mouvement réel (TU/e P1 M1–M3) : variantes de correction du mouvement, et précision selon le
// SNR pendant le mouvement (pour un seuil plus strict quand la tête bouge).
// Référence décalée de OFFSET secondes (synchro du jeu TU/e, voir tools/lag-check.mjs).
import { readFileSync } from 'node:fs';
import { slidingAnalysis, ZoneMemory } from '../js/dsp.js';
import { buildSamples } from './offline-score.mjs';

const OFFSET = +(process.env.OFFSET ?? 6);
const VARIANTS = {
  linear: { motion: { domain: 'rgb', quad: false, gate: true } },
  quad: { motion: { domain: 'rgb', quad: true, gate: true } },
  'quad+mask4': { motion: { domain: 'rgb', quad: true, gate: true, mask: true, kappa: 4 } },
  'quad+mask20': { motion: { domain: 'rgb', quad: true, gate: true, mask: true, kappa: 20 } },
};
const MAP = [1, 0.5, 0.3, 0.15]; // seuil sur la part du mouvement à la fréquence retenue

const all = Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, []]));
for (const name of process.argv.slice(2)) {
  const h = JSON.parse(readFileSync(`recordings/out/${name}.json`));
  const buf = readFileSync(`recordings/out/${name}.bin`);
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const ref = JSON.parse(readFileSync(h.ref));
  const refAt = (t) => ref.windows.find((w) => w.ok && Math.abs(w.t - (t + OFFSET)) < 0.26);
  const samples = buildSamples(h, data, { kind: 'grid' });
  for (const [label, v] of Object.entries(VARIANTS)) {
    const res = slidingAnalysis(samples, { step: 1, nfftZone: 1024, zoneWeights: new ZoneMemory({ alpha: 0.05 }).weigh, ...v });
    for (const r of res) {
      const w = refAt(r.t);
      if (w) all[label].push({ snr: r.snr, err: Math.abs(r.bpm - w.bpm), moving: r.moving, map: r.motionAtPeak });
    }
  }
}
for (const [label, recs] of Object.entries(all)) {
  const n = recs.length;
  const ok3 = recs.filter((r) => r.err <= 3).length;
  const line = MAP.map((mp) => {
    const sh = recs.filter((r) => r.snr >= 1.75 && r.map < mp);
    const wr = sh.filter((r) => r.err > 5).length;
    return `motion@peak<${mp}: shown ${(100 * sh.length / n).toFixed(0)}% wrong ${(100 * wr / (sh.length || 1)).toFixed(0)}%`;
  });
  console.log(`${label.padEnd(13)} raw±3 ${(100 * ok3 / n).toFixed(0)}% (${n} w) | ${line.join(' | ')}`);
}
