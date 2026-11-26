// Interface : sources (caméra, fichier, démo), boucle image par image, affichage,
// amplification du pouls et enregistrement.
import { analyze, HrTracker, ZoneMemory, GRID_THRESHOLDS, HR_MIN, HR_MAX } from './dsp.js';
import { Extractor, tracePath, WORK_W, ZONES } from './extract.js';
import { DemoFace } from './demo.js';
import { Magnifier } from './magnify.js';
import { Recorder, recordingName, download, MAX_SECONDS } from './recorder.js';
import { loadLandmarker, loadHands, loadPose, faceLandmarkerClass } from './landmarker.js';
import { FaceGrid, featureSets } from './grid.js';
import { videoFrames, measureFrame } from './frames.js';
import { t, setLang, getLang, applyI18n } from './i18n.js';

const BUFFER_S = 15;       // historique gardé
const GAP_RESET_S = 0.5;   // trou plus long → on repart de zéro
// Déplacement du nez sur 1 s, en fraction de l'écart des yeux. Le mouvement est corrigé ;
// au-delà de ce seuil on prévient seulement que les mesures peuvent sauter.
const MOTION_LIMIT = 0.3;
// Grille détaillée du visage (~100 cellules) au lieu de 3 zones : choisie sur de vraies vidéos
// (MCD-rPPG), voir README et tools/offline-score.mjs.
const USE_GRID = true;
const QUALITY_COLORS = { good: '#3ccf8e', fair: '#e9bd4c', poor: '#8794a1', none: '#e4e8ec' };

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'), media: $('media'), video: $('video'), overlay: $('overlay'), status: $('status'),
  btnCamera: $('btnCamera'), btnFile: $('btnFile'), fileInput: $('fileInput'), btnDemo: $('btnDemo'), btnStop: $('btnStop'),
  optHands: $('optHands'), optBody: $('optBody'),
  demoControls: $('demoControls'), demoBpm: $('demoBpm'), demoBpmOut: $('demoBpmOut'), demoFlicker: $('demoFlicker'), demoHair: $('demoHair'),
  magnify: $('magnify'), gainRow: $('gainRow'), gain: $('gain'), gainOut: $('gainOut'), magnifyHint: $('magnifyHint'),
  btnRecord: $('btnRecord'), recLabel: $('recLabel'),
  savePanel: $('savePanel'), saveTitle: $('saveTitle'), refBpm: $('refBpm'), btnSave: $('btnSave'), btnDiscard: $('btnDiscard'),
  bpm: $('bpm'), quality: $('quality'), qualityLabel: $('qualityLabel'), snr: $('snr'),
  progress: $('progress'), progressBar: $('progressBar'), truth: $('truth'),
  wave: $('wave'), spectrum: $('spectrum'), details: $('details'),
};
const octx = els.overlay.getContext('2d');
const extractor = new Extractor();
const magnifier = new Magnifier();
const recorder = new Recorder();

const state = {
  mode: 'idle', run: 0,
  samples: [], lastT: null, noFaceSince: null,
  result: null, tracker: new HrTracker(), zoneMemory: new ZoneMemory({ alpha: 0.1 }), motion: [], frameTimes: [], pixels: 0, kept: 0,
  stream: null, fileUrl: null, demo: null, demoTimer: null, analyzeTimer: null,
  landmarker: null, truth: null,
  magnify: false, gain: 50,
  extras: { hands: false, body: false }, handsModel: null, poseModel: null, grid: null,
  pending: null, // enregistrement terminé, pas encore enregistré : { blob, seconds, ext }
  statusKey: 'status.idle', statusVars: {}, statusError: false,
};

// ---------- Statut ----------
function setStatus(key, vars = {}, error = false) {
  state.statusKey = key; state.statusVars = vars; state.statusError = error;
  els.status.textContent = t(key, vars);
  els.status.classList.toggle('error', error);
}

// ---------- Tampon d'échantillons ----------
function resetBuffer() {
  state.samples = []; state.lastT = null; state.result = null;
  state.tracker.reset(); state.zoneMemory.reset(); state.motion = [];
}

