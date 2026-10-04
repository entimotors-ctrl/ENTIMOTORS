// 3.15.0 · BLOQUE 2 · RENDIMIENTO del flujo de presupuesto de una orden (app real, laboratorio local). N ciclos por la UI real y la
// MEDIANA de cada paso: abrir presupuesto · buscar producto · seleccionar producto · cambiar cantidad · guardar · aprobar · sincronizar.
// Mismo guion en 3.14.1 (B2_BASE=<carpeta con taller-demo/ de e807f65>, base SIN sync-15a/15b) y en 3.15. En 3.14.1 no existe el
// buscador (paso «n/a») ni la aprobación en el servidor («Aprobar en el local» solo marcaba la orden): se mide lo que había.
//   B2_N=5 SYNC_NAVEGADORES=chromium node --test pruebas/sync/browser/b2-rendimiento.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { iniciarPila, PERFILES, FASES_315 } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAV = (process.env.SYNC_NAVEGADORES || "chromium").split(",")[0];
const N = Number(process.env.B2_N || 5);
const BASE = process.env.B2_BASE ? path.join(process.env.B2_BASE, "taller-demo") : null;
const u = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
let pila;
before(async () => { pila = await iniciarPila({ fasesExtra: ["sec-1c-clave-intentos"], excluir: BASE ? FASES_315 : [] }); });
after(async () => { await pila?.detener(); });

