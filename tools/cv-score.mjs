// Validation croisée par personne : le seuil de qualité est choisi sur une moitié des personnes
// (part de lectures fausses ≤ cible) et mesuré sur l'autre moitié, puis on échange. Évite de
// régler et juger sur les mêmes données. Lit recordings/out/scores.json (offline-score.mjs).
// Usage : node tools/cv-score.mjs [cible=0.01] [fichier=scores.json]
import { readFileSync } from 'node:fs';

const target = parseFloat(process.argv[2] ?? '0.01');
const scores = JSON.parse(readFileSync(new URL(`../recordings/out/${process.argv[3] ?? 'scores.json'}`, import.meta.url)));
const person = (s) => (s.name.startsWith('mcd_') ? s.name.split('_')[1] : s.participant);
const fold = (s) => {
  let h = 0;
  for (const ch of person(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 2;
};
const configs = Object.keys(scores[0]).filter((k) => scores[0][k]?.recs);

function pickThreshold(recs) {
  for (let thr = -2; thr <= 10; thr += 0.25) {
    const shown = recs.filter((r) => r[1] >= thr);
    if (shown.length && shown.filter((r) => Math.abs(r[2]) > 5).length / shown.length <= target) return thr;
  }
  return Infinity;
}

function evaluate(recs, thr) {
  const shown = recs.filter((r) => r[1] >= thr);
  const wrong = shown.filter((r) => Math.abs(r[2]) > 5).length;
  const mae = shown.reduce((a, r) => a + Math.abs(r[2]), 0) / (shown.length || 1);
  return { n: recs.length, shown: shown.length, wrong, mae };
}

const groups = {
  'all': () => true,
  'MCD rest': (s) => s.name.startsWith('mcd_') && s.step === 'before',
  'MCD after exercise': (s) => s.name.startsWith('mcd_') && s.step === 'after',
  'TU/e bright (P1) lighting': (s) => s.skin === 'bright' && /^LC/.test(s.condition),
  'TU/e intermediate (P2)': (s) => s.skin === 'intermediate',
  'TU/e dark (P3)': (s) => s.skin === 'dark',
  'TU/e motion (P1 M1–M3)': (s) => /^M/.test(s.condition ?? ''),
  'TU/e high HR (P1 H1)': (s) => /^H/.test(s.condition ?? ''),
};

console.log(`target: wrong readings ≤ ${target * 100}% · thresholds chosen on the other half of the people\n`);
for (const cn of configs) {
  // Seuil appris sur chaque moitié (toutes sources confondues), appliqué à l'autre.
  const thr = [0, 1].map((k) => pickThreshold(scores.filter((s) => fold(s) !== k).flatMap((s) => s[cn]?.recs ?? [])));
  const line = [];
  for (const [g, test] of Object.entries(groups)) {
    const agg = { n: 0, shown: 0, wrong: 0, abs: 0 };
    for (const s of scores.filter(test)) {
      const e = evaluate(s[cn]?.recs ?? [], thr[fold(s)]);
      agg.n += e.n; agg.shown += e.shown; agg.wrong += e.wrong; agg.abs += e.mae * e.shown;
    }
    if (!agg.n) continue;
    line.push(`${g}: shown ${(100 * agg.shown / agg.n).toFixed(0)}%, wrong ${(100 * agg.wrong / (agg.shown || 1)).toFixed(1)}%, MAE ${(agg.abs / (agg.shown || 1)).toFixed(1)} (${agg.n} w)`);
  }
  console.log(`${cn}  [thresholds ${thr.map((t) => t.toFixed(2)).join(' / ')} dB]\n  ${line.join('\n  ')}\n`);
}
