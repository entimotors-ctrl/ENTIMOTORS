// SYNC-8 · APP REAL (index.html + app.js de verdad) contra PostgREST/Postgres reales: offline + recarga + reconexión,
// venta con corte y sobreventa sin red visibles en «⚠ Por revisar», mecánico sin red + reasignación (Mi Trabajo real),
// ítems de orden y reporte de producción reconstruidos en OTRO dispositivo, bootstrap de dispositivo limpio, sesión
// caducada y cuenta desactivada. La verdad se comprueba en la NUBE (SQL) y en lo que ve la UI.
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/sync8-app-real.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const INV = "00000000-0000-4000-9000-000000000881";
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

const uno = (q) => pila.sql(q);
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (${q}) t`));
const invariantes = () => uno(`select public.verificar_invariantes()::text`);
function sembrarRepuesto(cant) {
  uno(`insert into public.inventario (id, nombre, precio_venta, costo_compra) values ('${INV}', 'Filtro app 8', 100, 60);
       insert into public.inventario_movimientos (inventario_id, tipo, cantidad) values ('${INV}', 'apertura', ${cant});`);
}

let n = 0;
async function abrir(nav, rol, o = {}) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `8app-${rol}-${nav}-${++n}`, pagina: "index.html", real: true, producto: o.producto || null });
  await entrar(d, rol, o);
  return d;
}
/* Sesión de nube simulada (sin login UI ni GoTrue, igual que sync7b-app-real) + toasts capturados + corte de red.
   o.sinRed: la página arranca SIN red (la petición no llega aunque la app crea estar en línea). */
function entrar(d, rol, o = {}) {
  return d.eval(async (a) => {
    window.__toasts = [];
    window.toast = function (m) { window.__toasts.push(String(m)); };
    if (!window.__fetchReal) {
      window.__fetchReal = window.fetch.bind(window);
      window.__perderRespuestaDe = null;
      window.fetch = function (url, init) {
        const u = String(url && url.url ? url.url : url);
        const nube = u.indexOf(window.ENTIMOTORS_SUPABASE.url) === 0;
        if (nube && window.__sinRed) return Promise.reject(new TypeError("Failed to fetch"));
        if (nube && window.__perderRespuestaDe && u.indexOf("/rpc/" + window.__perderRespuestaDe) > 0) {
          window.__perderRespuestaDe = null;
          return window.__fetchReal(url, init).then(function () { throw new TypeError("Failed to fetch"); });
        }
        return window.__fetchReal(url, init);
      };
    }
    window.__sinRed = !!a.sinRed;
    window.__token = a.token;
    window.SupabaseCliente.sesion = function () { return window.__token ? { access_token: window.__token } : null; };
    window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true, usuario: a.rol + "@example.test" }; };
    window.SupabaseCliente.refrescarSesion = async function () { return { ok: !!window.__token }; };
    const mec = a.rol === "mecanico" || a.rol === "mecanico2";
    currentUser = { uid: a.id, nombre: a.rol, rol: mec ? "mecanico" : a.rol, origen: "supabase", activo: true, perfilId: mec ? a.id : null, user: null };
    await prepararModoNube({ rol: currentUser.rol, origen: "supabase", activo: true, uid: a.id, perfilId: currentUser.perfilId });
    window.__esperarCola = async function (ms) {
      const hasta = Date.now() + (ms || 15000);
      while (Date.now() < hasta) {
        const p = (await syncBd.outbox.todos()).filter((x) => x.estado === "pending" || x.estado === "syncing");
        if (!p.length) return true;
        for (const x of p) if (x.siguiente_en > Date.now()) await syncBd.outbox.actualizar(x.seq, { siguiente_en: 0 });   // sin esperar el backoff real
        await syncMotor.sincronizar();
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    };
    window.__chip = async function () { await renderSyncChipNube(); const b = document.getElementById("btnRevisionSync"); return { label: document.getElementById("syncLabel").textContent, boton: b.style.display !== "none" ? b.textContent : null }; };
    return true;
  }, { token: pila.jwt(PERFILES[rol]), id: PERFILES[rol], rol, sinRed: !!o.sinRed });
}
async function recargar(d, rol, o = {}) {
  const marca = "m" + Math.random();
  await d.eval((m) => { window.__marca = m; setTimeout(() => location.reload(), 50); return true; }, marca);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await d.eval(() => (document.readyState === "complete" ? window.__marca || "nueva" : "cargando"), null, { plazoMs: 3000 })) === "nueva") break; } catch { /* orden perdida en la descarga */ }
  }
  await entrar(d, rol, o);
}
const paso = async (nombre, fn) => { const t0 = Date.now(); try { return await fn(); } catch (e) { throw new Error(`[paso ${nombre}, ${Date.now() - t0} ms] ${e.message}`); } };

for (const nav of NAVS) {
  describe(`SYNC-8 · app real (index.html + app.js) · ${nav}`, () => {
    const abiertos = [];
    const abrirD = async (rol, o) => { const d = await abrir(nav, rol, o); abiertos.push(d); return d; };
    before(() => pila.limpiar());
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });

    test("crear SIN RED → recargar (sigue sin red, el cambio persiste y el indicador lo dice) → reconectar → sincroniza UNA vez", async () => {
      pila.limpiar();
      const d = await paso("abrir", () => abrirD("cajero"));
      const r1 = await paso("crear offline", () => d.eval(async () => {
        window.__sinRed = true; forcedOffline = true;
        const id = await DB.save("clientes", { nombre: "Offline app 8", telefono: "777" });
        return { id, cola: (await syncBd.outbox.todos()).map((o) => o.estado), chip: await window.__chip() };
      }));
      assert.deepEqual(r1.cola, ["pending"]); assert.match(r1.chip.label, /Sin conexión · 1 cambio sin subir/);
      await paso("recargar sin red", () => recargar(d, "cajero", { sinRed: true }));
      const r2 = await d.eval(async () => ({ cola: (await syncBd.outbox.todos()).map((o) => o.estado), cli: (await DB.getAll("clientes")).map((c) => c.nombre) }));
      assert.deepEqual(r2.cola, ["pending"]); assert.deepEqual(r2.cli, ["Offline app 8"]);
      assert.equal(uno(`select count(*) from public.clientes`), "0");
      const r3 = await paso("reconectar", () => d.eval(async () => { window.__sinRed = false; forcedOffline = false; const ok = await window.__esperarCola(); return { ok, chip: await window.__chip() }; }));
      assert.equal(r3.ok, true); assert.match(r3.chip.label, /En línea · sincronizado/);
      assert.deepEqual(nube(`select nombre, created_by from public.clientes`), [{ nombre: "Offline app 8", created_by: PERFILES.cajero }]);
    });

    test("venta con corte a mitad → UNA venta; sobreventa sin red → negativo + revisión; rechazo tras corte → VISIBLE en «⚠ Por revisar» y se atiende", async () => {
      pila.limpiar(); sembrarRepuesto(3);
      const d = await paso("abrir", () => abrirD("cajero"));
      // (1) venta en línea cuya respuesta se pierde: al reconectar, UNA venta
      await paso("venta con corte", () => d.eval(async (uid) => {
        window.__perderRespuestaDe = "registrar_venta_v2";
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        await registrarVentaRapida({ items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 1, precio: 100 }], metodoPago: "efectivo", efectivoRecibido: 100 });
        return window.__esperarCola();
      }, INV));
      assert.equal(uno(`select count(*) from public.ventas`), "1");
      // (2) venta SIN RED de 4 con 2 en existencia → al volver: −2 y requiere_revision, la venta se conserva
      await paso("venta sin red", () => d.eval(async (uid) => {
        window.__sinRed = true; forcedOffline = true;
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        await registrarVentaRapida({ items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 4, precio: 100 }], metodoPago: "efectivo", efectivoRecibido: 400 });
        return true;
      }, INV));
      await new Promise((r) => setTimeout(r, 21000));   // el servidor solo cree «offline» si el hecho es >20 s anterior
      await paso("reconectar", () => d.eval(async () => { window.__sinRed = false; forcedOffline = false; await window.__esperarCola(20000); await syncMotor.pullTodo(); return true; }));
      assert.equal(uno(`select cantidad::int || '/' || requiere_revision from public.inventario where id = '${INV}'`), "-2/true");
      assert.equal(uno(`select count(*) from public.ventas where not anulada`), "2", "la venta sin red NO se destruyó");
      // (3) venta en línea que pierde la red antes de llegar; al volver ya no hay stock (online no admite negativo) → rechazo visible
      await paso("venta rechazada", () => d.eval(async (uid) => {
        window.__sinRed = true;
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === uid);
        await registrarVentaRapida({ items: [{ inventarioId: rep.id, nombre: rep.nombre, cantidad: 1, precio: 100 }], metodoPago: "efectivo", efectivoRecibido: 100 });
        window.__sinRed = false; await window.__esperarCola(20000); return true;
      }, INV));
      const r = await paso("revisión", () => d.eval(async () => {
        const chip = await window.__chip();
        await abrirRevisionSync();
        const modal = document.getElementById("modalRevisionSync");
        const texto = document.getElementById("revisionSyncLista").textContent;
        const boton = document.querySelector("[data-rev-descartar]");
        const abierto = modal.classList.contains("active");
        boton.click();
        for (let i = 0; i < 30 && document.querySelector("[data-rev-descartar]"); i++) await new Promise((ok) => setTimeout(ok, 100));
        const despues = await syncMotor.revision();
        return { chip, texto, abierto, quedan: despues.rechazadas.length, toasts: window.__toasts.slice() };
      }));
      assert.match(r.chip.boton || "", /⚠ 2 por revisar/, JSON.stringify(r.chip));
      assert.equal(r.abierto, true);
      assert.match(r.texto, /Ventas · La nube no lo aceptó/); assert.match(r.texto, /Sin stock|Stock/i);
      assert.match(r.texto, /Inventario · Filtro app 8: existencia -2/);
      assert.ok(!/\b400\b|p_items|efectivo/.test(r.texto), "sin datos enviados ni montos en la lista");
      assert.equal(r.quedan, 0, "«Entendido» la quita de la lista");
      assert.ok(r.toasts.some((t) => /rechazada/.test(t)), "el rechazo también se avisó al ocurrir");
      assert.equal(uno(`select count(*) from public.ventas`), "2");
      assert.equal(invariantes(), "[]");
    });

    test("Mi Trabajo real: mecánico SIN RED avanza su orden; el admin la reasigna; al volver el cambio se RECHAZA visible y la orden no se reabre", async () => {
      pila.limpiar();
      uno(`insert into public.clientes (id, nombre) values ('00000000-0000-4000-9000-000000000891', 'Cli mec');
           insert into public.motos (id, cliente_id, marca, placa, km) values ('00000000-0000-4000-9000-000000000892', '00000000-0000-4000-9000-000000000891', 'Honda', 'MEC-8', 1);
           insert into public.ordenes (id, cliente_id, moto_id, estado, falla, mecanico, mecanico_id, origen_trabajo)
             values ('00000000-0000-4000-9000-000000000893', '00000000-0000-4000-9000-000000000891', '00000000-0000-4000-9000-000000000892', 'recibido', 'ruido', 'Mec Uno', '${PERFILES.mecanico}', 'taller');`);
      const m = await paso("abrir mecánico", () => abrirD("mecanico", { producto: "mecanico" }));
      const r1 = await paso("avance sin red", () => m.eval(async () => {
        const [o] = await DB.getAll("ordenes");
        window.__sinRed = true; forcedOffline = true;
        await updateOrder(o.id, (x) => { x.estado = "diagnostico"; });
        return { build: window.ENTIMOTORS_BUILD.producto, cola: (await syncBd.outbox.todos()).map((x) => x.rpc) };
      }));
      assert.equal(r1.build, "mecanico"); assert.deepEqual(r1.cola, ["avanzar_orden_tecnico"]);
      uno(`update public.ordenes set mecanico_id = '${PERFILES.mecanico2}', mecanico = 'Mec Dos' where id = '00000000-0000-4000-9000-000000000893'`);
      const r2 = await paso("volver", () => m.eval(async () => {
        window.__toasts = []; window.__sinRed = false; forcedOffline = false;
        await window.__esperarCola(20000);
        for (let i = 0; i < 30 && !window.__toasts.length; i++) await new Promise((ok) => setTimeout(ok, 100));
        return { toasts: window.__toasts.slice(), rev: await syncMotor.revision() };
      }));
      assert.ok(r2.toasts.some((t) => /ya no está asignada/.test(t)), JSON.stringify(r2.toasts));
      assert.equal(r2.rev.rechazadas.length, 1); assert.equal(r2.rev.rechazadas[0].entidad, "ordenes");
      assert.deepEqual(nube(`select estado, mecanico_id from public.ordenes`), [{ estado: "recibido", mecanico_id: PERFILES.mecanico2 }], "nada del mecánico anterior se aplicó");
    });

    test("ítems de orden A→B y reporte de producción por mecánico reconstruido en OTRO dispositivo; el stock no se descuenta dos veces", async () => {
      pila.limpiar(); sembrarRepuesto(10);
      const A = await paso("abrir A", () => abrirD("admin"));
      const hoy = new Date().toISOString().slice(0, 10);
      const r = await paso("orden en A", () => A.eval(async (a) => {
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === a.uid);
        const cli = await DB.save("clientes", { nombre: "Cliente A→B", telefono: "1" });
        const moto = await DB.save("motos", { clienteId: cli, marca: "Honda", modelo: "CB", placa: "AB-8", km: 1 });
        const oid = await DB.save("ordenes", { clienteId: cli, motoId: moto, estado: "recibido", falla: "ruido", items: [], fotos: [], mecanico: "Mec Uno", mecanicoId: a.mec, origenTrabajo: "taller", creadoEn: Date.now() });
        await window.__esperarCola();
        const ord = await DB.get("ordenes", oid);
        const i1 = await agregarItemOrdenNube(ord, { nombre: rep.nombre, cantidad: 2, precio: 150, inventarioId: rep.id, costoUnitario: 60 });
        const i2 = await agregarItemOrdenNube(ord, { nombre: "Mano de obra", cantidad: 1, precio: 200, inventarioId: null });
        await updateOrder(oid, (x) => { x.items = [i1.item, i2.item]; x.estado = "entregado"; x.tipoCobro = "contado"; x.metodoPago = "efectivo"; });
        await window.__esperarCola();
        const f = await finalizarOrdenNube(await DB.get("ordenes", oid), 500);
        return { estado: f.estado, total: f.total };
      }, { uid: INV, mec: PERFILES.mecanico }));
      assert.deepEqual(r, { estado: "ok", total: 500 });
      const B = await paso("abrir B", () => abrirD("admin"));
      const rb = await paso("B reconstruye", () => B.eval(async (a) => {
        await syncMotor.pullTodo(); await syncMotor.pullTodo();
        const [o] = await DB.getAll("ordenes");
        const rep = (await DB.getAll("inventario")).find((x) => x.uid === a.uid);
        const prod = await calcularProduccion(a.hoy, a.hoy);
        return { items: o.items.map((it) => [it.nombre, it.cantidad, it.precio, it.origenInventarioId === rep.id]), finalizada: o.finalizada, conFecha: !!o.finalizadoEn,
          stockLocal: rep.cantidad, taller: prod.taller, porMec: prod.porMecanico.map((p) => [p.mecanicoId, p.completados, p.producido]) };
      }, { uid: INV, hoy }));
      assert.deepEqual(rb.items.sort(), [["Filtro app 8", 2, 150, true], ["Mano de obra", 1, 200, false]].sort());
      assert.equal(rb.finalizada, true); assert.equal(rb.conFecha, true);
      assert.equal(rb.taller, 500); assert.deepEqual(rb.porMec, [[PERFILES.mecanico, 1, 500]]);
      assert.equal(rb.stockLocal, 8); assert.equal(uno(`select cantidad::int from public.inventario where id = '${INV}'`), "8", "bajar los ítems no descontó otra vez");
      assert.equal(invariantes(), "[]");
    });

    test("dispositivo LIMPIO: bootstrap sin red queda INCOMPLETO a la vista; al volver la red completa y el indicador lo confirma", async () => {
      pila.limpiar();
      uno(`insert into public.clientes (nombre) select 'Boot app ' || g from generate_series(1, 120) g;`);
      const d = await paso("abrir sin red", () => abrirD("admin", { sinRed: true }));
      const r1 = await d.eval(async () => ({ e: await syncMotor.estado(), chip: await window.__chip(), n: (await DB.getAll("clientes")).length }));
      assert.equal(r1.e.bootstrapCompleto, false); assert.match(r1.chip.label, /Descarga inicial incompleta/); assert.equal(r1.n, 0);
      const r2 = await paso("volver", () => d.eval(async () => { window.__sinRed = false; await syncMotor.sincronizar(); return { e: await syncMotor.estado(), chip: await window.__chip(), n: (await DB.getAll("clientes")).length }; }));
      assert.equal(r2.e.bootstrapCompleto, true); assert.equal(r2.n, 120); assert.match(r2.chip.label, /En línea · sincronizado/);
    });

    test("sesión caducada: nada sale, aviso + indicador; con sesión válida y la cuenta DESACTIVADA → fail closed (se cierra la sesión, nada se envía)", async () => {
      pila.limpiar();
      const d = await paso("abrir", () => abrirD("cajero"));
      const r1 = await paso("caducar", () => d.eval(async () => {
        window.__token = null; window.__toasts = [];
        await DB.save("clientes", { nombre: "Tras caducar" });
        await syncMotor.flush();
        for (let i = 0; i < 20 && !window.__toasts.length; i++) await new Promise((ok) => setTimeout(ok, 100));
        return { toasts: window.__toasts.slice(), chip: await window.__chip(), cola: (await syncBd.outbox.todos()).map((o) => [o.estado, o.intentos]) };
      }));
      assert.ok(r1.toasts.some((t) => /sesión caducó/.test(t)), JSON.stringify(r1.toasts));
      assert.match(r1.chip.label, /Sesión caducada/); assert.deepEqual(r1.cola, [["pending", 0]]);
      assert.equal(uno(`select count(*) from public.clientes`), "0");
      uno(`update public.perfiles set activo = false where id = '${PERFILES.cajero}'`);
      try {
        const r2 = await paso("inactiva", () => d.eval(async (t) => {
          window.__token = t; syncMotor.reanudar(); await syncMotor.flush();
          for (let i = 0; i < 30 && !document.getElementById("gateLogin").classList.contains("active"); i++) await new Promise((ok) => setTimeout(ok, 100));
          return { gate: document.getElementById("gateLogin").classList.contains("active"), error: document.getElementById("loginError").textContent };
        }, pila.jwt(PERFILES.cajero)));
        assert.equal(r2.gate, true); assert.match(r2.error, /desactivada/);
        assert.equal(uno(`select count(*) from public.clientes`), "0", "nada se envió con la cuenta desactivada");
      } finally { uno(`update public.perfiles set activo = true where id = '${PERFILES.cajero}'`); }
    });
  });
}
