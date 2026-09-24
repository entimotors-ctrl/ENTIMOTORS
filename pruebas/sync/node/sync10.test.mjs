// SYNC-10 · IMPORTADOR 3.13 → NUBE (import-313.js) sin navegador: validación del respaldo (roto, incompleto, versión,
// ids, dinero que no cuadra, datos de EJEMPLO), vista previa solo con cantidades, mapeo (relaciones, ids deterministas,
// dinero histórico, stock exacto, nada del JSON decide identidad/rol/columnas del servidor), flujo con el servidor
// (nube vacía / con datos / desconocida, sin red, respuesta perdida, reintento, rol incorrecto) y las guardas estáticas
// de B2 (demo nunca en la nube), P0002 y del Service Worker. Fixtures 100 % sintéticos, generados con el código REAL de
// la 3.13.0 (pruebas/sync/fixtures/generar-respaldo-313.mjs).
// La prueba contra PostgREST + Postgres reales está en pruebas/sync/browser/sync10-core.test.mjs y sync10-app-real.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leer = (f) => fs.readFileSync(path.join(RAIZ, f), "utf8");
const ctx = vm.createContext({ console, Promise, JSON, Math, Date, TextEncoder, crypto: globalThis.crypto });
vm.runInContext(leer("taller-demo/import-313.js"), ctx, { filename: "import-313.js" });
const I = ctx.Import313;
const J = (x) => JSON.parse(JSON.stringify(x));
const REAL = () => JSON.parse(leer("pruebas/sync/fixtures/respaldo-313-realista.json"));
const DEMO = () => JSON.parse(leer("pruebas/sync/fixtures/respaldo-313-demo.json"));
const PII = (r) => [...r.data.clientes.flatMap((c) => [c.nombre, c.telefono]), ...r.data.motos.map((m) => m.placa)].filter((x) => x && String(x).length > 3);

describe("SYNC-10 · V313_DATA_MANIFEST y clasificación", () => {
  test("el fixture es un respaldo REAL de la 3.13.0 (formato 2, esquema 6, 12 stores verificados por la propia 3.13)", () => {
    const r = REAL();
    assert.equal(r.version, 2); assert.equal(r.esquemaDB, 6); assert.equal(r.versionApp, "3.13.0");
    assert.deepEqual(Object.keys(r.data).sort(), [...I.STORES].sort());
    assert.equal(r.totalRegistros, Object.values(r.data).reduce((a, x) => a + x.length, 0));
  });
  test("cada store 3.13 está clasificado (ninguno sin clasificar = BLOCKER) y ALL_STORES de la app coincide", () => {
    for (const s of I.STORES) assert.ok(["IMPORT", "DERIVE", "LOCAL_ONLY", "DEPRECATED", "DO_NOT_IMPORT"].includes(I.CLASIFICACION[s]), s);
    const all = /const ALL_STORES = (\[[^\]]+\])/.exec(leer("taller-demo/app.js"))[1];
    assert.deepEqual(JSON.parse(all).sort(), [...I.STORES].sort(), "el importador conoce exactamente los stores que respalda la app");
    assert.equal(I.CLASIFICACION.auditoria, "DO_NOT_IMPORT"); assert.equal(I.CLASIFICACION.web_cms, "LOCAL_ONLY");
  });
});

