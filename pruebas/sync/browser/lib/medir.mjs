// 3.15 (Bloque 7) · utilidades de MEDICIÓN dentro de la página real (index.html) y del proceso del navegador. Solo miden: no cambian
// el comportamiento de la app (envolver una función global conserva su resultado, sus errores y su `this`).
import fs from "node:fs";
import { spawnSync } from "node:child_process";

/** Instala la instrumentación en la página: marcas de las fases del arranque y de cada render. Idempotente. */
export const instrumentar = (d) => d.eval(() => {
  if (window.__b7) return true;
  const B = (window.__b7 = { marcas: [], t0: performance.now() });
  const marcar = (n, t0) => B.marcas.push({ n, t0: Math.round(t0 * 10) / 10, t1: Math.round(performance.now() * 10) / 10 });
  const envolverGlobal = (nombre) => {
    const f = window[nombre];
    if (typeof f !== "function" || f.__b7) return;
    const w = function (...a) { const t0 = performance.now(); let r; try { r = f.apply(this, a); } catch (e) { marcar(nombre, t0); throw e; }
      if (r && typeof r.then === "function") return r.finally(() => marcar(nombre, t0)); marcar(nombre, t0); return r; };
    w.__b7 = true; window[nombre] = w;
  };
  ["startApp", "openDb", "prepararModoNube", "continuarArranque", "renderOrdersList", "renderClientes", "renderInventario", "renderCitasList", "renderCotizaciones",
    "renderPOS", "renderFinanzas", "renderFinanzasCharts", "renderRendimiento", "renderAjustes", "renderDashboard", "renderNotificaciones", "renderMiTrabajo",
    "renderMensajes", "renderCreditos", "revisarDatos313", "prepararRealtime", "renderSyncChip"].forEach(envolverGlobal);
  const envolverMetodo = (obj, nombre, etiqueta) => {
    const f = obj[nombre]; if (typeof f !== "function" || f.__b7) return;
    obj[nombre] = function (...a) { const t0 = performance.now(); const r = f.apply(this, a); if (r && typeof r.then === "function") return r.finally(() => marcar(etiqueta, t0)); marcar(etiqueta, t0); return r; };
    obj[nombre].__b7 = true;
  };
  if (window.SyncDB) envolverMetodo(window.SyncDB, "abrirSeguro", "SyncDB.abrirSeguro");
  if (window.SyncEngine) {
    const crear = window.SyncEngine.crearMotor;
    window.SyncEngine.crearMotor = function (...a) { const m = crear.apply(this, a); ["pullTodo", "sincronizar", "flush"].forEach((k) => envolverMetodo(m, k, "motor." + k)); return m; };
  }
  return true;
});

/** Preparación común de una sesión de nube sin GoTrue (igual que las demás pruebas app-real): token de la pila y toasts mudos. */
export const prepararSesion = (d, token) => d.eval((a) => {
  window.__toasts = []; window.toast = (m) => window.__toasts.push(String(m));
  window.__token = a.token;
  try { if (!localStorage.getItem("enti_modo_datos")) localStorage.setItem("enti_modo_datos", "blanco"); } catch (e) { /* sin almacenamiento */ }   // la elección de una sola vez del primer arranque
  window.SupabaseCliente.sesion = () => (window.__token ? { access_token: window.__token } : null);
  window.SupabaseCliente.estado = () => ({ activo: true, conSesion: true, usuario: "x@example.test" });
  // como el cliente real (3.15 · 8A): sin sesión que renovar → {motivo:"sin-sesion", clase:"rechazada"}
  window.SupabaseCliente.refrescarSesion = async () => (window.__token ? { ok: true } : { ok: false, motivo: "sin-sesion", clase: "rechazada" });
  return true;
}, { token });

/** Tiempos de navegación del documento (ms desde el inicio de la navegación). */
export const navegacion = (d) => d.eval(() => {
  const n = performance.getEntriesByType("navigation")[0] || {};
  const r = (x) => Math.round((x || 0) * 10) / 10;
  const recursos = performance.getEntriesByType("resource");
  return { respuesta: r(n.responseEnd), domListo: r(n.domContentLoadedEventEnd), carga: r(n.loadEventEnd), primerPintado: r((performance.getEntriesByName("first-contentful-paint")[0] || {}).startTime),
    recursos: recursos.length, bytesRecursos: recursos.reduce((s, x) => s + (x.transferSize || 0), 0), sw: !!navigator.serviceWorker?.controller };
});

/** RSS (MB) de todo el árbol de procesos del navegador (grupo de procesos del dispositivo). */
export function rssMb(pid) {
  const r = spawnSync("ps", ["-o", "rss=", "-g", String(pid)], { encoding: "utf8" });
  return Math.round(r.stdout.split("\n").filter(Boolean).reduce((s, x) => s + Number(x), 0) / 1024);
}
/** CPU (s) consumida por el árbol de procesos del navegador. */
export function cpuS(pid) {
  const r = spawnSync("ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" });
  let t = 0;
  for (const p of r.stdout.split("\n").map((x) => x.trim()).filter(Boolean)) { try { const c = fs.readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" "); t += Number(c[11]) + Number(c[12]); } catch { /* terminó */ } }
  return t / 100;
}
/** Memoria del sistema (MB) para el registro del arnés. */
export function memoriaSistema() {
  const m = fs.readFileSync("/proc/meminfo", "utf8");
  const v = (k) => Math.round(Number((m.match(new RegExp(`^${k}:\\s+(\\d+)`, "m")) || [])[1] || 0) / 1024);
  return { disponible: v("MemAvailable"), swapLibre: v("SwapFree"), swapTotal: v("SwapTotal") };
}
export const mediana = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor(s.length / 2)] * 10) / 10 : null; };
export function anotar(archivo, etiqueta, datos) {
  const linea = JSON.stringify({ etiqueta, t: new Date().toISOString(), ...datos });
  console.log("RENDIMIENTO_B7 " + linea);
  if (archivo) fs.appendFileSync(archivo, linea + "\n");
}
