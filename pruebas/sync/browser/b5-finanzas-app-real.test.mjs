// 3.15.0 · BLOQUE 5 · APP REAL · finanzas correctas y respaldo honesto (index.html + app.js reales; Postgres + PostgREST reales con 15e).
//   A · Dashboard: «Cobrado este mes», «Por cobrar», «Entregado sin cobrar» = lo que dice el servidor (finanzas_resumen); ya no hay «Ingresos del mes».
//   B · Finanzas en línea: cobrado hoy / gastos / por cobrar / entregado sin cobrar (dispositivo) + facturado / costo histórico / utilidad bruta
//       (servidor), todo igual a finanzas_resumen; cambiar el costo MAESTRO después no cambia la utilidad.
//   C · Finanzas sin red: lo de efectivo sigue; la utilidad dice «Sin conexión» (no se inventa).
//   D · Ajustes en modo nube: la copia se presenta como caché del dispositivo (no respaldo de la empresa), restaurar no se ofrece, la copia
//       queda marcada «cache-nube», se verifica, y el importador 3.13 la rechaza.
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b5-finanzas-app-real.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
let pila;
before(async () => { pila = await iniciarPila({ fasesExtra: ["sec-1c-clave-intentos"] }); });
after(async () => { await pila?.detener(); });

const U = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
function sembrar() {
  pila.limpiar();
  pila.sql(`set session_replication_role = replica;
    insert into public.clientes (id, nombre, telefono) values ('${U(5001)}', 'Cliente B5', '9');
    insert into public.inventario (id, nombre, precio_venta, costo_compra, cantidad) values ('${U(5011)}', 'Filtro B5', 150, 100, 10);
    -- orden entregada SIN cobrar (500) y orden cobrada de contado hoy (repuesto 150, costo histórico 100)
    insert into public.ordenes (id, cliente_id, estado, falla, entregado_en) values ('${U(5100)}', '${U(5001)}', 'entregado', 'sin cobrar', now() - interval '2 minutes');
    insert into public.orden_items (orden_id, nombre, cantidad, precio, tipo) values ('${U(5100)}', 'Reparación', 1, 500, 'mano_obra');
    insert into public.ordenes (id, cliente_id, estado, falla, finalizada, finalizado_en, tipo_cobro, entregado_en) values ('${U(5200)}', '${U(5001)}', 'entregado', 'cobrada', true, now() - interval '3 minutes', 'contado', now() - interval '3 minutes');
    insert into public.orden_items (orden_id, inventario_id, nombre, cantidad, precio, costo_unitario, tipo, cantidad_aplicada) values ('${U(5200)}', '${U(5011)}', 'Filtro B5', 1, 150, 100, 'repuesto_inventario', 1);
    insert into public.caja_movimientos (tipo, categoria, monto, metodo_pago, descripcion, orden_id, occurred_at) values ('ingreso', 'Servicio taller', 150, 'efectivo', 'Orden B5', '${U(5200)}', now() - interval '3 minutes');
    -- crédito de 600 con un abono de 200 hoy
    insert into public.creditos (id, cliente_nombre, total, abonado, saldo, estado, origen, occurred_at) values ('${U(5300)}', 'Cliente B5', 600, 200, 400, 'parcial', 'pos', now() - interval '4 minutes');
    insert into public.credito_items (credito_id, nombre, cantidad, precio) values ('${U(5300)}', 'Trabajo a crédito', 1, 600);
    insert into public.abonos (id_abono, credito_id, monto, metodo_pago, occurred_at) values ('B5-AB1', '${U(5300)}', 200, 'efectivo', now() - interval '4 minutes');
    insert into public.caja_movimientos (tipo, categoria, monto, metodo_pago, descripcion, credito_id, id_abono, occurred_at) values ('ingreso', 'Cobro de crédito', 200, 'efectivo', 'Abono B5', '${U(5300)}', 'B5-AB1', now() - interval '4 minutes');
    -- fondo de caja (no es cobro) y un gasto
    insert into public.caja_movimientos (tipo, categoria, monto, metodo_pago, descripcion, occurred_at) values
      ('ingreso', 'Apertura de caja', 1000, 'efectivo', 'Fondo', now() - interval '5 minutes'), ('egreso', 'Planilla', 70, 'efectivo', 'Planilla', now() - interval '5 minutes');
    reset session_replication_role;`);
}
const servidor = () => JSON.parse(pila.sql("select public.finanzas_resumen(null, null)").trim());

