// Service worker minimal : rend le jeu installable et jouable hors-ligne.
const CACHE = 'ultimatum-v17';

// Pré-cache le noyau au moment de l'installation.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll([
        './',
        './index.html',
        './style.css',
        './main.js',
        './config.js',
        './constants.js',
        './helpers.js',
        './meta.js',
        './menu.js',
        './building.js',
        './codex.js',
        './resource.js',
        './game-tax.js',
        './game-workers.js',
        './game-shop.js',
        './game-bots.js',
        './game-customers.js',
        './game-production.js',
        './game-render.js',
        './game-cheats.js',
        './manifest.json',
        './icon-192.png',
        './icon-512.png'
      ]).catch(() => {}) // on n'échoue pas l'install si un fichier manque
    )
  );
  self.skipWaiting();
});

// Nettoie les anciens caches.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Réseau d'abord (en contournant le cache HTTP pour toujours avoir la vraie
// version à jour), repli sur le cache uniquement hors-ligne.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
