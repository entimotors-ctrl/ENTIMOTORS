// MANIFEST DE RELEASE 3.15.1 (árbol de trabajo): release-3.15.1-manifest.json. LISTA CERRADA con SHA-256 y tamaño de la fuente que se confirma:
// runtime del frontend (Taller y la base de Mi Trabajo), su documentación y sus pruebas de release. 3.15.1 es SOLO frontends: no hay migraciones
// (database_files vacío) y el backend sigue siendo el de 3.15.0 (release-3.15.0-backend-manifest.json, 26c). Mismo formato y verificador.
// Además fija QUÉ cambia respecto de lo publicado en 3.15.0 (tag v3.15.0 → f2a6598): exactamente la corrección TOAST-XSS y la versión.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { RAIZ } from "./helpers/entorno.mjs";
import { raiz3150 } from "./helpers/congelado-3.15.0.mjs";
// 3.16.0: el árbol de trabajo ya cambia a propósito → este freeze se comprueba contra la 3.15.1 terminada (commit 746744c, git archive y
// git ls-tree, solo lectura). Las aserciones no cambian: solo de DÓNDE se leen los archivos. El manifest de 3.16.0 está en 26e.
import { raiz3151, archivosDe3151 } from "./helpers/congelado-3.15.1.mjs";
const R = raiz3151();

const F = "pruebas/multiusuario/release-3.15.1-manifest.json";
const VERIF = path.join(RAIZ, "pruebas/multiusuario/verificar-backend-manifest.mjs");
const M = JSON.parse(fs.readFileSync(path.join(R, F), "utf8"));
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
// lo que la 3.15.1 terminada lleva (git ls-tree del commit 746744c)
const delRepo = (prefijo) => archivosDe3151(prefijo).sort();

