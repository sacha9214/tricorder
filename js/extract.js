// Zones de peau à partir des repères MediaPipe, et couleur moyenne de la peau dans chaque zone
// (pixels filtrés par SkinFilter). Zones du visage toujours ; mains et corps en option.
import { SkinFilter } from './skin.js';

export const WORK_W = 320; // largeur de travail : moyenne sur ~2 000 px, rapide à 30 i/s

// Emplacements fixes des zones : un indice = toujours la même partie du corps,
// pour que l'analyse puisse suivre chaque zone dans le temps.
export const ZONES = ['forehead', 'cheekL', 'cheekR', 'palmL', 'palmR', 'neck', 'forearmL', 'forearmR', 'footL', 'footR'];
export const FACE_ZONES = 3;

// Repères MediaPipe Face Mesh utilisés.
const L = { top: 10, chin: 152, eyeA: 33, eyeB: 263, browA: 105, browB: 334, cheekA: 50, cheekB: 280, nose: 1, lipTop: 13, lipBottom: 14 };

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = (a) => Math.hypot(a.x, a.y);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const lerp = (a, b, k) => add(a, mul(sub(b, a), k));

// landmarks : coordonnées normalisées [0,1] → zones en pixels de travail.
// motion : signaux de mouvement de la tête (pour la correction du mouvement), sans unité :
// [x, y, échelle, inclinaison, rotation gauche-droite, hochement, ouverture de la bouche].
export function faceRegions(landmarks, w, h) {
  const p = (i) => ({ x: landmarks[i].x * w, y: landmarks[i].y * h });
  const eyeA = p(L.eyeA), eyeB = p(L.eyeB);
  const d = len(sub(eyeB, eyeA)); // écart entre les yeux = échelle du visage
  const ux = mul(sub(eyeB, eyeA), 1 / d);
  let uy = { x: -ux.y, y: ux.x };
  // uy doit pointer du front vers le menton.
  if (dot(uy, sub(p(L.chin), p(L.top))) < 0) uy = mul(uy, -1);
  const angle = Math.atan2(ux.y, ux.x);

  const brow = mul(add(p(L.browA), p(L.browB)), 0.5);
  const up = sub(p(L.top), brow); // des sourcils vers le haut du front
  const forehead = { kind: 'rect', c: add(brow, mul(up, 0.5)), w: 0.8 * d, h: Math.max(4, 0.6 * Math.abs(dot(up, uy))), angle };
  const r = 0.16 * d;
  const cheekA = { kind: 'ellipse', c: p(L.cheekA), rx: r, ry: r * 1.15, angle };
  const cheekB = { kind: 'ellipse', c: p(L.cheekB), rx: r, ry: r * 1.15, angle };

  const nose = p(L.nose);
  const eyeMid = mul(add(eyeA, eyeB), 0.5);
  const motion = [
    nose.x / w,
    nose.y / h,
    d / w,
    angle,
    dot(sub(nose, eyeMid), ux) / d,
    dot(sub(nose, eyeMid), uy) / d,
    len(sub(p(L.lipTop), p(L.lipBottom))) / d,
  ];
  return { regions: [forehead, cheekA, cheekB], scale: d, nose, chin: p(L.chin), hull: faceHull(landmarks, w, h), motion };
}

// Contour du visage : enveloppe convexe des repères, resserrée de 8 % vers le centre
// (pour ne pas déborder sur les cheveux et le fond).
export function faceHull(landmarks, w, h, shrink = 0.92) {
  return shrinkPoly(convexHull(landmarks.map((q) => ({ x: q.x * w, y: q.y * h }))), shrink);
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function shrinkPoly(poly, k) {
  const c = poly.reduce((a, p) => ({ x: a.x + p.x / poly.length, y: a.y + p.y / poly.length }), { x: 0, y: 0 });
  return poly.map((p) => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }));
}

// Mouvement propre d'une zone qui bouge indépendamment de la tête (main, avant-bras, pied) :
// [x, y, taille, angle], pour la corriger avec son propre mouvement.
function partMotion(c, size, angle, w, h) {
  return [c.x / w, c.y / h, size / w, angle];
}

// Rectangle orienté le long d'un segment a → b (avant-bras, pied).
function segmentRect(a, b, from, to, widthK) {
  const v = sub(b, a), l = len(v);
  return { kind: 'rect', c: lerp(a, b, (from + to) / 2), w: (to - from) * l, h: widthK * l, angle: Math.atan2(v.y, v.x) };
}

