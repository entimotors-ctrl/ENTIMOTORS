// SYNC-7A · inventario (maestro sincronizado + stock de apertura) EN NAVEGADORES REALES contra PostgREST +
// Postgres reales (local), usando los MAPPERS DE VERDAD (taller-demo/sync-mappers.js), mismo patrón que
// sync5-core.test.mjs/sync6-core.test.mjs. `cantidad` nunca viaja por el CRUD del maestro (ver la cabecera de
// sync-mappers.js): esta suite prueba el maestro (mapper) Y la RPC de apertura (sync-7a-inventario.sql,
// registrar_stock_inicial) por separado, y que nunca se pisan entre sí.
//   node --test pruebas/sync/browser/sync7a-core.test.mjs          (requiere pruebas/sync/entorno-local.sh up y Docker)
//   SYNC_NAVEGADORES=chromium node --test …                        (uno solo)
//
// NO CUBIERTO AQUÍ (es de SYNC-7B, no de SYNC-7A — ver ENTIMOTORS-SYNC-3.14-STATE.md): ventas/créditos/órdenes
// moviendo stock real, reversos de stock, requiere_revision por venta offline con stock negativo.
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES, uid } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const ORDEN = ["clientes", "motos", "citas", "categorias_inv", "inventario", "cotizaciones", "ordenes"];
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

