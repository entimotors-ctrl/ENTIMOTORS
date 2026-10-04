// 3.15.0 · BLOQUE 2 · piezas puras del cliente: constructores de la cola (sync-finanzas.js) y mappers (sync-mappers.js) REALES en vm.
// Tipos de renglón, precio obligatorio (vacío ≠ L 0.00), estado del presupuesto solo del servidor y ninguna RPC nueva con PIN.
//   node --test pruebas/sync/node/b2-presupuestos.test.mjs
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leer = (f) => fs.readFileSync(path.join(RAIZ, "taller-demo", f), "utf8");
const J = (x) => JSON.parse(JSON.stringify(x));
function cargar(producto = "admin") {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Date, Promise, JSON, Math, crypto: globalThis.crypto, navigator: { onLine: true }, ENTIMOTORS_BUILD: { producto } });
  for (const f of ["sync-rest.js", "sync-db.js", "sync-engine.js", "sync-mappers.js", "sync-finanzas.js"]) vm.runInContext(leer(f), ctx, { filename: f });
  return ctx;
}
const ctx = cargar();
let n = 0;
const K = ctx.SyncFinanzas.construir({ uuid: () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}` });
const falla = (fn, re) => assert.throws(fn, (e) => e.validacion === true && re.test(e.message), String(re));
const ORD = "00000000-0000-4000-9000-00000000aaaa", INV = "00000000-0000-4000-9000-00000000bbbb", ITEM = "00000000-0000-4000-9000-00000000cccc";

describe("3.15 BLOQUE 2 · constructores de la cola", () => {
  test("itemOrden: el tipo viaja (p_tipo); el repuesto del negocio exige su producto; mano de obra y manual no llevan producto", () => {
    const a = K.itemOrden({ ordenUid: ORD, tipo: "repuesto_inventario", inventarioId: 7, inventarioUid: INV, nombre: "Aceite", cantidad: 2, precio: "140" });
    assert.equal(a.rpc, "agregar_item_orden");
    assert.deepEqual([a.params.p_tipo, a.params.p_inventario_id, a.params.p_cantidad, a.params.p_precio], ["repuesto_inventario", INV, 2, 140]);
    const m = K.itemOrden({ ordenUid: ORD, tipo: "mano_obra", nombre: "Frenos", cantidad: 1, precio: 250 });
    assert.deepEqual([m.params.p_tipo, m.params.p_inventario_id], ["mano_obra", null]);
    falla(() => K.itemOrden({ ordenUid: ORD, tipo: "repuesto_inventario", nombre: "x", cantidad: 1, precio: 1 }), /producto del inventario/);
    falla(() => K.itemOrden({ ordenUid: ORD, tipo: "mano_obra", inventarioUid: INV, nombre: "x", cantidad: 1, precio: 1 }), /no llevan producto/);
    falla(() => K.itemOrden({ ordenUid: ORD, tipo: "repuesto_manual", nombre: " ", cantidad: 1, precio: 1 }), /descripci/);
    falla(() => K.itemOrden({ ordenUid: ORD, tipo: "otro", nombre: "x", cantidad: 1, precio: 1 }), /Tipo de rengl/);
    falla(() => K.itemOrden({ ordenUid: ORD, tipo: "repuesto_inventario", inventarioId: 7, nombre: "x", cantidad: 1, precio: 1 }), /identidad en la nube/);
  });

  test("F · precio vacío NO es L 0.00: null, '' y espacios se rechazan; 0 explícito sí vale; negativo o texto no", () => {
    for (const precio of [null, undefined, "", "  "]) falla(() => K.itemOrden({ ordenUid: ORD, tipo: "mano_obra", nombre: "x", cantidad: 1, precio }), /Falta el precio/);
    falla(() => K.itemOrden({ ordenUid: ORD, tipo: "mano_obra", nombre: "x", cantidad: 1, precio: -1 }), /Precio inv/);
    falla(() => K.itemOrden({ ordenUid: ORD, tipo: "mano_obra", nombre: "x", cantidad: 1, precio: "abc" }), /Precio inv/);
    assert.equal(K.itemOrden({ ordenUid: ORD, tipo: "mano_obra", nombre: "cortesía", cantidad: 1, precio: 0 }).params.p_precio, 0);
    falla(() => K.itemOrden({ ordenUid: ORD, tipo: "mano_obra", nombre: "x", cantidad: 0, precio: 1 }), /cantidad/);
  });

  test("renglón viejo sin tipo: se respeta (null); solo el vínculo real a un producto lo vuelve repuesto del negocio", () => {
    assert.equal(K.itemOrden({ ordenUid: ORD, tipo: null, nombre: "aceite bajaj", cantidad: 1, precio: 250 }).params.p_tipo, null);
    assert.equal(K.itemOrden({ ordenUid: ORD, tipo: null, inventarioId: 7, inventarioUid: INV, nombre: "Aceite", cantidad: 1, precio: 1 }).params.p_tipo, "repuesto_inventario");
  });

  test("actualizarItemOrden y decidirPresupuesto arman las RPC exactas; decisión desconocida se rechaza", () => {
    const e = K.actualizarItemOrden({ itemUid: ITEM, ordenUid: ORD, tipo: "repuesto_inventario", inventarioId: 7, inventarioUid: INV, nombre: "Aceite", cantidad: 3, precio: 120, deviceId: "d1" });
    assert.equal(e.rpc, "actualizar_item_orden");
    assert.deepEqual(J(e.params), { p_item_id: ITEM, p_cantidad: 3, p_precio: 120, p_nombre: "Aceite", p_inventario_id: INV, p_tipo: "repuesto_inventario", p_device: "d1" });
    assert.deepEqual(J(e.meta), { entidad: "ordenes", uid: ORD });
    falla(() => K.actualizarItemOrden({ ordenUid: ORD, tipo: "mano_obra", nombre: "x", cantidad: 1, precio: 1 }), /identidad/);
    const d = K.decidirPresupuesto({ ordenUid: ORD, decision: "aprobar", via: "local", deviceId: "d1" });
    assert.equal(d.rpc, "decidir_presupuesto_orden");
    assert.deepEqual(J(d.params), { p_orden_id: ORD, p_decision: "aprobar", p_via: "local", p_device: "d1" });
    for (const x of ["rechazar", "reabrir"]) assert.equal(K.decidirPresupuesto({ ordenUid: ORD, decision: x }).params.p_decision, x);
    falla(() => K.decidirPresupuesto({ ordenUid: ORD, decision: "desaprobar" }), /Decisi/);
  });

  test("las RPC del presupuesto NO son acciones con PIN (van por la cola, sirven sin red); anular sigue con PIN", () => {
    const pin = ctx.SyncEngine.puras.ACCIONES_CON_PIN;
    for (const rpc of ["agregar_item_orden", "actualizar_item_orden", "quitar_item_orden", "decidir_presupuesto_orden", "convertir_cotizacion"]) assert.ok(!pin.includes(rpc), rpc);
    assert.ok(pin.includes("anular_orden"));
  });
});

describe("3.15 BLOQUE 2 · mappers", () => {
  const M = ctx.ENTIMOTORS_SYNC_MAPPERS;
  test("ordenes: bajan tipo, cantidad aplicada y legado de cada renglón, y el estado del presupuesto (solo lectura)", () => {
    assert.match(M.ordenes.select, /orden_items\([^)]*tipo[^)]*cantidad_aplicada[^)]*aplicada_legado/);
    const l = M.ordenes.aLocal({ estado: "presupuesto", presupuesto_estado: "aprobado", aprobado_en: "2026-09-29T10:00:00Z", rechazado_en: null, aprobacion_via: "local",
      orden_items: [{ id: ITEM, nombre: "Aceite", cantidad: 3, precio: 120, costo_unitario: 90, inventario_id: INV, tipo: "repuesto_inventario", cantidad_aplicada: 3, aplicada_legado: 1, creado_en: "x" }] });
    assert.deepEqual([l.presupuestoEstado, l.aprobadoEn, l.rechazadoEn, l.aprobacionVia], ["aprobado", Date.parse("2026-09-29T10:00:00Z"), null, "local"]);
    assert.deepEqual(J(l.items[0]), { uid: ITEM, nombre: "Aceite", cantidad: 3, precio: 120, costoUnitario: 90, costoEstimado: false, inventarioUid: INV, origenInventarioId: null,
      tipo: "repuesto_inventario", cantidadAplicada: 3, aplicadaLegado: 1 });
    for (const c of ["presupuestoEstado", "aprobadoEn", "rechazadoEn", "aprobacionVia"]) assert.ok(M.ordenes.soloServidor.includes(c), c);
    assert.ok(!("presupuesto_estado" in M.ordenes.aCloud({ presupuestoEstado: "aprobado" })), "el estado del presupuesto nunca sube por el CRUD");
    assert.ok(!M.ordenes.columnas.includes("presupuesto_estado"));
    const sin = M.ordenes.aLocal({ estado: "presupuesto" });
    assert.ok(!("presupuestoEstado" in sin), "una respuesta sin el campo (PATCH) no lo pisa");
  });
  test("cotizaciones: el tipo del renglón baja; un renglón viejo sin tipo baja como null", () => {
    assert.match(M.cotizaciones.select, /cotizacion_items\([^)]*tipo/);
    const c = M.cotizaciones.aLocal({ cliente_nombre: "x", cotizacion_items: [{ nombre: "Afinado", cantidad: 1, precio: 300, inventario_id: null, tipo: "mano_obra" },
      { nombre: "aceite bajaj", cantidad: 1, precio: 250, inventario_id: null, tipo: null }] });
    assert.deepEqual(c.items.map((x) => x.tipo), ["mano_obra", null]);
  });
  test("Mi Trabajo (mecánico): sigue sin precio, costo ni estado financiero del presupuesto", () => {
    const mec = cargar("mecanico").ENTIMOTORS_SYNC_MAPPERS.ordenes.aLocal({ estado: "presupuesto", presupuesto_estado: "aprobado", items: [{ nombre: "Aceite", cantidad: 1, precio: 9 }] });
    assert.deepEqual(J(mec.items), [{ nombre: "Aceite", cantidad: 1 }]);
    assert.ok(!("presupuestoEstado" in mec));
  });
});
