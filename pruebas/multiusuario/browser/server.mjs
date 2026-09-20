// Servidores HTTP LOCALES del QA en navegador real. Solo escuchan en 127.0.0.1 (puerto dinamico) y sirven:
//   · el runtime REAL (taller-demo/ o el build de «Mi Trabajo» generado en /tmp) SIN modificar en disco;
//   · el harness (pruebas/multiusuario/browser/) bajo /__h/ y el mock sintetico bajo /__m/;
//   · un endpoint /__test_result que recibe los resultados (colector en memoria).
// Cada origen (puerto) es un ORIGIN distinto para el navegador: almacenamiento, IndexedDB y CacheStorage separados.
//
// Dos modos por origen:
//   "app" → para probar la APLICACION: index.html / panel-tecnico.html se sirven con DOS cambios EN MEMORIA (nunca en disco):
//             1) se inyecta helpers/prelude.js como primer script (mocks de red ANTES de cargar el runtime);
//             2) el <script> de Chart.js del CDN se cambia por un archivo vacio local (el runtime ya contempla «sin Chart»).
//           supabase-config.js se sustituye por una configuracion SINTETICA (el real trae la URL de produccion).
//           El resto de archivos (app.js, auth.js, usuarios.js, recovery.js, sw.js…) van BYTE A BYTE como en el repositorio.
//   "raw" → para probar el SERVICE WORKER / PWA: TODO byte a byte, sin ninguna transformacion.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL_SB, URL_API, ANON } from "../helpers/supabase-mock.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const DIR_BROWSER = AQUI;
const DIR_MOCK = path.resolve(AQUI, "..", "helpers");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8" };

const CONFIG_SINTETICA = `/* configuracion SINTETICA del harness (sustituye a supabase-config.js SOLO dentro de este servidor local) */
window.ENTIMOTORS_SUPABASE = { url: ${JSON.stringify(URL_SB)}, anonKey: ${JSON.stringify(ANON)}, habilitado: true, apiUrl: ${JSON.stringify(URL_API)} };
`;

/** Cambios EN MEMORIA al HTML de la aplicacion. Falla cerrado si quedara algun recurso externo. */
export function transformarHtml(texto, nombre) {
  let t = String(texto);
  const chart = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js"><\/script>/;
  if (chart.test(t)) t = t.replace(chart, '<script src="/__h/vacio.js"></script>');
  const externos = [...t.matchAll(/<(?:script|link|img|iframe|source|video|audio)\b[^>]*\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/gi)].map((m) => m[1]);
  if (externos.length) throw new Error(`${nombre}: quedan recursos externos que el harness no sustituye: ${externos.join(", ")}`);
  if (!/<head[^>]*>/i.test(t)) throw new Error(`${nombre}: no se encontro <head> para inyectar el prelude`);
  return t.replace(/<head[^>]*>/i, (m) => `${m}\n<script src="/__h/helpers/prelude.js"></script>`);
}

const leerSiExiste = (ruta) => { try { const st = fs.statSync(ruta); return st.isFile() ? fs.readFileSync(ruta) : null; } catch { return null; } };
const dentro = (base, destino) => { const r = path.relative(base, destino); return r !== "" && !r.startsWith("..") && !path.isAbsolute(r); };

/**
 * Crea UN origen. Opciones:
 *  nombre, dir (raiz del runtime a servir), modo ("app"|"raw"), prefijo ("" | "/taller"…), colector,
 *  mutar: { "app.js": (texto) => texto }  → SOLO para el origen de mutantes; nunca toca el disco,
 *  swActual: () => Buffer|null            → si existe, /sw.js se responde con esto (prueba de actualizacion).
 *  ctl: { sw(v) }                          → gancho para /__ctl/sw?v=… (cambia la fase de la prueba de actualizacion).
 */
