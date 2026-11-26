// Historique de la séance : courbe du rythme cardiaque dans le temps, et export CSV.

export function drawHistory(canvas, history, { color = '#ff5f6d', other = null, otherColor = '#7aa2ff' } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const series = [history, other].filter(Boolean);
  const pts = series.flat().filter((p) => p.bpm !== null);
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = '#8794a1';
  if (pts.length < 2) { ctx.fillText('—', 8, H / 2); return; }
  const tMax = Math.max(30, ...pts.map((p) => p.t));
  const lo = Math.floor((Math.min(...pts.map((p) => p.bpm)) - 5) / 10) * 10;
  const hi = Math.ceil((Math.max(...pts.map((p) => p.bpm)) + 5) / 10) * 10;
  const L = 30, R = 6, T = 6, B = 18;
  const x = (t) => L + (t / tMax) * (W - L - R);
  const y = (b) => T + ((hi - b) / (hi - lo)) * (H - T - B);
  ctx.strokeStyle = '#1e252d'; ctx.lineWidth = 1; ctx.textAlign = 'right';
  for (let b = lo; b <= hi; b += 10) {
    ctx.beginPath(); ctx.moveTo(L, y(b)); ctx.lineTo(W - R, y(b)); ctx.stroke();
    ctx.fillText(String(b), L - 4, y(b) + 4);
  }
  ctx.textAlign = 'center';
  const step = tMax > 300 ? 120 : tMax > 120 ? 60 : 15;
  for (let s = 0; s <= tMax; s += step) ctx.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, x(s), H - 4);
  const line = (hist, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    let open = false;
    for (const p of hist) {
      if (p.bpm === null) { open = false; continue; }
      // Pointillé visuel : une lecture approximative (mouvement) est tracée plus pâle.
      if (!open) { ctx.moveTo(x(p.t), y(p.bpm)); open = true; } else ctx.lineTo(x(p.t), y(p.bpm));
    }
    ctx.stroke();
  };
  line(history, color);
  if (other) line(other, otherColor);
}

export function historyCsv(history, other = null) {
  const head = other ? 'seconds,bpm_left,quality_left,bpm_right,quality_right' : 'seconds,bpm,quality,moving';
  if (!other) return [head, ...history.map((p) => `${p.t.toFixed(1)},${p.bpm?.toFixed(1) ?? ''},${p.quality},${p.moving ? 1 : 0}`)].join('\n');
  const byT = new Map(other.map((p) => [p.t.toFixed(1), p]));
  return [head, ...history.map((p) => {
    const o = byT.get(p.t.toFixed(1));
    return `${p.t.toFixed(1)},${p.bpm?.toFixed(1) ?? ''},${p.quality},${o?.bpm?.toFixed(1) ?? ''},${o?.quality ?? ''}`;
  })].join('\n');
}

export function stats(history) {
  const v = history.map((p) => p.bpm).filter((b) => b !== null);
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return { min: s[0], max: s[s.length - 1], median: s[s.length >> 1], n: v.length };
}
