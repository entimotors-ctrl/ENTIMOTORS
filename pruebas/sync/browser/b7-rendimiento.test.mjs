// 3.15.0 · BLOQUE 7 · RENDIMIENTO REPRODUCIBLE (app real + Postgres/PostgREST reales, Chromium y Firefox). MIDE; los umbrales
// (holgados, para no generar flakes) viven en b7-umbrales.test.mjs.
//   Taller: arranque en frío (dispositivo nuevo: descarga inicial) y en caliente (reabrir con la caché llena), fases del arranque,
//           peticiones/bytes, cada pantalla (primer render y mediana de 5), IndexedDB por almacén y memoria al navegar en ciclos.
//   Mi Trabajo: arranque, trabajos, mensajes, cambio de estado (local y confirmado por el servidor) y reapertura.
// Variables:
//   B7_VOLUMENES=actual,3000,10000,25000   B7_ETIQUETA=antes|despues   B7_RAIZ=<carpeta con taller-demo/ a medir (p. ej. la copia ANTES)>
//   B7_SALIDA=<archivo .jsonl>   B7_CICLOS=20   SYNC_NAVEGADORES=chromium,firefox
//   SYNC_NAVEGADORES=chromium B7_VOLUMENES=actual node --test --test-concurrency=1 pruebas/sync/browser/b7-rendimiento.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { sembrarVolumen } from "./lib/volumen.mjs";
import { instrumentar, prepararSesion, navegacion, rssMb, cpuS, memoriaSistema, anotar } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const VOLS = (process.env.B7_VOLUMENES || "actual,3000").split(",").filter(Boolean);
const ETQ = process.env.B7_ETIQUETA || "despues";
const RAIZ = process.env.B7_RAIZ ? process.env.B7_RAIZ + "/taller-demo" : null;
const SALIDA = process.env.B7_SALIDA || null;
const CICLOS = Number(process.env.B7_CICLOS || 20);
const PLAZO = { plazoMs: 600000 };

let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

