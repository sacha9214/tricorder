// Extraction par lots dans le navigateur (servi par tools/devserver.py) : pour chaque vidéo du
// manifeste, lit toutes les images et enregistre dans recordings/out/<nom>.bin une ligne de
// Float32 par image : [t, visage trouvé, mouvement ×7, zones avec filtre de peau ×9,
// zones sans filtre ×9, cellules de la grille ×3N] ; et <nom>.json (description).
// Plusieurs onglets peuvent se partager le travail (part / parts).
import { Extractor, faceRegions } from '../js/extract.js';
import { loadLandmarker, faceLandmarkerClass, nextTs } from '../js/landmarker.js';
import { videoFrames } from '../js/frames.js';
import { FaceGrid, featureSets, GRID } from '../js/grid.js';

export const status = { current: null, progress: 0, done: [], errors: [] };

async function doneNames() {
  const html = await (await fetch('/recordings/out/', { cache: 'no-store' })).text().catch(() => '');
  return new Set([...html.matchAll(/href="([^"]+)\.json"/g)].map((m) => decodeURIComponent(m[1])));
}

export async function processVideo(item) {
  const face = await loadLandmarker();
  const grid = new FaceGrid(featureSets(await faceLandmarkerClass()));
  const ex = new Extractor();
  const v = Object.assign(document.createElement('video'), { muted: true, playsInline: true, src: '/' + item.mp4 });
  const N = grid.cells.length;
  const rowLen = 2 + 7 + 9 + 9 + 3 * N;
  const rows = [];
  for await (const { time, duration } of videoFrames(v, item.fps)) {
    const row = new Float32Array(rowLen).fill(NaN);
    row[0] = time;
    row[1] = 0;
    const lm = face.detectForVideo(v, nextTs()).faceLandmarks?.[0];
    if (lm) {
      row[1] = 1;
      const { w, h } = ex.size(v.videoWidth, v.videoHeight);
      const fr = faceRegions(lm, w, h);
      row.set(fr.motion, 2);
      const m = ex.measure(v, v.videoWidth, v.videoHeight, fr.regions);
      m?.zones.forEach((z, i) => {
        if (z) row.set([z.r, z.g, z.b], 9 + i * 3);
        if (z?.raw) row.set([z.raw.r, z.raw.g, z.raw.b], 18 + i * 3);
      });
      row.set(grid.measure(v, v.videoWidth, v.videoHeight, lm), 27);
    }
    rows.push(row);
    if (rows.length % 150 === 0) status.progress = time / duration;
  }
  const bin = new Float32Array(rows.length * rowLen);
  rows.forEach((r, i) => bin.set(r, i * rowLen));
  const header = { ...item, frames: rows.length, rowLen, grid: GRID, cells: grid.cells, cols: grid.cols, rows: grid.rows };
  await fetch(`/save?name=${encodeURIComponent(item.name)}.bin`, { method: 'POST', body: bin.buffer });
  await fetch(`/save?name=${encodeURIComponent(item.name)}.json`, { method: 'POST', body: JSON.stringify(header) });
}

// Traite le manifeste tant qu'il reste du travail ; attend les téléchargements en cours.
// reverse : prend la liste par la fin, pour qu'un onglet ajouté en cours de route ne refasse
// pas le travail des autres.
export async function runQueue({ manifest = '/recordings/mcd/manifest.json', part = 0, parts = 1, reverse = false } = {}) {
  for (;;) {
    const m = await (await fetch(manifest, { cache: 'no-store' })).json();
    const done = await doneNames();
    const todo = m.videos.filter((v, i) => i % parts === part && !done.has(v.name) && !status.errors.includes(v.name));
    if (!todo.length) {
      if (m.complete) return status;
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }
    const item = reverse ? todo[todo.length - 1] : todo[0];
    status.current = item.name;
    status.progress = 0;
    try {
      await processVideo(item);
      status.done.push(item.name);
    } catch (e) {
      console.error(item.name, e);
      status.errors.push(item.name);
    }
  }
}
