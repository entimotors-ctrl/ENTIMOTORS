// SECURITY-1B · errores HTTP/JSON: api-server/src/app.ts REAL (Express 5, body-parser, CORS, cookie-parser y el logger pino REALES) arrancado como
// proceso hijo en 127.0.0.1; solo Supabase es falso. Se envían cuerpos rotos con CANARIOS (contraseña/PIN ficticios, aleatorios por corrida)
// y se exige que no aparezcan NI en stdout NI en stderr NI en la respuesta, en producción y en desarrollo. Mutante: sin el manejador, el
// canario vuelve a salir en stderr (demuestra que la prueba ve la fuga real que medimos en el PRECHECK).
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compilar } from "./helpers/compilar.mjs";

const CANARIO = `CANARIO-${crypto.randomBytes(6).toString("hex")}`;           // «contraseña» ficticia
const PIN_C = String(100000 + crypto.randomInt(800000));                        // «PIN» ficticio
const trozos = (s) => { const t = new Set(); for (let i = 0; i + 8 <= s.length; i++) t.add(s.slice(i, i + 8)); return [...t]; };
const FRAGMENTOS = [...trozos(CANARIO), PIN_C];

const REAL = await compilar("api-server/src/app.ts", { falsos: ["supabase", "ws"], nombre: "app-real" });
const SIN_MANEJADOR = await compilar("api-server/src/app.ts", { falsos: ["supabase", "ws"], nombre: "app-sin-manejador",
  mutar: (ruta, t) => (ruta === "api-server/src/app.ts" ? t.replace("app.use(crearManejadorErrores(logger));", "") : t) });
assert.notEqual(fs.readFileSync(fileURLToPath(REAL), "utf8").includes("crearManejadorErrores"), false);

function hijo(urlApp) {
  const dir = path.dirname(fileURLToPath(urlApp));
  const f = path.join(dir, `hijo-${crypto.randomBytes(4).toString("hex")}.mjs`);
  fs.writeFileSync(f, `
    const cliente = { auth: { getUser: async () => ({ data: { user: null }, error: { message: "sesion invalida" } }) },
      from: () => ({ select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; }, maybeSingle: async () => ({ data: null, error: null }), then: (ok) => ok({ data: [], error: null }) }),
      rpc: async () => ({ data: null, error: null }), storage: { from: () => ({}) } };
    globalThis.__PIN = { crearCliente: () => cliente };
    const { default: app } = await import(${JSON.stringify(urlApp)});
    const srv = app.listen(0, "127.0.0.1", () => process.stdout.write("PUERTO=" + srv.address().port + "\\n"));
    process.stdin.on("data", () => srv.close(() => setTimeout(() => process.exit(0), 300)));
  `);
  return f;
}

async function arrancar(urlApp, NODE_ENV) {
  const p = spawn(process.execPath, [hijo(urlApp)], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, NODE_ENV, LOG_LEVEL: "info",
    SUPABASE_URL: "https://proyecto-sintetico.example.test", SUPABASE_SERVICE_KEY: "SERVICIO-SINTETICO", SUPABASE_ANON_KEY: "ANONIMA-SINTETICA",
    ADMIN_PASSWORD: "PANEL-SINTETICO-no-es-el-canario", ADMIN_PIN_PEPPER: "pepper-sintetico-solo-para-pruebas-0123456789",
    ENTIMOTORS_ADMIN_ORIGIN: "https://taller.example.test", ENTIMOTORS_MECHANIC_ORIGIN: "https://mt.example.test" } });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
  const puerto = await new Promise((ok, mal) => {
    const t = setTimeout(() => mal(new Error(`no arrancó: ${err.slice(0, 500)}`)), 15000);
    const mirar = () => { const m = /PUERTO=(\d+)/.exec(out); if (m) { clearTimeout(t); ok(Number(m[1])); } };
    p.stdout.on("data", mirar); p.on("exit", (c) => { clearTimeout(t); mal(new Error(`salió ${c}: ${err.slice(0, 500)}`)); });
  });
  return {
    base: `http://127.0.0.1:${puerto}`,
    async cerrar() { const fin = new Promise((ok) => p.on("exit", ok)); p.stdin.write("fin\n"); await fin; return { out, err }; },
  };
}

