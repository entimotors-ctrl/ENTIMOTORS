// SYNC-7B · piezas PURAS/MOCKEABLES sin navegador ni Docker: taller-demo/sync-finanzas.js (constructores de
// parámetros de las RPC de dinero/stock + orquestador outbox/PIN), los mappers financieros de solo lectura de
// sync-mappers.js, los cambios aditivos de sync-engine.js (rpcInmediato con op_id, soloLectura, refsALocal) y la
// clasificación HTTP de sync-rest.js para los ERRCODE que SYNC-7B consume. Lo que necesita Postgres+PostgREST
// reales (atomicidad, ledger, concurrencia, PIN real, invariantes) vive en pruebas/sync/sql/05-finanzas.test.sql
// y pruebas/sync/browser/sync7b-*.test.mjs — este archivo NO los sustituye.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leer = (f) => fs.readFileSync(path.join(RAIZ, "taller-demo", f), "utf8");
const J = (x) => JSON.parse(JSON.stringify(x));
function cargar(archivos, extra = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Math, Date, ...extra });
  for (const f of archivos) vm.runInContext(leer(f), ctx, { filename: f });
  return ctx;
}
function contador(prefijo = "u") { let n = 0; return () => `${prefijo}-${++n}`; }

const ctx = cargar(["sync-rest.js", "sync-engine.js", "sync-mappers.js", "sync-finanzas.js"]);
const F = () => ctx.SyncFinanzas.construir({ uuid: contador("id") });
const OCURRIO = "2026-09-22T15:00:00.000Z";