const red = (p0) => {
  const p = pila.peticiones.slice(p0);
  const reales = p.filter((x) => x.metodo !== "OPTIONS");
  return { peticiones: reales.length, preflight: p.length - reales.length, bytes: reales.reduce((s, x) => s + (x.bytes || 0), 0),
    rutas: Object.entries(reales.reduce((m, x) => { const k = `${x.metodo} ${x.ruta.replace(/^\/rest\/v1/, "")}`; m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 14) };
};
async function recargar(d) {
  await d.eval(() => { window.__paginaVieja = true; setTimeout(() => location.reload(), 30); return true; });
  await new Promise((r) => setTimeout(r, 400));
  for (let i = 0; i < 120; i++) { try { if ((await d.eval(() => !window.__paginaVieja && document.readyState, null, { plazoMs: 3000 })) === "complete") break; } catch { /* navegando */ } await new Promise((r) => setTimeout(r, 250)); }
}
/** startApp REAL con la sesión dada; devuelve el tiempo total, las fases y cuándo quedó utilizable (dashboard / Mi Trabajo pintado). */
const arrancar = (d, a) => d.eval(async (a) => {
  window.__b7.marcas = [];
  const t0 = performance.now();
  await startApp({ uid: a.id, nombre: a.rol, rol: a.rol, origen: "supabase", activo: true, perfilId: a.rol === "mecanico" ? a.id : null, user: null });
  const t1 = performance.now();
  // 3.15 (Bloque 7): la puesta al día puede seguir en segundo plano: se mide también cuándo quedó AL DÍA (no se esconde trabajo)
  if (typeof esperarDescargaArranque === "function") await esperarDescargaArranque();
  const tAlDia = performance.now();
  await new Promise((r) => setTimeout(r, 300));   // el primer ciclo del motor (envío de la cola) arranca después
  const M = window.__b7.marcas;
  const primera = (n) => M.find((m) => m.n === n);
  const util = primera(a.rol === "mecanico" ? "renderMiTrabajo" : "renderDashboard");
  const fases = {};
  for (const m of M) { const k = m.n; fases[k] = fases[k] || { n: 0, ms: 0 }; fases[k].n++; fases[k].ms = Math.round((fases[k].ms + (m.t1 - m.t0)) * 10) / 10; }
  const chip = document.getElementById("syncChip") || document.querySelector("[data-sync-chip]");
  if (window.renderSyncChipNube) await renderSyncChipNube();
  return { startApp_ms: Math.round(t1 - t0), alDia_ms: Math.round(tAlDia - t0), utilizable_ms: util ? Math.round(util.t1 - t0) : null, shell: document.getElementById("shell").classList.contains("active"),
    desdeNavegacion_ms: Math.round(t1), fases, chip: chip ? chip.textContent.trim().slice(0, 80) : null };
}, a, PLAZO);

const VISTAS_TALLER = ["dashboard", "clientes", "citas", "cotizaciones", "ordenes", "inventario", "pos", "creditos", "finanzas", "ajustes", "mensajes", "usuarios"];
const pantallas = (d, vistas) => d.eval(async (vistas) => {
  const med = (v) => { const s = [...v].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)] * 10) / 10; };
  const cuadro = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const medir = async (f) => { const js = [], pint = []; let primero = null;
    for (let i = 0; i < 6; i++) { const t = performance.now(); await f(); const tj = performance.now(); await cuadro(); const tp = performance.now();
      if (i === 0) primero = { js: Math.round(tj - t), pintado: Math.round(tp - t) }; else { js.push(tj - t); pint.push(tp - t); } }
    return { primero, js: med(js), pintado: med(pint), nodos: document.getElementsByTagName("*").length }; };
  const out = {};
  for (const v of vistas) { if (!showView(v)) { out[v] = "sin acceso"; continue; } try { out[v] = await medir(() => renderByView[v]()); } catch (e) { out[v] = "error: " + String(e.message || e).slice(0, 80); } }
  // lo que no es una vista del menú: ficha de cliente (motos), detalle de orden, detalle de cotización
  const cli = (await DB.getAll("clientes"))[0], ord = (await DB.getAll("ordenes")).find((o) => o.estado !== "entregado"), cot = (await DB.getAll("cotizaciones"))[0];
  if (cli) { showView("clientes"); out["motos(ficha cliente)"] = await medir(() => openClienteDetalle(cli.id)); }
  if (ord) { showView("ordenes"); out["orden(detalle)"] = await medir(() => openOrder(ord.id)); }
  if (cot) { showView("cotizaciones"); out["cotizacion(detalle)"] = await medir(() => abrirCotizacionDetalle(cot.id)); }
  document.querySelectorAll(".modal-bg.active").forEach((m) => m.classList.remove("active"));
  showView("dashboard");
  return out;
}, vistas, PLAZO);

const indexedDb = (d) => d.eval(async () => {
  const med = (v) => { const s = [...v].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)] * 10) / 10; };
  const out = {};
  for (const s of ["clientes", "motos", "citas", "ordenes", "inventario", "cotizaciones", "ventas_rapidas", "caja_movimientos", "creditos", "auditoria"]) {
    const v = []; let n = 0; for (let i = 0; i < 5; i++) { const t = performance.now(); n = (await DB.getAll(s)).length; v.push(performance.now() - t); }
    out[s] = { filas: n, getAll_ms: med(v) };
  }
  const idx = []; for (let i = 0; i < 5; i++) { const t = performance.now(); await syncBd.outbox.porEstado("pending"); idx.push(performance.now() - t); }
  out.outbox_porEstado_ms = med(idx);
  const g = []; const c1 = (await DB.getAll("clientes"))[0];
  if (c1) for (let i = 0; i < 5; i++) { const t = performance.now(); await DB.get("clientes", c1.id); g.push(performance.now() - t); }
  out.get_uno_ms = g.length ? med(g) : null;
  // búsqueda global (Ctrl+K): lee 5 almacenes y filtra en memoria
  const inp = document.getElementById("buscarGlobalInput"); const bg = [];
  for (let i = 0; i < 3; i++) { const t = performance.now(); inp.value = "cliente 1"; inp.dispatchEvent(new Event("input")); await new Promise((r) => setTimeout(r, 0));
    const h = Date.now() + 20000; while (Date.now() < h && !document.getElementById("buscarGlobalResultados").innerHTML) await new Promise((r) => setTimeout(r, 5)); bg.push(performance.now() - t);
    inp.value = ""; inp.dispatchEvent(new Event("input")); await new Promise((r) => setTimeout(r, 30)); }
  out.busqueda_global_ms = med(bg);
  return out;
}, null, PLAZO);

