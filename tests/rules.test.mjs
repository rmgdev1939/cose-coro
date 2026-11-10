import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs, addDoc,
         serverTimestamp, writeBatch, orderBy, limit, arrayUnion, arrayRemove, increment } from "firebase/firestore";
import { ref, set, get as rget } from "firebase/database";

// Pruebas de las reglas de seguridad (Firestore + Realtime Database).
// Se corren contra el simulador de Firebase: ver README.md.
const DIR = new URL("../", import.meta.url).pathname;
const env = await initializeTestEnvironment({
  projectId: "demo-cosecoro",
  firestore: { rules: readFileSync(DIR + "firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  database: { rules: readFileSync(DIR + "database.rules.json", "utf8"), host: "127.0.0.1", port: 9000 },
});

let pass = 0, fail = 0;
async function t(name, fn){
  try{ await fn(); pass++; console.log("  ok  " + name); }
  catch(e){ fail++; console.log("  FAIL " + name + " — " + (e && e.message ? e.message.split("\n")[0] : e)); }
}
const pid = (a, b) => a < b ? a + "_" + b : b + "_" + a;
const pair = (a, b) => a < b ? [a, b] : [b, a];

// Personas
const U = {
  A: { name: "Ana Admin", role: "admin", status: "verificado" },
  B: { name: "Beto", role: "empleado", status: "verificado" },
  C: { name: "Carla", role: "empleado", status: "verificado" },
  D: { name: "Dani Pendiente", role: "empleado", status: "pendiente" },
  E: { name: "Eva Bloqueada", role: "empleado", status: "bloqueado" },
};
const RAFA = "eabbcqq01NSHmbCiXMMToQIMzU72";
U.INV = { name: "Iván Inventario", role: "empleado", status: "verificado", cargo: "Inventario" };
U.AUT = { name: "Aura Autoservicio", role: "empleado", status: "verificado", cargo: "Autoservicio" };
U.MEC = { name: "Mario Mecánico", role: "empleado", status: "verificado", cargo: "Mecánicos" };
U.GER = { name: "Gina Gerencia", role: "empleado", status: "verificado", cargo: "Gerencia" };
U.CHO = { name: "Carlos Chofer", role: "empleado", status: "verificado", cargo: "Choferes" };
U.COM = { name: "Coral Compras", role: "empleado", status: "verificado", cargo: "Compras" };
U.SPF = { name: "Sergio Sistema PF", role: "empleado", status: "verificado", cargo: "Sistema PF" };
U[RAFA] = { name: "Rafael Supervisor", role: "admin", status: "verificado" };
for (let i = 1; i <= 9; i++) U["U" + i] = { name: "Extra " + i, role: "empleado", status: "verificado" };

await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  for (const [uid, u] of Object.entries(U)){
    await setDoc(doc(db, "users", uid), { name: u.name, email: uid + "@x.com", cargo: u.cargo || "Ventas", emailVerified: true, status: u.status, role: u.role });
    if (u.status === "verificado") await setDoc(doc(db, "perfiles", uid), { name: u.name, cargo: u.cargo || "Ventas", icon: "martillo" });
  }
  // B es compañero de U1..U9 (para probar grupos grandes)
  for (let i = 1; i <= 9; i++){
    const o = "U" + i;
    await setDoc(doc(db, "conexiones", pid("B", o)), { members: pair("B", o), from: "B", to: o, fromName: "Beto", toName: U[o].name, status: "aceptada" });
  }
});

const as = (uid, verified = true) => env.authenticatedContext(uid, { email: uid + "@x.com", email_verified: verified }).firestore();
const B = as("B"), C = as("C"), A = as("A"), D = as("D"), E = as("E"), Bun = as("B", false);
const anon = env.unauthenticatedContext().firestore();

console.log("perfiles");
await t("B lee el perfil de C", () => assertSucceeds(getDoc(doc(B, "perfiles", "C"))));
await t("D (pendiente) no lee perfiles", () => assertFails(getDoc(doc(D, "perfiles", "C"))));
await t("E (bloqueada) no lee perfiles", () => assertFails(getDoc(doc(E, "perfiles", "C"))));
await t("sin sesión no lee perfiles", () => assertFails(getDoc(doc(anon, "perfiles", "C"))));
await t("B con correo sin confirmar no lee perfiles", () => assertFails(getDoc(doc(Bun, "perfiles", "C"))));
await t("B guarda su perfil con su nombre e ícono", () => assertSucceeds(setDoc(doc(B, "perfiles", "B"), { name: "Beto", cargo: "Ventas", icon: "llave", updatedAt: serverTimestamp() })));
await t("B no pone otro nombre en su perfil", () => assertFails(setDoc(doc(B, "perfiles", "B"), { name: "Jefe", cargo: "Ventas", icon: "llave", updatedAt: serverTimestamp() })));
await t("B no escribe el perfil de C", () => assertFails(setDoc(doc(B, "perfiles", "C"), { name: "Carla", cargo: "Ventas", icon: "llave", updatedAt: serverTimestamp() })));
await t("B no agrega campos extra al perfil", () => assertFails(setDoc(doc(B, "perfiles", "B"), { name: "Beto", cargo: "Ventas", icon: "llave", role: "admin", updatedAt: serverTimestamp() })));
await t("D (pendiente) no crea perfil", () => assertFails(setDoc(doc(D, "perfiles", "D"), { name: "Dani Pendiente", cargo: "", icon: "", updatedAt: serverTimestamp() })));
await t("admin borra el perfil de alguien", () => assertSucceeds(deleteDoc(doc(A, "perfiles", "U9"))));
await t("B no borra el perfil de C", () => assertFails(deleteDoc(doc(B, "perfiles", "C"))));

console.log("solicitudes de compañero");
const req = (from, to, fromName, extra = {}) => Object.assign({ members: pair(from, to), from, to, fromName, toName: U[to] ? U[to].name : "x", status: "pendiente", createdAt: serverTimestamp() }, extra);
await t("B envía solicitud a C", () => assertSucceeds(setDoc(doc(B, "conexiones", pid("B", "C")), req("B", "C", "Beto"))));
await t("no se crea con id equivocado", () => assertFails(setDoc(doc(B, "conexiones", "C_B"), req("B", "A", "Beto"))));
await t("no se crea con miembros desordenados", () => assertFails(setDoc(doc(B, "conexiones", pid("B", "A")), req("B", "A", "Beto", { members: ["B", "A"] }))));
await t("no se crea con nombre falso", () => assertFails(setDoc(doc(B, "conexiones", pid("B", "A")), req("B", "A", "Otro"))));
await t("no se crea ya aceptada", () => assertFails(setDoc(doc(B, "conexiones", pid("B", "A")), req("B", "A", "Beto", { status: "aceptada" }))));
await t("no se envía a alguien sin perfil (pendiente)", () => assertFails(setDoc(doc(B, "conexiones", pid("B", "D")), req("B", "D", "Beto"))));
await t("no se envía a uno mismo", () => assertFails(setDoc(doc(B, "conexiones", "B_B"), req("B", "B", "Beto", { members: ["B", "B"] }))));
await t("D (pendiente) no envía solicitudes", () => assertFails(setDoc(doc(D, "conexiones", pid("D", "C")), req("D", "C", "Dani Pendiente"))));
await t("C ve la solicitud", () => assertSucceeds(getDoc(doc(C, "conexiones", pid("B", "C")))));
await t("A (admin, ajeno) no ve la solicitud", () => assertFails(getDoc(doc(A, "conexiones", pid("B", "C")))));
await t("B lista sus conexiones", () => assertSucceeds(getDocs(query(collection(B, "conexiones"), where("members", "array-contains", "B")))));
await t("B no lista todas las conexiones", () => assertFails(getDocs(collection(B, "conexiones"))));
await t("B (quien la envió) no se la acepta solo", () => assertFails(updateDoc(doc(B, "conexiones", pid("B", "C")), { status: "aceptada", acceptedAt: serverTimestamp() })));
await t("C no cambia otros datos al aceptar", () => assertFails(updateDoc(doc(C, "conexiones", pid("B", "C")), { status: "aceptada", acceptedAt: serverTimestamp(), fromName: "x" })));
await t("C acepta la solicitud", () => assertSucceeds(updateDoc(doc(C, "conexiones", pid("B", "C")), { status: "aceptada", acceptedAt: serverTimestamp() })));
await t("B envía solicitud a A y A la rechaza (borra)", async () => {
  await assertSucceeds(setDoc(doc(B, "conexiones", pid("B", "A")), req("B", "A", "Beto")));
  await assertSucceeds(deleteDoc(doc(A, "conexiones", pid("B", "A"))));
});
await t("un ajeno no borra la conexión", () => assertFails(deleteDoc(doc(A, "conexiones", pid("B", "C")))));

