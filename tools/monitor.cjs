// Medidor del plan gratuito de Firebase para Cose Coro.
// Lee el consumo real (Cloud Monitoring) y los conteos de la base de datos, y
// guarda un resumen en Firestore: monitor/resumen (solo lo lee el administrador).
// Corre cada hora en la computadora de Rafael (launchd: tools/com.cosecoro.monitor.plist)
// con la sesión del Firebase CLI de esa computadora (`firebase login`).
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");

const P = "cosecoro-coro";
// Cliente OAuth público del Firebase CLI (el mismo que usa firebase-tools).
const CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";
// Límites diarios/mensuales del plan Spark (gratis)
const LIMITS = { reads: 50000, writes: 20000, deletes: 20000, connections: 100, rtdbMonthBytes: 10 * 1024 ** 3, rtdbStorageBytes: 1024 ** 3 };
const TZ_QUOTA = "America/Los_Angeles"; // la cuota diaria se reinicia a medianoche del Pacífico

async function token(){
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/configstore/firebase-tools.json"), "utf8"));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: cfg.tokens.refresh_token, grant_type: "refresh_token" })
  }).then(r => r.json());
  if (!r.access_token) throw new Error("sin sesión de Firebase: " + JSON.stringify(r));
  return r.access_token;
}

// Fecha (AAAA-MM-DD) y medianoche de un día en una zona horaria
function dayIn(tz, d){ return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
function tzMidnight(tz, d){
  const day = dayIn(tz, d);
  // busca la hora UTC en que ese día empieza en la zona
  for (let h = -14; h <= 14; h++){
    const t = new Date(Date.parse(day + "T00:00:00Z") - h * 3600e3);
    if (dayIn(tz, t) === day && dayIn(tz, new Date(t.getTime() - 1000)) !== day) return t;
  }
  return new Date(Date.parse(day + "T00:00:00Z"));
}

(async () => {
  const t = await token();
  const H = { Authorization: "Bearer " + t, "Content-Type": "application/json" };
  const now = new Date();

  async function series(metric, { start, aligner = "ALIGN_SUM", period = "3600s", reducer = "REDUCE_SUM" }){
    const q = new URLSearchParams({
      filter: `metric.type="${metric}"`, "interval.startTime": start.toISOString(), "interval.endTime": now.toISOString(),
      "aggregation.alignmentPeriod": period, "aggregation.perSeriesAligner": aligner, "aggregation.crossSeriesReducer": reducer
    });
    const r = await fetch(`https://monitoring.googleapis.com/v3/projects/${P}/timeSeries?` + q, { headers: H }).then(r => r.json());
    if (r.error) throw new Error(metric + ": " + r.error.message);
    return (r.timeSeries || []).flatMap(s => s.points).map(p => ({ end: new Date(p.interval.endTime), v: +(p.value.int64Value ?? p.value.doubleValue ?? 0) }));
  }
  const since30 = new Date(now.getTime() - 30 * 86400e3);
  const hourlyReads = await series("firestore.googleapis.com/document/read_count", { start: since30 });
  const hourlyWrites = await series("firestore.googleapis.com/document/write_count", { start: since30 });
  const hourlyDeletes = await series("firestore.googleapis.com/document/delete_count", { start: since30 });
  const hourlyConn = await series("firebasedatabase.googleapis.com/network/active_connections", { start: since30, aligner: "ALIGN_MAX" });
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rtdbBytes = (await series("firebasedatabase.googleapis.com/network/sent_bytes_count", { start: monthStart })).reduce((a, p) => a + p.v, 0);
  const rtdbStore = await series("firebasedatabase.googleapis.com/storage/total_bytes", { start: new Date(now.getTime() - 2 * 86400e3), aligner: "ALIGN_MAX", period: "86400s" });

  // por día de cuota (Pacífico)
  const days = {};
  function add(list, key, max){
    list.forEach(p => {
      const d = dayIn(TZ_QUOTA, new Date(p.end.getTime() - 1000));
      const o = days[d] || (days[d] = { date: d, reads: 0, writes: 0, deletes: 0, peakConn: 0 });
      o[key] = max ? Math.max(o[key], p.v) : o[key] + p.v;
    });
  }
  add(hourlyReads, "reads"); add(hourlyWrites, "writes"); add(hourlyDeletes, "deletes"); add(hourlyConn, "peakConn", true);
  const todayKey = dayIn(TZ_QUOTA, now);
  const today = days[todayKey] || { date: todayKey, reads: 0, writes: 0, deletes: 0, peakConn: 0 };
  const history = Object.values(days).sort((a, b) => a.date < b.date ? -1 : 1).slice(-30);

  // conteos
  async function count(col, where, group){
    const sq = { from: [{ collectionId: col, allDescendants: !!group }] };
    if (where) sq.where = { fieldFilter: { field: { fieldPath: where[0] }, op: "EQUAL", value: { stringValue: where[1] } } };
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents:runAggregationQuery`,
      { method: "POST", headers: H, body: JSON.stringify({ structuredAggregationQuery: { structuredQuery: sq, aggregations: [{ alias: "n", count: {} }] } }) }).then(r => r.json());
    return +(r[0] && r[0].result && r[0].result.aggregateFields && r[0].result.aggregateFields.n && r[0].result.aggregateFields.n.integerValue || 0);
  }
  const counts = {
    users: await count("users"), verificados: await count("users", ["status", "verificado"]),
    pendientes: await count("users", ["status", "pendiente"]), bloqueados: await count("users", ["status", "bloqueado"]),
    conexiones: await count("conexiones", ["status", "aceptada"]), solicitudes: await count("conexiones", ["status", "pendiente"]),
    chats: await count("chats"), mensajes: await count("mensajes", null, true), cambiosMapa: await count("mapaLog")
  };

  const quotaStart = tzMidnight(TZ_QUOTA, now);
  const resumen = {
    updatedAt: now, quotaStart, quotaReset: new Date(quotaStart.getTime() + 86400e3),
    limits: LIMITS, today, history, counts,
    rtdb: { monthBytes: rtdbBytes, storageBytes: rtdbStore.length ? Math.max(...rtdbStore.map(p => p.v)) : 0 }
  };

  // a formato de Firestore
  function enc(v){
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "string") return { stringValue: v };
    if (typeof v === "boolean") return { booleanValue: v };
    if (v && typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
    return { nullValue: null };
  }
  const w = await fetch(`https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents/monitor/resumen`,
    { method: "PATCH", headers: H, body: JSON.stringify({ fields: enc(resumen).mapValue.fields }) });
  if (!w.ok) throw new Error("no se pudo guardar: " + w.status + " " + await w.text());
  console.log(now.toISOString(), "ok", JSON.stringify({ today, counts }));
})().catch(e => { console.error(new Date().toISOString(), "ERROR", e.message); process.exit(1); });
