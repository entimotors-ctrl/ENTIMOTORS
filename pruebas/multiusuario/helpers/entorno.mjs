// ENTORNO node:vm para ejecutar el JS REAL de taller-demo/ sin navegador y sin red.
//
// - Los scripts se leen de disco tal cual (no se copian ni se modifican) y se ejecutan en un contexto vm
//   donde `window` es el propio global, con mocks minimos y EXPLICITOS de navegador.
// - `fetch` es el servidor sintetico (falla cerrado). No hay red real.
// - Timers y Date son controlados: nada queda vivo al terminar y se puede simular la caducidad de tokens.
// - `indexedDB.open` REGISTRA el nombre de la base que se intenta abrir y falla: no persiste nada.
import vm from "node:vm";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crearDocumento, Elemento } from "./dom.mjs";
import { crearServidor, URL_SB, URL_API, ANON } from "./supabase-mock.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ = path.resolve(AQUI, "..", "..", "..");
export const RUNTIME = path.join(RAIZ, "taller-demo");
export const leer = (rel) => fs.readFileSync(path.join(RUNTIME, rel), "utf8");
export const existe = (rel) => fs.existsSync(path.join(RUNTIME, rel));

export function crearAlmacen(inicial = {}) {
  const m = new Map(Object.entries(inicial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; }, volcado: () => Object.fromEntries(m),
  };
}

const ORDEN_INDEX = ["build-target", "supabase-client", "auth", "recovery", "app", "usuarios"];
const ARCHIVO = { "supabase-client": "supabase-client.js", auth: "auth.js", recovery: "recovery.js", app: "app.js", usuarios: "usuarios.js" };

