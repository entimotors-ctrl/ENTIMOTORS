// 3.15.0 · BLOQUE 8 · SERVICE WORKER: red primero CON PLAZO (sw.js REAL en un contexto vm, reloj real).
// Casos: respuesta rápida · a 2 s · a 5 s · nunca · sin conexión · reconexión · primer uso sin copia · una página abierta desde la
// copia pide lo demás a la copia (no mezcla) · 404/500 no tapan una copia buena · la respuesta tardía se guarda · API/escrituras intactas.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CODIGO_SW = fs.readFileSync(path.join(RAIZ, "taller-demo/sw.js"), "utf8");
const ORIGEN = "https://taller.example.test";
const V = (CODIGO_SW.match(/app\.js\?v=([\d.]+)/) || [])[1];   // la versión real de los archivos del SHELL
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function cargarSW({ red, previo = {} }) {
  const manejadores = {}, guardado = new Map(Object.entries(previo).map(([k, v]) => [new URL(k, ORIGEN).href, new Response(v)])), pedidosRed = [];
  const url = (r) => new URL(typeof r === "string" ? r : r.url, ORIGEN).href;
  const cache = { put: async (r, res) => { guardado.set(url(r), res); }, match: async (r) => { const x = guardado.get(url(r)); return x ? x.clone() : undefined; } };
  const caches = { open: async () => cache, match: async (r) => { const x = guardado.get(url(r)); return x ? x.clone() : undefined; }, keys: async () => [], delete: async () => true };
  const fetch = async (r, init) => { pedidosRed.push(url(r)); return red(url(r), init); };
  const self_ = { location: new URL(`${ORIGEN}/`), addEventListener: (t, f) => { manejadores[t] = f; }, skipWaiting() {}, clients: { claim() {} } };
  vm.runInContext(CODIGO_SW, vm.createContext({ self: self_, caches, fetch, Request, Response, URL, Headers, Promise, setTimeout, clearTimeout, Map, Symbol, Date }), { filename: "sw.js" });
  return { manejadores, guardado, pedidosRed };
}
/** Evento fetch; devuelve { interceptada, ms, texto } o { pendiente:true } si no contestó en `espera` ms. */
async function pedir(sw, ruta, { navegar = false, cliente = "", resultante = "", espera = 12000, metodo = "GET", cabeceras = {} } = {}) {
  const request = new Request(`${ORIGEN}${ruta}`, { method: metodo, headers: cabeceras });
  if (navegar) Object.defineProperty(request, "mode", { value: "navigate" });
  let p = null; const t0 = Date.now();
  sw.manejadores.fetch({ request, clientId: cliente, resultingClientId: resultante, respondWith(x) { p = Promise.resolve(x); }, waitUntil() {} });
  if (!p) return { interceptada: false };
  const r = await Promise.race([p.then(async (res) => ({ ms: Date.now() - t0, texto: await res.text(), status: res.status })), dormir(espera).then(() => ({ pendiente: true }))]);
  return { interceptada: true, ...r };
}
const redQueTarda = (ms, cuerpo = "RED") => async () => { await dormir(ms); return new Response(cuerpo); };
const redQueNunca = () => () => new Promise(() => {});

