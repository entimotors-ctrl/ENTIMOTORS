// 3.15.0 · PRE-RELEASE · F-1 y O-2 (motor REAL sobre IndexedDB en memoria y un servidor falso con la semántica mínima de PostgREST).
//
// F-1 · Una orden tiene 2 renglones que SOLO existen en este dispositivo: sus operaciones `agregar_item_orden` fueron RECHAZADAS por la nube
//       (terminal: ni se reenvían ni se convierten en pendientes). Cuando el servidor publica una revisión más nueva de la orden (la
//       migración 15b sube `rev` a todas), la descarga NO puede destruir en silencio esos 2 renglones: siguen en la orden local mientras su
//       operación rechazada siga en la cola. La protección es SOLO local y SOLO para el renglón que nombra esa operación (p_item_id).
// O-2 · Un dispositivo que sincronizó con 3.14.1 contra el servidor ya migrado tiene las órdenes en la revisión nueva pero SIN los campos de
//       3.15 (presupuesto). Al pasar a 3.15 la caché se vuelve a leer UNA vez y toma el estado REAL del servidor.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crearFabrica } from "./helpers/idb-memoria.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leer = (f) => fs.readFileSync(path.join(RAIZ, "taller-demo", f), "utf8");
const J = (x) => JSON.parse(JSON.stringify(x));
function cargar({ idb = crearFabrica() } = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, Date, Promise, JSON, Math, structuredClone,
    crypto: globalThis.crypto, indexedDB: idb, navigator: { onLine: true }, ENTIMOTORS_BUILD: { producto: "admin" } });
  for (const f of ["sync-rest.js", "sync-db.js", "sync-engine.js", "sync-mappers.js", "sync-finanzas.js"]) vm.runInContext(leer(f), ctx, { filename: f });
  return ctx;
}
const P = cargar().SyncEngine.puras;

/* servidor falso: tablas con rev/updated_at, paginar por cursor, seleccionar por id, PATCH condicionado y RPC idempotentes por op_id */
function servidor() {
  let reloj = 0;
  const tablas = {}, opsHechas = new Map(), llamadas = [];
  const t = (n) => (tablas[n] ||= new Map());
  const sello = () => new Date(1790000000000 + (++reloj) * 1000).toISOString();
  const srv = { tablas, llamadas, rpcs: {}, sinRed: false, auth: false, perfiles: [{ id: "u-a", rol: "admin", activo: true }],
    sembrar(tabla, filas) { for (const f of filas) t(tabla).set(f.id, { rev: 1, deleted_at: null, ...f, updated_at: f.updated_at || sello() }); },
    tocar(tabla, id, cambios) { const r = t(tabla).get(id); Object.assign(r, cambios || {}, { rev: r.rev + 1, updated_at: sello() }); return r; } };
  const corte = () => (srv.sinRed ? { ok: false, clase: "red", status: 0, codigo: "SIN_RED", mensaje: "Failed to fetch" } : srv.auth ? { ok: false, clase: "auth", status: 401, codigo: "PGRST303", mensaje: "JWT expired" } : null);
  srv.rest = {
    insertar: async (tabla) => { llamadas.push(["insertar", tabla]); return corte() || { ok: true, status: 201, datos: [] }; },
    modificar: async (tabla, filtros, cambios) => {
      llamadas.push(["modificar", tabla]); const c = corte(); if (c) return c;
      const id = filtros.find((x) => x[0] === "id")[2], rev = filtros.find((x) => x[0] === "rev"), row = t(tabla).get(id);
      if (!row || (rev && row.rev !== rev[2])) return { ok: true, status: 200, datos: [] };
      Object.assign(row, structuredClone(cambios), { rev: row.rev + 1, updated_at: sello() });
      const { orden_items: _i, ...sinEmbebido } = row; return { ok: true, status: 200, datos: [structuredClone(sinEmbebido)] };   // un PATCH no devuelve el embebido
    },
    obtener: async (tabla, id) => { llamadas.push(["obtener", tabla]); return corte() || { ok: true, datos: t(tabla).get(id) ? structuredClone(t(tabla).get(id)) : null }; },
    rpc: async (nombre, params) => {
      llamadas.push(["rpc", nombre, params.p_op]); const c = corte(); if (c) return c;
      if (opsHechas.has(params.p_op)) return { ok: true, datos: { ...opsHechas.get(params.p_op), repetida: true } };
      const fn = srv.rpcs[nombre]; if (!fn) return { ok: false, clase: "esquema", status: 404, codigo: "PGRST202", mensaje: "no existe" };
      const r = fn(params); if (r && r.ok === false) return r;
      opsHechas.set(params.p_op, r); return { ok: true, datos: r };
    },
    seleccionar: async (tabla, o) => {
      llamadas.push(["seleccionar", tabla]); const c = corte(); if (c) return c;
      if (tabla === "perfiles") { const id = o.filtros[0][2]; return { ok: true, datos: srv.perfiles.filter((p) => p.id === id) }; }
      const f = (o.filtros || []).find((x) => x[0] === "id"), ids = f ? (f[1] === "in" ? f[2].replace(/[()]/g, "").split(",") : [f[2]]) : null;
      return { ok: true, datos: [...t(tabla).values()].filter((r) => !ids || ids.includes(r.id)).map((r) => structuredClone(r)) };
    },
    paginar: async (tabla, o) => {
      const cmp = (a, b) => P.compararCursor({ t: a.updated_at, id: a.id }, { t: b.updated_at, id: b.id });
      let cursor = o.cursor, total = 0;
      for (let pag = 0; pag < 200; pag++) {
        llamadas.push(["paginar", tabla, cursor ? "desde-cursor" : "desde-cero"]); const c = corte(); if (c) return { ok: false, clase: c.clase, codigo: c.codigo, mensaje: c.mensaje, total, cursor };
        const filas = [...t(tabla).values()].sort(cmp).filter((r) => !cursor || P.compararCursor({ t: r.updated_at, id: r.id }, cursor) > 0).slice(0, o.pagina || 500);
        if (!filas.length) return { ok: true, total, cursor, completo: true };
        total += filas.length; const ult = filas[filas.length - 1];
        await o.onPagina(filas.map((r) => structuredClone(r)), { t: ult.updated_at, id: ult.id }); cursor = { t: ult.updated_at, id: ult.id };
      }
      return { ok: true, total, cursor, completo: false };
    },
  };
  return srv;
}
const ORDEN = ["clientes", "motos", "ordenes", "creditos"];
async function dispositivo({ ctx = cargar(), srv, actor = "u-a" } = {}) {
  const bd = await ctx.SyncDB.abrir({ nombre: "entimotors_sync" });
  const d = { ctx, bd, srv, actor, reloj: 1_000_000 };
  d.motor = ctx.SyncEngine.crearMotor({ bd, rest: srv.rest, mappers: ctx.ENTIMOTORS_SYNC_MAPPERS, orden: ORDEN, sesion: () => (d.actor ? { uid: d.actor } : null), habilitado: () => true, locks: null, ahora: () => d.reloj, aleatorio: () => 0.5 });
  d.cola = () => bd.outbox.todos().then(J);
  d.orden = async (uid) => J((await bd.datos.todos("ordenes")).find((o) => o.uid === uid));
  d.rpcs = () => srv.llamadas.filter((x) => x[0] === "rpc").length;
  return d;
}
const RENGLON = (id, nombre, cantidad, precio, n) => ({ id, inventario_id: null, tipo: null, nombre, cantidad, precio, costo_unitario: 0, costo_estimado: false, cantidad_aplicada: 0, aplicada_legado: 0, creado_en: new Date(1780000000000 + n * 1000).toISOString() });
const OCHO = () => [300, 110, 580, 650, 150, 1500, 900, 250].map((p, i) => RENGLON("s" + (i + 1), "Servidor " + (i + 1), 1, p, i));
const RETENIDA = { ok: false, clase: "conflicto", status: 409, codigo: "23505", mensaje: "OP_ID_REUTILIZADO: esta operación está retenida" };
const sumar = (o) => o.items.reduce((a, i) => a + i.cantidad * i.precio, 0);

