// Banc de mouvement : précision par type de mouvement et par méthode (signaux synthétiques).
// Réussite = juste à ±3 bpm et affiché (qualité ≠ poor) ; « faux » = affiché mais faux.
import { analyze } from '../js/dsp.js';
import { synthMotion } from '../js/synth.js';

export const SCENARIOS = {
  still: { motion: 'still', bpm: 72 },
  random: { motion: 'random', bpm: 76 },
  talking: { motion: 'talking', bpm: 84 },
  turns: { motion: 'turns', bpm: 68 },
  exercise: { motion: 'exercise', bpm: 128, cadence: 1.55 },
};

export function evaluate(method, opts = {}, seeds = 20) {
  const rows = {};
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    let ok = 0, wrong = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const s = synthMotion({ ...sc, seed, seconds: 12 });
      const r = analyze(s, { method, ...opts });
      const good = Math.abs(r.bpm - sc.bpm) < 3;
      if (r.quality !== 'poor') good ? ok++ : wrong++;
    }
    rows[name] = { ok, wrong };
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configs = [
    ['fusion, sans correction', 'fusion', { motion: null }],
    ['régression pouls, linéaire', 'fusion', { motion: { domain: 'pulse', quad: false } }],
    ['régression pouls, +carrés', 'fusion', { motion: { domain: 'pulse', quad: true } }],
    ['régression couleurs, linéaire', 'fusion', { motion: { domain: 'rgb', quad: false } }],
    ['régression couleurs, +carrés', 'fusion', { motion: { domain: 'rgb', quad: true } }],
    ['masque seul', 'fusion', { motion: { mask: true } }],
    ['couleurs +carrés + masque', 'fusion', { motion: { domain: 'rgb', quad: true, mask: true } }],
    ['pouls +carrés + masque', 'fusion', { motion: { domain: 'pulse', quad: true, mask: true } }],
  ];
  for (const [label, method, opts] of configs) {
    const r = evaluate(method, opts);
    const tot = Object.values(r).reduce((a, v) => ({ ok: a.ok + v.ok, wrong: a.wrong + v.wrong }), { ok: 0, wrong: 0 });
    console.log(label.padEnd(30), Object.entries(r).map(([k, v]) => `${k} ${String(v.ok).padStart(2)}/${v.wrong}`).join('  '), `| total ${tot.ok}/100 justes, ${tot.wrong} faux`);
  }
}
