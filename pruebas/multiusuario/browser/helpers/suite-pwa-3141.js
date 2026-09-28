// ACTUALIZACIÓN REAL 3.14.0 → 3.14.1 (Taller y «Mi Trabajo»). Sin prelude ni transformación: el navegador registra el sw.js REAL.
// «Antes» = la release 3.14.0 ENTERA tal como se publicó (commit effbfa1; Mi Trabajo generado con su propio script) y «después» = el
// árbol de trabajo 3.14.1, servidos en el MISMO origen y URL (el runner cambia la raíz con /__ctl/sw?v=post). Comprueba lo que ve un
// dispositivo que ya tenía 3.14.0: detecta la versión nueva, la instala SIN activarse sola, conserva la vieja mientras espera, «activar-ya»
// la activa y borra la caché 3.14.0, y después todo lo que sirve el SW (en línea y sin red) es 3.14.1: nada mezclado.
// El cliente controlado es un icono (no index.html): así no arranca la app, que llevaría la configuración real de producción.
import { crearBanco, esperarHasta, pausa, ok, igual, mismo } from "/__h/helpers/pagina.js";

const sha = async (buf) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
const shellDe = (textoSw) => { const m = /const SHELL = \[([\s\S]*?)\];/.exec(textoSw); ok(m, "no se encontró SHELL en sw.js"); return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]); };
const activado = (reg) => esperarHasta(() => reg.active && reg.active.state === "activated", { ms: 25000, desc: "Service Worker activado" });

