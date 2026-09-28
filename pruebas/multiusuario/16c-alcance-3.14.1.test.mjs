// ALCANCE HONESTO · contrato de 3.14.1 (árbol de trabajo). El de 3.14.0 (16b) sigue vigente sobre el commit effbfa1 y el de 3.13.0
// (16) sobre el tag v3.13.0. Guardas de que README y CHANGELOG de 3.14.1 (1) dicen la versión y las cachés REALES del código,
// (2) describen solo lo que entrega 3.14.1 (Seguridad, accesos rápidos, iconos) sin cambios de base ni de backend, y (3) conservan
// la historia de 3.14.0 hacia atrás tal cual se publicó.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { leer, RUNTIME, RELEASE_CONGELADA } from "./helpers/entorno.mjs";
import { raiz3140 } from "./helpers/congelado-3.14.0.mjs";

const README = leer("README.md"), CHANGELOG = leer("CHANGELOG.md"), APP = leer("app.js"), SW = leer("sw.js");
const VERSION = (/const VERSION_APP = "([^"]+)"/.exec(APP) || [])[1];
const CACHE = (/const CACHE_NAME = "([^"]+)"/.exec(SW) || [])[1];

describe("README.md · 3.14.1", () => {
  test("se ejecuta sobre el árbol de trabajo; versión 3.14.1 en el README, en app.js y en la caché", () => {
    assert.equal(RELEASE_CONGELADA, null); assert.equal(VERSION, "3.14.1"); assert.equal(CACHE, "entimotors-v3.14.1");
    assert.match(README, /\*\*Versión actual:\*\* 3\.14\.1 ·/);
  });
  test("«Novedades de 3.14.1»: Seguridad (solo admin), accesos rápidos, iconos y la caché nueva; sin base ni backend nuevos", () => {
    const i = README.indexOf("## Novedades de 3.14.1"); assert.ok(i > 0); const sec = README.slice(i, README.indexOf("\n---", i));
    for (const t of ["Ajustes → Seguridad", "solo administrador", "modo claro y oscuro", "se cierran las demás sesiones de administrador", "Accesos rápidos",
      "el cajero ya no ve Ajustes ni\n  el Gestor de la web", "Iconos vectoriales", "`entimotors-v3.14.1`", "`entimotors-mitrabajo-v3.14.1`", "misma base de datos y mismo backend"])
      assert.ok(sec.includes(t), t);
    assert.doesNotMatch(sec, /ADMIN_PASSWORD|service_role|JWT|Render|mayúscula|símbolo/);
  });
  test("la tabla de productos usa las cachés 3.14.1 (ninguna fila con la de 3.14.0) y el alcance/limitaciones de 3.14.0 siguen documentados", () => {
    assert.ok(README.includes("| `entimotors-v3.14.1` |")); assert.ok(README.includes("| `entimotors-mitrabajo-v3.14.1` |"));
    assert.ok(!/\| `entimotors-(mitrabajo-)?v3\.14\.0` \|/.test(README));
    for (const t of ["## Alcance de 3.14.0: el taller en la nube", "## Limitaciones conocidas de 3.14.0", "01-pwa-3.14.1.test.mjs", "01-pwa-3.14.0", "effbfa1"]) assert.ok(README.includes(t), t);
  });
  test("enlaces relativos que existen y ninguna URL real de Supabase/Render", () => {
    const enlaces = [...README.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((u) => !/^(https?:|mailto:)/.test(u));
    assert.deepEqual(enlaces.filter((u) => !fs.existsSync(path.join(RUNTIME, u))), []);
    assert.ok(!/https:\/\/[a-z0-9-]+\.(supabase\.co|onrender\.com)/i.test(README.replace("https://<tu-servicio>.onrender.com", "")));
  });
});

describe("CHANGELOG.md · entrada 3.14.1", () => {
  const i3141 = CHANGELOG.indexOf("## 3.14.1"), i3140 = CHANGELOG.indexOf("## 3.14.0"), E = CHANGELOG.slice(i3141, i3140);
  test("es la PRIMERA entrada, candidato sin publicar, y declara que no cambia base ni backend", () => {
    assert.equal(CHANGELOG.indexOf("## "), i3141); assert.ok(i3140 > i3141);
    assert.match(E, /^## 3\.14\.1 — candidato .*sin publicar/); assert.match(E, /Sin cambios de base de datos ni de backend/);
  });
  test("incluye Seguridad, accesos rápidos, iconos y la caché nueva, y NO inventa requisitos de contraseña", () => {
    for (const t of ["Ajustes → Seguridad", "solo administrador", "`type=password`", "`Retry-After`", "legibles en\n  modo claro y oscuro", "accesos rápidos", "Iconos SVG propios",
      "`entimotors-v3.14.1`", "`entimotors-mitrabajo-v3.14.1`"]) assert.ok(E.includes(t), t);
    assert.doesNotMatch(E, /mayúscula|minúscula|símbolo/);
  });
  test("la historia desde 3.14.0 hacia atrás queda BYTE A BYTE igual que en el release 3.14.0 (commit effbfa1)", () => {
    const antes = fs.readFileSync(path.join(raiz3140(), "taller-demo", "CHANGELOG.md"), "utf8");
    assert.equal(CHANGELOG.slice(i3140), antes.slice(antes.indexOf("## 3.14.0")));
  });
});