function pushSample(time, m, motion = null) {
  if (state.lastT !== null) {
    if (Math.abs(time - state.lastT) < 1e-6) return; // même image
    if (time < state.lastT || time - state.lastT > GAP_RESET_S) resetBuffer();
  }
  state.samples.push({ t: time, r: m.r, g: m.g, b: m.b, zones: m.zones, ...(motion ? { motion } : {}) });
  state.lastT = time;
  state.pixels = m.pixels;
  state.kept = m.kept;
  while (state.samples.length && state.samples[0].t < time - BUFFER_S) state.samples.shift();
}

function trackMotion(time, face) {
  state.motion.push({ t: time, x: face.nose.x / face.scale, y: face.nose.y / face.scale });
  while (state.motion.length && state.motion[0].t < time - 1) state.motion.shift();
}

function motionAmount() {
  const m = state.motion;
  if (m.length < 2) return 0;
  let max = 0;
  for (const p of m) max = Math.max(max, Math.hypot(p.x - m[0].x, p.y - m[0].y));
  return max;
}

function frameRate() {
  const f = state.frameTimes;
  return f.length > 10 ? (f.length - 1) / (f[f.length - 1] - f[0]) : 30;
}

// Avec la caméra, l'image amplifiée affichée éclaire le visage au rythme du pouls :
// les mesures prises pendant ce temps seraient faussées, on les suspend.
const readingsPaused = () => state.mode === 'camera' && state.magnify;

// ---------- Zones en option : mains et corps ----------
const models = () => ({
  face: state.landmarker,
  grid: USE_GRID ? state.grid : null,
  hands: state.extras.hands ? state.handsModel : null,
  pose: state.extras.body ? state.poseModel : null,
});

async function loadExtras() {
  if (state.extras.hands && !state.handsModel) state.handsModel = await loadHands();
  if (state.extras.body && !state.poseModel) state.poseModel = await loadPose();
}

async function onExtrasChange() {
  state.extras = { hands: els.optHands.checked, body: els.optBody.checked };
  if (state.mode === 'camera' || state.mode === 'file') {
    const key = state.statusKey;
    setStatus('status.loadingModel');
    try { await loadExtras(); } catch (e) { console.error(e); setStatus('status.modelError', {}, true); return; }
    setStatus(key);
  }
  // Le nombre de zones change : on repart de zéro.
  resetBuffer();
}

// ---------- Traitement d'une image (toutes sources) ----------
// fixed : { regions, hull } pour la démo (zones connues), sinon détection du visage.
function processFrame(time, source, w, h, fixed = null) {
  state.frameTimes.push(time);
  while (state.frameTimes.length && state.frameTimes[0] < time - 2) state.frameTimes.shift();

  let regions = [], hull = null, m = null, motion = null;
  if (fixed) {
    regions = fixed.regions;
    hull = fixed.hull;
    m = extractor.measure(source, w, h, regions);
  } else {
    const res = measureFrame(source, w, h, models(), extractor);
    if (res) {
      regions = res.regions;
      motion = res.face.motion;
      const k = w / WORK_W;
      hull = res.face.hull.map((p) => ({ x: p.x * k, y: p.y * k }));
      m = res.m;
      trackMotion(time, res.face);
      state.noFaceSince = null;
    } else {
      state.noFaceSince ??= time;
      if (time - state.noFaceSince > GAP_RESET_S) resetBuffer();
    }
  }
  if (m && !readingsPaused()) pushSample(time, m, motion);
  if (state.magnify) {
    const bpm = state.tracker.bpm;
    magnifier.setBand(bpm ? bpm / 60 : null, frameRate());
    magnifier.process(source, w, h, hull, state.gain);
  }
  drawOverlay(regions, w, h, w / WORK_W);
}

// ---------- Sources ----------
function stop(keepStatus = false) {
  state.run++;
  if (recorder.active) finishRecording();
  clearInterval(state.demoTimer); state.demoTimer = null;
  clearInterval(state.analyzeTimer); state.analyzeTimer = null;
  state.stream?.getTracks().forEach((tr) => tr.stop());
  state.stream = null;
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.srcObject = null;
  if (state.fileUrl) { URL.revokeObjectURL(state.fileUrl); state.fileUrl = null; }
  els.media.classList.remove('mirror');
  els.stage.classList.remove('live');
  els.demoControls.hidden = true;
  state.mode = 'idle';
  state.truth = null;
  state.frameTimes = [];
  resetBuffer();
  extractor.reset();
  magnifier.reset();
  updateView();
  render();
  setButtons();
  if (!keepStatus) setStatus('status.idle');
}