console.log("chat directo");
const direct = (a, b, by) => ({ type: "directo", members: pair(a, b), createdBy: by, createdAt: serverTimestamp() });
await t("B abre chat con C (compañeros)", () => assertSucceeds(setDoc(doc(B, "chats", pid("B", "C")), direct("B", "C", "B"))));
await t("B no abre chat con A (no son compañeros)", () => assertFails(setDoc(doc(B, "chats", pid("B", "A")), direct("B", "A", "B"))));
await t("A no crea un chat ajeno entre B y C", () => assertFails(setDoc(doc(A, "chats", "x"), direct("B", "C", "A"))));
const msg = (from, name, text = "Hola") => ({ from, fromName: name, text, at: serverTimestamp() });
const bc = pid("B", "C");
await t("B envía mensaje + actualiza el último (lote)", async () => {
  const b = writeBatch(B);
  b.set(doc(collection(B, "chats", bc, "mensajes")), msg("B", "Beto"));
  b.update(doc(B, "chats", bc), { lastText: "Hola", lastAt: serverTimestamp(), lastFrom: "B", lastFromName: "Beto" });
  await assertSucceeds(b.commit());
});
await t("C lee los mensajes", () => assertSucceeds(getDocs(query(collection(C, "chats", bc, "mensajes"), orderBy("at", "desc"), limit(50)))));
await t("C lista sus chats", () => assertSucceeds(getDocs(query(collection(C, "chats"), where("members", "array-contains", "C")))));
await t("A (ajeno) no lee los mensajes", () => assertFails(getDocs(collection(A, "chats", bc, "mensajes"))));
await t("A (ajeno) no lee el chat", () => assertFails(getDoc(doc(A, "chats", bc))));
await t("A (ajeno) no escribe en el chat", () => assertFails(addDoc(collection(A, "chats", bc, "mensajes"), msg("A", "Ana Admin"))));
await t("B no firma como C", () => assertFails(addDoc(collection(B, "chats", bc, "mensajes"), msg("C", "Carla"))));
await t("B no usa otro nombre", () => assertFails(addDoc(collection(B, "chats", bc, "mensajes"), msg("B", "Carla"))));
await t("mensaje vacío no", () => assertFails(addDoc(collection(B, "chats", bc, "mensajes"), msg("B", "Beto", ""))));
await t("mensaje de más de 1000 letras no", () => assertFails(addDoc(collection(B, "chats", bc, "mensajes"), msg("B", "Beto", "x".repeat(1001)))));
await t("B no pone el último mensaje a nombre de C", () => assertFails(updateDoc(doc(B, "chats", bc), { lastText: "x", lastAt: serverTimestamp(), lastFrom: "C", lastFromName: "Carla" })));
await t("B no cambia los miembros de un chat directo", () => assertFails(updateDoc(doc(B, "chats", bc), { members: ["B", "C", "U1"] })));
await t("no se editan mensajes", async () => {
  const snap = await getDocs(collection(B, "chats", bc, "mensajes"));
  await assertFails(updateDoc(doc(B, "chats", bc, "mensajes", snap.docs[0].id), { text: "cambiado" }));
});
await t("no se borran mensajes", async () => {
  const snap = await getDocs(collection(B, "chats", bc, "mensajes"));
  await assertFails(deleteDoc(doc(B, "chats", bc, "mensajes", snap.docs[0].id)));
});
await t("D (pendiente) no lee chats", () => assertFails(getDocs(query(collection(D, "chats"), where("members", "array-contains", "D")))));

console.log("grupos");
const grp = (by, members, name = "Ventas") => ({ type: "grupo", members, name, createdBy: by, createdAt: serverTimestamp() });
const g1 = doc(collection(B, "chats"));
await t("B crea grupo con C", () => assertSucceeds(setDoc(g1, grp("B", ["B", "C"]))));
await t("B no mete a A (no es su compañero)", () => assertFails(setDoc(doc(collection(B, "chats")), grp("B", ["B", "C", "A"]))));
await t("el creador debe ir primero", () => assertFails(setDoc(doc(collection(B, "chats")), grp("B", ["C", "B"]))));
await t("sin repetidos", () => assertFails(setDoc(doc(collection(B, "chats")), grp("B", ["B", "C", "C"]))));
await t("sin nombre no", () => assertFails(setDoc(doc(collection(B, "chats")), grp("B", ["B", "C"], ""))));
await t("B crea grupo grande (con 8 compañeros)", () => assertSucceeds(setDoc(doc(collection(B, "chats")), grp("B", ["B", "U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"]))));
await t("más de 9 al crear no (se agregan después)", () => assertFails(setDoc(doc(collection(B, "chats")), grp("B", ["B", "C", "U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"]))));
// A y C se hacen compañeros
await env.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), "conexiones", pid("A", "C")), { members: pair("A", "C"), from: "A", to: "C", fromName: "Ana Admin", toName: "Carla", status: "aceptada" });
});
const g1id = g1.id;
await t("B no agrega a A (no es su compañero)", () => assertFails(updateDoc(doc(B, "chats", g1id), { members: ["B", "C", "A"] })));
await t("C agrega a A (compañera de C)", () => assertSucceeds(updateDoc(doc(C, "chats", g1id), { members: ["B", "C", "A"] })));
await t("no se agrega a alguien repetido", () => assertFails(updateDoc(doc(C, "chats", g1id), { members: ["B", "C", "A", "A"] })));
await t("A lee el grupo y sus mensajes", async () => {
  await assertSucceeds(getDoc(doc(A, "chats", g1id)));
  await assertSucceeds(getDocs(collection(A, "chats", g1id, "mensajes")));
});
await t("A escribe en el grupo", () => assertSucceeds(addDoc(collection(A, "chats", g1id, "mensajes"), msg("A", "Ana Admin", "Hola grupo"))));
await t("A no saca a C del grupo", () => assertFails(updateDoc(doc(A, "chats", g1id), { members: ["B", "A"] })));
await t("A se sale del grupo", () => assertSucceeds(updateDoc(doc(A, "chats", g1id), { members: ["B", "C"] })));
await t("A ya no escribe en el grupo", () => assertFails(addDoc(collection(A, "chats", g1id, "mensajes"), msg("A", "Ana Admin", "sigo?"))));
await t("A ya no lee el grupo", () => assertFails(getDocs(collection(A, "chats", g1id, "mensajes"))));
await t("un ajeno (U1) no se mete al grupo", () => assertFails(updateDoc(doc(as("U1"), "chats", g1id), { members: ["B", "C", "U1"] })));
await t("nadie borra un grupo", () => assertFails(deleteDoc(doc(B, "chats", g1id))));

console.log("quitar compañero");
await t("C quita a B de compañeros", () => assertSucceeds(deleteDoc(doc(C, "conexiones", bc))));
await t("B ya no puede escribirle a C", () => assertFails(addDoc(collection(B, "chats", bc, "mensajes"), msg("B", "Beto", "¿sigues?"))));
await t("en el grupo sí siguen hablando", () => assertSucceeds(addDoc(collection(B, "chats", g1id, "mensajes"), msg("B", "Beto", "hola grupo"))));

console.log("supervisión (solo Rafael)");
const R = as(RAFA);
await t("Rafael lee un chat directo ajeno", () => assertSucceeds(getDoc(doc(R, "chats", bc))));
await t("Rafael lista todos los chats", () => assertSucceeds(getDocs(collection(R, "chats"))));
await t("Rafael lee los mensajes de un chat directo ajeno", () => assertSucceeds(getDocs(query(collection(R, "chats", bc, "mensajes"), orderBy("at", "desc"), limit(80)))));
await t("Rafael lee los mensajes de un grupo ajeno", () => assertSucceeds(getDocs(collection(R, "chats", g1id, "mensajes"))));
await t("Rafael no escribe en un chat ajeno", () => assertFails(addDoc(collection(R, "chats", g1id, "mensajes"), msg(RAFA, "Rafael Supervisor"))));
await t("Rafael no cambia el último mensaje de un chat ajeno", () => assertFails(updateDoc(doc(R, "chats", g1id), { lastText: "x", lastAt: serverTimestamp(), lastFrom: RAFA, lastFromName: "Rafael Supervisor" })));
await t("Rafael no se mete a un grupo ajeno", () => assertFails(updateDoc(doc(R, "chats", g1id), { members: ["B", "C", RAFA] })));
await t("otra admin (Ana) no lista todos los chats", () => assertFails(getDocs(collection(A, "chats"))));
await t("otra admin (Ana) no lee mensajes ajenos", () => assertFails(getDocs(collection(A, "chats", bc, "mensajes"))));
await t("Rafael con correo sin confirmar no ve chats ajenos", () => assertFails(getDocs(collection(as(RAFA, false), "chats"))));
await t("Rafael no lee lo que leyó cada quien", () => assertFails(getDoc(doc(R, "lecturas", "B"))));

console.log("no leídos");
await t("B guarda lo que leyó", () => assertSucceeds(setDoc(doc(B, "lecturas", "B"), { c: { [bc]: serverTimestamp() } }, { merge: true })));
await t("B lee lo suyo", () => assertSucceeds(getDoc(doc(B, "lecturas", "B"))));
await t("C no lee lo de B", () => assertFails(getDoc(doc(C, "lecturas", "B"))));
await t("C no escribe lo de B", () => assertFails(setDoc(doc(C, "lecturas", "B"), { c: {} })));
await t("sin campos extra", () => assertFails(setDoc(doc(B, "lecturas", "B"), { c: {}, x: 1 })));

