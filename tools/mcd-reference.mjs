// Référence MCD-rPPG : fréquence cardiaque par fenêtre de 12 s (pas de 0,5 s) à partir du
// capteur de pouls au doigt synchronisé image par image (ppg_sync : une valeur par image).
// Usage : node tools/mcd-reference.mjs recordings/mcd/ppg_1020_before.txt 180 > ref.json
import { readFileSync } from 'node:fs';
import { bandpass, estimate } from '../js/dsp.js';

const [file, seconds] = process.argv.slice(2);
const values = readFileSync(file, 'utf8').trim().split('\n').map((l) => parseFloat(l.trim().split(/\s+/)[0]));
const fs = values.length / parseFloat(seconds);
const win = Math.round(12 * fs), step = 0.5;
const out = [];
for (let tEnd = 12; tEnd <= values.length / fs + 1e-9; tEnd += step) {
  const end = Math.round(tEnd * fs), seg = Float64Array.from(values.slice(end - win, end));
  const e = estimate(bandpass(seg, fs), fs);
  out.push({ t: +tEnd.toFixed(2), bpm: +e.bpm.toFixed(2), snr: +e.snr.toFixed(1) });
}
const bpms = out.map((o) => o.bpm);
console.error(`${file}: fs ${fs.toFixed(3)} Hz, ${out.length} windows, reference ${Math.min(...bpms).toFixed(1)}–${Math.max(...bpms).toFixed(1)} bpm, min SNR ${Math.min(...out.map((o) => o.snr))} dB`);
console.log(JSON.stringify({ fs, windows: out }));
