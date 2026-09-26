// BACKEND-SEC1D-PREP · EL ARTEFACTO COMPILADO con SECURITY-1B y SECURITY-1D. Igual que la 24: arranca api-server/dist/index.mjs TAL CUAL
// (`node --enable-source-maps ./dist/index.mjs`), como proceso real, con variables SINTÉTICAS y un Supabase FALSO en 127.0.0.1.
// Comprueba PUT /api/admin/clave por la red: sin sesión, sesión inválida, rol, cuerpo, CORS, límite de intentos (las RPC de SECURITY-1C con
// la firma EXACTA de producción) y que un JSON roto con un canario no deja el canario ni en stdout/stderr ni en la respuesta.
//   · Sin red externa, sin Supabase ni GoTrue reales, sin credenciales: ninguna cuenta, contraseña ni token son reales.
//   · Nunca llega a cambiar una contraseña: el flujo completo con GoTrue real es pruebas/sync/gotrue/sec1d-cambio-clave.test.mjs.
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { RAIZ } from "./helpers/entorno.mjs";

const API = path.join(RAIZ, "api-server"), DIST = path.join(API, "dist");
const SERVICIO = "CLAVE-DE-SERVICIO-FALSA-sec1d", ANON = "CLAVE-ANON-FALSA-sec1d";
const ORIGEN_TALLER = "https://taller.example.test", ORIGEN_MT = "https://mitrabajo.example.test", ORIGEN_MALO = "https://malo.example.test";
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PERFILES = new Map([[ID(1), { rol: "admin", activo: true, correo: "admin@example.test" }], [ID(2), { rol: "cajero", activo: true, correo: "cajero@example.test" }],
  [ID(3), { rol: "admin", activo: false, correo: "baja@example.test" }]]);
const TOKENS = new Map([["TOKEN-ADMIN-FALSO", ID(1)], ["TOKEN-CAJERO-FALSO", ID(2)], ["TOKEN-BAJA-FALSO", ID(3)]]);
const llamadas = [];                 // todo lo que el servidor le pidió al Supabase falso fuera de getUser/perfiles
let respuestaReserva = { permitido: false, motivo: "bloqueado", reintentar_en_s: 900 };

