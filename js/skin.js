// Sélection des pixels de peau dans une zone.
// Pas de règle fixe « couleur de peau » (ces règles marchent mal sur les peaux très claires
// ou très foncées) : on garde les pixels proches de la couleur médiane de la zone elle-même.
// Cheveux, sourcils, montures de lunettes (sombres) et reflets (clairs) sont écartés par la
// luminosité ; les objets d'une autre teinte, par la chrominance.
// La référence part de la couleur médiane, puis ne suit que les pixels gardés : une fois
// calée sur la peau, des cheveux qui couvrent plus de la moitié de la zone ne l'emportent
// pas. Si moins de 20 % des pixels passent pendant 1 s, on recale sur la médiane.

const BINS = 512;

function histMedian(hist, count) {
  const half = count / 2;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= half) return i;
  }
  return hist.length - 1;
}

export class SkinFilter {
  // Tolérances larges : sur de vraies vidéos compressées, le bruit de couleur est fort et une
  // tolérance serrée (0,035) écartait de la vraie peau et faisait perdre des mesures.
  constructor({ chromaTol = 0.06, lumLo = 0.5, lumHi = 1.7, ema = 0.1, minKept = 40, relockFrames = 30 } = {}) {
    Object.assign(this, { chromaTol, lumLo, lumHi, ema, minKept, relockFrames });
    this.hu = new Uint32Array(BINS);
    this.hv = new Uint32Array(BINS);
    this.hs = new Uint32Array(766);
    this.reset();
  }

  reset() { this.ref = null; this.lowFrames = 0; }

  medianRef(r, g, b, n) {
    const { hu, hv, hs } = this;
    hu.fill(0); hv.fill(0); hs.fill(0);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const s = r[i] + g[i] + b[i];
      if (s <= 0) continue;
      hu[Math.min(BINS - 1, ((r[i] / s) * BINS) | 0)]++;
      hv[Math.min(BINS - 1, ((g[i] / s) * BINS) | 0)]++;
      hs[Math.min(765, s | 0)]++;
      count++;
    }
    if (!count) return null;
    return {
      u: (histMedian(hu, count) + 0.5) / BINS,
      v: (histMedian(hv, count) + 0.5) / BINS,
      s: histMedian(hs, count) + 0.5,
    };
  }

  // r, g, b : valeurs (0–255) des n pixels candidats. Renvoie la moyenne des pixels gardés.
  apply(r, g, b, n) {
    if (n < this.minKept) return null;
    if (!this.ref) this.ref = this.medianRef(r, g, b, n);
    if (!this.ref) return null;
    const { u: mu, v: mv, s: ms } = this.ref;
    const sLo = this.lumLo * ms, sHi = this.lumHi * ms, tol = this.chromaTol;
    let sr = 0, sg = 0, sb = 0, kept = 0;
    for (let i = 0; i < n; i++) {
      const s = r[i] + g[i] + b[i];
      if (s < sLo || s > sHi) continue;
      if (Math.abs(r[i] / s - mu) > tol || Math.abs(g[i] / s - mv) > tol) continue;
      sr += r[i]; sg += g[i]; sb += b[i]; kept++;
    }
    // Recalage si la peau est perdue (changement de cadrage, zone mal initialisée).
    this.lowFrames = kept < 0.2 * n ? this.lowFrames + 1 : 0;
    if (this.lowFrames > this.relockFrames) { this.ref = null; this.lowFrames = 0; }
    if (kept < this.minKept) return null;
    if (this.ref) {
      const ks = sr + sg + sb, a = this.ema;
      this.ref.u += a * (sr / ks - this.ref.u);
      this.ref.v += a * (sg / ks - this.ref.v);
      this.ref.s += a * (ks / kept - this.ref.s);
    }
    return { r: sr / kept, g: sg / kept, b: sb / kept, n: kept, kept: kept / n };
  }
}
