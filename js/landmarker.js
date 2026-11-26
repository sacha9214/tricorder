// Modèles MediaPipe (visage, mains, corps), chargés une seule fois chacun, à la demande.
// Fichiers embarqués dans vendor/ (fonctionne hors ligne, aucune requête à un CDN) ; le CDN ne
// sert que de secours si les fichiers locaux manquent.
const LOCAL = new URL('../vendor/', import.meta.url).href;
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const CDN_MODELS = 'https://storage.googleapis.com/mediapipe-models';
const MODEL_FILES = {
  face: ['face_landmarker.task', `${CDN_MODELS}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`],
  face2: ['face_landmarker.task', `${CDN_MODELS}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`],
  hands: ['hand_landmarker.task', `${CDN_MODELS}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`],
  pose: ['pose_landmarker_lite.task', `${CDN_MODELS}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`],
};

let visionPromise = null;
const promises = {};
let lastTs = 0;

function vision() {
  visionPromise ??= (async () => {
    try {
      const mod = await import(`${LOCAL}mediapipe/vision_bundle.mjs`);
      const fileset = await mod.FilesetResolver.forVisionTasks(`${LOCAL}mediapipe/wasm`);
      return { mod, fileset, local: true };
    } catch {
      const mod = await import(`${CDN}/vision_bundle.mjs`);
      const fileset = await mod.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      return { mod, fileset, local: false };
    }
  })().catch((e) => { visionPromise = null; throw e; });
  return visionPromise;
}

function load(kind) {
  promises[kind] ??= (async () => {
    const { mod, fileset, local } = await vision();
    const [file, remote] = MODEL_FILES[kind];
    const modelPath = local ? `${LOCAL}models/${file}` : remote;
    const Task = { face: mod.FaceLandmarker, face2: mod.FaceLandmarker, hands: mod.HandLandmarker, pose: mod.PoseLandmarker }[kind];
    // face2 : deux visages (mode duel). Les visages donnent aussi leur matrice de rotation 3D.
    const extra = {
      face: { numFaces: 1, outputFacialTransformationMatrixes: true },
      face2: { numFaces: 2, outputFacialTransformationMatrixes: true },
      hands: { numHands: 2 },
      pose: { numPoses: 1 },
    }[kind];
    const make = (delegate) =>
      Task.createFromOptions(fileset, { baseOptions: { modelAssetPath: modelPath, delegate }, runningMode: 'VIDEO', ...extra });
    try { return await make('GPU'); } catch { return await make('CPU'); }
  })().catch((e) => { promises[kind] = null; throw e; });
  return promises[kind];
}

export const loadLandmarker = () => load('face');
export const loadLandmarker2 = () => load('face2');

// Listes de connexions de MediaPipe (yeux, sourcils, lèvres), pour la grille du visage.
export async function faceLandmarkerClass() {
  const { mod } = await vision();
  return mod.FaceLandmarker;
}
export const loadHands = () => load('hands');
export const loadPose = () => load('pose');

// Horodatage strictement croissant exigé par MediaPipe en mode VIDEO.
export function nextTs() {
  lastTs = Math.max(performance.now(), lastTs + 1);
  return lastTs;
}
