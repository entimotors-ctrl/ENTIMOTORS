// 3.15.0 · BLOQUE 3 · APP REAL · día empresarial America/Tegucigalpa en pantalla (Postgres + PostgREST reales).
// Con el reloj de la página fijado a 17:59, 18:00, 23:59, 00:00 y 00:01 HORA DE HONDURAS se comprueba lo que ve el Taller:
//   V · citas de hoy (lista de Citas y aviso) · W · cierre de caja del día · X · «Citas hoy» del Dashboard · Y · filtro «Hoy» de Finanzas.
// Hasta 3.14.1 todo eso usaba la fecha UTC: desde las 18:00 locales mostraba el día SIGUIENTE.
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b3-fecha-app-real.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

// Todo en el PASADO respecto del reloj real (el servidor no acepta hechos futuros): día empresarial 28-sep-2026 y 29-sep-2026.
const CASOS = [
  { hora: "17:59", ahora: "2026-09-28T23:59:00Z", hoy: "2026-09-28" },
  { hora: "18:00", ahora: "2026-09-29T00:00:00Z", hoy: "2026-09-28" },   // UTC ya dice 29
  { hora: "23:59", ahora: "2026-09-29T05:59:00Z", hoy: "2026-09-28" },
  { hora: "00:00", ahora: "2026-09-29T06:00:00Z", hoy: "2026-09-29" },
  { hora: "00:01", ahora: "2026-09-29T06:01:00Z", hoy: "2026-09-29" },
];
const CAJA = { "2026-09-28": ["Caja 17:30 del 28", "Caja 18:30 del 28"], "2026-09-29": ["Caja 00:30 del 29"] };

