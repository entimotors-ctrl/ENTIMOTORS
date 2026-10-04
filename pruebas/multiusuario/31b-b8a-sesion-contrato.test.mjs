// 3.15.0 · CHECKPOINT 8A · LA SESIÓN NO SE PIERDE POR LA RED (y no se mantiene con credenciales inválidas). app.js + auth.js +
// supabase-client.js + sync-rest.js REALES en el entorno sintético (reloj controlado, Auth falso con red caída / tiempo agotado / 5xx /
// respuesta que no es de Auth / rechazo / user_banned). Clasificación exigida:
//   TRANSPORT_ERROR · TEMPORARY_SERVER_ERROR → la sesión SIGUE y se reintenta (nunca «caducó» ni «cuenta eliminada»)
//   AUTH_REJECTED · SESSION_REVOKED → se sale con «Tu sesión terminó / ha caducado» y SIN credenciales guardadas
//   ACCOUNT_DELETED_OR_DISABLED → SOLO con evidencia del servidor (user_banned, o el perfil ausente/inactivo leído con token válido)
// Contra el código ANTERIOR (ENTIMOTORS_RUNTIME_RAIZ=<base-inicio | base-3.14.1>) estas pruebas FALLAN; con el 8A pasan.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { nuevoEntorno, sesionAppDe, activo, toasts, CUENTAS } from "./helpers/flujos.mjs";

