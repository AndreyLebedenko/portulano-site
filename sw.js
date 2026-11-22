const SW_VERSION = "7bc623c+ 2026-11-22 13:16Z";
const PRECACHE = [
  "assets/index-BrWRV5CI.css",
  "assets/index-DY-V3pgs.js",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "index.html",
  "manifest.webmanifest"
];

// Service Worker of the app shell (Р-4.4, М-20). Plain script, not bundled: the build
// (build/pwaBuild.mjs) prepends
//   const SW_VERSION = '<build version>';
//   const PRECACHE = [<every file of the build but sw.js, relative to this script>];
// and writes the result to <outDir>/sw.js.
//
// Update policy: a new version installs and WAITS (no skipWaiting on install). It is
// activated by the browser when no page uses the old one, or at the next launch of
// the app, which posts {type: 'SKIP_WAITING'} before the app starts (src/app/swClient.ts).
// After activation the caches of older versions are deleted. User data (IndexedDB) is
// never touched here.

const CACHE_PREFIX = 'whiteboard-shell-';
const CACHE = CACHE_PREFIX + SW_VERSION;
const INDEX_URL = new URL('index.html', self.registration.scope).href;
// ignoreVary: servers answer with e.g. `Vary: Origin`; a module script (crossorigin,
// with an Origin header) would then never match the precached response, and the app
// would not start offline. The shell files do not depend on request headers.
const MATCH = { ignoreSearch: true, ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // cache: 'reload' — bypass the HTTP cache, so the shell is exactly this build.
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !req.url.startsWith(self.registration.scope)) return;
  if (req.mode === 'navigate') {
    // Any page of the app opens the cached shell: works offline and on a cold start.
    event.respondWith(
      caches
        .open(CACHE)
        .then((cache) => cache.match(INDEX_URL, MATCH))
        .then((hit) => hit || fetch(req)),
    );
    return;
  }
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(req, MATCH))
      .then((hit) => hit || fetch(req)),
  );
});
