'use strict';
/* ==========================================================================
   sw.js — Service worker: app-shell caching, offline fallback, background sync
   ==========================================================================
   NOTE for subfolder deployments (e.g. GitHub Pages project sites at
   https://user.github.io/cinemavault/): this file's scope is the folder it's
   served from. If you move it, double-check that scope still covers index.html.
   ========================================================================== */

const SHELL_CACHE = 'cinemavault-shell-v1';
const DATA_CACHE = 'cinemavault-data-v1';
const IMAGE_CACHE = 'cinemavault-images-v1';
const CURRENT_CACHES = [SHELL_CACHE, DATA_CACHE, IMAGE_CACHE];

// Precached on install. Everything here is small, same-origin, and required
// for the app shell to boot with zero network access.
const SHELL_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/player.js',
  './js/library.js',
  './js/storage.js',
  './js/pwa.js',
  './manifest.json',
  './movies.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const SHELL_PATHS = new Set(SHELL_ASSETS.map((p) => new URL(p, self.location.href).pathname));

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CinemaVault — Offline</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center; flex-direction:column;
         background:#0a0a0f; color:#f0f0f0; font-family:Inter,system-ui,sans-serif; text-align:center; padding:24px; }
  h1 { font-family:'Bebas Neue',sans-serif; letter-spacing:0.08em; color:#e50914; font-size:2.4rem; margin:0 0 8px; }
  p { color:#8a8a9a; max-width:380px; line-height:1.5; }
  button { margin-top:20px; background:#e50914; color:#fff; border:none; padding:12px 24px; border-radius:8px; font-size:0.95rem; cursor:pointer; }
</style></head>
<body>
  <h1>🎬 CinemaVault</h1>
  <p>You're offline and this page hasn't been saved yet. Reconnect to load it, or head back to your library — everything you've already opened still works.</p>
  <button onclick="location.href='./index.html'">Go to Library</button>
</body></html>`;

/* ---------------------------------------------------------------- */
/* Request classification                                            */
/* ---------------------------------------------------------------- */

function isSameOrigin(url) { return url.origin === self.location.origin; }

function isShellAsset(url) {
  if (!isSameOrigin(url)) return false;
  if (SHELL_PATHS.has(url.pathname)) return true;
  return /\.(html|css|js)$/i.test(url.pathname);
}

function isMoviesJson(url) {
  return isSameOrigin(url) && url.pathname.endsWith('/movies.json');
}

function isImageRequest(request, url) {
  if (request.destination === 'image') return true;
  return /\.(png|jpe?g|webp|gif|svg|ico)$/i.test(url.pathname);
}

// Video/stream sources are deliberately excluded from every cache: they're
// far too large for Cache Storage quotas, and the browser needs native
// Range-request support to seek, which the Cache API can't reliably provide.
function isVideoRequest(request, url) {
  if (request.destination === 'video' || request.destination === 'audio') return true;
  if (/\.(mp4|m3u8|ts|webm|mov|mkv)$/i.test(url.pathname)) return true;
  const streamingHosts = [
    'commondatastorage.googleapis.com', 'googlevideo.com',
    'youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'ytimg.com',
    'vimeo.com', 'player.vimeo.com', 'vimeocdn.com'
  ];
  return streamingHosts.some((h) => url.hostname === h || url.hostname.endsWith('.' + h));
}

/* ---------------------------------------------------------------- */
/* Caching strategies                                                 */
/* ---------------------------------------------------------------- */

// Cache-first: serve from cache instantly if present; otherwise hit the
// network and stash a copy for next time. Used for the app shell — these
// files change rarely and should load instantly even offline.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

// Network-first: always try for the freshest copy; fall back to whatever
// we cached last time if the network is unavailable. Used for movies.json
// so a freshly-edited library shows up immediately when online.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

// Stale-while-revalidate: serve the cached copy immediately for speed, while
// quietly fetching a fresh one in the background for next time. Used for
// poster/backdrop images, which are often slow, cross-origin, and rarely change.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => { if (response && response.ok) cache.put(request, response.clone()); return response; })
    .catch(() => null);
  if (cached) return cached;
  const fresh = await networkPromise;
  return fresh || new Response('', { status: 504, statusText: 'Offline and not cached' });
}

async function offlineFallback() {
  const shellCache = await caches.open(SHELL_CACHE);
  const shellHtml = await shellCache.match('./index.html');
  return shellHtml || new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html' } });
}

/* ---------------------------------------------------------------- */
/* Lifecycle                                                          */
/* ---------------------------------------------------------------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch((err) => console.warn('CinemaVault SW: pre-cache failed —', err))
  );
  // Intentionally NOT calling self.skipWaiting() here — we want the new
  // worker to sit in "waiting" until the user approves the update toast
  // (see pwa.js notifyUpdate / the message handler below).
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !CURRENT_CACHES.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') self.skipWaiting();
});

/* ---------------------------------------------------------------- */
/* Fetch routing                                                      */
/* ---------------------------------------------------------------- */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never intercept writes

  const url = new URL(request.url);

  if (isVideoRequest(request, url)) {
    return; // let the browser handle streaming/Range requests untouched
  }

  if (isMoviesJson(url)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  if (request.mode === 'navigate' || isShellAsset(url)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE).catch(() => offlineFallback()));
    return;
  }

  if (isImageRequest(request, url)) {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE));
    return;
  }

  // Anything uncategorized (analytics pings, fonts, etc.) — let the browser
  // fetch it normally without intervention.
});

/* ---------------------------------------------------------------- */
/* Background sync                                                    */
/* ---------------------------------------------------------------- */

self.addEventListener('sync', (event) => {
  if (event.tag === 'progress-sync') {
    event.waitUntil(flushPendingProgress());
  }
});

async function flushPendingProgress() {
  // Progress writes go straight to IndexedDB from the page, so there's no
  // server queue for the worker to flush. We just nudge any open tabs so they
  // can re-check their own pending state now that connectivity is back.
  const allClients = await self.clients.matchAll();
  allClients.forEach((client) => client.postMessage({ type: 'progress-sync' }));
}

/* ---------------------------------------------------------------- */
/* Push notifications (optional stub)                                 */
/* ---------------------------------------------------------------- */

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch (err) { payload = { title: 'CinemaVault', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'CinemaVault', {
      body: payload.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png'
    })
  );
});
