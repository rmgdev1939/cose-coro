// Avisos con la app cerrada (notificaciones push) de Cose Coro.
//
// Mira la base de datos (chats, avisos, soporte, solicitudes de compañero y
// revisiones de la flota) y manda un aviso al teléfono de cada persona que lo
// activó en Ajustes → «Avisos con la app cerrada», aunque la app esté cerrada.
// Es gratis y no usa cuentas nuevas: el aviso lo entrega el servicio de avisos
// del propio teléfono o navegador (Google, Apple, Mozilla o Microsoft), firmado
// con unas llaves propias (VAPID) que se crean la primera vez en este equipo.
//
// Corre todo el tiempo en el iMac de Rafael (launchd: com.cosecoro.avisos.plist,
// se instala con instalar.sh) con la sesión del Firebase CLI de esa computadora
// (`firebase login`), igual que tools/monitor.cjs. Esa sesión es la del dueño y
// NO pasa por las reglas de seguridad: por eso aquí se revisa con cuidado a
// quién se le manda cada cosa (solo personas aprobadas, nunca a quien lo
// escribió, y los mensajes de un chat solo a los miembros de ese chat).
//
// En el registro (log) nunca se escriben textos de mensajes, correos ni
// llaves: solo tipos, cantidades e ids.
//
// También se puede usar como módulo (las pruebas: tests/avisos.test.mjs):
// start({ db, send, dataDir, now, log }) → { ready, stop(), publicKey }.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { Firestore, Timestamp, FieldValue } = require("@google-cloud/firestore");
const webpush = require("web-push");

const PROJECT = "cosecoro-coro";
// Cliente OAuth público del Firebase CLI (el mismo que usa firebase-tools y tools/monitor.cjs).
const CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";
const SUBJECT = "https://cosecoro.web.app"; // contacto que piden los servicios de avisos

const CATCHUP = 10 * 60e3;   // al arrancar se pone al día, como mucho, con los últimos 10 minutos
const OVERLAP = 60e3;        // margen sobre la última vez que estuvo vivo (lo repetido se descarta)
const SAVE_EVERY = 30e3;     // guarda su estado cada 30 segundos (y al parar)
const KEEP_SENT = 2000;      // recuerda lo último que mandó, para no repetirlo
const MAX_DEVICES = 5;       // equipos por persona (los más recientes)
const PAGE = 20;             // mensajes por consulta
const TTL = 43200;           // 12 horas: si el teléfono pasa más tiempo apagado, el aviso se pierde
const SEND_TIMEOUT = 15000;
const REINTENTO = 15000;     // espera antes de reintentar un envío que falló por un momento
const SALUD_CADA = 15 * 60e3; // cada cuánto prueba que la conexión con Firebase sigue bien
const SALUD_FALLAS = 3;      // fallas seguidas para reiniciar

// Servicios de avisos permitidos. El iMac está en la red de la tienda: nunca
// se le manda nada a otra dirección (por ejemplo, un equipo de la red interna).
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
const TIPO_REP = { fallo: "falla", sugerencia: "sugerencia", pregunta: "pregunta" };

// ---------------------------------------------------------------- utilidades
function logConsola(){
  const a = Array.prototype.slice.call(arguments);
  console.log.apply(console, [new Date().toISOString()].concat(a));
}
// Error en pocas palabras (sin datos de nadie: solo código y primera línea)
function resumenError(e){
  if (!e) return "desconocido";
  const code = e.statusCode || e.code;
  const msg = String(e.message || e).split("\n")[0].slice(0, 160);
  const pre = code !== undefined && msg.indexOf(String(code)) !== 0 ? code + " " : "";
  const pista = /invalid_grant|UNAUTHENTICATED|invalid_rapt/.test(msg)
    ? " (la sesión de Firebase de este equipo venció o se cerró: corre «npx firebase-tools login»)" : "";
  return pre + msg + pista;
}
function esperar(ms){ return new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }); }
function tsMs(v){ return v && typeof v.toMillis === "function" ? v.toMillis() : 0; }
function esTs(v){ return !!(v && typeof v.toMillis === "function" && typeof v.seconds === "number"); }
// Compara dos horas de Firestore con toda su precisión (null = la más vieja)
function cmpTs(a, b){
  if (!esTs(a)) return esTs(b) ? -1 : 0;
  if (!esTs(b)) return 1;
  return (a.seconds - b.seconds) || (a.nanoseconds - b.nanoseconds);
}
// Recorta a n letras (contando emojis como una) y termina en "…"
function corto(s, n){
  const c = Array.from(String(s == null ? "" : s).replace(/\s+/g, " ").trim());
  if (c.length <= n) return c.join("");
  return c.slice(0, n - 1).join("").replace(/\s+$/, "") + "…";
}

