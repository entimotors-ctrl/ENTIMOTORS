// 3.15.0 · BLOQUE 3 · APP REAL · almacenamiento local y trabajo sin conexión (Postgres + PostgREST reales; sin Realtime a propósito:
// el trabajo offline no depende de él).
//   A · la base local de sincronización NO abre (dañada) → pantalla de bloqueo, NADA se guarda «en modo local»; reintentar sin el
//       fallo → recupera la cola intacta y sincroniza. También: el navegador cierra la base a mitad de sesión → bloqueo inmediato.
//   B · sin Internet la app sigue funcionando (sin pantalla de bloqueo)  C · cerrar/reabrir sin red conserva la cola
//   D · al volver la red, todo llega EXACTAMENTE una vez: clientes, motos, citas, cotizaciones, órdenes, avance del mecánico,
//       movimiento de caja y mensaje (con una respuesta perdida en medio).
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b3-almacen-offline-app-real.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });
const uno = (q) => pila.sql(q);
const cuenta = (q) => Number(uno(`select count(*) from (${q}) t`));

let n = 0;
// 3.15 (Bloque 6): APP_RAIZ / APP_RAIZ_MT = correr lo MISMO contra el ARTEFACTO PUBLICABLE (build del Taller / de Mi Trabajo) en vez del
// código fuente — así se demuestra que retirar la experiencia demo no rompió el trabajo sin internet. Sin ellas, idéntico a antes.
const nuevo = (nav, producto = null) => abrirDispositivo({ navegador: nav, nombre: `b3a-${nav}-${++n}`, pagina: "index.html", real: true, producto,
  raiz: (producto === "mecanico" ? process.env.APP_RAIZ_MT : null) || process.env.APP_RAIZ || null });
/* Prepara la página (sin iniciar la sesión): toasts capturados, corte de red por fetch y, si se pide, IndexedDB «dañado» para
   las bases de sincronización (entimotors_sync*): el navegador responde UnknownError como con un almacenamiento corrupto. */
const preparar = (d, a) => d.eval((a) => {
  window.__toasts = []; window.toast = function (m) { window.__toasts.push(String(m)); };
  if (!window.__fetchReal) {
    window.__fetchReal = window.fetch.bind(window);
    window.fetch = function (url, init) {
      const u = String(url && url.url ? url.url : url);
      const nube = u.indexOf(window.ENTIMOTORS_SUPABASE.url) === 0;
      if (nube && window.__sinRed) return Promise.reject(new TypeError("Failed to fetch"));
      if (nube && window.__perderRespuestaDe && u.indexOf("/rpc/" + window.__perderRespuestaDe) > 0) {
        window.__perderRespuestaDe = null; window.__respuestasPerdidas = (window.__respuestasPerdidas || 0) + 1;
        return window.__fetchReal(url, init).then(function () { throw new TypeError("Failed to fetch"); });
      }
      return window.__fetchReal(url, init);
    };
  }
  window.__sinRed = !!a.sinRed; window.__token = a.token;
  window.__idbOpen = window.__idbOpen || indexedDB.open.bind(indexedDB);
  indexedDB.open = a.danada ? function (nombre, v) {
    if (/^entimotors_sync/.test(nombre)) { const req = {}; setTimeout(function () { req.error = new DOMException("almacenamiento dañado (simulado)", "UnknownError"); if (req.onerror) req.onerror({}); }, 5); return req; }
    return window.__idbOpen(nombre, v);
  } : window.__idbOpen;
  window.SupabaseCliente.sesion = function () { return window.__token ? { access_token: window.__token } : null; };
  window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true, usuario: "x@example.test" }; };
  window.SupabaseCliente.refrescarSesion = async function () { return window.__token ? { ok: true } : { ok: false, motivo: "sin-sesion", clase: "rechazada" }; };   // como el cliente real (3.15 · 8A)
  window.__esperarCola = async function (ms) {
    const hasta = Date.now() + (ms || 20000);
    while (Date.now() < hasta) {
      const p = (await syncBd.outbox.todos()).filter((x) => x.estado === "pending" || x.estado === "syncing");
      if (!p.length) return true;
      for (const x of p) if (x.siguiente_en > Date.now()) await syncBd.outbox.actualizar(x.seq, { siguiente_en: 0 });
      await syncMotor.sincronizar(); await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  };
  return true;
}, a);
/* El arranque REAL (startApp): portero, base de siempre, prepararModoNube y primera lectura. */
const arrancar = (d, rol) => d.eval(async (a) => {
  const mec = a.rol === "mecanico";
  await startApp({ uid: a.id, nombre: a.rol, rol: a.rol, origen: "supabase", activo: true, perfilId: mec ? a.id : null, user: null });
  return { almacen: document.getElementById("gateAlmacen").classList.contains("active"), shell: document.getElementById("shell").classList.contains("active"),
    modo: document.getElementById("gateModo").classList.contains("active"), motor: typeof syncMotor !== "undefined" && !!syncMotor };
}, { rol, id: PERFILES[rol] }, { plazoMs: 60000 });
async function recargar(d) {
  await d.eval(() => { setTimeout(() => location.reload(), 30); return true; });
  await new Promise((r) => setTimeout(r, 400));
  for (let i = 0; i < 80; i++) { try { if ((await d.eval(() => document.readyState, null, { plazoMs: 3000 })) === "complete") break; } catch { /* navegando */ } await new Promise((r) => setTimeout(r, 250)); }
}
const leerBaseCruda = (d, nombre, store) => d.eval((a) => new Promise((ok) => {
  const req = window.__idbOpen(a.nombre); req.onerror = () => ok({ error: String(req.error) });
  req.onsuccess = () => { const db = req.result; if (!db.objectStoreNames.contains(a.store)) { db.close(); return ok({ filas: [] }); }
    const g = db.transaction([a.store], "readonly").objectStore(a.store).getAll(); g.onsuccess = () => { db.close(); ok({ filas: g.result }); }; g.onerror = () => { db.close(); ok({ error: "lectura" }); }; };
}), { nombre, store });

