// Chaque amélioration doit battre l'ancienne méthode sur un cas fait pour la mettre en défaut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, slidingAnalysis, summarizeRun, HrTracker, spectrum, HR_MIN, HR_MAX } from '../js/dsp.js';
import { synthSamples, synthZones, synthMotion, makeSynth, rng, gaussian, SKIN } from '../js/synth.js';
import { SkinFilter } from '../js/skin.js';

const near = (a, b, tol) => Math.abs(a - b) < tol;

// Le contrôle est désactivé par défaut (nuisible sur vraies vidéos) ; on vérifie qu'il marche
// toujours quand on l'active explicitement.
test('harmonique plus forte que la fondamentale : avec le contrôle activé, on lit 60, pas 120', async () => {
  const { HALF_RATIO_SYNTHETIC } = await import('../js/dsp.js');
  let ok = 0, rawWrong = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const r = analyze(synthSamples({ bpm: 60, harmonic: 1.4, noise: 0.2, seed }), { halfRatio: HALF_RATIO_SYNTHETIC });
    if (near(r.bpm, 60, 2)) ok++;
    // Pic brut (sans score harmonique) : doit tomber sur 120, sinon le test ne prouve rien.
    let k = Math.ceil(HR_MIN / r.df);
    for (let i = k; i <= Math.floor(HR_MAX / r.df); i++) if (r.power[i] > r.power[k]) k = i;
    if (near(k * r.df * 60, 120, 3)) rawWrong++;
  }
  console.log(`  contrôle des harmoniques juste ${ok}/10, pic brut sur 120 : ${rawWrong}/10`);
  assert.ok(rawWrong >= 8, 'le cas de test doit tromper le pic brut');
  assert.ok(ok >= 9);
});

test('fusion des zones : une zone très bruitée (cheveux) ne ruine plus la mesure', () => {
  let fusionOk = 0, mixedOk = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const s = synthZones([
      { bpm: 78, noise: 4, seed: seed * 3 },       // front couvert : surtout du bruit
      { bpm: 78, noise: 0.4, seed: seed * 3 + 1 }, // joues propres
      { bpm: 78, noise: 0.4, seed: seed * 3 + 2 },
    ]);
    const f = analyze(s);
    const m = analyze(s, { method: 'pos' });
    if (near(f.bpm, 78, 2) && f.quality !== 'poor') fusionOk++;
    if (near(m.bpm, 78, 2) && m.quality !== 'poor') mixedOk++;
    if (seed === 1) console.log(`  poids des zones : ${f.zones.map((z) => z.weight.toFixed(2)).join(' / ')}`);
  }
  console.log(`  fusion ${fusionOk}/12, mélange ${mixedOk}/12`);
  assert.ok(fusionOk >= 11);
  assert.ok(fusionOk > mixedOk);
});

test('fusion des zones : sans perturbation, aussi bonne que le mélange', () => {
  const s = synthZones([{ bpm: 95, seed: 1 }, { bpm: 95, seed: 2 }, { bpm: 95, seed: 3 }]);
  const r = analyze(s);
  assert.equal(r.method, 'fusion');
  assert.ok(near(r.bpm, 95, 1.5), `bpm=${r.bpm}`);
  assert.equal(r.quality, 'good');
});

test('suivi : moins d\'erreurs que des fenêtres indépendantes sur signal bruité', () => {
  let rawOk = 0, trackOk = 0, total = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const s = synthSamples({ bpm: 70, noise: 0.45, seed: seed * 17 }, { seconds: 40 });
    const res = slidingAnalysis(s, { method: 'pos' });
    const tr = new HrTracker();
    for (const r of res) {
      tr.update(r);
      const v = tr.value(r.t);
      total++;
      if (r.quality !== 'poor' && near(r.bpm, 70, 3)) rawOk++;
      if (v !== null && near(v, 70, 3)) trackOk++;
    }
  }
  console.log(`  fenêtres justes et affichées : indépendantes ${rawOk}/${total}, suivi ${trackOk}/${total}`);
  assert.ok(trackOk > rawOk);
});

