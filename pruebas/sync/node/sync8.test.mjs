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

describe("SYNC-8 · orden de dependencias (elegirSiguiente, pura)", () => {
  const op = (seq, o) => ({ seq, estado: "pending", actor_uid: "A", siguiente_en: 0, kind: "insert", cambios: {}, ...o });
  test("un hijo NUNCA sale antes que su padre aunque el padre esté esperando un reintento; lo independiente sí sigue", () => {
    const padre = op(1, { uid: "c1", siguiente_en: 5000, cambios: { id: "c1" } });
    const hijo = op(2, { uid: "m1", cambios: { id: "m1", cliente_id: "c1" } });
    const otro = op(3, { uid: "c2", cambios: { id: "c2" } });
    const r = P.elegirSiguiente([hijo, padre, otro], "A", 1000);
    assert.equal(r.op.uid, "c2", "el independiente sale; el hijo espera a su padre");
    assert.equal(P.elegirSiguiente([padre, hijo], "A", 1000), null, "con solo padre (en espera) e hijo, no sale nada");
    assert.equal(P.elegirSiguiente([padre, hijo], "A", 6000).op.uid, "c1", "vencida la espera, sale primero el padre");
  });
  test("padre RECHAZADO → el hijo se rechaza por dependencia sin enviarse (en cascada)", () => {
    const padre = op(1, { uid: "c1", estado: "rejected" });
    const hijo = op(2, { uid: "m1", cambios: { cliente_id: "c1" } });
    const r = P.elegirSiguiente([padre, hijo], "A", 0);
    assert.equal(r.accion, "rechazar-dependencia"); assert.equal(r.padre, "c1");
    const nieto = op(3, { kind: "rpc", uid: "x", params: { p_moto: "m1" } });
    assert.equal(P.elegirSiguiente([padre, { ...hijo, estado: "rejected" }, nieto], "A", 0).accion, "rechazar-dependencia", "el hijo rechazado es padre del nieto");
  });
  test("un alta de OTRA persona retiene lo mío que la apunta; lo que no la apunta sigue", () => {
    const ajeno = op(1, { uid: "c1", actor_uid: "B" });
    const mio = op(2, { uid: "m1", cambios: { cliente_id: "c1" } });
    const libre = op(3, { uid: "c9" });
    assert.equal(P.elegirSiguiente([ajeno, mio, libre], "A", 0).op.uid, "c9");
    assert.equal(P.elegirSiguiente([ajeno, mio], "A", 0), null);
  });
  test("una EDICIÓN mía en espera retiene solo las siguientes del mismo registro, no a sus hijos (el registro ya existe)", () => {
    const ed = op(1, { uid: "c1", kind: "update", siguiente_en: 9999 });
    const ed2 = op(2, { uid: "c1", kind: "update" });
    const hijo = op(3, { uid: "m1", cambios: { cliente_id: "c1" } });
    assert.equal(P.elegirSiguiente([ed, ed2, hijo], "A", 0).op.uid, "m1");
  });
  test("abono (RPC que NO crea) rechazado no bloquea otras operaciones del mismo crédito; una venta (crea) sí", () => {
    const abono = op(1, { kind: "rpc", uid: "cr1", estado: "rejected", crea: false, params: { p_credito_id: "cr1" } });
    const otro = op(2, { kind: "rpc", uid: "cr1", params: { p_credito_id: "cr1" } });
    assert.equal(P.elegirSiguiente([abono, otro], "A", 0).accion, "enviar");
    const credito = { ...abono, crea: true };
    assert.equal(P.elegirSiguiente([credito, otro], "A", 0).accion, "rechazar-dependencia");
  });
  test("referencia(): por uid propio o por el uid dentro de lo enviado; nunca por coincidencia parcial", () => {
    assert.equal(P.referencia({ uid: "a", kind: "insert", cambios: { x: "abc-1" } }, "abc"), false);
    assert.equal(P.referencia({ uid: "a", kind: "rpc", params: { p_items: [{ inventario_id: "inv-1" }] } }, "inv-1"), true);
  });
});