function supabaseFalso() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1"); let cuerpo = "";
    req.on("data", (c) => { cuerpo += c; });
    req.on("end", () => {
      const json = (estado, o) => { res.writeHead(estado, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (u.pathname === "/auth/v1/user" && req.method === "GET") {
        const id = TOKENS.get(auth); if (!id) return json(403, { code: 403, error_code: "session_not_found", msg: "sesión inexistente (falso)" });
        return json(200, { id, aud: "authenticated", role: "authenticated", email: PERFILES.get(id).correo, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
      }
      if (u.pathname === "/rest/v1/perfiles") {
        const id = (u.searchParams.get("id") ?? "").replace(/^eq\./, ""), p = PERFILES.get(id), fila = p && { id, nombre: "Persona Falsa", rol: p.rol, activo: p.activo };
        if (String(req.headers.accept ?? "").includes("pgrst.object")) return fila ? json(200, fila) : json(406, { code: "PGRST116", details: "0 rows", hint: null, message: "sin filas" });
        return json(200, fila ? [fila] : []);
      }
      llamadas.push({ metodo: req.method, ruta: u.pathname + u.search, cuerpo: cuerpo ? JSON.parse(cuerpo) : null, apikey: req.headers.apikey });
      if (u.pathname === "/rest/v1/rpc/clave_reservar_intento") return json(200, respuestaReserva);
      return json(500, { msg: `ruta no simulada: ${req.method} ${u.pathname}` });
    });
  });
}
const puertoLibre = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function arrancar(puertoFalso) {
  const puerto = await puertoLibre(), salida = { texto: "" };
  const env = { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), NODE_ENV: "production", PORT: String(puerto), SUPABASE_URL: `http://127.0.0.1:${puertoFalso}`,
    SUPABASE_SERVICE_KEY: SERVICIO, SUPABASE_ANON_KEY: ANON, ENTIMOTORS_ADMIN_ORIGIN: ORIGEN_TALLER, ENTIMOTORS_MECHANIC_ORIGIN: ORIGEN_MT };
  const hijo = spawn(process.execPath, ["--enable-source-maps", "./dist/index.mjs"], { cwd: API, env, stdio: ["ignore", "pipe", "pipe"] });
  hijo.stdout.on("data", (c) => { salida.texto += c; }); hijo.stderr.on("data", (c) => { salida.texto += c; });
  let terminado = false; hijo.on("exit", () => { terminado = true; });
  for (let i = 0; i < 100; i++) {
    if (terminado) throw new Error(`el servidor compilado salió al arrancar:\n${salida.texto.slice(0, 600)}`);
    const abierto = await new Promise((ok) => { const c = net.connect(puerto, "127.0.0.1"); c.once("connect", () => { c.destroy(); ok(true); }); c.once("error", () => ok(false)); });
    if (abierto) return { hijo, salida, base: `http://127.0.0.1:${puerto}` };
    await esperar(100);
  }
  hijo.kill("SIGKILL"); throw new Error("el servidor compilado no abrió el puerto");
}
async function pedir(srv, ruta, { metodo = "PUT", token, cuerpo, crudo, tipo = "application/json", origen, cabeceras = {} } = {}) {
  const h = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cuerpo !== undefined || crudo !== undefined ? { "content-type": tipo } : {}), ...(origen ? { origin: origen } : {}), ...cabeceras };
  const r = await fetch(srv.base + ruta, { method: metodo, headers: h, body: crudo !== undefined ? crudo : cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined });
  const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch { /* no JSON */ }
  return { estado: r.status, json, texto, cabeceras: r.headers };
}
const valida = () => { const n = `frase ${crypto.randomBytes(6).toString("hex")} lenta de marzo`; return { clave_actual: "actual-sintetica-larga", clave_nueva: n, clave_confirmacion: n }; };

