// SYNC-9 · FOTOS (sync-fotos.js) sin navegador: clasificación con las respuestas REALES de storage-api (HTTP 400 con el
// código en el cuerpo), nunca subir sin sesión, reintento idempotente (una subida que ya llegó se reconoce y se liga),
// ligar ANTES de borrar el blob, espera creciente, una sola pestaña, rutas propias (jamás el nombre del archivo), y las
// guardas estáticas del contrato nuevo (el avance técnico ya no manda `fotos`; el ligado es solo-agregar).
// La prueba contra storage-api + PostgREST + Postgres reales está en pruebas/sync/browser/sync9-core.test.mjs.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leer = (f) => fs.readFileSync(path.join(RAIZ, f), "utf8");
const J = (x) => JSON.parse(JSON.stringify(x));
function cargar(extra = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Math, Date, crypto: globalThis.crypto, ...extra });
  for (const f of ["taller-demo/sync-db.js", "taller-demo/sync-fotos.js"]) vm.runInContext(leer(f), ctx, { filename: f });
  return ctx;
}
const F = cargar().SyncFotos;

/* Respuestas REALES observadas en storage-api v1.60.15 (pila local de SYNC-9). */
const REAL = {
  rls: { status: 400, cuerpo: { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" } },
  exp: { status: 400, cuerpo: { statusCode: "403", error: "Unauthorized", message: "\"exp\" claim timestamp check failed" } },
  jws: { status: 400, cuerpo: { statusCode: "403", error: "Unauthorized", message: "Invalid Compact JWS" } },
  noEncontrado: { status: 400, cuerpo: { statusCode: "404", error: "not_found", message: "Object not found" } },
  duplicado: { status: 409, cuerpo: { statusCode: "409", error: "Duplicate", message: "The resource already exists" } },
  mime: { status: 400, cuerpo: { statusCode: "415", error: "invalid_mime_type", message: "mime type text/plain is not supported" } },
  grande: { status: 400, cuerpo: { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" } },
  caido: { status: 503, cuerpo: null }, limite: { status: 429, cuerpo: null },
};
function servidor(responder) {
  const reg = [];
  const fetch = async (url, init) => {
    const u = new URL(url); const i = { m: init.method, ruta: decodeURIComponent(u.pathname), h: init.headers };
    reg.push(i);
    const r = await responder(i, reg.length);
    if (r === "red") throw new TypeError("Failed to fetch");
    return { status: r.status ?? 200, text: async () => (r.cuerpo == null ? "" : JSON.stringify(r.cuerpo)) };
  };
  return { fetch, reg };
}
function bdFalsa() {
  let filas = [], sig = 1;
  return {
    blobs: { agregar: async (r) => { const id = sig++; filas.push({ ...r, id }); return id; }, todos: async () => filas.map((f) => ({ ...f })), borrar: async (id) => { filas = filas.filter((f) => f.id !== id); } },
    transaccion: async (t, m, fn) => fn({ put: async (s, v) => { filas = filas.map((f) => (f.id === v.id ? { ...v } : f)); return v.id; } }),
    _filas: () => filas,
  };
}
const base = { baseUrl: "https://x.test", anonKey: "A", bucket: "entimotors-taller" };
const UID = "11111111-1111-4111-8111-111111111111";

describe("SYNC-9 · clasificación con respuestas reales de Storage", () => {
  test("RLS → permiso; JWT vencido o inválido (también HTTP 400) → auth, JAMÁS rechazo; 404, 409, 415, 413, 5xx, 429", () => {
    const k = (r) => F.clasificarStorage(r).clase;
    assert.equal(k(REAL.rls), "permiso");
    assert.equal(k(REAL.exp), "auth", "sesión caducada: antes se leía como 400 → «validacion» y la foto se rechazaba para siempre");
    assert.equal(k(REAL.jws), "auth");
    assert.equal(k(REAL.noEncontrado), "validacion");
    assert.equal(k(REAL.duplicado), "conflicto");
    assert.equal(k(REAL.mime), "validacion"); assert.equal(k(REAL.grande), "validacion");
    assert.equal(k(REAL.caido), "servidor"); assert.equal(k(REAL.limite), "limite");
    assert.equal(k({ status: 401, cuerpo: null }), "auth"); assert.equal(k({ status: 200 }), undefined);
  });
});

describe("SYNC-9 · subir() y existe()", () => {
  test("sin token NO sale ninguna petición (nunca «Bearer null»); con refresco que da token, sube con él", async () => {
    const srv = servidor(() => ({ status: 200 }));
    const r = await F.subir({ ...base, path: "p", blob: { type: "image/jpeg" }, obtenerToken: () => null, fetch: srv.fetch });
    assert.equal(r.clase, "auth"); assert.equal(srv.reg.length, 0);
    let tok = null;
    const r2 = await F.subir({ ...base, path: "p", blob: { type: "image/jpeg" }, obtenerToken: () => tok, refrescar: async () => { tok = "NUEVO"; return true; }, fetch: srv.fetch });
    assert.equal(r2.ok, true); assert.equal(srv.reg[0].h.Authorization, "Bearer NUEVO");
  });
  test("token vencido (400 «exp claim») → refresca UNA vez y reintenta; sin refresco posible queda en auth", async () => {
    let tok = "VIEJO";
    const srv = servidor((i) => (i.h.Authorization === "Bearer NUEVO" ? { status: 200 } : REAL.exp));
    const r = await F.subir({ ...base, path: "p", blob: {}, obtenerToken: () => tok, refrescar: async () => { tok = "NUEVO"; return true; }, fetch: srv.fetch });
    assert.equal(r.ok, true); assert.equal(srv.reg.length, 2);
    const r2 = await F.subir({ ...base, path: "p", blob: {}, obtenerToken: () => "VIEJO", refrescar: async () => false, fetch: servidor(() => REAL.exp).fetch });
    assert.equal(r2.clase, "auth");
  });
  test("existe(): 200 → sí; 404 (incluido un objeto AJENO bajo RLS) → no; red → error", async () => {
    assert.deepEqual(J(await F.existe({ ...base, path: "p", obtenerToken: () => "T", fetch: servidor(() => ({ status: 200, cuerpo: { id: "x" } })).fetch })), { ok: true, existe: true });
    assert.deepEqual(J(await F.existe({ ...base, path: "p", obtenerToken: () => "T", fetch: servidor(() => REAL.noEncontrado).fetch })), { ok: true, existe: false });
    assert.equal((await F.existe({ ...base, path: "p", obtenerToken: () => "T", fetch: servidor(() => "red").fetch })).ok, false);
    const srv = servidor(() => ({ status: 200 }));
    await F.existe({ ...base, path: `ordenes/${UID}/f.jpg`, obtenerToken: () => "T", fetch: srv.fetch });
    assert.equal(srv.reg[0].ruta, `/storage/v1/object/info/authenticated/entimotors-taller/ordenes/${UID}/f.jpg`);
  });
});

describe("SYNC-9 · procesarCola(): idempotencia, orden ligar→borrar, pausa, espera, pestañas", () => {
  async function conBlob(bd, n = 1) { for (let i = 0; i < n; i++) await F.encolar(bd, { ordenUid: UID, blob: { type: "image/jpeg" } }); }

  test("subida que YA había llegado (respuesta perdida): el reintento choca (RLS/409), se comprueba que existe y se LIGA una sola vez", async () => {
    for (const choque of [REAL.rls, REAL.duplicado]) {
      const bd = bdFalsa(); await conBlob(bd);
      const ligadas = [];
      const srv = servidor((i) => (i.m === "PUT" ? choque : { status: 200, cuerpo: { id: "obj" } }));
      const r = await F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: srv.fetch, locks: null, alSubirUna: async (p) => { ligadas.push(p); } });
      assert.equal(r.subidas, 1); assert.equal(r.rechazadas, 0);
      assert.equal(ligadas.length, 1); assert.equal(bd._filas().length, 0);
      assert.deepEqual(srv.reg.map((x) => x.m), ["PUT", "GET"], "un solo PUT; nunca «foto-copy»");
    }
  });

  test("RLS de verdad (orden ajena/reasignada, el objeto NO existe): rechazo terminal visible, sin reintento", async () => {
    const bd = bdFalsa(); await conBlob(bd);
    const srv = servidor((i) => (i.m === "PUT" ? REAL.rls : REAL.noEncontrado));
    const r = await F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: srv.fetch, locks: null, alSubirUna: async () => { throw new Error("no debe ligar"); } });
    assert.equal(r.rechazadas, 1);
    const [b] = bd._filas(); assert.equal(b.estado, "rechazada"); assert.equal(b.error_clase, "permiso");
    assert.equal((await F.rechazadas(bd)).length, 1);
    const antes = srv.reg.length;
    await F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: srv.fetch, locks: null });
    assert.equal(srv.reg.length, antes, "una rechazada no se vuelve a intentar");
  });

  test("se LIGA antes de borrar: si ligar falla (cierre/error), el blob se queda y el próximo intento lo repite sin duplicar", async () => {
    const bd = bdFalsa(); await conBlob(bd);
    let falla = true; const ligadas = [];
    const srv = servidor((i) => (i.m === "PUT" && srv.reg.filter((x) => x.m === "PUT").length === 1 ? { status: 200 } : i.m === "PUT" ? REAL.rls : { status: 200, cuerpo: { id: "o" } }));
    await F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: srv.fetch, locks: null, alSubirUna: async (p) => { if (falla) throw new Error("cierre"); ligadas.push(p); } }).catch(() => {});
    assert.equal(bd._filas().length, 1, "el blob sigue: la foto no se pierde");
    falla = false;
    const r = await F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: srv.fetch, locks: null, alSubirUna: async (p) => { ligadas.push(p); } });
    assert.equal(r.subidas, 1); assert.equal(ligadas.length, 1); assert.equal(bd._filas().length, 0);
    assert.equal(srv.reg.filter((x) => x.m === "PUT").length, 2, "el segundo PUT choca con el objeto ya subido → existe → se liga (idempotente)");
  });

  test("sesión caducada: nada se sube, no se gastan intentos, nada se rechaza; con sesión, sube", async () => {
    const bd = bdFalsa(); await conBlob(bd, 3);
    const srv = servidor(() => ({ status: 200 }));
    const r = await F.procesarCola({ bd, ...base, obtenerToken: () => null, fetch: srv.fetch, locks: null, alSubirUna: async () => {} });
    assert.equal(r.detenido, "auth"); assert.equal(srv.reg.length, 0);
    assert.ok(bd._filas().every((b) => b.estado === "pendiente" && (b.intentos || 0) === 0));
    const r2 = await F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: srv.fetch, locks: null, alSubirUna: async () => {} });
    assert.equal(r2.subidas, 3);
  });

  test("temporales (red, 503, 429): espera creciente por foto; antes de tiempo ni se intenta; sin red no sigue con las demás", async () => {
    const bd = bdFalsa(); await conBlob(bd, 2);
    let ahora = 1_000_000;
    const srv = servidor(() => "red");
    const r = await F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: srv.fetch, locks: null, ahora: () => ahora });
    assert.equal(r.detenido, "red"); assert.equal(srv.reg.length, 1, "sin red: no insiste con la segunda");
    const [b1] = bd._filas(); assert.equal(b1.intentos, 1); assert.ok(b1.siguiente_en > ahora);
    const srv2 = servidor(() => REAL.caido);
    await F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: srv2.fetch, locks: null, ahora: () => ahora });
    assert.equal(srv2.reg.length, 1, "la primera espera su turno; solo la segunda se intenta");
    ahora = b1.siguiente_en + 1;
    const srv3 = servidor(() => ({ status: 200 }));
    const r3 = await F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: srv3.fetch, locks: null, ahora: () => ahora, alSubirUna: async () => {} });
    assert.equal(r3.subidas, 2, "cumplida la espera de ambas (la 2ª esperó lo mismo tras su 503), las dos suben");
  });

  test("validación del servidor (MIME/tamaño) → rechazo terminal visible, no bucle", async () => {
    for (const resp of [REAL.mime, REAL.grande]) {
      const bd = bdFalsa(); await conBlob(bd);
      const r = await F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: servidor(() => resp).fetch, locks: null });
      assert.equal(r.rechazadas, 1); assert.equal(bd._filas()[0].estado, "rechazada");
    }
  });

  test("dos pestañas con Web Locks: la segunda cede y no sube nada", async () => {
    const bd = bdFalsa(); await conBlob(bd, 2);
    let tomado = false;
    const locks = { request: async (n, o, f) => { if (tomado) return f(null); tomado = true; try { return await f({}); } finally { tomado = false; } } };
    const srv = servidor(async () => { await new Promise((r) => setTimeout(r, 5)); return { status: 200 }; });
    const [a, b] = await Promise.all([F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: srv.fetch, locks, alSubirUna: async () => {} }), F.procesarCola({ bd, ...base, obtenerToken: () => "T", fetch: srv.fetch, locks, alSubirUna: async () => {} })]);
    assert.deepEqual([a.subidas, b.omitido || b.subidas].sort(), [2, "otra-pestana"].sort());
    assert.equal(srv.reg.filter((x) => x.m === "PUT").length, 2);
  });
});

