// Générateur synthétique : couleur moyenne d'une zone de peau avec pouls connu,
// éclairage variable, reflets et bruit capteur. Sert aux tests et au mode démo.

// Direction du pouls dans l'espace RVB normalisé (« PBV », de Haan & van Leest 2014).
const PBV = [0.33, 0.77, 0.53];
export const SKIN = [180, 130, 105];

export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Renvoie sample(t) → { r, g, b, truth } ; `truth` = fréquence cardiaque instantanée (bpm).
export function makeSynth({
  bpm = 72,           // nombre, ou fonction du temps (bpm(t))
  pulseAmp = 0.003,   // variation relative du vert due au pouls (~0,3 %)
  harmonic = 0.35,    // amplitude de l'harmonique 2 (relative à la fondamentale)
  hrv = 0.03,         // arythmie respiratoire : ±3 % à 0,25 Hz
  drift = 0.02,       // dérive lente de l'éclairage
  flicker = 0,        // scintillement dans la bande cardiaque (multiplicatif)
  flickerHz = 1.3,
  specular = 0,       // reflet blanc additif (fraction de 255)
  artifact = null,    // { from, to, hz, amp, color } : lumière colorée additive (niveaux)
  noise = 0.3,        // bruit capteur après moyenne spatiale (niveaux 0–255)
  seed = 1,
} = {}) {
  const rand = rng(seed);
  const scale = PBV.map((v) => v / PBV[1]);
  const bpmAt = typeof bpm === 'function' ? bpm : () => bpm;
  let phase = 0, lastT = null;
  return (t) => {
    const dt = lastT === null ? 0 : t - lastT;
    lastT = t;
    const f = (bpmAt(t) / 60) * (1 + hrv * Math.sin(2 * Math.PI * 0.25 * t));
    phase += 2 * Math.PI * f * dt;
    // Onde PPG asymétrique : fondamentale + harmonique 2.
    const p = Math.sin(phase) + harmonic * Math.sin(2 * phase - 0.8);
    const light =
      1 + drift * Math.sin(2 * Math.PI * 0.05 * t) + flicker * Math.sin(2 * Math.PI * flickerHz * t);
    const spec = specular * 255 * light * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.4 * t + 1));
    let art = 0;
    if (artifact && t >= artifact.from && t <= artifact.to) art = artifact.amp * Math.sin(2 * Math.PI * artifact.hz * t);
    const color = artifact?.color ?? [1, 1, 1];
    const [r, g, b] = SKIN.map(
      (base, c) => base * light * (1 - pulseAmp * scale[c] * p) + spec + art * color[c] + noise * gaussian(rand),
    );
    return { r, g, b, truth: f * 60 };
  };
}