const JSON_CT = { "content-type": "application/json" };
const ROTOS = [
  ["PUT /api/admin/pin · clave_cuenta cortada", "PUT", "/api/admin/pin", JSON_CT, `{"clave_cuenta":"${CANARIO}","pin_nuevo":"${PIN_C}"`],
  ["PUT /api/admin/pin · clave_cuenta sin comillas", "PUT", "/api/admin/pin", JSON_CT, `{"clave_cuenta":${CANARIO}}`],
  ["POST /api/autorizaciones · pin roto", "POST", "/api/autorizaciones", JSON_CT, `{"accion":"ajustar_stock","pin":${PIN_C}x}`],
  ["POST /api/admin/login · password sin comillas", "POST", "/api/admin/login", JSON_CT, `{"password":${CANARIO}}`],
  ["PATCH /api/admin/usuarios/x · cuerpo roto", "PATCH", "/api/admin/usuarios/x", JSON_CT, `{"password":"${CANARIO}",`],
  ["POST /api/admin/login · primer carácter inválido (modo estricto)", "POST", "/api/admin/login", JSON_CT, CANARIO],
];
const ESPERADO = {
  400: { error: "Cuerpo inválido.", codigo: "CUERPO_INVALIDO" },
  413: { error: "El cuerpo de la petición es demasiado grande.", codigo: "CUERPO_DEMASIADO_GRANDE" },
  415: { error: "Formato del cuerpo no admitido.", codigo: "CUERPO_NO_ADMITIDO" },
};
const OTROS = [
  ["413 · cuerpo JSON válido pero enorme con el canario", "POST", "/api/admin/login", JSON_CT, JSON.stringify({ password: CANARIO, relleno: "x".repeat(200 * 1024) }), 413],
  ["415 · charset no admitido (body-parser solo admite utf-*)", "POST", "/api/admin/login", { "content-type": "application/json; charset=iso-8859-1" }, `{"password":"${CANARIO}"}`, 415],
  ["415 · content-encoding no admitido", "POST", "/api/admin/login", { ...JSON_CT, "content-encoding": "x-desconocido" }, `{"password":"${CANARIO}"}`, 415],
];

async function pedir(base, metodo, ruta, cab, cuerpo) {
  const r = await fetch(base + ruta, { method: metodo, headers: { origin: "https://taller.example.test", ...cab }, body: cuerpo });
  const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch { /* no JSON */ }
  return { status: r.status, texto, json, cab: Object.fromEntries(r.headers), crudo: JSON.stringify([...r.headers]) + texto };
}
const sinFugas = (texto, donde) => { for (const f of FRAGMENTOS) assert.ok(!texto.includes(f), `${donde}: aparece un fragmento del canario`); };

for (const NODE_ENV of ["production", "development"]) {
  describe(`SECURITY-1B · app.ts real con NODE_ENV=${NODE_ENV}`, () => {
    let srv, logs = null; const vistas = [];
    after(async () => { if (srv && !logs) logs = await srv.cerrar(); });
    test("arranca", async () => { srv = await arrancar(REAL, NODE_ENV); });
    for (const [nombre, metodo, ruta, cab, cuerpo] of ROTOS) {
      test(`JSON roto → 400 genérico, no-store, sin canario en la respuesta · ${nombre}`, async () => {
        const r = await pedir(srv.base, metodo, ruta, cab, cuerpo); vistas.push(r);
        assert.equal(r.status, 400); assert.deepEqual(r.json, ESPERADO[400]); assert.equal(r.cab["cache-control"], "no-store");
        assert.match(r.cab["content-type"], /^application\/json/); sinFugas(r.crudo, "respuesta");
      });
    }
    for (const [nombre, metodo, ruta, cab, cuerpo, st] of OTROS) {
      test(`${nombre} → ${st} genérico, no-store, sin canario`, async () => {
        const r = await pedir(srv.base, metodo, ruta, cab, cuerpo); vistas.push(r);
        assert.equal(r.status, st); assert.deepEqual(r.json, ESPERADO[st]); assert.equal(r.cab["cache-control"], "no-store"); sinFugas(r.crudo, "respuesta");
      });
    }
    test("regresión: las peticiones válidas siguen igual (healthz 200; login y PIN responden con sus códigos de siempre)", async () => {
      const h = await pedir(srv.base, "GET", "/api/healthz", {}, undefined); assert.equal(h.status, 200); assert.deepEqual(h.json, { status: "ok" });
      const l = await pedir(srv.base, "POST", "/api/admin/login", JSON_CT, JSON.stringify({ password: CANARIO })); assert.equal(l.status, 401); assert.deepEqual(l.json, { error: "No se pudo iniciar sesión." }); sinFugas(l.crudo, "login");
      const p = await pedir(srv.base, "PUT", "/api/admin/pin", JSON_CT, JSON.stringify({ pin_nuevo: PIN_C, clave_cuenta: CANARIO })); assert.equal(p.status, 401); assert.equal(p.json.codigo, "SIN_SESION"); sinFugas(p.crudo, "pin");
      const n = await pedir(srv.base, "GET", "/api/no-existe", {}, undefined); assert.equal(n.status, 404);
    });
    test("logs (stdout + stderr del proceso): ningún fragmento del canario ni del PIN; ni SyntaxError, ni stack de Express; sí el evento cuerpo-rechazado", async () => {
      logs = await srv.cerrar(); const todo = logs.out + logs.err;
      sinFugas(todo, "logs");
      assert.doesNotMatch(todo, /SyntaxError|is not valid JSON|Unexpected token|at JSON\.parse/);
      assert.match(todo, /cuerpo-rechazado/); assert.match(todo, /entity\.parse\.failed/); assert.match(todo, /entity\.too\.large/); assert.match(todo, /charset\.unsupported/);
      assert.equal(logs.err.trim(), "", `stderr vacío (antes aquí salía el stack): ${logs.err.slice(0, 300)}`);
    });
  });
}

