// Modèles MediaPipe (visage, mains, corps), chargés une seule fois chacun, à la demande.
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODELS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  hands: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

let visionPromise = null;
const promises = {};
let lastTs = 0;

function vision() {
  visionPromise ??= (async () => {
    const mod = await import(`${VISION}/vision_bundle.mjs`);
    const fileset = await mod.FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    return { mod, fileset };
  })().catch((e) => { visionPromise = null; throw e; });
  return visionPromise;
}

function load(kind) {
  promises[kind] ??= (async () => {
    const { mod, fileset } = await vision();
    const Task = { face: mod.FaceLandmarker, hands: mod.HandLandmarker, pose: mod.PoseLandmarker }[kind];
    const extra = { face: { numFaces: 1 }, hands: { numHands: 2 }, pose: { numPoses: 1 } }[kind];
    const make = (delegate) =>
      Task.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODELS[kind], delegate }, runningMode: 'VIDEO', ...extra });
    try { return await make('GPU'); } catch { return await make('CPU'); }
  })().catch((e) => { promises[kind] = null; throw e; });
  return promises[kind];
}

export const loadLandmarker = () => load('face');
export const loadHands = () => load('hands');
export const loadPose = () => load('pose');

// Horodatage strictement croissant exigé par MediaPipe en mode VIDEO.
export function nextTs() {
  lastTs = Math.max(performance.now(), lastTs + 1);
  return lastTs;
}