/* El caso EXACTO del teléfono: orden en rev 2 con 8 renglones en la nube; 2 renglones agregados aquí (4 × 70 y 1 × 1200) cuyas
   operaciones la nube rechazó (409 / 23505). Sin operaciones pendientes. Columnas del servidor 3.14 (sin presupuesto_estado). */
async function telefono() {
  const srv = servidor();
  srv.sembrar("clientes", [{ id: "c-21", nombre: "Cliente" }]); srv.sembrar("motos", [{ id: "m-8", cliente_id: "c-21", placa: "X" }]);
  srv.sembrar("ordenes", [{ id: "o-9", rev: 2, estado: "presupuesto", cliente_id: "c-21", moto_id: "m-8", finalizada: false, anulada: false, orden_items: OCHO() },
    { id: "o-otra", rev: 1, estado: "entregado", cliente_id: "c-21", moto_id: "m-8", finalizada: true, anulada: false, orden_items: [RENGLON("z1", "Otra", 1, 100, 0)] }]);
  srv.sembrar("creditos", [{ id: "cr-6", cliente_id: "c-21", total: 450, abonado: 0, saldo: 450, estado: "pendiente", credito_items: [], abonos: [] }]);
  srv.rpcs.agregar_item_orden = () => RETENIDA; srv.rpcs.registrar_abono_v2 = () => RETENIDA;
  const d = await dispositivo({ srv });
  await d.motor.pullTodo();
  const locales = [{ uid: "L-4x70", nombre: "Renglón local A", cantidad: 4, precio: 70, costoUnitario: 0, costoEstimado: false, inventarioUid: null, origenInventarioId: null },
    { uid: "L-1x1200", nombre: "Renglón local B", cantidad: 1, precio: 1200, costoUnitario: 0, costoEstimado: false, inventarioUid: null, origenInventarioId: null }];
  const o = await d.orden("o-9");
  await d.bd.transaccion(["ordenes"], "readwrite", (t) => t.put("ordenes", { ...o, items: o.items.concat(locales) }));   // lo que hace la app al agregar el renglón
  for (const l of locales) await d.motor.encolarRpc("agregar_item_orden", { p_orden_id: "o-9", p_item_id: l.uid, p_nombre: l.nombre, p_cantidad: l.cantidad, p_precio: l.precio, p_inventario_id: null }, { entidad: "ordenes", uid: "o-9" });
  await d.motor.encolarRpc("registrar_abono_v2", { p_credito_id: "cr-6", p_monto: 450, p_metodo: "transferencia" }, { entidad: "creditos", uid: "cr-6" });
  const r = await d.motor.flush();
  assert.deepEqual([r.enviadas, r.rechazadas], [0, 3]);
  return d;
}
/* la migración 15b: actualiza TODAS las órdenes una vez (backfill del presupuesto) → rev + 1 */
const migrar15b = (srv) => { for (const o of srv.tablas.ordenes.values()) srv.tocar("ordenes", o.id, { presupuesto_estado: o.finalizada ? "aprobado" : "pendiente", aprobado_en: o.finalizada ? "2026-09-20T10:00:00Z" : null, rechazado_en: null, aprobacion_via: o.finalizada ? "compatibilidad-3.14" : null }); };

