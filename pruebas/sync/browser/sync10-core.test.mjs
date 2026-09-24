// SYNC-10 · IMPORTADOR 3.13 → NUBE en navegadores REALES (Chrome y Firefox) contra PostgREST + Postgres reales (cadena
// completa 1..9 + 10). El módulo de verdad (taller-demo/import-313.js) con el respaldo que generó el CÓDIGO REAL de la
// 3.13.0 (fixtures/): File/JSON en el navegador, fetch real, UNA llamada atómica, MIGRATION_PARITY_CHECK campo a campo,
// invariantes, doble importación, respuesta perdida, cierre a mitad, todo-o-nada por HTTP, autorización (admin, cajero,
// mecánico, anónimo, inactivo, token vencido), sin red, tamaño grande con el statement_timeout REAL de authenticated (8 s)
// y la demostración de P0002 (HEAD anterior → HTTP 500 → reintento infinito; SYNC-10 → 409 → terminal).
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/sync10-core.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { iniciarPila, PERFILES, REST_URL, RAIZ } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { paridad } from "./lib/paridad.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const FIX = path.join(RAIZ, "pruebas/sync/fixtures");
const TEXTO = fs.readFileSync(path.join(FIX, "respaldo-313-realista.json"), "utf8");
const RESPALDO = JSON.parse(TEXTO);
const PII = [...RESPALDO.data.clientes.flatMap((c) => [c.nombre, c.telefono]), ...RESPALDO.data.motos.map((m) => m.placa)].filter((x) => x && x.length > 3);
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

