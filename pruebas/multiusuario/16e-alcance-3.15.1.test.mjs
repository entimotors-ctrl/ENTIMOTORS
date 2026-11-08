// ALCANCE HONESTO · contrato de 3.15.1 (árbol de trabajo). El de 3.15.0 (16d) sigue vigente sobre el tag v3.15.0 (f2a6598), el de 3.14.1
// (16c) sobre e807f65, etc. Guardas de que README, CHANGELOG y panel técnico de 3.15.1 (1) dicen la versión y las cachés REALES del código,
// (2) describen el alcance real —solo frontends, corrección de seguridad de los avisos—, (3) no llevan datos privados y (4) conservan la
// historia de 3.15.0 hacia atrás tal cual se publicó.
// 3.16.0: contrato de 3.15.1 → se ejecuta sobre la instantánea del commit 746744c (helpers/usar-3151.mjs, PRIMER import). Única aserción
// ajustada: ya no corre sobre el árbol de trabajo sino sobre esa instantánea. El de 3.16.0 está en 16f-alcance-3.16.0.
import "./helpers/usar-3151.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { leer, RELEASE_CONGELADA } from "./helpers/entorno.mjs";
import { raiz3150 } from "./helpers/congelado-3.15.0.mjs";

const README = leer("README.md"), CHANGELOG = leer("CHANGELOG.md"), APP = leer("app.js"), SW = leer("sw.js"), PANEL = leer("panel-tecnico.html");
const VERSION = (/const VERSION_APP = "([^"]+)"/.exec(APP) || [])[1];
const CACHE = (/const CACHE_NAME = "([^"]+)"/.exec(SW) || [])[1];
const PRIVADO = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ADMIN_PASSWORD|service_role|JWT|supabase\.co|onrender\.com/i;
const ANTES = (f) => fs.readFileSync(path.join(raiz3150(), "taller-demo", f), "utf8");

describe("README.md · 3.15.1", () => {
  test("se ejecuta sobre la instantánea de 3.15.1 (746744c); versión 3.15.1 en el README, en app.js, en la caché y en el panel técnico", () => {
    assert.equal(RELEASE_CONGELADA, "3.15.1"); assert.equal(VERSION, "3.15.1"); assert.equal(CACHE, "entimotors-v3.15.1");
    assert.match(README, /\*\*Versión actual:\*\* 3\.15\.1 ·/);
    assert.equal((/<span class="version" id="version">([^<]*)<\/span>/.exec(PANEL) || [])[1], "3.15.1");
  });
  test("«Novedades de 3.15.1» va primero y dice lo que entrega: corrección de los avisos, solo frontends, cachés nuevas", () => {
    const i = README.indexOf("## Novedades de 3.15.1"); assert.ok(i > 0); assert.ok(i < README.indexOf("## Novedades de 3.15.0"));
    const sec = README.slice(i, README.indexOf("\n---", i));
    for (const t of ["Corrección de seguridad en los avisos", "CSV", "sincronización", "Tom & Jerry", "Solo cambia el frontend", "`entimotors-v3.15.1`",
      "`entimotors-mitrabajo-v3.15.1`", "La actualización no es automática"]) assert.ok(sec.includes(t), t);
    assert.doesNotMatch(sec, PRIVADO);
  });
  test("la tabla de productos usa las cachés 3.15.1 y la guía de versionado apunta al contrato 01-pwa-3.15.1 y a la instantánea de 3.15.0", () => {
    assert.ok(README.includes("| `entimotors-v3.15.1` |")); assert.ok(README.includes("| `entimotors-mitrabajo-v3.15.1` |"));
    assert.ok(!/\| `entimotors-(mitrabajo-)?v3\.15\.0` \|/.test(README));
    for (const t of ["01-pwa-3.15.1.test.mjs", "01-pwa-3.15.0", "`f2a6598`"]) assert.ok(README.includes(t), t);
  });
  test("las Novedades de 3.15.0 y todo lo anterior a ellas se conservan BYTE A BYTE como se publicaron (tag v3.15.0)", () => {
    const antes = ANTES("README.md"), desde = (t) => t.slice(t.indexOf("## Novedades de 3.15.0"), t.indexOf("## Dos productos, dos orígenes"));
    assert.equal(desde(README), desde(antes));
  });
});

describe("CHANGELOG.md · entrada 3.15.1", () => {
  const i3151 = CHANGELOG.indexOf("## 3.15.1"), i315 = CHANGELOG.indexOf("## 3.15.0"), E = CHANGELOG.slice(i3151, i315);
  test("es la PRIMERA entrada, declara el alcance (solo frontends) y nombra la corrección y sus pruebas", () => {
    assert.equal(CHANGELOG.indexOf("## "), i3151); assert.ok(i315 > i3151);
    for (const t of ["Alcance: solo frontends", "TOAST-XSS", "`toast()`", "`aviso()`", "32-toast-xss-nombres", "`entimotors-v3.15.1`", "`entimotors-mitrabajo-v3.15.1`", "`f2a6598`"]) assert.ok(E.includes(t), t);
    assert.doesNotMatch(E, PRIVADO);
  });
  test("la historia desde 3.15.0 hacia atrás queda BYTE A BYTE igual que en el release 3.15.0 (tag v3.15.0)", () => {
    const antes = ANTES("CHANGELOG.md");
    assert.equal(CHANGELOG.slice(i315), antes.slice(antes.indexOf("## 3.15.0")));
  });
});