for (const nav of NAVS) {
  describe(`3.15 · Bloque 5 · finanzas y respaldo · ${nav}`, () => {
    let d, S;
    before(async () => {
      sembrar(); S = servidor();
      d = await abrirDispositivo({ navegador: nav, nombre: `b5f-${nav}`, pagina: "index.html", real: true });
      await d.eval(async (a) => {
        window.__toasts = []; window.toast = (m) => window.__toasts.push(String(m));
        window.SupabaseCliente.sesion = () => ({ access_token: a.token }); window.SupabaseCliente.estado = () => ({ activo: true, conSesion: true }); window.SupabaseCliente.refrescarSesion = async () => ({ ok: true });
        currentUser = { uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null };
        await prepararModoNube({ rol: "admin", origen: "supabase", activo: true, uid: a.id });
        await syncMotor.sincronizar?.();
        document.getElementById("shell").classList.add("active");
      }, { token: pila.jwt(PERFILES.admin), id: PERFILES.admin });
    });
    after(async () => { await d?.cerrar(); });

    test("A · Dashboard: cobrado del mes / por cobrar / entregado sin cobrar = servidor; «Ingresos del mes» ya no existe", async () => {
      assert.equal(S.cobrado_hoy, 350); assert.equal(S.por_cobrar, 400); assert.equal(S.entregado_sin_cobrar, 500);
      const r = await d.eval(async () => {
        await renderDashboard();
        const t = (id) => document.querySelector(`#${id} .big`)?.textContent;
        return { cobrado: t("cardCobradoMes"), sub: document.querySelector("#cardCobradoMes .sub")?.textContent, porCobrar: t("cardPorCobrarDash"), entregado: t("cardEntregadoSinCobrar"),
                 viejo: document.getElementById("widgetGrid").textContent.includes("Ingresos del mes"), money: [money(0)] };
      });
      assert.equal(r.cobrado, `L. ${Number(S.cobrado_mes).toFixed(2)}`); assert.match(r.sub, /hoy L\. 350\.00/);
      assert.equal(r.porCobrar, "L. 400.00"); assert.equal(r.entregado, "L. 500.00"); assert.equal(r.viejo, false);
    });

    test("B · Finanzas en línea = finanzas_resumen; la utilidad usa el costo HISTÓRICO (cambiar el costo maestro no la mueve)", async () => {
      const leer = () => d.eval(async () => {
        document.getElementById("finDesde").value = ""; document.getElementById("finHasta").value = "";
        document.querySelector('#finPeriodoRapido [data-periodo="mes"]').click(); await new Promise((ok) => setTimeout(ok, 50)); await renderFinanzas();
        const v = (k) => document.querySelector(`[data-fin="${k}"] .big`)?.textContent;
        return { hoy: v("cobrado-hoy"), cobrado: v("cobrado"), gastos: v("gastos"), porCobrar: v("por-cobrar"), entregado: v("entregado-sin-cobrar"),
          facturado: v("facturado"), costo: v("costo-repuestos"), utilidad: v("utilidad-bruta"), texto: document.getElementById("finanzasResumen").textContent };
      });
      const m = (n) => `L. ${Number(n).toFixed(2)}`;
      const r = await leer();
      assert.deepEqual([r.hoy, r.cobrado, r.gastos, r.porCobrar, r.entregado], [m(S.cobrado_hoy), m(S.cobrado), m(S.gastos), m(S.por_cobrar), m(S.entregado_sin_cobrar)]);
      assert.deepEqual([r.facturado, r.costo, r.utilidad], [m(S.facturado), m(S.costo_repuestos), m(S.utilidad_bruta)]);
      assert.equal(S.gastos, 70, "el fondo de caja no es gasto"); assert.equal(S.costo_repuestos, 100); assert.equal(S.facturado, 150 + 600);
      assert.match(r.texto, /costo HISTÓRICO/i); assert.doesNotMatch(r.texto, /Utilidad neta|Ingresos totales/);
      pila.sql(`update public.inventario set costo_compra = 140 where id = '${U(5011)}'`);
      const r2 = await leer();
      assert.equal(r2.utilidad, r.utilidad, "F24 en pantalla: la utilidad no se recalcula con el costo maestro nuevo");
    });

    test("C · Finanzas SIN red: el efectivo sigue (del dispositivo); la utilidad dice por qué no está", async () => {
      const r = await d.eval(async () => {
        forcedOffline = true;
        try { await renderFinanzas(); return { hoy: document.querySelector('[data-fin="cobrado-hoy"] .big')?.textContent, sin: [...document.querySelectorAll('[data-fin="sin-servidor"] .sub')].map((x) => x.textContent) }; }
        finally { forcedOffline = false; }
      });
      assert.equal(r.hoy, "L. 350.00"); assert.equal(r.sin.length, 3); assert.ok(r.sin.every((t) => /Sin conexión/.test(t)));
    });

    test("D · Ajustes en modo nube: la copia es la caché del dispositivo, no el respaldo de la empresa; restaurar no se ofrece; el importador 3.13 la rechaza", async () => {
      const r = await d.eval(async () => {
        if (!db) db = await openDb(BASE_TALLER);   // el arnés no pasa por startApp: la base local (web_cms, auditoría) se abre como lo hace la app
        pintarUltimoRespaldo();
        const g = await generarRespaldoVerificado("respaldoEstado");
        return { titulo: document.getElementById("respaldoTitulo").textContent, aviso: document.getElementById("respaldoNoEmpresa").textContent,
          avisoVisible: document.getElementById("respaldoNoEmpresa").style.display !== "none", restaurarOculto: document.getElementById("labelRestaurar").style.display === "none",
          restaurarTexto: document.getElementById("restaurarAlcance").textContent, estado: document.getElementById("respaldoEstado").getAttribute("data-estado"),
          estadoTexto: document.getElementById("respaldoEstado").textContent, formato: g?.respaldo.formato, alcance: g?.respaldo.alcance,
          importador: Import313.validar(JSON.parse(g.verif.texto)) };
      });
      assert.match(r.titulo, /no es el respaldo de la empresa/); assert.ok(r.avisoVisible); assert.match(r.aviso, /NO recupera la empresa/);
      assert.ok(r.restaurarOculto); assert.match(r.restaurarTexto, /No disponible en modo nube/);
      assert.equal(r.estado, "verificada"); assert.match(r.estadoTexto, /No es el respaldo de la empresa/);
      assert.deepEqual([r.formato, r.alcance], ["entimotors-copia-dispositivo", "cache-nube"]);
      assert.equal(r.importador.ok, false); assert.match(r.importador.errores[0], /CACHÉ DE LA NUBE/);
    });
  });
}
