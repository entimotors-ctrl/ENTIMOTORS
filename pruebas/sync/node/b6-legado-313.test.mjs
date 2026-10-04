// 3.15.0 · Bloque 6 · LEGADO 3.13: el importador (taller-demo/import-313.js REAL) acepta EXCLUSIVAMENTE el formato legado v6 y rechaza
// todo lo demás; el kit de respaldo (operacion/respaldo/lib/respaldo.mjs) clasifica IGUAL; los registros 3.13 de un dispositivo que no
// están en la nube se identifican uno a uno (caso registro 119) y siguen siendo recuperables. Reemplaza a b5-formatos-respaldo.
//   node --test pruebas/sync/node/b6-legado-313.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clasificarArchivo as clasificarKit } from "../../../operacion/respaldo/lib/respaldo.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ctx = vm.createContext({ console, Promise, JSON, Math, Date, TextEncoder, crypto: globalThis.crypto });
vm.runInContext(fs.readFileSync(path.join(RAIZ, "taller-demo/import-313.js"), "utf8"), ctx, { filename: "import-313.js" });
const I = ctx.Import313;
const J = (x) => JSON.parse(JSON.stringify(x));
const vacio = () => ({ clientes: [], motos: [], ordenes: [], inventario: [], citas: [], cotizaciones: [], ventas_rapidas: [], caja_movimientos: [], creditos: [], web_cms: [], categorias_inv: [], auditoria: [] });
const conTotales = (r) => { r.conteos = Object.fromEntries(Object.entries(r.data).map(([k, v]) => [k, v.length])); r.totalRegistros = Object.values(r.conteos).reduce((a, b) => a + b, 0); return r; };
const d313 = (extra = {}) => conTotales({ version: 2, versionApp: "3.13.0", esquemaDB: 6, idRespaldo: "ENTI-X", exportadoEn: "2026-09-25T22:00:00Z", data: { ...vacio(), clientes: [{ id: 1, nombre: "Cliente", telefono: "1" }] }, ...extra });
const ambas = (r) => [I.clasificarArchivo(r), clasificarKit(r)];
const valida = (r) => J(I.validar(r));

test("L01 · el importador acepta un respaldo 3.13 válido (y la copia local 3.13 que arma la 3.14.1, y un 3.14.0 leyendo la base v6)", () => {
  assert.deepEqual(ambas(d313()), ["legado-v6", "legado-v6"]);
  assert.equal(valida(d313()).ok, true);
  const local314 = d313({ generadoPor: "3.14.1", idRespaldo: "ENTI-2026-09-29-LOCAL313" });   // armarRespaldoLocal313()
  assert.equal(valida(local314).ok, true);
  const exportado3140 = d313({ versionApp: "3.14.0" });   // como el respaldo real JEIEKQ del teléfono
  assert.deepEqual(ambas(exportado3140), ["legado-v6", "legado-v6"]);
  const v = valida(exportado3140); assert.equal(v.ok, true); assert.ok(v.avisos.some((a) => /3\.14\.0/.test(a)), "avisa de qué versión lo exportó, sin rechazarlo");
});

const JEIEKQ = "/home/wilkin/Escritorio/Sistema-emos/ENTIMOTORS-respaldo-telefono-ENTI-2026-09-25-JEIEKQ/entimotors-backup-2026-09-25-JEIEKQ.json";
test("L01 · el respaldo REAL JEIEKQ del teléfono (registro 119) sigue siendo aceptado por el importador endurecido", { skip: !fs.existsSync(JEIEKQ) && "el archivo real solo existe en la máquina de trabajo" }, () => {
  const r = JSON.parse(fs.readFileSync(JEIEKQ, "utf8"));
  assert.deepEqual(ambas(r), ["legado-v6", "legado-v6"]);
  const v = valida(r);
  assert.ok(!v.errores.some((e) => /no es un respaldo|CACHÉ|EMPRESA|alterado|incompleto/i.test(e)), "ningún rechazo de formato: " + JSON.stringify(v.errores.slice(0, 3)));
});