test('suivi : suit une montée progressive 65 → 95 bpm', () => {
  const bpm = (t) => 65 + (30 * t) / 40;
  const s = synthSamples({ bpm, seed: 5 }, { seconds: 40 });
  const res = slidingAnalysis(s, { method: 'pos' });
  const tr = new HrTracker();
  let ok = 0;
  for (const r of res) {
    tr.update(r);
    if (near(tr.value(r.t), bpm(r.t - 6), 4)) ok++; // vérité = milieu de la fenêtre de 12 s
  }
  console.log(`  ${ok}/${res.length} fenêtres à ±4 bpm`);
  assert.ok(ok / res.length >= 0.9);
});

test('suivi : valeur périmée après 5 s sans mesure fiable', () => {
  const tr = new HrTracker();
  const r = analyze(synthSamples({ bpm: 72 }));
  tr.update(r);
  assert.ok(near(tr.value(r.t), 72, 2));
  tr.update({ ...r, quality: 'poor', t: r.t + 6 });
  assert.equal(tr.value(r.t + 6), null);
});

// Pixels d'une zone : peau (pouls inclus) + mèches de cheveux d'une autre teinte.
function zonePixels(rand, skin, hairFrac, n = 1200) {
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const hair = i < hairFrac * n;
    const base = hair ? [50, 38, 44] : [skin.r, skin.g, skin.b];
    r[i] = base[0] + 4 * gaussian(rand);
    g[i] = base[1] + 4 * gaussian(rand);
    b[i] = base[2] + 4 * gaussian(rand);
  }
  return { r, g, b, n };
}

test('filtre de peau : écarte les cheveux et garde la peau', () => {
  const f = new SkinFilter();
  const rand = rng(3);
  const px = zonePixels(rand, { r: SKIN[0], g: SKIN[1], b: SKIN[2] }, 0.3);
  const m = f.apply(px.r, px.g, px.b, px.n);
  assert.ok(near(m.r, SKIN[0], 1) && near(m.g, SKIN[1], 1) && near(m.b, SKIN[2], 1), JSON.stringify(m));
  assert.ok(m.kept > 0.66 && m.kept < 0.72, `kept=${m.kept}`);
});

test('filtre de peau : aussi bon qu\'une moyenne de peau idéale, même si les mèches couvrent 75 % de la zone', () => {
  const avg = { raw: 0, oracle: 0, filt: 0 };
  const seeds = 10;
  for (let seed = 1; seed <= seeds; seed++) {
    const synth = makeSynth({ bpm: 84, noise: 0, seed });
    const rand = rng(seed * 7 + 1), walk = rng(seed * 13), filter = new SkinFilter();
    const raw = [], oracle = [], filt = [];
    let frac = 0.3, v = 0;
    for (let i = 0; i < 360; i++) {
      const t = i / 30;
      // Mèches : marche aléatoire amortie (mouvement irrégulier), de 5 à 75 % de la zone.
      v = 0.9 * v + 0.02 * (walk() - 0.5);
      frac = Math.min(0.75, Math.max(0.05, frac + v));
      const skin = synth(t), n = 1200;
      const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
      const a = [0, 0, 0], o = [0, 0, 0];
      let on = 0;
      for (let k = 0; k < n; k++) {
        const hair = k < frac * n, base = hair ? [50, 38, 44] : [skin.r, skin.g, skin.b];
        r[k] = base[0] + 4 * gaussian(rand); g[k] = base[1] + 4 * gaussian(rand); b[k] = base[2] + 4 * gaussian(rand);
        a[0] += r[k]; a[1] += g[k]; a[2] += b[k];
        if (!hair) { o[0] += r[k]; o[1] += g[k]; o[2] += b[k]; on++; }
      }
      raw.push({ t, r: a[0] / n, g: a[1] / n, b: a[2] / n });
      oracle.push({ t, r: o[0] / on, g: o[1] / on, b: o[2] / on });
      const m = filter.apply(r, g, b, n);
      assert.ok(m, `image ${i} sans résultat`);
      filt.push({ t, ...m });
    }
    avg.raw += analyze(raw).snr / seeds;
    avg.oracle += analyze(oracle).snr / seeds;
    avg.filt += analyze(filt).snr / seeds;
  }
  console.log(`  SNR moyen : brut ${avg.raw.toFixed(2)} dB, peau idéale ${avg.oracle.toFixed(2)}, filtre ${avg.filt.toFixed(2)}`);
  assert.ok(Math.abs(avg.filt - avg.oracle) < 0.2);
  assert.ok(avg.filt > avg.raw + 1);
});

