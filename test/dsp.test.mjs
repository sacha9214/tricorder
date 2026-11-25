import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, resample } from '../js/dsp.js';
import { synthSamples } from '../js/synth.js';

const err = (r, bpm) => Math.abs(r.bpm - bpm);

test('resample: grille régulière et interpolation linéaire', () => {
  const s = [{ t: 0, r: 0, g: 0, b: 0 }, { t: 1, r: 30, g: 60, b: 90 }];
  const rs = resample(s, 10);
  assert.equal(rs.r.length, 11);
  assert.ok(Math.abs(rs.g[5] - 30) < 1e-9);
});

test('pas de résultat avant 8 s de signal', () => {
  const r = analyze(synthSamples({}, { seconds: 5 }));
  assert.equal(r.ready, false);
  assert.ok(r.progress > 0.5 && r.progress < 0.7);
});

test('signal propre à 72 bpm : erreur < 1,5 bpm, qualité bonne', () => {
  const r = analyze(synthSamples({ bpm: 72 }));
  assert.ok(err(r, 72) < 1.5, `bpm=${r.bpm}`);
  assert.equal(r.quality, 'good');
});

for (const bpm of [45, 60, 90, 120, 150, 175]) {
  // Critère : aucune valeur fausse affichée, et au moins 15/20 justes (les autres masquées).
  test(`plage de fréquences : ${bpm} bpm, aucune valeur fausse affichée (bruit 0,3)`, () => {
    let ok = 0, wrongShown = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = analyze(synthSamples({ bpm, noise: 0.3, seed: seed * 31 + bpm }));
      if (err(r, bpm) < 2) ok++;
      else if (r.quality !== 'poor') wrongShown++;
    }
    assert.equal(wrongShown, 0);
    assert.ok(ok >= 15, `${ok}/20`);
  });
}

test('horodatage irrégulier (gigue ±10 ms, 10 % d\'images perdues)', () => {
  const r = analyze(synthSamples({ bpm: 84 }, { jitter: 0.01, drop: 0.1 }));
  assert.ok(err(r, 84) < 2, `bpm=${r.bpm}`);
});

test('scintillement de la lumière dans la bande : POS tient, le vert seul échoue', () => {
  // Scintillement à 1,3 Hz (78 bpm), 2 % d'amplitude : ~7× le pouls dans le vert.
  const r = analyze(synthSamples({ bpm: 66, flicker: 0.02, flickerHz: 1.3 }));
  assert.ok(err(r, 66) < 2, `POS bpm=${r.bpm}`);
  assert.ok(Math.abs(r.greenBpm - 66) > 5, `vert bpm=${r.greenBpm}`);
});

test('saut d\'exposition automatique (+8 % sur les 3 canaux à t = 5 s)', () => {
  const s = synthSamples({ bpm: 75 }).map((x) =>
    x.t > 5 ? { ...x, r: x.r * 1.08, g: x.g * 1.08, b: x.b * 1.08 } : x,
  );
  const r = analyze(s);
  assert.ok(err(r, 75) < 2, `bpm=${r.bpm}`);
});

test('reflet blanc variable', () => {
  const r = analyze(synthSamples({ bpm: 95, specular: 0.01 }));
  assert.ok(err(r, 95) < 2, `bpm=${r.bpm}`);
});

test('bruit pur : jamais « good »', () => {
  const snrs = [];
  for (let seed = 1; seed <= 40; seed++) {
    const r = analyze(synthSamples({ pulseAmp: 0, noise: 0.5, seed }));
    snrs.push(r.snr);
    assert.notEqual(r.quality, 'good', `seed=${seed} snr=${r.snr}`);
  }
  const max = Math.max(...snrs);
  console.log(`  SNR bruit pur : max ${max.toFixed(1)} dB, moyenne ${(snrs.reduce((a, b) => a + b) / snrs.length).toFixed(1)} dB`);
});

test('le label de qualité est fiable : « good » toujours juste, « fair » ≥ 90 %', () => {
  const tally = { good: [0, 0], fair: [0, 0], poor: [0, 0] };
  for (const noise of [0.1, 0.3, 0.5, 0.8, 1.2])
    for (const bpm of [45, 55, 72, 90, 120, 150, 175])
      for (let seed = 1; seed <= 12; seed++) {
        const r = analyze(synthSamples({ bpm, noise, seed: seed * 101 + bpm }));
        tally[r.quality][0]++;
        if (err(r, bpm) < 3) tally[r.quality][1]++;
      }
  const [gn, gok] = tally.good, [fn, fok] = tally.fair;
  console.log(`  good ${gok}/${gn}, fair ${fok}/${fn}, poor ${tally.poor[1]}/${tally.poor[0]}`);
  assert.ok(gn > 10 && gok === gn);
  assert.ok(fn >= 10 && fok / fn >= 0.9);
});