console.log("mapa: solo Autoservicio, Inventario y administración");
const zone = (who, name) => ({ items: arrayUnion("llave de paso 1/2"), updatedAt: serverTimestamp(), updatedBy: who, updatedByName: name });
const logm = (who, name) => ({ zone: "P1-A-arriba", action: "agregó", item: "llave de paso 1/2", by: who, byName: name, at: serverTimestamp() });
const INV = as("INV"), AUT = as("AUT");
await t("B (Ventas) ve el mapa", () => assertSucceeds(getDoc(doc(B, "mapa", "P1-A-arriba"))));
await t("B (Ventas) no edita el mapa", () => assertFails(setDoc(doc(B, "mapa", "P1-A-arriba"), zone("B", "Beto"), { merge: true })));
await t("B (Ventas) no escribe en el registro del mapa", () => assertFails(addDoc(collection(B, "mapaLog"), logm("B", "Beto"))));
await t("Inventario edita el mapa", () => assertSucceeds(setDoc(doc(INV, "mapa", "P1-A-arriba"), zone("INV", "Iván Inventario"), { merge: true })));
await t("Inventario deja registro", () => assertSucceeds(addDoc(collection(INV, "mapaLog"), logm("INV", "Iván Inventario"))));
await t("Autoservicio edita el mapa", () => assertSucceeds(setDoc(doc(AUT, "mapa", "P2-A-arriba"), zone("AUT", "Aura Autoservicio"), { merge: true })));
await t("Autoservicio mueve un artículo (lote de 2 lugares + registro)", async () => {
  const b = writeBatch(AUT);
  b.set(doc(AUT, "mapa", "P2-A-arriba"), { items: arrayRemove("llave de paso 1/2"), updatedAt: serverTimestamp(), updatedBy: "AUT", updatedByName: "Aura Autoservicio" }, { merge: true });
  b.set(doc(AUT, "mapa", "P3-B-abajo"), { items: arrayUnion("llave de paso 1/2"), updatedAt: serverTimestamp(), updatedBy: "AUT", updatedByName: "Aura Autoservicio" }, { merge: true });
  b.set(doc(collection(AUT, "mapaLog")), { zone: "P3-B-abajo", action: "movió", item: "llave de paso 1/2 (desde x)", by: "AUT", byName: "Aura Autoservicio", at: serverTimestamp() });
  await assertSucceeds(b.commit());
});
await t("admin (cargo Ventas) edita el mapa", () => assertSucceeds(setDoc(doc(A, "mapa", "P4-A-arriba"), zone("A", "Ana Admin"), { merge: true })));
await t("D (pendiente) no edita el mapa aunque sea Inventario", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), "users", "D"), { cargo: "Inventario" }); });
  await assertFails(setDoc(doc(D, "mapa", "P1-A-arriba"), zone("D", "Dani Pendiente"), { merge: true }));
});
await t("no se firma el cambio del mapa a nombre de otro", () => assertFails(setDoc(doc(INV, "mapa", "P1-A-arriba"), zone("B", "Beto"), { merge: true })));

console.log("cargos: solo los cambia el administrador");
await t("B no se cambia el cargo a Inventario", () => assertFails(updateDoc(doc(B, "users", "B"), { cargo: "Inventario", updatedAt: serverTimestamp() })));
await t("B sí cambia su nombre y teléfono", () => assertSucceeds(updateDoc(doc(B, "users", "B"), { name: "Beto", phone: "0414", updatedAt: serverTimestamp() })));
await t("B no pone otro cargo en su perfil público", () => assertFails(setDoc(doc(B, "perfiles", "B"), { name: "Beto", cargo: "Inventario", icon: "llave", updatedAt: serverTimestamp() })));
await t("la admin le cambia el cargo a B", () => assertSucceeds(updateDoc(doc(A, "users", "B"), { cargo: "Inventario" })));
await t("con el cargo nuevo, B ya edita el mapa", () => assertSucceeds(setDoc(doc(B, "mapa", "P5-A-arriba"), zone("B", "Beto"), { merge: true })));
await t("y actualiza su perfil público con el cargo nuevo", () => assertSucceeds(setDoc(doc(B, "perfiles", "B"), { name: "Beto", cargo: "Inventario", icon: "llave", updatedAt: serverTimestamp() })));
await t("la admin cambia su propio cargo", () => assertSucceeds(updateDoc(doc(A, "users", "A"), { cargo: "Sistema", updatedAt: serverTimestamp() })));
await t("la admin no pone un cargo de más de 40 letras", () => assertFails(updateDoc(doc(A, "users", "C"), { cargo: "x".repeat(41) })));
await t("B no le cambia el cargo a C", () => assertFails(updateDoc(doc(B, "users", "C"), { cargo: "Caja" })));

console.log("un solo administrador");
await t("la admin no nombra administrador a C", () => assertFails(updateDoc(doc(A, "users", "C"), { role: "admin" })));
await t("la admin no le quita el rol a otro admin", () => assertFails(updateDoc(doc(A, "users", RAFA), { role: "empleado" })));
await t("nadie se nombra administrador a sí mismo", () => assertFails(updateDoc(doc(C, "users", "C"), { role: "admin", updatedAt: serverTimestamp() })));
await t("la admin aún aprueba o quita acceso", () => assertSucceeds(updateDoc(doc(A, "users", "C"), { status: "bloqueado" })));

console.log("presupuesto de las calculadoras (Profit)");
const pres = (by, map = { "saco(s) de cemento 42,5 kg": "CEM001" }) => ({ map, updatedBy: by, updatedAt: serverTimestamp() });
await t("la admin elige el artículo de Profit para todos", () => assertSucceeds(setDoc(doc(A, "config", "presupuesto"), pres("A"))));
await t("un empleado lee las elecciones", () => assertSucceeds(getDoc(doc(INV, "config", "presupuesto"))));
await t("un pendiente no las lee", () => assertFails(getDoc(doc(D, "config", "presupuesto"))));
await t("un empleado no las cambia", () => assertFails(setDoc(doc(INV, "config", "presupuesto"), pres("INV"))));
await t("la admin no firma a nombre de otro", () => assertFails(setDoc(doc(A, "config", "presupuesto"), pres("B"))));
await t("ni agrega campos extra", () => assertFails(setDoc(doc(A, "config", "presupuesto"), Object.assign(pres("A"), { x: 1 }))));

console.log("estado del sistema");
await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), "monitor", "resumen"), { today: { reads: 1 } }); });
await t("la admin ve el estado del sistema", () => assertSucceeds(getDoc(doc(A, "monitor", "resumen"))));
await t("un empleado no ve el estado del sistema", () => assertFails(getDoc(doc(INV, "monitor", "resumen"))));
await t("nadie lo escribe desde la app", () => assertFails(setDoc(doc(A, "monitor", "resumen"), { today: { reads: 0 } })));

console.log("avisos y soporte");
const aviso = (who, name, extra = {}) => Object.assign({ titulo: "Inventario el sábado", texto: "Todos a las 7 am.", tipo: "sistema", by: who, byName: name, at: serverTimestamp() }, extra);
await t("la admin publica un aviso", () => assertSucceeds(setDoc(doc(A, "avisos", "a1"), aviso("A", "Ana Admin"))));
await t("un empleado no publica avisos", () => assertFails(setDoc(doc(INV, "avisos", "a2"), aviso("INV", "Iván Inventario"))));
await t("tipo de aviso inválido no", () => assertFails(setDoc(doc(A, "avisos", "a3"), aviso("A", "Ana Admin", { tipo: "spam" }))));
await t("un empleado lee los avisos", () => assertSucceeds(getDocs(collection(INV, "avisos"))));
await t("un pendiente no lee avisos", () => assertFails(getDocs(collection(D, "avisos"))));
await t("un empleado no borra avisos", () => assertFails(deleteDoc(doc(INV, "avisos", "a1"))));
await t("la admin borra un aviso", () => assertSucceeds(deleteDoc(doc(A, "avisos", "a1"))));
const rep = (who, name, extra = {}) => Object.assign({ uid: who, nombre: name, tipo: "fallo", texto: "No carga el mapa", version: "Versión 26", pantalla: "mapa", equipo: "Android", estado: "nuevo", at: serverTimestamp() }, extra);
await t("un empleado reporta un fallo", () => assertSucceeds(setDoc(doc(INV, "reportes", "r1"), rep("INV", "Iván Inventario"))));
await t("no reporta a nombre de otro", () => assertFails(setDoc(doc(INV, "reportes", "r2"), rep("AUT", "Aura Autoservicio"))));
await t("no crea un reporte ya resuelto", () => assertFails(setDoc(doc(INV, "reportes", "r3"), rep("INV", "Iván Inventario", { estado: "resuelto" }))));
await t("ve su propio reporte", () => assertSucceeds(getDoc(doc(INV, "reportes", "r1"))));
await t("lista sus reportes", () => assertSucceeds(getDocs(query(collection(INV, "reportes"), where("uid", "==", "INV")))));
await t("otro empleado no ve el reporte", () => assertFails(getDoc(doc(AUT, "reportes", "r1"))));
await t("la admin ve todos los reportes", () => assertSucceeds(getDocs(collection(A, "reportes"))));
await t("la admin responde", () => assertSucceeds(updateDoc(doc(A, "reportes", "r1"), { estado: "resuelto", respuesta: "Listo, ya carga.", respondidoAt: serverTimestamp() })));
await t("el empleado no cambia el estado", () => assertFails(updateDoc(doc(INV, "reportes", "r1"), { estado: "nuevo" })));
await t("guardar hasta dónde vio los avisos", () => assertSucceeds(setDoc(doc(INV, "lecturas", "INV"), { av: serverTimestamp() }, { merge: true })));

