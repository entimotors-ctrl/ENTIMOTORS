// SYNC-6 · órdenes + Mi Trabajo (mecánicos reales, avance técnico, RLS) EN NAVEGADORES REALES contra
// PostgREST + Postgres reales (local), usando los MAPPERS DE VERDAD (taller-demo/sync-mappers.js) — igual que
// sync5-core.test.mjs. El mapper "ordenes" depende de window.ENTIMOTORS_BUILD (sync-mappers.js, cabecera): la
// página del arnés lo fija leyendo ?mecanico=1 de su propia URL (ver harness/pagina.html) — sin el parámetro se
// prueba el mapper del Taller (tabla "ordenes"), con él el de Mi Trabajo (tabla "rpc/ordenes_tecnico_mias").
//   node --test pruebas/sync/browser/sync6-core.test.mjs          (requiere pruebas/sync/entorno-local.sh up y Docker)
//   SYNC_NAVEGADORES=chromium node --test …                       (uno solo)
//
// NO CUBIERTO AQUÍ (infraestructura, no falta de intención — ver ENTIMOTORS-SYNC-3.14-STATE.md):
// Storage (fotos online/offline/ajena) — esta pila local solo levanta PostgREST, no el servicio de Storage;
// no hay endpoint /storage/v1/object real contra el que subir. Las políticas de Storage (taller_lee_media/
// taller_sube_media, mecanico_asignado_a_orden) son de SYNC-2, sin cambios en SYNC-6.
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES, uid } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const ORDEN = ["clientes", "motos", "citas", "categorias_inv", "cotizaciones", "ordenes"];
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

let n = 0;
/** quien: clave de PERFILES ("admin","cajero","mecanico","mecanico2") o un uuid ya sembrado. Los mecánicos
    cargan el arnés con ?mecanico=1 (mapper "ordenes" = rpc/ordenes_tecnico_mias); el resto, sin el parámetro
    (mapper "ordenes" = tabla real, igual que el Taller). */
