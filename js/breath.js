// Fréquence respiratoire à partir des mêmes données que le pouls : la respiration fait monter et
// descendre légèrement la tête, l'avance ou la recule (taille apparente du visage) et module
// lentement la couleur de la peau. Chaque signal est filtré dans la bande 0,1–0,6 Hz
// (6–36 respirations par minute) ; leurs spectres sont combinés, pondérés par la netteté de
// leur pic. Fenêtre longue (32 s) : il faut plusieurs respirations pour une mesure.
import { resampleRange, resampleColumns, bandpass, spectrum, std } from './dsp.js';

export const BR_MIN = 0.1;   // 6 / min
export const BR_MAX = 0.6;   // 36 / min
export const BR_WINDOW = 32; // s
const FS = 10;               // la respiration est lente : 10 Hz suffisent
const NFFT = 2048;           // 10 / 2048 Hz ≈ 0,3 respiration/min par case

// Signaux candidats (indices dans s.motion, voir extract.js) : y, échelle, hochement.
const MOTION_SIGNALS = { y: 1, scale: 2, pitch: 5 };

function peakInfo(x) {
  const { power, df } = spectrum(x, FS, NFFT);
  const lo = Math.ceil(BR_MIN / df), hi = Math.floor(BR_MAX / df);
  let k = lo, tot = 0;
  for (let i = lo; i <= hi; i++) { tot += power[i]; if (power[i] > power[k]) k = i; }
  // Netteté : part de l'énergie de la bande dans ±0,03 Hz autour du pic.
  let near = 0;
  for (let i = Math.max(lo, k - Math.round(0.03 / df)); i <= Math.min(hi, k + Math.round(0.03 / df)); i++) near += power[i];
  return { power, df, k, share: tot > 0 ? near / tot : 0 };
}

// samples : [{ t, r, g, b, motion }]. sources : liste de noms de signaux à utiliser.
export function estimateBreathing(samples, { window = BR_WINDOW, sources = ['y', 'scale', 'pitch', 'color'] } = {}) {
  if (samples.length < 2) return { ready: false, progress: 0 };
  const tEnd = samples[samples.length - 1].t;
  const span = tEnd - samples[0].t;
  if (span < window - 0.1) return { ready: false, progress: Math.max(0, span / window) };
  const tStart = tEnd - window;
  const sigs = {};
  const withMotion = samples.filter((s) => s.motion);
  if (withMotion.length > 10) {
    const cols = resampleColumns(withMotion, FS, tStart, tEnd, (s) => s.motion);
    for (const [name, i] of Object.entries(MOTION_SIGNALS)) if (sources.includes(name)) sigs[name] = cols[i];
  }
  if (sources.includes('color')) {
    const rs = resampleRange(samples, FS, tStart, tEnd);
    const m = rs.g.reduce((a, v) => a + v, 0) / rs.g.length;
    sigs.color = Float64Array.from(rs.g, (v) => v / m - 1);
  }
  const parts = [];
  for (const [name, x] of Object.entries(sigs)) {
    const f = bandpass(x, FS, BR_MIN, BR_MAX);
    const sd = std(f);
    if (!(sd > 0)) continue;
    const norm = Float64Array.from(f, (v) => v / sd);
    const info = peakInfo(norm);
    parts.push({ name, wave: norm, ...info });
  }
  if (!parts.length) return { ready: false, progress: 1 };
  // Combinaison : spectres normalisés, pondérés par la netteté (au carré : un signal net compte
  // beaucoup plus qu'un signal flou).
  const len = parts[0].power.length, df = parts[0].df;
  const comb = new Float64Array(len);
  let wsum = 0;
  for (const p of parts) {
    let tot = 0;
    for (let i = 0; i < len; i++) tot += p.power[i];
    const w = p.share ** 2;
    wsum += w;
    for (let i = 0; i < len; i++) comb[i] += (w * p.power[i]) / (tot || 1);
  }
  const lo = Math.ceil(BR_MIN / df), hi = Math.floor(BR_MAX / df);
  let k = lo, tot = 0;
  for (let i = lo; i <= hi; i++) { tot += comb[i]; if (comb[i] > comb[k]) k = i; }
  let near = 0;
  for (let i = Math.max(lo, k - Math.round(0.03 / df)); i <= Math.min(hi, k + Math.round(0.03 / df)); i++) near += comb[i];
  // Affinage parabolique.
  const y0 = comb[k - 1], y1 = comb[k], y2 = comb[k + 1];
  const den = y0 - 2 * y1 + y2;
  const f = (k + (den ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0)) * df;
  // Onde affichée : le signal dont le pic est le plus net.
  const best = parts.reduce((a, p) => (p.share > a.share ? p : a), parts[0]);
  return {
    ready: true,
    t: tEnd,
    wave: best.wave,
    waveSource: best.name,
    rate: f * 60,                  // respirations par minute
    clarity: tot > 0 ? near / tot : 0, // 0–1 : netteté du pic combiné
    sources: Object.fromEntries(parts.map((p) => [p.name, { rate: p.k * p.df * 60, share: p.share }])),
    weightSum: wsum,
  };
}
