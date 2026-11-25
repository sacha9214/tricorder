# Tricorder

**Your heart rate from your webcam, computed entirely in your browser.** No video leaves the page.

**Try it: https://sacha9214.github.io/tricorder/**

Sit still in good light for about 10 seconds. Turn on **Magnify pulse** to watch your face flush with each heartbeat.

> Experimental and educational. Not a medical device: don't use it to diagnose or monitor a health condition.

## How it works

Each heartbeat pushes a little more blood into the skin, which then absorbs slightly more green light. The change is 0.1–1 % of pixel brightness, invisible to the eye but measurable when you average thousands of skin pixels. This is remote photoplethysmography (rPPG).

1. **Face tracking.** MediaPipe Face Landmarker (478 points) places zones on the forehead and both cheeks. Optional: palms (hand landmarker), plus neck, forearms and feet (pose landmarker).
2. **Skin pixels only.** In each zone, pixels far from the zone's own skin color (hair, eyebrows, glasses, glare) are dropped. Optional zones whose color is clearly not skin, such as a sleeve or a sock, are ignored.
3. **Motion correction.** The head's position, scale, tilt, turn, nod and mouth opening, all taken from the face tracker, are regressed out of each zone's color signals. Hands and limbs are corrected with their own motion.
4. **POS** (Wang et al., 2017) separates the pulse from lighting changes. A zero-phase band-pass keeps 42–180 bpm.
5. **Zone fusion.** Each zone is weighted by its signal-to-noise ratio, measured at the frequency the zones agree on.
6. **Peak, harmonic check, quality.** An FFT finds the peak and a half-frequency check catches doubled readings. The SNR sets a quality label, and unreliable readings are hidden instead of shown.
7. **Tracking.** The rate is followed across windows, so a noise peak in one window doesn't make the number jump.
8. **Pulse magnification** (Wu et al., 2012). Color changes are band-passed around the measured rate, smoothed spatially, amplified and added back on the face.

## Tested on real people

