// 3.15.0 · CHECKPOINT 8A · La sesión contra GoTrue REAL (v2.197, pila LOCAL; nunca producción): supabase-client.js + auth.js + app.js
// REALES en el entorno sintético de multiusuario, con su fetch dirigido al gateway local (que reenvía /auth/v1 y /rest/v1 a GoTrue y
// PostgREST). Cuentas sintéticas *@example.test. Comprueba la clasificación con las respuestas DE VERDAD del servidor:
//   dos dispositivos · logout global desde el otro (SESSION_REVOKED) · logout local del otro (no afecta) · ban (ACCOUNT_DISABLED) ·
//   borrado (SESSION_REVOKED, nunca «cuenta eliminada» sin evidencia) · Auth inalcanzable y reconexión (TRANSPORT_ERROR) · token vencido al abrir.
//   ENTIMOTORS_RUNTIME_RAIZ=<árbol anterior> corre el código de antes (debe FALLAR).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { iniciarPila, REST_URL } from "../browser/lib/pila.mjs";
import { crearEntorno } from "../../multiusuario/helpers/entorno.mjs";
import { URL_SB } from "../../multiusuario/helpers/supabase-mock.mjs";

let pila; let authCaido = false; const R = {};
const SRV = () => pila.jwt(undefined, { role: "service_role" });
async function gt(ruta, { m = "GET", tok, body, srv } = {}) {
  const r = await fetch(REST_URL + ruta, { method: m, headers: { apikey: "anon-sintetica", Authorization: `Bearer ${srv ? SRV() : tok || "anon-sintetica"}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j };
}
async function cuenta(rol = "admin") {
  const c = { correo: `b8as-${crypto.randomBytes(3).toString("hex")}@example.test`, pass: `frase ${crypto.randomBytes(9).toString("base64url")} lenta` };
  const r = await gt("/auth/v1/admin/users", { m: "POST", srv: true, body: { email: c.correo, password: c.pass, email_confirm: true } }); assert.equal(r.s, 200); c.id = r.j.id;
  pila.sql(`set session_replication_role = replica; update public.perfiles set nombre = 'Dueño 8A', rol = '${rol}', activo = true where id = '${c.id}'; reset session_replication_role;`);
  return c;
}
// un «dispositivo»: el runtime real, su localStorage propio, su fetch al laboratorio (Auth se puede «cortar» sin tocar el resto)
function dispositivo(storage = {}) {
  const servidor = { llamadas: [], inesperadas: [], ajenas: [], tokensEmitidos: () => [],
    fetch: (u, i) => { const url = String(u); servidor.llamadas.push(url.replace(URL_SB, "")); if (authCaido && /\/auth\/v1\//.test(url)) return Promise.reject(new TypeError("Failed to fetch"));
      return fetch(url.replace(URL_SB, REST_URL), i); } };
  const env = crearEntorno({ scripts: ["supabase-client", "auth"], producto: "ninguno", servidor, storage, config: { url: URL_SB, anonKey: "anon-sintetica", habilitado: true } });
  env.eventos = []; env.win.Auth.alCambiar((e) => env.eventos.push(e));
  return env;
}
const sesion = (d) => JSON.parse(d.almacen.getItem("entimotors_sb_sesion") || "null");
const vencer = (d) => { const s = sesion(d); s.expires_at = Math.floor(Date.now() / 1000) - 60; return { entimotors_sb_sesion: JSON.stringify(s), enti_perfil_supabase: d.almacen.getItem("enti_perfil_supabase") }; };
before(async () => { pila = await iniciarPila({ gotrue: true }); });
after(async () => { await pila?.detener(); console.log(`B8A_SESION_GOTRUE ${JSON.stringify(R)}`); });

test("GoTrue real: renovación normal, Auth inalcanzable (sigue) y reconexión", async () => {
  const c = await cuenta(); const A = dispositivo();
  assert.equal((await A.win.Auth.iniciarSesion(c.correo, c.pass)).ok, true);
  const r1 = await A.win.Auth.renovar(); R.normal = r1.ok; assert.equal(r1.ok, true);
  authCaido = true; const r2 = await A.win.Auth.renovar(); authCaido = false;
  R.caido = { clase: r2.clase, motivo: A.win.Auth.motivoSalida(), sesion: !!sesion(A) };
  assert.equal(r2.clase, "transporte"); assert.equal(A.win.Auth.motivoSalida(), null); assert.ok(sesion(A), "la sesión no se borra"); assert.ok(!A.eventos.includes("SIGNED_OUT"));
  const r3 = await A.win.Auth.renovar(); R.reconexion = r3.ok; assert.equal(r3.ok, true);
});
test("GoTrue real: dos dispositivos — logout LOCAL del otro no afecta; logout GLOBAL del otro → SESSION_REVOKED aquí", async () => {
  const c = await cuenta(); const A = dispositivo(), B = dispositivo();
  await A.win.Auth.iniciarSesion(c.correo, c.pass); await B.win.Auth.iniciarSesion(c.correo, c.pass);
  // logout LOCAL (scope=local) del otro dispositivo: A sigue
  const l = await gt("/auth/v1/logout?scope=local", { m: "POST", tok: sesion(B).access_token }); assert.equal(l.s, 204);
  const r1 = await A.win.Auth.renovar(); R.tras_logout_local_del_otro = r1.ok; assert.equal(r1.ok, true, "A sigue");
  // HALLAZGO 8A → DECISIÓN del propietario (Bloque 8): «Cerrar sesión» de la app cierra SOLO ese dispositivo (/auth/v1/logout?scope=local);
  // antes era sin scope = GLOBAL y el otro dispositivo de la misma cuenta salía en su siguiente renovación (detalle: b8-logout-gotrue L01–L12)
  const B2 = dispositivo(); await B2.win.Auth.iniciarSesion(c.correo, c.pass); const A2 = dispositivo(); await A2.win.Auth.iniciarSesion(c.correo, c.pass);
  await B2.win.Auth.cerrarSesion();
  const rg = await A2.win.Auth.renovar(); R.logout_de_la_app_en_otro_dispositivo = { clase: rg.clase, motivo: A2.win.Auth.motivoSalida() };
  assert.equal(rg.ok, true, "el logout de la app en OTRO dispositivo ya no saca a este (scope=local)");
  const C = dispositivo(); await C.win.Auth.iniciarSesion(c.correo, c.pass);
  const g = await gt("/auth/v1/logout?scope=global", { m: "POST", tok: sesion(C).access_token }); assert.equal(g.s, 204);
  const r2 = await A.win.Auth.renovar(); R.tras_logout_global = { clase: r2.clase, codigo: r2.codigo, motivo: A.win.Auth.motivoSalida() };
  assert.equal(r2.clase, "rechazada"); assert.equal(A.win.Auth.motivoSalida(), "sesion-revocada"); assert.equal(sesion(A), null, "sin credenciales inválidas"); assert.ok(A.eventos.includes("SIGNED_OUT"));
});
test("GoTrue real: usuario DESACTIVADO (ban del Bloque 4) → ACCOUNT_DISABLED; usuario BORRADO → SESSION_REVOKED (no «cuenta eliminada»)", async () => {
  const c1 = await cuenta(); const A = dispositivo(); await A.win.Auth.iniciarSesion(c1.correo, c1.pass);
  await gt(`/auth/v1/admin/users/${c1.id}`, { m: "PUT", srv: true, body: { ban_duration: "876000h" } });
  const r1 = await A.win.Auth.renovar(); R.ban = { clase: r1.clase, codigo: r1.codigo, motivo: A.win.Auth.motivoSalida() };
  assert.equal(r1.codigo, "user_banned"); assert.equal(r1.clase, "cuenta-desactivada"); assert.equal(A.win.Auth.motivoSalida(), "cuenta-desactivada");
  const c2 = await cuenta(); const B = dispositivo(); await B.win.Auth.iniciarSesion(c2.correo, c2.pass);
  pila.sql(`set session_replication_role = replica; delete from public.perfiles where id = '${c2.id}'; reset session_replication_role;`);
  await gt(`/auth/v1/admin/users/${c2.id}`, { m: "DELETE", srv: true });
  const r2 = await B.win.Auth.renovar(); R.borrado = { clase: r2.clase, codigo: r2.codigo, motivo: B.win.Auth.motivoSalida() };
  assert.equal(r2.clase, "rechazada"); assert.equal(B.win.Auth.motivoSalida(), "sesion-revocada");
});
test("GoTrue real: token VENCIDO al abrir → renueva y confirma el perfil; con Auth inalcanzable entra SIN confirmar y no borra nada", async () => {
  const c = await cuenta(); const A = dispositivo(); await A.win.Auth.iniciarSesion(c.correo, c.pass);
  const B = dispositivo(vencer(A));
  const r1 = await B.win.Auth.restaurarSesion(); R.vencido = { ok: r1.ok, conSesion: B.win.Auth.estado().conSesion };
  assert.equal(r1.ok, true); assert.equal(B.win.Auth.estado().conSesion, true); assert.equal(B.win.Auth.perfilActual().rol, "admin");
  const D = dispositivo(vencer(B)); authCaido = true;
  const r2 = await D.win.Auth.restaurarSesion(); authCaido = false;
  R.vencido_sin_auth = { ok: r2.ok, sinConfirmar: !!r2.sinConfirmar, sesionGuardada: !!sesion(D) };
  assert.equal(r2.ok, true); assert.equal(r2.sinConfirmar, true); assert.ok(sesion(D), "no se borra la sesión por un corte");
});
