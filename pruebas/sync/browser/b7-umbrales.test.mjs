// 3.15.0 · BLOQUE 7 · UMBRALES DE RENDIMIENTO (guardia contra regresiones grandes, NO una medición fina). App real con 3 000 movimientos
// (Chromium; Firefox con B7_UMBRALES_FIREFOX=1). Los límites son HOLGADOS a propósito (~1,6–4× lo medido después de las optimizaciones del
// Bloque 7 en esta máquina) (ver ENTIMOTORS-3.15-bloque7/BLOQUE-7.md), y aun así muy por debajo de lo que había ANTES en las rutas que se
// optimizaron: un regreso al comportamiento anterior (pintar todo de golpe, esperar la descarga al reabrir, repetir la descarga, RLS por fila)
// los rompe; el ruido normal de la máquina no.
//   node --test pruebas/sync/browser/b7-umbrales.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { sembrarVolumen } from "./lib/volumen.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = ["chromium", ...(process.env.B7_UMBRALES_FIREFOX === "1" ? ["firefox"] : [])].filter((n) => NAVEGADORES[n]);
// ms (mediana de 5, con pintado). ANTES (medido) → DESPUÉS (medido) → UMBRAL
export const UMBRALES = {
  reabrir_utilizable: 1000,     // startApp COMPLETO al reabrir (las 10 pantallas; el Dashboard ya se ve antes): 1 286 → ~510–600 → 1 000
                                //   (la puesta al día con la nube sigue aparte, en segundo plano)
  reabrir_peticiones: 28,       // 32 → 25 → 28           (sin la descarga repetida del primer ciclo)
  frio_descarga: 9000,          // 10 118 → ~5 700 → 9 000 (RLS una vez por consulta + lecturas agrupadas por página)
  finanzas: 480,                // 669 → ~240 → 480
  ordenes: 200,                 // 260 → ~107 → 200
  creditos: 150,                // 183 → ~76 → 150
  ajustes: 100,                 // 122 → (contar sin leer todo) → 100
  dashboard: 300,               // 117 → ~130 → 300 (3.15 B8: DASHBOARD_LINEAR = ACCEPTED_FOR_3_15 — lee la caja completa; esto vigila que no empeore)
  nodos_dom: 30000,             // 36 208 → ~17 000 → 30 000 (listas por tramos)
};

let pila;
before(async () => { pila = await iniciarPila(); sembrarVolumen(pila, "3000"); });
after(async () => { await pila?.detener(); });

for (const nav of NAVS) test(`UMBRALES · 3 000 movimientos · ${nav}`, async () => {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b7u-${nav}`, pagina: "index.html", real: true });
  try {
    await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
    const arrancar = () => d.eval(async (a) => {
      const t0 = performance.now(); let tDesc = null;
      const crear = SyncEngine.crearMotor;
      SyncEngine.crearMotor = function (...x) { const m = crear.apply(this, x); const p = m.pullTodo; m.pullTodo = async (...y) => { const t = performance.now(); try { return await p.apply(m, y); } finally { if (tDesc == null) tDesc = performance.now() - t; } }; return m; };
      await startApp({ uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null });
      const util = performance.now() - t0;
      if (window.esperarDescargaArranque) await esperarDescargaArranque();
      await new Promise((r) => setTimeout(r, 500));
      return { utilizable: Math.round(util), descarga: Math.round(tDesc || 0) };
    }, { id: PERFILES.admin }, { plazoMs: 300000 });
    const frio = await arrancar();
    await d.eval(() => { window.__paginaVieja = true; setTimeout(() => location.reload(), 30); return true; });
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 120; i++) { try { if ((await d.eval(() => !window.__paginaVieja && document.readyState, null, { plazoMs: 3000 })) === "complete") break; } catch { /* navegando */ } await new Promise((r) => setTimeout(r, 250)); }
    await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
    const p0 = pila.peticiones.length;
    const caliente = await arrancar();
    const pet = pila.peticiones.slice(p0).filter((x) => x.metodo !== "OPTIONS").length;
    const pant = await d.eval(async () => {
      const med = async (v) => { const x = []; showView(v); for (let i = 0; i < 5; i++) { const t = performance.now(); await renderByView[v](); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); x.push(performance.now() - t); } x.sort((a, b) => a - b); return Math.round(x[2]); };
      const r = { dashboard: await med("dashboard"), finanzas: await med("finanzas"), ordenes: await med("ordenes"), creditos: await med("creditos"), ajustes: await med("ajustes") };
      showView("dashboard"); r.nodos_dom = document.getElementsByTagName("*").length;
      return r;
    }, null, { plazoMs: 120000 });
    const R = { reabrir_utilizable: caliente.utilizable, reabrir_peticiones: pet, frio_descarga: frio.descarga, ...pant };
    console.log(`UMBRALES_B7 ${nav} ${JSON.stringify(R)}`);
    for (const [k, lim] of Object.entries(UMBRALES)) assert.ok(R[k] <= lim, `${k}: ${R[k]} > ${lim}`);
  } finally { await d.cerrar(); }
});
