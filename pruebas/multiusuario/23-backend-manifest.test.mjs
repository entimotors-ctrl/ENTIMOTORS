// OBS-9 · PLAN B (4E-C7-FIX-B) — EVIDENCIA SEPARADA DEL BACKEND: pruebas/multiusuario/release-3.13.0-backend-manifest.json + su verificador determinista.
// El manifest del frontend (release-3.13.0-manifest.json) no cubre api-server/; este lo cubre. Aqui se comprueba que:
//   · el verificador dice MATCH sobre el repositorio real;
//   · una COPIA TEMPORAL alterada da MANIFEST_MISMATCH (y una copia sin un archivo, MANIFEST_MISSING) SIN tocar ningun archivo real;
//   · el verificador es deterministico (misma salida, desde cualquier directorio) y falla cerrado ante un manifest malo;
//   · el manifest lista lo que debe (la ruta modificada, sus dependencias directas, las pruebas nuevas) y no contiene secretos;
//   · desde 4E-C9 cubre tambien api-server/dist/ (grupo `generated_build_artifacts`: los 10 archivos compilados y versionados) y declara la politica del dist y el estado de Render;
//   · el manifest del frontend referencia al del backend con su SHA-256 real.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
// 3.14.0: el backend del árbol de trabajo cambia a propósito (PIN, CORS selectivo), así que la integridad del freeze de 3.13.0 se comprueba contra
// la instantánea inmutable del tag v3.13.0 (helpers/congelado.mjs), no contra el árbol de trabajo. Ver pruebas/sync/README.md.
import { RAIZ_313 as RAIZ } from "./helpers/congelado.mjs";

const VERIFICADOR = path.join(RAIZ, "pruebas/multiusuario/verificar-backend-manifest.mjs");
const REL_MANIFEST = "pruebas/multiusuario/release-3.13.0-backend-manifest.json", REL_FRONT = "pruebas/multiusuario/release-3.13.0-manifest.json";
const MANIFEST = JSON.parse(fs.readFileSync(path.join(RAIZ, REL_MANIFEST), "utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const fuente = () => [...MANIFEST.runtime_files, ...MANIFEST.test_files].map((e) => e.path);
const compilados = () => MANIFEST.generated_build_artifacts.map((e) => e.path); // api-server/dist/* (4E-C9): artefacto generado, versionado
const archivos = () => [...fuente(), ...compilados()];
const correr = (raiz, cwd = RAIZ, extra = []) => { const r = spawnSync(process.execPath, [VERIFICADOR, ...(raiz ? ["--raiz", raiz] : []), ...extra], { cwd, encoding: "utf8" }); return { codigo: r.status, salida: r.stdout, error: r.stderr }; };
const huella = (lista) => Object.fromEntries(lista.map((p) => [p, sha(fs.readFileSync(path.join(RAIZ, p)))]));
/** Copia temporal (os.tmpdir) con SOLO los archivos del manifest + el manifest; nunca se toca el repositorio. */
function copiaTemporal() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-backend-manifest-"));
  for (const p of [...archivos(), REL_MANIFEST]) { const dest = path.join(d, ...p.split("/")); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(RAIZ, p), dest); }
  return d;
}

describe("backend manifest · el repositorio real coincide", () => {
  test("el verificador imprime «MATCH N archivos» y sale con 0", () => {
    const r = correr(); assert.equal(r.codigo, 0, r.salida + r.error); assert.equal(r.salida.trim(), `MATCH ${archivos().length} archivos`); assert.equal(r.error, "");
  });
  test("es DETERMINISTA: dos corridas, y desde otro directorio de trabajo, dan la MISMA salida", () => {
    const a = correr(), b = correr(), c = correr(RAIZ, os.tmpdir()); assert.deepEqual([a.salida, a.codigo], [b.salida, b.codigo]); assert.deepEqual([a.salida, a.codigo], [c.salida, c.codigo]);
  });
  test("el hash de cada archivo es el SHA-256 de sus bytes exactos (recomputado aquí de forma independiente)", () => {
    for (const e of [...MANIFEST.runtime_files, ...MANIFEST.test_files, ...MANIFEST.generated_build_artifacts]) { const b = fs.readFileSync(path.join(RAIZ, e.path)); assert.equal(e.sha256, sha(b), e.path); assert.equal(e.bytes, b.length, e.path); }
  });
});