test('résumé d\'un enregistrement', () => {
  const s = synthZones([{ bpm: 66, seed: 1 }, { bpm: 66, seed: 2 }, { bpm: 66, seed: 3 }], { seconds: 20 });
  const res = slidingAnalysis(s);
  assert.equal(res.length, 24); // fenêtres finissant à 8 s, 8,5 s … 19,5 s
  const sum = summarizeRun(res, { tracked: true });
  assert.ok(near(sum.bpm, 66, 1.5) && sum.coverage > 0.9, JSON.stringify(sum));
});

test('mouvement : la correction par les signaux de suivi bat l\'absence de correction', () => {
  const scenarios = [
    { motion: 'talking', bpm: 84 },
    { motion: 'random', bpm: 76 },
    { motion: 'exercise', bpm: 128, cadence: 1.55 },
  ];
  let withOk = 0, withoutOk = 0, withWrong = 0, total = 0;
  for (const sc of scenarios) {
    for (let seed = 1; seed <= 12; seed++) {
      const s = synthMotion({ ...sc, seed, seconds: 12 });
      const a = analyze(s), b = analyze(s, { motion: null });
      total++;
      if (a.quality !== 'poor') near(a.bpm, sc.bpm, 3) ? withOk++ : withWrong++;
      if (b.quality !== 'poor' && near(b.bpm, sc.bpm, 3)) withoutOk++;
    }
  }
  console.log(`  avec correction ${withOk}/${total} (faux affichés ${withWrong}), sans ${withoutOk}/${total}`);
  assert.ok(withOk >= withoutOk + 8);
  assert.ok(withWrong <= 1);
});

test('mouvement : tête immobile, la correction ne coûte rien', () => {
  let ok = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const r = analyze(synthMotion({ motion: 'still', bpm: 70, seed, seconds: 12 }));
    if (r.quality !== 'poor' && near(r.bpm, 70, 2)) ok++;
  }
  assert.equal(ok, 12);
});

test('mouvement propre à une zone (main) : corrigé avec son propre mouvement', () => {
  // Zones 0–2 : visage immobile ; zone 3 : une main qui bouge, avec son mouvement à elle.
  const face = synthMotion({ motion: 'still', bpm: 90, seed: 4, seconds: 12 });
  const hand = synthMotion({ motion: 'random', amp: 2, bpm: 90, seed: 5, seconds: 12 });
  const s = face.map((f, i) => ({ ...f, zones: [...f.zones, { ...hand[i].zones[1], m: hand[i].motion }] }));
  const r = analyze(s);
  assert.ok(near(r.bpm, 90, 2) && r.quality !== 'poor', `bpm=${r.bpm}`);
});

test('zones en option : manche écartée, paume plus claire gardée', async () => {
  const { Extractor } = await import('../js/extract.js');
  const face = { r: 150, g: 100, b: 80, n: 500 };          // peau du visage
  const zones = [face, face, face,
    { r: 205, g: 150, b: 135, n: 300 },                     // paume plus claire et rose
    null,
    null,
    { r: 90, g: 70, b: 120, n: 300 },                       // manche violette
    { r: 140, g: 140, b: 145, n: 300 },                     // manche grise
    null, null];
  Extractor.prototype.dropNonSkin.call(null, zones);
  assert.ok(zones[3], 'la paume doit rester');
  assert.equal(zones[6], null);
  assert.equal(zones[7], null);
});

