const SW_VERSION = "7cae4d5+ 2026-11-27 23:49Z";
const PRECACHE = [
  "assets/main-Bm__dG0q.js",
  "assets/main-DjitoQ0t.css",
  "assets/relayClient-D2hFuI3c.js",
  "assets/view-C93PcqK6.js",
  "assets/view-m6ZcacPm.css",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "index.html",
  "manifest.webmanifest",
  "view.html"
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
//
// Consistency (after deploy e4a9163 shipped an index.html that referred to a JS file of
// the previous build): a shell is usable only if every local file its index.html refers
// to is in the same cache.
//  - install: a version whose cached index.html refers to a file not in its cache is
//    refused (its cache is deleted; the current version stays in control);
//  - install: if the shell of the ACTIVE version is unusable, the app cannot be running
//    on it (its JavaScript never loaded), so the new version activates at once instead of
//    waiting for a launch that the broken page cannot perform, and reloads the open
//    windows. Which cache is active is recorded at activation (META); before that record
//    existed (versions up to e4a9163) the only other shell cache is taken as the active one.
//    Other leftover caches (e.g. of an interrupted install) never trigger this;
//  - navigation: an unusable cached shell is not served while the network is available.

const CACHE_PREFIX = 'whiteboard-shell-';
const CACHE = CACHE_PREFIX + SW_VERSION;
const INDEX_URL = new URL('index.html', self.registration.scope).href;
/** The page of viewers of a push presentation (step 9.3): next to the app, but not the app. */
const VIEWER_PATH = new URL('view.html', self.registration.scope).pathname;
// ignoreVary: servers answer with e.g. `Vary: Origin`; a module script (crossorigin,
// with an Origin header) would then never match the precached response, and the app
// would not start offline. The shell files do not depend on request headers.
const MATCH = { ignoreSearch: true, ignoreVary: true };
/** Cache with the name of the active version's shell cache (written at activation). */
const META = 'whiteboard-sw-meta';
const ACTIVE_KEY = new URL('__active-shell-cache', self.registration.scope).href;

/** Local URLs (in this scope) that index.html refers to with src="…" / href="…". */
function shellRefs(html) {
  const out = [];
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    let u;
    try {
      u = new URL(m[1], INDEX_URL);
    } catch {
      continue;
    }
    if (u.origin !== self.location.origin || !u.href.startsWith(self.registration.scope)) continue;
    u.hash = '';
    u.search = '';
    out.push(u.href);
  }
  return out;
}

/** URLs the shell in `cache` needs but does not have ([] = usable; index.html itself counts). */
async function missingInShell(cache) {
  const index = await cache.match(INDEX_URL, MATCH);
  if (!index) return [INDEX_URL];
  const missing = [];
  for (const url of shellRefs(await index.text())) if (!(await cache.match(url, MATCH))) missing.push(url);
  return missing;
}

/** Name of the shell cache of the version in control (null if unknown). */
async function activeShellCache(keys) {
  const recorded = await (await caches.open(META)).match(ACTIVE_KEY);
  if (recorded) return recorded.text();
  const others = keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE);
  return others.length === 1 ? others[0] : null;
}

/** Is the shell of the version in control (not this one) present but unusable? */
async function activeShellBroken() {
  const keys = await caches.keys();
  const name = await activeShellCache(keys);
  if (!name || name === CACHE || !keys.includes(name)) return false;
  return (await missingInShell(await caches.open(name))).length > 0;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        // cache: 'reload' — bypass the HTTP cache, so the shell is exactly this build.
        await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
        const missing = await missingInShell(cache);
        if (missing.length) throw new Error(`inconsistent shell ${SW_VERSION}: index.html refers to missing ${missing.join(', ')}`);
      } catch (e) {
        await caches.delete(CACHE);
        throw e; // install fails: the version in control stays
      }
      if (await activeShellBroken()) await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const heal = await activeShellBroken();
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
      await (await caches.open(META)).put(ACTIVE_KEY, new Response(CACHE));
      await self.clients.claim();
      if (!heal) return;
      // Windows stuck on the broken shell (the app never started there): reload them.
      // NOT awaited: the reload's own fetch waits for this activation to finish, so
      // waiting for navigate() here would deadlock.
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const w of windows) if (typeof w.navigate === 'function') w.navigate(w.url).catch(() => undefined);
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** The cached shell if it is usable; otherwise the network (and the cached one only as a last resort). */
async function shellResponse(req) {
  const cache = await caches.open(CACHE);
  const index = await cache.match(INDEX_URL, MATCH);
  if (index && (await missingInShell(cache)).length === 0) return index;
  try {
    return await fetch(req);
  } catch (e) {
    if (index) return index;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !req.url.startsWith(self.registration.scope)) return;
  if (req.mode === 'navigate') {
    // The page of viewers is not the app and needs the network anyway: it goes to the network as it is, never replaced by the shell.
    if (url.pathname === VIEWER_PATH) return;
    // Any page of the app opens the cached shell: works offline and on a cold start.
    event.respondWith(shellResponse(req));
    return;
  }
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(req, MATCH))
      .then((hit) => hit || fetch(req)),
  );
});
