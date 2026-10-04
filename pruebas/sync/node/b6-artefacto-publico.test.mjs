// 3.15.0 · Bloque 6 · el ARTEFACTO PUBLICABLE (no el código fuente): se generan de verdad el build del Taller (hacer-build-taller.sh, GitHub
// Pages) y el de Mi Trabajo (hacer-build-mecanicos.sh, Netlify) en una carpeta temporal y se examina lo que se publicaría.
//   L12 URL del Gestor Web · L13 sin credenciales · L14 panel técnico · L15 config-local · L16 sin archivos técnicos · L17/L18 sin textos
//   demo (parte estática; la de pantalla va en b6-producto-app-real) · L19 HUD de Netlify oculto · L21 caché/actualización coherente
//   node --test pruebas/sync/node/b6-artefacto-publico.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROHIBIDAS, PERMITIDAS, prohibidasEn } from "./helpers/no-demo.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEMO = path.join(RAIZ, "taller-demo");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-b6-art-"));
const TALLER = path.join(T, "taller"), MT = path.join(T, "mitrabajo");
const leer = (d, f) => fs.readFileSync(path.join(d, f), "utf8");
const archivos = (d) => { const out = []; (function w(x) { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); e.isDirectory() ? w(p) : out.push(path.relative(d, p)); } })(d); return out.sort(); };
before(() => {
  for (const [s, d] of [["hacer-build-taller.sh", TALLER], ["hacer-build-mecanicos.sh", MT]]) {
    const r = spawnSync("bash", [path.join(DEMO, s), d], { encoding: "utf8" });
    assert.equal(r.status, 0, `${s}: ${r.stderr}`);
  }
});
after(() => fs.rmSync(T, { recursive: true, force: true }));

/** Texto VISIBLE de un HTML estático: sin comentarios, <script>, <style>, atributos ni etiquetas. */
function textoVisible(html) {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
}