test("L02 / L23 · un respaldo de EMPRESA 3.15 (y su manifiesto real) no entra al importador 3.13", () => {
  const man = { formato: "entimotors-respaldo-negocio", version_formato: 1, entimotors_version: "3.14.1", data: vacio() };
  assert.deepEqual(ambas(man), ["negocio-3.15", "negocio-3.15"]);
  assert.match(valida(man).errores[0], /respaldo de EMPRESA/);
  const real = path.join("/home/wilkin/Escritorio/Sistema-emos/ENTIMOTORS-3.15-bloque5/respaldos/lab-20260930T020652Z/manifiesto.json");
  if (fs.existsSync(real)) { const m = JSON.parse(fs.readFileSync(real, "utf8")); assert.equal(I.clasificarArchivo(m), "negocio-3.15"); assert.equal(valida(m).ok, false); }
});

test("L03 · la caché de la nube 3.14/3.15 no entra (uid, _rev, _base, _pend o marca «cache-nube»)", () => {
  for (const campo of ["uid", "_rev", "_base", "_pend"]) {
    const r = d313({ versionApp: "3.14.1" }); r.data.clientes[0][campo] = campo === "uid" ? "3f0e9c1e-0000-4000-8000-000000000001" : 1;
    assert.deepEqual(ambas(r), ["cache-nube", "cache-nube"], campo);
    assert.match(valida(r).errores[0], /CACHÉ DE LA NUBE/, campo);
  }
  const marcada = { ...d313({ versionApp: "3.14.1" }), formato: "entimotors-copia-dispositivo", alcance: "cache-nube" };
  assert.deepEqual(ambas(marcada), ["cache-nube", "cache-nube"]);
  const copiaLocal = { ...d313({ versionApp: "3.14.1" }), formato: "entimotors-copia-dispositivo", alcance: "datos-locales" };
  assert.deepEqual(ambas(copiaLocal), ["legado-v6", "legado-v6"], "la copia 3.15 en modo LOCAL es la misma base v6");
});

test("L04 · archivo corrupto, alterado, incompleto o desconocido → rechazado (nada se sube)", () => {
  assert.equal(J(I.leerTexto("{ esto no es json")).ok, false);
  assert.equal(J(I.leerTexto(JSON.stringify(d313()).slice(0, 80))).ok, false, "JSON truncado");
  assert.equal(J(I.leerTexto("")).ok, false);
  const alterado = d313(); alterado.totalRegistros += 1; assert.match(valida(alterado).errores.join(" "), /alterado o incompleto/);
  const conteo = d313(); conteo.conteos.clientes = 5; assert.match(valida(conteo).errores.join(" "), /incompleto/);
  const faltaTabla = d313(); delete faltaTabla.data.ordenes; delete faltaTabla.conteos.ordenes; faltaTabla.totalRegistros = 1;
  assert.match(valida(faltaTabla).errores.join(" "), /falta la tabla «ordenes»/);
  for (const [nombre, r] of [["esquema 5", d313({ esquemaDB: 5 })], ["formato 1", d313({ version: 1 })], ["otra tabla", (() => { const x = d313(); x.data.pagos = []; return x; })()],
    ["otra marca", { ...d313(), formato: "otra-cosa" }], ["objeto cualquiera", { hola: 1 }], ["lista", []]]) {
    assert.equal(valida(r).ok, false, nombre); assert.equal(I.clasificarArchivo(r), "desconocido", nombre); assert.equal(clasificarKit(r), "desconocido", nombre);
  }
});