/* ---------------- constructores (mappers de operación) ---------------- */
describe("SYNC-7B · constructores de operaciones (sync-finanzas.js)", () => {
  test("venta: parámetros exactos de registrar_venta_v2, inventario por UUID de nube, ids generados UNA vez", () => {
    const op = F().venta({
      items: [{ inventarioId: 7, inventarioUid: "inv-uuid-7", nombre: "Aceite", cantidad: 2, precio: 180 },
              { inventarioId: null, nombre: "Mano de obra", cantidad: 1, precio: 100.005 }],
      clienteUid: "cli-uuid", clienteNombre: "Ana", metodoPago: "efectivo", efectivoRecibido: 500,
      ocurrioEn: OCURRIO, offline: false, deviceId: "dev-1",
    });
    assert.equal(op.rpc, "registrar_venta_v2");
    assert.deepEqual(J(op.meta), { entidad: "ventas_rapidas", uid: "id-1", crea: true });   // SYNC-8: da de alta su uid
    assert.deepEqual(J(op.params), {
      p_venta_id: "id-1", p_cliente_id: "cli-uuid", p_cliente_nombre: "Ana", p_metodo_pago: "efectivo", p_efectivo: 500,
      p_items: [{ item_id: "id-2", inventario_id: "inv-uuid-7", nombre: "Aceite", cantidad: 2, precio: 180 },
                { item_id: "id-3", inventario_id: null, nombre: "Mano de obra", cantidad: 1, precio: 100.01 }],
      p_occurred_at: OCURRIO, p_offline: false, p_device: "dev-1",
    });
    assert.ok(!JSON.stringify(op.params).includes('"inventario_id":7'), "el id entero local nunca es identidad global");
  });

  test("venta: un repuesto sin UUID de nube, cantidad ≤0, precio <0 o carrito vacío se rechazan ANTES de encolar", () => {
    const f = F();
    assert.throws(() => f.venta({ items: [{ inventarioId: 3, nombre: "X", cantidad: 1, precio: 1 }], metodoPago: "efectivo" }), /identidad en la nube/);
    assert.throws(() => f.venta({ items: [{ nombre: "X", cantidad: 0, precio: 1 }], metodoPago: "efectivo" }), /Cantidad/);
    assert.throws(() => f.venta({ items: [{ nombre: "X", cantidad: 1, precio: -1 }], metodoPago: "efectivo" }), /Precio/);
    assert.throws(() => f.venta({ items: [], metodoPago: "efectivo" }), /vacío/);
    assert.throws(() => f.venta({ items: [{ nombre: "X", cantidad: 1, precio: 1 }], metodoPago: "" }), /método de pago/);
  });

  test("venta con tarjeta: p_efectivo nulo; offline se decide al crear (p_offline true)", () => {
    const op = F().venta({ items: [{ nombre: "X", cantidad: 1, precio: 10 }], metodoPago: "tarjeta", efectivoRecibido: 999, ocurrioEn: OCURRIO, offline: true });
    assert.equal(op.params.p_efectivo, null);
    assert.equal(op.params.p_offline, true);
  });

  test("crédito: registrar_credito con entrada ATÓMICA (p_abono_inicial), origen y orden por UUID", () => {
    const op = F().credito({
      items: [{ inventarioId: 1, inventarioUid: "inv-1", nombre: "Kit", cantidad: 1, precio: 300 }],
      clienteUid: "c-1", clienteNombre: "Luis", clienteTelefono: "9999", abonoInicial: 100, abonoMetodo: "transferencia",
      origen: "pos", ordenUid: null, ocurrioEn: OCURRIO, offline: false, deviceId: "d",
    });
    assert.equal(op.rpc, "registrar_credito");
    assert.equal(op.params.p_credito_id, op.meta.uid);
    assert.equal(op.meta.crea, true, "SYNC-8: el crédito da de alta su uid (sus abonos sin red esperan a que exista)");
    assert.equal(op.params.p_abono_inicial, 100);
    assert.equal(op.params.p_abono_metodo, "transferencia");
    assert.equal(op.params.p_items[0].inventario_id, "inv-1");
    assert.equal(op.params.p_origen, "pos");
    assert.throws(() => F().credito({ items: [{ nombre: "A", cantidad: 1, precio: 10 }], clienteNombre: "L", abonoInicial: 11 }), /supera el total/);
    assert.throws(() => F().credito({ items: [{ nombre: "A", cantidad: 1, precio: 10 }], clienteNombre: "" }), /cliente/);
  });

  test("abono: registrar_abono_v2 por UUID del crédito; monto redondeado; nunca monto ≤ 0", () => {
    const op = F().abono({ creditoUid: "cr-1", monto: 50.555, metodo: "efectivo", ocurrioEn: OCURRIO, deviceId: "d" });
    assert.equal(op.rpc, "registrar_abono_v2");
    assert.deepEqual(J(op.params), { p_credito_id: "cr-1", p_monto: 50.56, p_metodo: "efectivo", p_occurred_at: OCURRIO, p_device: "d" });
    assert.deepEqual(J(op.meta), { entidad: "creditos", uid: "cr-1" });   // un abono NO da de alta nada (SYNC-8)
    assert.throws(() => F().abono({ creditoUid: "cr-1", monto: 0 }), /mayor a cero/);
    assert.throws(() => F().abono({ monto: 5 }), /identidad/);
  });

  test("caja: registrar_movimiento_caja solo ingreso/egreso y monto > 0", () => {
    const op = F().movimientoCaja({ tipo: "egreso", categoria: "Compra de repuestos", monto: 900, metodo: "efectivo", descripcion: "x", ocurrioEn: OCURRIO, deviceId: "d" });
    assert.equal(op.rpc, "registrar_movimiento_caja");
    assert.equal(op.params.p_tipo, "egreso");
    assert.equal(op.params.p_monto, 900);
    assert.throws(() => F().movimientoCaja({ tipo: "otro", monto: 1 }), /Tipo/);
    assert.throws(() => F().movimientoCaja({ tipo: "ingreso", monto: -3 }), /mayor a cero/);
  });

  test("órdenes: agregar/quitar ítem y finalizar arman sus RPC transaccionales (stock por ledger, nunca DB.save de cantidad)", () => {
    const f = F();
    const ag = f.itemOrden({ ordenUid: "o-1", inventarioId: 4, inventarioUid: "inv-4", nombre: "Bujía", cantidad: 2, precio: 50, offline: true, ocurrioEn: OCURRIO, deviceId: "d" });
    assert.equal(ag.rpc, "agregar_item_orden");
    assert.equal(ag.params.p_inventario_id, "inv-4");
    assert.equal(ag.params.p_offline, true);
    assert.ok(ag.params.p_item_id, "el id del renglón se genera antes de enviar: quitar_item_orden lo usará");
    assert.deepEqual(J(ag.meta), { entidad: "ordenes", uid: "o-1" });
    const q = f.quitarItemOrden({ itemUid: ag.params.p_item_id, ordenUid: "o-1", deviceId: "d" });
    assert.deepEqual(J(q.params), { p_item_id: ag.params.p_item_id, p_device: "d" });
    assert.throws(() => f.quitarItemOrden({ ordenUid: "o-1" }), /identidad/);
    const fin = f.finalizarOrden({ ordenUid: "o-1", tipoCobro: "credito", abono: 20, ocurrioEn: OCURRIO, deviceId: "d" });
    assert.equal(fin.rpc, "finalizar_orden");
    assert.ok(fin.params.p_credito_id, "crédito: el id del crédito se fija antes de enviar");
    const cont = f.finalizarOrden({ ordenUid: "o-1", tipoCobro: "contado", metodoPago: "tarjeta", abono: 20 });
    assert.equal(cont.params.p_credito_id, null);
    assert.equal(cont.params.p_abono, 0);
    assert.throws(() => f.itemOrden({ ordenUid: "o", inventarioId: 3, nombre: "x", cantidad: 1, precio: 1 }), /identidad/);
  });

  test("reversos y ajuste: motivo obligatorio, registro y MONTO del hash crítico iguales a los que usa el servidor", () => {
    const f = F();
    const rv = f.reversarVenta({ ventaUid: "v-1", total: 460, motivo: "cliente devolvió todo", deviceId: "d" });
    assert.equal(rv.rpc, "reversar_venta"); assert.equal(rv.registro, "v-1"); assert.equal(rv.monto, 460);
    const dv = f.devolucion({ ventaUid: "v-1", items: [{ ventaItemUid: "vi-1", cantidad: 1, precio: 180.004 }], motivo: "falla", deviceId: "d" });
    assert.deepEqual(J(dv.params.p_items), [{ venta_item_id: "vi-1", cantidad: 1 }]);
    assert.equal(dv.monto, 180, "igual que registrar_devolucion: round(cantidad*precio, 2)");
    assert.equal(f.reversarAbono({ abonoUid: "a", monto: 50, motivo: "error" }).monto, 50);
    assert.equal(f.reversarCredito({ creditoUid: "c", total: 300, motivo: "error" }).monto, 300);
    assert.equal(f.reversarCaja({ cajaUid: "m", monto: 900, motivo: "error" }).rpc, "reversar_caja");
    const an = f.anularOrden({ ordenUid: "o", motivo: "error", devolverStock: true, deviceId: "d" });
    assert.equal(an.params.p_devolver_stock, true); assert.equal(an.monto, null);
    const aj = f.ajusteStock({ inventarioUid: "i", delta: -2, motivo: "rotura", deviceId: "d" });
    assert.equal(aj.params.p_delta, -2); assert.equal(aj.params.p_conteo, null); assert.equal(aj.monto, -2, "monto = v_delta del servidor");
    const cn = f.ajusteStock({ inventarioUid: "i", conteo: 7, motivo: "conteo físico" });
    assert.equal(cn.params.p_conteo, 7); assert.equal(cn.monto, null);
    assert.throws(() => f.ajusteStock({ inventarioUid: "i", delta: 1, conteo: 2, motivo: "abc" }), /uno solo/);
    assert.throws(() => f.ajusteStock({ inventarioUid: "i", delta: 0, motivo: "abc" }), /distinta de cero/);
    for (const fn of ["reversarVenta", "reversarAbono", "reversarCredito", "reversarCaja", "anularOrden"]) {
      assert.throws(() => f[fn]({ ventaUid: "x", abonoUid: "x", creditoUid: "x", cajaUid: "x", ordenUid: "x", motivo: "no" }), /motivo/, fn);
    }
    for (const a of [rv, dv, an, aj]) assert.ok(!("p_autorizacion" in a.params), "la autorización la pone quien ejecuta, nunca el constructor");
  });
});