/** Navegación repetida Dashboard → Orden → Inventario → Cotización → Dashboard; memoria tras cada ciclo. */
async function ciclosMemoria(d, nav) {
  const muestras = [];
  for (let c = 0; c <= CICLOS; c++) {
    const m = await d.eval(async (c) => {
      if (c > 0) {
        const ord = (await DB.getAll("ordenes")).find((o) => o.estado !== "entregado"), cot = (await DB.getAll("cotizaciones"))[0];
        showView("dashboard"); await renderDashboard();
        if (ord) { showView("ordenes"); await renderOrdersList(); await openOrder(ord.id); }
        showView("inventario"); await renderInventario();
        if (cot) { showView("cotizaciones"); await renderCotizaciones(); await abrirCotizacionDetalle(cot.id); }
        document.querySelectorAll(".modal-bg.active").forEach((m) => m.classList.remove("active"));
        showView("dashboard"); await renderDashboard();
      }
      if (typeof window.gc === "function") { window.gc(); await new Promise((r) => setTimeout(r, 50)); window.gc(); }
      return { heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : null, nodos: document.getElementsByTagName("*").length };
    }, c, PLAZO);
    muestras.push({ c, ...m, rssMb: rssMb(d.pid) });
  }
  const a = muestras[1], m = muestras[Math.floor(CICLOS / 2)], z = muestras[muestras.length - 1];
  return { ciclos: CICLOS, heap_ciclo1: a.heapMb, heap_mitad: m.heapMb, heap_final: z.heapMb, nodos_ciclo1: a.nodos, nodos_final: z.nodos, rss_ciclo1: a.rssMb, rss_mitad: m.rssMb, rss_final: z.rssMb,
    heap_pendiente_mb_por_ciclo_2a_mitad: a.heapMb != null ? Math.round(((z.heapMb - m.heapMb) / Math.max(1, CICLOS - Math.floor(CICLOS / 2))) * 100) / 100 : null, navegador: nav };
}

