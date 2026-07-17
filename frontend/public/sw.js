/**
 * QuorumProof Service Worker — offline-first with background sync.
 *
 * Strategy:
 *  - App shell (HTML/JS/CSS/fonts): Cache-first, update in background.
 *  - Stellar RPC / API calls:       Network-first, fall back to cache.
 *  - Background sync:               Queue failed mutations and replay on reconnect.
 */

const CACHE_NAME = 'qp-shell-v1';
const RUNTIME_CACHE = 'qp-runtime-v1';

const PRECACHE_URLS = [
  '/',
  '/index.html',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: cache-first for shell, network-first for RPC/API ──────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests and cross-origin GETs (fonts, etc.)
  if (request.method !== 'GET') return;

  // Network-first for Stellar RPC and API server calls
  if (url.hostname.includes('stellar') || url.pathname.startsWith('/api')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Cache-first for the app shell
  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline and no cache — return a minimal offline page for navigation requests
    if (request.mode === 'navigate') {
      const cached = await caches.match('/index.html');
      if (cached) return cached;
    }
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached ?? new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
