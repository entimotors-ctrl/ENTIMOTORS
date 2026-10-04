// 3.15.0 · BLOQUE 1A · RENDIMIENTO del flujo de cotización (app real, laboratorio local). Mide N ciclos por la UI real y da la MEDIANA
// de cada paso: abrir Cotizaciones · elegir producto (modal + selección + precio) · guardar · sincronizar (cola vacía) · aceptar/convertir
// (hasta la orden abierta). Mismo guion en 3.14.1 (B1A_BASE=<carpeta con taller-demo/ de e807f65>, base sin sync-15a) y en 3.15.
//   B1A_N=5 SYNC_NAVEGADORES=chromium node --test pruebas/sync/browser/b1a-rendimiento.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { iniciarPila, PERFILES, FASES_315 } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAV = (process.env.SYNC_NAVEGADORES || "chromium").split(",")[0];
const N = Number(process.env.B1A_N || 5);
const BASE = process.env.B1A_BASE ? path.join(process.env.B1A_BASE, "taller-demo") : null;
let pila;
before(async () => { pila = await iniciarPila({ fasesExtra: ["sec-1c-clave-intentos"], excluir: BASE ? FASES_315 : [] }); });
after(async () => { await pila?.detener(); });

test(`rendimiento cotización → orden · ${NAV} · ${BASE ? "ANTES (3.14.1)" : "DESPUÉS (3.15 B1A)"} · N=${N}`, async () => {
  assert.ok(NAVEGADORES[NAV]);
  pila.limpiar();
  // inventario realista: 40 productos (la apertura del modal y la selección dependen del tamaño del catálogo)
  pila.sql(`insert into public.inventario (id, nombre, precio_venta, costo_compra) select ('00000000-0000-4000-9000-0000000019'||lpad(g::text,2,'0'))::uuid, 'Producto '||lpad(g::text,2,'0'), 10*g, 5*g from generate_series(10,49) g;
            insert into public.inventario_movimientos (inventario_id, tipo, cantidad) select id, 'apertura', 100 from public.inventario;`);
  const d = await abrirDispositivo({ navegador: NAV, nombre: `b1a-perf-${NAV}`, pagina: "index.html", real: true, raiz: BASE });
  try {
    await d.eval(async (a) => {
      window.toast = function () {};
      window.SupabaseCliente.sesion = function () { return { access_token: a.token }; };
      window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true }; };
      window.SupabaseCliente.refrescarSesion = async function () { return { ok: true }; };
      currentUser = { uid: a.id, nombre: "cajero", rol: "cajero", origen: "supabase", activo: true, perfilId: null };
      await prepararModoNube({ rol: "cajero", origen: "supabase", activo: true, uid: a.id, perfilId: null });
      return true;
    }, { token: pila.jwt(PERFILES.cajero), id: PERFILES.cajero });
    const muestras = await d.eval(async (n) => {
      const esperar = async (f, ms = 20000) => { const h = Date.now() + ms; while (Date.now() < h) { if (await f()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };
      const modal = (id, v = true) => esperar(() => document.getElementById(id).classList.contains("active") === v);
      const cola = () => esperar(async () => { const p = (await syncBd.outbox.todos()).filter((o) => o.estado === "pending" || o.estado === "syncing"); if (!p.length) return true; await syncMotor.sincronizar(); return false; });
      const out = [];
      for (let k = 0; k < n; k++) {
        const t = {}, T = () => performance.now(); let t0;
        t0 = T(); await renderCotizaciones(); t.abrir = T() - t0;
        document.getElementById("btnNuevaCotizacion").click(); await modal("modalCotizacion");
        document.getElementById("cotNombre").value = "Perf " + k;
        t0 = T();
        for (const prod of ["Producto 12", "Producto 33"]) {
          document.getElementById("btnAgregarItemCot").click(); await modal("modalItemCot");
          await esperar(() => document.getElementById("cotItemInvSelect").options.length > 1);
          const tipo = document.getElementById("cotItemTipo");
          tipo.value = [...tipo.options].some((o) => o.value === "repuesto_inventario") ? "repuesto_inventario" : "inventario"; tipo.dispatchEvent(new Event("change"));
          const sel = document.getElementById("cotItemInvSelect"); sel.value = [...sel.options].find((o) => o.textContent.startsWith(prod)).value; sel.dispatchEvent(new Event("change"));
          document.getElementById("cotItemCantidad").value = "2";
          document.getElementById("btnGuardarItemCot").click(); await modal("modalItemCot", false);
        }
        t.elegirProducto = (T() - t0) / 2;
        t0 = T(); document.getElementById("btnGuardarCotizacion").click(); await modal("modalCotDetalle"); t.guardar = T() - t0;
        t0 = T(); await cola(); t.sincronizar = T() - t0;
        const antes = currentOrderId;
        t0 = T(); document.getElementById("btnCotAceptar").click();
        await esperar(() => currentOrderId != null && currentOrderId !== antes && !document.getElementById("modalCotDetalle").classList.contains("active"));
        await cola(); t.aceptarConvertir = T() - t0;
        out.push(t);
      }
      return out;
    }, N, { plazoMs: 300000 });
    const med = {}; for (const k of Object.keys(muestras[0])) { const v = muestras.map((m) => m[k]).sort((a, b) => a - b); med[k] = Math.round(v[Math.floor(v.length / 2)] * 10) / 10; }
    console.log(`RENDIMIENTO ${NAV} ${BASE ? "ANTES" : "DESPUES"} N=${N} mediana_ms=${JSON.stringify(med)}`);
  } finally { await d.cerrar(); }
});
