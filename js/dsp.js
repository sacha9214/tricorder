// Traitement du signal rPPG, sans DOM (testable sous Node).
// Chaîne : échantillons {t, r, g, b, zones?} → rééchantillonnage régulier → POS par zone
// → écrêtage → passe-bande 42–180 bpm → fusion des zones pondérée par leur SNR
// → spectre → pic (avec contrôle des harmoniques) + rapport signal/bruit.

export const FS = 30;           // fréquence d'analyse (Hz)
export const HR_MIN = 0.7;      // 42 bpm
export const HR_MAX = 3.0;      // 180 bpm
export const NFFT = 4096;       // zéro-padding : 30/4096 Hz ≈ 0,44 bpm par case

// Seuils de qualité en dB, calés par tools/calibrate.mjs sur signaux synthétiques :
// sous 1 dB la mesure est juste ~50 % du temps, au-dessus de 1 dB ~100 %.
// À revalider sur de vraies vidéos avec un oxymètre de référence.
export const SNR_GOOD = 2;
export const SNR_FAIR = 1;

// Rééchantillonne les échantillons entre tStart et tEnd sur une grille régulière à `fs` Hz
// (interpolation linéaire). Les navigateurs livrent les images avec une cadence irrégulière.
export function resampleRange(samples, fs, tStart, tEnd) {
  const n = samples.length;
  const N = Math.floor((tEnd - tStart) * fs + 1e-9) + 1;
  const r = new Float64Array(N), g = new Float64Array(N), b = new Float64Array(N);
  let j = 0;
  for (let i = 0; i < N; i++) {
    const t = tStart + i / fs;
    while (j < n - 2 && samples[j + 1].t < t) j++;
    const a = samples[j], c = samples[Math.min(j + 1, n - 1)];
    const span = c.t - a.t;
    const w = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
    r[i] = a.r + w * (c.r - a.r);
    g[i] = a.g + w * (c.g - a.g);
    b[i] = a.b + w * (c.b - a.b);
  }
  return { r, g, b, fs, tStart, tEnd };
}

// Les `duration` dernières secondes.
export function resample(samples, fs = FS, duration = Infinity) {
  const n = samples.length;
  if (n < 2) return null;
  const tEnd = samples[n - 1].t;
  return resampleRange(samples, fs, Math.max(samples[0].t, tEnd - duration), tEnd);
}

function mean(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i];
  return s / (to - from);
}

export function std(x) {
  const m = mean(x);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - m) ** 2;
  return Math.sqrt(s / x.length);
}

// POS (Wang, den Brinker, Stuijk, de Haan, 2017) — "Plane-Orthogonal-to-Skin".
// Chaque fenêtre de 1,6 s est normalisée par sa moyenne : la teinte de peau disparaît
// et toute variation multiplicative commune aux 3 canaux (éclairage, exposition auto)
// s'annule dans les deux projections, orthogonales à [1, 1, 1].
export function pos(r, g, b, fs = FS, winSec = 1.6) {
  const N = r.length;
  const l = Math.round(winSec * fs);
  const h = new Float64Array(N);
  if (N < l) return h;
  const s1 = new Float64Array(l), s2 = new Float64Array(l), tmp = new Float64Array(l);
  for (let n = 0; n + l <= N; n++) {
    const mr = mean(r, n, n + l), mg = mean(g, n, n + l), mb = mean(b, n, n + l);
    if (!(mr > 0 && mg > 0 && mb > 0)) continue;
    for (let k = 0; k < l; k++) {
      const rn = r[n + k] / mr, gn = g[n + k] / mg, bn = b[n + k] / mb;
      s1[k] = gn - bn;
      s2[k] = gn + bn - 2 * rn;
    }
    const sd2 = std(s2);
    const alpha = sd2 > 1e-12 ? std(s1) / sd2 : 0;
    for (let k = 0; k < l; k++) tmp[k] = s1[k] + alpha * s2[k];
    const mh = mean(tmp);
    for (let k = 0; k < l; k++) h[n + k] += tmp[k] - mh;
  }
  return h;
}

// Méthode « vert seul » (Verkruysse 2008), gardée comme point de comparaison.
export function greenOnly(g) {
  const m = mean(g);
  const out = new Float64Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = m > 0 ? g[i] / m - 1 : 0;
  return out;
}

