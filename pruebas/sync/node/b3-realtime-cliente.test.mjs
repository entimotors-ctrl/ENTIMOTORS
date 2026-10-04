// 3.15.0 · Bloque 3 · piezas del cliente, sin navegador ni Docker:
//   · taller-demo/sync-realtime.js REAL contra un WebSocket FALSO (protocolo Phoenix v1): unión privada con el token en el mensaje
//     (no en la URL), avisos, duplicados, reconexión con espera creciente, renovación del token, rechazo sin bucle, cierre.
//   · taller-demo/sync-db.js REAL (abrirSeguro) contra un IndexedDB FALSO: ocupada → reintento, dañada, llena, versión más nueva,
//     escritura que falla aunque abra. Nunca borra ni recrea.
//   node --test pruebas/sync/node/b3-realtime-cliente.test.mjs
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const TD = path.resolve(AQUI, "../../../taller-demo");
function cargar(archivo, extra = {}) { const ctx = { setTimeout, clearTimeout, Promise, JSON, Math, Date, atob, ...extra }; vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(TD, archivo), "utf8"), ctx); return ctx; }

/* ── WebSocket falso + reloj manual ─────────────────────────────────────────── */
function crearMundo() {
  const sockets = [], timers = [];
  let ahora = 1_000_000;
  class WS {
    constructor(url) { this.url = url; this.readyState = 0; this.enviados = []; sockets.push(this); }
    send(t) { this.enviados.push(JSON.parse(t)); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({}); }
    // lado «servidor»
    abrir() { this.readyState = 1; this.onopen?.({}); }
    recibir(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
    caer() { this.readyState = 3; this.onclose?.({}); }
    unir(tema, ok = true, motivo) { const j = this.enviados.filter((x) => x.event === "phx_join" && x.topic === "realtime:" + tema).at(-1); this.recibir({ topic: "realtime:" + tema, event: "phx_reply", ref: j.ref, payload: ok ? { status: "ok", response: {} } : { status: "error", response: { reason: motivo } } }); }
    aviso(tema, payload, id) { this.recibir({ topic: "realtime:" + tema, event: "broadcast", payload: { event: "cambio", type: "broadcast", payload, meta: { id } } }); }
  }
  const t = {
    setTimeout: (fn, ms) => { const x = { fn, en: ahora + ms, id: timers.length + 1, vivo: true }; timers.push(x); return x; },
    clearTimeout: (x) => { if (x) x.vivo = false; },
    avanzar(ms) { const fin = ahora + ms; for (;;) { const s = timers.filter((x) => x.vivo && x.en <= fin).sort((a, b) => a.en - b.en)[0]; if (!s) break; ahora = s.en; s.vivo = false; s.fn(); } ahora = fin; },
    ahora: () => ahora,
  };
  return { WS, sockets, t };
}
function cliente(mundo, extra = {}) {
  const { SyncRealtime } = cargar("sync-realtime.js");
  let token = extra.token === undefined ? "tok-1" : extra.token;
  const avisos = [], estados = [], conectados = [];
  const rt = SyncRealtime.crear({ url: "https://proyecto.example.test", apiKey: "anon-publica", temas: extra.temas || ["mt:A"], WebSocket: mundo.WS,
    getToken: () => token, alAviso: (a, tema) => avisos.push({ a, tema }), alEstado: (e) => estados.push(e), alConectado: (r) => conectados.push(r),
    setTimeout: mundo.t.setTimeout, clearTimeout: mundo.t.clearTimeout, ahora: mundo.t.ahora, aleatorio: () => 0.5 });
  return { rt, avisos, estados, conectados, fijarToken: (x) => { token = x; } };
}

describe("sync-realtime.js · protocolo y seguridad del canal", () => {
  test("conecta al endpoint Realtime con la clave PÚBLICA en la URL y el token SOLO dentro de la unión privada", () => {
    const m = crearMundo(), c = cliente(m); c.rt.conectar();
    const s = m.sockets[0];
    assert.equal(s.url, "wss://proyecto.example.test/realtime/v1/websocket?apikey=anon-publica&vsn=1.0.0");
    assert.ok(!s.url.includes("tok-1"), "el token nunca va en la URL");
    s.abrir();
    const j = s.enviados.find((x) => x.event === "phx_join");
    assert.equal(j.topic, "realtime:mt:A"); assert.equal(j.payload.config.private, true); assert.equal(j.payload.access_token, "tok-1");
    assert.equal(j.payload.config.broadcast.self, false);
    assert.equal(c.rt.estado(), "conectando");
    s.unir("mt:A"); assert.equal(c.rt.estado(), "conectado"); assert.deepEqual(c.conectados, [false]);
  });
  test("aviso → alAviso UNA vez; el mismo aviso repetido (mismo id) se descarta; fuera de orden se entregan los dos (manda el servidor)", () => {
    const m = crearMundo(), c = cliente(m); c.rt.conectar(); const s = m.sockets[0]; s.abrir(); s.unir("mt:A");
    s.aviso("mt:A", { e: "ordenes", id: "u1", rev: 5 }, "m1");
    s.aviso("mt:A", { e: "ordenes", id: "u1", rev: 5 }, "m1");   // duplicado
    s.aviso("mt:A", { e: "ordenes", id: "u1", rev: 3 }, "m0");   // atrasado: se entrega; el cliente vuelve a pedir el registro y aplica lo que hay AHORA
    assert.deepEqual(c.avisos.map((x) => x.a.rev), [5, 3]);
    assert.equal(c.rt.metricas().duplicados, 1); assert.equal(c.rt.metricas().avisos, 2);
  });
  test("aviso de un canal al que NO se unió (u otro tema) se ignora", () => {
    const m = crearMundo(), c = cliente(m); c.rt.conectar(); const s = m.sockets[0]; s.abrir(); s.unir("mt:A");
    s.aviso("mt:B", { e: "ordenes", id: "x" }, "z1"); assert.equal(c.avisos.length, 0);
  });
  test("unión RECHAZADA (sin permiso) → estado sin-acceso y NO reintenta en bucle; sí al cambiar el token", () => {
    const m = crearMundo(), c = cliente(m); c.rt.conectar(); const s = m.sockets[0]; s.abrir();
    s.unir("mt:A", false, "Unauthorized: You do not have permissions to read from this Channel topic: mt:A");
    assert.equal(c.rt.estado(), "sin-acceso");
    m.t.avanzar(50000);   // dos latidos con el MISMO token: no insiste
    assert.equal(s.enviados.filter((x) => x.event === "phx_join").length, 1, "no insiste con el mismo token");
    m.t.avanzar(10 * 60000 - 50000);   // 10 min con el mismo token: como mucho un intento por minuto (nunca en bucle)
    const conMismo = s.enviados.filter((x) => x.event === "phx_join").length;
    assert.ok(conMismo >= 2 && conMismo <= 11, `reintentos con el mismo token en 10 min: ${conMismo}`);
    s.unir("mt:A", false, "Unauthorized");   // el último también rechazado
    c.fijarToken("tok-2"); m.t.avanzar(25000);
    const js = s.enviados.filter((x) => x.event === "phx_join"); assert.equal(js.at(-1).payload.access_token, "tok-2", "con token nuevo se une enseguida");
    s.unir("mt:A"); assert.equal(c.rt.estado(), "conectado");
  });
  test("sesión refrescada: el canal unido recibe el token nuevo (access_token) sin reconectar", () => {
    const m = crearMundo(), c = cliente(m); c.rt.conectar(); const s = m.sockets[0]; s.abrir(); s.unir("mt:A");
    c.fijarToken("tok-nuevo"); m.t.avanzar(25000);
    const at = s.enviados.filter((x) => x.event === "access_token"); assert.equal(at.length, 1); assert.equal(at[0].payload.access_token, "tok-nuevo");
    assert.equal(m.sockets.length, 1);
    assert.ok(s.enviados.some((x) => x.topic === "phoenix" && x.event === "heartbeat"), "latido Phoenix");
  });
  test("token CADUCADO (el servidor lo avisa y cierra el canal) → sin-acceso; no se reciben más avisos hasta un token nuevo", () => {
    const m = crearMundo(), c = cliente(m); c.rt.conectar(); const s = m.sockets[0]; s.abrir(); s.unir("mt:A");
    s.recibir({ topic: "realtime:mt:A", event: "system", payload: { status: "error", message: "Token has expired 0 seconds ago", extension: "system" } });
    assert.equal(c.rt.estado(), "sin-acceso");
    s.aviso("mt:A", { e: "ordenes", id: "u9" }, "m9"); assert.equal(c.avisos.length, 0, "canal caído: nada entra");
  });
  test("carrera: el cierre ATRASADO del canal caducado llega después de unirse con el token nuevo → la unión vigente sigue en pie", () => {
    const m = crearMundo(), c = cliente(m); c.rt.conectar(); const s = m.sockets[0]; s.abrir(); s.unir("mt:A");
    s.recibir({ topic: "realtime:mt:A", event: "system", payload: { status: "error", message: "Token has expired 0 seconds ago" } });
    c.fijarToken("tok-2"); c.rt.reintentar();
    const j2 = s.enviados.filter((x) => x.event === "phx_join").at(-1); assert.equal(j2.payload.access_token, "tok-2");
    s.recibir({ topic: "realtime:mt:A", event: "phx_close", ref: "1", payload: {} });   // el cierre viejo (join_ref 1) llega tarde
    s.unir("mt:A");
    assert.equal(c.rt.estado(), "conectado");
    m.t.avanzar(5000);
    assert.equal(s.enviados.filter((x) => x.event === "phx_join").length, 2, "no hay una tercera unión que el servidor rechazaría");
    assert.equal(c.rt.estado(), "conectado");
  });
  test("carrera: un «Token has expired» ATRASADO (del token viejo) llega después de unirse con un token vigente → se ignora", () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const vigente = `${b64({ alg: "HS256" })}.${b64({ sub: "A", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
    const m = crearMundo(), c = cliente(m); c.rt.conectar(); const s = m.sockets[0]; s.abrir(); s.unir("mt:A");
    s.recibir({ topic: "realtime:mt:A", event: "system", payload: { status: "error", message: "Token has expired 0 seconds ago" } });
    c.fijarToken(vigente); c.rt.reintentar(); s.unir("mt:A"); assert.equal(c.rt.estado(), "conectado");
    s.recibir({ topic: "realtime:mt:A", event: "system", payload: { status: "error", message: "Token has expired 1 seconds ago" } });
    assert.equal(c.rt.estado(), "conectado", "el aviso atrasado no tumba la unión vigente");
  });
  test("sin sesión (no hay token): ni siquiera abre el socket", () => {
    const m = crearMundo(), c = cliente(m, { token: null }); c.rt.conectar();
    assert.equal(m.sockets.length, 0); assert.equal(c.rt.estado(), "sin-sesion");
  });
  test("caída del socket → reconexión con espera creciente (1 s, 2 s, 4 s…) y alConectado(reconexion=true) al volver", () => {
    const m = crearMundo(), c = cliente(m); c.rt.conectar(); m.sockets[0].abrir(); m.sockets[0].unir("mt:A");
    m.sockets[0].caer(); assert.equal(c.rt.estado(), "desconectado");
    m.t.avanzar(999); assert.equal(m.sockets.length, 1, "no reconecta antes de ~1 s");
    m.t.avanzar(2); assert.equal(m.sockets.length, 2);
    m.sockets[1].caer(); m.t.avanzar(1999); assert.equal(m.sockets.length, 2); m.t.avanzar(2); assert.equal(m.sockets.length, 3, "segunda espera ~2 s");
    m.sockets[2].abrir(); m.sockets[2].unir("mt:A");
    assert.equal(c.rt.estado(), "conectado"); assert.deepEqual(c.conectados, [false, true]);
    assert.equal(c.rt.metricas().reconexiones, 1);
    m.sockets[2].caer(); m.t.avanzar(1001); assert.equal(m.sockets.length, 4, "tras conectar bien, la espera vuelve a empezar en ~1 s");
  });
  test("cerrar() (cierre de sesión / cambio de usuario): cierra y NO reconecta nunca", () => {
    const m = crearMundo(), c = cliente(m); c.rt.conectar(); m.sockets[0].abrir(); m.sockets[0].unir("mt:A");
    c.rt.cerrar(); assert.equal(c.rt.estado(), "apagado"); m.t.avanzar(10 * 60000);
    assert.equal(m.sockets.length, 1); assert.equal(m.sockets[0].readyState, 3);
  });
  test("varios temas (admin: taller + admin): conectado solo cuando TODOS se unieron", () => {
    const m = crearMundo(), c = cliente(m, { temas: ["taller", "admin"] }); c.rt.conectar(); const s = m.sockets[0]; s.abrir();
    s.unir("taller"); assert.notEqual(c.rt.estado(), "conectado"); s.unir("admin"); assert.equal(c.rt.estado(), "conectado");
  });
  test("inactivo: en 10 minutos sin cambios, 0 mensajes salvo el latido (≈1 cada 25 s) y ninguna reconexión", () => {
    const m = crearMundo(), c = cliente(m); c.rt.conectar(); const s = m.sockets[0]; s.abrir(); s.unir("mt:A");
    const antes = s.enviados.length; m.t.avanzar(10 * 60000);
    const nuevos = s.enviados.slice(antes);
    assert.ok(nuevos.every((x) => x.event === "heartbeat")); assert.equal(nuevos.length, 24); assert.equal(m.sockets.length, 1);
  });
});

/* ── IndexedDB falso configurable ───────────────────────────────────────────── */
function idbFalso(plan) {
  // plan: lista de comportamientos por intento de open: "ok" | "error:<Nombre>" | "bloqueada" | "ok-sin-escritura:<Nombre>"
  const aperturas = [], borrados = [];
  let i = 0;
  const idb = {
    aperturas, borrados,
    deleteDatabase(n) { borrados.push(n); return {}; },
    open(nombre) {
      const modo = plan[Math.min(i, plan.length - 1)]; i++; aperturas.push({ nombre, modo });
      const req = {};
      setTimeout(() => {
        if (modo.startsWith("error:")) { req.error = Object.assign(new Error("fallo"), { name: modo.slice(6) }); req.onerror?.(); return; }
        if (modo === "bloqueada") { req.onblocked?.(); return; }
        const romperEscritura = modo.startsWith("ok-sin-escritura:") ? modo.split(":")[1] : null;
        req.result = baseFalsa(romperEscritura); req.onsuccess?.();
      }, 0);
      return req;
    },
  };
  return idb;
}
function baseFalsa(romper) {
  const datos = { meta: new Map() };
  return {
    close() {}, objectStoreNames: { contains: () => true },
    transaction() {
      const t = { objectStore: (s) => ({
        get: (k) => req(() => datos[s]?.get(k)), put: (v) => req(() => { if (romper) throw Object.assign(new Error("no escribe"), { name: romper }); (datos[s] ||= new Map()).set(v.k, v); }),
      }) };
      let pend = 0, fallo = null;
      function req(fn) { const r = {}; pend++; setTimeout(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { fallo = e; r.error = e; r.onerror?.(); } pend--; if (!pend) setTimeout(() => { if (fallo) { t.error = fallo; t.onabort?.(); } else t.oncomplete?.(); }, 0); }, 0); return r; }
      return t;
    },
  };
}
describe("sync-db.js · abrirSeguro (fail closed, sin borrar nada)", () => {
  const SyncDB = cargar("sync-db.js", { crypto: globalThis.crypto }).SyncDB;
  const ops = { esperasMs: [5, 5, 5], esperaBloqueoMs: 20 };
  test("abre y ESCRIBE (sonda) → ok", async () => {
    const idb = idbFalso(["ok"]); const r = await SyncDB.abrirSeguro({ indexedDB: idb, nombre: "entimotors_sync", ...ops });
    assert.equal(r.ok, true); assert.equal(r.intentos, 1); assert.equal(idb.borrados.length, 0);
  });
  test("ocupada por otra pestaña (bloqueada) dos veces y luego abre → ok al tercer intento", async () => {
    const idb = idbFalso(["bloqueada", "bloqueada", "ok"]); const r = await SyncDB.abrirSeguro({ indexedDB: idb, nombre: "entimotors_sync", ...ops });
    assert.equal(r.ok, true); assert.equal(r.intentos, 3);
  });
  test("siempre ocupada → tipo «ocupada» tras reintentar (no se espera para siempre)", async () => {
    const idb = idbFalso(["bloqueada"]); const r = await SyncDB.abrirSeguro({ indexedDB: idb, nombre: "entimotors_sync", ...ops });
    assert.equal(r.ok, false); assert.equal(r.tipo, "ocupada"); assert.equal(idb.aperturas.length, 4);
  });
  test("dañada (UnknownError persistente) → «no-disponible»; NO borra ni recrea la base", async () => {
    const idb = idbFalso(["error:UnknownError"]); const r = await SyncDB.abrirSeguro({ indexedDB: idb, nombre: "entimotors_sync", ...ops });
    assert.equal(r.ok, false); assert.equal(r.tipo, "no-disponible"); assert.equal(r.error.nombre, "UnknownError");
    assert.deepEqual(idb.borrados, []); assert.ok(idb.aperturas.every((a) => a.nombre === "entimotors_sync"), "nunca abre otra base «nueva» para esconder el problema");
  });
  test("fallo pasajero (UnknownError una vez) → reintenta y abre", async () => {
    const idb = idbFalso(["error:UnknownError", "ok"]); const r = await SyncDB.abrirSeguro({ indexedDB: idb, nombre: "entimotors_sync", ...ops });
    assert.equal(r.ok, true); assert.equal(r.intentos, 2);
  });
  test("abre pero NO puede escribir (cuota) → «llena», sin reintentos inútiles", async () => {
    const idb = idbFalso(["ok-sin-escritura:QuotaExceededError"]); const r = await SyncDB.abrirSeguro({ indexedDB: idb, nombre: "entimotors_sync", ...ops });
    assert.equal(r.ok, false); assert.equal(r.tipo, "llena"); assert.equal(idb.aperturas.length, 1);
  });
  test("base de una versión MÁS NUEVA → «version», sin reintentos", async () => {
    const idb = idbFalso(["error:VersionError"]); const r = await SyncDB.abrirSeguro({ indexedDB: idb, nombre: "entimotors_sync", ...ops });
    assert.equal(r.ok, false); assert.equal(r.tipo, "version"); assert.equal(idb.aperturas.length, 1);
  });
  test("sin IndexedDB en absoluto → «no-disponible» (y NO es «sin Internet»)", async () => {
    const r = await SyncDB.abrirSeguro({ indexedDB: null, nombre: "entimotors_sync", ...ops });
    const r2 = await cargar("sync-db.js", { crypto: globalThis.crypto }).SyncDB.abrirSeguro({ nombre: "x", ...ops });
    assert.equal(r.ok, false); assert.equal(r.tipo, "no-disponible"); assert.equal(r2.tipo, "no-disponible");
  });
  test("la versión de la base local NO sube (sigue v1: la 3.14.1 puede volver a abrirla) y los mensajes usan el almacén existente", () => {
    assert.equal(SyncDB.version, 1); assert.equal(SyncDB.ALMACEN_MENSAJES, "auditoria"); assert.ok(SyncDB.ENTIDADES.includes("auditoria"));
  });
});