const c = CUENTAS.adminActivo;
const PERFIL = { uid: c.uid, nombre: c.perfil.nombre, rol: c.perfil.rol, activo: true };
const recargo = (e) => e.navegaciones.some((n) => n.tipo === "reload");
const dentro = (e) => e.doc.getElementById("shell").classList.add("active");
async function abrir(o = {}) { const e = nuevoEntorno({ cuenta: c, sesionGuardada: sesionAppDe(c), perfilCacheado: PERFIL, ...o }); await e.asentar(20); return e; }
// la renovación (POST /auth/v1/token?grant_type=refresh_token) contesta lo que se pida; el resto, el servidor sintético
function renovacionResponde(e, fn) {
  const real = e.win.fetch;
  e.win.fetch = (u, i) => (/grant_type=refresh_token/.test(String(u)) ? fn(u, i, real) : real(u, i));
}
// la consulta de la comprobación de cuenta (select=id,activo) con token VÁLIDO: el servidor sintético es fail-closed y solo conoce el
// select de Auth.cargarPerfil, así que aquí se contesta esa lectura con la evidencia que se quiere probar
function perfilResponde(e, filas) {
  const real = e.win.fetch;
  e.win.fetch = (u, i) => (/\/rest\/v1\/perfiles\?select=id%2Cactivo/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify(filas), { status: 200, headers: { "Content-Type": "application/json" } })) : real(u, i));
}
const restaurarRed = (e) => { e.servidor.red = "ok"; e.win.fetch = e.servidor.fetch; };
const html200 = () => Promise.resolve(new Response("<html>Portal Wi-Fi: acepta las condiciones</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
const status = (s, cuerpo) => () => Promise.resolve(new Response(JSON.stringify(cuerpo || { message: "x" }), { status: s, headers: { "Content-Type": "application/json" } }));
function sinSalida(e) {
  assert.equal(recargo(e), false, "no recarga al login"); assert.ok(!toasts(e).some((t) => /caducado|terminó/.test(t)), "sin aviso de sesión terminada");
  assert.ok(e.almacen.getItem("enti_session"), "enti_session intacta"); assert.ok(e.almacen.getItem("entimotors_sb_sesion"), "la sesión de Supabase NO se borra");
}
// la app con su cliente REST real (como lo arma startApp) para probar comprobarCuentaPropia
function conSyncRest(e) {
  if (typeof e.win.SyncRest === "undefined") e.cargar("sync-rest.js");
  e.evaluar(`currentUser = { uid: ${JSON.stringify(c.uid)}, rol: "admin", origen: "supabase" };
    syncRest = SyncRest.crear({ baseUrl: window.ENTIMOTORS_SUPABASE.url, anonKey: window.ENTIMOTORS_SUPABASE.anonKey,
      getToken: () => { const s = SupabaseCliente.sesion(); return s ? s.access_token : null; },
      refrescar: typeof renovarSesionNube === "function" ? renovarSesionNube : () => SupabaseCliente.refrescarSesion().then((r) => r.ok) });`);
  return e.espiar("denegarSesion", () => Promise.resolve());
}
const FALLOS_TEMPORALES = [
  ["red caída (TRANSPORT_ERROR)", (e) => { e.servidor.red = "caida"; }], ["tiempo agotado (TRANSPORT_ERROR)", (e) => { e.servidor.red = "timeout"; }],
  ["lie-fi: 200 que no es de Auth (TRANSPORT_ERROR)", (e) => renovacionResponde(e, html200)], ["servidor 503 (TEMPORARY_SERVER_ERROR)", (e) => renovacionResponde(e, status(503))],
  ["servidor 500 (TEMPORARY_SERVER_ERROR)", (e) => renovacionResponde(e, status(500))], ["429 (TEMPORARY_SERVER_ERROR)", (e) => renovacionResponde(e, status(429))],
];

describe("renovación programada mientras se trabaja (el token vence a los 2 min)", () => {
  test("normal: renueva, sigue dentro y reprograma", async () => {
    const e = await abrir({ expiraEnS: 125 }); dentro(e); await e.avanzar(10000);
    assert.equal(e.win.Auth.estado().conSesion, true); sinSalida(e); assert.ok(e.timersPendientes() >= 1);
  });
  for (const [nombre, prep] of FALLOS_TEMPORALES) test(`${nombre}: la sesión válida NO se cierra; al volver el servicio renueva sola (reconexión)`, async () => {
    const e = await abrir({ expiraEnS: 125 }); dentro(e); prep(e); await e.avanzar(10000);
    sinSalida(e); assert.equal(e.win.Auth.perfilActual()?.rol, "admin", "el perfil sigue");
    restaurarRed(e); await e.avanzar(20000);
    assert.equal(e.win.Auth.estado().conSesion, true, "reconectado: renovó en el reintento"); sinSalida(e);
  });
  test("refresh RECHAZADO por Auth (AUTH_REJECTED/SESSION_REVOKED): sale con «Tu sesión ha caducado» y olvida las credenciales", async () => {
    const e = await abrir({ expiraEnS: 125 }); dentro(e); e.servidor.refrescoFalla = true; await e.avanzar(13000);
    assert.equal(recargo(e), true); assert.deepEqual(toasts(e).at(-1), "Tu sesión ha caducado. Vuelve a entrar.");
    assert.equal(e.almacen.getItem("entimotors_sb_sesion"), null, "sin credenciales inválidas guardadas"); assert.equal(e.win.Auth.motivoSalida(), "sesion-revocada");
  });
  test("usuario BORRADO en Auth (400 refresh_token_not_found = SESSION_REVOKED): sale como sesión terminada, NO como «cuenta eliminada»", async () => {
    const e = await abrir({ expiraEnS: 125 }); dentro(e); const den = conSyncRest(e);
    renovacionResponde(e, status(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" }));
    await e.avanzar(13000);
    assert.equal(e.win.Auth.motivoSalida(), "sesion-revocada"); assert.equal(recargo(e), true); assert.equal(den.length, 0, "no se dice «cuenta eliminada» sin evidencia");
  });
  test("usuario DESACTIVADO (400 user_banned = ACCOUNT_DISABLED, evidencia de Auth): el cierre del Bloque 4 con su mensaje", async () => {
    const e = await abrir({ expiraEnS: 125 }); dentro(e); const den = conSyncRest(e);
    renovacionResponde(e, status(400, { code: 400, error_code: "user_banned", msg: "Invalid Refresh Token: User Banned" }));
    await e.avanzar(13000);
    assert.equal(e.win.Auth.motivoSalida(), "cuenta-desactivada"); assert.ok(den.length >= 1); assert.match(String(den[0][0]), /eliminada o desactivada/);
    assert.equal(e.almacen.getItem("entimotors_sb_sesion"), null);
  });
});

describe("al abrir con el access token VENCIDO (app cerrada > 1 h)", () => {
  test("renueva ANTES de decidir y entra con sesión válida", async () => {
    const e = await abrir({ expiraEnS: -60 });
    assert.equal(e.startApp.length, 1); assert.equal(e.win.Auth.estado().conSesion, true);
    assert.ok(e.servidor.llamadas.some((l) => /grant_type=refresh_token/.test(l.ruta)));
  });
  for (const [nombre, prep] of FALLOS_TEMPORALES) test(`${nombre}: entra con el perfil guardado, NO borra nada, y renueva al volver el servicio`, async () => {
    const e = await abrir({ expiraEnS: -60, preparar: prep });
    assert.equal(e.startApp.length, 1); assert.equal(activo(e, "gateLogin"), false); sinSalida(e);
    restaurarRed(e); await e.avanzar(20000); assert.equal(e.win.Auth.estado().conSesion, true);
  });
  test("Auth RECHAZA: login con «Tu sesión terminó» (no entra con credenciales inválidas)", async () => {
    const e = await abrir({ expiraEnS: -60, preparar: (env) => { env.servidor.refrescoFalla = true; } });
    assert.equal(e.startApp.length, 0); assert.equal(activo(e, "gateLogin"), true);
    assert.equal(e.doc.getElementById("loginError").textContent, "Tu sesión terminó. Vuelve a entrar."); assert.equal(e.almacen.getItem("enti_session"), null);
  });
  test("user_banned: login con «Esta cuenta está dada de baja.»", async () => {
    const e = await abrir({ expiraEnS: -60, preparar: (env) => renovacionResponde(env, status(400, { error_code: "user_banned" })) });
    assert.equal(e.startApp.length, 0); assert.equal(e.doc.getElementById("loginError").textContent, "Esta cuenta está dada de baja.");
  });
});

describe("volver a la app (comprobación de la cuenta del Bloque 4): nunca un falso «cuenta eliminada»", () => {
  for (const [nombre, prep] of FALLOS_TEMPORALES) test(`token vencido + ${nombre} al renovar: SIGUE dentro`, async () => {
    const e = await abrir({ expiraEnS: -60, preparar: prep }); dentro(e);
    const den = conSyncRest(e);
    await e.win.comprobarCuentaPropia("volver"); await e.asentar(10);
    assert.equal(den.length, 0, "no se dice «cuenta eliminada» por un problema de red o del servidor"); sinSalida(e);
  });
  test("NO SE DEBILITA el Bloque 4: perfil INACTIVO leído con token VÁLIDO → «cuenta eliminada o desactivada»", async () => {
    const e = await abrir({}); dentro(e); perfilResponde(e, [{ id: c.uid, activo: false }]); const den = conSyncRest(e);
    await e.win.comprobarCuentaPropia("aviso"); await e.asentar(10);
    assert.equal(den.length, 1); assert.match(String(den[0][0]), /eliminada o desactivada/);
  });
  test("NO SE DEBILITA el Bloque 4: perfil AUSENTE (la RLS lo oculta) con token válido → «cuenta eliminada o desactivada»", async () => {
    const e = await abrir({}); dentro(e); perfilResponde(e, []); const den = conSyncRest(e);
    await e.win.comprobarCuentaPropia("aviso"); await e.asentar(10);
    assert.equal(den.length, 1);
  });
});

describe("cambio de usuario con una comprobación de cuenta EN CURSO (Bloque 8, b8-realtime-estres R7)", () => {
  test("si el usuario cambia mientras se lee el perfil, el perfil «oculto» NO es evidencia: no se dice «cuenta eliminada»", async () => {
    const e = await abrir({}); dentro(e);
    let soltar; const espera = new Promise((r) => { soltar = r; });
    const real = e.win.fetch;   // la lectura del perfil tarda: en medio se cambia de usuario; el servidor ya no le muestra el perfil ajeno
    e.win.fetch = (u, i) => (/\/rest\/v1\/perfiles\?select=id%2Cactivo/.test(String(u)) ? espera.then(() => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })) : real(u, i));
    const den = conSyncRest(e);
    const p = e.win.comprobarCuentaPropia("volver");
    await e.asentar(5); e.evaluar(`currentUser = { uid: "00000000-0000-4000-8000-0000000000b2", rol: "mecanico", origen: "supabase" };`);
    soltar(); await p; await e.asentar(10);
    assert.equal(den.length, 0, "un cambio de usuario no es una baja");
  });
});

describe("salir y cambiar de usuario", () => {
  test("logout: SIGNED_OUT, motivo «cerrada» y sin credenciales; entrar con OTRA cuenta limpia el motivo y trae su perfil", async () => {
    const e = await abrir({}); await e.win.Auth.cerrarSesion(); await e.asentar();
    assert.equal(e.win.Auth.motivoSalida(), "cerrada"); assert.equal(e.almacen.getItem("entimotors_sb_sesion"), null);
    const r = await e.win.Auth.iniciarSesion(CUENTAS.cajeroActivo.correo, CUENTAS.cajeroActivo.clave);
    assert.equal(r.ok, true); assert.equal(e.win.Auth.motivoSalida(), null); assert.equal(e.win.Auth.perfilActual().rol, "cajero");
  });
});
