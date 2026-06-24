// BrightMind Teacher — Service Worker
//
// Intentionally minimal. This app is live-data-driven (AI responses, exam
// questions, student progress, daily limits all come from the server in
// real time), so this service worker does NOT cache pages or API calls.
// Aggressive caching here would risk showing students stale lesson content,
// outdated daily-limit counts, or old exam questions — worse than no
// offline support at all.
//
// Its only job is to satisfy the PWA installability requirement (a fetch
// handler must exist) so the app can be packaged via Trusted Web Activity
// for the Play Store, while always fetching fresh content from the network.

const CACHE_NAME = 'brightmind-shell-v1';

// Only the static app shell assets are safe to cache — never API responses.
const SHELL_ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_ASSETS).catch(() => {
        // Don't fail install if an asset is missing — installability matters more
        // than a perfect cache.
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for everything. Falls back to cache ONLY for the small
// shell assets above, and only if the network genuinely fails (e.g. brief
// offline moment) — never for HTML pages, API calls, or anything dynamic.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isShellAsset = SHELL_ASSETS.some((path) => url.pathname === path);

  if (!isShellAsset) {
    // Everything else (HTML, /api/*, etc.) — always go to network, never cache.
    return; // letting the browser handle it normally is equivalent to fetch passthrough
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
