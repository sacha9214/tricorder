// Interface : sources (caméra, fichier, doigt, démo), boucle image par image, affichage,
// amplification du pouls, enregistrement, vérification par tapotement, historique, duel.
import { analyze, HR_MIN, HR_MAX } from './dsp.js';
import { tracePath, WORK_W, ZONES } from './extract.js';
import { DemoFace } from './demo.js';
import { Magnifier } from './magnify.js';
import { Recorder, recordingName, download, MAX_SECONDS } from './recorder.js';
import { loadLandmarker, loadLandmarker2, loadHands, loadPose, faceLandmarkerClass } from './landmarker.js';
import { FaceGrid, featureSets } from './grid.js';
import { videoFrames, measureFrame, detectFaces, measureFace } from './frames.js';
import { Person } from './person.js';
import { FingerSensor, fingerAnalyze } from './finger.js';
import { setTorch, lockExposure, unlockExposure, exposureCollapsed, brighten } from './camera.js';
import { pulseDelay } from './delay.js';
import { tappedBpm, loadChecks, saveCheck, clearChecks, checksCsv, checkSummary } from './check.js';
import { drawHistory, historyCsv, stats } from './history.js';
import { t, setLang, getLang, applyI18n } from './i18n.js';

const GAP_RESET_S = 0.5;   // visage perdu plus longtemps → on repart de zéro
// Déplacement du nez sur 1 s, en fraction de l'écart des yeux. Le mouvement est corrigé ;
// au-delà de ce seuil on prévient seulement que les mesures peuvent sauter.
const MOTION_LIMIT = 0.3;
// Grille détaillée du visage au lieu de 3 zones : choisie sur de vraies vidéos (voir README).
const USE_GRID = true;
const CHECK_SECONDS = 20;
const QUALITY_COLORS = { good: '#3ccf8e', fair: '#e9bd4c', poor: '#8794a1', none: '#e4e8ec' };

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'), media: $('media'), video: $('video'), overlay: $('overlay'), status: $('status'),
  btnCamera: $('btnCamera'), btnFile: $('btnFile'), fileInput: $('fileInput'), btnFinger: $('btnFinger'), btnDemo: $('btnDemo'), btnStop: $('btnStop'),
  optHands: $('optHands'), optBody: $('optBody'), optDuel: $('optDuel'),
  demoControls: $('demoControls'), demoBpm: $('demoBpm'), demoBpmOut: $('demoBpmOut'), demoFlicker: $('demoFlicker'), demoHair: $('demoHair'),
  magnify: $('magnify'), gainRow: $('gainRow'), gain: $('gain'), gainOut: $('gainOut'), magnifyHint: $('magnifyHint'), fingerHint: $('fingerHint'),
  btnRecord: $('btnRecord'), recLabel: $('recLabel'),
  savePanel: $('savePanel'), saveTitle: $('saveTitle'), refBpm: $('refBpm'), btnSave: $('btnSave'), btnDiscard: $('btnDiscard'),
  btnCheck: $('btnCheck'), btnTap: $('btnTap'), btnCheckDone: $('btnCheckDone'), checkLive: $('checkLive'), checkResult: $('checkResult'),
  checkSaveRow: $('checkSaveRow'), btnCheckSave: $('btnCheckSave'), checkSummary: $('checkSummary'), btnCheckExport: $('btnCheckExport'), btnCheckClear: $('btnCheckClear'),
  duelCard: $('duelCard'), duelLeft: $('duelLeft'), duelRight: $('duelRight'), duelDiff: $('duelDiff'),
  history: $('history'), historyStats: $('historyStats'), btnHistoryExport: $('btnHistoryExport'),
  breathRate: $('breathRate'), breathWave: $('breathWave'),
  bpm: $('bpm'), quality: $('quality'), qualityLabel: $('qualityLabel'), snr: $('snr'),
  progress: $('progress'), progressBar: $('progressBar'), truth: $('truth'),
  wave: $('wave'), spectrum: $('spectrum'), details: $('details'),
};
const octx = els.overlay.getContext('2d');
const magnifier = new Magnifier();
const recorder = new Recorder();
const finger = new FingerSensor();

