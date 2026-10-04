// ALCANCE HONESTO · contrato de 3.15.0 (árbol de trabajo). El de 3.14.1 (16c) sigue vigente sobre el commit e807f65, el de 3.14.0 (16b)
// sobre effbfa1 y el de 3.13.0 (16) sobre el tag v3.13.0. Guardas de que README, CHANGELOG y panel técnico de 3.15.0 (1) dicen la versión
// y las cachés REALES del código, (2) describen el estado real del release —la protección de las operaciones rechazadas es TEMPORAL y el
// rescate de los datos del dispositivo está DIFERIDO, no completado—, (3) no llevan textos privados ni identificadores del dispositivo
// y (4) conservan la historia de 3.14.1 hacia atrás tal cual se publicó.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { leer, RUNTIME, RELEASE_CONGELADA } from "./helpers/entorno.mjs";
import { raiz3141 } from "./helpers/congelado-3.14.1.mjs";

const README = leer("README.md"), CHANGELOG = leer("CHANGELOG.md"), APP = leer("app.js"), SW = leer("sw.js"), INDEX = leer("index.html"), PANEL = leer("panel-tecnico.html");
const VERSION = (/const VERSION_APP = "([^"]+)"/.exec(APP) || [])[1];
const CACHE = (/const CACHE_NAME = "([^"]+)"/.exec(SW) || [])[1];
const ETIQUETAS_V = [...INDEX.matchAll(/<script src="[^"?]+\?v=/g)].length;
const SHELL_V = [...((/const SHELL = \[(.*?)\];/s.exec(SW) || [, ""])[1]).matchAll(/"\.\/[^"]*\?v=[^"]*"/g)].length;
const PRIVADO = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|L\s?2[.,]?280|\b2280\b|\b5[.,]?920\b|ADMIN_PASSWORD|service_role|JWT/i;

