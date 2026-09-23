// SYNC-8 · HARDENING OFFLINE / RECONCILIACIÓN / CONFLICTOS en navegadores REALES (Chrome, Firefox) contra Postgres +
// PostgREST REALES (local) con el motor, la base local y los mappers DE VERDAD. Los fallos de red se inyectan en el
// navegador (harness/red-falsa.js): corte, respuesta perdida tras aplicar, 5xx/4xx sintéticos, peticiones colgadas.
// Todo lo que importa se afirma EN LA NUBE (SQL) y las invariantes financieras se revisan tras cada prueba de dinero.
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/sync8-core.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const ORDEN = ["clientes", "motos", "citas", "categorias_inv", "inventario", "cotizaciones", "ordenes"];
const INV = "00000000-0000-4000-9000-000000000801";
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

const uno = (q) => pila.sql(q);
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (${q}) t`));
const invariantes = () => uno(`select public.verificar_invariantes()::text`);
function sembrarRepuesto(cant, id = INV, nombre = "Aceite SYNC-8") {
  uno(`insert into public.inventario (id, nombre, precio_venta, costo_compra) values ('${id}', '${nombre}', 100, 60);
       insert into public.inventario_movimientos (inventario_id, tipo, cantidad) values ('${id}', 'apertura', ${cant});`);
}

let n = 0;
async function dispositivo(nav, quien = "cajero", opciones = {}) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `8-${quien}-${nav}-${++n}` });
  await entrar(d, quien, opciones);
  return d;
}
function entrar(d, quien, opciones = {}) {
  const id = PERFILES[quien];
  return d.eval((a) => { window.__token = a.token; window.__sesion = { uid: a.id }; window.__habilitado = true; return __montar(a.op); },
    { token: pila.jwt(id), id, op: { nombreBd: opciones.nombreBd || `sync8_${++n}`, usarMappersReales: true, orden: ORDEN, ...opciones } });
}
/* Recarga REAL de la página (mismo perfil de navegador, misma IndexedDB) y vuelve a montar el motor sobre la MISMA base. */
async function recargar(d, quien, nombreBd, opciones = {}) {
  const marca = "m" + Math.random();
  await d.eval((m) => { window.__marca = m; setTimeout(() => location.reload(), 50); return true; }, marca);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try { if ((await d.eval(() => (document.readyState === "complete" ? window.__marca || "nueva" : "cargando"), null, { plazoMs: 3000 })) === "nueva") break; } catch { /* orden perdida en la descarga */ }
  }
  await entrar(d, quien, { ...opciones, nombreBd });
}
const cola = (d) => d.eval(() => __bd.outbox.todos());
const locales = (d, e) => d.eval((e) => __bd.datos.todos(e), e);
const flush = (d) => d.eval(() => __motor.flush());
const pullTodo = (d, o = {}) => d.eval((o) => __motor.pullTodo(o), o);
const escribir = (d, e, datos) => d.eval((a) => __motor.escribir(a.e, a.datos), { e, datos });
const encolar = (d, nombre, params, meta) => d.eval((a) => __motor.encolarRpc(a.nombre, a.params, a.meta), { nombre, params, meta });
const sinEspera = (d) => d.eval(async () => { for (const o of await __bd.outbox.todos()) if (o.estado === "pending") await __bd.outbox.actualizar(o.seq, { siguiente_en: 0 }); });
const red = (d, cambios) => d.eval((c) => { Object.assign(window.__red, c); return true; }, cambios);
const registro = (d) => d.eval(() => window.__red.registro);
function paramsVenta(ventaId, cant, { offline = false, hace = 0 } = {}) {
  return { p_venta_id: ventaId, p_cliente_id: null, p_cliente_nombre: "Mostrador", p_metodo_pago: "efectivo", p_efectivo: 100 * cant,
    p_items: [{ item_id: crypto.randomUUID(), inventario_id: INV, nombre: "Aceite SYNC-8", cantidad: cant, precio: 100 }],
    p_occurred_at: new Date(Date.now() - hace).toISOString(), p_offline: offline, p_device: null };
}
const ventas = () => Number(uno(`select count(*) from public.ventas`));
const stock = (id = INV) => Number(uno(`select cantidad from public.inventario where id = '${id}'`));

for (const nav of NAVS) {
  describe(`SYNC-8 · hardening offline (pila real) · ${nav}`, () => {
    const abiertos = [];
    const abrir = async (...a) => { const d = await dispositivo(nav, ...a); abiertos.push(d); return d; };
    before(() => pila.limpiar());
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });

    test("venta: respuesta perdida tras aplicarse, cierre DURANTE el envío (syncing) + recarga real, cierre ANTES de enviar → UNA venta cada una", async () => {
      pila.limpiar(); sembrarRepuesto(10);
      const bdNombre = `sync8_crash_${nav}`;
      const d = await abrir("cajero", { nombreBd: bdNombre });
      // (1) el servidor aplica, la respuesta se pierde
      await encolar(d, "registrar_venta_v2", paramsVenta(crypto.randomUUID(), 1), { entidad: "ventas_rapidas", uid: "v-a", crea: true });
      await red(d, { perderRespuesta: 1 });
      assert.equal((await flush(d)).detenido, "red");
      assert.equal(ventas(), 1, "el servidor sí la aplicó");
      await sinEspera(d); assert.equal((await flush(d)).enviadas, 1);
      assert.equal(ventas(), 1, "el reintento con el mismo op_id no duplicó");
      // (2) cierre durante el envío: el servidor aplicó y la pestaña murió con la op en «syncing»
      const vid = crypto.randomUUID();
      const { seq } = await encolar(d, "registrar_venta_v2", paramsVenta(vid, 2), { entidad: "ventas_rapidas", uid: vid, crea: true });
      await red(d, { perderRespuesta: 1 }); await flush(d);
      await d.eval((s) => __bd.outbox.actualizar(s, { estado: "syncing" }), seq);
      await recargar(d, "cajero", bdNombre);
      const r = await flush(d);
      assert.equal(r.enviadas, 1); assert.equal((await cola(d)).length, 0, "nada colgado en «syncing»");
      assert.equal(ventas(), 2); assert.equal(Number(uno(`select count(*) from public.ventas where id = '${vid}'`)), 1);
      // (3) cierre ANTES de enviar
      await encolar(d, "registrar_venta_v2", paramsVenta(crypto.randomUUID(), 1), { entidad: "ventas_rapidas", uid: "v-c", crea: true });
      await recargar(d, "cajero", bdNombre);
      assert.equal((await flush(d)).enviadas, 1);
      assert.equal(ventas(), 3); assert.equal(stock(), 6, "10 − 1 − 2 − 1: stock movido UNA vez por venta");
      assert.equal(Number(uno(`select count(*) from public.caja_movimientos where venta_id is not null`)), 3);
      assert.equal(invariantes(), "[]");
    });

    test("temporales reales: 503, 502 (backend caído), petición colgada (tiempo agotado) y red caída con navigator.onLine=true → pendiente con espera, nada aplicado; luego UNA", async () => {
      pila.limpiar();
      const d = await abrir("cajero", { timeoutMs: 1500 });
      const c = await escribir(d, "clientes", { nombre: "Temporal" });
      for (const falla of [{ respuestas: [{ ruta: "/clientes", metodo: "POST", status: 503, cuerpo: { message: "Service Unavailable" } }] },
        { respuestas: [{ ruta: "/clientes", metodo: "POST", status: 502, cuerpo: "Bad Gateway" }] }, { colgar: 1 }, { soloSiguientes: 1 }]) {
        await red(d, falla);
        const r = await flush(d);
        assert.ok(["servidor", "red"].includes(r.detenido), JSON.stringify(r));
        const [op] = await cola(d);
        assert.equal(op.estado, "pending"); assert.ok(op.siguiente_en > Date.now(), "espera antes de reintentar");
        assert.equal(await d.eval(() => navigator.onLine), true, "el navegador creía estar en línea");
        assert.equal(nube(`select id from public.clientes`).length, 0, "nada aplicado");
        await sinEspera(d);
      }
      assert.equal((await flush(d)).enviadas, 1);
      assert.equal(nube(`select id from public.clientes where id = '${c.uid}'`).length, 1);
    });

    test("terminales REALES (23514 abono > saldo, 23503 crédito inexistente): rechazo sin reintento, visible en revisión y persistente tras recargar", async () => {
      pila.limpiar(); sembrarRepuesto(5);
      const bdNombre = `sync8_term_${nav}`;
      const d = await abrir("cajero", { nombreBd: bdNombre });
      const cr = crypto.randomUUID();
      await encolar(d, "registrar_credito", { p_credito_id: cr, p_cliente_id: null, p_cliente_nombre: "Luis", p_cliente_telefono: null,
        p_items: [{ item_id: crypto.randomUUID(), inventario_id: INV, nombre: "Aceite", cantidad: 1, precio: 100 }], p_vencimiento: null, p_nota: null,
        p_abono_inicial: 0, p_abono_metodo: null, p_occurred_at: new Date().toISOString(), p_offline: false, p_device: null, p_origen: null, p_orden_id: null }, { entidad: "creditos", uid: cr, crea: true });
      await encolar(d, "registrar_abono_v2", { p_credito_id: cr, p_monto: 500, p_metodo: "efectivo", p_occurred_at: new Date().toISOString(), p_device: null }, { entidad: "creditos", uid: cr });
      await encolar(d, "registrar_abono_v2", { p_credito_id: crypto.randomUUID(), p_monto: 5, p_metodo: "efectivo", p_occurred_at: new Date().toISOString(), p_device: null }, { entidad: "creditos", uid: "x" });
      const r = await flush(d);
      assert.equal(r.enviadas, 1); assert.equal(r.rechazadas, 2);
      const ops = await cola(d);
      assert.deepEqual(ops.map((o) => [o.estado, o.error?.codigo, o.error?.http]).sort(), [["rejected", "23503", 409], ["rejected", "23514", 400]]);
      const antes = (await registro(d)).length;
      await flush(d); await flush(d);
      assert.equal((await registro(d)).length, antes, "un terminal nunca se reintenta");
      await recargar(d, "cajero", bdNombre);
      const rev = await d.eval(() => __motor.revision());
      assert.equal(rev.rechazadas.length, 2, "persiste tras recargar");
      assert.ok(rev.rechazadas.every((x) => !("params" in x) && !("cambios" in x)), "sin parámetros (montos) en la lista");
      assert.equal(invariantes(), "[]");
    });

    test("sesión caducada: con token vencido o sin token NADA sale como anónimo ni se aplica; pausa sin gastar intentos; con sesión nueva sale con su autor", async () => {
      pila.limpiar();
      const d = await abrir("cajero");
      await escribir(d, "clientes", { nombre: "Sin sesión" });
      await d.eval((t) => { window.__token = t; window.__tokensRefresco = []; return true; }, pila.jwt(PERFILES.cajero, { segundos: -300 }));   // PostgREST tolera ~30 s de desfase de reloj
      const r = await flush(d);
      assert.equal(r.detenido, "auth", JSON.stringify({ r, reg: (await registro(d)).slice(-3), cola: await cola(d) }));
      const [op] = await cola(d); assert.equal(op.intentos, 0); assert.equal(op.estado, "pending");
      assert.deepEqual(await flush(d), { omitido: "auth" });
      await d.eval(() => { window.__token = null; __motor.reanudar(); return true; });
      const n0 = (await registro(d)).length;
      assert.equal((await flush(d)).detenido, "auth");
      assert.equal((await registro(d)).length, n0, "sin token no sale ninguna petición");
      assert.ok((await registro(d)).every((x) => x.a), "toda petición que salió llevaba Authorization");
      assert.equal(nube(`select id from public.clientes`).length, 0);
      await d.eval((t) => { window.__token = t; __motor.reanudar(); return true; }, pila.jwt(PERFILES.cajero));
      assert.equal((await flush(d)).enviadas, 1);
      assert.equal(nube(`select created_by from public.clientes`)[0].created_by, PERFILES.cajero);
    });

    test("perfil desactivado: con validarPerfil, fail closed — nada se envía ni se baja", async () => {
      pila.limpiar();
      const d = await abrir("cajero", { validarPerfil: true });
      await escribir(d, "clientes", { nombre: "Inactivo" });
      uno(`update public.perfiles set activo = false where id = '${PERFILES.cajero}'`);
      const r = await d.eval(() => __motor.sincronizar());
      assert.equal(r.flush.detenido, "cuenta-inactiva"); assert.deepEqual(r.pull, []);
      assert.equal(nube(`select id from public.clientes`).length, 0);
      assert.equal(await d.eval(() => __motor.reanudar()), false);
      uno(`update public.perfiles set activo = true where id = '${PERFILES.cajero}'`);
    });

    test("cambio de usuario en el mismo dispositivo: lo de A sale solo con A (created_by A); lo de B que depende de A espera y sale con B", async () => {
      pila.limpiar();
      const d = await abrir("cajero");
      const c = await escribir(d, "clientes", { nombre: "Cliente de A" });
      await d.eval((t) => { window.__token = t.tok; window.__sesion = { uid: t.id }; return true; }, { tok: pila.jwt(PERFILES.admin), id: PERFILES.admin });
      const m = await escribir(d, "motos", { clienteId: c.id, marca: "Honda", placa: "USR-1", km: 1 });
      let r = await flush(d);
      assert.equal(r.enviadas || 0, 0); assert.equal(nube(`select id from public.clientes`).length, 0, "B nunca envía lo de A");
      await d.eval((t) => { window.__token = t.tok; window.__sesion = { uid: t.id }; return true; }, { tok: pila.jwt(PERFILES.cajero), id: PERFILES.cajero });
      assert.equal((await flush(d)).enviadas, 1);
      await d.eval((t) => { window.__token = t.tok; window.__sesion = { uid: t.id }; return true; }, { tok: pila.jwt(PERFILES.admin), id: PERFILES.admin });
      assert.equal((await flush(d)).enviadas, 1);
      assert.equal(nube(`select created_by from public.clientes where id = '${c.uid}'`)[0].created_by, PERFILES.cajero);
      assert.equal(nube(`select created_by, cliente_id from public.motos where id = '${m.uid}'`)[0].created_by, PERFILES.admin);
    });

    test("device_id: estable al recargar, el mismo para Taller y caché de mecánico, distinto en otro dispositivo", async () => {
      const bdNombre = `sync8_dev_${nav}`;
      const d = await abrir("cajero", { nombreBd: bdNombre });
      const id1 = await d.eval(() => __bd.deviceId());
      const mec = await d.eval(async () => { const b = await SyncDB.abrir({ nombre: "entimotors_sync_mec_x" }); const i = await b.deviceId(); b.cerrar(); return i; });
      await recargar(d, "cajero", bdNombre);
      assert.equal(await d.eval(() => __bd.deviceId()), id1); assert.equal(mec, id1);
      assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const otro = await abrir("cajero");
      assert.notEqual(await otro.eval(() => __bd.deviceId()), id1);
    });

    test("dependencias: padre con 503 → el hijo espera (nunca 23503); padre rechazado (403) → hijo rechazado por dependencia SIN enviarse", async () => {
      pila.limpiar();
      const d = await abrir("cajero");
      const c = await escribir(d, "clientes", { nombre: "Padre" });
      await escribir(d, "motos", { clienteId: c.id, marca: "Yamaha", placa: "DEP-1", km: 1 });
      await red(d, { respuestas: [{ ruta: "/clientes", metodo: "POST", status: 503, cuerpo: {} }] });
      await flush(d); await flush(d);
      assert.equal((await registro(d)).filter((x) => x.m === "POST" && /\/motos/.test(x.u)).length, 0, "el hijo no salió");
      await sinEspera(d); assert.equal((await flush(d)).enviadas, 2);
      assert.equal(nube(`select cliente_id from public.motos`)[0].cliente_id, c.uid);
      // padre rechazado
      const c2 = await escribir(d, "clientes", { nombre: "Rechazado" });
      await escribir(d, "motos", { clienteId: c2.id, marca: "Suzuki", placa: "DEP-2", km: 1 });
      const antes = (await registro(d)).filter((x) => /\/motos/.test(x.u)).length;
      await red(d, { respuestas: [{ ruta: "/clientes", metodo: "POST", status: 403, cuerpo: { code: "42501", message: "rls" } }] });
      const r = await flush(d);
      assert.equal(r.rechazadas, 2);
      assert.equal((await registro(d)).filter((x) => /\/motos/.test(x.u)).length, antes, "el hijo nunca se envió");
      const rev = await d.eval(() => __motor.revision());
      assert.deepEqual(rev.rechazadas.map((x) => x.tipo).sort(), ["dependencia", "rechazada"]);
    });

    test("bootstrap de 300 clientes cortado en la página 3: incompleto y sin borrar lo bajado; al volver retoma, sin duplicados, relaciones completas", async () => {
      pila.limpiar();
      uno(`insert into public.clientes (nombre) select 'Boot ' || lpad(g::text, 4, '0') from generate_series(1, 300) g;
           insert into public.motos (cliente_id, marca, placa, km) select id, 'Boot', 'B' || substr(nombre, 6), 1 from public.clientes where nombre like 'Boot 03%';`);
      const d = await abrir("admin");
      await red(d, { caerTras: 2 });
      const r0 = await pullTodo(d, { pagina: 100 });
      assert.equal(r0.length, 1); assert.equal(r0[0].ok, false);
      let e = await d.eval(() => __motor.estado());
      assert.equal(e.bootstrapCompleto, false);
      assert.equal((await locales(d, "clientes")).length, 200); assert.equal((await locales(d, "motos")).length, 0);
      await red(d, { caerTras: null });
      const r = await pullTodo(d, { pagina: 100 });
      assert.ok(r.every((x) => x.ok), JSON.stringify(r));
      const cl = await locales(d, "clientes"), mo = await locales(d, "motos");
      assert.equal(cl.length, 300); assert.equal(new Set(cl.map((x) => x.uid)).size, 300);
      assert.ok(mo.length > 0 && mo.every((m) => cl.some((c) => c.id === m.clienteId)), "cada moto con su cliente local");
      e = await d.eval(() => __motor.estado()); assert.equal(e.bootstrapCompleto, true);
    });

    test("paginación real con páginas de 100: 0, 1, 100, 101 y 250 filas exactas, sin duplicados", async () => {
      const d = await abrir("admin");
      for (const k of [0, 1, 100, 101, 250]) {
        pila.limpiar();
        if (k) uno(`insert into public.clientes (nombre) select 'P' || g from generate_series(1, ${k}) g;`);
        await entrar(d, "admin", { nombreBd: `sync8_pag_${nav}_${k}` });
        const r = await d.eval(() => __motor.pull("clientes", { pagina: 100 }));
        const l = await locales(d, "clientes");
        assert.equal(r.total, k, `${k}`); assert.equal(l.length, k); assert.equal(new Set(l.map((x) => x.uid)).size, k);
      }
    });

    test("llave foránea que llega antes que su padre (creado tras bajar su tabla): se anota y se resuelve al terminar la descarga", async () => {
      pila.limpiar();
      const d = await abrir("admin");
      await d.eval(() => __motor.pull("clientes"));
      uno(`insert into public.clientes (id, nombre) values ('00000000-0000-4000-9000-000000000811', 'Tardío');
           insert into public.motos (cliente_id, marca, placa, km) values ('00000000-0000-4000-9000-000000000811', 'Tardía', 'FK-1', 1);`);
      await d.eval(() => __motor.pull("motos"));
      let [m] = await locales(d, "motos");
      assert.equal(m.clienteId, null); assert.equal((await d.eval(() => __motor.estado())).fkPendientes, 1);
      await pullTodo(d);
      [m] = await locales(d, "motos");
      const [c] = await locales(d, "clientes");
      assert.equal(m.clienteId, c.id); assert.equal((await d.eval(() => __motor.estado())).fkPendientes, 0);
    });

    test("conflictos CRUD entre dos dispositivos: mismo campo → conflicto visible (sin LWW); inventario maestro: la cantidad jamás se sobrescribe", async () => {
      pila.limpiar(); sembrarRepuesto(7);
      const A = await abrir("admin"), B = await abrir("admin");
      const c = await escribir(A, "clientes", { nombre: "Conflicto", telefono: "1" });
      await flush(A); await pullTodo(B);
      const [cb] = await locales(B, "clientes");
      await escribir(A, "clientes", { id: c.id, nombre: "Conflicto", telefono: "AAA" });
      await escribir(B, "clientes", { ...cb, telefono: "BBB" });
      await flush(A); const r = await flush(B);
      assert.equal(r.conflictos, 1); assert.equal(nube(`select telefono from public.clientes`)[0].telefono, "AAA");
      const rev = await B.eval(() => __motor.revision());
      assert.equal(rev.conflictos.length, 1); assert.deepEqual(rev.conflictos[0].campos, ["telefono"]);
      // maestro de inventario
      await pullTodo(A); await pullTodo(B);
      const ia = (await locales(A, "inventario"))[0], ib = (await locales(B, "inventario"))[0];
      await escribir(A, "inventario", { ...ia, precio: 120, cantidad: 999 });
      await escribir(B, "inventario", { ...ib, precio: 130, nombre: "Aceite 20W", cantidad: -5 });
      await flush(A); const r2 = await flush(B);
      assert.equal(r2.conflictos, 1, "mismo campo (precio): conflicto determinista, gana lo que ya estaba en la nube");
      const f = nube(`select precio_venta, nombre, cantidad from public.inventario where id = '${INV}'`)[0];
      assert.equal(Number(f.precio_venta), 120); assert.equal(Number(f.cantidad), 7, "la cantidad no participa del maestro");
      assert.equal(Number(uno(`select sum(cantidad) from public.inventario_movimientos where inventario_id = '${INV}'`)), 7, "stock = ledger");
      assert.equal(invariantes(), "[]");
    });

    test("ítems de orden A→B: A agrega por RPC; B baja el detalle (precio, costo, repuesto local); bajar NO descuenta stock; A quita → B lo ve", async () => {
      pila.limpiar(); sembrarRepuesto(4);
      const A = await abrir("admin"), B = await abrir("cajero");
      const cl = await escribir(A, "clientes", { nombre: "Orden A→B" });
      const mo = await escribir(A, "motos", { clienteId: cl.id, marca: "Honda", placa: "OAB-1", km: 1 });
      const or = await escribir(A, "ordenes", { clienteId: cl.id, motoId: mo.id, estado: "reparacion", falla: "x", mecanico: "Mec Uno", mecanicoId: PERFILES.mecanico, origenTrabajo: "taller" });
      await flush(A);
      const item = crypto.randomUUID();
      await encolar(A, "agregar_item_orden", { p_orden_id: or.uid, p_inventario_id: INV, p_nombre: "Aceite", p_cantidad: 2, p_precio: 150, p_item_id: item, p_offline: false, p_occurred_at: new Date().toISOString(), p_device: null }, { entidad: "ordenes", uid: or.uid });
      assert.equal((await flush(A)).enviadas, 1);
      assert.equal(stock(), 2);
      await pullTodo(B); await pullTodo(B);
      const ob = (await locales(B, "ordenes")).find((o) => o.uid === or.uid), ib = (await locales(B, "inventario"))[0];
      assert.equal(ob.items.length, 1);
      assert.deepEqual([ob.items[0].uid, ob.items[0].cantidad, ob.items[0].precio, ob.items[0].costoUnitario, ob.items[0].origenInventarioId], [item, 2, 150, 60, ib.id]);
      assert.equal(ib.cantidad, 2, "la existencia local es la del servidor"); assert.equal(stock(), 2, "bajar el ítem no movió stock");
      assert.equal(Number(uno(`select count(*) from public.inventario_movimientos where inventario_id = '${INV}'`)), 2, "apertura + UN movimiento del ítem");
      // mecánico: solo nombre y cantidad
      const M = await abrirDispositivo({ navegador: nav, nombre: `8-mec-${nav}-${++n}`, pagina: "pagina.html?mecanico=1" }); abiertos.push(M);
      await entrar(M, "mecanico", { orden: ["ordenes"] });
      await M.eval(() => __motor.pull("ordenes"));
      const [om] = await locales(M, "ordenes");
      assert.deepEqual(Object.keys(om.items[0]).sort(), ["cantidad", "nombre"]);
      // A quita
      await encolar(A, "quitar_item_orden", { p_item_id: item, p_device: null }, { entidad: "ordenes", uid: or.uid });
      assert.equal((await flush(A)).enviadas, 1);
      await pullTodo(B);
      assert.equal((await locales(B, "ordenes")).find((o) => o.uid === or.uid).items.length, 0);
      assert.equal((await locales(B, "inventario"))[0].cantidad, 4); assert.equal(stock(), 4);
      assert.equal(invariantes(), "[]");
    });

    test("venta sin red con sobreventa → al volver: stock negativo + requiere_revision en la nube Y en la caché; la venta NO se destruye", async () => {
      pila.limpiar(); sembrarRepuesto(1);
      const d = await abrir("cajero");
      const vid = crypto.randomUUID();
      await encolar(d, "registrar_venta_v2", paramsVenta(vid, 3, { offline: true, hace: 60000 }), { entidad: "ventas_rapidas", uid: vid, crea: true });
      await d.eval(() => __motor.sincronizar());
      const f = nube(`select cantidad, requiere_revision from public.inventario where id = '${INV}'`)[0];
      assert.equal(Number(f.cantidad), -2); assert.equal(f.requiere_revision, true);
      assert.equal(Number(uno(`select count(*) from public.ventas where id = '${vid}' and not anulada`)), 1, "la venta sigue");
      const [loc] = await locales(d, "inventario");
      assert.equal(loc.cantidad, -2); assert.equal(loc.requiereRevision, true);
      assert.equal(invariantes(), "[]");
    });

    test("dos pestañas del MISMO dispositivo envían a la vez (Web Locks y, sin ellos, arrendamiento): UN envío por operación", async () => {
      for (const sinLocks of [false, true]) {
        pila.limpiar(); sembrarRepuesto(20);
        const bdNombre = `sync8_tabs_${nav}_${sinLocks}`;
        const d = await abrir("cajero", { nombreBd: bdNombre, sinLocks });
        for (let i = 0; i < 4; i++) { const v = crypto.randomUUID(); await encolar(d, "registrar_venta_v2", paramsVenta(v, 1), { entidad: "ventas_rapidas", uid: v, crea: true }); }
        // segunda pestaña: un iframe del mismo origen (misma IndexedDB, mismos Web Locks), con su propio motor
        const r = await d.eval(async (a) => {
          const f = document.createElement("iframe"); f.src = "/__h/pestana.html"; document.body.appendChild(f);
          await new Promise((ok) => f.addEventListener("load", ok));
          for (let i = 0; i < 50 && !f.contentWindow.__montar; i++) await new Promise((ok) => setTimeout(ok, 100));
          const w = f.contentWindow; w.__token = window.__token; w.__sesion = window.__sesion; w.__habilitado = true;
          await w.__montar({ nombreBd: a.bd, usarMappersReales: true, sinLocks: a.sinLocks });
          const [x, y] = await Promise.all([__motor.flush(), w.__motor.flush()]);
          const posts = window.__red.registro.concat(w.__red.registro).filter((q) => q.m === "POST" && /registrar_venta_v2/.test(q.u)).length;
          return { x, y, posts };
        }, { bd: bdNombre, sinLocks });
        assert.equal(r.posts, 4, `${sinLocks ? "arrendamiento" : "Web Locks"}: ${JSON.stringify(r)}`);
        assert.ok(r.x.omitido === "otra-pestana" || r.y.omitido === "otra-pestana" || (r.x.enviadas || 0) + (r.y.enviadas || 0) === 4);
        assert.equal(ventas(), 4); assert.equal(stock(), 16);
        assert.equal(invariantes(), "[]");
      }
    });
  });
}