describe("SYNC-8 · recuperación tras cierre y reintentos (motor real + IDB en memoria)", () => {
  test("cierre ANTES de enviar: la operación sigue pendiente al reabrir y sale UNA vez", async () => {
    const srv = servidor(), ctx = cargar();
    const a = await dispositivo({ ctx, srv });
    await a.motor.escribir("clientes", { nombre: "Ana" });
    // «reinicio»: otro motor, misma base (la app se volvió a abrir)
    const b = await dispositivo({ ctx, srv });
    const r = await b.motor.flush();
    assert.equal(r.enviadas, 1); assert.equal(srv.tablas.clientes.size, 1); assert.equal((await b.cola()).length, 0);
  });

  test("cierre DURANTE el envío (quedó «syncing») y el servidor SÍ lo aplicó: al reabrir se recupera, se reintenta y hay UN solo efecto", async () => {
    const srv = servidor(), ctx = cargar();
    srv.rpcs.registrar_venta_v2 = (p) => ({ venta_id: p.p_venta_id, total: 10 });
    const a = await dispositivo({ ctx, srv });
    const { seq } = await a.motor.encolarRpc("registrar_venta_v2", { p_venta_id: "v1" }, { entidad: "ventas_rapidas", uid: "v1", crea: true });
    // el navegador murió justo después de que el servidor aplicó (la respuesta nunca llegó): la op quedó en «syncing»
    await srv.rest.rpc("registrar_venta_v2", (await a.bd.outbox.get(seq)).params);
    await a.bd.outbox.actualizar(seq, { estado: "syncing", intentos: 1 });
    const b = await dispositivo({ ctx, srv });
    const r = await b.motor.flush();
    assert.equal(r.enviadas, 1, "se recuperó de «syncing» y se reenvió");
    assert.equal(srv.efectos.registrar_venta_v2, 1, "UN solo efecto: el reintento devolvió el resultado guardado (repetida)");
    assert.equal((await b.cola()).length, 0);
  });

  test("servidor aplicó pero el cliente no recibió respuesta (red): queda pendiente con espera, el reintento da UN efecto", async () => {
    const srv = servidor();
    srv.rpcs.registrar_abono_v2 = () => ({ saldo: 50 });
    const d = await dispositivo({ srv });
    await d.motor.encolarRpc("registrar_abono_v2", { p_credito_id: "cr1", p_monto: 50 }, { entidad: "creditos", uid: "cr1" });
    srv.fallas.push({ metodo: "rpc", aplicar: true, respuesta: srv.RED });
    const r1 = await d.motor.flush();
    assert.equal(r1.detenido, "red");
    const [op] = await d.cola();
    assert.equal(op.estado, "pending"); assert.equal(op.intentos, 1); assert.ok(op.siguiente_en > d.reloj, "espera antes de reintentar");
    assert.equal((await d.motor.flush()).enviadas, 0, "antes de la espera NO se reintenta (sin bucle apretado)");
    d.reloj = op.siguiente_en + 1;
    assert.equal((await d.motor.flush()).enviadas, 1);
    assert.equal(srv.efectos.registrar_abono_v2, 1);
  });

  test("temporales (red, 5xx, 55P03, tiempo agotado, 429) se reintentan con backoff; terminales (400/403/409) NUNCA", async () => {
    const temporales = [srv0 => srv0.RED, () => ({ ok: false, clase: "servidor", status: 503, codigo: "" }), () => ({ ok: false, clase: "servidor", status: 500, codigo: "55P03" }),
      () => ({ ok: false, clase: "red", status: 0, codigo: "TIMEOUT" }), () => ({ ok: false, clase: "limite", status: 429, codigo: "", reintentarEnS: 7 })];
    for (const resp of temporales) {
      const srv = servidor(); const d = await dispositivo({ srv });
      await d.motor.escribir("clientes", { nombre: "T" });
      srv.fallas.push({ metodo: "insertar", respuesta: resp(srv) });
      await d.motor.flush();
      const [op] = await d.cola();
      assert.equal(op.estado, "pending", JSON.stringify(resp(srv)));
      assert.ok(op.siguiente_en >= d.reloj + 1500, "espera real antes del próximo intento");
      if (resp(srv).clase === "limite") assert.equal(op.siguiente_en, d.reloj + 7000, "respeta Retry-After");
    }
    const terminales = [["validacion", 400, "23514"], ["conflicto", 409, "23503"], ["validacion", 400, "22000"], ["validacion", 400, "22023"], ["conflicto", 409, "23505"], ["permiso", 403, "42501"]];
    for (const [clase, status, codigo] of terminales) {
      const srv = servidor(); const d = await dispositivo({ srv });
      await d.motor.escribir("clientes", { nombre: "T" });
      srv.fallas.push({ metodo: "insertar", respuesta: { ok: false, clase, status, codigo, mensaje: "x" } });
      await d.motor.flush();
      const antes = srv.llamadas.length;
      d.reloj += 3_600_000; await d.motor.flush(); await d.motor.flush();
      const [op] = await d.cola();
      assert.equal(op.estado, "rejected", codigo); assert.equal(op.error.codigo, codigo);
      assert.equal(srv.llamadas.length, antes, `${codigo}: un terminal no se reintenta nunca`);
    }
  });

  test("backoff exponencial con tope y variación acotada: 2 s, 4 s, 8 s… ≤ 5 min ±25 %", () => {
    let prev = 0;
    for (let i = 1; i <= 12; i++) { const m = P.esperaMs(i, 0.5); assert.ok(m >= prev); prev = m; }
    assert.equal(P.esperaMs(30, 0.5), 300000);
    assert.ok(P.esperaMs(30, 0) >= 225000 && P.esperaMs(30, 1) <= 375000, "variación ±25 %: dispositivos que vuelven a la vez no golpean juntos");
  });

  test("conectividad engañosa: navigator.onLine=true pero DNS/PostgREST/backend no responden → temporal, NUNCA aplicada", async () => {
    for (const r of [{ ok: false, clase: "red", status: 0, codigo: "SIN_RED" }, { ok: false, clase: "red", status: 0, codigo: "TIMEOUT" }, { ok: false, clase: "servidor", status: 502 }, { ok: false, clase: "servidor", status: 504 }]) {
      const srv = servidor(); const d = await dispositivo({ srv });
      await d.motor.escribir("clientes", { nombre: "Engañosa" });
      srv.fallas.push({ metodo: "insertar", respuesta: r });
      await d.motor.sincronizar();
      const [op] = await d.cola(), [local] = await d.bd.datos.todos("clientes");
      assert.equal(op.estado, "pending"); assert.equal(local._pend, true, "no se marca aplicada"); assert.equal(srv.tablas.clientes?.size || 0, 0);
    }
  });
});

