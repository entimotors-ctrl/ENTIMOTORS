// 3.15.0 · Bloque 5 · indicadores de EFECTIVO del dispositivo (taller-demo/finanzas-calc.js REAL + fecha-negocio.js, cargados en vm).
// PARIDAD: sobre la base de laboratorio con los datos de 15e-finanzas.test.sql (si está), FinanzasCalc y public.finanzas_resumen()
// tienen que dar las MISMAS cifras en varios rangos: es la misma regla escrita dos veces y así se demuestra.
//   node --test pruebas/sync/node/b5-finanzas-calc.test.mjs          (paridad: B5_PARIDAD_DB=t_15e_x, por defecto)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.resolve(AQUI, "../../../taller-demo");
const FUENTES = ["fecha-negocio.js", "finanzas-calc.js"].map((f) => fs.readFileSync(path.join(DEMO, f), "utf8"));
function cargar() { const ctx = {}; vm.createContext(ctx); FUENTES.forEach((s) => vm.runInContext(s, ctx)); return ctx; }
const { FechaNegocio: F, FinanzasCalc: FC } = cargar();
const Z = (iso) => Date.parse(iso);
let n = 0;
const mov = (tipo, categoria, monto, fechaISO, extra = {}) => ({ id: ++n, uid: "u" + n, tipo, categoria, monto, fechaISO, ...extra });

test("F16..F19 · fronteras del día de Honduras (17:59 · 18:00 · 23:59 · 00:00)", () => {
  const movs = [mov("ingreso", "Otro", 1, "2026-09-01T23:59:00Z"), mov("ingreso", "Otro", 2, "2026-09-02T00:00:00Z"),
                mov("ingreso", "Otro", 4, "2026-09-02T05:59:00Z"), mov("ingreso", "Otro", 8, "2026-09-02T06:00:00Z")];
  assert.equal(FC.caja({ movs, F, ahora: Z("2026-09-01T23:59:00Z") }).cobradoHoy, 7, "F16 17:59");
  const a18 = FC.caja({ movs, F, ahora: Z("2026-09-02T00:00:00Z") });
  assert.equal(a18.hoy, "2026-09-01", "F17 a las 18:00 de Honduras sigue siendo el 1-sep (UTC ya dice 2-sep)");
  assert.equal(a18.cobradoHoy, 7, "F17");
  assert.equal(FC.caja({ movs, F, ahora: Z("2026-09-02T05:59:00Z") }).cobradoHoy, 7, "F18 23:59");
  const a00 = FC.caja({ movs, F, ahora: Z("2026-09-02T06:00:00Z") });
  assert.deepEqual([a00.hoy, a00.cobradoHoy], ["2026-09-02", 8], "F19 00:00");
});

test("F20 · cambio de mes en Honduras (23:59 del 30-sep es septiembre; 00:00 del 1-oct es octubre)", () => {
  const movs = [mov("ingreso", "Otro", 16, "2026-10-01T05:59:00Z"), mov("ingreso", "Otro", 32, "2026-10-01T06:00:00Z")];
  assert.equal(FC.caja({ movs, F, ahora: Z("2026-09-30T18:00:00Z") }).cobradoMes, 16);
  assert.equal(FC.caja({ movs, F, ahora: Z("2026-10-01T06:00:00Z") }).cobradoMes, 32);
  assert.equal(FC.caja({ movs, F, ahora: Z("2026-10-01T05:59:00Z") }).mes, "2026-09");
});

test("fondo de caja, gastos, devoluciones y reversos: cada uno donde corresponde", () => {
  const venta = mov("ingreso", "Venta mostrador", 300, "2026-08-10T16:00:00Z");
  const gasto = mov("egreso", "Planilla", 70, "2026-08-10T17:00:00Z");
  const movs = [venta, gasto,
    mov("ingreso", "Apertura de caja", 1000, "2026-08-10T14:00:00Z"), mov("egreso", "Cierre de caja", 500, "2026-08-10T23:00:00Z"),
    mov("egreso", "Devolución", 50, "2026-08-10T18:00:00Z"),
    mov("egreso", "Reverso de venta", 300, "2026-08-10T19:00:00Z", { reversoDe: venta.uid }),
    mov("ingreso", "Reverso", 70, "2026-08-10T19:30:00Z", { reversoDe: gasto.uid })];
  const c = FC.caja({ movs, F, desde: "2026-08-10", hasta: "2026-08-10", ahora: Z("2026-08-10T20:00:00Z") });
  assert.equal(c.cobradoBruto, 300, "la apertura de caja no es cobro");
  assert.equal(c.devuelto, 350, "devolución 50 + venta revertida 300");
  assert.equal(c.cobrado, -50, "cobrado neto del día");
  assert.equal(c.gastos, 0, "planilla 70 revertida; el cierre de caja no es gasto");
  assert.equal(c.movimientosFondo, 2);
});

test("F22 · por cobrar = saldo vivo (sin anulados); F23 · entregado sin cobrar ≠ cobrado", () => {
  const creditos = [{ id: 1, saldo: 400, anulado: false, ordenId: 30 }, { id: 2, saldo: 0, anulado: false }, { id: 3, saldo: 900, anulado: true }];
  assert.deepEqual({ ...FC.porCobrar(creditos) }, { saldo: 400, creditos: 1 });
  const it = (p) => [{ cantidad: 1, precio: p }];
  const ordenes = [
    { id: 10, estado: "entregado", finalizada: false, items: it(500) },               // cuenta
    { id: 11, estado: "entregado", finalizada: true, items: it(700) },                // cobrada
    { id: 12, estado: "entregado", finalizada: false, anulada: true, items: it(1) },  // anulada
    { id: 13, estado: "calidad", finalizada: false, items: it(2) },                   // todavía no entregada
    { id: 30, estado: "entregado", finalizada: false, items: it(600) },               // ya tiene crédito → es «por cobrar»
  ];
  assert.deepEqual({ ...FC.entregadoSinCobrar(ordenes, creditos) }, { total: 500, ordenes: 1 });
  const r = FC.resumenLocal({ movs: [], creditos, ordenes, F, ahora: Z("2026-08-10T20:00:00Z") });
  assert.equal(r.cobrado, 0, "F23: nada de lo entregado sin cobrar entra como cobrado");
});

