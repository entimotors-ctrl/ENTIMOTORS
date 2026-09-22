// SYNC-4 · NÚCLEO DEL CLIENTE DE SINCRONIZACIÓN en navegadores REALES (Chrome y Firefox) contra PostgREST + Postgres reales (local).
//   node --test pruebas/sync/browser/sync-core.test.mjs          (requiere pruebas/sync/entorno-local.sh up y Docker)
//   SYNC_NAVEGADORES=chromium node --test …                       (uno solo)
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { iniciarPila, PERFILES, PG, DB } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

let n = 0;
/** Abre un dispositivo, fija sesión/token del usuario dado y monta el motor con una base local nueva. */
async function dispositivo(nav, quien = "cajero", opciones = {}) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `${quien}-${nav}-${++n}` });
  await entrar(d, quien, opciones);
  return d;
}
async function entrar(d, quien, opciones = {}) {
  const id = PERFILES[quien];
  return d.eval((a) => { window.__token = a.token; window.__sesion = { uid: a.id }; window.__habilitado = true; return __montar(a.op); },
    { token: pila.jwt(id), id, op: { nombreBd: `sync_${++n}`, ...opciones } });
}
const cliente = (d, datos) => d.eval((x) => __motor.escribir("clientes", x), datos);
const cola = (d) => d.eval(() => __bd.outbox.todos());
const locales = (d, e = "clientes") => d.eval((e) => __bd.datos.todos(e), e);
const flush = (d) => d.eval(() => __motor.flush());
const pull = (d, e = "clientes", o = {}) => d.eval((a) => __motor.pull(a.e, a.o), { e, o });
const sinEspera = (d) => d.eval(async () => { for (const o of await __bd.outbox.todos()) if (o.estado === "pending") await __bd.outbox.actualizar(o.seq, { siguiente_en: 0 }); });
const nube = (tabla, cols = "id, nombre, telefono, rev, created_by, deleted_at") => JSON.parse(pila.sql(`select coalesce(json_agg(t order by nombre), '[]') from (select ${cols} from public.${tabla}) t`));
const peticiones = (d) => d.eval(() => window.__red.registro);

