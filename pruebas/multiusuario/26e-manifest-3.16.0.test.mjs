// MANIFEST DE RELEASE 3.16.0 (árbol de trabajo): release-3.16.0-manifest.json. LISTA CERRADA con SHA-256 y tamaño de la fuente que se confirma:
// runtime del frontend (Taller y la base de Mi Trabajo), su documentación y sus pruebas de release. 3.16.0 es SOLO frontends: no hay migraciones
// (database_files vacío) y el backend sigue siendo el de 3.15.0 (release-3.15.0-backend-manifest.json, 26c). Mismo formato y verificador.
// La base es lo PUBLICADO (3.15.0, tag v3.15.0 → f2a6598): 3.15.1 no se publicó por separado y entra entera aquí. A diferencia de 26d no se fija
// línea a línea app.js (los cambios del cliente son cientos de líneas, cubiertas por pruebas/ui-telefono y sus pruebas de comportamiento): se fija
// QUÉ ARCHIVOS cambian y cuáles son nuevos.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { RAIZ } from "./helpers/entorno.mjs";
import { raiz3150 } from "./helpers/congelado-3.15.0.mjs";

const F = "pruebas/multiusuario/release-3.16.0-manifest.json";
const VERIF = path.join(RAIZ, "pruebas/multiusuario/verificar-backend-manifest.mjs");
const M = JSON.parse(fs.readFileSync(path.join(RAIZ, F), "utf8"));
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const git = (...a) => spawnSync("git", ["-C", RAIZ, ...a], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
// lo que el repositorio lleva o llevará (rastreado + nuevo sin ignorar): antes y después del commit da la misma lista
const delRepo = (prefijo) => [...new Set([...git("ls-files", prefijo), ...git("ls-files", "--others", "--exclude-standard", prefijo)])].filter((p) => fs.existsSync(path.join(RAIZ, p))).sort();
const BASE = "f2a659870d1a485551cedc601b07490e804faed4";

describe("release 3.16.0 · manifest cerrado de la fuente (frontend, documentación y pruebas de release)", () => {
  test("MATCH: cada archivo listado existe con su SHA-256 y su tamaño", () => {
    const r = spawnSync(process.execPath, [VERIF, "--raiz", RAIZ, "--manifest", F], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /^MATCH \d+ archivos/m);
  });
  test("formato, versión, commit base (f2a6598 = v3.15.0, lo publicado) y matriz de versiones = lo que dice el código", () => {
    assert.equal(M.format, "entimotors-release-freeze/1"); assert.equal(M.version, "3.16.0"); assert.equal(M.base_commit, BASE);
    const app = fs.readFileSync(path.join(RAIZ, "taller-demo/app.js"), "utf8"), sw = fs.readFileSync(path.join(RAIZ, "taller-demo/sw.js"), "utf8"), idx = fs.readFileSync(path.join(RAIZ, "taller-demo/index.html"), "utf8");
    assert.equal(M.version_matrix.VERSION_APP, /const VERSION_APP = "([^"]+)"/.exec(app)[1]);
    assert.equal(M.version_matrix.CACHE_NAME, /const CACHE_NAME = "([^"]+)"/.exec(sw)[1]);
    assert.equal(M.version_matrix.index_html_query_v, (idx.match(/<script src="[^"?]+\?v=3\.16\.0"/g) || []).length);
    assert.deepEqual([M.version_matrix.index_html_query_v, M.version_matrix.sw_shell_query_v, M.version_matrix.sw_shell_total], [21, 20, 25]);
    assert.equal(M.version_matrix.panel_tecnico, "3.16.0");
  });
  test("runtime_files = TODO lo del repositorio en taller-demo/ salvo supabase/ y la documentación; sin migraciones (solo frontends)", () => {
    const esperado = delRepo("taller-demo").filter((p) => !p.startsWith("taller-demo/supabase/") && !/^taller-demo\/(README|CHANGELOG)\.md$/.test(p));
    assert.deepEqual(M.runtime_files.map((e) => e.path), esperado);
    assert.deepEqual(M.documentation_files.map((e) => e.path), ["taller-demo/CHANGELOG.md", "taller-demo/README.md"]);
    assert.deepEqual(M.database_files, []);
  });
  test("respecto de 3.15.0 (f2a6598): nuevos EXACTAMENTE fotos-avance.js y mensajes-fijos.js; cambian app.js, usuarios.js, index.html, sw.js, panel-tecnico.html y el build del Taller", () => {
    const base = raiz3150();
    const nuevos = M.runtime_files.filter((e) => !fs.existsSync(path.join(base, e.path))).map((e) => e.path.replace("taller-demo/", ""));
    assert.deepEqual(nuevos.sort(), ["fotos-avance.js", "mensajes-fijos.js"]);
    const cambian = M.runtime_files.filter((e) => fs.existsSync(path.join(base, e.path)) && sha(path.join(base, e.path)) !== e.sha256).map((e) => e.path.replace("taller-demo/", ""));
    assert.deepEqual(cambian.sort(), ["app.js", "hacer-build-taller.sh", "index.html", "panel-tecnico.html", "sw.js", "usuarios.js"]);
    const db = (p) => fs.readdirSync(path.join(p, "taller-demo/supabase/sync")).sort();
    assert.deepEqual(db(RAIZ), db(base), "3.16.0 no añade ni quita migraciones");
    assert.equal(spawnSync("git", ["-C", RAIZ, "diff", "--quiet", BASE, "--", "api-server", "taller-demo/supabase"]).status, 0, "3.16.0 no toca api-server/ ni la base");
  });
  test("la lista del Taller es la del build (con los dos módulos nuevos) y no publica nada técnico", () => {
    const build = fs.readFileSync(path.join(RAIZ, "taller-demo/hacer-build-taller.sh"), "utf8");
    const lista = /^PUBLICAR=\(([\s\S]*?)\)/m.exec(build)[1].split(/\s+/).filter((x) => /\.(html|json|js|png)$/.test(x)).sort();
    assert.deepEqual(M.publicacion.taller_lista, lista); assert.equal(lista.length, 29);
    for (const f of ["fotos-avance.js", "mensajes-fijos.js"]) assert.ok(lista.includes(f), f);
    assert.ok(!M.publicacion.taller_lista.some((f) => /panel-tecnico|config-local|hacer-build|build-mecanicos|README|CHANGELOG|supabase\//.test(f)));
  });
  test("las pruebas de release de 3.16.0 están en la lista y ninguna falta en disco", () => {
    const t = M.test_files.map((e) => e.path);
    for (const f of ["pruebas/multiusuario/01-pwa-3.16.0.test.mjs", "pruebas/multiusuario/16f-alcance-3.16.0.test.mjs", "pruebas/multiusuario/26e-manifest-3.16.0.test.mjs",
      "pruebas/multiusuario/helpers/usar-3151.mjs", "pruebas/multiusuario/helpers/congelado-3.15.1.mjs", "pruebas/multiusuario/32-toast-xss-nombres.test.mjs",
      "pruebas/ui-telefono/revisar.py", "pruebas/ui-telefono/t10_entrada.py", "pruebas/sync/node/c1-fotos-avance.test.mjs", "pruebas/sync/node/c6-mensajes-fijos.test.mjs"]) assert.ok(t.includes(f), f);
    for (const f of t) assert.ok(fs.existsSync(path.join(RAIZ, f)), f);
  });
  test("estado real y alcance limpio: los pendientes de 3.15.0 siguen declarados; nada de laboratorio, respaldos ni privados; sin secretos", () => {
    assert.ok(M.pendiente_conocido.some((x) => /^PHONE_RESCUE: DEFERRED/.test(x))); assert.ok(M.pendiente_conocido.some((x) => /protección TEMPORAL/.test(x)));
    for (const p of [...M.runtime_files, ...M.documentation_files, ...M.test_files].map((e) => e.path)) {
      assert.match(p, /^(taller-demo|pruebas)\//, p);
      assert.doesNotMatch(p, /respaldo-20|prerelease-lab|record119|privado|captura|lector|salida\/|node_modules|__pycache__|config-local\.js$|\.env$|\.dump$|\.log$|pgpass|pg_service/i, p);
    }
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.|sb_secret_|sb_publishable_|service_role"\s*:\s*"[^"]{10}|supabase\.co/.test(JSON.stringify(M)));
  });
});
