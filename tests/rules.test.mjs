import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs, addDoc,
         serverTimestamp, writeBatch, orderBy, limit, arrayUnion, arrayRemove } from "firebase/firestore";
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

console.log("en línea (Realtime Database)");
const rt = (uid, verified = true) => env.authenticatedContext(uid, { email: uid + "@x.com", email_verified: verified }).database();
await t("B marca que está en línea", () => assertSucceeds(set(ref(rt("B"), "estado/B"), { on: true, t: Date.now() })));
await t("B no marca a C", () => assertFails(set(ref(rt("B"), "estado/C"), { on: true, t: Date.now() })));
await t("sin campos extra", () => assertFails(set(ref(rt("B"), "estado/B"), { on: true, t: 1, x: 2 })));
await t("faltando la hora no", () => assertFails(set(ref(rt("B"), "estado/B"), { on: true })));
await t("C ve quién está en línea", () => assertSucceeds(rget(ref(rt("C"), "estado"))));
await t("correo sin confirmar no ve", () => assertFails(rget(ref(rt("C", false), "estado"))));
await t("sin sesión no ve", () => assertFails(rget(ref(env.unauthenticatedContext().database(), "estado"))));
await t("nadie escribe fuera de estado", () => assertFails(set(ref(rt("B"), "otra/cosa"), 1)));

console.log(`\n${pass} ok, ${fail} fallas`);
await env.cleanup();
process.exit(fail ? 1 : 0);