describe("README.md · 3.15.0", () => {
  test("se ejecuta sobre el árbol de trabajo; versión 3.15.0 en el README, en app.js, en la caché y en el panel técnico", () => {
    assert.equal(RELEASE_CONGELADA, null); assert.equal(VERSION, "3.15.0"); assert.equal(CACHE, "entimotors-v3.15.0");
    assert.match(README, /\*\*Versión actual:\*\* 3\.15\.0 ·/);
    assert.equal((/<span class="version" id="version">([^<]*)<\/span>/.exec(PANEL) || [])[1], "3.15.0");
  });
  test("«Novedades de 3.15.0»: lo que entrega, el orden de publicación y las cachés nuevas", () => {
    const i = README.indexOf("## Novedades de 3.15.0"); assert.ok(i > 0); assert.ok(i < README.indexOf("## Novedades de 3.14.1"), "va antes que la de 3.14.1");
    const sec = README.slice(i, README.indexOf("\n---", i));
    for (const t of ["base de datos (sync-15a → 15g) → backend → frontends", "una sola vez, al aprobar", "Avisos en vivo", "mensajes", "PIN del propietario", "«Eliminar usuario»",
      "Datos de la versión 3.13", "`entimotors-v3.15.0`", "`entimotors-mitrabajo-v3.15.0`", "La actualización no es automática"]) assert.ok(sec.includes(t), t);
  });
  test("la protección de las operaciones rechazadas se presenta como TEMPORAL y el rescate como DIFERIDO, nunca como resuelto", () => {
    const sec = README.slice(README.indexOf("## Novedades de 3.15.0"), README.indexOf("## Novedades de 3.14.1"));
    assert.match(sec, /no se puede quitar\*\* de «⚠ Por revisar»/); assert.match(sec, /\*\*protección temporal\*\*, no la solución definitiva/);
    const estado = README.slice(README.indexOf("## Estado"));
    assert.match(estado, /rescate de datos de un dispositivo: DIFERIDO/); assert.match(estado, /no se ha completado/);
    assert.doesNotMatch(README, /rescate (completado|terminado|resuelto)|PHONE_RESCUE: (PASS|DONE|RESOLVED)/i);
  });
  test("la tabla de productos usa las cachés 3.15.0 (ninguna fila con las de 3.14.x) y la guía de versionado dice las cifras reales del código", () => {
    assert.ok(README.includes("| `entimotors-v3.15.0` |")); assert.ok(README.includes("| `entimotors-mitrabajo-v3.15.0` |"));
    assert.ok(!/\| `entimotors-(mitrabajo-)?v3\.14\.[01]` \|/.test(README));
    assert.deepEqual([ETIQUETAS_V, SHELL_V], [19, 18]);
    assert.ok(README.includes(`las **${ETIQUETAS_V}** etiquetas`)); assert.ok(README.includes(`las **${SHELL_V}** entradas versionadas de \`SHELL\``));
    for (const t of ["01-pwa-3.15.0.test.mjs", "01-pwa-3.14.1", "01-pwa-3.14.0", "e807f65", "effbfa1"]) assert.ok(README.includes(t), t);
  });
  test("se conserva lo de las releases anteriores: Novedades de 3.14.1, alcance y limitaciones de 3.14.0", () => {
    for (const t of ["## Novedades de 3.14.1", "## Alcance de 3.14.0: el taller en la nube", "## Limitaciones conocidas de 3.14.0"]) assert.ok(README.includes(t), t);
  });
  test("enlaces relativos que existen, ninguna URL real de Supabase/Render y ningún dato privado del dispositivo", () => {
    const enlaces = [...README.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((u) => !/^(https?:|mailto:)/.test(u));
    assert.deepEqual(enlaces.filter((u) => !fs.existsSync(path.join(RUNTIME, u))), []);
    assert.ok(!/https:\/\/[a-z0-9-]+\.(supabase\.co|onrender\.com)/i.test(README.replace("https://<tu-servicio>.onrender.com", "")));
    const nuevo = README.slice(README.indexOf("## Novedades de 3.15.0"), README.indexOf("## Novedades de 3.14.1")) + README.slice(README.indexOf("3.15.0 cambia base de datos"));
    assert.doesNotMatch(nuevo, PRIVADO);
  });
});

describe("CHANGELOG.md · entrada 3.15.0", () => {
  const i315 = CHANGELOG.indexOf("## 3.15.0"), i3141 = CHANGELOG.indexOf("## 3.14.1"), E = CHANGELOG.slice(i315, i3141);
  test("es la PRIMERA entrada y declara el orden de publicación: base de datos → backend → frontends", () => {
    assert.equal(CHANGELOG.indexOf("## "), i315); assert.ok(i3141 > i315);
    assert.match(E, /^## 3\.15\.0 — release/); assert.match(E, /sync-15a → 15b → 15c → 15d → 15e → 15f → 15g\) → backend → frontends/);
  });
  test("incluye lo que entrega 3.15.0 y las cachés nuevas", () => {
    for (const t of ["`convertir_cotizacion`", "una sola vez, al aprobar", "PIN del propietario", "Eliminar usuario", "`finanzas_invariantes`", "sync-15g", "`agregar_item_orden`", "`registrar_credito`",
      "`entimotors-v3.15.0`", "`entimotors-mitrabajo-v3.15.0`", "`hacer-build-taller.sh`"]) assert.ok(E.includes(t), t);
  });
  test("estado real: protección TEMPORAL y PHONE_RESCUE: DEFERRED; no afirma que el rescate esté hecho; sin datos privados", () => {
    assert.match(E, /\*\*Protección temporal:\*\*/); assert.match(E, /No es la resolución definitiva/);
    assert.match(E, /\*\*PHONE_RESCUE: DEFERRED\.\*\*/); assert.match(E, /no se ha completado al publicar 3\.15\.0/);
    assert.doesNotMatch(E, /PHONE_RESCUE: (PASS|DONE|RESOLVED)|rescate (completado|terminado|resuelto)/i);
    assert.doesNotMatch(E, PRIVADO);
  });
  test("la historia desde 3.14.1 hacia atrás queda BYTE A BYTE igual que en el release 3.14.1 (commit e807f65)", () => {
    const antes = fs.readFileSync(path.join(raiz3141(), "taller-demo", "CHANGELOG.md"), "utf8");
    assert.equal(CHANGELOG.slice(i3141), antes.slice(antes.indexOf("## 3.14.1")));
  });
});
