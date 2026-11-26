// Service worker : le tricorder fonctionne hors ligne après une première visite.
// Page et code : réseau d'abord (les mises à jour arrivent), copie en cache si hors ligne.
// Modèles et code MediaPipe (vendor/) : immuables, servis depuis le cache dès qu'ils y sont.
const CACHE = 'tricorder-v3';
const SHELL = [
  './', 'index.html', 'bench.html', 'manifest.webmanifest', 'css/style.css',
  'js/app.js', 'js/dsp.js', 'js/extract.js', 'js/skin.js', 'js/grid.js', 'js/frames.js', 'js/landmarker.js',
  'js/person.js', 'js/breath.js', 'js/finger.js', 'js/camera.js', 'js/delay.js', 'js/check.js', 'js/history.js',
  'js/magnify.js', 'js/recorder.js', 'js/demo.js', 'js/synth.js', 'js/i18n.js', 'js/bench.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } // copie AVANT que la page lise la réponse
      return res;
    })));
    return;
  }
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } // copie AVANT que la page lise la réponse
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