describe("F-1 · renglones locales de una orden cuyas operaciones fueron RECHAZADAS", () => {
  test("punto de partida == teléfono: orden rev 2 con 10 renglones (5 920), servidor 8 (4 440), 2 operaciones rechazadas, ninguna pendiente", async () => {
    const d = await telefono(), o = await d.orden("o-9"), cola = await d.cola();
    assert.deepEqual([o._rev, o.items.length, sumar(o)], [2, 10, 5920]);
    assert.equal(d.srv.tablas.ordenes.get("o-9").orden_items.length, 8);
    assert.deepEqual(cola.map((x) => [x.rpc, x.estado, x.intentos, x.error.codigo]), [["agregar_item_orden", "rejected", 1, "23505"], ["agregar_item_orden", "rejected", 1, "23505"], ["registrar_abono_v2", "rejected", 1, "23505"]]);
  });

  test("F-1 · primera sincronización tras 15b: la orden local CONSERVA sus 10 renglones; el servidor sigue con 8; rechazadas idénticas; sin reenvío", async () => {
    const d = await telefono(), colaAntes = await d.cola(), rpcsAntes = d.rpcs();
    migrar15b(d.srv);
    assert.equal(d.srv.tablas.ordenes.get("o-9").rev, 3);
    await d.motor.sincronizar();
    const o = await d.orden("o-9");
    assert.deepEqual(o.items.map((i) => i.uid), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "L-4x70", "L-1x1200"], "los 2 renglones locales NO desaparecen");
    assert.deepEqual([o.items.length, sumar(o)], [10, 5920]);
    assert.deepEqual(J(o.items.slice(-2).map((i) => [i.nombre, i.cantidad, i.precio])), [["Renglón local A", 4, 70], ["Renglón local B", 1, 1200]]);
    assert.deepEqual([o._rev, o.presupuestoEstado], [3, "pendiente"], "lo demás de la orden SÍ es lo del servidor (revisión y estado del presupuesto reales)");
    assert.deepEqual([d.srv.tablas.ordenes.get("o-9").orden_items.length, d.srv.tablas.ordenes.get("o-9").rev], [8, 3], "el servidor no recibió nada");
    assert.deepEqual(await d.cola(), colaAntes, "las operaciones rechazadas: mismas filas, mismo estado, mismos intentos, mismo contenido");
    assert.equal(d.rpcs(), rpcsAntes, "ninguna RPC nueva: una rechazada no se reenvía");
  });

  test("sincronizaciones posteriores: sin duplicados, sin bucle, sin subir revisiones, sin reenvíos; el registro local queda estable", async () => {
    const d = await telefono(); migrar15b(d.srv); await d.motor.sincronizar();
    const o1 = await d.orden("o-9"), cola1 = await d.cola(), rpcs1 = d.rpcs(), escrituras = () => d.srv.llamadas.filter((x) => ["insertar", "modificar", "rpc"].includes(x[0])).length, e1 = escrituras();
    for (let i = 0; i < 6; i++) { d.reloj += 60000; await d.motor.sincronizar(); }
    assert.deepEqual(await d.orden("o-9"), o1); assert.deepEqual(await d.cola(), cola1);
    assert.deepEqual([d.rpcs(), escrituras()], [rpcs1, e1], "0 escrituras hacia el servidor en 6 sincronizaciones");
    assert.equal(d.srv.tablas.ordenes.get("o-9").rev, 3);
    const n0 = d.srv.llamadas.length; await d.motor.sincronizar();
    assert.ok(d.srv.llamadas.length - n0 <= ORDEN.length + 1, "una sincronización en reposo = una consulta por entidad (ninguna relectura en bucle)");
  });

  test("el servidor vuelve a cambiar la orden (otro dispositivo agrega un renglón): baja lo nuevo y los 2 locales siguen, una sola vez", async () => {
    const d = await telefono(); migrar15b(d.srv); await d.motor.sincronizar();
    const s = d.srv.tablas.ordenes.get("o-9"); s.orden_items.push(RENGLON("s9", "Servidor 9", 1, 40, 20)); d.srv.tocar("ordenes", "o-9");
    await d.motor.sincronizar(); await d.motor.sincronizar();
    const o = await d.orden("o-9");
    assert.deepEqual(o.items.map((i) => i.uid), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "L-4x70", "L-1x1200"]); assert.equal(o._rev, 4);
  });

  test("si el servidor YA trae un renglón con ese mismo id (p. ej. se registró de nuevo), manda el del servidor: nunca se duplica", async () => {
    const d = await telefono(); migrar15b(d.srv); await d.motor.sincronizar();
    const s = d.srv.tablas.ordenes.get("o-9"); s.orden_items.push(RENGLON("L-4x70", "Renglón del servidor", 4, 75, 30)); d.srv.tocar("ordenes", "o-9");
    await d.motor.sincronizar();
    const o = await d.orden("o-9");
    assert.deepEqual(o.items.map((i) => i.uid), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "L-4x70", "L-1x1200"]);
    assert.deepEqual([o.items[8].nombre, o.items[8].precio], ["Renglón del servidor", 75], "lo que confirmó el servidor prevalece sobre la copia local");
  });

  test("la protección está ligada al renglón que nombra la operación: otros renglones con uid que el servidor ya no trae SÍ se van; otras órdenes no cambian de regla", async () => {
    const d = await telefono();
    const o = await d.orden("o-9"), otra = await d.orden("o-otra");
    await d.bd.transaccion(["ordenes"], "readwrite", async (t) => { await t.put("ordenes", { ...o, items: o.items.concat([{ uid: "fantasma", nombre: "Sin operación", cantidad: 1, precio: 9 }]) });
      await t.put("ordenes", { ...otra, items: otra.items.concat([{ uid: "L-4x70", nombre: "Mismo id en OTRA orden", cantidad: 1, precio: 9 }]) }); });
    migrar15b(d.srv); await d.motor.sincronizar();
    assert.ok(!(await d.orden("o-9")).items.some((i) => i.uid === "fantasma"), "un renglón sin operación rechazada que lo respalde sigue la regla de siempre: manda el servidor");
    assert.deepEqual((await d.orden("o-otra")).items.map((i) => i.uid), ["z1"], "la operación rechazada es de la orden o-9: no protege nada en otra orden");
    assert.equal((await d.orden("o-otra")).presupuestoEstado, "aprobado");
  });

  test("NO se generaliza: un crédito con un abono rechazado sigue aceptando la versión del servidor (el dinero lo decide la nube)", async () => {
    const d = await telefono();
    const c = d.srv.tablas.creditos.get("cr-6"); Object.assign(c, { abonado: 450, saldo: 0, estado: "pagado" }); d.srv.tocar("creditos", "cr-6");
    await d.motor.sincronizar();
    const l = J((await d.bd.datos.todos("creditos")).find((x) => x.uid === "cr-6"));
    assert.deepEqual([l.saldo, l.estado, l._rev], [0, "pagado", 2]);
    assert.equal((await d.cola()).filter((x) => x.rpc === "registrar_abono_v2" && x.estado === "rejected").length, 1, "y su operación rechazada sigue en revisión, intacta");
  });

  test("operaciones PENDIENTES normales: mismo comportamiento de siempre (lo mío a la vista, se envía, y los renglones retenidos no se pierden por la respuesta)", async () => {
    const d = await telefono(); migrar15b(d.srv); await d.motor.sincronizar();
    d.srv.sinRed = true;
    const o = await d.orden("o-9");
    await d.motor.escribir("ordenes", { ...o, falla: "ruido al frenar" });
    d.srv.tocar("ordenes", "o-9", { diagnostico: { notas: "desde otro dispositivo" } });   // el servidor cambia mientras tanto (rev 4)
    d.srv.sinRed = false;
    await d.motor.pull("ordenes");
    let l = await d.orden("o-9");
    assert.deepEqual([l.falla, l._rev, l._pend, l.items.length], ["ruido al frenar", 3, true, 10], "con un cambio mío pendiente, la descarga no lo pisa ni avanza la revisión conocida (regla anterior, intacta)");
    const r = await d.motor.flush();
    assert.equal(r.rechazadas, 0); l = await d.orden("o-9");
    assert.equal(l.falla, "ruido al frenar"); assert.equal(d.srv.tablas.ordenes.get("o-9").falla, "ruido al frenar", "el cambio pendiente llegó al servidor");
    assert.deepEqual(l.items.slice(-2).map((i) => i.uid), ["L-4x70", "L-1x1200"]);
    assert.equal((await d.cola()).filter((x) => x.estado === "rejected").length, 3); assert.equal((await d.cola()).filter((x) => x.estado === "pending").length, 0);
  });

  test("registros SIN operaciones pendientes ni rechazadas: aceptan la versión más nueva del servidor, renglones incluidos", async () => {
    const d = await telefono();
    const s = d.srv.tablas.ordenes.get("o-otra"); s.orden_items = [RENGLON("z2", "Reemplazo", 2, 30, 1)]; d.srv.tocar("ordenes", "o-otra", { estado: "entregado" });
    await d.motor.sincronizar();
    const l = await d.orden("o-otra"); assert.deepEqual([l.items.map((i) => i.uid), l._rev], [["z2"], 2]);
  });

  test("sesión caducada, sin red y volver a entrar: nada se pierde y nada se reenvía", async () => {
    const d = await telefono(), cola0 = await d.cola(), rpcs0 = d.rpcs(); migrar15b(d.srv);
    d.srv.auth = true; const r1 = await d.motor.sincronizar(); assert.equal(r1.pull[0].clase, "auth");
    assert.equal((await d.orden("o-9")).items.length, 10); assert.deepEqual(await d.cola(), cola0);
    d.srv.auth = false; d.srv.sinRed = true; await d.motor.sincronizar(); assert.equal((await d.orden("o-9")).items.length, 10);
    d.actor = null; assert.equal((await d.motor.flush()).omitido, "sin-sesion");
    d.actor = "u-a"; d.srv.sinRed = false; d.reloj += 10 * 60000; d.motor.reanudar && d.motor.reanudar(); await d.motor.sincronizar(); await d.motor.sincronizar();
    const o = await d.orden("o-9"); assert.deepEqual([o.items.length, sumar(o), o._rev], [10, 5920, 3]);
    assert.deepEqual(await d.cola(), cola0); assert.equal(d.rpcs(), rpcs0);
  });

  /* PROTECCIÓN TEMPORAL (requisito nuevo, 2026-10-04). Este caso sustituye a «al QUITAR deliberadamente una rechazada de la lista… prevalece
     el servidor»: mientras los textos de esos renglones no estén respaldados fuera del dispositivo, una rechazada que los respalda NO se
     puede quitar. El descarte con relectura queda en el motor, inactivo (PROTEGER_RESPALDO_LOCAL), para la versión que retire la protección. */
  test("PROTECCIÓN TEMPORAL · una rechazada que respalda un renglón local NO se puede quitar (ni llamando al motor): nada cambia; las que no respaldan nada se quitan como siempre", async () => {
    const d = await telefono(); migrar15b(d.srv); await d.motor.sincronizar();
    const rev = await d.motor.revision();
    const a = rev.rechazadas.find((x) => x.rpc === "agregar_item_orden"), abono = rev.rechazadas.find((x) => x.rpc === "registrar_abono_v2");
    assert.deepEqual([a.retieneLocal, a.protegida, abono.retieneLocal, abono.protegida], [true, true, false, false], "la lista dice cuáles respaldan un dato que solo existe aquí (la pantalla no ofrece quitarlas)");
    const estado = async () => J({ cola: await d.cola(), orden: await d.orden("o-9"), cursores: await d.bd.transaccion(["cursores"], "readonly", (t) => t.todos("cursores")), fk: (await d.bd.meta.get("fk_pendientes")) || null });
    const antes = await estado(), rpcs = d.rpcs(), llamadas = d.srv.llamadas.length;
    for (const op of antes.cola.filter((x) => x.rpc === "agregar_item_orden")) {
      assert.deepEqual(J(await d.motor.descartarRechazadaDetalle(op.seq)), { ok: false, motivo: "protegida", protegida: true });
      assert.equal(await d.motor.descartarRechazada(op.seq), false, "la forma de siempre devuelve false: no salió de la lista");
    }
    assert.deepEqual(await estado(), antes, "ni la cola (mismas filas, estado, intentos y contenido), ni la orden, ni los cursores, ni las relecturas anotadas cambian");
    assert.equal(d.srv.llamadas.length, llamadas, "el intento no habla con el servidor");
    await d.motor.sincronizar(); await d.motor.sincronizar();
    const o = await d.orden("o-9");
    assert.deepEqual([o.items.length, sumar(o)], [10, 5920], "la orden sigue con sus 10 renglones");
    assert.deepEqual(await d.cola(), antes.cola, "y las rechazadas siguen idénticas tras sincronizar");
    assert.equal(d.rpcs(), rpcs, "sin reenvíos");
    // lo que NO respalda datos locales (un abono rechazado) conserva el comportamiento de siempre
    const seqAbono = antes.cola.find((x) => x.rpc === "registrar_abono_v2").seq;
    assert.deepEqual(J(await d.motor.descartarRechazadaDetalle(999999)), { ok: false, motivo: "no-existe" });
    assert.equal(await d.motor.descartarRechazada(seqAbono), true);
    assert.deepEqual((await d.cola()).map((x) => x.rpc), ["agregar_item_orden", "agregar_item_orden"]);
    assert.equal(d.srv.tablas.ordenes.get("o-9").rev, 3, "sin tocar el servidor");
  });

  test("una versión ANTERIOR de la app (3.14.1, sin esta protección) ya quitó los 2 renglones de la orden local: 3.15 los repone desde la propia operación rechazada, una sola vez y sin enviar nada", async () => {
    const d = await telefono(), cola0 = await d.cola(), rpcs0 = d.rpcs(); migrar15b(d.srv);
    const s = d.srv.tablas.ordenes.get("o-9"), o = await d.orden("o-9");
    // lo que deja 3.14.1 tras sincronizar contra el servidor migrado: la orden del servidor (8 renglones, rev 3), sin campos de 3.15, cursor al día
    await d.bd.transaccion(["ordenes", "cursores", "meta"], "readwrite", async (t) => { await t.put("ordenes", { ...o, items: o.items.slice(0, 8), _rev: 3, _pend: false });
      const ult = [...d.srv.tablas.ordenes.values()].sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1)).pop(); await t.put("cursores", { entidad: "ordenes", t: ult.updated_at, id: ult.id }); await t.borrar("meta", "esquema_cache"); });
    assert.equal((await d.orden("o-9")).items.length, 8);
    await d.motor.sincronizar(); await d.motor.sincronizar(); await d.motor.sincronizar();
    const l = await d.orden("o-9");
    assert.deepEqual(l.items.map((i) => i.uid), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "L-4x70", "L-1x1200"]);
    assert.deepEqual(J(l.items.slice(-2).map((i) => [i.nombre, i.cantidad, i.precio, i.inventarioUid])), [["Renglón local A", 4, 70, null], ["Renglón local B", 1, 1200, null]], "repuestos con los datos EXACTOS de la operación");
    assert.deepEqual([sumar(l), l._rev, l.presupuestoEstado], [5920, 3, "pendiente"]);
    assert.deepEqual(await d.cola(), cola0); assert.equal(d.rpcs(), rpcs0); assert.deepEqual([s.orden_items.length, s.rev], [8, 3]);
  });

  test("regla del mapper (pura): retiene SOLO renglones con operación `agregar_item_orden` RECHAZADA de esa orden y ausentes del servidor; sin operaciones = regla anterior", () => {
    const M = cargar().ENTIMOTORS_SYNC_MAPPERS.ordenes;
    const local = { uid: "o-9", items: [{ uid: "s1" }, { uid: "L1", nombre: "a" }, { uid: "L2", nombre: "b" }, { uid: "L3", nombre: "c" }, { nombre: "sin uid" }] }, c = { items: [{ uid: "s1" }, { uid: "L3", nombre: "del servidor" }] };
    const op = (o) => ({ kind: "rpc", rpc: "agregar_item_orden", estado: "rejected", uid: "o-9", params: { p_orden_id: "o-9" }, ...o });
    const ids = (ops) => J(M.fusionarLocal(local, c, ops).items.map((i) => i.uid || i.nombre));
    assert.deepEqual(ids(undefined), ["s1", "L3", "sin uid"], "llamada antigua (sin operaciones): igual que antes");
    assert.deepEqual(ids([]), ["s1", "L3", "sin uid"]);
    assert.deepEqual(ids([op({ params: { p_orden_id: "o-9", p_item_id: "L1" } })]), ["s1", "L3", "L1", "sin uid"]);
    assert.deepEqual(ids([op({ params: { p_orden_id: "o-9", p_item_id: "L3" } })]), ["s1", "L3", "sin uid"], "si el servidor ya lo trae, no se duplica");
    assert.deepEqual(ids([op({ params: { p_orden_id: "o-9", p_item_id: "L9", p_nombre: "z", p_cantidad: 2, p_precio: 5 } }), op({ params: { p_orden_id: "o-9", p_item_id: "L9", p_nombre: "z", p_cantidad: 2, p_precio: 5 } })]), ["s1", "L3", "sin uid", "L9"], "ausente de la copia local: se repone desde la operación, una sola vez");
    assert.deepEqual(ids([op({ estado: "pending", params: { p_orden_id: "o-9", p_item_id: "L1" } })]), ["s1", "L3", "sin uid"], "pendiente: no es este mecanismo (lo protege el de siempre)");
    assert.deepEqual(ids([op({ rpc: "quitar_item_orden", params: { p_item_id: "L1" } })]), ["s1", "L3", "sin uid"], "otra RPC rechazada no retiene");
    assert.deepEqual(ids([op({ params: { p_orden_id: "o-otra", p_item_id: "L1" } })]), ["s1", "L3", "sin uid"], "una operación de otra orden no retiene");
    assert.deepEqual(J(M.fusionarLocal(local, { estado: "x" }, [op({ params: { p_orden_id: "o-9", p_item_id: "L1" } })])), { estado: "x" }, "sin renglones embebidos (respuesta de un PATCH) no toca los renglones");
  });
});