let n = 0;
async function dispositivo(nav, quien = "admin", opciones = {}) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `${quien}-${nav}-${++n}` });
  await entrar(d, quien, opciones);
  return d;
}
async function entrar(d, quien, opciones = {}) {
  const id = PERFILES[quien] || quien;
  return d.eval((a) => { window.__token = a.token; window.__sesion = { uid: a.id }; window.__habilitado = true; return __montar(a.op); },
    { token: pila.jwt(id), id, op: { nombreBd: `sync7a_${++n}`, usarMappersReales: true, orden: ORDEN, ...opciones } });
}
const escribir = (d, e, datos) => d.eval((a) => __motor.escribir(a.e, a.datos), { e, datos });
const encolarRpc = (d, nombre, params, meta) => d.eval((a) => __motor.encolarRpc(a.nombre, a.params, a.meta), { nombre, params, meta });
const cola = (d) => d.eval(() => __bd.outbox.todos());
const locales = (d, e) => d.eval((e) => __bd.datos.todos(e), e);
const flush = (d) => d.eval(() => __motor.flush());
const pull = (d, e, o = {}) => d.eval((a) => __motor.pull(a.e, a.o), { e, o });
const pullTodo = (d, o = {}) => d.eval((o) => __motor.pullTodo(o), o);
const sinEspera = (d) => d.eval(async () => { for (const o of await __bd.outbox.todos()) if (o.estado === "pending") await __bd.outbox.actualizar(o.seq, { siguiente_en: 0 }); });
const nube = (tabla, cols) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (select ${cols} from public.${tabla}) t`));

/** Crea una categoría + un repuesto por el mapper real (admin), hace flush y devuelve {catUid, repUid, repLocal}. */
async function crearRepuesto(a, { nombre = "Repuesto de prueba", cantidad = 12, categoria = "Cat de prueba" } = {}) {
  const cat = await escribir(a, "categorias_inv", { nombre: categoria });
  const rep = await escribir(a, "inventario", {
    nombre, modelo: "Universal", cantidad, precio: 100, precioVenta: 100, costoCompra: 60,
    stockMinimo: 3, codigoBarras: "", categoriaId: cat.id, publicarEnWeb: false, foto: null,
  });
  const r = await flush(a);
  assert.equal(r.rechazadas, 0, "crear categoría+repuesto no debería rechazarse: " + JSON.stringify(await cola(a)));
  return { catUid: cat.uid, repUid: rep.uid, repLocalId: rep.id };
}

for (const nav of NAVS) {
  describe(`SYNC-7A · inventario maestro + stock de apertura (mappers reales) · ${nav}`, () => {
    const abiertos = [];
    const abrir = async (...a) => { const d = await dispositivo(nav, ...a); abiertos.push(d); return d; };
    before(() => pila.limpiar());
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });

    test("creación online: el maestro sube sin cantidad (nace en 0) y categoria_id resuelve por el mapa uid", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const { catUid, repUid } = await crearRepuesto(a, { nombre: "Filtro de aire", cantidad: 40 });
      const [fila] = nube("inventario", "id,nombre,cantidad,categoria_id");
      assert.equal(fila.nombre, "Filtro de aire");
      assert.equal(Number(fila.cantidad), 0, "el maestro nace en 0: cantidad nunca viaja por el CRUD (ver sync-mappers.js)");
      assert.equal(fila.categoria_id, catUid, "categoria_id resuelve al mismo mapa local↔uid que categorias_inv");
      const [local] = (await locales(a, "inventario")).filter((x) => x.uid === repUid);
      assert.equal(local.cantidad, 40, "localmente SÍ se conserva la cantidad con la que se llenó el formulario");
    });

    test("update del maestro (precio) nunca toca cantidad, ni local ni remota", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const { repUid, repLocalId } = await crearRepuesto(a, { cantidad: 15 });
      await encolarRpc(a, "registrar_stock_inicial", { p_inventario_id: repUid, p_cantidad: 15 }, { entidad: "inventario", uid: repUid });
      assert.equal((await flush(a)).rechazadas, 0);
      assert.equal(Number(nube("inventario", "cantidad").find(() => true).cantidad), 15);

      const rep = (await locales(a, "inventario")).find((x) => x.uid === repUid);
      await escribir(a, "inventario", { ...rep, id: repLocalId, precio: 999, precioVenta: 999 });
      assert.equal((await flush(a)).rechazadas, 0);
      const [fila] = nube("inventario", "precio_venta,cantidad");
      assert.equal(Number(fila.precio_venta), 999, "el precio sí cambió");
      assert.equal(Number(fila.cantidad), 15, "la cantidad sigue igual: la edición del maestro nunca la tocó");
    });

    test("creación offline → online: el alta del maestro se conserva y se envía sola al volver la red", async () => {
      pila.limpiar();
      const d = await abrir("admin");
      await d.eval(() => { window.__red.caida = true; });
      const cat = await escribir(d, "categorias_inv", { nombre: "Offline" });
      await escribir(d, "inventario", { nombre: "Creado sin red", modelo: "", cantidad: 5, precio: 50, precioVenta: 50, costoCompra: 20, stockMinimo: 1, codigoBarras: "", categoriaId: cat.id, publicarEnWeb: false, foto: null });
      const r1 = await flush(d);
      assert.equal(r1.detenido, "red"); assert.equal(r1.enviadas, 0);
      assert.equal(nube("inventario", "nombre").length, 0, "nada llegó todavía");

      await d.eval(() => { window.__red.caida = false; }); await sinEspera(d);
      const r2 = await flush(d);
      assert.equal(r2.enviadas, 2, "categoría + repuesto (la apertura no se encola sola: eso lo dispara app.js, fuera del harness sintético)");
      assert.equal(nube("inventario", "nombre").length, 1);
    });

    test("retry sin duplicado: respuesta perdida al crear un repuesto no lo duplica en la nube", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const cat = await escribir(a, "categorias_inv", { nombre: "Retry" }); await flush(a);
      await escribir(a, "inventario", { nombre: "No debe duplicarse", modelo: "", cantidad: 1, precio: 10, precioVenta: 10, costoCompra: 5, stockMinimo: 1, codigoBarras: "", categoriaId: cat.id, publicarEnWeb: false, foto: null });
      await a.eval(() => { window.__red.perderRespuesta = 1; });
      const r1 = await flush(a); assert.equal(r1.detenido, "red");
      assert.equal(nube("inventario", "nombre").length, 1, "la nube sí la recibió aunque la respuesta se perdió");
      await sinEspera(a);
      const r2 = await flush(a); assert.equal(r2.enviadas, 1);
      assert.equal(nube("inventario", "nombre").length, 1, "el reintento no duplicó el repuesto (INSERT idempotente)");
    });

    test("stock de apertura: registrar_stock_inicial mueve el ledger y deja cantidad materializada = lo pedido", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const { repUid } = await crearRepuesto(a, { cantidad: 30 });
      const r = await encolarRpc(a, "registrar_stock_inicial", { p_inventario_id: repUid, p_cantidad: 30 }, { entidad: "inventario", uid: repUid });
      assert.equal((await flush(a)).rechazadas, 0);
      const [fila] = nube("inventario", "cantidad");
      assert.equal(Number(fila.cantidad), 30);
      const movs = nube("inventario_movimientos", `tipo,cantidad,inventario_id`).filter((m) => m.inventario_id === repUid);
      assert.equal(movs.length, 1); assert.equal(movs[0].tipo, "apertura"); assert.equal(Number(movs[0].cantidad), 30);
    });

    test("idempotencia de apertura: el MISMO operation_id reintentado no duplica el movimiento", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const { repUid } = await crearRepuesto(a, { cantidad: 8 });
      const opId = "20000000-0000-4000-8000-000000000001";
      await encolarRpc(a, "registrar_stock_inicial", { p_inventario_id: repUid, p_cantidad: 8 }, { entidad: "inventario", uid: repUid, op_id: opId });
      await flush(a);
      await encolarRpc(a, "registrar_stock_inicial", { p_inventario_id: repUid, p_cantidad: 8 }, { entidad: "inventario", uid: repUid, op_id: opId });
      const r2 = await flush(a);
      assert.equal(r2.rechazadas, 0, "el mismo op_id no es un error: sync_op_iniciar devuelve el resultado guardado");
      const movs = nube("inventario_movimientos", "inventario_id").filter((m) => m.inventario_id === repUid);
      assert.equal(movs.length, 1, "mismo operation_id → UN solo movimiento, nunca dos");
    });

    test("contrato de migración (SYNC-9): una apertura CON OTRO operation_id sobre el mismo producto se rechaza (terminal, no se reintenta)", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const { repUid } = await crearRepuesto(a, { cantidad: 8 });
      await encolarRpc(a, "registrar_stock_inicial", { p_inventario_id: repUid, p_cantidad: 8 }, { entidad: "inventario", uid: repUid });
      assert.equal((await flush(a)).rechazadas, 0);
      await encolarRpc(a, "registrar_stock_inicial", { p_inventario_id: repUid, p_cantidad: 5 }, { entidad: "inventario", uid: repUid });
      const r2 = await flush(a);
      assert.equal(r2.rechazadas, 1, "una segunda apertura con OTRO op_id se rechaza: como máximo una apertura por producto");
      assert.equal((await cola(a))[0].error.clase, "validacion", "ERRCODE 22000: rechazo terminal, nunca se reintenta solo");
      const movs = nube("inventario_movimientos", "inventario_id").filter((m) => m.inventario_id === repUid);
      assert.equal(movs.length, 1, "el segundo intento no agregó un movimiento");
      assert.equal(Number(nube("inventario", "cantidad")[0].cantidad), 8, "la cantidad no cambió con el intento rechazado");
    });

    test("D-4: el cajero no crea ni edita el maestro de inventario (RLS real, rechazo terminal, sin red)", async () => {
      pila.limpiar();
      const a = await abrir("admin"), c = await abrir("cajero");
      // categoriaId: null a propósito — el dispositivo del cajero nunca sincronizó la categoría del admin,
      // así que un local_id ajeno ni siquiera resolvería (el punto de esta prueba es D-4, no la fk).
      await escribir(c, "inventario", { nombre: "Pastillas", modelo: "", cantidad: 1, precio: 10, precioVenta: 10, costoCompra: 5, stockMinimo: 1, codigoBarras: "", categoriaId: null, publicarEnWeb: false, foto: null });
      const rc = await flush(c);
      assert.equal(rc.rechazadas, 1); assert.equal((await cola(c))[0].error.clase, "permiso");
      assert.equal(nube("inventario", "nombre").length, 0, "el cajero no logró crear nada");
    });

    test("D-4: solo admin ejecuta registrar_stock_inicial — el cajero se rechaza aunque el producto ya exista", async () => {
      pila.limpiar();
      const a = await abrir("admin"), c = await abrir("cajero");
      const { repUid } = await crearRepuesto(a, { cantidad: 3 });
      await encolarRpc(c, "registrar_stock_inicial", { p_inventario_id: repUid, p_cantidad: 3 }, { entidad: "inventario", uid: repUid });
      const rc = await flush(c);
      assert.equal(rc.rechazadas, 1); assert.equal((await cola(c))[0].error.clase, "permiso");
      assert.equal(nube("inventario_movimientos", "id").length, 0, "el cajero no logró abrir stock");
    });

    test("bootstrap en un dispositivo nuevo: pullTodo trae el inventario completo con su categoría ya enlazada", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const { catUid, repUid } = await crearRepuesto(a, { nombre: "Bootstrap", categoria: "Cat bootstrap" });
      await encolarRpc(a, "registrar_stock_inicial", { p_inventario_id: repUid, p_cantidad: 7 }, { entidad: "inventario", uid: repUid });
      await flush(a);

      const b = await abrir("admin");
      const salida = await pullTodo(b);
      assert.ok(salida.every((r) => r.ok !== false), "bootstrap no debe fallar: " + JSON.stringify(salida));
      const [rep] = await locales(b, "inventario");
      const [catLocal] = (await locales(b, "categorias_inv")).filter((x) => x.uid === catUid);
      assert.equal(rep.nombre, "Bootstrap");
      assert.equal(rep.categoriaId, catLocal.id, "la fk ya reconstruida contra el id LOCAL de B, no el uid");
    });

    test("paginación >100: inventario con 250 filas baja completo, sin el límite de 100 de PostgREST", async () => {
      pila.limpiar();
      pila.sql(`insert into public.inventario (nombre, precio_venta, costo_compra) select 'Repuesto ' || lpad(g::text, 4, '0'), 10, 5 from generate_series(1, 250) g;`);
      const d = await abrir("admin");
      const r = await pull(d, "inventario", { pagina: 100 });
      assert.equal(r.ok, true); assert.equal(r.completo, true); assert.equal(r.total, 250);
      const todas = await locales(d, "inventario");
      assert.equal(todas.length, 250, "las 250 llegaron, no se cortó en 100");
      assert.equal(new Set(todas.map((x) => x.uid)).size, 250, "uid estable y único por fila");
    });

    test("mapping estable: el uid del repuesto no cambia entre ediciones sucesivas del maestro", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const { repUid, repLocalId } = await crearRepuesto(a);
      const rep = (await locales(a, "inventario")).find((x) => x.uid === repUid);
      const r2 = await escribir(a, "inventario", { ...rep, id: repLocalId, nombre: "Editado una vez" });
      const r3 = await escribir(a, "inventario", { ...rep, id: repLocalId, nombre: "Editado dos veces" });
      assert.equal(r2.uid, repUid); assert.equal(r3.uid, repUid);
      assert.equal((await flush(a)).rechazadas, 0);
      assert.equal(nube("inventario", "nombre")[0].nombre, "Editado dos veces");
    });

    test("pull() nunca pisa la cantidad local con la de la nube, aunque la nube cambie (venta local sin sincronizar, SYNC-7B)", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const { repUid, repLocalId } = await crearRepuesto(a, { cantidad: 20 });
      await encolarRpc(a, "registrar_stock_inicial", { p_inventario_id: repUid, p_cantidad: 20 }, { entidad: "inventario", uid: repUid });
      await flush(a);

      // simula una venta LOCAL que todavía no sincroniza stock (SYNC-7B no conectado): el TPV baja la cantidad
      // local a mano, exactamente como hace hoy DB.save("inventario", rep) tras un cobro. Como cantidad no es
      // columna del mapper, esto NO debe generar ningún outbox: es un cambio 100% local.
      const antes = (await locales(a, "inventario")).find((x) => x.uid === repUid);
      await escribir(a, "inventario", { ...antes, id: repLocalId, cantidad: 3 });
      assert.equal((await cola(a)).length, 0, "bajar la cantidad local no encola nada: cantidad no es una columna sincronizada");

      // otro dispositivo (o la propia apertura) deja la cantidad de la NUBE en un valor distinto (20) a propósito.
      pila.sql(`update public.inventario set nombre = 'Nombre actualizado por otro dispositivo' where id = '${repUid}'`);
      await pull(a, "inventario");
      const tras = (await locales(a, "inventario")).find((x) => x.uid === repUid);
      assert.equal(tras.nombre, "Nombre actualizado por otro dispositivo", "el nombre SÍ se actualiza con el pull");
      assert.equal(tras.cantidad, 3, "la cantidad local (venta sin sincronizar) NO se pisa con la de la nube (20)");
    });
  });
}
