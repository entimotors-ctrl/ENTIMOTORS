// 3.15.0 · BLOQUE 5 · RENDIMIENTO antes/después (app real, Chromium): Dashboard, Finanzas (mes), Créditos y el cálculo mensual de caja,
// con volumen (3 000 movimientos de caja, 600 créditos con abonos, 800 órdenes, 500 ventas). Mediana de 7 renders tras la sincronización.
//   después (árbol 3.15):  SYNC_NAVEGADORES=chromium node --test pruebas/sync/browser/b5-rendimiento.test.mjs
//   antes (3.14.1):        B5_BASE=<carpeta con taller-demo/ de e807f65> … (la pila se levanta SIN 15a..15e)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES, FASES_315 } from "./lib/pila.mjs";
import { abrirDispositivo } from "./lib/dispositivo.mjs";

const BASE = process.env.B5_BASE || null;
let pila;
before(async () => { pila = await iniciarPila({ fasesExtra: ["sec-1c-clave-intentos"], excluir: BASE ? FASES_315 : [] }); });
after(async () => { await pila?.detener(); });

test(`rendimiento de finanzas en pantalla · ${BASE ? "ANTES (3.14.1)" : "DESPUÉS (3.15 árbol)"}`, async () => {
  pila.limpiar();
  pila.sql(`set session_replication_role = replica;
    insert into public.caja_movimientos (tipo, categoria, monto, metodo_pago, descripcion, occurred_at)
      select case when g % 5 = 0 then 'egreso' else 'ingreso' end, case when g % 5 = 0 then 'Planilla' else 'Venta mostrador' end, (g % 900) + 10, 'efectivo', 'v' || g,
             now() - (g % 90) * interval '1 day' - (g % 600) * interval '1 minute' from generate_series(1, 3000) g;
    insert into public.creditos (id, cliente_nombre, total, abonado, saldo, estado, origen, occurred_at)
      select ('00000000-0000-4000-d000-' || lpad(g::text, 12, '0'))::uuid, 'c' || g, 1000, 400, 600, 'parcial', 'pos', now() - (g % 90) * interval '1 day' from generate_series(1, 600) g;
    insert into public.credito_items (credito_id, nombre, cantidad, precio) select ('00000000-0000-4000-d000-' || lpad(g::text, 12, '0'))::uuid, 'x', 1, 1000 from generate_series(1, 600) g;
    insert into public.abonos (id_abono, credito_id, monto, metodo_pago, occurred_at)
      select 'P' || g, ('00000000-0000-4000-d000-' || lpad((g % 600 + 1)::text, 12, '0'))::uuid, 200, 'efectivo', now() - (g % 90) * interval '1 day' from generate_series(1, 1200) g;
    insert into public.ordenes (id, estado, falla, finalizada, finalizado_en, entregado_en, tipo_cobro)
      select ('00000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid, 'entregado', 'x', g % 4 <> 0, case when g % 4 <> 0 then now() - (g % 90) * interval '1 day' end, now() - (g % 90) * interval '1 day', 'contado' from generate_series(1, 800) g;
    insert into public.orden_items (orden_id, nombre, cantidad, precio, costo_unitario) select ('00000000-0000-4000-c000-' || lpad((g % 800 + 1)::text, 12, '0'))::uuid, 'mo', 1, 200, 0 from generate_series(1, 2400) g;
    insert into public.ventas (id, metodo_pago, total, occurred_at) select ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, 'efectivo', 150, now() - (g % 90) * interval '1 day' from generate_series(1, 500) g;
    insert into public.venta_items (venta_id, nombre, cantidad, precio, costo_unitario) select ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, 'r', 1, 150, 90 from generate_series(1, 500) g;
    reset session_replication_role; analyze;`);
  const d = await abrirDispositivo({ navegador: "chromium", nombre: `b5r-${BASE ? "antes" : "despues"}`, pagina: "index.html", real: true, raiz: BASE ? BASE + "/taller-demo" : null });
  try {
    const r = await d.eval(async (a) => {
      window.toast = () => {};
      window.SupabaseCliente.sesion = () => ({ access_token: a.token }); window.SupabaseCliente.estado = () => ({ activo: true, conSesion: true }); window.SupabaseCliente.refrescarSesion = async () => ({ ok: true });
      currentUser = { uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null };
      await prepararModoNube({ rol: "admin", origen: "supabase", activo: true, uid: a.id });
      await syncMotor.sincronizar?.(); syncMotor.detener();
      document.getElementById("shell").classList.add("active");
      window.Chart = undefined;   // se mide el cálculo y la tabla, no el dibujo de Chart.js (CDN)
      const med = async (f) => { const v = []; for (let i = 0; i < 7; i++) { const t = performance.now(); await f(); v.push(performance.now() - t); } v.sort((x, y) => x - y); return Math.round(v[3] * 10) / 10; };
      const hoyUtc = new Date().toISOString().slice(0, 10);   // 3.14.1 no tiene FechaNegocio: mismo rango (día 1 → hoy) para las dos versiones
      const mes = () => { document.getElementById("finDesde").value = hoyUtc.slice(0, 8) + "01"; document.getElementById("finHasta").value = hoyUtc; };
      const movs = await DB.getAll("caja_movimientos");
      return {
        filas: { caja: movs.length, creditos: (await DB.getAll("creditos")).length, ordenes: (await DB.getAll("ordenes")).length, ventas: (await DB.getAll("ventas_rapidas")).length },
        dashboard: await med(() => renderDashboard()),
        finanzas_mes: await med(async () => { mes(); await renderFinanzas(); }),
        creditos: await med(() => renderCreditos()),
        desglose: window.FinanzasCalc ? {
          getAll_caja: await med(() => DB.getAll("caja_movimientos")), getAll_creditos: await med(() => DB.getAll("creditos")), getAll_ordenes: await med(() => DB.getAll("ordenes")),
          diaDe_x3000: await med(async () => { for (const m of movs) FechaNegocio.diaDe(m.fechaISO); }),
          rpc_finanzas_resumen: await med(() => syncRest.rpc("finanzas_resumen", { p_desde: FechaNegocio.inicioMes(), p_hasta: FechaNegocio.hoy() })),
          renderRendimiento: await med(() => renderRendimiento(FechaNegocio.inicioMes(), FechaNegocio.hoy())),
        } : null,
        calculo_mensual_caja: window.FinanzasCalc ? await med(async () => FinanzasCalc.caja({ movs, F: window.FechaNegocio })) : null,
      };
    }, { token: pila.jwt(PERFILES.admin, { segundos: 3600 }), id: PERFILES.admin });
    console.log(`RENDIMIENTO_B5 ${BASE ? "antes-3.14.1" : "despues-3.15"} ${JSON.stringify(r)}`);
    assert.ok(r.filas.caja >= 3000 && r.filas.creditos >= 600, JSON.stringify(r.filas));
  } finally { await d.cerrar(); }
});
