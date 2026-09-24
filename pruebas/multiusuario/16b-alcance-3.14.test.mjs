// ALCANCE HONESTO · contrato de 3.14.0 (árbol de trabajo). El de 3.13.0 (16-alcance-honesto) sigue vigente sobre el tag v3.13.0.
// Guardas de que el README y el CHANGELOG de 3.14.0 (1) dicen la versión y las cifras REALES del código, (2) declaran las
// limitaciones conocidas de la migración y (3) no arrastran afirmaciones de 3.13.0 que en 3.14.0 serían falsas.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { leer, RUNTIME, ES_313 } from "./helpers/entorno.mjs";
import { RAIZ_313 } from "./helpers/congelado.mjs";

const README = leer("README.md"), CHANGELOG = leer("CHANGELOG.md"), APP = leer("app.js"), INDEX = leer("index.html"), SW = leer("sw.js");
const VERSION = (/const VERSION_APP = "([^"]+)"/.exec(APP) || [])[1];
const ETIQUETAS_V = [...INDEX.matchAll(/<script src="[^"?]+\?v=/g)].length;
const SHELL_V = [...((/const SHELL = \[(.*?)\];/s.exec(SW) || [, ""])[1]).matchAll(/"\.\/[^"]*\?v=[^"]*"/g)].length;

describe("README.md · 3.14.0", () => {
  test("se ejecuta sobre el árbol de trabajo; versión 3.14.0 en el README y en el código", () => {
    assert.equal(ES_313, false); assert.equal(VERSION, "3.14.0"); assert.match(README, /\*\*Versión actual:\*\* 3\.14\.0/);
  });
  test("no arrastra afirmaciones de 3.13.0 que en 3.14.0 son falsas", () => {
    for (const falso of ["No incluye sincronización entre dispositivos", "Los datos operativos permanecen locales en IndexedDB", "Sincronización entre dispositivos ni datos operativos compartidos",
      "## Alcance de 3.13.0", "## Limitaciones conocidas de 3.13.0", "entimotors-v3.13.0", "las **8** etiquetas", "las **7** entradas", "01-pwa-3.13.0.test.mjs` comprueba la coherencia de todo esto."])
      assert.ok(!README.includes(falso), `README contiene «${falso}»`);
  });
  test("VERSIONADO: las cifras del README coinciden con el código (16 etiquetas ?v=, 15 entradas del SHELL) y excluye la procedencia 3.13 del importador", () => {
    assert.equal(ETIQUETAS_V, 16); assert.equal(SHELL_V, 15);
    assert.ok(README.includes(`las **${ETIQUETAS_V}** etiquetas`)); assert.ok(README.includes(`las **${SHELL_V}** entradas`));
    for (const t of ["VERSION_APP", "CACHE_NAME", "panel-tecnico.html", "versionApp: \"3.13.0\"", "01-pwa-3.14.0.test.mjs"]) assert.ok(README.includes(t), t);
  });
  test("documenta la nube, los dos productos con sus cachés 3.14.0, el importador y el orden de publicación", () => {
    for (const t of ["Supabase", "entimotors-v3.14.0", "entimotors-mitrabajo-v3.14.0", "entimotors_sync", "Importador 3.13 → nube", "entimotors_os_demo", "**no se borra**",
      "**base de datos → backend →\nfrontends**", "PIN administrativo", "⚠ Por revisar"]) assert.ok(README.includes(t), t);
  });
  test("LIMITACIONES CONOCIDAS de 3.14.0: sección propia con las de la migración (fotos, mecánicos, respaldo de ejemplo, una sola importación, PIN)", () => {
    const i = README.indexOf("## Limitaciones conocidas de 3.14.0"); assert.ok(i > 0); const sec = README.slice(i, README.indexOf("\n---", i));
    assert.match(sec, /no son bugs corregidos/);
    for (const rx of [/fotos que la 3\.13 guardó/, /sin cuenta de mecánico/, /«Ver un ejemplo» no se importa/, /una sola vez y exige la nube vacía/, /ADMIN_PIN_PEPPER/, /requiere configurar `apiUrl`/]) assert.match(sec, rx);
  });
  test("enlaces relativos que existen y ninguna URL real de Supabase/Render", () => {
    const enlaces = [...README.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((u) => !/^(https?:|mailto:)/.test(u));
    assert.deepEqual(enlaces.filter((u) => !fs.existsSync(path.join(RUNTIME, u))), []);
    assert.ok(!/https:\/\/[a-z0-9-]+\.(supabase\.co|onrender\.com)/i.test(README.replace("https://<tu-servicio>.onrender.com", "")));
  });
});

describe("CHANGELOG.md · entrada 3.14.0", () => {
  const i314 = CHANGELOG.indexOf("## 3.14.0"), i313 = CHANGELOG.indexOf("## 3.13.0"), E = CHANGELOG.slice(i314, i313);
  test("es la PRIMERA entrada, marcada como candidato sin publicar, y declara el orden BD → backend → frontends", () => {
    assert.equal(CHANGELOG.indexOf("## "), i314); assert.ok(i313 > i314); assert.match(E, /^## 3\.14\.0 — candidato .*sin publicar/);
    assert.match(E, /sync-1 → 2 → 3 → 3b → 3p → 5 → 6 → 7a → 9 → 10/); assert.match(E, /base de datos .* → backend → frontends/);
  });
  test("incluye lo entregado y las limitaciones de la migración", () => {
    for (const t of ["Importador 3.13 → nube", "entimotors-v3.14.0", "entimotors-mitrabajo-v3.14.0", "no se siembran datos de ejemplo", "«⚠ Por revisar»", "PIN administrativo", "### Limitaciones conocidas"]) assert.ok(E.includes(t), t);
  });
  test("la historia de 3.13.0 hacia atrás queda BYTE A BYTE igual que en el tag v3.13.0", () => {
    const antes = fs.readFileSync(path.join(RAIZ_313, "taller-demo", "CHANGELOG.md"), "utf8");
    assert.equal(CHANGELOG.slice(i313), antes.slice(antes.indexOf("## 3.13.0")));
  });
});