test("L16 · el artefacto del Taller es EXACTAMENTE su lista; ninguno de los dos publica archivos técnicos", () => {
  const t = archivos(TALLER), m = archivos(MT);
  assert.equal(t.length, 27, t.join(", "));
  for (const lista of [t, m]) for (const f of lista) {
    assert.doesNotMatch(f, /\.(sh|md|sql)$|panel-tecnico|config-local|build-mecanicos|supabase\//, f);
  }
  assert.ok(m.includes("_headers") && !t.includes("_headers"), "_headers solo en Mi Trabajo (Netlify)");
  assert.ok(!fs.existsSync(path.join(TALLER, "config-local.js")) && fs.existsSync(path.join(DEMO, "config-local.js")) === fs.existsSync(path.join(DEMO, "config-local.js")));
});

test("L14 · panel-tecnico.html: SOURCE sí, PUBLIC no — y la app solo lo enlaza en desarrollo", () => {
  assert.ok(fs.existsSync(path.join(DEMO, "panel-tecnico.html")), "se conserva en el código fuente");
  for (const d of [TALLER, MT]) assert.ok(!fs.existsSync(path.join(d, "panel-tecnico.html")));
  const app = leer(DEMO, "app.js");
  const usos = [...app.matchAll(/panel-tecnico\.html/g)].length;
  assert.ok(usos >= 1 && /function mensajeCuentaTecnica\(\) \{\s*return modoDesarrollo\(\) \? '[^']*panel-tecnico\.html/.test(app), "único enlace, detrás de modoDesarrollo()");
  assert.doesNotMatch(leer(DEMO, "sw.js").replace(/\/\/[^\n]*/g, ""), /panel-tecnico/, "el service worker no lo precachea");
});

test("L15 · config-local: SOURCE (plantilla) sí, PUBLIC no; ningún artefacto lo carga; sin él, lo de desarrollo no existe", () => {
  assert.ok(fs.existsSync(path.join(DEMO, "config-local.example.js")));
  for (const d of [TALLER, MT]) {
    assert.ok(!fs.existsSync(path.join(d, "config-local.js")) && !fs.existsSync(path.join(d, "config-local.example.js")));
    for (const f of archivos(d).filter((x) => /\.(html|js)$/.test(x))) assert.doesNotMatch(leer(d, f), /(src=|import |import\(|fetch\()[^\n]*config-local/, f);
  }
  assert.match(leer(DEMO, "app.js"), /function modoDesarrollo\(\) \{ return !!\(window\.ENTIMOTORS_LOCAL && window\.ENTIMOTORS_LOCAL\.teamPasswords\); \}/);
});

test("L17 / L18 · texto visible del HTML publicado (Taller y Mi Trabajo) sin frases de demo/desarrollo", () => {
  for (const [nombre, d, titulo] of [["Taller", TALLER, "ENTIMOTORS OS"], ["Mi Trabajo", MT, "ENTIMOTORS · Mi Trabajo"]]) {
    const html = leer(d, "index.html");
    assert.match(html, new RegExp(`<title>${titulo}</title>`), nombre);
    const visibles = textoVisible(html);
    assert.deepEqual(prohibidasEn(visibles), [], `${nombre}: ${prohibidasEn(visibles)}`);
    assert.match(html, /<span class="tag" id="topbarTag">OS<\/span>/);
    assert.match(html, /id="offlineToggle" style="display:none;"/, "el simulador arranca oculto");
  }
});

test("allowlist explícita: «por ejemplo» y «Ej.» son legítimos; «datos de ejemplo» y «demo» no", () => {
  assert.deepEqual(prohibidasEn("Escribe, por ejemplo, el modelo. Ej. CB190R"), []);
  assert.ok(PERMITIDAS.every((re) => re.test("por ejemplo · Ej. algo")));
  assert.equal(prohibidasEn("Cargar datos de ejemplo").length, 1);
  assert.equal(prohibidasEn("OS · demo local").length, 1);
  assert.deepEqual(prohibidasEn("Demostración de cobro"), [], "«demostración» no es «demo»");
});

test("L19 · Mi Trabajo oculta el HUD que inyecta Netlify (iframes nl-badge-frame / nl-hud-frame) sin tocar la PWA", () => {
  const html = leer(MT, "index.html");
  assert.match(html, /iframe#nl-badge-frame, iframe#nl-hud-frame \{ display: none !important; \}/);
  assert.match(leer(MT, "_headers"), /\/sw\.js\n\s+Cache-Control: public, max-age=0, must-revalidate/);
});

test("L12 / L13 · Gestor Web: UNA sola URL (la canónica) y ninguna credencial en lo publicado", () => {
  for (const d of [TALLER, MT]) {
    const cfg = leer(d, "supabase-config.js");
    assert.match(cfg, /gestorWebUrl: "https:\/\/www\.entimotors\.com\/admin\.html"/);
    const todo = archivos(d).filter((x) => /\.(js|html|json)$/.test(x)).map((x) => leer(d, x)).join("\n");
    assert.equal([...todo.matchAll(/entimotors\.com\/admin\.html/g)].length, 1, "la URL no se repite fuera de la configuración");
    // L13: sin secretos. El único JWT permitido es la anon key pública (rol anon).
    const jwts = [...todo.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g)];
    for (const j of jwts) assert.equal(JSON.parse(Buffer.from(j[1], "base64url").toString()).role, "anon", "solo la anon key pública");
    // una LLAVE real (el detector defensivo /^sb_secret_/ de supabase-client.js no es un secreto)
    assert.doesNotMatch(todo, /sb_secret_[A-Za-z0-9_-]{10,}|service_role"?\s*[:=]\s*"eyJ|teamPasswords\s*:\s*\{|adminCode\s*:\s*"|PIN_PEPPER\s*[:=]|SUPABASE_SERVICE_ROLE_KEY\s*[:=]/);
    assert.doesNotMatch(todo, /password\s*[:=]\s*["'][^"'\s]{6,}["']/i);
  }
});

test("L21 · caché y actualización coherentes en los dos artefactos (SHELL completo, una sola versión de ?v=, sin skipWaiting en install)", () => {
  for (const [d, cache] of [[TALLER, /^const CACHE_NAME = "entimotors-v[\d.]+";/m], [MT, /^const CACHE_NAME = "entimotors-mitrabajo-v[\d.]+";/m]]) {
    const sw = leer(d, "sw.js"); assert.match(sw, cache);
    const shell = [...sw.slice(sw.indexOf("const SHELL"), sw.indexOf("];", sw.indexOf("const SHELL"))).matchAll(/"\.\/([^"?]*)/g)].map((x) => x[1]).filter(Boolean);
    for (const f of shell) assert.ok(fs.existsSync(path.join(d, f)), `SHELL: ${f}`);
    assert.ok(shell.includes("finanzas-calc.js") && shell.includes("fecha-negocio.js"));
    const vs = new Set([...leer(d, "index.html").matchAll(/<script src="[^"?]+\?v=([^"]+)"/g)].map((x) => x[1]));
    assert.equal(vs.size, 1, "una sola versión en los ?v=");
    const install = sw.slice(sw.indexOf('addEventListener("install"'), sw.indexOf('addEventListener("activate"')).replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(install, /skipWaiting\(\)/);
  }
});
