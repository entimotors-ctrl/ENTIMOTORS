// Utilidades de la pagina de prueba (se ejecutan DENTRO del navegador real): banco de casos, apertura de la aplicacion en un
// iframe del mismo origen con el runtime REAL, esperas, canario de contraseña y clasificacion de errores de consola.
import { M } from "/__h/helpers/mock-navegador.js";

export const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
export async function esperarHasta(cond, { ms = 8000, cada = 25, desc = "condicion" } = {}) {
  const t0 = Date.now(); let ultimo = null;
  while (Date.now() - t0 < ms) { try { const v = await cond(); if (v) return v; } catch (e) { ultimo = e; } await pausa(cada); }
  throw new Error(`tiempo agotado esperando: ${desc}${ultimo ? ` (${ultimo.message})` : ""}`);
}
export const ok = (c, m) => { if (!c) throw new Error(m || "afirmacion falsa"); };
export const mismo = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || "distinto"}: obtenido ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`); };
export const igual = (a, b, m) => { if (a !== b) throw new Error(`${m || "distinto"}: obtenido ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`); };

const borrarBases = async () => {
  if (!indexedDB.databases) return;
  const dbs = await indexedDB.databases();
  await Promise.all(dbs.map((d) => new Promise((res) => { const t = setTimeout(res, 1500); const r = indexedDB.deleteDatabase(d.name); r.onsuccess = r.onerror = r.onblocked = () => { clearTimeout(t); res(); }; })));
};

/** Banco de pruebas: crea el estado compartido con los iframes (window.__H), los casos y las utilidades. */
export function crearBanco({ enviar, muerto }) {
  const H = window.__H = { escenario: {}, servidor: null, interceptor: null, errores: [], consola: [], externos: [], swRegistros: [] };
  // Contraseña sintetica: se genera aqui, solo en memoria. NUNCA se imprime, se envia ni se escribe: solo se busca (PRESENTE/AUSENTE).
  const CANARIO = `Cn-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}-9aZ`;
  const limpio = (s) => String(s).split(CANARIO).join("«canario»");
  const abiertas = new Set();

  const enviarLimpio = (obj) => {
    let s = JSON.stringify(obj);
    if (s.includes(CANARIO)) { obj = { ...JSON.parse(limpio(s)), canarioEnResultado: true }; }
    return enviar(obj);
  };

  async function limpiarAlmacenamiento() { localStorage.clear(); sessionStorage.clear(); await borrarBases(); }

  /**
   * Abre la app REAL en un iframe. Opciones:
   *  ruta, hash            → URL dentro del origen (p. ej. "/index.html", "#access_token=…&type=recovery")
   *  cuenta                → cuenta sintetica del mock: se guarda una sesion de servidor valida (entimotors_sb_sesion)
   *  almacen               → claves extra de localStorage (objetos → JSON), p. ej. { enti_session: {…} }
   *  servidor(s, M)        → prepara el mock antes de cargar el runtime
   *  sinRed, swReal        → banderas para el prelude
   */
  async function abrirApp({ ruta = "/index.html", hash = "", cuenta = null, almacen = {}, servidor = null, sinRed = false, swReal = false, modoDatos = "blanco" } = {}) {
    await limpiarAlmacenamiento();
    H.servidor = M.crearServidor(); H.interceptor = null; H.escenario = { sinRed, swReal };
    if (servidor) servidor(H.servidor, M);
    if (cuenta) localStorage.setItem("entimotors_sb_sesion", JSON.stringify(H.servidor.emitirSesion(cuenta)));
    if (modoDatos) localStorage.setItem("enti_modo_datos", modoDatos);
    for (const [k, v] of Object.entries(almacen)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "width:1000px;height:760px;border:1px solid #555;background:#fff";
    document.body.appendChild(iframe); abiertas.add(iframe);
    const cargado = new Promise((r) => iframe.addEventListener("load", r, { once: true }));
    iframe.src = ruta + (typeof hash === "function" ? hash(H.servidor) : hash);
    await cargado;
    const doc = iframe.contentDocument, win = iframe.contentWindow;
    const app = { iframe, win, doc, $: (s) => doc.querySelector(s), $$: (s) => [...doc.querySelectorAll(s)], activo: (id) => !!doc.getElementById(id)?.classList.contains("active"),
      cerrar() { iframe.remove(); abiertas.delete(iframe); } };
    return app;
  }

  /** Espera a que el arranque REAL de app.js llegue a un estado estable y dice cual. */
  async function esperarArranque(app, { ms = 10000 } = {}) {
    const d = app.doc;
    return esperarHasta(() => {
      const rcv = (d.getElementById("rcvCuerpo")?.textContent || "").trim();
      if (d.getElementById("rcvForm") || (rcv && !/Comprobando/.test(rcv))) return "recuperacion";
      if (app.activo("gateInstall")) return "instalar";
      if (app.activo("gateModo")) return "modo";
      if (app.activo("shell")) {
        if (app.activo("view-mi-trabajo") || (d.getElementById("ajustesInfo")?.innerHTML || "").trim() !== "") return "shell";
        return null;
      }
      if (app.activo("gateLogin")) return "login";
      return null;
    }, { ms, desc: "arranque de la aplicacion" });
  }

  const contar = (doc) => ({ img: doc.querySelectorAll("img").length, svg: doc.querySelectorAll("svg").length, script: doc.querySelectorAll("script").length,
    iframe: doc.querySelectorAll("iframe").length, manejadores: doc.querySelectorAll("[onerror],[onload]").length });

  /** Busca el canario SIN imprimirlo: devuelve solo PRESENTE/AUSENTE por lugar. */
  function buscarCanario(app) {
    const en = {};
    en.dom = !!app && (app.doc.documentElement.outerHTML.includes(CANARIO) || [...app.doc.querySelectorAll("input,textarea")].some((i) => String(i.value).includes(CANARIO)));
    en.localStorage = JSON.stringify(Object.entries(localStorage)).includes(CANARIO);
    en.sessionStorage = JSON.stringify(Object.entries(sessionStorage)).includes(CANARIO);
    en.consola = H.consola.join("\n").includes(CANARIO) || JSON.stringify(H.errores).includes(CANARIO);
    return Object.fromEntries(Object.entries(en).map(([k, v]) => [k, v ? "PRESENTE" : "AUSENTE"]));
  }

  /** Recursos que el navegador pidio fuera de 127.0.0.1 (img/script/link…): Resource Timing de cada iframe abierto. */
  function auditarRecursos() {
    for (const f of abiertas) {
      try {
        for (const e of f.contentWindow.performance.getEntriesByType("resource")) {
          if (/^(data|blob|about):/.test(e.name)) continue;
          let host = ""; try { host = new URL(e.name).hostname; } catch { /* nombre raro */ }
          if (host !== "127.0.0.1") H.externos.push({ via: "resource", destino: e.name.slice(0, 160) });
        }
      } catch { /* iframe ya cerrado */ }
    }
  }
  async function cerrarTodas() { for (const f of [...abiertas]) { f.remove(); abiertas.delete(f); } await pausa(60); }

  /** Un caso: aisla errores/red, ejecuta, cierra iframes y clasifica errores de consola. Devuelve el estado. */
  async function caso(nombre, fn, { grupo = "", esperados = [], errorCritico = true } = {}) {
    H.errores = []; H.externos = []; H.consola = []; H.swRegistros = []; H.interceptor = null;
    const t0 = performance.now(); let estado = "PASS", detalle = "", extras = {};
    try { const r = await fn(); if (r && typeof r === "object") extras = r; } catch (e) { estado = "FAIL"; detalle = limpio((e && e.message) || e); }
    await pausa(150);
    auditarRecursos();
    const clasif = H.errores.map((e) => ({ ...e, clase: esperados.some((rx) => rx.test(e.texto)) ? "EXPECTED_MOCK_ERROR" : "APPLICATION_ERROR" }));
    const apps = clasif.filter((c) => c.clase === "APPLICATION_ERROR");
    if (H.externos.length) { estado = "FAIL"; detalle += ` UNEXPECTED_EXTERNAL_REQUEST: ${JSON.stringify(H.externos)}`; }
    if (apps.length && errorCritico) { estado = "FAIL"; detalle += ` APPLICATION_ERROR: ${limpio(apps.map((a) => `${a.tipo}: ${a.texto}`).join(" | "))}`; }
    await cerrarTodas();
    enviarLimpio({ tipo: "caso", grupo, nombre, estado, detalle: detalle.trim(), extras, applicationErrors: apps.length, expectedErrors: clasif.length - apps.length,
      externos: H.externos.length, ms: Math.round(performance.now() - t0) });
    return estado;
  }

  // Fallos REALES del motor (no inventados): un fetch a un puerto sin nadie escuchando y un fetch con la señal ya abortada.
  const fallosNativos = {
    red: () => fetch(`http://127.0.0.1:${muerto}/no-hay-nadie`, { cache: "no-store" }),
    abortado: () => { const c = new AbortController(); c.abort(); return fetch("/__h/vacio.js", { signal: c.signal }); },
  };

  return { H, M, CANARIO, limpio, caso, abrirApp, esperarArranque, esperarHasta, pausa, contar, buscarCanario, fallosNativos, enviar: enviarLimpio, ok, igual, cerrarTodas };
}
