// Contrôle de synchronisation vidéo / référence : corrélation entre la fréquence estimée et la
// référence pour différents décalages. Usage : node tools/lag-check.mjs scores.json config nom…
import { readFileSync } from 'node:fs';
const [file, cn, ...names] = process.argv.slice(2);
const scores = JSON.parse(readFileSync(new URL(`../recordings/out/${file}`, import.meta.url)));
for (const s of scores.filter((x) => names.some((n) => x.name.includes(n)))) {
  const ref = JSON.parse(readFileSync(new URL(`../recordings/${s.name.startsWith('tue') ? 'tue/ref_' + s.name.slice(4) : 'mcd/ref_' + s.name.slice(4)}.json`, import.meta.url)));
  const est = new Map(s[cn].recs.map(([t, snr, err]) => [t, { snr, err }]));
  // estimé = réf + err au même t ; on reconstruit l'estimé puis on le compare à la réf décalée.
  const refAt = new Map(ref.windows.filter((w) => w.ok).map((w) => [w.t, w.bpm]));
  const pts = [...est].filter(([t, e]) => e.snr > 2 && refAt.has(t)).map(([t, e]) => ({ t, est: refAt.get(t) + e.err }));
  let best = null;
  for (let lag = -15; lag <= 15; lag += 1) {
    const pairs = pts.map((p) => [p.est, refAt.get(+(p.t + lag).toFixed(1))]).filter(([, r]) => r !== undefined);
    const mae = pairs.reduce((a, [e, r]) => a + Math.abs(e - r), 0) / pairs.length;
    if (!best || mae < best.mae) best = { lag, mae, n: pairs.length };
    if (lag === 0) var zero = mae;
  }
  console.log(`${s.name.padEnd(16)} error at lag 0: ${zero.toFixed(2)} bpm · best lag ${best.lag}s: ${best.mae.toFixed(2)} bpm (${best.n} windows)`);
}
