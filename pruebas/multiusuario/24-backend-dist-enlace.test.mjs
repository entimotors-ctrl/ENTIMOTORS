// FASE 4E-C9 · EL ARTEFACTO COMPILADO — api-server/dist/index.mjs es lo que ejecuta `pnpm start` (`node --enable-source-maps ./dist/index.mjs`).
// Las pruebas 21–23 ejercen el codigo FUENTE (TypeScript convertido a JS); esta arranca el BUNDLE versionado tal cual, como PROCESO real, contra
// un Supabase FALSO local (HTTP en 127.0.0.1) y comprueba POST /api/admin/usuarios/:id/enlace POR LA RED. Asi, si `dist/` se queda atras respecto de
// `src/` (o se compila sin la ruta), esta prueba falla aunque el fuente este bien.
//   · Sin red externa, sin Supabase real, sin `pnpm install` (el bundle es autocontenido), sin tocar ningun archivo.
//   · El proceso hijo recibe SOLO variables SINTETICAS (no hereda el entorno del desarrollador): ninguna clave ni URL reales.
//   · Ninguna cuenta ni enlace son reales: el «action_link» es una direccion .example.test con un token de mentira.
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { RAIZ } from "./helpers/entorno.mjs";

const API = path.join(RAIZ, "api-server"), DIST = path.join(API, "dist");
const SERVICIO = "CLAVE-DE-SERVICIO-FALSA-c9", ANON = "CLAVE-ANON-FALSA-c9", TOKEN_ENLACE = "TOKEN-DE-ENLACE-FALSO-c9";
const ORIGEN_TALLER = "https://taller.example.test", ORIGEN_MT = "https://mitrabajo.example.test";
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// id → { rol, activo, correo, generar }   (generar: cómo responde el generateLink falso para esa cuenta)
const PERFILES = new Map([
  [ID(1), { rol: "admin", activo: true, correo: "admin@example.test" }], [ID(2), { rol: "admin", activo: true, correo: "otro-admin@example.test" }],
  [ID(3), { rol: "mecanico", activo: true, correo: "mecanico@example.test" }], [ID(4), { rol: "cajero", activo: true, correo: "cajero@example.test" }],
  [ID(5), { rol: "desarrollador", activo: true, correo: "dev@example.test" }], [ID(6), { rol: "mecanico", activo: false, correo: "baja@example.test" }],
  [ID(7), { rol: "mecanico", activo: true, correo: "rechazo@example.test", generar: "rechazo" }], [ID(8), { rol: "mecanico", activo: true, correo: "malformado@example.test", generar: "sin-enlace" }],
  [ID(9), { rol: "mecanico", activo: true, correo: "js@example.test", generar: "javascript" }], [ID(10), { rol: "portero", activo: true, correo: "portero@example.test" }],
  [ID(11), { rol: "mecanico", activo: true, correo: "" }],
]);
const TOKENS = new Map([["TOKEN-ADMIN-FALSO", ID(1)], ["TOKEN-CAJERO-FALSO", ID(4)]]);
const llamadas = []; // lo que el servidor real le pidió al Supabase falso (para comprobar qué se envía)

