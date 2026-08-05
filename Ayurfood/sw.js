const CACHE = 'ayurfood-v4';
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-72.png',
  '/icon-96.png',
  '/icon-128.png',
  '/icon-144.png',
  '/icon-152.png',
  '/icon-192.png',
  '/icon-384.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png'
];

// How long to wait for the network on a page load before falling back to the
// cached copy. Long enough for a slow mobile connection, short enough that an
// offline launch still feels instant.
const NET_TIMEOUT_MS = 3500;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Race the network against a timer. Whichever wins answers the request; a
// successful network response always refreshes the cache.
function networkFirst(request) {
  const fromCache = () => caches.match(request).then(r => r || caches.match('/index.html'));

  return new Promise(resolve => {
    let settled = false;
    const done = res => { if (!settled) { settled = true; resolve(res); } };

    const timer = setTimeout(() => { fromCache().then(c => { if (c) done(c); }); }, NET_TIMEOUT_MS);

    fetch(request)
      .then(res => {
        clearTimeout(timer);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
        }
        done(res);
      })
      .catch(() => {
        clearTimeout(timer);
        fromCache().then(c => done(c || Response.error()));
      });
  });
}

// Cache-first for immutable-ish assets, refreshed in the background.
function cacheFirst(request) {
  return caches.match(request).then(cached => {
    const network = fetch(request).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => cached);
    return cached || network;
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (url.hostname !== self.location.hostname) return;
  if (e.request.method !== 'GET') return;

  // Never cache backend calls — a cached checkout session or subscription
  // status is worse than no response at all.
  if (url.pathname.startsWith('/.netlify/')) return;

  // The HTML document is the one thing that must never be stale: it carries
  // the price IDs, the automatic-renewal disclosure, and the consent logic.
  const isDocument =
    e.request.mode === 'navigate' ||
    (e.request.headers.get('accept') || '').includes('text/html') ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html');

  if (isDocument) {
    e.respondWith(networkFirst(e.request));
    return;
  }

  // manifest.json changes with releases; icons effectively never do.
  if (url.pathname === '/manifest.json' || url.pathname === '/sw.js') {
    e.respondWith(networkFirst(e.request));
    return;
  }

  e.respondWith(cacheFirst(e.request));
});