describe("SECURITY-1B · MUTANTE: app.ts SIN el manejador (el comportamiento de antes)", () => {
  test("el canario vuelve a aparecer en stderr → la prueba de logs detecta la fuga real", async () => {
    const s = await arrancar(SIN_MANEJADOR, "production");
    for (const [, metodo, ruta, cab, cuerpo] of ROTOS) await pedir(s.base, metodo, ruta, cab, cuerpo);
    const { out, err } = await s.cerrar();
    assert.ok(FRAGMENTOS.some((f) => (out + err).includes(f)), "sin manejador el fragmento DEBE salir en los logs (si no, la prueba no vería la fuga)");
    assert.match(err, /is not valid JSON|Unexpected token/);
  });
});

describe("SECURITY-1B · crearManejadorErrores (unidad, lib/errores-http.ts real)", async () => {
  const { crearManejadorErrores, pilaSinMensaje, ERRORES_DE_CUERPO } = await import(await compilar("api-server/src/lib/errores-http.ts", { falsos: [], nombre: "errores-http" }));
  const montar = () => {
    const logs = []; const h = crearManejadorErrores({ warn: (o, m) => logs.push(["warn", o, m]), error: (o, m) => logs.push(["error", o, m]) });
    const req = { method: "POST", originalUrl: `/api/admin/pin?token=${CANARIO}`, headers: { "content-length": "42" }, socket: { destroyed: false, destroy() { this.destroyed = true; } } };
    const res = { headersSent: false, codigo: 0, cab: {}, cuerpo: undefined, status(c) { this.codigo = c; return this; }, set(k, v) { this.cab[k] = v; return this; }, json(o) { this.cuerpo = o; return this; } };
    return { h, req, res, logs };
  };
  test("error NO controlado: 500 genérico; el log lleva nombre/código/marcos pero NI message NI body NI la query", () => {
    const { h, req, res, logs } = montar();
    const err = Object.assign(new TypeError(`fallo con ${CANARIO}`), { code: "E_X", body: `{"password":"${CANARIO}"}` });
    h(err, req, res, () => {});
    assert.equal(res.codigo, 500); assert.deepEqual(res.cuerpo, { error: "No se pudo completar la operación.", codigo: "ERROR_INTERNO" }); assert.equal(res.cab["Cache-Control"], "no-store");
    assert.equal(logs.length, 1); assert.equal(logs[0][1].nombre, "TypeError"); assert.equal(logs[0][1].codigo, "E_X"); assert.equal(logs[0][1].ruta, "/api/admin/pin");
    assert.ok(logs[0][1].pila.length > 0 && logs[0][1].pila.every((l) => l.startsWith("at ")));
    sinFugas(JSON.stringify(logs) + JSON.stringify(res), "unidad");
  });
  test("un error con status 4xx conserva su código con mensaje genérico", () => {
    const { h, req, res } = montar(); h(Object.assign(new Error(CANARIO), { status: 404 }), req, res, () => {});
    assert.equal(res.codigo, 404); assert.deepEqual(res.cuerpo, { error: "Petición no válida.", codigo: "PETICION_INVALIDA" });
  });
  test("cada tipo de body-parser tiene su código (400/403/413/415) y se registra solo el tipo", () => {
    for (const [tipo, r] of Object.entries(ERRORES_DE_CUERPO)) {
      const { h, req, res, logs } = montar(); h(Object.assign(new Error(CANARIO), { type: tipo, body: CANARIO }), req, res, () => {});
      assert.equal(res.codigo, r.status, tipo); assert.deepEqual(Object.keys(logs[0][1]).sort(), ["bytes", "evento", "metodo", "ruta", "status", "tipo"]); sinFugas(JSON.stringify(logs), tipo);
    }
  });
  test("respuesta ya enviada: no se escribe nada más y se corta la conexión (como Express)", () => {
    const { h, req, res } = montar(); res.headersSent = true; h(new Error("x"), req, res, () => {});
    assert.equal(res.codigo, 0); assert.equal(req.socket.destroyed, true);
  });
  test("pilaSinMensaje: nunca la primera línea (nombre + mensaje), aunque el mensaje tenga saltos de línea", () => {
    const e = new Error(`linea1 ${CANARIO}\n    at falso (${CANARIO})`);
    const p = pilaSinMensaje(e); assert.ok(p.length > 0, "quedan los marcos reales");
    assert.ok(p.every((l) => l.startsWith("at "))); sinFugas(JSON.stringify(p), "pila con mensaje multilínea que imita un marco");
    const raro = Object.assign(new Error("x"), { stack: `otra cosa ${CANARIO}\n    at y (${CANARIO})` });
    assert.deepEqual(pilaSinMensaje(raro), [], "formato desconocido: ningún marco (falla cerrado)");
    assert.deepEqual(pilaSinMensaje(null), []); assert.deepEqual(pilaSinMensaje({ stack: 7 }), []);
  });
});
