// hacer-build-mecanicos.sh REAL, ejecutado SOLO contra directorios temporales (os.tmpdir()), que se borran al terminar.
// El script escribe unicamente en su destino; aqui se comprueba ademas que taller-demo/ queda BYTE A BYTE igual.
// Requiere bash y sed de GNU (Linux). No usa red ni datos reales.
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { RUNTIME } from "./helpers/entorno.mjs";
import { ejecutarServiceWorker, VERSION_ESPERADA, CONTRATOS } from "./helpers/pwa.mjs";

const SCRIPT = path.join(RUNTIME, "hacer-build-mecanicos.sh");
const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-c3-build-"));
const V = VERSION_ESPERADA;
// cifras del contrato de la release (helpers/pwa.mjs): Mi Trabajo lleva las mismas etiquetas que el taller MENOS config-local.js
const K = CONTRATOS[V], ETIQUETAS_MT = K.etiquetas - 1;
let n = 0;
const nuevoDir = (etiqueta) => path.join(RAIZ_TMP, `${etiqueta}-${++n}`);

function arbol(dir) {
  const m = new Map();
  const rec = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) rec(p); else m.set(path.relative(dir, p).split(path.sep).join("/"), crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")); } };
  rec(dir); return m;
}
const ejecutar = (script, destino, cwd) => spawnSync("bash", destino === undefined ? [script] : [script, destino], { encoding: "utf8", cwd: cwd || RAIZ_TMP, env: { PATH: process.env.PATH, LC_ALL: "C.UTF-8" } });
const leerEn = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");
const existeEn = (dir) => (rel) => fs.existsSync(path.join(dir, rel));

