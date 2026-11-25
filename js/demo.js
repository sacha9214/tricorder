// Mode démo : un « visage » synthétique dessiné image par image, avec un pouls connu.
// Il passe par exactement la même chaîne que la caméra (lecture des pixels, filtre de peau,
// POS par zone, FFT), sauf la détection du visage : les zones sont fixes.
import { makeSynth, rng, gaussian } from './synth.js';

export class DemoFace {
  constructor(w = 320, h = 240) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(w, h);
    this.rand = rng(42);
    this.w = w;
    this.configure({ bpm: 72, flicker: false, hair: false });
    // Pixels du visage (ellipse), précalculés.
    const cx = w / 2, cy = h / 2, rx = 0.26 * w, ry = 0.44 * h;
    this.inside = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) this.inside.push((y * w + x) * 4);
    const d = 0.3 * w; // écart entre les yeux fictif
    this.regions = [
      { kind: 'rect', c: { x: cx, y: cy - 0.27 * h }, w: 0.7 * d, h: 0.13 * h, angle: 0 },
      { kind: 'ellipse', c: { x: cx - 0.33 * d, y: cy + 0.1 * h }, rx: 0.14 * d, ry: 0.16 * d, angle: 0 },
      { kind: 'ellipse', c: { x: cx + 0.33 * d, y: cy + 0.1 * h }, rx: 0.14 * d, ry: 0.16 * d, angle: 0 },
    ];
    // Contour du visage (pour l'amplification), légèrement resserré.
    this.hull = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2;
      return { x: cx + 0.92 * rx * Math.cos(a), y: cy + 0.92 * ry * Math.sin(a) };
    });
    // Zone où passent les mèches : le haut du front.
    const top = cy - 0.44 * h, bottom = cy - 0.16 * h;
    this.hairZone = this.inside.filter((i) => {
      const y = Math.floor(i / 4 / w);
      return y >= top && y <= bottom;
    });
    // Fond sombre, une fois pour toutes.
    const px = this.img.data;
    for (let i = 0; i < px.length; i += 4) { px[i] = 14; px[i + 1] = 16; px[i + 2] = 20; px[i + 3] = 255; }
  }

  configure({ bpm, flicker, hair }) {
    this.bpm = bpm;
    this.flicker = flicker;
    this.hair = hair;
    // Pouls plus marqué qu'en vrai (0,4 %) mais bruit par pixel réaliste.
    this.synth = makeSynth({ bpm, pulseAmp: 0.004, flicker: flicker ? 0.02 : 0, noise: 0, seed: 3 });
  }

  // Dessine l'image au temps t (s) et renvoie la fréquence vraie.
  render(t) {
    const s = this.synth(t);
    const px = this.img.data, rand = this.rand, w = this.w;
    for (const i of this.inside) {
      px[i] = s.r + 6 * gaussian(rand);
      px[i + 1] = s.g + 6 * gaussian(rand);
      px[i + 2] = s.b + 6 * gaussian(rand);
    }
    if (this.hair) {
      // Mèches sombres qui ondulent irrégulièrement sur le front.
      const sway = 2.2 * Math.sin(2 * Math.PI * 0.6 * t) + 1.3 * Math.sin(2 * Math.PI * 0.23 * t + 1);
      for (const i of this.hairZone) {
        const x = (i / 4) % w, y = Math.floor(i / 4 / w);
        if (Math.sin(0.42 * x + sway + 0.08 * y * Math.sin(0.7 * t)) > 0.1 - 0.012 * (60 - y)) {
          px[i] = 52 + 5 * gaussian(rand);
          px[i + 1] = 38 + 5 * gaussian(rand);
          px[i + 2] = 42 + 5 * gaussian(rand);
        }
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
    return s.truth;
  }
}