describe("dist · el bundle trae SECURITY-1B y SECURITY-1D", () => {
  const t = fs.readFileSync(path.join(DIST, "index.mjs"), "utf8");
  test("ruta, códigos, auditoría, scopes de GoTrue, RPC de SECURITY-1C y manejador final de errores", () => {
    assert.match(t, /\.put\("\/admin\/clave"/);
    for (const s of ["CUERPO_INVALIDO", "CAMBIO_EN_CURSO", "DEMASIADOS_INTENTOS", "AUTH_NO_DISPONIBLE", "SESION_INVALIDA", '"cambio-clave-admin"', "/auth/v1/logout?scope=local",
      "/auth/v1/logout?scope=others", '"clave_reservar_intento"', '"clave_resolver_intento"', "crearManejadorErrores", "reauthentication_needed"]) assert.ok(t.includes(s), `falta ${s}`);
    // en el código del PROYECTO (no en supabase-js), toda llamada a /auth/v1/logout lleva scope=local u scope=others: nunca sin scope ni global
    // solo las secciones de módulos del proyecto (esbuild las marca con «// src/…»; las de node_modules van intercaladas)
    const propio = t.split(/\n(?=\/\/ [\w@./+-]+\.(?:ts|js|mjs|cjs|json)\n)/).filter((s) => s.startsWith("// src/")).join("\n");
    assert.ok(propio.includes("// src/routes/admin-clave.ts"));
    const cierres = propio.match(/\/auth\/v1\/logout[^"'`\s]*/g) ?? [];
    assert.ok(cierres.length >= 3); for (const c of cierres) assert.match(c, /^\/auth\/v1\/logout\?scope=(local|others)$/, c);
    assert.ok(!/\.auth\.admin\.signOut\(|\.auth\.signOut\(/.test(propio), "el backend no debe cerrar sesiones con signOut de supabase-js (scope global por defecto)");
  });
  test("módulos fuente de SECURITY-1B/1D presentes en el bundle", () => {
    for (const m of ["src/lib/errores-http.ts", "src/lib/clave-cuenta.ts", "src/lib/clave-admin.ts", "src/routes/admin-clave.ts"]) assert.ok(t.includes(`// ${m}`), m);
  });
});

describe("dist · PUT /api/admin/clave en el servidor COMPILADO contra un Supabase falso", { concurrency: false }, () => {
  let falso, srv;
  before(async () => { falso = supabaseFalso(); await new Promise((ok) => falso.listen(0, "127.0.0.1", ok)); srv = await arrancar(falso.address().port); });
  after(async () => { srv?.hijo.kill("SIGKILL"); await new Promise((ok) => (falso ? falso.close(ok) : ok())); });

  test("GET /api/healthz → 200 {status:ok}", async () => { const r = await pedir(srv, "/api/healthz", { metodo: "GET" }); assert.equal(r.estado, 200); assert.deepEqual(r.json, { status: "ok" }); });

  test("sin sesión → 401 SIN_SESION (no-store); sesión revocada/inválida → 401 SESION_INVALIDA; nada llega a las RPC", async () => {
    const antes = llamadas.length;
    const a = await pedir(srv, "/api/admin/clave", { cuerpo: valida() }); assert.deepEqual([a.estado, a.json.codigo], [401, "SIN_SESION"]); assert.equal(a.cabeceras.get("cache-control"), "no-store");
    const b = await pedir(srv, "/api/admin/clave", { cuerpo: valida(), token: "TOKEN-REVOCADO" }); assert.deepEqual([b.estado, b.json.codigo], [401, "SESION_INVALIDA"]);
    assert.equal(llamadas.length, antes);
  });

  test("rol y perfil: cajero → 403 SOLO_ADMIN; admin inactivo → 403 CUENTA_INACTIVA; sin RPC", async () => {
    const antes = llamadas.length;
    assert.equal((await pedir(srv, "/api/admin/clave", { cuerpo: valida(), token: "TOKEN-CAJERO-FALSO" })).json.codigo, "SOLO_ADMIN");
    assert.equal((await pedir(srv, "/api/admin/clave", { cuerpo: valida(), token: "TOKEN-BAJA-FALSO" })).json.codigo, "CUENTA_INACTIVA");
    assert.equal(llamadas.length, antes);
  });

  test("cuerpo: no JSON → 400; campos de más/de menos → 400 CUERPO_INVALIDO; confirmación distinta → 400; débil (política local 12+) → 400 CLAVE_DEBIL; ninguno reserva", async () => {
    const antes = llamadas.length, tk = "TOKEN-ADMIN-FALSO";
    assert.equal((await pedir(srv, "/api/admin/clave", { crudo: "clave=x", tipo: "text/plain", token: tk })).json.codigo, "CUERPO_INVALIDO");
    assert.equal((await pedir(srv, "/api/admin/clave", { cuerpo: { ...valida(), correo: "otro@example.test" }, token: tk })).json.codigo, "CUERPO_INVALIDO");
    assert.equal((await pedir(srv, "/api/admin/clave", { cuerpo: { clave_actual: "x", clave_nueva: "y" }, token: tk })).json.codigo, "CUERPO_INVALIDO");
    assert.equal((await pedir(srv, "/api/admin/clave", { cuerpo: { clave_actual: "a", clave_nueva: "frase larga de prueba uno", clave_confirmacion: "frase larga de prueba dos" }, token: tk })).json.codigo, "CLAVES_NO_COINCIDEN");
    assert.equal((await pedir(srv, "/api/admin/clave", { cuerpo: { clave_actual: "a", clave_nueva: "corta6", clave_confirmacion: "corta6" }, token: tk })).json.codigo, "CLAVE_DEBIL");
    assert.equal(llamadas.length, antes);
  });

  test("límite SECURITY-1C: la reserva usa la firma EXACTA de producción (5/15/15/90); bloqueado → 429 DEMASIADOS_INTENTOS + Retry-After; en_curso → 409", async () => {
    respuestaReserva = { permitido: false, motivo: "bloqueado", reintentar_en_s: 900 };
    const r = await pedir(srv, "/api/admin/clave", { cuerpo: valida(), token: "TOKEN-ADMIN-FALSO" });
    assert.deepEqual([r.estado, r.json.codigo, r.cabeceras.get("retry-after")], [429, "DEMASIADOS_INTENTOS", "900"]);
    const l = llamadas.at(-1);
    assert.equal(l.ruta, "/rest/v1/rpc/clave_reservar_intento"); assert.equal(l.apikey, SERVICIO);
    assert.deepEqual(l.cuerpo, { p_perfil: ID(1), p_max: 5, p_ventana_min: 15, p_bloqueo_min: 15, p_ttl_seg: 90 });
    respuestaReserva = { permitido: false, motivo: "en_curso", reintentar_en_s: 40 };
    const c = await pedir(srv, "/api/admin/clave", { cuerpo: valida(), token: "TOKEN-ADMIN-FALSO" });
    assert.deepEqual([c.estado, c.json.codigo, c.cabeceras.get("retry-after")], [409, "CAMBIO_EN_CURSO", "40"]);
    assert.ok(!llamadas.some((x) => x.ruta.startsWith("/auth/v1/token") || x.ruta.startsWith("/auth/v1/logout") || x.metodo === "PUT"), "bloqueado/en curso no debe tocar GoTrue");
  });

  test("CORS: origen no permitido → 403 ORIGEN_NO_PERMITIDO (también el preflight); origen aprobado → Access-Control-Allow-Origin exacto", async () => {
    const antes = llamadas.length;
    const m = await pedir(srv, "/api/admin/clave", { cuerpo: valida(), token: "TOKEN-ADMIN-FALSO", origen: ORIGEN_MALO });
    assert.deepEqual([m.estado, m.json.codigo], [403, "ORIGEN_NO_PERMITIDO"]); assert.equal(m.cabeceras.get("access-control-allow-origin"), null);
    const p = await pedir(srv, "/api/admin/clave", { metodo: "OPTIONS", origen: ORIGEN_MALO, cabeceras: { "access-control-request-method": "PUT" } });
    assert.equal(p.estado, 403); assert.equal(p.cabeceras.get("access-control-allow-origin"), null);
    const ok = await pedir(srv, "/api/admin/clave", { metodo: "OPTIONS", origen: ORIGEN_TALLER, cabeceras: { "access-control-request-method": "PUT", "access-control-request-headers": "authorization,content-type" } });
    assert.ok(ok.estado >= 200 && ok.estado < 300, String(ok.estado)); assert.equal(ok.cabeceras.get("access-control-allow-origin"), ORIGEN_TALLER);
    assert.equal(llamadas.length, antes);
  });

  test("JSON roto con CANARIO (clave y PIN): 400 CUERPO_INVALIDO genérico; el canario NO aparece en la respuesta, stdout ni stderr", async () => {
    const canario = `CANARIO-SEC1D-${crypto.randomBytes(8).toString("hex")}`;
    for (const [ruta, metodo, crudo] of [["/api/admin/clave", "PUT", `{"clave_actual":"${canario}","clave_nueva":"${canario}"`], ["/api/admin/clave", "PUT", `{"clave_actual": ${canario}}`],
      ["/api/admin/pin", "PUT", `{"clave_cuenta":"${canario}",`]]) {
      const r = await pedir(srv, ruta, { metodo, crudo, token: "TOKEN-ADMIN-FALSO" });
      assert.deepEqual([r.estado, r.json], [400, { error: "Cuerpo inválido.", codigo: "CUERPO_INVALIDO" }], ruta);
      assert.equal(r.cabeceras.get("cache-control"), "no-store"); assert.ok(!r.texto.includes(canario));
    }
    await esperar(300);
    assert.ok(!srv.salida.texto.includes(canario), "el canario apareció en stdout/stderr");
    assert.ok(!srv.salida.texto.includes(canario.slice(0, 20)));
    assert.match(srv.salida.texto, /cuerpo-rechazado/, "el rechazo sí queda registrado (sin el cuerpo)");
    for (const s of [SERVICIO, ANON, "TOKEN-ADMIN-FALSO"]) assert.ok(!srv.salida.texto.includes(s), "secreto sintético en los logs");
  });
});
