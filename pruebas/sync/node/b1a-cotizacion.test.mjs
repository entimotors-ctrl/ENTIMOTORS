// SYNC-8 · HARDENING OFFLINE: recuperación tras cierre, reintentos/backoff, errores terminales, sesión caducada, cambio de
// usuario, device_id, orden de dependencias, pull tras flush, bootstrap interrumpido, paginación, llaves foráneas
// pendientes, ítems de orden, multi-pestaña, requiere revisión. Corre el código REAL (sync-db.js + sync-engine.js +
// sync-rest.js + sync-mappers.js) sobre una IndexedDB en memoria (helpers/idb-memoria.mjs) y un servidor falso con la
// semántica mínima de PostgREST (idempotencia por op_id, PATCH condicionado por rev, 23503, cursor updated_at/id).
// La prueba contra Postgres + PostgREST reales está en pruebas/sync/browser/sync8-core.test.mjs.
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

function cargar({ idb = crearFabrica(), mecanico = false, fetch } = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, Date, Promise, JSON, Math, structuredClone,
    crypto: globalThis.crypto, indexedDB: idb, navigator: { onLine: true }, fetch, ENTIMOTORS_BUILD: { producto: mecanico ? "mecanico" : "admin" } });
  for (const f of ["sync-rest.js", "sync-db.js", "sync-engine.js", "sync-mappers.js", "sync-finanzas.js"]) vm.runInContext(leer(f), ctx, { filename: f });
  ctx.__idb = idb;
  return ctx;
}
const P = cargar().SyncEngine.puras;

/* Mappers de prueba (mismo contrato que los reales): clientes y motos con llave foránea. */
const MAPPERS = {
  clientes: { entidad: "clientes", tabla: "clientes", store: "clientes", columnas: ["nombre", "telefono"], tiempos: [], fks: [],
    aCloud: (l) => ({ nombre: l.nombre, telefono: l.telefono || null }), aLocal: (r) => ({ nombre: r.nombre, telefono: r.telefono }) },
  motos: { entidad: "motos", tabla: "motos", store: "motos", columnas: ["placa"], tiempos: [], fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }],
    aCloud: (l) => ({ placa: l.placa || null }), aLocal: (r) => ({ placa: r.placa }) },
};

