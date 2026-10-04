// 3.15.0 · CHECKPOINT 8A · CLIENT-STARTUP-01…06: reabrir la app (dispositivo YA en uso, con sus datos) con la red en malas condiciones.
// B8A_VERSION=3.14.1 = la app de PRODUCCIÓN (commit e807f65, esquema sin 15*); por defecto la 3.15 corregida del árbol. Métricas:
//   FIRST_VISIBLE  primer pintado (first-contentful-paint; si el navegador no lo da, DOMContentLoaded) desde el inicio de la navegación
//   USABLE         la app abierta con sus datos locales (startApp resuelto), desde el inicio de la navegación
//   CLOUD_UPDATED  un cambio hecho en la nube JUSTO antes de abrir ya se ve en el dispositivo (mismo criterio para las dos versiones)
//   ERROR_STATE    pantalla de error, avisos de error o excepciones sin atender
// Escenarios: 01 red lenta (400 kbps, 150 ms; también los archivos de la app) · 02 latencia alta (1 s por petición) · 03 lie-fi (la nube
// acepta y no contesta) · 04 CDN inaccesible · 05 backend inaccesible (PostgREST caído) · 06 reconexión (abre sin red, vuelve la red).
// Registro B8A_STARTUP. Solo mide; las aserciones son las mínimas (abre y no se pierde nada).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { iniciarPila, PERFILES, RAIZ, FASES, RED } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const V = process.env.B8A_VERSION || "3.15";
const RAIZ_APP = V === "3.14.1" ? path.resolve(RAIZ, "../ENTIMOTORS-3.15-bloque8/candidatos/base-3.14.1/taller-demo") : null;
const TOPE_MS = 45000;
let pila, sumidero; const colgadas = new Set(); const R = {};
before(async () => {
  pila = await iniciarPila(V === "3.14.1" ? { excluir: FASES.filter((f) => /^15/.test(f)) } : {});
  sumidero = net.createServer((s) => { colgadas.add(s); s.on("error", () => {}); s.on("close", () => colgadas.delete(s)); });
  await new Promise((r) => sumidero.listen(0, "127.0.0.1", r));
});
after(async () => { Object.assign(RED, { latenciaMs: 0, kbps: 0 }); spawnSync("docker", ["start", "entimotors-sync-rest"]); for (const s of colgadas) s.destroy(); sumidero?.close(); await pila?.detener();
  console.log(`B8A_STARTUP ${V} ${JSON.stringify(R)}`); });

// arranca la app (sesión de la prueba) y mide desde el inicio de la navegación
const medirArranque = (d, marcador) => d.eval(async (a) => {
  window.__errores = []; addEventListener("error", (e) => window.__errores.push(String(e.message).slice(0, 80))); addEventListener("unhandledrejection", (e) => window.__errores.push(String(e.reason?.message || e.reason).slice(0, 80)));
  const real = window.fetch.bind(window);
  window.fetch = (u, i) => (String(u?.url || u).indexOf(window.ENTIMOTORS_SUPABASE.url) === 0 && window.__sinRed ? Promise.reject(new TypeError("Failed to fetch")) : real(u, i));
  window.__sinRed = !!a.sinRed;
  const nav = performance.getEntriesByType("navigation")[0] || {};
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const pintado = Math.round(fcp ? fcp.startTime : nav.domContentLoadedEventEnd || 0);
  // USABLE = el tablero (lo primero que se ve) pintado con el shell activo; el resto de pantallas se pintan después en segundo plano
  window.__usable = null; const rd = window.renderDashboard;
  window.renderDashboard = async function () { const x = await rd.apply(this, arguments); if (window.__usable == null && document.getElementById("shell")?.classList.contains("active")) window.__usable = Math.round(performance.now()); return x; };
  const tope = new Promise((r) => setTimeout(() => r("tope"), a.tope));
  const arranque = startApp({ uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null }).then(() => "ok", (e) => "error: " + e.message);
  const h = Date.now() + a.tope; while (window.__usable == null && Date.now() < h) await new Promise((r) => setTimeout(r, 50));
  const res = await Promise.race([arranque, new Promise((r) => setTimeout(() => r("sigue-en-segundo-plano"), 1500))]);
  return { FIRST_VISIBLE: pintado, USABLE: window.__usable, arranque_completo: res === "ok" ? Math.round(performance.now()) : res };
}, { id: PERFILES.admin, tope: TOPE_MS, sinRed: !!marcador?.sinRed }, { plazoMs: TOPE_MS + 20000 });
// CLOUD_UPDATED: el marcador (insertado en la nube antes de abrir) ya está en el dispositivo
const esperarMarcador = (d, nombre, ms) => d.eval(async (a) => {
  const h = Date.now() + a.ms;
  while (Date.now() < h) { if ((await DB.getAll("clientes")).some((c) => c.nombre === a.nombre)) return Math.round(performance.now()); await new Promise((r) => setTimeout(r, 150)); }
  return null;
}, { nombre, ms }, { plazoMs: ms + 15000 });
const estadoError = (d) => d.eval(() => ({ pantallaError: !!document.getElementById("gateAlmacen")?.classList.contains("active") || !!document.getElementById("gateLogin")?.classList.contains("active"),
  avisos: (window.__toasts || []).filter((t) => /error|no se pudo|sin conexi|falló/i.test(t)).slice(-2), excepciones: (window.__errores || []).slice(-3),
  shell: !!document.getElementById("shell")?.classList.contains("active") }), null, { plazoMs: 10000 });
