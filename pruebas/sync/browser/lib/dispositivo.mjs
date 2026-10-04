// UN «DISPOSITIVO» = un navegador REAL (Chrome o Firefox, headless, perfil temporal nuevo) con su propio origen (puerto) = su propio
// IndexedDB/localStorage/CacheStorage, aislado de los demás. Sirve taller-demo/ SIN modificarlo y deja que Node lo maneje por un puente
// (la página pregunta «¿hay algo que ejecutar?» y devuelve el resultado). Sin WebDriver, sin dependencias, sin salida a Internet.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REST_URL, RED } from "./pila.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../../../..");
const TALLER_REPO = path.join(RAIZ, "taller-demo");
const HARNESS = path.resolve(AQUI, "../harness");
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const buscar = (nombres) => { for (const n of nombres) { const p = spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }).stdout.trim(); if (p) return p; } return null; };
export const NAVEGADORES = { chromium: buscar(["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]), firefox: buscar(["firefox"]) };

const PREFS_FF = [["browser.shell.checkDefaultBrowser", false], ["browser.startup.homepage_override.mstone", "ignore"], ["browser.aboutwelcome.enabled", false], ["datareporting.policy.dataSubmissionEnabled", false],
  ["toolkit.telemetry.enabled", false], ["app.update.enabled", false], ["app.normandy.enabled", false], ["network.captive-portal-service.enabled", false], ["extensions.update.enabled", false],
  ["services.settings.server", "http://127.0.0.1:1/v1"], ["dom.serviceWorkers.enabled", true], ["browser.tabs.warnOnClose", false], ["network.prefetch-next", false],
  ["network.proxy.allow_hijacking_localhost", false],
  // 3.15 (Bloque 8): reabrir() con el MISMO perfil NO debe restaurar la sesión anterior: Firefox reponía la pestaña vieja junto a la nueva
  // (una de ellas en otro contexto de almacenamiento, userContextId) y DOS páginas contestaban al puente — una sin datos
  ["browser.sessionstore.resume_from_crash", false], ["browser.sessionstore.max_resumed_crashes", 0], ["browser.startup.page", 0],
  ["browser.sessionstore.resume_session_once", false],
  // … y la pestaña oculta que SÍ aparecía era de Firefox: renderiza la página visitada en segundo plano (miniaturas de «sitios frecuentes»
  // de Nueva pestaña), con almacenamiento propio vacío. Fuera:
  ["browser.pagethumbnails.capturing_disabled", true], ["browser.newtabpage.enabled", false], ["browser.newtabpage.activity-stream.feeds.topsites", false],
  ["browser.newtab.preload", false]].map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n";

/* 3.15 (Bloque 7): `extra` = { ventana: [ancho, alto], gc: true (Chromium: window.gc para medir memoria), tactil: true (puntero «coarse» sin
   hover, como un teléfono: EMULADO — la prueba lo confirma con matchMedia) }. Sin extra, idéntico a antes. */
function lanzar(nav, url, perfil, extra = {}) {
  let args;
  const [vw, vh] = extra.ventana || [1280, 900];
  if (nav === "chromium") {
    args = ["--headless=new", ...(extra.gc ? ["--js-flags=--expose-gc"] : []),
      // 3.15 (Bloque 7): proxySumidero = TODO lo que no es 127.0.0.1 (Internet: el CDN de Chart.js) va a un proxy que acepta y nunca responde («lie-fi»)
      ...(extra.proxySumidero ? [`--proxy-server=http://127.0.0.1:${extra.proxySumidero}`] : []),
      ...(extra.tactil ? ["--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1", "--touch-events=enabled"] : []), `--user-data-dir=${perfil}`, ...(process.env.DEBUG_CDP ? [`--remote-debugging-port=${process.env.DEBUG_CDP}`] : []), "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update",
      "--disable-default-apps", "--metrics-recording-only", "--disable-breakpad", "--mute-audio", "--password-store=basic", "--disable-search-engine-choice-screen", `--window-size=${vw},${vh}`,
      ...(process.env.QA_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), url];
  } else {
    const proxyFf = extra.proxySumidero ? [["network.proxy.type", 1], ["network.proxy.http", "127.0.0.1"], ["network.proxy.http_port", extra.proxySumidero], ["network.proxy.ssl", "127.0.0.1"],
      ["network.proxy.ssl_port", extra.proxySumidero], ["network.proxy.no_proxies_on", "localhost, 127.0.0.1"]].map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n" : "";
    fs.writeFileSync(path.join(perfil, "user.js"), PREFS_FF + proxyFf + (extra.tactil ? ["ui.primaryPointerCapabilities", "ui.allPointerCapabilities"].map((k) => `user_pref("${k}", 1);`).join("\n") + "\nuser_pref(\"dom.w3c_touch_events.enabled\", 1);\n" : ""));
    args = ["--headless", "--no-remote", "--profile", perfil, url];
  }
  const xdg = (n) => { const d = path.join(perfil, `.xdg-${n}`); fs.mkdirSync(d, { recursive: true }); return d; };
  const e = { ...process.env, XDG_CONFIG_HOME: xdg("config"), XDG_CACHE_HOME: xdg("cache"), XDG_DATA_HOME: xdg("data"), XDG_STATE_HOME: xdg("state") };
  // 3.15 (Bloque 7): Firefox headless ignora --window-size; su tamaño de ventana va por estas variables (sin ventana pedida: como antes)
  if (nav !== "chromium" && extra.ventana) { e.MOZ_HEADLESS_WIDTH = String(vw); e.MOZ_HEADLESS_HEIGHT = String(vh); }
  return spawn(NAVEGADORES[nav], args, { detached: true, stdio: ["ignore", "ignore", "pipe"], env: e });
}
const salio = (h, ms) => new Promise((r) => { if (h.exitCode !== null || h.signalCode) return r(true); const t = setTimeout(() => r(false), ms); h.once("exit", () => { clearTimeout(t); r(true); }); });
async function matar(h) { for (const s of ["SIGTERM", "SIGKILL"]) { try { process.kill(-h.pid, s); } catch { /* ya no está */ } if (await salio(h, s === "SIGTERM" ? 3000 : 2000)) break; } }

/** Abre un dispositivo. opciones: { navegador: "chromium"|"firefox", nombre, pagina, real }
    real:true → `pagina` se sirve desde taller-demo/ tal cual (p. ej. "index.html", la app de verdad), con el
    puente inyectado (ver arriba); por defecto (real:false) se sirve desde /__h/ (el arnés, pagina.html). */
export async function abrirDispositivo({ navegador = "chromium", nombre = "dispositivo", pagina = "pagina.html", real = false, apiUrl = "", producto = null, raiz = null, ventana = null, gc = false, redEstaticos = false, tactil = false, proxySumidero = null, plazoApertura = 30000 } = {}) {
  // SYNC-10: raiz = otra carpeta a servir en lugar de taller-demo/ (p. ej. la app 3.13.0 extraída del tag, para generar un
  // respaldo 3.13 REAL con su propio código). Sin raiz, idéntico a antes.
  let TALLER = raiz ? path.resolve(raiz) : TALLER_REPO;
  // 3.15 (Bloque 8): actualización de la PWA en el MISMO origen → servir(otraRaiz) cambia lo publicado; sinRedApp = los archivos de la
  // app no responden (corte de red), pero el puente del arnés (/__cmd, /__res, /__h/) sigue vivo para poder observar la página.
  let sinRedApp = false;
  if (!NAVEGADORES[navegador]) throw new Error(`no hay ${navegador} instalado`);
  const cola = []; const esperando = []; const pendientes = new Map(); let sigId = 1;
  const peticionesEstaticas = [];
  const bytesEstaticos = { n: 0, bytes: 0 };
  // 3.15 (Bloque 8): DEBUG_PUENTE=<archivo> registra cuándo se encola/entrega cada orden del puente (diagnóstico de demoras)
  const traza = (ev, x) => { if (process.env.DEBUG_PUENTE) fs.appendFileSync(process.env.DEBUG_PUENTE, `${Date.now()} ${nombre} ${ev} ${x ?? ""}\n`); };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/__cmd") {
      const entregar = (c) => { traza("entrega", c && c.id); res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(c)); };
      if (cola.length) return entregar(cola.shift());
      const w = { entregar, vivo: () => !req.socket.destroyed && !res.writableEnded, t: setTimeout(() => { const i = esperando.indexOf(w); if (i >= 0) esperando.splice(i, 1); entregar({}); }, 15000) };
      traza("espera", `${esperando.length + 1} pagina=${req.headers["x-pagina"] || "?"}`);
      esperando.push(w); req.on("close", () => { const i = esperando.indexOf(w); if (i >= 0) { esperando.splice(i, 1); traza("espera-cerrada", i); } clearTimeout(w.t); });
      return;
    }
    if (u.pathname === "/__res" && req.method === "POST") {
      let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { try { const r = JSON.parse(b); const p = pendientes.get(r.id); if (p) { pendientes.delete(r.id); clearTimeout(p.t); r.ok ? p.ok(r.valor) : p.mal(new Error(r.error)); } } catch { /* ignorar */ } res.writeHead(204); res.end(); });
      return;
    }
    if (sinRedApp && !u.pathname.startsWith("/__h/")) { req.socket.destroy(); return; }
    if (u.pathname === "/__h/cfg.js") { res.writeHead(200, { "Content-Type": TIPOS[".js"], "Cache-Control": "no-store" }); return res.end(`window.__pila = ${JSON.stringify({ restUrl: REST_URL, anonKey: "anon-sintetica", nombre })};`); }
    // SYNC-6 sección 2 (real:true, index.html de verdad): supabase-config.js de disco apunta a producción
    // (taller-demo/supabase-config.js, url real + anon key real) — NUNCA se sirve tal cual en una prueba.
    // Se sustituye por una versión sintética que apunta al gateway local, ANTES de que supabase-client.js
    // (que se carga justo después en index.html) la lea. index.html/supabase-config.js en disco no se tocan.
    if (u.pathname === "/supabase-config.js") {
      res.writeHead(200, { "Content-Type": TIPOS[".js"], "Cache-Control": "no-store" });
      // 3.15 (Bloque 6): gestorWebUrl es una URL PÚBLICA (no un secreto ni un destino de datos): se toma tal cual del supabase-config.js
      // de la carpeta servida (el artefacto, si raiz apunta a un build), para probar el valor real configurado.
      const gestorWebUrl = (() => { try { return (fs.readFileSync(path.join(TALLER, "supabase-config.js"), "utf8").match(/gestorWebUrl:\s*"([^"]+)"/) || [])[1]; } catch { return undefined; } })();
      return res.end(`window.ENTIMOTORS_SUPABASE = ${JSON.stringify({ url: REST_URL, anonKey: "anon-sintetica", habilitado: true, apiUrl, gestorWebUrl })};`);   // apiUrl: el api-server LOCAL de pruebas (SYNC-7B) o vacío
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
    // 3.15 (Bloque 7): redEstaticos = los archivos de la app también viajan por el perfil de red del gateway (arranque en frío por red lenta)
    // 3.15 (Bloque 8 · 8A): el perfil de red es de los archivos de la APP; el puente del arnés (/__h/) no se retrasa (si no, la prueba
    // arrancaría la app tarde y mediría su propio retraso)
    if (redEstaticos && base === TALLER && RED.latenciaMs > 0) await new Promise((r) => setTimeout(r, RED.latenciaMs));
    let cuerpo = fs.readFileSync(f);
    // SYNC-6 sección 2: al servir un .html REAL de taller-demo (no la página del arnés) se inyecta el
    // puente justo antes de </body> para poder controlarlo con d.eval() igual que pagina.html — el
    // index.html en disco no se toca. Las pruebas SYNC-1..5 nunca piden un .html de TALLER (solo /__h/
    // pagina.html), así que esto no las afecta.
    if (base === TALLER && /\.html?$/i.test(f)) {
      const texto = cuerpo.toString("utf8");
      if (/<\/body>/i.test(texto)) cuerpo = Buffer.from(texto.replace(/<\/body>/i, '<script src="/__h/bridge.js"></script></body>'));
    }
    bytesEstaticos.n++; bytesEstaticos.bytes += cuerpo.length;
    if (redEstaticos && base === TALLER && RED.kbps > 0) await new Promise((r) => setTimeout(r, cuerpo.length / ((RED.kbps * 1024) / 8 / 1000)));
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(cuerpo);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const puerto = srv.address().port, origen = `http://127.0.0.1:${puerto}`;
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), `entimotors-sync-${navegador}-`));
  const URL_INICIO = `${origen}/${real ? String(pagina).replace(/^\/+/, "") : "__h/" + pagina}`;
  let hijo = lanzar(navegador, URL_INICIO, perfil, { ventana, gc, tactil, proxySumidero });
  let errBrowser = ""; hijo.stderr.on("data", (d) => { if (errBrowser.length < 4000) errBrowser += d; });

  const dispositivo = {
    nombre, navegador, origen, perfil, peticiones: peticionesEstaticas, estaticos: bytesEstaticos, pid: hijo.pid,
    /** Ejecuta `fn(arg)` DENTRO de la página (puede ser async) y devuelve su resultado (JSON). */
    eval(fn, arg, { plazoMs = 40000 } = {}) {
      const id = sigId++;
      const cmd = { id, fn: typeof fn === "function" ? fn.toString() : String(fn), arg: arg === undefined ? null : arg };
      return new Promise((ok, mal) => {
        const t = setTimeout(() => { pendientes.delete(id); mal(new Error(`plazo agotado (${plazoMs} ms) en ${nombre}`)); }, plazoMs);
        pendientes.set(id, { ok, mal, t });
        // 3.15 (Bloque 8): nunca a una espera cuya conexión ya murió (p. ej. la del navegador que se está cerrando en reabrir()): la orden se perdería
        let w = esperando.shift(); while (w && !w.vivo()) { clearTimeout(w.t); w = esperando.shift(); }
        traza("orden", `${id} ${w ? "a-espera" : "a-cola"} esperando=${esperando.length}`); if (w) { clearTimeout(w.t); w.entregar(cmd); } else cola.push(cmd);
      });
    },
    /** Espera a que la página esté lista (puente activo). */
    async listo(plazoMs = 30000) { return dispositivo.eval(() => document.readyState, null, { plazoMs }); },
    /** Reinicia el navegador conservando el perfil (= cerrar y volver a abrir la app en el mismo dispositivo). */
    async cerrar() {
      for (const w of esperando.splice(0)) { clearTimeout(w.t); try { w.entregar({}); } catch { /* ya */ } }
      await matar(hijo); srv.closeAllConnections?.(); await new Promise((r) => srv.close(r));   // hijo: el ACTUAL (tras reabrir)
      try { fs.rmSync(perfil, { recursive: true, force: true }); } catch { /* ya */ }
    },
    stderrNavegador: () => errBrowser,
    /** 3.15 (Bloque 8): publica otra carpeta en el mismo origen (la «versión nueva» del sitio). */
    servir(nuevaRaiz) { TALLER = path.resolve(nuevaRaiz); },
    /** 3.15 (Bloque 8): true = los archivos de la app no responden (socket cortado); el puente sigue. */
    redApp(hay) { sinRedApp = !hay; },
    /** 3.15 (Bloque 8): cierra el navegador y lo vuelve a abrir con el MISMO perfil y el mismo origen (cerrar la app y reabrirla). */
    async reabrir(plazoMs = 60000) {
      for (const w of esperando.splice(0)) { clearTimeout(w.t); try { w.entregar({}); } catch { /* ya */ } }
      // cierre ORDENADO (como cerrar la app): SIGTERM solo al proceso principal y tiempo para que guarde su estado (localStorage se
      // escribe a disco en diferido; matar el grupo entero lo pierde). Si no sale, el cierre forzado de siempre.
      try { process.kill(hijo.pid, "SIGTERM"); } catch { /* ya */ }
      // el grupo entero (Firefox deja procesos propios tras salir el lanzado): se espera a que no quede NINGUNO antes de forzar
      const grupoVivo = () => { try { process.kill(-hijo.pid, 0); return true; } catch { return false; } };
      const t0c = Date.now(); await salio(hijo, 10000); try { process.kill(-hijo.pid, "SIGTERM"); } catch { /* ya */ }
      while (grupoVivo() && Date.now() - t0c < 15000) await new Promise((x) => setTimeout(x, 100));
      const ordenado = !grupoVivo();
      if (process.env.DEBUG_REABRIR) fs.appendFileSync(process.env.DEBUG_REABRIR, `${nombre} cierre ${ordenado ? "ordenado" : "FORZADO"} ${Date.now() - t0c} ms\n`);
      if (!ordenado) await matar(hijo);
      try { process.kill(-hijo.pid, "SIGKILL"); } catch { /* restos del grupo */ }
      for (const w of esperando.splice(0)) { clearTimeout(w.t); try { w.entregar({}); } catch { /* ya */ } }   // las que abrió el navegador viejo mientras cerraba
      hijo = lanzar(navegador, URL_INICIO, perfil, { ventana, gc, tactil, proxySumidero }); errBrowser = "";
      peticionesEstaticas.push("[reabrir]");
      hijo.stderr.on("data", (d) => { if (errBrowser.length < 4000) errBrowser += d; });
      dispositivo.pid = hijo.pid;
      try { return await dispositivo.listo(plazoMs); }
      catch (e) {
        if (process.env.DEBUG_CDP) { try { const t = await (await fetch(`http://127.0.0.1:${process.env.DEBUG_CDP}/json`)).json(); fs.appendFileSync(process.env.DEBUG_CDP_SALIDA || "/dev/stderr", JSON.stringify(t.map((x) => ({ type: x.type, url: x.url, title: x.title }))) + "\n");
          const pg = t.find((x) => x.type === "page"); const { default: WS } = await import(path.join(TALLER_REPO, "../api-server/node_modules/ws/index.js"));
          const ws = new WS(pg.webSocketDebuggerUrl); await new Promise((r) => ws.on("open", r));
          const expr = `JSON.stringify({ v: typeof VERSION_APP !== "undefined" ? VERSION_APP : null, rs: document.readyState, puente: [...document.scripts].map((x) => x.src).filter((x) => /__h/.test(x)), ctrl: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.state : null, gate: [...document.querySelectorAll(".gate.active, .modal.active")].map((x) => x.id), errores: window.__errores || null })`;
          ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, timeout: 3000 } }));
          const res = await Promise.race([new Promise((r) => ws.on("message", (m) => r(String(m)))), new Promise((r) => setTimeout(() => r("SIN RESPUESTA (hilo principal ocupado)"), 5000))]);
          fs.appendFileSync(process.env.DEBUG_CDP_SALIDA || "/dev/stderr", res + "\n"); ws.close(); } catch (x) { fs.appendFileSync(process.env.DEBUG_CDP_SALIDA || "/dev/stderr", "cdp: " + x.message + "\n"); } }
        throw new Error(`${e.message} al REABRIR (vivo: ${hijo.exitCode === null && !hijo.signalCode}; últimas peticiones: ${peticionesEstaticas.slice(-6).join(" ")}; stderr: ${errBrowser.slice(-300).replace(/\s+/g, " ")})`); }
    },
  };
  /* 3.15 (Bloque 6) · CAUSA del «incidente Docker» de los Bloques 4–5: si la página no quedaba lista a tiempo, esto lanzaba ANTES de
     devolver el dispositivo, así que nadie podía cerrarlo: el navegador (detached) y este servidor HTTP quedaban vivos y el proceso de
     node no terminaba nunca. Visto desde fuera: la suite «se colgaba» y el REST «desaparecía» (era el cierre NORMAL de la pila en el
     after() de la suite). Ahora un dispositivo que no abre se cierra aquí mismo y el error dice qué pasó. */
  try { await dispositivo.listo(plazoApertura); }
  catch (e) {
    try { await dispositivo.cerrar(); } catch { /* ya */ }
    throw new Error(`${e.message} (el dispositivo no llegó a abrir; se cerró. stderr del navegador: ${errBrowser.slice(-400).replace(/\s+/g, " ")})`);
  }
  return dispositivo;
}