export async function correr(ctx) {
  const B = crearBanco(ctx); const { caso } = B; const mt = ctx.modo === "mitrabajo";
  const base = mt ? "/u2/" : "/u1/";
  const VIEJA = mt ? "entimotors-mitrabajo-v3.14.0" : "entimotors-v3.14.0", NUEVA = mt ? "entimotors-mitrabajo-v3.14.1" : "entimotors-v3.14.1";
  const producto = mt ? "mecanico" : "admin";
  const opc = { grupo: `UPG-3141 ${mt ? "mitrabajo" : "taller"}`, errorCritico: false };
  const ctl = (ruta) => fetch(ruta, { cache: "no-store" });
  const abs = (u) => new URL(u, location.origin + base).href;

  await caso("UPG-3141 · perfil limpio: Service Worker, CacheStorage y contexto seguro disponibles", async () => {
    ok("serviceWorker" in navigator, "sin serviceWorker"); ok(!!window.caches, "sin CacheStorage"); ok(window.isSecureContext, "origen no seguro");
    mismo(await caches.keys(), [], "CacheStorage vacío");
    return { origen: location.origin };
  }, opc);

  let reg, cliente, t = {};
  await caso(`UPG-3141 · ANTES: la release 3.14.0 publicada se instala y activa con SOLO «${VIEJA}»; su SHELL es 3.14.0 y su app.js dice VERSION_APP 3.14.0`, async () => {
    const pre = await (await ctl(base + "sw.js")).text();
    ok(pre.includes(`const CACHE_NAME = "${VIEJA}";`), "el sw.js de ANTES no es el 3.14.0");
    reg = await navigator.serviceWorker.register(base + "sw.js", { updateViaCache: "none" }); await activado(reg);
    mismo(await caches.keys(), [VIEJA], "solo la caché 3.14.0");
    const c = await caches.open(VIEJA), urls = (await c.keys()).map((r) => r.url);
    ok(urls.some((u) => u.endsWith("app.js?v=3.14.0")) && !urls.some((u) => /\?v=3\.14\.1$/.test(u)), "SHELL 3.14.0");
    const app = await (await c.match(abs("app.js?v=3.14.0"))).text(); ok(app.includes('const VERSION_APP = "3.14.0";'), "app.js cacheado 3.14.0");
    ok(!app.includes("cardSeguridad") && !app.includes("enviarCambioClave"), "3.14.0 no trae Seguridad");
    // cliente controlado por el SW viejo (como la pestaña abierta): sin él, el navegador promovería el nuevo al instante
    cliente = document.createElement("iframe"); document.body.appendChild(cliente); cliente.src = base + "icons/icon-192.png";
    await new Promise((r) => cliente.addEventListener("load", r, { once: true }));
    await esperarHasta(() => cliente.contentWindow.navigator.serviceWorker.controller, { ms: 8000, desc: "cliente controlado por el SW 3.14.0" });
    t.entradasVieja = urls.length;
    return { caches: [VIEJA], entradas: urls.length };
  }, opc);

  await caso(`UPG-3141 · se publica 3.14.1: el navegador la DETECTA, la instala en «${NUEVA}» y queda ESPERANDO (sin skipWaiting); la 3.14.0 sigue activa`, async () => {
    await ctl("/__ctl/sw?v=post");
    const post = await (await ctl(base + "sw.js")).text(); ok(post.includes(`const CACHE_NAME = "${NUEVA}";`), "el servidor no pasó al sw.js 3.14.1");
    await reg.update();
    await esperarHasta(() => reg.waiting, { ms: 25000, desc: "SW 3.14.1 instalado y en espera" });
    igual(reg.waiting.state, "installed", "3.14.1 en espera");
    await pausa(3000); ok(reg.waiting && reg.waiting.state === "installed", "el 3.14.1 se activó solo: skipWaiting automático");
    mismo((await caches.keys()).sort(), [VIEJA, NUEVA].sort(), "mientras espera conviven la 3.14.0 (activa) y la 3.14.1 (instalada)");
    ok(cliente.contentWindow.navigator.serviceWorker.controller.scriptURL.endsWith("sw.js"), "el cliente sigue con el SW viejo");
    return { esperando: "SI", skipWaitingAutomatico: "NO" };
  }, opc);

  await caso(`UPG-3141 · la caché nueva es 3.14.1 PURA: cada entrada del SHELL con ?v=3.14.1 (ninguna 3.14.0) y bytes IDÉNTICOS a los del servidor 3.14.1; producto «${producto}»`, async () => {
    const shell = shellDe(await (await ctl(base + "sw.js")).text());
    ok(shell.filter((u) => u.includes("?v=")).every((u) => u.endsWith("?v=3.14.1")), "SHELL con ?v= distinto de 3.14.1");
    const c = await caches.open(NUEVA), faltan = [], distintos = [];
    for (const u of shell) { const r = await c.match(abs(u)); if (!r) { faltan.push(u); continue; } if ((await sha(await r.arrayBuffer())) !== (await sha(await (await ctl(abs(u))).arrayBuffer()))) distintos.push(u); }
    mismo(faltan, [], "sin cachear"); mismo(distintos, [], "bytes distintos");
    const urls = (await c.keys()).map((r) => r.url); ok(!urls.some((u) => /\?v=3\.14\.0$/.test(u)), "ninguna entrada 3.14.0 en la caché nueva");
    const app = await (await c.match(abs("app.js?v=3.14.1"))).text(); ok(app.includes('const VERSION_APP = "3.14.1";'), "app.js 3.14.1");
    const idx = await (await c.match(abs("index.html"))).text();
    ok(!/\?v=3\.14\.0"/.test(idx) && (idx.match(/\?v=3\.14\.1"/g) || []).length === (mt ? 15 : 16), "index.html cacheado solo con ?v=3.14.1");
    ok(idx.includes('id="cardSeguridad"'), "index 3.14.1 con la tarjeta Seguridad (oculta por rol)");
    const bt = await (await c.match(abs("build-target.js?v=3.14.1"))).text(); ok(new RegExp(`producto:\\s*"${producto}"`).test(bt), `build-target «${producto}»`);
    if (mt) ok(!urls.some((u) => /panel-tecnico|config-local/.test(u)), "Mi Trabajo sin panel técnico ni config-local");
    t.entradasNueva = urls.length;
    return { shell: shell.length, entradas: urls.length };
  }, opc);

  await caso(`UPG-3141 · «activar-ya» (lo que envía la app tras ofrecer la copia de seguridad) activa 3.14.1, BORRA «${VIEJA}» y toma el cliente`, async () => {
    let cambio = 0; cliente.contentWindow.navigator.serviceWorker.addEventListener("controllerchange", () => { cambio++; });
    reg.waiting.postMessage({ tipo: "activar-ya" });
    await esperarHasta(async () => { const k = await caches.keys(); return k.length === 1 && k[0] === NUEVA && reg.active && reg.active.state === "activated" && !reg.waiting; }, { ms: 25000, desc: "3.14.1 activo y 3.14.0 borrada" });
    mismo(await caches.keys(), [NUEVA], "solo la caché 3.14.1");
    await esperarHasta(() => cambio > 0, { ms: 8000, desc: "controllerchange en el cliente" });
    return { caches: [NUEVA], controllerchange: cambio };
  }, opc);

  await caso("UPG-3141 · después: en línea y SIN RED el SW solo entrega 3.14.1 (index.html y app.js coherentes); 0 mezcla con 3.14.0", async () => {
    cliente.contentWindow.location.reload(); await new Promise((r) => cliente.addEventListener("load", r, { once: true }));
    await esperarHasta(() => cliente.contentWindow.navigator.serviceWorker.controller, { ms: 8000, desc: "cliente controlado por el SW 3.14.1" });
    const w = cliente.contentWindow, r = {};
    for (const red of ["en línea", "sin red"]) {
      if (red === "sin red") await ctl("/__ctl/desconectar?v=1");
      try {
        const idx = await (await w.fetch(`${base}index.html`)).text(), app = await (await w.fetch(`${base}app.js?v=3.14.1`)).text();
        ok(!/\?v=3\.14\.0"/.test(idx) && /\?v=3\.14\.1"/.test(idx), `${red}: index.html 3.14.1`);
        ok(app.includes('const VERSION_APP = "3.14.1";'), `${red}: app.js 3.14.1`);
        // la URL vieja SOLO sin red: en línea el SW (red primero) guardaría la respuesta y la prueba se contaminaría a sí misma
        let viejo = "n/a";
        if (red === "sin red") { try { const x = await w.fetch(`${base}app.js?v=3.14.0`); viejo = x.ok ? "SERVIDO" : `HTTP ${x.status}`; } catch { viejo = "rechazado"; } }
        if (red === "sin red") ok(viejo === "rechazado" || /^HTTP/.test(viejo), `sin red, app.js?v=3.14.0 ya no existe en ninguna caché (${viejo})`);
        r[red] = { index: "3.14.1", app: "3.14.1", appViejaSinRed: viejo };
      } finally { if (red === "sin red") await ctl("/__ctl/desconectar?v=0"); }
    }
    cliente.remove();
    return r;
  }, opc);
}
