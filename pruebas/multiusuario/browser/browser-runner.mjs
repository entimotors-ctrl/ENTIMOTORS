#!/usr/bin/env node
// QA en NAVEGADOR REAL (Chrome/Chromium + Firefox) del candidato multiusuario 3.13.0. Local, sintetico, cero produccion.
//   node pruebas/multiusuario/browser/browser-runner.mjs [--navegador=chrome|firefox|todos] [--suite=app,mt,mut,pwa-taller,pwa-mt,upg-taller,upg-mt] [--json]
// Sin dependencias: usa los navegadores YA instalados, un servidor HTTP local en 127.0.0.1 y una pagina autoejecutable que
// carga el runtime REAL. Cada navegador corre con un PERFIL TEMPORAL nuevo (en /tmp) y con un proxy-SUMIDERO que anota y rechaza
// todo intento de salir a Internet. No escribe ningun resultado en disco: solo imprime. Al terminar cierra navegadores,
// servidores y borra perfiles y el build temporal de «Mi Trabajo».
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crearColector } from "./collector.mjs";
import { crearOrigen, crearTrampa } from "./server.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..", "..");
const TALLER = path.join(RAIZ, "taller-demo");
const arg = (n, def) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : def; };
const JSON_SALIDA = process.argv.includes("--json");
const SUITES_TODAS = ["app", "mt", "mut", "pwa-taller", "pwa-mt", "upg-taller", "upg-mt"];
/* 3.15.1 · la release ANTERIOR publicada: el «antes» de la prueba de actualización (upg-taller / upg-mt). Es lo que tienen hoy los
   dispositivos; al publicar una release, esta constante pasa a apuntar a ella. Sustituye a las suites fijas 3.12.2 → 3.13.0 (pwa-upg) y
   3.14.0 → 3.14.1 (upg-3141-*), escritas para esas releases. */
const RELEASE_ANTERIOR = { version: "3.15.0", commit: "f2a659870d1a485551cedc601b07490e804faed4" };
const suites = arg("suite", SUITES_TODAS.join(",")).split(",").filter(Boolean);
const quePedido = arg("navegador", "todos");
const PLAZO_MS = { app: 240000, mt: 120000, mut: 150000, "pwa-taller": 90000, "pwa-mt": 90000, "upg-taller": 150000, "upg-mt": 150000 };