// la página ANTERIOR deja de sincronizar y se esperan sus peticiones en curso ANTES de poner el marcador: si no, una petición suya que
// llega al servidor después del alta se lleva el marcador a IndexedDB y la página nueva lo «ve» sin haber hablado con la nube
async function aislarPaginaAnterior(d) {
  const antes = { ...RED }; Object.assign(RED, { latenciaMs: 0, kbps: 0 });
  await d.eval(() => { try { syncMotor?.detener(); } catch (e) { /* ya */ } window.__sinRed = true; return true; }, null, { plazoMs: 15000 }).catch(() => {});
  await new Promise((x) => setTimeout(x, 2500)); Object.assign(RED, antes);
}
async function reabrirYMedir(d, { marcador, sinRed = false, esperarNube = TOPE_MS }) {
  await aislarPaginaAnterior(d);
  if (marcador) pila.sql(`insert into public.clientes (id, nombre) values ('${crypto.randomUUID()}', '${marcador}')`);
  await new Promise((x) => setTimeout(x, 1000));
  const t0 = Date.now();
  try { await d.reabrir(90000); }
  catch (e) {   // NO_ABRE: la página no llegó a estar lista; se deja constancia y se recupera el dispositivo con la red buena
    const resultado = { NO_ABRE: true, esperado_ms: Date.now() - t0, detalle: String(e.message).slice(0, 120) };
    const antes = { ...RED }; Object.assign(RED, { latenciaMs: 0, kbps: 0 }); spawnSync("docker", ["start", "entimotors-sync-rest"]);
    await d.reabrir(90000); Object.assign(RED, antes);
    return resultado;
  }
  await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
  const m = await medirArranque(d, { sinRed });
  m.CLOUD_UPDATED = m.USABLE != null && marcador ? await esperarMarcador(d, marcador, esperarNube) : null;
  m.ERROR_STATE = await estadoError(d);
  return m;
}

