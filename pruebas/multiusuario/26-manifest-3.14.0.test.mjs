// MANIFESTS DE RELEASE 3.14.0 (árbol de trabajo): release-3.14.0-backend-manifest.json (api-server: fuente, pruebas y dist/ compilado)
// y release-3.14.0-manifest.json (frontend: lo que se publica en el repo B y la base de Mi Trabajo, su documentación y sus pruebas).
// Cada uno es una LISTA CERRADA con SHA-256 y tamaño: la publicación (SYNC-12 E) copia exactamente esos archivos y compara hashes.
// Los de 3.13.0 siguen siendo evidencia inmutable (23-backend-manifest, sobre el tag v3.13.0).
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RAIZ } from "./helpers/entorno.mjs";

const VERIF = path.join(RAIZ, "pruebas/multiusuario/verificar-backend-manifest.mjs");
const correr = (...a) => spawnSync(process.execPath, [VERIF, ...a], { encoding: "utf8" });
const git = (...a) => spawnSync("git", ["-C", RAIZ, ...a], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
const leerJson = (rel) => JSON.parse(fs.readFileSync(path.join(RAIZ, rel), "utf8"));
const B = "pruebas/multiusuario/release-3.14.0-backend-manifest.json", F = "pruebas/multiusuario/release-3.14.0-manifest.json";

describe("release 3.14.0 · manifests cerrados", () => {
  test("backend: MATCH (fuente, pruebas y los 10 archivos de dist/)", () => { const r = correr("--manifest", B); assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /^MATCH \d+ archivos/m); });
  test("frontend: MATCH (runtime del repo B + base de Mi Trabajo, documentación y pruebas)", () => { const r = correr("--manifest", F); assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /^MATCH \d+ archivos/m); });
  test("backend: runtime_files = TODO lo versionado de api-server/ salvo dist/ (nada fuera, nada de más)", () => {
    const m = leerJson(B); assert.equal(m.format, "entimotors-backend-freeze/1"); assert.equal(m.version, "3.14.0");
    assert.deepEqual(m.runtime_files.map((e) => e.path), git("ls-files", "api-server").filter((p) => !p.startsWith("api-server/dist/")).sort());
    assert.deepEqual(m.generated_build_artifacts.map((e) => e.path), git("ls-files", "api-server/dist").sort());
  });
  test("backend: dist/ trae las 5 rutas del PIN (el dist de 3.13.0 no las tenía)", () => {
    const idx = fs.readFileSync(path.join(RAIZ, "api-server/dist/index.mjs"), "utf8");
    for (const r of ['"/admin/pin/estado"', '"/admin/pin/desbloquear"', '"/autorizaciones"']) assert.equal(idx.split(r).length - 1, 1, r);
    assert.equal(idx.split('"/admin/pin"').length - 1, 2, "PUT y DELETE /admin/pin");
  });
  test("frontend: runtime_files = TODO lo versionado de taller-demo/ salvo supabase/ y la documentación; incluye las 8 piezas nuevas de 3.14.0", () => {
    const m = leerJson(F); assert.equal(m.format, "entimotors-release-freeze/1"); assert.equal(m.version, "3.14.0");
    const esperado = git("ls-files", "taller-demo").filter((p) => !p.startsWith("taller-demo/supabase/") && !/^taller-demo\/(README|CHANGELOG)\.md$/.test(p)).sort();
    assert.deepEqual(m.runtime_files.map((e) => e.path), esperado);
    for (const f of ["sync-rest.js", "sync-db.js", "sync-engine.js", "sync-mappers.js", "sync-fotos.js", "sync-finanzas.js", "pin-ui.js", "import-313.js"]) assert.ok(esperado.includes(`taller-demo/${f}`), f);
    assert.deepEqual(m.documentation_files.map((e) => e.path), ["taller-demo/CHANGELOG.md", "taller-demo/README.md"]);
  });
  test("la configuración REAL de Render queda documentada sin valores secretos (solo nombres de variables)", () => {
    const r = leerJson(B).render;
    assert.equal(r.build_command, "npm install -g pnpm@12.3.4 && cd api-server && pnpm install && node ./build.mjs");
    assert.equal(r.start_command, "node api-server/dist/index.mjs"); assert.equal(r.root_directory, ""); assert.equal(r.auto_deploy, "On Commit"); assert.equal(r.branch, "main");
    const texto = JSON.stringify(leerJson(B)); assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.|sb_secret_|service_role"\s*:\s*"[^"]{10}/.test(texto));
  });
});
