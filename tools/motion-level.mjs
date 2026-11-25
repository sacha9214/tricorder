// Niveau de mouvement dans la bande cardiaque (0,7–3 Hz), par signal, sur fenêtres de 12 s :
// sert à placer le seuil au-delà duquel on corrige le mouvement.
import { resampleColumns, bandpass, std, FS } from '../js/dsp.js';
import { synthMotion, MOTION_FEATURES } from '../js/synth.js';

export function motionLevel(samples, fs = FS) {
  const tEnd = samples[samples.length - 1].t, tStart = Math.max(samples[0].t, tEnd - 12);
  const cols = resampleColumns(samples.filter((s) => s.t >= tStart), fs, tStart, tEnd, (s) => s.motion);
  return cols.map((c) => std(bandpass(c, fs)));
}

if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
  for (const sc of [{ motion: 'still' }, { motion: 'random' }, { motion: 'talking' }, { motion: 'turns' }, { motion: 'exercise', cadence: 1.55 }]) {
    const lv = motionLevel(synthMotion({ ...sc, bpm: 80, seed: 3, seconds: 12 }));
    console.log(sc.motion.padEnd(9), MOTION_FEATURES.map((f, i) => `${f} ${lv[i].toExponential(1)}`).join('  '));
  }
}
