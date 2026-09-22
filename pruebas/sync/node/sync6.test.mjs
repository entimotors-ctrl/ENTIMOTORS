// SYNC-6 · piezas PURAS/MOCKEABLES sin navegador ni Docker: taller-demo/sync-fotos.js (compresión aparte, es
// 100% DOM) y el mapper "ordenes" de taller-demo/sync-mappers.js para los dos productos (Taller/Mi Trabajo).
// Lo que necesita Postgres+PostgREST reales (ordenes_tecnico_mias, avanzar_orden_tecnico, RLS, Storage) vive en
// pruebas/sync/browser/sync6-core.test.mjs — este archivo NO lo sustituye, solo cubre lo que no requiere Docker.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leer = (f) => fs.readFileSync(path.join(RAIZ, "taller-demo", f), "utf8");
const J = (x) => JSON.parse(JSON.stringify(x));      // deepEqual sin depender de los prototipos del contexto vm (ver sync-cliente.test.mjs)
function cargar(archivos, extra = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Math, Date, ...extra });
  for (const f of archivos) vm.runInContext(leer(f), ctx, { filename: f });
  return ctx;
}

/* ═════════════════════════ sync-fotos.js ═════════════════════════ */
describe("SYNC-6 · sync-fotos.js (ruta, subir, firmar, cola offline — sin DOM)", () => {
  const ctx0 = cargar(["sync-fotos.js"]);
  const { ruta } = ctx0.SyncFotos;

  test("ruta(): ordenes/<orden_uuid>/<foto_uuid>.jpg — SINGLE_WORKSHOP, sin taller_id", () => {
    assert.equal(ruta("orden-1", "foto-1"), "ordenes/orden-1/foto-1.jpg");
    // Sin SyncDB.uuid cargado (este archivo se prueba aislado), ruta() usa su respaldo interno — en el
    // navegador real sync-db.js siempre está cargado antes y da un UUID de verdad (ver sync-fotos.js, uuid()).
    assert.match(ruta("orden-1"), /^ordenes\/orden-1\/.+\.jpg$/, "sin foto_uid, genera uno propio");
  });

  /** Servidor falso mínimo, mismo espíritu que sync-cliente.test.mjs: responde según una función y registra peticiones. */
  function servidor(responder) {
    const reg = [];
    const fetch = async (url, init) => {
      const u = new URL(url);
      const i = { m: init.method, ruta: u.pathname, h: init.headers, cuerpo: init.body };
      reg.push(i);
      const r = await responder(i, reg.length);
      return { status: r.status ?? 200, text: async () => (r.cuerpo === undefined ? "" : typeof r.cuerpo === "string" ? r.cuerpo : JSON.stringify(r.cuerpo)) };
    };
    return { fetch, reg };
  }

  test("subir(): 2xx → ok; 403 → clase permiso (no se reintenta); red → clase red", async () => {
    const ctx = cargar(["sync-fotos.js"]);
    const ok = await ctx.SyncFotos.subir({ baseUrl: "https://x.test", anonKey: "A", bucket: "entimotors-taller", path: "ordenes/o1/f1.jpg", blob: { type: "image/jpeg" }, obtenerToken: () => "T", fetch: servidor(() => ({ status: 200 })).fetch });
    assert.equal(ok.ok, true);

    const prohibido = await ctx.SyncFotos.subir({ baseUrl: "https://x.test", anonKey: "A", bucket: "entimotors-taller", path: "ordenes/ajena/f1.jpg", blob: { type: "image/jpeg" }, obtenerToken: () => "T", fetch: servidor(() => ({ status: 403 })).fetch });
    assert.equal(prohibido.ok, false); assert.equal(prohibido.clase, "permiso");

    const sinRed = await ctx.SyncFotos.subir({ baseUrl: "https://x.test", anonKey: "A", bucket: "b", path: "p", blob: { type: "image/jpeg" }, obtenerToken: () => "T", fetch: async () => { throw new Error("sin red"); } });
    assert.equal(sinRed.ok, false); assert.equal(sinRed.clase, "red");
  });

  test("subir(): 401 sin refrescar() → auth; 401 CON refrescar() que renueva el token → reintenta y sube", async () => {
    const ctx = cargar(["sync-fotos.js"]);
    const solo401 = await ctx.SyncFotos.subir({ baseUrl: "https://x.test", anonKey: "A", bucket: "b", path: "p", blob: { type: "image/jpeg" }, obtenerToken: () => "VIEJO", fetch: servidor(() => ({ status: 401 })).fetch });
    assert.equal(solo401.ok, false); assert.equal(solo401.clase, "auth");

    let token = "VIEJO";
    const srv = servidor((i) => (i.h.Authorization === "Bearer NUEVO" ? { status: 200 } : { status: 401 }));
    const r = await ctx.SyncFotos.subir({
      baseUrl: "https://x.test", anonKey: "A", bucket: "b", path: "p", blob: { type: "image/jpeg" },
      obtenerToken: () => token, refrescar: async () => { token = "NUEVO"; return true; }, fetch: srv.fetch,
    });
    assert.equal(r.ok, true); assert.equal(srv.reg.length, 2, "un intento con el token viejo, uno con el nuevo");
  });

  test("firmar(): URL firmada relativa se arma completa con baseUrl; 403 → clase permiso", async () => {
    const ctx = cargar(["sync-fotos.js"]);
    const srv = servidor(() => ({ status: 200, cuerpo: { signedURL: "/object/sign/entimotors-taller/ordenes/o1/f1.jpg?token=abc" } }));
    const r = await ctx.SyncFotos.firmar({ baseUrl: "https://x.test", anonKey: "A", bucket: "entimotors-taller", path: "ordenes/o1/f1.jpg", obtenerToken: () => "T", fetch: srv.fetch });
    assert.equal(r.ok, true);
    assert.equal(r.url, "https://x.test/storage/v1/object/sign/entimotors-taller/ordenes/o1/f1.jpg?token=abc");

    const denegado = await ctx.SyncFotos.firmar({ baseUrl: "https://x.test", anonKey: "A", bucket: "b", path: "ordenes/ajena/f1.jpg", obtenerToken: () => "T", fetch: servidor(() => ({ status: 403 })).fetch });
    assert.equal(denegado.ok, false); assert.equal(denegado.clase, "permiso");
  });

  /** Base falsa mínima, mismo contrato que sync-db.js: blobs.{agregar,todos,borrar} + transaccion(tablas,modo,fn). */
  function bdFalsa(iniciales = []) {
    let filas = iniciales.slice();
    let siguiente = filas.reduce((m, f) => Math.max(m, f.id || 0), 0) + 1;
    return {
      blobs: {
        agregar: async (r) => { const id = siguiente++; filas.push({ ...r, id }); return id; },
        todos: async () => filas.slice(),
        borrar: async (id) => { filas = filas.filter((f) => f.id !== id); },
      },
      transaccion: async (tablas, modo, fn) => fn({ put: async (s, v) => { filas = filas.map((f) => (f.id === v.id ? v : f)); return v.id; } }),
      _filas: () => filas,
    };
  }

  test("encolar()/pendientes(): un blob nuevo queda 'pendiente', nunca en base64 (se guarda el Blob tal cual)", async () => {
    const ctx = cargar(["sync-fotos.js"]);
    const bd = bdFalsa();
    const blobFalso = { type: "image/jpeg", tamaño: "no-es-texto" };
    await ctx.SyncFotos.encolar(bd, { ordenUid: "orden-1", blob: blobFalso });
    const p = await ctx.SyncFotos.pendientes(bd, "orden-1");
    assert.equal(p.length, 1);
    assert.equal(p[0].estado, "pendiente"); assert.equal(p[0].entidad, "ordenes"); assert.equal(p[0].uid, "orden-1");
    assert.equal(p[0].archivo, blobFalso, "el blob viaja tal cual, no se convierte a texto/base64");
    assert.ok(p[0].operation_id, "trae operation_id para el registro/idempotencia");
  });

  test("procesarCola(): sube lo pendiente (y lo quita de la cola); 403 → 'rechazada' (queda, no se reintenta); 500 → sigue pendiente", async () => {
    const ctx = cargar(["sync-fotos.js"]);
    const bd = bdFalsa();
    await ctx.SyncFotos.encolar(bd, { ordenUid: "orden-ok", blob: { type: "image/jpeg" } });
    await ctx.SyncFotos.encolar(bd, { ordenUid: "orden-ajena", blob: { type: "image/jpeg" } });
    await ctx.SyncFotos.encolar(bd, { ordenUid: "orden-caida", blob: { type: "image/jpeg" } });
    const subidas = [];
    const fetchFalso = async (url) => {
      if (url.includes("orden-ajena")) return { status: 403, text: async () => "" };
      if (url.includes("orden-caida")) return { status: 500, text: async () => "" };
      return { status: 200, text: async () => "" };
    };
    const r = await ctx.SyncFotos.procesarCola({
      bd, baseUrl: "https://x.test", anonKey: "A", bucket: "entimotors-taller", obtenerToken: () => "T", fetch: fetchFalso,
      alSubirUna: async (p, reg) => subidas.push({ p, uid: reg.uid }),
    });
    assert.deepEqual({ subidas: r.subidas, rechazadas: r.rechazadas, pendientes: r.pendientes }, { subidas: 1, rechazadas: 1, pendientes: 1 });
    assert.equal(subidas.length, 1); assert.equal(subidas[0].uid, "orden-ok");
    assert.equal(bd._filas().length, 2, "la subida OK se quitó de la cola; la rechazada y la caída se quedaron");
    assert.equal(bd._filas().find((f) => f.uid === "orden-ajena").estado, "rechazada");
    assert.equal(bd._filas().find((f) => f.uid === "orden-caida").estado, "pendiente", "error de servidor: se reintenta después, no se marca rechazada");
  });
});

