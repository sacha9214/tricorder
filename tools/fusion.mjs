// Choix de la règle de pondération des zones (30 graines par scénario) : réussite = juste à ±2 bpm et SNR ≥ 1 dB.
import * as d from '../js/dsp.js';
import { synthZones } from '../js/synth.js';
const rules = {
  dbClamp: (snr) => Math.max(0, snr),
  linear: (snr) => 10 ** (snr / 10),
  mrc: (snr) => { const p = 10 ** (snr / 10); return Math.sqrt(p * (1 + p)); },
  square: (snr) => (10 ** (snr / 10)) ** 2,
};
// Copie locale de la fusion avec règle et option consensus.
function fuse(samples, rule, consensus) {
  const fs = 30, tEnd = samples.at(-1).t, tStart = Math.max(samples[0].t, tEnd - 12);
  const zs = [];
  for (let z = 0; z < 3; z++) {
    const list = samples.filter((s) => s.t >= tStart).map((s) => ({ t: s.t, ...s.zones[z] }));
    const rs = d.resampleRange(list, fs, tStart, tEnd);
    const p = d.bandpass(d.clipRobust(d.pos(rs.r, rs.g, rs.b, fs)), fs);
    const e = d.estimate(p, fs);
    zs.push({ p, e, sd: d.std(p) || 1 });
  }
  const mix = (ws) => { const out = new Float64Array(zs[0].p.length); zs.forEach((z, k) => { for (let i = 0; i < out.length; i++) out[i] += (ws[k] / z.sd) * z.p[i]; }); return out; };
  let ws = zs.map((z) => rule(z.e.snr));
  let est = d.estimate(mix(ws), fs);
  if (consensus) {
    ws = zs.map((z) => rule(d.snrAt(z.e.power, z.e.df, est.f)));
    est = d.estimate(mix(ws), fs);
  }
  return est;
}
const scenarios = {
  'front bruité (4) + joues 0.4': (s) => [{ bpm: 78, noise: 4, seed: s * 3 }, { bpm: 78, noise: 0.4, seed: s * 3 + 1 }, { bpm: 78, noise: 0.4, seed: s * 3 + 2 }],
  'tout à 0.5': (s) => [0, 1, 2].map((k) => ({ bpm: 78, noise: 0.5, seed: s * 3 + k })),
  'tout à 0.3': (s) => [0, 1, 2].map((k) => ({ bpm: 78, noise: 0.3, seed: s * 3 + k })),
  'front artefact coloré 1.8 Hz': (s) => [{ bpm: 78, noise: 0.3, seed: s * 3, artifact: { from: 0, to: 99, hz: 1.8, amp: 1, color: [1, 0.6, 0.3] } }, { bpm: 78, noise: 0.4, seed: s * 3 + 1 }, { bpm: 78, noise: 0.4, seed: s * 3 + 2 }],
};
for (const [name, mk] of Object.entries(scenarios)) {
  const row = [];
  for (const [rn, rule] of Object.entries(rules)) for (const cons of [false, true]) {
    let ok = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const e = fuse(synthZones(mk(seed)), rule, cons);
      if (Math.abs(e.bpm - 78) < 2 && e.snr >= 1) ok++;
    }
    row.push(`${rn}${cons ? '+c' : ''}:${ok}`);
  }
  let mixOk = 0;
  for (let seed = 1; seed <= 30; seed++) { const r = d.analyze(synthZones(mk(seed)), { method: 'pos' }); if (Math.abs(r.bpm - 78) < 2 && r.snr >= 1) mixOk++; }
  console.log(name.padEnd(32), 'mix:' + mixOk, row.join(' '));
}
