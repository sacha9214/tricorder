// Balayage bruit × fréquence cardiaque sur 20 graines : taux de réussite (±2 bpm) et SNR moyen.
import { analyze } from '../js/dsp.js';
import { synthSamples } from '../js/synth.js';
const noises = (process.argv[2] ?? '0,0.1,0.3,0.5').split(',').map(Number);
for (const noise of noises) {
  const row = [];
  for (const bpm of [45, 72, 120, 175]) {
    let ok = 0, snr = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = analyze(synthSamples({ bpm, noise, seed }));
      if (Math.abs(r.bpm - bpm) < 2) ok++;
      snr += r.snr / 20;
    }
    row.push(`${bpm}:${ok}/20 ${snr.toFixed(1)}dB`);
  }
  console.log('noise', noise, row.join('  '));
}
