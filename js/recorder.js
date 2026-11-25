// Enregistrement d'une source vidéo en local (rien n'est envoyé) pour la rejouer plus tard
// et mesurer la précision. Débit élevé : la compression vidéo efface facilement des variations
// de couleur de 0,1 %.
export const MAX_SECONDS = 60;

export class Recorder {
  constructor() { this.rec = null; }

  get active() { return !!this.rec; }
  get seconds() { return this.rec ? (performance.now() - this.t0) / 1000 : 0; }

  start(stream) {
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    this.mime = types.find((t) => window.MediaRecorder?.isTypeSupported(t));
    if (!this.mime) throw new Error('MediaRecorder unavailable');
    this.chunks = [];
    this.rec = new MediaRecorder(stream, { mimeType: this.mime, videoBitsPerSecond: 8_000_000 });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.done = new Promise((resolve) => {
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.mime.split(';')[0] }));
    });
    this.rec.start(1000);
    this.t0 = performance.now();
  }

  async stop() {
    if (!this.rec) return null;
    const rec = this.rec;
    this.rec = null;
    if (rec.state !== 'inactive') rec.stop();
    return this.done;
  }

  extension() {
    return this.mime?.includes('mp4') ? 'mp4' : 'webm';
  }
}

// Nom de fichier avec la date et, si connue, la fréquence de référence (lue par le banc d'essai).
export function recordingName(ext, refBpm) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const ref = Number.isFinite(refBpm) && refBpm > 0 ? `_${Math.round(refBpm)}bpm` : '';
  return `tricorder-${stamp}${ref}.${ext}`;
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