/* ── L06 · REGISTRO 119: 118 registros conocidos (ya en la nube) + 1 adicional ─────────────────────────────────────── */
function fixture119() {
  const d = vacio();
  for (let i = 1; i <= 26; i++) d.clientes.push({ id: i, nombre: "Cliente " + i, telefono: "9" + String(i).padStart(3, "0") });
  for (let i = 1; i <= 8; i++) d.motos.push({ id: i, clienteId: i, marca: "M", modelo: "X", placa: "P-" + i });
  for (let i = 1; i <= 10; i++) d.ordenes.push({ id: i, clienteId: i, motoId: ((i - 1) % 8) + 1, estado: "entregado", items: [{ nombre: "MO", cantidad: 1, precio: 100 }], creadoEn: 1 });
  for (let i = 1; i <= 6; i++) d.inventario.push({ id: i, nombre: "Rep " + i, cantidad: 5, precio: 10, precioVenta: 10, costoCompra: 5 });
  for (let i = 1; i <= 3; i++) d.citas.push({ id: i, clienteId: i, fecha: "2026-09-2" + i, hora: "10:00", motivo: "m" });
  d.cotizaciones.push({ id: 1, clienteId: 1, items: [], fechaISO: "2026-09-20T10:00:00Z", validezDias: 7, estado: "pendiente" });
  for (let i = 1; i <= 5; i++) d.ventas_rapidas.push({ id: i, items: [{ nombre: "x", cantidad: 1, precio: 10 }], total: 10, metodoPago: "efectivo", fechaISO: "2026-09-20T10:00:00Z" });
  for (let i = 1; i <= 30; i++) d.caja_movimientos.push({ id: i, tipo: "ingreso", categoria: "Otro", monto: 10, fechaISO: "2026-09-20T10:00:00Z" });
  for (let i = 1; i <= 24; i++) d.creditos.push({ id: i, clienteNombre: "C", items: [{ nombre: "x", cantidad: 1, precio: 100 }], total: 100, abonado: 0, saldo: 100, estado: "pendiente", historialAbonos: [], fechaISO: "2026-09-20T10:00:00Z" });
  for (let i = 1; i <= 5; i++) d.categorias_inv.push({ id: i, nombre: "Cat " + i });
  return conTotales({ version: 2, versionApp: "3.13.0", esquemaDB: 6, idRespaldo: "ENTI-FIX-118", exportadoEn: "2026-09-25T22:00:00Z", data: d });
}
test("L06 · fixture 118 + 1: se detecta la base, se identifica EXACTAMENTE el registro adicional, se compara y sigue siendo recuperable", async () => {
  const base = fixture119();
  const ids118 = J(await I.identidadesNube(base));
  assert.equal(ids118.lista.length, 118, "118 registros operativos conocidos");
  // la nube tiene esos 118 (con el mismo uuid determinista con que el importador los habría subido)
  const nube = {}; for (const x of ids118.lista) (nube[I.TABLA_NUBE[x.store]] = nube[I.TABLA_NUBE[x.store]] || new Set()).add(x.uuid);
  const consultar = async (porTabla) => ({ ok: true, datos: Object.fromEntries(Object.entries(porTabla).map(([t, us]) => [t, us.filter((u) => nube[t]?.has(u))])) });
  // el teléfono tiene uno más: un abono/movimiento de caja nuevo después del respaldo
  const telefono = fixture119(); telefono.data.caja_movimientos.push({ id: 31, tipo: "ingreso", categoria: "Cobro de crédito", monto: 75, fechaISO: "2026-09-26T15:00:00Z" });
  conTotales(telefono);
  assert.deepEqual(ambas(telefono), ["legado-v6", "legado-v6"], "la base 3.13 del teléfono se sigue reconociendo");
  const p = J(await I.pendientesEnNube(telefono, consultar));
  assert.equal(p.total, 119); assert.equal(p.enNube, 118);
  assert.equal(p.faltan.length, 1, "exactamente UN pendiente");
  assert.equal(p.faltan[0].store, "caja_movimientos"); assert.equal(p.faltan[0].id, 31);
  assert.equal(p.faltan[0].uuid, await I.uuidDe("caja_movimientos", 31));
  // comparar: el registro adicional se puede leer tal cual del archivo/teléfono (nada se modificó)
  const extra = telefono.data.caja_movimientos.find((x) => x.id === p.faltan[0].id);
  assert.equal(extra.monto, 75);
  // recuperable: un paquete SOLO con ese registro se valida y lo sube con su uuid determinista (sin chocar con los 118)
  const solo = conTotales({ ...telefono, data: { ...vacio(), caja_movimientos: [extra] } });
  assert.equal(valida(solo).ok, true, JSON.stringify(valida(solo).errores));
  const { paquete } = J(await I.construirPaquete(solo));
  assert.equal(paquete.caja_movimientos.length, 1); assert.equal(paquete.caja_movimientos[0].id, p.faltan[0].uuid);
  assert.ok(!nube.caja_movimientos.has(paquete.caja_movimientos[0].id), "no choca con lo que ya está en la nube");
  // informativo: nada del fixture se toma como «ejemplo»; con un cliente de la siembra, se marca pero NO se descarta
  const conEjemplo = fixture119(); conEjemplo.data.clientes.push({ id: 99, nombre: "Carlos Reyes", telefono: "9704-1122" }); conTotales(conEjemplo);
  const pe = J(await I.pendientesEnNube(conEjemplo, consultar));
  assert.equal(pe.faltan.length, 1); assert.equal(pe.faltan[0].posibleEjemplo, true, "se informa, y sigue en la lista de pendientes");
});

