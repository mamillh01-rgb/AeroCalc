// AeroCalc service worker — lets the app open with no connection (e.g. in flight).
//
// What it caches:
//  • The app page itself (network-first: you always get the latest version when online,
//    the last saved copy when offline or when the network hangs for more than 4 s).
//  • The libraries it needs (React, Leaflet, Supabase) and the app icons (cache-first).
//  • Chart/map tiles you've already looked at (cache-first, capped), so the sectional
//    still shows for areas you viewed while online.
// What it never caches: weather, METAR/TAF, airspace, TFR and account data — showing an
// old forecast as if it were current would be worse than showing none.
//
// Bump VERSION when this file's caching rules change (app updates don't need it).
const VERSION = "aerocalc-sw-v1";
const SHELL = VERSION + "-shell";
const TILES = VERSION + "-tiles";
const MAX_TILES = 2500;

const LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
];
const LOCAL = ["./", "aerocalc-icon-180.jpg", "aerocalc-icon-192.jpg", "aerocalc-icon-512.jpg"];

const TILE_HOSTS = ["tiles.arcgis.com", "server.arcgisonline.com", "tile.openstreetmap.org"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // One at a time and tolerant of failures, so one bad URL can't block the install.
    for (const url of LOCAL) {
      try { const r = await fetch(url, { cache: "reload" }); if (r.ok) await cache.put(url, r); } catch (e) {}
    }
    for (const url of LIBS) {
      try { const r = await fetch(url, { mode: "cors" }); if (r.ok) await cache.put(url, r); } catch (e) {}
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Remove caches from older versions of this worker (and the old inline one)
    await Promise.all(keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function timeout(ms) { return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)); }

async function pageRequest(request) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await Promise.race([fetch(request), timeout(4000)]);
    if (fresh && fresh.ok) {
      cache.put("./", fresh.clone());
      return fresh;
    }
    throw new Error("bad response");
  } catch (e) {
    return (await cache.match("./")) || (await cache.match(request, { ignoreSearch: true })) ||
      new Response("<h1>AeroCalc is offline</h1><p>Open the app once with a connection so it can be saved for offline use.</p>",
        { headers: { "Content-Type": "text/html" } });
  }
}

async function cacheFirst(request, cacheName, trim) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  // Fetch with CORS where the server allows it: browsers charge a huge storage penalty
  // for cached "opaque" (no-CORS) responses, so those are passed through but not kept.
  let res;
  try { res = await fetch(request.url, { mode: "cors", credentials: "omit" }); }
  catch (e) { return fetch(request); }
  if (res && res.ok) {
    try { await cache.put(request.url, res.clone()); if (trim) trimTiles(cache); } catch (e) { /* storage full */ }
  }
  return res;
}

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) {
      // Oldest first (insertion order) — drop the oldest 20%
      await Promise.all(keys.slice(0, keys.length - Math.floor(MAX_TILES * 0.8)).map((k) => cache.delete(k)));
    }
  } finally { trimming = false; }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // The app page
  if (req.mode === "navigate" && url.origin === self.location.origin) {
    event.respondWith(pageRequest(req));
    return;
  }
  // Libraries and icons
  if (LIBS.includes(req.url) || (url.origin === self.location.origin && /aerocalc-icon-\d+\.jpg$/.test(url.pathname)) ||
      (url.hostname === "cdnjs.cloudflare.com" && url.pathname.includes("/leaflet/1.9.4/"))) {
    event.respondWith(cacheFirst(req, SHELL, false));
    return;
  }
  // Chart / base-map tiles already viewed
  if (TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h))) {
    event.respondWith(cacheFirst(req, TILES, true).catch(() => new Response("", { status: 504 })));
    return;
  }
  // Everything else (weather, airspace, accounts…) goes straight to the network.
});