for (const nav of NAVS) for (const vol of VOLS) {
  test(`TALLER · ${nav} · volumen ${vol} · ${ETQ}`, async () => {
    const tam = sembrarVolumen(pila, vol);
    const d = await abrirDispositivo({ navegador: nav, nombre: `b7-${nav}-${vol}`, pagina: "index.html", real: true, raiz: RAIZ, gc: nav === "chromium" });
    const R = { volumen: vol, tamanos: tam, navegador: nav, sistema: memoriaSistema() };
    try {
      R.navegacion_fria = await navegacion(d);
      await instrumentar(d); await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
      let p0 = pila.peticiones.length; let c0 = cpuS(d.pid);
      R.arranque_frio = await arrancar(d, { id: PERFILES.admin, rol: "admin" });
      R.arranque_frio.red = red(p0); R.arranque_frio.cpu_s = Math.round((cpuS(d.pid) - c0) * 100) / 100;
      await d.eval(async () => { await syncMotor.sincronizar?.(); return true; }, null, PLAZO);
      R.pantallas = await pantallas(d, VISTAS_TALLER);
      R.indexeddb = await indexedDb(d);
      R.memoria = await ciclosMemoria(d, nav);
      // reabrir: misma caché, recarga real de la página
      await recargar(d);
      R.navegacion_caliente = await navegacion(d);
      await instrumentar(d); await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
      p0 = pila.peticiones.length; c0 = cpuS(d.pid);
      R.arranque_caliente = await arrancar(d, { id: PERFILES.admin, rol: "admin" });
      R.arranque_caliente.red = red(p0); R.arranque_caliente.cpu_s = Math.round((cpuS(d.pid) - c0) * 100) / 100;
      R.rss_final_mb = rssMb(d.pid);
      anotar(SALIDA, `${ETQ}|${nav}|${vol}|taller`, R);
      assert.ok(R.arranque_frio.shell && R.arranque_caliente.shell, "el Taller abre");
      assert.equal(R.indexeddb.caja_movimientos.filas, tam.caja, "toda la caja llegó al dispositivo");
    } finally { await d.cerrar(); }
  });

  test(`MI TRABAJO · ${nav} · volumen ${vol} · ${ETQ}`, async () => {
    const tam = sembrarVolumen(pila, vol);
    const d = await abrirDispositivo({ navegador: nav, nombre: `b7mt-${nav}-${vol}`, pagina: "index.html", real: true, producto: "mecanico", raiz: RAIZ, gc: nav === "chromium" });
    const R = { volumen: vol, tamanos: tam, navegador: nav };
    try {
      await instrumentar(d); await prepararSesion(d, pila.jwt(PERFILES.mecanico, { segundos: 7200 }));
      let p0 = pila.peticiones.length;
      R.arranque_frio = await arrancar(d, { id: PERFILES.mecanico, rol: "mecanico" });
      R.arranque_frio.red = red(p0);
      R.pantallas = await d.eval(async () => {
        const med = (v) => { const s = [...v].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)] * 10) / 10; };
        const m = async (f) => { const v = []; for (let i = 0; i < 5; i++) { const t = performance.now(); await f(); v.push(performance.now() - t); } return med(v); };
        const mias = (await DB.getAll("ordenes")).filter((o) => !o.anulada);
        return { trabajos: mias.length, citas: (await DB.getAll("citas")).length, mi_trabajo_ms: await m(() => renderMiTrabajo()), mensajes_ms: await m(() => renderMensajesMiTrabajo()),
          orden_detalle_ms: mias[0] ? await m(() => openOrder(mias[0].id)) : null };
      }, null, PLAZO);
      p0 = pila.peticiones.length;
      R.cambio_estado = await d.eval(async () => {
        const o = (await DB.getAll("ordenes")).find((x) => AVANCE_MECANICO[x.estado]?.siguiente && !x.anulada);
        if (!o) return null;
        const t0 = performance.now();
        await updateOrder(o.id, (ord) => setStage(ord, AVANCE_MECANICO[o.estado].siguiente));
        const local = performance.now() - t0;
        const h = Date.now() + 30000;
        while (Date.now() < h) { await syncMotor.sincronizar(); const p = (await syncBd.outbox.todos()).filter((x) => x.estado === "pending" || x.estado === "syncing"); if (!p.length) break; await new Promise((r) => setTimeout(r, 20)); }
        return { local_ms: Math.round(local), confirmado_ms: Math.round(performance.now() - t0) };
      }, null, PLAZO);
      R.cambio_estado && (R.cambio_estado.red = red(p0));
      await recargar(d);
      await instrumentar(d); await prepararSesion(d, pila.jwt(PERFILES.mecanico, { segundos: 7200 }));
      p0 = pila.peticiones.length;
      R.reapertura = await arrancar(d, { id: PERFILES.mecanico, rol: "mecanico" });
      R.reapertura.red = red(p0);
      R.rss_final_mb = rssMb(d.pid);
      anotar(SALIDA, `${ETQ}|${nav}|${vol}|mitrabajo`, R);
      assert.ok(R.arranque_frio.shell && R.reapertura.shell, "Mi Trabajo abre");
    } finally { await d.cerrar(); }
  });
}
