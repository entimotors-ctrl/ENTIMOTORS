// SERVICE WORKER y PWA REALES. Aqui NO hay prelude ni transformacion alguna: el navegador registra el sw.js REAL, byte a byte, desde un
// origen localhost propio (perfil limpio → CacheStorage vacio). Tres variantes:
//   taller     → taller-demo/ bajo /taller/        (CACHE_NAME entimotors-v3.13.0)
//   mitrabajo  → build de «Mi Trabajo» en /tmp bajo /mt/  (CACHE_NAME entimotors-mitrabajo-v3.13.0)
//   upgrade    → primero el sw.js de HEAD (3.12.2, leido del commit) y luego el REAL 3.13.0 en el MISMO origen y URL
// Nota: el sw.js real intenta bajar 2 librerias del CDN (EXTRAS) con .catch(): el navegador se lanza con un proxy-sumidero, asi que
// esas 2 peticiones fallan cerradas y se anotan aparte (EXPECTED_SW_EXTRAS); nunca hay salida real a Internet.
import { crearBanco, esperarHasta, pausa, ok, igual, mismo } from "/__h/helpers/pagina.js";

const sha = async (buf) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
const shellDe = (textoSw) => { const m = /const SHELL = \[([\s\S]*?)\];/.exec(textoSw); ok(m, "no se encontro SHELL en sw.js"); return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]); };
const activado = (reg) => esperarHasta(() => reg.active && reg.active.state === "activated", { ms: 25000, desc: "Service Worker activado" });