describe("O-2 · caché descargada por 3.14.1 contra el servidor ya migrado", () => {
  /* reproduce la ventana: el dispositivo (3.14.1) baja las órdenes en la revisión nueva SIN los campos de 3.15 */
  async function ventana() {
    const d = await telefono(); migrar15b(d.srv);
    const filas = await d.bd.datos.todos("ordenes"), cur = [...d.srv.tablas.ordenes.values()].sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1)).pop();
    await d.bd.transaccion(["ordenes", "cursores", "meta"], "readwrite", async (t) => {
      for (const f of filas) { const s = d.srv.tablas.ordenes.get(f.uid); const { presupuestoEstado: _a, aprobadoEn: _b, rechazadoEn: _c, aprobacionVia: _d, ...sin } = J(f); await t.put("ordenes", { ...sin, _rev: s.rev }); }
      await t.put("cursores", { entidad: "ordenes", t: cur.updated_at, id: cur.id });
      await t.borrar("meta", "esquema_cache");   // una caché de 3.14.1 no tiene la marca
    });
    return d;
  }
  test("la ventana reproducida: órdenes en la revisión del servidor, sin presupuestoEstado, y el cursor ya pasó", async () => {
    const d = await ventana();
    for (const u of ["o-9", "o-otra"]) { const o = await d.orden(u); assert.equal(o._rev, d.srv.tablas.ordenes.get(u).rev); assert.ok(!("presupuestoEstado" in o)); }
  });
  test("O-2 · primera sincronización en 3.15: relee UNA vez y cada orden toma el estado REAL del servidor (aprobado ≠ pendiente); sin escribir en el servidor; F-1 sigue protegido", async () => {
    const d = await ventana(), revs = () => [...d.srv.tablas.ordenes.values()].map((o) => o.id + ":" + o.rev).join(), r0 = revs(), w0 = d.srv.llamadas.filter((x) => ["insertar", "modificar", "rpc"].includes(x[0])).length;
    await d.motor.sincronizar();
    assert.deepEqual([(await d.orden("o-otra")).presupuestoEstado, (await d.orden("o-9")).presupuestoEstado], ["aprobado", "pendiente"], "el estado es el del servidor, no un «pendiente» por defecto");
    assert.equal((await d.orden("o-otra")).aprobacionVia, "compatibilidad-3.14");
    assert.equal((await d.orden("o-9")).items.length, 10, "la relectura tampoco destruye los renglones retenidos");
    assert.equal(revs(), r0, "ninguna revisión cambió en el servidor"); assert.equal(d.srv.llamadas.filter((x) => ["insertar", "modificar", "rpc"].includes(x[0])).length, w0);
    assert.ok((await d.bd.meta.get("esquema_cache")) >= 315);
    const n0 = d.srv.llamadas.length; await d.motor.sincronizar(); const despues = d.srv.llamadas.slice(n0);
    assert.ok(!despues.some((x) => x[0] === "paginar" && x[2] === "desde-cero"), "la relectura completa ocurre una sola vez");
  });
  test("si la relectura se corta (sin red), no se da por hecha: se repite en la siguiente sincronización", async () => {
    const d = await ventana(); d.srv.sinRed = true; await d.motor.sincronizar();
    assert.ok(!((await d.bd.meta.get("esquema_cache")) >= 315)); assert.ok(!("presupuestoEstado" in (await d.orden("o-otra"))));
    d.srv.sinRed = false; d.reloj += 10 * 60000; await d.motor.sincronizar();
    assert.equal((await d.orden("o-otra")).presupuestoEstado, "aprobado"); assert.ok((await d.bd.meta.get("esquema_cache")) >= 315);
  });
  test("un dispositivo NUEVO descarga una sola vez (sin relectura extra) y queda marcado", async () => {
    const srv = servidor(); srv.sembrar("clientes", [{ id: "c1", nombre: "A" }]); srv.sembrar("ordenes", [{ id: "o1", estado: "recibido", cliente_id: "c1", finalizada: false, anulada: false, presupuesto_estado: "pendiente", orden_items: [] }]);
    const d = await dispositivo({ srv }); await d.motor.pullTodo();
    assert.equal(srv.llamadas.filter((x) => x[0] === "paginar" && x[1] === "ordenes" && x[2] === "desde-cero").length, 1);
    assert.ok((await d.bd.meta.get("esquema_cache")) >= 315);
    const n0 = srv.llamadas.length; await d.motor.pullTodo(); assert.ok(!srv.llamadas.slice(n0).some((x) => x[0] === "paginar" && ["clientes", "ordenes"].includes(x[1]) && x[2] === "desde-cero"), "las tablas con datos siguen desde su cursor");
  });
  test("un cambio MÍO pendiente sobrevive a la relectura (misma regla de siempre) y lo que decide el servidor sí baja", async () => {
    const d = await ventana(); d.srv.sinRed = true;
    await d.motor.escribir("ordenes", { ...(await d.orden("o-otra")), reparacionNotas: "nota mía" }); d.srv.sinRed = false;
    await d.motor.pullTodo();
    const o = await d.orden("o-otra"); assert.deepEqual([o.reparacionNotas, o._pend, o.presupuestoEstado], ["nota mía", true, "aprobado"]);
  });
});


