// SYNC-7A · app real (index.html + app.js de verdad): confirma que guardarSincronizado() dispara EXACTAMENTE
// una vez el stock de apertura al crear un repuesto (nunca en una edición posterior) y que D-4 (solo admin edita
// el maestro) se aplica también del lado del cliente (puedeEscribirEntidadNube), no solo por RLS. Mismo patrón
// que sync6-app-real.test.mjs (abrirDispositivo({real:true}) sirve taller-demo/ tal cual).
//   node --test pruebas/sync/browser/sync7a-app-real.test.mjs          (requiere pruebas/sync/entorno-local.sh up y Docker)
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

for (const nav of NAVS) {
  describe(`SYNC-7A · app real — stock de apertura y D-4 (inventario) · ${nav}`, () => {
    test("crear un repuesto (admin) dispara EXACTAMENTE un stock de apertura; editarlo después no dispara un segundo", async () => {
      pila.limpiar();
      const d = await abrirDispositivo({ navegador: nav, nombre: `app-real-inv-${nav}`, pagina: "index.html", real: true });
      try {
        // prepararModoNube() ya deja arrancar() corriendo un flush() de fondo (mismo camino que la app real):
        // llamar a syncMotor.flush() a mano se puede OMITIR ("otra-pestana", el candado ya lo tiene ese flush
        // de fondo) — en vez de eso se espera a que la cola se vacíe sola (mismo trabajo, sin la carrera).
        const r = await d.eval(async (a) => {
          window.SupabaseCliente.sesion = function () { return { access_token: a.token }; };
          window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true, usuario: "admin@example.test" }; };
          window.SupabaseCliente.refrescarSesion = async function () { return { ok: true }; };
          currentUser = { uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null };
          await prepararModoNube({ rol: "admin", origen: "supabase", activo: true, uid: a.id });

          async function esperarColaVacia(maxMs) {
            const hasta = Date.now() + maxMs;
            while (Date.now() < hasta) {
              const pend = (await syncBd.outbox.todos()).filter((o) => o.estado === "pending" || o.estado === "syncing");
              if (!pend.length) return true;
              await new Promise((res) => setTimeout(res, 100));
            }
            return false;
          }

          const nuevoId = await DB.save("inventario", { nombre: "Repuesto app real", modelo: "", cantidad: 9, precio: 100, precioVenta: 100, costoCompra: 50, stockMinimo: 2, codigoBarras: "", categoriaId: null, publicarEnWeb: false, foto: null });
          const vacio1 = await esperarColaVacia(5000);
          const rep = await DB.get("inventario", nuevoId);
          const uid = rep && rep.uid;

          await DB.save("inventario", { ...rep, precio: 200, precioVenta: 200 });
          const vacio2 = await esperarColaVacia(5000);
          return { uid, vacio1, vacio2, colaFinal: await syncBd.outbox.todos() };
        }, { token: pila.jwt(PERFILES.admin), id: PERFILES.admin });

        assert.equal(r.vacio1, true, "la cola drenó sola tras crear (alta + apertura)");
        assert.equal(r.vacio2, true, "la cola drenó sola tras editar");
        assert.equal(r.colaFinal.filter((o) => o.estado !== "rejected").length, 0, "sin ops sin resolver al final: " + JSON.stringify(r.colaFinal));
        const movs = JSON.parse(pila.sql(`select coalesce(json_agg(tipo), '[]') from public.inventario_movimientos where inventario_id = '${r.uid}'`));
        assert.deepEqual(movs, ["apertura"], "un solo movimiento de ledger (apertura) tras crear Y editar el mismo repuesto");
        const [fila] = JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (select cantidad, precio_venta from public.inventario where id = '${r.uid}') t`));
        assert.equal(Number(fila.cantidad), 9, "la cantidad con la que se llenó el formulario llegó por la apertura");
        assert.equal(Number(fila.precio_venta), 200, "y la edición posterior del precio sí se aplicó, sin tocar la cantidad");
      } finally { await d.cerrar(); }
    });

    test("D-4 del lado del cliente: un cajero no puede guardar el maestro de inventario (bloqueado antes de tocar la red)", async () => {
      pila.limpiar();
      const d = await abrirDispositivo({ navegador: nav, nombre: `app-real-inv-cajero-${nav}`, pagina: "index.html", real: true });
      try {
        const r = await d.eval(async (a) => {
          window.SupabaseCliente.sesion = function () { return { access_token: a.token }; };
          window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true, usuario: "cajero@example.test" }; };
          window.SupabaseCliente.refrescarSesion = async function () { return { ok: true }; };
          currentUser = { uid: a.id, nombre: "Caja", rol: "cajero", origen: "supabase", activo: true, perfilId: null, user: null };
          await prepararModoNube({ rol: "cajero", origen: "supabase", activo: true, uid: a.id });

          let lanzo = false;
          try { await DB.save("inventario", { nombre: "No debería guardarse", modelo: "", cantidad: 1, precio: 1, precioVenta: 1, costoCompra: 1, stockMinimo: 1, codigoBarras: "", categoriaId: null, publicarEnWeb: false, foto: null }); }
          catch (e) { lanzo = true; }
          const cola = await syncBd.outbox.todos();
          return { lanzo, colaVacia: cola.length === 0 };
        }, { token: pila.jwt(PERFILES.cajero), id: PERFILES.cajero });

        assert.equal(r.lanzo, true, "DB.save bloqueado localmente (puedeEscribirEntidadNube) debe impedir el guardado");
        assert.equal(r.colaVacia, true, "nada se encoló: el bloqueo es ANTES de tocar la red, no un rechazo del servidor");
        assert.equal(pila.sql(`select count(*) from public.inventario`), "0", "la nube tampoco recibió nada");
      } finally { await d.cerrar(); }
    });
  });
}