describe("SYNC-8 · sesión, usuario y dispositivo", () => {
  test("sesión caducada (sin token): NADA sale como anónimo; la cola se pausa sin gastar intentos; al reanudar con sesión, sale", async () => {
    const pedidos = [];
    let token = null;
    const ctx = cargar({ fetch: async (u, i) => { pedidos.push({ u, auth: i.headers.Authorization }); return { status: 201, headers: { get: () => null }, text: async () => "[]" }; } });
    const rest = ctx.SyncRest.crear({ baseUrl: "https://x.test", anonKey: "ANON", getToken: async () => token, refrescar: async () => false });
    const srv = servidor(); srv.rest = rest;
    const d = await dispositivo({ ctx, srv, extra: { pausaAuthMs: 60000 } });
    await d.motor.escribir("clientes", { nombre: "Sin sesión" });
    const r = await d.motor.flush();
    assert.equal(r.detenido, "auth"); assert.equal(pedidos.length, 0, "ninguna petición salió sin token");
    assert.ok(d.eventos.includes("auth-requerida"));
    const [op] = await d.cola(); assert.equal(op.estado, "pending"); assert.equal(op.intentos, 0, "la sesión caducada no gasta intentos");
    assert.deepEqual(J(await d.motor.flush()), { omitido: "auth" }, "pausada: ni lo intenta");
    assert.equal((await d.motor.estado()).pausa, "auth");
    token = "TOKEN-NUEVO"; d.motor.reanudar();
    await d.motor.flush();
    assert.ok(pedidos.length >= 1); assert.ok(pedidos.every((p) => p.auth === "Bearer TOKEN-NUEVO"), "todo sale con la sesión nueva, nada anónimo");
  });

  test("perfil revalidado antes de enviar: cuenta INACTIVA → fail closed (nada sale, nada baja) y reanudar() no la levanta", async () => {
    const srv = servidor(); srv.perfiles[0].activo = false;
    const d = await dispositivo({ srv, extra: { validarPerfil: true } });
    await d.motor.escribir("clientes", { nombre: "X" });
    const r = await d.motor.sincronizar();
    assert.equal(r.flush.detenido, "cuenta-inactiva"); assert.deepEqual(J(r.pull), []);
    assert.equal(srv.tablas.clientes?.size || 0, 0); assert.ok(d.eventos.includes("cuenta-inactiva"));
    assert.equal(d.motor.reanudar(), false);
    assert.deepEqual(J(await d.motor.flush()), { omitido: "cuenta-inactiva" });
    // perfil activo → pasa
    const srv2 = servidor(); const d2 = await dispositivo({ srv: srv2, extra: { validarPerfil: true } });
    await d2.motor.escribir("clientes", { nombre: "Y" });
    assert.equal((await d2.motor.flush()).enviadas, 1);
    assert.equal(srv2.llamadas.filter((x) => x[1] === "perfiles").length, 1, "una sola comprobación por sesión");
  });

  test("cambio de usuario: lo de A NUNCA sale con B ni se le atribuye; lo que B edita de A va en una operación de B que espera a A", async () => {
    const srv = servidor(), ctx = cargar();
    const d = await dispositivo({ ctx, srv, actor: "u-a" });
    const c = await d.motor.escribir("clientes", { nombre: "De A" });
    d.actor = "u-b";                                             // logout de A, entra B en el mismo dispositivo
    await d.motor.escribir("clientes", { id: c.id, nombre: "De A", telefono: "555" });
    const m = await d.motor.escribir("motos", { placa: "B-1", clienteId: c.id });
    let cola = await d.cola();
    const deA = cola.filter((x) => x.actor_uid === "u-a"), deB = cola.filter((x) => x.actor_uid === "u-b");
    assert.equal(deA.length, 1); assert.equal(deA[0].kind, "insert"); assert.equal(deA[0].cambios.telefono, null, "la edición de B NO se mezcló en el alta de A");
    assert.equal(deB.length, 2);
    let r = await d.motor.flush();
    assert.equal(r.enviadas, 0, "B no envía lo de A ni lo suyo que depende de lo de A");
    assert.equal(srv.llamadas.length, 0);
    assert.equal((await d.motor.estado()).deOtraPersona, 1);
    d.actor = "u-a"; assert.equal((await d.motor.flush()).enviadas, 1);
    d.actor = "u-b"; r = await d.motor.flush();
    assert.equal(r.enviadas, 2);
    assert.equal(srv.fila("clientes", c.uid).telefono, "555"); assert.equal(srv.fila("motos", m.uid).cliente_id, c.uid);
    cola = await d.cola(); assert.equal(cola.length, 0);
  });

  test("device_id: crypto.randomUUID, estable al reabrir, el MISMO para el Taller y las cachés de mecánico del dispositivo, otro en otro perfil", async () => {
    const idb = crearFabrica(), ctx = cargar({ idb });
    const t1 = await ctx.SyncDB.abrir({ nombre: "entimotors_sync" });
    const id1 = await t1.deviceId();
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const t2 = await cargar({ idb }).SyncDB.abrir({ nombre: "entimotors_sync" });   // recarga
    assert.equal(await t2.deviceId(), id1);
    const mec = await ctx.SyncDB.abrir({ nombre: "entimotors_sync_mec_perfil-1" });
    assert.equal(await mec.deviceId(), id1, "independiente del usuario");
    const otro = await cargar().SyncDB.abrir({ nombre: "entimotors_sync" });
    assert.notEqual(await otro.deviceId(), id1, "otro perfil de navegador = otro almacenamiento = otro id");
    // adopción: un Taller que ya tenía device_id (antes de SYNC-8) lo conserva
    const idb2 = crearFabrica(), ctx2 = cargar({ idb: idb2 });
    const viejo = await ctx2.SyncDB.abrir({ nombre: "entimotors_sync" });
    await viejo.meta.set("device_id", "11111111-1111-4111-8111-111111111111");
    const re = await cargar({ idb: idb2 }).SyncDB.abrir({ nombre: "entimotors_sync" });
    assert.equal(await re.deviceId(), "11111111-1111-4111-8111-111111111111");
  });

  test("device_id no viaja en el respaldo ni se restaura: ALL_STORES del respaldo no incluye la base de sync ni la del dispositivo", () => {
    const app = leer("app.js");
    const m = /const ALL_STORES = \[([^\]]+)\]/.exec(app);
    assert.ok(m && !/meta|outbox|device|dispositivo|entimotors_sync/.test(m[1]));
    assert.ok(!/entimotors_dispositivo/.test(app), "la app no abre ni copia la identidad del dispositivo");
  });
});