// Paumes, depuis HandLandmarker : polygone poignet (0), base du pouce (1), bases des doigts
// (5, 9, 13, 17), resserré vers son centre. handedness : 'Left' | 'Right'.
export function handRegions(hands, handedness, w, h) {
  const out = {};
  // L'étiquette gauche/droite du modèle se trompe parfois (deux mains « Left ») : dans ce cas
  // on range par position dans l'image.
  const labels = handedness.map((hd) => hd?.[0]?.categoryName);
  const clash = hands.length === 2 && labels[0] === labels[1];
  const order = clash ? [...hands.keys()].sort((i, j) => hands[i][0].x - hands[j][0].x) : null;
  hands.forEach((lm, i) => {
    const p = (k) => ({ x: lm[k].x * w, y: lm[k].y * h });
    const poly = shrinkPoly([0, 1, 5, 9, 13, 17].map(p), 0.75);
    const wrist = p(0), mid = p(9);
    const side = clash ? (order[0] === i ? 'palmL' : 'palmR') : labels[i] === 'Left' ? 'palmL' : 'palmR';
    const c = poly.reduce((a, q) => ({ x: a.x + q.x / poly.length, y: a.y + q.y / poly.length }), { x: 0, y: 0 });
    out[side] = { kind: 'poly', pts: poly, m: partMotion(c, len(sub(mid, wrist)), Math.atan2(mid.y - wrist.y, mid.x - wrist.x), w, h) };
  });
  return out;
}

// Cou, avant-bras et pieds, depuis PoseLandmarker (33 repères). Une partie peu visible
// (visibilité < 0,5, souvent hors cadre) est ignorée. chin : menton du maillage du visage.
export function bodyRegions(pose, chin, w, h) {
  const out = {};
  const p = (k) => ({ x: pose[k].x * w, y: pose[k].y * h });
  const vis = (...ks) => ks.every((k) => (pose[k].visibility ?? 1) >= 0.5);
  if (chin && vis(11, 12)) {
    const sh = mul(add(p(11), p(12)), 0.5);
    const shoulders = len(sub(p(11), p(12)));
    const along = sub(sh, chin);
    const c = lerp(chin, sh, 0.4);
    out.neck = {
      kind: 'rect', c, w: 0.28 * shoulders, h: 0.45 * len(along),
      angle: Math.atan2(p(12).y - p(11).y, p(12).x - p(11).x),
    };
  }
  for (const [side, e, wr] of [['forearmL', 13, 15], ['forearmR', 14, 16]]) {
    if (!vis(e, wr)) continue;
    const reg = segmentRect(p(e), p(wr), 0.35, 0.85, 0.22);
    out[side] = { ...reg, m: partMotion(reg.c, len(sub(p(wr), p(e))), reg.angle, w, h) };
  }
  for (const [side, heel, toe] of [['footL', 29, 31], ['footR', 30, 32]]) {
    if (!vis(heel, toe)) continue;
    const reg = segmentRect(p(heel), p(toe), 0.15, 0.85, 0.4);
    out[side] = { ...reg, m: partMotion(reg.c, len(sub(p(toe), p(heel))), reg.angle, w, h) };
  }
  return out;
}

export function tracePath(ctx, reg, k = 1) {
  ctx.beginPath();
  if (reg.kind === 'poly') {
    reg.pts.forEach((q, i) => (i ? ctx.lineTo(q.x * k, q.y * k) : ctx.moveTo(q.x * k, q.y * k)));
    ctx.closePath();
    return;
  }
  ctx.save();
  ctx.translate(reg.c.x * k, reg.c.y * k);
  ctx.rotate(reg.angle);
  if (reg.kind === 'rect') ctx.rect((-reg.w / 2) * k, (-reg.h / 2) * k, reg.w * k, reg.h * k);
  else ctx.ellipse(0, 0, reg.rx * k, reg.ry * k, 0, 0, Math.PI * 2);
  ctx.restore();
}

