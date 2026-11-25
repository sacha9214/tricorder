// Contrôle de la référence : fréquence spectrale contre comptage des battements (intervalle
// médian entre pics) sur les mêmes fenêtres. Les fenêtres où les deux divergent sont exclues.
import { readFileSync } from 'node:fs';
import { bandpass, median } from '../js/dsp.js';

export function beatBpm(seg, fs) {
  const x = bandpass(Float64Array.from(seg), fs);
  const minGap = Math.round(0.33 * fs), peaks = [];
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] > x[i - 1] && x[i] >= x[i + 1] && x[i] > 0) {
      if (peaks.length && i - peaks[peaks.length - 1] < minGap) {
        if (x[i] > x[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
      } else peaks.push(i);
    }
  }
  const ibi = peaks.slice(1).map((p, k) => (p - peaks[k]) / fs);
  return ibi.length >= 4 ? 60 / median(ibi) : NaN;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [ppgFile, refFile] = process.argv.slice(2);
  const values = readFileSync(ppgFile, 'utf8').trim().split('\n').map((l) => parseFloat(l.trim().split(/\s+/)[0]));
  const ref = JSON.parse(readFileSync(refFile, 'utf8'));
  let agree = 0;
  for (const w of ref.windows) {
    const end = Math.round(w.t * ref.fs), seg = values.slice(end - Math.round(12 * ref.fs), end);
    w.beats = +beatBpm(seg, ref.fs).toFixed(2);
    w.ok = Math.abs(w.beats - w.bpm) < 3 && w.snr >= 1;
    if (w.ok) agree++;
  }
  console.error(`${refFile}: ${agree}/${ref.windows.length} windows where both methods agree within 3 bpm`);
  console.log(JSON.stringify(ref));
}