[MCD-rPPG](https://huggingface.co/datasets/kyegorov/mcd_rppg) (CC-BY-4.0) pairs face videos with a finger pulse sensor. Subject 1020 was tested with the frontal webcam, 3 minutes at rest and 3 minutes after 15 squats. Each 12 s window was compared with the reference heart rate. The reference was computed from the sensor two ways (frequency and beat counting), and only windows where both agree were scored: 301 and 273 windows.

| Method | Rest: shown / error / wrong | After squats: shown / error / wrong |
|---|---|---|
| Green only | 31 % / 2.1 bpm / 6 | 19 % / 3.5 bpm / 4 |
| POS, all pixels | 94 % / 0.6 / 0 | 72 % / 0.6 / 0 |
| **Full pipeline** | **100 % / 0.5 / 0** | **91 % / 0.7 / 1** |

*Shown* is the share of windows where a reading was displayed (the rest are flagged unreliable). *Wrong* counts readings more than 5 bpm off.

**Caveat:** the settings below were tuned on this subject, so these numbers are optimistic until other subjects confirm them.

Real data overturned several conclusions from simulation:
- **Zone size matters most.** The face is small in this video, and 1.5–2× bigger zones raised correct estimates from about 90 % to 98 %.
- **The tight skin filter lost readings** on compressed video (83 % → 40 % shown). A wider tolerance fixed it, and with big zones the filter now helps by dropping eyebrows and hair at the edges.
- **Motion correction on a still person hurt** (91 % → 85 % shown). The head moves slightly with every heartbeat (ballistocardiography), and face tracking jitters, so the regression removed some pulse. Correction now runs only when the head clearly moves. The gate sits between the largest movement measured on still people and the smallest in the moving simulations.
- **Tracking kept stale values too long.** Holding a value 5 s showed 3 % wrong readings; 2 s shows 1 %.
- **A silent bug:** with a server that doesn't support Range requests, browser seeks "succeed" without moving, so every frame analyzed was the first one. Frame reading now checks the position it actually reached.

## What each improvement buys (simulated)

Each one was kept only if it beat the previous method on a case built to break that method. The scripts in `tools/` reproduce the numbers.

| Improvement | Test case | Before | After |
|---|---|---|---|
| Half-frequency check | 2nd harmonic stronger than the fundamental | doubled values shown as reliable 26–33 / 40 | 1 / 40 |
| Zone fusion | forehead covered (very noisy) | 0 / 12 | 12 / 12 |
| Skin filter | moving hair over 5–75 % of a zone | 5.06 dB | 6.80 dB (ideal: 6.81) |
| Tracking | noisy 40 s signal | 154 / 512 correct readings shown | 255 / 512 |
| Motion correction | head moving in colored light: random, talking, turns, exercise (320 runs) | 130 correct, 38 wrong shown | 204 correct, 4 wrong shown |

On two test videos of a real face photo moved through colored light (irregular motion at 76 bpm, exercise bobbing at 120 bpm), the full pipeline averaged **0.2 bpm error with a reading 98 % of the time**, vs 73 % for plain POS. Real moving footage with a reference is still missing. The green-only method read 45 bpm on the exercise video.

Some ideas were measured and rejected:
- Weighting zones by SNR in dB was worse than plain mixing.
- Regressing motion out of the pulse after POS removed part of the pulse, even on a still face.
- Squared motion terms didn't help.
- Down-weighting motion frequencies in the spectrum added nothing.

POS alone already cancels a *single* distortion, such as one moving light. The extra steps matter when several act at once, which is the normal case.

## Accuracy bench

`bench.html` runs recordings through six methods, from green-only to the full pipeline. It reports mean error, RMS error, share within 5 bpm, coverage and a Bland–Altman plot. Recordings come from the **Record** button: it saves the raw camera video locally, with your reference heart rate in the file name, e.g. `…_72bpm.webm`.

To test it yourself, record with a reference (sports watch or finger pulse oximeter) and run the recordings through the bench.

Public datasets with a medical reference mostly require a signed academic agreement. MCD-rPPG needs none, but it has no head motion. Dataset evaluation tools:
- `tools/mcd-reference.mjs`, `tools/mcd-refcheck.mjs`: compute the reference per window.
- `tools/eval-browser.js`: runs the extraction in the browser and scores each method.

## Run locally

Run this from the project folder. `--bind 127.0.0.1` keeps it reachable from your computer only:

```bash
python3 -m http.server 8766 --bind 127.0.0.1
```

Then open http://localhost:8766. The camera needs `localhost` or HTTPS.

## Tests

```bash
npm test
```

28 tests cover:
- rates 45–175 bpm with no wrong value displayed;
- timestamp jitter, dropped frames, in-band light flicker, auto-exposure jumps, glare and pure noise;
- reliability of the quality label;
- one test per improvement above, and motion scenarios including a hand moving on its own;
- rejection of clothed zones.

## Code

| File | Role |
|---|---|
| `js/dsp.js` | resampling, POS, filters, FFT, harmonic check, zone fusion, motion regression, tracking |
| `js/skin.js` | per-zone skin pixel selection |
| `js/extract.js` | zones from landmarks (face, hands, body), per-zone skin color, head motion signals |
| `js/landmarker.js`, `js/frames.js` | MediaPipe models (CDN), frame-by-frame video reading |
| `js/magnify.js` | pulse magnification |
| `js/recorder.js`, `js/bench.js` | recording and accuracy bench |
| `js/synth.js`, `js/demo.js` | synthetic signals, moving head in colored light, demo face |

## Limits

- Accuracy drops with strong 3D head rotation, dim or flickering light, and darker skin tones (weaker signal), as for all rPPG.
- Optional zones only help with bare skin in view.
- The demo face can't be recorded for the bench: it isn't detected as a face.
- No breathing rate or HRV yet.

## License

MIT