describe("SYNC-8 · dependencias de punta a punta, pull tras flush, bootstrap, paginación", () => {
  test("padre con fallo temporal: el hijo espera; al volver, sale el padre y LUEGO el hijo (nunca 23503)", async () => {
    const srv = servidor(); const d = await dispositivo({ srv });
    const c = await d.motor.escribir("clientes", { nombre: "Padre" });
    await d.motor.escribir("motos", { placa: "H-1", clienteId: c.id });
    srv.fallas.push({ metodo: "insertar", tabla: "clientes", respuesta: { ok: false, clase: "servidor", status: 503 } });
    await d.motor.flush();
    assert.equal(await d.motor.flush().then((r) => r.enviadas), 0, "el hijo no sale mientras el padre espera");
    assert.deepEqual(srv.llamadas.filter((x) => x[0] === "insertar").map((x) => x[1]), ["clientes"]);
    d.reloj += 3_600_000;
    assert.equal((await d.motor.flush()).enviadas, 2);
    assert.deepEqual(srv.llamadas.filter((x) => x[0] === "insertar").map((x) => x[1]), ["clientes", "clientes", "motos"]);
  });

  test("padre rechazado (terminal): el hijo se rechaza por DEPENDENCIA sin enviarse y queda en «por revisar»", async () => {
    const srv = servidor(); const d = await dispositivo({ srv });
    const c = await d.motor.escribir("clientes", { nombre: "Rechazado" });
    await d.motor.escribir("motos", { placa: "H-2", clienteId: c.id });
    srv.fallas.push({ metodo: "insertar", tabla: "clientes", respuesta: { ok: false, clase: "permiso", status: 403, codigo: "42501", mensaje: "rls" } });
    const r = await d.motor.flush();
    assert.equal(r.rechazadas, 2);
    assert.equal(srv.llamadas.filter((x) => x[1] === "motos").length, 0, "el hijo nunca se envió");
    const rev = await d.motor.revision();
    assert.deepEqual(rev.rechazadas.map((x) => [x.entidad, x.tipo]).sort(), [["clientes", "rechazada"], ["motos", "dependencia"]]);
  });

  test("abono sin red de un crédito sin red: el abono espera al crédito (crea) y sale después", async () => {
    const srv = servidor(); const d = await dispositivo({ srv });
    srv.rpcs.registrar_credito = (p) => ({ credito_id: p.p_credito_id }); srv.rpcs.registrar_abono_v2 = () => ({ saldo: 0 });
    await d.motor.encolarRpc("registrar_credito", { p_credito_id: "cr-9" }, { entidad: "creditos", uid: "cr-9", crea: true });
    await d.motor.encolarRpc("registrar_abono_v2", { p_credito_id: "cr-9", p_monto: 5 }, { entidad: "creditos", uid: "cr-9" });
    srv.fallas.push({ metodo: "rpc", tabla: "registrar_credito", respuesta: srv.RED });
    await d.motor.flush();
    assert.equal(srv.llamadas.filter((x) => x[1] === "registrar_abono_v2").length, 0);
    d.reloj += 3_600_000; await d.motor.flush();
    assert.deepEqual(srv.llamadas.filter((x) => x[0] === "rpc").map((x) => x[1]), ["registrar_credito", "registrar_credito", "registrar_abono_v2"]);
  });

  test("sincronizar = flush → pull correctivo: lo que queda en caché es lo del servidor, no lo enviado", async () => {
    const srv = servidor(); const d = await dispositivo({ srv });
    const c = await d.motor.escribir("clientes", { nombre: "enviado" });
    await d.motor.sincronizar();
    srv.tablas.clientes.get(c.uid).nombre = "corregido por el servidor"; srv.tablas.clientes.get(c.uid).rev++; srv.tablas.clientes.get(c.uid).updated_at = new Date(1799999999000).toISOString();
    const orden = []; const r = await d.motor.sincronizar();
    assert.ok(r.flush && Array.isArray(r.pull));
    assert.equal((await d.bd.datos.get("clientes", c.id)).nombre, "corregido por el servidor");
    orden.push(...srv.llamadas.map((x) => x[0]));
    assert.ok(orden.lastIndexOf("paginar") > orden.indexOf("insertar"));
  });

  test("bootstrap de 300 filas cortado en la página 3: NO se marca completo, no borra lo bajado, retoma sin duplicar", async () => {
    const srv = servidor();
    srv.sembrar("clientes", Array.from({ length: 300 }, (_, i) => ({ id: `c-${String(i).padStart(4, "0")}`, nombre: `C${i}` })));
    srv.sembrar("motos", [{ id: "m-1", placa: "P1", cliente_id: "c-0299" }]);
    const d = await dispositivo({ srv });
    srv.cortarEn = { tabla: "clientes", pagina: 3 };            // la red cae al pedir la página 3
    const r0 = await d.motor.pullTodo({ pagina: 100 });
    assert.equal(r0.length, 1); assert.equal(r0[0].ok, false);
    let e = await d.motor.estado();
    assert.equal(e.bootstrapCompleto, false, "una descarga parcial no se presenta como completa");
    assert.equal((await d.bd.datos.todos("clientes")).length, 200);
    assert.equal((await d.bd.datos.todos("motos")).length, 0, "los hijos no bajan si el padre no terminó");
    const r = await d.motor.pullTodo({ pagina: 100 });
    assert.ok(r.every((x) => x.ok));
    const locales = await d.bd.datos.todos("clientes");
    assert.equal(locales.length, 300); assert.equal(new Set(locales.map((x) => x.uid)).size, 300, "sin duplicados");
    const [moto] = await d.bd.datos.todos("motos");
    assert.equal(moto.clienteId, locales.find((x) => x.uid === "c-0299").id, "relación completa");
    e = await d.motor.estado(); assert.equal(e.bootstrapCompleto, true);
    assert.ok(d.eventos.includes("bootstrap-completo"));
  });

  test("pull que falla en una entidad (no solo red/auth) detiene las siguientes: nada de relaciones a medias", async () => {
    const srv = servidor(); srv.sembrar("clientes", [{ id: "c1", nombre: "a" }]); srv.sembrar("motos", [{ id: "m1", placa: "x", cliente_id: "c1" }]);
    const d = await dispositivo({ srv });
    srv.fallas.push({ metodo: "paginar", tabla: "clientes", respuesta: { clase: "servidor", codigo: "" } });
    const r = await d.motor.pullTodo();
    assert.equal(r.length, 1); assert.equal((await d.motor.estado()).bootstrapCompleto, false);
  });

  test("paginación: 0, 1, 100, 101 y 250 filas con páginas de 100 → exactas, sin duplicados ni saltos", async () => {
    for (const n of [0, 1, 100, 101, 250]) {
      const srv = servidor(); srv.sembrar("clientes", Array.from({ length: n }, (_, i) => ({ id: `c-${String(i).padStart(4, "0")}`, nombre: `C${i}` })));
      const d = await dispositivo({ srv });
      const r = await d.motor.pull("clientes", { pagina: 100 });
      const l = await d.bd.datos.todos("clientes");
      assert.equal(r.total, n); assert.equal(l.length, n); assert.equal(new Set(l.map((x) => x.uid)).size, n);
      assert.equal(srv.llamadas.filter((x) => x[0] === "paginar").length, Math.ceil(n / 100) + 1, "páginas con datos + la vacía final");
    }
  });

  test("llave foránea que llega ANTES que su padre (el padre se creó tras bajar su tabla): se anota y se resuelve al terminar la descarga", async () => {
    const srv = servidor(); srv.sembrar("clientes", [{ id: "c1", nombre: "viejo" }]);
    const d = await dispositivo({ srv });
    await d.motor.pull("clientes");
    // otro dispositivo crea cliente + moto DESPUÉS de que este bajó clientes
    srv.sembrar("clientes", [{ id: "c2", nombre: "nuevo" }]); srv.sembrar("motos", [{ id: "m2", placa: "N", cliente_id: "c2" }]);
    await d.motor.pull("motos");
    let [moto] = await d.bd.datos.todos("motos");
    assert.equal(moto.clienteId, null); assert.equal((await d.motor.estado()).fkPendientes, 1, "anotada, no perdida");
    await d.motor.pullTodo();
    [moto] = await d.bd.datos.todos("motos");
    const c2 = (await d.bd.datos.todos("clientes")).find((x) => x.uid === "c2");
    assert.equal(moto.clienteId, c2.id); assert.equal((await d.motor.estado()).fkPendientes, 0);
  });
});