test("L05 (lógica) · sin nada pendiente en este dispositivo, pendientesEnNube dice 0 (el aviso no se muestra)", async () => {
  const base = fixture119();
  const todos = new Set((J(await I.identidadesNube(base))).lista.map((x) => x.uuid));
  const p = J(await I.pendientesEnNube(base, async (pt) => ({ ok: true, datos: Object.fromEntries(Object.entries(pt).map(([t, us]) => [t, us.filter((u) => todos.has(u))])) })));
  assert.equal(p.faltan.length, 0);
  const sinRed = J(await I.pendientesEnNube(base, async () => ({ ok: false, clase: "red", mensaje: "sin conexión" })));
  assert.equal(sinRed.ok, false, "sin respuesta del servidor NO se da por migrado");
});

test("L22 · la infraestructura para leer/recuperar la 3.13 se conserva (base, versión, respaldo local, importador, diagnóstico)", () => {
  const app = fs.readFileSync(path.join(RAIZ, "taller-demo/app.js"), "utf8");
  assert.match(app, /const BASE_TALLER = "entimotors_os_demo";/);
  assert.match(app, /indexedDB\.open\(nombre, 6\)/);
  assert.match(app, /async function armarRespaldoLocal313\(\)/); assert.match(app, /versionApp: "3\.13\.0",\s+\/\/ los datos son los de la base v6/);
  assert.match(app, /async function contarDatosLocales313\(\)/);
  for (const f of ["validar", "preparar", "importar", "construirPaquete", "uuidDe", "pendientesEnNube"]) assert.equal(typeof I[f], "function", f);
  assert.ok(!/deleteDatabase\(\s*BASE_TALLER|deleteDatabase\(\s*"entimotors_os_demo"/.test(app), "nada borra entimotors_os_demo");
  assert.ok(fs.existsSync(path.join(RAIZ, "taller-demo/supabase/sync/sync-10-importacion.sql")), "la importación del servidor sigue");
});

test("L23 · el restaurador/kit 3.15 nunca manda nada al importador 3.13 (no lo importa ni lo llama)", () => {
  const kit = ["respaldo.mjs", "lib/respaldo.mjs", "respaldar.sh", "restaurar-aislado.sh", "puerta-pre-release.sh"].map((f) => fs.readFileSync(path.join(RAIZ, "operacion/respaldo", f), "utf8")).join("\n");
  // referencias EJECUTABLES (un comentario que cita la regla compartida no cuenta)
  assert.doesNotMatch(kit, /from\s+["'][^"']*import-313|require\([^)]*import-313|Import313\.|["']import_(aplicar|iniciar|confirmar)/);
});