/* PROTECCIÓN TEMPORAL · crédito provisional: se registró sin conexión (copia local nunca confirmada) y la nube rechazó su `registrar_credito`.
   La operación es la única representación completa (conceptos y nota) de ese crédito. Textos de prueba, no reales. */
const CONCEPTOS = [["Concepto de prueba 1", 1, 980], ["Concepto de prueba 2", 2, 300], ["Concepto de prueba 3", 1, 450], ["Concepto de prueba 4", 1, 250]].map(([nombre, cantidad, precio], i) => ({ item_id: "ci-" + (i + 1), nombre, cantidad, precio, inventario_id: null }));
async function conCreditoProvisional() {
  const d = await telefono();
  d.srv.rpcs.registrar_credito = () => RETENIDA;
  await d.bd.transaccion(["creditos", "mapa"], "readwrite", async (t) => {
    const id = await t.put("creditos", { clienteNombre: "Cliente", clienteTelefono: "", items: CONCEPTOS.map((c) => ({ nombre: c.nombre, cantidad: c.cantidad, precio: c.precio })), total: 2280, abonado: 0, saldo: 2280, estado: "pendiente",
      vencimiento: null, nota: "Nota de prueba", origen: null, ordenId: null, historialAbonos: [], uid: "cr-prov", _rev: 0, _base: null, _pend: true });   // lo que deja guardarProvisional() de la app
    await t.put("mapa", { uid: "cr-prov", entidad: "creditos", local_id: id });
  });
  await d.motor.encolarRpc("registrar_credito", { p_credito_id: "cr-prov", p_cliente_id: "c-21", p_cliente_nombre: "Cliente", p_items: CONCEPTOS, p_nota: "Nota de prueba", p_abono_inicial: 0, p_offline: true }, { entidad: "creditos", uid: "cr-prov", crea: true });
  const r = await d.motor.flush();
  assert.deepEqual([r.enviadas, r.rechazadas], [0, 1]);
  d.credito = async () => J((await d.bd.datos.todos("creditos")).find((c) => c.uid === "cr-prov"));
  return d;
}
describe("PROTECCIÓN TEMPORAL · crédito provisional cuya creación fue RECHAZADA", () => {
  test("la lista lo marca como protegido; los abonos rechazados NO", async () => {
    const d = await conCreditoProvisional(), rev = await d.motor.revision();
    assert.deepEqual(J(rev.rechazadas.map((x) => [x.rpc, x.retieneLocal, x.protegida])), [["agregar_item_orden", true, true], ["agregar_item_orden", true, true], ["registrar_abono_v2", false, false], ["registrar_credito", true, true]]);
    assert.ok(!JSON.stringify(rev).includes("Concepto de prueba") && !JSON.stringify(rev).includes("Nota de prueba"), "la lista de revisión sigue sin llevar el contenido de la operación");
  });
  test("intentar quitarla: rechazado; la operación (conceptos y nota), el crédito local y los cursores quedan idénticos; no aparece en la nube; sin reenvío, también tras 15b y varias sincronizaciones", async () => {
    const d = await conCreditoProvisional();
    const op = (await d.cola()).find((x) => x.rpc === "registrar_credito"), credito = await d.credito(), rpcs = d.rpcs();
    assert.deepEqual([op.estado, op.intentos, op.params.p_items.length, op.params.p_nota, credito.total, credito.items.length, credito._rev, credito._pend], ["rejected", 1, 4, "Nota de prueba", 2280, 4, 0, true]);
    const cursores = J(await d.bd.transaccion(["cursores"], "readonly", (t) => t.todos("cursores"))), colaAntes = await d.cola();
    assert.deepEqual(J(await d.motor.descartarRechazadaDetalle(op.seq)), { ok: false, motivo: "protegida", protegida: true });
    assert.equal(await d.motor.descartarRechazada(op.seq), false);
    assert.deepEqual(await d.cola(), colaAntes); assert.deepEqual(await d.credito(), credito);
    assert.deepEqual(J(await d.bd.transaccion(["cursores"], "readonly", (t) => t.todos("cursores"))), cursores);
    migrar15b(d.srv); await d.motor.sincronizar(); await d.motor.sincronizar(); d.reloj += 3_600_000; await d.motor.sincronizar();
    assert.deepEqual(await d.cola(), colaAntes, "las 4 rechazadas idénticas: mismo estado, mismos intentos, mismo contenido");
    assert.deepEqual(await d.credito(), credito, "el crédito provisional íntegro: 4 conceptos, total, nota");
    assert.equal(d.srv.tablas.creditos.has("cr-prov"), false, "no aparece en la nube");
    assert.equal(d.rpcs(), rpcs, "sin reenvíos");
    const o = await d.orden("o-9"); assert.deepEqual([o.items.length, sumar(o)], [10, 5920], "y F-1 sigue protegido");
  });
  test("no se generaliza: si el crédito YA está confirmado por el servidor, su `registrar_credito` rechazado se quita como siempre", async () => {
    const d = await telefono(); d.srv.rpcs.registrar_credito = () => RETENIDA;
    await d.motor.encolarRpc("registrar_credito", { p_credito_id: "cr-6", p_items: [], p_nota: "" }, { entidad: "creditos", uid: "cr-6", crea: true }); await d.motor.flush();
    const x = (await d.motor.revision()).rechazadas.find((y) => y.rpc === "registrar_credito");
    assert.deepEqual([x.retieneLocal, x.protegida], [false, false]);
    assert.equal(await d.motor.descartarRechazada(x.seq), true);
  });
  test("regla del mapper (pura): solo `registrar_credito` RECHAZADO con crédito y sin copia local confirmada; ninguna otra operación de dinero", () => {
    const m = cargar().ENTIMOTORS_SYNC_MAPPERS.creditos, op = (rpc, estado = "rejected", params = { p_credito_id: "x" }) => ({ estado, kind: "rpc", rpc, params });
    assert.equal(m.retieneLocal(op("registrar_credito"), { _rev: 0, _base: null, _pend: true }), true);
    assert.equal(m.retieneLocal(op("registrar_credito"), null), true, "sin copia local sigue siendo la única representación");
    assert.equal(m.retieneLocal(op("registrar_credito"), { _rev: 3, _base: {} }), false);
    assert.equal(m.retieneLocal(op("registrar_credito", "pending"), null), false);
    assert.equal(m.retieneLocal(op("registrar_credito", "rejected", {}), null), false);
    for (const rpc of ["registrar_abono_v2", "reversar_abono", "reversar_credito", "registrar_venta_v2"]) assert.equal(m.retieneLocal(op(rpc), null), false, rpc);
  });
});