/* ---------------- orquestador: outbox (offline-safe, idempotente) ---------------- */
function motorYBase({ respuestas = [], estadoTrasFlush } = {}) {
  const cola = new Map(); let seq = 0; const escuchas = []; const log = { encolar: [], flush: 0, rpc: [] };
  const motor = {
    onCambio(f) { escuchas.push(f); return () => { const i = escuchas.indexOf(f); if (i >= 0) escuchas.splice(i, 1); }; },
    async encolarRpc(nombre, params, meta) {
      ctx.SyncEngine.puras.verificarSinPin(nombre, params);
      const op = { seq: ++seq, op_id: meta.op_id, rpc: nombre, params: J({ ...params, p_op: meta.op_id }), estado: "pending", entidad: meta.entidad, uid: meta.uid };
      cola.set(op.seq, op); log.encolar.push(J(op)); return { seq: op.seq, op_id: op.op_id };
    },
    async flush() {
      log.flush++;
      const r = respuestas.shift() || estadoTrasFlush;
      for (const op of cola.values()) {
        if (op.estado !== "pending") continue;
        if (r.ok) { cola.delete(op.seq); escuchas.forEach((f) => f({ tipo: "rpc-ok", datos: { op_id: op.op_id, resultado: r.datos } })); }
        else if (r.terminal) { op.estado = "rejected"; op.error = r.error; }
        else if (r.error) { op.error = r.error; }
      }
    },
    async rpcInmediato(nombre, params, o) { log.rpc.push({ nombre, params: J(params), op_id: o && o.op_id }); return respuestas.shift() || { ok: true, datos: {} }; },
  };
  const bd = { outbox: { get: async (s) => cola.get(s) || null, borrar: async (s) => { cola.delete(s); } } };
  return { motor, bd, cola, log };
}

