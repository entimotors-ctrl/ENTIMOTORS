// 3.16 · cambio 1 · fotos del avance por WhatsApp sin repetir las ya enviadas (taller-demo/fotos-avance.js REAL, en vm).
//   node --test pruebas/sync/node/c1-fotos-avance.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../taller-demo");
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(DEMO, "fotos-avance.js"), "utf8"), ctx);
const FA = ctx.FotosAvance;
const lista = (l) => Array.from(l);   // las listas creadas dentro de vm son de otro contexto

const fotoA = "data:image/jpeg;base64," + "A".repeat(5000) + "x";
const fotoB = "data:image/jpeg;base64," + "A".repeat(5000) + "y";   // mismo largo, distinta al final

test("la misma foto en base64 da siempre la misma clave, corta", () => {
  assert.equal(FA.claveFoto(fotoA), FA.claveFoto(fotoA));
  assert.match(FA.claveFoto(fotoA), /^d:\d+:[0-9a-f]{8}$/);
});

test("dos fotos distintas del mismo largo dan claves distintas", () => {
  assert.notEqual(FA.claveFoto(fotoA), FA.claveFoto(fotoB));
});

test("una ruta de Storage es su propia clave", () => {
  assert.equal(FA.claveFoto("ordenes/u1/f.jpg"), "ordenes/u1/f.jpg");
});

test("pendientes: las que no se han enviado, en el mismo orden", () => {
  assert.deepEqual(lista(FA.pendientes([fotoA, "ordenes/u1/f.jpg", fotoB], [FA.claveFoto(fotoA)])), ["ordenes/u1/f.jpg", fotoB]);
  assert.deepEqual(lista(FA.pendientes([fotoA], [])), [fotoA]);
  assert.deepEqual(lista(FA.pendientes([], ["x"])), []);
});

test("marcar: une las claves sin duplicar", () => {
  const una = FA.marcar([], [fotoA]);
  assert.deepEqual(lista(FA.marcar(una, [fotoA, fotoB])), [FA.claveFoto(fotoA), FA.claveFoto(fotoB)]);
});