test('mémoire des zones : une zone bonne longtemps garde du poids sur une fenêtre bruitée', async () => {
  const { ZoneMemory } = await import('../js/dsp.js');
  const mem = new ZoneMemory({ alpha: 0.2 });
  for (let i = 0; i < 20; i++) mem.weigh([6, -4, 2]);        // zone 0 bonne, zone 1 mauvaise
  const w = mem.weigh([-4, 6, 2]);                            // une fenêtre où tout s'inverse
  assert.ok(w[0] > w[1], `la zone 0 doit rester devant : ${w.map((x) => x.toFixed(2))}`);
  assert.equal(mem.weigh([-Infinity, 1, 1])[0], 0, 'zone absente : poids nul');
});

test('seuils de qualité réglables (grille calibrée sur vraies vidéos)', () => {
  const s = synthSamples({ bpm: 70, noise: 0.6, seed: 4 });
  const strict = analyze(s, { thresholds: { good: 99, fair: 98 } });
  const loose = analyze(s, { thresholds: { good: -99, fair: -99 } });
  assert.equal(strict.quality, 'poor');
  assert.equal(loose.quality, 'good');
});

test('part du mouvement à la fréquence retenue : présente seulement quand la tête bouge', () => {
  const still = analyze(synthMotion({ motion: 'still', bpm: 80, seed: 2, seconds: 12 }));
  const ex = analyze(synthMotion({ motion: 'exercise', bpm: 128, cadence: 1.55, seed: 2, seconds: 12 }));
  assert.equal(still.motionAtPeak, 0);
  assert.equal(still.moving, false);
  assert.ok(ex.moving);
  assert.ok(ex.motionAtPeak >= 0 && ex.motionAtPeak <= 1);
});

test('respiration : 15/min retrouvée à partir du mouvement de la tête et de la couleur', async () => {
  const { estimateBreathing } = await import('../js/breath.js');
  const rand = rng(11);
  const s = [];
  for (let i = 0; i < 40 * 30; i++) {
    const t = i / 30, br = Math.sin(2 * Math.PI * 0.25 * t);
    s.push({ t, r: 150, g: 100 * (1 + 0.002 * br) + 0.3 * gaussian(rand), b: 80,
      motion: [0.4, 0.5 + 0.004 * br + 0.0005 * gaussian(rand), 0.08, 0, 0, 0.5 + 0.003 * br, 0.02] });
  }
  const r = estimateBreathing(s);
  assert.ok(r.ready && near(r.rate, 15, 1.5), `rate=${r.rate}`);
  assert.ok(r.clarity > 0.45, `clarity=${r.clarity}`);
  // Sans respiration : bruit pur, pas de pic net.
  const n = s.map((x) => ({ ...x, g: 100 + 0.3 * gaussian(rand), motion: x.motion.map((v, i) => (i === 1 || i === 5 ? 0.5 + 0.0005 * gaussian(rand) : v)) }));
  const q = estimateBreathing(n);
  assert.ok(q.clarity < 0.45, `noise clarity=${q.clarity}`);
});

test('lumière qui change : la référence de fond retire une lampe qui scintille dans la bande', () => {
  // Lampe colorée qui scintille à 1,3 Hz sur la peau ET sur le mur du fond.
  const flick = (t) => 0.02 * Math.sin(2 * Math.PI * 1.3 * t);
  const s = synthZones([{ bpm: 70, seed: 1 }, { bpm: 70, seed: 2 }, { bpm: 70, seed: 3 }]).map((x) => {
    const f = flick(x.t), tint = [1, 0.8, 0.55];
    const lit = (z) => ({ r: z.r * (1 + f * tint[0]), g: z.g * (1 + f * tint[1]), b: z.b * (1 + f * tint[2]) });
    return { ...lit(x), t: x.t, zones: x.zones.map(lit), bg: lit({ r: 200, g: 200, b: 190 }) };
  });
  const without = analyze(s), withBg = analyze(s, { background: true });
  assert.ok(withBg.lightChanging);
  assert.ok(near(withBg.bpm, 70, 2), `avec fond : ${withBg.bpm}`);
  assert.ok(!near(without.bpm, 70, 2) || without.snr < withBg.snr, `sans fond : ${without.bpm}`);
});
