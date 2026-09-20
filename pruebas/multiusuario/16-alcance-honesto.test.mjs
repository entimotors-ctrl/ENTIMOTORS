// ALCANCE HONESTO de 3.13.0 (4E-C4-FIX) — «identidad, acceso y roles multiusuario»; NO trabajo compartido ni sincronizado.
// Guardas de que la UI visible, el manifest de Mi Trabajo, el README y el CHANGELOG (1) no prometen asignacion ni sincronizacion que no existen,
// (2) dicen expresamente las limitaciones y (3) siguen coherentes con el codigo (versiones, enlaces, cuentas de referencias).
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { leer, existe, RUNTIME } from "./helpers/entorno.mjs";

const INDEX = leer("index.html"), APP = leer("app.js"), README = leer("README.md"), CHANGELOG = leer("CHANGELOG.md"), SW = leer("sw.js");
const MANIFEST_MT = JSON.parse(leer("build-mecanicos/manifest.json")), MANIFEST_TALLER = JSON.parse(leer("manifest.json"));
const VISTA_MT = /<section class="view" id="view-mi-trabajo">[\s\S]*?<\/section>/.exec(INDEX)[0];
const NOTA = "La asignación y sincronización de trabajos entre dispositivos estará disponible en una versión posterior.";
// texto «plano»: sin marcas de cita (> ) ni saltos de linea, para comprobar frases aunque el documento las parta en varias lineas
const plano = (t) => t.replace(/\n>\s?/g, " ").replace(/\s+/g, " ");
const VERSION = /const VERSION_APP = "([^"]+)"/.exec(APP)[1];

describe("Mi Trabajo · la pantalla NO promete trabajo asignado y muestra la limitacion DENTRO de la app", () => {
  test("la vista trae la nota visible: «la asignación y sincronización de trabajos entre dispositivos estará disponible en una versión posterior»", () => {
    assert.ok(VISTA_MT.includes(NOTA)); assert.match(VISTA_MT, /id="miTrabajoAlcance"/);
  });
  test("el subtitulo es «Acceso para mecánicos.» y ningun texto de la vista habla de trabajo asignado", () => {
    assert.match(VISTA_MT, /id="miTrabajoSub">Acceso para mecánicos\.</); assert.ok(!/asignad/i.test(VISTA_MT), "la vista no debe decir «asignado»"); assert.ok(!/Lo que tienes asignado/.test(INDEX));
  });
  test("renderMiTrabajo() no escribe textos de «asignado» (subtitulo ni mensajes de lista vacia)", () => {
    const i = APP.indexOf("async function renderMiTrabajo()"), j = APP.indexOf('document.querySelectorAll(".orden-mia")', i); assert.ok(i > 0 && j > i);
    const cuerpo = APP.slice(i, j); assert.ok(!/asignad/i.test(cuerpo), "renderMiTrabajo no debe hablar de trabajo asignado");
    for (const t of ["acceso para mecánicos.", "No hay citas en este dispositivo.", "No hay órdenes abiertas en este dispositivo.", "Todavía no hay trabajos entregados en este dispositivo."]) assert.ok(cuerpo.includes(t), t);
  });
  test("«Mecánico asignado» (selector del TALLER, por nombre, lista local) sigue igual: no es texto de Mi Trabajo ni promete cuentas", () => {
    assert.equal((INDEX.match(/<label>Mecánico asignado<\/label>/g) || []).length, 2); assert.ok(!/cuenta/i.test(INDEX.match(/<label>Mecánico asignado<\/label>[^\n]*/)[0]));
  });
});