const uno = (q) => pila.sql(q);
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (${q}) t`));
const invariantes = () => uno(`select public.verificar_invariantes()::text`);
const conteo = () => nube(`select (select count(*) from public.clientes) c, (select count(*) from public.ventas) v, (select count(*) from public.caja_movimientos) cm,
  (select count(*) from public.abonos) a, (select count(*) from public.inventario_movimientos) im, (select coalesce(sum(cantidad),0) from public.inventario) u, (select count(*) from public.import_lotes) l`)[0];

/** Página real (index.html) con el importador listo: SyncRest real + token; fetch envuelto para contar llamadas, perder
    la respuesta de UNA rpc o simular «sin red». */
async function preparar(d, token) {
  await d.eval((a) => {
    window.toast = () => {};
    if (!window.__fetchReal) {
      window.__fetchReal = window.fetch.bind(window);
      window.fetch = function (url, init) {
        const u = String(url && url.url ? url.url : url);
        const m = /\/rpc\/([a-z_]+)/.exec(u);
        if (m) (window.__llamadas = window.__llamadas || []).push(m[1]);
        if (window.__sinRed) return Promise.reject(new TypeError("Failed to fetch"));
        if (m && window.__perder === m[1]) { window.__perder = null; return window.__fetchReal(url, init).then(() => { throw new TypeError("Failed to fetch"); }); }
        return window.__fetchReal(url, init);
      };
    }
    window.__token = a.token;
    window.__rest = SyncRest.crear({ baseUrl: window.ENTIMOTORS_SUPABASE.url, anonKey: window.ENTIMOTORS_SUPABASE.anonKey, getToken: () => window.__token });
    window.__rpc = (n, p, o) => window.__rest.rpc(n, p, o);
    window.__imp = async (txt, o) => {
      o = o || {};
      // igual que la app: el texto pasa por un File real (File API) antes de leerse
      const archivo = new File([txt], "entimotors-backup.json", { type: "application/json" });
      const l = Import313.leerTexto(await archivo.text());
      if (!l.ok) return { ok: false, errores: l.errores };
      const prep = await Import313.preparar(l.respaldo);
      if (!prep.ok) return { ok: false, errores: prep.errores };
      window.__llamadas = [];
      const r = await Import313.importar({ rpc: window.__rpc, preparado: prep, enLinea: () => !o.offline });
      return Object.assign({}, r, { llamadas: window.__llamadas.slice(), lote: prep.lote });
    };
    return true;
  }, { token });
}
let n = 0;
async function abrir(nav, quien = "admin", o = {}) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `10core-${quien}-${nav}-${++n}`, pagina: "index.html", real: true });
  await preparar(d, o.token !== undefined ? o.token : pila.jwt(PERFILES[quien]));
  return d;
}
async function recargar(d, token) {
  await d.eval(() => { setTimeout(() => location.reload(), 50); return true; });
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 40; i++) { try { await d.eval(() => document.readyState, null, { plazoMs: 3000 }); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  await preparar(d, token);
}

for (const nav of NAVS) {
  describe(`SYNC-10 · importador 3.13 real · ${nav}`, () => {
    const abiertos = [];
    const abrirD = async (q, o) => { const d = await abrir(nav, q, o); abiertos.push(d); return d; };
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });

    test("respaldo 3.13 REAL → nube vacía → UNA llamada de aplicar → MIGRATION_PARITY_CHECK = [] e invariantes = []", async () => {
      pila.limpiar();
      const d = await abrirD("admin");
      const r = await d.eval((t) => window.__imp(t), TEXTO, { plazoMs: 120000 });
      assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.verificado, true, JSON.stringify(r.diferencias));
      assert.equal(r.llamadas.filter((x) => x === "import_aplicar_paquete").length, 1, "un solo paquete, nunca cientos de operaciones");
      assert.deepEqual(r.llamadas, ["import_estado", "import_totales", "import_iniciar", "import_dry_run_ok", "import_aplicar_paquete", "import_totales"]);
      assert.deepEqual(paridad(RESPALDO, nube), [], "MIGRATION_PARITY_CHECK");
      assert.equal(invariantes(), "[]");
      assert.equal(nube(`select estado from public.import_lotes`)[0].estado, "aplicado");
    });

    test("DOBLE importación: el mismo respaldo desde OTRO dispositivo y re-exportado (otra cabecera) → repetida; OTRO respaldo → bloqueado; nada se duplica", async () => {
      const antes = conteo();
      const d2 = await abrirD("admin");
      const r1 = await d2.eval((t) => window.__imp(t), TEXTO, { plazoMs: 60000 });
      assert.equal(r1.ok, true); assert.equal(r1.repetida, true); assert.ok(!r1.llamadas.includes("import_aplicar_paquete"), "ya aplicado: ni se reenvía");
      const reexp = JSON.stringify({ ...RESPALDO, idRespaldo: "ENTI-2026-09-24-OTRA", exportadoEn: new Date().toISOString() });
      const r2 = await d2.eval((t) => window.__imp(t), reexp, { plazoMs: 60000 });
      assert.equal(r2.repetida, true);
      const otro = JSON.parse(TEXTO); otro.data.clientes[0].telefono = "0000-0000";
      const r3 = await d2.eval((t) => window.__imp(t), JSON.stringify(otro), { plazoMs: 60000 });
      assert.equal(r3.ok, false); assert.equal(r3.codigo, "NUBE_CON_DATOS");
      assert.deepEqual(conteo(), antes, "ni una fila de más"); assert.deepEqual(paridad(RESPALDO, nube), []);
    });

    test("RESPUESTA PERDIDA tras el commit: la app consulta el estado, no reimporta, verifica; el reintento es «repetida»", async () => {
      pila.limpiar();
      const d = await abrirD("admin");
      await d.eval(() => { window.__perder = "import_aplicar_paquete"; return true; });
      const r = await d.eval((t) => window.__imp(t), TEXTO, { plazoMs: 120000 });
      assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.verificado, true);
      assert.ok(r.llamadas.filter((x) => x === "import_estado").length === 2, "tras el corte pregunta al servidor");
      const antes = conteo();
      const r2 = await d.eval((t) => window.__imp(t), TEXTO, { plazoMs: 60000 });
      assert.equal(r2.repetida, true); assert.deepEqual(conteo(), antes);
      assert.deepEqual(paridad(RESPALDO, nube), []); assert.equal(invariantes(), "[]");
    });

    test("CIERRE a mitad: (a) tras el dry-run, antes de enviar → reabrir y reanudar; (b) el servidor aplicó pero la app se cerró antes de saberlo → reabrir → «repetida»", async () => {
      pila.limpiar();
      const d = await abrirD("admin");
      const a = await d.eval(async (t) => {
        const prep = await Import313.preparar(JSON.parse(t));
        await window.__rpc("import_iniciar", { p_lote: prep.lote, p_legacy_device: "legado-313", p_sha256: prep.huella, p_backup_id: "x", p_version_app: "3.13.0", p_esquema: 6, p_conteos: {} });
        await window.__rpc("import_dry_run_ok", { p_lote: prep.lote, p_informe: {} });
        return prep.lote;
      }, TEXTO, { plazoMs: 60000 });
      assert.equal(nube(`select estado from public.import_lotes`)[0].estado, "dry_run_ok"); assert.equal(conteo().c, 0, "nada a medias");
      await recargar(d, pila.jwt(PERFILES.admin));
      const r = await d.eval((t) => window.__imp(t), TEXTO, { plazoMs: 120000 });
      assert.equal(r.ok, true); assert.equal(r.lote, a, "mismo lote (determinista): se reanuda, no se crea otro");
      assert.equal(nube(`select count(*) n from public.import_lotes`)[0].n, 1);
      // (b)
      pila.limpiar();
      await d.eval(async (t) => {
        const prep = await Import313.preparar(JSON.parse(t));
        await window.__rpc("import_iniciar", { p_lote: prep.lote, p_legacy_device: "legado-313", p_sha256: prep.huella, p_backup_id: "x", p_version_app: "3.13.0", p_esquema: 6, p_conteos: {} });
        await window.__rpc("import_dry_run_ok", { p_lote: prep.lote, p_informe: {} });
        window.__rpc("import_aplicar_paquete", { p_lote: prep.lote, p_paquete: prep.paquete }, { timeout: 120000 });   // sin esperar: la app «se cierra»
        return true;
      }, TEXTO, { plazoMs: 60000 });
      for (let i = 0; i < 40 && nube(`select estado from public.import_lotes`)[0]?.estado !== "aplicado"; i++) await new Promise((ok) => setTimeout(ok, 250));
      await recargar(d, pila.jwt(PERFILES.admin));
      const antes = conteo();
      const r2 = await d.eval((t) => window.__imp(t), TEXTO, { plazoMs: 60000 });
      assert.equal(r2.ok, true); assert.equal(r2.repetida, true); assert.equal(r2.verificado, true); assert.deepEqual(conteo(), antes);
      assert.deepEqual(paridad(RESPALDO, nube), []);
    });

    test("TODO O NADA por HTTP: un paquete que falla a mitad → HTTP 400 terminal, NADA en la nube y la respuesta no trae datos personales", async () => {
      pila.limpiar();
      const d = await abrirD("admin");
      const r = await d.eval(async (t) => {
        const prep = await Import313.preparar(JSON.parse(t));
        await window.__rpc("import_iniciar", { p_lote: prep.lote, p_legacy_device: "legado-313", p_sha256: prep.huella, p_backup_id: "x", p_version_app: "3.13.0", p_esquema: 6, p_conteos: {} });
        await window.__rpc("import_dry_run_ok", { p_lote: prep.lote, p_informe: {} });
        prep.paquete.ordenes[prep.paquete.ordenes.length - 1].estado = "inventado";   // falla DESPUÉS de clientes, motos e inventario
        const res = await window.__fetchReal(window.ENTIMOTORS_SUPABASE.url + "/rest/v1/rpc/import_aplicar_paquete", { method: "POST",
          headers: { apikey: "anon-sintetica", Authorization: "Bearer " + window.__token, "Content-Type": "application/json" }, body: JSON.stringify({ p_lote: prep.lote, p_paquete: prep.paquete }) });
        const texto = await res.text();
        return { status: res.status, texto, clase: SyncRest.clasificar(res.status, JSON.parse(texto)).clase };
      }, TEXTO, { plazoMs: 60000 });
      assert.equal(r.status, 400); assert.equal(r.clase, "validacion", "terminal: nunca se reintenta solo");
      for (const p of PII) assert.ok(!r.texto.includes(p), "la respuesta filtró un dato personal");
      assert.deepEqual(conteo(), { c: 0, v: 0, cm: 0, a: 0, im: 0, u: 0, l: 1 }, "ni un cliente, venta, caja ni stock");
      assert.equal(nube(`select estado from public.import_lotes`)[0].estado, "dry_run_ok", "el lote sigue listo para un reintento correcto");
    });

    test("AUTORIZACIÓN: cajero, mecánico, anónimo, admin INACTIVO y token VENCIDO → DENY en todas las RPC del importador; nada entra y el backup no se refleja", async () => {
      pila.limpiar();
      const quienes = [["cajero", pila.jwt(PERFILES.cajero)], ["mecanico", pila.jwt(PERFILES.mecanico)], ["anon", pila.jwt(null, { role: "anon" })],
        ["vencido", pila.jwt(PERFILES.admin, { segundos: -600 })], ["inactivo", pila.jwt(PERFILES.admin)]];
      const d = await abrirD("admin");
      for (const [quien, token] of quienes) {
        if (quien === "inactivo") uno(`update public.perfiles set activo = false where id = '${PERFILES.admin}'`);
        try {
          const r = await d.eval(async (a) => {
            const prep = await Import313.preparar(JSON.parse(a.t));
            const out = {};
            for (const [nombre, p] of [["import_totales", {}], ["import_estado", { p_lote: prep.lote }],
              ["import_iniciar", { p_lote: prep.lote, p_legacy_device: "legado-313", p_sha256: prep.huella, p_backup_id: "x", p_version_app: "3.13.0", p_esquema: 6, p_conteos: {} }],
              ["import_aplicar_paquete", { p_lote: prep.lote, p_paquete: prep.paquete }], ["import_confirmar_lote", { p_lote: prep.lote }]]) {
              const res = await window.__fetchReal(window.ENTIMOTORS_SUPABASE.url + "/rest/v1/rpc/" + nombre, { method: "POST",
                headers: { apikey: "anon-sintetica", Authorization: "Bearer " + a.token, "Content-Type": "application/json" }, body: JSON.stringify(p) });
              out[nombre] = { status: res.status, texto: await res.text() };
            }
            return out;
          }, { t: TEXTO, token }, { plazoMs: 60000 });
          for (const [nombre, x] of Object.entries(r)) {
            assert.ok(x.status >= 400, `${quien} ${nombre}: ${x.status}`);
            for (const p of PII) assert.ok(!x.texto.includes(p), `${quien} ${nombre}: la respuesta reflejó datos del respaldo`);
          }
        } finally { uno(`update public.perfiles set activo = true where id = '${PERFILES.admin}'`); }
      }
      assert.deepEqual(conteo(), { c: 0, v: 0, cm: 0, a: 0, im: 0, u: 0, l: 0 }, "nada entró, ni siquiera un lote");
    });

    test("SIN RED: no sale ni una petición y no se toca nada", async () => {
      pila.limpiar();
      const d = await abrirD("admin");
      const r = await d.eval((t) => window.__imp(t, { offline: true }), TEXTO, { plazoMs: 60000 });
      assert.equal(r.codigo, "SIN_RED"); assert.deepEqual(r.llamadas, []); assert.equal(conteo().l, 0);
    });
  });
}

describe("SYNC-10 · tamaño, statement_timeout real y P0002 (una vez)", () => {
  test("respaldo GRANDE (≈26 000 filas) por HTTP: entra entero, bajo el statement_timeout de authenticated (8 s) gracias al de la función (120 s)", async () => {
    pila.limpiar();
    assert.equal(uno(`select array_to_string(rolconfig, ',') from pg_roles where rolname = 'authenticated'`), "statement_timeout=8s", "mismo límite que producción");
    const d = await abrirDispositivo({ navegador: NAVS[0], nombre: "10core-grande", pagina: "index.html", real: true });
    try {
      await preparar(d, pila.jwt(PERFILES.admin));
      const txt = grande(2000);
      const t0 = Date.now();
      const r = await d.eval((t) => window.__imp(t), txt, { plazoMs: 200000 });
      const ms = Date.now() - t0;
      assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400)); assert.equal(r.verificado, true);
      assert.ok(ms > 0 && ms < 150000, `tardó ${ms} ms`);
      console.log(`  [SYNC-10] respaldo de ${Math.round(txt.length / 1024)} KB / ${nube(`select count(*) n from public.import_registros`)[0].n} filas importado en ${ms} ms`);
      assert.equal(invariantes(), "[]");
    } finally { await d.cerrar(); }
  });

  test("P0002 DEMOSTRADO: con sync-5/sync-6 de HEAD 1a10865 → HTTP 500 → clase «servidor» (reintento infinito); con SYNC-10 → HTTP 409 → «conflicto» (terminal)", async () => {
    pila.limpiar();
    const O = "00000000-0000-4000-9000-000000000a01", C = "00000000-0000-4000-9000-000000000a02";
    uno(`insert into public.clientes (id, nombre) values ('${C}', 'Cli P0002');
         insert into public.ordenes (id, cliente_id, estado, falla, mecanico, mecanico_id, origen_trabajo) values ('${O}', '${C}', 'recibido', 'x', 'Mec', '${PERFILES.mecanico}', 'taller');
         update public.ordenes set deleted_at = now() where id = '${O}';`);
    const llamar = async (quien, rpc, cuerpo) => {
      const res = await fetch(`${REST_URL}/rest/v1/rpc/${rpc}`, { method: "POST", headers: { apikey: "anon-sintetica", Authorization: "Bearer " + pila.jwt(PERFILES[quien]), "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
      const j = await res.json(); return { status: res.status, code: j.code };
    };
    const avance = () => llamar("mecanico", "avanzar_orden_tecnico", { p_op: crypto.randomUUID(), p_orden_id: O, p_campos: { estado: "diagnostico" }, p_device: "dev" });
    const items = () => llamar("cajero", "sync_guardar_items_cotizacion", { p_op: crypto.randomUUID(), p_cotizacion_id: crypto.randomUUID(), p_items: [], p_device: "dev" });
    const clasificar = (x) => { const s = spawnSync("node", ["-e", `global.window=global;require(${JSON.stringify(path.join(RAIZ, "taller-demo/sync-rest.js"))});process.stdout.write(SyncRest.clasificar(${x.status},{code:${JSON.stringify(x.code)}}).clase)`], { encoding: "utf8" }); return s.stdout; };
    const viejo = (f) => spawnSync("git", ["-C", RAIZ, "show", `1a10865:taller-demo/supabase/sync/${f}`], { encoding: "utf8" }).stdout;
    const aplicar = (sqlTexto) => { const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "s10-")), "x.sql"); fs.writeFileSync(tmp, sqlTexto); uno(`\\i ${tmp}`); uno("notify pgrst, 'reload schema'"); };
    try {
      aplicar(viejo("sync-6-mecanicos-ordenes.sql")); aplicar(viejo("sync-5-cotizacion-items.sql"));
      await new Promise((r) => setTimeout(r, 800));
      const a0 = await avance(), i0 = await items();
      assert.deepEqual([a0.status, a0.code, clasificar(a0)], [500, "P0002", "servidor"], "ANTES: la cola lo reintentaba cada ≤5 min para siempre");
      assert.deepEqual([i0.status, i0.code, clasificar(i0)], [500, "P0002", "servidor"]);
    } finally {
      aplicar(fs.readFileSync(path.join(RAIZ, "taller-demo/supabase/sync/sync-6-mecanicos-ordenes.sql"), "utf8"));
      aplicar(fs.readFileSync(path.join(RAIZ, "taller-demo/supabase/sync/sync-5-cotizacion-items.sql"), "utf8"));
      aplicar(fs.readFileSync(path.join(RAIZ, "taller-demo/supabase/sync/sync-7a-inventario.sql"), "utf8"));   // 7a re-aplica encima (idempotente), como en la cadena
      aplicar(fs.readFileSync(path.join(RAIZ, "taller-demo/supabase/sync/sync-9-fotos.sql"), "utf8"));
      await new Promise((r) => setTimeout(r, 800));
    }
    const a1 = await avance(), i1 = await items();
    assert.deepEqual([a1.status, a1.code, clasificar(a1)], [409, "23503", "conflicto"], "AHORA: rechazo terminal (a la vista en «⚠ Por revisar»)");
    assert.deepEqual([i1.status, i1.code, clasificar(i1)], [409, "23503", "conflicto"]);
    assert.deepEqual(nube(`select estado from public.ordenes where id = '${O}'`), [{ estado: "recibido" }], "sin daño de datos");
  });
});

/** Respaldo 3.13 sintético GRANDE con la misma forma que escribe la 3.13 (cliente, moto, orden con 2 renglones, venta con 2,
    crédito con abono y su caja, por cliente). */
function grande(N) {
  const d = { clientes: [], motos: [], ordenes: [], inventario: [], citas: [], cotizaciones: [], ventas_rapidas: [], caja_movimientos: [], creditos: [], web_cms: [], categorias_inv: [{ id: 1, nombre: "Cat" }], auditoria: [] };
  for (let i = 1; i <= 50; i++) d.inventario.push({ id: i, nombre: "Rep " + i, cantidad: i * 3, precio: 100, precioVenta: 100, costoCompra: 50, stockMinimo: 2, codigoBarras: "", categoriaId: 1, publicarEnWeb: false });
  let caja = 1; const f = new Date().toISOString();
  for (let i = 1; i <= N; i++) {
    d.clientes.push({ id: i, nombre: "Cliente " + i, telefono: "9" + i });
    d.motos.push({ id: i, clienteId: i, marca: "M", modelo: "X", placa: "P" + i, km: i, foto: null, mantenimiento: null });
    d.ordenes.push({ id: i, clienteId: i, motoId: i, estado: "entregado", falla: "f", items: [{ nombre: "a", cantidad: 1, precio: 100, origenInventarioId: (i % 50) + 1, costoUnitario: 50 }, { nombre: "MO", cantidad: 1, precio: 200 }], fotos: [], mecanico: "Mec", creadoEn: Date.now(), finalizada: true, tipoCobro: "contado", origenTrabajo: "taller" });
    d.ventas_rapidas.push({ id: i, items: [{ inventarioId: (i % 50) + 1, nombre: "a", cantidad: 2, precio: 100 }, { nombre: "b", cantidad: 1, precio: 50 }], clienteId: i, metodoPago: "efectivo", total: 250, fechaISO: f });
    d.caja_movimientos.push({ id: caja++, tipo: "ingreso", categoria: "Venta mostrador", monto: 250, metodoPago: "efectivo", ventaId: i, fechaISO: f });
    d.creditos.push({ id: i, clienteId: i, clienteNombre: "Cliente " + i, items: [{ nombre: "c", cantidad: 1, precio: 300 }], total: 300, abonado: 100, saldo: 200, estado: "parcial", historialAbonos: [{ idAbono: "a" + i, monto: 100, metodoPago: "efectivo", fechaISO: f }], fechaISO: f });
    d.caja_movimientos.push({ id: caja++, tipo: "ingreso", categoria: "Cobro de crédito", monto: 100, metodoPago: "efectivo", creditoId: i, idAbono: "a" + i, fechaISO: f });
  }
  const conteos = {}; let tot = 0; for (const k in d) { conteos[k] = d[k].length; tot += d[k].length; }
  return JSON.stringify({ version: 2, versionApp: "3.13.0", esquemaDB: 6, idRespaldo: "ENTI-GRANDE", exportadoEn: f, conteos, totalRegistros: tot, data: d });
}
