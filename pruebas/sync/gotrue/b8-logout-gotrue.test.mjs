// 3.15.0 · BLOQUE 8 · LOGOUT de UN dispositivo (decisión del propietario) contra GoTrue REAL (v2.197, pila LOCAL; nunca producción).
// supabase-client.js + auth.js REALES en el entorno sintético, con su fetch dirigido al gateway local. Cuentas *@example.test.
// «Cerrar sesión» = POST /auth/v1/logout?scope=local: cierra ESTE dispositivo; los demás de la misma cuenta siguen. Las revocaciones de
// SEGURIDAD (eliminar / desactivar) siguen cerrando TODO. L01…L12. Registro B8_LOGOUT (sin tokens).
//   ENTIMOTORS_RUNTIME_RAIZ=<árbol anterior> corre el código de antes (L02 debe FALLAR: el logout viejo era global).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { iniciarPila, REST_URL } from "../browser/lib/pila.mjs";
import { crearEntorno } from "../../multiusuario/helpers/entorno.mjs";
import { URL_SB } from "../../multiusuario/helpers/supabase-mock.mjs";

let pila; let fallosAuth = 0; const R = {};
const SRV = () => pila.jwt(undefined, { role: "service_role" });
async function gt(ruta, { m = "GET", tok, body, srv } = {}) {
  const r = await fetch(REST_URL + ruta, { method: m, headers: { apikey: "anon-sintetica", Authorization: `Bearer ${srv ? SRV() : tok || "anon-sintetica"}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j };
}
async function cuenta() {
  const c = { correo: `b8lo-${crypto.randomBytes(3).toString("hex")}@example.test`, pass: `frase ${crypto.randomBytes(9).toString("base64url")} lenta` };
  const r = await gt("/auth/v1/admin/users", { m: "POST", srv: true, body: { email: c.correo, password: c.pass, email_confirm: true } }); assert.equal(r.s, 200); c.id = r.j.id;
  pila.sql(`set session_replication_role = replica; update public.perfiles set nombre = 'Dueño L', rol = 'admin', activo = true where id = '${c.id}'; reset session_replication_role;`);
  return c;
}
// un dispositivo: runtime real; `fallosAuth` > 0 corta las siguientes N peticiones a /auth/v1 (red caída un momento)
function dispositivo(storage = {}) {
  const servidor = { llamadas: [], inesperadas: [], ajenas: [], tokensEmitidos: () => [],
    fetch: (u, i) => { const url = String(u); servidor.llamadas.push(url.replace(URL_SB, "").split("?")[0] + (url.includes("scope=") ? "?" + url.split("?")[1] : ""));
      if (fallosAuth > 0 && /\/auth\/v1\//.test(url)) { fallosAuth--; return Promise.reject(new TypeError("Failed to fetch")); }
      return fetch(url.replace(URL_SB, REST_URL), i); } };
  const env = crearEntorno({ scripts: ["supabase-client", "auth"], producto: "ninguno", servidor, storage, config: { url: URL_SB, anonKey: "anon-sintetica", habilitado: true } });
  env.eventos = []; env.win.Auth.alCambiar((e) => env.eventos.push(e)); env.servidor = servidor;
  return env;
}
const sesion = (d) => JSON.parse(d.almacen.getItem("entimotors_sb_sesion") || "null");
const renovarCon = async (refresh) => (await gt("/auth/v1/token?grant_type=refresh_token", { m: "POST", body: { refresh_token: refresh } })).s;   // 200 = sesión viva en el servidor
const trabaja = async (d) => (await gt("/rest/v1/perfiles?select=id&limit=1", { tok: sesion(d)?.access_token })).s;
before(async () => { pila = await iniciarPila({ gotrue: true }); });
after(async () => { await pila?.detener(); console.log(`B8_LOGOUT ${JSON.stringify(R)}`); });

test("L01–L04 · dos dispositivos: el logout de A no saca a B; B sigue trabajando; el logout de B lo saca a él", async () => {
  const c = await cuenta(); const A = dispositivo(), B = dispositivo();
  assert.equal((await A.win.Auth.iniciarSesion(c.correo, c.pass)).ok, true); assert.equal((await B.win.Auth.iniciarSesion(c.correo, c.pass)).ok, true);   // L01
  const refA = sesion(A).refresh_token;
  const ra = await A.win.Auth.cerrarSesion();
  R.L02 = { ruta: A.servidor.llamadas.filter((x) => /logout/.test(x)), A_local: sesion(A) === null, A_servidor: await renovarCon(refA), B_renueva: (await renovarCon(sesion(B).refresh_token)) === 200 };
  assert.deepEqual(R.L02.ruta, ["/auth/v1/logout?scope=local"], "el endpoint y el scope exactos");
  assert.equal(R.L02.A_local, true); assert.notEqual(R.L02.A_servidor, 200, "la sesión de A quedó cerrada EN EL SERVIDOR");
  assert.equal(R.L02.B_renueva, true, "L02: B sigue válido");
  R.L03 = await trabaja(B); assert.equal(R.L03, 200, "L03: B sigue trabajando");
  const refB = sesion(B).refresh_token; await B.win.Auth.cerrarSesion();
  R.L04 = { B_local: sesion(B) === null, B_servidor: await renovarCon(refB) }; assert.equal(R.L04.B_local, true); assert.notEqual(R.L04.B_servidor, 200);
});
test("L05 · eliminar el usuario (Auth) revoca A y B · L06 · desactivar (ban del Bloque 4) revoca A y B", async () => {
  let c = await cuenta(); let A = dispositivo(), B = dispositivo();
  await A.win.Auth.iniciarSesion(c.correo, c.pass); await B.win.Auth.iniciarSesion(c.correo, c.pass);
  pila.sql(`set session_replication_role = replica; delete from public.perfiles where id = '${c.id}'; reset session_replication_role;`);
  await gt(`/auth/v1/admin/users/${c.id}`, { m: "DELETE", srv: true });
  R.L05 = { A: (await A.win.Auth.renovar()).clase, B: (await B.win.Auth.renovar()).clase };
  assert.deepEqual(R.L05, { A: "rechazada", B: "rechazada" });
  c = await cuenta(); A = dispositivo(); B = dispositivo();
  await A.win.Auth.iniciarSesion(c.correo, c.pass); await B.win.Auth.iniciarSesion(c.correo, c.pass);
  await gt(`/auth/v1/admin/users/${c.id}`, { m: "PUT", srv: true, body: { ban_duration: "876000h" } });
  R.L06 = { A: (await A.win.Auth.renovar()).clase, B: (await B.win.Auth.renovar()).clase };
  assert.deepEqual(R.L06, { A: "cuenta-desactivada", B: "cuenta-desactivada" });
});
test("L07 · cambiar el PIN del propietario NO es un logout · L08 · cambio de contraseña: GoTrue por sí solo no cierra otras sesiones (la política «cerrar las demás» la aplica el backend con scope=others, SEC-1D)", async () => {
  const c = await cuenta(); const A = dispositivo(), B = dispositivo();
  await A.win.Auth.iniciarSesion(c.correo, c.pass); await B.win.Auth.iniciarSesion(c.correo, c.pass);
  pila.sql(`select public.pin_guardar('${c.id}', 'scrypt$sintetico-de-prueba', '${c.id}', 'pin')`);   // formato aceptado (scrypt$…); valor sintético
  R.L07 = { A: (await A.win.Auth.renovar()).ok, B: (await B.win.Auth.renovar()).ok }; assert.deepEqual(R.L07, { A: true, B: true });
  const nueva = `frase ${crypto.randomBytes(9).toString("base64url")} otra`;
  const p = await gt("/auth/v1/user", { m: "PUT", tok: sesion(A).access_token, body: { password: nueva } });
  const o = await gt("/auth/v1/logout?scope=others", { m: "POST", tok: sesion(A).access_token });   // lo que hace el backend (clave-admin.ts) tras cambiarla
  R.L08 = { cambio: p.s, others: o.s, A_sigue: (await A.win.Auth.renovar()).ok, B_tras_others: (await B.win.Auth.renovar()).clase };
  assert.equal(R.L08.A_sigue, true); assert.equal(R.L08.B_tras_others, "rechazada", "la política del Bloque 4/SEC-1D: las demás sesiones caen");
});
test("L09 token vencido · L10 red caída al cerrar · L11 reintento · L12 reabrir el dispositivo que cerró", async () => {
  const c = await cuenta(); const A = dispositivo(); await A.win.Auth.iniciarSesion(c.correo, c.pass);
  // L09: access token vencido → renueva y cierra EN EL SERVIDOR
  const s9 = sesion(A); s9.expires_at = Math.floor(Date.now() / 1000) - 60; const A9 = dispositivo({ entimotors_sb_sesion: JSON.stringify(s9) });
  const r9 = await A9.win.Auth.cerrarSesion(); const ref9 = sesion(A) && s9.refresh_token;
  R.L09 = { resultado: r9.ok, local: sesion(A9) === null, servidor_confirma: A9.servidor.llamadas.some((x) => /logout\?scope=local/.test(x)) };
  assert.equal(R.L09.local, true); assert.equal(R.L09.servidor_confirma, true);
  // L10: red caída durante el logout (todas las peticiones de Auth fallan): local fuera igual; servidor «no-confirmada»
  const B = dispositivo(); await B.win.Auth.iniciarSesion(c.correo, c.pass); const refB = sesion(B).refresh_token;
  fallosAuth = 10; const SB = B.win.SupabaseCliente; const r10 = await SB.cerrarSesion(); fallosAuth = 0;
  R.L10 = { servidor: r10.datos?.servidor, local: sesion(B) === null, sesion_servidor_viva: (await renovarCon(refB)) === 200 };
  assert.equal(R.L10.local, true, "desde este dispositivo ya no se puede usar"); assert.equal(R.L10.servidor, "no-confirmada");
  // L11: el primer intento falla por red, el reintento cierra
  const C = dispositivo(); await C.win.Auth.iniciarSesion(c.correo, c.pass); const refC = sesion(C).refresh_token;
  fallosAuth = 1; const r11 = await C.win.SupabaseCliente.cerrarSesion(); fallosAuth = 0;
  R.L11 = { servidor: r11.datos?.servidor, intentos: C.servidor.llamadas.filter((x) => /logout/.test(x)).length, sesion_servidor: await renovarCon(refC) };
  assert.equal(R.L11.servidor, "cerrada"); assert.notEqual(R.L11.sesion_servidor, 200);
  // L12: reabrir el dispositivo que cerró sesión → no entra, pide login (nada guardado)
  const C2 = dispositivo({ entimotors_sb_sesion: C.almacen.getItem("entimotors_sb_sesion") || "" });
  const r12 = await C2.win.Auth.restaurarSesion(); R.L12 = { ok: r12.ok, motivo: r12.motivo };
  assert.equal(r12.ok, false); assert.equal(r12.motivo, "sin-sesion");
});