// ¿Es la dirección de un servicio de avisos permitido? Solo https, sin
// usuario, sin puerto y con una forma estricta, para que web-push (que la lee
// con url.parse) y esta revisión (con URL) entiendan el mismo equipo.
function pushHostOk(endpoint){
  if (typeof endpoint !== "string" || endpoint.length > 800) return false;
  const m = /^https:\/\/([A-Za-z0-9.-]+)(\/[!-~]*)?$/.exec(endpoint);
  if (!m || /[\\@]/.test(endpoint)) return false;
  const host = m[1].toLowerCase();
  const permitido = PUSH_HOSTS.indexOf(host) >= 0 || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/.test(host);
  if (!permitido) return false;
  let u;
  try { u = new URL(endpoint); } catch (e) { return false; }
  return u.protocol === "https:" && u.hostname === host && u.port === "" && !u.username && !u.password;
}

// Tema para el servicio de avisos: si el teléfono está apagado, de varios
// avisos con el mismo tema solo le llega el último (máx. 32 letras base64url).
function tema(tag){ return tag ? crypto.createHash("sha256").update(String(tag)).digest("base64url").slice(0, 32) : undefined; }

// ------------------------------------------------------ textos de los avisos
// Lo que recibe el service worker (public/sw.js): { t, b, tag, go }
function carga(t, b, tag, go){
  const p = { t: corto(t, 80), b: corto(b, 160) };
  if (tag) p.tag = String(tag).slice(0, 64);
  if (go) p.go = String(go);
  return p;
}
function avisoChat(chatId, chat, m){
  const de = m.fromName || "Alguien";
  if (chat && chat.type === "grupo") return carga(chat.name || "Grupo", de + ": " + (m.text || ""), "chat-" + chatId, "chat:" + chatId);
  return carga(de, m.text || "", "chat-" + chatId, "chat:" + chatId);
}
function avisoAviso(id, a){
  return carga((a.tipo === "sistema" ? "🔔 " : "✨ ") + (a.titulo || ""), a.texto || "", "aviso-" + id, "avisos");
}
function avisoReporte(id, r){
  return carga("Nuevo reporte: " + (TIPO_REP[r.tipo] || r.tipo || ""), (r.nombre || "") + ": " + (r.texto || ""), "rep-" + id, "soporte");
}
function avisoRespuesta(id, r){
  return carga("Respondieron tu reporte", r.respuesta || "", "rep-" + id, "soporte");
}
function avisoSolicitud(id, c){
  return carga("Solicitud de compañero", (c.fromName || "Alguien") + " quiere agregarte como compañero.", "con-" + id, "compas");
}
function avisoAceptada(id, c){
  return carga("Solicitud aceptada", (c.toName || "Alguien") + " aceptó tu solicitud de compañero.", "con-" + id, "compas");
}
function avisoRevision(id, r){
  const f = r.fallas;
  return carga("⚠️ Revisión con fallas", (r.placa || "") + ": " + f + (f === 1 ? " falla" : " fallas") + ", por " + (r.byName || ""), "rev-" + id, "flota");
}

