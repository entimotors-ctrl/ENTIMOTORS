// SYNC-7B · APP REAL (index.html + app.js de verdad, en Chrome y Firefox) contra PostgREST/Postgres reales y el
// api-server REAL del PIN (lib/api-local.mjs + shim de auth SOLO de pruebas del gateway). Las operaciones se disparan
// por las funciones reales de app.js (registrarVentaRapida, cobrarAlCredito, registrarAbonoCredito,
// finalizarOrdenNube…) y las acciones sensibles por la UI real: botón de la tabla de caja → modal de motivo → modal
// PIN. La verdad se comprueba en la NUBE (SQL) y en la caché que ve la UI (DB.getAll), también tras recargar la página.
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/sync7b-app-real.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES, CLAVE_CUENTA_PRUEBA } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { iniciarApi, llamar, API_URL } from "./lib/api-local.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const PIN = "482915";
const INV = "00000000-0000-4000-9000-000000000701";
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

const uno = (q) => pila.sql(q);
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (${q}) t`));
function sembrarRepuesto(cant) {
  pila.limpiar();
  uno(`insert into public.inventario (id, nombre, precio_venta, costo_compra) values ('${INV}', 'Aceite app real', 100, 60);
       insert into public.inventario_movimientos (inventario_id, tipo, cantidad) values ('${INV}', 'apertura', ${cant});`);
}
const invariantesServidor = () => uno(`select public.verificar_invariantes()::text`);

let n = 0;
async function abrir(nav, rol) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `7b-${rol}-${nav}-${++n}`, pagina: "index.html", real: true, apiUrl: API_URL });
  await entrar(d, rol);
  return d;
}
/* Sesión de nube simulada como en sync7a-app-real (sin login UI ni GoTrue), + captura de toasts y un corte de red. */
function entrar(d, rol) {
  return d.eval(async (a) => {
    window.__toasts = [];
    window.toast = function (m) { window.__toasts.push(String(m)); };
    if (!window.__fetchReal) {
      window.__fetchReal = window.fetch.bind(window);
      window.__sinRed = false; window.__perderRespuestaDe = null;
      window.fetch = function (url, init) {
        const u = String(url && url.url ? url.url : url);
        const nube = u.indexOf(window.ENTIMOTORS_SUPABASE.url) === 0 || u.indexOf(window.ENTIMOTORS_SUPABASE.apiUrl) === 0;
        if (nube && window.__sinRed) return Promise.reject(new TypeError("Failed to fetch"));
        if (nube && window.__perderRespuestaDe && u.indexOf("/rpc/" + window.__perderRespuestaDe) > 0) {
          window.__perderRespuestaDe = null;   // la petición LLEGA al servidor, pero la respuesta se pierde
          return window.__fetchReal(url, init).then(function () { throw new TypeError("Failed to fetch"); });
        }
        return window.__fetchReal(url, init);
      };
    }
    window.SupabaseCliente.sesion = function () { return { access_token: a.token }; };
    window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true, usuario: a.rol + "@example.test" }; };
    window.SupabaseCliente.refrescarSesion = async function () { return { ok: true }; };
    currentUser = { uid: a.id, nombre: a.rol, rol: a.rol, origen: "supabase", activo: true, perfilId: a.rol === "mecanico" ? a.id : null, user: null };
    await prepararModoNube({ rol: a.rol, origen: "supabase", activo: true, uid: a.id, perfilId: a.rol === "mecanico" ? a.id : null });
    window.__esperarCola = async function (ms) {
      const hasta = Date.now() + (ms || 15000);
      while (Date.now() < hasta) {
        const p = (await syncBd.outbox.todos()).filter((o) => o.estado === "pending" || o.estado === "syncing");
        if (!p.length) return true;
        await syncMotor.sincronizar();
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    };
    /* Completa los modales REALES: primero el de motivo (showPrompt), luego el de PIN (si pin !== undefined). */
    window.__modales = async function (motivo, pin) {
      const esperar = async (id) => { for (let i = 0; i < 100; i++) { if (document.getElementById(id).classList.contains("active")) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
      if (!(await esperar("modalPrompt"))) return "sin-modal-motivo";
      document.getElementById("promptInput").value = motivo;
      document.getElementById("btnPromptAceptar").click();
      if (pin === undefined) return "ok";
      if (!(await esperar("modalPinAutorizar"))) return "sin-modal-pin";
      document.getElementById("pinAutorizarInput").value = pin;
      document.getElementById("btnPinAutorizarOk").click();
      await new Promise((r) => setTimeout(r, 50));
      return document.getElementById("pinAutorizarInput").value === "" ? "ok" : "pin-quedo-en-el-campo";
    };
    return true;
  }, { token: pila.jwt(PERFILES[rol]), id: PERFILES[rol], rol });
}
/* Recarga REAL de la página. Una orden al puente puede perderse si la toma la página vieja justo antes de descargarse
   (más visible en Firefox): se marca la página y se sondea con plazos cortos hasta que responde la página NUEVA. */
async function recargar(d, rol) {
  const marca = "m" + Math.random();
  await d.eval((m) => { window.__marca = m; setTimeout(() => location.reload(), 50); return true; }, marca);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await d.eval(() => (document.readyState === "complete" ? window.__marca || "nueva" : "cargando"), null, { plazoMs: 3000 })) === "nueva") break; } catch { /* orden perdida en la descarga: se reintenta */ }
  }
  await entrar(d, rol);
}
const localInv = (d) => d.eval(async (uid) => { const r = (await DB.getAll("inventario")).find((x) => x.uid === uid); return r ? { id: r.id, cantidad: r.cantidad, requiereRevision: r.requiereRevision } : null; }, INV);

for (const nav of NAVS) {
  describe(`SYNC-7B · app real (index.html + app.js) · ${nav}`, () => {
    let api; const abiertos = [];
    const abrirD = async (rol) => { const d = await abrir(nav, rol); abiertos.push(d); return d; };
    before(async () => {
      api = await iniciarApi(pila, { origenes: [] });
      const r = await llamar(pila, api, "PUT", "/api/admin/pin", { sub: PERFILES.admin, cuerpo: { pin_nuevo: PIN, clave_cuenta: CLAVE_CUENTA_PRUEBA } });
      assert.equal(r.status, 200, JSON.stringify(r.datos));
    });
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); await api?.detener(); });
    // el CORS selectivo del backend real exige el origen exacto de cada dispositivo: se reinicia con ese origen
    async function apiPara(d) {
      await api.detener(); api = await iniciarApi(pila, { origenes: [d.origen] });
      await llamar(pila, api, "POST", "/api/admin/pin/desbloquear", { sub: PERFILES.admin });
    }

    test("CAJERO: venta → RPC → stock y caja cambian en la nube y en la caché; recargar la página conserva todo", async () => {
      sembrarRepuesto(10);
      // cada paso lleva nombre: si uno se queda sin respuesta, el error dice cuál
      const paso = async (nombre, fn) => { const t0 = Date.now(); try { return await fn(); } catch (e) { throw new Error(`[paso ${nombre}, ${Date.now() - t0} ms] ${e.message}`); } };
      const d = await paso("abrir+entrar", () => abrirD("cajero"));
      const r = await paso("venta", () => d.eval(async (uid) => {
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        const v = await registrarVentaRapida({ items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 2, precio: 100 }], clienteId: null, clienteNombre: "Mostrador", metodoPago: "efectivo", efectivoRecibido: 200 });
        return { estado: v.estado, id: v.id, total: v.total };
      }, INV));
      assert.equal(r.estado, "ok");
      assert.equal(r.total, 200);
      assert.equal(uno(`select cantidad::int from public.inventario where id = '${INV}'`), "8");
      assert.deepEqual(nube(`select tipo, monto::int, categoria from public.caja_movimientos`), [{ tipo: "ingreso", monto: 200, categoria: "Venta mostrador" }]);
      assert.equal((await paso("cache-inv", () => localInv(d))).cantidad, 8, "la caché muestra el stock del servidor");
      assert.equal(await paso("cache-caja", () => d.eval(async () => (await DB.getAll("caja_movimientos")).length)), 1);
      await paso("recargar", () => recargar(d, "cajero"));
      assert.equal((await paso("cache-inv-2", () => localInv(d))).cantidad, 8, "tras recargar sigue igual");
      assert.equal(await paso("cache-ventas-2", () => d.eval(async () => (await DB.getAll("ventas_rapidas")).filter((v) => v.total === 200 && !v._pend).length)), 1);
      assert.equal(invariantesServidor(), "[]");
    });

    test("venta ONLINE sin stock: rechazo visible (terminal), nada queda en la cola ni en la nube; escribir dinero directo está bloqueado", async () => {
      sembrarRepuesto(1);
      const d = await abrirD("cajero");
      const r = await d.eval(async (uid) => {
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        let error = null;
        try { await registrarVentaRapida({ items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 5, precio: 100 }], metodoPago: "efectivo", efectivoRecibido: 500 }); }
        catch (e) { error = e.message; }
        let directo = null;
        try { await DB.save("caja_movimientos", { tipo: "ingreso", monto: 1 }); } catch (e) { directo = e.message; }
        let borrar = null;
        try { await DB.delete("ventas_rapidas", 1); } catch (e) { borrar = e.message; }
        return { error, directo, borrar, cola: (await syncBd.outbox.todos()).length };
      }, INV);
      assert.match(r.error, /Sin stock suficiente/);
      assert.match(r.directo, /FINANCIERO_SOLO_RPC/);
      assert.match(r.borrar, /FINANCIERO_SOLO_RPC/);
      assert.equal(r.cola, 0, "el rechazo que la persona vio no queda colgado en la cola");
      assert.equal(uno(`select count(*) from public.ventas`), "0");
    });

    test("venta SIN RED → outbox (op estable) → al volver, UNA venta aunque se pierda la respuesta; sobreventa offline → negativo + requiere_revision", async () => {
      sembrarRepuesto(1);
      const d = await abrirD("cajero");
      const r1 = await d.eval(async (uid) => {
        window.__sinRed = true; forcedOffline = true;
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        const v = await registrarVentaRapida({ items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 3, precio: 100 }], metodoPago: "efectivo", efectivoRecibido: 300 });
        const cola = await syncBd.outbox.todos();
        const local = await DB.get("ventas_rapidas", v.id);
        return { estado: v.estado, cola: cola.map((o) => ({ rpc: o.rpc, p_offline: o.params.p_offline, p_op: o.params.p_op, op_id: o.op_id, cant: o.params.p_items[0].cantidad })), provisional: !!(local && local._pend) };
      }, INV);
      assert.equal(r1.estado, "pendiente");
      assert.equal(r1.cola.length, 1); assert.equal(r1.cola[0].rpc, "registrar_venta_v2"); assert.equal(r1.cola[0].p_offline, true);
      assert.equal(r1.cola[0].p_op, r1.cola[0].op_id); assert.equal(r1.cola[0].cant, 3, "nunca se recorta");
      assert.equal(r1.provisional, true, "la venta se ve en la caché mientras tanto");
      assert.equal(uno(`select count(*) from public.ventas`), "0", "sin red no llegó nada");
      await new Promise((r) => setTimeout(r, 21000));   // el servidor solo cree "offline" si el hecho es >20 s anterior
      const r2 = await d.eval(async () => {
        window.__sinRed = false; forcedOffline = false; window.__perderRespuestaDe = "registrar_venta_v2";
        const vacia = await window.__esperarCola(20000);
        await syncMotor.pullTodo();
        return { vacia, rechazos: (await syncBd.outbox.todos()).filter((o) => o.estado === "rejected").length };
      });
      assert.equal(r2.vacia, true); assert.equal(r2.rechazos, 0);
      assert.equal(uno(`select count(*) from public.ventas`), "1", "respuesta perdida + reintento = UNA venta");
      assert.equal(uno(`select count(*) from public.caja_movimientos`), "1");
      assert.equal(uno(`select cantidad::int || '/' || requiere_revision from public.inventario where id = '${INV}'`), "-2/true");
      assert.equal(uno(`select capturada_offline from public.ventas`), "t");
      const loc = await localInv(d);
      assert.deepEqual([loc.cantidad, loc.requiereRevision], [-2, true], "la caché muestra el negativo y la marca de revisión");
      assert.equal(await d.eval(async () => (await DB.getAll("ventas_rapidas")).length), 1, "el provisional se reemplazó, no se duplicó");
      assert.equal(invariantesServidor(), "[]");
    });

    test("caso A: venta ONLINE que pierde la red a mitad queda pendiente (p_offline=false); si al volver otro ya agotó el stock, el rechazo queda VISIBLE (toast + cola), no se pierde en silencio", async () => {
      sembrarRepuesto(2);
      const d = await abrirD("cajero");
      const r1 = await d.eval(async (uid) => {
        window.__sinRed = true;                     // la app cree que hay red (isOnline) pero la petición no llega
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        const v = await registrarVentaRapida({ items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 2, precio: 100 }], metodoPago: "efectivo", efectivoRecibido: 200 });
        const [op] = await syncBd.outbox.todos();
        return { estado: v.estado, p_offline: op.params.p_offline, id: v.id };
      }, INV);
      assert.deepEqual([r1.estado, r1.p_offline], ["pendiente", false]);
      // mientras tanto, otro dispositivo vende las 2 unidades
      const venta = await fetch(`${pila.REST_URL}/rest/v1/rpc/registrar_venta_v2`, { method: "POST", headers: { apikey: "a", Authorization: "Bearer " + pila.jwt(PERFILES.admin), "Content-Type": "application/json" },
        body: JSON.stringify({ p_op: "00000000-0000-4000-9000-00000000a0a0", p_cliente_id: null, p_cliente_nombre: "otro", p_metodo_pago: "efectivo", p_efectivo: 0, p_items: [{ inventario_id: INV, nombre: "x", cantidad: 2, precio: 100 }] }) });
      assert.equal(venta.status, 200);
      const r2 = await d.eval(async (id) => {
        window.__toasts = []; window.__sinRed = false;
        await window.__esperarCola(30000);          // respeta el backoff real del outbox hasta que el servidor responda
        for (let i = 0; i < 30 && !window.__toasts.length; i++) await new Promise((r) => setTimeout(r, 100));
        const cola = await syncBd.outbox.todos();
        const local = await DB.get("ventas_rapidas", id);
        return { toasts: window.__toasts.slice(), cola: cola.map((o) => ({ estado: o.estado, msg: o.error && o.error.mensaje })), local: !!local };
      }, r1.id);
      assert.ok(r2.toasts.some((t) => /rechazada/.test(t) && /Sin stock/.test(t)), JSON.stringify(r2));
      assert.equal(r2.cola.length, 1); assert.equal(r2.cola[0].estado, "rejected"); assert.match(r2.cola[0].msg, /Sin stock/);
      assert.equal(r2.local, true, "la venta sigue a la vista (provisional) para que el taller decida");
      assert.equal(uno(`select count(*) from public.ventas`), "1", "solo la del otro dispositivo; nunca stock negativo online");
      assert.equal(uno(`select cantidad::int from public.inventario where id = '${INV}'`), "0");
      assert.equal(invariantesServidor(), "[]");
    });

    test("crédito con entrada → aparece; abono → el servidor recalcula el saldo; la caja refleja entrada y abono", async () => {
      sembrarRepuesto(5);
      const d = await abrirD("cajero");
      const r = await d.eval(async (uid) => {
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        const c = await cobrarAlCredito({ clienteId: null, clienteNombre: "Luis Crédito", clienteTelefono: "9999", items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 1, precio: 300 }], abono: 100, abonoMetodo: "efectivo", nota: "prueba", origen: "pos" });
        const cred1 = await DB.get("creditos", c.id);
        await registrarAbonoCredito(c.id, 50, "transferencia");
        const cred2 = await DB.get("creditos", c.id);
        return { saldo1: cred1.saldo, saldo2: cred2.saldo, abonos: cred2.historialAbonos.length };
      }, INV);
      assert.deepEqual(r, { saldo1: 200, saldo2: 150, abonos: 2 });
      assert.equal(uno(`select total::int || '/' || abonado::int || '/' || saldo::int from public.creditos`), "300/150/150");
      assert.equal(uno(`select sum(monto)::int from public.caja_movimientos where credito_id is not null`), "150");
      assert.equal(uno(`select cantidad::int from public.inventario where id = '${INV}'`), "4");
      assert.equal(invariantesServidor(), "[]");
    });

    test("anular venta desde la tabla de caja: modal de motivo → modal PIN; PIN incorrecto niega; correcto anula; recargar lo conserva; el admin lo ve auditado", async () => {
      sembrarRepuesto(10);
      const d = await abrirD("cajero");
      await apiPara(d);
      await d.eval(async (uid) => {
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        await registrarVentaRapida({ items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 2, precio: 100 }], metodoPago: "efectivo", efectivoRecibido: 200 });
        return true;
      }, INV);
      const intentar = (pin) => d.eval(async (pin) => {
        window.__toasts = [];
        await renderFinanzas();
        const btn = document.querySelector("[data-anular-venta]");
        if (!btn) return { sinBoton: true };
        btn.click();
        const m = await window.__modales("cliente devolvió todo", pin);
        for (let i = 0; i < 60 && !window.__toasts.length; i++) await new Promise((r) => setTimeout(r, 100));
        return { modales: m, toasts: window.__toasts.slice() };
      }, pin);
      const mal = await intentar("907315");
      assert.equal(mal.modales, "ok", "se mostró el modal PIN real y el campo se vació");
      assert.ok(mal.toasts.some((t) => /PIN incorrecto/.test(t)), JSON.stringify(mal.toasts));
      assert.equal(uno(`select anulada from public.ventas`), "f", "PIN incorrecto: nada cambió");
      const bien = await intentar(PIN);
      assert.ok(bien.toasts.some((t) => /Venta anulada/.test(t)), JSON.stringify(bien.toasts));
      assert.equal(uno(`select anulada from public.ventas`), "t");
      assert.equal(uno(`select cantidad::int from public.inventario where id = '${INV}'`), "10", "el stock volvió por ledger");
      assert.equal(uno(`select sum(case tipo when 'ingreso' then monto else -monto end)::int from public.caja_movimientos`), "0", "caja compensada");
      const aud = nube(`select r.autorizado_por, r.device_id is not null dev, r.autorizacion_id is not null aut from public.reversos r`);
      assert.deepEqual(aud, [{ autorizado_por: PERFILES.admin, dev: true, aut: true }]);
      await recargar(d, "cajero");
      assert.equal(await d.eval(async () => (await DB.getAll("ventas_rapidas"))[0].anulada), true, "tras recargar sigue anulada");
      // el admin ve la auditoría (RLS auditoria_admin_lee) y el cajero no
      const leer = async (quien) => (await fetch(`${pila.REST_URL}/rest/v1/auditoria?accion=eq.anular-venta&select=accion,autorizado_por`, { headers: { apikey: "a", Authorization: "Bearer " + pila.jwt(PERFILES[quien]) } })).json();
      assert.deepEqual(await leer("admin"), [{ accion: "anular-venta", autorizado_por: PERFILES.admin }]);
      assert.deepEqual(await leer("cajero"), []);
      assert.equal(invariantesServidor(), "[]");
    });

    test("UI real de reversos (admin, sin PIN): devolución 'renglón:cantidad' validada, revertir abono, anular crédito, revertir movimiento de caja — originales conservados", async () => {
      sembrarRepuesto(10);
      const d = await abrirD("admin");
      const r = await d.eval(async (uid) => {
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        await registrarVentaRapida({ items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 3, precio: 100 }], metodoPago: "efectivo", efectivoRecibido: 300 });
        const esperarToast = async (re) => { for (let i = 0; i < 80; i++) { if (window.__toasts.some((t) => re.test(t))) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
        const prompt = async (valor) => { for (let i = 0; i < 80 && !document.getElementById("modalPrompt").classList.contains("active"); i++) await new Promise((r) => setTimeout(r, 100));
          document.getElementById("promptInput").value = valor; document.getElementById("btnPromptAceptar").click(); await new Promise((r) => setTimeout(r, 150)); };
        const out = {};
        // devolución inválida (más de lo vendido) → no llega a la red
        window.__toasts = []; await renderFinanzas(); document.querySelector("[data-devolver-venta]").click(); await prompt("1:9");
        out.invalida = await esperarToast(/inválidos/);
        // devolución válida de 1 unidad
        window.__toasts = []; await renderFinanzas(); document.querySelector("[data-devolver-venta]").click(); await prompt("1:1"); await prompt("una salió mala");
        out.devolucion = await esperarToast(/Devolución registrada/);
        // crédito con entrada + abono, luego revertir el abono y anular el crédito desde el detalle
        const c = await cobrarAlCredito({ clienteId: null, clienteNombre: "Cliente reversos", items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 1, precio: 100 }], abono: 30, abonoMetodo: "efectivo", origen: "pos" });
        await registrarAbonoCredito(c.id, 20, "efectivo");
        await renderCreditos();
        const clave = Object.keys(creditosPorCliente)[0]; abrirCreditoDetalle(clave);
        window.__toasts = []; document.querySelector('#credDetLista [data-act="revertir-abono"][data-abono="1"]').click(); await prompt("abono duplicado");
        out.abono = await esperarToast(/Abono revertido/);
        window.__toasts = []; abrirCreditoDetalle(Object.keys(creditosPorCliente)[0]); document.querySelector('#credDetLista [data-act="eliminar"]').click(); await prompt("crédito mal hecho");
        out.credito = await esperarToast(/Crédito anulado/);
        // movimiento manual de caja y su reverso
        document.getElementById("moviTipo").value = "egreso"; document.getElementById("moviMonto").value = "75"; document.getElementById("moviDescripcion").value = "compra";
        await registrarMovimientoCajaNube({ tipo: "egreso", categoria: "Compra de repuestos", monto: 75, metodoPago: "efectivo", descripcion: "compra" });
        window.__toasts = []; await renderFinanzas(); document.querySelector("[data-revertir-movi]").click(); await prompt("egreso duplicado");
        out.caja = await esperarToast(/Movimiento revertido/);
        await renderCreditos();
        out.creditosVisibles = Object.keys(creditosPorCliente).length;
        return out;
      }, INV);
      assert.deepEqual(r, { invalida: true, devolucion: true, abono: true, credito: true, caja: true, creditosVisibles: 0 });
      assert.equal(uno(`select count(*) from public.reversos`), "4", "devolución + abono + crédito + caja");
      assert.equal(uno(`select count(*) from public.ventas`) + "/" + uno(`select anulada from public.ventas`), "1/f", "la venta se conserva (devolución parcial)");
      assert.equal(uno(`select anulado from public.creditos`), "t");
      assert.equal(uno(`select count(*) filter (where anulado) || '/' || count(*) from public.abonos`), "2/2", "abono revertido + la entrada revertida con el crédito; nada borrado");
      assert.equal(uno(`select cantidad::int from public.inventario where id = '${INV}'`), "8", "10 −3 venta +1 devolución −1 crédito +1 reverso de crédito");
      assert.equal(uno(`select sum(case tipo when 'ingreso' then monto else -monto end)::int from public.caja_movimientos`), "200", "300 −100 devolución +30+20 −20 −30 −75 +75");
      assert.equal(invariantesServidor(), "[]");
    });

    test("PIN SIN RED: se niega antes de pedir el PIN, con el mensaje exacto; nada se encola", async () => {
      sembrarRepuesto(10);
      const d = await abrirD("cajero");
      await d.eval(async (uid) => {
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        await registrarVentaRapida({ items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 1, precio: 100 }], metodoPago: "efectivo", efectivoRecibido: 100 });
        return true;
      }, INV);
      const r = await d.eval(async () => {
        await renderFinanzas();
        window.__sinRed = true; forcedOffline = true; window.__toasts = [];
        document.querySelector("[data-anular-venta]").click();
        const m = await window.__modales("sin conexión", undefined);
        for (let i = 0; i < 40 && !window.__toasts.length; i++) await new Promise((r) => setTimeout(r, 100));
        const pinAbierto = document.getElementById("modalPinAutorizar").classList.contains("active");
        window.__sinRed = false; forcedOffline = false;
        return { m, toasts: window.__toasts.slice(), pinAbierto, cola: (await syncBd.outbox.todos()).length };
      });
      assert.ok(r.toasts.includes("Esta operación requiere conexión para obtener autorización del administrador."), JSON.stringify(r.toasts));
      assert.equal(r.pinAbierto, false); assert.equal(r.cola, 0);
      assert.equal(uno(`select anulada from public.ventas`), "f");
    });

    test("ajuste de stock: cajero SOLO con PIN (modal real); admin directo sin PIN; ambos por ledger", async () => {
      sembrarRepuesto(10);
      const c = await abrirD("cajero");
      await apiPara(c);
      const r = await c.eval(async (a) => {
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === a.uid);
        window.__toasts = [];
        const p = accionAutorizada((x) => syncFin.construir.ajusteStock(x), { inventarioUid: rep.uid, delta: -2, motivo: "rotura en bodega" }, ["inventario"], "Stock ajustado");
        // accionAutorizada no pide motivo (ya viene): solo aparece el modal PIN
        for (let i = 0; i < 100 && !document.getElementById("modalPinAutorizar").classList.contains("active"); i++) await new Promise((r) => setTimeout(r, 100));
        document.getElementById("pinAutorizarInput").value = a.pin;
        document.getElementById("btnPinAutorizarOk").click();
        return { ok: await p, cantidad: (await DB.get("inventario", rep.id)).cantidad };
      }, { uid: INV, pin: PIN });
      assert.deepEqual(r, { ok: true, cantidad: 8 });
      const ad = await abrirD("admin");
      const r2 = await ad.eval(async (uid) => {
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        const ok = await accionAutorizada((x) => syncFin.construir.ajusteStock(x), { inventarioUid: rep.uid, conteo: 15, motivo: "conteo físico" }, ["inventario"], "ok");
        return { ok, pinAbierto: document.getElementById("modalPinAutorizar").classList.contains("active"), cantidad: (await DB.get("inventario", rep.id)).cantidad };
      }, INV);
      assert.deepEqual(r2, { ok: true, pinAbierto: false, cantidad: 15 });
      assert.deepEqual(nube(`select tipo, cantidad::int from public.inventario_movimientos where tipo = 'ajuste' order by creado_en`), [{ tipo: "ajuste", cantidad: -2 }, { tipo: "ajuste", cantidad: 7 }]);
      assert.equal(invariantesServidor(), "[]");
    });

    test("orden: ítem con repuesto por RPC (stock por ledger), finalizar = UNA operación (caja del total del servidor)", async () => {
      sembrarRepuesto(10);
      const d = await abrirD("admin");
      const r = await d.eval(async (uid) => {
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        const cli = await DB.save("clientes", { nombre: "Cliente orden", telefono: "1" });
        const moto = await DB.save("motos", { clienteId: cli, marca: "Honda", modelo: "CB", placa: "X", km: 1 });
        const oid = await DB.save("ordenes", { clienteId: cli, motoId: moto, estado: "recibido", falla: "ruido", items: [], fotos: [], mecanico: "", creadoEn: Date.now() });
        await window.__esperarCola();
        let ord = await DB.get("ordenes", oid);
        const a = await agregarItemOrdenNube(ord, { nombre: rep.nombre, cantidad: 2, precio: 150, inventarioId: rep.id, costoUnitario: 60 });
        const b = await agregarItemOrdenNube(ord, { nombre: "Mano de obra", cantidad: 1, precio: 200, inventarioId: null });
        await updateOrder(oid, (x) => { x.items = [a.item, b.item]; x.estado = "entregado"; x.tipoCobro = "contado"; x.metodoPago = "efectivo"; });
        await window.__esperarCola();
        const f = await finalizarOrdenNube(await DB.get("ordenes", oid), 500);
        return { estado: f.estado, total: f.total, stock: (await DB.get("inventario", rep.id)).cantidad };
      }, INV);
      assert.deepEqual(r, { estado: "ok", total: 500, stock: 8 });
      assert.equal(uno(`select finalizada from public.ordenes`), "t");
      assert.equal(uno(`select count(*) from public.orden_items`), "2");
      assert.deepEqual(nube(`select categoria, monto::int from public.caja_movimientos`), [{ categoria: "Servicio taller", monto: 500 }]);
      assert.equal(invariantesServidor(), "[]");
    });

    test("MECÁNICO: sin acceso financiero (servidor niega, la UI no eleva por PIN, no ve caja ni ventas)", async () => {
      sembrarRepuesto(10);
      uno(`insert into public.caja_movimientos (tipo, categoria, monto, metodo_pago) values ('ingreso', 'Otro', 50, 'efectivo')`);
      const d = await abrirD("mecanico");
      const r = await d.eval(async () => {
        window.__toasts = [];
        let venta = null;
        try { await registrarVentaRapida({ items: [{ inventarioId: null, nombre: "x", cantidad: 1, precio: 1 }], metodoPago: "efectivo", efectivoRecibido: 1 }); } catch (e) { venta = e.message; }
        const elev = await accionAutorizada((x) => syncFin.construir.reversarCaja(x), { cajaUid: "00000000-0000-4000-9000-000000000001", monto: 50, motivo: "intento" }, [], "no");
        return { venta, elev, caja: (await DB.getAll("caja_movimientos")).length, pinAbierto: document.getElementById("modalPinAutorizar").classList.contains("active") };
      });
      assert.match(r.venta || "", /permiso/i);
      assert.equal(r.elev, false); assert.equal(r.pinAbierto, false);
      assert.equal(r.caja, 0, "RLS: el mecánico no baja movimientos de caja");
      assert.equal(uno(`select count(*) from public.ventas`), "0");
    });
  });
}
