// MANIFEST DE RELEASE 3.14.1 (árbol de trabajo): release-3.14.1-manifest.json. LISTA CERRADA con SHA-256 y tamaño del runtime del
// frontend (repo B / GitHub Pages y la base de Mi Trabajo), su documentación y sus pruebas. 3.14.1 NO cambia backend ni base de datos:
// el backend publicado es el del commit d0aaee3 (SECURITY-1B/1D) y su manifest sigue siendo el de 3.14.0 + ese commit.
// Además fija QUÉ cambia respecto de lo publicado en 3.14.0 (commit effbfa1): en el repo B, solo app.js, index.html y sw.js.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { RAIZ } from "./helpers/entorno.mjs";
import { raiz3140 } from "./helpers/congelado-3.14.0.mjs";

const F = "pruebas/multiusuario/release-3.14.1-manifest.json";
const VERIF = path.join(RAIZ, "pruebas/multiusuario/verificar-backend-manifest.mjs");
const M = JSON.parse(fs.readFileSync(path.join(RAIZ, F), "utf8"));
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const git = (...a) => spawnSync("git", ["-C", RAIZ, ...a], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);

describe("release 3.14.1 · manifest cerrado del frontend", () => {
  test("MATCH: cada archivo listado existe con su SHA-256 y su tamaño", () => {
    const r = spawnSync(process.execPath, [VERIF, "--manifest", F], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /^MATCH \d+ archivos/m);
  });
  test("formato, versión y matriz de versiones = lo que dice el código", () => {
    assert.equal(M.format, "entimotors-release-freeze/1"); assert.equal(M.version, "3.14.1");
    const app = fs.readFileSync(path.join(RAIZ, "taller-demo/app.js"), "utf8"), sw = fs.readFileSync(path.join(RAIZ, "taller-demo/sw.js"), "utf8"), idx = fs.readFileSync(path.join(RAIZ, "taller-demo/index.html"), "utf8");
    assert.equal(M.version_matrix.VERSION_APP, /const VERSION_APP = "([^"]+)"/.exec(app)[1]);
    assert.equal(M.version_matrix.CACHE_NAME, /const CACHE_NAME = "([^"]+)"/.exec(sw)[1]);
    assert.equal(M.version_matrix.index_html_query_v, (idx.match(/<script src="[^"?]+\?v=3\.14\.1"/g) || []).length);
    assert.equal(M.version_matrix.index_html_query_v, 16); assert.equal(M.version_matrix.sw_shell_query_v, 15);
  });
  test("runtime_files = TODO lo versionado de taller-demo/ salvo supabase/ y la documentación (nada fuera, nada de más)", () => {
    const esperado = git("ls-files", "taller-demo").filter((p) => !p.startsWith("taller-demo/supabase/") && !/^taller-demo\/(README|CHANGELOG)\.md$/.test(p)).sort();
    assert.deepEqual(M.runtime_files.map((e) => e.path), esperado);
    assert.deepEqual(M.documentation_files.map((e) => e.path), ["taller-demo/CHANGELOG.md", "taller-demo/README.md"]);
  });
  test("respecto de 3.14.0 (effbfa1) cambian EXACTAMENTE app.js, index.html, sw.js y panel-tecnico.html; en el repo B, solo los tres primeros", () => {
    const base = raiz3140();
    const cambian = M.runtime_files.filter((e) => { const b = path.join(base, e.path); return !fs.existsSync(b) || sha(b) !== e.sha256; }).map((e) => e.path.replace("taller-demo/", ""));
    assert.deepEqual(cambian.sort(), ["app.js", "index.html", "panel-tecnico.html", "sw.js"]);
    assert.deepEqual([...M.publicacion.repo_b_cambian].sort(), ["app.js", "index.html", "sw.js"]);
    for (const f of M.publicacion.repo_b_cambian) assert.ok(M.publicacion.repo_b_lista.includes(f), f);
    assert.ok(!M.publicacion.repo_b_lista.some((f) => /panel-tecnico|config-local|hacer-build|build-mecanicos|README|CHANGELOG|supabase\//.test(f)), "el repo B no publica esos archivos");
  });
  test("las pruebas de 3.14.1 están en la lista (SEC-1E, UI-1C, PWA 3.14.1, actualización 3.14.0 → 3.14.1) y ninguna falta en disco", () => {
    const t = M.test_files.map((e) => e.path);
    for (const f of ["pruebas/multiusuario/29-sec1e-seguridad.test.mjs", "pruebas/multiusuario/27-ui1c-iconos.test.mjs", "pruebas/multiusuario/01-pwa-3.14.1.test.mjs",
      "pruebas/multiusuario/16c-alcance-3.14.1.test.mjs", "pruebas/multiusuario/browser/helpers/suite-sec1e.js", "pruebas/multiusuario/browser/helpers/suite-pwa-3141.js"]) assert.ok(t.includes(f), f);
    for (const f of t) assert.ok(fs.existsSync(path.join(RAIZ, f)), f);
  });
  test("sin secretos en el manifest (solo nombres y hashes)", () => {
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.|sb_secret_|service_role"\s*:\s*"[^"]{10}/.test(JSON.stringify(M)));
  });
});
