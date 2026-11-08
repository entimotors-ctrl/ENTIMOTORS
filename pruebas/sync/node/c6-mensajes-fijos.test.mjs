// 3.16 · cambio 6 · los mensajes del administrador quedan FIJOS arriba en Mi Trabajo 36 horas (taller-demo/mensajes-fijos.js REAL, en vm).
//   node --test pruebas/sync/node/c6-mensajes-fijos.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../taller-demo");
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(DEMO, "mensajes-fijos.js"), "utf8"), ctx);
const MF = ctx.MensajesFijos;

const H = 3600 * 1000, AHORA = Date.parse("2026-11-08T18:00:00Z");
const m = (id, horas, leido) => ({ id, creadoEn: horas == null ? null : AHORA - horas * H, leido });
const noLeido = (x) => !x.leido;
const ids = (l) => Array.from(l, (x) => x.id);   // Array.from: las listas creadas dentro de vm son de otro contexto

test("36 horas es el plazo", () => { assert.equal(MF.HORAS_FIJO, 36); });

test("fijos: los de las últimas 36 h (leídos o no) y los no leídos de cualquier edad; el resto al historial", () => {
  const msgs = [m("37h-leido", 37, true), m("1h", 1, true), m("72h-sin-leer", 72, false), m("sin-fecha", null, true), m("35h", 35, true)];
  const r = MF.separar(msgs, AHORA, noLeido);
  assert.deepEqual(ids(r.fijos), ["1h", "35h", "72h-sin-leer"]);
  assert.deepEqual(ids(r.historial), ["37h-leido", "sin-fecha"]);
});

test("justo en el borde de 36 h sigue fijo; un minuto después ya no", () => {
  const r = MF.separar([m("borde", 36, true), m("pasado", 36 + 1 / 60, true)], AHORA, noLeido);
  assert.deepEqual(ids(r.fijos), ["borde"]);
  assert.deepEqual(ids(r.historial), ["pasado"]);
});

test("no modifica la lista que recibe", () => {
  const msgs = [m("a", 40, true), m("b", 1, true)];
  MF.separar(msgs, AHORA, noLeido);
  assert.deepEqual(ids(msgs), ["a", "b"]);
});
