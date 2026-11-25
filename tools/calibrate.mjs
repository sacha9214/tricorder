// Précision des mesures par tranche de SNR, pour placer les seuils good/fair.
import { analyze } from '../js/dsp.js';
import { synthSamples } from '../js/synth.js';
const bins = new Map();
for (const noise of [0.1, 0.3, 0.5, 0.8, 1.2, 2])
  for (const bpm of [45, 55, 72, 90, 120, 150, 175])
    for (let seed = 1; seed <= 25; seed++) {
      const r = analyze(synthSamples({ bpm, noise, seed: seed * 7919 + bpm }));
      const b = Math.floor(r.snr);
      const e = bins.get(b) ?? [0, 0];
      e[0]++; if (Math.abs(r.bpm - bpm) < 3) e[1]++;
      bins.set(b, e);
    }
for (const b of [...bins.keys()].sort((x, y) => x - y))
  if (b >= -4 && b <= 6) { const [n, ok] = bins.get(b); console.log(`[${b},${b + 1}) dB  n=${String(n).padStart(4)}  correct ${(100 * ok / n).toFixed(0)} %`); }
