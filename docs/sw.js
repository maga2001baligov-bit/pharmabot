// PharmaBot service worker — makes the Mini App installable and usable offline.
// Bump CACHE_NAME on deploys where offline users must pick up new app-shell code;
// data files are refreshed opportunistically on every successful online fetch anyway.
const CACHE_NAME = "pharmabot-cache-v2";

const APP_SHELL = [
  "./",
  "index.html",
  "style.css?v=7",
  "js/app.js?v=13",
  "js/storage.js?v=13",
  "js/recipeMatch.js?v=13",
  "data/tests.json",
  "data/recipes.json",
  "data/theory.json",
  "manifest.json",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Only manage our own same-origin files — third-party CDN scripts (Telegram's
  // web app JS, Google Fonts) go straight to the network, untouched.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return networkResponse;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match("index.html"))
      )
  );
});
