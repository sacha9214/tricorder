# Tricorder

**Your heart rate from your webcam, computed entirely in your browser.** No video leaves the page.

**Try it: https://sacha9214.github.io/tricorder/**

Sit still in good light for about 10 seconds. The face turns into a heat map of where your pulse shows best. Turn on **Magnify pulse** to watch your face flush with each heartbeat.

> Experimental and educational. Not a medical device: don't use it to diagnose or monitor a health condition.

## How it works

Each heartbeat pushes a little more blood into the skin, which then absorbs slightly more green light. The change is 0.1–1 % of pixel brightness, invisible to the eye but measurable when you average many skin pixels. This is remote photoplethysmography (rPPG).

1. **Face tracking.** MediaPipe Face Landmarker (478 points). Optional: palms (hand landmarker), plus neck, forearms and feet (pose landmarker).
2. **Detailed face grid.** Each frame, the face is straightened (eyes level, fixed size) and cut into ~200 small cells. Cells outside the face outline or near the eyes, eyebrows or lips are dropped; typically 35–45 remain. Each cell is averaged with its neighbours (3×3), so many more cells carry a usable pulse.
3. **Motion correction.** The head's position, scale, tilt, turn, nod and mouth opening come from the face tracker. They are regressed out of the colors, but **only when the head really moves**: on a still person the head moves slightly with each heartbeat, and correcting anyway removes some pulse.
4. **Changing light.** The wall on each side of the head is measured too. When its light varies in the heart-rate band (a flickering lamp, a TV), that variation is removed from the skin colors. Your pulse doesn't show on the wall.
5. **POS** (Wang et al., 2017) per cell separates the pulse from lighting changes. A zero-phase band-pass keeps 42–180 bpm.
6. **Fusion with memory.** Cells are weighted by their signal-to-noise ratio at the frequency they agree on. The ratio is smoothed over time per cell, so the weighting follows the cells that carry the pulse instead of chasing noise.
7. **Quality gate.** Thresholds are calibrated on real people. Readings below the gate are hidden instead of shown, and readings during head movement are shown greyed as approximate.
8. **Tracking.** The rate is followed across windows, so a noise peak in one window doesn't make the number jump.
9. **Heat map and pulse magnification** (Wu et al., 2012). Every cell where the pulse shows is tinted green, more intense where the signal is cleaner. Magnification band-passes the color changes around the measured rate, smooths them, amplifies them and adds them back on the face.

## Tested on real people

