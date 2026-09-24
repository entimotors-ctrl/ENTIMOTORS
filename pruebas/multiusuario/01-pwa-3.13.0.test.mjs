// PWA / cache 3.13.0: versionado coherente, SHELL, service worker (estatico Y ejecutado) y mutantes.
// 3.14.0: este es el CONTRATO de la release 3.13.0 → se ejecuta, sin cambiar una sola aserción, contra la instantánea inmutable
// del tag v3.13.0 (helpers/usar-313.mjs, PRIMER import). El contrato vigente de 3.14.0 está en su archivo hermano (3.14.0 / 16b / 17b).
import "./helpers/usar-313.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { leer } from "./helpers/entorno.mjs";
import { verificarPwa, fallos, fuentesReales, ejecutarServiceWorker, VERSION_ESPERADA } from "./helpers/pwa.mjs";

const real = fuentesReales();
const con = (campo, fn) => ({ ...real, [campo]: fn(real[campo]) });

describe("PWA 3.13.0 — el runtime real", () => {
  test("todas las comprobaciones de versionado/cache pasan sobre los archivos reales", () => {
    const r = verificarPwa(real);
    assert.deepEqual(fallos(r), [], r.filter((x) => !x.ok).map((x) => `${x.id}: ${x.detalle}`).join(" | "));
    assert.ok(r.length >= 13, "se esperaban al menos 13 comprobaciones");
  });
  test("VERSION_APP = 3.13.0", () => assert.match(real.app, /const VERSION_APP = "3\.13\.0";/));
  test("CACHE_NAME = entimotors-v3.13.0", () => assert.match(real.sw, /const CACHE_NAME = "entimotors-v3\.13\.0";/));
  test("las 8 etiquetas <script ?v=> de index.html llevan 3.13.0 (incluidas app.js y config-local.js)", () => {
    const t = [...real.index.matchAll(/<script src="([^"?]+)\?v=([^"]+)"/g)];
    assert.equal(t.length, 8);
    assert.ok(t.every((m) => m[2] === "3.13.0"));
    assert.deepEqual(t.map((m) => m[1]).sort(), ["app.js", "auth.js", "build-target.js", "config-local.js", "recovery.js", "supabase-client.js", "supabase-config.js", "usuarios.js"]);
  });
  test("0 residuos runtime de 3.12.2 y de 3.12.1 en app.js, sw.js e index.html", () => {
    const todo = real.app + real.sw + real.index;
    assert.equal((todo.match(/3\.12\.2|entimotors-v3\.12\./g) || []).length, 0);
    assert.equal((todo.match(/3\.12\.1(?![0-9])/g) || []).length, 0);
  });
  test("el orden y la estructura de los scripts no cambiaron (build-target primero, usuarios al final)", () => {
    const orden = [...real.index.matchAll(/<script src="([^"?]+)\?v=/g)].map((m) => m[1]);
    assert.deepEqual(orden, ["build-target.js", "supabase-config.js", "supabase-client.js", "auth.js", "recovery.js", "config-local.js", "app.js", "usuarios.js"]);
    assert.ok(!/<script[^>]*\b(async|defer)\b/.test(real.index.split("chart.js")[1] || ""), "no debe haber async/defer en los scripts locales");
  });
});

describe("PWA 3.13.0 — el service worker EJECUTADO", () => {
  test("usa el nombre de cache entimotors-v3.13.0 y el SHELL versionado", async () => {
    const sw = ejecutarServiceWorker();
    assert.equal(sw.nombreCache(), "entimotors-v3.13.0");
    assert.equal(sw.shell().filter((s) => s.includes("?v=")).every((s) => s.endsWith("?v=3.13.0")), true);
  });
  test("install: abre SOLO su cache, precachea el SHELL con no-store y NO llama skipWaiting", async () => {
    const sw = ejecutarServiceWorker(); await sw.instalar();
    assert.deepEqual(sw.llamadas.abiertas, ["entimotors-v3.13.0"]);
    const shell = sw.shell();
    for (const url of shell) assert.ok(sw.llamadas.fetch.some((f) => f.url === url && f.opciones?.cache === "no-store"), `no se precacheo ${url} con no-store`);
    assert.equal(sw.llamadas.skipWaiting, 0, "skipWaiting automatico en install");
  });
  test("activate: borra las caches de OTRAS versiones (p. ej. la 3.12.2) y conserva la propia; llama clients.claim()", async () => {
    const sw = ejecutarServiceWorker({ cachesExistentes: ["entimotors-v3.12.2", "entimotors-v3.13.0", "entimotors-mitrabajo-v3.13.0"] });
    await sw.activar();
    assert.deepEqual(sw.llamadas.borradas.sort(), ["entimotors-mitrabajo-v3.13.0", "entimotors-v3.12.2"]);
    assert.ok(sw.almacenes.has("entimotors-v3.13.0"));
    assert.equal(sw.llamadas.claim, 1);
    assert.equal(sw.llamadas.skipWaiting, 0);
  });
  test("mensaje activar-ya: llama skipWaiting UNA vez; otros mensajes no", () => {
    const sw = ejecutarServiceWorker();
    sw.mensaje({ tipo: "cualquier-cosa" }); sw.mensaje(undefined); sw.mensaje({ tipo: "activar-YA" });
    assert.equal(sw.llamadas.skipWaiting, 0);
    sw.mensaje({ tipo: "activar-ya" });
    assert.equal(sw.llamadas.skipWaiting, 1);
  });
  test("fetch: ignora las peticiones que no son GET", () => {
    const sw = ejecutarServiceWorker();
    assert.equal(sw.fetchEvento("https://app.synthetic.test/api/x", "POST"), undefined);
    assert.notEqual(sw.fetchEvento("https://app.synthetic.test/app.js?v=3.13.0", "GET"), undefined);
  });
});

