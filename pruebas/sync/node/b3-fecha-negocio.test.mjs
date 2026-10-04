// 3.15.0 · Bloque 3 · día empresarial America/Tegucigalpa (taller-demo/fecha-negocio.js REAL, cargado en vm).
// Cada caso corre además en procesos hijos con OTRA zona en el reloj del «dispositivo» (TZ=UTC, Asia/Tokyo, Pacific/Kiritimati,
// America/Tegucigalpa): el resultado debe ser el mismo — el día del negocio no depende del teléfono.
//   node --test pruebas/sync/node/b3-fecha-negocio.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = path.resolve(AQUI, "../../../taller-demo/fecha-negocio.js");
const FUENTE = fs.readFileSync(ARCHIVO, "utf8");
function cargar(extra = {}) { const ctx = { ...extra }; vm.createContext(ctx); vm.runInContext(FUENTE, ctx); return ctx.FechaNegocio; }
const F = cargar();
const Z = (iso) => Date.parse(iso);

test("S · 17:59 hora local = mismo día (en UTC ya son las 23:59)", () => {
  assert.equal(F.diaDe(Z("2026-09-29T23:59:00Z")), "2026-09-29");
  assert.equal(F.hoy(Z("2026-09-29T23:59:00Z")), "2026-09-29");
});
test("T · 18:00 hora local SIGUE siendo hoy (el error: UTC ya decía mañana)", () => {
  const t = Z("2026-09-30T00:00:00Z");
  assert.equal(new Date(t).toISOString().slice(0, 10), "2026-09-30", "así fallaba la 3.14.1");
  assert.equal(F.hoy(t), "2026-09-29");
});
test("U · 23:59 → 00:00 → 00:01 hora local cambian de día exactamente a medianoche de Honduras", () => {
  assert.equal(F.diaDe(Z("2026-09-30T05:59:59.999Z")), "2026-09-29");   // 23:59:59.999
  assert.equal(F.diaDe(Z("2026-09-30T06:00:00Z")), "2026-09-30");       // 00:00
  assert.equal(F.diaDe(Z("2026-09-30T06:01:00Z")), "2026-09-30");       // 00:01
});
test("medianoche UTC (18:00 local) y mediodía UTC (06:00 local) en el borde", () => {
  assert.equal(F.diaDe("2026-10-01T00:00:00.000Z"), "2026-09-30");
  assert.equal(F.diaDe("2026-10-01T12:00:00Z"), "2026-10-01");
  assert.equal(F.diaDe("2026-10-01T05:59:59Z"), "2026-09-30");
});
test("límites de día en ms (inicio 00:00 = 06:00Z; fin 23:59:59.999)", () => {
  assert.equal(F.inicioDia("2026-09-30"), Z("2026-09-30T06:00:00Z"));
  assert.equal(F.finDia("2026-09-30"), Z("2026-10-01T05:59:59.999Z"));
  assert.equal(F.desfaseMin(Z("2026-09-30T06:00:00Z")), -360);
});
test("mes y año empresariales en su borde", () => {
  assert.equal(F.mesDe(Z("2026-10-01T05:00:00Z")), "2026-09", "30-sep 23:00 local sigue en septiembre");
  assert.equal(F.mesDe(Z("2026-10-01T06:00:00Z")), "2026-10");
  assert.equal(F.diaDe(Z("2027-01-01T03:00:00Z")), "2026-12-31");
  assert.equal(F.mismoMes(Z("2026-10-01T05:00:00Z"), Z("2026-09-15T12:00:00Z")), true);
  assert.equal(F.inicioMes(Z("2026-10-01T05:00:00Z")), "2026-09-01");
});
test("aritmética de calendario sin zonas (fin de mes, año bisiesto, cambio de año)", () => {
  assert.equal(F.sumarDias("2028-02-28", 1), "2028-02-29");
  assert.equal(F.sumarDias("2026-12-31", 1), "2027-01-01");
  assert.equal(F.sumarDias("2026-09-29", -6), "2026-09-23");
  assert.equal(F.diferenciaDias("2026-09-29", "2026-09-30"), 1);
  assert.equal(F.diferenciaDias("2026-09-29", "2026-09-29"), 0);
  assert.equal(F.diferenciaDias("2026-09-30", "2026-09-29"), -1);
});
test("hora local de una cita → instante absoluto", () => {
  assert.equal(F.instante("2026-09-29", "14:30"), Z("2026-09-29T20:30:00Z"));
  assert.equal(F.instante("2026-09-29", "18:00"), Z("2026-09-30T00:00:00Z"));
});
test("rango inclusivo por día empresarial", () => {
  assert.equal(F.enRango(Z("2026-09-30T00:30:00Z"), "2026-09-29", "2026-09-29"), true, "18:30 del 29 cuenta en el 29");
  assert.equal(F.enRango(Z("2026-09-30T06:00:00Z"), "2026-09-29", "2026-09-29"), false);
});
test("textos: un instante se muestra con la fecha de Honduras; una fecha de calendario no se corre", () => {
  assert.match(F.fecha(Z("2026-09-30T00:30:00Z")), /29/);
  assert.match(F.hora(Z("2026-09-30T00:30:00Z")), /18:30|6:30/);
  assert.match(F.dia("2026-09-29"), /29/);
  assert.equal(F.fecha(null), "");
});
test("sin soporte de zonas IANA (plataforma vieja): respaldo −06:00, mismo resultado", () => {
  class DTF { constructor(l, o) { if (o && o.timeZone) throw new RangeError("sin zonas"); } formatToParts() { return []; } }
  const G = cargar({ Intl: { DateTimeFormat: DTF } });
  assert.equal(G.zonaSoportada, false);
  assert.equal(G.hoy(Z("2026-09-30T00:00:00Z")), "2026-09-29");
  assert.equal(G.inicioDia("2026-09-30"), Z("2026-09-30T06:00:00Z"));
});
test("el reloj del dispositivo en OTRA zona no cambia el día del negocio", () => {
  const prog = `const vm=require("vm"),fs=require("fs");const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(${JSON.stringify(ARCHIVO)},"utf8"),c);const F=c.FechaNegocio;
    const Z=(s)=>Date.parse(s);process.stdout.write(JSON.stringify([F.diaDe(Z("2026-09-29T23:59:00Z")),F.diaDe(Z("2026-09-30T00:00:00Z")),F.diaDe(Z("2026-09-30T05:59:00Z")),
    F.diaDe(Z("2026-09-30T06:00:00Z")),F.diaDe(Z("2026-09-30T06:01:00Z")),F.inicioDia("2026-09-30"),F.instante("2026-09-29","14:30"),F.dia("2026-09-29",{day:"numeric"})]));`;
  const esperado = JSON.stringify(["2026-09-29", "2026-09-29", "2026-09-29", "2026-09-30", "2026-09-30", Z("2026-09-30T06:00:00Z"), Z("2026-09-29T20:30:00Z"), "29"]);
  for (const tz of ["UTC", "Asia/Tokyo", "Pacific/Kiritimati", "America/Tegucigalpa", "America/New_York"]) {
    const r = spawnSync(process.execPath, ["-e", prog], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, esperado, `con TZ=${tz}`);
  }
});