for (const nav of NAVS) {
  describe(`SYNC-4 · núcleo del cliente · ${nav}`, () => {
    const abiertos = [];
    const abrir = async (...a) => { const d = await dispositivo(nav, ...a); abiertos.push(d); return d; };
    before(() => pila.limpiar());
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });

    test("la base entimotors_sync tiene sus tablas, device_id estable y NO se crea entimotors_os_demo", async () => {
      const d = await abrir("cajero", { nombreBd: "entimotors_sync" });
      const r = await d.eval(async () => {
        const id1 = await __bd.deviceId(); __bd.cerrar();
        const otra = await SyncDB.abrir({ nombre: "entimotors_sync" }); const id2 = await otra.deviceId();
        const tablas = [...otra.idb.objectStoreNames].sort(); const version = otra.idb.version; otra.cerrar();
        const dbs = (await indexedDB.databases()).map((x) => x.name);
        return { id1, id2, tablas, version, dbs };
      });
      assert.equal(r.id1, r.id2, "el device_id debe sobrevivir a cerrar y reabrir");
      assert.match(r.id1, /^[0-9a-f-]{36}$/);
      assert.equal(r.version, 1);
      for (const t of ["clientes", "motos", "citas", "ordenes", "inventario", "cotizaciones", "categorias_inv", "ventas_rapidas", "caja_movimientos", "creditos", "web_cms", "auditoria", "meta", "mapa", "outbox", "cursores", "conflictos", "blobs"]) assert.ok(r.tablas.includes(t), `falta la tabla ${t}`);
      assert.ok(!r.dbs.includes("entimotors_os_demo"), "el módulo de sync no debe crear ni tocar la base de siempre");
    });

    test("con la bandera APAGADA no escribe, no envía y no hace ninguna petición", async () => {
      const d = await abrir("cajero");
      const r = await d.eval(async () => {
        window.__habilitado = false;
        const a = await __motor.escribir("clientes", { nombre: "No debe guardarse" });
        const b = await __motor.flush(), c = await __motor.pull("clientes"), s = await __motor.sincronizar();
        return { a, b, c, s, peticiones: window.__red.registro.length, locales: await __bd.datos.todos("clientes"), cola: await __bd.outbox.todos() };
      });
      for (const x of [r.a, r.b, r.c, r.s]) assert.deepEqual(x, { omitido: "apagado" });
      assert.equal(r.peticiones, 0); assert.equal(r.locales.length, 0); assert.equal(r.cola.length, 0);
    });

    test("escribir es UNA transacción: registro + mapa + operación; una referencia rota no deja nada a medias", async () => {
      const d = await abrir("cajero");
      const c = await cliente(d, { nombre: "Ana", telefono: "555", creadoEn: 1700000000000 });
      assert.ok(c.id && c.uid);
      const [reg] = await locales(d); const ops = await cola(d);
      assert.equal(reg.uid, c.uid); assert.equal(reg._pend, true); assert.equal(reg._rev, 0);
      assert.equal(ops.length, 1); assert.equal(ops[0].kind, "insert"); assert.equal(ops[0].estado, "pending"); assert.equal(ops[0].uid, c.uid);
      assert.equal(ops[0].cambios.id, c.uid); assert.equal(ops[0].cambios.nombre, "Ana"); assert.equal(ops[0].cambios.creado_en, "2023-11-14T22:13:20.000Z");
      assert.match(ops[0].op_id, /^[0-9a-f-]{36}$/); assert.equal(ops[0].actor_uid, PERFILES.cajero);
      assert.equal(await d.eval((x) => __bd.mapa.uidDe("clientes", x), c.id), c.uid);
      const err = await d.eval(async () => { try { await __motor.escribir("motos", { marca: "X", clienteId: 9999 }); return null; } catch (e) { return String(e.message || e); } });
      assert.match(err, /no existe/);
      assert.equal((await locales(d, "motos")).length, 0); assert.equal((await cola(d)).length, 1);
    });

    test("varias ediciones antes de enviar = UNA operación; borrar algo que nunca subió la descarta", async () => {
      const d = await abrir("cajero");
      const c = await cliente(d, { nombre: "Luis" });
      await cliente(d, { id: c.id, nombre: "Luis P", telefono: "1" }); await cliente(d, { id: c.id, nombre: "Luis Pérez", telefono: "1" });
      const ops = await cola(d); assert.equal(ops.length, 1); assert.equal(ops[0].cambios.nombre, "Luis Pérez");
      const b = await d.eval((id) => __motor.escribir("clientes", { id }, { borrar: true }), c.id);
      assert.equal(b.descartada, true); assert.equal((await cola(d)).length, 0); assert.equal((await locales(d)).length, 0);
    });

    test("enviar: el alta llega a la nube, el servidor sella created_by/rev y la cola queda vacía", async () => {
      pila.limpiar();
      const d = await abrir("cajero");
      const c = await cliente(d, { nombre: "Marta", telefono: "300", creadoEn: 1700000000000 });
      const r = await flush(d);
      assert.equal(r.enviadas, 1); assert.equal(r.detenido, null);
      const filas = nube("clientes"); assert.equal(filas.length, 1);
      assert.equal(filas[0].id, c.uid); assert.equal(filas[0].created_by, PERFILES.cajero, "created_by lo sella el servidor con el token"); assert.equal(filas[0].rev, 1);
      const [reg] = await locales(d); assert.equal(reg._rev, 1); assert.equal(reg._pend, false); assert.equal(reg._base.nombre, "Marta");
      assert.equal((await cola(d)).length, 0);
    });

    test("respuesta perdida tras un alta ya aplicada: el reintento NO duplica (inserción idempotente)", async () => {
      pila.limpiar();
      const d = await abrir("cajero");
      const c = await cliente(d, { nombre: "Sin duplicar" });
      await d.eval(() => { window.__red.perderRespuesta = 1; });
      const r1 = await flush(d); assert.equal(r1.detenido, "red");
      assert.equal(nube("clientes").length, 1, "el servidor sí lo recibió");
      const [op] = await cola(d); assert.equal(op.estado, "pending"); assert.ok(op.siguiente_en > 0, "queda con espera antes de reintentar");
      await sinEspera(d);
      const r2 = await flush(d); assert.equal(r2.enviadas, 1);
      assert.equal(nube("clientes").length, 1, "seguía habiendo UNA sola fila"); assert.equal((await cola(d)).length, 0);
      assert.equal((await locales(d))[0]._rev, 1); assert.equal((await locales(d))[0].uid, c.uid);
    });

    test("actualizar envía PATCH SOLO con los campos cambiados y condicionado a la revisión", async () => {
      pila.limpiar();
      const d = await abrir("cajero");
      const c = await cliente(d, { nombre: "Pedro", telefono: "111" }); await flush(d);
      await d.eval(() => { window.__red.registro.length = 0; });
      await cliente(d, { id: c.id, nombre: "Pedro", telefono: "222" });
      assert.deepEqual(Object.keys((await cola(d))[0].cambios), ["telefono"]);
      await flush(d);
      const patch = (await peticiones(d)).find((p) => p.m === "PATCH");
      assert.ok(patch, "debe usar PATCH"); assert.match(patch.u, /rev=eq\.1/); assert.match(patch.u, new RegExp(`id=eq\\.${c.uid}`));
      assert.deepEqual(JSON.parse(patch.b), { telefono: "222" });
      assert.equal(nube("clientes")[0].telefono, "222"); assert.equal(nube("clientes")[0].rev, 2);
      assert.equal((await locales(d))[0]._rev, 2);
    });

    test("sin conexión: se guarda, se conserva y se envía al volver; nada se pierde", async () => {
      pila.limpiar();
      const d = await abrir("cajero");
      await d.eval(() => { window.__red.caida = true; });
      await cliente(d, { nombre: "Offline 1" }); await cliente(d, { nombre: "Offline 2" });
      const r = await flush(d); assert.equal(r.detenido, "red"); assert.equal(r.enviadas, 0);
      assert.equal((await cola(d)).length, 2); assert.ok((await cola(d)).every((o) => o.estado === "pending"));
      assert.equal(nube("clientes").length, 0);
      await d.eval(() => { window.__red.caida = false; }); await sinEspera(d);
      const r2 = await flush(d); assert.equal(r2.enviadas, 2); assert.equal(nube("clientes").length, 2); assert.equal((await cola(d)).length, 0);
    });

    test("descarga incremental: 2 300 registros con páginas de 500, cursor exacto, y la siguiente descarga no repite trabajo", async () => {
      pila.limpiar();
      pila.sql(`insert into public.clientes (nombre, telefono) select 'Cliente ' || lpad(g::text, 5, '0'), '3' || g from generate_series(1, 2300) g;`);
      const d = await abrir("admin");
      const r = await pull(d, "clientes", { pagina: 500 });
      assert.equal(r.ok, true); assert.equal(r.completo, true);
      const todos = await locales(d); assert.equal(todos.length, 2300);
      assert.equal(new Set(todos.map((x) => x.uid)).size, 2300); assert.equal(new Set(todos.map((x) => x.id)).size, 2300, "ids locales únicos");
      const gets = (await peticiones(d)).filter((p) => p.m === "GET"); assert.ok(gets.length >= 5, `esperaba ≥5 páginas, hubo ${gets.length}`);
      const cur = await d.eval(() => __bd.cursor.get("clientes")); assert.match(cur.t, /^\d{4}-\d{2}-\d{2}T/); assert.match(cur.id, /^[0-9a-f-]{36}$/);
      await d.eval(() => { window.__red.registro.length = 0; });
      const r2 = await pull(d, "clientes", { pagina: 500, solapamientoMs: 0 });      // cursor exacto, sin ventana de seguridad
      assert.equal(r2.ok, true); assert.equal((await locales(d)).length, 2300);
      assert.equal((await peticiones(d)).length, 1, "con el cursor exacto, una descarga sin novedades es UNA petición (la página vacía)");
      // Con la ventana de seguridad (60 s) lo recién creado se vuelve a leer A PROPÓSITO (por si una transacción se confirma tarde): el costo es
      // ancho de banda acotado (una relectura de la ventana), y lo local no cambia: mismos registros, mismos ids, mismas revisiones.
      const antes = await locales(d); await d.eval(() => { window.__red.registro.length = 0; });
      const r3 = await pull(d, "clientes", { pagina: 500 });
      assert.equal(r3.ok, true);
      assert.deepEqual((await locales(d)).map((x) => [x.id, x.uid, x._rev]), antes.map((x) => [x.id, x.uid, x._rev]), "releer la ventana no altera nada local");
      assert.ok((await peticiones(d)).length <= 6, "la relectura está acotada: 5 páginas de 500 + la vacía");
    });

    test("el servidor recorta la página (max-rows 1000) y aun así se descarga TODO", async () => {
      pila.limpiar();
      pila.sql(`insert into public.clientes (nombre) select 'Recorte ' || g from generate_series(1, 2500) g;`);
      const d = await abrir("admin");
      const r = await pull(d, "clientes", { pagina: 5000 });   // pide 5 000, el servidor solo da 1 000 por respuesta
      assert.equal(r.ok, true); assert.equal((await locales(d)).length, 2500, "si se detuviera en «página corta» faltarían 1 500");
    });

    test("solapamiento: una fila confirmada TARDE (sello anterior al cursor) igual llega en la siguiente descarga", async () => {
      pila.limpiar();
      const d = await abrir("admin");
      const psql = spawn("psql", ["-X", "-q", "-At", "-h", PG.host, "-p", String(PG.port), "-U", "supabase_admin", "-d", DB], { env: { ...process.env, PGPASSWORD: "postgres" } });
      psql.stdin.write(`begin; insert into public.clientes (nombre) values ('Tardío');\nselect 'listo';\n`);   // sello T1, sin confirmar
      await new Promise((r) => psql.stdout.once("data", r));
      pila.sql(`insert into public.clientes (nombre) values ('Temprano');`);                                  // sello T2 > T1, confirmado
      await pull(d);
      assert.deepEqual((await locales(d)).map((x) => x.nombre), ["Temprano"], "de momento solo se ve el confirmado");
      psql.stdin.write("commit;\n"); psql.stdin.end(); await new Promise((r) => psql.once("exit", r));
      await pull(d, "clientes", { solapamientoMs: 0 });
      assert.deepEqual((await locales(d)).map((x) => x.nombre), ["Temprano"], "CONTROL: con el cursor exacto y sin ventana, la fila tardía se pierde (el riesgo es real)");
      await pull(d);
      assert.deepEqual((await locales(d)).map((x) => x.nombre).sort(), ["Tardío", "Temprano"], "con la ventana de seguridad la fila tardía llega");
    });

    test("dos dispositivos editan CAMPOS DISTINTOS del mismo cliente: se fusionan sin conflicto", async () => {
      pila.limpiar();
      const a = await abrir("admin"), b = await abrir("cajero");
      const c = await cliente(a, { nombre: "Fusión", telefono: "1" }); await flush(a);
      await pull(b); const [cb] = await locales(b); assert.equal(cb.nombre, "Fusión");
      await cliente(a, { id: c.id, nombre: "Fusión SA", telefono: "1" });          // A cambia el nombre
      await cliente(b, { id: cb.id, nombre: "Fusión", telefono: "999" });           // B cambia el teléfono (sin ver lo de A)
      await flush(a); const rb = await flush(b);
      assert.equal(rb.conflictos, 0); assert.equal(rb.enviadas, 1);
      const f = nube("clientes")[0]; assert.equal(f.nombre, "Fusión SA"); assert.equal(f.telefono, "999"); assert.equal(f.rev, 3);
      const [xb] = await locales(b); assert.equal(xb.nombre, "Fusión SA", "B recibe el cambio de A al fusionar"); assert.equal(xb.telefono, "999");
      assert.equal((await b.eval(() => __bd.conflictos.todos())).length, 0);
    });

    test("MISMO campo con valores distintos = conflicto visible, sin perder ninguno de los dos; se resuelve «mío» o «servidor»", async () => {
      pila.limpiar();
      const a = await abrir("admin"), b = await abrir("cajero");
      const c = await cliente(a, { nombre: "Choque", telefono: "1" }); await flush(a);
      await pull(b); const [cb] = await locales(b);
      await cliente(a, { id: c.id, nombre: "Choque de A", telefono: "1" }); await flush(a);
      await cliente(b, { id: cb.id, nombre: "Choque de B", telefono: "1" });
      const rb = await flush(b); assert.equal(rb.conflictos, 1);
      assert.equal(nube("clientes")[0].nombre, "Choque de A", "la nube conserva lo de A");
      const confl = await b.eval(() => __bd.conflictos.todos()); assert.equal(confl.length, 1); assert.deepEqual(confl[0].campos, ["nombre"]); assert.equal(confl[0].mio.nombre, "Choque de B");
      assert.equal((await locales(b))[0].nombre, "Choque de B", "lo de B sigue a la vista hasta que decida");
      assert.equal((await cola(b))[0].estado, "conflict");
      await b.eval((id) => __motor.resolverConflicto(id, "mio"), confl[0].id);
      const r2 = await flush(b); assert.equal(r2.enviadas, 1); assert.equal(nube("clientes")[0].nombre, "Choque de B");
      await pull(a);      // A descarga lo que B acaba de subir; sin esto la edición de A parte de una revisión vieja y el conflicto lo tendría A (correcto), no B
      await cliente(a, { id: c.id, nombre: "Otra vez A", telefono: "1" }); await flush(a);
      const [cb2] = await locales(b); await cliente(b, { id: cb2.id, nombre: "Otra vez B", telefono: "1" });
      assert.equal((await flush(b)).conflictos, 1);
      const c2 = (await b.eval(() => __bd.conflictos.todos()))[0];
      await b.eval((id) => __motor.resolverConflicto(id, "servidor"), c2.id);
      assert.equal((await locales(b))[0].nombre, "Otra vez A"); assert.equal((await cola(b)).length, 0); assert.equal((await b.eval(() => __bd.conflictos.todos())).length, 0);
    });

    test("sesión caducada: se refresca UNA vez y se reintenta; si no se puede, la operación se CONSERVA (no se rechaza) y se pide iniciar sesión", async () => {
      pila.limpiar();
      const d = await abrir("cajero");
      await cliente(d, { nombre: "Token" });
      const caducado = pila.jwt(PERFILES.cajero, { segundos: -60 });
      await d.eval((a) => { window.__token = a.viejo; window.__tokensRefresco = [a.nuevo]; }, { viejo: caducado, nuevo: pila.jwt(PERFILES.cajero) });
      const r = await flush(d); assert.equal(r.enviadas, 1); assert.equal(await d.eval(() => window.__refrescos), 1);
      assert.equal(nube("clientes").length, 1);
      await cliente(d, { nombre: "Otro" });
      await d.eval((viejo) => { window.__token = viejo; window.__tokensRefresco = []; }, caducado);
      const r2 = await flush(d); assert.equal(r2.detenido, "auth");
      const ops = await cola(d); assert.equal(ops.length, 1); assert.equal(ops[0].estado, "pending", "no se rechaza por sesión caducada");
      assert.ok((await d.eval(() => window.__eventos)).includes("auth-requerida"));
    });

    test("permiso denegado por la nube (RLS): la operación se RECHAZA (no se reintenta) y queda a la vista", async () => {
      pila.limpiar();
      const d = await abrir("mecanico");
      await cliente(d, { nombre: "El mecánico no puede" });
      const r = await flush(d); assert.equal(r.rechazadas, 1); assert.equal(r.detenido, null);
      const [op] = await cola(d); assert.equal(op.estado, "rejected"); assert.equal(op.error.clase, "permiso"); assert.equal(nube("clientes").length, 0);
      const r2 = await flush(d); assert.equal(r2.enviadas, 0, "una operación rechazada no se reenvía sola");
    });

    test("eliminar: el cajero NO puede (queda rechazada y el registro vuelve); el admin sí, y el otro dispositivo lo ve desaparecer", async () => {
      pila.limpiar();
      const a = await abrir("admin"), c = await abrir("cajero");
      const x = await cliente(a, { nombre: "Para borrar" }); await flush(a);
      await pull(c); const [xc] = await locales(c);
      await c.eval((id) => __motor.escribir("clientes", { id }, { borrar: true }), xc.id);
      assert.equal((await locales(c)).length, 0, "desaparece de la pantalla al borrar");
      const r = await flush(c); assert.equal(r.rechazadas, 1);
      assert.equal((await locales(c)).length, 1, "al rechazarse, vuelve la versión de la nube");
      assert.equal(nube("clientes")[0].deleted_at, null);
      await a.eval((id) => __motor.escribir("clientes", { id }, { borrar: true }), x.id);
      assert.equal((await flush(a)).enviadas, 1); assert.notEqual(nube("clientes")[0].deleted_at, null, "borrado suave: la fila queda con deleted_at");
      await pull(c); assert.equal((await locales(c)).length, 0);
    });

    test("eliminar rechazado (403) y la red cae justo después: el registro vuelve con la copia que se tenía al borrar", async () => {
      pila.limpiar();
      const a = await abrir("admin"), c = await abrir("cajero");
      await cliente(a, { nombre: "Copia local", telefono: "7" }); await flush(a);
      await pull(c); const [xc] = await locales(c);
      await c.eval((id) => __motor.escribir("clientes", { id }, { borrar: true }), xc.id);
      assert.equal((await locales(c)).length, 0);
      await c.eval(() => { window.__red.caerTras = 1; });         // el PATCH llega y la nube contesta 403; la lectura que sigue ya no tiene red
      const r = await flush(c); assert.equal(r.rechazadas, 1);
      const [op] = await cola(c); assert.equal(op.estado, "rejected"); assert.equal(op.error.clase, "permiso"); assert.equal(op.error.http, 403);
      const salidas = await peticiones(c); assert.deepEqual(salidas.slice(-2).map((p) => p.m), ["PATCH", "GET"], "primero intentó la nube (el PATCH y luego la lectura, que ya no tuvo red)");
      const [vuelto] = await locales(c); assert.ok(vuelto, "el registro vuelve aunque en ese instante no haya red");
      assert.equal(vuelto.nombre, "Copia local"); assert.equal(vuelto.telefono, "7"); assert.equal(vuelto.uid, xc.uid); assert.equal(vuelto._rev, xc._rev); assert.equal(vuelto._pend, false);
      assert.equal(nube("clientes")[0].deleted_at, null, "la nube lo conserva");
    });

    test("llave foránea: la moto viaja con el uid del cliente y el otro dispositivo la enlaza con SU id local", async () => {
      pila.limpiar();
      const a = await abrir("admin"), b = await abrir("cajero");
      const cl = await cliente(a, { nombre: "Dueño" }); const mo = await a.eval((id) => __motor.escribir("motos", { marca: "Honda", modelo: "CB", placa: "ABC12", clienteId: id }), cl.id);
      const r = await flush(a); assert.equal(r.enviadas, 2, "cliente primero, moto después");
      assert.equal(JSON.parse(pila.sql("select json_agg(cliente_id) from public.motos"))[0], cl.uid);
      await b.eval(() => __motor.pullTodo());
      const [cb] = await locales(b, "clientes"), [mb] = await locales(b, "motos");
      assert.equal(mb.clienteId, cb.id, "clienteId apunta al id LOCAL del cliente en B"); assert.equal(mb.uid, mo.uid);
    });

    test("PIN: nunca entra en la cola (acciones con PIN y datos de autorización se rechazan)", async () => {
      const d = await abrir("cajero");
      const errores = await d.eval(async () => {
        const out = [];
        for (const [nombre, params] of [["ajustar_stock", { p_id: "x" }], ["reversar_venta", {}], ["registrar_movimiento_caja", { pin: "123456" }], ["registrar_abono_v2", { p_autorizacion_id: "a" }], ["registrar_abono_v2", { datos: { clave_cuenta: "x" } }]]) {
          try { await __motor.encolarRpc(nombre, params); out.push(null); } catch (e) { out.push(String(e.message)); }
        }
        return out;
      });
      assert.ok(errores.every((e) => e && /PIN|autorización/.test(e)), JSON.stringify(errores));
      const ok = await d.eval(() => __motor.encolarRpc("registrar_abono_v2", { p_monto: 5 }));
      assert.ok(ok.seq); const ops = await cola(d); assert.equal(ops.filter((o) => o.kind === "rpc").length, 1);
      assert.ok(!JSON.stringify(ops).match(/"pin"|autorizacion_id|clave_cuenta/i));
    });

    test("solo se envían las operaciones de QUIEN INICIÓ SESIÓN: las de otra persona esperan", async () => {
      pila.limpiar();
      const d = await abrir("cajero");
      await cliente(d, { nombre: "Del cajero" });
      await d.eval((a) => { window.__token = a.t; window.__sesion = { uid: a.id }; }, { t: pila.jwt(PERFILES.admin), id: PERFILES.admin });
      const r = await flush(d); assert.equal(r.enviadas, 0); assert.equal(nube("clientes").length, 0);
      assert.equal((await d.eval(() => __motor.estado())).deOtraPersona, 1);
      await d.eval((a) => { window.__token = a.t; window.__sesion = { uid: a.id }; }, { t: pila.jwt(PERFILES.cajero), id: PERFILES.cajero });
      assert.equal((await flush(d)).enviadas, 1); assert.equal(nube("clientes")[0].created_by, PERFILES.cajero, "queda a nombre de quien la creó");
    });

    test("dos pestañas: solo UNA envía a la vez (Web Locks) y la otra se omite; con arrendamiento en la base pasa lo mismo", async () => {
      for (const sinLocks of [false, true]) {
        pila.limpiar();
        const d = await abrir("cajero", { sinLocks });
        for (let i = 0; i < 6; i++) await cliente(d, { nombre: `Lote ${i}` });
        const r = await d.eval(async (sin) => {
          const bd2 = await SyncDB.abrir({ nombre: __bd.nombre });
          const rest2 = SyncRest.crear({ baseUrl: __pila.restUrl, anonKey: "x", getToken: async () => __token });
          const m2 = SyncEngine.crearMotor({ bd: bd2, rest: rest2, mappers: __mappers, sesion: () => __sesion, habilitado: () => true, locks: sin ? null : undefined });
          return Promise.all([__motor.flush(), m2.flush()]);
        }, sinLocks);
        const omitidos = r.filter((x) => x.omitido === "otra-pestana").length;
        assert.equal(omitidos, 1, `(${sinLocks ? "arrendamiento" : "Web Locks"}) una debe omitirse: ${JSON.stringify(r)}`);
        assert.equal(nube("clientes").length, 6, "sin duplicados"); assert.equal((await cola(d)).length, 0);
      }
    });
  });
}
