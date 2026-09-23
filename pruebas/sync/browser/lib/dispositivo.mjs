// UN «DISPOSITIVO» = un navegador REAL (Chrome o Firefox, headless, perfil temporal nuevo) con su propio origen (puerto) = su propio
// IndexedDB/localStorage/CacheStorage, aislado de los demás. Sirve taller-demo/ SIN modificarlo y deja que Node lo maneje por un puente
// (la página pregunta «¿hay algo que ejecutar?» y devuelve el resultado). Sin WebDriver, sin dependencias, sin salida a Internet.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REST_URL } from "./pila.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../../../..");
const TALLER = path.join(RAIZ, "taller-demo");
const HARNESS = path.resolve(AQUI, "../harness");
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const buscar = (nombres) => { for (const n of nombres) { const p = spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }).stdout.trim(); if (p) return p; } return null; };
export const NAVEGADORES = { chromium: buscar(["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]), firefox: buscar(["firefox"]) };

const PREFS_FF = [["browser.shell.checkDefaultBrowser", false], ["browser.startup.homepage_override.mstone", "ignore"], ["browser.aboutwelcome.enabled", false], ["datareporting.policy.dataSubmissionEnabled", false],
  ["toolkit.telemetry.enabled", false], ["app.update.enabled", false], ["app.normandy.enabled", false], ["network.captive-portal-service.enabled", false], ["extensions.update.enabled", false],
  ["services.settings.server", "http://127.0.0.1:1/v1"], ["dom.serviceWorkers.enabled", true], ["browser.tabs.warnOnClose", false], ["network.prefetch-next", false],
  ["network.proxy.allow_hijacking_localhost", false]].map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n";

function lanzar(nav, url, perfil) {
  let args;
  if (nav === "chromium") {
    args = ["--headless=new", `--user-data-dir=${perfil}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update",
      "--disable-default-apps", "--metrics-recording-only", "--disable-breakpad", "--mute-audio", "--password-store=basic", "--disable-search-engine-choice-screen", "--window-size=1280,900",
      ...(process.env.QA_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), url];
  } else {
    fs.writeFileSync(path.join(perfil, "user.js"), PREFS_FF);
    args = ["--headless", "--no-remote", "--profile", perfil, url];
  }
  const xdg = (n) => { const d = path.join(perfil, `.xdg-${n}`); fs.mkdirSync(d, { recursive: true }); return d; };
  const e = { ...process.env, XDG_CONFIG_HOME: xdg("config"), XDG_CACHE_HOME: xdg("cache"), XDG_DATA_HOME: xdg("data"), XDG_STATE_HOME: xdg("state") };
  return spawn(NAVEGADORES[nav], args, { detached: true, stdio: ["ignore", "ignore", "pipe"], env: e });
}
const salio = (h, ms) => new Promise((r) => { if (h.exitCode !== null || h.signalCode) return r(true); const t = setTimeout(() => r(false), ms); h.once("exit", () => { clearTimeout(t); r(true); }); });
async function matar(h) { for (const s of ["SIGTERM", "SIGKILL"]) { try { process.kill(-h.pid, s); } catch { /* ya no está */ } if (await salio(h, s === "SIGTERM" ? 3000 : 2000)) break; } }

/** Abre un dispositivo. opciones: { navegador: "chromium"|"firefox", nombre, pagina, real }
    real:true → `pagina` se sirve desde taller-demo/ tal cual (p. ej. "index.html", la app de verdad), con el
    puente inyectado (ver arriba); por defecto (real:false) se sirve desde /__h/ (el arnés, pagina.html). */
export async function abrirDispositivo({ navegador = "chromium", nombre = "dispositivo", pagina = "pagina.html", real = false, apiUrl = "", producto = null } = {}) {
  if (!NAVEGADORES[navegador]) throw new Error(`no hay ${navegador} instalado`);
  const cola = []; const esperando = []; const pendientes = new Map(); let sigId = 1;
  const peticionesEstaticas = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/__cmd") {
      const entregar = (c) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(c)); };
      if (cola.length) return entregar(cola.shift());
      const w = { entregar, t: setTimeout(() => { const i = esperando.indexOf(w); if (i >= 0) esperando.splice(i, 1); entregar({}); }, 15000) };
      esperando.push(w); req.on("close", () => { const i = esperando.indexOf(w); if (i >= 0) esperando.splice(i, 1); clearTimeout(w.t); });
      return;
    }
    if (u.pathname === "/__res" && req.method === "POST") {
      let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { try { const r = JSON.parse(b); const p = pendientes.get(r.id); if (p) { pendientes.delete(r.id); clearTimeout(p.t); r.ok ? p.ok(r.valor) : p.mal(new Error(r.error)); } } catch { /* ignorar */ } res.writeHead(204); res.end(); });
      return;
    }
    if (u.pathname === "/__h/cfg.js") { res.writeHead(200, { "Content-Type": TIPOS[".js"], "Cache-Control": "no-store" }); return res.end(`window.__pila = ${JSON.stringify({ restUrl: REST_URL, anonKey: "anon-sintetica", nombre })};`); }
    // SYNC-6 sección 2 (real:true, index.html de verdad): supabase-config.js de disco apunta a producción
    // (taller-demo/supabase-config.js, url real + anon key real) — NUNCA se sirve tal cual en una prueba.
    // Se sustituye por una versión sintética que apunta al gateway local, ANTES de que supabase-client.js
    // (que se carga justo después en index.html) la lea. index.html/supabase-config.js en disco no se tocan.
    if (u.pathname === "/supabase-config.js") {
      res.writeHead(200, { "Content-Type": TIPOS[".js"], "Cache-Control": "no-store" });
      return res.end(`window.ENTIMOTORS_SUPABASE = ${JSON.stringify({ url: REST_URL, anonKey: "anon-sintetica", habilitado: true, apiUrl })};`);   // apiUrl: el api-server LOCAL de pruebas (SYNC-7B) o vacío
    }
    // SYNC-8: producto:"mecanico" sirve «Mi Trabajo» (lo que hace hacer-build-mecanicos.sh) sin tocar build-target.js en disco
    if (producto && u.pathname === "/build-target.js") {
      res.writeHead(200, { "Content-Type": TIPOS[".js"], "Cache-Control": "no-store" });
      return res.end(`window.ENTIMOTORS_BUILD = ${JSON.stringify({ producto })};`);
    }
    let base = TALLER, rel = decodeURIComponent(u.pathname);
    if (rel.startsWith("/__h/")) { base = HARNESS; rel = rel.slice(4); }
    if (rel === "/") rel = "/index.html";
    const f = path.join(base, path.normalize(rel));
    if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("no existe"); }
    peticionesEstaticas.push(u.pathname);
    let cuerpo = fs.readFileSync(f);
    // SYNC-6 sección 2: al servir un .html REAL de taller-demo (no la página del arnés) se inyecta el
    // puente justo antes de </body> para poder controlarlo con d.eval() igual que pagina.html — el
    // index.html en disco no se toca. Las pruebas SYNC-1..5 nunca piden un .html de TALLER (solo /__h/
    // pagina.html), así que esto no las afecta.
    if (base === TALLER && /\.html?$/i.test(f)) {
      const texto = cuerpo.toString("utf8");
      if (/<\/body>/i.test(texto)) cuerpo = Buffer.from(texto.replace(/<\/body>/i, '<script src="/__h/bridge.js"></script></body>'));
    }
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(cuerpo);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const puerto = srv.address().port, origen = `http://127.0.0.1:${puerto}`;
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), `entimotors-sync-${navegador}-`));
  const hijo = lanzar(navegador, `${origen}/${real ? String(pagina).replace(/^\/+/, "") : "__h/" + pagina}`, perfil);
  let errBrowser = ""; hijo.stderr.on("data", (d) => { if (errBrowser.length < 4000) errBrowser += d; });

  const dispositivo = {
    nombre, navegador, origen, perfil, peticiones: peticionesEstaticas,
    /** Ejecuta `fn(arg)` DENTRO de la página (puede ser async) y devuelve su resultado (JSON). */
    eval(fn, arg, { plazoMs = 40000 } = {}) {
      const id = sigId++;
      const cmd = { id, fn: typeof fn === "function" ? fn.toString() : String(fn), arg: arg === undefined ? null : arg };
      return new Promise((ok, mal) => {
        const t = setTimeout(() => { pendientes.delete(id); mal(new Error(`plazo agotado (${plazoMs} ms) en ${nombre}`)); }, plazoMs);
        pendientes.set(id, { ok, mal, t });
        const w = esperando.shift(); if (w) { clearTimeout(w.t); w.entregar(cmd); } else cola.push(cmd);
      });
    },
    /** Espera a que la página esté lista (puente activo). */
    async listo(plazoMs = 30000) { return dispositivo.eval(() => document.readyState, null, { plazoMs }); },
    /** Reinicia el navegador conservando el perfil (= cerrar y volver a abrir la app en el mismo dispositivo). */
    async cerrar() {
      for (const w of esperando.splice(0)) { clearTimeout(w.t); try { w.entregar({}); } catch { /* ya */ } }
      await matar(hijo); srv.closeAllConnections?.(); await new Promise((r) => srv.close(r));
      try { fs.rmSync(perfil, { recursive: true, force: true }); } catch { /* ya */ }
    },
    stderrNavegador: () => errBrowser,
  };
  await dispositivo.listo();
  return dispositivo;
}