describe("SYNC-7B · ejecutar() por el outbox", () => {
  test("offline: la venta queda en la cola con operation_id estable y NO se intenta enviar (OFFLINE_SALE_ACCEPT_AND_REVIEW)", async () => {
    const { motor, bd, cola, log } = motorYBase();
    const fin = ctx.SyncFinanzas.crear({ motor, bd, enLinea: () => false, uuid: contador("op") });
    const op = F().venta({ items: [{ inventarioId: 1, inventarioUid: "i1", nombre: "A", cantidad: 3, precio: 10 }], metodoPago: "efectivo", ocurrioEn: OCURRIO, offline: true });
    const r = await fin.ejecutar(op);
    assert.equal(r.estado, "pendiente");
    assert.equal(log.flush, 0);
    assert.equal(cola.size, 1, "la venta NO se pierde: sigue en el outbox");
    const enCola = [...cola.values()][0];
    assert.equal(enCola.params.p_op, r.op_id, "p_op = el operation_id generado UNA vez");
    assert.equal(enCola.params.p_offline, true);
    assert.equal(enCola.params.p_items[0].cantidad, 3, "nunca se recorta la cantidad");
  });

  test("online OK: devuelve el resultado del servidor y la operación sale de la cola", async () => {
    const { motor, bd, cola } = motorYBase({ respuestas: [{ ok: true, datos: { venta_id: "v", total: 30, stock_negativo: [] } }] });
    const fin = ctx.SyncFinanzas.crear({ motor, bd, enLinea: () => true, uuid: contador("op"), esperar: async () => {} });
    const r = await fin.ejecutar(F().venta({ items: [{ nombre: "A", cantidad: 3, precio: 10 }], metodoPago: "efectivo", ocurrioEn: OCURRIO }));
    assert.equal(r.estado, "ok");
    assert.equal(r.resultado.total, 30);
    assert.equal(cola.size, 0);
  });

  test("online con error 5xx/red: queda PENDIENTE con el MISMO op y los MISMOS bytes (reintento = una sola afectación)", async () => {
    const { motor, bd, cola, log } = motorYBase({ estadoTrasFlush: { error: { clase: "servidor", codigo: "500" } } });
    const fin = ctx.SyncFinanzas.crear({ motor, bd, enLinea: () => true, uuid: contador("op"), esperar: async () => {} });
    const r = await fin.ejecutar(F().abono({ creditoUid: "c", monto: 10, ocurrioEn: OCURRIO }));
    assert.equal(r.estado, "pendiente");
    assert.equal(cola.size, 1);
    const antes = JSON.stringify(log.encolar[0].params);
    await motor.flush(); await motor.flush();
    assert.equal(JSON.stringify([...cola.values()][0].params), antes, "los reintentos no cambian ni un byte (hash del servidor estable)");
    assert.equal(log.encolar.length, 1, "nunca se encola dos veces");
  });

  test("online con rechazo terminal (4xx: sin stock, abono > saldo): estado rechazada; descartarRechazo la retira", async () => {
    const { motor, bd, cola } = motorYBase({ estadoTrasFlush: { terminal: true, error: { clase: "validacion", codigo: "23514", mensaje: "Sin stock suficiente de A" } } });
    const fin = ctx.SyncFinanzas.crear({ motor, bd, enLinea: () => true, uuid: contador("op"), esperar: async () => {} });
    const r = await fin.ejecutar(F().venta({ items: [{ nombre: "A", cantidad: 3, precio: 10 }], metodoPago: "efectivo", ocurrioEn: OCURRIO }));
    assert.equal(r.estado, "rechazada");
    assert.match(r.error.mensaje, /Sin stock/);
    await fin.descartarRechazo(r.seq);
    assert.equal(cola.size, 0);
  });

  test("una acción con PIN jamás entra al outbox (el motor la rechaza)", async () => {
    const { motor, bd } = motorYBase();
    const fin = ctx.SyncFinanzas.crear({ motor, bd, enLinea: () => true, uuid: contador("op") });
    const a = F().reversarVenta({ ventaUid: "v", total: 1, motivo: "error" });
    await assert.rejects(fin.ejecutar({ rpc: a.rpc, params: a.params, meta: { entidad: "ventas_rapidas", uid: "v" } }), /PIN/);
  });
});