const state = {
  mode: 'idle', run: 0,
  people: [new Person()],
  motion: [], frameTimes: [],
  stream: null, fileUrl: null, demo: null, demoTimer: null, analyzeTimer: null,
  landmarker: null, landmarker2: null, truth: null,
  magnify: false, gain: 50, duel: false,
  extras: { hands: false, body: false }, handsModel: null, poseModel: null, grid: null,
  finger: { samples: [], result: null, present: false, torch: false, fallback: false },
  exposure: null, // 'locked' | 'unsupported' | 'failed' (+ boosted)
  exposureBoosted: false,
  delay: null,
  check: null, // { taps: [], start, timer, result }
  pending: null, // enregistrement terminé, pas encore enregistré : { blob, seconds, ext }
  statusKey: 'status.idle', statusVars: {}, statusError: false,
};
const P = () => state.people[0];

// ---------- Statut ----------
function setStatus(key, vars = {}, error = false) {
  state.statusKey = key; state.statusVars = vars; state.statusError = error;
  els.status.textContent = t(key, vars);
  els.status.classList.toggle('error', error);
}

// ---------- Personnes ----------
function resetPeople() {
  for (const p of state.people) p.reset();
  state.motion = [];
  state.delay = null;
}

function setPeopleCount(n) {
  while (state.people.length < n) state.people.push(new Person());
  state.people.length = n;
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

// ---------- Modèles ----------
const models = () => ({
  face: state.landmarker,
  grid: USE_GRID ? state.grid : null,
  // Mains et corps : une seule personne (pas en duel).
  hands: state.extras.hands && !state.duel ? state.handsModel : null,
  pose: state.extras.body && !state.duel ? state.poseModel : null,
});

async function loadExtras() {
  if (state.extras.hands && !state.handsModel) state.handsModel = await loadHands();
  if (state.extras.body && !state.poseModel) state.poseModel = await loadPose();
  if (state.duel && !state.landmarker2) state.landmarker2 = await loadLandmarker2();
}

async function onExtrasChange() {
  state.extras = { hands: els.optHands.checked, body: els.optBody.checked };
  state.duel = els.optDuel.checked;
  setPeopleCount(state.duel ? 2 : 1);
  if (state.mode === 'camera' || state.mode === 'file') {
    const key = state.statusKey;
    setStatus('status.loadingModel');
    try { await loadExtras(); } catch (e) { console.error(e); setStatus('status.modelError', {}, true); return; }
    setStatus(key);
  }
  // Le nombre de zones ou de personnes change : on repart de zéro.
  for (const p of state.people) p.clear();
  state.motion = [];
  els.duelCard.hidden = !state.duel;
  render();
}

// ---------- Traitement d'une image (visages) ----------
// fixed : { regions, hull } pour la démo (zones connues), sinon détection des visages.
function processFrame(time, source, w, h, fixed = null) {
  state.frameTimes.push(time);
  while (state.frameTimes.length && state.frameTimes[0] < time - 2) state.frameTimes.shift();
  const layers = []; // [{ regions, result }] pour la superposition
  let hull = null;

  if (fixed) {
    const p = P();
    const m = p.extractor.measure(source, w, h, fixed.regions);
    if (m) p.push(time, m);
    hull = fixed.hull;
    layers.push({ regions: fixed.regions, result: p.result });
  } else if (state.duel) {
    // Deux visages, rangés de gauche à droite tels qu'on les voit à l'écran (image en miroir
    // pour la caméra).
    let faces = detectFaces(source, state.landmarker2);
    if (state.mode === 'camera') faces = faces.reverse();
    state.people.forEach((p, i) => {
      const f = faces[i];
      if (!f) {
        p.noFaceSince ??= time;
        if (time - p.noFaceSince > GAP_RESET_S) p.reset();
        return;
      }
      const res = measureFace(source, w, h, f.lm, f.matrix, models(), p.extractor);
      p.noFaceSince = null;
      if (res.m && !readingsPaused()) p.push(time, res.m, res.face.motion, res.bg);
      if (i === 0) { trackMotion(time, res.face); hull = res.face.hull.map((q) => ({ x: (q.x * w) / WORK_W, y: (q.y * w) / WORK_W })); }
      layers.push({ regions: res.regions, result: p.result });
    });
  } else {
    const p = P();
    const res = measureFrame(source, w, h, models(), p.extractor);
    if (res) {
      const k = w / WORK_W;
      hull = res.face.hull.map((q) => ({ x: q.x * k, y: q.y * k }));
      trackMotion(time, res.face);
      p.noFaceSince = null;
      if (res.m && !readingsPaused()) p.push(time, res.m, res.face.motion, res.bg);
      layers.push({ regions: res.regions, result: p.result });
    } else {
      p.noFaceSince ??= time;
      if (time - p.noFaceSince > GAP_RESET_S) p.reset();
    }
  }
  if (state.magnify) {
    const bpm = P().tracker.bpm;
    magnifier.setBand(bpm ? bpm / 60 : null, frameRate());
    magnifier.process(source, w, h, hull, state.gain);
  }
  drawOverlay(layers, w, h, w / WORK_W);
}

// ---------- Mode doigt ----------
function processFinger(time, source) {
  state.frameTimes.push(time);
  while (state.frameTimes.length && state.frameTimes[0] < time - 2) state.frameTimes.shift();
  const f = state.finger;
  const m = finger.measure(source);
  f.present = m.present;
  if (!m.present) { if (f.samples.length && time - f.samples[f.samples.length - 1].t > 1) f.samples = []; return; }
  if (f.samples.length && time - f.samples[f.samples.length - 1].t > GAP_RESET_S) f.samples = [];
  f.samples.push({ t: time, r: m.r, g: m.g, b: m.b });
  while (f.samples.length && f.samples[0].t < time - 12) f.samples.shift();
  octx.clearRect(0, 0, els.overlay.width, els.overlay.height);
}

// ---------- Sources ----------
function stop(keepStatus = false) {
  state.run++;
  if (recorder.active) finishRecording();
  if (state.check?.timer) finishCheck();
  clearInterval(state.demoTimer); state.demoTimer = null;
  clearInterval(state.analyzeTimer); state.analyzeTimer = null;
  const track = state.stream?.getVideoTracks?.()[0];
  if (state.finger.torch && track) setTorch(track, false);
  state.stream?.getTracks().forEach((tr) => tr.stop());
  state.stream = null;
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.srcObject = null;
  if (state.fileUrl) { URL.revokeObjectURL(state.fileUrl); state.fileUrl = null; }
  els.media.classList.remove('mirror');
  els.stage.classList.remove('live');
  els.demoControls.hidden = true;
  els.fingerHint.hidden = true;
  state.mode = 'idle';
  state.truth = null;
  state.frameTimes = [];
  state.finger = { samples: [], result: null, present: false, torch: false, fallback: false };
  state.exposure = null;
  state.exposureBoosted = false;
  for (const p of state.people) p.clear();
  state.motion = [];
  state.delay = null;
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
  els.btnFinger.classList.toggle('active', state.mode === 'finger');
  els.btnDemo.classList.toggle('active', state.mode === 'demo');
  // Caméra seulement : la démo n'a pas de vrai visage, son enregistrement ne serait pas analysable.
  els.btnRecord.disabled = state.mode !== 'camera' && !recorder.active;
  els.btnRecord.classList.toggle('recording', recorder.active);
  els.recLabel.textContent = recorder.active ? t('rec.stop', { s: formatTime(recorder.seconds) }) : t('rec.start');
  els.btnCheck.disabled = !(state.mode === 'camera' || state.mode === 'finger') || !!state.check?.timer;
}

const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Une seule image visible dans la scène : vidéo, visage de démo, ou image amplifiée.
function updateView() {
  const live = state.mode !== 'idle';
  const showMag = live && state.magnify && state.mode !== 'finger';
  els.video.hidden = !live || state.mode === 'demo' || showMag;
  if (state.demo) state.demo.canvas.hidden = state.mode !== 'demo' || showMag;
  magnifier.canvas.hidden = !showMag;
  if (!magnifier.canvas.isConnected) els.media.prepend(magnifier.canvas);
  if (state.demo && !state.demo.canvas.isConnected) els.media.prepend(state.demo.canvas);
  els.gainRow.hidden = !state.magnify;
  els.magnifyHint.hidden = !state.magnify;
  els.duelCard.hidden = !state.duel;
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
  goLive('camera');
  // Lancer la vidéo une fois visible : sur iPhone, une vidéo démarrée cachée peut rester noire.
  try { await els.video.play(); } catch (e) { console.error(e); }
  startAnalysis();
  scheduleVideoFrame(run);
  manageExposure(run, stream.getVideoTracks()[0]);
}

// Luminosité moyenne de toute l'image (0–255), sur une petite copie.
function frameLevel() {
  const m = finger.measure(els.video);
  return (m.r + m.g + m.b) / 3;
}

// Exposition : laisser l'automatique se régler 2,5 s, puis figer (si la caméra le permet) ;
// si le visage est très sombre, éclaircir d'un cran puis figer à nouveau. Expérimental.
async function manageExposure(run, track) {
  await new Promise((r) => setTimeout(r, 2500));
  if (run !== state.run) return;
  const before = frameLevel();
  state.exposure = await lockExposure(track);
  if (state.exposure === 'locked') {
    // Filet de sécurité : si l'image s'assombrit nettement, on rend la main à l'automatique.
    await new Promise((r) => setTimeout(r, 800));
    if (run !== state.run) return;
    if (exposureCollapsed(before, frameLevel())) {
      await unlockExposure(track);
      state.exposure = 'reverted';
      resetPeople();
      return;
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
  if (run !== state.run) return;
  const s = P().samples[P().samples.length - 1];
  if (s && (s.r + s.g + s.b) / 3 < 70 && (await brighten(track))) {
    state.exposureBoosted = true;
    // Le niveau a changé : on repart de zéro pour ne pas mélanger deux expositions.
    resetPeople();
  }
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

async function startFinger() {
  stop(true);
  const run = state.run;
  setStatus('status.camera');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: 'environment' }, frameRate: { ideal: 30 } }, audio: false });
  } catch {
    // Pas de caméra arrière (ordinateur) : la caméra habituelle, près d'une lumière.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
      state.finger.fallback = true;
    } catch {
      if (run === state.run) setStatus('status.cameraDenied', {}, true);
      return;
    }
  }
  if (run !== state.run) { stream.getTracks().forEach((tr) => tr.stop()); return; }
  state.stream = stream;
  els.video.srcObject = stream;
  state.mode = 'finger';
  els.stage.classList.add('live');
  els.fingerHint.hidden = false;
  updateView();
  try { await els.video.play(); } catch (e) { console.error(e); }
  state.finger.torch = await setTorch(stream.getVideoTracks()[0], true);
  setButtons();
  setStatus(state.finger.fallback ? 'status.fingerNoCam' : 'status.fingerNone');
  startAnalysis();
  scheduleVideoFrame(run);
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
  const time = (meta?.captureTime ?? meta?.expectedDisplayTime ?? now) / 1000;
  if (v.videoWidth && !v.paused) {
    if (state.mode === 'finger') processFinger(time, v);
    else processFrame(time, v, v.videoWidth, v.videoHeight);
  }
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
  if (bpmChanged) resetPeople();
}

