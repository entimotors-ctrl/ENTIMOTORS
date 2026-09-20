// Verificador ESTATICO de versionado/cache de la PWA + ejecucion REAL del service worker en node:vm.
// `verificarPwa` es una funcion pura sobre textos: asi las pruebas pueden alimentarla con el runtime real
// (debe pasar) y con MUTANTES en memoria (deben fallar por el id correcto). No escribe nada.
import vm from "node:vm";
import { leer, existe } from "./entorno.mjs";

export const VERSION_ESPERADA = "3.13.0";
export const fuentesReales = () => ({ app: leer("app.js"), sw: leer("sw.js"), index: leer("index.html"), existe });

function manejador(txt, evento) {
  const m = new RegExp(`self\\.addEventListener\\("${evento}"`).exec(txt);
  if (!m) return null;
  const i = txt.indexOf("{", m.index + m[0].length);
  let d = 0;
  for (let j = i; j < txt.length; j++) { d += (txt[j] === "{") - (txt[j] === "}"); if (d === 0) return txt.slice(i, j + 1); }
  return null;
}
const sinComentarios = (s) => String(s || "").replace(/\/\/[^\n]*/g, "");

export function verificarPwa({ app, sw, index, existe: hay }, version = VERSION_ESPERADA) {
  const R = [];
  const chk = (id, ok, detalle = "") => R.push({ id, ok: Boolean(ok), detalle: ok ? "" : detalle });

  const va = [...app.matchAll(/const VERSION_APP = "([^"]+)"/g)].map((m) => m[1]);
  chk("VERSION_APP", va.length === 1 && va[0] === version, `VERSION_APP=${JSON.stringify(va)} (se esperaba "${version}")`);

  const cn = [...sw.matchAll(/const CACHE_NAME = "([^"]+)"/g)].map((m) => m[1]);
  chk("CACHE_NAME", cn.length === 1 && cn[0] === `entimotors-v${version}`, `CACHE_NAME=${JSON.stringify(cn)} (se esperaba "entimotors-v${version}")`);

  const tags = [...index.matchAll(/<script src="([^"?]+)\?v=([^"]+)"/g)].map((m) => ({ archivo: m[1], v: m[2] }));
  const malas = tags.filter((t) => t.v !== version).map((t) => `${t.archivo}?v=${t.v}`);
  chk("INDEX_QUERY_VERSIONES", tags.length === 8 && !malas.length, `${tags.length} etiquetas ?v= (8 esperadas); distintas de ${version}: [${malas}]`);
  chk("INDEX_APP_Y_CONFIG_LOCAL", tags.some((t) => t.archivo === "app.js" && t.v === version) && tags.some((t) => t.archivo === "config-local.js" && t.v === version), "app.js y config-local.js deben llevar ?v=" + version);

  const shellTxt = (/const SHELL = \[(.*?)\];/s.exec(sw) || [, ""])[1];
  const shell = [...shellTxt.matchAll(/"(\.\/[^"]*)"/g)].map((m) => m[1]);
  const shellV = shell.filter((s) => s.includes("?v="));
  chk("SHELL_QUERY_VERSIONES", shellV.length === 7 && shellV.every((s) => s.endsWith(`?v=${version}`)), `SHELL con ?v= distintas de ${version}: [${shellV.filter((s) => !s.endsWith("?v=" + version))}] (${shellV.length}/7)`);
  const mapaIndex = new Map(tags.map((t) => [t.archivo, t.v]));
  const incoh = shellV.filter((s) => mapaIndex.get(s.slice(2).split("?v=")[0]) !== s.split("?v=")[1]);
  chk("SHELL_COHERENTE_CON_INDEX", !incoh.length, `SHELL y index.html no coinciden en: [${incoh}]`);
  const faltan = shell.filter((s) => s !== "./" && !hay(s.slice(2).split("?")[0]));
  chk("SHELL_RECURSOS_EXISTEN", shell.length === 12 && !faltan.length, `${shell.length} entradas (12 esperadas); no existen: [${faltan}]`);
  const enShell = new Set(shell.map((s) => s.split("?")[0]));
  const sinShell = tags.map((t) => t.archivo).filter((a) => a !== "config-local.js" && !enShell.has("./" + a));
  chk("SHELL_CUBRE_LOS_SCRIPTS", !sinShell.length, `scripts de index.html fuera del SHELL: [${sinShell}]`);

  const texto = app + "\n" + sw + "\n" + index;
  const r312 = (texto.match(/3\.12\.2|entimotors-v3\.12\./g) || []).length, r311 = (texto.match(/3\.12\.1(?![0-9])/g) || []).length;
  chk("SIN_RESIDUOS_3_12_2", r312 === 0, `${r312} referencias a 3.12.2 / entimotors-v3.12.x en app.js, sw.js e index.html`);
  chk("SIN_RESIDUOS_3_12_1", r311 === 0, `${r311} referencias a 3.12.1`);

  const inst = sinComentarios(manejador(sw, "install")), act = sinComentarios(manejador(sw, "activate")), msg = sinComentarios(manejador(sw, "message"));
  const total = (sinComentarios(sw).match(/skipWaiting\(\)/g) || []).length, enMsg = (msg.match(/skipWaiting\(\)/g) || []).length;
  chk("SW_SKIPWAITING_NO_AUTOMATICO", !inst.includes("skipWaiting") && total === enMsg && enMsg >= 1, `skipWaiting en install=${inst.includes("skipWaiting")}; totales=${total}; dentro de 'message'=${enMsg}`);
  chk("SW_ACTIVAR_YA", /event\.data\?\.tipo === "activar-ya"\)\s*\{\s*self\.skipWaiting\(\)/.test(msg), "el handler 'message' ya no llama skipWaiting() para el mensaje activar-ya");
  chk("SW_CLIENTS_CLAIM_EN_ACTIVATE", act.includes("clients.claim()"), "activate ya no llama clients.claim()");
  return R;
}
export const fallos = (r) => r.filter((x) => !x.ok).map((x) => x.id);