function bounds(reg) {
  if (reg.kind === 'poly') {
    const xs = reg.pts.map((q) => q.x), ys = reg.pts.map((q) => q.y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const ext = reg.kind === 'rect' ? Math.hypot(reg.w, reg.h) / 2 : Math.max(reg.rx, reg.ry);
  return [reg.c.x - ext, reg.c.y - ext, reg.c.x + ext, reg.c.y + ext];
}

export class Extractor {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.mask = document.createElement('canvas');
    this.mctx = this.mask.getContext('2d', { willReadFrequently: true });
    this.filters = ZONES.map(() => new SkinFilter());
    this.buf = { r: new Float32Array(0), g: new Float32Array(0), b: new Float32Array(0) };
  }

  // Zones en option (mains, corps) dont la couleur n'est manifestement pas celle de la peau du
  // visage (manche, chaussette, chaussure) : écartées, elles n'ajouteraient que du bruit.
  // Tolérance large : une paume est souvent plus claire et plus rose que le visage,
  // surtout sur une peau foncée, et elle doit rester.
  dropNonSkin(zones, tolU = 0.06, tolV = 0.05) {
    const face = zones.slice(0, FACE_ZONES).filter(Boolean);
    if (!face.length) return;
    const chroma = (z) => { const s = z.r + z.g + z.b; return { u: z.r / s, v: z.g / s }; };
    const ref = face.map(chroma).reduce((a, c) => ({ u: a.u + c.u / face.length, v: a.v + c.v / face.length }), { u: 0, v: 0 });
    for (let i = FACE_ZONES; i < zones.length; i++) {
      if (!zones[i]) continue;
      const c = chroma(zones[i]);
      if (Math.abs(c.u - ref.u) > tolU || Math.abs(c.v - ref.v) > tolV) zones[i] = null;
    }
  }

  // Nouvelle source : on oublie la couleur de peau apprise.
  reset() {
    for (const f of this.filters) f.reset();
  }

  size(srcW, srcH) {
    const w = WORK_W, h = Math.round((WORK_W * srcH) / srcW);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = this.mask.width = w;
      this.canvas.height = this.mask.height = h;
    }
    return { w, h };
  }

  // regions : tableau indexé comme ZONES (null = zone absente sur cette image).
  // Renvoie la couleur moyenne de la peau par zone et globale, ou null si aucune zone utile.
  measure(source, srcW, srcH, regions) {
    const { w, h } = this.size(srcW, srcH);
    this.ctx.drawImage(source, 0, 0, w, h);
    const m = this.mctx;
    const zones = [];
    let sr = 0, sg = 0, sb = 0, n = 0, cand = 0, clipped = 0, inside = 0, rr = 0, rg = 0, rb = 0;
    regions.forEach((reg, z) => {
      if (!reg) { zones.push(null); return; }
      let [x0, y0, x1, y1] = bounds(reg);
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
      x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
      if (x1 - x0 < 2 || y1 - y0 < 2) { zones.push(null); return; }
      const bw = x1 - x0, bh = y1 - y0;
      m.clearRect(x0, y0, bw, bh);
      m.fillStyle = '#fff';
      tracePath(m, reg);
      m.fill();
      const px = this.ctx.getImageData(x0, y0, bw, bh).data;
      const mk = m.getImageData(x0, y0, bw, bh).data;
      if (this.buf.r.length < bw * bh) this.buf = { r: new Float32Array(bw * bh), g: new Float32Array(bw * bh), b: new Float32Array(bw * bh) };
      const { r: br, g: bg, b: bb } = this.buf;
      let k = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (mk[i + 3] < 128) continue;
        inside++;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        // Pixels saturés : pas d'information sur le pouls.
        if (r > 250 || g > 250 || b > 250) { clipped++; continue; }
        rr += r; rg += g; rb += b;
        br[k] = r; bg[k] = g; bb[k] = b; k++;
      }
      cand += k;
      const res = this.filters[z].apply(br, bg, bb, k);
      zones.push(res ? { r: res.r, g: res.g, b: res.b, n: res.n, ...(reg.m ? { m: reg.m } : {}) } : null);
      if (res) { sr += res.r * res.n; sg += res.g * res.n; sb += res.b * res.n; n += res.n; }
    });
    if (!n) return null;
    this.dropNonSkin(zones);
    ({ sr, sg, sb, n } = zones.reduce((a, z) => (z ? { sr: a.sr + z.r * z.n, sg: a.sg + z.g * z.n, sb: a.sb + z.b * z.n, n: a.n + z.n } : a), { sr: 0, sg: 0, sb: 0, n: 0 }));
    if (!n) return null;
    const rawN = inside - clipped;
    return {
      r: sr / n, g: sg / n, b: sb / n, zones,
      // Moyenne sans filtre de peau, toutes zones mélangées (méthode v0, pour comparer).
      raw: { r: rr / rawN, g: rg / rawN, b: rb / rawN },
      pixels: n,
      kept: cand ? n / cand : 0,
      clipped: inside ? clipped / inside : 0,
    };
  }
}
