// Choix entre régression des couleurs linéaire et avec carrés : 40 graines par scénario,
// y compris mouvement deux fois plus fort, effort à 150 bpm et pouls faible immobile.
import { analyze } from '../js/dsp.js';
import { synthMotion } from '../js/synth.js';

const SC = {
  still: { motion: 'still', bpm: 72 },
  random: { motion: 'random', bpm: 76 },
  'random x2': { motion: 'random', bpm: 76, amp: 2 },
  talking: { motion: 'talking', bpm: 84 },
  turns: { motion: 'turns', bpm: 68 },
  exercise: { motion: 'exercise', bpm: 128, cadence: 1.55 },
  'exercise 150': { motion: 'exercise', bpm: 150, cadence: 2.4 },
  'still weak': { motion: 'still', bpm: 64, pulseAmp: 0.0015 },
};
const CONFIGS = [
  ['none', { motion: null }],
  ['colors linear', { motion: { domain: 'rgb', quad: false } }],
  ['colors +squares', { motion: { domain: 'rgb', quad: true } }],
];
for (const [label, opts] of CONFIGS) {
  const row = [];
  let tot = 0, wrong = 0;
  for (const [n, sc] of Object.entries(SC)) {
    let ok = 0;
    for (let seed = 101; seed <= 140; seed++) {
      const r = analyze(synthMotion({ ...sc, seed, seconds: 12 }), opts);
      if (r.quality !== 'poor') Math.abs(r.bpm - sc.bpm) < 3 ? ok++ : wrong++;
    }
    row.push(`${n} ${ok}`);
    tot += ok;
  }
  console.log(label.padEnd(16), row.join(' | '), `| total ${tot}/320, wrong shown ${wrong}`);
}
