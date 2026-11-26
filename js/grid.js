// Grille détaillée du visage : chaque image, le visage est redressé dans un repère fixe
// (yeux à l'horizontale, écart des yeux = D pixels), puis découpé en cellules carrées.
// Une cellule ne compte que si son centre est dans le contour du visage et loin des yeux,
// sourcils et lèvres. On obtient la couleur moyenne de ~100 petits morceaux de peau, au lieu
// de 3 zones : de quoi trouver quelles parties du visage portent le mieux le pouls.

export const GRID = { D: 40, u0: -1.3, u1: 1.3, v0: -1.8, v1: 1.9, cell: 0.2 };

// Indices des repères des yeux, sourcils et lèvres (listes de connexions de MediaPipe).
export function featureSets(FaceLandmarker) {
  const idx = (conns) => [...new Set((conns ?? []).flatMap((c) => [c.start, c.end]))];
  return {
    eyes: [...idx(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE), ...idx(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE)],
    brows: [...idx(FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW), ...idx(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW)],
    lips: idx(FaceLandmarker.FACE_LANDMARKS_LIPS),
  };
}

function inPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function hull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

export class FaceGrid {
  constructor(features, grid = GRID) {
    this.g = grid;
    this.features = features;
    const { D, u0, u1, v0, v1, cell } = grid;
    this.W = Math.round((u1 - u0) * D);
    this.H = Math.round((v1 - v0) * D);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.ctx.imageSmoothingQuality = 'high';
    const cs = Math.round(cell * D);
    this.cols = Math.floor(this.W / cs); this.rows = Math.floor(this.H / cs);
    this.cs = cs;
    // Centre de chaque cellule, en unités d'écart des yeux (u vers la droite, v vers le menton).
    this.cells = [];
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        this.cells.push({ u: u0 + (c + 0.5) * cell, v: v0 + (r + 0.5) * cell });
    this.sums = new Float64Array(this.cells.length * 4);
  }

  // landmarks : repères normalisés [0,1]. Renvoie Float32Array(cellules × 3), NaN si la
  // cellule n'est pas utilisable sur cette image.
  measure(source, srcW, srcH, landmarks) {
    const { D, u0, v0, cell } = this.g;
    const p = (i) => ({ x: landmarks[i].x * srcW, y: landmarks[i].y * srcH });
    const a = p(33), b = p(263);
    const dSrc = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = { x: (b.x - a.x) / dSrc, y: (b.y - a.y) / dSrc };
    let uy = { x: -ux.y, y: ux.x };
    const chin = p(152), top = p(10);
    if ((chin.x - top.x) * uy.x + (chin.y - top.y) * uy.y < 0) uy = { x: -uy.x, y: -uy.y };
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const k = D / dSrc;
    this.last = { m, ux, uy, dSrc };
    // Repère redressé : x' = D·(u − u0), y' = D·(v − v0), avec u, v en écarts des yeux.
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.setTransform(k * ux.x, k * uy.x, k * ux.y, k * uy.y,
      -k * (ux.x * m.x + ux.y * m.y) - u0 * D, -k * (uy.x * m.x + uy.y * m.y) - v0 * D);
    ctx.drawImage(source, 0, 0, srcW, srcH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const px = ctx.getImageData(0, 0, this.W, this.H).data;

    // Repères dans le repère redressé (unités d'écart des yeux).
    const toUV = (q) => {
      const dx = q.x * srcW - m.x, dy = q.y * srcH - m.y;
      return { x: (dx * ux.x + dy * ux.y) / dSrc, y: (dx * uy.x + dy * uy.y) / dSrc };
    };
    const uv = landmarks.map(toUV);
    // Le maillage s'arrête au milieu du front : on prolonge le contour vers le haut (35 %)
    // pour couvrir le haut du front ; les cellules qui tombent sur les cheveux auront un
    // mauvais signal et peu de poids.
    const up = uv.filter((q) => q.y < -0.3).map((q) => ({ x: q.x, y: q.y * 1.35 }));
    const outline = hull([...uv, ...up]).map((q) => ({ x: q.x * 0.97, y: q.y * 0.97 }));
    const near = (c, list, r) => list.some((i) => (uv[i].x - c.u) ** 2 + (uv[i].y - c.v) ** 2 < r * r);
    const { eyes, brows, lips } = this.features;

    const sums = this.sums.fill(0);
    const cs = this.cs, cols = this.cols;
    for (let y = 0; y < this.rows * cs; y++) {
      const row = ((y / cs) | 0) * cols;
      for (let x = 0; x < cols * cs; x++) {
        const i = (y * this.W + x) * 4;
        if (px[i + 3] < 255) continue; // hors de l'image source
        const r = px[i], g = px[i + 1], bl = px[i + 2];
        if (r > 250 || g > 250 || bl > 250) continue;
        const j = (row + ((x / cs) | 0)) * 4;
        sums[j] += r; sums[j + 1] += g; sums[j + 2] += bl; sums[j + 3]++;
      }
    }
    const out = new Float32Array(this.cells.length * 3).fill(NaN);
    this.valid = new Uint8Array(this.cells.length);
    const minPx = 0.5 * cs * cs;
    this.cells.forEach((c, n) => {
      if (sums[n * 4 + 3] < minPx) return;
      if (!inPoly({ x: c.u, y: c.v }, outline)) return;
      if (near(c, eyes, 0.16) || near(c, brows, 0.12) || near(c, lips, 0.1)) return;
      this.valid[n] = 1;
      out[n * 3] = sums[n * 4] / sums[n * 4 + 3];
      out[n * 3 + 1] = sums[n * 4 + 1] / sums[n * 4 + 3];
      out[n * 3 + 2] = sums[n * 4 + 2] / sums[n * 4 + 3];
    });
    return out;
  }

  // Cellules de la dernière image, en rectangles orientés (coordonnées source × scale),
  // pour les dessiner par-dessus la vidéo. null pour une cellule non utilisée.
  cellRegions(scale = 1) {
    if (!this.last) return [];
    const { m, ux, uy, dSrc } = this.last;
    const size = this.g.cell * dSrc * scale;
    const angle = Math.atan2(ux.y, ux.x);
    return this.cells.map((c, n) => (this.valid?.[n]
      ? { kind: 'rect', c: { x: (m.x + dSrc * (c.u * ux.x + c.v * uy.x)) * scale, y: (m.y + dSrc * (c.u * ux.y + c.v * uy.y)) * scale }, w: size, h: size, angle }
      : null));
  }
}