export function crearOrigen({ nombre, dir, modo, prefijo = "", colector, mutar = {}, swActual = null, ctl = {} }) {
  const estado = { desconectado: false, peticiones: [] };
  const servir = (res, codigo, cuerpo, tipo) => {
    res.writeHead(codigo, { "Content-Type": tipo || "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(cuerpo);
  };
  const servidor = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    let ruta;
    try { ruta = decodeURIComponent(u.pathname); } catch { return servir(res, 400, "ruta invalida"); }
    estado.peticiones.push(`${req.method} ${ruta}`);
    if (estado.peticiones.length > 400) estado.peticiones.shift();

    // ── colector ──
    if (req.method === "POST" && ruta === "/__test_result") {
      let cuerpo = "";
      req.on("data", (d) => { cuerpo += d; if (cuerpo.length > 4_000_000) req.destroy(); });
      req.on("end", () => { try { colector.recibir(JSON.parse(cuerpo)); } catch { /* cuerpo invalido: se ignora */ } servir(res, 204, ""); });
      return;
    }
    // ── control del harness (solo para las pruebas de actualizacion / sin conexion) ──
    if (ruta === "/__ctl/desconectar") { estado.desconectado = u.searchParams.get("v") === "1"; return servir(res, 200, String(estado.desconectado)); }
    if (ruta === "/__ctl/sw") { if (ctl.sw) ctl.sw(u.searchParams.get("v")); return servir(res, 200, "ok"); }
    if (ruta === "/__ctl/peticiones") return servir(res, 200, JSON.stringify(estado.peticiones), MIME[".json"]);
    if (estado.desconectado && !ruta.startsWith("/__")) { req.socket.destroy(); return; }   // simula «sin red» para el SW: la conexion se corta

    if (req.method !== "GET" && req.method !== "HEAD") return servir(res, 405, "metodo no permitido");

    // ── harness y mock ──
    if (ruta === "/__h/vacio.js") return servir(res, 200, "/* vacio a proposito: sustituye a Chart.js del CDN en el harness */\n", MIME[".js"]);
    if (ruta.startsWith("/__h/")) {
      const f = path.join(DIR_BROWSER, ruta.slice("/__h/".length));
      const b = dentro(DIR_BROWSER, f) && /\.(html|js|mjs)$/.test(f) ? leerSiExiste(f) : null;
      return b ? servir(res, 200, b, MIME[path.extname(f)]) : servir(res, 404, "no existe");
    }
    if (ruta === "/__m/supabase-mock.mjs") { const b = leerSiExiste(path.join(DIR_MOCK, "supabase-mock.mjs")); return b ? servir(res, 200, b, MIME[".mjs"]) : servir(res, 404, "no existe"); }

    // ── runtime ──
    let rel;
    if (prefijo) {
      if (ruta === prefijo) { res.writeHead(302, { Location: `${prefijo}/` }); return res.end(); }
      if (!ruta.startsWith(prefijo + "/")) return servir(res, 404, "fuera del prefijo");
      rel = ruta.slice(prefijo.length + 1);
    } else rel = ruta.slice(1);
    if (rel === "" || rel.endsWith("/")) rel += "index.html";

    if (modo === "app") {
      if (rel === "supabase-config.js") return servir(res, 200, CONFIG_SINTETICA, MIME[".js"]);
      if (rel === "config-local.js") return servir(res, 404, "config-local.js no existe (es opcional y no se publica)");
    }
    if (rel === "sw.js" && swActual) { const b = swActual(); return b ? servir(res, 200, b, MIME[".js"]) : servir(res, 404, "sin sw"); }
    const f = path.join(dir, rel);
    const bruto = dentro(dir, f) ? leerSiExiste(f) : null;
    if (!bruto) return servir(res, 404, "no existe");
    let cuerpo = bruto;
    if (modo === "app" && /^(index|panel-tecnico)\.html$/.test(rel)) cuerpo = transformarHtml(bruto.toString("utf8"), rel);
    if (mutar[rel]) cuerpo = mutar[rel](bruto.toString("utf8"));
    return servir(res, 200, cuerpo, MIME[path.extname(f)] || "application/octet-stream");
  });
  return new Promise((resolve, reject) => {
    servidor.once("error", reject);
    servidor.listen(0, "127.0.0.1", () => {
      const puerto = servidor.address().port;
      resolve({ nombre, puerto, url: `http://127.0.0.1:${puerto}`, prefijo, estado, cerrar: () => new Promise((r) => { servidor.closeAllConnections?.(); servidor.close(() => r()); }) });
    });
  });
}

/**
 * Proxy-SUMIDERO. Los navegadores se lanzan con este proxy para TODO lo que no sea 127.0.0.1: cualquier intento de salir a
 * Internet llega aqui, se ANOTA y se rechaza (502). No reenvia nada: no existe salida real. Sirve de prueba de que no hubo red.
 */
export function crearTrampa() {
  const intentos = [];
  const srv = http.createServer((req, res) => { intentos.push({ via: "http", destino: (() => { try { return new URL(req.url).host; } catch { return String(req.url).slice(0, 80); } })() }); res.writeHead(502); res.end("sin salida (sumidero del QA)"); });
  srv.on("connect", (req, sock) => { intentos.push({ via: "connect", destino: String(req.url).slice(0, 120) }); sock.on("error", () => {}); sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve({ puerto: srv.address().port, intentos, cerrar: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) }));
  });
}
