// Délai d'arrivée du pouls entre deux endroits du corps (visage → paume) : l'onde de pouls met
// un peu plus de temps à atteindre la main qu'à atteindre le visage. Mesuré par intercorrélation
// des deux ondes de pouls, affinée entre deux images. Expérimental : à 30 images/s une image
// dure 33 ms, la précision dépend fortement de la qualité des deux signaux. Ce n'est PAS une
// mesure de tension artérielle.

// a, b : ondes de même longueur échantillonnées à fs. Retard positif = b en retard sur a.
export function pulseDelay(a, b, fs, maxLag = 0.3) {
  const n = Math.min(a.length, b.length);
  const norm = (x) => {
    const m = x.reduce((s, v) => s + v, 0) / x.length;
    const sd = Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length) || 1;
    return Float64Array.from(x, (v) => (v - m) / sd);
  };
  const A = norm(a.subarray ? a.subarray(a.length - n) : a.slice(-n));
  const B = norm(b.subarray ? b.subarray(b.length - n) : b.slice(-n));
  const L = Math.round(maxLag * fs);
  const corr = (lag) => {
    let s = 0, k = 0;
    for (let i = Math.max(0, -lag); i < n - Math.max(0, lag); i++) { s += A[i] * B[i + lag]; k++; }
    return k ? s / k : 0;
  };
  let best = 0, bc = -Infinity;
  const cs = new Map();
  for (let lag = -L; lag <= L; lag++) {
    const c = corr(lag);
    cs.set(lag, c);
    if (c > bc) { bc = c; best = lag; }
  }
  const y0 = cs.get(best - 1) ?? bc, y2 = cs.get(best + 1) ?? bc;
  const den = y0 - 2 * bc + y2;
  const frac = den ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
  return { ms: ((best + frac) / fs) * 1000, corr: bc };
}
