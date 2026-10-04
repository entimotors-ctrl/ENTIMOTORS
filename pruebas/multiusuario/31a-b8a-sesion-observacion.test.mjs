// 3.15.0 · CHECKPOINT 8A · CLIENT-STARTUP-07…14 en la capa donde vive la sesión: app.js + auth.js + supabase-client.js REALES en el
// entorno sintético (reloj controlado: «pasa 1 hora» sin esperar; servidor de Auth falso con red caída / tiempo agotado / rechazo).
// ENTIMOTORS_RUNTIME_RAIZ=<carpeta con taller-demo/ 3.14.1> corre la app de PRODUCCIÓN; sin ella, la 3.15 del árbol.
// OBSERVACIÓN: registra en B8A_SESION qué ve la persona en cada escenario (ABRE_OK · ABRE_Y_EXPULSA · SESSION_EXPIRED · NO_ABRE · APP_CRASH).
import test from "node:test";
import assert from "node:assert/strict";
import { RAIZ_RUNTIME } from "./helpers/entorno.mjs";
import { nuevoEntorno, sesionAppDe, activo, toasts, CUENTAS } from "./helpers/flujos.mjs";

const VERSION = /3\.14\.1|base-3\.14\.1/.test(RAIZ_RUNTIME) ? "3.14.1" : "árbol";
const R = {};
const c = CUENTAS.adminActivo;
const recargo = (e) => e.navegaciones.some((n) => n.tipo === "reload");
function estado(e) {
  const s = (() => { try { return JSON.parse(e.almacen.getItem("entimotors_sb_sesion") || "null"); } catch { return "ILEGIBLE"; } })();
  return { startApp: e.startApp.length, login: activo(e, "gateLogin"), recarga: recargo(e), toast: toasts(e).slice(-1)[0] || null,
    enti_session: !!e.almacen.getItem("enti_session"), sesion_sb: !!s, con_sesion_valida: !!e.win.Auth?.estado().conSesion,
    perfil: !!e.win.Auth?.perfilActual(), refrescos: e.servidor.llamadas.filter((l) => /grant_type=refresh_token/.test(l.url || l.ruta || "")).length, error: (e.consola.error || []).slice(-1)[0] || null };
}
function clasificar(x, { estabaDentro = false } = {}) {
  if (x.recarga && estabaDentro) return "ABRE_Y_EXPULSA";
  if (x.startApp && !x.con_sesion_valida) return "ABRE_SIN_SESION_VALIDA";
  if (x.startApp) return "ABRE_OK";
  if (x.login) return x.sesion_sb ? "SESSION_EXPIRED" : "NO_ABRE";
  return x.error ? "APP_CRASH" : "UNKNOWN";
}
// la app «dentro»: shell activo (startApp está espiado y no pinta)
const dentro = (e) => e.doc.getElementById("shell").classList.add("active");
async function abrir(o) { const e = nuevoEntorno({ cuenta: c, sesionGuardada: sesionAppDe(c), perfilCacheado: { uid: c.uid, nombre: c.perfil.nombre, rol: c.perfil.rol, activo: true }, ...o }); await e.asentar(20); return e; }