for (const nav of NAVS) {
  describe(`3.15 · Bloque 3 · día empresarial en pantalla · ${nav}`, () => {
    let d;
    before(async () => {
      pila.limpiar();
      pila.sql(`insert into public.citas (id, nombre_tmp, telefono_tmp, fecha, hora, motivo) values
          ('00000000-0000-4000-9000-00000000f028', 'Cliente 28', '1', '2026-09-28', '10:00', 'Cita del 28'),
          ('00000000-0000-4000-9000-00000000f029', 'Cliente 29', '1', '2026-09-29', '10:00', 'Cita del 29');
        set session_replication_role = replica;
        insert into public.caja_movimientos (tipo, categoria, monto, metodo_pago, descripcion, occurred_at, creado_en) values
          ('ingreso', 'Venta mostrador', 100, 'efectivo', 'Caja 17:30 del 28', '2026-09-28T23:30:00Z', '2026-09-28T23:30:00Z'),
          ('ingreso', 'Venta mostrador', 200, 'efectivo', 'Caja 18:30 del 28', '2026-09-29T00:30:00Z', '2026-09-29T00:30:00Z'),
          ('egreso', 'Otros', 50, 'efectivo', 'Caja 00:30 del 29', '2026-09-29T06:30:00Z', '2026-09-29T06:30:00Z');
        reset session_replication_role;`);
      // B3_BASE=<carpeta con taller-demo/ de e807f65> corre lo mismo contra la app 3.14.1 (debe FALLAR a las 18:00 y 23:59)
      d = await abrirDispositivo({ navegador: nav, nombre: `b3f-${nav}`, pagina: "index.html", real: true, raiz: process.env.B3_BASE ? process.env.B3_BASE + "/taller-demo" : null });
      await d.eval(async (a) => {
        window.__toasts = []; window.toast = (m) => window.__toasts.push(String(m));
        window.SupabaseCliente.sesion = () => ({ access_token: a.token }); window.SupabaseCliente.estado = () => ({ activo: true, conSesion: true }); window.SupabaseCliente.refrescarSesion = async () => ({ ok: true });
        currentUser = { uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null };
        await prepararModoNube({ rol: "admin", origen: "supabase", activo: true, uid: a.id });
        syncMotor.detener();   // con el reloj fijado no debe correr nada por su cuenta
        document.getElementById("shell").classList.add("active");
        window.abrirVentanaImpresion = () => null; window.imprimirPlantilla = () => {};   // el cierre se lee de la pantalla, sin imprimir
        window.__DateReal = window.Date;
        return (await DB.getAll("caja_movimientos")).length + (await DB.getAll("citas")).length;
      }, { token: pila.jwt(PERFILES.admin), id: PERFILES.admin });
    });
    after(async () => { await d?.cerrar(); });

    for (const c of CASOS) {
      test(`${c.hora} hora de Honduras → «hoy» = ${c.hoy} en citas, caja del día, dashboard y filtros`, async () => {
        const r = await d.eval(async (a) => {
          const REAL = window.__DateReal, fijo = REAL.parse(a.ahora);
          class Fijo extends REAL { constructor(...x) { if (x.length === 0) super(fijo); else super(...x); } static now() { return fijo; } }
          window.Date = Fijo;
          try {
            const mini = (vista, lbl) => { const b = [...document.querySelectorAll(`#view-${vista} .widget-mini`)].find((x) => x.querySelector(".lbl")?.textContent === lbl); return b ? b.querySelector(".val").textContent : null; };
            await renderDashboard();
            const dashboard = mini("dashboard", "Citas hoy");
            await renderCitasList();
            const hoyCitas = mini("citas", "Hoy");
            const etiquetas = (await DB.getAll("citas")).map((ci) => [ci.motivo, citaWhenInfo(ci).label]);
            await renderNotificaciones();
            const avisos = [...document.querySelectorAll("#notifPanel *")].map((x) => x.textContent).join(" ");
            document.querySelector('#finPeriodoRapido [data-periodo="hoy"]').click();
            await new Promise((ok) => setTimeout(ok, 50)); await renderFinanzas();
            const filtro = { desde: document.getElementById("finDesde").value, hasta: document.getElementById("finHasta").value, filas: [...document.querySelectorAll("#movimientosBody tr")].map((tr) => tr.textContent) };
            document.getElementById("btnImprimirCierre").click();
            await new Promise((ok) => setTimeout(ok, 300));
            const cierre = [...document.querySelectorAll("#cierreItems tr")].length;
            const cierreFecha = document.getElementById("cierreFecha").textContent;
            return { dashboard, hoyCitas, etiquetas, avisos, filtro, cierre, cierreFecha, toasts: window.__toasts.slice(-2), utc: new Date().toISOString().slice(0, 10) };
          } finally { window.Date = REAL; }
        }, c);
        const esperadas = CAJA[c.hoy];
        assert.equal(r.dashboard, "1", "X · Dashboard: una cita hoy");
        assert.equal(r.hoyCitas, "1", "V · Citas: filtro Hoy");
        const hoyMotivo = c.hoy === "2026-09-28" ? "Cita del 28" : "Cita del 29", otra = c.hoy === "2026-09-28" ? "Cita del 29" : "Cita del 28";
        assert.equal(r.etiquetas.find(([m]) => m === hoyMotivo)[1], "Hoy");
        assert.equal(r.etiquetas.find(([m]) => m === otra)[1], c.hoy === "2026-09-28" ? "Mañana" : "Pasada");
        assert.equal(r.filtro.desde, c.hoy, "Y · filtro «Hoy»: desde"); assert.equal(r.filtro.hasta, c.hoy, "Y · filtro «Hoy»: hasta");
        assert.equal(r.filtro.filas.length, esperadas.length, `Y · movimientos del día: ${JSON.stringify(r.filtro.filas)}`);
        for (const e of esperadas) assert.ok(r.filtro.filas.some((f) => f.includes(e)), e);
        assert.equal(r.cierre, esperadas.length, "W · cierre de caja: solo los del día empresarial");
        assert.match(r.cierreFecha, new RegExp(String(Number(c.hoy.slice(8)))), "W · el cierre dice el día de Honduras");
        if (c.hora === "18:00") assert.equal(r.utc, "2026-09-29", "(a esta hora la fecha UTC ya es la del día siguiente: así fallaba 3.14.1)");
      });
    }
  });
}