Two datasets with a medical reference, about 14,000 twelve-second windows in total:
- **[MCD-rPPG](https://huggingface.co/datasets/kyegorov/mcd_rppg)** (CC-BY-4.0): 40 people, frontal webcam, 3 min at rest and 3 min after 15 squats, finger pulse sensor. The reference was computed two ways (frequency and beat counting), and only windows where both agree are scored.
- **[TU/e Hoffman & Lakens](https://data.4tu.nl/datasets/8c901757-d472-41ec-9f96-51425b719f1b)** (personal and research use only, not redistributed): 3 people labelled bright / intermediate / dark skin, several lighting levels, head movement and high heart rate, ECG reference.

*Shown* is the share of windows where a reading is displayed. *Wrong* is the share of displayed readings more than 5 bpm off.

### 40 people (MCD), cross-validated

Thresholds were chosen on half the people and measured on the other half, then swapped, so no person is used to both tune and judge.

| Method | Shown at ≤ 1 % wrong | Shown at ≤ 2 % wrong | Error when shown |
|---|---|---|---|
| 3 zones (forehead, cheeks) | 25 % | 35 % | 0.8–1.2 bpm |
| **Face grid + memory** | **51 %** | **60 %** | **0.8–1.1 bpm** |

With the page's settings, the grid shows a reading in 48 % of windows (0.9 % wrong), or 53 % with tracking. The 3-zone method shows 23 %. Results at rest and after exercise are similar.

### Skin tone, lighting and movement (TU/e)

| Group | Raw estimate within 3 bpm | Shown | Wrong |
|---|---|---|---|
| Bright skin, still, 7 lighting levels | 82 % | 83 % (3 zones: 68 %) | 1.9 % |
| Bright skin, high heart rate (171 → 100 bpm) | 81 % | 75 % (3 zones: 36 %) | 0 % |
| Bright skin, **moving** | 70 % | 44 % (3 zones: 22 %) | 6.3 % |
| Intermediate skin | 45 % | 2 % | 0 % |
| **Dark skin** | **9 %** | **1 %** | 7 of 8 |

**This method does not work reliably on darker skin.** It's one person per skin tone, so read this as a warning, not a statistic. The pulse signal is much weaker (melanin absorbs more light), the lighting was often dim, and the camcorder's compression adds noise. The tool mostly hides readings rather than showing wrong ones, but on the dark-skinned participant the few it showed were wrong. This is a known, documented limit of camera-based pulse measurement. Fixing it needs data from many more people with darker skin, and the datasets that have them require institutional agreements.

**Movement** is still hard. Correction raises correct estimates (38 % → 50 % on the raw signal), but the confidence score is less trustworthy while the head moves, so those readings are shown greyed.

### More working cells, motion, hard lighting

Each change below was kept only if it held up on the 40 MCD people and the TU/e recordings, including **degraded versions of the same videos**: 2.5× darker with sensor noise, very noisy, and a warm lamp flickering at 78 or 126 bpm.

| Change | Result |
|---|---|
| **3×3 neighbour pooling** | Cells carrying the pulse per window: 2.2 → 7.3 (MCD), 6.5 → 11.6 (moving). Moving: raw within 3 bpm 70 → 76 %, shown 44 → 52 %, wrong 6.2 → 2.5 %. No loss at rest. |
| **Dim + noisy light** (degraded MCD) | Face grid: 70 % raw, 23 % shown, 0.5 % wrong. The old 3 zones: 26 % raw, never shown. |
| **Background light reference**, applied only when the wall's light changes | Lamp flickering at 78 bpm: wrong readings 175 → 28. At 126 bpm: 87 → 1. Clean video: unchanged (95 % raw, 0 wrong). |

Rejected after testing: squared and speed motion terms on top of pooling (a wash), and 5×5 pooling (fewer readings).

The flickering-lamp test applies the same light to the face and to the wall, which flatters the background correction. A real lamp or TV lights them less uniformly.

### Breathing (experimental, not validated)

The page shows a breathing wave from small head movements and the slow swing of skin color. It shows a rate only when the rhythm is very clear. It couldn't be validated:
- MCD's clinical breathing rates (15–22/min, probably counted at another moment) and breathing derived from the finger sensor disagree with each other (correlation 0.10).
- The video estimate tracks neither.

Treat the rate as a curiosity. Breathe slowly and deeply to watch the wave follow.

### What real data overturned

Every one of these was measured, not guessed. Scripts are in `tools/`.

- **A detailed face grid beats a few big zones.** Many small skin cells, weighted by quality, find the pulse more often (84 % vs 77 % raw) and can be shown twice as often.
- **Memory per cell** made the quality score honest. Without it, the grid's wrong readings were 7 % at the old thresholds.
- **Quality thresholds** calibrated on simulated signals were far too lax on real video, so they were recalibrated on real people.
- **The half-frequency check** (against reading twice the rate) caused more errors than it caught on real video (−40 to −60 bpm). It's off by default.
- **Motion correction on a still person** removed part of the pulse, because the head moves slightly with every heartbeat. It now runs only when the head clearly moves.
- **Zone size, skin-filter tolerance, tracker memory:** all retuned on real data.
- **Ideas rejected on real data:**
  - a longer 20 s window for weak signals: +2–4 % readings only;
  - requiring many cells to agree: it depends on face size and cut MCD readings from 50 % to 7 %;
  - distrusting the head's movement frequency: the wrong readings weren't there.
- **Pitfalls found in the data, not the method:**
  - **Browser seeking:** a server without Range support makes seeks silently stay on frame 0. The frame reader now checks the position it actually reached.
  - **TU/e synchronization:** the ECG timeline is offset by about 6.5 s (one fixed value for the whole dataset, measured once).
  - **TU/e letterboxing:** the videos have black bars, so they are cropped before analysis.
  - **TU/e compression:** an artifact at exactly 30/12 = 2.5 Hz (2.4993 ± 0.007 Hz) is notched out for that dataset only. A live webcam doesn't have it.

## Simulated tests

Simulation was useful to build and unit-test each piece, but several conclusions did not survive real data (see above). `npm test` runs 33 tests:
- rates 45–175 bpm;
- timestamp jitter, light flicker, auto-exposure jumps and glare;
- zone fusion, skin filter, tracking and cell memory;
- motion correction (including a hand moving on its own) and the background-light correction;
- breathing rate on a synthetic head movement;
- rejection of clothed zones.

## Accuracy bench

`bench.html` runs your own recordings through five methods, from green-only to the full pipeline. It reports mean error, RMS error, share within 5 bpm, coverage and a Bland–Altman plot. Record with the **Record** button on the main page. It saves the raw camera video locally, with your reference heart rate in the file name (e.g. `…_72bpm.webm`).

Dataset evaluation (local only, data not included):

| Step | Tool |
|---|---|
| Fetch MCD subjects, prepare them | `tools/mcd_fetch.py` |
| Extract only the needed TU/e files from its 18 GB zip, by range requests | `tools/remote_zip.py` |
| Prepare TU/e | `tools/tue_prepare.py`, `tools/tue_reference.py` |
| Serve locally with Range support and save results | `tools/devserver.py` |
| Extract per-frame grid colors in the browser | `tools/batch-extract.js` |
| Score configurations offline | `tools/offline-score.mjs` |
| Calibrate thresholds by cross-validation across people | `tools/cv-score.mjs` |
| Check video/reference sync | `tools/lag-check.mjs` |

## Run locally

Run this from the project folder. `--bind 127.0.0.1` keeps it reachable from your computer only:

```bash
python3 -m http.server 8766 --bind 127.0.0.1
```

Then open http://localhost:8766. The camera needs `localhost` or HTTPS.

## Code

| File | Role |
|---|---|
| `js/dsp.js` | resampling, POS, filters, FFT, fusion with cell memory, motion regression and gate, quality, tracking |
| `js/grid.js` | detailed face grid (straightened face, skin cells) |
| `js/breath.js` | breathing wave and rate (experimental) |
| `js/extract.js`, `js/skin.js` | zones from landmarks (face, hands, body), skin pixel selection, head motion signals |
| `js/landmarker.js`, `js/frames.js` | MediaPipe models (CDN), frame-by-frame video reading |
| `js/magnify.js` | pulse magnification |
| `js/recorder.js`, `js/bench.js` | recording and accuracy bench |
| `js/synth.js`, `js/demo.js` | synthetic signals, moving head in colored light, demo face |

## Limits

- **Darker skin:** see above, not reliable.
- **Movement:** readings are approximate.
- **Dim or flickering light:** fewer readings.
- **Validation scope:** 40 people at rest and after exercise, plus 3 people on a second dataset. Not a clinical validation.

## License

MIT for the code. The datasets keep their own licenses and are not included.