// Suite d'échantillons sur `seconds` secondes, avec gigue d'horodatage et images perdues.
export function synthSamples(opts = {}, { seconds = 12, fps = 30, jitter = 0, drop = 0, seed = 7 } = {}) {
  const sample = makeSynth(opts);
  const rand = rng(seed);
  const out = [];
  for (let i = 0; i < seconds * fps; i++) {
    if (drop && rand() < drop) continue;
    const t = i / fps + (jitter ? (rand() - 0.5) * 2 * jitter : 0);
    out.push({ t, ...sample(t) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Plusieurs zones (front, joue gauche, joue droite) avec le même pouls mais leurs propres
// perturbations. La moyenne globale pondère les zones par leur nombre de pixels.
export function synthZones(zoneOpts, { seconds = 12, fps = 30, pixels = null } = {}) {
  const gens = zoneOpts.map((o) => makeSynth(o));
  const px = pixels ?? zoneOpts.map(() => 1);
  const total = px.reduce((a, b) => a + b, 0);
  const out = [];
  for (let i = 0; i < seconds * fps; i++) {
    const t = i / fps;
    const zones = gens.map((g) => g(t));
    const avg = (c) => zones.reduce((s, z, k) => s + z[c] * px[k], 0) / total;
    out.push({ t, r: avg('r'), g: avg('g'), b: avg('b'), truth: zones[0].truth, zones: zones.map(({ r, g, b }) => ({ r, g, b })) });
  }
  return out;
}

// ---------- Mouvement de la tête dans une scène éclairée ----------
// Deux lampes de couleurs différentes (chaude à gauche, froide à droite) + ambiance.
// Quand la tête bouge ou tourne, chaque zone reçoit un mélange de lumières différent :
// sa COULEUR change, pas seulement sa luminosité, ce que POS ne sait pas annuler seul.
// Renvoie aussi les signaux de mouvement que donnerait le suivi du visage (avec un peu de
// bruit de suivi), dans l'ordre de MOTION_FEATURES.
export const MOTION_FEATURES = ['x', 'y', 'scale', 'roll', 'yaw', 'pitch', 'mouth'];

const WARM = [1.0, 0.78, 0.55], COOL = [0.72, 0.86, 1.0];
// Zones : front, joue gauche, joue droite (angle de la normale par rapport au visage).
const ZONE_ANGLE = [0, -0.55, 0.55];

function bandNoise(rand, freqs) {
  // Somme de sinusoïdes de phases et amplitudes aléatoires : mouvement irrégulier.
  const parts = freqs.map((f) => ({ f, ph: rand() * Math.PI * 2, a: 0.5 + rand() }));
  const norm = Math.sqrt(parts.reduce((s, p) => s + p.a * p.a, 0) / 2);
  return (t) => parts.reduce((s, p) => s + p.a * Math.sin(2 * Math.PI * p.f * t + p.ph), 0) / norm;
}

export function synthMotion({
  bpm = 80,
  motion = 'random',  // 'still' | 'random' | 'talking' | 'turns' | 'exercise'
  amp = 1,            // échelle du mouvement
  cadence = 1.6,      // Hz, pour 'exercise' (pédalage, course)
  pulseAmp = 0.003,
  noise = 0.25,
  trackNoise = 0.002,
  seconds = 20,
  fps = 30,
  seed = 1,
} = {}) {
  const rand = rng(seed);
  const pulse = makeSynth({ bpm, pulseAmp: 1, noise: 0, drift: 0, seed }); // on lit seulement la forme
  const n = (fs) => bandNoise(rand, fs);
  const zero = () => 0;
  let m;
  if (motion === 'still') m = { x: zero, y: zero, yaw: zero, roll: zero, scale: zero, mouth: zero };
  else if (motion === 'random') {
    const [x, y, yaw, roll, s] = [n([0.15, 0.4, 0.9, 1.4]), n([0.2, 0.6, 1.1]), n([0.1, 0.35, 0.8, 1.3]), n([0.25, 0.7]), n([0.1, 0.3])];
    m = { x: (t) => 0.05 * x(t), y: (t) => 0.03 * y(t), yaw: (t) => 0.25 * yaw(t), roll: (t) => 0.06 * roll(t), scale: (t) => 0.04 * s(t), mouth: zero };
  } else if (motion === 'talking') {
    const [nod, yaw, syl] = [n([0.4, 1.1, 1.9]), n([0.2, 0.6, 1.2]), n([2.7, 3.9, 4.6, 5.3])];
    m = { x: zero, y: (t) => 0.012 * nod(t), yaw: (t) => 0.1 * yaw(t), roll: zero, scale: zero, mouth: (t) => 0.5 * Math.max(0, syl(t)) };
  } else if (motion === 'turns') {
    m = { x: (t) => 0.02 * Math.sin(2 * Math.PI * 0.21 * t), y: zero, yaw: (t) => 0.5 * Math.sin(2 * Math.PI * 0.21 * t), roll: zero, scale: zero, mouth: zero };
  } else if (motion === 'exercise') {
    const drift = n([0.05, 0.12]);
    m = {
      x: (t) => 0.025 * Math.sin(Math.PI * cadence * t) + 0.02 * drift(t),
      y: (t) => 0.035 * Math.sin(2 * Math.PI * cadence * t),
      yaw: (t) => 0.12 * Math.sin(Math.PI * cadence * t + 0.5),
      roll: (t) => 0.05 * Math.sin(Math.PI * cadence * t),
      scale: (t) => 0.02 * drift(t + 7),
      mouth: (t) => 0.2 * Math.max(0, Math.sin(2 * Math.PI * cadence * t)),
    };
  } else throw new Error(`mouvement inconnu : ${motion}`);

  const out = [];
  const base = SKIN.map((v) => v / 0.95); // niveau moyen ≈ SKIN tête immobile
  for (let i = 0; i < seconds * fps; i++) {
    const t = i / fps;
    const p = pulse(t);
    const pv = (p.g - SKIN[1]) / -SKIN[1]; // forme d'onde du pouls (relative), signée
    const hx = amp * m.x(t), hy = amp * m.y(t), yaw = amp * m.yaw(t), mouth = amp * m.mouth(t);
    const zones = ZONE_ANGLE.map((za, z) => {
      const phi = yaw + za;                              // orientation de la zone
      const px = hx + [0, -0.06, 0.06][z];               // position de la zone dans la scène
      const iw = Math.max(0, 0.55 + 0.45 * Math.cos(phi + 1.0)) / (1 + 4 * (px + 0.6) ** 2);
      const ic = Math.max(0, 0.55 + 0.45 * Math.cos(phi - 1.0)) / (1 + 4 * (px - 0.6) ** 2);
      const vertical = 1 - 1.5 * hy;                     // lampe de plafond
      const talk = z > 0 ? 1 - 0.06 * mouth : 1;         // la joue se creuse en parlant
      const spec = z === 0 ? 0.05 * Math.max(0, Math.cos(phi + 1.0)) ** 12 : 0; // reflet sur le front
      const [r, g, b] = [0, 1, 2].map((c) => {
        const light = (0.35 + 0.55 * iw * WARM[c] / 0.62 + 0.55 * ic * COOL[c] / 0.62) * vertical * talk;
        const pulseC = 1 - pulseAmp * [0.43, 1, 0.69][c] * pv;
        return base[c] * light * pulseC * 0.62 + 255 * spec * WARM[c] + noise * gaussian(rand);
      });
      return { r, g, b };
    });
    const avg = (c) => zones.reduce((s, zn) => s + zn[c], 0) / 3;
    const tn = () => trackNoise * gaussian(rand);
    out.push({
      t, r: avg('r'), g: avg('g'), b: avg('b'), zones, truth: p.truth,
      // Ce que verrait le suivi du visage : position, échelle, inclinaison, rotation (proxy),
      // hochement (proxy), ouverture de la bouche — avec un peu de bruit.
      motion: [hx + tn(), hy + tn(), 1 + amp * m.scale(t) + tn(), amp * m.roll(t) + tn(), Math.sin(yaw) * 0.35 + tn(), hy * 0.5 + tn(), mouth * 0.3 + tn()],
    });
  }
  return out;
}