console.log("fotos, medallas y capacitación");
const foto = "data:image/jpeg;base64," + "A".repeat(2000);
await t("B pone una foto en su perfil", () => assertSucceeds(setDoc(doc(B, "perfiles", "B"), { foto, updatedAt: serverTimestamp() }, { merge: true })));
await t("B no pone algo que no es una foto", () => assertFails(setDoc(doc(B, "perfiles", "B"), { foto: "<script>", updatedAt: serverTimestamp() }, { merge: true })));
await t("B no pone una foto gigante", () => assertFails(setDoc(doc(B, "perfiles", "B"), { foto: "data:image/jpeg;base64," + "A".repeat(50000), updatedAt: serverTimestamp() }, { merge: true })));
await t("B guarda sus medallas", () => assertSucceeds(setDoc(doc(B, "perfiles", "B"), { medallas: 3, updatedAt: serverTimestamp() }, { merge: true })));
await t("B guarda cuántos compañeros tiene", () => assertSucceeds(setDoc(doc(B, "perfiles", "B"), { companeros: 5, updatedAt: serverTimestamp() }, { merge: true })));
await t("medallas negativas no", () => assertFails(setDoc(doc(B, "perfiles", "B"), { medallas: -1, updatedAt: serverTimestamp() }, { merge: true })));
await t("Inventario ve la foto y las medallas de B", () => assertSucceeds(getDoc(doc(INV, "perfiles", "B"))));
await t("B guarda una lección aprobada", () => assertSucceeds(setDoc(doc(B, "capacitaciones", "B"), { hechas: { salitre: { nota: 3, at: serverTimestamp() } } }, { merge: true })));
await t("C no escribe las lecciones de B", () => assertFails(setDoc(doc(C, "capacitaciones", "B"), { hechas: {} })));
await t("la admin ve las lecciones de B", () => assertSucceeds(getDoc(doc(A, "capacitaciones", "B"))));

console.log("vehículos");
const MEC = as("MEC"), GER = as("GER");
const veh = (who, name, extra = {}) => Object.assign({ placa: "A12BC3D", tipo: "camion", marca: "Ford", modelo: "Cargo 815", anio: 2012, color: "Blanco", km: 150000, estado: "operativo", notas: "", creadoPor: who, creadoPorNombre: name, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: who, updatedByName: name }, extra);
await t("un mecánico agrega un vehículo", () => assertSucceeds(setDoc(doc(MEC, "vehiculos", "v1"), veh("MEC", "Mario Mecánico"))));
await t("ventas no agrega vehículos", () => assertFails(setDoc(doc(INV, "vehiculos", "v2"), veh("INV", "Iván Inventario"))));
await t("gerencia no agrega vehículos", () => assertFails(setDoc(doc(GER, "vehiculos", "v3"), veh("GER", "Gina Gerencia"))));
await t("gerencia ve los vehículos", () => assertSucceeds(getDocs(collection(GER, "vehiculos"))));
await t("inventario no ve los vehículos", () => assertFails(getDocs(collection(INV, "vehiculos"))));
await t("tipo inválido no", () => assertFails(setDoc(doc(MEC, "vehiculos", "v4"), veh("MEC", "Mario Mecánico", { tipo: "avion" }))));
await t("el mecánico lo pasa a taller", () => assertSucceeds(updateDoc(doc(MEC, "vehiculos", "v1"), { estado: "taller", km: 150500, updatedAt: serverTimestamp(), updatedBy: "MEC", updatedByName: "Mario Mecánico" })));
await t("no cambia quién lo creó", () => assertFails(updateDoc(doc(MEC, "vehiculos", "v1"), { creadoPor: "X", updatedAt: serverTimestamp(), updatedBy: "MEC", updatedByName: "Mario Mecánico" })));
await t("el mecánico no borra", () => assertFails(deleteDoc(doc(MEC, "vehiculos", "v1"))));
await t("la admin borra", () => assertSucceeds(deleteDoc(doc(A, "vehiculos", "v1"))));

console.log("mantenimientos, revisiones y faltantes");
const CHO = as("CHO"), COM = as("COM");
await setDoc(doc(MEC, "vehiculos", "v9"), veh("MEC", "Mario Mecánico"));
const mant = (who, name, extra = {}) => Object.assign({ vehiculoId: "v9", placa: "A12BC3D", fecha: "2026-09-30", tipo: "aceite", km: 150000, detalle: "Aceite 15W40", by: who, byName: name, at: serverTimestamp() }, extra);
await t("el mecánico registra un mantenimiento", () => assertSucceeds(addDoc(collection(MEC, "mantenimientos"), mant("MEC", "Mario Mecánico"))));
await t("el chofer no registra mantenimientos", () => assertFails(addDoc(collection(CHO, "mantenimientos"), mant("CHO", "Carlos Chofer"))));
await t("mantenimiento de un vehículo que no existe no", () => assertFails(addDoc(collection(MEC, "mantenimientos"), mant("MEC", "Mario Mecánico", { vehiculoId: "nope" }))));
await t("el chofer ve los vehículos", () => assertSucceeds(getDocs(collection(CHO, "vehiculos"))));
await t("el chofer no edita vehículos", () => assertFails(updateDoc(doc(CHO, "vehiculos", "v9"), { km: 1, updatedAt: serverTimestamp(), updatedBy: "CHO", updatedByName: "Carlos Chofer" })));
const rev = (who, name, extra = {}) => Object.assign({ vehiculoId: "v9", placa: "A12BC3D", puntos: { cauchos: true, luces: false }, fallas: 1, km: 150100, combustible: "1/2", nota: "Luz de cruce izquierda", by: who, byName: name, at: serverTimestamp() }, extra);
await t("el chofer hace la revisión diaria", () => assertSucceeds(addDoc(collection(CHO, "revisiones"), rev("CHO", "Carlos Chofer"))));
await t("ventas no hace revisiones", () => assertFails(addDoc(collection(INV, "revisiones"), rev("INV", "Iván Inventario"))));
await t("el mecánico ve las revisiones", () => assertSucceeds(getDocs(collection(MEC, "revisiones"))));
const falt = (who, name, extra = {}) => Object.assign({ producto: "Silicón transparente", nota: "", by: who, byName: name, at: serverTimestamp(), estado: "pendiente" }, extra);
await t("cualquiera anota un faltante", () => assertSucceeds(setDoc(doc(INV, "faltantes", "f1"), falt("INV", "Iván Inventario"))));
await t("no se anota a nombre de otro", () => assertFails(setDoc(doc(INV, "faltantes", "f2"), falt("COM", "Coral Compras"))));
await t("compras ve todos los faltantes", () => assertSucceeds(getDocs(collection(COM, "faltantes"))));
await t("ventas no ve todos los faltantes", () => assertFails(getDocs(collection(AUT, "faltantes"))));
await t("compras lo marca pedido", () => assertSucceeds(updateDoc(doc(COM, "faltantes", "f1"), { estado: "pedido" })));
await t("inventario no lo marca", () => assertFails(updateDoc(doc(INV, "faltantes", "f1"), { estado: "descartado" })));

console.log("palomitas y escribiendo");
await t("B marca recibido y leído en su grupo", () => assertSucceeds(updateDoc(doc(B, "chats", g1id), { "recibido.B": serverTimestamp(), "leido.B": serverTimestamp() })));
await t("B no marca como leído a nombre de otro", () => assertFails(updateDoc(doc(B, "chats", g1id), { "leido.U1": serverTimestamp() })));
await t("un ajeno no marca leído", () => assertFails(updateDoc(doc(INV, "chats", g1id), { "leido.INV": serverTimestamp() })));

console.log("uso de la app");
const usoB = (extra = {}) => Object.assign({ name: "Beto", ultimaVez: serverTimestamp(), aparato: "iPhone", instalada: true, version: "CC/1.0 · v43",
  aperturas: increment(1), min: { "2026-10-01": increment(5) } }, extra);
await t("B guarda su uso", () => assertSucceeds(setDoc(doc(B, "uso", "B"), usoB({ ingresos: increment(1), ultimoIngreso: serverTimestamp() }), { merge: true })));
await t("B suma minutos otra vez", () => assertSucceeds(setDoc(doc(B, "uso", "B"), usoB(), { merge: true })));
await t("B lee el suyo", () => assertSucceeds(getDoc(doc(B, "uso", "B"))));
await t("B no escribe el de C", () => assertFails(setDoc(doc(B, "uso", "C"), usoB(), { merge: true })));
await t("C no lee el de B", () => assertFails(getDoc(doc(C, "uso", "B"))));
await t("C no ve la lista", () => assertFails(getDocs(collection(C, "uso"))));
await t("el admin ve la lista", () => assertSucceeds(getDocs(collection(A, "uso"))));
await t("sin hora del servidor no", () => assertFails(setDoc(doc(B, "uso", "B"), usoB({ ultimaVez: new Date(2020, 0, 1) }), { merge: true })));
await t("sin campos extra", () => assertFails(setDoc(doc(B, "uso", "B"), usoB({ role: "admin" }), { merge: true })));
await t("aparato muy largo no", () => assertFails(setDoc(doc(B, "uso", "B"), usoB({ aparato: "x".repeat(40) }), { merge: true })));
await t("pendiente no guarda uso", () => assertFails(setDoc(doc(D, "uso", "D"), Object.assign(usoB(), { name: "Dani" }), { merge: true })));
await t("nadie lo borra", () => assertFails(deleteDoc(doc(B, "uso", "B"))));