for (const nav of NAVS) {
  describe(`3.15 · Bloque 3 · almacenamiento y offline · app real · ${nav}`, () => {
    test("A · base de sync DAÑADA: bloqueo explícito, nada «en modo local», la cola NO se borra; al quitar el fallo se recupera y sincroniza una vez", async () => {
      pila.limpiar();
      const d = await nuevo(nav);
      try {
        await preparar(d, { token: pila.jwt(PERFILES.admin) });
        let r = await arrancar(d, "admin"); assert.equal(r.almacen, false); assert.equal(r.motor, true);
        // trabajo SIN red que queda en la cola…
        await d.eval(async () => { window.__sinRed = true; await DB.save("clientes", { nombre: "Pendiente antes del fallo", telefono: "1" }); return true; });
        assert.equal(await d.eval(async () => (await syncBd.outbox.todos()).length), 1);
        // …y el almacenamiento se daña (crash/reapertura con la base ilegible)
        await recargar(d);
        await preparar(d, { token: pila.jwt(PERFILES.admin), danada: true });
        const t0 = Date.now();
        r = await arrancar(d, "admin");
        assert.equal(r.almacen, true, "pantalla de almacenamiento a la vista"); assert.equal(r.shell, false, "el sistema no queda usable"); assert.equal(r.modo, false);
        assert.ok(Date.now() - t0 >= 3000, "reintentó antes de rendirse (ocupada/pasajero)");
        const vista = await d.eval(() => ({ texto: document.getElementById("gateAlmacen").textContent, motor: !!syncMotor, sync: window.ENTIMOTORS_SYNC }));
        assert.match(vista.texto, /No es un problema de Internet/); assert.match(vista.texto, /No se borró nada/); assert.match(vista.texto, /Reintentar/);
        assert.equal(vista.motor, false); assert.equal(vista.sync.enabled, false);
        const intento = await d.eval(async () => { try { await DB.save("clientes", { nombre: "NO debe guardarse" }); return "guardó"; } catch (e) { return String(e.message); } });
        assert.match(intento, /ALMACEN_NO_DISPONIBLE/, "no guarda en silencio");
        const lectura = await d.eval(async () => { try { await DB.getAll("clientes"); return "leyó"; } catch (e) { return String(e.message); } });
        assert.match(lectura, /ALMACEN_NO_DISPONIBLE/, "tampoco lee la base de siempre haciéndola pasar por la nube");
        const demo = await leerBaseCruda(d, "entimotors_os_demo", "clientes");
        assert.ok(!(demo.filas || []).some((c) => c.nombre === "NO debe guardarse"), "nada escrito en entimotors_os_demo");
        const cola = await leerBaseCruda(d, "entimotors_sync", "outbox");
        assert.equal((cola.filas || []).length, 1, "la cola pendiente sigue intacta (no se borró ni se recreó la base)");
        // Reintentar con el fallo todavía presente: sigue bloqueado y lo dice
        await d.eval(async () => { document.getElementById("btnAlmacenReintentar").click(); await new Promise((r) => setTimeout(r, 2500)); return true; });
        assert.equal(await d.eval(() => document.getElementById("gateAlmacen").classList.contains("active")), true);
        assert.ok((await d.eval(() => window.__toasts)).some((t) => /sigue sin estar disponible/.test(t)));
        // se arregla el almacenamiento → «Reintentar» reabre la app (recarga) y todo sigue ahí
        await d.eval(() => { indexedDB.open = window.__idbOpen; setTimeout(() => document.getElementById("btnAlmacenReintentar").click(), 20); return true; });
        await new Promise((r) => setTimeout(r, 2500));
        for (let i = 0; i < 40; i++) { try { if ((await d.eval(() => document.readyState, null, { plazoMs: 3000 })) === "complete") break; } catch { /* recargando */ } await new Promise((r) => setTimeout(r, 250)); }
        await preparar(d, { token: pila.jwt(PERFILES.admin) });
        r = await arrancar(d, "admin"); assert.equal(r.almacen, false); assert.equal(r.motor, true);
        assert.equal(await d.eval(() => window.__esperarCola(20000)), true);
        assert.equal(cuenta(`select 1 from public.clientes where nombre = 'Pendiente antes del fallo'`), 1, "llegó a la nube una sola vez");
        assert.equal(cuenta(`select 1 from public.clientes where nombre = 'NO debe guardarse'`), 0);
      } finally { await d.cerrar(); }
    });

    test("A · el navegador CIERRA la base a mitad de sesión → bloqueo inmediato, sin escrituras a medias", async () => {
      const d = await nuevo(nav);
      try {
        await preparar(d, { token: pila.jwt(PERFILES.admin) });
        await arrancar(d, "admin");
        const r = await d.eval(async () => {
          syncBd.idb.onclose();   // lo que dispara el navegador si borra los datos del sitio o el disco falla
          let intento; try { await DB.save("clientes", { nombre: "a medias" }); intento = "guardó"; } catch (e) { intento = String(e.message); }
          return { gate: document.getElementById("gateAlmacen").classList.contains("active"), texto: document.getElementById("gateAlmacenTexto").textContent, intento, rt: typeof syncRt === "undefined" ? null : syncRt };
        });
        assert.equal(r.gate, true); assert.match(r.texto, /cerró el almacenamiento/); assert.match(r.intento, /ALMACEN_NO_DISPONIBLE/); assert.equal(r.rt, null);
      } finally { await d.cerrar(); }
    });

    test("B/C/D · SIN RED: clientes, motos, citas, cotización, orden, caja, mensaje y avance del mecánico → cerrar/reabrir sin red → al volver la red, cada cosa UNA vez", async () => {
      pila.limpiar();
      const adm = await nuevo(nav), mec = await nuevo(nav, "mecanico");
      try {
        // orden ya asignada al mecánico (para su avance sin red)
        uno(`insert into public.ordenes (id, estado, falla, mecanico, mecanico_id) values ('00000000-0000-4000-9000-00000000c001', 'recibido', 'Orden para avanzar ${nav}', 'Mec Uno', '${PERFILES.mecanico}')`);
        await preparar(adm, { token: pila.jwt(PERFILES.admin) }); await arrancar(adm, "admin");
        await preparar(mec, { token: pila.jwt(PERFILES.mecanico) }); await arrancar(mec, "mecanico");
        assert.equal(await mec.eval(async () => (await DB.getAll("ordenes")).length), 1);
        // — todo sin red —
        const r = await adm.eval(async (a) => {
          window.__sinRed = true;
          const cid = await DB.save("clientes", { nombre: "Cliente offline " + a.nav, telefono: "9000" });
          const mid = await DB.save("motos", { clienteId: cid, marca: "Yamaha", modelo: "FZ", placa: "OFF-" + a.nav, km: 1000 });
          await DB.save("citas", { clienteId: cid, nombreTmp: "", telefonoTmp: "", fecha: FechaNegocio.sumarDias(FechaNegocio.hoy(), 1), hora: "09:00", motivo: "Cita offline " + a.nav, mecanico: "Mec Uno", mecanicoId: a.mec, origen: "interna", estado: undefined, recordatorioEnviado: false, creadoEn: Date.now() });
          await DB.save("cotizaciones", { clienteId: cid, clienteNombre: "Cliente offline " + a.nav, clienteTelefono: "9000", motoDesc: "Yamaha FZ", items: [{ nombre: "Mano de obra", cantidad: 1, precio: 200, tipo: "mano_obra" }],
            validezDias: 15, fechaISO: new Date().toISOString(), venceISO: new Date(Date.now() + 15 * 86400000).toISOString(), estado: "pendiente" });
          await DB.save("ordenes", { clienteId: cid, motoId: mid, estado: "recibido", falla: "Orden offline " + a.nav, items: [], fotos: [], aprobacion: null, diagnostico: null, reparacionNotas: "", calidadChecklist: null, mecanico: "Mec Uno", mecanicoId: a.mec, origenTrabajo: "taller", creadoEn: Date.now() });
          const caja = await registrarMovimientoCajaNube({ tipo: "egreso", categoria: "Otros", monto: 55, metodoPago: "efectivo", descripcion: "Caja offline " + a.nav });
          return { caja: caja.estado, cola: (await syncBd.outbox.todos()).length, gate: document.getElementById("gateAlmacen").classList.contains("active") };
        }, { nav, mec: PERFILES.mecanico });
        assert.equal(r.gate, false, "B: sin red NO es fallo de almacenamiento"); assert.equal(r.caja, "pendiente"); assert.ok(r.cola >= 6, `cola: ${r.cola}`);
        // mensaje sin red (la lista de mecánicos se guardó la última vez que hubo red)
        await adm.eval(async () => { window.__sinRed = false; await mecanicosParaMensajes(); window.__sinRed = true; return true; });
        await adm.eval(async (a) => { showView("mensajes"); await renderMensajes(); document.getElementById("msgDestinatario").value = a.mec; document.getElementById("msgOrden").value = ""; document.getElementById("msgTexto").value = "Mensaje offline " + a.nav; document.getElementById("btnMsgEnviar").click(); await new Promise((r) => setTimeout(r, 600)); return true; }, { nav, mec: PERFILES.mecanico });
        // mecánico sin red: avance técnico
        await mec.eval(async () => { window.__sinRed = true; const o = (await DB.getAll("ordenes"))[0]; await DB.save("ordenes", { ...o, estado: "diagnostico", diagnostico: { nota: "offline" } }); return true; });
        const colaAdm = await adm.eval(async () => (await syncBd.outbox.todos()).length), colaMec = await mec.eval(async () => (await syncBd.outbox.todos()).length);
        // C · cerrar y reabrir SIN red
        await recargar(adm); await preparar(adm, { token: pila.jwt(PERFILES.admin), sinRed: true }); await arrancar(adm, "admin");
        await recargar(mec); await preparar(mec, { token: pila.jwt(PERFILES.mecanico), sinRed: true }); await arrancar(mec, "mecanico");
        assert.equal(await adm.eval(async () => (await syncBd.outbox.todos()).length), colaAdm, "C: la cola del admin sobrevive a reabrir sin red");
        assert.equal(await mec.eval(async () => (await syncBd.outbox.todos()).length), colaMec, "C: la del mecánico también");
        assert.equal(await mec.eval(async () => (await DB.getAll("ordenes"))[0].estado), "diagnostico", "el avance se ve sin red");
        assert.equal(cuenta(`select 1 from public.clientes where nombre = 'Cliente offline ${nav}'`), 0, "nada llegó todavía");
        // D · vuelve la red (con UNA respuesta perdida de la RPC de caja en medio)
        assert.equal(await adm.eval(() => { window.__sinRed = false; window.__perderRespuestaDe = "registrar_movimiento_caja"; return window.__esperarCola(30000); }), true);
        assert.equal(await adm.eval(() => window.__respuestasPerdidas), 1, "la respuesta de la caja SE PERDIÓ de verdad (el servidor la aplicó y el cliente no lo supo)");
        assert.equal(await mec.eval(() => { window.__sinRed = false; return window.__esperarCola(30000); }), true);
        assert.equal(cuenta(`select 1 from public.clientes where nombre = 'Cliente offline ${nav}'`), 1);
        assert.equal(cuenta(`select 1 from public.motos where placa = 'OFF-${nav}'`), 1);
        assert.equal(cuenta(`select 1 from public.citas where motivo = 'Cita offline ${nav}'`), 1);
        assert.equal(cuenta(`select 1 from public.cotizaciones c join public.cotizacion_items i on i.cotizacion_id = c.id where c.cliente_nombre = 'Cliente offline ${nav}'`), 1);
        assert.equal(cuenta(`select 1 from public.ordenes where falla = 'Orden offline ${nav}'`), 1);
        assert.equal(cuenta(`select 1 from public.caja_movimientos where descripcion = 'Caja offline ${nav}'`), 1, "caja: una vez aunque se perdió una respuesta");
        assert.equal(cuenta(`select 1 from public.mensajes where texto = 'Mensaje offline ${nav}'`), 1);
        assert.equal(uno(`select estado from public.ordenes where id = '00000000-0000-4000-9000-00000000c001'`), "diagnostico", "avance del mecánico aplicado");
        assert.equal(uno(`select public.verificar_invariantes()::text`), "[]");
        // cruzado: ni el mecánico tiene nada del admin ajeno a él, ni al revés
        assert.equal(await mec.eval(async () => (await DB.getAll("clientes")).length), 0, "el mecánico no guarda clientes en su caché");
      } finally { await adm.cerrar(); await mec.cerrar(); }
    });
  });
}
