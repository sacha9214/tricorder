// Réglages de la caméra quand le navigateur les permet (Chrome, certaines webcams et téléphones) :
// lampe du téléphone, verrouillage de l'exposition et de la balance des blancs (l'exposition
// automatique crée de fausses variations de luminosité), et éclaircissement d'un visage sombre.
// Tout est facultatif : si une capacité manque, on continue sans.

const caps = (track) => (typeof track?.getCapabilities === 'function' ? track.getCapabilities() : {});
const settings = (track) => (typeof track?.getSettings === 'function' ? track.getSettings() : {});

export async function setTorch(track, on) {
  if (!caps(track).torch) return false;
  try { await track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch { return false; }
}

// Fige l'exposition et la balance des blancs à leurs valeurs actuelles (après quelques secondes
// d'automatique, pour qu'elles se soient réglées sur la scène). On ne passe en manuel que si la
// caméra donne la valeur actuelle : sur certains téléphones Android, « manuel » sans durée de pose
// prend la plus courte possible et l'image devient noire.
export async function lockExposure(track) {
  const c = caps(track), s = settings(track);
  const adv = {};
  if (c.exposureMode?.includes?.('manual') && s.exposureTime > 0) {
    adv.exposureMode = 'manual';
    adv.exposureTime = s.exposureTime;
  }
  if (c.whiteBalanceMode?.includes?.('manual') && s.colorTemperature > 0) {
    adv.whiteBalanceMode = 'manual';
    adv.colorTemperature = s.colorTemperature;
  }
  if (!Object.keys(adv).length) return 'unsupported';
  try { await track.applyConstraints({ advanced: [adv] }); return 'locked'; } catch { return 'failed'; }
}

// Revient à l'automatique (si le verrouillage a assombri l'image).
export async function unlockExposure(track) {
  const c = caps(track);
  const adv = {};
  if (c.exposureMode?.includes?.('continuous')) adv.exposureMode = 'continuous';
  if (c.whiteBalanceMode?.includes?.('continuous')) adv.whiteBalanceMode = 'continuous';
  if (!Object.keys(adv).length) return false;
  try { await track.applyConstraints({ advanced: [adv] }); return true; } catch { return false; }
}

// L'image s'est-elle effondrée après le verrouillage ? (luminosité moyenne 0–255 avant / après)
export function exposureCollapsed(before, after) {
  return after < 25 || after < 0.6 * before;
}

// Éclaircit l'image d'un cran (compensation d'exposition, sinon temps de pose ×1,5).
// Expérimental : un visage très sombre dans l'image donne un signal de pouls trop faible.
export async function brighten(track) {
  const c = caps(track), s = settings(track);
  try {
    if (c.exposureCompensation && Number.isFinite(s.exposureCompensation)) {
      const next = Math.min(c.exposureCompensation.max, s.exposureCompensation + (c.exposureCompensation.step || 0.33) * 3);
      if (next <= s.exposureCompensation) return false;
      await track.applyConstraints({ advanced: [{ exposureCompensation: next }] });
      return true;
    }
    if (c.exposureTime && s.exposureMode === 'manual' && s.exposureTime) {
      const next = Math.min(c.exposureTime.max, s.exposureTime * 1.5);
      if (next <= s.exposureTime) return false;
      await track.applyConstraints({ advanced: [{ exposureTime: next }] });
      return true;
    }
  } catch { /* réglage refusé */ }
  return false;
}