function setButtons() {
  els.btnStop.disabled = state.mode === 'idle';
  els.btnCamera.classList.toggle('active', state.mode === 'camera');
  els.btnFile.classList.toggle('active', state.mode === 'file');
  els.btnDemo.classList.toggle('active', state.mode === 'demo');
  // Caméra seulement : la démo n'a pas de vrai visage, son enregistrement ne serait pas analysable.
  els.btnRecord.disabled = state.mode !== 'camera' && !recorder.active;
  els.btnRecord.classList.toggle('recording', recorder.active);
  els.recLabel.textContent = recorder.active
    ? t('rec.stop', { s: formatTime(recorder.seconds) })
    : t('rec.start');
}

const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Une seule image visible dans la scène : vidéo, visage de démo, ou image amplifiée.
function updateView() {
  const live = state.mode !== 'idle';
  const showMag = live && state.magnify;
  els.video.hidden = !live || state.mode === 'demo' || showMag;
  if (state.demo) state.demo.canvas.hidden = state.mode !== 'demo' || showMag;
  magnifier.canvas.hidden = !showMag;
  if (!magnifier.canvas.isConnected) els.media.prepend(magnifier.canvas);
  if (state.demo && !state.demo.canvas.isConnected) els.media.prepend(state.demo.canvas);
  els.gainRow.hidden = !state.magnify;
  els.magnifyHint.hidden = !state.magnify;
}

function startAnalysis() {
  state.analyzeTimer = setInterval(runAnalysis, 500);
}

async function startCamera() {
  stop(true);
  const run = state.run;
  setStatus('status.camera');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: false,
    });
  } catch {
    if (run === state.run) setStatus('status.cameraDenied', {}, true);
    return;
  }
  if (run !== state.run) { stream.getTracks().forEach((tr) => tr.stop()); return; }
  state.stream = stream;
  els.video.srcObject = stream;
  els.media.classList.add('mirror');
  if (!(await prepareModel(run))) return;
  try { await els.video.play(); } catch (e) { console.error(e); }
  goLive('camera');
  startAnalysis();
  scheduleVideoFrame(run);
}

async function startFile(file) {
  stop(true);
  const run = state.run;
  state.fileUrl = URL.createObjectURL(file);
  els.video.src = state.fileUrl;
  if (!(await prepareModel(run))) return;
  goLive('file');
  // Fichier : image par image, en se plaçant à chaque instant (1/30 s).
  // Déterministe, et insensible au ralentissement des onglets en arrière-plan.
  let i = 0;
  for await (const { time } of videoFrames(els.video)) {
    if (run !== state.run) return;
    processFrame(time, els.video, els.video.videoWidth, els.video.videoHeight);
    if (++i % 15 === 0) runAnalysis();
  }
  if (run !== state.run) return;
  runAnalysis();
  setStatus('status.ended');
}

async function prepareModel(run) {
  setStatus('status.loadingModel');
  try {
    state.landmarker = await loadLandmarker();
    if (USE_GRID && !state.grid) state.grid = new FaceGrid(featureSets(await faceLandmarkerClass()));
    await loadExtras();
  } catch (e) {
    console.error(e);
    if (run === state.run) setStatus('status.modelError', {}, true);
    return false;
  }
  return run === state.run;
}

function goLive(mode) {
  state.mode = mode;
  els.stage.classList.add('live');
  updateView();
  setButtons();
  setStatus(mode === 'demo' ? 'status.demo' : 'status.noFace');
}

// Caméra : une analyse par image affichée.
function scheduleVideoFrame(run) {
  const v = els.video;
  if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback((now, meta) => onVideoFrame(run, now, meta));
  else requestAnimationFrame((now) => onVideoFrame(run, now, null));
}

function onVideoFrame(run, now, meta) {
  if (run !== state.run) return;
  const v = els.video;
  // Heure de capture si le navigateur la donne, sinon heure d'affichage.
  if (v.videoWidth && !v.paused) processFrame((meta?.captureTime ?? meta?.expectedDisplayTime ?? now) / 1000, v, v.videoWidth, v.videoHeight);
  scheduleVideoFrame(run);
}