/* ---------- servidor falso (nivel PostgREST, NO HTTP) ---------- */
function servidor() {
  let reloj = 0;
  const tablas = {}, opsHechas = new Map(), llamadas = [];
  const t = (n) => (tablas[n] ||= new Map());
  const sello = () => new Date(1790000000000 + (++reloj) * 1000).toISOString();
  const FK = { motos: { cliente_id: "clientes" } };
  const srv = {
    tablas, llamadas, opsHechas, fallas: [], rpcs: {}, perfiles: [{ id: "u-a", rol: "cajero", activo: true }, { id: "u-b", rol: "admin", activo: true }],
    efectos: {},   // rpc → cuántas veces se aplicó DE VERDAD (una sola por op_id)
    fila: (tabla, id) => { const r = t(tabla).get(id); return r ? structuredClone(r) : null; },
    sembrar(tabla, filas) { for (const f of filas) t(tabla).set(f.id, { rev: 1, deleted_at: null, ...f, updated_at: f.updated_at || sello() }); },
  };
  const falla = (metodo, tabla) => { const i = srv.fallas.findIndex((f) => f.metodo === metodo && (!f.tabla || f.tabla === tabla)); return i < 0 ? null : srv.fallas.splice(i, 1)[0]; };
  const RED = { ok: false, clase: "red", status: 0, codigo: "SIN_RED", mensaje: "Failed to fetch" };
  srv.RED = RED;
  const conFalla = async (metodo, tabla, aplicar) => {
    llamadas.push([metodo, tabla]);
    const f = falla(metodo, tabla);
    if (f && !f.aplicar) return f.respuesta;          // la petición no llegó / el servidor contestó error sin aplicar
    const r = await aplicar();
    return f ? f.respuesta : r;                       // f.aplicar: el servidor SÍ aplicó, pero la respuesta se pierde
  };
  srv.rest = {
    insertar: (tabla, filas) => conFalla("insertar", tabla, async () => {
      const out = [];
      for (const f of filas) {
        for (const [col, padre] of Object.entries(FK[tabla] || {})) if (f[col] && !t(padre).has(f[col])) return { ok: false, clase: "conflicto", status: 409, codigo: "23503", mensaje: "violates foreign key" };
        if (t(tabla).has(f.id)) continue;                                    // resolution=ignore-duplicates
        const row = { ...structuredClone(f), rev: 1, deleted_at: null, updated_at: sello() };
        t(tabla).set(f.id, row); out.push(structuredClone(row));
      }
      return { ok: true, status: 201, datos: out };
    }),
    modificar: (tabla, filtros, cambios) => conFalla("modificar", tabla, async () => {
      const id = filtros.find((x) => x[0] === "id")[2], rev = filtros.find((x) => x[0] === "rev");
      const row = t(tabla).get(id);
      if (!row || (rev && row.rev !== rev[2])) return { ok: true, status: 200, datos: [] };
      Object.assign(row, structuredClone(cambios), { rev: row.rev + 1, updated_at: sello() });
      return { ok: true, status: 200, datos: [structuredClone(row)] };
    }),
    obtener: (tabla, id) => conFalla("obtener", tabla, async () => ({ ok: true, datos: srv.fila(tabla, id) })),
    rpc: (nombre, params) => conFalla("rpc", nombre, async () => {
      if (opsHechas.has(params.p_op)) return { ok: true, datos: { ...opsHechas.get(params.p_op), repetida: true } };
      const fn = srv.rpcs[nombre];
      if (!fn) return { ok: false, clase: "esquema", status: 404, codigo: "PGRST202", mensaje: "no existe" };
      const r = fn(params);
      if (r && r.ok === false) return r;
      srv.efectos[nombre] = (srv.efectos[nombre] || 0) + 1;
      opsHechas.set(params.p_op, r); return { ok: true, datos: r };
    }),
    seleccionar: (tabla, o) => conFalla("seleccionar", tabla, async () => {
      if (tabla === "perfiles") { const id = o.filtros[0][2]; return { ok: true, datos: srv.perfiles.filter((p) => p.id === id) }; }
      const f = (o.filtros || []).find((x) => x[0] === "id" && x[1] === "in");
      const ids = f ? f[2].replace(/[()]/g, "").split(",") : null;
      return { ok: true, datos: [...t(tabla).values()].filter((r) => !ids || ids.includes(r.id)).map((r) => structuredClone(r)) };
    }),
    paginar: async (tabla, o) => {
      const cmp = (a, b) => P.compararCursor({ t: a.updated_at, id: a.id }, { t: b.updated_at, id: b.id });
      let cursor = o.cursor, total = 0;
      for (let pag = 0; pag < (o.maxPaginas || 200); pag++) {
        llamadas.push(["paginar", tabla]);
        const f = falla("paginar", tabla);
        if (f) return { ok: false, clase: f.respuesta.clase, codigo: f.respuesta.codigo, total, cursor };
        if (srv.cortarEn && srv.cortarEn.tabla === tabla && pag + 1 === srv.cortarEn.pagina) { srv.cortarEn = null; return { ok: false, clase: "red", codigo: "SIN_RED", total, cursor }; }
        const filas = [...t(tabla).values()].sort(cmp).filter((r) => !cursor || P.compararCursor({ t: r.updated_at, id: r.id }, cursor) > 0).slice(0, o.pagina || 500);
        if (!filas.length) return { ok: true, total, cursor, completo: true };
        total += filas.length;
        const ult = filas[filas.length - 1];
        await o.onPagina(filas.map((r) => structuredClone(r)), { t: ult.updated_at, id: ult.id });
        cursor = { t: ult.updated_at, id: ult.id };
      }
      return { ok: true, total, cursor, completo: false };
    },
  };
  return srv;
}

