// ALCANCE HONESTO · contrato de 3.16.0 (árbol de trabajo). El de 3.15.1 (16e) sigue vigente sobre la instantánea 746744c, el de 3.15.0 (16d)
// sobre el tag v3.15.0 (f2a6598), etc. Guardas de que README, CHANGELOG y panel técnico de 3.16.0 (1) dicen la versión y las cachés REALES
// del código, (2) describen el alcance real —solo frontends, cambios del cliente, 3.15.1 incluida—, (3) no llevan datos privados y (4)
// conservan la historia de 3.15.1 hacia atrás tal cual quedó terminada.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { leer, RELEASE_CONGELADA } from "./helpers/entorno.mjs";
import { raiz3151 } from "./helpers/congelado-3.15.1.mjs";

const README = leer("README.md"), CHANGELOG = leer("CHANGELOG.md"), APP = leer("app.js"), SW = leer("sw.js"), PANEL = leer("panel-tecnico.html");
const VERSION = (/const VERSION_APP = "([^"]+)"/.exec(APP) || [])[1];
const CACHE = (/const CACHE_NAME = "([^"]+)"/.exec(SW) || [])[1];
const PRIVADO = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ADMIN_PASSWORD|service_role|JWT|supabase\.co|onrender\.com/i;
const ANTES = (f) => fs.readFileSync(path.join(raiz3151(), "taller-demo", f), "utf8");

describe("README.md · 3.16.0", () => {
  test("se ejecuta sobre el árbol de trabajo; versión 3.16.0 en el README, en app.js, en la caché y en el panel técnico", () => {
    assert.equal(RELEASE_CONGELADA, null); assert.equal(VERSION, "3.16.0"); assert.equal(CACHE, "entimotors-v3.16.0");
    assert.match(README, /\*\*Versión actual:\*\* 3\.16\.0 ·/);
    assert.equal((/<span class="version" id="version">([^<]*)<\/span>/.exec(PANEL) || [])[1], "3.16.0");
  });
  test("«Novedades de 3.16.0» va primero y dice lo que entrega: los cambios del cliente, 3.15.1 incluida, solo frontends, cachés nuevas", () => {
    const i = README.indexOf("## Novedades de 3.16.0"); assert.ok(i > 0); assert.ok(i < README.indexOf("## Novedades de 3.15.1"));
    const sec = README.slice(i, README.indexOf("\n---", i));
    for (const t of ["3.15.1 no se publicó por separado", "WhatsApp", "fotos", "cotización", "44 px", "36 horas", "Ver eliminados", "＋ Entrada",
      "Solo cambia el frontend", "`entimotors-v3.16.0`", "`entimotors-mitrabajo-v3.16.0`", "La actualización no es automática"]) assert.ok(sec.includes(t), t);
    assert.doesNotMatch(sec, PRIVADO);
  });
  test("la tabla de productos usa las cachés 3.16.0 y la guía de versionado apunta al contrato 01-pwa-3.16.0 y a la instantánea de 3.15.1", () => {
    assert.ok(README.includes("| `entimotors-v3.16.0` |")); assert.ok(README.includes("| `entimotors-mitrabajo-v3.16.0` |"));
    assert.ok(!/\| `entimotors-(mitrabajo-)?v3\.15\.[01]` \|/.test(README));
    for (const t of ["01-pwa-3.16.0.test.mjs", "01-pwa-3.15.1", "`746744c`", "`f2a6598`"]) assert.ok(README.includes(t), t);
  });
  test("las Novedades de 3.15.1 y todo lo anterior a ellas se conservan BYTE A BYTE como quedaron en la 3.15.1 terminada (746744c)", () => {
    const antes = ANTES("README.md"), desde = (t) => t.slice(t.indexOf("## Novedades de 3.15.1"), t.indexOf("## Dos productos, dos orígenes"));
    assert.equal(desde(README), desde(antes));
  });
});

describe("CHANGELOG.md · entrada 3.16.0", () => {
  const i316 = CHANGELOG.indexOf("## 3.16.0"), i3151 = CHANGELOG.indexOf("## 3.15.1"), E = CHANGELOG.slice(i316, i3151);
  test("es la PRIMERA entrada, ya no dice «SIN PUBLICAR», declara el alcance y nombra los cambios y sus pruebas", () => {
    assert.equal(CHANGELOG.indexOf("## "), i316); assert.ok(i3151 > i316);
    assert.doesNotMatch(E, /SIN PUBLICAR/);
    for (const t of ["Alcance: solo frontends", "Incluye 3.15.1 completa", "`746744c`", "cambio 1", "cambio 2", "cambio 3", "cambio 6", "cambio 7", "cambio 8",
      "01-pwa-3.16.0", "16f-alcance-3.16.0", "26e-manifest-3.16.0", "`entimotors-v3.16.0`", "`entimotors-mitrabajo-v3.16.0`"]) assert.ok(E.includes(t), t);
    assert.doesNotMatch(E, PRIVADO);
  });
  test("la historia desde 3.15.1 hacia atrás queda BYTE A BYTE igual que en la 3.15.1 terminada (746744c)", () => {
    const antes = ANTES("CHANGELOG.md");
    assert.equal(CHANGELOG.slice(i3151), antes.slice(antes.indexOf("## 3.15.1")));
  });
});