function startDemo() {
  stop(true);
  const run = state.run;
  state.demo ??= new DemoFace();
  const demo = state.demo;
  demo.configure(demoOptions());
  els.demoControls.hidden = false;
  goLive('demo');
  const { width: w, height: h } = demo.canvas;
  state.demoTimer = setInterval(() => {
    if (run !== state.run) return;
    const time = performance.now() / 1000;
    state.truth = demo.render(time);
    processFrame(time, demo.canvas, w, h, demo);
  }, 1000 / 30);
  startAnalysis();
}

const demoOptions = () => ({ bpm: +els.demoBpm.value, flicker: els.demoFlicker.checked, hair: els.demoHair.checked });

function onDemoChange() {
  els.demoBpmOut.textContent = els.demoBpm.value;
  if (state.mode !== 'demo') return;
  const bpmChanged = +els.demoBpm.value !== state.demo.bpm;
  state.demo.configure(demoOptions());
  // Nouveau rythme : on repart de zéro ; mèches ou lumière : on garde, pour voir l'effet.
  if (bpmChanged) resetBuffer();
}

// ---------- Amplification ----------
function onMagnifyChange() {
  state.magnify = els.magnify.checked;
  magnifier.reset();
  // Caméra : mesures suspendues pendant l'amplification, et tampon vidé dans les deux sens
  // pour ne garder aucune image éclairée par l'écran pulsant.
  if (state.mode === 'camera') resetBuffer();
  updateView();
  render();
}

function onGainChange() {
  state.gain = +els.gain.value;
  els.gainOut.textContent = `×${state.gain}`;
}

// ---------- Enregistrement ----------
function toggleRecording() {
  if (recorder.active) return finishRecording();
  const stream = state.mode === 'camera' ? state.stream : null;
  if (!stream) return;
  try {
    recorder.start(stream);
  } catch (e) {
    console.error(e);
    setStatus('rec.error', {}, true);
    return;
  }
  els.savePanel.hidden = true;
  state.pending = null;
  setButtons();
}

async function finishRecording() {
  const seconds = recorder.seconds;
  const ext = recorder.extension();
  const blob = await recorder.stop();
  setButtons();
  if (!blob?.size) return;
  state.pending = { blob, seconds, ext };
  els.saveTitle.textContent = t('rec.title', { s: Math.round(seconds) });
  els.refBpm.value = '';
  els.savePanel.hidden = false;
}

function saveRecording() {
  if (!state.pending) return;
  const ref = parseFloat(els.refBpm.value);
  download(state.pending.blob, recordingName(state.pending.ext, ref));
  state.pending = null;
  els.savePanel.hidden = true;
}

function discardRecording() {
  state.pending = null;
  els.savePanel.hidden = true;
}

// ---------- Analyse ----------
function runAnalysis() {
  if (recorder.active) {
    if (recorder.seconds >= MAX_SECONDS) finishRecording();
    setButtons();
  }
  const r = analyze(state.samples, USE_GRID
    ? { nfftZone: 1024, zoneWeights: state.zoneMemory.weigh, thresholds: GRID_THRESHOLDS }
    : {});
  state.result = r;
  if (r.ready) state.tracker.update(r);
  updateStatusFromResult(r);
  render();
}

function updateStatusFromResult(r) {
  if (state.mode === 'idle' || state.statusKey === 'status.ended') return;
  if (readingsPaused()) return setStatus('status.paused');
  if (state.mode !== 'demo' && state.noFaceSince !== null) return setStatus('status.noFace');
  if (state.mode !== 'demo' && motionAmount() > MOTION_LIMIT) return setStatus('status.motion');
  if (!r.ready) {
    const left = Math.max(1, Math.ceil(8 * (1 - r.progress)));
    return state.samples.length ? setStatus('status.warmup', { s: left }) : null;
  }
  if (state.mode === 'demo') return setStatus('status.demo');
  if (r.quality !== 'poor' && r.moving) return setStatus('status.movingOk');
  setStatus(r.quality === 'poor' ? 'status.weak' : 'status.ok');
}