// ---------- Amplification ----------
function onMagnifyChange() {
  state.magnify = els.magnify.checked;
  magnifier.reset();
  // Caméra : mesures suspendues pendant l'amplification, et tampon vidé dans les deux sens
  // pour ne garder aucune image éclairée par l'écran pulsant.
  if (state.mode === 'camera') resetPeople();
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
  els.refBpm.value = state.check?.result?.tapped ? Math.round(state.check.result.tapped) : '';
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

// ---------- Vérification par tapotement ----------
function startCheck() {
  state.check = { taps: [], start: performance.now() / 1000, result: null, timer: null };
  state.check.timer = setInterval(() => {
    const left = CHECK_SECONDS - (performance.now() / 1000 - state.check.start);
    els.checkLive.textContent = t('check.live', { n: state.check.taps.length, s: Math.max(0, Math.ceil(left)) });
    if (left <= 0) finishCheck();
  }, 200);
  els.btnTap.hidden = false;
  els.btnCheckDone.hidden = false;
  els.checkLive.hidden = false;
  els.checkResult.hidden = true;
  els.checkSaveRow.hidden = true;
  els.btnTap.focus();
  setButtons();
}

function tap() {
  if (!state.check?.timer) return;
  state.check.taps.push(performance.now() / 1000);
  els.checkLive.textContent = t('check.live', { n: state.check.taps.length, s: Math.max(0, Math.ceil(CHECK_SECONDS - (performance.now() / 1000 - state.check.start))) });
}

// Lecture de la caméra (ou du doigt) pendant la vérification : médiane des valeurs affichées.
function cameraDuringCheck(start, end) {
  if (state.mode === 'finger') {
    const r = state.finger.result;
    return r?.ready && r.quality !== 'poor' ? r.bpm : null;
  }
  const p = P();
  if (p.t0 === null) return null;
  const v = p.history.filter((h) => h.bpm !== null && h.t + p.t0 >= start - 1 && h.t + p.t0 <= end + 1).map((h) => h.bpm).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : null;
}

function finishCheck() {
  const c = state.check;
  if (!c?.timer) return;
  clearInterval(c.timer);
  c.timer = null;
  const end = performance.now() / 1000;
  const tapped = tappedBpm(c.taps);
  els.btnTap.hidden = true;
  els.btnCheckDone.hidden = true;
  els.checkLive.hidden = true;
  els.checkResult.hidden = false;
  if (!tapped) {
    els.checkResult.textContent = t('check.tooFew');
    setButtons();
    return;
  }
  // Horloge des mesures : celle des images (performance.now au même référentiel en direct).
  const cam = cameraDuringCheck(c.start, end);
  const r = P().result;
  const last = P().samples[P().samples.length - 1];
  c.result = {
    date: new Date().toISOString(), tapped: tapped.bpm, camera: cam,
    source: state.mode, quality: state.mode === 'finger' ? state.finger.result?.quality : r?.quality,
    working: r?.working ?? null, moving: !!r?.moving, light: !!r?.lightChanging,
    skin: last ? [last.r, last.g, last.b] : null,
  };
  els.checkResult.textContent = cam !== null
    ? t('check.result', { tap: tapped.bpm.toFixed(0), cam: cam.toFixed(0), d: (cam - tapped.bpm > 0 ? '+' : '') + (cam - tapped.bpm).toFixed(0) })
    : t('check.resultNoCam', { tap: tapped.bpm.toFixed(0) });
  els.checkSaveRow.hidden = false;
  setButtons();
}

function saveCurrentCheck() {
  if (!state.check?.result) return;
  saveCheck(state.check.result);
  els.checkSaveRow.hidden = true;
  renderChecks();
}

function renderChecks() {
  const s = checkSummary(loadChecks());
  els.checkSummary.textContent = s ? t('check.summary', { n: s.n, mae: s.mae.toFixed(1), p: Math.round(s.within5 * 100) }) : '';
}

// ---------- Analyse ----------
function runAnalysis() {
  if (recorder.active) {
    if (recorder.seconds >= MAX_SECONDS) finishRecording();
    setButtons();
  }
  if (state.mode === 'finger') {
    state.finger.result = fingerAnalyze(state.finger.samples);
    updateStatusFromResult(null);
    render();
    return;
  }
  for (const p of state.people) p.analyze({ grid: USE_GRID });
  if (state.extras.hands && !state.duel) state.delay = computeDelay(P());
  updateStatusFromResult(P().result);
  render();
}

// Délai du pouls visage → paume (zones en option « Mains ») : onde du visage seul contre onde
// d'une paume, intercorrélées. Montré seulement si les deux signaux sont nets et cohérents.
function computeDelay(p) {
  const N = state.grid?.cells.length ?? 3;
  if (!p.samples.length || p.samples[p.samples.length - 1].zones.length <= N) return null;
  const only = (idx) => p.samples.map((s) => ({ ...s, zones: idx.map((i) => s.zones[i] ?? null) }));
  const face = analyze(only([...Array(N).keys()]), { nfftZone: 1024, motion: null });
  const delays = [];
  for (const palm of [N, N + 1]) {
    const r = analyze(only([palm]), { motion: null });
    if (!face.ready || !r.ready || r.method !== 'fusion' || r.quality === 'poor' || face.quality === 'poor') continue;
    const d = pulseDelay(face.wave, r.wave, 30);
    if (d.corr >= 0.5) delays.push(d.ms);
  }
  return delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null;
}

function updateStatusFromResult(r) {
  if (state.mode === 'idle' || state.statusKey === 'status.ended') return;
  if (state.mode === 'finger') {
    const f = state.finger;
    if (!f.present) return setStatus(f.fallback ? 'status.fingerNoCam' : 'status.fingerNone');
    return setStatus(f.result?.ready && f.result.quality === 'poor' ? 'status.fingerWeak' : 'status.fingerOk');
  }
  if (readingsPaused()) return setStatus('status.paused');
  if (state.mode !== 'demo' && P().noFaceSince !== null) return setStatus(state.duel ? 'duel.need' : 'status.noFace');
  if (state.mode !== 'demo' && motionAmount() > MOTION_LIMIT) return setStatus('status.motion');
  if (!r?.ready) {
    const left = Math.max(1, Math.ceil(8 * (1 - (r?.progress ?? 0))));
    return P().samples.length ? setStatus('status.warmup', { s: left }) : null;
  }
  if (state.mode === 'demo') return setStatus('status.demo');
  if (r.quality !== 'poor' && r.moving) return setStatus('status.movingOk');
  if (r.quality !== 'poor' && r.lightChanging) return setStatus('status.lightOk');
  setStatus(r.quality === 'poor' ? 'status.weak' : 'status.ok');
}

// ---------- Affichage ----------
function drawOverlay(layers, vw, vh, k) {
  const o = els.overlay;
  if (o.width !== vw || o.height !== vh) { o.width = vw; o.height = vh; }
  octx.clearRect(0, 0, vw, vh);
  const s = vw / 320;
  for (const { regions, result: r } of layers) {
    octx.lineWidth = Math.max(1.5, s);
    octx.setLineDash([6 * s, 4 * s]);
    if (regions.length > 20) { drawHeatMap(regions, k, r); continue; }
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
}

// Grille : chaque cellule où le pouls ressort (SNR ≥ 0 dB à la fréquence retenue) est teintée
// en vert, d'autant plus intense que son signal est net ; les autres restent un simple contour.
function drawHeatMap(regions, k, r) {
  octx.setLineDash([]);
  regions.forEach((reg, z) => {
    if (!reg) return;
    const zn = r?.ready ? r.zones?.[z] : null;
    tracePath(octx, reg, k);
    if (!zn || !(zn.snr >= 0)) {
      octx.strokeStyle = 'rgba(228,232,236,0.22)';
      octx.lineWidth = 1;
      octx.stroke();
      return;
    }
    octx.globalAlpha = Math.min(0.8, 0.25 + 0.12 * zn.snr);
    octx.fillStyle = QUALITY_COLORS.good;
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
  if (!r?.ready || !r.wave) return;
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
  if (!r?.ready || !r.power) return;
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
  const finger = state.mode === 'finger';
  const p = P();
  const r = finger ? state.finger.result : p.result;
  const shown = finger ? (r?.ready && r.quality !== 'poor' ? r.bpm : null) : p.value();
  els.bpm.textContent = shown !== null && Number.isFinite(shown) ? Math.round(shown) : '—';
  // Grisé si la mesure du moment n'est pas fiable, ou si la tête bouge : sur de vraies vidéos en
  // mouvement, ~7 % des lectures « fiables » étaient fausses — le score de qualité ne suffit pas.
  els.bpm.classList.toggle('stale', !finger && shown !== null && r?.ready && (r.quality === 'poor' || r.moving));

  const q = r?.ready ? r.quality : 'none';
  els.quality.dataset.q = q;
  els.qualityLabel.textContent = t(`q.${q}`);
  els.snr.textContent = r?.ready && Number.isFinite(r.snr) ? `SNR ${r.snr.toFixed(1)} dB` : '';

  const warming = state.mode !== 'idle' && !readingsPaused() && r && !r.ready;
  els.progress.hidden = !warming;
  if (warming) els.progressBar.style.width = `${Math.round((r.progress ?? 0) * 100)}%`;

  els.truth.hidden = state.mode !== 'demo';
  if (state.truth) els.truth.textContent = t('demo.truth', { v: Math.round(+els.demoBpm.value) });

  renderDetails(r, finger);
  drawWave(r);
  drawSpectrum(r);
  drawBreath(finger ? null : p.breathResult);
  renderDuel();
  renderHistory();
}

function renderDetails(r, finger) {
  if (!r?.ready) { els.details.textContent = '—'; return; }
  const parts = [];
  if (finger) {
    parts.push(`finger · ${r.channel ?? '—'} channel`, t('details.fps', { v: frameRate().toFixed(1) }));
    els.details.textContent = parts.join('  ·  ');
    return;
  }
  parts.push(
    t('details.pos', { v: `${r.bpm.toFixed(1)} bpm` }),
    t('details.mixed', { v: `${r.combinedBpm.toFixed(1)}` }),
    t('details.green', { v: `${r.greenBpm.toFixed(1)}` }),
  );
  if (r.zones && r.zones.length > 20 && state.grid) {
    const N = state.grid.cells.length;
    const cells = r.zones.slice(0, N).filter(Boolean);
    parts.push(t('details.grid', { n: cells.length, w: cells.filter((zn) => zn.snr >= 0).length }));
    const extra = r.zones.slice(N).map((zn, j) => (zn ? `${t(`zone.${ZONES[3 + j]}`)} ${zn.snr.toFixed(1)} dB` : null)).filter(Boolean);
    if (extra.length) parts.push(extra.join(', '));
  } else if (r.zones) {
    const z = r.zones
      .map((zn, i) => (zn || i < 3 ? `${t(`zone.${ZONES[i]}`)} ${zn ? `${zn.snr.toFixed(1)} dB (${Math.round(zn.weight * 100)} %)` : '—'}` : null))
      .filter(Boolean);
    parts.push(`${t('details.zones')}: ${z.join(', ')}`);
  }
  if (state.delay !== null) parts.push(t('details.delay', { v: Math.round(state.delay) }));
  if (state.exposure) parts.push(t('details.exposure', { v: t(`exposure.${state.exposure}`) + (state.exposureBoosted ? `, ${t('exposure.boosted')}` : '') }));
  parts.push(t('details.fps', { v: frameRate().toFixed(1) }), t('details.px', { v: `${P().pixels.toLocaleString()} (${Math.round(P().kept * 100)} %)` }));
  els.details.textContent = parts.join('  ·  ');
}

function renderDuel() {
  if (!state.duel) return;
  const [a, b] = state.people;
  const va = a?.value() ?? null, vb = b?.value() ?? null;
  els.duelLeft.textContent = va !== null ? Math.round(va) : '—';
  els.duelRight.textContent = vb !== null ? Math.round(vb) : '—';
  els.duelDiff.textContent = va !== null && vb !== null ? t('duel.diff', { d: Math.abs(Math.round(va - vb)) }) : t('duel.need');
}

let lastHistoryDraw = 0;
function renderHistory() {
  const now = performance.now();
  if (now - lastHistoryDraw < 1000 && state.mode !== 'idle') return;
  lastHistoryDraw = now;
  const [a, b] = state.people;
  drawHistory(els.history, a.history, { other: state.duel ? b?.history : null });
  const s = stats(a.history);
  els.historyStats.textContent = s ? t('history.stats', { min: Math.round(s.min), med: Math.round(s.median), max: Math.round(s.max) }) : '—';
}

function exportHistory() {
  const [a, b] = state.people;
  if (!a.history.length) return;
  download(new Blob([historyCsv(a.history, state.duel ? b?.history : null)], { type: 'text/csv' }), `tricorder-session-${new Date().toISOString().slice(0, 16).replace(':', '')}.csv`);
}

// Respiration : onde (10 Hz, 32 s) et rythme seulement si le pic est net.
const BREATH_CLARITY = 0.45;
function drawBreath(b) {
  const clear = b?.ready && b.clarity >= BREATH_CLARITY;
  els.breathRate.textContent = clear ? Math.round(b.rate) : '—';
  const { ctx, w, h } = fitCanvas(els.breathWave);
  ctx.strokeStyle = '#1e252d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  if (!b?.ready || !b.wave) return;
  const x = b.wave, n = x.length;
  let max = 1e-12;
  for (const v of x) max = Math.max(max, Math.abs(v));
  ctx.strokeStyle = clear ? '#7aa2ff' : '#6c7784';
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = (i / (n - 1)) * w, py = h / 2 - (x[i] / max) * (h / 2 - 6);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.stroke();
}

// ---------- Langue ----------
function refreshLang() {
  applyI18n();
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()));
  setStatus(state.statusKey, state.statusVars, state.statusError);
  if (state.pending) els.saveTitle.textContent = t('rec.title', { s: Math.round(state.pending.seconds) });
  setButtons();
  renderChecks();
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
els.btnFinger.addEventListener('click', startFinger);
els.btnDemo.addEventListener('click', startDemo);
els.btnStop.addEventListener('click', () => stop());
els.demoBpm.addEventListener('input', onDemoChange);
els.demoFlicker.addEventListener('change', onDemoChange);
els.demoHair.addEventListener('change', onDemoChange);
els.magnify.addEventListener('change', onMagnifyChange);
els.optHands.addEventListener('change', onExtrasChange);
els.optBody.addEventListener('change', onExtrasChange);
els.optDuel.addEventListener('change', onExtrasChange);
els.gain.addEventListener('input', onGainChange);
els.btnRecord.addEventListener('click', toggleRecording);
els.btnSave.addEventListener('click', saveRecording);
els.btnDiscard.addEventListener('click', discardRecording);
els.btnCheck.addEventListener('click', startCheck);
els.btnTap.addEventListener('pointerdown', (e) => { e.preventDefault(); tap(); });
els.btnCheckDone.addEventListener('click', finishCheck);
els.btnCheckSave.addEventListener('click', saveCurrentCheck);
els.btnCheckExport.addEventListener('click', () => {
  const all = loadChecks();
  if (all.length) download(new Blob([checksCsv(all)], { type: 'text/csv' }), 'tricorder-checks.csv');
});
els.btnCheckClear.addEventListener('click', () => { clearChecks(); renderChecks(); });
els.btnHistoryExport.addEventListener('click', exportHistory);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && state.check?.timer) { e.preventDefault(); if (!e.repeat) tap(); }
});
for (const b of document.querySelectorAll('[data-lang]'))
  b.addEventListener('click', () => { setLang(b.dataset.lang); refreshLang(); });
window.addEventListener('resize', render);

magnifier.canvas.hidden = true;
els.media.prepend(magnifier.canvas);
document.documentElement.lang = getLang();
refreshLang();
updateView();

// Application installable et utilisable hors ligne (service worker), seulement en HTTPS ou
// sur localhost.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker', e));
}

// Retour sur la page (téléphone verrouillé, autre appli) : la vidéo a pu être mise en pause.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && els.video.srcObject && els.video.paused) {
    els.video.play().catch(() => {});
  }
});

// Accès pour le débogage depuis la console.
window.tricorder = { state, magnifier, recorder, startDemo, stop, P };