/** Ejecuta sw.js REAL en un vm con `self`, `caches` y `fetch` sinteticos. */
export function ejecutarServiceWorker({ cachesExistentes = [], sw = leer("sw.js") } = {}) {
  const oyentes = {}, llamadas = { fetch: [], skipWaiting: 0, claim: 0, borradas: [], abiertas: [], puestas: [] };
  const almacenes = new Map(cachesExistentes.map((n) => [n, new Map()]));
  const respuesta = (u) => ({ url: u, ok: true, status: 200, clone() { return this; } });
  const caches = {
    open: async (n) => { llamadas.abiertas.push(n); if (!almacenes.has(n)) almacenes.set(n, new Map()); const a = almacenes.get(n); return { put: async (k, v) => { llamadas.puestas.push(typeof k === "string" ? k : k.url); a.set(typeof k === "string" ? k : k.url, v); } }; },
    keys: async () => [...almacenes.keys()],
    delete: async (n) => { llamadas.borradas.push(n); return almacenes.delete(n); },
    match: async () => undefined,
  };
  const self = {
    addEventListener: (t, fn) => { (oyentes[t] ||= []).push(fn); },
    skipWaiting: () => { llamadas.skipWaiting++; }, clients: { claim: () => { llamadas.claim++; } },
    location: new URL("https://app.synthetic.test/sw.js"),
  };
  const ctx = vm.createContext({
    self, caches, URL, Request: class { constructor(u) { this.url = String(u); this.method = "GET"; } }, Response: class { constructor(b) { this.body = b; } },
    fetch: async (u, o) => { llamadas.fetch.push({ url: String(u && u.url ? u.url : u), opciones: o }); return respuesta(String(u)); },
    console, Promise,
  });
  vm.runInContext(sw, ctx, { filename: "sw.js" });
  const evento = (extra = {}) => { const esperas = []; return { waitUntil: (p) => esperas.push(p), esperas, ...extra }; };
  return {
    llamadas, almacenes, oyentes,
    async instalar() { const e = evento(); oyentes.install.forEach((f) => f(e)); await Promise.all(e.esperas); },
    async activar() { const e = evento(); oyentes.activate.forEach((f) => f(e)); await Promise.all(e.esperas); },
    mensaje(data) { const e = evento({ data, source: { postMessage() {} } }); oyentes.message.forEach((f) => f(e)); return e; },
    fetchEvento(url, method = "GET") { let resp; const e = evento({ request: { url, method }, respondWith: (p) => { resp = p; } }); oyentes.fetch.forEach((f) => f(e)); return resp; },
    nombreCache: () => vm.runInContext("CACHE_NAME", ctx), shell: () => vm.runInContext("SHELL", ctx),
  };
}
