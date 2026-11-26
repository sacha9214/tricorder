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
// Un serveur qui ne gère pas les requêtes partielles (Range) empêche le navigateur de se
// déplacer dans la vidéo, mais l'événement « seeked » arrive quand même : sans contrôle,
// on analyserait la même image des milliers de fois. On vérifie donc la position atteinte.
export async function* videoFrames(v, fps = 30) {
  v.pause();
  const duration = await videoDuration(v);
  const step = 1 / fps;
  for (let time = 0; time < duration - step / 2; time += step) {
    await seekTo(v, time);
    if (Math.abs(v.currentTime - time) > 0.25) {
      throw new Error(`seek failed: asked ${time.toFixed(2)} s, got ${v.currentTime.toFixed(2)} s (server without Range support?)`);
    }
    yield { time, duration };
  }
}

// Fond de chaque côté de la tête (mur, décor) : couleur moyenne de deux rectangles placés à
// ~2 écarts des yeux à gauche et à droite du nez, dans l'image de travail. La lumière qui change
// (lampe, écran, télé) touche aussi le fond ; le pouls, non. Sert de référence pour retirer de la
// peau ce qui suit la lumière. null si aucun côté n'est dans l'image.
export function measureBackground(extractor, face) {
  const ctx = extractor.ctx, W = extractor.canvas.width, H = extractor.canvas.height;
  const d = face.scale, w = Math.round(0.8 * d), h = Math.round(1.2 * d);
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (const side of [-1, 1]) {
    const x0 = Math.round(face.nose.x + side * 2.2 * d - w / 2), y0 = Math.round(face.nose.y - 0.3 * d - h / 2);
    if (x0 < 0 || y0 < 0 || x0 + w > W || y0 + h > H || w < 2 || h < 2) continue;
    const px = ctx.getImageData(x0, y0, w, h).data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 250 || px[i + 1] > 250 || px[i + 2] > 250) continue;
      sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; n++;
    }
  }
  return n > 20 ? { r: sr / n, g: sg / n, b: sb / n } : null;
}

// Mesure d'une image. models : { face, hands?, pose? } (mains et corps seulement s'ils sont
// fournis). Renvoie { face, regions, m } (m null si pas assez de peau) ou null sans visage.
export function measureFrame(source, w, h, models, extractor) {
  const res = models.face.detectForVideo(source, nextTs());
  const lm = res.faceLandmarks?.[0];
  if (!lm) return null;
  return measureFace(source, w, h, lm, res.facialTransformationMatrixes?.[0] ?? null, models, extractor);
}

// Tous les visages d'une image (mode duel), triés de gauche à droite dans l'image.
export function detectFaces(source, model) {
  const res = model.detectForVideo(source, nextTs());
  const faces = (res.faceLandmarks ?? []).map((lm, i) => ({ lm, matrix: res.facialTransformationMatrixes?.[i] ?? null }));
  return faces.sort((a, b) => a.lm[1].x - b.lm[1].x);
}

// Mesure d'un visage déjà détecté (repères lm, matrice 3D optionnelle).
export function measureFace(source, w, h, lm, matrix, models, extractor) {
  const { w: ww, h: wh } = extractor.size(w, h);
  const face = faceRegions(lm, ww, wh, matrix);
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
  const m = extractor.measure(source, w, h, regions);
  const bg = measureBackground(extractor, face);
  if (!models.grid) return { face, regions, m, bg };
  // Grille détaillée : les cellules remplacent les 3 zones du visage ; les zones en option
  // (mains, corps) restent à la suite. Les zones du visage servent encore de référence de
  // couleur de peau pour écarter les zones habillées.
  const vals = models.grid.measure(source, w, h, lm);
  const N = models.grid.cells.length;
  const { cols, rows } = models.grid;
  // Mise en commun 3×3 : chaque cellule présente prend la moyenne des cellules présentes autour
  // d'elle. Sur vraies vidéos : ~3 fois plus de cellules portent le pouls, et en mouvement les
  // lectures fausses passent de 6 % à 2,5 % (tools/offline-score.mjs, configs pool1).
  const has = (n) => !Number.isNaN(vals[n * 3]);
  const cells = [];
  for (let n = 0; n < N; n++) {
    if (!has(n)) { cells.push(null); continue; }
    const r0 = (n / cols) | 0, c0 = n % cols;
    let sr = 0, sg = 0, sb = 0, k = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
      const m = r * cols + c;
      if (!has(m)) continue;
      sr += vals[m * 3]; sg += vals[m * 3 + 1]; sb += vals[m * 3 + 2]; k++;
    }
    cells.push({ r: sr / k, g: sg / k, b: sb / k, n: k });
  }
  const ok = cells.filter(Boolean);
  if (!ok.length) return { face, regions: models.grid.cellRegions(ww / w), m: null, bg };
  const avg = (c) => ok.reduce((a, z) => a + z[c], 0) / ok.length;
  const zones = [...cells, ...(m?.zones.slice(FACE_ZONES) ?? regions.slice(FACE_ZONES).map(() => null))];
  const cellRegs = models.grid.cellRegions(ww / w);
  return {
    face,
    bg,
    regions: [...cellRegs, ...regions.slice(FACE_ZONES)],
    m: { r: avg('r'), g: avg('g'), b: avg('b'), zones, faceZones: m?.zones.slice(0, FACE_ZONES) ?? null, raw: m?.raw ?? { r: avg('r'), g: avg('g'), b: avg('b') }, pixels: ok.length, kept: 1, clipped: m?.clipped ?? 0 },
  };
}