describe("SYNC-10 · validación del respaldo (entrada NO confiable)", () => {
  test("respaldo válido → ok, con avisos (referencia a un repuesto borrado, fotos base64, mecánicos por nombre, web y bitácora locales)", () => {
    const v = I.validar(REAL());
    assert.equal(v.ok, true, v.errores.join("; "));
    assert.ok(v.avisos.some((a) => /repuesto eliminado/.test(a)) && v.avisos.some((a) => /foto/.test(a)) && v.avisos.some((a) => /mecánico/.test(a)));
  });
  test("JSON roto, vacío o gigantesco → rechazo limpio (nunca lanza)", () => {
    assert.equal(I.leerTexto("{\"version\":2, ").ok, false);
    assert.equal(I.leerTexto("").ok, false);
    assert.match(I.leerTexto("x".repeat(I.LIMITE_BYTES + 1)).errores[0], /demasiado grande/);
    for (const x of [null, [], 7, "texto", { data: null }, { data: [] }]) assert.equal(I.validar(x).ok, false);
  });
  test("versión / esquema / app incompatibles → rechazo", () => {
    for (const cambio of [{ version: 1 }, { esquemaDB: 7 }, { esquemaDB: undefined }, { versionApp: "2.0" }, { versionApp: undefined }]) {
      const r = { ...REAL(), ...cambio };
      assert.equal(I.validar(r).ok, false, JSON.stringify(cambio));
    }
    const otra = { ...REAL(), versionApp: "3.12.4" };
    const v = I.validar(otra);
    assert.equal(v.ok, true); assert.ok(v.avisos.some((a) => /3\.12\.4/.test(a)), "otra 3.x se admite con aviso");
  });
  test("respaldo INCOMPLETO → rechazo: falta un store, conteos o total que no cuadran, tabla desconocida", () => {
    let r = REAL(); delete r.data.creditos; assert.match(I.validar(r).errores.join(), /falta la tabla «creditos»/);
    r = REAL(); r.data.clientes.pop(); assert.match(I.validar(r).errores.join(), /incompleto/);
    r = REAL(); r.totalRegistros += 1; assert.match(I.validar(r).errores.join(), /incompleto/);
    r = REAL(); r.data.inventada = []; assert.match(I.validar(r).errores.join(), /no conoce/);
  });
  test("ids inválidos o repetidos → rechazo", () => {
    let r = REAL(); r.data.clientes[0].id = "1"; assert.equal(I.validar(r).ok, false);
    r = REAL(); r.data.clientes[1].id = r.data.clientes[0].id; assert.match(I.validar(r).errores.join(), /repetido/);
    r = REAL(); r.data.ordenes[0].id = -3; assert.equal(I.validar(r).ok, false);
    r = REAL(); r.data.web_cms[0].key = ""; assert.equal(I.validar(r).ok, false);
  });
  test("campos críticos inválidos → rechazo (etapa, nombre, cantidad, tipo de caja, fecha de cita, vencimiento)", () => {
    const casos = [(d) => { d.ordenes[0].estado = "volando"; }, (d) => { d.clientes[0].nombre = "  "; }, (d) => { d.inventario[0].cantidad = "muchos"; },
      (d) => { d.caja_movimientos[0].tipo = "robo"; }, (d) => { d.citas[0].fecha = "ayer"; }, (d) => { d.cotizaciones[0].venceISO = "nunca"; },
      (d) => { d.ordenes[0].tipoCobro = "trueque"; }];
    for (const f of casos) { const r = REAL(); f(r.data); assert.equal(I.validar(r).ok, false, f.toString()); }
  });
  test("DINERO que no cuadra → rechazo ENTERO (nunca se recalcula ni se arregla)", () => {
    let r = REAL(); r.data.ventas_rapidas[0].total += 5; assert.match(I.validar(r).errores.join(), /no cuadra con sus renglones/);
    r = REAL(); const c = r.data.creditos.find((x) => x.historialAbonos.length); c.abonado += 1; assert.match(I.validar(r).errores.join(), /abonado no cuadra/);
    r = REAL(); r.data.creditos[0].saldo += 1; assert.match(I.validar(r).errores.join(), /saldo no cuadra/);
    r = REAL(); r.data.creditos.find((x) => x.historialAbonos.length).historialAbonos[0].monto = 0; assert.equal(I.validar(r).ok, false);
    r = REAL(); r.data.caja_movimientos[0].monto = -1; assert.equal(I.validar(r).ok, false);
  });
  test("B2 · un respaldo con los datos de EJEMPLO de la 3.13 («Ver un ejemplo» / cuenta prueba) → rechazo", () => {
    const v = I.validar(DEMO());
    assert.equal(v.ok, false); assert.match(v.errores.join(), /datos de EJEMPLO/);
    const r = REAL(); r.data.clientes.push({ id: 999, nombre: "Carlos Reyes", telefono: "9704-1122" }, { id: 998, nombre: "Ana Gómez", telefono: "9911-2233" });
    r.conteos.clientes += 2; r.totalRegistros += 2;
    assert.equal(I.validar(r).ok, false, "mezclado con datos reales también");
  });
  test("privacidad: ningún error ni aviso trae nombres, teléfonos ni placas del respaldo", () => {
    const r = REAL(); const pii = PII(r);
    r.data.ordenes[0].estado = "x"; r.data.clientes[0].nombre = ""; r.data.ventas_rapidas[0].total += 9;
    const v = I.validar(r); const todo = v.errores.concat(v.avisos).join(" | ");
    for (const s of pii.filter((x) => x !== "")) assert.ok(!todo.includes(s), "se filtró: " + s);
  });
  test("límite de filas: un respaldo enorme se rechaza antes de tocar la red", () => {
    const r = REAL(); const base = r.data.clientes[0];
    for (let i = 0; i < I.LIMITE_FILAS + 5; i++) r.data.clientes.push({ ...base, id: 100000 + i, nombre: "C" + i, telefono: "" });
    r.conteos.clientes = r.data.clientes.length; r.totalRegistros = Object.values(r.data).reduce((a, x) => a + x.length, 0);
    assert.match(I.validar(r).errores.join(), /filas/);
  });
});