// ── navegadores ya instalados ──
const buscar = (nombres) => { for (const n of nombres) { const r = spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }); const p = r.stdout.trim(); if (p) return { nombre: n, ruta: p, real: fs.realpathSync(p) }; } return null; };
const version = (ruta) => { const r = spawnSync(ruta, ["--version"], { encoding: "utf8", timeout: 15000 }); return (r.stdout || r.stderr || "").trim().split("\n")[0]; };
function inventario() {
  const chr = buscar(["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]);
  const ff = buscar(["firefox"]);
  return [
    { id: "chromium", etiqueta: "Chromium/Chrome", ...(chr || {}), version: chr ? version(chr.ruta) : null, disponible: !!chr },
    { id: "firefox", etiqueta: "Firefox", ...(ff || {}), version: ff ? version(ff.ruta) : null, disponible: !!ff },
  ];
}

// ── perfiles temporales y lanzamiento ──
const perfilesCreados = [];
function crearPerfil(id) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `entimotors-c3browser-${id}-`)); perfilesCreados.push(d); return d; }
function prefsFirefox(puertoTrampa) {
  return [
    ["network.proxy.type", 1], ["network.proxy.http", "127.0.0.1"], ["network.proxy.http_port", puertoTrampa], ["network.proxy.ssl", "127.0.0.1"], ["network.proxy.ssl_port", puertoTrampa],
    ["network.proxy.no_proxies_on", "localhost, 127.0.0.1"], ["network.proxy.allow_hijacking_localhost", false],
    ["browser.shell.checkDefaultBrowser", false], ["browser.startup.homepage_override.mstone", "ignore"], ["browser.aboutwelcome.enabled", false], ["startup.homepage_welcome_url", ""],
    ["datareporting.policy.dataSubmissionEnabled", false], ["datareporting.healthreport.uploadEnabled", false], ["toolkit.telemetry.enabled", false], ["toolkit.telemetry.unified", false],
    ["app.update.enabled", false], ["app.update.auto", false], ["app.normandy.enabled", false], ["app.shield.optoutstudies.enabled", false],
    ["browser.safebrowsing.malware.enabled", false], ["browser.safebrowsing.phishing.enabled", false], ["browser.safebrowsing.downloads.enabled", false],
    ["network.captive-portal-service.enabled", false], ["network.connectivity-service.enabled", false], ["extensions.update.enabled", false],
    ["services.settings.server", "http://127.0.0.1:1/v1"], ["browser.newtabpage.activity-stream.feeds.telemetry", false], ["browser.newtabpage.activity-stream.telemetry", false],
    ["dom.serviceWorkers.enabled", true], ["browser.tabs.warnOnClose", false], ["network.prefetch-next", false], ["network.dns.disablePrefetch", true],
  ].map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n";
}
function lanzar(nav, url, perfil, puertoTrampa) {
  let args;
  if (nav.id === "chromium") {
    args = ["--headless=new", `--user-data-dir=${perfil}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--disable-domain-reliability", "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
      "--metrics-recording-only", "--disable-breakpad", "--mute-audio", "--password-store=basic", "--disable-search-engine-choice-screen", "--window-size=1280,900", `--proxy-server=http://127.0.0.1:${puertoTrampa}`,
      ...(process.env.QA_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), url];
  } else {
    fs.writeFileSync(path.join(perfil, "user.js"), prefsFirefox(puertoTrampa));
    args = ["--headless", "--no-remote", "--profile", perfil, url];
  }
  // XDG_* dentro del perfil temporal: ningun archivo del HOME real (perfil personal, cachés, crash reports) se lee ni se escribe.
  const xdg = (n) => { const d = path.join(perfil, `.xdg-${n}`); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = { ...process.env, XDG_CONFIG_HOME: xdg("config"), XDG_CACHE_HOME: xdg("cache"), XDG_DATA_HOME: xdg("data"), XDG_STATE_HOME: xdg("state") };
  const hijo = spawn(nav.ruta, args, { detached: true, stdio: ["ignore", "ignore", "pipe"], env });
  let stderr = ""; hijo.stderr.on("data", (d) => { if (stderr.length < 6000) stderr += d; });
  hijo.on("error", (e) => { stderr += `\n[spawn] ${e.message}`; });
  return { hijo, stderr: () => stderr };
}
const esperarSalida = (hijo, ms) => new Promise((r) => { if (hijo.exitCode !== null || hijo.signalCode) return r(true); const t = setTimeout(() => r(false), ms); hijo.once("exit", () => { clearTimeout(t); r(true); }); });
async function matar(hijo) {
  for (const senal of ["SIGTERM", "SIGKILL"]) {
    try { process.kill(-hijo.pid, senal); } catch { /* ya no existe */ }
    if (await esperarSalida(hijo, senal === "SIGTERM" ? 3000 : 2000)) break;
  }
}
// Clasificacion de lo que llego al SUMIDERO (proxy): NADA sale a Internet, pero se distingue el origen de cada intento.
const FONDO_NAVEGADOR = /(^|\.)(google\.com|gstatic\.com|googleapis\.com|googleusercontent\.com|mozilla\.(org|com|net)|openh264\.org|firefox\.com)(:\d+)?$/i;
function clasificarExterno(intento, suite) {
  const host = String(intento.destino);
  if (FONDO_NAVEGADOR.test(host)) return "BROWSER_BACKGROUND";
  if (/^cdn\.jsdelivr\.net(:\d+)?$/i.test(host) && /^(pwa-|upg-)/.test(suite)) return "EXPECTED_SW_EXTRAS";
  return "UNEXPECTED_EXTERNAL_REQUEST";
}
const puertoLibre = () => new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

// ── main ──
const limpiezas = [];
let salida = 0;
try {
  const navs = inventario().filter((n) => quePedido === "todos" || n.id === quePedido || (quePedido === "chrome" && n.id === "chromium"));
  const trampa = await crearTrampa(); limpiezas.push(() => trampa.cerrar());
  const colector = crearColector();

  // Build temporal de «Mi Trabajo» (solo si hace falta), sin tocar nada.
  const raizTmp = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-c3browser-build-")); limpiezas.push(() => fs.rmSync(raizTmp, { recursive: true, force: true }));
  const BUILD_MT = path.join(raizTmp, "mecanicos");
  if (suites.some((s) => ["mt", "pwa-mt", "upg-mt"].includes(s))) {
    const b = spawnSync("bash", [path.join(TALLER, "hacer-build-mecanicos.sh"), BUILD_MT], { encoding: "utf8", env: { PATH: process.env.PATH, LC_ALL: "C.UTF-8" } });
    if (b.status !== 0) throw new Error(`no se pudo generar el build de Mi Trabajo en /tmp: ${b.stderr || b.stdout}`);
  }
  /* La release ANTERIOR entera (RELEASE_ANTERIOR, publicada) como «antes» de la actualización: el Taller tal cual y su «Mi Trabajo»
     generado con SU PROPIO hacer-build-mecanicos.sh. Solo lectura del repositorio (git archive a /tmp). */
  let ANTES_TALLER = null, ANTES_MT = null;
  if (suites.some((s) => /^upg-/.test(s))) {
    const d = path.join(raizTmp, "antes"); fs.mkdirSync(d);
    const a = spawnSync("sh", ["-c", `git -C "${RAIZ}" archive ${RELEASE_ANTERIOR.commit} taller-demo | tar -x -C "${d}"`], { encoding: "utf8" });
    if (a.status !== 0) throw new Error(`no se pudo extraer la release ${RELEASE_ANTERIOR.version} (${RELEASE_ANTERIOR.commit.slice(0, 7)}): ${a.stderr}`);
    ANTES_TALLER = path.join(d, "taller-demo");
    if (!fs.readFileSync(path.join(ANTES_TALLER, "sw.js"), "utf8").includes(`const CACHE_NAME = "entimotors-v${RELEASE_ANTERIOR.version}";`)) throw new Error(`${RELEASE_ANTERIOR.commit.slice(0, 7)} no trae el sw.js ${RELEASE_ANTERIOR.version}`);
    ANTES_MT = path.join(raizTmp, "antes-mt");
    const b = spawnSync("bash", [path.join(ANTES_TALLER, "hacer-build-mecanicos.sh"), ANTES_MT], { encoding: "utf8", env: { PATH: process.env.PATH, LC_ALL: "C.UTF-8" } });
    if (b.status !== 0) throw new Error(`no se pudo generar Mi Trabajo ${RELEASE_ANTERIOR.version}: ${b.stderr || b.stdout}`);
  }

  const cambiar = (de, a) => (t) => { const r = t.split(de).join(a); if (r === t) throw new Error(`mutante sin efecto: ${de}`); return r; };
  const componer = (...fs) => (t) => fs.reduce((acc, f) => f(acc), t);
  const MUTANTES = {
    // app.js: F-SEC-2 (sin esc() en el rol) + rol desconocido (sin lista blanca) + OBS-3 (eliminar cita con exigeGestion)
    // + F-SEC-1 / TOAST-XSS (3.15.1: el escape vive en toast(); se revierte allí, aviso() de usuarios.js ya entrega texto plano)
    "app.js": componer(
      cambiar('(${esc(NOMBRE_ROL[currentUser?.rol] || currentUser?.rol || "—")})', '(${NOMBRE_ROL[currentUser?.rol] || currentUser?.rol || "—"})'),
      cambiar('if (typeof session.rol !== "string" || !ROLES_DEL_TALLER.includes(session.rol))', "if (false)"),
      cambiar('if (!esAdmin()) { bloquear("Solo el administrador elimina una cita"); return; }', 'if (!exigeGestion("Solo el administrador elimina una cita")) return;'),
      cambiar("${esc(msg)}`;", "${msg}`;")),
    // auth.js: F-FUNC-1 (sin conservar sin-conexion/tiempo-agotado) + OBS-4 (sin validar la forma del 200)
    "auth.js": componer(
      cambiar('if (r.motivo === "sin-conexion" || r.motivo === "tiempo-agotado") return mal(r.motivo, r.detalle);', ""),
      cambiar('if (!r.datos || typeof r.datos !== "object" || Array.isArray(r.datos)) return mal("respuesta-invalida");', "")),
    // supabase-client.js: OBS-5 (extraccion anterior: los objetos pasan como objeto)
    "supabase-client.js": cambiar("primeraCadena([cuerpo.message, cuerpo.msg, cuerpo.error_description, cuerpo.error])", "(cuerpo.message || cuerpo.error_description || cuerpo.error)"),
  };
  const fase = { sw: "pre" };
  const def = {
    app: { nombre: "taller-app", dir: TALLER, modo: "app" },
    mt: { nombre: "mt-app", dir: BUILD_MT, modo: "app" },
    mut: { nombre: "mut-app", dir: TALLER, modo: "app", mutar: MUTANTES },
    "pwa-taller": { nombre: "pwa-taller", dir: TALLER, modo: "raw", prefijo: "/taller" },
    "pwa-mt": { nombre: "pwa-mt", dir: BUILD_MT, modo: "raw", prefijo: "/mt" },
    "upg-taller": { nombre: "upg-taller", dir: TALLER, modo: "raw", prefijo: "/u1", dirActual: () => (fase.sw === "pre" ? ANTES_TALLER : TALLER), ctl: { sw: (v) => { fase.sw = v; } } },
    "upg-mt": { nombre: "upg-mt", dir: BUILD_MT, modo: "raw", prefijo: "/u2", dirActual: () => (fase.sw === "pre" ? ANTES_MT : BUILD_MT), ctl: { sw: (v) => { fase.sw = v; } } },
  };
  const origenes = {};
  for (const s of suites) { origenes[s] = await crearOrigen({ ...def[s], colector }); limpiezas.push(() => origenes[s].cerrar()); }
  const muerto = await puertoLibre();   // puerto en el que NADIE escucha: sirve para provocar un rechazo de red REAL del motor

  const informe = { navegadores: [], suites: [], externos: [], hosts: {}, perfilesBorrados: 0 };
  for (const nav of navs) {
    informe.navegadores.push({ id: nav.id, etiqueta: nav.etiqueta, ruta: nav.ruta || null, version: nav.version || null, disponible: nav.disponible });
    if (!nav.disponible) continue;
    for (const s of suites) {
      const run = `${nav.id}-${s}-${Date.now()}`;
      const perfil = crearPerfil(nav.id);
      const o = origenes[s];
      const pagina = `${o.url}/__h/harness.html?run=${encodeURIComponent(run)}&suite=${s}&browser=${nav.id}&muerto=${muerto}`;
      fase.sw = "pre"; o.estado.desconectado = false;   // cada corrida parte del estado inicial (el origen se comparte entre navegadores)
      const antes = trampa.intentos.length;
      const { hijo, stderr } = lanzar(nav, pagina, perfil, trampa.puerto);
      const termino = await colector.esperarFin(run, PLAZO_MS[s] || 120000);
      await matar(hijo);
      const res = colector.resultado(run);
      informe.suites.push({ navegador: nav.id, suite: s, termino, casos: res.casos, logs: res.logs, externosTrampa: trampa.intentos.slice(antes), pid: hijo.pid, stderr: termino ? "" : stderr().slice(0, 500) });
      if (!JSON_SALIDA) process.stdout.write(`  ${nav.id.padEnd(9)} ${s.padEnd(11)} ${termino ? "fin" : "TIMEOUT"} · ${res.casos.filter((c) => c.estado === "PASS").length}/${res.casos.length} PASS\n`);
    }
  }
  // Integridad: lo que el navegador hashea de cada archivo de runtime debe coincidir con el disco (mutantes excluidos: alteran a proposito).
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  informe.integridad = { comparados: 0, distintos: [] };
  for (const su of informe.suites.filter((x) => ["app", "mt"].includes(x.suite))) {
    const c = su.casos.find((k) => /^INTEGRIDAD/.test(k.nombre)); if (!c || !c.extras || !c.extras.sha) { informe.integridad.distintos.push(`${su.navegador}/${su.suite}: sin datos`); continue; }
    for (const [f, h] of Object.entries(c.extras.sha)) { informe.integridad.comparados++; const disco = sha(fs.readFileSync(path.join(def[su.suite].dir, f))); if (disco !== h) informe.integridad.distintos.push(`${su.navegador}/${su.suite}/${f}`); }
  }
  // Cachés por target (deben ser distintas y exactas)
  const cacheDe = (suite, nav) => { const su = informe.suites.find((x) => x.suite === suite && x.navegador === nav); const c = su && su.casos.find((k) => /CacheStorage contiene/.test(k.nombre)); return c && c.extras ? c.extras.caches : null; };
  informe.cachesPorTarget = Object.fromEntries(navs.filter((n) => n.disponible).map((n) => [n.id, { taller: cacheDe("pwa-taller", n.id), mitrabajo: cacheDe("pwa-mt", n.id) }]));
  informe.externos = trampa.intentos.slice();
  informe.externosPorClase = { BROWSER_BACKGROUND: 0, EXPECTED_SW_EXTRAS: 0, UNEXPECTED_EXTERNAL_REQUEST: 0 }; informe.externosInesperados = [];
  for (const su of informe.suites) for (const it of su.externosTrampa) {
    const c = clasificarExterno(it, su.suite); informe.externosPorClase[c]++;
    if (c === "UNEXPECTED_EXTERNAL_REQUEST") informe.externosInesperados.push({ navegador: su.navegador, suite: su.suite, ...it });
  }
  informe.origenes = Object.fromEntries(Object.entries(origenes).map(([k, o]) => [k, o.url]));

  // limpieza de perfiles (antes de informar, para poder comprobarlo)
  for (const p of perfilesCreados) { try { fs.rmSync(p, { recursive: true, force: true }); informe.perfilesBorrados++; } catch { /* se reporta abajo */ } }
  informe.perfilesRestantes = perfilesCreados.filter((p) => fs.existsSync(p));
  const vivos = spawnSync("sh", ["-c", "pgrep -af 'entimotors-c3browser' || true"], { encoding: "utf8" }).stdout.trim();
  informe.procesosNavegadorVivos = vivos ? vivos.split("\n").filter((l) => !/pgrep/.test(l)).length : 0;

  const fallos = informe.suites.flatMap((s) => s.casos.filter((c) => c.estado !== "PASS").map((c) => ({ ...c, navegador: s.navegador, suite: s.suite })));
  const sinTerminar = informe.suites.filter((s) => !s.termino);
  const externosCasos = informe.suites.reduce((a, su) => a + su.casos.reduce((b, c) => b + (c.externos || 0), 0), 0);
  informe.externosDePagina = externosCasos;
  informe.resumen = { externosDePagina: externosCasos, externosInesperadosSumidero: informe.externosInesperados.length, casos: informe.suites.reduce((a, s) => a + s.casos.length, 0), fallos: fallos.length, sinTerminar: sinTerminar.length };
  if (JSON_SALIDA) process.stdout.write(JSON.stringify(informe) + "\n");
  else {
    for (const f of fallos) process.stdout.write(`  FAIL [${f.navegador}/${f.suite}] ${f.nombre}\n        ${f.detalle}\n`);
    for (const s of sinTerminar) process.stdout.write(`  SIN TERMINAR [${s.navegador}/${s.suite}] ${s.stderr}\n`);
    for (const d of informe.integridad.distintos) process.stdout.write(`  INTEGRIDAD distinta: ${d}\n`);
    for (const x of informe.externosInesperados) process.stdout.write(`  UNEXPECTED_EXTERNAL_REQUEST [${x.navegador}/${x.suite}] ${x.via} ${x.destino}\n`);
    process.stdout.write(`\nresumen: ${informe.resumen.casos} casos · ${informe.resumen.fallos} FAIL · ${informe.resumen.sinTerminar} suites sin terminar · externos de pagina: ${externosCasos} · sumidero: ${JSON.stringify(informe.externosPorClase)}\n`);
  }
  salida = fallos.length || sinTerminar.length || informe.externosInesperados.length || externosCasos || informe.integridad.distintos.length ? 1 : 0;
} catch (e) {
  process.stderr.write(`ERROR del runner: ${e.stack || e}\n`);
  salida = 2;
} finally {
  for (const f of limpiezas.reverse()) { try { await f(); } catch { /* mejor esfuerzo */ } }
  for (const p of perfilesCreados) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ya borrado */ } }
}
process.exit(salida);
