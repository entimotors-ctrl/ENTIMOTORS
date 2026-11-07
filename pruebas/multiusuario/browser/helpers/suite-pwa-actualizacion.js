// ACTUALIZACIÓN REAL «release anterior publicada → versión en curso» (Taller y «Mi Trabajo»). Sin prelude ni transformación: el navegador
// registra el sw.js REAL. «Antes» = la release anterior ENTERA tal como se publicó (el runner la extrae de su commit con git archive y genera
// su Mi Trabajo con su propio script) y «después» = el árbol de trabajo, servidos en el MISMO origen y URL (el runner cambia la raíz con
// /__ctl/sw?v=post). Comprueba lo que ve un dispositivo que ya tenía la versión anterior: detecta la nueva, la instala SIN activarse sola,
// conserva la vieja mientras espera, «activar-ya» la activa y borra la caché vieja, y después todo lo que sirve el SW (en línea y sin red) es
// de la versión nueva: nada mezclado.
// 3.15.1: sustituye a suite-pwa-3141.js (3.14.0 → 3.14.1, escrita para esa release) y al modo «upgrade» de suite-pwa.js (3.12.2 → 3.13.0).
// Las versiones NO van escritas aquí: se leen de CACHE_NAME en los sw.js servidos, así la suite vale para cada release sin tocarla.
// El cliente controlado es un icono (no index.html): así no arranca la app, que llevaría la configuración real de producción.
import { crearBanco, esperarHasta, pausa, ok, igual, mismo } from "/__h/helpers/pagina.js";

const sha = async (buf) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
const shellDe = (textoSw) => { const m = /const SHELL = \[([\s\S]*?)\];/.exec(textoSw); ok(m, "no se encontró SHELL en sw.js"); return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]); };
const activado = (reg) => esperarHasta(() => reg.active && reg.active.state === "activated", { ms: 25000, desc: "Service Worker activado" });
const cacheDe = (textoSw) => (/const CACHE_NAME = "([^"]+)";/.exec(textoSw) || [])[1];
const versionDe = (cache) => (/-v(\d+\.\d+\.\d+)$/.exec(cache || "") || [])[1];
const reV = (v) => v.replace(/\./g, "\\.");