// ------------------------------------------------------ llaves y estado local
// Llaves VAPID: se crean una sola vez y se guardan solo en este equipo (nunca
// en el repositorio ni en el registro). Si se pierden, cada teléfono tiene que
// volver a activar los avisos.
function llavesVapid(dir){
  const f = path.join(dir, "vapid.json");
  let txt = null;
  try { txt = fs.readFileSync(f, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (txt !== null){
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (!j || typeof j.publicKey !== "string" || typeof j.privateKey !== "string")
      throw new Error("vapid.json está dañado. No lo cambio solo (los teléfonos tendrían que activar los avisos otra vez): si de verdad hay que cambiarlo, bórralo a mano.");
    return { publicKey: j.publicKey, privateKey: j.privateKey };
  }
  const k = webpush.generateVAPIDKeys();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify({ publicKey: k.publicKey, privateKey: k.privateKey, createdAt: new Date().toISOString() }) + "\n", { mode: 0o600, flag: "wx" });
  return { publicKey: k.publicKey, privateKey: k.privateKey };
}

function leerEstado(file, log){
  const vacio = { lastAlive: 0, cursors: {}, sent: [] };
  let txt;
  try { txt = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code !== "ENOENT") log("no pude leer el estado (" + resumenError(e) + "): empiezo de cero"); return vacio; }
  try {
    const j = JSON.parse(txt);
    return {
      lastAlive: Number(j.lastAlive) || 0,
      cursors: j.cursors && typeof j.cursors === "object" ? j.cursors : {},
      sent: Array.isArray(j.sent) ? j.sent.filter(k => typeof k === "string").slice(-KEEP_SENT) : []
    };
  } catch (e) { log("el estado está dañado: empiezo de cero"); return vacio; }
}

// --------------------------------------------- equipos (suscripciones push)
// Un documento push/{uid}_{equipo} → { id, uid, endpoint, keys, at }. Si algo
// no cuadra, se salta (y se dice por qué, sin mostrar la dirección).
function equipoDeDoc(doc){
  const d = doc.data() || {};
  if (typeof d.uid !== "string" || !d.uid || doc.id.split("_")[0] !== d.uid) return { malo: "el id no es de esa persona" };
  if (!pushHostOk(d.endpoint)) return { malo: "dirección no permitida" };
  if (typeof d.p256dh !== "string" || !/^[A-Za-z0-9_-]{60,120}$/.test(d.p256dh)
    || typeof d.auth !== "string" || !/^[A-Za-z0-9_-]{16,40}$/.test(d.auth)) return { malo: "llaves inválidas" };
  return { sub: { id: doc.id, uid: d.uid, endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth }, at: tsMs(d.at), updateTime: doc.updateTime } };
}
// uid → equipos (los 5 más recientes). Si una misma dirección aparece en dos
// cuentas (el teléfono cambió de dueño), se queda con quien la guardó último.
function armarEquipos(docs){
  const porDireccion = new Map();
  docs.forEach(doc => {
    const r = equipoDeDoc(doc);
    if (!r.sub) return;
    const prev = porDireccion.get(r.sub.endpoint);
    if (!prev || r.sub.at > prev.at) porDireccion.set(r.sub.endpoint, r.sub);
  });
  const porUid = new Map();
  porDireccion.forEach(s => {
    if (!porUid.has(s.uid)) porUid.set(s.uid, []);
    porUid.get(s.uid).push(s);
  });
  porUid.forEach(l => { l.sort((a, b) => b.at - a.at); if (l.length > MAX_DEVICES) l.length = MAX_DEVICES; });
  return porUid;
}