/** Comprobaciones estaticas del build de «Mi Trabajo» ya generado. Devuelve [{id, ok, detalle}]. */
function verificarBuild(dir) {
  const R = []; const chk = (id, ok, detalle = "") => R.push({ id, ok: Boolean(ok), detalle: ok ? "" : detalle });
  const hay = existeEn(dir);
  const app = hay("app.js") ? leerEn(dir, "app.js") : "", sw = hay("sw.js") ? leerEn(dir, "sw.js") : "", index = hay("index.html") ? leerEn(dir, "index.html") : "";
  const bt = hay("build-target.js") ? leerEn(dir, "build-target.js") : "";
  chk("VERSION_APP", [...app.matchAll(/const VERSION_APP = "([^"]+)"/g)].map((m) => m[1]).join() === V, "VERSION_APP distinta");
  const cn = [...sw.matchAll(/const CACHE_NAME = "([^"]+)"/g)].map((m) => m[1]);
  chk("CACHE_NAME", cn.length === 1 && cn[0] === `entimotors-mitrabajo-v${V}`, `CACHE_NAME=${JSON.stringify(cn)}`);
  const tags = [...index.matchAll(/<script src="([^"?]+)\?v=([^"]+)"/g)].map((m) => ({ a: m[1], v: m[2] }));
  chk("INDEX_QUERY_VERSIONES", tags.length === ETIQUETAS_MT && tags.every((t) => t.v === V), `?v= en index: ${tags.map((t) => `${t.a}?v=${t.v}`)}`);
  const shell = [...((/const SHELL = \[(.*?)\];/s.exec(sw) || [, ""])[1]).matchAll(/"(\.\/[^"]*)"/g)].map((m) => m[1]);
  const shellV = shell.filter((s) => s.includes("?v="));
  chk("SHELL_QUERY_VERSIONES", shellV.length === K.shellV && shellV.every((s) => s.endsWith(`?v=${V}`)), `SHELL ?v=: ${shellV}`);
  const mapa = new Map(tags.map((t) => [t.a, t.v]));
  chk("SHELL_COHERENTE_CON_INDEX", shellV.every((s) => mapa.get(s.slice(2).split("?v=")[0]) === s.split("?v=")[1]), "SHELL e index.html no coinciden");
  chk("SHELL_RECURSOS_EXISTEN", shell.length === K.shell && shell.filter((s) => s !== "./").every((s) => hay(s.slice(2).split("?")[0])), `faltan: ${shell.filter((s) => s !== "./" && !hay(s.slice(2).split("?")[0]))}`);
  chk("INDEX_SCRIPTS_EXISTEN", tags.length > 0 && tags.every((t) => hay(t.a)), `scripts de index inexistentes: ${tags.filter((t) => !hay(t.a)).map((t) => t.a)}`);
  chk("SHELL_CUBRE_LOS_SCRIPTS", tags.every((t) => shell.some((s) => s.split("?")[0] === "./" + t.a)), "scripts de index fuera del SHELL");
  const texto = app + sw + index;
  chk("SIN_RESIDUOS_3_12", !/3\.12\.[12](?![0-9])|entimotors-(mitrabajo-)?v3\.12\./.test(texto), "quedan referencias a 3.12.x");
  chk("SIN_CACHE_DEL_TALLER", !/CACHE_NAME = "entimotors-v/.test(sw), "el CACHE_NAME sigue siendo el del taller");
  chk("PRODUCTO_MECANICO", /producto:\s*"mecanico"/.test(bt) && !/producto:\s*"admin"/.test(bt), "build-target.js no declara producto mecanico");
  chk("SIN_CONFIG_LOCAL", !hay("config-local.js") && !hay("config-local.example.js") && !/config-local/.test(index.replace(/<!--[\s\S]*?-->/g, "")), "config-local presente o referenciado en index.html");
  const refs = []; for (const f of ["index.html", "app.js", "auth.js", "recovery.js", "usuarios.js", "supabase-client.js", "supabase-config.js", "sw.js", "build-target.js"]) if (hay(f)) for (const l of leerEn(dir, f).split("\n")) if (/(src=|import |import\(|fetch\()[^\n]*config-local/.test(l)) refs.push(f);
  chk("SIN_REFERENCIAS_EJECUTABLES_A_CONFIG_LOCAL", refs.length === 0, `en: ${refs}`);
  chk("SIN_PANEL_TECNICO_NI_SQL", !hay("panel-tecnico.html") && !hay("supabase") && !hay("build-mecanicos") && !hay("hacer-build-mecanicos.sh"), "quedaron archivos que no son de este producto");
  let man = null; try { man = JSON.parse(leerEn(dir, "manifest.json")); } catch { /* se reporta abajo */ }
  chk("MANIFEST_MECANICOS", man && man.name === "ENTIMOTORS Mi Trabajo" && man.short_name === "Mi Trabajo" && man.icons.every((i) => hay(i.src)), "manifest ausente, del taller o con iconos inexistentes");
  chk("HEADERS_SIN_CACHE", hay("_headers") && ["/index.html", "/build-target.js", "/sw.js", "/manifest.json"].every((r) => new RegExp(`${r.replace(".", "\\.")}\\s+Cache-Control: public, max-age=0, must-revalidate`).test(leerEn(dir, "_headers"))), "_headers ausente o sin no-cache en los cuatro archivos clave");
  return R;
}
const fallosDe = (r) => r.filter((x) => !x.ok).map((x) => x.id);
const IDS = ["VERSION_APP", "CACHE_NAME", "INDEX_QUERY_VERSIONES", "SHELL_QUERY_VERSIONES", "SHELL_COHERENTE_CON_INDEX", "SHELL_RECURSOS_EXISTEN", "INDEX_SCRIPTS_EXISTEN", "SHELL_CUBRE_LOS_SCRIPTS", "SIN_RESIDUOS_3_12", "SIN_CACHE_DEL_TALLER", "PRODUCTO_MECANICO", "SIN_CONFIG_LOCAL", "SIN_REFERENCIAS_EJECUTABLES_A_CONFIG_LOCAL", "SIN_PANEL_TECNICO_NI_SQL", "MANIFEST_MECANICOS", "HEADERS_SIN_CACHE"];

let destino, salida, antes, despues, fuente;
before(() => {
  assert.ok(RAIZ_TMP.startsWith(os.tmpdir()), "el directorio de trabajo debe estar en el temporal del sistema");
  antes = arbol(RUNTIME);
  destino = nuevoDir("build");
  salida = ejecutar(SCRIPT, destino);
  despues = arbol(RUNTIME);
  fuente = antes;
});
after(() => { fs.rmSync(RAIZ_TMP, { recursive: true, force: true }); });

describe("el script sobre el runtime real", () => {
  test("termina con codigo 0 y anuncia el destino", () => { assert.equal(salida.status, 0, salida.stderr); assert.match(salida.stdout, /build de mecánicos generado en: /); assert.equal(salida.stderr, ""); });
  test("NO escribe nada en taller-demo/: el arbol de origen queda byte a byte igual (mismos archivos, mismos hashes)", () => {
    assert.deepEqual([...despues].sort(), [...antes].sort());
  });
  test("el destino esta FUERA del repositorio (temporal del sistema)", () => { assert.ok(destino.startsWith(os.tmpdir())); assert.ok(!path.resolve(destino).startsWith(path.resolve(RUNTIME))); });
  test("todas las comprobaciones estaticas del build pasan", () => { const r = verificarBuild(destino); assert.deepEqual(fallosDe(r), [], JSON.stringify(r.filter((x) => !x.ok))); assert.deepEqual(r.map((x) => x.id), IDS); });
});

describe("contenido del build de «Mi Trabajo»", () => {
  test("CACHE_NAME = entimotors-mitrabajo-v3.14.0 (una sola vez) y ninguna referencia a 3.12.x", () => {
    const sw = leerEn(destino, "sw.js"); assert.deepEqual([...sw.matchAll(/const CACHE_NAME = "([^"]+)"/g)].map((m) => m[1]), [`entimotors-mitrabajo-v${V}`]);
    for (const f of ["app.js", "sw.js", "index.html"]) assert.ok(!/3\.12\.[12](?![0-9])|entimotors-(mitrabajo-)?v3\.12\./.test(leerEn(destino, f)), f);
  });
  test("los 15 <script ?v=> de index.html (los 16 del taller sin config-local.js) apuntan a 3.14.0 y el SHELL del service worker coincide", () => {
    const idx = leerEn(destino, "index.html"); assert.deepEqual([...idx.matchAll(/<script src="([^"?]+)\?v=([^"]+)"/g)].map((m) => `${m[1]}?v=${m[2]}`).sort(),
      ["app.js", "auth.js", "build-target.js", "import-313.js", "pin-ui.js", "recovery.js", "supabase-client.js", "supabase-config.js", "sync-db.js", "sync-engine.js",
       "sync-finanzas.js", "sync-fotos.js", "sync-mappers.js", "sync-rest.js", "usuarios.js"].map((a) => `${a}?v=${V}`).sort());
    assert.equal(ETIQUETAS_MT, 15);
  });
  test("index.html = el del taller SIN el bloque de config-local, con titulo y textos de «Mi Trabajo» (transformacion documentada del script)", () => {
    const src = leerEn(RUNTIME, "index.html");
    const esperado = src.replace(/<!-- config-local\.js es opcional[\s\S]*?Ver config-local\.example\.js\. -->\n?/, "").split("\n").filter((l) => !l.startsWith('<script src="config-local.js')).join("\n")
      .replace("<title>ENTIMOTORS OS — Demo local</title>", "<title>ENTIMOTORS · Mi Trabajo</title>").replace("<h1>Instala ENTIMOTORS OS</h1>", "<h1>Instala ENTIMOTORS Mi Trabajo</h1>").replace("Abre ENTIMOTORS OS desde su propio ícono", "Abre Mi Trabajo desde su propio ícono");
    assert.equal(leerEn(destino, "index.html"), esperado);
    assert.match(leerEn(destino, "index.html"), /<title>ENTIMOTORS · Mi Trabajo<\/title>/);
  });
  test("sw.js = el del taller salvo la linea de CACHE_NAME", () => {
    const src = leerEn(RUNTIME, "sw.js"); assert.equal(leerEn(destino, "sw.js"), src.replace(/^const CACHE_NAME = "entimotors-/m, 'const CACHE_NAME = "entimotors-mitrabajo-'));
  });
  test("build-target.js, manifest.json y _headers son EXACTAMENTE los de build-mecanicos/", () => {
    for (const f of ["build-target.js", "manifest.json", "_headers"]) assert.equal(leerEn(destino, f), leerEn(RUNTIME, `build-mecanicos/${f}`), f);
  });
  test("el resto del runtime (app.js, auth.js, recovery.js, usuarios.js, supabase-*.js, iconos) es identico byte a byte al del taller", () => {
    const out = arbol(destino); const cambiados = [...out].filter(([f, h]) => fuente.has(f) && fuente.get(f) !== h).map(([f]) => f).sort();
    assert.deepEqual(cambiados, ["build-target.js", "index.html", "manifest.json", "sw.js"]);
    assert.deepEqual([...out.keys()].filter((f) => !fuente.has(f)), ["_headers"]);
  });
  test("quita exactamente lo que no es de este producto", () => {
    const out = arbol(destino); const quitados = [...fuente.keys()].filter((f) => !out.has(f));
    assert.ok(quitados.every((f) => /^(build-mecanicos\/|hacer-build-mecanicos\.sh$|config-local(\.example)?\.js$|panel-tecnico\.html$|supabase\/|README\.md$|CHANGELOG\.md$)/.test(f)), `quitados inesperados: ${quitados.filter((f) => !/^(build-mecanicos\/|hacer-build-mecanicos\.sh$|config-local(\.example)?\.js$|panel-tecnico\.html$|supabase\/|README\.md$|CHANGELOG\.md$)/.test(f))}`);
    for (const f of ["hacer-build-mecanicos.sh", "panel-tecnico.html", "build-mecanicos/build-target.js"]) assert.ok(quitados.includes(f), f);
    for (const f of ["app.js", "auth.js", "recovery.js", "usuarios.js", "supabase-client.js", "supabase-config.js", "sw.js", "index.html"]) assert.ok(out.has(f), `debe conservar ${f}`);
  });
  test("ningun JWT del build tiene rol distinto de «anon» (no viaja ninguna clave de servicio; el codigo que la DETECTA y rechaza es legitimo)", () => {
    const roles = [];
    for (const [f] of arbol(destino)) { if (!/\.(js|html|json)$/.test(f)) continue; for (const m of leerEn(destino, f).matchAll(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) { try { roles.push([f, JSON.parse(Buffer.from(m[1], "base64url").toString()).role]); } catch { roles.push([f, "ilegible"]); } } }
    assert.deepEqual(roles.filter(([, r]) => r !== "anon"), [], "solo puede haber la clave publica (anon)");
    assert.ok(roles.length >= 1, "debe existir al menos la clave publica de supabase-config.js");
  });
  test("el service worker DEL BUILD se ejecuta: abre SOLO su cache de mecanicos, precachea el SHELL (todo existe en el build) con no-store y NO llama skipWaiting", async () => {
    const sw = leerEn(destino, "sw.js"); const w = ejecutarServiceWorker({ sw });
    assert.equal(w.nombreCache(), `entimotors-mitrabajo-v${V}`); await w.instalar();
    assert.deepEqual(w.llamadas.abiertas, [`entimotors-mitrabajo-v${V}`]); assert.equal(w.llamadas.skipWaiting, 0, "skipWaiting automatico en install");
    const shell = w.shell(); assert.equal(shell.length, K.shell); assert.equal(K.shell, 20);
    for (const url of shell) { assert.ok(w.llamadas.fetch.some((f) => f.url === url && f.opciones?.cache === "no-store"), `no se precacheo ${url} con no-store`); if (url !== "./") assert.ok(fs.existsSync(path.join(destino, url.slice(2).split("?")[0])), `SHELL: ${url} no existe en el build`); }
  });
  test("al activarse, el service worker del build borra caches VIEJAS de Mi Trabajo, conserva la actual y llama clients.claim() sin skipWaiting", async () => {
    const w = ejecutarServiceWorker({ sw: leerEn(destino, "sw.js"), cachesExistentes: ["entimotors-mitrabajo-v3.12.1", "entimotors-mitrabajo-v3.12.2", "entimotors-mitrabajo-v3.13.0", `entimotors-mitrabajo-v${V}`] }); await w.activar();
    assert.deepEqual(w.llamadas.borradas.sort(), ["entimotors-mitrabajo-v3.12.1", "entimotors-mitrabajo-v3.12.2", "entimotors-mitrabajo-v3.13.0"]); assert.deepEqual([...w.almacenes.keys()], [`entimotors-mitrabajo-v${V}`]);
    assert.equal(w.llamadas.claim, 1); assert.equal(w.llamadas.skipWaiting, 0);
  });
});

describe("el verificador del build detecta cada defecto (mutantes sobre COPIAS del build)", () => {
  const copia = (etiqueta) => { const d = nuevoDir(etiqueta); fs.cpSync(destino, d, { recursive: true }); return d; };
  const editar = (d, rel, fn) => { const p = path.join(d, rel); const t = fs.readFileSync(p, "utf8"); const r = fn(t); assert.notEqual(r, t, `el mutante no cambio ${rel}`); fs.writeFileSync(p, r); };
  const MUTANTES = [
    ["CACHE_NAME del taller (el sed de renombrado no se aplico)", (d) => editar(d, "sw.js", (t) => t.replace("entimotors-mitrabajo-v", "entimotors-v")), ["CACHE_NAME", "SIN_CACHE_DEL_TALLER"]],
    ["CACHE_NAME con version vieja", (d) => editar(d, "sw.js", (t) => t.replace(`entimotors-mitrabajo-v${V}`, "entimotors-mitrabajo-v3.12.2")), ["CACHE_NAME", "SIN_RESIDUOS_3_12"]],
    ["una entrada del SHELL con version vieja", (d) => editar(d, "sw.js", (t) => t.replace(`"./recovery.js?v=${V}"`, '"./recovery.js?v=3.12.2"')), ["SHELL_QUERY_VERSIONES", "SHELL_COHERENTE_CON_INDEX", "SIN_RESIDUOS_3_12"]],
    ["un <script ?v=> con version vieja", (d) => editar(d, "index.html", (t) => t.replace(`recovery.js?v=${V}`, "recovery.js?v=3.12.2")), ["INDEX_QUERY_VERSIONES", "SHELL_COHERENTE_CON_INDEX", "SIN_RESIDUOS_3_12"]],
    ["VERSION_APP distinta", (d) => editar(d, "app.js", (t) => t.replace(`const VERSION_APP = "${V}"`, 'const VERSION_APP = "3.12.2"')), ["VERSION_APP", "SIN_RESIDUOS_3_12"]],
    ["falta un recurso del SHELL", (d) => fs.rmSync(path.join(d, "usuarios.js")), ["SHELL_RECURSOS_EXISTEN", "INDEX_SCRIPTS_EXISTEN"]],
    ["build-target.js del taller", (d) => editar(d, "build-target.js", (t) => t.replace(/producto:\s*"mecanico"/, 'producto: "admin"')), ["PRODUCTO_MECANICO"]],
    ["queda config-local.js", (d) => fs.writeFileSync(path.join(d, "config-local.js"), "// x\n"), ["SIN_CONFIG_LOCAL"]],
    ["queda una etiqueta ejecutable a config-local", (d) => editar(d, "index.html", (t) => t.replace(`<script src="app.js?v=${V}"`, `<script src="config-local.js?v=${V}"></script>\n<script src="app.js?v=${V}"`)), ["SIN_CONFIG_LOCAL", "SIN_REFERENCIAS_EJECUTABLES_A_CONFIG_LOCAL", "INDEX_QUERY_VERSIONES", "INDEX_SCRIPTS_EXISTEN", "SHELL_CUBRE_LOS_SCRIPTS"]],
    ["queda un fetch a config-local en el JS", (d) => editar(d, "app.js", (t) => `${t}\nfetch("config-local.js");\n`), ["SIN_REFERENCIAS_EJECUTABLES_A_CONFIG_LOCAL"]],
    ["queda el panel tecnico", (d) => fs.writeFileSync(path.join(d, "panel-tecnico.html"), "<html></html>"), ["SIN_PANEL_TECNICO_NI_SQL"]],
    ["manifest del taller", (d) => editar(d, "manifest.json", (t) => t.replace("ENTIMOTORS Mi Trabajo", "ENTIMOTORS OS")), ["MANIFEST_MECANICOS"]],
    ["manifest con un icono inexistente", (d) => fs.rmSync(path.join(d, "icons", "icon-192.png")), ["MANIFEST_MECANICOS"]],
    ["_headers sin no-cache para sw.js", (d) => editar(d, "_headers", (t) => t.replace(/\/sw\.js\n\s+Cache-Control: public, max-age=0, must-revalidate/, "/sw.js\n  Cache-Control: public, max-age=31536000")), ["HEADERS_SIN_CACHE"]],
  ];
  for (const [nombre, mutar, esperados] of MUTANTES) test(`detecta: ${nombre}`, () => {
    const d = copia("mut"); mutar(d); const f = fallosDe(verificarBuild(d));
    for (const id of esperados) assert.ok(f.includes(id), `debia fallar ${id}; fallo: [${f}]`);
  });
  test("cada comprobacion tiene al menos un mutante que la dispara", () => {
    const cubiertos = new Set(MUTANTES.flatMap((m) => m[2])); assert.deepEqual(IDS.filter((i) => !cubiertos.has(i)), []);
  });
});

describe("las guardas propias del script (sobre COPIAS del runtime, nunca el real)", () => {
  const copiaRuntime = (etiqueta) => { const d = nuevoDir(etiqueta); fs.cpSync(RUNTIME, d, { recursive: true }); return d; };
  test("sin argumento: codigo 1 y mensaje de uso; no crea nada", () => {
    const antesTmp = fs.readdirSync(RAIZ_TMP).length; const r = ejecutar(SCRIPT, undefined); assert.equal(r.status, 1); assert.match(r.stderr, /uso: /); assert.equal(fs.readdirSync(RAIZ_TMP).length, antesTmp);
  });
  test("argumento vacio: igual que sin argumento", () => { const r = ejecutar(SCRIPT, ""); assert.equal(r.status, 1); assert.match(r.stderr, /uso: /); });
  test("si falta build-mecanicos/build-target.js el script FALLA (no produce un build a medias declarandolo bueno)", () => {
    const src = copiaRuntime("src"); fs.rmSync(path.join(src, "build-mecanicos", "build-target.js")); const out = nuevoDir("out");
    const r = ejecutar(path.join(src, "hacer-build-mecanicos.sh"), out); assert.notEqual(r.status, 0); assert.ok(!/build de mecánicos generado/.test(r.stdout));
  });
  test("si el build-target del overlay NO declara «mecanico» → ABORTADO (codigo 1)", () => {
    const src = copiaRuntime("src"); fs.writeFileSync(path.join(src, "build-mecanicos", "build-target.js"), 'window.ENTIMOTORS_BUILD = { producto: "admin" };\n'); const out = nuevoDir("out");
    const r = ejecutar(path.join(src, "hacer-build-mecanicos.sh"), out); assert.equal(r.status, 1); assert.match(r.stderr, /ABORTADO: el build no quedó marcado como producto mecánico/);
  });
  test("si queda una referencia EJECUTABLE a config-local.js → ABORTADO (codigo 1)", () => {
    const src = copiaRuntime("src"); fs.appendFileSync(path.join(src, "app.js"), '\nfetch("config-local.js");\n'); const out = nuevoDir("out");
    const r = ejecutar(path.join(src, "hacer-build-mecanicos.sh"), out); assert.equal(r.status, 1); assert.match(r.stderr, /ABORTADO: quedan referencias ejecutables a config-local/);
  });
  test("un comentario que MENCIONA config-local no es una referencia ejecutable: el build sigue adelante", () => {
    const src = copiaRuntime("src"); fs.appendFileSync(path.join(src, "app.js"), "\n// nota: config-local.js no existe en este producto\n"); const out = nuevoDir("out");
    assert.equal(ejecutar(path.join(src, "hacer-build-mecanicos.sh"), out).status, 0);
  });
  test("es idempotente: repetir el build sobre el mismo destino da el mismo arbol y no arrastra restos", () => {
    const d = nuevoDir("idem"); assert.equal(ejecutar(SCRIPT, d).status, 0); const a = arbol(d);
    fs.writeFileSync(path.join(d, "resto-de-otra-vez.txt"), "x"); assert.equal(ejecutar(SCRIPT, d).status, 0); assert.deepEqual([...arbol(d)].sort(), [...a].sort());
  });
  test("con el runtime en otra ruta (copia) genera exactamente el mismo build: no depende de rutas absolutas ni del directorio actual", () => {
    const src = copiaRuntime("src"); const out = nuevoDir("out"); assert.equal(ejecutar(path.join(src, "hacer-build-mecanicos.sh"), out, os.tmpdir()).status, 0);
    assert.deepEqual([...arbol(out)].sort(), [...arbol(destino)].sort());
  });
  test("tras todo esto, taller-demo/ real sigue byte a byte igual", () => { assert.deepEqual([...arbol(RUNTIME)].sort(), [...antes].sort()); });
});