// ---------- Affichage ----------
// Chaque zone est tracée dans la couleur de sa propre qualité.
function drawOverlay(regions, vw, vh, k) {
  const o = els.overlay;
  if (o.width !== vw || o.height !== vh) { o.width = vw; o.height = vh; }
  octx.clearRect(0, 0, vw, vh);
  const r = state.result;
  const s = vw / 320;
  octx.lineWidth = Math.max(1.5, s);
  octx.setLineDash([6 * s, 4 * s]);
  if (regions.length > 20) return drawHeatMap(regions, k, r);
  regions.forEach((reg, z) => {
    if (!reg) return;
    let q = 'none';
    if (r?.ready) {
      const zn = r.zones?.[z];
      q = r.zones ? (zn ? (zn.snr >= 2 ? 'good' : zn.snr >= 1 ? 'fair' : 'poor') : 'poor') : r.quality;
    }
    octx.strokeStyle = QUALITY_COLORS[q];
    tracePath(octx, reg, k);
    octx.stroke();
  });
}

// Grille : chaque cellule teintée selon la qualité de son signal, d'autant plus opaque que
// son poids dans la mesure est grand — une carte de l'endroit où le pouls se voit le mieux.
function drawHeatMap(regions, k, r) {
  let wmax = 0;
  if (r?.ready && r.zones) for (const zn of r.zones) if (zn) wmax = Math.max(wmax, zn.weight);
  octx.setLineDash([]);
  regions.forEach((reg, z) => {
    if (!reg) return;
    const zn = r?.ready ? r.zones?.[z] : null;
    tracePath(octx, reg, k);
    if (!zn || !wmax) {
      octx.strokeStyle = 'rgba(228,232,236,0.25)';
      octx.lineWidth = 1;
      octx.stroke();
      return;
    }
    const q = zn.snr >= 2 ? 'good' : zn.snr >= 1 ? 'fair' : 'poor';
    octx.globalAlpha = 0.22 + 0.5 * Math.sqrt(zn.weight / wmax);
    octx.fillStyle = QUALITY_COLORS[q];
    octx.fill();
    octx.globalAlpha = 1;
  });
}

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
  return { ctx, w: c.clientWidth, h: c.clientHeight };
}

function drawWave(r) {
  const { ctx, w, h } = fitCanvas(els.wave);
  ctx.strokeStyle = '#1e252d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  if (!r?.ready) return;
  const n = Math.min(r.wave.length, 300); // 10 s à 30 Hz
  const x = r.wave.subarray(r.wave.length - n);
  let max = 1e-12;
  for (const v of x) max = Math.max(max, Math.abs(v));
  ctx.strokeStyle = r.quality === 'poor' ? '#6c7784' : '#ff5f6d';
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = (i / (n - 1)) * w, py = h / 2 - (x[i] / max) * (h / 2 - 6);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.stroke();
}

function drawSpectrum(r) {
  const { ctx, w, h } = fitCanvas(els.spectrum);
  const base = h - 18;
  const fx = (f) => ((f - HR_MIN) / (HR_MAX - HR_MIN)) * w;
  ctx.fillStyle = '#8794a1'; ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
  ctx.strokeStyle = '#1e252d'; ctx.lineWidth = 1;
  for (const bpm of [60, 90, 120, 150]) {
    const x = fx(bpm / 60);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, base); ctx.stroke();
    ctx.fillText(String(bpm), x, h - 4);
  }
  if (state.truth) {
    const x = fx(state.truth / 60);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = '#e4e8ec';
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, base); ctx.stroke(); ctx.setLineDash([]);
  }
  if (!r?.ready) return;
  const k0 = Math.ceil(HR_MIN / r.df), k1 = Math.floor(HR_MAX / r.df);
  let max = 1e-30;
  for (let k = k0; k <= k1; k++) max = Math.max(max, r.power[k]);
  ctx.beginPath(); ctx.moveTo(fx(k0 * r.df), base);
  for (let k = k0; k <= k1; k++) ctx.lineTo(fx(k * r.df), base - (r.power[k] / max) * (base - 4));
  ctx.lineTo(fx(k1 * r.df), base); ctx.closePath();
  const good = r.quality !== 'poor';
  ctx.fillStyle = good ? 'rgba(255,95,109,0.22)' : 'rgba(108,119,132,0.22)';
  ctx.strokeStyle = good ? '#ff5f6d' : '#6c7784';
  ctx.fill(); ctx.stroke();
}

