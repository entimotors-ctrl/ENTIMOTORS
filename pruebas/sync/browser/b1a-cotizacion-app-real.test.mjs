// 3.15.0 · BLOQUE 1A · APP REAL (index.html + app.js de verdad, Chrome y Firefox) contra PostgREST/Postgres reales con la cadena
// 3.14.1 + sync-15a. Cotización ↔ inventario de punta a punta y conversión atómica/idempotente por la UI real (modal de renglón,
// «Guardar cotización», «Aceptó — crear orden»). La verdad se mira en la NUBE (SQL) y en la caché que ve la UI (DB.getAll).
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b1a-cotizacion-app-real.test.mjs
// Modo «antes» (para demostrar que las pruebas fallan con 3.14.1): B1A_BASE=<carpeta con taller-demo/ de e807f65> → sirve esa app y
// la base SIN sync-15a. Tiempos de cada paso en la salida («TIEMPOS …»).
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { iniciarPila, PERFILES, FASES_315 } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

// 3.15 · Bloque 2: desde el Bloque 2 aceptar = APROBAR: la conversión descuenta los repuestos del negocio exactamente una vez (antes,
// en el 1A solo, no movía stock). Las aserciones de stock de este archivo siguen esa regla; en modo ANTES (3.14.1) no se evalúan.
const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const BASE = process.env.B1A_BASE ? path.join(process.env.B1A_BASE, "taller-demo") : null;
const NEU = "00000000-0000-4000-9000-000000001911", BUJ = "00000000-0000-4000-9000-000000001912";
let pila;
before(async () => { pila = await iniciarPila({ fasesExtra: ["sec-1c-clave-intentos"], excluir: BASE ? FASES_315 : [] }); });
after(async () => { await pila?.detener(); });
const uno = (q) => pila.sql(q);
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (${q}) t`));
const huellaStock = () => uno(`select (select count(*) from public.inventario_movimientos)||'|'||(select string_agg(id::text||'='||cantidad, ',' order by id) from public.inventario)`);
function sembrar() {
  pila.limpiar();
  uno(`insert into public.inventario (id, nombre, precio_venta, costo_compra) values ('${NEU}', 'Neumático 4.60-17', 100, 60), ('${BUJ}', 'Bujía NGK', 50, 20);
       insert into public.inventario_movimientos (inventario_id, tipo, cantidad) values ('${NEU}', 'apertura', 5), ('${BUJ}', 'apertura', 1);`);
}

let n = 0;
async function abrir(nav, rol) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b1a-${rol}-${nav}-${++n}`, pagina: "index.html", real: true, raiz: BASE });
  await entrar(d, rol);
  return d;
}
/* Sesión de nube simulada (como sync7b-app-real), toasts capturados y un corte de red controlable: __perder[rpc] = N pierde la
   respuesta de las N próximas llamadas a esa RPC (la petición SÍ llega al servidor). */
function entrar(d, rol) {
  return d.eval(async (a) => {
    window.__toasts = [];
    window.toast = function (m) { window.__toasts.push(String(m)); };
    if (!window.__fetchReal) {
      window.__fetchReal = window.fetch.bind(window); window.__perder = {};
      window.fetch = function (url, init) {
        const u = String(url && url.url ? url.url : url);
        const m = u.match(/\/rpc\/([a-z_0-9]+)/);
        if (m && window.__perder[m[1]] > 0) { window.__perder[m[1]]--; return window.__fetchReal(url, init).then(function () { throw new TypeError("Failed to fetch"); }); }
        return window.__fetchReal(url, init);
      };
    }
    window.SupabaseCliente.sesion = function () { return { access_token: a.token }; };
    window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true, usuario: a.rol + "@example.test" }; };
    window.SupabaseCliente.refrescarSesion = async function () { return { ok: true }; };
    currentUser = { uid: a.id, nombre: a.rol, rol: a.rol, origen: "supabase", activo: true, perfilId: null, user: null };
    await prepararModoNube({ rol: a.rol, origen: "supabase", activo: true, uid: a.id, perfilId: null });
    window.__esperarCola = async function (ms) {
      const hasta = Date.now() + (ms || 15000);
      while (Date.now() < hasta) {
        const p = (await syncBd.outbox.todos()).filter((o) => o.estado === "pending" || o.estado === "syncing");
        if (!p.length) return true;
        await syncMotor.sincronizar(); await new Promise((r) => setTimeout(r, 150));
      }
      return false;
    };
    window.__esperarModal = async (id, activo = true) => { for (let i = 0; i < 150; i++) { if (document.getElementById(id).classList.contains("active") === activo) return true; await new Promise((r) => setTimeout(r, 40)); } return false; };
    return true;
  }, { token: pila.jwt(PERFILES[rol]), id: PERFILES[rol], rol });
}
async function recargar(d, rol) {
  const marca = "m" + Math.random();
  await d.eval((m) => { window.__marca = m; setTimeout(() => location.reload(), 50); return true; }, marca);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await d.eval(() => (document.readyState === "complete" ? window.__marca || "nueva" : "cargando"), null, { plazoMs: 3000 })) === "nueva") break; } catch { /* reintento */ }
  }
  await entrar(d, rol);
}

