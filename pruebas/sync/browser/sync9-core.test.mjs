// SYNC-9 · FOTOS + STORAGE REAL: storage-api de Supabase (v1.60.15, contenedor propio de la pila, 127.0.0.1, backend de
// archivos efímero) + PostgREST + Postgres reales, con las políticas de Storage de SYNC-2 y los buckets de producción.
//   1) MATRIZ RLS RUNTIME (subir/leer/firmar/listar/reemplazar/borrar × propio/otro mecánico/admin/cajero/anónimo/inactivo,
//      rutas manipuladas, URL pública del bucket privado, metadata apuntando a lo ajeno) — por HTTP, como el navegador.
//   2) FLUJOS DEL CLIENTE REAL (sync-fotos.js + motor) en navegadores reales: sin red → recarga → con red → Storage +
//      ligado → OTRO dispositivo lo ve; respuesta perdida; cierres; sesión caducada; dos dispositivos sin pisarse; dos
//      pestañas; agregar_foto_orden con sus rechazos; límites del bucket. Todo se afirma en la NUBE.
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/sync9-core.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES, REST_URL } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const BUCKET = "entimotors-taller";
const CLI = "00000000-0000-4000-9000-000000000950";
let pila;
before(async () => { pila = await iniciarPila({ storage: true }); });
after(async () => { await pila?.detener(); });