// ------------------------------------------------------------------ el motor
// opts: db (Firestore), send(equipo, carga) → promesa (solo recibe equipos ya
// revisados con pushHostOk), dataDir, now() en ms, log(...), onFatal(error).
function start(opts){
  const db = opts.db, send = opts.send, dir = opts.dataDir;
  const now = opts.now || Date.now, log = opts.log || logConsola;
  const onFatal = opts.onFatal || function(){ process.exit(1); };
  if (!db || typeof send !== "function" || !dir) throw new Error("start: faltan db, send o dataDir");

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const vapid = llavesVapid(dir);
  const estadoFile = path.join(dir, "avisos-estado.json");
  const est = leerEstado(estadoFile, log);
  const huboEstado = est.lastAlive > 0;
  // (nunca en el futuro: si el reloj se adelantó alguna vez, no se pierde nada)
  const since = Math.min(now(), Math.max(now() - CATCHUP, huboEstado ? est.lastAlive - OVERLAP : 0));
  const sinceTs = Timestamp.fromMillis(since);

  let lastAlive = est.lastAlive, parado = false, todoListo = false, sucio = false, ultimoGuardado = 0;
  const enviados = new Set(est.sent), enviadosLista = est.sent.slice();
  const personas = new Map();   // uid → { status, role, cargo, name }
  let equipos = new Map();      // uid → [equipo]
  const chats = new Map();      // id → datos del chat
  const cursores = new Map();   // id → hora del último mensaje revisado
  const corriendo = new Map();  // id → { busy, again } (un chat a la vez)
  const pendientes = new Set(); // trabajo en curso
  const unsubs = [];

  // --- recordar lo enviado ---------------------------------------------------
  function yaVisto(k){
    if (enviados.has(k)) return true;
    enviados.add(k); enviadosLista.push(k);
    while (enviadosLista.length > KEEP_SENT) enviados.delete(enviadosLista.shift());
    sucio = true;
    return false;
  }
  function ponerCursor(id, t){ cursores.set(id, t); sucio = true; }
  function guardar(conVida){
    if (conVida && todoListo) lastAlive = now();
    const cursors = {};
    cursores.forEach((t, id) => { if (esTs(t)) cursors[id] = [t.seconds, t.nanoseconds]; });
    const tmp = estadoFile + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify({ lastAlive: lastAlive, cursors: cursors, sent: enviadosLista }), { mode: 0o600 });
      fs.renameSync(tmp, estadoFile);
      sucio = false;
    } catch (e) { log("no pude guardar el estado: " + resumenError(e)); }
    ultimoGuardado = now();
  }
  // cada 30 s si hubo cambios; si no, cada 5 min (para anotar que sigue vivo)
  const timer = setInterval(() => { if (!parado && (sucio || now() - ultimoGuardado >= 5 * 60e3)) guardar(true); }, SAVE_EVERY);
  if (timer.unref) timer.unref();

  function seguir(p){
    pendientes.add(p);
    p.then(() => pendientes.delete(p), () => pendientes.delete(p));
    return p;
  }
  function fatal(donde, e){
    if (parado) return;
    log("ERROR en " + donde + ": " + resumenError(e));
    parado = true;
    unsubs.forEach(u => { try { u(); } catch (x) { /* nada */ } });
    clearInterval(timer);
    clearInterval(salud);
    guardar(false);
    onFatal(e);
  }

  // --- personas ----------------------------------------------------------------
  function aprobado(uid){ const p = typeof uid === "string" && personas.get(uid); return !!(p && p.status === "verificado"); }
  function aprobados(){ const l = []; personas.forEach((p, uid) => { if (p.status === "verificado") l.push(uid); }); return l; }
  function nombre(uid){ const p = personas.get(uid); return (p && p.name) || ""; }
  // ¿pasó hace más de 10 minutos? (se compara con la hora del servidor de la
  // consulta: si el iMac se quedó sin internet un rato largo, al volver no se
  // mandan avisos atrasados)
  function viejo(ts, leido){ return esTs(ts) && leido - tsMs(ts) > CATCHUP; }
  function anotarViejo(tipo, ref){ log(tipo, ref, "de hace más de " + Math.round(CATCHUP / 60e3) + " min: no se avisa"); }

  // --- mandar ------------------------------------------------------------------
  function quitarEquipo(s){
    const l = equipos.get(s.uid);
    if (l) equipos.set(s.uid, l.filter(x => x.id !== s.id));
  }
  async function vencido(s){
    quitarEquipo(s);
    try {
      // solo si nadie lo cambió mientras tanto (el teléfono pudo guardar uno nuevo)
      await db.collection("push").doc(s.id).delete(s.updateTime ? { lastUpdateTime: s.updateTime } : undefined);
    } catch (e) { if (e.code !== 9 && e.code !== 5) log("no pude borrar el equipo " + s.id + ": " + resumenError(e)); }
  }
  async function repartir(tipo, ref, destinos, p){
    const lista = [];
    destinos.forEach(uid => (equipos.get(uid) || []).forEach(s => lista.push(s)));
    if (!lista.length){ log(tipo, ref, "personas=" + destinos.length, "sin equipos con avisos"); return; }
    let ok = 0, fallos = 0, vencidos = 0, saltados = 0;
    await Promise.all(lista.map(async s => {
      if (!pushHostOk(s.endpoint)){ saltados++; log("salto el equipo " + s.id + ": dirección no permitida"); return; }
      try {
        try { await send(s, p); }
        catch (e1) {
          // falla pasajera (sin internet, 429 o error del servicio): un reintento
          const st1 = e1 && e1.statusCode;
          if (!(st1 === undefined || st1 === 429 || st1 >= 500) || parado) throw e1;
          const ra = Number(e1 && e1.headers && (e1.headers["retry-after"] || e1.headers["Retry-After"]));
          await esperar(isFinite(ra) && ra > 0 ? Math.min(60, ra) * 1000 : REINTENTO);
          if (parado) throw e1;
          await send(s, p);
        }
        ok++;
      }
      catch (e) {
        const st = e && e.statusCode;
        if (st === 404 || st === 410){ vencidos++; await vencido(s); }
        else { fallos++; log("no se pudo enviar", tipo, "equipo=" + s.id, "estado=" + (st || (e && e.code) || "?")); }
      }
    }));
    log(tipo, ref, "personas=" + destinos.length, "equipos=" + lista.length, "ok=" + ok
      + (fallos ? " fallos=" + fallos : "") + (vencidos ? " vencidos=" + vencidos : "") + (saltados ? " saltados=" + saltados : ""));
  }

  // --- chats -------------------------------------------------------------------
  function cursorInicial(id, c, enPrimeraFoto){
    // chat nuevo (no estaba al arrancar): todos sus mensajes son posteriores
    if (!enPrimeraFoto) return sinceTs;
    if (huboEstado){
      const g = est.cursors[id];
      const guardado = Array.isArray(g) && g.length === 2 && isFinite(g[0]) && isFinite(g[1]) ? new Timestamp(Math.floor(g[0]), Math.floor(g[1])) : null;
      return guardado && cmpTs(guardado, sinceTs) > 0 ? guardado : sinceTs;
    }
    // primera vez en este equipo: nada de lo viejo se manda
    return esTs(c.lastAt) ? c.lastAt : sinceTs;
  }
  function revisarChat(id){
    let st = corriendo.get(id);
    if (!st){ st = { busy: false, again: false }; corriendo.set(id, st); }
    if (st.busy){ st.again = true; return; }
    st.busy = true;
    seguir((async () => {
      try {
        await base;
        do { st.again = false; await vaciarChat(id); } while (st.again && !parado);
      } catch (e) { fatal("mensajes del chat " + id, e); }
      finally { st.busy = false; }
    })());
  }
  async function vaciarChat(id){
    for (;;){
      if (parado) return;
      const c = chats.get(id);
      const hasta = c && c.lastAt;
      let cur = cursores.get(id);
      if (!c || !c.lastFrom || !esTs(hasta) || cmpTs(hasta, cur) <= 0) return;
      const snap = await db.collection("chats").doc(id).collection("mensajes")
        .where("at", ">", cur).orderBy("at").limit(PAGE).get();
      const leido = tsMs(snap.readTime) || now();
      let repetidos = 0, viejos = 0;
      for (const d of snap.docs){
        if (parado) return;
        const r = await mensaje(id, d, leido);
        if (r === false) repetidos++;
        else if (r === "viejo") viejos++;
        const at = d.get("at");
        if (cmpTs(at, cur) > 0){ cur = at; ponerCursor(id, cur); }
      }
      if (repetidos) log("chat=" + id, "repetidos=" + repetidos, "(ya se habían mandado)");
      if (viejos) log("chat=" + id, "atrasados=" + viejos, "(de hace más de " + Math.round(CATCHUP / 60e3) + " min: no se avisan)");
      if (snap.size < PAGE){
        // ya están todos los que había hasta "hasta"
        if (cmpTs(hasta, cursores.get(id)) > 0) ponerCursor(id, hasta);
        return;
      }
    }
  }
  async function mensaje(chatId, d, leido){
    const key = "m:" + chatId + "/" + d.id;
    if (yaVisto(key)) return false;
    const m = d.data() || {}, c = chats.get(chatId) || {};
    if (viejo(m.at, leido)) return "viejo";
    const members = Array.isArray(c.members) ? c.members : [];
    if (typeof m.from !== "string" || typeof m.text !== "string" || !m.text) return;
    if (members.indexOf(m.from) < 0 || !aprobado(m.from)){ log("mensaje", "chat=" + chatId, "msg=" + d.id, "autor no aprobado o fuera del chat: no se avisa"); return; }
    const destinos = members.filter((u, i) => u !== m.from && members.indexOf(u) === i && aprobado(u));
    const p = avisoChat(chatId, c, { fromName: m.fromName || nombre(m.from), text: m.text });
    await repartir(c.type === "grupo" ? "grupo" : "directo", "chat=" + chatId + " msg=" + d.id, destinos, p);
  }

  // --- avisos, soporte, compañeros y flota ---------------------------------------
  function aviso(d, leido){
    const a = d.data() || {};
    if (yaVisto("a:" + d.id)) return;
    if (viejo(a.at, leido)) return anotarViejo("aviso", "id=" + d.id);
    if (a.by && !aprobado(a.by)) return;
    return repartir("aviso", "id=" + d.id, aprobados().filter(u => u !== a.by), avisoAviso(d.id, a));
  }
  function reporteNuevo(d, leido){
    const r = d.data() || {};
    if (yaVisto("rn:" + d.id)) return;
    if (viejo(r.at, leido)) return anotarViejo("reporte", "id=" + d.id);
    if (!aprobado(r.uid)) return;
    const admins = aprobados().filter(u => u !== r.uid && personas.get(u).role === "admin");
    return repartir("reporte", "id=" + d.id, admins, avisoReporte(d.id, r));
  }
  function respuesta(d, leido){
    const r = d.data() || {};
    if (!esTs(r.respondidoAt) || typeof r.respuesta !== "string" || !r.respuesta.trim()) return;
    if (yaVisto("rr:" + d.id + ":" + tsMs(r.respondidoAt))) return;
    if (viejo(r.respondidoAt, leido)) return anotarViejo("respuesta", "id=" + d.id);
    return repartir("respuesta", "id=" + d.id, aprobado(r.uid) ? [r.uid] : [], avisoRespuesta(d.id, r));
  }
  // (la misma pareja puede volver a pedirse: por eso la hora va en la clave)
  function solicitud(d, leido){
    const c = d.data() || {};
    if (c.status !== "pendiente" || !esTs(c.createdAt)) return;
    if (yaVisto("cp:" + d.id + ":" + tsMs(c.createdAt))) return;
    if (viejo(c.createdAt, leido)) return anotarViejo("solicitud", "id=" + d.id);
    if (!aprobado(c.from) || c.to === c.from) return;
    return repartir("solicitud", "id=" + d.id, aprobado(c.to) ? [c.to] : [], avisoSolicitud(d.id, c));
  }
  function aceptada(d, leido){
    const c = d.data() || {};
    if (c.status !== "aceptada" || !esTs(c.acceptedAt)) return;
    if (yaVisto("ca:" + d.id + ":" + tsMs(c.acceptedAt))) return;
    if (viejo(c.acceptedAt, leido)) return anotarViejo("aceptada", "id=" + d.id);
    if (!aprobado(c.to) || c.to === c.from) return;
    return repartir("aceptada", "id=" + d.id, aprobado(c.from) ? [c.from] : [], avisoAceptada(d.id, c));
  }
  function revision(d, leido){
    const r = d.data() || {};
    if (!(typeof r.fallas === "number" && r.fallas > 0)) return;
    if (yaVisto("v:" + d.id)) return;
    if (viejo(r.at, leido)) return anotarViejo("revision", "id=" + d.id);
    if (!aprobado(r.by)) return;
    const destinos = aprobados().filter(u => {
      const p = personas.get(u);
      return u !== r.by && (p.role === "admin" || p.cargo === "Mecánicos");
    });
    return repartir("revision", "id=" + d.id, destinos, avisoRevision(d.id, r));
  }

  // --- escuchar la base de datos --------------------------------------------------
  const primeras = [];
  function escuchar(nombreL, q, alCambiar){
    let resolver, rechazar, primera = true;
    const p = new Promise((r, x) => { resolver = r; rechazar = x; });
    p.catch(() => {});
    primeras.push(p);
    unsubs.push(q.onSnapshot(snap => {
      if (parado) return;
      try { alCambiar(snap, primera); }
      catch (e) { rechazar(e); fatal(nombreL, e); return; }
      if (primera){ primera = false; resolver(); }
    }, e => { rechazar(e); fatal(nombreL, e); }));
  }
  // los eventos se atienden cuando ya se sabe quién es quién y sus equipos
  let listoBase;
  const base = new Promise(r => { listoBase = r; });
  let tengoPersonas = false, tengoEquipos = false;
  function quizasBase(){ if (tengoPersonas && tengoEquipos) listoBase(); }
  function atender(nombreL, tipos, fn){
    return snap => {
      const leido = tsMs(snap.readTime) || now();
      snap.docChanges().forEach(ch => {
        if (tipos.indexOf(ch.type) < 0) return;
        const d = ch.doc;
        seguir(base.then(() => parado ? null : fn(d, leido)).catch(e => fatal(nombreL, e)));
      });
    };
  }

  function conectar(){
    escuchar("users", db.collection("users"), snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === "removed"){ personas.delete(ch.doc.id); return; }
        const u = ch.doc.data() || {};
        personas.set(ch.doc.id, { status: u.status, role: u.role, cargo: u.cargo, name: u.name });
      });
      if (!tengoPersonas){ tengoPersonas = true; quizasBase(); }
    });
    escuchar("push", db.collection("push"), snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === "removed") return;
        const r = equipoDeDoc(ch.doc);
        if (r.malo) log("salto el equipo " + ch.doc.id + ": " + r.malo);
      });
      equipos = armarEquipos(snap.docs);
      if (!tengoEquipos){ tengoEquipos = true; quizasBase(); }
    });
    escuchar("chats", db.collection("chats"), (snap, primera) => {
      snap.docChanges().forEach(ch => {
        const id = ch.doc.id;
        if (ch.type === "removed"){ chats.delete(id); return; }
        const c = ch.doc.data() || {};
        chats.set(id, c);
        if (!cursores.has(id)) ponerCursor(id, cursorInicial(id, c, primera));
        if (c.lastFrom && esTs(c.lastAt) && cmpTs(c.lastAt, cursores.get(id)) > 0) revisarChat(id);
      });
    });
    escuchar("avisos", db.collection("avisos").where("at", ">", sinceTs), atender("avisos", ["added"], aviso));
    escuchar("reportes", db.collection("reportes").where("at", ">", sinceTs), atender("reportes", ["added"], reporteNuevo));
    escuchar("respuestas", db.collection("reportes").where("respondidoAt", ">", sinceTs), atender("respuestas", ["added", "modified"], respuesta));
    escuchar("solicitudes", db.collection("conexiones").where("createdAt", ">", sinceTs), atender("solicitudes", ["added", "modified"], solicitud));
    escuchar("aceptadas", db.collection("conexiones").where("acceptedAt", ">", sinceTs), atender("aceptadas", ["added", "modified"], aceptada));
    escuchar("revisiones", db.collection("revisiones").where("at", ">", sinceTs), atender("revisiones", ["added"], revision));
  }

  // La llave pública va en config/push para que la app pueda activar los avisos.
  async function asegurarLlave(){
    const ref = db.collection("config").doc("push");
    const snap = await ref.get();
    if (!snap.exists || snap.get("publicKey") !== vapid.publicKey){
      await ref.set({ publicKey: vapid.publicKey, updatedAt: FieldValue.serverTimestamp() });
      log("llave pública guardada en config/push");
    }
  }

  // Las escuchas de Firestore reintentan solas, sin avisar, si la sesión de
  // Firebase venció o se acabó la cuota del día: cada 15 minutos se lee
  // config/push y, si falla 3 veces seguidas, se reinicia (y queda en el registro).
  let fallasSalud = 0;
  const salud = setInterval(() => {
    if (parado || !todoListo) return;
    db.collection("config").doc("push").get()
      .then(() => { fallasSalud = 0; })
      .catch(e => {
        fallasSalud++;
        log("no pude leer config/push (" + fallasSalud + " de " + SALUD_FALLAS + "): " + resumenError(e));
        if (fallasSalud >= SALUD_FALLAS) fatal("conexión con Firebase", e);
      });
  }, opts.saludCada || SALUD_CADA);
  if (salud.unref) salud.unref();

  log("arrancando: me pongo al día desde " + new Date(since).toISOString() + (huboEstado ? "" : " (primera vez: los mensajes viejos no se mandan)"));
  const ready = (async () => {
    await asegurarLlave();
    if (parado) return;
    conectar();
    await Promise.all(primeras);
    await base;
    todoListo = true;
    guardar(true);
    log("listo: " + personas.size + " personas, " + aprobados().length + " aprobadas, "
      + Array.from(equipos.values()).reduce((n, l) => n + l.length, 0) + " equipos con avisos, " + chats.size + " chats");
  })();
  ready.catch(e => fatal("arranque", e));

  async function stop(){
    if (parado) return;
    parado = true;
    unsubs.forEach(u => { try { u(); } catch (e) { /* nada */ } });
    clearInterval(timer);
    clearInterval(salud);
    // espera lo que se estaba enviando (máximo 10 segundos)
    await Promise.race([Promise.all(Array.from(pendientes)).catch(() => {}), esperar(10000)]);
    guardar(true);
  }

  return { ready: ready, stop: stop, publicKey: vapid.publicKey };
}

