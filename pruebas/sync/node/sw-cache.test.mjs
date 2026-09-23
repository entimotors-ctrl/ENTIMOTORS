// SYNC-4 · el Service Worker (taller-demo/sw.js) NO puede guardar en su caché lo que viene de la nube: datos del taller, tokens en la URL
// (Storage firmado), respuestas con credenciales. Sí debe seguir sirviendo el shell de la app sin conexión. Se carga el sw.js REAL en un
// contexto vm con Request/Response reales de Node y un caché falso; no hace falta navegador.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CODIGO_SW = fs.readFileSync(path.join(RAIZ, "taller-demo/sw.js"), "utf8");
const ORIGEN = "https://taller.example.test";
const SUPABASE = "https://proyecto-sintetico.supabase.co";
const API = "https://api-sintetica.onrender.com";

/** Carga sw.js. `red` = cómo responde la red (o lanza si no hay). Devuelve los manejadores y lo que el SW guardó/pidió. */
function cargarSW({ red = async () => new Response("desde-la-red", { status: 200 }), previo = {} } = {}) {
  const manejadores = {}, guardado = new Map(Object.entries(previo)), puestos = [], pedidosRed = [];
  const url = (r) => new URL(typeof r === "string" ? r : r.url, ORIGEN).href;
  const cache = { put: async (r, res) => { guardado.set(url(r), res); puestos.push(url(r)); }, match: async (r) => guardado.get(url(r)) };
  const caches = { open: async () => cache, match: async (r) => guardado.get(url(r)), keys: async () => [], delete: async () => true };
  const fetch = async (r, init) => { pedidosRed.push({ url: url(r), init }); return red(r, init); };
  const self_ = { location: new URL(`${ORIGEN}/`), addEventListener: (t, f) => { manejadores[t] = f; }, skipWaiting() {}, clients: { claim() {} } };
  const ctx = vm.createContext({ self: self_, caches, fetch, Request, Response, URL, Headers, Promise, setTimeout });
  vm.runInContext(CODIGO_SW, ctx, { filename: "sw.js" });
  return { manejadores, guardado, puestos, pedidosRed };
}

/** Dispara un evento fetch. `interceptada` = el SW llamó a respondWith (si no, el navegador resuelve la petición por su cuenta). */
async function pedir(sw, ruta, { metodo = "GET", cabeceras = {} } = {}) {
  const request = new Request(ruta.startsWith("http") ? ruta : `${ORIGEN}${ruta}`, { method: metodo, headers: cabeceras });
  let respuesta = null;
  sw.manejadores.fetch({ request, respondWith(p) { respuesta = Promise.resolve(p); }, waitUntil() {} });
  const res = respuesta ? await respuesta : null;
  await new Promise((r) => setTimeout(r, 0));          // el cache.put del SW va sin esperar
  return { interceptada: respuesta !== null, res };
}

test("GET normal del shell (mismo origen): se sirve y SE CACHEA", async () => {
  const sw = cargarSW();
  for (const ruta of ["/", "/index.html", "/app.js?v=3.13.0", "/manifest.json", "/icons/icon-192.png"]) {
    const { interceptada, res } = await pedir(sw, ruta);
    assert.equal(interceptada, true, `${ruta} debe pasar por el SW`);
    assert.equal(await res.text(), "desde-la-red");
    assert.ok(sw.puestos.includes(new URL(ruta, ORIGEN).href), `${ruta} debe quedar en el caché`);
  }
});

test("las librerías del CDN que index.html ya cargaba (jsDelivr) siguen cacheándose", async () => {
  const sw = cargarSW();
  const u = "https://cdn.jsdelivr.net/npm/chart.js";
  const { interceptada } = await pedir(sw, u);
  assert.equal(interceptada, true); assert.ok(sw.puestos.includes(u));
});

test("sin conexión el shell se sirve del caché (la app abre offline)", async () => {
  let hayRed = true;
  const sw = cargarSW({ red: async () => { if (!hayRed) throw new TypeError("Failed to fetch"); return new Response("<html>app</html>"); } });
  await pedir(sw, "/index.html");
  hayRed = false;
  const { interceptada, res } = await pedir(sw, "/index.html");
  assert.equal(interceptada, true); assert.equal(await res.text(), "<html>app</html>");
});