/* Un «dispositivo»: contexto vm + base real (sync-db.js) sobre la IDB en memoria + motor real. */
async function dispositivo({ ctx = cargar(), srv, actor = "u-a", nombreBd = "entimotors_sync", mappers = MAPPERS, orden = ["clientes", "motos"], extra = {} } = {}) {
  const bd = await ctx.SyncDB.abrir({ nombre: nombreBd });
  const d = { ctx, bd, srv, actor, reloj: 1_000_000, eventos: [] };
  d.motor = ctx.SyncEngine.crearMotor({ bd, rest: srv.rest, mappers, orden, sesion: () => (d.actor ? { uid: d.actor } : null), habilitado: () => true,
    locks: null, ahora: () => d.reloj, aleatorio: () => 0.5, ...extra });
  d.motor.onCambio((e) => d.eventos.push(e.tipo));
  d.cola = () => d.bd.outbox.todos().then(J);
  return d;
}

describe("3.15 BLOQUE 1A · cotizaciones: el renglón conserva su repuesto de origen al bajar (motor real, mappers reales)", () => {
  const ctxReal = () => cargar();
  test("aLocal: inventario_id → inventarioUid; manual → null; precio del renglón (histórico)", () => {
    const M = ctxReal().ENTIMOTORS_SYNC_MAPPERS.cotizaciones;
    const c = M.aLocal({ cliente_nombre: "x", orden_id: null, aceptada_en: null, cotizacion_items: [{ id: "1", inventario_id: "inv-neu", nombre: "N", cantidad: 2, precio: 90 }, { id: "2", inventario_id: null, nombre: "Mano", cantidad: 1, precio: 250 }] });
    assert.deepEqual(J(c.items.map((x) => [x.nombre, x.inventarioUid, x.precio])), [["N", "inv-neu", 90], ["Mano", null, 250]]);
    assert.ok(!M.columnas.includes("orden_id") && !M.columnas.includes("aceptada_en"), "la conversión nunca sube por el CRUD");
    assert.deepEqual(J(M.soloServidor), ["ordenUid", "aceptadaEn", "ordenId"]);
  });
  test("pull de punta a punta: el repuesto se resuelve al id LOCAL, la orden resultante también, y un cambio del producto no toca el precio del renglón", async () => {
    const ctx = ctxReal(), srv = servidor();
    srv.sembrar("inventario", [{ id: "inv-neu", nombre: "Neumático", precio_venta: 100, costo_compra: 60, cantidad: 5 }]);
    srv.sembrar("ordenes", [{ id: "ord-1", estado: "recibido", finalizada: false, anulada: false, orden_items: [] }]);
    srv.sembrar("cotizaciones", [{ id: "cot-1", cliente_nombre: "C", estado: "aceptada", orden_id: "ord-1", aceptada_en: "2026-09-29T10:00:00Z",
      cotizacion_items: [{ id: "ci1", inventario_id: "inv-neu", nombre: "Neumático", cantidad: 2, precio: 90 }, { id: "ci2", inventario_id: null, nombre: "Mano", cantidad: 1, precio: 250 }] }]);
    const D = await dispositivo({ ctx, srv, actor: "u-b", mappers: ctx.ENTIMOTORS_SYNC_MAPPERS, orden: ["inventario", "cotizaciones", "ordenes"] });
    await D.motor.pullTodo();
    const [inv] = await D.bd.datos.todos("inventario"), [cot] = await D.bd.datos.todos("cotizaciones"), [ord] = await D.bd.datos.todos("ordenes");
    assert.equal(cot.items[0].inventarioId, inv.id, "repuesto → id local"); assert.equal(cot.items[1].inventarioId, null, "manual sigue manual");
    assert.equal(cot.ordenId, ord.id, "la orden resultante se resuelve (aunque baje después, por fk_pendientes)");
    // el producto cambia de precio en la nube: el renglón de la cotización conserva el suyo
    const i = srv.tablas.inventario.get("inv-neu"); i.precio_venta = 175; i.rev++; i.updated_at = new Date(1799999999000).toISOString();
    await D.motor.pullTodo();
    const [cot2] = await D.bd.datos.todos("cotizaciones"), [inv2] = await D.bd.datos.todos("inventario");
    assert.equal(inv2.precio, 175); assert.equal(cot2.items[0].precio, 90, "precio histórico intacto");
  });
});