describe("Manifest de Mi Trabajo · describe la capacidad REAL y no cambia nada mas", () => {
  test("description = «Acceso para mecánicos — ENTIMOTORS» (sin «trabajo asignado»)", () => { assert.equal(MANIFEST_MT.description, "Acceso para mecánicos — ENTIMOTORS"); assert.ok(!/asignad/i.test(JSON.stringify(MANIFEST_MT))); });
  test("name, short_name, start_url, scope, display, colores e iconos NO cambiaron", () => {
    assert.deepEqual({ ...MANIFEST_MT, description: undefined }, { name: "ENTIMOTORS Mi Trabajo", short_name: "Mi Trabajo", description: undefined, start_url: "./index.html", scope: "./", display: "standalone", orientation: "any", background_color: "#0a0a0a", theme_color: "#0a0a0a",
      icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }, { src: "icons/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" }, { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }, { src: "icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" }] });
  });
  test("el manifest del TALLER no se toco", () => assert.equal(MANIFEST_TALLER.description, "Sistema interno de taller ENTIMOTORS"));
  test("el BUILD generado en /tmp (hacer-build-mecanicos.sh) trae la nota, el manifest honesto y la cache propia", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-c4fix-build-")); const destino = path.join(tmp, "mecanicos");
    try {
      const r = spawnSync("bash", [path.join(RUNTIME, "hacer-build-mecanicos.sh"), destino], { encoding: "utf8", env: { PATH: process.env.PATH, LC_ALL: "C.UTF-8" } }); assert.equal(r.status, 0, r.stderr);
      const idx = fs.readFileSync(path.join(destino, "index.html"), "utf8"); assert.ok(idx.includes(NOTA)); assert.ok(!/Lo que tienes asignado/.test(idx));
      assert.equal(JSON.parse(fs.readFileSync(path.join(destino, "manifest.json"), "utf8")).description, "Acceso para mecánicos — ENTIMOTORS");
      assert.match(fs.readFileSync(path.join(destino, "sw.js"), "utf8"), /const CACHE_NAME = "entimotors-mitrabajo-v3\.13\.0"/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("«Usuarios y equipo» · el texto ya no sobreafirma: cuentas (servidor) vs datos de este dispositivo (aplicacion)", () => {
  test("el texto distingue las dos cosas y no dice que el servidor aplica TODOS los permisos", () => {
    assert.ok(!/Los permisos los aplica el servidor/.test(INDEX)); const p = /<div><h2>Usuarios y equipo<\/h2><p>([^<]*)<\/p><\/div>/.exec(INDEX)[1];
    assert.match(p, /cuentas/); assert.match(p, /servidor/); assert.match(p, /datos de este dispositivo/); assert.match(p, /aplicación/);
    assert.ok(p.length < 160, "texto corto para la UI");
  });
  test("apiUrl NO se relleno: el supabase-config.js versionado sigue con apiUrl vacio, sin URL de produccion y sin secretos", () => {
    const cfg = leer("supabase-config.js"); assert.match(cfg, /apiUrl:\s*""/); assert.ok(!/onrender\.com|service_role/i.test(cfg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  });
  test("con apiUrl vacio la pantalla conserva su aviso actual", () => assert.match(leer("usuarios.js"), /Falta indicar la dirección del servidor/));
});

// ─────────────── README y CHANGELOG ───────────────
const ETIQUETAS_V = (INDEX.match(/<script src="[^"]+\?v=[\d.]+"><\/script>/g) || []).length;
const SHELL_V = (/const SHELL = \[([\s\S]*?)\];/.exec(SW)[1].match(/\?v=[\d.]+"/g) || []).length;
const LIMITACIONES = [
  ["no incluye asignacion de trabajo a cuentas de mecanico", /No incluye asignación de trabajo a cuentas de mecánico/],
  ["no incluye sincronizacion entre dispositivos", /No incluye sincronización entre dispositivos/],
  ["Mi Trabajo no recibe trabajo/ordenes/citas desde otro dispositivo todavia", /Mi Trabajo no recibe (trabajo|órdenes ni citas desde otro dispositivo) todavía/],
  ["los datos operativos siguen locales en IndexedDB", /datos operativos (permanecen|siguen) locales/],
  ["logout en otra pestaña no es inmediato", /(Cerrar sesión en otra pestaña no (es inmediato|invalida de inmediato))/],
];

describe("README.md · estado REAL de 3.13.0", () => {
  test("version 3.13.0 y sin afirmaciones falsas heredadas", () => {
    assert.match(README, /\*\*Versión actual:\*\* 3\.13\.0/); assert.equal(VERSION, "3.13.0");
    for (const falso of ["3.12.0", "No hay ni una línea de código de Supabase", "dos roles", "tres archivos", "tres sitios", "pantalla de usuarios en fase", "Supabase: preparado, todavía no conectado"]) assert.ok(!README.includes(falso), `README contiene «${falso}»`);
  });
  test("todos los enlaces relativos apuntan a archivos que EXISTEN (se quitaron los cuatro rotos)", () => {
    const enlaces = [...README.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((u) => !/^(https?:|mailto:)/.test(u)); assert.ok(enlaces.length >= 4, "debe haber enlaces");
    const rotos = enlaces.filter((u) => !fs.existsSync(path.join(RUNTIME, u))); assert.deepEqual(rotos, []);
    for (const f of ["SUPABASE-CONFIG.md", "SUPABASE-STATUS.md", "entimotors-completo.sql", "README-MAPA.md"]) assert.ok(!README.includes(f), f);
  });
  test("documenta los dos productos, los cuatro roles reales y el rechazo de roles desconocidos", () => {
    for (const t of ["ENTIMOTORS Taller", "ENTIMOTORS Mi Trabajo", "Administrador", "Cajero", "Mecánico", "Desarrollador", "entimotors-v3.13.0", "entimotors-mitrabajo-v3.13.0", "activo=false", "Un **rol desconocido se rechaza**"]) assert.ok(README.includes(t), t);
  });
  test("API ADMIN: documenta apiUrl y las variables del api-server (sin valores ni secretos)", () => {
    for (const t of ["apiUrl", "ENTIMOTORS_ADMIN_ORIGIN", "ENTIMOTORS_MECHANIC_ORIGIN", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SUPABASE_ANON_KEY", "Falta indicar la dirección del servidor"]) assert.ok(plano(README).includes(t), t);
    assert.ok(!/https:\/\/[a-z0-9-]+\.(supabase\.co|onrender\.com)/i.test(README.replace("https://<tu-servicio>.onrender.com", "")), "el README no debe traer URLs reales");
  });
  test("VERSIONADO: las cifras del README coinciden con el codigo (8 etiquetas ?v= en index.html, 7 entradas versionadas del SHELL) y cita VERSION_APP, CACHE_NAME y el literal del panel", () => {
    assert.equal(ETIQUETAS_V, 8); assert.equal(SHELL_V, 7);
    assert.ok(README.includes(`las **${ETIQUETAS_V}** etiquetas`), "cifra de index.html"); assert.ok(README.includes(`las **${SHELL_V}** entradas`), "cifra del SHELL");
    for (const t of ["VERSION_APP", "CACHE_NAME", "panel-tecnico.html"]) assert.ok(README.includes(t), t);
  });
  test("LIMITACIONES CONOCIDAS visibles en el README (y sin presentarlas como corregidas)", () => {
    const i = README.indexOf("## Limitaciones conocidas de 3.13.0"); assert.ok(i > 0); const seccion = README.slice(i, README.indexOf("\n---", i));
    for (const [n, rx] of LIMITACIONES) assert.match(seccion, rx, n); assert.match(seccion, /no son bugs corregidos/i); assert.match(seccion, /requiere configurar `apiUrl`/);
  });
  test("el alcance (arriba) declara lo que incluye y lo que NO incluye", () => {
    const a = README.slice(README.indexOf("## Alcance de 3.13.0"), README.indexOf("## Cómo funciona hoy"));
    assert.match(a, /identidad, acceso y roles/); assert.match(a, /\*\*No incluye\*\*/); assert.match(a, /Asignación real de trabajo/); assert.match(a, /Sincronización entre dispositivos/);
  });
});

describe("CHANGELOG.md · entrada 3.13.0", () => {
  const i313 = CHANGELOG.indexOf("## 3.13.0"), i312 = CHANGELOG.indexOf("## 3.12.0"), E = CHANGELOG.slice(i313, i312);
  test("es la PRIMERA entrada, esta marcada como aun sin publicar y la historia previa sigue ahi", () => {
    assert.equal(CHANGELOG.indexOf("## "), i313); assert.ok(i313 >= 0 && i312 > i313); assert.match(E, /^## 3\.13\.0 — candidato .*sin publicar/);
    assert.ok(CHANGELOG.includes("## 3.12.0 — 4 de septiembre de 2026") && CHANGELOG.includes("## 3.11.0 — versión en producción"));
    assert.ok(CHANGELOG.includes("Esta versión NO constituye todavía el piloto multiusuario"), "la entrada de 3.12.0 no se altero");
  });
  test("declara el alcance: identidad, acceso y roles; y lo que NO incluye", () => {
    assert.match(plano(E), /identidad, acceso y roles multiusuario/); assert.match(plano(E), /\*\*No\*\* incluye asignación de trabajo a cuentas de mecánico/); assert.match(plano(E), /sincronización entre dispositivos/);
  });
  test("incluye todo lo entregado: auth, roles, cuentas, Mi Trabajo, activo=false, PWA/cache 3.13.0, actualizacion controlada, F-SEC-1/2, F-FUNC-1 y OBS-3/4/5, rol desconocido y panel", () => {
    for (const t of ["Autenticación multiusuario", "Roles", "Administración de cuentas", "ENTIMOTORS Mi Trabajo", "`activo=false` falla cerrado", "entimotors-v3.13.0", "entimotors-mitrabajo-v3.13.0", "Actualización controlada", "F-SEC-1", "F-SEC-2", "F-FUNC-1", "OBS-3", "OBS-4", "OBS-5", "Rol desconocido, cerrado", "Panel técnico"])
      assert.ok(E.includes(t), t);
  });
  test("LIMITACIONES CONOCIDAS: seccion propia, DESPUES de las correcciones, con el significado literal exigido", () => {
    const iCorr = E.indexOf("### Correcciones"), iLim = E.indexOf("### Limitaciones conocidas"); assert.ok(iCorr > 0 && iLim > iCorr, "la seccion de limitaciones va despues de «Correcciones»");
    const lim = E.slice(iLim); for (const [n, rx] of LIMITACIONES) assert.match(lim, rx, n);
    assert.match(lim, /No son bugs corregidos/); assert.ok(!/^\s*-\s.*(corregid|arreglad)/im.test(lim.split("\n").slice(3).join("\n")), "ninguna limitacion se presenta como corregida");
  });
  test("las tres limitaciones del alcance aparecen con el mismo sentido en UI (nota), README y CHANGELOG", () => {
    for (const doc of [README, CHANGELOG]) for (const [n, rx] of LIMITACIONES.slice(0, 3)) assert.match(doc, rx, n);
    assert.match(INDEX, /asignación y sincronización de trabajos entre dispositivos estará disponible en una versión posterior/);
  });
});