const uno = (q) => pila.sql(q);
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (${q}) t`));
const invariantes = () => uno(`select public.verificar_invariantes()::text`);
const tok = (quien, o) => (quien === "anon" ? pila.jwt(null, { role: "anon" }) : pila.jwt(PERFILES[quien], o));
const JPEG = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5, 0xff, 0xd9])], { type: "image/jpeg" });
/** Una orden por prueba (UUID nuevo, limpieza por ids propios): asignada a `mecanico`. */
function orden({ mecanico = PERFILES.mecanico, estado = "recibido" } = {}) {
  const id = crypto.randomUUID();
  uno(`insert into public.clientes (id, nombre) values ('${CLI}', 'Cliente fotos') on conflict (id) do nothing;
       insert into public.ordenes (id, cliente_id, estado, falla, mecanico, mecanico_id, origen_trabajo) values ('${id}', '${CLI}', '${estado}', 'x', 'Mec', ${mecanico ? `'${mecanico}'` : "null"}, 'taller');`);
  return id;
}
async function http(metodo, ruta, quien, { cuerpo, tipo = "image/jpeg", cabeceras = {} } = {}) {
  const h = { apikey: "anon-sintetica", ...cabeceras };
  if (quien) h.Authorization = "Bearer " + (quien.startsWith("ey") ? quien : tok(quien));
  if (cuerpo !== undefined) h["Content-Type"] = typeof cuerpo === "string" ? "application/json" : tipo;
  const r = await fetch(`${REST_URL}/storage/v1${ruta}`, { method: metodo, headers: h, body: cuerpo });
  const texto = await r.text(); let j = null; try { j = JSON.parse(texto); } catch { /* binario */ }
  return { http: r.status, codigo: Number(j && j.statusCode) || r.status, ok: r.status >= 200 && r.status < 300, j, texto };
}
const subir = (path, quien, o = {}) => http("PUT", `/object/${BUCKET}/${path}`, quien, { cuerpo: o.blob || JPEG(), tipo: o.tipo, cabeceras: { "x-upsert": o.upsert ? "true" : "false" } });
const objetos = (prefijo) => nube(`select name from storage.objects where bucket_id = '${BUCKET}' and name like '${prefijo}%' order by name`).map((x) => x.name);

describe("SYNC-9 · STORAGE RLS en runtime (storage-api real + políticas SYNC-2) — matriz y negativos", () => {
  test("SUBIR (INSERT): mecánico asignado SÍ; otro mecánico, cajero-a-otra-carpeta, anónimo, inactivo, sin token, token vencido: NO", async () => {
    const o = orden(), p = `ordenes/${o}/${crypto.randomUUID()}.jpg`;
    assert.equal((await subir(p, "mecanico")).ok, true, "propio");
    for (const [quien, esperado] of [["mecanico2", 403], ["anon", 403]]) {
      const r = await subir(`ordenes/${o}/${crypto.randomUUID()}.jpg`, quien);
      assert.equal(r.ok, false, quien); assert.equal(r.codigo, esperado, `${quien}: ${r.texto}`);
    }
    const sin = await http("PUT", `/object/${BUCKET}/ordenes/${o}/${crypto.randomUUID()}.jpg`, null, { cuerpo: JPEG() });
    assert.equal(sin.ok, false, "sin Authorization");
    const vencido = await subir(`ordenes/${o}/${crypto.randomUUID()}.jpg`, tok("mecanico", { segundos: -600 }));
    assert.equal(vencido.ok, false); assert.match(vencido.j.message, /exp/);
    uno(`update public.perfiles set activo = false where id = '${PERFILES.mecanico}'`);
    try { assert.equal((await subir(`ordenes/${o}/${crypto.randomUUID()}.jpg`, "mecanico")).codigo, 403, "inactivo"); }
    finally { uno(`update public.perfiles set activo = true where id = '${PERFILES.mecanico}'`); }
    // admin/cajero (ve_todo_el_taller) suben en ordenes/motos/inventario; nunca fuera de esas carpetas
    assert.equal((await subir(`ordenes/${o}/${crypto.randomUUID()}.jpg`, "cajero")).ok, true, "cajero: contrato SYNC-2 (ve todo el taller)");
    assert.equal((await subir(`otra/${o}/${crypto.randomUUID()}.jpg`, "admin")).codigo, 403, "carpeta fuera del contrato");
    assert.equal(objetos(`ordenes/${o}/`).length, 2, "solo lo permitido quedó guardado");
  });

  test("RUTAS MANIPULADAS: ../, %2e%2e, uuid ajeno, orden de otro, carpeta de más niveles, orden cerrada → DENEGADO", async () => {
    const mia = orden(), ajena = orden({ mecanico: PERFILES.mecanico2 }), cerrada = orden({ estado: "entregado" });
    for (const p of [`ordenes/${mia}/../${ajena}/${crypto.randomUUID()}.jpg`, `ordenes/${mia}/%2e%2e/${ajena}/x.jpg`, `ordenes/${ajena}/${crypto.randomUUID()}.jpg`,
      `ordenes/${mia}/sub/${crypto.randomUUID()}.jpg`, `ordenes/${crypto.randomUUID()}/${crypto.randomUUID()}.jpg`, `ordenes/${cerrada}/${crypto.randomUUID()}.jpg`, `ordenes/no-es-uuid/x.jpg`]) {
      const r = await subir(p, "mecanico");
      assert.equal(r.ok, false, p);
    }
    assert.equal(objetos(`ordenes/${ajena}/`).length + objetos(`ordenes/${cerrada}/`).length, 0);
  });

  test("LEER / FIRMAR / LISTAR: propio y admin/cajero SÍ; otro mecánico, anónimo e inactivo NO (ni siquiera saben que existe); URL pública del bucket privado NO", async () => {
    const o = orden(), p = `ordenes/${o}/${crypto.randomUUID()}.jpg`;
    assert.equal((await subir(p, "mecanico")).ok, true);
    const firmar = (quien) => http("POST", `/object/sign/${BUCKET}/${p}`, quien, { cuerpo: JSON.stringify({ expiresIn: 60 }) });
    const leer = (quien) => http("GET", `/object/authenticated/${BUCKET}/${p}`, quien);
    const info = (quien) => http("GET", `/object/info/authenticated/${BUCKET}/${p}`, quien);
    const listar = (quien) => http("POST", `/object/list/${BUCKET}`, quien, { cuerpo: JSON.stringify({ prefix: `ordenes/${o}`, limit: 100 }) });
    for (const q of ["mecanico", "admin", "cajero"]) {
      assert.equal((await firmar(q)).ok, true, `firmar ${q}`); assert.equal((await leer(q)).ok, true, `leer ${q}`);
      assert.equal((await listar(q)).j.length, 1, `listar ${q}`);
    }
    for (const q of ["mecanico2", "anon"]) {
      assert.equal((await firmar(q)).codigo, 404, `firmar ${q}`); assert.equal((await leer(q)).codigo, 404, `leer ${q}`);
      assert.equal((await info(q)).codigo, 404, `info ${q}: no revela existencia`); assert.deepEqual((await listar(q)).j, [], `listar ${q}`);
    }
    uno(`update public.perfiles set activo = false where id = '${PERFILES.mecanico}'`);
    try { assert.equal((await firmar("mecanico")).codigo, 404, "inactivo no firma"); assert.deepEqual((await listar("mecanico")).j, []); }
    finally { uno(`update public.perfiles set activo = true where id = '${PERFILES.mecanico}'`); }
    const pub = await fetch(`${REST_URL}/storage/v1/object/public/${BUCKET}/${p}`, { headers: { apikey: "a" } });
    assert.notEqual(pub.status, 200, "el bucket es privado: no hay URL pública");
    // enumeración: el otro mecánico lista TODO «ordenes/» y no ve nada que no sea suyo
    const todo = await http("POST", `/object/list/${BUCKET}`, "mecanico2", { cuerpo: JSON.stringify({ prefix: "ordenes", limit: 1000 }) });
    assert.ok(!JSON.stringify(todo.j).includes(o), "sin enumeración de órdenes ajenas");
  });

  test("REEMPLAZAR / BORRAR: el mecánico no reemplaza (sin upsert, ni el suyo) ni borra; otro mecánico tampoco; solo el admin borra (política de producción)", async () => {
    const o = orden(), p = `ordenes/${o}/${crypto.randomUUID()}.jpg`;
    assert.equal((await subir(p, "mecanico")).ok, true);
    for (const q of ["mecanico", "mecanico2"]) {
      assert.equal((await subir(p, q, { upsert: true })).ok, false, `upsert ${q}`);
      assert.equal((await http("DELETE", `/object/${BUCKET}/${p}`, q)).ok, false, `borrar ${q}`);
      assert.equal((await http("DELETE", `/object/${BUCKET}`, q, { cuerpo: JSON.stringify({ prefixes: [p] }) })).j?.length || 0, 0, `borrado masivo ${q}`);
    }
    assert.equal((await http("DELETE", `/object/${BUCKET}/${p}`, "cajero")).ok, false, "cajero no borra");
    assert.deepEqual(objetos(`ordenes/${o}/`), [p], "sigue intacto");
    assert.equal((await http("DELETE", `/object/${BUCKET}/${p}`, "admin")).ok, true, "admin sí (taller_borra_media)");
    assert.deepEqual(objetos(`ordenes/${o}/`), []);
  });

  test("METADATA manipulada: `fotos` apuntando a una foto AJENA no la hace legible; agregar_foto_orden rechaza rutas ajenas, objetos inexistentes y vacíos", async () => {
    const mia = orden(), ajena = orden({ mecanico: PERFILES.mecanico2 });
    const pa = `ordenes/${ajena}/${crypto.randomUUID()}.jpg`;
    assert.equal((await subir(pa, "mecanico2")).ok, true);
    uno(`update public.ordenes set fotos = '["${pa}"]'::jsonb where id = '${mia}'`);   // aunque la metadata la liste…
    assert.equal((await http("POST", `/object/sign/${BUCKET}/${pa}`, "mecanico", { cuerpo: JSON.stringify({ expiresIn: 60 }) })).codigo, 404, "…Storage decide por la RUTA del objeto");
    const rpc = async (params) => { const r = await fetch(`${REST_URL}/rest/v1/rpc/agregar_foto_orden`, { method: "POST", headers: { apikey: "a", Authorization: "Bearer " + tok("mecanico"), "Content-Type": "application/json" }, body: JSON.stringify({ p_op: crypto.randomUUID(), p_device: null, ...params }) }); return { status: r.status, j: await r.json() }; };
    assert.equal((await rpc({ p_orden_id: mia, p_path: pa })).j.code, "22023", "ruta de otra orden");
    assert.equal((await rpc({ p_orden_id: mia, p_path: `ordenes/${mia}/${crypto.randomUUID()}.jpg` })).j.code, "23503", "el objeto no existe");
    assert.equal((await rpc({ p_orden_id: mia, p_path: `ordenes/${mia}/../x.jpg` })).j.code, "22023");
    assert.equal((await rpc({ p_orden_id: ajena, p_path: pa })).j.code, "42501", "orden de otro mecánico");
    const vacia = `ordenes/${mia}/${crypto.randomUUID()}.jpg`;
    assert.equal((await subir(vacia, "mecanico", { blob: new Blob([], { type: "image/jpeg" }) })).ok, true);
    assert.equal((await rpc({ p_orden_id: mia, p_path: vacia })).j.code, "22023", "objeto vacío");
    const anon = await fetch(`${REST_URL}/rest/v1/rpc/agregar_foto_orden`, { method: "POST", headers: { apikey: "a", Authorization: "Bearer " + tok("anon"), "Content-Type": "application/json" }, body: JSON.stringify({ p_op: crypto.randomUUID(), p_orden_id: mia, p_path: vacia }) });
    assert.ok([401, 403].includes(anon.status), "anónimo no ejecuta la RPC");
  });

  test("LÍMITES del bucket privado: solo image/jpeg y ≤ 10 MiB (nada de text/plain vacío ni archivos enormes)", async () => {
    const o = orden();
    const txt = await subir(`ordenes/${o}/${crypto.randomUUID()}.jpg`, "mecanico", { blob: new Blob(["hola"], { type: "text/plain" }), tipo: "text/plain" });
    assert.equal(txt.ok, false, "MIME incorrecto"); assert.equal(txt.codigo, 415, txt.texto);
    const png = await subir(`ordenes/${o}/${crypto.randomUUID()}.jpg`, "mecanico", { blob: new Blob([new Uint8Array(8)], { type: "image/png" }), tipo: "image/png" });
    assert.equal(png.ok, false, "solo lo que produce el cliente (JPEG)");
    const grande = await subir(`ordenes/${o}/${crypto.randomUUID()}.jpg`, "mecanico", { blob: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: "image/jpeg" }) });
    assert.equal(grande.ok, false, "más de 10 MiB"); assert.equal(grande.codigo, 413, grande.texto);
    assert.equal(objetos(`ordenes/${o}/`).length, 0);
  });
});

/* ---------------- flujos del cliente real ---------------- */
let n = 0;
async function dispositivo(nav, quien, opciones = {}) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `9-${quien}-${nav}-${++n}`, pagina: "pagina.html?mecanico=1" });
  await entrar(d, quien, opciones);
  return d;
}
function entrar(d, quien, opciones = {}) {
  return d.eval(async (a) => {
    window.__token = a.token; window.__sesion = { uid: a.id }; window.__habilitado = true;
    await __montar(a.op);
    window.__ligar = async (path, reg) => {   // mismo ligado que app.js (flushFotosPendientes.alSubirUna)
      const ya = (await __bd.outbox.todos()).some((o) => o.op_id === reg.operation_id);
      if (!ya) await __motor.encolarRpc("agregar_foto_orden", { p_orden_id: reg.uid, p_path: path, p_device: await __bd.deviceId() }, { entidad: "ordenes", uid: reg.uid, op_id: reg.operation_id });
    };
    window.__procesar = (extra) => SyncFotos.procesarCola(Object.assign({ bd: __bd, baseUrl: __pila.restUrl, anonKey: __pila.anonKey, bucket: "entimotors-taller",
      obtenerToken: () => window.__token, refrescar: async () => false, alSubirUna: window.__ligar }, extra || {}));
    window.__foto = async (ordenUid) => {   // una foto JPEG real hecha con canvas + la compresión real de la app
      const c = document.createElement("canvas"); c.width = 64; c.height = 48; const x = c.getContext("2d"); x.fillStyle = "#c33"; x.fillRect(0, 0, 64, 48);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.9));
      const { blob: comprimida } = await SyncFotos.comprimir(blob);
      return SyncFotos.encolar(__bd, { ordenUid, blob: comprimida, nombreArchivo: "foto.jpg" });
    };
    return true;
  }, { token: pila.jwt(PERFILES[quien]), id: PERFILES[quien], op: { nombreBd: opciones.nombreBd || `sync9_${++n}`, usarMappersReales: true, orden: ["ordenes"], ...opciones } });
}
async function recargar(d, quien, nombreBd) {
  const marca = "m" + Math.random();
  await d.eval((m) => { window.__marca = m; setTimeout(() => location.reload(), 50); return true; }, marca);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try { if ((await d.eval(() => (document.readyState === "complete" ? window.__marca || "nueva" : "cargando"), null, { plazoMs: 3000 })) === "nueva") break; } catch { /* orden perdida en la descarga */ }
  }
  await entrar(d, quien, { nombreBd });
}
const red = (d, c) => d.eval((x) => { Object.assign(window.__red, x); return true; }, c);
const blobs = (d) => d.eval(async () => (await __bd.blobs.todos()).map((b) => ({ estado: b.estado, intentos: b.intentos || 0, error_clase: b.error_clase || null })));
const fotosNube = (o) => nube(`select coalesce(fotos, '[]'::jsonb) as f from public.ordenes where id = '${o}'`)[0].f;
const sinEspera = (d) => d.eval(async () => { for (const b of await __bd.blobs.todos()) if (b.siguiente_en) await __bd.transaccion(["blobs"], "readwrite", (t) => t.put("blobs", { ...b, siguiente_en: 0 })); for (const o of await __bd.outbox.todos()) if (o.estado === "pending") await __bd.outbox.actualizar(o.seq, { siguiente_en: 0 }); return true; });

for (const nav of NAVS) {
  describe(`SYNC-9 · fotos con el cliente real (Storage real) · ${nav}`, () => {
    const abiertos = [];
    const abrir = async (...a) => { const d = await dispositivo(nav, ...a); abiertos.push(d); return d; };
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });

    test("SIN RED → recarga → con red: UNA foto en Storage, ligada UNA vez, y OTRO dispositivo del mecánico la baja, firma y descarga idéntica", async () => {
      const o = orden(), bdNombre = `sync9_off_${nav}`;
      const A = await abrir("mecanico", { nombreBd: bdNombre });
      await A.eval(() => __motor.pullTodo());
      await red(A, { caida: true });
      await A.eval((u) => window.__foto(u), o);
      const r0 = await A.eval(() => window.__procesar());
      assert.equal(r0.detenido, "red"); assert.deepEqual((await blobs(A)).map((b) => b.estado), ["pendiente"]);
      await recargar(A, "mecanico", bdNombre);   // la recarga trae red de nuevo (el interruptor es de la página)
      assert.equal((await blobs(A)).length, 1, "la foto sobrevivió a la recarga (Blob en IndexedDB)");
      await sinEspera(A);
      const r = await A.eval(() => window.__procesar());
      assert.equal(r.subidas, 1);
      assert.equal((await A.eval(() => __motor.flush())).enviadas, 1, "el ligado sale por el outbox");
      const guardadas = objetos(`ordenes/${o}/`);
      assert.equal(guardadas.length, 1); assert.deepEqual(fotosNube(o), guardadas, "metadata = objeto, sin huérfanos");
      assert.equal(nube(`select count(*)::int as n from public.sync_ops where kind = 'agregar_foto_orden'`)[0].n >= 1, true);
      const B = await abrir("mecanico");
      await B.eval(() => __motor.pullTodo());
      const vista = await B.eval(async (a) => {
        const ord = (await __bd.datos.todos("ordenes")).find((x) => x.uid === a.o);
        const f = await SyncFotos.firmar({ baseUrl: __pila.restUrl, anonKey: __pila.anonKey, bucket: "entimotors-taller", path: ord.fotos[0], obtenerToken: () => window.__token });
        const bytes = f.ok ? new Uint8Array(await (await fetch(f.url)).arrayBuffer()) : null;
        return { fotos: ord.fotos, ok: f.ok, f, tam: bytes && bytes.length, jpeg: bytes && bytes[0] === 0xff && bytes[1] === 0xd8 };
      }, { o });
      assert.deepEqual(vista.fotos, guardadas); assert.equal(vista.ok, true, JSON.stringify(vista)); assert.equal(vista.jpeg, true);
      assert.equal(vista.tam, Number(nube(`select (metadata->>'size')::int as tam from storage.objects where name = '${guardadas[0]}'`)[0].tam));
    });

    test("respuesta PERDIDA tras subir + cierre DURANTE el ligado: al reintentar, UN objeto, UNA ruta, sin «foto-copy»", async () => {
      const o = orden(), bdNombre = `sync9_retry_${nav}`;
      const A = await abrir("mecanico", { nombreBd: bdNombre });
      await A.eval(() => __motor.pullTodo());
      await A.eval((u) => window.__foto(u), o);
      await red(A, { perderRespuesta: 1 });                    // el PUT llega a Storage; la respuesta no
      const r1 = await A.eval(() => window.__procesar());
      let puts = (await A.eval(() => window.__red.registro)).filter((x) => x.m === "PUT").length;
      assert.equal(r1.detenido, "red"); assert.equal(objetos(`ordenes/${o}/`).length, 1, "Storage sí lo guardó");
      // cierre: el reintento se corta DESPUÉS de reconocer la subida y ANTES de borrar el blob (ligar lanza)
      await sinEspera(A);
      await A.eval(() => window.__procesar({ alSubirUna: async (p, reg) => { await window.__ligar(p, reg); throw new Error("cierre"); } })).catch(() => {});
      puts += (await A.eval(() => window.__red.registro)).filter((x) => x.m === "PUT").length;   // el registro es de la página: se suma antes de recargar
      await recargar(A, "mecanico", bdNombre);
      await sinEspera(A);
      const r2 = await A.eval(() => window.__procesar());
      assert.equal(r2.subidas, 1); assert.equal((await blobs(A)).length, 0);
      const cola = await A.eval(() => __bd.outbox.todos());
      assert.equal(cola.filter((x) => x.rpc === "agregar_foto_orden").length, 1, "un solo ligado en cola aunque se repitió");
      await A.eval(() => __motor.flush());
      assert.equal(objetos(`ordenes/${o}/`).length, 1); assert.deepEqual(fotosNube(o), objetos(`ordenes/${o}/`));
      puts += (await A.eval(() => window.__red.registro)).filter((x) => x.m === "PUT").length;
      assert.ok(puts >= 2, "hubo reintento real del PUT");
    });

    test("sesión caducada: la foto NO sube (ni como anónima), no gasta intentos ni se rechaza; con sesión nueva, sube y se liga", async () => {
      const o = orden();
      const A = await abrir("mecanico");
      await A.eval(() => __motor.pullTodo());
      await A.eval((u) => window.__foto(u), o);
      await A.eval((t) => { window.__token = t; return true; }, tok("mecanico", { segundos: -600 }));
      const r = await A.eval(() => window.__procesar());
      assert.equal(r.detenido, "auth"); assert.deepEqual(await blobs(A), [{ estado: "pendiente", intentos: 0, error_clase: null }]);
      await A.eval(() => { window.__token = null; return true; });
      const n0 = (await A.eval(() => window.__red.registro)).length;
      assert.equal((await A.eval(() => window.__procesar())).detenido, "auth");
      assert.equal((await A.eval(() => window.__red.registro)).length, n0, "sin token no sale ninguna petición");
      assert.equal(objetos(`ordenes/${o}/`).length, 0);
      await A.eval((t) => { window.__token = t; return true; }, tok("mecanico"));
      assert.equal((await A.eval(() => window.__procesar())).subidas, 1);
      await A.eval(() => __motor.flush());
      assert.equal(fotosNube(o).length, 1);
    });

    test("orden REASIGNADA mientras el mecánico estaba sin red: Storage rechaza, la foto queda «rechazada» (visible), nada en la nube, sin bucle", async () => {
      const o = orden();
      const A = await abrir("mecanico");
      await A.eval(() => __motor.pullTodo());
      await A.eval((u) => window.__foto(u), o);
      uno(`update public.ordenes set mecanico_id = '${PERFILES.mecanico2}' where id = '${o}'`);
      const r = await A.eval(() => window.__procesar());
      assert.equal(r.rechazadas, 1);
      assert.deepEqual((await blobs(A)).map((b) => [b.estado, b.error_clase]), [["rechazada", "permiso"]]);
      const antes = (await A.eval(() => window.__red.registro)).length;
      await A.eval(() => window.__procesar());
      assert.equal((await A.eval(() => window.__red.registro)).length, antes, "no se reintenta");
      assert.equal(objetos(`ordenes/${o}/`).length, 0); assert.deepEqual(fotosNube(o), []);
    });

    test("DOS dispositivos del mismo mecánico, uno con estado viejo: las DOS fotos quedan ligadas (antes una pisaba a la otra o se rechazaba)", async () => {
      const o = orden();
      const A = await abrir("mecanico"), B = await abrir("mecanico");
      await A.eval(() => __motor.pullTodo()); await B.eval(() => __motor.pullTodo());
      // A avanza la orden (B no se entera) y sube su foto
      await A.eval((u) => __motor.encolarRpc("avanzar_orden_tecnico", { p_orden_id: u, p_campos: { estado: "diagnostico" } }, { entidad: "ordenes", uid: u }), o);
      await A.eval((u) => window.__foto(u), o); await A.eval(() => window.__procesar()); await A.eval(() => __motor.flush());
      // B, con su copia vieja (estado «recibido»), sube la suya
      await B.eval((u) => window.__foto(u), o); await B.eval(() => window.__procesar()); const rb = await B.eval(() => __motor.flush());
      assert.equal(rb.rechazadas || 0, 0, "el ligado de B no depende de su estado viejo");
      const f = fotosNube(o);
      assert.equal(f.length, 2); assert.deepEqual([...f].sort(), objetos(`ordenes/${o}/`));
      assert.equal(nube(`select estado from public.ordenes where id = '${o}'`)[0].estado, "diagnostico", "el estado de A no retrocedió");
      await B.eval(() => __motor.pullTodo());
      assert.equal((await B.eval((u) => __bd.datos.todos("ordenes").then((l) => l.find((x) => x.uid === u)), o)).fotos.length, 2, "B ve las dos");
    });

    test("DOS pestañas del mismo dispositivo procesan a la vez (Web Locks y sin ellos): una sola foto, un solo ligado", async () => {
      for (const sinLocks of [false, true]) {
        const o = orden(), bdNombre = `sync9_tabs_${nav}_${sinLocks}`;
        const A = await abrir("mecanico", { nombreBd: bdNombre, sinLocks });
        await A.eval(() => __motor.pullTodo());
        await A.eval((u) => window.__foto(u), o);
        const r = await A.eval(async (a) => {
          const f = document.createElement("iframe"); f.src = "/__h/pestana.html"; document.body.appendChild(f);
          await new Promise((ok) => f.addEventListener("load", ok));
          for (let i = 0; i < 50 && !f.contentWindow.__montar; i++) await new Promise((ok) => setTimeout(ok, 100));
          const w = f.contentWindow; w.__token = window.__token; w.__sesion = window.__sesion; w.__habilitado = true;
          await w.__montar({ nombreBd: a.bd, usarMappersReales: true, sinLocks: a.sinLocks, orden: ["ordenes"] });
          const opts = (win) => ({ bd: win.__bd, baseUrl: __pila.restUrl, anonKey: __pila.anonKey, bucket: "entimotors-taller", obtenerToken: () => window.__token, locks: a.sinLocks ? null : undefined,
            alSubirUna: async (p, reg) => { const ya = (await win.__bd.outbox.todos()).some((x) => x.op_id === reg.operation_id); if (!ya) await win.__motor.encolarRpc("agregar_foto_orden", { p_orden_id: reg.uid, p_path: p, p_device: null }, { entidad: "ordenes", uid: reg.uid, op_id: reg.operation_id }); } });
          const [x, y] = await Promise.all([SyncFotos.procesarCola(opts(window)), w.SyncFotos.procesarCola(opts(w))]);
          await Promise.all([__motor.flush(), w.__motor.flush()]);
          const puts = window.__red.registro.concat(w.__red.registro).filter((q) => q.m === "PUT").length;
          return { x, y, puts, ligados: (await __bd.outbox.todos()).length };
        }, { bd: bdNombre, sinLocks });
        assert.equal(objetos(`ordenes/${o}/`).length, 1, JSON.stringify(r));
        assert.equal(fotosNube(o).length, 1, "un solo ligado");
        if (!sinLocks) assert.equal(r.puts, 1, "con Web Locks, un solo PUT");
      }
    });

    test("device_id de las fotos = el del dispositivo (entimotors_dispositivo), igual en todas las pestañas", async () => {
      const o = orden();
      const A = await abrir("mecanico");
      await A.eval(() => __motor.pullTodo());
      await A.eval((u) => window.__foto(u), o); await A.eval(() => window.__procesar()); await A.eval(() => __motor.flush());
      const dev = await A.eval(() => __bd.deviceId());
      assert.equal(nube(`select distinct device_id from public.sync_ops where kind = 'agregar_foto_orden' and user_id = '${PERFILES.mecanico}' and device_id = '${dev}'`).length, 1);
      const otro = await A.eval(async () => { const b = await SyncDB.abrir({ nombre: "entimotors_sync" }); const i = await b.deviceId(); b.cerrar(); return i; });
      assert.equal(otro, dev);
      assert.equal(invariantes(), "[]", "las fotos jamás tocan dinero ni stock");
    });
  });
}
