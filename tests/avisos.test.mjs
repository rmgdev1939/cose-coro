import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

// Prueba completa del enviador de avisos con la app cerrada
// (tools/avisos/avisos-push.cjs) contra el simulador de Firestore.
// Se corre con: cd tests && npm run test:avisos (ver README.md).
// El envío real (web-push) se cambia por uno de mentira que anota a qué
// equipo iba cada aviso y con qué texto.
const require = createRequire(import.meta.url);
const av = require("../tools/avisos/avisos-push.cjs");
const { Firestore, FieldValue, Timestamp } = require("../tools/avisos/node_modules/@google-cloud/firestore");

if (!process.env.FIRESTORE_EMULATOR_HOST){
  console.log("Falta el simulador de Firestore: corre «npm run test:avisos» dentro de tests/.");
  process.exit(1);
}
const PROJECT = "demo-cosecoro";
const db = new Firestore({ projectId: PROJECT }); // con el simulador no pasa por las reglas (como la cuenta del dueño)

let pass = 0, fail = 0;
async function t(name, fn){
  try{ await fn(); pass++; console.log("  ok  " + name); }
  catch(e){ fail++; console.log("  FAIL " + name + " — " + (e && e.message ? e.message.split("\n").slice(0, 6).join(" | ") : e)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function hasta(cond, que, ms = 10000){
  const fin = Date.now() + ms;
  while (Date.now() < fin){ if (cond()) return; await sleep(40); }
  throw new Error("no pasó a tiempo: " + que);
}
const pid = (a, b) => a < b ? a + "_" + b : b + "_" + a;
const pair = (a, b) => a < b ? [a, b] : [b, a];

// --- borrar lo que haya quedado de otra prueba -------------------------------------
{
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const r = await fetch("http://" + host + "/emulator/v1/projects/" + PROJECT + "/databases/(default)/documents", { method: "DELETE" });
  if (!r.ok) throw new Error("no pude limpiar el simulador: " + r.status);
}

// --- personas ------------------------------------------------------------------------
const RAFA = "eabbcqq01NSHmbCiXMMToQIMzU72";
const U = {
  [RAFA]: { name: "Rafael Supervisor", role: "admin", status: "verificado", cargo: "Gerencia" },
  B: { name: "Beto Pérez", role: "empleado", status: "verificado", cargo: "Ventas" },
  C: { name: "Carla Gómez", role: "empleado", status: "verificado", cargo: "Ventas" },
  D: { name: "Dani Pendiente", role: "empleado", status: "pendiente", cargo: "Ventas" },
  E: { name: "Eva Bloqueada", role: "empleado", status: "bloqueado", cargo: "Ventas" },
  M: { name: "Mario Mecánico", role: "empleado", status: "verificado", cargo: "Mecánicos" },
  H: { name: "Hugo Chofer", role: "empleado", status: "verificado", cargo: "Choferes" },
};
for (const [uid, u] of Object.entries(U)){
  await db.collection("users").doc(uid).set({ name: u.name, email: uid.toLowerCase() + "@x.com", cargo: u.cargo, emailVerified: true, status: u.status, role: u.role });
}

// --- equipos con avisos (push/{uid}_{equipo}) ------------------------------------------
const llaves = () => ({ p256dh: randomBytes(65).toString("base64url"), auth: randomBytes(16).toString("base64url") });
const T0 = Date.now() - 3600e3;
const EVIL = "https://192.168.1.10/x";
const AJENO = "https://fcm.googleapis.com/fcm/send/ajeno";
const COMPARTIDO = "https://fcm.googleapis.com/fcm/send/compartido";
const EQ = {
  [RAFA + "_rafa0001"]: { uid: RAFA, endpoint: "https://fcm.googleapis.com/fcm/send/rafa:APA91b" },
  B_beto0001: { uid: "B", endpoint: "https://fcm.googleapis.com/fcm/send/beto1:APA91b" },
  B_beto0002: { uid: "B", endpoint: "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABbeto2" },
  B_malo0001: { uid: "B", endpoint: EVIL },                       // red interna: nunca se envía
  C_carla001: { uid: "C", endpoint: "https://web.push.apple.com/QGcarla1" },
  C_carla002: { uid: "C", endpoint: "https://fcm.googleapis.com/fcm/send/gone" }, // el servicio dice 410
  C_viejo001: { uid: "C", endpoint: COMPARTIDO, at: T0 },          // ese teléfono ahora es de Mario
  C_ajeno001: { uid: "B", endpoint: AJENO },                       // id de otra persona: se salta
  D_dani0001: { uid: "D", endpoint: "https://fcm.googleapis.com/fcm/send/dani" },
  E_eva00001: { uid: "E", endpoint: "https://fcm.googleapis.com/fcm/send/eva" },
  M_mario001: { uid: "M", endpoint: "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2bmario" },
  M_nuevo001: { uid: "M", endpoint: COMPARTIDO, at: T0 + 60e3 },
};
for (let i = 1; i <= 6; i++) EQ["H_hugo000" + i] = { uid: "H", endpoint: "https://fcm.googleapis.com/fcm/send/hugo" + i, at: T0 + i * 1000 };
for (const [id, e] of Object.entries(EQ)){
  await db.collection("push").doc(id).set(Object.assign({ uid: e.uid, dev: id.split("_")[1], endpoint: e.endpoint, ua: "prueba",
    at: e.at ? Timestamp.fromMillis(e.at) : FieldValue.serverTimestamp() }, llaves()));
}
const HUGO5 = ["H_hugo0002", "H_hugo0003", "H_hugo0004", "H_hugo0005", "H_hugo0006"]; // los 5 más recientes
const BETO = ["B_beto0001", "B_beto0002"], MARIO = ["M_mario001", "M_nuevo001"];

// --- chats -----------------------------------------------------------------------------
const BC = pid("B", "C"), BE = pid("B", "E");
await db.collection("chats").doc(BC).set({ type: "directo", members: pair("B", "C"), createdBy: "B", createdAt: FieldValue.serverTimestamp() });
await db.collection("chats").doc(BE).set({ type: "directo", members: pair("B", "E"), createdBy: "B", createdAt: FieldValue.serverTimestamp() });
const grupo = db.collection("chats").doc();
const G = grupo.id;
await grupo.set({ type: "grupo", members: ["C", "B", "D", "E", "M"], name: "Patio", createdBy: "C", createdAt: FieldValue.serverTimestamp() });

// Como la app: el mensaje y el "último mensaje" del chat en un solo lote, con la hora del servidor
async function mensaje(chatId, from, text){
  const ref = db.collection("chats").doc(chatId).collection("mensajes").doc();
  const b = db.batch();
  b.set(ref, { from: from, fromName: U[from].name, text: text, at: FieldValue.serverTimestamp() });
  b.update(db.collection("chats").doc(chatId), { lastText: text.slice(0, 120), lastAt: FieldValue.serverTimestamp(), lastFrom: from, lastFromName: U[from].name });
  await b.commit();
  return ref.id;
}

// Lo de antes de arrancar el enviador no se manda
await mensaje(BC, "B", "Mensaje viejo de antes");
await db.collection("avisos").doc("viejo").set({ titulo: "Aviso viejo", texto: "De hace una hora", tipo: "sistema", by: RAFA, byName: U[RAFA].name, at: Timestamp.fromMillis(Date.now() - 3600e3) });

// --- el enviador, con un envío de mentira ---------------------------------------------------
const tArranque = Date.now();
const dir = mkdtempSync(join(tmpdir(), "cosecoro-avisos-"));
const enviados = [];
const logs = [];
async function send(sub, p){
  enviados.push({ id: sub.id, uid: sub.uid, endpoint: sub.endpoint, p: p });
  if (sub.endpoint.endsWith("/gone")){ const e = new Error("Received unexpected response code"); e.statusCode = 410; throw e; }
}
function arrancar(){
  return av.start({ db: db, send: send, dataDir: dir, log: (...a) => logs.push(a.join(" ")),
    onFatal: e => { console.log("FATAL", e); process.exit(1); } });
}
let mark = 0;
// espera n envíos nuevos (y un poco más, por si llega alguno de sobra)
async function recibir(n, que){
  try { await hasta(() => enviados.length >= mark + n, que + " (" + n + " envíos)"); await sleep(500); }
  finally { var nuevos = enviados.slice(mark); mark = enviados.length; }
  return nuevos;
}
async function nada(ms = 1200){
  await sleep(ms);
  const nuevos = enviados.slice(mark); mark = enviados.length;
  assert.deepEqual(nuevos.map(x => x.id), [], "no debía enviarse nada");
}
const ids = l => l.map(x => x.id).sort();
function todosCon(l, p){ l.forEach(x => assert.deepEqual(x.p, p)); }
const esperarLog = (txt, que) => hasta(() => logs.some(l => l.indexOf(txt) >= 0), que || txt);

console.log("revisión de direcciones y textos");
await t("solo servicios de avisos conocidos (https, sin puerto)", () => {
  const si = ["https://fcm.googleapis.com/fcm/send/abc:APA91b-x_y", "https://android.googleapis.com/gcm/send/x",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA", "https://web.push.apple.com/QGx-y_z",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA%2bb%3d", "https://FCM.googleapis.com/fcm/send/x"];
  const no = ["http://fcm.googleapis.com/fcm/send/x", EVIL, "https://fcm.googleapis.com:8443/x", "https://fcm.googleapis.com:443/x",
    "https://fcm.googleapis.com.evil.com/x", "https://evil.com/fcm.googleapis.com", "https://user@fcm.googleapis.com/x",
    "https://fcm.googleapis.com@192.168.1.10/x", "https://fcm.googleapis.com\\@evil.com/x", "https://fcm.googleapis.com\\evil",
    "https://notify.windows.com/x", "https://evilnotify.windows.com/x", "https://fcm.googleapis.com./x", "https://localhost/x",
    "https://127.0.0.1/x", "https://[::1]/x", "https://fcm.googleapis.com/x y", "https://fcm.googleapis.com/x#@evil", "",
    null, undefined, 42, "https://fcm.googleapis.com/" + "a".repeat(800)];
  si.forEach(u => assert.equal(av.pushHostOk(u), true, u));
  no.forEach(u => assert.equal(av.pushHostOk(u), false, String(u)));
});
await t("textos recortados (80 / 160 letras con «…») y emojis", () => {
  assert.equal(av.corto("a".repeat(80), 80), "a".repeat(80));
  assert.equal(av.corto("a".repeat(81), 80), "a".repeat(79) + "…");
  assert.equal(Array.from(av.corto("😀".repeat(200), 160)).length, 160);
  assert.equal(av.corto("  hola \n\n mundo  ", 80), "hola mundo");
  assert.deepEqual(av.avisoAviso("x", { tipo: "actualizacion", titulo: "Versión nueva", texto: "Hay cosas nuevas" }),
    { t: "✨ Versión nueva", b: "Hay cosas nuevas", tag: "aviso-x", go: "avisos" });
  assert.deepEqual(av.avisoChat("g1", { type: "grupo" }, { fromName: "Ana", text: "hola" }), { t: "Grupo", b: "Ana: hola", tag: "chat-g1", go: "chat:g1" });
  assert.equal(av.avisoReporte("r", { tipo: "sugerencia", nombre: "Ana", texto: "Algo" }).t, "Nuevo reporte: sugerencia");
  assert.equal(av.avisoReporte("r", { tipo: "pregunta", nombre: "Ana", texto: "Algo" }).t, "Nuevo reporte: pregunta");
  assert.ok(/^[A-Za-z0-9_-]{32}$/.test(av.tema("chat-" + BC)));
});

console.log("arranque");
let h = arrancar();
await t("arranca y se conecta", () => h.ready);
await t("guarda la llave pública en config/push", async () => {
  const s = await db.collection("config").doc("push").get();
  assert.equal(s.get("publicKey"), h.publicKey);
  assert.ok(/^[A-Za-z0-9_-]{80,100}$/.test(h.publicKey), "llave con forma rara");
  assert.ok(s.get("updatedAt") instanceof Timestamp);
});
await t("las llaves VAPID quedan solo en el equipo (archivo 600) y nunca en el registro", () => {
  const f = join(dir, "vapid.json");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const k = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(k.publicKey, h.publicKey);
  assert.ok(!logs.some(l => l.indexOf(k.privateKey) >= 0));
});
await t("salta los equipos con dirección no permitida o id ajeno", async () => {
  await esperarLog("salto el equipo B_malo0001: dirección no permitida");
  await esperarLog("salto el equipo C_ajeno001: el id no es de esa persona");
});
await t("no manda lo que había antes de arrancar", () => nada(1000));

console.log("chats");
let mid;
await t("mensaje directo: solo a la otra persona, en todos sus equipos", async () => {
  await mensaje(BC, "B", "Hola Carla, ¿ya llegó el cemento?");
  const l = await recibir(2, "mensaje directo");
  assert.deepEqual(ids(l), ["C_carla001", "C_carla002"]);
  todosCon(l, { t: "Beto Pérez", b: "Hola Carla, ¿ya llegó el cemento?", tag: "chat-" + BC, go: "chat:" + BC });
});
await t("si el servicio dice 410 (ya no existe), se borra ese equipo", async () => {
  const ref = db.collection("push").doc("C_carla002");
  const fin = Date.now() + 5000;
  while ((await ref.get()).exists && Date.now() < fin) await sleep(100);
  assert.equal((await ref.get()).exists, false);
  assert.equal((await db.collection("push").doc("C_carla001").get()).exists, true);
});
await t("las palomitas (recibido/leído) no repiten el aviso", async () => {
  await db.collection("chats").doc(BC).update({ "recibido.C": FieldValue.serverTimestamp(), "leido.C": FieldValue.serverTimestamp() });
  await nada();
});
await t("mensaje de grupo: a los miembros aprobados menos quien escribe", async () => {
  await mensaje(G, "C", "Ya llegó el camión");
  const l = await recibir(4, "mensaje de grupo");
  assert.deepEqual(ids(l), [...BETO, ...MARIO].sort());
  todosCon(l, { t: "Patio", b: "Carla Gómez: Ya llegó el camión", tag: "chat-" + G, go: "chat:" + G });
});
await t("mensaje de alguien pendiente en el grupo: no se avisa", async () => {
  mid = await mensaje(G, "D", "Hola a todos");
  await esperarLog("msg=" + mid);
  await nada(300);
});
await t("mensaje de alguien bloqueado: no se avisa", async () => {
  mid = await mensaje(BE, "E", "Hola Beto");
  await esperarLog("msg=" + mid);
  await nada(300);
});
await t("mensaje para alguien bloqueado: no se avisa", async () => {
  mid = await mensaje(BE, "B", "Hola Eva");
  await esperarLog("msg=" + mid);
  await nada(300);
});

console.log("avisos, soporte, compañeros y flota");
let rep;
await t("aviso del administrador: a todos los aprobados menos quien lo escribe", async () => {
  const a = await db.collection("avisos").add({ titulo: "Corte de luz", texto: "Mañana no hay luz de 8 a 10.", tipo: "sistema", by: RAFA, byName: U[RAFA].name, at: FieldValue.serverTimestamp() });
  const l = await recibir(10, "aviso");
  assert.deepEqual(ids(l), [...BETO, "C_carla001", ...MARIO, ...HUGO5].sort());
  todosCon(l, { t: "🔔 Corte de luz", b: "Mañana no hay luz de 8 a 10.", tag: "aviso-" + a.id, go: "avisos" });
});
await t("reporte nuevo: solo al administrador", async () => {
  rep = await db.collection("reportes").add({ uid: "B", nombre: U.B.name, tipo: "fallo", texto: "La calculadora no suma bien los bloques.",
    version: "v1", pantalla: "calc", equipo: "prueba", estado: "nuevo", at: FieldValue.serverTimestamp() });
  const l = await recibir(1, "reporte nuevo");
  assert.deepEqual(ids(l), [RAFA + "_rafa0001"]);
  todosCon(l, { t: "Nuevo reporte: falla", b: "Beto Pérez: La calculadora no suma bien los bloques.", tag: "rep-" + rep.id, go: "soporte" });
});
await t("respuesta del reporte: a quien lo envió", async () => {
  await rep.update({ estado: "resuelto", respuesta: "Ya lo arreglamos, gracias.", respondidoAt: FieldValue.serverTimestamp() });
  const l = await recibir(2, "respuesta");
  assert.deepEqual(ids(l), BETO);
  todosCon(l, { t: "Respondieron tu reporte", b: "Ya lo arreglamos, gracias.", tag: "rep-" + rep.id, go: "soporte" });
});
await t("cambiar solo el estado del reporte: no se repite", async () => {
  await rep.update({ estado: "revisando" });
  await nada();
});
await t("una respuesta nueva sí se avisa otra vez", async () => {
  await rep.update({ respuesta: "Ahora sí quedó.", respondidoAt: FieldValue.serverTimestamp() });
  const l = await recibir(2, "respuesta nueva");
  assert.deepEqual(ids(l), BETO);
  todosCon(l, { t: "Respondieron tu reporte", b: "Ahora sí quedó.", tag: "rep-" + rep.id, go: "soporte" });
});
const CH = pid("C", "H");
await t("solicitud de compañero: a quien la recibe", async () => {
  await db.collection("conexiones").doc(CH).set({ members: pair("C", "H"), from: "H", to: "C", fromName: U.H.name, toName: U.C.name,
    status: "pendiente", createdAt: FieldValue.serverTimestamp() });
  const l = await recibir(1, "solicitud");
  assert.deepEqual(ids(l), ["C_carla001"]);
  todosCon(l, { t: "Solicitud de compañero", b: "Hugo Chofer quiere agregarte como compañero.", tag: "con-" + CH, go: "compas" });
});
await t("solicitud aceptada: a quien la envió", async () => {
  await db.collection("conexiones").doc(CH).update({ status: "aceptada", acceptedAt: FieldValue.serverTimestamp() });
  const l = await recibir(5, "aceptada");
  assert.deepEqual(ids(l), HUGO5);
  todosCon(l, { t: "Solicitud aceptada", b: "Carla Gómez aceptó tu solicitud de compañero.", tag: "con-" + CH, go: "compas" });
});
await t("solicitudes para alguien pendiente o de alguien bloqueado: no se avisan", async () => {
  await db.collection("conexiones").doc(pid("B", "D")).set({ members: pair("B", "D"), from: "B", to: "D", fromName: U.B.name, toName: U.D.name,
    status: "pendiente", createdAt: FieldValue.serverTimestamp() });
  await db.collection("conexiones").doc(pid("B", "E")).set({ members: pair("B", "E"), from: "E", to: "B", fromName: U.E.name, toName: U.B.name,
    status: "pendiente", createdAt: FieldValue.serverTimestamp() });
  await nada();
});
const revision = (by, fallas) => db.collection("revisiones").add({ vehiculoId: "v1", placa: "AB123CD", puntos: { luces: fallas === 0 }, fallas: fallas,
  km: 1000, combustible: "1/2", nota: "", by: by, byName: U[by].name, at: FieldValue.serverTimestamp() });
await t("revisión con fallas: al administrador y a Mecánicos", async () => {
  const r = await revision("H", 2);
  const l = await recibir(3, "revisión");
  assert.deepEqual(ids(l), [RAFA + "_rafa0001", ...MARIO].sort());
  todosCon(l, { t: "⚠️ Revisión con fallas", b: "AB123CD: 2 fallas, por Hugo Chofer", tag: "rev-" + r.id, go: "flota" });
});
await t("revisión sin fallas: no se avisa", async () => {
  await revision("H", 0);
  await nada();
});
await t("revisión con 1 falla hecha por un mecánico: no se le avisa a él", async () => {
  const r = await revision("M", 1);
  const l = await recibir(1, "revisión de mecánico");
  assert.deepEqual(ids(l), [RAFA + "_rafa0001"]);
  todosCon(l, { t: "⚠️ Revisión con fallas", b: "AB123CD: 1 falla, por Mario Mecánico", tag: "rev-" + r.id, go: "flota" });
});
await t("nunca a la red interna, a ids ajenos, a pendientes o bloqueados, ni al 6.º equipo", () => {
  const malos = [EVIL, AJENO, EQ.D_dani0001.endpoint, EQ.E_eva00001.endpoint, EQ.H_hugo0001.endpoint];
  assert.deepEqual(enviados.filter(x => malos.indexOf(x.endpoint) >= 0), []);
  assert.deepEqual(enviados.filter(x => x.id === "C_viejo001" || x.uid === "D" || x.uid === "E"), []);
  assert.ok(enviados.every(x => av.pushHostOk(x.endpoint)));
});
await t("la supervisión no recibe los mensajes de los chats", () => {
  assert.deepEqual(enviados.filter(x => x.uid === RAFA && /^chat:/.test(x.p.go)), []);
});

console.log("reinicio");
await t("al parar guarda el estado (sin textos)", async () => {
  await h.stop();
  const est = JSON.parse(readFileSync(join(dir, "avisos-estado.json"), "utf8"));
  assert.ok(est.lastAlive > 0);
  assert.ok(Array.isArray(est.cursors[BC]) && Array.isArray(est.cursors[G]));
  assert.ok(est.sent.indexOf("a:viejo") < 0);
  const txt = JSON.stringify(est);
  ["cemento", "camión", "Corte de luz", "arreglamos", "AB123CD"].forEach(w => assert.ok(txt.indexOf(w) < 0, w));
  assert.equal(statSync(join(dir, "avisos-estado.json")).mode & 0o777, 0o600);
});
const llaveAntes = (await db.collection("config").doc("push").get()).get("updatedAt");
h = arrancar();
await t("al volver a arrancar no repite nada", async () => {
  await h.ready;
  await nada(1500);
});
await t("si los cursores de los chats quedan atrás, lo ya enviado no se repite", async () => {
  await h.stop();
  const f = join(dir, "avisos-estado.json"), est = JSON.parse(readFileSync(f, "utf8"));
  // como si hubiera guardado el estado justo al arrancar la primera vez
  for (const id of Object.keys(est.cursors)) est.cursors[id] = [Math.floor(tArranque / 1000), (tArranque % 1000) * 1e6];
  writeFileSync(f, JSON.stringify(est));
  h = arrancar();
  await h.ready;
  // volvió a mirar los mensajes recientes de los chats y no mandó nada repetido
  await esperarLog("chat=" + BC + " repetidos=");
  await esperarLog("chat=" + G + " repetidos=");
  await nada(800);
});
await t("la llave de config/push no cambia al reiniciar", async () => {
  const s = await db.collection("config").doc("push").get();
  assert.equal(s.get("publicKey"), h.publicKey);
  assert.ok(s.get("updatedAt").isEqual(llaveAntes));
  assert.equal(logs.filter(l => l.indexOf("llave pública guardada") >= 0).length, 1);
});
await t("después del reinicio sigue avisando (texto largo recortado)", async () => {
  const largo = "Carla, ".repeat(60);
  await mensaje(BC, "B", largo);
  const l = await recibir(1, "mensaje tras reinicio");
  assert.deepEqual(ids(l), ["C_carla001"]);
  assert.equal(l[0].p.t, "Beto Pérez");
  assert.equal(Array.from(l[0].p.b).length, 160);
  assert.ok(l[0].p.b.endsWith("…"));
});
await t("lo que pasó con el enviador apagado se manda al volver", async () => {
  await h.stop();
  await mensaje(BC, "C", "Sí, ya llegó");
  const a = await db.collection("avisos").add({ titulo: "Versión nueva", texto: "Ya pueden actualizar.", tipo: "actualizacion", by: RAFA, byName: U[RAFA].name, at: FieldValue.serverTimestamp() });
  await nada(300);
  h = arrancar();
  await h.ready;
  const l = await recibir(12, "lo pendiente");
  const chat = l.filter(x => x.p.go === "chat:" + BC), avs = l.filter(x => x.p.go === "avisos");
  assert.deepEqual(ids(chat), BETO);
  todosCon(chat, { t: "Carla Gómez", b: "Sí, ya llegó", tag: "chat-" + BC, go: "chat:" + BC });
  assert.deepEqual(ids(avs), [...BETO, "C_carla001", ...MARIO, ...HUGO5].sort());
  todosCon(avs, { t: "✨ Versión nueva", b: "Ya pueden actualizar.", tag: "aviso-" + a.id, go: "avisos" });
});
await h.stop();

await t("el registro no tiene textos, nombres de mensajes ni llaves", () => {
  const todo = logs.join("\n");
  const k = JSON.parse(readFileSync(join(dir, "vapid.json"), "utf8"));
  ["cemento", "camión", "Hola", "Corte de luz", "luz de 8", "calculadora", "arreglamos", "Ahora sí", "AB123CD", "Versión nueva", "Sí, ya llegó",
   "@x.com", k.privateKey, "/fcm/send/", "mozilla.com/wpush"].forEach(w => assert.ok(todo.indexOf(w) < 0, "aparece en el registro: " + w));
});

rmSync(dir, { recursive: true, force: true });
await db.terminate();
console.log(`\n${pass} ok, ${fail} fallas`);
process.exit(fail ? 1 : 0);