/* ---------------- acciones con autorización (PIN) ---------------- */
describe("SYNC-7B · conAutorizacion() — PIN real del cajero, admin directo, mecánico negado", () => {
  const accion = () => F().reversarVenta({ ventaUid: "v-1", total: 460, motivo: "anulación", deviceId: "dev-A" });

  test("cajero: pide autorización ligada a acción/registro/dispositivo/monto y la manda como p_autorizacion", async () => {
    const { motor, bd, log } = motorYBase({ respuestas: [{ ok: true, datos: { reverso_id: "r" } }] });
    const pedidas = [];
    const fin = ctx.SyncFinanzas.crear({ motor, bd, enLinea: () => true, uuid: contador("op"),
      autorizar: async (o) => { pedidas.push(J(o)); return { ok: true, admin: false, autorizacion_id: "aut-1" }; } });
    const r = await fin.conAutorizacion(accion(), "cajero");
    assert.equal(r.ok, true);
    assert.deepEqual(pedidas, [{ accion: "reversar_venta", rol: "cajero", registroId: "v-1", monto: 460, deviceId: "dev-A" }]);
    assert.equal(log.rpc[0].params.p_autorizacion, "aut-1");
    assert.equal(log.rpc[0].params.p_device, "dev-A", "el mismo dispositivo con el que se emitió (sync_autorizar lo exige)");
    assert.ok(log.rpc[0].op_id);
  });

  test("admin: sin PIN (p_autorizacion nulo), pero igual en línea", async () => {
    const { motor, bd, log } = motorYBase({ respuestas: [{ ok: true, datos: {} }] });
    const fin = ctx.SyncFinanzas.crear({ motor, bd, uuid: contador("op"), enLinea: () => true, autorizar: async () => ({ ok: true, admin: true, autorizacion_id: null }) });
    assert.equal((await fin.conAutorizacion(accion(), "admin")).ok, true);
    assert.equal(log.rpc[0].params.p_autorizacion, null);
  });

  test("PIN offline: denegado ANTES de pedir el PIN, con el mensaje exacto, sin red y sin cola", async () => {
    const { motor, bd, log, cola } = motorYBase();
    let pedido = false;
    const fin = ctx.SyncFinanzas.crear({ motor, bd, uuid: contador("op"), enLinea: () => false, autorizar: async () => { pedido = true; return { ok: true }; } });
    for (const rol of ["cajero", "admin"]) {
      const r = await fin.conAutorizacion(accion(), rol);
      assert.equal(r.ok, false);
      assert.equal(r.mensaje, "Esta operación requiere conexión para obtener autorización del administrador.");
    }
    assert.equal(pedido, false); assert.equal(log.rpc.length, 0); assert.equal(cola.size, 0);
  });

  test("mecánico (o rol desconocido): negado sin pedir PIN ni llamar a la red", async () => {
    const { motor, bd, log } = motorYBase();
    let pedido = false;
    const fin = ctx.SyncFinanzas.crear({ motor, bd, uuid: contador("op"), enLinea: () => true, autorizar: async () => { pedido = true; return { ok: true }; } });
    for (const rol of ["mecanico", "desarrollador", undefined]) assert.equal((await fin.conAutorizacion(accion(), rol)).ok, false);
    assert.equal(pedido, false); assert.equal(log.rpc.length, 0);
  });

  test("PIN incorrecto: no se ejecuta la RPC; corte de red al enviar: UN reintento con el MISMO op_id", async () => {
    const m1 = motorYBase();
    const fin1 = ctx.SyncFinanzas.crear({ motor: m1.motor, bd: m1.bd, uuid: contador("op"), enLinea: () => true, autorizar: async () => ({ ok: false, motivo: "PIN_INCORRECTO", mensaje: "PIN incorrecto." }) });
    assert.equal((await fin1.conAutorizacion(accion(), "cajero")).ok, false);
    assert.equal(m1.log.rpc.length, 0);
    const m2 = motorYBase({ respuestas: [{ ok: false, clase: "red", codigo: "SIN_RED" }, { ok: true, datos: { repetida: true } }] });
    const fin2 = ctx.SyncFinanzas.crear({ motor: m2.motor, bd: m2.bd, uuid: contador("op"), enLinea: () => true, autorizar: async () => ({ ok: true, autorizacion_id: "a" }) });
    const r = await fin2.conAutorizacion(accion(), "cajero");
    assert.equal(r.ok, true);
    assert.equal(m2.log.rpc.length, 2);
    assert.equal(m2.log.rpc[0].op_id, m2.log.rpc[1].op_id);
  });

  test("el PIN nunca aparece en parámetros, cola ni resultado (sync-finanzas.js no lo recibe jamás)", async () => {
    const { motor, bd, log } = motorYBase({ respuestas: [{ ok: true, datos: {} }] });
    const fin = ctx.SyncFinanzas.crear({ motor, bd, uuid: contador("op"), enLinea: () => true, autorizar: async () => ({ ok: true, autorizacion_id: "a" }) });
    const r = await fin.conAutorizacion(accion(), "cajero");
    const todo = JSON.stringify([log, r]);
    assert.ok(!/"pin"|123456/i.test(todo));
    const fuente = leer("sync-finanzas.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/\bpin\b/i.test(fuente.replace(/SIN_CONEXION_PIN/g, "")), "el código no maneja ningún PIN");
    assert.ok(!/localStorage|sessionStorage|indexedDB|console\./.test(fuente));
  });
});

/* ---------------- motor, mappers y clasificación ---------------- */
describe("SYNC-7B · motor, mappers financieros y clasificación HTTP", () => {
  function motorReal(rest, mappers = ctx.ENTIMOTORS_SYNC_MAPPERS) {
    const outbox = [];
    const bd = {
      deviceId: async () => "dev", transaccion: async (_t, _m, fn) => fn({ add: async (s, v) => { outbox.push(v); return outbox.length; } }),
    };
    const motor = ctx.SyncEngine.crearMotor({ bd, rest, mappers, uuid: contador("op"), sesion: () => ({ uid: "u1" }), habilitado: () => true });
    return { motor, outbox };
  }

  test("p_op (regresión SYNC-5): rpcInmediato usa el op_id dado por la UI; encolarRpc respeta meta.op_id", async () => {
    const llam = [];
    const { motor, outbox } = motorReal({ rpc: async (n, p) => { llam.push(p); return { ok: true, datos: {} }; } });
    const r = await motor.rpcInmediato("reversar_caja", { p_caja_id: "c" }, { op_id: "fijo-1" });
    assert.equal(llam[0].p_op, "fijo-1"); assert.equal(r.op_id, "fijo-1");
    assert.ok(!("p_op_id" in llam[0]));
    await motor.encolarRpc("registrar_venta_v2", { p_items: [] }, { entidad: "ventas_rapidas", uid: "v", op_id: "fijo-2" });
    assert.equal(outbox[0].params.p_op, "fijo-2"); assert.equal(outbox[0].op_id, "fijo-2");
  });

  test("dinero es SOLO LECTURA por el CRUD: escribir()/borrar sobre ventas, créditos o caja lanza (sin hard-delete)", async () => {
    const { motor } = motorReal({});
    for (const e of ["ventas_rapidas", "creditos", "caja_movimientos"]) {
      await assert.rejects(motor.escribir(e, { id: 1 }, { borrar: true }), /solo se modifica por su operación/);
      await assert.rejects(motor.escribir(e, { total: 5 }), /solo se modifica por su operación/);
      assert.equal(ctx.ENTIMOTORS_SYNC_MAPPERS[e].soloLectura, true);
      assert.deepEqual(J(ctx.ENTIMOTORS_SYNC_MAPPERS[e].columnas), []);
    }
  });

  test("inventario: cantidad BAJA de la nube (autoridad) pero NUNCA sube (no está en columnas ni en aCloud)", () => {
    const inv = ctx.ENTIMOTORS_SYNC_MAPPERS.inventario;
    assert.ok(!inv.columnas.includes("cantidad"));
    assert.ok(!("cantidad" in inv.aCloud({ nombre: "x", cantidad: 99 })));
    const l = inv.aLocal({ nombre: "x", cantidad: "-2.00", requiere_revision: true, precio_venta: 1, costo_compra: 1 });
    assert.equal(l.cantidad, -2); assert.equal(l.requiereRevision, true);
  });

  test("mappers financieros: venta/crédito/caja con la forma local de siempre; renglones resuelven el repuesto por el mapa", async () => {
    const M = ctx.ENTIMOTORS_SYNC_MAPPERS;
    const v = M.ventas_rapidas.aLocal({ id: "v", metodo_pago: "efectivo", total: "460.00", efectivo_recibido: "500", cambio: "40", creado_en: OCURRIO, occurred_at: "2026-09-22T10:00:00Z", anulada: false,
      venta_items: [{ id: "vi", inventario_id: "inv-1", nombre: "A", cantidad: "2", precio: "180", costo_unitario: "110", costo_estimado: false }] });
    assert.equal(v.total, 460); assert.equal(v.fechaISO, "2026-09-22T10:00:00.000Z"); assert.equal(v.items[0].uid, "vi");
    const v2 = await M.ventas_rapidas.refsALocal(v, async (uid) => (uid === "inv-1" ? 7 : null));
    assert.equal(v2.items[0].inventarioId, 7);
    const c = M.creditos.aLocal({ total: "300", abonado: "100", saldo: "200", estado: "parcial", cliente_nombre: "L", creado_en: OCURRIO, anulado: false, credito_items: [],
      abonos: [{ id: "a2", id_abono: "x2", monto: "50", metodo_pago: "efectivo", creado_en: "2026-09-22T12:00:00Z", anulado: true },
               { id: "a1", id_abono: "x1", monto: "100", metodo_pago: "efectivo", creado_en: "2026-09-22T11:00:00Z", anulado: false }] });
    assert.deepEqual(J(c.historialAbonos.map((a) => a.uid)), ["a1"], "los abonos revertidos no cuentan en el historial vigente");
    assert.equal(c.abonosAnulados.length, 1);
    const m = M.caja_movimientos.aLocal({ tipo: "egreso", monto: "460", categoria: "Reverso venta", reverso_de: "m-0", creado_en: OCURRIO });
    assert.equal(m.reversoDe, "m-0"); assert.equal(m.monto, 460);
    assert.deepEqual(J(M.caja_movimientos.fks.map((f) => f.entidad)), ["ventas_rapidas", "creditos", "ordenes"]);
    const orden = [...ctx.ENTIMOTORS_SYNC_ORDEN];
    assert.ok(orden.indexOf("caja_movimientos") > orden.indexOf("ventas_rapidas") && orden.indexOf("caja_movimientos") > orden.indexOf("creditos") && orden.indexOf("creditos") > orden.indexOf("ordenes"));
  });

  test("build del mecánico: NO carga los mappers de dinero ni los baja", () => {
    const mec = cargar(["sync-mappers.js"], { ENTIMOTORS_BUILD: { producto: "mecanico" }, window: undefined });
    assert.equal(mec.ENTIMOTORS_SYNC_MAPPERS.ventas_rapidas, undefined);
    assert.ok(!mec.ENTIMOTORS_SYNC_ORDEN.includes("caja_movimientos"));
  });

  test("clasificación: validaciones terminales NO se reintentan; temporales sí (ERRCODE que consume SYNC-7B)", () => {
    const k = (st, code) => ctx.SyncRest.clasificar(st, { code, message: "m" }).clase;
    assert.equal(k(400, "23514"), "validacion", "stock insuficiente online / abono > saldo");
    assert.equal(k(400, "22023"), "validacion");
    assert.equal(k(400, "22000"), "validacion", "ya anulada / ya finalizada");
    assert.equal(k(409, "23503"), "conflicto", "SYNC-7B: 'X no existe' (antes P0002 → 500 → reintento infinito)");
    assert.equal(k(409, "23505"), "conflicto", "OP_ID_REUTILIZADO");
    assert.equal(k(403, "42501"), "permiso", "rol sin permiso / AUTORIZACION_INVALIDA");
    assert.equal(k(500, "55P03"), "servidor", "lock_timeout: temporal, se reintenta");
    assert.equal(k(500, "40P01"), "servidor", "deadlock: temporal");
    assert.equal(k(503, "53300"), "servidor");
  });

  test("SQL: ningún 'no existe' de las RPC de dinero sigue en P0002, ni hay DELETE de tablas financieras en las RPC", () => {
    const sql = fs.readFileSync(path.join(RAIZ, "taller-demo/supabase/sync/sync-3-rpc.sql"), "utf8");
    const sql7a = fs.readFileSync(path.join(RAIZ, "taller-demo/supabase/sync/sync-7a-inventario.sql"), "utf8");
    assert.ok(!/ERRCODE = 'P0002'/.test(sql) && !/ERRCODE = 'P0002'/.test(sql7a));
    assert.ok(!/DELETE\s+FROM\s+public\.(ventas|venta_items|creditos|credito_items|abonos|caja_movimientos|inventario_movimientos|reversos)\b/i.test(sql));
    assert.ok(!/UPDATE\s+public\.inventario\s+SET\s+cantidad/i.test(sql), "la cantidad solo la mueve el trigger del ledger");
    assert.match(sql, /a\.device_id IS NOT DISTINCT FROM p_device/, "la autorización queda ligada al dispositivo");
    const llamadas = sql.match(/public\.sync_autorizar\(p_autorizacion[^;]*/g) || [];
    assert.equal(llamadas.length, 7);
    for (const l of llamadas) assert.match(l, /p_device\)\)/);
  });

  test("app.js: en modo nube DB.save/DB.delete de dinero lanzan, y ninguna rama nube escribe inventario.cantidad", () => {
    const app = leer("app.js");
    assert.match(app, /ENTIDADES_FINANCIERAS\.includes\(store\)\) throw new Error\("FINANCIERO_SOLO_RPC/);
    assert.equal((app.match(/FINANCIERO_SOLO_RPC/g) || []).length, 2, "save y delete");
    const nube = app.slice(app.indexOf("SYNC-7B · DINERO Y STOCK EN MODO NUBE"), app.indexOf("const ALL_STORES"));
    assert.ok(!/\.cantidad\s*[-+]?=/.test(nube) && !/DB\.save\("inventario"/.test(nube), "el bloque nube no toca cantidad");
    assert.ok(/<script src="sync-finanzas\.js/.test(fs.readFileSync(path.join(RAIZ, "taller-demo/index.html"), "utf8")));
    assert.ok(leer("sw.js").includes("./sync-finanzas.js"), "sync-finanzas.js en el SHELL del service worker");
  });
});

/* ---------------- shim de auth de las pruebas: jamás alcanzable en producción ---------------- */
test("shim /auth/v1 SOLO en pruebas/sync: ni el api-server ni las apps lo contienen ni tienen un bypass activable", () => {
  const recorrer = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", "uploads"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p, out); else if (/\.(m?js|ts|html|json)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const prod = [...recorrer(path.join(RAIZ, "api-server/src")), ...recorrer(path.join(RAIZ, "taller-demo"))];
  for (const f of prod) {
    const t = fs.readFileSync(f, "utf8");
    assert.ok(!/CLAVE_CUENTA_PRUEBA|shimAuth|verificarJwtLocal|clave-sintetica-solo-pruebas|secreto-sintetico-solo-pruebas/.test(t), "rastro del shim en " + f);
    assert.ok(!/(SALTAR|SKIP|BYPASS|OMITIR)_?(AUTH|SESION|PIN)/i.test(t), "bandera de bypass en " + f);
  }
  const pin = fs.readFileSync(path.join(RAIZ, "api-server/src/routes/pin.ts"), "utf8");
  assert.match(pin, /servidor\.auth\.getUser\(token\)/, "el backend sigue validando la sesión con Supabase Auth");
  const pila = fs.readFileSync(path.join(RAIZ, "pruebas/sync/browser/lib/pila.mjs"), "utf8");
  assert.match(pila, /srv\.listen\(REST_PUERTO, "127\.0\.0\.1"/, "el gateway (y su shim) solo escucha en loopback");
  assert.match(pila, /timingSafeEqual/, "el shim verifica la firma del JWT local, no confía en cabeceras");
});