describe("SYNC-10 · vista previa (solo cantidades)", () => {
  test("resumen: cantidades por tipo y lo que se queda en el teléfono; sin datos personales", () => {
    const r = REAL(); const s = I.resumen(r);
    assert.equal(s.conteos.clientes, r.data.clientes.length); assert.equal(s.conteos.productos, r.data.inventario.length);
    assert.equal(s.conteos.abonos, r.data.creditos.reduce((a, c) => a + c.historialAbonos.length, 0));
    assert.equal(s.seQuedanEnElTelefono.bitacora, r.data.auditoria.length);
    const txt = JSON.stringify(s); for (const p of PII(r)) assert.ok(!txt.includes(p), p);
  });
});

describe("SYNC-10 · mapeo 3.13 → nube (paquete)", () => {
  test("ids deterministas: el mismo respaldo → mismo lote y mismos UUID; re-exportar (otra cabecera) → mismo lote", async () => {
    const a = await I.preparar(REAL()), b = await I.preparar({ ...REAL(), idRespaldo: "ENTI-OTRO", exportadoEn: new Date().toISOString() });
    assert.equal(a.lote, b.lote); assert.deepEqual(J(a.paquete), J(b.paquete));
    assert.match(a.lote, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const r = REAL(); r.data.clientes[0].telefono = "otro"; assert.notEqual((await I.preparar(r)).lote, a.lote, "otros datos → otro lote");
  });
  test("relaciones: toda FK del paquete apunta a una fila del MISMO paquete (o va vacía); ninguna depende del orden del JSON", async () => {
    const p = (await I.preparar(REAL())).paquete; const ids = (t) => new Set(p[t].map((x) => x.id));
    const chk = (t, col, destino) => { for (const x of p[t]) if (x[col] !== undefined) assert.ok(ids(destino).has(x[col]), `${t}.${col}`); };
    chk("motos", "cliente_id", "clientes"); chk("inventario", "categoria_id", "categorias_inv"); chk("ordenes", "cliente_id", "clientes"); chk("ordenes", "moto_id", "motos");
    chk("orden_items", "orden_id", "ordenes"); chk("orden_items", "inventario_id", "inventario"); chk("cotizaciones", "orden_id", "ordenes"); chk("cotizacion_items", "cotizacion_id", "cotizaciones");
    chk("citas", "orden_id", "ordenes"); chk("venta_items", "venta_id", "ventas"); chk("venta_items", "inventario_id", "inventario"); chk("creditos", "orden_id", "ordenes");
    chk("credito_items", "credito_id", "creditos"); chk("abonos", "credito_id", "creditos"); chk("caja_movimientos", "venta_id", "ventas"); chk("caja_movimientos", "credito_id", "creditos");
    chk("caja_movimientos", "orden_id", "ordenes"); chk("enlaces", "id", "ordenes"); chk("enlaces", "credito_id", "creditos");
    const abonos = new Set(p.abonos.map((a) => a.id_abono));
    for (const c of p.caja_movimientos) if (c.id_abono) assert.ok(abonos.has(c.id_abono), "la caja del abono apunta al abono importado");
    const invertido = REAL(); for (const s of Object.keys(invertido.data)) invertido.data[s].reverse();
    assert.deepEqual(new Set((await I.preparar(invertido)).paquete.clientes.map((x) => x.id)), ids("clientes"), "orden del JSON irrelevante");
  });
  test("un repuesto BORRADO en la 3.13 pero vendido antes: el renglón entra con su texto y montos, sin enlace", async () => {
    const r = REAL(); const p = (await I.preparar(r)).paquete;
    const inv = new Set(r.data.inventario.map((x) => x.id));
    const colgante = r.data.ventas_rapidas.flatMap((v) => v.items).find((it) => it.inventarioId && !inv.has(it.inventarioId));
    assert.ok(colgante, "el fixture trae la venta del repuesto borrado");
    const fila = p.venta_items.find((x) => x.nombre === colgante.nombre && x.precio === colgante.precio);
    assert.equal(fila.inventario_id, undefined); assert.equal(fila.cantidad, colgante.cantidad);
  });
  test("dinero histórico: totales esperados = suma exacta del respaldo; nada se recalcula", async () => {
    const r = REAL(); const { esperado: e } = await I.preparar(r);
    const s = (xs, f) => Math.round(xs.reduce((a, x) => a + f(x), 0) * 100) / 100;
    assert.equal(e.ventas.total, s(r.data.ventas_rapidas, (x) => x.total));
    assert.equal(e.creditos.saldo, s(r.data.creditos, (x) => x.saldo));
    assert.equal(e.abonos.monto, s(r.data.creditos.flatMap((c) => c.historialAbonos), (a) => a.monto));
    assert.equal(e.caja.ingresos, s(r.data.caja_movimientos.filter((x) => x.tipo === "ingreso"), (x) => x.monto));
    assert.equal(e.caja.egresos, s(r.data.caja_movimientos.filter((x) => x.tipo === "egreso"), (x) => x.monto));
  });
  test("inventario: la cantidad viaja EXACTA (0, 1 y alta) para la apertura única del ledger", async () => {
    const r = REAL(); const p = (await I.preparar(r)).paquete;
    for (const x of r.data.inventario) assert.equal(p.inventario.find((y) => y.local_id === x.id).cantidad ?? 0, x.cantidad);
    assert.ok(r.data.inventario.some((x) => x.cantidad === 0) && r.data.inventario.some((x) => x.cantidad === 1) && r.data.inventario.some((x) => x.cantidad >= 100));
  });
  test("SEGURIDAD: el JSON no decide identidad, rol, dueño, mecánico, columnas del servidor ni SQL", async () => {
    const r = REAL();
    Object.assign(r.data.clientes[0], { created_by: "00000000-0000-4000-8000-000000000001", rol: "admin", deleted_at: "2020-01-01", rev: 99, "nombre); DROP TABLE clientes;--": 1 });
    Object.assign(r.data.ordenes[0], { mecanicoId: "00000000-0000-4000-8000-000000000003", mecanico_id: "00000000-0000-4000-8000-000000000003", credito_id: "x", updated_by: "y" });
    Object.assign(r.data.inventario[0], { requiere_revision: true, foto_path: "../../otro", bucket: "entimotors-taller" });
    r.data.clientes[1].nombre = "Robert'); DROP TABLE clientes;--";
    const p = (await I.preparar(r)).paquete;
    const PERMITIDAS = { clientes: ["id", "local_id", "dispositivo", "nombre", "telefono"] };
    for (const x of p.clientes) for (const k of Object.keys(x)) assert.ok(PERMITIDAS.clientes.includes(k), "columna no permitida: " + k);
    for (const t of Object.keys(p)) for (const x of p[t]) for (const k of Object.keys(x)) {
      assert.ok(!["created_by", "updated_by", "rev", "deleted_at", "deleted_by", "mecanico_id", "rol", "op_id", "last_op_id", "requiere_revision", "foto_path", "bucket"].includes(k), `${t}.${k}`);
      assert.match(k, /^[a-z_]+$/, "las llaves son columnas fijas, nunca las del respaldo");
    }
    assert.ok(p.ordenes.every((o) => o.credito_id === undefined), "el enlace orden→crédito solo va por «enlaces»");
    assert.ok(p.clientes.some((x) => x.nombre === "Robert'); DROP TABLE clientes;--"), "el texto viaja como DATO (el servidor lo inserta con parámetros)");
    assert.ok(p.clientes.every((x) => x.dispositivo === I.DISPOSITIVO));
  });
  test("fotos base64 nunca viajan (la nube tiene CHECK sin base64): se quedan en el respaldo", async () => {
    const txt = JSON.stringify((await I.preparar(REAL())).paquete);
    assert.ok(!/data:[a-z]+\/[a-z0-9.+-]+;base64/i.test(txt));
  });
  test("lo vacío no viaja: cada columna toma su DEFAULT (nunca un NULL explícito que viole NOT NULL)", async () => {
    const p = (await I.preparar(REAL())).paquete;
    for (const t of Object.keys(p)) for (const x of p[t]) for (const [k, v] of Object.entries(x)) assert.ok(v !== null && v !== undefined, `${t}.${k}`);
  });
});

describe("SYNC-10 · flujo con el servidor (rpc simulado)", () => {
  const TOT0 = { clientes: 0, motos: 0, ordenes: 0, citas: 0, cotizaciones: 0, inventario: { n: 0, unidades: 0 }, ventas: { n: 0, total: 0 }, creditos: { n: 0, total: 0, saldo: 0 }, abonos: { n: 0, monto: 0 }, caja: { ingresos: 0, egresos: 0 } };
  /** Servidor falso con el MISMO contrato que sync-10: estado del lote, nube vacía, todo o nada, repetida. */
  function servidor({ nube = TOT0, perderRespuesta = false, sinRed = false, rol = "admin", fallaAplicar = null } = {}) {
    const s = { lotes: {}, llamadas: [], totales: nube, aplicaciones: 0 };
    s.rpc = async (n, p) => {
      s.llamadas.push(n);
      if (sinRed) return { ok: false, clase: "red", codigo: "SIN_RED", mensaje: "sin red" };
      if (rol !== "admin") return { ok: false, clase: "permiso", status: 403, codigo: "42501", mensaje: "Solo el administrador importa" };
      if (n === "import_estado") return { ok: true, datos: s.lotes[p.p_lote] ? { estado: s.lotes[p.p_lote].estado } : { estado: "inexistente" } };
      if (n === "import_totales") return { ok: true, datos: J(s.totales) };
      if (n === "import_iniciar") { s.lotes[p.p_lote] ??= { estado: "dry_run" }; return { ok: true, datos: {} }; }
      if (n === "import_dry_run_ok") { s.lotes[p.p_lote].estado = "dry_run_ok"; return { ok: true, datos: {} }; }
      if (n === "import_aplicar_paquete") {
        if (fallaAplicar) return fallaAplicar;
        if (s.lotes[p.p_lote].estado !== "aplicado") { s.aplicaciones++; s.lotes[p.p_lote].estado = "aplicado"; s.totales = s.esperado; }
        if (perderRespuesta) { perderRespuesta = false; return { ok: false, clase: "red", codigo: "TIMEOUT", mensaje: "corte" }; }
        return { ok: true, datos: { estado: "aplicado" } };
      }
      return { ok: false, clase: "esquema", mensaje: "?" };
    };
    return s;
  }
  test("nube VACÍA → importa en UNA llamada de aplicar, verifica y cuadra", async () => {
    const prep = await I.preparar(REAL()); const s = servidor(); s.esperado = prep.esperado;
    const r = await I.importar({ rpc: s.rpc, preparado: prep, enLinea: () => true });
    assert.equal(r.ok, true); assert.equal(r.verificado, true); assert.equal(s.aplicaciones, 1);
    assert.equal(s.llamadas.filter((n) => n === "import_aplicar_paquete").length, 1, "nunca cientos de operaciones: un solo paquete");
  });
  test("RESPUESTA PERDIDA tras el commit → se consulta el estado, no se reimporta; reintento = repetida", async () => {
    const prep = await I.preparar(REAL()); const s = servidor({ perderRespuesta: true }); s.esperado = prep.esperado;
    const r = await I.importar({ rpc: s.rpc, preparado: prep, enLinea: () => true });
    assert.equal(r.ok, true); assert.equal(r.verificado, true); assert.equal(s.aplicaciones, 1);
    const r2 = await I.importar({ rpc: s.rpc, preparado: prep, enLinea: () => true });
    assert.equal(r2.ok, true); assert.equal(r2.repetida, true); assert.equal(s.aplicaciones, 1, "doble importación: nunca dos veces");
  });
  test("corte ANTES del commit → SIN_CONFIRMAR reintentable; el reintento importa una sola vez", async () => {
    const prep = await I.preparar(REAL());
    const s = servidor({ fallaAplicar: { ok: false, clase: "red", codigo: "SIN_RED", mensaje: "corte" } }); s.esperado = prep.esperado;
    const r = await I.importar({ rpc: s.rpc, preparado: prep, enLinea: () => true });
    assert.equal(r.ok, false); assert.equal(r.codigo, "SIN_CONFIRMAR"); assert.equal(r.reintentable, true);
    const s2 = servidor(); s2.lotes = s.lotes; s2.esperado = prep.esperado;
    const r2 = await I.importar({ rpc: s2.rpc, preparado: prep, enLinea: () => true });
    assert.equal(r2.ok, true); assert.equal(s2.aplicaciones, 1);
  });
  test("nube CON DATOS → se detiene antes de iniciar el lote (sin merge)", async () => {
    const prep = await I.preparar(REAL()); const s = servidor({ nube: { ...TOT0, clientes: 1 } });
    const r = await I.importar({ rpc: s.rpc, preparado: prep, enLinea: () => true });
    assert.equal(r.codigo, "NUBE_CON_DATOS"); assert.ok(!s.llamadas.includes("import_iniciar"));
  });
  test("sin red → no empieza (ni una llamada); destino desconocido → no importa", async () => {
    const prep = await I.preparar(REAL()); const s = servidor();
    assert.equal((await I.importar({ rpc: s.rpc, preparado: prep, enLinea: () => false })).codigo, "SIN_RED"); assert.equal(s.llamadas.length, 0);
    const s2 = servidor({ sinRed: true });
    assert.equal((await I.importar({ rpc: s2.rpc, preparado: prep, enLinea: () => true })).codigo, "DESTINO_DESCONOCIDO");
  });
  test("rol incorrecto (cajero/mecánico) → DENY sin enviar el paquete", async () => {
    const prep = await I.preparar(REAL()); const s = servidor({ rol: "cajero" });
    const r = await I.importar({ rpc: s.rpc, preparado: prep, enLinea: () => true });
    assert.equal(r.ok, false); assert.ok(!s.llamadas.includes("import_aplicar_paquete"));
  });
  test("verificación que NO cuadra → se informa (sin datos personales), nunca se da por buena", async () => {
    const prep = await I.preparar(REAL()); const s = servidor(); s.esperado = { ...prep.esperado, ventas: { ...prep.esperado.ventas, total: 1 } };
    const r = await I.importar({ rpc: s.rpc, preparado: prep, enLinea: () => true });
    assert.equal(r.ok, true); assert.equal(r.verificado, false); assert.deepEqual(J(r.diferencias), ["ventas.total"]);
  });
  test("nubeVacia/compararTotales: numéricos que llegan como texto (numeric de PostgREST) se comparan bien", () => {
    assert.equal(I.nubeVacia(TOT0), true); assert.equal(I.nubeVacia({ ...TOT0, caja: { ingresos: "0.00", egresos: "5.00" } }), false);
    assert.equal(I.compararTotales({ a: 1.5, b: { c: 2 } }, { a: "1.50", b: { c: "2.00" } }).ok, true);
  });
});

describe("SYNC-10 · guardas estáticas (B2, restaurar/borrar en nube, P0002, SW, privacidad)", () => {
  const app = leer("taller-demo/app.js"), html = leer("taller-demo/index.html"), sw = leer("taller-demo/sw.js");
  const cuerpo = (nombre) => { const i = app.indexOf(`async function ${nombre}(`); assert.ok(i >= 0, nombre); return app.slice(i, app.indexOf("\n}\n", i)); };
  test("B2: seedIfEmpty y sembrarDatosPrueba salen ANTES de escribir nada si la sesión es de nube", () => {
    for (const f of ["seedIfEmpty", "sembrarDatosPrueba"]) {
      const c = cuerpo(f); const guard = c.indexOf("if (demoProhibido())"), primeraEscritura = c.search(/DB\.(save|getAll)\(/);
      assert.ok(guard > 0 && guard < primeraEscritura, f);
    }
    assert.match(app, /function demoProhibido\(\) \{ return currentUser\?\.origen === "supabase"; \}/, "se decide por la SESIÓN, no por el motor ni por la nube");
  });
  test("B2: todas las llamadas de siembra pasan por funciones con guard; elegir «demo» en nube se convierte en blanco", () => {
    const llamadas = [...app.matchAll(/\b(seedIfEmpty|sembrarDatosPrueba)\(\)/g)].length;
    assert.equal(llamadas, 4, "2 definiciones + 2 llamadas (continuarArranque) — un camino nuevo obliga a revisar esta guarda");
    assert.match(cuerpo("elegirModoDatos"), /if \(modo === "demo" && demoProhibido\(\)\) modo = "blanco";/);
    assert.match(app, /document\.getElementById\("btnModoDemo"\)\.style\.display = nube \? "none" : ""/);
  });
  test("con nube: «Restaurar» y «Empezar de cero» se niegan (escribirían en la nube o vaciarían entimotors_os_demo)", () => {
    const rest = app.slice(app.indexOf('getElementById("inputRestaurar").addEventListener'), app.indexOf("respaldoParaRestaurar = respaldo;"));
    assert.ok(rest.indexOf("if (demoProhibido())") > 0 && rest.indexOf("if (demoProhibido())") < rest.indexOf("JSON.parse"));
    const cero = app.slice(app.indexOf('getElementById("btnEmpezarDeCero").addEventListener'), app.indexOf("DB.clear(store)", app.indexOf('getElementById("btnEmpezarDeCero")')));
    assert.ok(cero.includes("if (demoProhibido())"));
  });
  test("el importador lee entimotors_os_demo SOLO para leer (nunca clear/delete/put sobre la base 3.13)", () => {
    const bloque = app.slice(app.indexOf("SYNC-10 · pasar los datos de la 3.13 a la nube"), app.indexOf("datos de prueba adicionales"));
    assert.ok(bloque.length > 1000);
    assert.ok(!/DB\.(clear|delete|save)\(|idbSave|idbDelete|\.clear\(\)/.test(bloque), "sin escrituras sobre la base local");
    assert.ok(!/console\.(log|info|warn|error)/.test(bloque) && !/console\./.test(leer("taller-demo/import-313.js").replace(/Ningún console\.\*|ningún console\.\*/g, "")), "sin logs del respaldo");
  });
  test("P0002: ninguna RPC que usa la cola devuelve P0002 (sync-5/sync-6 → 23503)", () => {
    for (const f of ["sync-5-cotizacion-items.sql", "sync-6-mecanicos-ordenes.sql", "sync-7a-inventario.sql", "sync-3-rpc.sql"]) {
      assert.ok(!/ERRCODE = 'P0002'/.test(leer("taller-demo/supabase/sync/" + f)), f);
    }
  });
  test("SW / index: import-313.js en el SHELL y cargado ANTES de app.js; SIN bump de versión ni de CACHE_NAME", () => {
    assert.match(sw, /"\.\/import-313\.js\?v=3\.13\.0"/);
    assert.match(sw, /const CACHE_NAME = "entimotors-v3\.13\.0";/);
    assert.ok(html.indexOf('src="import-313.js?v=3.13.0"') > 0 && html.indexOf('src="import-313.js') < html.indexOf('src="app.js'));
    assert.match(app, /const VERSION_APP = "3\.13\.0";/);
  });
  test("fixtures: ningún secreto (JWT, service role, contraseñas) ni user-agent real", () => {
    for (const f of ["respaldo-313-realista.json", "respaldo-313-demo.json", "generar-respaldo-313.mjs"]) {
      const t = leer("pruebas/sync/fixtures/" + f);
      assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.|service_role|sb_secret|password|contraseña":|Mozilla\//i.test(t), f);
    }
  });
});
