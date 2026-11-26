// Mesures d'une personne : tampon d'échantillons, suivi du rythme, mémoire des cellules,
// respiration, historique de la séance. Une instance par visage (deux en mode duel).
import { analyze, HrTracker, ZoneMemory, GRID_THRESHOLDS } from './dsp.js';
import { estimateBreathing } from './breath.js';
import { Extractor } from './extract.js';

const BUFFER_S = 15;      // historique pour le pouls
const BREATH_S = 40;      // historique pour la respiration
const GAP_RESET_S = 0.5;  // trou plus long → on repart de zéro

export class Person {
  constructor() {
    this.extractor = new Extractor();
    this.tracker = new HrTracker();
    this.zoneMemory = new ZoneMemory({ alpha: 0.1 });
    this.history = []; // { t (s depuis le début), bpm, quality, moving } — toute la séance
    this.t0 = null;
    this.reset();
  }

  // Nouveau départ du tampon (trou, visage perdu, changement de zones) ; l'historique reste.
  reset() {
    this.samples = [];
    this.breath = [];
    this.lastT = null;
    this.result = null;
    this.breathResult = null;
    this.pixels = 0;
    this.kept = 0;
    this.noFaceSince = null;
    this.tracker.reset();
    this.zoneMemory.reset();
  }

  // Nouvelle séance : on efface aussi l'historique.
  clear() {
    this.reset();
    this.history = [];
    this.t0 = null;
    this.extractor.reset();
  }

  push(time, m, motion = null, bg = null) {
    if (this.lastT !== null) {
      if (Math.abs(time - this.lastT) < 1e-6) return; // même image
      if (time < this.lastT || time - this.lastT > GAP_RESET_S) this.reset();
    }
    this.t0 ??= time;
    this.samples.push({ t: time, r: m.r, g: m.g, b: m.b, zones: m.zones, ...(motion ? { motion } : {}), ...(bg ? { bg } : {}) });
    this.breath.push({ t: time, r: m.r, g: m.g, b: m.b, ...(motion ? { motion } : {}) });
    this.lastT = time;
    this.pixels = m.pixels;
    this.kept = m.kept;
    while (this.samples.length && this.samples[0].t < time - BUFFER_S) this.samples.shift();
    while (this.breath.length && this.breath[0].t < time - BREATH_S) this.breath.shift();
  }

  // Analyse du tampon ; grid : true pour la grille du visage (réglages calibrés sur vraies vidéos).
  analyze({ grid = true } = {}) {
    const r = analyze(this.samples, grid
      ? { nfftZone: 1024, zoneWeights: this.zoneMemory.weigh, thresholds: GRID_THRESHOLDS, background: true }
      : {});
    this.result = r;
    if (r.ready) this.tracker.update(r);
    this.breathResult = estimateBreathing(this.breath);
    const v = this.value();
    if (r.ready && this.t0 !== null) this.history.push({ t: r.t - this.t0, bpm: v, quality: r.quality, moving: !!r.moving });
    return r;
  }

  // Valeur affichée (null si aucune mesure fiable récente).
  value() {
    return this.lastT !== null ? this.tracker.value(this.lastT) : null;
  }
}