test(`8A · sesión al abrir y mientras se trabaja · app ${VERSION}`, async () => {
  // 07 · sesión válida
  let e = await abrir({}); R["07_valida"] = { ...estado(e), clase: clasificar(estado(e)) };
  // 08 · access token VENCIDO al abrir (la app estuvo cerrada > 1 h; el refresh token sigue válido en el servidor)
  e = await abrir({ expiraEnS: -60 }); dentro(e); let x = estado(e); R["08_vencido_al_abrir"] = { ...x, clase: clasificar(x) };
  await e.avanzar(30 * 60 * 1000); x = estado(e); R["08_vencido_30min_despues"] = { ...x, clase: clasificar(x, { estabaDentro: true }) };
  // 08b · igual pero SIN enti_session (primera vez en este dispositivo tras borrar datos del sitio, o enti_session perdida)
  e = await abrir({ expiraEnS: -60, sesionGuardada: null }); x = estado(e); R["08b_vencido_sin_enti_session"] = { ...x, clase: clasificar(x) };
  // 08c · a punto de vencer: el refresco programado (2 min antes) sale bien
  e = await abrir({ expiraEnS: 125 }); dentro(e); await e.avanzar(10000); x = estado(e); R["08c_casi_vencido_refresco_ok"] = { ...x, clase: clasificar(x, { estabaDentro: true }) };
  // 09/10 · el refresco programado coincide con un corte de red (caída o tiempo agotado) — la sesión NO estaba revocada
  for (const red of ["caida", "timeout"]) {
    e = await abrir({ expiraEnS: 125 }); dentro(e); e.servidor.red = red; await e.avanzar(10000); e.servidor.red = "ok"; await e.avanzar(3000); x = estado(e);
    R[`10_refresco_red_${red}`] = { ...x, clase: clasificar(x, { estabaDentro: true }) };
  }
  // 10c · control: el servidor RECHAZA el refresco (sesión revocada de verdad) → salir es lo correcto
  e = await abrir({ expiraEnS: 125 }); dentro(e); e.servidor.refrescoFalla = true; await e.avanzar(13000); x = estado(e); R["10c_refresco_rechazado"] = { ...x, clase: clasificar(x, { estabaDentro: true }) };
  // 12 · Auth sí / backend no: al abrir no se puede leer el perfil
  for (const red of ["caida", "timeout"]) { e = await abrir({ preparar: (env) => { env.servidor.perfilesRed = red; } }); x = estado(e); R[`12_perfil_${red}`] = { ...x, clase: clasificar(x) }; }
  // 11 · backend sí / Auth no, con token válido: abrir no necesita Auth; el refresco de dentro de 58 min sí (= 10)
  e = await abrir({}); dentro(e); e.servidor.red = "caida"; x = estado(e); R["11_auth_caido_token_valido"] = { ...x, clase: clasificar(x) }; e.servidor.red = "ok";
  // 13 · excepción en el arranque: enti_session corrupta / sesión de Supabase ilegible
  e = await abrir({ storageExtra: {}, sesionGuardada: null, preparar: (env) => { env.almacen.setItem("enti_session", "{roto"); } }); x = estado(e); R["13_enti_session_corrupta"] = { ...x, clase: clasificar(x) };
  e = await abrir({ cuenta: null, storageExtra: { entimotors_sb_sesion: "{roto" } }); x = estado(e); R["13_sesion_sb_corrupta"] = { ...x, clase: clasificar(x) };
  // 14 · abrir / cerrar / reabrir: a los 10 min (token vivo) y a las 2 h (token vencido)
  e = await abrir({ expiraEnS: 3000 }); x = estado(e); R["14_reabrir_10min"] = { ...x, clase: clasificar(x) };
  e = await abrir({ expiraEnS: -3600 }); x = estado(e); R["14_reabrir_2h"] = { ...x, clase: clasificar(x) };
  // 15 · SOLO 3.15 (Bloque 4): al VOLVER a la app se comprueba la cuenta. Token vencido (app dormida > 1 h) + el refresco falla por RED
  for (const [k, prep] of [["15_volver_vencido_red_caida", (e) => { e.servidor.red = "caida"; }], ["15_volver_vencido_red_timeout", (e) => { e.servidor.red = "timeout"; }],
    ["15_volver_vencido_refresco_ok", () => {}], ["15_volver_vencido_refresco_RECHAZADO", (e) => { e.servidor.refrescoFalla = true; }]]) {
    e = await abrir({ expiraEnS: -60 }); dentro(e);
    if (typeof e.win.comprobarCuentaPropia !== "function") { R[k] = { clase: "NO_APLICA (la función no existe en esta versión)" }; continue; }
    const denegadas = e.espiar("denegarSesion", () => Promise.resolve());
    if (typeof e.win.SyncRest === "undefined") e.cargar("sync-rest.js");
    e.evaluar(`currentUser = { uid: ${JSON.stringify(c.uid)}, rol: "admin", origen: "supabase" };
      syncRest = SyncRest.crear({ baseUrl: window.ENTIMOTORS_SUPABASE.url, anonKey: window.ENTIMOTORS_SUPABASE.anonKey,
        getToken: () => { const s = SupabaseCliente.sesion(); return s ? s.access_token : null; }, refrescar: () => SupabaseCliente.refrescarSesion().then((r) => r.ok) });`);
    prep(e); await e.win.comprobarCuentaPropia("volver"); await e.asentar(10); e.servidor.red = "ok";
    R[k] = { clase: denegadas.length ? "ABRE_Y_EXPULSA" : "SIGUE_DENTRO", mensaje: denegadas.length ? String(denegadas[0][0]).slice(0, 90) : null };
  }
  console.log(`B8A_SESION ${VERSION} ${JSON.stringify(R)}`);
  assert.ok(Object.keys(R).length >= 14);
});