// Écrête à ±k écarts-types robustes (MAD) : un saut isolé ne doit pas dominer le spectre.
export function clipRobust(x, k = 4) {
  const sorted = Float64Array.from(x).sort();
  const med = sorted[sorted.length >> 1];
  const dev = Float64Array.from(x, (v) => Math.abs(v - med)).sort();
  const sigma = 1.4826 * dev[dev.length >> 1];
  if (!(sigma > 0)) return Float64Array.from(x);
  const lo = med - k * sigma, hi = med + k * sigma;
  return Float64Array.from(x, (v) => Math.min(hi, Math.max(lo, v)));
}

// Biquad (formules RBJ), ordre 2, Butterworth (Q = 1/√2).
function biquad(type, f0, fs) {
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const lp = type === 'lp';
  const b0 = (lp ? (1 - cos) : (1 + cos)) / 2;
  const b1 = lp ? 1 - cos : -(1 + cos);
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function runBiquad(c, x) {
  const y = new Float64Array(x.length);
  let x1 = x[0], x2 = x[0];
  // État initial « en régime » pour limiter le transitoire de bord.
  const dc = (c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2);
  let y1 = dc * x[0], y2 = dc * x[0];
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

// Passe-bande à phase nulle (aller-retour), avec bords prolongés par réflexion.
export function bandpass(x, fs = FS, lo = HR_MIN, hi = HR_MAX) {
  const N = x.length;
  const pad = Math.min(N - 1, Math.round(fs * 1.5));
  const ext = new Float64Array(N + 2 * pad);
  for (let i = 0; i < pad; i++) {
    ext[i] = 2 * x[0] - x[pad - i];
    ext[N + pad + i] = 2 * x[N - 1] - x[N - 2 - i];
  }
  ext.set(x, pad);
  const stages = [biquad('hp', lo, fs), biquad('lp', hi, fs)];
  let y = ext;
  for (const s of stages) y = runBiquad(s, y);
  y.reverse();
  for (const s of stages) y = runBiquad(s, y);
  y.reverse();
  return y.slice(pad, pad + N);
}

// FFT radix-2 en place.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Densité spectrale (fenêtre de Hann, zéro-padding à NFFT).
export function spectrum(x, fs = FS, nfft = NFFT) {
  const N = Math.min(x.length, nfft);
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  for (let i = 0; i < N; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  fft(re, im);
  const half = nfft / 2 + 1;
  const power = new Float64Array(half);
  for (let k = 0; k < half; k++) power[k] = re[k] ** 2 + im[k] ** 2;
  return { power, df: fs / nfft };
}

// Affine un indice de pic : maximum local de puissance à ±3 cases, puis parabole.
function refinePeak(power, k, df) {
  let best = k;
  for (let i = Math.max(1, k - 3); i <= Math.min(power.length - 2, k + 3); i++) if (power[i] > power[best]) best = i;
  const y0 = power[best - 1], y1 = power[best], y2 = power[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  return (best + delta) * df;
}

// SNR : énergie à ±0,1 Hz de f et ±0,2 Hz de 2f, contre le reste de 0,6–4 Hz.
export function snrAt(power, df, f) {
  let sig = 0, noise = 0;
  const bLo = Math.ceil(0.6 / df), bHi = Math.min(power.length - 1, Math.floor(4.0 / df));
  for (let i = bLo; i <= bHi; i++) {
    const fi = i * df;
    if (Math.abs(fi - f) <= 0.1 || Math.abs(fi - 2 * f) <= 0.2) sig += power[i];
    else noise += power[i];
  }
  return 10 * Math.log10((sig + 1e-30) / (noise + 1e-30));
}

// Contrôle des harmoniques : une onde de pouls a une harmonique 2. Si elle dépasse la
// fondamentale (bruit à basse fréquence), le plus haut pic donne le double du vrai rythme.
// Règle : s'il existe un vrai pic à la moitié de la fréquence, d'au moins HALF_RATIO
// fois la puissance du pic principal, c'est lui le rythme. Ratio choisi par
// tools/harmonic.mjs : sans contrôle, 26 à 33 valeurs doublées sur 40 sont affichées comme
// fiables ; à 0,25, une seule. Les fausses divisions par deux, elles, tombent toujours
// sous le seuil de qualité : elles masquent la valeur au lieu d'en afficher une fausse.
export const HALF_RATIO_SYNTHETIC = 0.25;
// Désactivé par défaut : sur 80 vraies vidéos (MCD-rPPG), le contrôle faisait plus de mal que de
// bien — de fausses divisions par deux passaient pour fiables (erreurs de −40 à −60 bpm).
// Sans lui : lectures affichées 40 % → 51 % à ≤ 1 % de lectures fausses (validation croisée).
// Sur ces vraies vidéos la fondamentale domine toujours l'harmonique.
export const HALF_RATIO = Infinity;

function peakIndex(power, df) {
  const kLo = Math.ceil(HR_MIN / df), kHi = Math.floor(HR_MAX / df);
  let k = kLo;
  for (let i = kLo; i <= kHi; i++) if (power[i] > power[k]) k = i;
  return k;
}

export function halfCheck(power, df, k, ratio = HALF_RATIO) {
  const kh = Math.round(k / 2);
  const kLo = Math.ceil(HR_MIN / df);
  let best = -1;
  for (let i = Math.max(kLo, kh - 4); i <= kh + 4; i++) {
    // Maximum local seulement : un flanc de pente n'est pas un pic.
    if (power[i] >= power[i - 1] && power[i] >= power[i + 1] && (best < 0 || power[i] > power[best])) best = i;
  }
  return best >= 0 && power[best] >= ratio * power[k] ? best : k;
}

// Pic dans 42–180 bpm, contrôle des harmoniques, et SNR.
// mask (optionnel) : spectre du mouvement dans [0, 1] ; les fréquences où la tête bouge
// sont dévaluées pour le choix du pic (pas pour le SNR, qui reste honnête).
// exclude : bandes de fréquences (Hz) à ignorer, pour un artefact connu d'une source vidéo
// (ex. rythme des images clés d'un caméscope : 30 / 12 = 2,5 Hz).
export function estimate(x, fs = FS, { ratio = HALF_RATIO, mask = null, kappa = 4, nfft = NFFT, exclude = null } = {}) {
  const { power, df } = spectrum(x, fs, nfft);
  if (exclude) for (const [lo, hi] of exclude) for (let i = Math.max(0, Math.floor(lo / df)); i <= Math.min(power.length - 1, Math.ceil(hi / df)); i++) power[i] = 0;
  const pick = mask ? power.map((v, i) => v / (1 + kappa * mask[i])) : power;
  const k = halfCheck(pick, df, peakIndex(pick, df), ratio);
  const f = refinePeak(power, k, df);
  return { f, bpm: f * 60, snr: snrAt(power, df, f), power, df };
}

// Seuils pour la grille du visage avec mémoire des cellules, calibrés sur vraies vidéos par
// validation croisée entre personnes (tools/cv-score.mjs) : lectures fausses ≤ 1 %.
export const GRID_THRESHOLDS = { good: 3.5, fair: 2.0 };

export function qualityOf(snr, { good = SNR_GOOD, fair = SNR_FAIR } = {}) {
  return snr >= good ? 'good' : snr >= fair ? 'fair' : 'poor';
}

// Rééchantillonne des vecteurs (ex. signaux de mouvement) sur la même grille que les couleurs.
export function resampleColumns(samples, fs, tStart, tEnd, get) {
  const list = samples.filter((s) => get(s));
  const k = get(list[list.length - 1]).length;
  const N = Math.floor((tEnd - tStart) * fs + 1e-9) + 1;
  const cols = Array.from({ length: k }, () => new Float64Array(N));
  let j = 0;
  for (let i = 0; i < N; i++) {
    const t = tStart + i / fs;
    while (j < list.length - 2 && list[j + 1].t < t) j++;
    const a = list[j], c = list[Math.min(j + 1, list.length - 1)];
    const span = c.t - a.t;
    const w = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
    const va = get(a), vc = get(c);
    for (let q = 0; q < k; q++) cols[q][i] = va[q] + w * (vc[q] - va[q]);
  }
  return cols;
}

function centered(x) {
  const m = mean(x);
  return Float64Array.from(x, (v) => v - m);
}

// Régresseurs de mouvement : chaque signal (position, échelle, rotations, bouche),
// éventuellement son carré (les reflets et l'ombrage ne sont pas linéaires), normalisés.
function motionRegressors(cols, { quad = true, band = true, fs = FS, deriv = false } = {}) {
  const feats = [];
  for (const c of cols) {
    const cc = centered(c);
    feats.push(cc);
    if (quad) feats.push(centered(Float64Array.from(cc, (v) => v * v)));
    // Vitesse (différence d'une image à l'autre) : le flou et les reflets dépendent aussi de la
    // vitesse du mouvement, pas seulement de la position.
    if (deriv) feats.push(centered(Float64Array.from(cc, (v, i) => (i ? v - cc[i - 1] : 0))));
  }
  const out = [];
  for (const f of feats) {
    const x = band ? bandpass(f, fs) : f;
    const sd = std(x);
    if (sd > 1e-9) out.push(Float64Array.from(x, (v) => v / sd));
  }
  return out;
}

// Moindres carrés (ridge léger) : retire de y la partie expliquée par les régresseurs X.
export function regressOut(y, X, ridge = 0.05) {
  const k = X.length, N = y.length;
  if (!k) return Float64Array.from(y);
  const A = Array.from({ length: k }, () => new Float64Array(k + 1));
  for (let a = 0; a < k; a++) {
    for (let b = a; b < k; b++) {
      let s = 0;
      for (let i = 0; i < N; i++) s += X[a][i] * X[b][i];
      A[a][b] = A[b][a] = s;
    }
    A[a][a] += ridge * N;
    let s = 0;
    for (let i = 0; i < N; i++) s += X[a][i] * y[i];
    A[a][k] = s;
  }
  // Élimination de Gauss avec pivot partiel.
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const piv = A[c][c];
    if (Math.abs(piv) < 1e-12) continue;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / piv;
      for (let q = c; q <= k; q++) A[r][q] -= f * A[c][q];
    }
  }
  const beta = A.map((row, c) => (Math.abs(row[c]) > 1e-12 ? row[k] / row[c] : 0));
  const out = Float64Array.from(y);
  for (let a = 0; a < k; a++) for (let i = 0; i < N; i++) out[i] -= beta[a] * X[a][i];
  return out;
}

// Valeur maximale d'un spectre normalisé à ±0,08 Hz d'une fréquence (spectre calculé avec NFFT).
function peakShare(spec, df, f) {
  const d = (FS / NFFT);
  let m = 0;
  for (let i = Math.max(0, Math.floor((f - 0.08) / d)); i <= Math.min(spec.length - 1, Math.ceil((f + 0.08) / d)); i++) m = Math.max(m, spec[i]);
  return m;
}

// Spectre du mouvement (somme des spectres des régresseurs normalisés), ramené à [0, 1].
function motionSpectrum(X, fs) {
  let acc = null;
  for (const x of X) {
    const { power } = spectrum(x, fs);
    if (!acc) acc = new Float64Array(power.length);
    for (let i = 0; i < power.length; i++) acc[i] += power[i];
  }
  if (!acc) return null;
  let max = 0;
  for (const v of acc) max = Math.max(max, v);
  return max > 0 ? acc.map((v) => v / max) : null;
}

// Signal de pouls d'un jeu de canaux rééchantillonnés.
// mc : correction du mouvement { X (régresseurs dans la bande), Xraw (bruts), domain }.
function pulseOf(rs, fs, method, mc = null) {
  let { r, g, b } = rs;
  if (mc?.domain === 'rgb' && mc.Xraw.length) {
    // Retire des couleurs (en relatif) la part qui suit le mouvement, avant POS.
    [r, g, b] = [r, g, b].map((c) => {
      const m = mean(c);
      const rel = regressOut(Float64Array.from(c, (v) => v / m - 1), mc.Xraw);
      return Float64Array.from(rel, (v) => m * (1 + v));
    });
  }
  const raw = method === 'green' ? greenOnly(g) : pos(r, g, b, fs);
  let p = bandpass(clipRobust(raw), fs);
  if (mc?.domain === 'pulse' && mc.X.length) p = regressOut(p, mc.X);
  return p;
}

// Analyse d'un tampon d'échantillons (les `window` dernières secondes).
// method : 'fusion' (zones pondérées, par défaut), 'pos' (toutes zones mélangées), 'green'.
// Correction du mouvement par défaut, choisie par tools/motion.mjs et tools/motion-choice.mjs :
// on retire des couleurs (avant POS) la part qui suit linéairement les signaux de mouvement.
// Sur 320 essais simulés : 204 justes contre 130 sans correction, 4 valeurs fausses
// affichées contre 38. Régresser le signal de pouls après POS, ou ajouter les carrés,
// ou ignorer les fréquences du mouvement : pas mieux, parfois pire.
export const DEFAULT_MOTION = { domain: 'rgb', quad: false, gate: true };

// Porte de mouvement : on ne corrige que si la tête bouge vraiment. Sur de vraies vidéos
// d'une personne immobile (MCD-rPPG), corriger quand même faisait perdre des mesures : la
// tête bouge très légèrement à chaque battement (balistocardiographie) et le suivi tremble,
// si bien que la régression retirait une partie du pouls. Seuils (écart-type sur la fenêtre,
// tendance linéaire retirée) placés entre le maximum mesuré immobile (x 0,4 %, y 1,3 %,
// rotation 1,8 %, bouche 1,6 %) et le minimum des scénarios en mouvement simulés.
// Indices : x, y (fraction de l'image), rotation (proxy), bouche — voir extract.js.
export const MOTION_GATE = [[0, 0.01], [1, 0.015], [4, 0.03], [6, 0.03]];

// Porte de la correction par le fond : variation relative du vert du fond dans la bande du pouls.
export const BG_GATE = 0.006;

function detrendedStd(c) {
  const n = c.length, mx = (n - 1) / 2;
  let m = 0;
  for (let i = 0; i < n; i++) m += c[i] / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (i - mx) * (c[i] - m); sxx += (i - mx) ** 2; }
  const b = sxy / sxx;
  let v = 0;
  for (let i = 0; i < n; i++) v += (c[i] - m - b * (i - mx)) ** 2;
  return Math.sqrt(v / n);
}

// Score de mouvement : max des écarts-types rapportés à leur seuil (> 1 = en mouvement).
export function motionScore(cols) {
  let score = 0;
  for (const [i, thr] of MOTION_GATE) if (cols[i]) score = Math.max(score, detrendedStd(cols[i]) / thr);
  return score;
}

// motion : correction du mouvement à partir des signaux de suivi (s.motion pour la tête,
// s.zones[z].m pour une zone qui bouge à part, comme une main) ;
// { domain: 'pulse' | 'rgb' | null, quad, mask, kappa } ; null = pas de correction.
// fusion : 'snr' (pondération par SNR linéaire au consensus, défaut), 'topk' (moyenne des K
// meilleures zones), 'equal' (moyenne simple) ; nfftZone : taille de FFT par zone (plus petite
// = plus rapide quand il y a beaucoup de zones, comme la grille du visage).
// zoneWeights (optionnel) : fonction (SNR au consensus par zone) → poids, pour une pondération
// qui garde une mémoire d'une fenêtre à l'autre (voir ZoneMemory).
export function analyze(samples, { fs = FS, window = 12, minWindow = 8, method = 'fusion', motion = DEFAULT_MOTION, fusion = 'snr', topK = 10, nfftZone = NFFT, zoneWeights = null, thresholds = undefined, halfRatio = HALF_RATIO, exclude = null, background = false } = {}) {
  if (samples.length < 2) return { ready: false, progress: 0 };
  const span = samples[samples.length - 1].t - samples[0].t;
  // Tolérance de 0,1 s (jusqu à deux images partielles aux bords) : à 30 i/s, une fenêtre « de 12 s » fait rarement 12,000 s pile ;
  // sans elle, window = minWindow faisait rejeter presque toutes les fenêtres.
  if (span < minWindow - 0.1) return { ready: false, progress: Math.max(0, span / minWindow) };
  const tEnd = samples[samples.length - 1].t;
  const tStart = Math.max(samples[0].t, tEnd - window);
  const rs = resampleRange(samples, fs, tStart, tEnd);

  let mc = null, mask = null, moving = false, motionSpec = null;
  if (motion && samples[samples.length - 1].motion) {
    const cols = resampleColumns(samples, fs, tStart, tEnd, (s) => s.motion);
    moving = motionScore(cols) > 1;
    // Spectre du mouvement de la tête (normalisé à 1) : sert à savoir si la fréquence retenue
    // est celle du mouvement plutôt que celle du pouls.
    if (moving) motionSpec = motionSpectrum(motionRegressors(cols, { quad: false, band: true, fs }), fs);
  }
  if (motion && samples[samples.length - 1].motion && (moving || !motion.gate)) {
    const cols = resampleColumns(samples, fs, tStart, tEnd, (s) => s.motion);
    const X = motionRegressors(cols, { quad: motion.quad, band: true, fs, deriv: motion.deriv });
    mc = {
      domain: motion.domain ?? null,
      X,
      Xraw: motion.domain === 'rgb' ? motionRegressors(cols, { quad: motion.quad, band: false, fs, deriv: motion.deriv }) : [],
    };
    if (motion.mask) mask = motionSpec ?? motionSpectrum(motionRegressors(cols, { quad: false, band: true, fs }), fs);
  }
  // Référence de fond (mur à côté de la tête) : ses variations de couleur sont celles de la
  // lumière ; on les retire des couleurs de la peau avant POS, comme le mouvement.
  let Xbg = [], lightChanging = false;
  if (background) {
    const withBg = samples.filter((s) => s.bg && s.t >= tStart);
    const total = samples.filter((s) => s.t >= tStart).length;
    if (withBg.length >= 0.8 * total && withBg.length > 10) {
      const cols = resampleColumns(withBg, fs, tStart, tEnd, (s) => [s.bg.r, s.bg.g, s.bg.b]);
      const rel = cols.map((c) => { const m = mean(c); return Float64Array.from(c, (v) => (m > 0 ? v / m - 1 : 0)); });
      // Porte : on ne corrige que si la lumière du fond varie vraiment dans la bande du pouls
      // (fond immobile : ~0,27 % ; lampe qui scintille à 2 % : > 0,7 %). Sinon la régression
      // coûte un peu de signal pour rien.
      lightChanging = std(bandpass(rel[1], fs)) > BG_GATE;
      if (lightChanging || background === 'always') Xbg = motionRegressors(rel, { quad: false, band: false, fs });
    }
  }
  if (Xbg.length) {
    mc = mc ? { ...mc, domain: 'rgb', Xraw: [...(mc.Xraw ?? []), ...Xbg] } : { domain: 'rgb', X: [], Xraw: Xbg };
  }
  const est = (x) => estimate(x, fs, { mask, kappa: motion?.kappa ?? 4, ratio: halfRatio, exclude });

  const green = est(pulseOf(rs, fs, 'green'));
  const combinedPulse = pulseOf(rs, fs, 'pos', mc);
  const combined = est(combinedPulse);

  let pulse = method === 'green' ? pulseOf(rs, fs, 'green') : combinedPulse;
  let used = method === 'green' ? 'green' : 'pos';
  let zones = null, agreement = null, working = 0;

  const nz = samples[samples.length - 1].zones?.length ?? 0;
  if (method === 'fusion' && nz > 0) {
    // Chaque zone (front, joues) est analysée seule, puis pondérée par son SNR linéaire
    // mesuré à la fréquence sur laquelle les zones s'accordent (2 passes) : une zone masquée
    // par des cheveux ou dans l'ombre ne dilue plus les autres, et une zone dont le pic est
    // ailleurs ne vote pas pour lui. Règle choisie par tools/fusion.mjs.
    const parts = [];
    for (let z = 0; z < nz; z++) {
      const list = [];
      let total = 0;
      for (const s of samples) {
        if (s.t < tStart) continue;
        total++;
        const v = s.zones?.[z];
        if (v) list.push({ t: s.t, r: v.r, g: v.g, b: v.b, m: v.m ?? s.motion });
      }
      if (list.length < 2 || list.length < 0.8 * total) { parts.push(null); continue; }
      // Une zone qui bouge à part (main, pied) est corrigée avec son propre mouvement.
      let zmc = mc;
      if (motion && list[0].m && samples[samples.length - 1].zones[z]?.m) {
        const cols = resampleColumns(list, fs, tStart, tEnd, (x) => x.m);
        // Main, avant-bras, pied : même porte, sur sa propre position (x, y).
        const partMoving = motionScore([cols[0], cols[1]]) > 1;
        zmc = !partMoving && motion.gate ? (Xbg.length ? { domain: 'rgb', X: [], Xraw: Xbg } : null) : {
          domain: motion.domain ?? null,
          X: motionRegressors(cols, { quad: motion.quad, band: true, fs }),
          Xraw: [...(motion.domain === 'rgb' ? motionRegressors(cols, { quad: motion.quad, band: false, fs }) : []), ...Xbg],
        };
      }
      const p = pulseOf(resampleRange(list, fs, tStart, tEnd), fs, 'pos', zmc);
      const e = estimate(p, fs, { mask, kappa: motion?.kappa ?? 4, nfft: nfftZone, ratio: halfRatio, exclude });
      parts.push({ p, e, sd: std(p) || 1 });
    }
    const valid = parts.filter(Boolean);
    if (valid.length) {
      const mix = (weights) => {
        const out = new Float64Array(rs.r.length);
        parts.forEach((pt, k) => {
          if (!pt || !weights[k]) return;
          for (let i = 0; i < out.length; i++) out[i] += (weights[k] / pt.sd) * pt.p[i];
        });
        return out;
      };
      let weights = parts.map((pt) => (pt ? 10 ** (pt.e.snr / 10) : 0));
      const first = est(mix(weights));
      const consensus = parts.map((pt) => (pt ? snrAt(pt.e.power, pt.e.df, first.f) : -Infinity));
      if (zoneWeights) weights = zoneWeights(consensus);
      else if (fusion === 'equal') weights = parts.map((pt) => (pt ? 1 : 0));
      else if (fusion === 'topk') {
        const cut = [...consensus].sort((x, y) => y - x)[Math.min(topK, consensus.length) - 1];
        weights = consensus.map((c) => (c >= cut && c > -Infinity ? 1 : 0));
      } else weights = consensus.map((c) => (c > -Infinity ? 10 ** (c / 10) : 0));
      const wsum = weights.reduce((a, b) => a + b, 0);
      pulse = mix(weights);
      used = 'fusion';
      // Accord : part des zones présentes dont le pouls ressort à la fréquence retenue (SNR ≥ 0 dB).
      // Un vrai pouls apparaît sur beaucoup de cellules à la fois ; un pic de bruit, sur quelques-unes.
      const present = consensus.filter(Number.isFinite);
      agreement = present.length ? present.filter((c) => c >= 0).length / present.length : 0;
      working = present.filter((c) => c >= 0).length;
      zones = parts.map((pt, k) =>
        pt ? { bpm: pt.e.bpm, snr: consensus[k], weight: weights[k] / wsum } : null,
      );
    }
  }

  const fin = pulse === combinedPulse ? combined : est(pulse);
  return {
    ready: true,
    t: tEnd,
    bpm: fin.bpm,
    snr: fin.snr,
    quality: qualityOf(fin.snr, thresholds),
    wave: pulse,
    power: fin.power,
    df: fin.df,
    motionCorrected: !!mc,
    moving,
    lightChanging,
    agreement,
    working,
    // Part du mouvement de la tête à la fréquence retenue (0 = aucun, 1 = pic du mouvement).
    motionAtPeak: motionSpec ? peakShare(motionSpec, fin.df, fin.f) : 0,
    method: used,
    zones,
    combinedBpm: combined.bpm,
    combinedSnr: combined.snr,
    greenBpm: green.bpm,
    greenSnr: green.snr,
  };
}

// Mémoire de la qualité de chaque zone d'une fenêtre à l'autre : moyenne glissante du SNR au
// consensus (en dB). Une zone qui portait bien le pouls il y a quelques secondes garde du poids
// même si cette fenêtre-ci est bruitée, et inversement : la pondération suit moins le bruit.
export class ZoneMemory {
  constructor({ alpha = 0.2, floor = -10 } = {}) {
    this.alpha = alpha;
    this.floor = floor;
    this.ema = null;
  }

  reset() { this.ema = null; }

  // À passer comme zoneWeights à analyze.
  weigh = (consensus) => {
    if (!this.ema || this.ema.length !== consensus.length) this.ema = consensus.map(() => null);
    return consensus.map((c, i) => {
      const v = Number.isFinite(c) ? c : this.floor;
      this.ema[i] = this.ema[i] === null ? v : this.ema[i] + this.alpha * (v - this.ema[i]);
      return Number.isFinite(c) ? 10 ** (this.ema[i] / 10) : 0;
    });
  };
}

// Suivi du rythme d'une fenêtre à l'autre. Au lieu de prendre le plus haut pic de chaque
// fenêtre indépendamment, on cherche le pic près de la valeur précédente (a priori gaussien) ;
// on ne saute vers un autre pic que s'il gagne plusieurs fenêtres de suite.
export class HrTracker {
  // staleAfter = 2 s : sur vraies vidéos, garder la valeur 5 s affichait 3 % de valeurs fausses
  // (plus de 5 bpm d'écart) ; 2 s, 1 %, pour presque autant de temps couvert.
  constructor({ sigma = 6, switchAfter = 4, staleAfter = 2 } = {}) {
    this.sigma = sigma;           // bpm
    this.switchAfter = switchAfter; // fenêtres consécutives
    this.staleAfter = staleAfter; // s sans mesure fiable → valeur périmée
    this.reset();
  }

  reset() {
    this.bpm = null;
    this.disagree = 0;
    this.lastGoodT = null;
  }

  // r : résultat d'analyze. Renvoie le rythme suivi (ou null).
  update(r) {
    if (!r?.ready) return this.bpm;
    if (r.quality === 'poor') return this.bpm;
    const free = r.bpm;
    this.lastGoodT = r.t ?? null;
    if (this.bpm === null) { this.bpm = free; return this.bpm; }
    const { power, df } = r;
    const kLo = Math.ceil(HR_MIN / df), kHi = Math.floor(HR_MAX / df);
    let k = kLo, best = -Infinity;
    for (let i = kLo; i <= kHi; i++) {
      const d = i * df * 60 - this.bpm;
      const v = power[i] * Math.exp(-(d * d) / (2 * this.sigma * this.sigma));
      if (v > best) { best = v; k = i; }
    }
    const near = refinePeak(power, k, df) * 60;
    if (Math.abs(free - near) > 2 * this.sigma) this.disagree++;
    else this.disagree = 0;
    this.bpm = this.disagree >= this.switchAfter ? free : near;
    if (this.disagree >= this.switchAfter) this.disagree = 0;
    return this.bpm;
  }

  // Valeur à afficher au temps t (null si plus de mesure fiable depuis staleAfter s).
  value(t) {
    if (this.bpm === null || this.lastGoodT === null) return null;
    return t - this.lastGoodT > this.staleAfter ? null : this.bpm;
  }
}

// Analyse glissante d'un enregistrement complet (banc d'essai, tests).
export function slidingAnalysis(samples, { step = 0.5, window = 12, minWindow = 8, method = 'fusion', motion = DEFAULT_MOTION, ...rest } = {}) {
  const out = [];
  if (samples.length < 2) return out;
  const t0 = samples[0].t, tLast = samples[samples.length - 1].t;
  let lo = 0, hi = 0;
  for (let tEnd = t0 + minWindow; tEnd <= tLast + 1e-9; tEnd += step) {
    while (hi < samples.length && samples[hi].t <= tEnd + 1e-9) hi++;
    while (lo < hi && samples[lo].t < tEnd - window - 1e-9) lo++;
    const r = analyze(samples.slice(lo, hi), { window, minWindow, method, motion, ...rest });
    if (r.ready) out.push(r);
  }
  return out;
}

// Résumé d'un enregistrement : médiane des valeurs affichables, et part du temps couvert.
export function summarizeRun(results, { tracked = false } = {}) {
  const values = [];
  const tracker = new HrTracker();
  for (const r of results) {
    if (tracked) {
      tracker.update(r);
      const v = tracker.value(r.t);
      if (v !== null) values.push(v);
    } else if (r.quality !== 'poor') values.push(r.bpm);
  }
  return { bpm: median(values), coverage: results.length ? values.length / results.length : 0 };
}

// Médiane.
export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