describe("backend manifest · una copia temporal ALTERADA se detecta (sin tocar archivos reales)", () => {
  test("copia intacta → MATCH (control)", () => { const d = copiaTemporal(); try { const r = correr(d); assert.equal(r.codigo, 0); assert.match(r.salida, /^MATCH \d+ archivos/); } finally { fs.rmSync(d, { recursive: true, force: true }); } });
  test("un byte cambiado en api-server/src/routes/admin-usuarios.ts → MANIFEST_MISMATCH de ESE archivo, FAIL y salida 1; y el archivo REAL sigue igual", () => {
    const antes = huella(archivos()); const d = copiaTemporal();
    try {
      const f = path.join(d, "api-server/src/routes/admin-usuarios.ts"); fs.appendFileSync(f, " ");
      const r = correr(d); assert.equal(r.codigo, 1); assert.match(r.salida, /^MANIFEST_MISMATCH api-server\/src\/routes\/admin-usuarios\.ts$/m); assert.match(r.salida, /^FAIL 1 problemas$/m); assert.ok(!/MATCH \d+ archivos/.test(r.salida));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
    assert.deepEqual(huella(archivos()), antes, "el verificador o la copia tocaron un archivo REAL");
    assert.equal(correr().codigo, 0, "el repositorio real sigue en MATCH");
  });
  test("un byte cambiado en un archivo de PRUEBAS del backend, en una dependencia directa y en el lockfile → un MISMATCH por cada uno", () => {
    const d = copiaTemporal();
    try {
      for (const rel of ["pruebas/multiusuario/21-backend-enlace-recuperacion.test.mjs", "api-server/src/app.ts", "api-server/pnpm-lock.yaml"]) fs.appendFileSync(path.join(d, ...rel.split("/")), "\n");
      const r = correr(d); assert.equal(r.codigo, 1); const lineas = r.salida.trim().split("\n"); assert.equal(lineas.filter((l) => l.startsWith("MANIFEST_MISMATCH ")).length, 3); assert.equal(lineas.at(-1), "FAIL 3 problemas");
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("mismo tamaño pero contenido distinto (un caracter sustituido) → MISMATCH (no basta con comparar tamaños)", () => {
    const d = copiaTemporal();
    try { const f = path.join(d, "api-server/src/lib/logger.ts"); const t = fs.readFileSync(f, "utf8"); fs.writeFileSync(f, t.replace("info", "infX")); assert.equal(fs.statSync(f).size, MANIFEST.runtime_files.find((e) => e.path === "api-server/src/lib/logger.ts").bytes); const r = correr(d); assert.equal(r.codigo, 1); assert.match(r.salida, /MANIFEST_MISMATCH api-server\/src\/lib\/logger\.ts/); }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("un archivo AUSENTE → MANIFEST_MISSING", () => {
    const d = copiaTemporal(); try { fs.rmSync(path.join(d, "api-server/src/routes/index.ts")); const r = correr(d); assert.equal(r.codigo, 1); assert.match(r.salida, /^MANIFEST_MISSING api-server\/src\/routes\/index\.ts$/m); } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("un manifest ILEGIBLE o de otro formato falla cerrado", () => {
    const d = copiaTemporal(); try { const m = path.join(d, REL_MANIFEST); fs.writeFileSync(m, "{ no es json"); assert.equal(correr(d).codigo, 1); assert.match(correr(d).salida, /MANIFEST_ILEGIBLE/); const o = JSON.parse(JSON.stringify(MANIFEST)); o.format = "otro/9"; fs.writeFileSync(m, JSON.stringify(o)); assert.match(correr(d).salida, /MANIFEST_FORMATO/); assert.equal(correr(d).codigo, 1); } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("rutas peligrosas (absoluta, «..», con «\\», duplicada) o lista sin ordenar → problema (falla cerrado)", () => {
    const casos = [["MANIFEST_RUTA_INVALIDA", (m) => { m.runtime_files[0].path = "/etc/passwd"; }], ["MANIFEST_RUTA_INVALIDA", (m) => { m.runtime_files[0].path = "../fuera.txt"; }], ["MANIFEST_RUTA_INVALIDA", (m) => { m.runtime_files[0].path = "api-server\\src\\app.ts"; }],
      ["MANIFEST_DUPLICADO", (m) => { m.runtime_files[1].path = m.runtime_files[0].path; m.runtime_files[1].sha256 = m.runtime_files[0].sha256; m.runtime_files[1].bytes = m.runtime_files[0].bytes; }], ["MANIFEST_SIN_ORDENAR", (m) => { m.test_files.reverse(); }],
      ["MANIFEST_ENTRADA_MAL_FORMADA", (m) => { m.runtime_files[0].sha256 = "xyz"; }], ["MANIFEST_GRUPO_VACIO", (m) => { m.test_files = []; }]];
    for (const [esperado, alterar] of casos) { const d = copiaTemporal(); try { const m = JSON.parse(JSON.stringify(MANIFEST)); alterar(m); fs.writeFileSync(path.join(d, REL_MANIFEST), JSON.stringify(m)); const r = correr(d); assert.equal(r.codigo, 1, esperado); assert.ok(r.salida.includes(esperado), `${esperado}: ${r.salida}`); } finally { fs.rmSync(d, { recursive: true, force: true }); } }
  });
  test("--regenerar sobre la COPIA reescribe los hashes de lo ya listado (y el verificador vuelve a dar MATCH); el manifest REAL no cambia", () => {
    const real = fs.readFileSync(path.join(RAIZ, REL_MANIFEST), "utf8"); const d = copiaTemporal();
    try { fs.appendFileSync(path.join(d, "api-server/src/app.ts"), "// alterado\n"); assert.equal(correr(d).codigo, 1); const r = correr(d, RAIZ, ["--regenerar"]); assert.equal(r.codigo, 0, r.salida); assert.match(r.salida, /^REGENERADO \d+ archivos/); assert.equal(correr(d).codigo, 0); } finally { fs.rmSync(d, { recursive: true, force: true }); }
    assert.equal(fs.readFileSync(path.join(RAIZ, REL_MANIFEST), "utf8"), real, "--regenerar tocó el manifest real"); assert.equal(correr().codigo, 0);
  });
});

describe("backend manifest · qué cubre", () => {
  const paths = archivos();
  test("lista el archivo modificado (change «modified») y sus dependencias DIRECTAS del flujo (montaje de rutas, app, logger, variables, dependencias)", () => {
    const mod = MANIFEST.runtime_files.filter((e) => e.change === "modified").map((e) => e.path); assert.deepEqual(mod, ["api-server/src/routes/admin-usuarios.ts"]);
    for (const p of ["api-server/src/routes/index.ts", "api-server/src/app.ts", "api-server/src/lib/logger.ts", "api-server/.env.example", "api-server/package.json", "api-server/pnpm-lock.yaml"]) assert.ok(paths.includes(p), p);
    for (const e of MANIFEST.runtime_files) assert.ok(["modified", "dependency-unchanged"].includes(e.change), `${e.path}: change=${e.change}`);
  });
  test("lista las pruebas y ayudantes del backend (incluida la del bundle compilado), el verificador y esta prueba", () => {
    for (const p of ["pruebas/multiusuario/21-backend-enlace-recuperacion.test.mjs", "pruebas/multiusuario/23-backend-manifest.test.mjs", "pruebas/multiusuario/24-backend-dist-enlace.test.mjs", "pruebas/multiusuario/helpers/backend-admin-usuarios.mjs", "pruebas/multiusuario/helpers/ts-a-js.mjs", "pruebas/multiusuario/verificar-backend-manifest.mjs"]) assert.ok(paths.includes(p), p);
  });
  test("no contiene secretos (service_role, JWT, sb_secret_, claves) ni el host real de produccion", () => {
    const t = fs.readFileSync(path.join(RAIZ, REL_MANIFEST), "utf8"); assert.ok(!/service_role|eyJ[A-Za-z0-9_-]{10,}\.|sb_secret_|sb_publishable_|SUPABASE_SERVICE_KEY\s*[:=]\s*\S{8,}|supabase\.co/i.test(t));
  });
  test("declara lo que NO cubre ni se hizo: Supabase real, Render, SQL, deploy, publicación y correo; y los prerrequisitos de despliegue (variables, Redirect URLs y la confirmación del build de Render)", () => {
    for (const k of ["supabase_real", "render", "sql_produccion", "deploy", "publicacion", "envio_de_correo"]) assert.ok(MANIFEST.no_ejecutado.includes(k), k);
    assert.ok(!MANIFEST.no_ejecutado.includes("build_de_dist"), "el build de dist SÍ se ejecutó en 4E-C9: ya no puede figurar como no ejecutado");
    assert.ok(MANIFEST.prerrequisitos_de_despliegue.some((x) => /ENTIMOTORS_ADMIN_ORIGIN/.test(x) && /ENTIMOTORS_MECHANIC_ORIGIN/.test(x))); assert.ok(MANIFEST.prerrequisitos_de_despliegue.some((x) => /Redirect URLs/.test(x)));
    assert.ok(MANIFEST.prerrequisitos_de_despliegue.some((x) => /Build Command/.test(x) && /Render/.test(x)), "falta el prerrequisito de confirmar el Build Command de Render");
  });
  test("cada archivo de FUENTE y de PRUEBAS existe y ninguno es de node_modules, dist ni .env (el dist compilado va en su propio grupo)", () => { for (const p of fuente()) { assert.ok(fs.existsSync(path.join(RAIZ, p)), p); assert.ok(!/node_modules|(^|\/)dist\/|(^|\/)\.env$/.test(p), p); } });
});

describe("backend manifest · api-server/dist (artefacto COMPILADO y versionado)", () => {
  const dist = path.join(RAIZ, "api-server", "dist");
  test("el grupo generated_build_artifacts lista EXACTAMENTE los archivos de api-server/dist/ (ni uno más, ni uno menos), todos clasificados GENERATED_BUILD_ARTIFACT", () => {
    assert.deepEqual(compilados(), fs.readdirSync(dist).sort().map((f) => `api-server/dist/${f}`)); assert.equal(compilados().length, 10);
    for (const e of MANIFEST.generated_build_artifacts) { assert.equal(e.classification, "GENERATED_BUILD_ARTIFACT", e.path); assert.ok(["regenerated", "rebuilt-path-only", "unchanged"].includes(e.change), `${e.path}: change=${e.change}`); }
  });
  test("qué cambió respecto del dist de HEAD: index.mjs y su mapa se REGENERARON (ruta nueva); pino-file y pino-worker solo cambian la ruta absoluta de compilación; pino-pretty y thread-stream-worker, idénticos", () => {
    const c = Object.fromEntries(MANIFEST.generated_build_artifacts.map((e) => [e.path.replace("api-server/dist/", ""), e.change]));
    assert.deepEqual(c, { "index.mjs": "regenerated", "index.mjs.map": "regenerated", "pino-file.mjs": "rebuilt-path-only", "pino-file.mjs.map": "rebuilt-path-only", "pino-pretty.mjs": "unchanged", "pino-pretty.mjs.map": "unchanged", "pino-worker.mjs": "rebuilt-path-only", "pino-worker.mjs.map": "rebuilt-path-only", "thread-stream-worker.mjs": "unchanged", "thread-stream-worker.mjs.map": "unchanged" });
  });
  test("un byte cambiado en api-server/dist/index.mjs (copia temporal) → MANIFEST_MISMATCH de ESE archivo; un archivo de dist AUSENTE → MANIFEST_MISSING; el repositorio real sigue en MATCH", () => {
    const antes = huella(compilados()); let d = copiaTemporal();
    try { fs.appendFileSync(path.join(d, "api-server/dist/index.mjs"), "\n"); const r = correr(d); assert.equal(r.codigo, 1); assert.match(r.salida, /^MANIFEST_MISMATCH api-server\/dist\/index\.mjs$/m); assert.match(r.salida, /^FAIL 1 problemas$/m); } finally { fs.rmSync(d, { recursive: true, force: true }); }
    d = copiaTemporal(); try { fs.rmSync(path.join(d, "api-server/dist/pino-worker.mjs")); const r = correr(d); assert.equal(r.codigo, 1); assert.match(r.salida, /^MANIFEST_MISSING api-server\/dist\/pino-worker\.mjs$/m); } finally { fs.rmSync(d, { recursive: true, force: true }); }
    assert.deepEqual(huella(compilados()), antes, "la copia tocó el dist REAL"); assert.equal(correr().codigo, 0);
  });
  test("dist_versionado declara la política (VERSIONED), la clasificación y cómo se generó; render declara que el Build Command NO está en el repositorio y necesita confirmación manual", () => {
    const d = MANIFEST.dist_versionado; assert.equal(d.politica, "VERSIONED"); assert.equal(d.clasificacion, "GENERATED_BUILD_ARTIFACT"); assert.match(d.estado, /REGENERADO/); assert.match(d.como_se_genero, /pnpm install --frozen-lockfile/); assert.match(d.como_se_genero, /pnpm run build/);
    assert.match(d.ruta_absoluta_embebida, /no es un secreto|NO es un secreto/i); assert.ok(!/NO regenerado/.test(JSON.stringify(d)), "dist_versionado aún dice que no se regeneró");
    const r = MANIFEST.render; assert.equal(r.config_en_el_repositorio, false); assert.equal(r.estado, "RENDER_BUILD_COMMAND_NEEDS_MANUAL_CONFIRMATION"); assert.ok(Array.isArray(r.confirmar_antes_de_desplegar) && r.confirmar_antes_de_desplegar.length >= 4);
  });
  test("el bundle NUEVO trae la ruta (`/admin/usuarios/:id/enlace`) y `enlaceParaEstablecerClave`, y ninguna ruta retirada; el manifest no guarda ninguna ruta de usuario de la máquina", () => {
    const t = fs.readFileSync(path.join(dist, "index.mjs"), "utf8"); assert.ok(t.includes('"/admin/usuarios/:id/enlace"')); assert.ok(t.includes("enlaceParaEstablecerClave"));
    assert.ok(!/\/home\/[a-z][a-z0-9_-]*\//i.test(fs.readFileSync(path.join(RAIZ, REL_MANIFEST), "utf8")), "el manifest contiene una ruta absoluta de usuario");
  });
});

describe("backend manifest · lo referencia el manifest del frontend", () => {
  test("release-3.13.0-manifest.json trae `backend_manifest` con la ruta, el SHA-256 y el tamaño REALES de este manifest", () => {
    const f = JSON.parse(fs.readFileSync(path.join(RAIZ, REL_FRONT), "utf8")), b = fs.readFileSync(path.join(RAIZ, REL_MANIFEST));
    assert.deepEqual(f.backend_manifest, { path: REL_MANIFEST, sha256: sha(b), bytes: b.length });
  });
  test("el manifest del frontend YA NO dice que api-server/ no cambió, y el freeze doc nombra los dos manifests y el comando del verificador", () => {
    const f = JSON.parse(fs.readFileSync(path.join(RAIZ, REL_FRONT), "utf8")); assert.ok(!f.unchanged_since_base_commit.includes("api-server/"), "api-server/ cambió en esta fase");
    const doc = fs.readFileSync(path.join(RAIZ, "pruebas/multiusuario/RELEASE-FREEZE-3.13.0.md"), "utf8"); assert.ok(doc.includes("release-3.13.0-backend-manifest.json") && doc.includes("release-3.13.0-manifest.json") && doc.includes("verificar-backend-manifest.mjs"));
  });
});
