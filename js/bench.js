// Banc d'essai : analyse des enregistrements et comparaison des méthodes à la référence.
import { slidingAnalysis, summarizeRun, median, DEFAULT_MOTION } from './dsp.js';
import { Extractor } from './extract.js';
import { loadLandmarker } from './landmarker.js';
import { videoFrames, measureFrame } from './frames.js';

// Méthodes comparées, de la plus simple (v0) à la chaîne complète.
const METHODS = [
  { id: 'green', label: 'Green only', source: 'raw', method: 'green', motion: null, tracked: false },
  { id: 'v0', label: 'POS, all pixels (v0)', source: 'raw', method: 'pos', motion: null, tracked: false },
  { id: 'skin', label: '+ skin filter', source: 'skin', method: 'pos', motion: null, tracked: false },
  { id: 'zones', label: '+ zone fusion', source: 'skin', method: 'fusion', motion: null, tracked: false },
  { id: 'motion', label: '+ motion correction', source: 'skin', method: 'fusion', motion: DEFAULT_MOTION, tracked: false },
  { id: 'full', label: '+ tracking (full)', source: 'skin', method: 'fusion', motion: DEFAULT_MOTION, tracked: true },
];

const $ = (id) => document.getElementById(id);
const tbody = $('videos').querySelector('tbody');
const thead = $('videos').querySelector('thead tr');
const rows = []; // { file, ref, results: {id: {bpm, coverage}}, status, faceShare }

for (const m of METHODS) thead.insertAdjacentHTML('beforeend', `<th>${m.label}</th>`);

const refFromName = (name) => {
  const m = name.match(/(\d{2,3}(?:[.,]\d+)?)\s*bpm/i);
  return m ? parseFloat(m[1].replace(',', '.')) : NaN;
};

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderRows() {
  tbody.innerHTML = '';
  rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    const cells = METHODS.map((m) => {
      const r = row.results[m.id];
      if (!r) return '<td class="muted">—</td>';
      if (!Number.isFinite(r.bpm)) return '<td class="muted">no reading</td>';
      const err = Number.isFinite(row.ref) ? r.bpm - row.ref : NaN;
      const cls = !Number.isFinite(err) ? '' : Math.abs(err) <= 3 ? 'ok' : Math.abs(err) <= 5 ? 'meh' : 'bad';
      const errTxt = Number.isFinite(err) ? ` <span class="err">(${err >= 0 ? '+' : ''}${err.toFixed(1)})</span>` : '';
      return `<td class="${cls}">${r.bpm.toFixed(1)}${errTxt}</td>`;
    });
    tr.innerHTML = `<td class="file">${esc(row.file.name)}</td>
      <td><input type="number" min="30" max="220" step="0.1" value="${Number.isFinite(row.ref) ? row.ref : ''}" data-i="${i}" aria-label="Reference heart rate for ${esc(row.file.name)}"></td>
      <td class="muted">${esc(row.status)}</td>${cells.join('')}`;
    tbody.appendChild(tr);
  });
  for (const input of tbody.querySelectorAll('input')) {
    input.addEventListener('change', () => {
      rows[+input.dataset.i].ref = parseFloat(input.value);
      renderRows();
      renderSummary();
    });
  }
}

function stats(method) {
  const errs = [], cov = [];
  for (const row of rows) {
    const r = row.results[method.id];
    if (!r) continue;
    cov.push(r.coverage);
    if (Number.isFinite(row.ref) && Number.isFinite(r.bpm)) errs.push(r.bpm - row.ref);
  }
  if (!cov.length) return null;
  const mae = errs.length ? errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length : NaN;
  const rmse = errs.length ? Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length) : NaN;
  const within = errs.length ? errs.filter((e) => Math.abs(e) <= 5).length / errs.length : NaN;
  return { mae, rmse, within, coverage: cov.reduce((a, b) => a + b, 0) / cov.length, n: errs.length, total: cov.length };
}

function renderSummary() {
  const body = $('summary').querySelector('tbody');
  const fmt = (v, d = 1, suffix = '') => (Number.isFinite(v) ? v.toFixed(d) + suffix : '—');
  const lines = METHODS.map((m) => {
    const s = stats(m);
    if (!s) return '';
    return `<tr><td>${m.label}</td><td>${fmt(s.mae, 1, ' bpm')}</td><td>${fmt(s.rmse, 1, ' bpm')}</td>
      <td>${fmt(s.within * 100, 0, ' %')}</td><td>${fmt(s.coverage * 100, 0, ' %')}</td><td>${s.n} / ${s.total}</td></tr>`;
  }).join('');
  body.innerHTML = lines || '<tr><td colspan="6" class="muted">No results yet.</td></tr>';
  $('csv').disabled = !rows.some((r) => Object.keys(r.results).length);
  drawBlandAltman();
}

