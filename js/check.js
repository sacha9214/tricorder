// Vérification par soi-même : on garde les doigts sur son pouls (poignet ou cou) et on appuie
// sur une touche à chaque battement ressenti. Le rythme tapé sert de référence à comparer avec
// la mesure de la caméra, sans aucun appareil.

// Rythme à partir des instants d'appui (secondes) : médiane des intervalles, après avoir écarté
// les doubles appuis (< 0,3 s) et les battements oubliés (intervalle > 1,6 × la médiane).
export function tappedBpm(times) {
  if (times.length < 5) return null;
  const iv = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d >= 0.3) iv.push(d);
  }
  if (iv.length < 4) return null;
  const med = [...iv].sort((a, b) => a - b)[iv.length >> 1];
  const ok = iv.filter((d) => d < 1.6 * med && d > 0.6 * med);
  if (ok.length < 4) return null;
  const mean = ok.reduce((a, b) => a + b, 0) / ok.length;
  // Régularité : écart-type relatif des intervalles gardés (un tapotement très irrégulier
  // donne une référence peu fiable).
  const sd = Math.sqrt(ok.reduce((a, d) => a + (d - mean) ** 2, 0) / ok.length);
  return { bpm: 60 / mean, beats: ok.length + 1, regularity: sd / mean };
}

// Résultats gardés dans ce navigateur seulement (localStorage), exportables en CSV.
const KEY = 'tricorder.checks';

export function loadChecks() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

export function saveCheck(entry) {
  const all = loadChecks();
  all.push(entry);
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* stockage indisponible */ }
  return all;
}

export function clearChecks() {
  try { localStorage.removeItem(KEY); } catch { /* stockage indisponible */ }
}

export function checksCsv(all) {
  const head = 'date,tapped_bpm,camera_bpm,difference,quality,cells_working,moving,light_changing,skin_r,skin_g,skin_b';
  const rows = all.map((c) => [c.date, c.tapped.toFixed(1), c.camera?.toFixed(1) ?? '', c.camera ? (c.camera - c.tapped).toFixed(1) : '',
    c.quality ?? '', c.working ?? '', c.moving ? 1 : 0, c.light ? 1 : 0, ...(c.skin ?? ['', '', '']).map((v) => (typeof v === 'number' ? v.toFixed(0) : v))].join(','));
  return [head, ...rows].join('\n');
}

export function checkSummary(all) {
  const paired = all.filter((c) => Number.isFinite(c.camera));
  if (!paired.length) return null;
  const err = paired.map((c) => Math.abs(c.camera - c.tapped));
  return { n: paired.length, mae: err.reduce((a, b) => a + b, 0) / err.length, within5: err.filter((e) => e <= 5).length / err.length };
}