/* ═════════════════════════ sync-mappers.js — mapper "ordenes" por producto ═════════════════════════ */
describe('SYNC-6 · sync-mappers.js — "ordenes" es un mapper distinto según ENTIMOTORS_BUILD.producto', () => {
  function mapperOrdenes(producto) {
    const ctx = cargar(["sync-mappers.js"], { ENTIMOTORS_BUILD: producto ? { producto } : undefined });
    return ctx.ENTIMOTORS_SYNC_MAPPERS.ordenes;
  }

  test('Taller (sin ENTIMOTORS_BUILD o "admin"): tabla real, columnas sin fotos/items/dinero', () => {
    for (const p of [undefined, "admin", "cajero"]) {
      const m = mapperOrdenes(p);
      assert.equal(m.tabla, "ordenes", `producto=${p}`);
      for (const financiero of ["finalizada", "margen", "credito_id", "entregado_en", "tipo_cobro", "metodo_pago", "abono_inicial", "abono_metodo", "fotos"]) {
        assert.ok(!m.columnas.includes(financiero), `columnas no debe incluir "${financiero}" (dinero/fotos son de SYNC-7, o fotos: fuera de alcance de SYNC-6 para el Taller)`);
      }
      assert.deepEqual(m.aCloud({ estado: "recibido", mecanicoId: "u-1" }).estado, "recibido");
      assert.equal(m.aCloud({}).fotos, undefined, "aCloud() del Taller nunca manda fotos: no pisa lo que subió el mecánico");
    }
  });

  test('Mi Trabajo ("mecanico"): tabla = rpc/ordenes_tecnico_mias, nunca empuja cambios por aquí', () => {
    const m = mapperOrdenes("mecanico");
    assert.equal(m.tabla, "rpc/ordenes_tecnico_mias");
    assert.deepEqual(J(m.columnas), [], "el mecánico nunca sube por columnasNube(): solo por avanzar_orden_tecnico");
    assert.deepEqual(J(m.aCloud({ estado: "diagnostico" })), {}, "aCloud() del mecánico siempre vacío (defensivo)");
  });

  test("aLocal() del mecánico aplana cliente/moto (sin acceso directo a esas tablas) y nunca trae precio/costo en items", () => {
    const m = mapperOrdenes("mecanico");
    const fila = {
      id: "o-1", estado: "reparacion", falla: "Frena mal", diagnostico: { notas: "Pastillas gastadas" },
      reparacion_notas: "Cambiando pastillas", calidad_checklist: null, fotos: ["ordenes/o-1/f1.jpg"],
      km_salida: 15234, garantia_dias: 30, mecanico: "Mec Uno", mecanico_id: "u-3",
      origen_trabajo: "taller", finalizada: false, finalizado_en: null, entregado_en: null,
      cliente_nombre: "Ana Pérez", cliente_telefono: "9999-0000",
      moto_marca: "Honda", moto_modelo: "CB125", moto_placa: "PBB1234",
      items: [{ id: "i-1", nombre: "Pastillas de freno", cantidad: 2, precio: 450, costo_unitario: 200 }],
      updated_at: "2026-09-21T10:00:00Z", rev: 3, deleted_at: null,
    };
    const l = m.aLocal(fila);
    assert.equal(l.clienteNombre, "Ana Pérez"); assert.equal(l.motoMarca, "Honda"); assert.equal(l.motoPlaca, "PBB1234");
    assert.equal(l.kmSalida, 15234); assert.deepEqual(l.fotos, ["ordenes/o-1/f1.jpg"]);
    assert.equal(l.items.length, 1);
    assert.deepEqual(Object.keys(l.items[0]).sort(), ["cantidad", "nombre"], "nunca precio ni costo_unitario en los ítems del mecánico");
    assert.equal(l.items[0].nombre, "Pastillas de freno"); assert.equal(l.items[0].cantidad, 2);
  });

  test('"ordenes" está en el orden de sincronización (después de clientes/motos, de las que depende por fk en el mapper del Taller)', () => {
    const ctx = cargar(["sync-mappers.js"]);
    assert.ok(ctx.ENTIMOTORS_SYNC_ORDEN.includes("ordenes"));
    assert.ok(ctx.ENTIMOTORS_SYNC_ORDEN.indexOf("clientes") < ctx.ENTIMOTORS_SYNC_ORDEN.indexOf("ordenes"));
    assert.ok(ctx.ENTIMOTORS_SYNC_ORDEN.indexOf("motos") < ctx.ENTIMOTORS_SYNC_ORDEN.indexOf("ordenes"));
  });
});
