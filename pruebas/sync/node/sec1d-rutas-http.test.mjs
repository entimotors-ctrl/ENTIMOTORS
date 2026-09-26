// SECURITY-1D · PUT /api/admin/clave por HTTP: app.ts REAL (Express 5, CORS selectivo, body-parser, logger pino REALES) como proceso hijo;
// solo Supabase es falso (registra cada RPC e inserción y las vuelca al terminar). GoTrue apunta a un puerto cerrado de 127.0.0.1:
// el camino completo de un admin termina en «proveedor no disponible» → reserva ANULADA → 503 (probado de punta a punta por HTTP).
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compilar } from "./helpers/compilar.mjs";

const ACTUAL = `CANARIO-A-${crypto.randomBytes(5).toString("hex")} frase`, NUEVA = `CANARIO-N-${crypto.randomBytes(5).toString("hex")} volcan marzo`;
const APP = await compilar("api-server/src/app.ts", { falsos: ["supabase", "ws"], nombre: "app-1d" });
const A = "00000000-0000-4000-8000-000000000001", C = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000006";
const ORIGEN = "https://taller.example.test";

function hijo() {
  const f = path.join(path.dirname(fileURLToPath(APP)), `hijo-1d-${crypto.randomBytes(4).toString("hex")}.mjs`);
  fs.writeFileSync(f, `
    const usuarios = { "tk-admin": { id: "${A}", email: "gerente.taller@example.test" }, "tk-caja": { id: "${C}", email: "caja@example.test" }, "tk-baja": { id: "${B}", email: "baja@example.test" } };
    const perfiles = { "${A}": { id: "${A}", nombre: "Rosa Mejía", rol: "admin", activo: true }, "${C}": { id: "${C}", nombre: "Caja", rol: "cajero", activo: true }, "${B}": { id: "${B}", nombre: "Baja", rol: "admin", activo: false } };
    const reg = { rpc: [], insert: [] };
    const cliente = {
      auth: { getUser: async (t) => usuarios[t] ? { data: { user: usuarios[t] }, error: null } : t === "tk-caida" ? { data: { user: null }, error: { message: "fetch failed", status: 0 } } : { data: { user: null }, error: { message: "invalid", status: 403 } } },
      from: (tabla) => { const q = { eq: [] }; const api = { select() { return api; }, order() { return api; }, limit() { return api; }, eq(c, v) { q.eq.push(v); return api; },
        maybeSingle: async () => ({ data: tabla === "perfiles" ? perfiles[q.eq[0]] ?? null : null, error: null }),
        insert: async (fila) => { reg.insert.push({ tabla, fila }); return { error: null }; }, then: (ok) => ok({ data: [], error: null }) }; return api; },
      rpc: async (nombre, args) => { reg.rpc.push({ nombre, args }); return nombre === "clave_reservar_intento" ? { data: { permitido: true, intento_id: 77, intentos_restantes: 4 }, error: null } : { data: { resultado: args.p_resultado }, error: null }; },
      storage: { from: () => ({}) },
    };
    globalThis.__PIN = { crearCliente: () => cliente };
    const { default: app } = await import(${JSON.stringify(APP)});
    const srv = app.listen(0, "127.0.0.1", () => process.stdout.write("PUERTO=" + srv.address().port + "\\n"));
    process.stdin.on("data", () => srv.close(() => { process.stdout.write("REG=" + JSON.stringify(reg) + "\\n"); setTimeout(() => process.exit(0), 200); }));
  `);
  return f;
}
const p = spawn(process.execPath, [hijo()], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, NODE_ENV: "production", LOG_LEVEL: "info",
  SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_KEY: "SERVICIO-SINTETICO", SUPABASE_ANON_KEY: "ANONIMA-SINTETICA", ADMIN_PASSWORD: "PANEL-SINTETICO",
  ADMIN_PIN_PEPPER: "pepper-sintetico-solo-para-pruebas-0123456789", ENTIMOTORS_ADMIN_ORIGIN: ORIGEN, ENTIMOTORS_MECHANIC_ORIGIN: "https://mt.example.test" } });
let out = "", errTxt = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { errTxt += d; });
const BASE = await new Promise((ok, mal) => { const t = setTimeout(() => mal(new Error("no arrancó: " + errTxt)), 15000); p.stdout.on("data", () => { const m = /PUERTO=(\d+)/.exec(out); if (m) { clearTimeout(t); ok(`http://127.0.0.1:${m[1]}`); } }); });
let final = null;
async function cerrar() { if (final) return final; const fin = new Promise((ok) => p.on("exit", ok)); p.stdin.write("fin\n"); await fin; final = { out, err: errTxt, reg: JSON.parse(/REG=(.*)/.exec(out)[1]) }; return final; }
after(cerrar);

