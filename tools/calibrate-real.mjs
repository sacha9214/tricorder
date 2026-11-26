// Calibrage des seuils de qualité sur vraies vidéos : à partir de recordings/out/scores.json
// (fenêtres : SNR, erreur), précision par tranche de SNR et choix du seuil qui garde la part
// de lectures fausses (> 5 bpm) sous une cible, pour chaque configuration.
import { readFileSync } from 'node:fs';
const scores = JSON.parse(readFileSync(new URL('../recordings/out/scores.json', import.meta.url)));
const configs = Object.keys(scores[0]).filter((k) => scores[0][k]?.recs);
for (const cn of configs) {
  const recs = scores.flatMap((s) => s[cn]?.recs ?? []);
  console.log(`\n${cn}: ${recs.length} windows`);
  for (let lo = -4; lo < 8; lo += 1) {
    const bin = recs.filter((r) => r[1] >= lo && r[1] < lo + 1);
    if (!bin.length) continue;
    const ok = bin.filter((r) => Math.abs(r[2]) <= 5).length;
    console.log(`  [${String(lo).padStart(2)},${String(lo + 1).padStart(2)}) dB  n=${String(bin.length).padStart(5)}  within 5 bpm ${(100 * ok / bin.length).toFixed(0).padStart(3)}%`);
  }
  for (const target of [0.01, 0.02]) {
    let best = null;
    for (let thr = -2; thr <= 8; thr += 0.25) {
      const shown = recs.filter((r) => r[1] >= thr);
      const wrong = shown.filter((r) => Math.abs(r[2]) > 5).length;
      if (shown.length && wrong / shown.length <= target) { best = { thr, shown: shown.length / recs.length, wrong: wrong / shown.length }; break; }
    }
    console.log(`  wrong ≤ ${target * 100}% → threshold ${best?.thr ?? 'n/a'} dB, shown ${best ? (100 * best.shown).toFixed(0) : '-'}%`);
  }
}
