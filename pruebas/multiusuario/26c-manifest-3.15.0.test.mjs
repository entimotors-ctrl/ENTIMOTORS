// MANIFEST DE RELEASE 3.15.0 (árbol de trabajo): release-3.15.0-manifest.json y release-3.15.0-backend-manifest.json. LISTAS CERRADAS con SHA-256 y
// tamaño de la fuente que se confirma: runtime del frontend (Taller y la base de Mi Trabajo), su documentación, sus pruebas de release, las
// migraciones 15a–15g con sus reversiones, y el backend (fuente + dist compilado). Mismo formato y verificador que 3.14.0 / 3.14.1 (26, 26b).
// Además fija QUÉ cambia respecto de lo publicado en 3.14.1 (commit e807f65) y que el manifest no lleva nada de laboratorio ni privado.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { RAIZ } from "./helpers/entorno.mjs";
import { raiz3141 } from "./helpers/congelado-3.14.1.mjs";

const F = "pruebas/multiusuario/release-3.15.0-manifest.json", FB = "pruebas/multiusuario/release-3.15.0-backend-manifest.json";
const VERIF = path.join(RAIZ, "pruebas/multiusuario/verificar-backend-manifest.mjs");
const M = JSON.parse(fs.readFileSync(path.join(RAIZ, F), "utf8")), B = JSON.parse(fs.readFileSync(path.join(RAIZ, FB), "utf8"));
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const git = (...a) => spawnSync("git", ["-C", RAIZ, ...a], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
// lo que el repositorio lleva o llevará (rastreado + nuevo sin ignorar): antes y después del commit da la misma lista
const delRepo = (prefijo) => [...new Set([...git("ls-files", prefijo), ...git("ls-files", "--others", "--exclude-standard", prefijo)])].filter((p) => fs.existsSync(path.join(RAIZ, p))).sort();
const verificar = (m) => spawnSync(process.execPath, [VERIF, "--raiz", RAIZ, "--manifest", m], { encoding: "utf8" });

describe("release 3.15.0 · manifest cerrado de la fuente (frontend, documentación, pruebas de release y base de datos)", () => {
  test("MATCH: cada archivo listado existe con su SHA-256 y su tamaño", () => {
    const r = verificar(F); assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /^MATCH \d+ archivos/m);
  });
  test("formato, versión, commit base y matriz de versiones = lo que dice el código", () => {
    assert.equal(M.format, "entimotors-release-freeze/1"); assert.equal(M.version, "3.15.0"); assert.equal(M.base_commit, "e807f65502961497ed2866dbea8beaeb4bc1be3e");
    const app = fs.readFileSync(path.join(RAIZ, "taller-demo/app.js"), "utf8"), sw = fs.readFileSync(path.join(RAIZ, "taller-demo/sw.js"), "utf8"), idx = fs.readFileSync(path.join(RAIZ, "taller-demo/index.html"), "utf8");
    assert.equal(M.version_matrix.VERSION_APP, /const VERSION_APP = "([^"]+)"/.exec(app)[1]);
    assert.equal(M.version_matrix.CACHE_NAME, /const CACHE_NAME = "([^"]+)"/.exec(sw)[1]);
    assert.equal(M.version_matrix.index_html_query_v, (idx.match(/<script src="[^"?]+\?v=3\.15\.0"/g) || []).length);
    assert.deepEqual([M.version_matrix.index_html_query_v, M.version_matrix.sw_shell_query_v, M.version_matrix.sw_shell_total], [19, 18, 23]);
    assert.equal(M.version_matrix.panel_tecnico, (/<span class="version" id="version">([^<]*)<\/span>/.exec(fs.readFileSync(path.join(RAIZ, "taller-demo/panel-tecnico.html"), "utf8")) || [])[1]);
  });
  test("runtime_files = TODO lo del repositorio en taller-demo/ salvo supabase/ y la documentación (nada fuera, nada de más)", () => {
    const esperado = delRepo("taller-demo").filter((p) => !p.startsWith("taller-demo/supabase/") && !/^taller-demo\/(README|CHANGELOG)\.md$/.test(p));
    assert.deepEqual(M.runtime_files.map((e) => e.path), esperado);
    assert.deepEqual(M.documentation_files.map((e) => e.path), ["taller-demo/CHANGELOG.md", "taller-demo/README.md"]);
  });
  test("database_files = las 7 migraciones 15a–15g y sus 7 reversiones, con su SHA-256 (grupo propio de este release)", () => {
    const esperado = delRepo("taller-demo/supabase/sync").filter((p) => /\/sync-15[a-g]-/.test(p));
    assert.deepEqual(M.database_files.map((e) => e.path), esperado); assert.equal(esperado.length, 14);
    assert.equal(esperado.filter((p) => p.endsWith("-rollback.sql")).length, 7);
    for (const e of M.database_files) { const p = path.join(RAIZ, e.path); assert.equal(sha(p), e.sha256, e.path); assert.equal(fs.statSync(p).size, e.bytes, e.path); }
  });
  test("respecto de 3.14.1 (e807f65): los archivos NUEVOS son exactamente los 4 de 3.15 y la lista del Taller es la del build", () => {
    const base = raiz3141();
    const nuevos = M.runtime_files.filter((e) => !fs.existsSync(path.join(base, e.path))).map((e) => e.path.replace("taller-demo/", ""));
    assert.deepEqual(nuevos.sort(), ["fecha-negocio.js", "finanzas-calc.js", "hacer-build-taller.sh", "sync-realtime.js"]);
    const sinCambio = M.runtime_files.filter((e) => { const b = path.join(base, e.path); return fs.existsSync(b) && sha(b) === e.sha256; }).map((e) => e.path.replace("taller-demo/", ""));
    for (const f of ["build-target.js", "manifest.json", "recovery.js"]) assert.ok(sinCambio.includes(f), `${f} no cambia en 3.15.0`);
    const build = fs.readFileSync(path.join(RAIZ, "taller-demo/hacer-build-taller.sh"), "utf8");
    const lista = /^PUBLICAR=\(([\s\S]*?)\)/m.exec(build)[1].split(/\s+/).filter((x) => /\.(html|json|js|png)$/.test(x)).sort();
    assert.deepEqual(M.publicacion.taller_lista, lista); assert.equal(lista.length, 27);
    for (const f of lista) assert.ok(M.runtime_files.some((e) => e.path === "taller-demo/" + f), f);
    assert.ok(!M.publicacion.taller_lista.some((f) => /panel-tecnico|config-local|hacer-build|build-mecanicos|README|CHANGELOG|supabase\//.test(f)), "el Taller no publica esos archivos");
    assert.match(M.publicacion.orden, /^base de datos \(sync-15a → 15b → 15c → 15d → 15e → 15f → 15g\) → backend/);
  });
  test("las pruebas de release de 3.15.0 están en la lista y ninguna falta en disco", () => {
    const t = M.test_files.map((e) => e.path);
    for (const f of ["pruebas/multiusuario/01-pwa-3.15.0.test.mjs", "pruebas/multiusuario/16d-alcance-3.15.0.test.mjs", "pruebas/multiusuario/26c-manifest-3.15.0.test.mjs", "pruebas/multiusuario/helpers/usar-3141.mjs",
      "pruebas/sync/node/f1-rechazadas-orden.test.mjs", "pruebas/sync/browser/b8-ventana-migracion.test.mjs", "pruebas/sync/browser/b8-pwa-actualizacion.test.mjs"]) assert.ok(t.includes(f), f);
    for (const f of t) assert.ok(fs.existsSync(path.join(RAIZ, f)), f);
  });
  test("estado real y alcance limpio: PHONE_RESCUE DEFERRED y protección TEMPORAL declarados; nada de laboratorio, respaldos, evidencia ni privados; sin secretos", () => {
    assert.ok(M.pendiente_conocido.some((x) => /^PHONE_RESCUE: DEFERRED/.test(x))); assert.ok(M.pendiente_conocido.some((x) => /protección TEMPORAL/.test(x)));
    const rutas = [...M.runtime_files, ...M.documentation_files, ...M.test_files, ...M.database_files, ...B.runtime_files, ...B.test_files, ...B.generated_build_artifacts].map((e) => e.path);
    for (const p of rutas) {
      assert.match(p, /^(taller-demo|pruebas|api-server)\//, p);
      assert.doesNotMatch(p, /respaldo-20|prerelease-lab|record119|privado|captura|lector|salida\/|node_modules|config-local\.js$|\.env$|\.dump$|\.log$|pgpass|pg_service/i, p);
    }
    for (const m of [M, B]) assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.|sb_secret_|sb_publishable_|service_role"\s*:\s*"[^"]{10}|supabase\.co/.test(JSON.stringify(m)));
  });
});

describe("release 3.15.0 · manifest cerrado del backend (fuente + dist compilado)", () => {
  test("MATCH: cada archivo listado existe con su SHA-256 y su tamaño", () => {
    const r = verificar(FB); assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /^MATCH \d+ archivos/m);
  });
  test("cubre TODO api-server/ del repositorio: la fuente en runtime_files y los 10 archivos de dist/ en su propio grupo", () => {
    assert.equal(B.format, "entimotors-backend-freeze/1"); assert.equal(B.version, "3.15.0");
    const todo = delRepo("api-server");
    assert.deepEqual(B.runtime_files.map((e) => e.path), todo.filter((p) => !p.startsWith("api-server/dist/")));
    assert.deepEqual(B.generated_build_artifacts.map((e) => e.path), todo.filter((p) => p.startsWith("api-server/dist/"))); assert.equal(B.generated_build_artifacts.length, 10);
  });
  test("respecto de 3.14.1 (e807f65) cambian EXACTAMENTE los 3 archivos de fuente de 3.15; el dist contiene las rutas nuevas", () => {
    const base = raiz3141();
    const cambian = B.runtime_files.filter((e) => { const b = path.join(base, e.path); return !fs.existsSync(b) || sha(b) !== e.sha256; }).map((e) => e.path);
    assert.deepEqual(cambian.sort(), ["api-server/src/lib/pin.ts", "api-server/src/routes/admin-usuarios.ts", "api-server/src/routes/pin.ts"]);
    const dist = fs.readFileSync(path.join(RAIZ, "api-server/dist/index.mjs"), "utf8");
    for (const s of ["usuario_impacto", "eliminar_usuario", "revocar_sesiones_usuario"]) assert.ok(dist.includes(s), s);
  });
  test("declara cómo despliega Render (rama, Auto-Deploy, comandos) y que el push a main va después de la base de datos", () => {
    assert.equal(B.render.branch, "main"); assert.match(B.render.build_command, /node \.\/build\.mjs/); assert.match(B.scope, /Requiere sync-15d aplicada/);
    assert.ok(B.no_ejecutado.includes("render") && B.no_ejecutado.includes("produccion"));
  });
});
