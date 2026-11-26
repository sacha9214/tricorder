// Mode doigt : le bout du doigt posé sur la caméra (au dos du téléphone, lampe allumée), toute
// l'image devient rouge et sa luminosité suit le pouls — le principe d'un oxymètre de pouls.
// Bien plus fort que le signal du visage : sert de référence pour vérifier la mesure du visage.
import { resampleRange, bandpass, clipRobust, estimate, qualityOf, FS } from './dsp.js';

export const FINGER_THRESHOLDS = { good: 6, fair: 3 };

export class FingerSensor {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 40; this.canvas.height = 30;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  // Couleur moyenne de l'image et présence d'un doigt (image rouge et uniforme).
  measure(source) {
    this.ctx.drawImage(source, 0, 0, 40, 30);
    const px = this.ctx.getImageData(0, 0, 40, 30).data;
    let r = 0, g = 0, b = 0, r2 = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; r2 += px[i] * px[i]; }
    r /= n; g /= n; b /= n;
    const sdR = Math.sqrt(Math.max(0, r2 / n - r * r));
    return { r, g, b, present: isFinger(r, g, b, sdR) };
  }
}

export function isFinger(r, g, b, sdR) {
  return r > 60 && r > 1.4 * g && r > 1.4 * b && sdR < 35;
}

// samples : [{ t, r, g, b }]. On essaie le rouge et le vert (le rouge sature parfois sous la
// lampe) et on garde le canal au meilleur SNR.
export function fingerAnalyze(samples, { window = 10, minWindow = 6 } = {}) {
  if (samples.length < 2) return { ready: false, progress: 0 };
  const tEnd = samples[samples.length - 1].t;
  const span = tEnd - samples[0].t;
  if (span < minWindow - 0.1) return { ready: false, progress: span / minWindow };
  const rs = resampleRange(samples, FS, Math.max(samples[0].t, tEnd - window), tEnd);
  let best = null;
  for (const ch of ['r', 'g']) {
    const c = rs[ch];
    const m = c.reduce((a, v) => a + v, 0) / c.length;
    if (m > 250 || m < 5) continue; // saturé ou noir : pas d'information
    const x = bandpass(clipRobust(Float64Array.from(c, (v) => v / m - 1)), FS);
    const e = estimate(x, FS);
    if (!best || e.snr > best.snr) best = { ...e, channel: ch, wave: x };
  }
  if (!best) return { ready: true, bpm: NaN, snr: -Infinity, quality: 'poor', wave: null, channel: null };
  return { ready: true, t: tEnd, bpm: best.bpm, snr: best.snr, quality: qualityOf(best.snr, FINGER_THRESHOLDS), wave: best.wave, power: best.power, df: best.df, channel: best.channel };
}