function drawBlandAltman() {
  const c = $('ba');
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const pts = rows
    .map((r) => ({ ref: r.ref, v: r.results.full?.bpm }))
    .filter((p) => Number.isFinite(p.ref) && Number.isFinite(p.v))
    .map((p) => ({ x: (p.ref + p.v) / 2, y: p.v - p.ref }));
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = '#8794a1';
  if (!pts.length) { ctx.fillText('Needs videos with a reference.', 12, 20); return; }
  const bias = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const sd = Math.sqrt(pts.reduce((a, p) => a + (p.y - bias) ** 2, 0) / Math.max(1, pts.length - 1));
  const xs = pts.map((p) => p.x);
  const xMin = Math.min(40, ...xs) - 5, xMax = Math.max(140, ...xs) + 5;
  const yMax = Math.max(10, ...pts.map((p) => Math.abs(p.y)), Math.abs(bias) + 2 * sd) * 1.15;
  const L = 44, R = 12, T = 10, B = 26;
  const px = (x) => L + ((x - xMin) / (xMax - xMin)) * (W - L - R);
  const py = (y) => T + ((yMax - y) / (2 * yMax)) * (H - T - B);
  ctx.strokeStyle = '#1e252d';
  ctx.textAlign = 'right';
  for (const y of [-yMax, -yMax / 2, 0, yMax / 2, yMax].map((v) => Math.round(v))) {
    ctx.beginPath(); ctx.moveTo(L, py(y)); ctx.lineTo(W - R, py(y)); ctx.stroke();
    ctx.fillText(`${y > 0 ? '+' : ''}${y}`, L - 6, py(y) + 4);
  }
  ctx.textAlign = 'center';
  for (let x = Math.ceil(xMin / 20) * 20; x <= xMax; x += 20) ctx.fillText(String(x), px(x), H - 8);
  ctx.setLineDash([5, 4]);
  for (const [y, col] of [[bias, '#e4e8ec'], [bias + 1.96 * sd, '#e9bd4c'], [bias - 1.96 * sd, '#e9bd4c']]) {
    ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(L, py(y)); ctx.lineTo(W - R, py(y)); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = '#ff5f6d';
  for (const p of pts) { ctx.beginPath(); ctx.arc(px(p.x), py(p.y), 4, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#8794a1'; ctx.textAlign = 'left';
  ctx.fillText(`bias ${bias >= 0 ? '+' : ''}${bias.toFixed(1)} bpm · limits ${(bias - 1.96 * sd).toFixed(1)} to ${(bias + 1.96 * sd).toFixed(1)}`, L + 6, T + 12);
}

async function analyzeRow(row, landmarker, extractor, video) {
  const url = URL.createObjectURL(row.file);
  try {
    video.src = url;
    extractor.reset();
    const samples = [];
    let frames = 0, faces = 0;
    for await (const { time, duration } of videoFrames(video)) {
      frames++;
      const res = measureFrame(video, video.videoWidth, video.videoHeight, { face: landmarker }, extractor);
      if (res) faces++;
      if (res?.m) samples.push({ t: time, r: res.m.r, g: res.m.g, b: res.m.b, zones: res.m.zones, raw: res.m.raw, motion: res.face.motion });
      if (frames % 15 === 0) { row.status = `${Math.round((100 * time) / duration)} %`; renderRows(); }
    }
    row.faceShare = frames ? faces / frames : 0;
    for (const m of METHODS) {
      const src = m.source === 'raw' ? samples.map((s) => ({ t: s.t, ...s.raw })) : samples;
      const res = slidingAnalysis(src, { method: m.method, motion: m.motion });
      row.results[m.id] = summarizeRun(res, { tracked: m.tracked });
    }
    const dur = samples.length ? samples[samples.length - 1].t - samples[0].t : 0;
    row.status = `done · ${dur.toFixed(0)} s · face ${Math.round(row.faceShare * 100)} %`;
  } catch (e) {
    console.error(e);
    row.status = 'error';
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('pick').addEventListener('click', () => $('files').click());
$('files').addEventListener('change', () => {
  for (const file of $('files').files) rows.push({ file, ref: refFromName(file.name), results: {}, status: 'waiting' });
  $('files').value = '';
  $('run').disabled = !rows.length;
  renderRows();
});

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  const pending = rows.filter((r) => !Object.keys(r.results).length);
  for (const r of pending) r.status = 'loading model…';
  renderRows();
  let landmarker;
  try {
    landmarker = await loadLandmarker();
  } catch (e) {
    console.error(e);
    for (const r of pending) r.status = 'face model failed to load';
    renderRows();
    $('run').disabled = false;
    return;
  }
  const extractor = new Extractor();
  for (const row of pending) {
    await analyzeRow(row, landmarker, extractor, $('video'));
    renderRows();
    renderSummary();
  }
  $('run').disabled = false;
});

$('csv').addEventListener('click', () => {
  const head = ['file', 'reference_bpm', ...METHODS.flatMap((m) => [`${m.id}_bpm`, `${m.id}_coverage`])];
  const lines = rows.map((r) => [
    `"${r.file.name.replace(/"/g, '""')}"`,
    Number.isFinite(r.ref) ? r.ref : '',
    ...METHODS.flatMap((m) => {
      const x = r.results[m.id];
      return [Number.isFinite(x?.bpm) ? x.bpm.toFixed(2) : '', x ? x.coverage.toFixed(3) : ''];
    }),
  ].join(','));
  const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'tricorder-bench.csv' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

window.addEventListener('resize', drawBlandAltman);
drawBlandAltman();
// Accès pour le débogage depuis la console.
window.bench = { rows, METHODS, median };
