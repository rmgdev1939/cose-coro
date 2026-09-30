const CACHE = "coseimpa-cosecoro-v38";
const ASSETS = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// La página (HTML) se pide primero a la red para que las versiones nuevas
// lleguen solas; sin internet se usa la copia guardada. El resto, caché primero.
// Solo se guardan archivos de la app y librerías fijas (Firebase, fuentes).
// Las consultas en vivo (tasa BCV, Firebase Auth/Firestore) van siempre a la
// red: si se guardaran, la tasa quedaría vieja y la nube dejaría de actualizar.
const STATIC_HOSTS = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin && STATIC_HOSTS.indexOf(url.hostname) === -1) return;
  const isPage = event.request.mode === "navigate" ||
    (event.request.headers.get("accept") || "").includes("text/html");
  if (isPage) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(event.request).then((c) => c || caches.match("index.html")))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => cached);
    })
  );
});