test("el resultado no depende de la zona del reloj del dispositivo", () => {
  const codigo = `const fs=require('fs'),vm=require('vm');const ctx={};vm.createContext(ctx);
    for (const f of ['fecha-negocio.js','finanzas-calc.js']) vm.runInContext(fs.readFileSync(${JSON.stringify(DEMO)}+'/'+f,'utf8'),ctx);
    const m=[{uid:'a',tipo:'ingreso',categoria:'Otro',monto:2,fechaISO:'2026-09-02T00:00:00Z'},{uid:'b',tipo:'ingreso',categoria:'Otro',monto:8,fechaISO:'2026-09-02T06:00:00Z'}];
    const c=ctx.FinanzasCalc.caja({movs:m,F:ctx.FechaNegocio,ahora:Date.parse('2026-09-02T01:00:00Z')});process.stdout.write(c.hoy+'|'+c.cobradoHoy+'|'+c.cobradoMes);`;
  for (const TZ of ["UTC", "Asia/Tokyo", "Pacific/Kiritimati", "America/Tegucigalpa"]) {
    const r = spawnSync(process.execPath, ["-e", codigo], { env: { ...process.env, TZ }, encoding: "utf8" });
    assert.equal(r.stdout, "2026-09-01|2|10", `TZ=${TZ}: ${r.stderr}`);
  }
});

// ── PARIDAD con el servidor ─────────────────────────────────────────────────────────────────────────
const DB = process.env.B5_PARIDAD_DB || "t_15e_x";
function sql(q) {
  const r = spawnSync("psql", ["-X", "-q", "-At", "-h", "127.0.0.1", "-p", "54432", "-U", "supabase_admin", "-d", DB, "-c", q],
    { env: { ...process.env, PGPASSWORD: "postgres" }, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
const hayBase = sql("SELECT to_regprocedure('public.finanzas_resumen(date,date,timestamptz)') IS NOT NULL") === "t";
test("PARIDAD · FinanzasCalc = finanzas_resumen() sobre los mismos datos (cobrado, gastos, por cobrar, entregado sin cobrar)", { skip: !hayBase && `sin base de laboratorio ${DB}` }, () => {
  // los datos, con la MISMA forma que les da sync-mappers.js al bajarlos (fechaISO = occurred_at || creado_en; reversoDe = uid)
  const movs = JSON.parse(sql(`SELECT json_agg(json_build_object('uid', id, 'tipo', tipo, 'categoria', coalesce(categoria, ''), 'monto', monto,
      'reversoDe', reverso_de, 'fechaISO', to_char(coalesce(occurred_at, creado_en) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) FROM public.caja_movimientos`));
  const creditos = JSON.parse(sql(`SELECT json_agg(json_build_object('id', id, 'saldo', saldo, 'anulado', anulado, 'ordenId', orden_id)) FROM public.creditos`) || "[]");
  const ordenes = JSON.parse(sql(`SELECT json_agg(json_build_object('id', o.id, 'estado', o.estado, 'finalizada', o.finalizada, 'anulada', o.anulada,
      'items', (SELECT coalesce(json_agg(json_build_object('cantidad', cantidad, 'precio', precio)), '[]') FROM public.orden_items WHERE orden_id = o.id)))
      FROM public.ordenes o WHERE o.deleted_at IS NULL`));
  assert.ok(movs.length > 20, "la base tiene los datos de las pruebas SQL");
  const casos = [["2026-08-10", "2026-08-10", "2026-08-10T20:00:00Z"], ["2026-08-10", "2026-08-14", "2026-08-12T02:00:00Z"],
    ["2030-09-01", "2030-09-30", "2030-09-02T00:00:00Z"], ["2030-09-03", "2030-09-03", "2030-09-03T20:00:00Z"], ["2026-01-01", "2031-12-31", null]];
  let comparados = 0;
  for (const [desde, hasta, ahora] of casos) {
    const s = JSON.parse(sql(`SELECT public.finanzas_resumen('${desde}', '${hasta}', ${ahora ? `'${ahora}'` : "NULL"})`));
    const j = FC.resumenLocal({ movs, creditos, ordenes, desde, hasta, F, ahora: ahora ? Z(ahora) : undefined });
    const par = { cobrado_hoy: j.cobradoHoy, cobrado_mes: j.cobradoMes, cobrado: j.cobrado, cobrado_bruto: j.cobradoBruto, devuelto: j.devuelto,
      gastos: j.gastos, movimientos_fondo: j.movimientosFondo, por_cobrar: j.porCobrar, creditos_con_saldo: j.creditosConSaldo,
      entregado_sin_cobrar: j.entregadoSinCobrar, ordenes_entregadas_sin_cobrar: j.ordenesEntregadasSinCobrar };
    for (const [k, v] of Object.entries(par)) { assert.equal(Number(s[k]), v, `${desde}..${hasta} ${k}: servidor ${s[k]} ≠ dispositivo ${v}`); comparados++; }
    assert.equal(s.hoy, j.hoy, "mismo «hoy»");
  }
  assert.equal(comparados, casos.length * 11);
});
