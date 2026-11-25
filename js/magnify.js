// Amplification des variations de couleur (Wu et al., « Eulerian Video Magnification »,
// SIGGRAPH 2012) : l'image est moyennée par blocs de 8×8 pixels, chaque bloc est filtré
// dans le temps autour de la fréquence cardiaque, puis la variation est multipliée et
// rajoutée à l'image, uniquement sur le visage. Le visage « rougit » à chaque battement.

const BLOCK = 8;
const MAX_W = 640;
const CLAMP = 40; // variation ajoutée maximale, en niveaux (0–255)

// Flou binomial 3×3 en place sur une grille RVB (gw × gh × 3), pondéré par le masque.
function blur3(a, mask, gw, gh, tmp) {
  const n = a.length;
  if (tmp.buf?.length !== n) tmp.buf = new Float32Array(n);
  const out = tmp.buf;
  const K = [1, 2, 1];
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let sr = 0, sg = 0, sb = 0, ws = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= gh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= gw) continue;
          const p = yy * gw + xx;
          const w = K[dy + 1] * K[dx + 1] * (mask[p * 4 + 3] / 255 + 1e-3);
          sr += w * a[p * 3]; sg += w * a[p * 3 + 1]; sb += w * a[p * 3 + 2]; ws += w;
        }
      }
      const q = (y * gw + x) * 3;
      out[q] = sr / ws; out[q + 1] = sg / ws; out[q + 2] = sb / ws;
    }
  }
  a.set(out);
}

export class Magnifier {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.maskCanvas = document.createElement('canvas');
    this.mctx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    this.state = null;
    this.setBand(null, 30);
  }

  reset() { this.state = null; }

  // Passe-bande (RBJ, gain 0 dB au centre) : étroit autour du rythme mesuré s'il est connu,
  // large (≈ 45–125 bpm) sinon.
  setBand(f, fs) {
    const center = f ?? 1.4;
    const width = f ? 0.5 : 1.3;
    if (this.band && Math.abs(this.band.center - center) < 0.02 && Math.abs(this.band.fs - fs) < 0.5 && this.band.width === width) return;
    const w0 = (2 * Math.PI * center) / fs;
    const alpha = Math.sin(w0) / (2 * (center / width));
    const a0 = 1 + alpha;
    this.band = {
      center, fs, width,
      b0: alpha / a0, b2: -alpha / a0, a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha) / a0,
    };
  }

  // source : image ou vidéo ; hull : contour du visage en pixels de la source (ou null).
  // gain : facteur d'amplification. Renvoie le canevas de sortie.
  process(source, srcW, srcH, hull, gain) {
    const W = Math.min(MAX_W, Math.floor(srcW / BLOCK) * BLOCK);
    const H = Math.floor((W * srcH) / srcW / BLOCK) * BLOCK;
    const gw = W / BLOCK, gh = H / BLOCK;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W; this.canvas.height = H;
      this.maskCanvas.width = gw; this.maskCanvas.height = gh;
      this.state = null;
    }
    const ctx = this.ctx;
    ctx.drawImage(source, 0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H);
    const px = img.data;

    // Moyenne par bloc.
    const nb = gw * gh * 3;
    const blocks = this.blocks?.length === nb ? this.blocks.fill(0) : (this.blocks = new Float32Array(nb));
    for (let y = 0; y < H; y++) {
      const row = ((y / BLOCK) | 0) * gw;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, j = (row + ((x / BLOCK) | 0)) * 3;
        blocks[j] += px[i]; blocks[j + 1] += px[i + 1]; blocks[j + 2] += px[i + 2];
      }
    }
    const inv = 1 / (BLOCK * BLOCK);
    for (let j = 0; j < nb; j++) blocks[j] *= inv;

    // Filtre temporel par bloc et par canal : état [x1, x2, y1, y2].
    if (!this.state) {
      this.state = new Float32Array(nb * 4);
      for (let j = 0; j < nb; j++) { this.state[j * 4] = blocks[j]; this.state[j * 4 + 1] = blocks[j]; }
    }
    const { b0, b2, a1, a2 } = this.band;
    const st = this.state;
    const amp = this.amp?.length === nb ? this.amp : (this.amp = new Float32Array(nb));

    // Masque doux du visage, à la résolution des blocs.
    const m = this.mctx;
    m.clearRect(0, 0, gw, gh);
    if (hull?.length > 2) {
      const k = gw / srcW;
      m.fillStyle = '#fff';
      m.beginPath();
      hull.forEach((p, i) => (i ? m.lineTo(p.x * k, p.y * k) : m.moveTo(p.x * k, p.y * k)));
      m.closePath();
      m.fill();
    }
    const mask = m.getImageData(0, 0, gw, gh).data;

    const band = this.bandBuf?.length === nb ? this.bandBuf : (this.bandBuf = new Float32Array(nb));
    for (let j = 0; j < nb; j++) {
      const s = j * 4, x = blocks[j];
      const y = b0 * x + b2 * st[s + 1] - a1 * st[s + 2] - a2 * st[s + 3];
      st[s + 1] = st[s]; st[s] = x; st[s + 3] = st[s + 2]; st[s + 2] = y;
      band[j] = y;
    }
    // Lissage spatial (2 passes de flou binomial 3×3) : le pouls est le même sur toute la
    // joue, le bruit varie d'un bloc à l'autre. Sans ce lissage, le bruit amplifié fait des taches.
    // Moyenne pondérée par le masque, pour que le fond ne déteigne pas sur le visage.
    for (let pass = 0; pass < 2; pass++) blur3(band, mask, gw, gh, this.tmp ??= {});
    for (let j = 0; j < nb; j++) {
      const w = mask[((j / 3) | 0) * 4 + 3] / 255;
      amp[j] = Math.max(-CLAMP, Math.min(CLAMP, gain * band[j])) * w;
    }

    // Ajout à l'image, avec interpolation bilinéaire entre centres de blocs.
    for (let y = 0; y < H; y++) {
      const gy = Math.min(gh - 1, Math.max(0, (y + 0.5) / BLOCK - 0.5));
      const y0 = Math.min(gh - 2, gy | 0), fy = gh > 1 ? gy - y0 : 0;
      for (let x = 0; x < W; x++) {
        const gx = Math.min(gw - 1, Math.max(0, (x + 0.5) / BLOCK - 0.5));
        const x0 = Math.min(gw - 2, gx | 0), fx = gw > 1 ? gx - x0 : 0;
        const j00 = (y0 * gw + x0) * 3, j01 = j00 + 3, j10 = j00 + gw * 3, j11 = j10 + 3;
        const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          px[i + c] += w00 * amp[j00 + c] + w01 * amp[j01 + c] + w10 * amp[j10 + c] + w11 * amp[j11 + c];
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return this.canvas;
  }
}