console.log("código 5");
{
  const AUT = as("AUT"), ts = serverTimestamp();
  const AU2 = as("A"), nuevo = (extra = {}) => ({ codigo: 5, pedido: "25 m de cable", destino: "Chequeo", nota: "", by: "B", byName: "Beto", at: ts, estado: "abierto", ...extra });
  await t("Ventas no pide Código 5", () => assertFails(setDoc(doc(B, "codigos", "k0"), nuevo())));
  await t("destino muy largo no", () => assertFails(setDoc(doc(AU2, "codigos", "k0"), nuevo({ by: "A", byName: "Ana Admin", destino: "x".repeat(31) }))));
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), "codigos", "k1"), { ...nuevo(), at: new Date() }); });
  await t("no se pide a nombre de otro", () => assertFails(setDoc(doc(B, "codigos", "k2"), nuevo({ by: "C", byName: "Carla" }))));
  await t("no se crea ya aceptado", () => assertFails(setDoc(doc(B, "codigos", "k2"), nuevo({ estado: "aceptado" }))));
  await t("Autoservicio pide un Código 5 a pasillo", () => assertSucceeds(setDoc(doc(as("AUT"), "codigos", "k9"), nuevo({ by: "AUT", byName: "Aura Autoservicio", destino: "Pasillo 4" }))));
  await t("Autoservicio pide un Código 8", () => assertSucceeds(setDoc(doc(as("AUT"), "codigos", "k8"), nuevo({ codigo: 8, by: "AUT", byName: "Aura Autoservicio" }))));
  await t("no existe el Código 9", () => assertFails(setDoc(doc(as("AUT"), "codigos", "k10"), nuevo({ codigo: 9, by: "AUT", byName: "Aura Autoservicio" }))));
  await t("D (pendiente) no pide", () => assertFails(setDoc(doc(D, "codigos", "k2"), nuevo({ by: "D", byName: "Dani Pendiente" }))));
  await t("Inventario lee los códigos", () => assertSucceeds(getDoc(doc(as("INV"), "codigos", "k1"))));
  await t("C (Ventas) no acepta", () => assertFails(updateDoc(doc(C, "codigos", "k1"), { estado: "aceptado", tomadoPor: "C", tomadoPorNombre: "Carla", tomadoAt: ts })));
  await t("Autoservicio rechaza (solo para sí)", () => assertSucceeds(updateDoc(doc(AUT, "codigos", "k1"), { rechazos: ["AUT"] })));
  await t("no rechaza por otro", () => assertFails(updateDoc(doc(AUT, "codigos", "k1"), { rechazos: ["AUT", "INV"] })));
  await t("Autoservicio no lo acepta a nombre de otro", () => assertFails(updateDoc(doc(AUT, "codigos", "k1"), { estado: "aceptado", tomadoPor: "C", tomadoPorNombre: "Carla", tomadoAt: ts })));
  await t("Autoservicio acepta", () => assertSucceeds(updateDoc(doc(AUT, "codigos", "k1"), { estado: "aceptado", tomadoPor: "AUT", tomadoPorNombre: "Aura Autoservicio", tomadoAt: ts })));
  await t("el admin ya no lo acepta (está tomado)", () => assertFails(updateDoc(doc(A, "codigos", "k1"), { estado: "aceptado", tomadoPor: "A", tomadoPorNombre: "Ana Admin", tomadoAt: ts })));
  await t("quien lo pidió no lo marca llevado", () => assertFails(updateDoc(doc(B, "codigos", "k1"), { estado: "llevado", finAt: ts })));
  await t("quien lo aceptó lo marca llevado", () => assertSucceeds(updateDoc(doc(AUT, "codigos", "k1"), { estado: "llevado", finAt: ts })));
  await t("ya llevado no se cancela", () => assertFails(updateDoc(doc(B, "codigos", "k1"), { estado: "cancelado", finAt: ts })));
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), "codigos", "k3"), { ...nuevo(), at: new Date() }); });
  await t("C no cancela el de B", () => assertFails(updateDoc(doc(C, "codigos", "k3"), { estado: "cancelado", finAt: ts })));
  await t("B cancela el suyo", () => assertSucceeds(updateDoc(doc(B, "codigos", "k3"), { estado: "cancelado", finAt: ts })));
  await t("B no lo borra", () => assertFails(deleteDoc(doc(B, "codigos", "k3"))));
  await t("contar los llevados de AUT", async () => {
    const s = await assertSucceeds(getDocs(query(collection(AUT, "codigos"), where("tomadoPor", "==", "AUT"), where("estado", "==", "llevado"))));
    if (s.size !== 1) throw new Error("esperaba 1, hay " + s.size);
  });
  await t("AUT guarda c5 en su perfil", () => assertSucceeds(setDoc(doc(AUT, "perfiles", "AUT"), { c5: 1, updatedAt: ts }, { merge: true })));
  await t("c5 no puede ser texto", () => assertFails(setDoc(doc(AUT, "perfiles", "AUT"), { c5: "9", updatedAt: ts }, { merge: true })));
}
console.log("avisos con la app cerrada");
// (A esta altura C ya está bloqueada y D sigue pendiente.)
const LLAVE = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "config", "push"), { publicKey: LLAVE, updatedAt: new Date() });
  // Equipo de E, guardado cuando aún estaba aprobada
  await setDoc(doc(db, "push", "E_eeeeeeeeeeeeeeee"), { uid: "E", dev: "eeeeeeeeeeeeeeee", endpoint: "https://fcm.googleapis.com/fcm/send/e", p256dh: LLAVE, auth: "tBHItJI5svbpez7KI4CCXg", ua: "x", at: new Date() });
  await setDoc(doc(db, "push", "INVX_aaaaaaaaaaaaaaaa"), { uid: "INVX", dev: "aaaaaaaaaaaaaaaa", endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: LLAVE, auth: "tBHItJI5svbpez7KI4CCXg", ua: "x", at: new Date() });
});
const DEV = "k3j9x0p2m7q1z8w4";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/dX1y-Z_2:APA91bH7xQ";
const pushDoc = (uid, dev = DEV, extra = {}) => Object.assign({ uid, dev, endpoint: ENDPOINT, p256dh: LLAVE, auth: "tBHItJI5svbpez7KI4CCXg",
  ua: "Mozilla/5.0 (Linux; Android 14) Chrome/130", at: serverTimestamp() }, extra);