describe("SYNC-8 · conflictos, ítems de orden y campos del servidor (mappers reales)", () => {
  const ctxReal = () => cargar();
  test("CRUD: dos dispositivos cambian el MISMO campo → conflicto visible (no LWW ciego); campos distintos → se fusionan", async () => {
    const srv = servidor(), A = await dispositivo({ srv }), B = await dispositivo({ srv });
    const c = await A.motor.escribir("clientes", { nombre: "Ana", telefono: "1" });
    await A.motor.sincronizar(); await B.motor.pullTodo();
    const [cb] = await B.bd.datos.todos("clientes");
    await A.motor.escribir("clientes", { id: c.id, nombre: "Ana", telefono: "A" });
    await B.motor.escribir("clientes", { ...cb, telefono: "B" });
    await A.motor.flush(); const r = await B.motor.flush();
    assert.equal(r.conflictos, 1); assert.equal(srv.fila("clientes", c.uid).telefono, "A", "lo de B NO pisó a A");
    const rev = await B.motor.revision();
    assert.equal(rev.conflictos.length, 1); assert.deepEqual(rev.conflictos[0].campos, ["telefono"]);
    // resolución explícita: B decide la de la nube
    assert.equal((await B.motor.resolverConflicto(rev.conflictos[0].id, "servidor")).ok, true);
    assert.equal((await B.bd.datos.get("clientes", cb.id)).telefono, "A");
    // campos distintos
    await A.motor.escribir("clientes", { id: c.id, nombre: "Ana María", telefono: "A" });
    const cb2 = await B.bd.datos.get("clientes", cb.id);
    await B.motor.escribir("clientes", { ...cb2, telefono: "B2" });
    await A.motor.flush(); await B.motor.flush();
    assert.deepEqual([srv.fila("clientes", c.uid).nombre, srv.fila("clientes", c.uid).telefono], ["Ana María", "B2"]);
  });

  test("inventario maestro: dos admins cambian el precio → conflicto determinista; la CANTIDAD nunca participa ni se sobrescribe", async () => {
    const ctx = ctxReal(), srv = servidor();
    const M = ctx.ENTIMOTORS_SYNC_MAPPERS;
    srv.sembrar("inventario", [{ id: "inv-1", nombre: "Aceite", precio_venta: 100, costo_compra: 60, cantidad: 7, requiere_revision: false, stock_minimo: 3 }]);
    const A = await dispositivo({ ctx, srv, actor: "u-b", mappers: M, orden: ["inventario"] }), B = await dispositivo({ ctx: cargar(), srv, actor: "u-b", mappers: cargar().ENTIMOTORS_SYNC_MAPPERS, orden: ["inventario"] });
    await A.motor.pullTodo(); await B.motor.pullTodo();
    const [ia] = await A.bd.datos.todos("inventario"), [ib] = await B.bd.datos.todos("inventario");
    await A.motor.escribir("inventario", { ...ia, precio: 120, cantidad: 999 });
    await B.motor.escribir("inventario", { ...ib, precio: 130, nombre: "Aceite 20W", cantidad: -5 });
    const opA = (await A.cola())[0];
    assert.ok(!("cantidad" in opA.cambios), "la cantidad nunca viaja por el maestro");
    await A.motor.flush(); const r = await B.motor.flush();
    assert.equal(r.conflictos, 1, "mismo campo (precio) → conflicto, nunca «el último gana»");
    const fila = srv.fila("inventario", "inv-1");
    assert.equal(fila.precio_venta, 120); assert.equal(fila.cantidad, 7, "la cantidad de la nube quedó intacta");
    // la existencia de la nube baja aunque B tenga su edición del maestro en conflicto
    srv.tablas.inventario.get("inv-1").cantidad = -2; srv.tablas.inventario.get("inv-1").requiere_revision = true;
    srv.tablas.inventario.get("inv-1").rev++; srv.tablas.inventario.get("inv-1").updated_at = new Date(1799999999000).toISOString();
    await B.motor.pull("inventario");
    const lb = await B.bd.datos.get("inventario", ib.id);
    assert.equal(lb.cantidad, -2); assert.equal(lb.requiereRevision, true); assert.equal(lb.precio, 130, "lo mío en conflicto sigue a la vista");
  });

  test("ítems de orden: bajan embebidos con precio/costo y repuesto resuelto; un PATCH sin embebido NO los borra; lo local sin uid se conserva", () => {
    const M = ctxReal().ENTIMOTORS_SYNC_MAPPERS.ordenes;
    assert.match(M.select, /orden_items\(id,inventario_id,nombre,cantidad,precio,costo_unitario,costo_estimado,creado_en\)/);
    const c = M.aLocal({ estado: "reparacion", finalizada: true, finalizado_en: "2026-09-22T10:00:00Z", entregado_en: null,
      orden_items: [{ id: "i2", nombre: "B", cantidad: 1, precio: 5, costo_unitario: 3, inventario_id: null, creado_en: "2026-09-22T10:00:02Z" },
        { id: "i1", nombre: "A", cantidad: "2", precio: "10", costo_unitario: "4", inventario_id: "inv-1", creado_en: "2026-09-22T10:00:01Z" }] });
    assert.deepEqual(J(c.items.map((x) => [x.uid, x.cantidad, x.precio, x.costoUnitario, x.inventarioUid])), [["i1", 2, 10, 4, "inv-1"], ["i2", 1, 5, 3, null]]);
    assert.equal(c.finalizadoEn, Date.parse("2026-09-22T10:00:00Z"));
    assert.ok(!("items" in M.aLocal({ estado: "x" })), "sin embebido (respuesta de un PATCH) no toca los ítems");
    const f = M.fusionarLocal({ items: [{ uid: "i1" }, { nombre: "solo local", cantidad: 1, precio: 1 }] }, c);
    assert.deepEqual(J(f.items.map((x) => x.uid || x.nombre)), ["i1", "i2", "solo local"]);
    assert.deepEqual(J(M.soloServidor), ["finalizada", "anulada", "finalizadoEn", "entregadoEn"]);
    assert.ok(!M.columnas.includes("items") && !M.columnas.some((x) => /precio|costo|finaliz/.test(x)), "nada de ítems ni dinero sube por el CRUD");
    // mecánico: nunca precio ni costo
    const mec = cargar({ mecanico: true }).ENTIMOTORS_SYNC_MAPPERS.ordenes;
    assert.equal(mec.tabla, "rpc/ordenes_tecnico_mias");
    assert.deepEqual(J(mec.aLocal({ items: [{ nombre: "A", cantidad: 1, precio: 9, costo_unitario: 5 }] }).items), [{ nombre: "A", cantidad: 1 }]);
  });

  test("ítems de orden A→B de punta a punta (motor real): B ve el detalle y el repuesto local; bajar NO mueve stock", async () => {
    const ctxB = ctxReal(), srv = servidor();
    srv.sembrar("inventario", [{ id: "inv-1", nombre: "Filtro", precio_venta: 50, costo_compra: 20, cantidad: 4 }]);
    srv.sembrar("ordenes", [{ id: "o-1", estado: "reparacion", finalizada: false, anulada: false, orden_items: [] }]);
    const B = await dispositivo({ ctx: ctxB, srv, actor: "u-b", mappers: ctxB.ENTIMOTORS_SYNC_MAPPERS, orden: ["inventario", "ordenes"] });
    await B.motor.pullTodo();
    // A agregó un ítem por RPC: el servidor movió el ledger (cantidad 4→3) y tocó la cabecera (rev/updated_at)
    const o = srv.tablas.ordenes.get("o-1");
    o.orden_items = [{ id: "it-1", inventario_id: "inv-1", nombre: "Filtro", cantidad: 1, precio: 50, costo_unitario: 20, costo_estimado: false, creado_en: "2026-09-22T10:00:00Z" }];
    o.rev++; o.updated_at = new Date(1799999990000).toISOString();
    const inv = srv.tablas.inventario.get("inv-1"); inv.cantidad = 3; inv.rev++; inv.updated_at = new Date(1799999989000).toISOString();
    await B.motor.pullTodo(); await B.motor.pullTodo();   // dos veces: bajar lo mismo otra vez no cambia nada
    const [ob] = await B.bd.datos.todos("ordenes"), [ib] = await B.bd.datos.todos("inventario");
    assert.equal(ob.items.length, 1); assert.equal(ob.items[0].origenInventarioId, ib.id); assert.equal(ob.items[0].precio, 50);
    assert.equal(ib.cantidad, 3, "la existencia es la del servidor: bajar el ítem no descontó otra vez");
    assert.equal(srv.tablas.inventario.get("inv-1").cantidad, 3);
  });
});