test("una petición CON Authorization NO se cachea aunque sea del mismo origen", async () => {
  const sw = cargarSW();
  for (const c of [{ Authorization: "Bearer TOKEN-SINTETICO" }, { authorization: "Bearer TOKEN-SINTETICO" }, { AUTHORIZATION: "Basic eA==" }]) {
    const { interceptada } = await pedir(sw, "/datos-del-usuario.json", { cabeceras: c });
    assert.equal(interceptada, false, JSON.stringify(Object.keys(c)));
  }
  assert.equal(sw.puestos.length, 0, "nada se guardó"); assert.equal(sw.pedidosRed.length, 0, "el SW ni siquiera tocó la red: la resuelve el navegador");
});

test("el backend API (otro origen) NO se cachea, con o sin Authorization", async () => {
  const sw = cargarSW();
  for (const c of [{ Authorization: "Bearer TOKEN-SINTETICO" }, {}]) {
    for (const ruta of [`${API}/api/usuarios`, `${API}/api/admin/pin/estado`, `${API}/health`]) {
      assert.equal((await pedir(sw, ruta, { cabeceras: c })).interceptada, false, ruta);
    }
  }
  assert.equal(sw.puestos.length, 0);
});

test("Supabase REST y RPC NO se cachean (lecturas de sincronización, PATCH, POST, apikey sola o con token)", async () => {
  const sw = cargarSW();
  const q = "select=*&order=updated_at.asc%2Cid.asc&limit=500";
  for (const c of [{ apikey: "ANON-SINTETICA" }, { apikey: "ANON-SINTETICA", Authorization: "Bearer TOKEN-SINTETICO" }]) {
    assert.equal((await pedir(sw, `${SUPABASE}/rest/v1/clientes?${q}`, { cabeceras: c })).interceptada, false, "GET de descarga incremental");
    assert.equal((await pedir(sw, `${SUPABASE}/rest/v1/creditos?id=eq.x`, { cabeceras: c })).interceptada, false);
  }
  for (const metodo of ["POST", "PATCH", "PUT", "DELETE"]) assert.equal((await pedir(sw, `${SUPABASE}/rest/v1/rpc/registrar_venta_v2`, { metodo, cabeceras: { apikey: "A" } })).interceptada, false, metodo);
  assert.equal(sw.puestos.length, 0);
});

test("Supabase Auth NO se cachea", async () => {
  const sw = cargarSW();
  for (const ruta of [`${SUPABASE}/auth/v1/user`, `${SUPABASE}/auth/v1/session`, `${SUPABASE}/auth/v1/token?grant_type=refresh_token`]) assert.equal((await pedir(sw, ruta, { cabeceras: { apikey: "A" } })).interceptada, false, ruta);
  assert.equal(sw.puestos.length, 0);
});

test("Storage protegido NO se cachea: ni el autenticado ni el firmado (el token viaja en la URL, sin cabecera Authorization)", async () => {
  const sw = cargarSW();
  for (const ruta of [`${SUPABASE}/storage/v1/object/authenticated/fotos-ordenes/o1/f.jpg`, `${SUPABASE}/storage/v1/object/sign/fotos-ordenes/o1/f.jpg?token=JWT-SINTETICO`,
    `${SUPABASE}/storage/v1/object/public/publico/logo.png`, `${SUPABASE}/storage/v1/object/fotos-ordenes/o1/f.jpg`]) {
    assert.equal((await pedir(sw, ruta)).interceptada, false, ruta);
    assert.equal((await pedir(sw, ruta, { cabeceras: { Authorization: "Bearer TOKEN-SINTETICO" } })).interceptada, false, `${ruta} con token`);
  }
  assert.equal(sw.puestos.length, 0, "ni una sola respuesta de Storage llegó al caché");
});

test("lo que NO es GET nunca se intercepta (subidas, altas, PATCH), tampoco en el mismo origen", async () => {
  const sw = cargarSW();
  for (const metodo of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await pedir(sw, "/index.html", { metodo })).interceptada, false, metodo);
  assert.equal(sw.puestos.length, 0);
});

test("una respuesta VIEJA de la nube que quedó en el caché de un SW anterior no se vuelve a servir, ni con la red caída", async () => {
  const vieja = `${SUPABASE}/rest/v1/clientes?select=*`;
  const sw = cargarSW({ previo: { [vieja]: new Response('[{"nombre":"dato viejo"}]') }, red: async () => { throw new TypeError("Failed to fetch"); } });
  const { interceptada } = await pedir(sw, vieja, { cabeceras: { apikey: "A", Authorization: "Bearer T" } });
  assert.equal(interceptada, false, "no hay respondWith: el navegador falla o responde la nube, jamás un dato viejo");
});