const pushRef = (db, uid, dev = DEV) => doc(db, "push", uid + "_" + dev);
// Guardar
await t("B activa los avisos en su equipo", () => assertSucceeds(setDoc(pushRef(B, "B"), pushDoc("B"))));
await t("B lo vuelve a guardar con otra dirección", () => assertSucceeds(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { endpoint: "https://web.push.apple.com/QGx-y_z1" }))));
await t("B cambia solo la dirección (con la hora del servidor)", () => assertSucceeds(updateDoc(pushRef(B, "B"), { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/gAAAA", at: serverTimestamp() })));
await t("B al cambiarla sin la hora del servidor no", () => assertFails(updateDoc(pushRef(B, "B"), { endpoint: ENDPOINT })));
await t("B activa los avisos en otro equipo", () => assertSucceeds(setDoc(pushRef(B, "B", "otroequipo123"), pushDoc("B", "otroequipo123"))));
await t("la admin activa los suyos", () => assertSucceeds(setDoc(pushRef(A, "A"), pushDoc("A"))));
await t("el mecánico activa los suyos (dirección de Windows con ?token=)", () => assertSucceeds(setDoc(pushRef(MEC, "MEC"), pushDoc("MEC", DEV, { endpoint: "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2bXy" }))));
await t("dirección de 800 letras sí", () => assertSucceeds(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { endpoint: "https://fcm.googleapis.com/" + "a".repeat(800 - 27) }))));
// Quién y con qué id
await t("id que no empieza con su uid no", () => assertFails(setDoc(pushRef(B, "C"), pushDoc("B"))));
await t("id con otro equipo no", () => assertFails(setDoc(pushRef(B, "B", "otroequipo999"), pushDoc("B"))));
await t("id sin el equipo no", () => assertFails(setDoc(doc(B, "push", "B"), pushDoc("B"))));
await t("id sin guion bajo no", () => assertFails(setDoc(doc(B, "push", "B" + DEV), pushDoc("B"))));
await t("B no guarda a nombre de C (id de C)", () => assertFails(setDoc(pushRef(B, "C"), pushDoc("C"))));
await t("B no pone el uid de otro en su documento", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("C"))));
await t("la admin no guarda el equipo de otro", () => assertFails(setDoc(pushRef(A, "B", "deadmin12345"), pushDoc("B", "deadmin12345"))));
// Campos
for (const f of ["uid", "dev", "endpoint", "p256dh", "auth", "ua", "at"]){
  await t("faltando " + f + " no", () => { const d = pushDoc("B"); delete d[f]; return assertFails(setDoc(pushRef(B, "B"), d)); });
}
await t("sin campos extra", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { role: "admin" }))));
await t("equipo con mayúsculas no", () => assertFails(setDoc(pushRef(B, "B", "ABCdef123456"), pushDoc("B", "ABCdef123456"))));
await t("equipo muy corto no", () => assertFails(setDoc(pushRef(B, "B", "abc1234"), pushDoc("B", "abc1234"))));
await t("equipo muy largo no", () => assertFails(setDoc(pushRef(B, "B", "a".repeat(25)), pushDoc("B", "a".repeat(25)))));
await t("equipo con guion bajo no", () => assertFails(setDoc(pushRef(B, "B", "abcd_efgh1234"), pushDoc("B", "abcd_efgh1234"))));
await t("equipo que no es texto no", () => assertFails(setDoc(doc(B, "push", "B_12345678"), pushDoc("B", 12345678))));
await t("dirección http:// no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { endpoint: "http://fcm.googleapis.com/fcm/send/x" }))));
await t("dirección que no es web no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { endpoint: "javascript:alert(1)" }))));
await t("dirección con espacios no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { endpoint: "https://fcm.googleapis.com/fcm/send/a b" }))));
await t("dirección sin ruta no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { endpoint: "https://fcm.googleapis.com" }))));
await t("dirección de más de 800 letras no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { endpoint: "https://fcm.googleapis.com/" + "a".repeat(800 - 26) }))));
await t("dirección que no es texto no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { endpoint: 42 }))));
await t("p256dh muy corta no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { p256dh: "A".repeat(59) }))));
await t("p256dh muy larga no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { p256dh: "A".repeat(121) }))));
await t("p256dh con letras que no son base64url no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { p256dh: LLAVE.slice(0, 80) + "+/+/+/=" }))));
await t("p256dh que no es texto no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { p256dh: 7 }))));
await t("auth muy corta no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { auth: "a".repeat(15) }))));
await t("auth muy larga no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { auth: "a".repeat(41) }))));
await t("auth con letras que no son base64url no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { auth: "tBHItJI5svbpez7KI4CCXg==" }))));
await t("aparato (ua) de más de 120 letras no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { ua: "x".repeat(121) }))));
await t("aparato (ua) que no es texto no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { ua: true }))));
await t("hora puesta por el teléfono no", () => assertFails(setDoc(pushRef(B, "B"), pushDoc("B", DEV, { at: new Date() }))));
// Personas sin acceso
await t("D (pendiente) no activa avisos", () => assertFails(setDoc(pushRef(D, "D"), pushDoc("D"))));
await t("E (bloqueada) no activa avisos", () => assertFails(setDoc(pushRef(E, "E", "nuevoequipo1"), pushDoc("E", "nuevoequipo1"))));
await t("C (bloqueada) no activa avisos", () => assertFails(setDoc(pushRef(C, "C"), pushDoc("C"))));
await t("B con correo sin confirmar no activa avisos", () => assertFails(setDoc(pushRef(Bun, "B", "sinconfirmar1"), pushDoc("B", "sinconfirmar1"))));
await t("sin sesión no activa avisos", () => assertFails(setDoc(doc(anon, "push", "B_" + DEV), pushDoc("B"))));
// Leer: nadie desde la app
await t("B no lee su propio equipo", () => assertFails(getDoc(pushRef(B, "B"))));
await t("B no lista los suyos", () => assertFails(getDocs(query(collection(B, "push"), where("uid", "==", "B")))));
await t("la admin no lee el equipo de B", () => assertFails(getDoc(pushRef(A, "B"))));
await t("la admin no lee ni el suyo", () => assertFails(getDoc(pushRef(A, "A"))));
await t("Rafael no lista los equipos", () => assertFails(getDocs(collection(R, "push"))));
await t("sin sesión no lee", () => assertFails(getDoc(doc(anon, "push", "B_" + DEV))));
// Borrar
await t("otra persona (Inventario) no borra el de B", () => assertFails(deleteDoc(pushRef(INV, "B"))));
await t("la admin no borra el de B", () => assertFails(deleteDoc(pushRef(A, "B"))));
await t("Rafael no borra el de B", () => assertFails(deleteDoc(pushRef(R, "B"))));
await t("sin sesión no borra", () => assertFails(deleteDoc(doc(anon, "push", "B_" + DEV))));
await t("un uid que empieza igual no borra el de otro", () => assertFails(deleteDoc(doc(INV, "push", "INVX_aaaaaaaaaaaaaaaa"))));
await t("id con dos guiones bajos no se borra", () => assertFails(deleteDoc(doc(B, "push", "B_C_" + DEV))));
await t("B borra el suyo", () => assertSucceeds(deleteDoc(pushRef(B, "B"))));
await t("B borra el suyo aunque ya no exista", () => assertSucceeds(deleteDoc(pushRef(B, "B"))));
await t("B con correo sin confirmar borra el suyo", () => assertSucceeds(deleteDoc(pushRef(Bun, "B", "otroequipo123"))));
await t("E (bloqueada) borra el suyo", () => assertSucceeds(deleteDoc(doc(E, "push", "E_eeeeeeeeeeeeeeee"))));
await t("D (pendiente) borra el suyo aunque no exista", () => assertSucceeds(deleteDoc(pushRef(D, "D"))));
await t("y quedó borrado", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const s = await getDoc(doc(ctx.firestore(), "push", "E_eeeeeeeeeeeeeeee"));
    if (s.exists()) throw new Error("sigue ahí");
  });
});
// Llave pública (config/push)
await t("B (aprobado) lee la llave pública", async () => {
  const s = await assertSucceeds(getDoc(doc(B, "config", "push")));
  if (s.data().publicKey !== LLAVE) throw new Error("llave distinta");
});
await t("D (pendiente) no lee la llave", () => assertFails(getDoc(doc(D, "config", "push"))));
await t("E (bloqueada) no lee la llave", () => assertFails(getDoc(doc(E, "config", "push"))));
await t("B con correo sin confirmar no lee la llave", () => assertFails(getDoc(doc(Bun, "config", "push"))));
await t("sin sesión no lee la llave", () => assertFails(getDoc(doc(anon, "config", "push"))));
await t("nadie lista config", () => assertFails(getDocs(collection(B, "config"))));
await t("B no cambia la llave", () => assertFails(setDoc(doc(B, "config", "push"), { publicKey: "x", updatedAt: serverTimestamp() })));
await t("la admin no cambia la llave", () => assertFails(setDoc(doc(A, "config", "push"), { publicKey: "x", updatedAt: serverTimestamp() })));
await t("la admin no la edita", () => assertFails(updateDoc(doc(A, "config", "push"), { publicKey: "x" })));
await t("Rafael no cambia la llave", () => assertFails(setDoc(doc(R, "config", "push"), { publicKey: "x", updatedAt: serverTimestamp() })));
await t("la admin no borra la llave", () => assertFails(deleteDoc(doc(A, "config", "push"))));
await t("la lista de cargos se sigue leyendo sin sesión", () => assertSucceeds(getDoc(doc(anon, "config", "cargos"))));

console.log("Profit (puente)");
const PUENTE = readFileSync(DIR + "firestore.rules", "utf8").match(/function puente\(\) \{[^}]*request\.auth\.uid == "([^"]+)"/)[1];
const PU = env.authenticatedContext(PUENTE, { email: "puente@x.com", email_verified: false }).firestore();
const grupo = { datos: "[]", n: 0, hash: "abc", actualizado: serverTimestamp() };
const meta = { grupos: { g00: "abc" }, total: 0, actualizado: serverTimestamp(), almacenes: "A0101,A0201", precio: "05" };
await t("el puente escribe un grupo", () => assertSucceeds(setDoc(doc(PU, "profit", "g00"), grupo)));
await t("el puente escribe meta", () => assertSucceeds(setDoc(doc(PU, "profit", "meta"), meta)));
await t("el puente escribe agotados", () => assertSucceeds(setDoc(doc(PU, "profitAgotados", "a00"), grupo)));
await t("el puente no mete campos extra", () => assertFails(setDoc(doc(PU, "profit", "g01"), Object.assign({ x: 1 }, grupo))));
await t("el puente no escribe en el mapa", () => assertFails(setDoc(doc(PU, "mapa", "P1-A-arriba"), { items: [] })));
await t("el admin no escribe en profit", () => assertFails(setDoc(doc(A, "profit", "g02"), grupo)));
await t("un trabajador lee profit", () => assertSucceeds(getDoc(doc(B, "profit", "meta"))));
await t("pendiente no lee profit", () => assertFails(getDoc(doc(D, "profit", "meta"))));
await t("sin sesión no lee profit", () => assertFails(getDoc(doc(anon, "profit", "meta"))));
await t("compras lee agotados", () => assertSucceeds(getDoc(doc(as("COM"), "profitAgotados", "a00"))));
await t("gerencia lee agotados", () => assertSucceeds(getDoc(doc(as("GER"), "profitAgotados", "a00"))));
await t("el admin lee agotados", () => assertSucceeds(getDoc(doc(A, "profitAgotados", "a00"))));
await t("ventas no lee agotados", () => assertFails(getDoc(doc(B, "profitAgotados", "a00"))));

console.log("en línea (Realtime Database)");
const rt = (uid, verified = true) => env.authenticatedContext(uid, { email: uid + "@x.com", email_verified: verified }).database();
await t("B marca que está en línea", () => assertSucceeds(set(ref(rt("B"), "estado/B"), { on: true, t: Date.now() })));
await t("B no marca a C", () => assertFails(set(ref(rt("B"), "estado/C"), { on: true, t: Date.now() })));
await t("sin campos extra", () => assertFails(set(ref(rt("B"), "estado/B"), { on: true, t: 1, x: 2 })));
await t("faltando la hora no", () => assertFails(set(ref(rt("B"), "estado/B"), { on: true })));
await t("C ve quién está en línea", () => assertSucceeds(rget(ref(rt("C"), "estado"))));
await t("correo sin confirmar no ve", () => assertFails(rget(ref(rt("C", false), "estado"))));
await t("sin sesión no ve", () => assertFails(rget(ref(env.unauthenticatedContext().database(), "estado"))));
await t("B avisa que está escribiendo", () => assertSucceeds(set(ref(rt("B"), "escribiendo/chat1/B"), Date.now())));
await t("B no escribe por otro", () => assertFails(set(ref(rt("B"), "escribiendo/chat1/C"), Date.now())));
await t("nadie escribe fuera de estado", () => assertFails(set(ref(rt("B"), "otra/cosa"), 1)));

console.log("Sistema PF (COSEPF: no ve nada de Cose Coro)");
{
  const S = as("SPF");
  await t("Sistema PF lee su propia cuenta", () => assertSucceeds(getDoc(doc(S, "users", "SPF"))));
  await t("Sistema PF lee la lista de áreas", () => assertSucceeds(getDoc(doc(S, "config", "cargos"))));
  await t("Sistema PF no lee Profit", () => assertFails(getDoc(doc(S, "profit", "resumen"))));
  await t("Sistema PF no lee el mapa", () => assertFails(getDoc(doc(S, "mapa", "z1"))));
  await t("Sistema PF no lee perfiles", () => assertFails(getDoc(doc(S, "perfiles", "C"))));
  await t("Sistema PF no lee códigos", () => assertFails(getDocs(collection(S, "codigos"))));
  await t("Sistema PF no lee avisos", () => assertFails(getDocs(collection(S, "avisos"))));
  await t("Sistema PF no crea su perfil público", () => assertFails(setDoc(doc(S, "perfiles", "SPF"), { name: "Sergio Sistema PF", cargo: "Sistema PF", icon: "llave", updatedAt: serverTimestamp() })));
  await t("Sistema PF no se cambia de área", () => assertFails(updateDoc(doc(S, "users", "SPF"), { cargo: "Ventas", updatedAt: serverTimestamp() })));
  const U4 = as("U4");
  await t("admin pasa a U4 a Sistema PF", () => assertSucceeds(updateDoc(doc(A, "users", "U4"), { cargo: "Sistema PF" })));
  await t("U4 en Sistema PF ya no lee perfiles", () => assertFails(getDoc(doc(U4, "perfiles", "B"))));
  await t("admin devuelve a U4 a Ventas", () => assertSucceeds(updateDoc(doc(A, "users", "U4"), { cargo: "Ventas" })));
  await t("U4 en Ventas vuelve a leer perfiles", () => assertSucceeds(getDoc(doc(U4, "perfiles", "B"))));
}

console.log("sucursales");
{
  // Gente de Punto Fijo (sucursal la pone el administrador) y una gerente que ve las dos
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const pf = { PFA: ["Pía Autoservicio PF", "Autoservicio"], PFC: ["Pedro Compras PF", "Compras"], PFM: ["Pablo Mecánico PF", "Mecánicos"], PFV: ["Paula Ventas PF", "Ventas"] };
    for (const [uid, [name, cargo]] of Object.entries(pf)){
      await setDoc(doc(db, "users", uid), { name, email: uid + "@x.com", cargo, emailVerified: true, status: "verificado", role: "empleado", sucursal: "Punto Fijo" });
    }
    await setDoc(doc(db, "users", "AMB"), { name: "Amalia Ambas", email: "AMB@x.com", cargo: "Gerencia", emailVerified: true, status: "verificado", role: "empleado", ambas: true });
    await setDoc(doc(db, "codigos", "cCoro"), { codigo: 1, pedido: "x", by: "AUT", byName: "Aura Autoservicio", estado: "abierto", nota: "" });
    await setDoc(doc(db, "codigosPF", "cPF"), { codigo: 1, pedido: "x", by: "PFA", byName: "Pía Autoservicio PF", estado: "abierto", nota: "" });
    await setDoc(doc(db, "vehiculosPF", "vPF"), { placa: "PF1" });
    await setDoc(doc(db, "faltantesPF", "fPF"), { producto: "algo", by: "PFV", estado: "pendiente" });
  });
  const PFA = as("PFA"), PFC = as("PFC"), PFM = as("PFM"), PFV = as("PFV"), AMB = as("AMB"), AUTc = as("AUT"), COMc = as("COM"), Bc = as("B"), ts = serverTimestamp();
  const cod = (uid, name) => ({ codigo: 3, pedido: "Apoyo en chequeo", destino: "", nota: "", by: uid, byName: name, at: ts, estado: "abierto" });
  await t("Autoservicio PF pide un código en Punto Fijo", () => assertSucceeds(addDoc(collection(PFA, "codigosPF"), cod("PFA", "Pía Autoservicio PF"))));
  await t("Autoservicio PF no pide en Coro", () => assertFails(addDoc(collection(PFA, "codigos"), cod("PFA", "Pía Autoservicio PF"))));
  await t("Autoservicio Coro no pide en Punto Fijo", () => assertFails(addDoc(collection(AUTc, "codigosPF"), cod("AUT", "Aura Autoservicio"))));
  await t("Punto Fijo no lee códigos de Coro", () => assertFails(getDoc(doc(PFV, "codigos", "cCoro"))));
  await t("Coro no lee códigos de Punto Fijo", () => assertFails(getDoc(doc(Bc, "codigosPF", "cPF"))));
  await t("Punto Fijo lee sus códigos", () => assertSucceeds(getDocs(collection(PFV, "codigosPF"))));
  await t("Autoservicio Coro no acepta un código de Punto Fijo", () => assertFails(updateDoc(doc(AUTc, "codigosPF", "cPF"), { estado: "aceptado", tomadoPor: "AUT", tomadoPorNombre: "Aura Autoservicio", tomadoAt: ts })));
  await t("Autoservicio PF acepta el de Punto Fijo", () => assertSucceeds(updateDoc(doc(PFA, "codigosPF", "cPF"), { estado: "aceptado", tomadoPor: "PFA", tomadoPorNombre: "Pía Autoservicio PF", tomadoAt: ts })));
  await t("Gerencia con 'ambas' viejo solo ve Coro", () => assertSucceeds(getDocs(collection(AMB, "codigos"))));
  await t("'ambas' ya no da Punto Fijo (solo el admin ve las dos)", () => assertFails(getDocs(collection(AMB, "codigosPF"))));
  await t("el admin lee los de Punto Fijo", () => assertSucceeds(getDocs(collection(A, "codigosPF"))));
  await t("Gerencia sin 'ambas' no lee Punto Fijo", () => assertFails(getDocs(collection(GER, "codigosPF"))));
  await t("Punto Fijo no lee el mapa de Coro", () => assertFails(getDocs(collection(PFV, "mapa"))));
  const zpf = (uid, name) => ({ items: ["Aguas negras (A.N.)", "Codo 4"], updatedAt: ts, updatedBy: uid, updatedByName: name });
  await t("Punto Fijo lee su mapa", () => assertSucceeds(getDocs(collection(PFV, "mapaPF"))));
  await t("Coro no lee el mapa de Punto Fijo", () => assertFails(getDocs(collection(Bc, "mapaPF"))));
  await t("Autoservicio PF edita el mapa de Punto Fijo", () => assertSucceeds(setDoc(doc(PFA, "mapaPF", "F1-FONDO"), zpf("PFA", "Pía Autoservicio PF"))));
  await t("Autoservicio PF deja registro", () => assertSucceeds(addDoc(collection(PFA, "mapaLogPF"), { zone: "F1-FONDO", action: "agregó", item: "Codo 4", by: "PFA", byName: "Pía Autoservicio PF", at: ts })));
  await t("Autoservicio PF no edita el mapa de Coro", () => assertFails(setDoc(doc(PFA, "mapa", "P1-A-arriba"), zpf("PFA", "Pía Autoservicio PF"))));
  await t("Autoservicio Coro no edita el de Punto Fijo", () => assertFails(setDoc(doc(AUTc, "mapaPF", "F1-FONDO"), zpf("AUT", "Aura Autoservicio"))));
  await t("Ventas PF no edita el mapa de Punto Fijo", () => assertFails(setDoc(doc(PFV, "mapaPF", "F1-FONDO"), zpf("PFV", "Paula Ventas PF"))));
  await t("el admin edita el mapa de Punto Fijo", () => assertSucceeds(setDoc(doc(A, "mapaPF", "F2-FONDO"), zpf("A", "Ana Admin"))));
  await t("Punto Fijo no lee Profit de Coro", () => assertFails(getDoc(doc(PFV, "profit", "meta"))));
  await t("Compras PF no lee agotados de Coro", () => assertFails(getDoc(doc(PFC, "profitAgotados", "meta"))));
  await t("Coro sigue leyendo Profit", () => assertSucceeds(getDoc(doc(Bc, "profit", "meta"))));
  await t("Ventas PF anota un faltante en Punto Fijo", () => assertSucceeds(addDoc(collection(PFV, "faltantesPF"), { producto: "Codo 1/2", nota: "", by: "PFV", byName: "Paula Ventas PF", at: ts, estado: "pendiente" })));
  await t("Ventas PF no anota en Coro", () => assertFails(addDoc(collection(PFV, "faltantes"), { producto: "Codo 1/2", nota: "", by: "PFV", byName: "Paula Ventas PF", at: ts, estado: "pendiente" })));
  await t("Compras PF ve los faltantes de Punto Fijo", () => assertSucceeds(getDocs(collection(PFC, "faltantesPF"))));
  await t("Compras Coro no ve los de Punto Fijo", () => assertFails(getDocs(collection(COMc, "faltantesPF"))));
  await t("Compras PF marca uno pedido", () => assertSucceeds(updateDoc(doc(PFC, "faltantesPF", "fPF"), { estado: "pedido" })));
  await t("Mecánico PF ve vehículos de Punto Fijo", () => assertSucceeds(getDocs(collection(PFM, "vehiculosPF"))));
  await t("Mecánico PF no ve los de Coro", () => assertFails(getDocs(collection(PFM, "vehiculos"))));
  await t("Mecánico PF registra mantenimiento en Punto Fijo", () => assertSucceeds(addDoc(collection(PFM, "mantenimientosPF"), { vehiculoId: "vPF", placa: "PF1", fecha: "2026-10-08", tipo: "aceite", km: 1000, detalle: "", by: "PFM", byName: "Pablo Mecánico PF", at: ts })));
  await t("mantenimiento PF de un vehículo que no es de PF falla", () => assertFails(addDoc(collection(PFM, "mantenimientosPF"), { vehiculoId: "noexiste", placa: "X", fecha: "2026-10-08", tipo: "aceite", km: 1000, detalle: "", by: "PFM", byName: "Pablo Mecánico PF", at: ts })));
  await t("PF no se cambia de sucursal solo", () => assertFails(updateDoc(doc(PFV, "users", "PFV"), { sucursal: "Coro", updatedAt: ts })));
  await t("PF no se da 'ambas' solo", () => assertFails(updateDoc(doc(PFV, "users", "PFV"), { ambas: true, updatedAt: ts })));
  await t("admin cambia la sucursal de alguien", () => assertSucceeds(updateDoc(doc(A, "users", "U5"), { sucursal: "Punto Fijo" })));
  await t("admin no pone una sucursal inventada", () => assertFails(updateDoc(doc(A, "users", "U5"), { sucursal: "Caracas" })));
  await t("ni el admin pone 'ambas' (ya no existe)", () => assertFails(updateDoc(doc(A, "users", "U6"), { ambas: true })));
  await t("admin no pone 'ambas' que no sea sí/no", () => assertFails(updateDoc(doc(A, "users", "U6"), { ambas: "si" })));
  await t("admin pone un rol (Autoservicio: Caja)", () => assertSucceeds(updateDoc(doc(A, "users", "AUT"), { rol: "Caja" })));
  await t("admin cambia área y borra el rol a la vez", () => assertSucceeds(updateDoc(doc(A, "users", "U7"), { cargo: "Caja", rol: "" })));
  await t("nadie se pone su propio rol", () => assertFails(updateDoc(doc(AUTc, "users", "AUT"), { rol: "Supervisor", updatedAt: ts })));
  await t("el rol no puede ser otra cosa que texto", () => assertFails(updateDoc(doc(A, "users", "AUT"), { rol: 5 })));
  await t("el chat sigue compartido (PF lee perfiles)", () => assertSucceeds(getDoc(doc(PFV, "perfiles", "B"))));
}

console.log("conteo de inventario");
{
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", "PFI"), { name: "Pili Inventario PF", email: "PFI@x.com", cargo: "Inventario", emailVerified: true, status: "verificado", role: "empleado", sucursal: "Punto Fijo" });
    await setDoc(doc(db, "users", "PFW"), { name: "Wil Ventas PF", email: "PFW@x.com", cargo: "Ventas", emailVerified: true, status: "verificado", role: "empleado", sucursal: "Punto Fijo" });
    await setDoc(doc(db, "users", "CV"), { name: "Carla", email: "CV@x.com", cargo: "Ventas", emailVerified: true, status: "verificado", role: "empleado" });
    await setDoc(doc(db, "users", "BV"), { name: "Beto", email: "BV@x.com", cargo: "Ventas", emailVerified: true, status: "verificado", role: "empleado" });
    await setDoc(doc(db, "users", "IV"), { name: "Iván Inventario", email: "IV@x.com", cargo: "Inventario", emailVerified: true, status: "verificado", role: "empleado" });
  });
  const INVc = as("IV"), Cc = as("CV"), Bc = as("BV"), Ac = as("A"), PFI = as("PFI"), PFW = as("PFW"), ts = serverTimestamp();
  const nueva = (por, porN, a, aN, extra = {}) => Object.assign({ nombre: "Pasillo 3", items: [{ c: "001", d: "Tornillo" }, { c: "002", d: "Clavo" }],
    asignado: a, asignadoNombre: aN, creadoPor: por, creadoPorNombre: porN, creadoAt: ts, estado: "contando", conteo: {}, avance: 0, ronda: 1 }, extra);
  await t("Inventario manda una planilla a C", () => assertSucceeds(setDoc(doc(INVc, "conteos", "k1"), nueva("IV", "Iván Inventario", "CV", "Carla"))));
  await t("Ventas no crea planillas", () => assertFails(setDoc(doc(Bc, "conteos", "k2"), nueva("BV", "Beto", "CV", "Carla"))));
  await t("no se crea con conteo ya lleno", () => assertFails(setDoc(doc(INVc, "conteos", "k3"), nueva("IV", "Iván Inventario", "CV", "Carla", { conteo: { "0": 5 } }))));
  await t("no se manda a alguien pendiente", () => assertFails(setDoc(doc(INVc, "conteos", "k4"), nueva("IV", "Iván Inventario", "D", "Dani"))));
  await t("Coro no manda a alguien de Punto Fijo", () => assertFails(setDoc(doc(INVc, "conteos", "k5"), nueva("IV", "Iván Inventario", "PFW", "Wil"))));
  await t("C lee su planilla", () => assertSucceeds(getDoc(doc(Cc, "conteos", "k1"))));
  await t("C busca sus planillas", () => assertSucceeds(getDocs(query(collection(Cc, "conteos"), where("asignado", "==", "CV")))));
  await t("B no lee la planilla de C", () => assertFails(getDoc(doc(Bc, "conteos", "k1"))));
  await t("B no lista todas", () => assertFails(getDocs(collection(Bc, "conteos"))));
  await t("Inventario lista todas", () => assertSucceeds(getDocs(collection(INVc, "conteos"))));
  await t("C anota cantidades", () => assertSucceeds(updateDoc(doc(Cc, "conteos", "k1"), { conteo: { "0": 12 }, avance: 1 })));
  await t("C no cambia los productos", () => assertFails(updateDoc(doc(Cc, "conteos", "k1"), { items: [{ c: "9", d: "x" }] })));
  await t("C no la aprueba", () => assertFails(updateDoc(doc(Cc, "conteos", "k1"), { estado: "aprobado" })));
  await t("B no anota en la de C", () => assertFails(updateDoc(doc(Bc, "conteos", "k1"), { conteo: { "0": 1 }, avance: 1 })));
  await t("Inventario no la devuelve si no se entregó", () => assertFails(updateDoc(doc(INVc, "conteos", "k1"), { estado: "contando", recontar: [0], revisadoPor: "IV", revisadoPorNombre: "Iván Inventario", revisadoAt: ts })));
  await t("C la entrega", () => assertSucceeds(updateDoc(doc(Cc, "conteos", "k1"), { conteo: { "0": 12, "1": 0 }, avance: 2, estado: "entregado", entregadoAt: ts })));
  await t("C ya no la cambia entregada", () => assertFails(updateDoc(doc(Cc, "conteos", "k1"), { conteo: { "0": 99, "1": 0 } })));
  await t("Inventario la devuelve para recontar", () => assertSucceeds(updateDoc(doc(INVc, "conteos", "k1"), { estado: "contando", recontar: [1], conteo: { "0": 12 }, avance: 1, ronda: 2, revisadoPor: "IV", revisadoPorNombre: "Iván Inventario", revisadoAt: ts })));
  await t("C la vuelve a entregar", () => assertSucceeds(updateDoc(doc(Cc, "conteos", "k1"), { conteo: { "0": 12, "1": 3 }, avance: 2, estado: "entregado", entregadoAt: ts })));
  await t("Inventario la aprueba con lo de Profit", () => assertSucceeds(updateDoc(doc(INVc, "conteos", "k1"), { estado: "aprobado", sistema: { "0": 12, "1": 4 }, revisadoPor: "IV", revisadoPorNombre: "Iván Inventario", revisadoAt: ts })));
  await t("aprobada ya no se cambia", () => assertFails(updateDoc(doc(INVc, "conteos", "k1"), { estado: "anulado", revisadoPor: "IV", revisadoPorNombre: "Iván Inventario", revisadoAt: ts })));
  await t("Inventario PF manda en Punto Fijo", () => assertSucceeds(setDoc(doc(PFI, "conteosPF", "p1"), nueva("PFI", "Pili Inventario PF", "PFW", "Wil"))));
  await t("Inventario PF no manda a alguien de Coro", () => assertFails(setDoc(doc(PFI, "conteosPF", "p2"), nueva("PFI", "Pili Inventario PF", "CV", "Carla"))));
  await t("Inventario PF no crea en Coro", () => assertFails(setDoc(doc(PFI, "conteos", "p3"), nueva("PFI", "Pili Inventario PF", "PFW", "Wil"))));
  await t("Inventario Coro no lee las de Punto Fijo", () => assertFails(getDocs(collection(INVc, "conteosPF"))));
  await t("el admin las lee todas", () => assertSucceeds(getDocs(collection(Ac, "conteosPF"))));
  await t("Inventario anula una en conteo", () => assertSucceeds(updateDoc(doc(PFI, "conteosPF", "p1"), { estado: "anulado", revisadoPor: "PFI", revisadoPorNombre: "Pili Inventario PF", revisadoAt: ts })));
}

console.log(`\n${pass} ok, ${fail} fallas`);
await env.cleanup();
process.exit(fail ? 1 : 0);