function supabaseFalso() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1"); let cuerpo = "";
    req.on("data", (c) => { cuerpo += c; });
    req.on("end", () => {
      const json = (estado, o) => { res.writeHead(estado, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (u.pathname === "/auth/v1/user") { // getUser(token)
        const id = TOKENS.get(auth); if (!id) return json(401, { code: 401, error_code: "bad_jwt", msg: "token no valido (falso)" });
        return json(200, { id, aud: "authenticated", role: "authenticated", email: PERFILES.get(id).correo, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
      }
      if (u.pathname === "/rest/v1/perfiles") { // .from("perfiles").select(...).eq("id", x).maybeSingle()
        const id = (u.searchParams.get("id") ?? "").replace(/^eq\./, ""), p = PERFILES.get(id), fila = p && { id, nombre: `Persona ${id.slice(-2)}`, rol: p.rol, activo: p.activo };
        if (String(req.headers.accept ?? "").includes("pgrst.object")) return fila ? json(200, fila) : json(406, { code: "PGRST116", details: "0 rows", hint: null, message: "sin filas" });
        return json(200, fila ? [fila] : []);
      }
      let m;
      if ((m = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(u.pathname)) && req.method === "GET") { // getUserById
        const p = PERFILES.get(m[1]); return p ? json(200, { id: m[1], aud: "authenticated", role: "authenticated", email: p.correo, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" }) : json(404, { code: 404, msg: "no existe" });
      }
      if (u.pathname === "/auth/v1/admin/generate_link" && req.method === "POST") {
        // supabase-js manda la direccion de vuelta como parametro `redirect_to` de la URL; se mira tambien el cuerpo por si cambiara
        const b = JSON.parse(cuerpo || "{}"); llamadas.push({ tipo: b.type, correo: b.email, vuelta: u.searchParams.get("redirect_to") ?? b.redirect_to ?? b.options?.redirectTo, consulta: u.search, cuerpo: b });
        const p = [...PERFILES.values()].find((x) => x.correo === b.email);
        if (p?.generar === "rechazo") return json(422, { code: 422, error_code: "validation_failed", msg: "redirect_to no permitido (falso)" });
        const accion = p?.generar === "javascript" ? "javascript:alert(1)" : `https://supabase-falso.example.test/auth/v1/verify?token=${TOKEN_ENLACE}&type=recovery`;
        return json(200, { ...(p?.generar === "sin-enlace" ? {} : { action_link: accion }), email_otp: "000000", hashed_token: "HASH-FALSO", redirect_to: b.redirect_to, verification_type: "recovery", id: "x", aud: "authenticated", email: b.email });
      }
      return json(404, { msg: `ruta no simulada: ${req.method} ${u.pathname}` });
    });
  });
}
const puertoLibre = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Arranca `node --enable-source-maps ./dist/index.mjs` (el «start» de package.json) con un entorno SINTETICO y MINIMO. */
async function arrancar(puertoFalso, extra = {}) {
  const puerto = await puertoLibre(), salida = { texto: "" };
  const env = { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), NODE_ENV: "production", PORT: String(puerto), SUPABASE_URL: `http://127.0.0.1:${puertoFalso}`,
    SUPABASE_SERVICE_KEY: SERVICIO, SUPABASE_ANON_KEY: ANON, ENTIMOTORS_ADMIN_ORIGIN: ORIGEN_TALLER, ENTIMOTORS_MECHANIC_ORIGIN: ORIGEN_MT, ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const hijo = spawn(process.execPath, ["--enable-source-maps", "./dist/index.mjs"], { cwd: API, env, stdio: ["ignore", "pipe", "pipe"] });
  hijo.stdout.on("data", (c) => { salida.texto += c; }); hijo.stderr.on("data", (c) => { salida.texto += c; });
  let terminado = false; hijo.on("exit", () => { terminado = true; });
  for (let i = 0; i < 100; i++) { // hasta ~10 s a que acepte conexiones
    if (terminado) throw new Error(`el servidor compilado salió al arrancar:\n${salida.texto.slice(0, 600)}`);
    const abierto = await new Promise((ok) => { const c = net.connect(puerto, "127.0.0.1"); c.once("connect", () => { c.destroy(); ok(true); }); c.once("error", () => ok(false)); });
    if (abierto) return { puerto, hijo, salida, base: `http://127.0.0.1:${puerto}` };
    await esperar(100);
  }
  hijo.kill("SIGKILL"); throw new Error(`el servidor compilado no abrió el puerto:\n${salida.texto.slice(0, 600)}`);
}
async function pedir(srv, ruta, { metodo = "POST", token, cuerpo } = {}) {
  const r = await fetch(srv.base + ruta, { method: metodo, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cuerpo ? { "content-type": "application/json" } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch { /* no JSON */ }
  return { estado: r.status, json, texto, cabeceras: r.headers };
}

describe("dist · los archivos compilados son válidos y traen la ruta nueva", () => {
  const mjs = fs.readdirSync(DIST).filter((f) => f.endsWith(".mjs")).sort();
  test("hay 5 módulos .mjs y sus 5 mapas versionados", () => { assert.deepEqual(mjs, ["index.mjs", "pino-file.mjs", "pino-pretty.mjs", "pino-worker.mjs", "thread-stream-worker.mjs"]); for (const f of mjs) assert.ok(fs.existsSync(path.join(DIST, `${f}.map`)), `${f}.map`); });
  for (const f of mjs) test(`node --check ${f}`, () => { const r = spawnSync(process.execPath, ["--check", path.join(DIST, f)], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); });
  test("index.mjs monta POST /admin/usuarios/:id/enlace y devuelve enlaceParaEstablecerClave (y ya NO monta rutas retiradas)", () => {
    const t = fs.readFileSync(path.join(DIST, "index.mjs"), "utf8");
    assert.ok(t.includes('"/admin/usuarios/:id/enlace"'), "falta la ruta en el bundle"); assert.ok((t.match(/enlaceParaEstablecerClave/g) ?? []).length >= 2);
    assert.ok(!/rifa/i.test(t.slice(t.indexOf("// src/routes/index.ts"))), "el bundle no debe traer la ruta de la rifa (retirada)");
  });
});

describe("dist · el servidor COMPILADO, como proceso real, contra un Supabase falso", { concurrency: false }, () => {
  let falso, srv;
  before(async () => { falso = supabaseFalso(); await new Promise((ok) => falso.listen(0, "127.0.0.1", ok)); srv = await arrancar(falso.address().port); });
  after(async () => { srv?.hijo.kill("SIGKILL"); await new Promise((ok) => (falso ? falso.close(ok) : ok())); });
  const pedirEnlace = (id, opts = {}) => pedir(srv, `/api/admin/usuarios/${id}/enlace`, { token: "TOKEN-ADMIN-FALSO", ...opts });

  test("arranca con `node --enable-source-maps ./dist/index.mjs` y responde /api/healthz; una ruta inexistente y la de la rifa dan 404", async () => {
    assert.deepEqual((await pedir(srv, "/api/healthz", { metodo: "GET" })).json, { status: "ok" });
    assert.equal((await pedir(srv, "/api/no-existe", { metodo: "GET" })).estado, 404); assert.equal((await pedir(srv, "/api/rifa", { metodo: "POST", cuerpo: {} })).estado, 404);
  });
  test("autorización: sin token → 401; token desconocido → 401; token de un NO administrador (cajero) → 403; nunca se llega a generar un enlace", async () => {
    const antes = llamadas.length;
    assert.equal((await pedir(srv, `/api/admin/usuarios/${ID(3)}/enlace`)).estado, 401);
    assert.equal((await pedir(srv, `/api/admin/usuarios/${ID(3)}/enlace`, { token: "TOKEN-INVENTADO" })).estado, 401);
    const c = await pedir(srv, `/api/admin/usuarios/${ID(3)}/enlace`, { token: "TOKEN-CAJERO-FALSO" }); assert.equal(c.estado, 403); assert.equal(c.json.enlaceParaEstablecerClave, undefined);
    assert.equal(llamadas.length, antes);
  });
  test("mecánico activo → 200 con SOLO {enlaceParaEstablecerClave, nota}, Cache-Control: no-store, y el enlace vuelve a «Mi Trabajo» (origen del servidor)", async () => {
    const r = await pedirEnlace(ID(3)); assert.equal(r.estado, 200, r.texto); assert.deepEqual(Object.keys(r.json).sort(), ["enlaceParaEstablecerClave", "nota"]);
    assert.equal(r.cabeceras.get("cache-control"), "no-store"); assert.match(r.json.enlaceParaEstablecerClave, /^https:\/\/supabase-falso\.example\.test\/auth\/v1\/verify\?token=/);
    const l = llamadas.at(-1); assert.equal(l.tipo, "recovery"); assert.equal(l.correo, "mecanico@example.test"); assert.ok(String(l.vuelta).startsWith(ORIGEN_MT), l.vuelta);
  });
  test("cajero y desarrollador activos → 200 y vuelven al TALLER (origen del servidor)", async () => {
    for (const id of [ID(4), ID(5)]) { const r = await pedirEnlace(id); assert.equal(r.estado, 200, r.texto); assert.ok(String(llamadas.at(-1).vuelta).startsWith(ORIGEN_TALLER), llamadas.at(-1).vuelta); }
  });
  test("rechazos por regla: propio admin → 400, OTRO admin → 400, inactivo → 409, rol desconocido → 409, inexistente → 404, id mal formado → 400; ninguno genera enlace", async () => {
    const antes = llamadas.length;
    for (const [id, esperado] of [[ID(1), 400], [ID(2), 400], [ID(6), 409], [ID(10), 409], [ID(99), 404], ["no-es-un-id", 400], ["../../etc/passwd", 404], [`${ID(3)}%20`, 400]]) {
      const r = await pedirEnlace(id); assert.equal(r.estado, esperado, `${id} → ${r.estado} ${r.texto}`); assert.equal(r.json?.enlaceParaEstablecerClave, undefined, id);
    }
    assert.equal(llamadas.length, antes, "se pidió un enlace a Supabase para una cuenta que debía rechazarse");
  });
  test("cuenta sin correo en Auth → 409, sin llamar a generate_link", async () => { const antes = llamadas.length; const r = await pedirEnlace(ID(11)); assert.equal(r.estado, 409); assert.equal(llamadas.length, antes); });
  test("correo, rol, redirect y destino del CLIENTE se IGNORAN (cuerpo y query): se usa lo que hay en la base y el origen fijado por el servidor", async () => {
    const r = await pedir(srv, `/api/admin/usuarios/${ID(3)}/enlace?redirect_to=https://evil.example.test&redirectTo=https://evil.example.test&email=otro@example.test`, { token: "TOKEN-ADMIN-FALSO",
      cuerpo: { email: "victima@example.test", correo: "victima@example.test", rol: "admin", redirectTo: "https://evil.example.test", redirect_to: "https://evil.example.test", destino: "https://evil.example.test", type: "magiclink" } });
    assert.equal(r.estado, 200, r.texto); const l = llamadas.at(-1);
    assert.equal(l.correo, "mecanico@example.test"); assert.equal(l.tipo, "recovery"); assert.ok(String(l.vuelta).startsWith(ORIGEN_MT), l.vuelta);
    assert.ok(!JSON.stringify(l.cuerpo).includes("evil.example.test") && !JSON.stringify(l.cuerpo).includes("victima") && !l.consulta.includes("evil.example.test") && !l.consulta.includes("victima"), "algo del cliente llegó a generate_link");
  });
  test("generateLink rechazado por Supabase → 502 con un aviso propio (sin el mensaje ni el cuerpo de Supabase); respuesta sin action_link → 502; action_link no http(s) → 502", async () => {
    for (const id of [ID(7), ID(8), ID(9)]) { const r = await pedirEnlace(id); assert.equal(r.estado, 502, `${id}: ${r.texto}`); assert.equal(r.json.enlaceParaEstablecerClave, undefined); assert.ok(!/redirect_to no permitido|javascript:|validation_failed/.test(r.texto), r.texto); }
  });
  test("SIN FUGAS: ni las claves, ni el token de sesión, ni el token del enlace, ni los correos aparecen en NINGUNA respuesta de error ni en los registros del proceso", async () => {
    await pedirEnlace(ID(7)); await pedirEnlace(ID(3)); await esperar(200);
    const log = srv.salida.texto; assert.ok(log.length > 0, "el servidor no escribió ningún registro (no se puede probar que no hay fugas)");
    for (const secreto of [SERVICIO, ANON, TOKEN_ENLACE, "TOKEN-ADMIN-FALSO", "TOKEN-CAJERO-FALSO", "supabase-falso.example.test", "mecanico@example.test", "rechazo@example.test", "victima@example.test"]) assert.ok(!log.includes(secreto), `el registro contiene un secreto sintético: ${secreto.slice(0, 12)}…`);
    assert.match(log, /enlace-recuperacion-generado/, "se esperaba el registro con SOLO ids"); assert.match(log, /supabase-rechazo/, "se esperaba el motivo del rechazo");
  });
});

describe("dist · sin SUPABASE_ANON_KEY la gestión de usuarios queda apagada (503) y no se toca Supabase", { concurrency: false }, () => {
  let falso, srv;
  before(async () => { falso = supabaseFalso(); await new Promise((ok) => falso.listen(0, "127.0.0.1", ok)); srv = await arrancar(falso.address().port, { SUPABASE_ANON_KEY: undefined }); });
  after(async () => { srv?.hijo.kill("SIGKILL"); await new Promise((ok) => (falso ? falso.close(ok) : ok())); });
  test("POST /api/admin/usuarios/:id/enlace → 503, sin enlace", async () => { const antes = llamadas.length; const r = await pedir(srv, `/api/admin/usuarios/${ID(3)}/enlace`, { token: "TOKEN-ADMIN-FALSO" }); assert.equal(r.estado, 503); assert.equal(r.json.enlaceParaEstablecerClave, undefined); assert.equal(llamadas.length, antes); });
});
