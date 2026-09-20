// HOTFIX PRE-TAG (4E-C11) · CONFIGURACION DE PRODUCCION DEL TALLER: apiUrl.
//
// El bug: 3.13.0 se publico con taller-demo/supabase-config.js con `apiUrl: ""` y, en produccion, «Usuarios y equipo» mostro
// «Falta indicar la dirección del servidor. Se configura en supabase-config.js, campo apiUrl». El QA automatico NO lo vio porque
// (1) todas las pruebas inyectan un apiUrl SINTETICO (helpers/entorno.mjs), (2) el servidor de navegador sustituye supabase-config.js por una
// configuracion sintetica, y (3) la prueba 16 fijaba justo lo contrario («apiUrl vacio, sin URL de produccion»). Nadie miraba el archivo REAL.
//
// Esta suite mira el archivo REAL que se publica y valida con verificar-config-produccion.mjs (la misma comprobacion que se puede correr sobre
// el archivo a subir o sobre la URL ya publicada). Contra el supabase-config.js de 8eea52c (el publicado con el bug) FALLA.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { leer, RAIZ } from "./helpers/entorno.mjs";
import { nuevoEntorno, CUENTAS } from "./helpers/flujos.mjs";
import { URL_API, UUID } from "./helpers/supabase-mock.mjs";
import { validarConfig, evaluarConfig, rolDeJwt, BACKEND_ESPERADO } from "./verificar-config-produccion.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const VERIFICADOR = path.join(AQUI, "verificar-config-produccion.mjs");
const CONFIG = leer("supabase-config.js");
const REAL = evaluarConfig(CONFIG).cfg;
const API_REAL = REAL.apiUrl;
const jwt = (role) => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: "supabase", role })).toString("base64url")}.firma`;

describe("supabase-config.js VERSIONADO = configuracion de produccion del Taller", () => {
  test("el archivo real pasa el verificador de produccion (0 problemas)", () => assert.deepEqual(validarConfig(CONFIG), []));
  test("apiUrl esta presente y es EXACTAMENTE el backend de produccion: HTTPS, solo el origen (sin barra final ni ruta)", () => {
    assert.equal(typeof API_REAL, "string"); assert.notEqual(API_REAL, "");
    assert.equal(API_REAL, BACKEND_ESPERADO); assert.equal(API_REAL, "https://entimotors-1.onrender.com");
    const u = new URL(API_REAL); assert.equal(u.protocol, "https:"); assert.equal(u.origin, API_REAL); assert.ok(!API_REAL.endsWith("/"));
  });
  test("sigue siendo solo configuracion PUBLICA: anon (no service_role), Supabase https, sin claves de servidor", () => {
    assert.equal(rolDeJwt(REAL.anonKey), "anon"); assert.match(REAL.url, /^https:\/\/[a-z0-9-]+\.supabase\.co$/); assert.equal(REAL.habilitado, true);
    assert.deepEqual(Object.keys(REAL).filter((k) => /service|secret|password|token|private/i.test(k)), []);
    assert.ok(!/service_role/i.test(CONFIG.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")));
  });
  test("el README y el CHANGELOG no llevan la URL real (solo el archivo de configuracion)", () => {
    for (const f of ["README.md", "CHANGELOG.md"]) assert.ok(!/onrender\.com/i.test(leer(f).replace("https://<tu-servicio>.onrender.com", "")), f);
  });
});

describe("el verificador DETECTA cada defecto (mutantes del archivo REAL): la prueba habria fallado antes del deploy", () => {
  const con = (fn) => validarConfig(fn(CONFIG));
  const cambiarApi = (nuevo) => (t) => t.replace(/apiUrl:\s*"[^"]*"/, `apiUrl: ${JSON.stringify(nuevo)}`);
  const CASOS = [
    ["apiUrl VACIO (el bug publicado en 3.13.0)", cambiarApi(""), "APIURL_AUSENTE"],
    ["apiUrl solo con espacios", cambiarApi("   "), "APIURL_AUSENTE"],
    ["la propiedad apiUrl ELIMINADA", (t) => t.replace(/,?\s*\n?\s*apiUrl:\s*"[^"]*"/, ""), "APIURL_AUSENTE"],
    ["apiUrl con http:// (sin HTTPS)", cambiarApi("http://entimotors-1.onrender.com"), "APIURL_NO_HTTPS"],
    ["apiUrl con barra final", cambiarApi(`${BACKEND_ESPERADO}/`), "APIURL_MAL_FORMADA"],
    ["apiUrl con ruta (/api)", cambiarApi(`${BACKEND_ESPERADO}/api`), "APIURL_MAL_FORMADA"],
    ["apiUrl con parametros", cambiarApi(`${BACKEND_ESPERADO}?x=1`), "APIURL_MAL_FORMADA"],
    ["apiUrl con el placeholder del ejemplo", cambiarApi("https://<tu-servicio>.onrender.com"), "APIURL_MAL_FORMADA"],
    ["apiUrl apuntando a localhost (QA local)", cambiarApi("https://localhost"), "APIURL_LOCAL"],
    ["apiUrl con el host sintetico de las pruebas", cambiarApi(URL_API), "APIURL_LOCAL"],
    ["apiUrl de OTRO servicio de Render", cambiarApi("https://otro-servicio.onrender.com"), "APIURL_BACKEND_INESPERADO"],
    ["clave anon sustituida por una service_role", (t) => t.replace(/anonKey:\s*"[^"]*"/, `anonKey: ${JSON.stringify(jwt("service_role"))}`), "ANON_KEY_NO_ANON"],
    ["habilitado en false", (t) => t.replace(/habilitado:\s*true/, "habilitado: false"), "HABILITADO_NO_TRUE"],
    ["URL de Supabase que no es *.supabase.co", (t) => t.replace(/url:\s*"[^"]*"/, 'url: "https://ejemplo.invalid"'), "SUPABASE_URL_INVALIDA"],
    ["una clave de servidor colada en la config", (t) => t.replace("habilitado: true,", 'habilitado: true, serviceKey: "x",'), "CLAVE_SOSPECHOSA"],
    ["archivo que no se puede evaluar", () => "window.ENTIMOTORS_SUPABASE = {", "CONFIG_ILEGIBLE"],
    ["archivo sin la configuracion", () => "/* vacio */", "CONFIG_AUSENTE"],
  ];
  for (const [nombre, mutar, codigo] of CASOS) {
    test(`${nombre} → ${codigo}`, () => { const p = con(mutar); assert.ok(p.some((x) => x.startsWith(codigo)), `esperaba ${codigo}; salio: ${JSON.stringify(p)}`); });
  }
  test("el archivo SIN mutar sigue limpio (los mutantes no son un falso positivo del verificador)", () => assert.deepEqual(validarConfig(CONFIG), []));
});

describe("CLI: es la puerta del paso de publicacion (archivo a subir o URL ya publicada)", () => {
  const correr = (...args) => spawnSync(process.execPath, [VERIFICADOR, ...args], { encoding: "utf8", cwd: RAIZ });
  test("sobre el archivo versionado: salida 0 y CONFIG_PRODUCCION_OK, sin imprimir la clave anon", () => {
    const r = correr(); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /CONFIG_PRODUCCION_OK apiUrl=https:\/\/entimotors-1\.onrender\.com/);
    assert.ok(!r.stdout.includes(REAL.anonKey) && !/eyJ[A-Za-z0-9_-]{10,}\./.test(r.stdout));
  });
  test("sobre un archivo con apiUrl vacio (lo que se publico): salida 1 y APIURL_AUSENTE", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-prod-")); const f = path.join(d, "supabase-config.js");
    try { fs.writeFileSync(f, CONFIG.replace(/apiUrl:\s*"[^"]*"/, 'apiUrl: ""')); const r = correr(f); assert.equal(r.status, 1); assert.match(r.stdout, /APIURL_AUSENTE/); assert.match(r.stdout, /FAIL 1 problemas/); }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("sobre un archivo inexistente: falla cerrado (salida 1)", () => { const r = correr(path.join(os.tmpdir(), "no-existe-cfg-prod.js")); assert.equal(r.status, 1); assert.match(r.stdout, /CONFIG_INACCESIBLE/); });
});

// ─────────── la pantalla REAL con el apiUrl REAL del archivo versionado ───────────
const EQUIPO = () => [
  { id: UUID(101), nombre: "Admin Activo", correo: "admin@example.test", telefono: "", rol: "admin", activo: true, esUsted: true },
  { id: UUID(103), nombre: "Persona Tres", correo: "persona3@example.test", telefono: "", rol: "mecanico", activo: true, esUsted: false },
];
/** Pantalla con el apiUrl indicado; el trafico a la URL real se reescribe al api-server SINTETICO (nunca sale nada a internet). */
async function pantalla({ cuenta = CUENTAS.adminActivo, producto = "admin", apiUrl = API_REAL } = {}) {
  const env = nuevoEntorno({ producto, cuenta, sesionGuardada: null, apiUrl });
  env.servidor.api = async () => ({ status: 200, body: { usuarios: EQUIPO() } });
  env.vistos = []; const original = env.win.fetch;
  env.win.fetch = (u, i) => {
    const url = String(u); if (url.includes("/api/admin/usuarios")) env.vistos.push(url);
    return original(apiUrl && url.startsWith(apiUrl) ? URL_API + url.slice(apiUrl.length) : url, i);
  };
  await env.asentar();
  env.cuerpo = () => env.doc.getElementById("usuariosCuerpo");
  env.dibujar = async () => { await env.win.PantallaUsuarios.render(); await env.asentar(); };
  return env;
}
const AVISO = /Falta indicar la dirección del servidor/;

describe("«Usuarios y equipo» con el apiUrl del archivo versionado", () => {
  test("el admin YA NO ve «Falta indicar la dirección del servidor», pide al backend de produccion y pinta el equipo", async () => {
    const env = await pantalla(); await env.dibujar();
    const html = env.cuerpo().innerHTML;
    assert.ok(!AVISO.test(html), "no debe salir el aviso de apiUrl ausente"); assert.ok(!/campo <code>apiUrl<\/code>/.test(html));
    assert.deepEqual(env.vistos, [`${BACKEND_ESPERADO}/api/admin/usuarios`]); assert.match(html, /Persona Tres/);
  });
  test("CONTROL: con apiUrl vacio (el archivo publicado con el bug) aparece EXACTAMENTE el aviso que vio el QA y no se llama a nadie", async () => {
    const env = await pantalla({ apiUrl: "" }); await env.dibujar();
    assert.match(env.cuerpo().innerHTML, AVISO); assert.match(env.cuerpo().innerHTML, /supabase-config\.js/); assert.match(env.cuerpo().innerHTML, /apiUrl/); assert.deepEqual(env.vistos, []);
  });
  test("un cajero sigue viendo «solo para el administrador» y no hace ninguna llamada, tambien con apiUrl real", async () => {
    const env = await pantalla({ cuenta: CUENTAS.cajeroActivo }); await env.dibujar();
    assert.match(env.cuerpo().innerHTML, /solo para el administrador/); assert.deepEqual(env.vistos, []);
  });
  test("Mi Trabajo: un mecanico con cuenta sigue rechazado en esta pantalla y no llama al backend", async () => {
    const env = await pantalla({ cuenta: CUENTAS.mecanicoActivo, producto: "mecanico" }); await env.dibujar();
    assert.match(env.cuerpo().innerHTML, /solo para el administrador/); assert.deepEqual(env.vistos, []);
  });
});

describe("Mi Trabajo comparte el archivo: el build de mecanicos lleva la MISMA configuracion valida", () => {
  test("hacer-build-mecanicos.sh copia supabase-config.js sin alterarlo y el resultado tambien pasa el verificador", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mt-cfg-")); const out = path.join(d, "mt");
    try {
      const r = spawnSync("bash", [path.join(RAIZ, "taller-demo", "hacer-build-mecanicos.sh"), out], { encoding: "utf8" }); assert.equal(r.status, 0, r.stdout + r.stderr);
      const enBuild = fs.readFileSync(path.join(out, "supabase-config.js"), "utf8"); assert.equal(enBuild, CONFIG); assert.deepEqual(validarConfig(enBuild), []);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});