describe("PWA 3.13.0 — NEGATIVOS: cada mutante hace FALLAR la comprobacion correspondiente", () => {
  const M = [
    ["VERSION_APP vieja", () => con("app", (s) => s.replace('const VERSION_APP = "3.13.0"', 'const VERSION_APP = "3.12.2"')), "VERSION_APP"],
    ["VERSION_APP inconsistente (3.13.1)", () => con("app", (s) => s.replace('"3.13.0"', '"3.13.1"')), "VERSION_APP"],
    ["CACHE_NAME viejo", () => con("sw", (s) => s.replace('entimotors-v3.13.0', 'entimotors-v3.12.2')), "CACHE_NAME"],
    ["CACHE_NAME sin version", () => con("sw", (s) => s.replace('entimotors-v3.13.0', 'entimotors-v')), "CACHE_NAME"],
    ["una etiqueta de index.html con ?v= vieja", () => con("index", (s) => s.replace('app.js?v=3.13.0', 'app.js?v=3.12.2')), "INDEX_QUERY_VERSIONES"],
    ["config-local.js sin actualizar", () => con("index", (s) => s.replace('config-local.js?v=3.13.0', 'config-local.js?v=3.12.2')), "INDEX_APP_Y_CONFIG_LOCAL"],
    ["una entrada del SHELL con ?v= vieja", () => con("sw", (s) => s.replace('./auth.js?v=3.13.0', './auth.js?v=3.12.2')), "SHELL_QUERY_VERSIONES"],
    ["SHELL e index.html desincronizados", () => con("sw", (s) => s.replace('./usuarios.js?v=3.13.0', './usuarios.js?v=3.13.1')), "SHELL_COHERENTE_CON_INDEX"],
    ["recurso del SHELL que no existe", () => ({ ...real, existe: (rel) => rel !== "recovery.js" && real.existe(rel) }), "SHELL_RECURSOS_EXISTEN"],
    ["un script de index.html falta en el SHELL", () => con("sw", (s) => s.replace('"./recovery.js?v=3.13.0",', "")), "SHELL_CUBRE_LOS_SCRIPTS"],
    ["residuo runtime de 3.12.2 en app.js", () => con("app", (s) => s + '\nconst RESIDUO = "3.12.2";'), "SIN_RESIDUOS_3_12_2"],
    ["residuo runtime de 3.12.1 en sw.js", () => con("sw", (s) => s + '\nconst RESIDUO = "entimotors 3.12.1";'), "SIN_RESIDUOS_3_12_1"],
    ["skipWaiting automatico en install", () => con("sw", (s) => s.replace('event.waitUntil(\n    caches.open(CACHE_NAME)', 'self.skipWaiting();\n  event.waitUntil(\n    caches.open(CACHE_NAME)')), "SW_SKIPWAITING_NO_AUTOMATICO"],
    ["se pierde el mensaje activar-ya", () => con("sw", (s) => s.replace('event.data?.tipo === "activar-ya"', 'event.data?.tipo === "otra-cosa"')), "SW_ACTIVAR_YA"],
    ["se pierde clients.claim() en activate", () => con("sw", (s) => s.replace("self.clients.claim();", "")), "SW_CLIENTS_CLAIM_EN_ACTIVATE"],
  ];
  for (const [nombre, hacer, id] of M) {
    test(`mutante: ${nombre} → FAIL ${id}`, () => {
      const m = hacer();
      const cambio = m.app !== real.app || m.sw !== real.sw || m.index !== real.index || m.existe !== real.existe;
      assert.ok(cambio, "el mutante no cambio nada (el reemplazo no encontro su objetivo)");
      const f = fallos(verificarPwa(m));
      assert.ok(f.includes(id), `se esperaba FAIL en ${id}; fallos reales: [${f}]`);
    });
  }
  test("el runtime real, sin mutar, no falla ninguna (control)", () => assert.deepEqual(fallos(verificarPwa(real)), []));
  test("control de version: exigir otra version (3.12.2) sobre el runtime real FALLA", () => {
    const f = fallos(verificarPwa(real, "3.12.2"));
    for (const id of ["VERSION_APP", "CACHE_NAME", "INDEX_QUERY_VERSIONES", "SHELL_QUERY_VERSIONES"]) assert.ok(f.includes(id), id);
  });
});