function render() {
  const r = state.result;
  const shown = state.lastT !== null ? state.tracker.value(state.lastT) : null;
  els.bpm.textContent = shown !== null ? Math.round(shown) : '—';
  // Grisé si la mesure du moment n'est pas fiable, ou si la tête bouge : sur de vraies vidéos en
  // mouvement, ~7 % des lectures « fiables » étaient fausses — le score de qualité ne suffit pas.
  els.bpm.classList.toggle('stale', shown !== null && r?.ready && (r.quality === 'poor' || r.moving));

  const q = r?.ready ? r.quality : 'none';
  els.quality.dataset.q = q;
  els.qualityLabel.textContent = t(`q.${q}`);
  els.snr.textContent = r?.ready ? `SNR ${r.snr.toFixed(1)} dB` : '';

  const warming = state.mode !== 'idle' && !readingsPaused() && r && !r.ready;
  els.progress.hidden = !warming;
  if (warming) els.progressBar.style.width = `${Math.round(r.progress * 100)}%`;

  els.truth.hidden = state.mode !== 'demo';
  if (state.truth) els.truth.textContent = t('demo.truth', { v: Math.round(+els.demoBpm.value) });

  if (r?.ready) {
    const parts = [
      t('details.pos', { v: `${r.bpm.toFixed(1)} bpm` }),
      t('details.mixed', { v: `${r.combinedBpm.toFixed(1)}` }),
      t('details.green', { v: `${r.greenBpm.toFixed(1)}` }),
    ];
    if (r.zones && r.zones.length > 20 && state.grid) {
      const N = state.grid.cells.length;
      const cellW = r.zones.slice(0, N).filter(Boolean).map((zn) => zn.weight).sort((a, b) => b - a);
      const top5 = cellW.slice(0, 5).reduce((a, b) => a + b, 0) / (cellW.reduce((a, b) => a + b, 0) || 1);
      parts.push(t('details.grid', { n: cellW.length, p: Math.round(top5 * 100) }));
      const extra = r.zones.slice(N).map((zn, j) => (zn ? `${t(`zone.${ZONES[3 + j]}`)} ${zn.snr.toFixed(1)} dB` : null)).filter(Boolean);
      if (extra.length) parts.push(extra.join(', '));
    } else if (r.zones) {
      const z = r.zones
        .map((zn, i) => (zn || i < 3 ? `${t(`zone.${ZONES[i]}`)} ${zn ? `${zn.snr.toFixed(1)} dB (${Math.round(zn.weight * 100)} %)` : '—'}` : null))
        .filter(Boolean);
      parts.push(`${t('details.zones')}: ${z.join(', ')}`);
    }
    parts.push(t('details.fps', { v: frameRate().toFixed(1) }), t('details.px', { v: `${state.pixels.toLocaleString()} (${Math.round(state.kept * 100)} %)` }));
    els.details.textContent = parts.join('  ·  ');
  } else {
    els.details.textContent = '—';
  }

  drawWave(r);
  drawSpectrum(r);
}

// ---------- Langue ----------
function refreshLang() {
  applyI18n();
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()));
  setStatus(state.statusKey, state.statusVars, state.statusError);
  if (state.pending) els.saveTitle.textContent = t('rec.title', { s: Math.round(state.pending.seconds) });
  setButtons();
  render();
}

// ---------- Câblage ----------
els.btnCamera.addEventListener('click', startCamera);
els.btnFile.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  const f = els.fileInput.files?.[0];
  if (f) startFile(f);
  els.fileInput.value = '';
});
els.btnDemo.addEventListener('click', startDemo);
els.btnStop.addEventListener('click', () => stop());
els.demoBpm.addEventListener('input', onDemoChange);
els.demoFlicker.addEventListener('change', onDemoChange);
els.demoHair.addEventListener('change', onDemoChange);
els.magnify.addEventListener('change', onMagnifyChange);
els.optHands.addEventListener('change', onExtrasChange);
els.optBody.addEventListener('change', onExtrasChange);
els.gain.addEventListener('input', onGainChange);
els.btnRecord.addEventListener('click', toggleRecording);
els.btnSave.addEventListener('click', saveRecording);
els.btnDiscard.addEventListener('click', discardRecording);
for (const b of document.querySelectorAll('[data-lang]'))
  b.addEventListener('click', () => { setLang(b.dataset.lang); refreshLang(); });
window.addEventListener('resize', render);

magnifier.canvas.hidden = true;
els.media.prepend(magnifier.canvas);
document.documentElement.lang = getLang();
refreshLang();
updateView();

// Accès pour le débogage depuis la console.
window.tricorder = { state, magnifier, recorder, startDemo, stop };
