const CACHE = "coseimpa-cosecoro-v58";
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
    // Con internet lento no se espera más de 4 segundos: se abre la copia
    // guardada y la versión nueva queda lista para la próxima vez. Solo se
    // guardan respuestas buenas (una página de error no reemplaza la copia).
    // (la página se guarda sin lo que va después de "?": así abrir la app desde
    // un aviso, con ?go=..., no deja una copia más por cada chat)
    const pageKey = url.origin + url.pathname;
    const saved = () => caches.match(pageKey).then((c) => c || caches.match(event.request, { ignoreSearch: true }))
      .then((c) => c || caches.match("index.html"));
    const net = fetch(event.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(pageKey, copy)).catch(() => {});
      }
      return res;
    });
    event.waitUntil(net.catch(() => {}));
    event.respondWith(new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
      const timer = setTimeout(() => { saved().then(finish); }, 4000);
      net.then((res) => { clearTimeout(timer); finish(res); })
        .catch(() => { clearTimeout(timer); saved().then((c) => { if (!done) { done = true; resolve(c || Response.error()); } }); });
    }));
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

// ---------- AVISOS CON LA APP CERRADA (notificaciones push) ----------
// El iMac manda cada aviso como texto JSON: { t: título, b: texto, tag, go }.
// "go" dice qué abrir al tocarlo: "chat:<id>", "avisos", "soporte", "compas"
// "flota" o "codigos". En Chrome/Edge, si la app está abierta y a la vista, no se
// muestra el aviso del teléfono (la app ya muestra el suyo dentro): solo se
// le pasa el mensaje. En iPhone (Safari) y Firefox se muestra siempre, porque
// Safari quita el permiso si llega un aviso que no se muestra.
// (En iPhone/iPad todos los navegadores son Safari por dentro, aunque digan
// "EdgiOS" o "CriOS": ahí siempre se muestra.)
const esChromium = () => {
  const ua = (self.navigator && self.navigator.userAgent) || "";
  return /Chrome|Chromium|Edg/.test(ua) && !/iPhone|iPad|iPod|EdgiOS|CriOS|FxiOS/.test(ua);
};
const texto = (v) => (v == null ? "" : String(v));

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try { data = event.data.json(); }
    catch (e) {
      try { data = { b: event.data.text() }; } catch (e2) { data = {}; }
    }
  }
  if (data === null || typeof data !== "object") data = { b: texto(data) };
  const title = texto(data.t) || "Cose Coro";
  const body = texto(data.b);
  const tag = texto(data.tag);
  const go = texto(data.go);
  const opts = {
    body: body,
    icon: "icon-192.png",
    renotify: !!tag,
    data: { go: go },
    lang: "es",
    timestamp: Date.now()
  };
  if (tag) opts.tag = tag;
  // Ventanas de la app que se están viendo ahora (solo cuenta en Chrome/Edge).
  const visibles = esChromium()
    ? self.clients.matchAll({ type: "window", includeUncontrolled: true })
        .then((list) => list.filter((c) => c.visibilityState === "visible"))
        .catch(() => [])
    : Promise.resolve([]);
  event.waitUntil(visibles.then((list) => {
    if (list.length) {
      list.forEach((c) => { try { c.postMessage({ type: "cc-push", t: title, b: body, go: go }); } catch (e) {} });
      return;
    }
    return self.registration.showNotification(title, opts);
  }));
});

// Al tocar el aviso: si la app ya está abierta se trae al frente y se le dice
// qué abrir; si no, se abre con ?go=... en la dirección.
self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const go = n.data && typeof n.data.go === "string" ? n.data.go : "";
  n.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const scope = (self.registration && self.registration.scope) || "";
      const win = list.find((c) => scope && (c.url || "").indexOf(scope) === 0) || list[0];
      if (win) {
        const avisar = (c) => { try { (c || win).postMessage({ type: "cc-go", go: go }); } catch (e) {} };
        return Promise.resolve()
          .then(() => win.focus())
          .then(avisar, () => avisar(win));
      }
      return self.clients.openWindow(go ? "./?go=" + encodeURIComponent(go) : "./");
    })
  );
});

// Si el navegador cambia la suscripción, se vuelve a suscribir con la misma
// clave. La dirección nueva la guarda la app la próxima vez que se abra.
self.addEventListener("pushsubscriptionchange", (event) => {
  if (event.newSubscription) return;
  const old = event.oldSubscription;
  const key = old && old.options && old.options.applicationServerKey;
  if (!key) return;
  event.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .catch(() => {})
  );
});