async function dispositivo(nav, quien = "cajero", opciones = {}) {
  const esMec = opciones.mecanico ?? (quien === "mecanico" || quien === "mecanico2");
  const d = await abrirDispositivo({ navegador: nav, nombre: `${quien}-${nav}-${++n}`, pagina: esMec ? "pagina.html?mecanico=1" : "pagina.html" });
  await entrar(d, quien, opciones);
  return d;
}
async function entrar(d, quien, opciones = {}) {
  const id = PERFILES[quien] || quien;
  return d.eval((a) => { window.__token = a.token; window.__sesion = { uid: a.id }; window.__habilitado = true; return __montar(a.op); },
    { token: pila.jwt(id), id, op: { nombreBd: `sync6_${++n}`, usarMappersReales: true, orden: ORDEN, ...opciones } });
}
const escribir = (d, e, datos) => d.eval((a) => __motor.escribir(a.e, a.datos), { e, datos });
const encolarRpc = (d, nombre, params, meta) => d.eval((a) => __motor.encolarRpc(a.nombre, a.params, a.meta), { nombre, params, meta });
const cola = (d) => d.eval(() => __bd.outbox.todos());
const locales = (d, e) => d.eval((e) => __bd.datos.todos(e), e);
const flush = (d) => d.eval(() => __motor.flush());
const pull = (d, e, o = {}) => d.eval((a) => __motor.pull(a.e, a.o), { e, o });
const pullTodo = (d, o = {}) => d.eval((o) => __motor.pullTodo(o), o);
const nube = (tabla, cols) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (select ${cols} from public.${tabla}) t`));

/** Crea cliente+moto+orden (asignada a p_mecanico) por el mapper del Taller y hace flush. Devuelve {ordenUid, ordenLocalIdTaller}. */
async function crearOrdenAsignada(admin, { mecanico = PERFILES.mecanico, estado = "recibido", falla = "Frena mal" } = {}) {
  const cl = await escribir(admin, "clientes", { nombre: "Cliente de orden" });
  const mo = await escribir(admin, "motos", { clienteId: cl.id, marca: "Honda", modelo: "CB125", placa: "PBB" + String(Math.floor(Math.random() * 9999)).padStart(4, "0"), km: 1000 });
  const or = await escribir(admin, "ordenes", { clienteId: cl.id, motoId: mo.id, estado, falla, mecanico: "Mec Uno", mecanicoId: mecanico, origenTrabajo: "taller" });
  const r = await flush(admin);
  assert.equal(r.rechazadas, 0, "crear la orden de prueba no debería rechazarse: " + JSON.stringify(await cola(admin)));
  return { ordenUid: or.uid, ordenLocal: or.id };
}

for (const nav of NAVS) {
  describe(`SYNC-6 · mecánicos reales, órdenes y avance técnico (mappers reales) · ${nav}`, () => {
    const abiertos = [];
    const abrir = async (...a) => { const d = await dispositivo(nav, ...a); abiertos.push(d); return d; };
    before(() => pila.limpiar());
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });

    test("mecánico A ve su orden; mecánico B (otro perfil real) no ve nada de ella", async () => {
      pila.limpiar();
      const admin = await abrir("admin");
      const { ordenUid } = await crearOrdenAsignada(admin, { mecanico: PERFILES.mecanico });
      const a = await abrir("mecanico"), b = await abrir("mecanico2");
      assert.equal((await pull(a, "ordenes")).total, 1, "A tiene exactamente su orden asignada");
      const [oa] = await locales(a, "ordenes");
      assert.equal(oa.uid, ordenUid); assert.equal(oa.mecanicoId, PERFILES.mecanico);
      assert.equal((await pull(b, "ordenes")).total, 0, "B no ve la orden de A: mecanico_id no es el suyo");
      assert.equal((await locales(b, "ordenes")).length, 0);
    });

    test("el mecánico nunca recibe campos financieros ni el precio/costo de los ítems", async () => {
      pila.limpiar();
      const admin = await abrir("admin");
      const { ordenUid } = await crearOrdenAsignada(admin);
      // ítems y campos financieros sembrados directo en SQL (agregarlos por la RPC es de SYNC-7, ver SYNC-6 sección 6)
      pila.sql(`insert into public.orden_items (orden_id, nombre, cantidad, precio, costo_unitario, costo_estimado)
                values ('${ordenUid}', 'Pastillas de freno', 2, 450, 200, false);
                update public.ordenes set tipo_cobro = 'contado', metodo_pago = 'efectivo', margen = 55.5 where id = '${ordenUid}';`);
      const a = await abrir("mecanico");
      await pull(a, "ordenes");
      const [oa] = await locales(a, "ordenes");
      assert.equal(oa.items.length, 1); assert.equal(oa.items[0].nombre, "Pastillas de freno"); assert.equal(oa.items[0].cantidad, 2);
      for (const k of ["precio", "costoUnitario", "costo_unitario", "costoEstimado"]) assert.ok(!(k in oa.items[0]), `el ítem no debe traer "${k}"`);
      for (const k of ["margen", "tipoCobro", "tipo_cobro", "metodoPago", "metodo_pago", "abonoInicial", "creditoId"]) assert.ok(!(k in oa), `la orden del mecánico no debe traer "${k}"`);
    });

    test("avanzar_orden_tecnico: un paso permitido (recibido→diagnóstico) se aplica; un salto ilegal se rechaza y no cambia nada", async () => {
      pila.limpiar();
      const admin = await abrir("admin");
      const { ordenUid } = await crearOrdenAsignada(admin, { estado: "recibido" });
      const a = await abrir("mecanico");
      const r1 = await encolarRpc(a, "avanzar_orden_tecnico", { p_orden_id: ordenUid, p_campos: { estado: "diagnostico", diagnostico: { notas: "Pastillas gastadas" } } }, { entidad: "ordenes", uid: ordenUid });
      assert.equal((await flush(a)).enviadas, 1);
      assert.equal(nube("ordenes", "estado")[0].estado, "diagnostico");

      const r2 = await encolarRpc(a, "avanzar_orden_tecnico", { p_orden_id: ordenUid, p_campos: { estado: "reparacion" } }, { entidad: "ordenes", uid: ordenUid });
      const f2 = await flush(a);
      assert.equal(f2.rechazadas, 1, "de diagnóstico no se salta a reparación (falta presupuesto)");
      assert.equal(nube("ordenes", "estado")[0].estado, "diagnostico", "el estado no cambió con el intento rechazado");
    });

    test("avanzar_orden_tecnico: whitelist — el mecánico no reasigna ni toca dinero (rechazado, clase permiso)", async () => {
      pila.limpiar();
      const admin = await abrir("admin");
      const { ordenUid } = await crearOrdenAsignada(admin);
      const a = await abrir("mecanico");
      await encolarRpc(a, "avanzar_orden_tecnico", { p_orden_id: ordenUid, p_campos: { mecanico_id: PERFILES.mecanico2 } }, { entidad: "ordenes", uid: ordenUid });
      const r1 = await flush(a);
      assert.equal(r1.rechazadas, 1); assert.equal((await cola(a))[0].error.clase, "permiso");
      assert.equal(nube("ordenes", "mecanico_id")[0].mecanico_id, PERFILES.mecanico, "la asignación no cambió");

      const b = await abrir("mecanico");
      await encolarRpc(b, "avanzar_orden_tecnico", { p_orden_id: ordenUid, p_campos: { tipo_cobro: "contado" } }, { entidad: "ordenes", uid: ordenUid });
      const r2 = await flush(b);
      assert.equal(r2.rechazadas, 1, "tipo_cobro no está en la lista permitida");
      assert.equal((await cola(b))[0].error.clase, "permiso");
    });

    test("reasignada mientras el mecánico A estaba desconectado: al reconectar, su cambio se RECHAZA (no se sobrescribe la asignación)", async () => {
      pila.limpiar();
      const admin = await abrir("admin");
      const { ordenUid } = await crearOrdenAsignada(admin, { mecanico: PERFILES.mecanico });
      const a = await abrir("mecanico");
      // "desconectado": el cambio queda en la cola SIN flush — es justo la operación que se replay al volver la red.
      await encolarRpc(a, "avanzar_orden_tecnico", { p_orden_id: ordenUid, p_campos: { estado: "diagnostico" } }, { entidad: "ordenes", uid: ordenUid });
      pila.sql(`update public.ordenes set mecanico_id = '${PERFILES.mecanico2}', mecanico = 'Mec Dos' where id = '${ordenUid}'`);
      const r = await flush(a);
      assert.equal(r.rechazadas, 1);
      const op = (await cola(a))[0];
      assert.equal(op.error.clase, "permiso");
      assert.match(op.error.mensaje, /ya no está asignada a tu cuenta/i);
      assert.equal(nube("ordenes", "estado")[0].estado, "recibido", "el estado NO avanzó: la operación de A no se aplicó");
    });

    test("entregada/anulada mientras el mecánico A estaba desconectado: su cambio se RECHAZA (no se reabre)", async () => {
      pila.limpiar();
      const admin = await abrir("admin");
      const { ordenUid } = await crearOrdenAsignada(admin, { estado: "calidad" });
      const a = await abrir("mecanico");
      await encolarRpc(a, "avanzar_orden_tecnico", { p_orden_id: ordenUid, p_campos: { calidad_checklist: { limpieza: true } } }, { entidad: "ordenes", uid: ordenUid });
      pila.sql(`update public.ordenes set estado = 'entregado', finalizada = true, finalizado_en = clock_timestamp() where id = '${ordenUid}'`);
      const r = await flush(a);
      assert.equal(r.rechazadas, 1);
      const op = (await cola(a))[0];
      assert.equal(op.error.clase, "validacion");
      assert.match(op.error.mensaje, /ya no admite cambios técnicos/i);
    });

    test("avanzar_orden_tecnico es idempotente: repetir el mismo op_id no aplica el cambio dos veces", async () => {
      pila.limpiar();
      const admin = await abrir("admin");
      const { ordenUid } = await crearOrdenAsignada(admin, { estado: "recibido" });
      const a = await abrir("mecanico");
      const opId = "10000000-0000-4000-8000-000000000001";
      await encolarRpc(a, "avanzar_orden_tecnico", { p_orden_id: ordenUid, p_campos: { estado: "diagnostico" } }, { entidad: "ordenes", uid: ordenUid, op_id: opId });
      assert.equal((await flush(a)).enviadas, 1);
      assert.equal(nube("ordenes", "rev")[0].rev, 2, "sello: alta (rev 1) + un avance (rev 2)");
      await encolarRpc(a, "avanzar_orden_tecnico", { p_orden_id: ordenUid, p_campos: { estado: "diagnostico" } }, { entidad: "ordenes", uid: ordenUid, op_id: opId });
      assert.equal((await flush(a)).enviadas, 1, "el reintento con el mismo op_id se acepta (idempotente)…");
      assert.equal(nube("ordenes", "rev")[0].rev, 2, "…pero no vuelve a escribir la fila (misma revisión)");
    });

    test("perfil inactivo: rol_actual() falla cerrado — el mecánico dado de baja no ve ni puede avanzar nada", async () => {
      pila.limpiar();
      const admin = await abrir("admin");
      const { ordenUid } = await crearOrdenAsignada(admin, { mecanico: PERFILES.mecanico });
      pila.sql(`update public.perfiles set activo = false where id = '${PERFILES.mecanico}'`);
      const a = await abrir("mecanico");
      const r = await pull(a, "ordenes");
      assert.equal(r.total, 0, "inactivo: ordenes_tecnico_mias() no exige es_mecanico_activo() en vano");
      await encolarRpc(a, "avanzar_orden_tecnico", { p_orden_id: ordenUid, p_campos: { estado: "diagnostico" } }, { entidad: "ordenes", uid: ordenUid });
      const rf = await flush(a);
      assert.equal(rf.rechazadas, 1); assert.equal((await cola(a))[0].error.clase, "permiso");
    });

    test("bootstrap de dispositivo nuevo: un mecánico con cuenta real, sin restaurar nada a mano, baja su(s) orden(es) asignada(s)", async () => {
      pila.limpiar();
      const admin = await abrir("admin");
      await crearOrdenAsignada(admin, { mecanico: PERFILES.mecanico, falla: "Cadena floja" });
      await crearOrdenAsignada(admin, { mecanico: PERFILES.mecanico2, falla: "No debería verla" });
      const a = await abrir("mecanico");
      const r = await pullTodo(a);
      const rOrdenes = r.find((x) => x.entidad === "ordenes");
      assert.equal(rOrdenes.ok, true); assert.equal(rOrdenes.total, 1, "bootstrap: solo SU orden, nada de la del otro mecánico");
      const [oa] = await locales(a, "ordenes");
      assert.equal(oa.falla, "Cadena floja");
    });

    test("Taller: la orden creada por admin no lleva fotos/items en el push (quedan 100% locales hasta SYNC-7)", async () => {
      pila.limpiar();
      const admin = await abrir("admin");
      const { ordenUid } = await crearOrdenAsignada(admin);
      const fila = nube("ordenes", "fotos")[0];
      assert.ok(fila.fotos === null || (Array.isArray(fila.fotos) && fila.fotos.length === 0), "sin fotos en la nube: el Taller no las sincroniza todavía");
    });
  });
}
