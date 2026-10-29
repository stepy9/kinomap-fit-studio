// Offline support: pages come from the network first, other files from the cache while it refreshes them.
const cacheName = "kinomap-fit-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(["./", "./favicon.svg", "./manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  const fetchAndStore = fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(cacheName).then((cache) => cache.put(request, copy));
    }
    return response;
  });
  if (request.mode === "navigate") {
    event.respondWith(fetchAndStore.catch(() => caches.match(request).then((cached) => cached ?? caches.match("./"))));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => {
    if (cached) {
      event.waitUntil(fetchAndStore.catch(() => {}));
      return cached;
    }
    return fetchAndStore;
  }));
});
