// Spectre de la luminosité moyenne d'un carré de l'image (ex. le mur du fond, sans pouls) :
// révèle un artefact de lumière ou de caméra. Usage : node tools/patch-spectrum.mjs video x y taille
import { spawnSync } from 'node:child_process';
import { spectrum, bandpass } from '../js/dsp.js';
const [file, x, y, s] = process.argv.slice(2);
const r = spawnSync('ffmpeg', ['-v', 'error', '-t', '60', '-i', file, '-vf', `crop=${s}:${s}:${x}:${y},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
const px = r.stdout;
const g = Float64Array.from({ length: px.length / 3 }, (_, i) => px[i * 3 + 1]);
const m = g.reduce((a, v) => a + v, 0) / g.length;
const { power, df } = spectrum(bandpass(Float64Array.from(g, (v) => v / m - 1), 30), 30);
let best = [];
for (let k = Math.ceil(0.7 / df); k <= Math.floor(3 / df); k++) best.push([k * df, power[k]]);
best.sort((a, b) => b[1] - a[1]);
const tot = best.reduce((a, b) => a + b[1], 0);
console.log(`${file} patch ${x},${y}: strongest ${best.slice(0, 3).map(([f, p]) => `${f.toFixed(2)} Hz (${(f * 60).toFixed(0)} bpm, ${(100 * p / tot).toFixed(1)}%)`).join(', ')}`);