describe("SYNC-8 · multi-pestaña, revisión persistente, PIN", () => {
  test("dos pestañas SIN Web Locks (arrendamiento en la base) envían a la vez: UN solo envío por operación", async () => {
    const idb = crearFabrica(), srv = servidor();
    srv.rpcs.registrar_venta_v2 = () => ({ ok: 1 });
    const A = await dispositivo({ ctx: cargar({ idb }), srv }), B = await dispositivo({ ctx: cargar({ idb }), srv });
    for (let i = 0; i < 5; i++) await A.motor.encolarRpc("registrar_venta_v2", { p_venta_id: "v" + i }, { entidad: "ventas_rapidas", uid: "v" + i, crea: true });
    const [ra, rb] = await Promise.all([A.motor.flush(), B.motor.flush()]);
    assert.equal((ra.enviadas || 0) + (rb.enviadas || 0), 5);
    assert.ok(ra.omitido === "otra-pestana" || rb.omitido === "otra-pestana", "una de las dos cedió");
    assert.equal(srv.llamadas.filter((x) => x[0] === "rpc").length, 5, "ningún envío duplicado");
  });

  test("el arrendamiento se RENUEVA en un envío largo: otra pestaña no hereda la cola a mitad; si la dueña muere, caduca", async () => {
    const idb = crearFabrica(), srv = servidor();
    const A = await dispositivo({ ctx: cargar({ idb }), srv, extra: { leaseMs: 1000 } }), B = await dispositivo({ ctx: cargar({ idb }), srv, extra: { leaseMs: 1000 } });
    srv.rpcs.lenta = () => ({ ok: 1 });
    for (let i = 0; i < 3; i++) await A.motor.encolarRpc("lenta", { i }, {});
    let intentosB = [];
    const rpcReal = srv.rest.rpc;
    srv.rest.rpc = async (n, p) => { A.reloj += 900; B.reloj = A.reloj; intentosB.push(await B.motor.flush()); return rpcReal(n, p); };
    const ra = await A.motor.flush();
    srv.rest.rpc = rpcReal;
    assert.equal(ra.enviadas, 3);
    assert.ok(intentosB.every((x) => x.omitido === "otra-pestana"), "B nunca tomó la cola mientras A la renovaba");
    // A «muere» con el arrendamiento tomado: al caducar, B lo toma
    await A.bd.meta.set("lease", { dueno: "pestaña-muerta", until: A.reloj + 1000 });
    await B.motor.encolarRpc("lenta", { i: 9 }, {});
    B.actor = "u-a";
    assert.deepEqual(J(await B.motor.flush()), { omitido: "otra-pestana" });
    B.reloj = A.reloj + 1001;
    assert.equal((await B.motor.flush()).enviadas, 1);
  });

  test("con Web Locks: la segunda pestaña cede (ifAvailable) y no envía nada", async () => {
    const srv = servidor();
    let tomado = false;
    const locks = { request: async (n, o, f) => { if (tomado) return f(null); tomado = true; try { return await f({ name: n }); } finally { tomado = false; } } };
    srv.rpcs.x = () => ({});
    const idb = crearFabrica();
    const A = await dispositivo({ ctx: cargar({ idb }), srv, extra: { locks } }), B = await dispositivo({ ctx: cargar({ idb }), srv, extra: { locks } });
    for (let i = 0; i < 3; i++) await A.motor.encolarRpc("x", { i }, {});
    const [ra, rb] = await Promise.all([A.motor.flush(), B.motor.flush()]);
    assert.deepEqual([ra.enviadas ?? ra.omitido, rb.enviadas ?? rb.omitido].sort(), [3, "otra-pestana"].sort());
  });

  test("requiere revisión PERSISTE tras reiniciar (rechazo + conflicto + dependencia) y nunca expone lo enviado", async () => {
    const srv = servidor(), ctx = cargar();
    srv.rpcs.registrar_venta_v2 = () => ({ ok: false, clase: "validacion", status: 400, codigo: "23514", mensaje: "Stock insuficiente" });
    const d = await dispositivo({ ctx, srv });
    await d.motor.encolarRpc("registrar_venta_v2", { p_venta_id: "v1", p_items: [{ precio: 12345.67 }] }, { entidad: "ventas_rapidas", uid: "v1", crea: true });
    await d.motor.flush();
    const d2 = await dispositivo({ ctx, srv });   // reinicio
    const rev = await d2.motor.revision();
    assert.equal(rev.total, 1); assert.equal(rev.rechazadas[0].codigo, "23514"); assert.equal(rev.rechazadas[0].entidad, "ventas_rapidas");
    assert.ok(rev.rechazadas[0].creadoEn);
    assert.ok(!JSON.stringify(rev).includes("12345.67"), "ni montos ni parámetros en la lista de revisión");
    assert.equal((await d2.motor.estado()).rechazadas, 1);
    assert.equal(await d2.motor.descartarRechazada(rev.rechazadas[0].seq), true);
    assert.equal((await d2.motor.revision()).total, 0);
  });

  test("venta online con corte a mitad: mismo op_id → UNA venta; si no se aplicó y ya no hay stock → rechazo VISIBLE, nunca silencioso", async () => {
    const srv = servidor(); let stock = 1;
    srv.rpcs.registrar_venta_v2 = (p) => { if (stock < 1) return { ok: false, clase: "validacion", status: 400, codigo: "23514", mensaje: "Stock insuficiente" }; stock--; return { venta_id: p.p_venta_id }; };
    const d = await dispositivo({ srv });
    // (a) aplicada, respuesta perdida
    await d.motor.encolarRpc("registrar_venta_v2", { p_venta_id: "v1", p_offline: false }, { entidad: "ventas_rapidas", uid: "v1", crea: true });
    srv.fallas.push({ metodo: "rpc", aplicar: true, respuesta: srv.RED });
    await d.motor.flush(); d.reloj += 3_600_000; await d.motor.flush();
    assert.equal(srv.efectos.registrar_venta_v2, 1); assert.equal(stock, 0);
    // (b) NO aplicada (se cayó antes de llegar) y otro agotó el stock
    await d.motor.encolarRpc("registrar_venta_v2", { p_venta_id: "v2", p_offline: false }, { entidad: "ventas_rapidas", uid: "v2", crea: true });
    srv.fallas.push({ metodo: "rpc", respuesta: srv.RED });
    await d.motor.flush(); d.reloj += 3_600_000; await d.motor.flush();
    const rev = await d.motor.revision();
    assert.equal(rev.rechazadas.length, 1); assert.equal(rev.rechazadas[0].uid, "v2"); assert.match(rev.rechazadas[0].mensaje, /Stock insuficiente/);
    assert.ok(d.eventos.includes("rechazada"));
  });

  test("PIN: una acción con PIN o datos de autorización JAMÁS entra al outbox (ni offline)", async () => {
    const srv = servidor(); const d = await dispositivo({ srv });
    for (const a of P.ACCIONES_CON_PIN) await assert.rejects(d.motor.encolarRpc(a, { p_x: 1 }), /PIN/);
    await assert.rejects(d.motor.encolarRpc("registrar_venta_v2", { p_autorizacion_id: "a" }), /autorizaci/);
    await assert.rejects(d.motor.encolarRpc("registrar_venta_v2", { x: { pin: "123456" } }), /autorizaci/);
    assert.equal((await d.cola()).length, 0);
    const texto = leer("sync-db.js") + leer("sync-engine.js");
    assert.ok(!/localStorage|sessionStorage/.test(texto), "ningún PIN ni token persiste en almacenamiento del navegador");
  });
});
