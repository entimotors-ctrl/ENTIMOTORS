// 3.15.0 · BLOQUE 2 · APP REAL (index.html + app.js de verdad, Chrome y Firefox) contra PostgREST/Postgres reales con la cadena
// 3.14.1 + sync-15a + sync-15b. Presupuestos + inventario + stock por la UI REAL: modal de renglón (tipo, buscar producto, precio
// automático/editable, subtotal en vivo), secciones por tipo, «Aprobar en el local» / «No aprobó» / «Reabrir», editar ✎ y quitar 🗑,
// sin red, respuesta perdida, recarga y dos dispositivos. La verdad se mira en la NUBE (SQL: inventario, ledger, auditoría) y en la
// caché que ve la UI. Letras = pruebas A–AD del encargo.
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b2-presupuestos-app-real.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const u = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const ACE = u(3401), FIL = u(3402), CAD = u(3403);   // Aceite 20W-50 (L150, costo 90) · Filtro de aire (L80, 2 u.) · Cadena (L500)
let pila;
before(async () => { pila = await iniciarPila({ fasesExtra: ["sec-1c-clave-intentos"] }); });
after(async () => { await pila?.detener(); });
const uno = (q) => pila.sql(q);
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (${q}) t`));
const stock = (id) => Number(uno(`select cantidad from public.inventario where id = '${id}'`));
const movs = () => Number(uno(`select count(*) from public.inventario_movimientos`));
const invariantes = () => uno(`select public.verificar_invariantes()::text`);
function sembrar() {
  pila.limpiar();
  uno(`insert into public.inventario (id, nombre, precio_venta, costo_compra) values ('${ACE}', 'Aceite 20W-50', 150, 90), ('${FIL}', 'Filtro de aire', 80, 40), ('${CAD}', 'Cadena 428', 500, 300);
       insert into public.inventario_movimientos (inventario_id, tipo, cantidad) values ('${ACE}', 'apertura', 10), ('${FIL}', 'apertura', 2), ('${CAD}', 'apertura', 5);`);
}
/* Orden en «presupuesto» con su cliente y su moto (como las deja el taller). */
function nuevaOrden(n, extraSql = "") {
  uno(`insert into public.clientes (id, nombre, telefono) values ('${u(3200 + n)}', 'Cliente B2 ${n}', '9999000${n}');
       insert into public.motos (id, cliente_id, marca, modelo, placa) values ('${u(3300 + n)}', '${u(3200 + n)}', 'Honda', 'XR150', 'B2-${n}');
       insert into public.ordenes (id, cliente_id, moto_id, estado, falla) values ('${u(3100 + n)}', '${u(3200 + n)}', '${u(3300 + n)}', 'presupuesto', 'prueba B2 ${n}');
       ${extraSql}`);
  return u(3100 + n);
}

let nd = 0;
async function abrir(nav, rol) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b2-${rol}-${nav}-${++nd}`, pagina: "index.html", real: true });
  await entrar(d, rol);
  return d;
}
/* Sesión de nube simulada (como b1a/sync7b), toasts capturados, red controlable: __sinRed corta TODO lo de la nube;
   __perder[rpc] = N pierde la respuesta de las N próximas llamadas a esa RPC (la petición SÍ llega al servidor). */
