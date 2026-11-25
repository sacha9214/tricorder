// Choix du ratio du contrôle des harmoniques : mesures justes, et mesures fausses
// qui seraient affichées (SNR ≥ seuil « fair ») — c'est ce second chiffre qui compte.
import { estimate, resample, pos, bandpass, clipRobust, SNR_FAIR } from '../js/dsp.js';
import { synthSamples } from '../js/synth.js';
const bpmOf = (s, ratio) => {
  const rs = resample(s, 30, 12);
  return estimate(bandpass(clipRobust(pos(rs.r, rs.g, rs.b, 30)), 30), 30, { ratio });
};
const cases = {
  'harmonique 1.4 à 60': (seed) => [synthSamples({ bpm: 60, harmonic: 1.4, noise: 0.2, seed }), 60],
  'harmonique 1.2 à 50': (seed) => [synthSamples({ bpm: 50, harmonic: 1.2, noise: 0.2, seed }), 50],
  '175 bpm bruit 0.3': (seed) => [synthSamples({ bpm: 175, noise: 0.3, seed: seed * 31 + 175 }), 175],
  '150 bpm bruit 0.3': (seed) => [synthSamples({ bpm: 150, noise: 0.3, seed: seed * 31 + 150 }), 150],
  '110 bpm bruit 0.5': (seed) => [synthSamples({ bpm: 110, noise: 0.5, seed }), 110],
};
for (const ratio of [Infinity, 0.5, 0.4, 0.35, 0.3, 0.25]) {
  const row = [];
  for (const [name, mk] of Object.entries(cases)) {
    let ok = 0, wrongShown = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const [s, truth] = mk(seed);
      const e = bpmOf(s, ratio);
      if (Math.abs(e.bpm - truth) < 2) ok++;
      else if (e.snr >= SNR_FAIR) wrongShown++;
    }
    row.push(`${name}: ${ok} ok, ${wrongShown} faux affichés`);
  }
  console.log(`ratio ${String(ratio).padEnd(8)}`, row.join(' | '));
}