/* Crea una cotización por la UI REAL: renglones [{inv:true, nombre?, cantidad, precio?}] (inv = elegido del inventario por nombre
   de producto; precio undefined = el que autocompleta la app) o manuales. Devuelve tiempos y el precio autocompletado. */
function crearCotizacionUI(d, { cliente, renglones }) {
  return d.eval(async (a) => {
    const t = {}, T = () => performance.now();
    let t0 = T(); await renderCotizaciones(); t.abrirCotizaciones = T() - t0;
    document.getElementById("btnNuevaCotizacion").click();
    await __esperarModal("modalCotizacion");
    document.getElementById("cotNombre").value = a.cliente;
    const autocompletados = [];
    for (const r of a.renglones) {
      t0 = T();
      document.getElementById("btnAgregarItemCot").click();
      await __esperarModal("modalItemCot");
      for (let i = 0; i < 50 && !document.getElementById("cotItemInvSelect").options.length; i++) await new Promise((x) => setTimeout(x, 20));
      const tipo = document.getElementById("cotItemTipo");
      // 3.14.1 tenía «inventario/manual»; 3.15 (Bloque 2) tiene los tres tipos
      const valor = (v) => ([...tipo.options].some((o) => o.value === v) ? v : v === "repuesto_inventario" ? "inventario" : "manual");
      if (r.inv) {
        tipo.value = valor("repuesto_inventario"); tipo.dispatchEvent(new Event("change"));
        const sel = document.getElementById("cotItemInvSelect");
        const opt = [...sel.options].find((o) => o.textContent.startsWith(r.producto));
        sel.value = opt.value; sel.dispatchEvent(new Event("change"));
        autocompletados.push(Number(document.getElementById("cotItemPrecio").value));
      } else {
        tipo.value = valor(r.tipo || (/mano de obra|revisi/i.test(r.nombre) ? "mano_obra" : "repuesto_manual")); tipo.dispatchEvent(new Event("change"));
        document.getElementById("cotItemNombre").value = r.nombre;
      }
      document.getElementById("cotItemCantidad").value = String(r.cantidad);
      if (r.precio !== undefined) document.getElementById("cotItemPrecio").value = String(r.precio);
      t.seleccionarProducto = (t.seleccionarProducto || 0) + (T() - t0);
      document.getElementById("btnGuardarItemCot").click();
      await __esperarModal("modalItemCot", false);   // 3.15: guardar el renglón es asíncrono (valida/confirma antes de cerrar)
    }
    t0 = T();
    document.getElementById("btnGuardarCotizacion").click();
    await __esperarModal("modalCotDetalle");
    t.guardar = T() - t0;
    t0 = T(); const ok = await __esperarCola(20000); t.sincronizar = T() - t0;
    const cot = (await DB.getAll("cotizaciones")).find((c) => c.clienteNombre === a.cliente);
    return { t, autocompletados, colaVacia: ok, id: cot && cot.id, uid: cot && cot.uid, toasts: window.__toasts.slice(-3) };
  }, { cliente, renglones }, { plazoMs: 60000 });
}
/* «Aceptó — crear orden» por el botón REAL (o por la función, para disparar dos a la vez). */
function aceptarUI(d, cotId, { veces = 1 } = {}) {
  return d.eval(async (a) => {
    window.__toasts = [];
    await abrirCotizacionDetalle(a.cotId);
    const t0 = performance.now();
    const b = document.getElementById("btnCotAceptar");
    for (let i = 0; i < a.veces; i++) b.click();   // doble clic real sobre el botón
    for (let i = 0; i < 400 && (document.getElementById("modalCotDetalle").classList.contains("active") || b.disabled); i++) {
      if (document.getElementById("modalConfirm").classList.contains("active")) document.getElementById("btnConfirmAceptar").click();
      if (!b.disabled && window.__toasts.some((x) => /No se pudo/.test(x))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return { ms: performance.now() - t0, toasts: window.__toasts.slice(), abierta: currentOrderId };
  }, { cotId, veces }, { plazoMs: 60000 });
}
const localCot = (d, uid) => d.eval(async (u) => { const c = (await DB.getAll("cotizaciones")).find((x) => x.uid === u);
  const inv = await DB.getAll("inventario"); const nom = (id) => (inv.find((r) => r.id === id) || {}).nombre || null;
  return c ? { estado: c.estado, ordenId: c.ordenId ?? null, items: (c.items || []).map((it) => ({ nombre: it.nombre, precio: it.precio, inventarioId: it.inventarioId ?? null, producto: nom(it.inventarioId) })) } : null; }, uid);
const ordenesDe = (cotUid) => nube(`select o.id, (select json_agg(json_build_object('nombre', i.nombre, 'inv', i.inventario_id, 'precio', i.precio, 'costo', i.costo_unitario) order by i.creado_en) from public.orden_items i where i.orden_id = o.id) items
  from public.ordenes o where o.id in (select orden_id from public.cotizaciones where id = '${cotUid}') or o.falla like '%' || left('${cotUid}', 8) || '%'`);
const tiempos = {};
const totalOrdenes = () => Number(uno(`select count(*) from public.ordenes`));   // vale igual en 3.14.1 (que no liga cotización→orden en la nube)

for (const nav of NAVS) {
  describe(`3.15 BLOQUE 1A · cotización ↔ inventario + conversión atómica · app real · ${nav}${BASE ? " · MODO ANTES (3.14.1)" : ""}`, () => {
    const abiertos = []; let A, B;
    before(async () => { sembrar(); A = await abrir(nav, "cajero"); abiertos.push(A); B = await abrir(nav, "admin"); abiertos.push(B); });
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); console.log(`TIEMPOS ${nav}${BASE ? " ANTES" : " DESPUÉS"} ${JSON.stringify(tiempos[nav])}`); });
    let cot;

    test("A/B/K · repuesto del inventario conserva inventario_id local→nube→local (A y otro dispositivo B); manual = null; pendiente no toca stock", async () => {
      const stock0 = huellaStock();
      cot = await crearCotizacionUI(A, { cliente: "Cliente B1A " + nav, renglones: [
        { inv: true, producto: "Neumático", cantidad: 2, precio: 90 },       // precio editado en la cotización (el producto vale 100)
        { inv: true, producto: "Bujía", cantidad: 3 },                         // más de lo que hay (1): cotizar no aparta
        { inv: false, nombre: "Mano de obra", cantidad: 1, precio: 250 }] });
      tiempos[nav] = { ...cot.t };
      assert.ok(cot.colaVacia, "la cotización llegó a la nube: " + JSON.stringify(cot.toasts));
      assert.deepEqual(cot.autocompletados, [100, 50], "al elegir el producto se autocompleta su precio actual");
      const items = nube(`select nombre, inventario_id, precio::float precio from public.cotizacion_items where cotizacion_id = '${cot.uid}' order by nombre`);
      assert.deepEqual(items.map((x) => [x.nombre, x.inventario_id, x.precio]),
        [["Bujía NGK", BUJ, 50], ["Mano de obra", null, 250], ["Neumático 4.60-17", NEU, 90]], "A/B · en la NUBE: repuestos con su inventario_id, manual con null");
      await A.eval(async () => { await syncMotor.pullTodo(); return true; });
      const la = await localCot(A, cot.uid);
      assert.deepEqual(la.items.map((x) => [x.nombre, x.producto]), [["Neumático 4.60-17", "Neumático 4.60-17"], ["Bujía NGK", "Bujía NGK"], ["Mano de obra", null]],
        "A · tras sincronizar y bajar, la caché del MISMO dispositivo conserva el repuesto de origen");
      await B.eval(async () => { await syncMotor.pullTodo(); return true; });
      const lb = await localCot(B, cot.uid);
      assert.deepEqual(lb.items.map((x) => [x.nombre, x.producto, x.precio]), [["Neumático 4.60-17", "Neumático 4.60-17", 90], ["Bujía NGK", "Bujía NGK", 50], ["Mano de obra", null, 250]],
        "A · OTRO dispositivo reconstruye el vínculo (id local de SU inventario) y el precio histórico");
      assert.equal(huellaStock(), stock0, "K · guardar una cotización pendiente no mueve stock");
    });

    test("L · cotización RECHAZADA (botón real) no toca stock", async () => {
      const otra = await crearCotizacionUI(A, { cliente: "Rechaza " + nav, renglones: [{ inv: true, producto: "Neumático", cantidad: 1 }] });
      const stock0 = huellaStock();
      await A.eval(async (id) => { await abrirCotizacionDetalle(id); document.getElementById("btnCotRechazar").click(); await __esperarModal("modalConfirm"); document.getElementById("btnConfirmAceptar").click();
        await new Promise((r) => setTimeout(r, 300)); await __esperarCola(); return true; }, otra.id);
      assert.equal(uno(`select estado from public.cotizaciones where id = '${otra.uid}'`), "rechazada");
      assert.equal(huellaStock(), stock0, "L · rechazar no mueve stock");
    });

    test("C/D/H/I · DOBLE CLIC en «Aceptó» → 1 orden; conserva inventario_id y el precio de la cotización; descuenta UNA vez (Bloque 2)", async () => {
      // la cotización pide 3 bujías y hay 1: con el Bloque 2 aceptar = aprobar → primero entra mercadería (sin eso, SIN_EXISTENCIA)
      if (!BASE) uno(`insert into public.inventario_movimientos (inventario_id, tipo, cantidad) values ('${BUJ}', 'apertura', 9)`);
      const stock0 = huellaStock(), o0 = totalOrdenes();
      const r = await aceptarUI(A, cot.id, { veces: 2 });
      tiempos[nav].aceptarConvertir = r.ms;
      assert.equal(totalOrdenes() - o0, 1, "C/D · el doble clic crea exactamente 1 orden en la nube (conteo total): " + JSON.stringify(r.toasts));
      const ords = ordenesDe(cot.uid);
      assert.equal(ords.length, 1, "C/D · exactamente 1 orden: " + JSON.stringify(r.toasts));
      assert.deepEqual(ords[0].items.map((x) => [x.nombre, x.inv, Number(x.precio)]),
        [["Neumático 4.60-17", NEU, 90], ["Bujía NGK", BUJ, 50], ["Mano de obra", null, 250]], "H/I · la orden conserva el producto de origen y el precio histórico");
      assert.equal(uno(`select estado from public.cotizaciones where id = '${cot.uid}'`), "aceptada");
      if (BASE) assert.equal(huellaStock(), stock0, "3.14.1: la conversión no mueve stock");
      else {
        assert.deepEqual(nube(`select nombre, cantidad::int c from public.inventario order by nombre`).map((x) => [x.nombre, x.c]), [["Bujía NGK", 7], ["Neumático 4.60-17", 3]],
          "Bloque 2 · aceptar = aprobar: sale exactamente lo de la cotización (bujía 10→7, neumático 5→3), UNA vez pese al doble clic");
        assert.equal(uno(`select count(*) from public.inventario_movimientos where orden_item_id in (select id from public.orden_items where orden_id = '${ords[0].id}')`), "2",
          "un movimiento por repuesto del negocio (la mano de obra no mueve stock)");
      }
      const lo = await A.eval(async (u) => { const o = (await DB.getAll("ordenes")).find((x) => x.uid === u); const inv = await DB.getAll("inventario");
        return o ? { abierta: currentOrderId === o.id, items: o.items.map((it) => [(inv.find((r) => r.id === it.origenInventarioId) || {}).nombre || null, it.precio]) } : null; }, ords[0].id);
      assert.ok(lo && lo.abierta, "la orden bajó y quedó abierta en pantalla");
      assert.deepEqual(lo.items, [["Neumático 4.60-17", 90], ["Bujía NGK", 50], [null, 250]], "H · la orden LOCAL resuelve el repuesto a su id local");
    });

    test("J · cambiar después el precio/costo del producto no cambia la cotización ni la orden históricas", async () => {
      uno(`update public.inventario set precio_venta = 175, costo_compra = 99 where id = '${NEU}'`);
      await A.eval(async () => { await syncMotor.pullTodo(); return true; });
      assert.deepEqual(nube(`select precio::float p from public.cotizacion_items where cotizacion_id = '${cot.uid}' and inventario_id = '${NEU}'`).map((x) => x.p), [90]);
      assert.deepEqual(nube(`select precio::float p, costo_unitario::float c from public.orden_items where orden_id in (select orden_id from public.cotizaciones where id = '${cot.uid}') and inventario_id = '${NEU}'`), [{ p: 90, c: 60 }]);
      const la = await localCot(A, cot.uid); assert.equal(la.items[0].precio, 90, "la caché también conserva el histórico");
    });

    test("E · respuesta PERDIDA dos veces (resultado desconocido) + el usuario vuelve a pulsar → misma operación, 1 orden, la MISMA", async () => {
      const c2 = await crearCotizacionUI(A, { cliente: "Corte " + nav, renglones: [{ inv: true, producto: "Neumático", cantidad: 1 }, { inv: false, nombre: "Revisión", cantidad: 1, precio: 100 }] });
      const o0 = totalOrdenes();
      await A.eval(() => { window.__perder.convertir_cotizacion = 2; window.__perder.agregar_item_orden = 1; return true; });   // se pierde la respuesta (la petición llega)
      const r1 = await aceptarUI(A, c2.id);
      assert.ok(r1.toasts.some((x) => /No se pudo confirmar/.test(x)), "se avisa que el resultado es desconocido: " + JSON.stringify(r1.toasts));
      const o1 = ordenesDe(c2.uid); assert.equal(o1.length, 1, "el servidor SÍ la creó (una)");
      const r2 = await aceptarUI(A, c2.id);                                              // sin recargar: repite el MISMO operation_id guardado
      assert.equal(totalOrdenes() - o0, 1, "E · en total, 1 sola orden nueva (conteo total): " + JSON.stringify([r1.toasts, r2.toasts]));
      const o2 = ordenesDe(c2.uid);
      assert.equal(o2.length, 1, "E · el reintento NO crea otra: " + JSON.stringify(r2.toasts));
      assert.equal(o2[0].id, o1[0].id, "es la MISMA orden");
      assert.ok(r2.toasts.some((x) => /creada desde la cotización/.test(x)), "el reintento recibe el resultado guardado: " + JSON.stringify(r2.toasts));
      assert.equal(uno(`select count(*) from public.sync_ops where kind = 'convertir_cotizacion' and resultado->>'orden_id' = '${o1[0].id}'`), "1");
      assert.equal(await A.eval(async (u) => (await syncBd.meta.get("aceptar_cot:" + u)) ?? null, c2.uid), null, "el intento guardado se limpia al confirmar");
    });

    test("G · respuesta perdida + la app se CIERRA/RECARGA antes de reintentar → al volver, 1 orden y se abre la existente", async () => {
      const c4 = await crearCotizacionUI(A, { cliente: "Cierre " + nav, renglones: [{ inv: true, producto: "Neumático", cantidad: 1 }] });
      await A.eval(() => { window.__perder.convertir_cotizacion = 2; return true; });
      const r1 = await aceptarUI(A, c4.id);
      assert.ok(r1.toasts.some((x) => /No se pudo confirmar/.test(x)));
      const o1 = ordenesDe(c4.uid); assert.equal(o1.length, 1);
      assert.ok(await A.eval(async (u) => !!(await syncBd.meta.get("aceptar_cot:" + u)), c4.uid), "el intento (op + orden) quedó guardado en el dispositivo");
      await recargar(A, "cajero");
      const r2 = await aceptarUI(A, c4.id);
      assert.equal(ordenesDe(c4.uid).length, 1, "G · tras recargar no hay segunda orden: " + JSON.stringify(r2.toasts));
      assert.ok(r2.toasts.some((x) => /ya es la orden/.test(x)), "se reconoce la orden existente: " + JSON.stringify(r2.toasts));
      const abierta = await A.eval(async (u) => { const o = (await DB.getAll("ordenes")).find((x) => x.uid === u); return !!o && currentOrderId === o.id && !document.getElementById("modalCotDetalle").classList.contains("active"); }, o1[0].id);
      assert.ok(abierta, "se cierra el detalle y se abre la orden existente");
      assert.equal(await A.eval(async (u) => (await syncBd.meta.get("aceptar_cot:" + u)) ?? null, c4.uid), null, "y se olvida el intento guardado");
    });

    test("F · DOS DISPOSITIVOS aceptan la misma cotización a la vez → 1 orden; el otro recibe «ya se había convertido»", async () => {
      const c3 = await crearCotizacionUI(A, { cliente: "Carrera " + nav, renglones: [{ inv: true, producto: "Bujía", cantidad: 1 }] });
      assert.ok(c3.colaVacia && c3.uid, "c3 subida: " + JSON.stringify(c3));
      const pullB = await B.eval(async () => JSON.stringify(await syncMotor.pullTodo()));
      const idB = await B.eval(async (u) => { const c = (await DB.getAll("cotizaciones")).find((x) => x.uid === u); return c ? c.id : null; }, c3.uid);
      assert.ok(idB, "B bajó la cotización: " + pullB + " · nube: " + uno(`select count(*)||'/'||coalesce(max(estado),'-') from public.cotizaciones where id = '${c3.uid}'`));
      const o0 = totalOrdenes();
      const [ra, rb] = await Promise.all([aceptarUI(A, c3.id), aceptarUI(B, idB)]);
      assert.equal(totalOrdenes() - o0, 1, "F · dos dispositivos: 1 sola orden nueva en la nube (conteo total): " + JSON.stringify([ra.toasts, rb.toasts]));
      assert.equal(ordenesDe(c3.uid).length, 1, "F · una sola orden: " + JSON.stringify([ra.toasts, rb.toasts]));
      const avisos = [...ra.toasts, ...rb.toasts];
      assert.ok(avisos.some((x) => /creada desde la cotización/.test(x)) && avisos.some((x) => /ya se había convertido/.test(x)), "uno la crea y el otro lo sabe: " + JSON.stringify(avisos));
      assert.equal(uno(`select public.verificar_invariantes()::text`), "[]");
    });

    test("compatibilidad · cotización antigua solo con renglones MANUALES (como la de producción) → orden con renglones manuales, sin stock", async () => {
      const cm = await crearCotizacionUI(A, { cliente: "Manual " + nav, renglones: [{ inv: false, nombre: "aceite bajaj", cantidad: 1, precio: 250 }, { inv: false, nombre: "bujía de motor", cantidad: 1, precio: 120 }] });
      const stock0 = huellaStock(), o0 = totalOrdenes();
      await aceptarUI(A, cm.id);
      assert.equal(totalOrdenes() - o0, 1, "1 orden nueva");
      const o = ordenesDe(cm.uid);
      assert.equal(o.length, 1); assert.deepEqual(o[0].items.map((x) => [x.nombre, x.inv]), [["aceite bajaj", null], ["bujía de motor", null]], "no se infiere el producto por el nombre");
      assert.equal(huellaStock(), stock0);
    });
  });
}