describe("SYNC-9 · rutas y contrato", () => {
  test("ruta propia ordenes/<orden>/<uuid>.jpg: nunca el nombre original; «foto.jpg» tres veces = tres rutas distintas; válida para agregar_foto_orden", async () => {
    const ctx = cargar();
    const bd = bdFalsa();
    for (const nombre of ["foto.jpg", "foto.jpg", "foto.jpg", "Fotó (ñ) 🚲 muy larga" + "x".repeat(300) + ".jpg"]) await ctx.SyncFotos.encolar(bd, { ordenUid: UID, blob: {}, nombreArchivo: nombre });
    const rutas = bd._filas().map((b) => ctx.SyncFotos.ruta(b.uid, b.operation_id));
    assert.equal(new Set(rutas).size, 4);
    const re = new RegExp(`^ordenes/${UID}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`);
    for (const r of rutas) assert.match(r, re, "misma forma que exige agregar_foto_orden");
    assert.ok(rutas.every((r) => !/foto|ñ|🚲/.test(r)));
  });

  test("contrato: el avance técnico YA NO manda `fotos` (pisaba las de otro dispositivo); el ligado es agregar_foto_orden, solo-agregar, con op_id de la foto", () => {
    const app = leer("taller-demo/app.js");
    const avance = /async function encolarAvanceTecnico[\s\S]*?\n}\n/.exec(app)[0];
    assert.ok(!/\bfotos\s*:/.test(avance), "encolarAvanceTecnico no incluye fotos");
    assert.match(app, /encolarRpc\("agregar_foto_orden", \{ p_orden_id: registro\.uid, p_path: path/);
    assert.match(app, /op_id: registro\.operation_id/);
    const sql = leer("taller-demo/supabase/sync/sync-9-fotos.sql");
    assert.match(sql, /COALESCE\(fotos, '\[\]'::jsonb\) \|\| jsonb_build_array\(p_path\)/, "solo agrega");
    assert.match(sql, /FROM storage\.objects so WHERE so\.bucket_id = 'entimotors-taller' AND so\.name = p_path/, "nunca metadata sin objeto");
    assert.match(sql, /allowed_mime_types = ARRAY\['image\/jpeg'\], file_size_limit = 10485760/);
    assert.ok(!/taller_lee_media|taller_sube_media/.test(sql.replace(/policyname IN \([^)]*\)/, "")), "no toca las políticas de Storage de SYNC-2");
  });

  test("observabilidad: sync-fotos no registra en consola ni guarda tokens/URLs firmadas en la cola", () => {
    const t = leer("taller-demo/sync-fotos.js");
    assert.ok(!/console\.(log|info|warn|error|debug)/.test(t));
    assert.ok(!/localStorage|sessionStorage/.test(t));
    const enc = /function encolar\(bd, o\)[\s\S]*?\n  }\n/.exec(t)[0];
    assert.ok(!/token|signed|url/i.test(enc), "el registro en cola no lleva token ni URL");
  });
});