export async function correr(ctx) {
  const B = crearBanco(ctx); const { caso } = B; const modo = ctx.modo;
  const base = modo === "taller" ? "/taller/" : modo === "mitrabajo" ? "/mt/" : "/up/";
  const CACHE = modo === "mitrabajo" ? "entimotors-mitrabajo-v3.13.0" : "entimotors-v3.13.0";
  const opc = { grupo: `PWA ${modo}`, errorCritico: false };
  const ctl = (ruta) => fetch(ruta, { cache: "no-store" });

  await caso("SW REAL · el navegador soporta Service Worker, CacheStorage y el origen localhost es contexto seguro", async () => {
    ok("serviceWorker" in navigator, "sin serviceWorker"); ok(!!window.caches, "sin CacheStorage"); ok(window.isSecureContext, "el origen no es seguro");
    mismo(await caches.keys(), [], "el perfil debe estar limpio: CacheStorage vacio");
    return { origen: location.origin, perfilLimpio: true };
  }, opc);

  if (modo === "upgrade") {
    await caso("UPGRADE 3.12.2 → 3.13.0 · PRE real (sw.js de HEAD) instala solo entimotors-v3.12.2; el 3.13.0 real queda ESPERANDO sin skipWaiting; «activar-ya» lo activa y borra la caché vieja", async () => {
      const t = {};
      // ── PRE: el servidor entrega el sw.js REAL de HEAD (3.12.2) ──
      const pre = await (await ctl(base + "sw.js")).text(); ok(/entimotors-v3\.12\.2/.test(pre) && !/entimotors-v3\.13\.0/.test(pre), "el sw.js de PRE no es el 3.12.2");
      const reg = await navigator.serviceWorker.register(base + "sw.js", { updateViaCache: "none" }); await activado(reg);
      t.cachesPre = await caches.keys(); mismo(t.cachesPre, ["entimotors-v3.12.2"], "PRE: solo la cache 3.12.2");
      // Un CLIENTE controlado por el SW viejo (como la pestaña de la app abierta): sin él, el navegador promueve al nuevo SW al instante
      // (la especificacion solo mantiene «waiting» mientras algun cliente use el SW anterior).
      const f = document.createElement("iframe"); document.body.appendChild(f); f.src = base + "icons/icon-192.png";
      await new Promise((r) => f.addEventListener("load", r, { once: true }));
      await esperarHasta(() => f.contentWindow.navigator.serviceWorker.controller, { ms: 8000, desc: "cliente controlado por el SW 3.12.2" });
      let cambioDeControl = 0; f.contentWindow.navigator.serviceWorker.addEventListener("controllerchange", () => { cambioDeControl++; });
      t.clienteControlado = "SI";
      // ── POST: el MISMO origen y URL pasan a servir el sw.js REAL 3.13.0 ──
      await ctl("/__ctl/sw?v=post");
      const post = await (await ctl(base + "sw.js")).text(); ok(/entimotors-v3\.13\.0/.test(post), "el servidor no cambio al sw.js 3.13.0");
      await reg.update();
      await esperarHasta(() => reg.waiting, { ms: 25000, desc: "SW 3.13.0 instalado y en espera" });
      ok(reg.installing === null || reg.installing === undefined || reg.installing.state !== "installing", "sigue instalando");
      t.estadoNuevo = reg.waiting.state; igual(reg.waiting.state, "installed", "el nuevo debe quedar «installed» (waiting)");
      await pausa(3000);   // margen: SIN skipWaiting no debe activarse solo
      ok(reg.waiting && reg.waiting.state === "installed", "el 3.13.0 se activo SOLO: hay skipWaiting automatico");
      t.cachesEsperando = (await caches.keys()).sort(); mismo(t.cachesEsperando, ["entimotors-v3.12.2", "entimotors-v3.13.0"], "mientras espera: el 3.12.2 sigue activo (su caché sigue) y la 3.13.0 ya está instalada");
      t.skipWaitingAutomatico = "NO";
      // ── activar-ya: el mensaje que manda la app tras ofrecer la copia de seguridad ──
      reg.waiting.postMessage({ tipo: "activar-ya" });
      await esperarHasta(async () => { const k = await caches.keys(); return k.length === 1 && k[0] === "entimotors-v3.13.0" && reg.active && reg.active.state === "activated" && !reg.waiting; }, { ms: 25000, desc: "3.13.0 activado tras activar-ya" });
      t.cachesFinal = await caches.keys(); mismo(t.cachesFinal, ["entimotors-v3.13.0"], "tras activar: la cache 3.12.2 se borra y queda la 3.13.0");
      const c = await caches.open("entimotors-v3.13.0"); t.entradasEnCache3130 = (await c.keys()).length; ok(t.entradasEnCache3130 >= 10, "la cache 3.13.0 debe tener el SHELL");
      await pausa(300); t.controllerchangeEnElCliente = cambioDeControl; f.remove();
      t.activarYa = "PASS"; t.residuos = { "3.12.2": (await caches.keys()).includes("entimotors-v3.12.2"), "3.12.1": (await caches.keys()).includes("entimotors-v3.12.1") };
      return t;
    }, opc);
    return;
  }

  let reg;
  await caso(`SW REAL · registro de ${base}sw.js (updateViaCache «none», como hace app.js): se instala y se activa; en la PRIMERA instalación no hay «waiting»`, async () => {
    reg = await navigator.serviceWorker.register(base + "sw.js", { updateViaCache: "none" });
    const sw = reg.installing || reg.waiting || reg.active; const estados = [sw.state]; sw.addEventListener("statechange", () => estados.push(sw.state));
    await activado(reg);
    ok(!estados.includes("installed") || !reg.waiting, "no debe quedar nada esperando");
    igual(reg.waiting, null, "primera instalacion: nada en espera"); igual(reg.scope, `${location.origin}${base}`, "alcance");
    return { estados, scope: reg.scope, skipWaitingAutomatico: "NO VERIFICABLE en la primera instalacion (no hay SW previo); ver la prueba de actualizacion" };
  }, opc);

  await caso(`SW REAL · CacheStorage contiene EXACTAMENTE «${CACHE}» (sin entimotors-v3.12.2 ni entimotors-v3.12.1${modo === "mitrabajo" ? " ni la del taller" : ""})`, async () => {
    const k = await caches.keys(); mismo(k, [CACHE], "caches del origen");
    return { caches: k, "cache 3.12.2": "AUSENTE", "cache 3.12.1": "AUSENTE" };
  }, opc);

  await caso("SW REAL · cada recurso del SHELL quedó cacheado y sus bytes (SHA-256) son idénticos a los que sirve el servidor", async () => {
    const sw = await (await ctl(base + "sw.js")).text(); const shell = shellDe(sw); ok(shell.length >= 10, `SHELL con ${shell.length} entradas`);
    const cache = await caches.open(CACHE); const faltan = [], distintos = [];
    for (const u of shell) {
      const url = new URL(u, location.origin + base).href; const c = await cache.match(url);
      if (!c) { faltan.push(u); continue; }
      const red = await (await ctl(url)).arrayBuffer(); if ((await sha(await c.arrayBuffer())) !== (await sha(red))) distintos.push(u);
    }
    mismo(faltan, [], "recursos del SHELL sin cachear"); mismo(distintos, [], "recursos cacheados con bytes distintos");
    const extras = (await cache.keys()).filter((r) => /cdn\.jsdelivr\.net/.test(r.url)).length;
    return { shell: shell.length, cacheados: shell.length, extrasDelCDNCacheados: extras };
  }, opc);

  await caso(`SW REAL · producto correcto y sin mezcla: el build-target.js cacheado declara «${modo === "mitrabajo" ? "mecanico" : "admin"}»${modo === "mitrabajo" ? "; sin panel técnico ni config-local en la caché" : ""}`, async () => {
    const cache = await caches.open(CACHE); const bt = await cache.match(new URL("build-target.js?v=3.13.0", location.origin + base).href); const txt = await bt.text();
    ok(new RegExp(`producto:\\s*"${modo === "mitrabajo" ? "mecanico" : "admin"}"`).test(txt), `build-target.js cacheado: ${txt.slice(-80)}`);
    const urls = (await cache.keys()).map((r) => new URL(r.url).pathname);
    if (modo === "mitrabajo") { ok(!urls.some((u) => /panel-tecnico|config-local/.test(u)), "la caché de Mi Trabajo no debe traer panel-tecnico ni config-local"); }
    const man = await (await cache.match(new URL("manifest.json", location.origin + base).href)).json();
    return { productoCacheado: modo === "mitrabajo" ? "mecanico" : "admin", manifest: man.name, entradas: urls.length };
  }, opc);

  await caso("SW REAL · estrategia «red primero, caché de respaldo»: con el servidor cortado, un cliente controlado por el SW sigue recibiendo el SHELL desde la caché (y un recurso no cacheado falla)", async () => {
    const f = document.createElement("iframe"); document.body.appendChild(f); f.src = base + "icons/icon-192.png";
    await new Promise((r) => f.addEventListener("load", r, { once: true }));
    await esperarHasta(() => f.contentWindow.navigator.serviceWorker.controller, { ms: 8000, desc: "cliente controlado por el SW" });
    const w = f.contentWindow; const url = `${base}app.js?v=3.13.0`;
    const enLinea = await w.fetch(url); ok(enLinea.ok, "en linea"); const bytesEnLinea = await sha(await enLinea.arrayBuffer());
    await ctl("/__ctl/desconectar?v=1");
    let sinRed, noCacheado;
    try { const r = await w.fetch(url); sinRed = { ok: r.ok, sha: await sha(await r.arrayBuffer()) }; } catch (e) { sinRed = { error: String(e) }; }
    try { const r = await w.fetch(`${base}no-esta-en-la-cache.js`); noCacheado = { status: r.status }; } catch (e) { noCacheado = { rechazado: true }; }
    await ctl("/__ctl/desconectar?v=0"); f.remove();
    ok(sinRed.ok === true, `sin red debia servirse desde la cache: ${JSON.stringify(sinRed)}`); igual(sinRed.sha, bytesEnLinea, "los bytes desde la cache deben ser los mismos");
    ok(noCacheado.rechazado === true, `un recurso no cacheado sin red debia fallar: ${JSON.stringify(noCacheado)}`);
    return { desdeCacheSinRed: "PASS", recursoNoCacheado: "falla como se espera" };
  }, opc);
}