test(`rendimiento presupuesto de orden · ${NAV} · ${BASE ? "ANTES (3.14.1)" : "DESPUÉS (3.15 B2)"} · N=${N}`, async () => {
  assert.ok(NAVEGADORES[NAV]);
  pila.limpiar();
  // catálogo realista (40 productos) y N órdenes en «presupuesto» con cliente y moto
  pila.sql(`insert into public.inventario (id, nombre, precio_venta, costo_compra) select ('00000000-0000-4000-9000-0000000019'||lpad(g::text,2,'0'))::uuid, 'Producto '||lpad(g::text,2,'0'), 10*g, 5*g from generate_series(10,49) g;
            insert into public.inventario_movimientos (inventario_id, tipo, cantidad) select id, 'apertura', 1000 from public.inventario;
            insert into public.clientes (id, nombre) select ('00000000-0000-4000-9000-0000000042'||lpad(g::text,2,'0'))::uuid, 'Perf '||g from generate_series(10,10+${N}) g;
            insert into public.motos (id, cliente_id, marca, modelo, placa) select ('00000000-0000-4000-9000-0000000043'||lpad(g::text,2,'0'))::uuid, ('00000000-0000-4000-9000-0000000042'||lpad(g::text,2,'0'))::uuid, 'Honda', 'XR', 'P'||g from generate_series(10,10+${N}) g;
            insert into public.ordenes (id, cliente_id, moto_id, estado, falla) select ('00000000-0000-4000-9000-0000000041'||lpad(g::text,2,'0'))::uuid, ('00000000-0000-4000-9000-0000000042'||lpad(g::text,2,'0'))::uuid, ('00000000-0000-4000-9000-0000000043'||lpad(g::text,2,'0'))::uuid, 'presupuesto', 'perf' from generate_series(10,10+${N}) g;`);
  const d = await abrirDispositivo({ navegador: NAV, nombre: `b2-perf-${NAV}`, pagina: "index.html", real: true, raiz: BASE });
  try {
    await d.eval(async (a) => {
      window.toast = function (m) { (window.__toasts ||= []).push(String(m)); };
      window.SupabaseCliente.sesion = function () { return { access_token: a.token }; };
      window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true }; };
      window.SupabaseCliente.refrescarSesion = async function () { return { ok: true }; };
      currentUser = { uid: a.id, nombre: "cajero", rol: "cajero", origen: "supabase", activo: true, perfilId: null };
      await prepararModoNube({ rol: "cajero", origen: "supabase", activo: true, uid: a.id, perfilId: null });
      await syncMotor.pullTodo();
      return true;
    }, { token: pila.jwt(PERFILES.cajero), id: PERFILES.cajero });
    const muestras = await d.eval(async (n) => {
      const esperar = async (f, ms = 20000) => { const h = Date.now() + ms; while (Date.now() < h) { if (await f()) return true; await new Promise((r) => setTimeout(r, 5)); } return false; };
      const cola = () => esperar(async () => { const p = (await syncBd.outbox.todos()).filter((o) => o.estado === "pending" || o.estado === "syncing"); if (!p.length) return true; await syncMotor.sincronizar(); return false; });
      const nuevo = !!document.getElementById("itemTipo");
      const ordenes = (await DB.getAll("ordenes")).filter((o) => o.estado === "presupuesto").sort((a, b) => a.id - b.id);
      const out = [];
      for (let k = 0; k < n; k++) {
        const t = {}, T = () => performance.now(); let t0;
        const o = ordenes[k];
        t0 = T(); await openOrder(o.id); await esperar(() => document.getElementById("btnAgregarItem")); t.abrirPresupuesto = T() - t0;
        document.getElementById("btnAgregarItem").click();
        await esperar(() => document.getElementById("modalItem").classList.contains("active"));
        const sel = document.getElementById(nuevo ? "itemInvSelect" : "itemInventarioSelect");
        await esperar(() => sel.options.length > 1);
        if (nuevo) {
          t0 = T(); const b = document.getElementById("itemBuscar"); b.value = "Producto 3"; b.dispatchEvent(new Event("input"));
          await esperar(() => [...sel.options].every((x) => x.textContent.startsWith("Producto 3"))); t.buscarProducto = T() - t0;
        } else t.buscarProducto = null;
        t0 = T();
        if (nuevo) { const tp = document.getElementById("itemTipo"); tp.value = "repuesto_inventario"; tp.dispatchEvent(new Event("change")); }
        else { const og = document.getElementById("itemOrigen"); og.value = "inventario"; og.dispatchEvent(new Event("change")); }
        sel.value = [...sel.options].find((x) => x.textContent.startsWith("Producto 33")).value; sel.dispatchEvent(new Event("change"));
        if (!nuevo) document.getElementById("itemPrecio").value = "330";   // 3.14.1 no autocompletaba el precio en la orden
        t.seleccionarProducto = T() - t0;
        t0 = T(); const c = document.getElementById("itemCantidad"); c.value = "2"; c.dispatchEvent(new Event("input"));
        if (nuevo) await esperar(() => /660/.test(document.getElementById("itemSubtotal").textContent));
        t.cambiarCantidad = T() - t0;
        t0 = T(); document.getElementById("btnGuardarItem").click();
        await esperar(() => !document.getElementById("modalItem").classList.contains("active") && document.getElementById("btnAprobarLocal"));
        t.guardar = T() - t0;
        window.__toasts = [];
        t0 = T(); document.getElementById("btnAprobarLocal").click();
        await esperar(() => window.__toasts.some((x) => /[Aa]probad/.test(x))); t.aprobar = T() - t0;
        t0 = T(); await cola(); await syncMotor.pullTodo(); t.sincronizar = T() - t0;
        out.push(t);
      }
      return out;
    }, N, { plazoMs: 300000 });
    const med = {};
    for (const k of Object.keys(muestras[0])) {
      const v = muestras.map((m) => m[k]).filter((x) => x != null).sort((a, b) => a - b);
      med[k] = v.length ? Math.round(v[Math.floor(v.length / 2)] * 10) / 10 : "n/a";
    }
    if (!BASE) {
      const ok = Number(pila.sql(`select count(*) from public.ordenes where presupuesto_estado = 'aprobado'`));
      assert.equal(ok, N, "todas las aprobaciones llegaron al servidor");
    }
    console.log(`RENDIMIENTO-B2 ${NAV} ${BASE ? "ANTES" : "DESPUES"} N=${N} mediana_ms=${JSON.stringify(med)}`);
  } finally { await d.cerrar(); }
});
