// SYNC-5 · clientes, motos, citas, categorias_inv, cotizaciones+items EN NAVEGADORES REALES (Chrome y Firefox) contra
// PostgREST + Postgres reales (local), usando los MAPPERS DE VERDAD (taller-demo/sync-mappers.js), no la copia de
// prueba de SYNC-4: monta el motor con { usarMappersReales: true } (ver harness/montar.js).
//   node --test pruebas/sync/browser/sync5-core.test.mjs          (requiere pruebas/sync/entorno-local.sh up y Docker)
//   SYNC_NAVEGADORES=chromium node --test …                       (uno solo)
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES, uid } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const ORDEN = ["clientes", "motos", "citas", "categorias_inv", "cotizaciones"];
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

let n = 0;
/** Abre un dispositivo con los mappers REALES y el orden de dependencia completo de SYNC-5. `quien` acepta una
    clave de PERFILES o, para el perfil «inactivo» ad-hoc de la prueba de fail-closed, un uuid ya sembrado. */
async function dispositivo(nav, quien = "cajero", opciones = {}) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `${quien}-${nav}-${++n}` });
  await entrar(d, quien, opciones);
  return d;
}
async function entrar(d, quien, opciones = {}) {
  const id = PERFILES[quien] || quien;
  return d.eval((a) => { window.__token = a.token; window.__sesion = { uid: a.id }; window.__habilitado = true; return __montar(a.op); },
    { token: pila.jwt(id), id, op: { nombreBd: `sync5_${++n}`, usarMappersReales: true, orden: ORDEN, ...opciones } });
}
const escribir = (d, e, datos) => d.eval((a) => __motor.escribir(a.e, a.datos), { e, datos });
const borrar = (d, e, id) => d.eval((a) => __motor.escribir(a.e, { id: a.id }, { borrar: true }), { e, id });
const encolarRpc = (d, nombre, params, meta) => d.eval((a) => __motor.encolarRpc(a.nombre, a.params, a.meta), { nombre, params, meta });
const cola = (d) => d.eval(() => __bd.outbox.todos());
const locales = (d, e) => d.eval((e) => __bd.datos.todos(e), e);
const flush = (d) => d.eval(() => __motor.flush());
const pull = (d, e, o = {}) => d.eval((a) => __motor.pull(a.e, a.o), { e, o });
const pullTodo = (d, o = {}) => d.eval((o) => __motor.pullTodo(o), o);
const sinEspera = (d) => d.eval(async () => { for (const o of await __bd.outbox.todos()) if (o.estado === "pending") await __bd.outbox.actualizar(o.seq, { siguiente_en: 0 }); });
const peticiones = (d) => d.eval(() => window.__red.registro);
const nube = (tabla, cols) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (select ${cols} from public.${tabla}) t`));

for (const nav of NAVS) {
  describe(`SYNC-5 · clientes/motos/citas/categorias/cotizaciones (mappers reales) · ${nav}`, () => {
    const abiertos = [];
    const abrir = async (...a) => { const d = await dispositivo(nav, ...a); abiertos.push(d); return d; };
    before(() => pila.limpiar());
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });

    test("clientes: A crea → push → B pull; B edita el teléfono → A pull ve el cambio", async () => {
      pila.limpiar();
      const a = await abrir("admin"), b = await abrir("cajero");
      const c = await escribir(a, "clientes", { nombre: "Ana", telefono: "8888-0001" });
      assert.equal((await flush(a)).enviadas, 1);
      await pullTodo(b);
      const [cb] = await locales(b, "clientes");
      assert.equal(cb.nombre, "Ana"); assert.equal(cb.telefono, "8888-0001"); assert.equal(cb.uid, c.uid);

      await escribir(b, "clientes", { id: cb.id, nombre: "Ana", telefono: "8888-9999" });
      assert.equal((await flush(b)).enviadas, 1);
      await pullTodo(a);
      const [ca] = await locales(a, "clientes");
      assert.equal(ca.telefono, "8888-9999", "A ve el teléfono que cambió B");
    });

    test("motos: A crea cliente+moto → B recibe ambos con la relación intacta (id local de B, no el de A)", async () => {
      pila.limpiar();
      const a = await abrir("admin"), b = await abrir("cajero");
      const cl = await escribir(a, "clientes", { nombre: "Dueño de moto" });
      const mo = await escribir(a, "motos", { clienteId: cl.id, marca: "Honda", modelo: "CB125", placa: "PBB1234", km: 3200, cilindraje: "125cc" });
      assert.equal((await flush(a)).enviadas, 2, "cliente primero, moto después (fk resuelta)");
      assert.equal(nube("motos", "cliente_id")[0].cliente_id, cl.uid);

      await pullTodo(b);
      const [cb] = await locales(b, "clientes"), [mb] = await locales(b, "motos");
      assert.equal(mb.uid, mo.uid); assert.equal(mb.clienteId, cb.id, "clienteId en B apunta al id LOCAL de B, no al de A");
      // OJO: mb.clienteId puede coincidir NUMÉRICAMENTE con cl.id por pura coincidencia (A y B arrancan su
      // propio autoincrement en 1 cada uno) — lo que importa es que apunte al id local de ESTE dispositivo (línea de arriba).
      assert.equal(mb.marca, "Honda"); assert.equal(mb.km, 3200); assert.equal(mb.cilindraje, "125cc");
    });

    test("motos: foto en base64 nunca se sube (foto_path solo viaja si ya es una ruta)", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const cl = await escribir(a, "clientes", { nombre: "Con foto" });
      await escribir(a, "motos", { clienteId: cl.id, marca: "Yamaha", modelo: "FZ", placa: "XYZ999", km: 0, foto: "data:image/png;base64,AAAA" });
      await escribir(a, "motos", { clienteId: cl.id, marca: "Suzuki", modelo: "GN", placa: "QQQ111", km: 0, foto: "fotos/motos/qqq111.jpg" });
      assert.equal((await flush(a)).enviadas, 3);
      const filas = nube("motos", "placa, foto_path").sort((x, y) => x.placa.localeCompare(y.placa));
      assert.equal(filas.find((f) => f.placa === "XYZ999").foto_path, null, "base64 no se manda a foto_path");
      assert.equal(filas.find((f) => f.placa === "QQQ111").foto_path, "fotos/motos/qqq111.jpg", "una ruta de verdad sí viaja");
    });

    test("citas: A crea una cita → B la recibe; B la reprograma (fecha/hora/estado) → A ve el cambio", async () => {
      pila.limpiar();
      const a = await abrir("admin"), b = await abrir("cajero");
      const cl = await escribir(a, "clientes", { nombre: "Cliente con cita" });
      const ci = await escribir(a, "citas", { clienteId: cl.id, nombreTmp: "", telefonoTmp: "", fecha: "2026-10-01", hora: "09:00", motivo: "Revisión", mecanico: "Wilkin", origen: "taller", estado: "pendiente" });
      assert.equal((await flush(a)).enviadas, 2);
      await pullTodo(b);
      const [cib] = await locales(b, "citas");
      assert.equal(cib.uid, ci.uid); assert.equal(cib.fecha, "2026-10-01"); assert.equal(cib.hora, "09:00"); assert.equal(cib.estado, "pendiente");

      await escribir(b, "citas", { ...cib, fecha: "2026-10-03", hora: "14:30", estado: "reprogramada" });
      assert.equal((await flush(b)).enviadas, 1);
      await pullTodo(a);
      const [cia] = await locales(a, "citas");
      assert.equal(cia.fecha, "2026-10-03"); assert.equal(cia.hora, "14:30"); assert.equal(cia.estado, "reprogramada");
    });

    test("categorías: solo el admin crea/edita (RLS); el cajero se rechaza sin reintentar; el otro dispositivo la ve", async () => {
      pila.limpiar();
      const a = await abrir("admin"), c = await abrir("cajero");
      await escribir(c, "categorias_inv", { nombre: "Frenos" });
      const rc = await flush(c);
      assert.equal(rc.rechazadas, 1); assert.equal((await cola(c))[0].error.clase, "permiso");
      assert.equal(nube("categorias_inv", "nombre").length, 0, "el cajero no logró crear nada");

      const cat = await escribir(a, "categorias_inv", { nombre: "Frenos" });
      assert.equal((await flush(a)).enviadas, 1);
      await pullTodo(c);
      // el intento rechazado de c deja un registro local "fantasma" (correcto: un rechazo queda a la vista,
      // no se borra solo) — se busca puntualmente el que SÍ llegó de la nube, por uid.
      const catc = (await locales(c, "categorias_inv")).find((x) => x.uid === cat.uid);
      assert.ok(catc, "la categoría creada por el admin llega al pull del cajero"); assert.equal(catc.nombre, "Frenos");
    });

    test("cotización + items: la cabecera y los renglones viajan juntos; el otro dispositivo los ve embebidos al bajar", async () => {
      pila.limpiar();
      const a = await abrir("admin"), b = await abrir("cajero");
      const cl = await escribir(a, "clientes", { nombre: "Cliente cotiza" });
      const cot = await escribir(a, "cotizaciones", {
        clienteId: cl.id, clienteNombre: "Cliente cotiza", clienteTelefono: "7000-0000", motoId: null,
        motoDesc: "Honda CB125 · placa PBB1234", diagnostico: "Cambio de balatas", notas: "Precio válido 15 días",
        validezDias: 15, venceISO: new Date(Date.now() + 15 * 86400000).toISOString(), estado: "pendiente",
      });
      // igual que guardarSincronizado() en app.js: la cabecera primero, los renglones por la RPC idempotente
      const r1 = await encolarRpc(a, "sync_guardar_items_cotizacion", { p_cotizacion_id: cot.uid, p_items: [
        { nombre: "Balatas delanteras", cantidad: 1, precio: 450, inventario_id: null },
        { nombre: "Mano de obra", cantidad: 1, precio: 200, inventario_id: null },
      ] }, { entidad: "cotizaciones", uid: cot.uid });
      assert.match(r1.op_id, /^[0-9a-f-]{36}$/);
      const res = await flush(a);
      assert.equal(res.enviadas, 3, "cliente + cabecera (insert) + renglones (rpc)"); assert.equal(res.rechazadas, 0);

      const itemsNube = nube("cotizacion_items", "nombre, cantidad, precio").sort((x, y) => x.nombre.localeCompare(y.nombre));
      assert.equal(itemsNube.length, 2);
      assert.equal(itemsNube[0].nombre, "Balatas delanteras"); assert.equal(Number(itemsNube[0].cantidad), 1); assert.equal(Number(itemsNube[0].precio), 450);

      await pullTodo(b);
      const [cotb] = await locales(b, "cotizaciones");
      assert.equal(cotb.uid, cot.uid); assert.equal(cotb.clienteNombre, "Cliente cotiza"); assert.equal(cotb.estado, "pendiente");
      assert.equal(cotb.items.length, 2, "los renglones llegan EMBEBIDOS en la cabecera, sin un pull aparte");
      assert.deepEqual(cotb.items.map((it) => it.nombre).sort(), ["Balatas delanteras", "Mano de obra"]);
      assert.equal(cotb.items[0].inventarioId, null, "SYNC-5 no resuelve inventarioId a un uid de nube (inventario no está sincronizado todavía)");

      // editar reemplaza TODOS los renglones de una vez (idempotente): un renglón nuevo, uno quitado
      await encolarRpc(a, "sync_guardar_items_cotizacion", { p_cotizacion_id: cot.uid, p_items: [
        { nombre: "Balatas delanteras", cantidad: 1, precio: 450, inventario_id: null },
        { nombre: "Kit de arrastre", cantidad: 1, precio: 900, inventario_id: null },
      ] }, { entidad: "cotizaciones", uid: cot.uid });
      assert.equal((await flush(a)).enviadas, 1);
      await pullTodo(b, {});
      const [cotb2] = await locales(b, "cotizaciones");
      assert.deepEqual(cotb2.items.map((it) => it.nombre).sort(), ["Balatas delanteras", "Kit de arrastre"], "el pull del padre detecta el cambio de items (last_op_id sube su rev)");
    });

    test("cotización + items: reemplazo idempotente — repetir el mismo op_id no duplica renglones", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const cot = await escribir(a, "cotizaciones", { clienteId: null, clienteNombre: "Walk-in", validezDias: 15, venceISO: new Date().toISOString(), estado: "pendiente" });
      await flush(a);
      const opId = "10000000-0000-4000-8000-000000000001";
      await encolarRpc(a, "sync_guardar_items_cotizacion", { p_cotizacion_id: cot.uid, p_items: [{ nombre: "Aceite", cantidad: 1, precio: 300, inventario_id: null }] }, { entidad: "cotizaciones", uid: cot.uid, op_id: opId });
      await flush(a);
      assert.equal(nube("cotizacion_items", "nombre").length, 1);
      // la MISMA operación (mismo op_id) se reintenta a mano: sync_op_iniciar debe devolver el resultado guardado sin volver a correr el DELETE+INSERT
      await encolarRpc(a, "sync_guardar_items_cotizacion", { p_cotizacion_id: cot.uid, p_items: [{ nombre: "Aceite", cantidad: 1, precio: 300, inventario_id: null }] }, { entidad: "cotizaciones", uid: cot.uid, op_id: opId });
      await flush(a);
      assert.equal(nube("cotizacion_items", "nombre").length, 1, "mismo op_id no duplica ni vuelve a aplicar el reemplazo");
    });

    test("offline → online: categorías creadas sin red se conservan y se envían solas al volver", async () => {
      pila.limpiar();
      const d = await abrir("admin");
      await d.eval(() => { window.__red.caida = true; });
      await escribir(d, "categorias_inv", { nombre: "Sin red 1" });
      await escribir(d, "categorias_inv", { nombre: "Sin red 2" });
      const r1 = await flush(d);
      assert.equal(r1.detenido, "red"); assert.equal(r1.enviadas, 0);
      assert.equal((await cola(d)).length, 2); assert.equal(nube("categorias_inv", "nombre").length, 0, "nada se perdió, pero tampoco nada llegó todavía");

      await d.eval(() => { window.__red.caida = false; }); await sinEspera(d);
      const r2 = await flush(d);
      assert.equal(r2.enviadas, 2); assert.equal((await cola(d)).length, 0);
      assert.equal(nube("categorias_inv", "nombre").length, 2);
    });

    test("retry sin duplicado: respuesta perdida al crear una moto no la duplica en la nube", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const cl = await escribir(a, "clientes", { nombre: "Dueño retry" }); await flush(a);
      await escribir(a, "motos", { clienteId: cl.id, marca: "Bera", modelo: "SBR", placa: "RTY001", km: 10 });
      await a.eval(() => { window.__red.perderRespuesta = 1; });
      const r1 = await flush(a); assert.equal(r1.detenido, "red");
      assert.equal(nube("motos", "placa").length, 1, "la nube sí la recibió aunque la respuesta se perdió");
      await sinEspera(a);
      const r2 = await flush(a); assert.equal(r2.enviadas, 1);
      assert.equal(nube("motos", "placa").length, 1, "el reintento no duplicó la moto (INSERT idempotente)");
    });

    test("bootstrap en un dispositivo nuevo: pullTodo() trae las 5 entidades y reconstruye TODAS las relaciones sin restaurar nada a mano", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      const cl = await escribir(a, "clientes", { nombre: "Bootstrap" });
      const mo = await escribir(a, "motos", { clienteId: cl.id, marca: "Italika", modelo: "FT125", placa: "BOOT001", km: 500 });
      const ci = await escribir(a, "citas", { clienteId: cl.id, fecha: "2026-11-01", hora: "10:00", motivo: "Mantenimiento", estado: "pendiente" });
      const cat = await escribir(a, "categorias_inv", { nombre: "Bootstrap cat" });
      const cot = await escribir(a, "cotizaciones", { clienteId: cl.id, motoId: mo.id, clienteNombre: "Bootstrap", motoDesc: "Italika FT125", validezDias: 15, venceISO: new Date().toISOString(), estado: "pendiente" });
      await encolarRpc(a, "sync_guardar_items_cotizacion", { p_cotizacion_id: cot.uid, p_items: [{ nombre: "Filtro de aire", cantidad: 1, precio: 150, inventario_id: null }] }, { entidad: "cotizaciones", uid: cot.uid });
      await flush(a);

      // dispositivo B: base local nueva, sin cursor guardado — el mismo camino que un teléfono que nunca sincronizó
      const b = await abrir("cajero");
      assert.deepEqual(await locales(b, "clientes"), [], "arranca vacío, como cualquier base nueva");
      const resultado = await pullTodo(b);
      assert.ok(resultado.every((r) => r.ok !== false), "las 5 entidades bajan sin error");

      const [cb] = await locales(b, "clientes"), [mb] = await locales(b, "motos"), [cib] = await locales(b, "citas"), [catb] = await locales(b, "categorias_inv"), [cotb] = await locales(b, "cotizaciones");
      assert.equal(cb.nombre, "Bootstrap");
      assert.equal(mb.clienteId, cb.id, "la moto ya enlaza con el id LOCAL de B");
      assert.equal(cib.clienteId, cb.id);
      assert.equal(catb.nombre, "Bootstrap cat");
      assert.equal(cotb.clienteId, cb.id); assert.equal(cotb.motoId, mb.id);
      assert.equal(cotb.items.length, 1, "los renglones de la cotización también llegan en el bootstrap, embebidos");
      assert.equal(cotb.items[0].nombre, "Filtro de aire");
    });

    test("paginación >100: categorias_inv con 250 filas baja completo, sin el límite de 100 de PostgREST", async () => {
      pila.limpiar();
      pila.sql(`insert into public.categorias_inv (nombre) select 'Categoría ' || lpad(g::text, 4, '0') from generate_series(1, 250) g;`);
      const d = await abrir("admin");
      const r = await pull(d, "categorias_inv", { pagina: 100 });
      assert.equal(r.ok, true); assert.equal(r.completo, true); assert.equal(r.total, 250);
      const todas = await locales(d, "categorias_inv");
      assert.equal(todas.length, 250, "las 250 llegaron, no se cortó en 100");
      assert.equal(new Set(todas.map((x) => x.uid)).size, 250);
    });

    test("usuario inactivo: rol_actual() falla cerrado — ni push ni pull ven nada, aunque el token sea válido", async () => {
      pila.limpiar();
      const a = await abrir("admin");
      await escribir(a, "clientes", { nombre: "Visible solo para activos" }); await flush(a);

      const idInactivo = uid(50);
      pila.sql(`set session_replication_role = replica;
        insert into auth.users (id, email) values ('${idInactivo}', 'inactivo@example.test') on conflict (id) do nothing;
        insert into public.perfiles (id, nombre, rol, activo) values ('${idInactivo}', 'Cajero dado de baja', 'cajero', false)
          on conflict (id) do update set rol = excluded.rol, activo = false;
        reset session_replication_role;`);

      const d = await abrir(idInactivo);
      const r = await pull(d, "clientes");
      assert.equal(r.ok, true); assert.equal(r.total, 0, "rol_actual() vacío: la política de SELECT no deja ver ni una fila");
      assert.equal((await locales(d, "clientes")).length, 0);

      await escribir(d, "clientes", { nombre: "No debería quedar" });
      const rf = await flush(d);
      assert.equal(rf.rechazadas, 1, "el INSERT también se rechaza: fail-closed en escritura, no solo en lectura");
      assert.equal((await cola(d))[0].error.clase, "permiso");
      assert.equal(nube("clientes", "nombre").length, 1, "sigue habiendo solo el cliente que creó el admin");
    });
  });
}