test("SYNC-8: aunque la API/Supabase se sirvan desde el MISMO origen (proxy), REST/RPC/Auth/Storage/api y cualquier petición con apikey NO pasan por el caché", async () => {
  const vieja = `${ORIGEN}/rest/v1/inventario?select=*`;
  const sw = cargarSW({ previo: { [vieja]: new Response('[{"cantidad":99}]') }, red: async () => { throw new TypeError("Failed to fetch"); } });
  for (const ruta of ["/rest/v1/inventario?select=*", "/rest/v1/rpc/registrar_venta_v2", "/auth/v1/user", "/storage/v1/object/sign/x", "/functions/v1/f", "/api/admin/pin", "/api/caja/resumen"]) {
    const { interceptada } = await pedir(sw, ruta);
    assert.equal(interceptada, false, `${ruta}: jamás respondida desde el caché, ni con la red caída`);
  }
  assert.equal((await pedir(sw, "/cualquier-cosa.json", { cabeceras: { apikey: "A" } })).interceptada, false, "con apikey es de Supabase, no de la app");
  assert.equal(sw.puestos.length, 0);
  // el shell sigue funcionando offline
  const sw2 = cargarSW();
  assert.equal((await pedir(sw2, "/index.html")).interceptada, true);
});

test("SYNC-9: fotos privadas — URL firmada (con token en la URL), firmada VENCIDA (400/403) y descarga autenticada: nunca pasan por el caché, ni del mismo origen ni del de Supabase", async () => {
  const firmada = "/storage/v1/object/sign/entimotors-taller/ordenes/0000/f.jpg?token=eyJfirmaSintetica";
  const previo = { [`${SUPABASE}${firmada}`]: new Response("foto-vieja"), [`${ORIGEN}${firmada}`]: new Response("foto-vieja") };
  const sw = cargarSW({ previo, red: async () => new Response('{"statusCode":"403","message":"jwt expired"}', { status: 400 }) });
  for (const u of [`${SUPABASE}${firmada}`, `${ORIGEN}${firmada}`, `${SUPABASE}/storage/v1/object/authenticated/entimotors-taller/ordenes/0000/f.jpg`, `${ORIGEN}/storage/v1/object/info/authenticated/entimotors-taller/x.jpg`]) {
    assert.equal((await pedir(sw, u)).interceptada, false, u);
  }
  assert.equal(sw.puestos.length, 0, "ni la respuesta vencida ni la foto se guardan");
});

test("impresion.html sigue sirviéndose desde el caché sin tocar la red", async () => {
  const sw = cargarSW({ red: async () => { throw new Error("no debe llamarse"); } });
  sw.manejadores.message({ data: { tipo: "guardar-impresion", html: "<p>factura</p>" }, source: { postMessage() {} }, waitUntil(p) { return p; } });
  await new Promise((r) => setTimeout(r, 0));
  const { interceptada, res } = await pedir(sw, "/impresion.html");
  assert.equal(interceptada, true); assert.equal(await res.text(), "<p>factura</p>"); assert.equal(sw.pedidosRed.length, 0);
});

test("la instalación precachea SOLO archivos de la app y del CDN: nunca la nube, ni config-local.js ni panel-tecnico.html", async () => {
  const sw = cargarSW();
  const trabajos = []; sw.manejadores.install({ waitUntil(p) { trabajos.push(p); } }); await Promise.all(trabajos);
  const urls = sw.pedidosRed.map((p) => new URL(p.url, ORIGEN));
  assert.ok(urls.length >= 8, `debería precachear el shell (${urls.length})`);
  for (const u of urls) {
    assert.ok(u.origin === ORIGEN || u.origin === "https://cdn.jsdelivr.net", `origen inesperado en el precaché: ${u.href}`);
    assert.ok(!/config-local|panel-tecnico/.test(u.pathname), `no debe precachearse ${u.pathname}`);
  }
  assert.ok(urls.some((u) => u.pathname.endsWith("/index.html")) && urls.some((u) => u.pathname.endsWith("/app.js")), "el shell incluye index.html y app.js");
});