// ------------------------------------------------------------ uso desde launchd
function dirDatos(){ return process.env.COSECORO_DIR || path.join(os.homedir(), "Library", "Application Support", "CoseCoro"); }

function conectarFirestore(){
  if (process.env.FIRESTORE_EMULATOR_HOST){
    // simulador (pruebas): no hace falta sesión
    return new Firestore({ projectId: process.env.COSECORO_PROJECT || "demo-cosecoro" });
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/configstore/firebase-tools.json"), "utf8")); }
  catch (e) { cfg = null; }
  const refresh = cfg && cfg.tokens && cfg.tokens.refresh_token;
  if (!refresh) throw new Error("no hay sesión de Firebase en este equipo: corre «npx firebase-tools login» y vuelve a instalar");
  return new Firestore({
    projectId: PROJECT,
    credentials: { type: "authorized_user", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refresh }
  });
}

// Si se cae una y otra vez, espera cada vez más antes de cerrarse (1, 2, 4…
// hasta 60 minutos; luego launchd lo vuelve a abrir), para no gastar la cuota
// gratis de lecturas reabriendo sin parar. Si estuvo bien más de 10 minutos,
// la cuenta vuelve a empezar.
const ARRANQUE = Date.now();
let cerrando = false;
function cerrarConFalla(){
  if (cerrando) return;
  cerrando = true;
  const dir = dirDatos(), f = path.join(dir, "avisos-fallas.json");
  let n = 0;
  try { n = Number(JSON.parse(fs.readFileSync(f, "utf8")).n) || 0; } catch (e) { n = 0; }
  if (Date.now() - ARRANQUE > 10 * 60e3) n = 0;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, JSON.stringify({ n: n + 1, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  } catch (e) { /* nada */ }
  const ms = Math.min(60 * 60e3, 60e3 * Math.pow(2, Math.min(n, 6)));
  logConsola("vuelvo a intentar en " + Math.round(ms / 60e3) + " min");
  setTimeout(() => process.exit(1), ms);
}

async function main(){
  const dir = dirDatos();
  const db = conectarFirestore();
  if (process.env.FIRESTORE_EMULATOR_HOST) logConsola("usando el simulador de Firebase");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const vapid = llavesVapid(dir);
  webpush.setVapidDetails(SUBJECT, vapid.publicKey, vapid.privateKey);

  function enviar(s, p){
    if (!pushHostOk(s.endpoint)) return Promise.reject(new Error("dirección no permitida"));
    return webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, JSON.stringify(p),
      { TTL: TTL, urgency: "high", topic: tema(p.tag), timeout: SEND_TIMEOUT });
  }

  const motor = start({ db: db, send: enviar, dataDir: dir, log: logConsola, onFatal: cerrarConFalla });
  let saliendo = false;
  function salir(sig){
    if (saliendo) return;
    saliendo = true;
    logConsola("parando (" + sig + ")");
    const t = setTimeout(() => process.exit(0), 15000);
    if (t.unref) t.unref();
    motor.stop().then(() => db.terminate()).catch(() => {}).then(() => process.exit(0));
  }
  process.on("SIGTERM", () => salir("SIGTERM"));
  process.on("SIGINT", () => salir("SIGINT"));
  // Una vez al día se reinicia solo (launchd lo vuelve a abrir enseguida), para
  // que las consultas abiertas no crezcan sin fin.
  const diario = setTimeout(() => salir("reinicio diario"), 24 * 3600e3);
  if (diario.unref) diario.unref();
  await motor.ready.catch(() => {}); // si falla, ya lo atendió onFatal
}

if (require.main === module){
  process.on("unhandledRejection", e => { logConsola("ERROR inesperado: " + resumenError(e)); cerrarConFalla(); });
  main().catch(e => { logConsola("ERROR: " + resumenError(e)); cerrarConFalla(); });
}

module.exports = {
  start, pushHostOk, llavesVapid, armarEquipos, corto, tema,
  avisoChat, avisoAviso, avisoReporte, avisoRespuesta, avisoSolicitud, avisoAceptada, avisoRevision,
  CATCHUP, KEEP_SENT, MAX_DEVICES
};