export function crearEntorno(opts = {}) {
  const {
    producto = "admin",          // "admin" | "mecanico" (usa el build-target de cada build) | "ninguno" | objeto crudo
    config = "sintetica",        // "sintetica" | null | objeto para window.ENTIMOTORS_SUPABASE
    apiUrl = "",
    scripts = ORDEN_INDEX,
    online = true, standalone = true,
    hash = "", search = "", pathname = "/index.html",
    storage = {}, servidor = crearServidor(), local,
    preparar = null,             // (env) => void, se ejecuta ANTES de cargar los scripts (p. ej. dejar «activa» una pantalla)
    mutar = {},                  // { app: (texto) => texto, auth: ... } SOLO para pruebas de mutacion: se altera en memoria, nunca en disco
  } = opts;

  const doc = crearDocumento();
  const almacen = crearAlmacen(storage);
  const almacenSesion = crearAlmacen();
  const consola = { log: [], info: [], warn: [], error: [] };
  const navegaciones = [], ventanas = [], idbAbiertas = [], alertas = [];
  const oyentesVentana = {};
  const reloj = { ahora: Date.now(), lista: [], seq: 0 };

  // ── tiempo controlado ──
  const FechaFalsa = class extends Date {
    constructor(...a) { if (a.length === 0) super(reloj.ahora); else super(...a); }
    static now() { return reloj.ahora; }
  };
  const programar = (fn, ms, intervalo, args) => { const id = ++reloj.seq; reloj.lista.push({ id, en: reloj.ahora + (Number(ms) || 0), fn, args, intervalo }); return id; };
  const cancelar = (id) => { reloj.lista = reloj.lista.filter((t) => t.id !== id); };

  // ── navegador ──
  const location = {
    hash, search, pathname, hostname: "app.synthetic.test", host: "app.synthetic.test", protocol: "https:",
    get origin() { return "https://app.synthetic.test"; },
    get href() { return `https://app.synthetic.test${this.pathname}${this.search}${this.hash}`; },
    replace(u) { navegaciones.push({ tipo: "replace", url: String(u) }); },
    assign(u) { navegaciones.push({ tipo: "assign", url: String(u) }); },
    reload() { navegaciones.push({ tipo: "reload" }); },
    toString() { return this.href; },
  };
  const history = {
    replaceState(estado, titulo, url) {
      navegaciones.push({ tipo: "replaceState", url: url === undefined ? undefined : String(url) });
      if (typeof url === "string") { const u = new URL(url, "https://app.synthetic.test/"); location.pathname = u.pathname; location.search = u.search; location.hash = u.hash; }
    },
    pushState() {}, back() {}, forward() {},
  };
  const navigator = {
    onLine: online, userAgent: "harness-qa-multiusuario", standalone: standalone,
    serviceWorker: { controller: null, getRegistration: async () => null, register: async () => ({}), addEventListener() {} },
    clipboard: { writeText: async () => {} },
  };
  const matchMedia = (q) => ({ matches: /display-mode:\s*standalone/.test(q) ? standalone : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const indexedDB = {
    open(nombre, version) {
      idbAbiertas.push({ nombre, version });
      const req = { error: new Error("indexedDB deshabilitado en el QA") };
      queueMicrotask(() => { if (typeof req.onerror === "function") req.onerror({ target: req }); });
      return req;
    },
  };
  const texto = (x) => {
    if (typeof x === "string") return x;
    if (x && typeof x === "object" && "message" in x && "name" in x) return `${x.name}: ${x.message}`;   // Error de cualquier realm
    try { return JSON.stringify(x); } catch { return String(x); }
  };
  const log = (k) => (...a) => { consola[k].push(a.map(texto).join(" ")); };

  const win = {
    document: doc, localStorage: almacen, sessionStorage: almacenSesion, navigator, location, history, matchMedia, indexedDB,
    console: { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug() {} },
    fetch: servidor.fetch,
    setTimeout: (fn, ms, ...a) => programar(fn, ms, null, a), clearTimeout: cancelar,
    setInterval: (fn, ms, ...a) => programar(fn, ms, Number(ms) || 1, a), clearInterval: cancelar,
    requestAnimationFrame: (fn) => programar(fn, 16, null, []), cancelAnimationFrame: cancelar,
    AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone,
    atob: (s) => Buffer.from(String(s), "base64").toString("binary"), btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    crypto: globalThis.crypto, Date: FechaFalsa,
    Event: class { constructor(t) { this.type = t; } }, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    open: () => { const v = new Elemento(doc, "window"); v.closed = false; v.location = { href: "" }; ventanas.push(v); return v; },
    print() {}, alert: (m) => { alertas.push(String(m)); }, confirm: () => false, prompt: () => null, scrollTo() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
    addEventListener(t, fn) { (oyentesVentana[t] ||= []).push(fn); },
    removeEventListener(t, fn) { oyentesVentana[t] = (oyentesVentana[t] || []).filter((f) => f !== fn); },
    dispatchEvent(ev) { (oyentesVentana[ev.type] || []).forEach((f) => f(ev)); return true; },
  };
  win.window = win; win.self = win;
  if (local !== undefined) win.ENTIMOTORS_LOCAL = local;
  vm.createContext(win);

  const cargarRel = (rel, clave) => {
    const original = leer(rel);
    const fuente = clave && mutar[clave] ? mutar[clave](original) : original;
    if (clave && mutar[clave] && fuente === original) throw new Error(`mutante sin efecto sobre ${rel}`);
    return vm.runInContext(fuente, win, { filename: rel });
  };
  const env = {
    win, doc, servidor, almacen, almacenSesion, consola, navegaciones, ventanas, idbAbiertas, alertas, oyentesVentana, reloj,
    evaluar: (codigo) => vm.runInContext(codigo, win),
    cargar: cargarRel,
    /** Deja correr las cadenas de promesas pendientes. */
    asentar: async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); },
    /** Avanza el reloj falso `ms` milisegundos ejecutando los temporizadores que venzan. */
    async avanzar(ms) {
      const limite = reloj.ahora + ms;
      for (;;) {
        const sig = reloj.lista.filter((t) => t.en <= limite).sort((a, b) => a.en - b.en || a.id - b.id)[0];
        if (!sig) break;
        reloj.ahora = Math.max(reloj.ahora, sig.en);
        if (sig.intervalo) sig.en = reloj.ahora + sig.intervalo; else reloj.lista = reloj.lista.filter((t) => t.id !== sig.id);
        try { sig.fn(...(sig.args || [])); } catch (e) { consola.error.push(`timer: ${e && e.message}`); }
        await env.asentar(4);
      }
      reloj.ahora = limite;
      await env.asentar(6);
    },
    timersPendientes: () => reloj.lista.length,
    /** Envuelve una funcion GLOBAL (declaracion de funcion del runtime) para registrar sus llamadas. */
    espiar(nombre, impl) {
      const original = win[nombre];
      if (typeof original !== "function") throw new Error(`espiar: ${nombre} no es una funcion global`);
      const llamadas = [];
      win[nombre] = function (...a) { llamadas.push(a); return impl ? impl.apply(this, a) : original.apply(this, a); };
      return llamadas;
    },
    setOnline(v) { navigator.onLine = !!v; },
  };

  if (config !== null) win.ENTIMOTORS_SUPABASE = config === "sintetica" ? { url: URL_SB, anonKey: ANON, habilitado: true, apiUrl } : config;

  if (preparar) preparar(env);

  for (const nombre of scripts) {
    if (nombre === "build-target") {
      if (producto === "ninguno") continue;
      if (typeof producto === "object") { win.ENTIMOTORS_BUILD = producto; continue; }
      cargarRel(producto === "mecanico" ? "build-mecanicos/build-target.js" : "build-target.js");
    } else cargarRel(ARCHIVO[nombre], nombre);
  }
  return env;
}

/** Comprueba que el servidor sintetico no vio nada raro: ningun host ajeno ni ruta imprevista. */
export function sinLlamadasAjenas(env) {
  assert.deepEqual(env.servidor.ajenas, [], "hosts ajenos contactados");
  assert.deepEqual(env.servidor.inesperadas, [], "llamadas inesperadas al servidor sintetico");
}
/** Ningun token/contrasena sintetica aparece en consola, almacenamiento accesible ni HTML asignado. */
export function sinFugas(env, secretos = []) {
  const buscar = [...env.servidor.tokensEmitidos(), ...secretos];
  // el token de sesion vive por diseno en entimotors_sb_sesion (lo administra supabase-client.js): esa clave se excluye
  const vol = env.almacen.volcado(); delete vol.entimotors_sb_sesion;
  const pajar = JSON.stringify(env.consola) + JSON.stringify(vol) + env.doc.sumideros.map((s) => s.html).join("\n");
  for (const s of buscar) if (s) assert.ok(!pajar.includes(s), `fuga: "${String(s).slice(0, 14)}…" aparece en consola/HTML/almacenamiento`);
}