const CUERPO = JSON.stringify({ clave_actual: ACTUAL, clave_nueva: NUEVA, clave_confirmacion: NUEVA });
async function put({ token, ct = "application/json", body = CUERPO, origin = ORIGEN, metodo = "PUT" } = {}) {
  const h = { ...(ct ? { "content-type": ct } : {}), ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const r = await fetch(`${BASE}/api/admin/clave`, { method: metodo, headers: h, body: metodo === "OPTIONS" ? undefined : body });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* vacío */ }
  return { status: r.status, j, cab: Object.fromEntries(r.headers), crudo: t };
}

describe("SECURITY-1D · PUT /api/admin/clave por HTTP (Express real)", () => {
  for (const [nombre, opc, st, codigo] of [
    ["sin Bearer", {}, 401, "SIN_SESION"], ["token inválido", { token: "tk-falso" }, 401, "SESION_INVALIDA"],
    ["GoTrue caído al identificar (no es «sesión inválida»; no reserva)", { token: "tk-caida" }, 503, "AUTH_NO_DISPONIBLE"],
    ["CAJERO (no puede gastar intentos del admin)", { token: "tk-caja" }, 403, "SOLO_ADMIN"], ["admin INACTIVO", { token: "tk-baja" }, 403, "CUENTA_INACTIVA"],
    ["Content-Type text/plain", { token: "tk-admin", ct: "text/plain" }, 400, "CUERPO_INVALIDO"], ["sin Content-Type", { token: "tk-admin", ct: null }, 400, "CUERPO_INVALIDO"],
    ["cuerpo > 2 KB", { token: "tk-admin", body: JSON.stringify({ clave_actual: ACTUAL, clave_nueva: "x".repeat(3000), clave_confirmacion: "x" }) }, 400, "CUERPO_INVALIDO"],
    ["JSON roto (SECURITY-1B sigue)", { token: "tk-admin", body: `{"clave_actual":${ACTUAL}` }, 400, "CUERPO_INVALIDO"],
    ["origen no aprobado", { token: "tk-admin", origin: "https://malo.example.test" }, 403, "ORIGEN_NO_PERMITIDO"],
    ["campo extra en el cuerpo", { token: "tk-admin", body: JSON.stringify({ clave_actual: ACTUAL, clave_nueva: NUEVA, clave_confirmacion: NUEVA, user_id: A }) }, 400, "CUERPO_INVALIDO"],
  ]) test(`${nombre} → ${st} ${codigo}, no-store, sin secretos en la respuesta`, async () => {
    const r = await put(opc);
    assert.equal(r.status, st); assert.equal(r.j.codigo, codigo);
    if (codigo !== "ORIGEN_NO_PERMITIDO") assert.equal(r.cab["cache-control"], "no-store");
    assert.ok(!r.crudo.includes(ACTUAL) && !r.crudo.includes(NUEVA));
  });
  test("preflight CORS del Taller: 204 con el origen aprobado", async () => {
    const r = await put({ metodo: "OPTIONS", ct: null }); assert.equal(r.status, 204); assert.equal(r.cab["access-control-allow-origin"], ORIGEN);
  });
  test("admin real con GoTrue inalcanzable → reserva → verificación sin respuesta → ANULADO → 503 AUTH_NO_DISPONIBLE", async () => {
    const r = await put({ token: "tk-admin" });
    assert.deepEqual([r.status, r.j], [503, { error: "El servicio de cuentas no respondió. Inténtalo de nuevo en unos minutos.", codigo: "AUTH_NO_DISPONIBLE" }]);
    assert.equal(r.cab["cache-control"], "no-store");
  });
  test("al terminar: SOLO el admin real llegó a reservar (1 reserva + 1 anulado, con los parámetros de SECURITY-1C); nadie más gastó intentos; sin auditoría; logs sin secretos", async () => {
    const f = await cerrar();
    assert.deepEqual(f.reg.rpc, [
      { nombre: "clave_reservar_intento", args: { p_perfil: A, p_max: 5, p_ventana_min: 15, p_bloqueo_min: 15, p_ttl_seg: 90 } },
      { nombre: "clave_resolver_intento", args: { p_perfil: A, p_intento: 77, p_resultado: "anulado", p_max: 5, p_ventana_min: 15, p_bloqueo_min: 15 } },
    ]);
    assert.deepEqual(f.reg.insert, [], "sin cambio → sin auditoría de cambio");
    const logs = f.out.replace(/REG=.*/, "") + f.err;
    for (const s of [ACTUAL, NUEVA, ...ACTUAL.match(/.{8}/g), ...NUEVA.match(/.{8}/g)]) assert.ok(!logs.includes(s), "fragmento de contraseña en logs");
    assert.doesNotMatch(logs, /SyntaxError|is not valid JSON/);
  });
});
