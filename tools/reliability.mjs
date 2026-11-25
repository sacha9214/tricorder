// Fiabilité du score de qualité : précision des mesures selon le label affiché.
import { analyze } from '../js/dsp.js';
import { synthSamples } from '../js/synth.js';
const stats = { good: [0, 0], fair: [0, 0], poor: [0, 0] };
for (const noise of [0.1, 0.3, 0.5, 0.8, 1.2])
  for (const bpm of [45, 55, 72, 90, 120, 150, 175])
    for (let seed = 1; seed <= 15; seed++) {
      const r = analyze(synthSamples({ bpm, noise, seed: seed * 101 + bpm }));
      const s = stats[r.quality];
      s[0]++;
      if (Math.abs(r.bpm - bpm) < 3) s[1]++;
    }
for (const [q, [n, ok]] of Object.entries(stats))
  console.log(`${q.padEnd(5)} n=${String(n).padStart(3)}  correct (±3 bpm) ${(100 * ok / n).toFixed(1)} %`);