describe("release 3.15.1 · manifest cerrado de la fuente (frontend, documentación y pruebas de release)", () => {
  test("MATCH: cada archivo listado existe con su SHA-256 y su tamaño", () => {
    const r = spawnSync(process.execPath, [VERIF, "--raiz", R, "--manifest", F], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /^MATCH \d+ archivos/m);
  });
  test("formato, versión, commit base (f2a6598 = v3.15.0) y matriz de versiones = lo que dice el código", () => {
    assert.equal(M.format, "entimotors-release-freeze/1"); assert.equal(M.version, "3.15.1"); assert.equal(M.base_commit, "f2a659870d1a485551cedc601b07490e804faed4");
    const app = fs.readFileSync(path.join(R, "taller-demo/app.js"), "utf8"), sw = fs.readFileSync(path.join(R, "taller-demo/sw.js"), "utf8"), idx = fs.readFileSync(path.join(R, "taller-demo/index.html"), "utf8");
    assert.equal(M.version_matrix.VERSION_APP, /const VERSION_APP = "([^"]+)"/.exec(app)[1]);
    assert.equal(M.version_matrix.CACHE_NAME, /const CACHE_NAME = "([^"]+)"/.exec(sw)[1]);
    assert.equal(M.version_matrix.index_html_query_v, (idx.match(/<script src="[^"?]+\?v=3\.15\.1"/g) || []).length);
    assert.deepEqual([M.version_matrix.index_html_query_v, M.version_matrix.sw_shell_query_v, M.version_matrix.sw_shell_total], [19, 18, 23]);
    assert.equal(M.version_matrix.panel_tecnico, "3.15.1");
  });
  test("runtime_files = TODO lo del repositorio en taller-demo/ salvo supabase/ y la documentación; sin migraciones (solo frontends)", () => {
    const esperado = delRepo("taller-demo").filter((p) => !p.startsWith("taller-demo/supabase/") && !/^taller-demo\/(README|CHANGELOG)\.md$/.test(p));
    assert.deepEqual(M.runtime_files.map((e) => e.path), esperado);
    assert.deepEqual(M.documentation_files.map((e) => e.path), ["taller-demo/CHANGELOG.md", "taller-demo/README.md"]);
    assert.deepEqual(M.database_files, []);
  });
  test("respecto de 3.15.0 (f2a6598) cambian EXACTAMENTE app.js, usuarios.js, index.html, sw.js y panel-tecnico.html; ningún archivo nuevo", () => {
    const base = raiz3150();
    const nuevos = M.runtime_files.filter((e) => !fs.existsSync(path.join(base, e.path))).map((e) => e.path);
    assert.deepEqual(nuevos, []);
    const cambian = M.runtime_files.filter((e) => sha(path.join(base, e.path)) !== e.sha256).map((e) => e.path.replace("taller-demo/", ""));
    assert.deepEqual(cambian.sort(), ["app.js", "index.html", "panel-tecnico.html", "sw.js", "usuarios.js"]);
    const db = (p) => fs.readdirSync(path.join(p, "taller-demo/supabase/sync")).sort();
    assert.deepEqual(db(R), db(base), "3.15.1 no añade ni quita migraciones");
    const api = () => spawnSync("git", ["-C", RAIZ, "diff", "--quiet", "f2a659870d1a485551cedc601b07490e804faed4", "746744c52cdae8fefa762e835fcb24907e7a6ee0", "--", "api-server"]).status;
    assert.equal(api(), 0, "3.15.1 no toca api-server/");
  });
  /* app.js respecto de 3.15.0: lista EXACTA de líneas de CÓDIGO (sin comentarios) que se quitan y que se añaden. Cada arreglo que entra en
     3.15.1 se declara aquí; un cambio no declarado hace fallar esta prueba. Arreglos: TOAST-XSS (toast escapa), LOGIN-ESTADO (aviso del
     login), OBS-E1a (etapas y selectores del detalle confirman) y VERSION_APP. */
  const APP_QUITA = [
    "  el.innerHTML = `<span class=\"dot ${kind}\"></span>${msg}`;",
    "  el.textContent = hay",
    "    ? (navigator.onLine ? \"Conectado al servidor — entra con tu correo.\" : \"Sin señal — solo acceso local.\")",
    "          r.motivo === \"sin-conexion\"           ? \"Sin conexión con el servidor. Entra con tu usuario local.\" :",
    "  document.getElementById(\"detalleOrigenSel\").value = origenTrabajoDe(o);",
    "  document.getElementById(\"detalleMecanicoSel\").addEventListener(\"change\", async (e) => {",
    "  document.getElementById(\"detalleOrigenSel\").addEventListener(\"change\", async (e) => {",
    "    await updateOrder(o.id, ord => { ord.origenTrabajo = e.target.value === \"negocio\" ? \"negocio\" : \"taller\"; });",
    "const VERSION_APP = \"3.15.0\";",
  ];
  const APP_PONE = [
    "  el.innerHTML = `<span class=\"dot ${kind}\"></span>${esc(msg)}`;",
    "const loginLocalDisponible = () => PERMITE_LOGIN_LOCAL && modoDesarrollo();",
    "const AVISO_SERVIDOR_NO_RESPONDE = \"El servidor no responde ahora. Revisa la conexión y vuelve a intentarlo en un momento.\";",
    "  el.textContent = !hay ? \"\"",
    "    : navigator.onLine ? \"Con internet — entra con tu correo.\"",
    "    : loginLocalDisponible() ? \"Sin señal — solo acceso local.\" : \"Sin señal — para entrar hace falta internet.\";",
    "          r.motivo === \"sin-conexion\"           ? (loginLocalDisponible() ? \"Sin conexión con el servidor. Entra con tu usuario local.\"",
    "                                                                          : \"Sin conexión con el servidor. Revisa tu internet y vuelve a intentarlo.\") :",
    "        if (r.motivo === \"sin-conexion\" && navigator.onLine) { const m = document.getElementById(\"loginModo\"); if (m) m.textContent = AVISO_SERVIDOR_NO_RESPONDE; }",
    "  const selMec = document.getElementById(\"detalleMecanicoSel\"), selOrigen = document.getElementById(\"detalleOrigenSel\");",
    "  selOrigen.value = origenTrabajoDe(o);",
    "  let mecGuardado = selMec.value, origenGuardado = selOrigen.value;",
    "  selMec.addEventListener(\"change\", async () => {",
    "    const nombre = selMec.selectedOptions?.[0]?.textContent?.trim() || \"sin asignar\";",
    "    if (!(await showConfirm(`¿Asignar la orden #${o.id} a «${nombre}»?`, { titulo: \"Cambiar mecánico\", textoOk: \"Sí, asignar\" }))) {",
    "      selMec.value = mecGuardado; return;",
    "    mecGuardado = selMec.value;",
    "  selOrigen.addEventListener(\"change\", async (e) => {",
    "    const origen = e.target.value === \"negocio\" ? \"negocio\" : \"taller\";",
    "    if (!(await showConfirm(`¿Marcar la orden #${o.id} como trabajo del ${origen === \"negocio\" ? \"negocio\" : \"taller\"}?`, { titulo: \"Origen del trabajo\", textoOk: \"Sí, cambiar\" }))) {",
    "      selOrigen.value = origenGuardado; return;",
    "    await updateOrder(o.id, ord => { ord.origenTrabajo = origen; });",
    "    origenGuardado = origen;",
    "      if (i === idx) return;",
    "      if (!(await showConfirm(`¿Pasar la orden #${currentOrderId} a «${STAGES[i].label}»?`, { titulo: \"Cambiar etapa\", textoOk: \"Sí, cambiar\" }))) return;",
    "const VERSION_APP = \"3.15.1\";",
  ];
  const codigo = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
  test("app.js respecto de 3.15.0: cambian EXACTAMENTE las líneas de código declaradas (TOAST-XSS, LOGIN-ESTADO, OBS-E1a y VERSION_APP)", () => {
    const antes = codigo(fs.readFileSync(path.join(raiz3150(), "taller-demo/app.js"), "utf8")), ahora = codigo(fs.readFileSync(path.join(R, "taller-demo/app.js"), "utf8"));
    const sa = new Set(antes), sb = new Set(ahora);
    assert.deepEqual(antes.filter((l) => !sb.has(l)), APP_QUITA);
    assert.deepEqual(ahora.filter((l) => !sa.has(l)), APP_PONE);
  });
  test("la lista del Taller es la del build y no publica nada técnico", () => {
    const build = fs.readFileSync(path.join(R, "taller-demo/hacer-build-taller.sh"), "utf8");
    const lista = /^PUBLICAR=\(([\s\S]*?)\)/m.exec(build)[1].split(/\s+/).filter((x) => /\.(html|json|js|png)$/.test(x)).sort();
    assert.deepEqual(M.publicacion.taller_lista, lista); assert.equal(lista.length, 27);
    assert.ok(!M.publicacion.taller_lista.some((f) => /panel-tecnico|config-local|hacer-build|build-mecanicos|README|CHANGELOG|supabase\//.test(f)));
  });
  test("las pruebas de release de 3.15.1 están en la lista y ninguna falta en disco", () => {
    const t = M.test_files.map((e) => e.path);
    for (const f of ["pruebas/multiusuario/01-pwa-3.15.1.test.mjs", "pruebas/multiusuario/16e-alcance-3.15.1.test.mjs", "pruebas/multiusuario/26d-manifest-3.15.1.test.mjs",
      "pruebas/multiusuario/32-toast-xss-nombres.test.mjs", "pruebas/multiusuario/helpers/usar-3150.mjs", "pruebas/multiusuario/helpers/congelado-3.15.0.mjs"]) assert.ok(t.includes(f), f);
    for (const f of t) assert.ok(fs.existsSync(path.join(R, f)), f);
  });
  test("estado real y alcance limpio: los pendientes de 3.15.0 siguen declarados; nada de laboratorio, respaldos ni privados; sin secretos", () => {
    assert.ok(M.pendiente_conocido.some((x) => /^PHONE_RESCUE: DEFERRED/.test(x))); assert.ok(M.pendiente_conocido.some((x) => /protección TEMPORAL/.test(x)));
    for (const p of [...M.runtime_files, ...M.documentation_files, ...M.test_files].map((e) => e.path)) {
      assert.match(p, /^(taller-demo|pruebas)\//, p);
      assert.doesNotMatch(p, /respaldo-20|prerelease-lab|record119|privado|captura|lector|salida\/|node_modules|config-local\.js$|\.env$|\.dump$|\.log$|pgpass|pg_service/i, p);
    }
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.|sb_secret_|sb_publishable_|service_role"\s*:\s*"[^"]{10}|supabase\.co/.test(JSON.stringify(M)));
  });
});
