// Lecture d'un fichier vidéo image par image (en se plaçant à chaque instant) et mesure
// d'une image : visage → zones → couleur de peau par zone.
import { faceRegions, handRegions, bodyRegions, ZONES, FACE_ZONES } from './extract.js';
import { nextTs } from './landmarker.js';

export const seekTo = (v, time) =>
  new Promise((resolve) => {
    v.addEventListener('seeked', resolve, { once: true });
    v.currentTime = time;
  });

export async function videoDuration(v) {
  if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
  if (Number.isFinite(v.duration)) return v.duration;
  // WebM sans durée (MediaRecorder) : aller au bout pour la connaître.
  await seekTo(v, 1e7);
  return v.duration;
}

// Itère sur les instants 0, 1/fps, 2/fps… ; l'image est prête à chaque pas.
export async function* videoFrames(v, fps = 30) {
  v.pause();
  const duration = await videoDuration(v);
  const step = 1 / fps;
  for (let time = 0; time < duration - step / 2; time += step) {
    await seekTo(v, time);
    yield { time, duration };
  }
}

// Mesure d'une image. models : { face, hands?, pose? } (mains et corps seulement s'ils sont
// fournis). Renvoie { face, regions, m } (m null si pas assez de peau) ou null sans visage.
export function measureFrame(source, w, h, models, extractor) {
  const res = models.face.detectForVideo(source, nextTs());
  const lm = res.faceLandmarks?.[0];
  if (!lm) return null;
  const { w: ww, h: wh } = extractor.size(w, h);
  const face = faceRegions(lm, ww, wh);
  let regions = face.regions;
  if (models.hands || models.pose) {
    const extra = {};
    if (models.hands) {
      const hr = models.hands.detectForVideo(source, nextTs());
      Object.assign(extra, handRegions(hr.landmarks ?? [], hr.handedness ?? hr.handednesses ?? [], ww, wh));
    }
    if (models.pose) {
      const pr = models.pose.detectForVideo(source, nextTs());
      if (pr.landmarks?.[0]) Object.assign(extra, bodyRegions(pr.landmarks[0], face.chin, ww, wh));
    }
    // Toujours 10 emplacements quand les options sont actives : une zone garde son indice.
    regions = ZONES.map((name, i) => (i < FACE_ZONES ? face.regions[i] : extra[name] ?? null));
  }
  return { face, regions, m: extractor.measure(source, w, h, regions) };
}