test("respuesta rápida → la red (versión nueva) y se guarda", async () => {
  const sw = cargarSW({ red: redQueTarda(10, "NUEVA"), previo: { "/index.html": "VIEJA" } });
  const r = await pedir(sw, "/index.html", { navegar: true, resultante: "c1" });
  assert.equal(r.texto, "NUEVA"); assert.ok(r.ms < 1000);
  await dormir(20); assert.equal(await sw.guardado.get(`${ORIGEN}/index.html`).clone().text(), "NUEVA");
});
test("servidor lento (2 s, dentro del plazo) → la red", async () => {
  const sw = cargarSW({ red: redQueTarda(2000, "NUEVA"), previo: { "/index.html": "VIEJA" } });
  const r = await pedir(sw, "/index.html", { navegar: true, resultante: "c2" });
  assert.equal(r.texto, "NUEVA"); assert.ok(r.ms >= 1900 && r.ms < 3900, `${r.ms} ms`);
});
test("servidor muy lento (5 s) con copia → la copia a los ~4 s; la respuesta tardía se guarda para la próxima", async () => {
  const sw = cargarSW({ red: redQueTarda(5000, "NUEVA"), previo: { "/index.html": "VIEJA" } });
  const r = await pedir(sw, "/index.html", { navegar: true, resultante: "c3" });
  assert.equal(r.texto, "VIEJA"); assert.ok(r.ms >= 3900 && r.ms < 4800, `${r.ms} ms`);
  await dormir(1300); assert.equal(await sw.guardado.get(`${ORIGEN}/index.html`).clone().text(), "NUEVA", "la respuesta tardía quedó guardada");
});
test("servidor muy lento (5 s) SIN copia (primer uso) → espera a la red: nunca inventa", async () => {
  const sw = cargarSW({ red: redQueTarda(5000, "NUEVA") });
  const r = await pedir(sw, "/index.html", { navegar: true, resultante: "c4" });
  assert.equal(r.texto, "NUEVA"); assert.ok(r.ms >= 4900, `${r.ms} ms`);
});
test("lie-fi (la red nunca contesta) con copia → la copia a los ~4 s; SIN copia → sigue esperando (no finge)", async () => {
  const sw = cargarSW({ red: redQueNunca(), previo: { "/index.html": "VIEJA" } });
  const r = await pedir(sw, "/index.html", { navegar: true, resultante: "c5" });
  assert.equal(r.texto, "VIEJA"); assert.ok(r.ms < 4800);
  const sw2 = cargarSW({ red: redQueNunca() });
  const r2 = await pedir(sw2, "/index.html", { navegar: true, resultante: "c6", espera: 6000 });
  assert.equal(r2.pendiente, true);
});
test("una página abierta desde la copia pide sus archivos a la copia (no mezcla versiones) y no espera a la red", async () => {
  const sw = cargarSW({ red: redQueNunca(), previo: { "/index.html": "VIEJA", [`/app.js?v=${V}`]: "APP-VIEJA" } });
  await pedir(sw, "/index.html", { navegar: true, resultante: "pag" });
  const a = await pedir(sw, `/app.js?v=${V}`, { cliente: "pag" });
  assert.equal(a.texto, "APP-VIEJA"); assert.ok(a.ms < 200, `${a.ms} ms: no esperó a la red`);
});
test("sin conexión (la red falla al instante) → la copia al instante; al volver la red, otra vez la red y la página deja el modo copia", async () => {
  let hay = false;
  const sw = cargarSW({ red: async () => { if (!hay) throw new TypeError("Failed to fetch"); return new Response("NUEVA"); }, previo: { "/index.html": "VIEJA", [`/app.js?v=${V}`]: "APP-VIEJA" } });
  const r = await pedir(sw, "/index.html", { navegar: true, resultante: "p1" });
  assert.equal(r.texto, "VIEJA"); assert.ok(r.ms < 200);
  hay = true;
  const r2 = await pedir(sw, "/index.html", { navegar: true, resultante: "p2" });
  assert.equal(r2.texto, "NUEVA");
  const a = await pedir(sw, `/app.js?v=${V}`, { cliente: "p2" });
  assert.equal(a.texto, "NUEVA", "la página nueva (de la red) pide sus archivos a la red");
});
test("un 404/500 del servidor NO tapa la copia buena", async () => {
  const sw = cargarSW({ red: async () => new Response("error", { status: 500 }), previo: { [`/app.js?v=${V}`]: "APP-BUENA" } });
  await pedir(sw, `/app.js?v=${V}`, { cliente: "x" });
  await dormir(20);
  assert.equal(await sw.guardado.get(`${ORIGEN}/app.js?v=${V}`).clone().text(), "APP-BUENA");
});
test("API, escrituras y peticiones con credenciales: el SW NO interviene (nunca finge éxito ni sirve datos del caché)", async () => {
  const sw = cargarSW({ red: redQueNunca(), previo: { "/rest/v1/caja_movimientos": "VIEJO" } });
  for (const [ruta, o] of [["/rest/v1/caja_movimientos", {}], ["/api/pin", {}], ["/index.html", { metodo: "POST" }], ["/app.js", { cabeceras: { authorization: "Bearer x" } }], ["/app.js", { cabeceras: { apikey: "k" } }]]) {
    const r = await pedir(sw, ruta, o);
    assert.equal(r.interceptada, false, `${ruta} ${JSON.stringify(o)}`);
  }
});