export async function correr(ctx) {
  const B = crearBanco(ctx); const { caso } = B; const mt = ctx.modo === "mitrabajo";
  const base = mt ? "/u2/" : "/u1/";
  const producto = mt ? "mecanico" : "admin", prefijoCache = mt ? "entimotors-mitrabajo-v" : "entimotors-v";
  const opc = { grupo: `ACTUALIZACIÓN ${mt ? "mitrabajo" : "taller"}`, errorCritico: false };
  const ctl = (ruta) => fetch(ruta, { cache: "no-store" });
  const abs = (u) => new URL(u, location.origin + base).href;
  let VIEJA, NUEVA, VA, VN;   // cachés y versiones: se leen de los sw.js servidos (antes y después)

  await caso("ACTUALIZACIÓN · perfil limpio: Service Worker, CacheStorage y contexto seguro disponibles", async () => {
    ok("serviceWorker" in navigator, "sin serviceWorker"); ok(!!window.caches, "sin CacheStorage"); ok(window.isSecureContext, "origen no seguro");
    mismo(await caches.keys(), [], "CacheStorage vacío");
    return { origen: location.origin };
  }, opc);

  let reg, cliente;
  await caso("ACTUALIZACIÓN · ANTES: la release anterior publicada se instala y activa con SOLO su caché; su SHELL y su app.js son de esa versión", async () => {
    const pre = await (await ctl(base + "sw.js")).text();
    VIEJA = cacheDe(pre); VA = versionDe(VIEJA);
    ok(VA && VIEJA.startsWith(prefijoCache), `CACHE_NAME de ANTES ilegible o de otro producto: ${VIEJA}`);
    reg = await navigator.serviceWorker.register(base + "sw.js", { updateViaCache: "none" }); await activado(reg);
    mismo(await caches.keys(), [VIEJA], `solo la caché ${VA}`);
    const c = await caches.open(VIEJA), urls = (await c.keys()).map((r) => r.url);
    ok(urls.some((u) => u.endsWith(`app.js?v=${VA}`)), `SHELL ${VA}`);
    const app = await (await c.match(abs(`app.js?v=${VA}`))).text(); ok(app.includes(`const VERSION_APP = "${VA}";`), `app.js cacheado ${VA}`);
    // cliente controlado por el SW viejo (como la pestaña abierta): sin él, el navegador promovería el nuevo al instante
    cliente = document.createElement("iframe"); document.body.appendChild(cliente); cliente.src = base + "icons/icon-192.png";
    await new Promise((r) => cliente.addEventListener("load", r, { once: true }));
    await esperarHasta(() => cliente.contentWindow.navigator.serviceWorker.controller, { ms: 8000, desc: `cliente controlado por el SW ${VA}` });
    return { version: VA, caches: [VIEJA], entradas: urls.length };
  }, opc);

  await caso("ACTUALIZACIÓN · se publica la versión nueva: el navegador la DETECTA, la instala en su caché y queda ESPERANDO (sin skipWaiting); la anterior sigue activa", async () => {
    await ctl("/__ctl/sw?v=post");
    const post = await (await ctl(base + "sw.js")).text();
    NUEVA = cacheDe(post); VN = versionDe(NUEVA);
    ok(VN && NUEVA.startsWith(prefijoCache), `CACHE_NAME nuevo ilegible o de otro producto: ${NUEVA}`);
    ok(NUEVA !== VIEJA, `el servidor no pasó a otra versión (sigue ${VIEJA}): sin cambio de CACHE_NAME el teléfono no se actualizaría`);
    await reg.update();
    await esperarHasta(() => reg.waiting, { ms: 25000, desc: `SW ${VN} instalado y en espera` });
    igual(reg.waiting.state, "installed", `${VN} en espera`);
    await pausa(3000); ok(reg.waiting && reg.waiting.state === "installed", `el ${VN} se activó solo: skipWaiting automático`);
    mismo((await caches.keys()).sort(), [VIEJA, NUEVA].sort(), `mientras espera conviven la ${VA} (activa) y la ${VN} (instalada)`);
    ok(cliente.contentWindow.navigator.serviceWorker.controller.scriptURL.endsWith("sw.js"), "el cliente sigue con el SW viejo");
    return { de: VA, a: VN, esperando: "SI", skipWaitingAutomatico: "NO" };
  }, opc);

  await caso(`ACTUALIZACIÓN · la caché nueva es PURA: cada entrada del SHELL con la versión nueva (ninguna vieja) y bytes IDÉNTICOS a los del servidor; producto «${producto}»`, async () => {
    const shell = shellDe(await (await ctl(base + "sw.js")).text());
    ok(shell.filter((u) => u.includes("?v=")).every((u) => u.endsWith(`?v=${VN}`)), `SHELL con ?v= distinto de ${VN}`);
    const c = await caches.open(NUEVA), faltan = [], distintos = [];
    for (const u of shell) { const r = await c.match(abs(u)); if (!r) { faltan.push(u); continue; } if ((await sha(await r.arrayBuffer())) !== (await sha(await (await ctl(abs(u))).arrayBuffer()))) distintos.push(u); }
    mismo(faltan, [], "sin cachear"); mismo(distintos, [], "bytes distintos");
    const urls = (await c.keys()).map((r) => r.url); ok(!urls.some((u) => new RegExp(`\\?v=${reV(VA)}$`).test(u)), `ninguna entrada ${VA} en la caché nueva`);
    const app = await (await c.match(abs(`app.js?v=${VN}`))).text(); ok(app.includes(`const VERSION_APP = "${VN}";`), `app.js ${VN}`);
    // index.html cacheado: TODAS sus etiquetas ?v= son de la versión nueva (las cuenta del propio index servido, sin cifra escrita aquí)
    const idx = await (await c.match(abs("index.html"))).text(), servido = await (await ctl(abs("index.html"))).text();
    const etiquetas = (t) => [...t.matchAll(/<script src="[^"?]+\?v=([^"]+)"/g)].map((m) => m[1]);
    ok(etiquetas(idx).length > 0 && etiquetas(idx).every((v) => v === VN), `index.html cacheado solo con ?v=${VN}: ${JSON.stringify(etiquetas(idx))}`);
    igual(etiquetas(idx).length, etiquetas(servido).length, "index.html cacheado = el servido");
    const bt = await (await c.match(abs(`build-target.js?v=${VN}`))).text(); ok(new RegExp(`producto:\\s*"${producto}"`).test(bt), `build-target «${producto}»`);
    if (mt) ok(!urls.some((u) => /panel-tecnico|config-local/.test(u)), "Mi Trabajo sin panel técnico ni config-local");
    return { shell: shell.length, entradas: urls.length, etiquetasIndex: etiquetas(idx).length };
  }, opc);

  await caso("ACTUALIZACIÓN · «activar-ya» (lo que envía la app tras ofrecer la copia de seguridad) activa la nueva, BORRA la caché vieja y toma el cliente", async () => {
    let cambio = 0; cliente.contentWindow.navigator.serviceWorker.addEventListener("controllerchange", () => { cambio++; });
    reg.waiting.postMessage({ tipo: "activar-ya" });
    await esperarHasta(async () => { const k = await caches.keys(); return k.length === 1 && k[0] === NUEVA && reg.active && reg.active.state === "activated" && !reg.waiting; }, { ms: 25000, desc: `${VN} activo y ${VA} borrada` });
    mismo(await caches.keys(), [NUEVA], `solo la caché ${VN}`);
    await esperarHasta(() => cambio > 0, { ms: 8000, desc: "controllerchange en el cliente" });
    return { caches: [NUEVA], controllerchange: cambio };
  }, opc);

  await caso("ACTUALIZACIÓN · después: en línea y SIN RED el SW solo entrega la versión nueva (index.html y app.js coherentes); 0 mezcla con la anterior", async () => {
    cliente.contentWindow.location.reload(); await new Promise((r) => cliente.addEventListener("load", r, { once: true }));
    await esperarHasta(() => cliente.contentWindow.navigator.serviceWorker.controller, { ms: 8000, desc: `cliente controlado por el SW ${VN}` });
    const w = cliente.contentWindow, r = {};
    for (const red of ["en línea", "sin red"]) {
      if (red === "sin red") await ctl("/__ctl/desconectar?v=1");
      try {
        const idx = await (await w.fetch(`${base}index.html`)).text(), app = await (await w.fetch(`${base}app.js?v=${VN}`)).text();
        ok(!new RegExp(`\\?v=${reV(VA)}"`).test(idx) && new RegExp(`\\?v=${reV(VN)}"`).test(idx), `${red}: index.html ${VN}`);
        ok(app.includes(`const VERSION_APP = "${VN}";`), `${red}: app.js ${VN}`);
        // la URL vieja SOLO sin red: en línea el SW (red primero) guardaría la respuesta y la prueba se contaminaría a sí misma
        let viejo = "n/a";
        if (red === "sin red") { try { const x = await w.fetch(`${base}app.js?v=${VA}`); viejo = x.ok ? "SERVIDO" : `HTTP ${x.status}`; } catch { viejo = "rechazado"; } }
        if (red === "sin red") ok(viejo === "rechazado" || /^HTTP/.test(viejo), `sin red, app.js?v=${VA} ya no existe en ninguna caché (${viejo})`);
        r[red] = { index: VN, app: VN, appViejaSinRed: viejo };
      } finally { if (red === "sin red") await ctl("/__ctl/desconectar?v=0"); }
    }
    cliente.remove();
    return r;
  }, opc);
}
