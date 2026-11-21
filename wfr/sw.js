// Service worker: precaches the app shell so it opens with no signal, and serves
// map tiles cache-first (tiles downloaded ahead of time or seen while online).
const VERSION = 'wfr-v1.0.0';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/store.js', 'js/model.js', 'js/utm.js', 'js/voice.js', 'js/export.js', 'js/chart.js', 'js/map.js', 'js/ui.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
const TILE_CACHE = 'wfr-tiles-v1';
const TILE_HOSTS = /(^|\.)tile\.openstreetmap\.org$|(^|\.)tile\.opentopomap\.org$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k)),
  )).then(() => self.clients.claim()));
});

function isTile(url) {
  return TILE_HOSTS.test(url.hostname) || /\/\d+\/\d+\/\d+\.(png|jpg|jpeg|webp)(\?.*)?$/.test(url.pathname);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin && isTile(url)) {
    e.respondWith(caches.open(TILE_CACHE).then(async (cache) => {
      const hit = await cache.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req.url, res.clone());
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    }));
    return;
  }
  if (url.origin === location.origin) {
    // cache-first for the shell; navigation falls back to the cached index
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).catch(() => {
      if (req.mode === 'navigate') return caches.match('index.html');
      return new Response('', { status: 504 });
    })));
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('./'))));
});