for (const nav of NAVS) test(`STARTUP-01…06 · app ${V} · ${nav}`, async () => {
  pila.limpiar(); const r = {}; R[nav] = r;
  // dispositivo en uso: primera apertura con red buena (descarga lo suyo)
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8a-red-${nav}`, pagina: "index.html", real: true, raiz: RAIZ_APP, redEstaticos: true, plazoApertura: 60000 });
  try {
    await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
    r.inicial = await medirArranque(d, null);
    await d.eval(async () => { if (typeof esperarDescargaArranque === "function") await esperarDescargaArranque(); else await syncMotor.sincronizar(); return true; }, null, { plazoMs: 120000 });
    r.referencia_red_buena = await reabrirYMedir(d, { marcador: "Marcador 00" });
    Object.assign(RED, { latenciaMs: 150, kbps: 400 }); r.STARTUP_01_red_lenta = await reabrirYMedir(d, { marcador: "Marcador 01" }); Object.assign(RED, { latenciaMs: 0, kbps: 0 });
    Object.assign(RED, { latenciaMs: 1000, kbps: 1000 }); r.STARTUP_02_latencia_alta = await reabrirYMedir(d, { marcador: "Marcador 02" }); Object.assign(RED, { latenciaMs: 0, kbps: 0 });
    Object.assign(RED, { latenciaMs: 60000, kbps: 0 }); r.STARTUP_03_lie_fi = await reabrirYMedir(d, { marcador: "Marcador 03", esperarNube: 20000 }); Object.assign(RED, { latenciaMs: 0, kbps: 0 });
    spawnSync("docker", ["stop", "-t", "1", "entimotors-sync-rest"]);
    r.STARTUP_05_backend_caido = await reabrirYMedir(d, { marcador: null });
    spawnSync("docker", ["start", "entimotors-sync-rest"]); await new Promise((x) => setTimeout(x, 4000));
    r.STARTUP_05_recupera_ms = await d.eval(async () => { const t0 = performance.now(); const h = Date.now() + 60000;
      while (Date.now() < h) { try { await syncMotor.sincronizar(); const ok = await syncRest.seleccionar("clientes", { select: "id", limite: 1 }); if (ok.ok) return Math.round(performance.now() - t0); } catch (e) { /* aún no */ } await new Promise((x) => setTimeout(x, 500)); } return null; }, null, { plazoMs: 80000 }).catch(() => null);
    // 06 · abre SIN red, y la red vuelve 10 s después
    await aislarPaginaAnterior(d);
    pila.sql(`insert into public.clientes (id, nombre) values ('${crypto.randomUUID()}', 'Marcador 06')`);
    await new Promise((x) => setTimeout(x, 3000)); await d.reabrir(90000); await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
    const s06 = await medirArranque(d, { sinRed: true });
    await d.eval(() => { setTimeout(() => { window.__sinRed = false; window.dispatchEvent(new Event("online")); }, 10000); return true; });
    s06.CLOUD_UPDATED = await esperarMarcador(d, "Marcador 06", TOPE_MS + 10000); s06.ERROR_STATE = await estadoError(d); s06.red_vuelve_en_ms = "USABLE + ~10000";
    r.STARTUP_06_reconexion = s06;
  } finally { Object.assign(RED, { latenciaMs: 0, kbps: 0 }); spawnSync("docker", ["start", "entimotors-sync-rest"]); await d.cerrar(); }
  // 04 · CDN inaccesible (Chart.js por un proxy que nunca contesta): otro dispositivo, abierto así desde el principio
  const c = await abrirDispositivo({ navegador: nav, nombre: `b8a-cdn-${nav}`, pagina: "index.html", real: true, raiz: RAIZ_APP, proxySumidero: sumidero.address().port, plazoApertura: 60000 }).catch((e) => ({ fallo: String(e.message).slice(0, 120) }));
  if (c.fallo) r.STARTUP_04_cdn_caido = { NO_ABRE: c.fallo };
  else {
    try { await prepararSesion(c, pila.jwt(PERFILES.admin, { segundos: 7200 })); const m = await medirArranque(c, null); m.ERROR_STATE = await estadoError(c); r.STARTUP_04_cdn_caido = m; }
    finally { await c.cerrar(); }
  }
  // la 3.15 tiene que ABRIR con sus datos locales en todos (la 3.14.1 se mide tal cual: es la línea base)
  if (V !== "3.14.1") for (const [k, v] of Object.entries(r)) if (/^STARTUP_0[1-6]_[a-z_]+$/.test(k) && v && typeof v === "object") assert.ok(!v.NO_ABRE && v.USABLE != null, `${k}: la app abre con sus datos locales (${JSON.stringify(v)})`);
});