function entrar(d, rol) {
  return d.eval(async (a) => {
    window.__toasts = [];
    window.toast = function (m) { window.__toasts.push(String(m)); };
    if (!window.__fetchReal) {
      window.__fetchReal = window.fetch.bind(window); window.__perder = {}; window.__sinRed = false;
      window.fetch = function (url, init) {
        const s = String(url && url.url ? url.url : url);
        if (window.__sinRed && s.indexOf(window.ENTIMOTORS_SUPABASE.url) === 0) return Promise.reject(new TypeError("Failed to fetch"));
        const m = s.match(/\/rpc\/([a-z_0-9]+)/);
        if (m && window.__perder[m[1]] > 0) { window.__perder[m[1]]--; return window.__fetchReal(url, init).then(function () { throw new TypeError("Failed to fetch"); }); }
        return window.__fetchReal(url, init);
      };
    }
    window.SupabaseCliente.sesion = function () { return { access_token: a.token }; };
    window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true, usuario: a.rol + "@example.test" }; };
    window.SupabaseCliente.refrescarSesion = async function () { return { ok: true }; };
    currentUser = { uid: a.id, nombre: a.rol, rol: a.rol, origen: "supabase", activo: true, perfilId: null, user: null };
    await prepararModoNube({ rol: a.rol, origen: "supabase", activo: true, uid: a.id, perfilId: null });
    const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__esperar = async (f, ms = 15000) => { const h = Date.now() + ms; while (Date.now() < h) { if (await f()) return true; await dormir(30); } return false; };
    window.__modal = (id, activo = true) => __esperar(() => document.getElementById(id).classList.contains("active") === activo, 6000);
    window.__esperarCola = async function (ms) {
      const hasta = Date.now() + (ms || 20000);
      while (Date.now() < hasta) {
        const p = (await syncBd.outbox.todos()).filter((o) => o.estado === "pending" || o.estado === "syncing");
        if (!p.length) return true;
        await syncMotor.sincronizar(); await dormir(150);
      }
      return false;
    };
    window.__abrirOrden = async (uid) => {
      await syncMotor.pullTodo();
      const o = (await DB.getAll("ordenes")).find((x) => x.uid === uid);
      if (!o) return null;
      await openOrder(o.id);
      await __esperar(() => document.getElementById("presupuestoCard"));
      return o.id;
    };
    /* Llena el modal REAL de renglón: {tipo, producto?, nombre?, cantidad?, precio?} → devuelve lo que la persona ve. */
    window.__llenarRenglon = async (r) => {
      const $ = (s) => document.getElementById("item" + s);
      const tipo = $("Tipo"); tipo.value = r.tipo; tipo.dispatchEvent(new Event("change"));
      let auto = null;
      if (r.producto) {
        const b = $("Buscar"); b.value = r.producto; b.dispatchEvent(new Event("input"));
        const sel = $("InvSelect");
        const opt = [...sel.options].find((o) => o.textContent.startsWith(r.producto));
        if (sel.value !== opt.value) { sel.value = opt.value; sel.dispatchEvent(new Event("change")); }
        auto = $("Precio").value;
      }
      if (r.nombre !== undefined) $("Nombre").value = r.nombre;
      if (r.cantidad !== undefined) { $("Cantidad").value = String(r.cantidad); $("Cantidad").dispatchEvent(new Event("input")); }
      if (r.precio !== undefined) { $("Precio").value = String(r.precio); $("Precio").dispatchEvent(new Event("input")); }
      return { auto, subtotal: $("Subtotal").textContent, nota: $("PrecioNota").textContent, info: $("InvInfo").textContent };
    };
    window.__guardarRenglon = async () => {
      window.__toasts = [];
      document.getElementById("btnGuardarItem").click();
      const h = Date.now() + 15000;
      while (Date.now() < h) {
        if (!document.getElementById("modalItem").classList.contains("active")) break;
        if (document.getElementById("modalConfirm").classList.contains("active")) return { confirmar: true, toasts: window.__toasts.slice() };
        if (window.__toasts.length && !document.getElementById("btnGuardarItem").disabled) break;
        await dormir(40);
      }
      await dormir(150);
      return { cerrado: !document.getElementById("modalItem").classList.contains("active"), toasts: window.__toasts.slice() };
    };
    window.__agregar = async (r) => {
      document.getElementById("btnAgregarItem").click();
      await __modal("modalItem");
      const vista = await __llenarRenglon(r);
      return { ...vista, ...(await __guardarRenglon()) };
    };
    const fila = (nombre) => [...document.querySelectorAll("#itemsBody tr")].find((tr) => tr.querySelector("td") && tr.querySelector("td").textContent.startsWith(nombre));
    window.__editar = async (nombre, r) => {
      fila(nombre).querySelector("[data-editar]").click();
      await __modal("modalItem");
      const vista = await __llenarRenglon(r);
      return { ...vista, ...(await __guardarRenglon()) };
    };
    window.__quitar = async (nombre) => {
      window.__toasts = [];
      fila(nombre).querySelector("[data-quitar]").click();
      await __esperar(() => window.__toasts.length);
      await dormir(200);
      return window.__toasts.slice();
    };
    /* Decisión por el botón REAL (veces = clics seguidos). */
    window.__decidir = async (boton, veces = 1) => {
      window.__toasts = [];
      const b = document.getElementById(boton);
      if (!b) return { sinBoton: true };
      for (let i = 0; i < veces; i++) b.click();
      if (boton === "btnRechazarPresupuesto" && await __modal("modalConfirm")) document.getElementById("btnConfirmAceptar").click();
      await __esperar(() => window.__toasts.length, 20000);
      await dormir(300);
      return { toasts: window.__toasts.slice() };
    };
    window.__vista = () => ({
      estado: document.getElementById("presupuestoEstadoPill")?.dataset.estado || null,
      pendienteConfirmacion: !!document.getElementById("presupuestoPendienteConfirmacion"),
      conflicto: document.getElementById("presupuestoConflicto")?.textContent.replace(/\s+/g, " ").trim() || null,
      error: document.getElementById("presupuestoError")?.textContent || null,
      secciones: [...document.querySelectorAll("#itemsBody tr.renglon-seccion")].map((tr) => tr.dataset.seccion),
      filas: [...document.querySelectorAll("#itemsBody tr:not(.renglon-seccion)")].map((tr) => tr.textContent.replace(/\s+/g, " ").trim()),
      botones: ["btnAprobarLocal", "btnRechazarPresupuesto", "btnReabrirPresupuesto"].filter((id) => document.getElementById(id)),
    });
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
const renglones = (orden) => nube(`select nombre, tipo, cantidad::float cantidad, precio::float precio, costo_unitario::float costo, cantidad_aplicada::float aplicada, inventario_id
  from public.orden_items where orden_id = '${orden}' order by creado_en, id`);
const ledgerDe = (orden) => nube(`select m.inventario_id, m.cantidad::float cantidad, m.op_id, m.orden_item_id from public.inventario_movimientos m
  where m.orden_item_id in (select id from public.orden_items where orden_id = '${orden}') or m.orden_id = '${orden}' order by m.creado_en, m.id`);

for (const nav of NAVS) {
  describe(`3.15 BLOQUE 2 · presupuestos + inventario + stock · app real · ${nav}`, () => {
    const abiertos = []; let A, B;
    before(async () => { sembrar(); A = await abrir(nav, "cajero"); abiertos.push(A); B = await abrir(nav, "admin"); abiertos.push(B); });
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });
    let O1;

    test("A/B/C/E/F/G/I · precio automático, editable por operación, subtotal en vivo, vacío inválido; maestro intacto; pendiente no toca stock", async () => {
      O1 = nuevaOrden(1);
      const m0 = movs();
      assert.ok(await A.eval((x) => __abrirOrden(x), O1), "la orden se abre en «presupuesto»");
      const r1 = await A.eval(() => (async () => {
        document.getElementById("btnAgregarItem").click(); await __modal("modalItem");
        const a = await __llenarRenglon({ tipo: "repuesto_inventario", producto: "Aceite 20W-50" });
        const e = await __llenarRenglon({ tipo: "repuesto_inventario", cantidad: 2 });
        const b = await __llenarRenglon({ tipo: "repuesto_inventario", precio: 140 });
        return { a, e, b, ...(await __guardarRenglon()) };
      })());
      assert.equal(r1.a.auto, "150", "A · al elegir el producto entra su precio de lista");
      assert.match(r1.e.subtotal, /300/, "E · cantidad 2 → subtotal 300 en vivo");
      assert.match(r1.b.subtotal, /280/, "B/E · precio 140 → subtotal 280");
      assert.match(r1.b.nota, /solo para esta operaci/i, "C · se avisa que el precio especial es solo de esta operación");
      assert.ok(r1.cerrado, "guardado: " + JSON.stringify(r1.toasts));
      // F · precio vacío: se rechaza en pantalla (no es L 0.00) y NO se guarda nada
      const f = await A.eval(() => (async () => {
        document.getElementById("btnAgregarItem").click(); await __modal("modalItem");
        await __llenarRenglon({ tipo: "mano_obra", nombre: "Mano de obra de frenos", cantidad: 1, precio: "" });
        const vacio = await __guardarRenglon();
        await __llenarRenglon({ tipo: "mano_obra", precio: 250 });
        const bien = await __guardarRenglon();
        return { vacio, bien };
      })());
      assert.equal(f.vacio.cerrado, false, "F · el modal sigue abierto");
      assert.ok(f.vacio.toasts.some((t) => /precio/i.test(t) && /vac/i.test(t)), "F · aviso claro: " + JSON.stringify(f.vacio.toasts));
      assert.ok(f.bien.cerrado, "con precio sí se guarda");
      // repuesto del negocio a L 0.00 → pide confirmación (no se cuela un 0 por descuido)
      const cero = await A.eval(() => (async () => {
        document.getElementById("btnAgregarItem").click(); await __modal("modalItem");
        await __llenarRenglon({ tipo: "repuesto_inventario", producto: "Cadena 428", cantidad: 1, precio: 0 });
        const r = await __guardarRenglon();
        const hay = document.getElementById("modalConfirm").classList.contains("active");
        document.getElementById("btnConfirmCancelar")?.click();
        document.getElementById("modalConfirm").classList.remove("active");
        document.getElementById("btnCancelarItem").click();
        return { hay, r };
      })());
      assert.ok(cero.hay, "un repuesto del negocio a L 0.00 pide confirmación: " + JSON.stringify(cero.r));
      const it = renglones(O1);
      assert.deepEqual(it.map((x) => [x.nombre, x.tipo, x.cantidad, x.precio, x.aplicada]),
        [["Aceite 20W-50", "repuesto_inventario", 2, 140, 0], ["Mano de obra de frenos", "mano_obra", 1, 250, 0]], "B · en la nube: precio de ESTA operación, tipo correcto, nada aplicado");
      assert.equal(uno(`select precio_venta::int from public.inventario where id = '${ACE}'`), "150", "C · el precio maestro NO cambió");
      assert.equal(stock(ACE), 10, "I · presupuesto pendiente: el inventario no se toca");
      assert.equal(movs(), m0, "G/I · ni un movimiento de stock (tampoco por la mano de obra)");
    });

    test("H · repuesto manual no toca stock; la pantalla separa taller / repuestos del negocio / manuales", async () => {
      const m0 = movs();
      const r = await A.eval(() => __agregar({ tipo: "repuesto_manual", nombre: "Tornillo especial", cantidad: 2, precio: 15 }));
      assert.ok(r.cerrado, JSON.stringify(r.toasts));
      const v = await A.eval(() => __vista());
      assert.deepEqual(v.secciones, ["mano_obra", "repuesto_inventario", "repuesto_manual"], "secciones separadas por tipo");
      assert.equal(v.estado, "pendiente");
      assert.equal(renglones(O1).find((x) => x.nombre === "Tornillo especial").tipo, "repuesto_manual");
      assert.equal(movs(), m0, "H · el repuesto manual no mueve stock");
    });

    test("K/L/AC · «Aprobar» con DOBLE CLIC → el repuesto sale UNA sola vez, con movimiento auditable", async () => {
      const r = await A.eval(() => __decidir("btnAprobarLocal", 2));
      assert.ok(r.toasts.some((t) => /aprobado/i.test(t)), JSON.stringify(r.toasts));
      assert.equal(stock(ACE), 8, "K/L · 10 → 8: las 2 unidades salen una sola vez");
      const l = ledgerDe(O1);
      assert.equal(l.length, 1, "L · un solo movimiento: " + JSON.stringify(l));
      assert.equal(l[0].cantidad, -2);
      assert.ok(l[0].op_id && l[0].orden_item_id, "AC · el movimiento lleva operación y renglón");
      assert.equal(uno(`select presupuesto_estado from public.ordenes where id = '${O1}'`), "aprobado");
      assert.ok(Number(uno(`select count(*) from public.auditoria where accion = 'presupuesto-aprobar' and entidad_id = '${O1}' and operation_id is not null`)) >= 1, "AC · la aprobación queda en la auditoría");
      const v = await A.eval(() => (async () => { await __abrirOrden(document.querySelector("#presupuestoCard") && (await DB.get("ordenes", currentOrderId)).uid); return __vista(); })());
      assert.equal(v.estado, "aprobado", "la pantalla muestra el estado que decidió el servidor");
      assert.ok(v.filas.some((f) => /Aceite 20W-50/.test(f) && /descontado/.test(f)), "el renglón muestra que ya salió del inventario: " + JSON.stringify(v.filas));
      assert.equal(invariantes(), "[]");
    });

    test("R/S/U · después de aprobar: 2→3 saca 1; 3→1 devuelve 2; cambiar solo el precio no mueve stock", async () => {
      let r = await A.eval(() => __editar("Aceite 20W-50", { tipo: "repuesto_inventario", cantidad: 3 }));
      assert.ok(r.cerrado, JSON.stringify(r.toasts));
      assert.equal(stock(ACE), 7, "R · 2→3 saca exactamente 1");
      r = await A.eval(() => __editar("Aceite 20W-50", { tipo: "repuesto_inventario", cantidad: 1 }));
      assert.equal(stock(ACE), 9, "S · 3→1 devuelve exactamente 2");
      const m0 = movs();
      r = await A.eval(() => __editar("Aceite 20W-50", { tipo: "repuesto_inventario", precio: 120 }));
      assert.equal(stock(ACE), 9, "U · cambiar el precio no mueve stock");
      assert.equal(movs(), m0, "U · ni un movimiento nuevo");
      const ace = renglones(O1).find((x) => x.nombre === "Aceite 20W-50");
      assert.deepEqual([ace.cantidad, ace.precio, ace.aplicada, ace.costo], [1, 120, 1, 90], "el renglón: cantidad 1, precio 120, aplicado 1, costo sellado 90");
      assert.equal(uno(`select precio_venta::int from public.inventario where id = '${ACE}'`), "150", "el precio maestro sigue igual");
      assert.equal(invariantes(), "[]");
    });

    test("V · cambiar el producto A→B devuelve A y saca B en UNA operación", async () => {
      const r = await A.eval(() => __editar("Aceite 20W-50", { tipo: "repuesto_inventario", producto: "Cadena 428", cantidad: 1, precio: 480 }));
      assert.ok(r.cerrado, JSON.stringify(r.toasts));
      assert.equal(stock(ACE), 10, "V · el aceite vuelve completo");
      assert.equal(stock(CAD), 4, "V · sale 1 cadena");
      const ult = nube(`select op_id, inventario_id, cantidad::float c from public.inventario_movimientos order by creado_en desc, id desc limit 2`);
      assert.equal(new Set(ult.map((x) => x.op_id)).size, 1, "los dos movimientos (devolver A, sacar B) son de la MISMA operación");
      const cad = renglones(O1).find((x) => x.inventario_id === CAD);
      assert.deepEqual([cad.nombre, cad.precio, cad.costo, cad.aplicada], ["Cadena 428", 480, 300, 1], "el renglón pasa a B con su costo");
      assert.equal(invariantes(), "[]");
    });

    test("T · quitar un renglón aplicado devuelve exactamente lo aplicado (movimiento compensatorio, la historia no se borra)", async () => {
      const antes = movs();
      const t = await A.eval(() => __quitar("Cadena 428"));
      assert.ok(t.some((x) => /devuelto/.test(x)), JSON.stringify(t));
      assert.equal(stock(CAD), 5, "T · la cadena vuelve");
      assert.equal(movs(), antes + 1, "T · un movimiento compensatorio; los anteriores siguen ahí");
      assert.equal(invariantes(), "[]");
    });

    test("J · «No aprobó»: no toca stock; «Reabrir» lo devuelve a pendiente", async () => {
      const O2 = nuevaOrden(2);
      await A.eval((x) => __abrirOrden(x), O2);
      await A.eval(() => __agregar({ tipo: "repuesto_inventario", producto: "Aceite 20W-50", cantidad: 1 }));
      const m0 = movs();
      const r = await A.eval(() => __decidir("btnRechazarPresupuesto"));
      assert.ok(r.toasts.some((t) => /no aprobado/i.test(t)), JSON.stringify(r.toasts));
      assert.equal(uno(`select presupuesto_estado from public.ordenes where id = '${O2}'`), "rechazado");
      assert.equal(movs(), m0, "J · rechazado: ningún movimiento");
      assert.deepEqual((await A.eval(() => __vista())).botones, ["btnReabrirPresupuesto"]);
      await A.eval(() => __decidir("btnReabrirPresupuesto"));
      assert.equal(uno(`select presupuesto_estado from public.ordenes where id = '${O2}'`), "pendiente");
      assert.equal(stock(ACE), 10);
    });

    test("P/Q · stock insuficiente aborta TODO, nombra el producto y nunca deja negativo", async () => {
      const O3 = nuevaOrden(3);
      await A.eval((x) => __abrirOrden(x), O3);
      await A.eval(() => __agregar({ tipo: "repuesto_inventario", producto: "Aceite 20W-50", cantidad: 1 }));
      const f = await A.eval(() => __agregar({ tipo: "repuesto_inventario", producto: "Filtro de aire", cantidad: 5 }));
      assert.match(f.info, /no alcanza/, "el modal ya avisa que no alcanza (sin bloquear: pendiente no reserva)");
      const m0 = movs();
      const r = await A.eval(() => __decidir("btnAprobarLocal"));
      assert.ok(r.toasts.some((t) => /Filtro de aire/.test(t) && /hay 2/.test(t)), "P · el error nombra el producto y cuánto hay: " + JSON.stringify(r.toasts));
      assert.equal(movs(), m0, "P · no salió NADA (tampoco el aceite, que sí alcanzaba)");
      assert.deepEqual([stock(ACE), stock(FIL)], [10, 2]);
      assert.equal(uno(`select presupuesto_estado from public.ordenes where id = '${O3}'`), "pendiente", "P · no quedó aprobado");
      const v = await A.eval(() => __vista());
      assert.ok(v.error && /Filtro de aire/.test(v.error), "el aviso queda en pantalla");
      assert.equal(uno(`select count(*) from public.inventario where cantidad < 0`), "0", "Q · nunca negativo");
    });

    test("M · respuesta PERDIDA al aprobar → la cola repite la MISMA operación → una sola vez", async () => {
      const O4 = nuevaOrden(4);
      await A.eval((x) => __abrirOrden(x), O4);
      await A.eval(() => __agregar({ tipo: "repuesto_inventario", producto: "Aceite 20W-50", cantidad: 1 }));
      await A.eval(() => { window.__perder.decidir_presupuesto_orden = 1; return true; });
      await A.eval(() => __decidir("btnAprobarLocal"));
      assert.ok(await A.eval(() => __esperarCola(20000)), "la cola se vació");
      assert.equal(stock(ACE), 9, "M · 10 → 9 una sola vez");
      assert.equal(uno(`select count(*) from public.sync_ops where kind = 'decidir_presupuesto_orden' and resultado->>'orden_id' = '${O4}'`), "1", "M · una operación registrada");
      assert.equal(ledgerDe(O4).length, 1);
      assert.equal(invariantes(), "[]");
    });

    test("AA/O · SIN RED la aprobación queda PENDIENTE DE CONFIRMACIÓN (sin aprobación falsa); la app se recarga; al volver la red el servidor confirma UNA vez", async () => {
      const O5 = nuevaOrden(5);
      await A.eval((x) => __abrirOrden(x), O5);
      await A.eval(() => __agregar({ tipo: "repuesto_inventario", producto: "Cadena 428", cantidad: 2 }));
      const r = await A.eval(() => (async () => { window.__sinRed = true; forcedOffline = true; const d = await __decidir("btnAprobarLocal"); return { ...d, vista: __vista() }; })());
      assert.ok(r.toasts.some((t) => /pendiente de confirmaci/i.test(t)), JSON.stringify(r.toasts));
      assert.equal(r.vista.estado, "pendiente", "AA · NO se pinta como aprobado");
      assert.ok(r.vista.pendienteConfirmacion, "AA · se ve «pendiente de confirmación»");
      assert.deepEqual(r.vista.botones, [], "no se puede apilar otra decisión mientras tanto");
      assert.equal(stock(CAD), 5, "sin red no salió nada");
      await recargar(A, "cajero");   // O · la app se cierra/recarga con la aprobación en la cola (IndexedDB)
      assert.ok(await A.eval(() => __esperarCola(20000)), "al volver, la cola se envía sola");
      assert.equal(stock(CAD), 3, "AA/O · el servidor confirma: 5 → 3, una sola vez");
      assert.equal(uno(`select presupuesto_estado from public.ordenes where id = '${O5}'`), "aprobado");
      const v = await A.eval((x) => (async () => { await __abrirOrden(x); return __vista(); })(), O5);
      assert.equal(v.estado, "aprobado"); assert.equal(v.pendienteConfirmacion, false);
      assert.equal(ledgerDe(O5).length, 1);
    });

    test("AB · aprobación sin red + otro dispositivo agota el stock → al volver: rechazo VISIBLE, sin aprobación falsa, renglones intactos", async () => {
      const O6 = nuevaOrden(6);
      await A.eval((x) => __abrirOrden(x), O6);
      await A.eval(() => __agregar({ tipo: "repuesto_inventario", producto: "Filtro de aire", cantidad: 2 }));
      await A.eval(() => (async () => { window.__sinRed = true; forcedOffline = true; await __decidir("btnAprobarLocal"); return true; })());
      // mientras tanto, OTRO dispositivo vende los 2 filtros
      const venta = await fetch(`${pila.REST_URL}/rest/v1/rpc/registrar_venta_v2`, { method: "POST", headers: { apikey: "a", Authorization: "Bearer " + pila.jwt(PERFILES.admin), "Content-Type": "application/json" },
        body: JSON.stringify({ p_op: u(3999), p_cliente_id: null, p_cliente_nombre: "otro", p_metodo_pago: "efectivo", p_efectivo: 0, p_items: [{ inventario_id: FIL, nombre: "Filtro", cantidad: 2, precio: 80 }] }) });
      assert.equal(venta.status, 200);
      const r = await A.eval((x) => (async () => {
        window.__sinRed = false; forcedOffline = false;
        await __esperarCola(20000);
        const cola = (await syncBd.outbox.todos()).map((o) => ({ rpc: o.rpc, estado: o.estado, msg: o.error && o.error.mensaje }));
        await __abrirOrden(x);
        const o = (await DB.getAll("ordenes")).find((y) => y.uid === x);
        return { cola, vista: __vista(), renglones: (o.items || []).map((it) => it.nombre) };
      })(), O6);
      assert.ok(r.cola.some((o) => o.rpc === "decidir_presupuesto_orden" && o.estado === "rejected" && /Filtro de aire/.test(o.msg)), "el rechazo queda en la cola (Por revisar): " + JSON.stringify(r.cola));
      assert.ok(r.vista.conflicto && /Filtro de aire/.test(r.vista.conflicto), "AB · conflicto claro en la orden: " + JSON.stringify(r.vista));
      assert.equal(r.vista.estado, "pendiente", "AB · sin aprobación falsa");
      assert.deepEqual(r.renglones, ["Filtro de aire"], "no se pierde el trabajo local");
      assert.equal(uno(`select presupuesto_estado from public.ordenes where id = '${O6}'`), "pendiente");
      assert.equal(stock(FIL), 0, "nunca negativo");
      const tras = await A.eval(() => (async () => { document.getElementById("btnDescartarConflicto").click(); await new Promise((z) => setTimeout(z, 300));
        return { vista: __vista(), rechazadas: (await syncBd.outbox.todos()).filter((o) => o.estado === "rejected").length }; })());
      assert.equal(tras.vista.conflicto, null); assert.equal(tras.rechazadas, 0, "«Entendido» retira el aviso");
      assert.equal(invariantes(), "[]");
    });

    test("N · DOS DISPOSITIVOS aprueban a la vez → el repuesto sale una sola vez", async () => {
      uno(`insert into public.inventario_movimientos (inventario_id, tipo, cantidad) values ('${FIL}', 'apertura', 6)`);
      const O7 = nuevaOrden(7);
      await A.eval((x) => __abrirOrden(x), O7);
      await A.eval(() => __agregar({ tipo: "repuesto_inventario", producto: "Filtro de aire", cantidad: 3 }));
      await B.eval((x) => __abrirOrden(x), O7);
      const [ra, rb] = await Promise.all([A.eval(() => __decidir("btnAprobarLocal")), B.eval(() => __decidir("btnAprobarLocal"))]);
      assert.equal(stock(FIL), 3, "N · 6 → 3 una sola vez: " + JSON.stringify([ra.toasts, rb.toasts]));
      assert.equal(ledgerDe(O7).length, 1);
      assert.equal(invariantes(), "[]");
    });

    test("W/X/Y · orden heredada de 3.14: «sin clasificar» se respeta; #4 (descontado en 3.13 sin ledger) y #6 (con ledger) no se descuentan otra vez; quitar #6 devuelve 1", async () => {
      // como las deja el backfill de sync-15b: #4 aplicada=1 legado=1 (sin ledger); #6 aplicada=1 legado=0 con su movimiento; manual sin tipo
      const O8 = nuevaOrden(8, `
        insert into public.orden_items (id, orden_id, inventario_id, tipo, nombre, cantidad, precio, costo_unitario, cantidad_aplicada, aplicada_legado, creado_en)
        values ('${u(3508)}', '${u(3108)}', null, null, 'aceite bajaj', 1, 250, 0, 0, 0, now() - interval '3 min'),
               ('${u(3509)}', '${u(3108)}', '${ACE}', 'repuesto_inventario', 'Aceite 20W-50', 1, 150, 90, 1, 1, now() - interval '2 min'),
               ('${u(3510)}', '${u(3108)}', '${CAD}', 'repuesto_inventario', 'Cadena 428', 1, 500, 300, 1, 0, now() - interval '1 min');
        insert into public.inventario_movimientos (inventario_id, tipo, cantidad, orden_id, orden_item_id) values ('${CAD}', 'orden_item', -1, '${u(3108)}', '${u(3510)}');`);
      assert.equal(invariantes(), "[]", "fixture coherente con el backfill");
      const s0 = [stock(ACE), stock(CAD)], m0 = movs();
      await A.eval((x) => __abrirOrden(x), O8);
      const v = await A.eval(() => __vista());
      assert.deepEqual(v.secciones, ["repuesto_inventario", "sin_clasificar"], "Y · el renglón viejo sin tipo queda «sin clasificar» (no se adivina por el nombre)");
      await A.eval(() => __decidir("btnAprobarLocal"));
      assert.equal(uno(`select presupuesto_estado from public.ordenes where id = '${O8}'`), "aprobado");
      assert.deepEqual([stock(ACE), stock(CAD)], s0, "W/X · aprobar NO vuelve a descontar lo ya aplicado (#4 sin ledger, #6 con ledger)");
      assert.equal(movs(), m0, "ni un movimiento nuevo");
      await A.eval(() => __quitar("Cadena 428"));
      assert.equal(stock(CAD), s0[1] + 1, "W · quitar #6 devuelve el 1 que sí había salido");
      assert.equal(renglones(O8).find((x) => x.nombre === "aceite bajaj").tipo, null, "el manual viejo sigue sin tipo");
      assert.equal(invariantes(), "[]");
    });

    test("Z · cotización heredada con 2 renglones manuales sin tipo (como ab4277b6) → orden con renglones manuales, sin stock", async () => {
      const cot = u(3601);
      uno(`insert into public.cotizaciones (id, cliente_nombre, estado, validez_dias, vence_en) values ('${cot}', 'Cliente Z ${nav}', 'pendiente', 15, now() + interval '10 days');
           insert into public.cotizacion_items (cotizacion_id, inventario_id, tipo, nombre, cantidad, precio) values ('${cot}', null, null, 'aceite bajaj', 1, 250), ('${cot}', null, null, 'bujía de motor', 1, 120);`);
      const m0 = movs();
      const r = await A.eval((x) => (async () => {
        await syncMotor.pullTodo();
        const c = (await DB.getAll("cotizaciones")).find((y) => y.uid === x);
        await abrirCotizacionDetalle(c.id);
        const secciones = [...document.querySelectorAll("#cotDetItems tr.renglon-seccion")].map((tr) => tr.dataset.seccion);
        window.__toasts = [];
        document.getElementById("btnCotAceptar").click();
        for (let i = 0; i < 300 && document.getElementById("modalCotDetalle").classList.contains("active"); i++) {
          if (document.getElementById("modalConfirm").classList.contains("active")) document.getElementById("btnConfirmAceptar").click();
          await new Promise((z) => setTimeout(z, 50));
        }
        return { secciones, toasts: window.__toasts.slice() };
      })(), cot);
      assert.deepEqual(r.secciones, ["sin_clasificar"], "en pantalla: sin clasificar");
      const orden = uno(`select orden_id from public.cotizaciones where id = '${cot}'`);
      assert.ok(orden, "se creó la orden: " + JSON.stringify(r.toasts));
      assert.deepEqual(renglones(orden).map((x) => [x.nombre, x.tipo, x.inventario_id]), [["aceite bajaj", null, null], ["bujía de motor", null, null]], "Z · manuales, sin producto inferido");
      assert.equal(movs(), m0, "Z · sin stock");
    });

    test("cotización con los 3 tipos por la UI: el tipo viaja a la nube y a la orden; aceptar descuenta solo el repuesto del negocio, una vez", async () => {
      const m0 = movs(), s0 = stock(ACE);
      const r = await A.eval((nav) => (async () => {
        await renderCotizaciones();
        document.getElementById("btnNuevaCotizacion").click(); await __modal("modalCotizacion");
        document.getElementById("cotNombre").value = "Cotiza tipos " + nav;
        const $ = (s) => document.getElementById("cotItem" + s);
        const agregar = async (r) => {
          document.getElementById("btnAgregarItemCot").click(); await __modal("modalItemCot");
          $("Tipo").value = r.tipo; $("Tipo").dispatchEvent(new Event("change"));
          if (r.producto) { $("Buscar").value = r.producto; $("Buscar").dispatchEvent(new Event("input")); const sel = $("InvSelect"); const o = [...sel.options].find((x) => x.textContent.startsWith(r.producto)); sel.value = o.value; sel.dispatchEvent(new Event("change")); }
          if (r.nombre) $("Nombre").value = r.nombre;
          $("Cantidad").value = String(r.cantidad); $("Cantidad").dispatchEvent(new Event("input"));
          if (r.precio !== undefined) { $("Precio").value = String(r.precio); $("Precio").dispatchEvent(new Event("input")); }
          document.getElementById("btnGuardarItemCot").click(); await __modal("modalItemCot", false);
        };
        await agregar({ tipo: "mano_obra", nombre: "Afinado", cantidad: 1, precio: 300 });
        await agregar({ tipo: "repuesto_inventario", producto: "Aceite 20W-50", cantidad: 1, precio: 145 });
        await agregar({ tipo: "repuesto_manual", nombre: "Espejo comprado fuera", cantidad: 1, precio: 90 });
        // ✎ editar un renglón antes de guardar: el aceite pasa a 2
        const fila = [...document.querySelectorAll("#cotItemsEdit .cot-item-fila")].find((f) => f.textContent.includes("Aceite"));
        fila.querySelector("[data-editar]").click(); await __modal("modalItemCot");
        $("Cantidad").value = "2"; $("Cantidad").dispatchEvent(new Event("input"));
        const precioEditando = $("Precio").value;
        document.getElementById("btnGuardarItemCot").click(); await __modal("modalItemCot", false);
        const secciones = [...document.querySelectorAll("#cotItemsEdit .renglon-seccion")].map((s) => s.dataset.seccion);
        document.getElementById("btnGuardarCotizacion").click(); await __modal("modalCotDetalle");
        await __esperarCola();
        const c = (await DB.getAll("cotizaciones")).find((x) => x.clienteNombre === "Cotiza tipos " + nav);
        return { uid: c.uid, id: c.id, secciones, precioEditando };
      })(), nav);
      assert.equal(r.precioEditando, "145", "al editar, el precio especial del renglón se conserva (no vuelve al de lista)");
      assert.deepEqual(r.secciones, ["mano_obra", "repuesto_inventario", "repuesto_manual"]);
      assert.deepEqual(nube(`select nombre, tipo, cantidad::int c, precio::int p from public.cotizacion_items where cotizacion_id = '${r.uid}' order by nombre`).map((x) => [x.nombre, x.tipo, x.c, x.p]),
        [["Aceite 20W-50", "repuesto_inventario", 2, 145], ["Afinado", "mano_obra", 1, 300], ["Espejo comprado fuera", "repuesto_manual", 1, 90]]);
      assert.equal(movs(), m0, "cotizar no mueve stock");
      await A.eval((id) => (async () => { await abrirCotizacionDetalle(id); document.getElementById("btnCotAceptar").click();
        for (let i = 0; i < 300 && document.getElementById("modalCotDetalle").classList.contains("active"); i++) { if (document.getElementById("modalConfirm").classList.contains("active")) document.getElementById("btnConfirmAceptar").click(); await new Promise((z) => setTimeout(z, 50)); }
        return true; })(), r.id);
      const orden = uno(`select orden_id from public.cotizaciones where id = '${r.uid}'`);
      assert.deepEqual(renglones(orden).map((x) => [x.nombre, x.tipo, x.aplicada]).sort(), [["Aceite 20W-50", "repuesto_inventario", 2], ["Afinado", "mano_obra", 0], ["Espejo comprado fuera", "repuesto_manual", 0]]);
      assert.equal(stock(ACE), s0 - 2, "aceptar = aprobar: sale solo el aceite, una vez");
      assert.equal(uno(`select presupuesto_estado || '/' || aprobacion_via from public.ordenes where id = '${orden}'`), "aprobado/cotizacion");
    });

    test("AD · precio y costo históricos sobreviven sincronizar, bajar y recargar (aunque el producto cambie después)", async () => {
      const O9 = nuevaOrden(9);
      await A.eval((x) => __abrirOrden(x), O9);
      await A.eval(() => __agregar({ tipo: "repuesto_inventario", producto: "Aceite 20W-50", cantidad: 1, precio: 135 }));
      await A.eval(() => __decidir("btnAprobarLocal"));
      uno(`update public.inventario set precio_venta = 999, costo_compra = 555 where id = '${ACE}'`);
      await recargar(A, "cajero");
      const loc = await A.eval((x) => (async () => { await syncMotor.pullTodo(); const o = (await DB.getAll("ordenes")).find((y) => y.uid === x); return o.items.map((it) => [it.nombre, it.precio, it.costoUnitario, it.tipo, it.cantidadAplicada]); })(), O9);
      assert.deepEqual(loc, [["Aceite 20W-50", 135, 90, "repuesto_inventario", 1]], "caché tras recargar: precio 135 y costo 90 de la operación");
      assert.deepEqual(renglones(O9).map((x) => [x.precio, x.costo]), [[135, 90]], "nube: el histórico no cambió");
      uno(`update public.inventario set precio_venta = 150, costo_compra = 90 where id = '${ACE}'`);
      assert.equal(invariantes(), "[]");
    });
  });
}
