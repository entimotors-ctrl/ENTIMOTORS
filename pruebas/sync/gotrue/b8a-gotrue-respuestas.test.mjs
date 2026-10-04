// 3.15.0 · CHECKPOINT 8A · ¿Qué contesta GoTrue REAL (v2.197, pila local) al RENOVAR una sesión en cada caso? Base para clasificar
// TRANSPORT_ERROR / TEMPORARY_SERVER_ERROR / AUTH_REJECTED / SESSION_REVOKED / ACCOUNT_DELETED_OR_DISABLED con evidencia del servidor.
// Solo registra (B8A_GOTRUE): status, error_code y error (nunca tokens). Cuentas sintéticas *@example.test que se borran al terminar.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { iniciarPila, REST_URL } from "../browser/lib/pila.mjs";

let pila; const R = {};
const SRV = () => pila.jwt(undefined, { role: "service_role" });
async function gt(ruta, { m = "GET", tok, body, srv } = {}) {
  const r = await fetch(REST_URL + ruta, { method: m, headers: { apikey: "anon-sintetica", Authorization: `Bearer ${srv ? SRV() : tok || "anon-sintetica"}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j };
}
const forma = (r) => ({ status: r.s, error_code: r.j?.error_code ?? null, error: r.j?.error ?? null, msg: String(r.j?.msg || r.j?.message || r.j?.error_description || "").slice(0, 80), trae_token: !!r.j?.access_token });
async function cuenta() {
  const c = { correo: `b8ag-${crypto.randomBytes(3).toString("hex")}@example.test`, pass: `frase ${crypto.randomBytes(9).toString("base64url")} lenta` };
  const r = await gt("/auth/v1/admin/users", { m: "POST", srv: true, body: { email: c.correo, password: c.pass, email_confirm: true } }); assert.equal(r.s, 200); c.id = r.j.id; return c;
}
const entrar = async (c) => { const r = await gt("/auth/v1/token?grant_type=password", { m: "POST", body: { email: c.correo, password: c.pass } }); assert.equal(r.s, 200); return { a: r.j.access_token, r: r.j.refresh_token }; };
const renovar = (s) => gt("/auth/v1/token?grant_type=refresh_token", { m: "POST", body: { refresh_token: s.r } });
before(async () => { pila = await iniciarPila({ gotrue: true }); });
after(async () => { await pila?.detener(); console.log(`B8A_GOTRUE ${JSON.stringify(R)}`); });

test("respuestas reales de GoTrue al renovar", async () => {
  let c = await cuenta(), s = await entrar(c);
  R.normal = forma(await renovar(s));
  R.token_inventado = forma(await renovar({ r: "no-existe-" + crypto.randomUUID() }));
  // logout global desde OTRO dispositivo (revoca todas las sesiones)
  c = await cuenta(); s = await entrar(c); const s2 = await entrar(c);
  R.logout_global_respuesta = forma(await gt("/auth/v1/logout?scope=global", { m: "POST", tok: s2.a }));
  R.tras_logout_global = forma(await renovar(s));
  // logout LOCAL del otro dispositivo: la sesión propia debe seguir
  c = await cuenta(); s = await entrar(c); const s3 = await entrar(c);
  await gt("/auth/v1/logout?scope=local", { m: "POST", tok: s3.a });
  R.tras_logout_local_de_otro = forma(await renovar(s));
  // baneado (así desactiva una cuenta el Bloque 4)
  c = await cuenta(); s = await entrar(c);
  R.ban_respuesta = forma(await gt(`/auth/v1/admin/users/${c.id}`, { m: "PUT", srv: true, body: { ban_duration: "876000h" } }));
  R.tras_ban = forma(await renovar(s));
  // borrado en Auth
  c = await cuenta(); s = await entrar(c);
  R.borrado_respuesta = forma(await gt(`/auth/v1/admin/users/${c.id}`, { m: "DELETE", srv: true }));
  R.tras_borrado = forma(await renovar(s));
  // reusar un refresh token YA usado (rotación): ¿revocación o tolerancia?
  c = await cuenta(); s = await entrar(c); await renovar(s);
  R.refresh_reusado = forma(await renovar(s));
  assert.ok(true);
});