test("un GET DINÁMICO del mismo origen (no es de la app: p. ej. una consulta larga) NO pasa por el caché ni por el plazo", async () => {
  const sw = cargarSW({ red: redQueNunca(), previo: { "/__cmd": "ORDEN-VIEJA" } });
  for (const ruta of ["/__cmd", "/algo-dinamico?x=1", "/app.js?v=otra-version"]) assert.equal((await pedir(sw, ruta, { cliente: "c" })).interceptada, false, ruta);
});

// B8 · G: el worker 3.14.1 (publicado) guarda cada respuesta AL LLEGAR; una petición suya que termina después del activate de la 3.15
// vuelve a crear «entimotors-v3.14.1». La 3.15 NUNCA contesta con esa caché ajena y la borra en la siguiente navegación.
test("una caché de OTRA versión re-creada tras activar: no contesta (ni sin red) y la navegación la borra", async () => {
  const PROPIA = (CODIGO_SW.match(/const CACHE_NAME = "([^"]+)"/) || [])[1];
  const AJENA = "entimotors-v0.0.0-anterior";   // el árbol aún se llama 3.14.1 (la 3.15.0 solo existe en staging): nombre distinto del propio
  assert.notEqual(AJENA, PROPIA);
  const almacenes = new Map([[AJENA, new Map([[`${ORIGEN}/index.html`, "VIEJA-3141"]])], [PROPIA, new Map()]]);
  const caja = (n) => { if (!almacenes.has(n)) almacenes.set(n, new Map()); const a = almacenes.get(n);
    return { put: async (r, res) => { a.set(new URL(r.url || r, ORIGEN).href, await res.text()); }, match: async (r) => { const x = a.get(new URL(r.url || r, ORIGEN).href); return x === undefined ? undefined : new Response(x); } }; };
  const caches = { open: async (n) => caja(n), keys: async () => [...almacenes.keys()], delete: async (n) => almacenes.delete(n),
    match: async (r) => { for (const a of almacenes.values()) { const x = a.get(new URL(r.url || r, ORIGEN).href); if (x !== undefined) return new Response(x); } } };
  const manejadores = {}; const pendientes = [];
  const self_ = { location: new URL(`${ORIGEN}/`), addEventListener: (t, f) => { manejadores[t] = f; }, skipWaiting() {}, clients: { claim() {} } };
  vm.runInContext(CODIGO_SW, vm.createContext({ self: self_, caches, fetch: async () => { throw new TypeError("Failed to fetch"); }, Request, Response, URL, Headers, Promise, setTimeout, clearTimeout, Map, Symbol, Date }), { filename: "sw.js" });
  const request = new Request(`${ORIGEN}/index.html`); Object.defineProperty(request, "mode", { value: "navigate" });
  let p = null;
  manejadores.fetch({ request, clientId: "", resultingClientId: "cx", respondWith(x) { p = Promise.resolve(x); }, waitUntil(x) { pendientes.push(x); } });
  const r = await p.then((res) => res.text(), (e) => `ERROR ${e.message}`);
  assert.notEqual(r, "VIEJA-3141", "nunca la página de otra versión");
  await Promise.all(pendientes);
  assert.deepEqual([...almacenes.keys()], [PROPIA], "la caché ajena se borró en la navegación");
});
