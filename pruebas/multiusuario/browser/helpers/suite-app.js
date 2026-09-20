// SUITE DE APLICACION en navegador real. Carga el runtime REAL (index.html / app.js / auth.js / usuarios.js / recovery.js /
// panel-tecnico.html) con un DOM real, IndexedDB real y localStorage real; solo la RED es sintetica (mock de Supabase / api-server).
// Corre igual en Chrome y en Firefox. Variante «mitrabajo» = el build de «Mi Trabajo» generado en /tmp.
// Todo dato es sintetico. El canario de contraseña se genera en memoria y jamas se imprime: solo se comprueba PRESENTE/AUSENTE.
import { crearBanco, esperarHasta, pausa, ok, igual, mismo } from "/__h/helpers/pagina.js";
import { casosC7FixA } from "/__h/helpers/suite-c7fixa.js";
import { casosC7FixB } from "/__h/helpers/suite-c7fixb.js";

export const AVISO_RED = "Sin conexión con el servidor. Inténtalo otra vez.";
export const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Payloads de la especificacion (sin alert(): el «canario» es window.__xss, que arranca en 0).
export const P_ERROR = [
  ["img/onerror", '<img src=x onerror="window.__xss=1">'],
  ["svg/onload", '<svg onload="window.__xss=2">'],
  ["script", "<script>window.__xss=3</script>"],
  ["variante de C3 (rompe atributo)", `"'><svg onload="window.__xss=4">`],
];
export const P_ROL = [
  ["img/onerror", '<img src=x onerror="window.__xss=11">'],
  ["svg/onload", '<svg onload="window.__xss=12">'],
  ["script", "<script>window.__xss=13</script>"],
  ["variante de C3 (rompe atributo)", `"'><svg onload="window.__xss=14">`],
  ["comillas y ampersand", `a<b>c&d"e'f`],
];
const LISTA = [
  { id: UUID(1), nombre: "Admin Activo", correo: "admin-activo@example.test", telefono: "", rol: "admin", activo: true, esUsted: true },
  { id: UUID(103), nombre: "Persona 3", correo: "persona3@example.test", telefono: "", rol: "mecanico", activo: true, esUsted: false },
];

// ───────────────────────── utilidades de flujo ─────────────────────────
async function llenarPrompt(app, etiqueta, valor) {
  await esperarHasta(() => app.activo("modalPrompt") && app.$("#promptLabel").textContent === etiqueta, { desc: `prompt «${etiqueta}»` });
  app.$("#promptInput").value = valor; app.$("#btnPromptAceptar").click();
}
export async function dispararCamino(app, camino) {
  if (camino === "rol") { const s = app.$$(".u-rol")[0]; s.value = "cajero"; s.dispatchEvent(new app.win.Event("change", { bubbles: true })); }
  else if (camino === "baja") app.$$(".u-estado")[0].click();
  else if (camino === "editar") { app.$$(".u-editar")[0].click(); await llenarPrompt(app, "Nombre", "x"); await llenarPrompt(app, "Teléfono (puede quedar vacío)", "y"); }
}
const tablaLista = (app) => app.$$(".u-rol").length > 0 && !/Cargando/.test(app.$("#usuariosCuerpo")?.textContent || "");

/** Admin real, Usuarios abierto desde el menu real. `estado.resp` es lo que responde el api-server a cualquier PATCH/POST. */
export async function abrirUsuarios(B, { lista = LISTA, cuenta = B.M.CUENTAS.adminActivo } = {}) {
  const estado = { resp: { status: 200, body: {} } };
  const app = await B.abrirApp({ cuenta, servidor: (s) => { s.api = async (metodo) => (metodo === "GET" ? { status: 200, body: { usuarios: lista } } : estado.resp); } });
  igual(await B.esperarArranque(app), "shell", "la app debe arrancar como admin");
  app.$('.nav-item[data-view="usuarios"]').click();
  await esperarHasta(() => tablaLista(app), { desc: "tabla de usuarios" });
  return { app, estado };
}
/** Provoca un error del servidor con `payload` por el `camino` y describe lo que quedo en el DOM real. */
export async function observarToast(B, app, estado, camino, payload) {
  estado.resp = { status: 500, body: { error: payload } };
  const antes = B.contar(app.doc), nToasts = app.$$("#toastWrap .toast").length;
  app.win.__xss = 0;
  await dispararCamino(app, camino);
  const toast = await esperarHasta(() => { const t = app.$$("#toastWrap .toast"); return t.length > nToasts ? t[t.length - 1] : null; }, { desc: "toast de error" });
  await pausa(600);   // un onerror/onload ejecutaria en este margen
  const o = { xss: app.win.__xss, hijos: [...toast.children].map((c) => `${c.tagName}.${c.className}`), texto: toast.textContent, antes, despues: B.contar(app.doc) };
  if (camino === "rol") await esperarHasta(() => tablaLista(app), { desc: "tabla tras el error" });
  return o;
}
export function juzgarToast(nombre, p, o) {
  const f = [];
  if (o.xss !== 0) f.push(`${nombre}: EL CANARIO SE EJECUTO (window.__xss=${o.xss})`);
  if (JSON.stringify(o.hijos) !== JSON.stringify(["SPAN.dot off"])) f.push(`${nombre}: el toast tiene elementos inesperados ${JSON.stringify(o.hijos)}`);
  if (o.texto !== p) f.push(`${nombre}: el texto visible no es literal («${o.texto}»)`);
  if (JSON.stringify(o.antes) !== JSON.stringify(o.despues)) f.push(`${nombre}: aparecieron elementos img/svg/script/iframe/manejadores ${JSON.stringify(o.antes)} → ${JSON.stringify(o.despues)}`);
  return f;
}

export async function observarAjustes(B, sesion, { cuenta = null, almacenExtra = {} } = {}) {
  const app = await B.abrirApp({ cuenta, almacen: sesion ? { enti_session: sesion, ...almacenExtra } : almacenExtra });
  const est = await B.esperarArranque(app);
  await pausa(600);
  const el = app.$("#ajustesInfo");
  return { app, est, xss: app.win.__xss, hijos: el ? [...el.children].map((c) => c.tagName) : null, descendientes: el ? el.querySelectorAll("*").length : -1,
    texto: el ? el.textContent.replace(/\s+/g, " ").trim() : "", html: el ? el.innerHTML : "", rolPie: app.$("#loggedUserRole")?.textContent ?? null };
}
/** F-SEC-2 como DEFENSA EN PROFUNDIDAD: desde 4E-C4-FIX el portero ya rechaza un rol hostil en una sesion guardada, asi que se arranca como admin
 *  y se FUERZA currentUser con ese rol (sin pasar por el portero) antes de repintar Ajustes, para seguir probando el escape del sumidero. */
export async function observarAjustesInyectando(B, rol, nombre = "Persona Sintetica") {
  const app = await B.abrirApp({ cuenta: B.M.CUENTAS.adminActivo });
  const est = await B.esperarArranque(app); await pausa(300);
  app.win.__xss = 0;
  app.win.eval(`currentUser = ${JSON.stringify({ user: "usuario-sintetico", nombre, telefono: "", rol, origen: "local" })}`);
  await app.win.renderAjustes(); await pausa(600);
  const el = app.$("#ajustesInfo");
  return { app, est, xss: app.win.__xss, hijos: [...el.children].map((c) => c.tagName), descendientes: el.querySelectorAll("*").length, texto: el.textContent.replace(/\s+/g, " ").trim(), html: el.innerHTML,
    rolPie: app.$("#loggedUserRole")?.textContent ?? null };
}
/** OBS-3: como `opc` (cuenta o sesion guardada) abre Citas, siembra UNA cita, pulsa «eliminar» y devuelve el aviso y cuantas citas quedan. */
export async function eliminarCita(B, opc) {
  const app = await B.abrirApp(opc); igual(await B.esperarArranque(app), "shell", "la app debe arrancar"); await pausa(300);
  await app.win.eval(`DB.save("citas", { nombreTmp: "Cliente Sintetico", telefonoTmp: "", fecha: "2000-01-01", hora: "10:00", motivo: "revision", mecanico: "", mecanicoId: null, origen: "interna", recordatorioEnviado: false, creadoEn: Date.now() })`);
  app.$('.nav-item[data-view="citas"]').click();
  const btn = await esperarHasta(() => app.$$('[data-action="eliminar"]')[0], { desc: "boton eliminar" });
  const antes = app.$$("#toastWrap .toast").length; btn.click();
  const toast = await esperarHasta(() => { const t = app.$$("#toastWrap .toast"); return t.length > antes ? t[t.length - 1] : null; }, { desc: "aviso de eliminar" }); await pausa(300);
  const quedan = (await app.win.eval("DB.getAll('citas')")).length;
  const r = { aviso: toast.textContent, apagado: !!toast.querySelector(".dot.off"), quedan }; app.cerrar(); return r;
}
export function juzgarAjustes(nombre, p, o) {
  const f = [];
  if (o.est !== "shell") f.push(`${nombre}: la app no llego a la vista principal (estado «${o.est}»)`);
  if (o.xss !== 0) f.push(`${nombre}: EL CANARIO SE EJECUTO (window.__xss=${o.xss})`);
  if (JSON.stringify(o.hijos) !== JSON.stringify(["B", "BR"]) || o.descendientes !== 2) f.push(`${nombre}: #ajustesInfo tiene elementos inyectados ${JSON.stringify(o.hijos)} (${o.descendientes} descendientes)`);
  if (!o.texto.includes(`Usuario: Persona Sintetica (${p})`)) f.push(`${nombre}: el texto visible no conserva el rol («${o.texto}»)`);
  return f;
}
export const sesionLocal = (rol, extra = {}) => ({ user: "usuario-sintetico", nombre: "Persona Sintetica", telefono: "", rol, origen: "local", ...extra });

// ───────────────────────── F-FUNC-1: escenarios de la contraseña de recuperacion ─────────────────────────
export const put = (B, hacer) => { B.H.interceptor = (u, m) => (m === "PUT" && u.pathname === "/auth/v1/user" ? hacer() : undefined); };
export const resp = (cuerpo, status, statusText = "") => () => Promise.resolve(new Response(cuerpo, { status, statusText }));
export const json = (o, status) => resp(JSON.stringify(o), status);
export const ESC_RED = [
  { id: "net-sintetico", nombre: "NETWORK · Promise.reject(new TypeError(«Failed to fetch»))", clase: "red", preparar: (B) => put(B, () => Promise.reject(new TypeError("Failed to fetch"))) },
  { id: "net-real", nombre: "NETWORK · rechazo REAL del motor (fetch a un puerto sin nadie escuchando)", clase: "red", preparar: (B) => put(B, () => B.fallosNativos.red()) },
  { id: "to-sintetico", nombre: "TIMEOUT · AbortError (lo que produce pedir() al vencer su temporizador)", clase: "red", preparar: (B) => put(B, () => Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))) },
  { id: "to-real", nombre: "TIMEOUT · AbortError REAL del motor (fetch con la señal ya abortada)", clase: "red", preparar: (B) => put(B, () => B.fallosNativos.abortado()) },
  { id: "offline", nombre: "OFFLINE · navigator.onLine = false", clase: "red", despues: (app) => Object.defineProperty(app.win.navigator, "onLine", { configurable: true, get: () => false }) },
];
export const ESCENARIOS = [
  { id: "ok", nombre: "SUCCESS (200)", clase: "exito", preparar: () => {} },
  { id: "401", nombre: "401", clase: "enlace", preparar: (B) => put(B, json({ msg: "JWT expired" }, 401)) },
  { id: "403", nombre: "403", clase: "enlace", preparar: (B) => put(B, json({ msg: "Forbidden" }, 403)) },
  ...[400, 409, 422, 429, 500, 503].map((st) => ({ id: `http-${st}`, nombre: `HTTP ${st}`, clase: "http", mensaje: `mensaje-del-servidor-${st}`, preparar: (B) => put(B, json({ message: `mensaje-del-servidor-${st}` }, st)) })),
  { id: "http-500-xss", nombre: "HTTP 500 con marcado en el mensaje (img/onerror)", clase: "http", mensaje: '<img src=x onerror="window.__xss=31">', preparar: (B) => put(B, json({ message: '<img src=x onerror="window.__xss=31">' }, 500)) },
  ...ESC_RED,
  { id: "mal-html", nombre: "MALFORMED 500 · cuerpo HTML con marcado", clase: "malformada", preparar: (B) => put(B, resp('<html><img src=x onerror="window.__xss=32"></html>', 500, "Internal Server Error")) },
  { id: "mal-vacio", nombre: "MALFORMED 500 · cuerpo vacío", clase: "malformada", preparar: (B) => put(B, resp("", 500)) },
  { id: "mal-trunc", nombre: "MALFORMED 500 · JSON truncado", clase: "malformada", preparar: (B) => put(B, resp('{"message": "se cor', 500, "Internal Server Error")) },
];
export async function abrirRecuperacion(B) {
  const app = await B.abrirApp({ servidor: (s) => { s.__tok = s.emitirRecuperacion("persona-nueva@example.test"); }, hash: (s) => `#access_token=${s.__tok}&type=recovery&expires_in=3600` });
  const est = await B.esperarArranque(app); igual(est, "recuperacion", "debe mostrarse la pantalla de contraseña");
  await esperarHasta(() => app.$("#rcvForm"), { desc: "formulario de contraseña" });
  return app;
}
/** Escribe el canario en ambos campos y pulsa el boton REAL; espera al desenlace y describe lo que ve la persona. */
export async function enviarClave(B, app) {
  app.win.__xss = 0;
  app.$("#rcvClave").value = B.CANARIO; app.$("#rcvClave2").value = B.CANARIO;
  const btn = app.$("#rcvForm button[type=submit]"); btn.click();
  await esperarHasta(() => { const b = app.$("#rcvForm button[type=submit]"), e = app.$("#rcvError"); return !b || (b.textContent === "Establecer contraseña" && !b.disabled && e && e.textContent !== ""); }, { desc: "desenlace del envio" });
  await pausa(500);
  const b = app.$("#rcvForm button[type=submit]");
  return { error: app.$("#rcvError") ? app.$("#rcvError").textContent : null, cuerpo: app.$("#rcvCuerpo").textContent.replace(/\s+/g, " ").trim(), hayFormulario: !!app.$("#rcvForm"),
    boton: b ? { texto: b.textContent, deshabilitado: b.disabled } : null, campos: b ? [app.$("#rcvClave").value, app.$("#rcvClave2").value] : null, xss: app.win.__xss,
    elementosNuevos: app.$$("#rcvError *").length };
}
const COMPLETAR = (B, app, e) => { e.canario = B.buscarCanario(app); return e; };

// ───────────────────────── la suite ─────────────────────────
export async function correr(ctx) {
  const B = crearBanco(ctx); const { M, caso } = B; const taller = ctx.modo === "taller";
  const C = M.CUENTAS;
  const basesTaller = async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => /^entimotors_os_demo/.test(n));

  // ══ 0 · CONTROLES: el detector de «canario» funciona en este motor ══
  await caso("CONTROL · el detector funciona en este motor: img/onerror SÍ ejecuta si se inyecta sin escapar (svg/onload se registra por motor); <script> por innerHTML queda inerte", async () => {
    const app = await B.abrirApp({}); await B.esperarArranque(app); const r = {};
    for (const [n, html, marca] of [["img/onerror", '<img src=x onerror="window.__xss=91">', 91], ["svg/onload", '<svg onload="window.__xss=92">', 92], ["script", "<script>window.__xss=93</script>", 93]]) {
      app.win.__xss = 0; const d = app.doc.createElement("div"); app.doc.body.appendChild(d); d.innerHTML = html; await pausa(700);
      r[n] = app.win.__xss === marca ? "EJECUTA" : "inerte"; d.remove();
    }
    igual(r["img/onerror"], "EJECUTA", "el detector no detecta un img/onerror: la prueba no seria concluyente"); igual(r.script, "inerte", "<script> por innerHTML no debe ejecutar");
    return { canarioPorMotor: r };
  }, { grupo: "control" });

  await caso("CONTROL · la captura de errores de consola funciona: console.error, excepción no capturada y promesa rechazada se ven y se clasifican como EXPECTED_MOCK_ERROR (deliberados)", async () => {
    const app = await B.abrirApp({}); await B.esperarArranque(app);
    // el codigo se crea DENTRO del iframe (su realm), como el de la app: asi los errores se reportan a la ventana de la app
    app.win.eval(`console.error("control-consola: console.error deliberado");
      setTimeout(function () { throw new Error("control-consola: excepcion deliberada"); }, 0);
      Promise.reject(new Error("control-consola: promesa rechazada deliberada"));`);
    await pausa(500); const tipos = B.H.errores.map((e) => e.tipo).sort();
    mismo(tipos, ["console.error", "onerror", "unhandledrejection"], "el detector debe ver los tres tipos"); return { capturados: tipos };
  }, { grupo: "control", esperados: [/control-consola/] });

  await caso("CONTROL · la RED está cerrada: un fetch, un XHR, un WebSocket y un sendBeacon a un host externo se RECHAZAN y se anotan como UNEXPECTED_EXTERNAL_REQUEST (aquí deliberado)", async () => {
    const app = await B.abrirApp({}); await B.esperarArranque(app); const w = app.win;
    let f1 = "no rechazo"; try { await w.fetch("https://externo.invalid/x"); } catch (e) { f1 = "rechazado"; }
    let f2 = "no rechazo"; try { const x = new w.XMLHttpRequest(); x.open("GET", "https://externo.invalid/x"); } catch (e) { f2 = "rechazado"; }
    let f3 = "no rechazo"; try { new w.WebSocket("wss://externo.invalid/x"); } catch (e) { f3 = "rechazado"; }
    const f4 = w.navigator.sendBeacon("https://externo.invalid/x", "x");
    mismo([f1, f2, f3, f4], ["rechazado", "rechazado", "rechazado", false], "toda salida externa debe rechazarse");
    const vias = B.H.externos.map((e) => e.via).sort(); mismo(vias, ["WebSocket", "fetch", "sendBeacon", "xhr"], "las cuatro deben anotarse");
    B.H.externos.length = 0;   // deliberadas: no cuentan como fallo de este caso
    return { bloqueadas: 4 };
  }, { grupo: "control" });

  await caso("INTEGRIDAD · los archivos de runtime que recibe el navegador son BYTE A BYTE los del repositorio (solo index.html y supabase-config.js se sustituyen en memoria, y se indica cuáles)", async () => {
    const archivos = ["app.js", "auth.js", "usuarios.js", "recovery.js", "build-target.js", "supabase-client.js", "sw.js", "manifest.json"];
    const sha = async (b) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const r = {}; for (const f of archivos) r[f] = await sha(await (await fetch(`/${f}`, { cache: "no-store" })).arrayBuffer());
    return { sha: r, sustituidosEnMemoria: ["index.html (prelude + Chart.js local vacio)", "supabase-config.js (configuracion sintetica)"] };
  }, { grupo: "integridad" });

  await caso("ENTORNO · IndexedDB, localStorage, sessionStorage, fetch, CacheStorage y Service Worker existen en este motor; la app arranca sin la pantalla «instalar»", async () => {
    const app = await B.abrirApp({}); const est = await B.esperarArranque(app); const w = app.win;
    const caps = { indexedDB: !!w.indexedDB, localStorage: !!w.localStorage, sessionStorage: !!w.sessionStorage, fetch: typeof w.fetch === "function", cacheStorage: !!w.caches, serviceWorker: "serviceWorker" in navigator, databases: typeof indexedDB.databases === "function" };
    for (const [k, v] of Object.entries(caps)) ok(v, `falta ${k}`);
    igual(est, "login", "sin sesion debe verse el login");
    igual(app.activo("gateInstall"), false, "la pantalla «instalar» no debe verse (bypass propio del codigo)");
    return { capacidades: caps, registroSW: B.H.swRegistros };
  }, { grupo: "entorno" });

  await caso("MOTOR · rechazos REALES de fetch: el texto propio de cada motor (la app los clasifica por tipo, no por texto)", async () => {
    const r = {};
    for (const [n, f] of [["red", B.fallosNativos.red], ["abortado", B.fallosNativos.abortado]]) { try { await f(); r[n] = "no fallo"; } catch (e) { r[n] = `${e.name}: ${e.message}`; } }
    ok(r.red.startsWith("TypeError") && r.abortado.startsWith("AbortError"), JSON.stringify(r)); return { mensajesNativos: r };
  }, { grupo: "entorno" });

  await caso("INDEXEDDB · abre, crea sus almacenes y lee/escribe en ambos motores (base sintetica aparte)", async () => {
    const abrir = (n) => new Promise((res, rej) => { const r = indexedDB.open(n, 1); r.onupgradeneeded = () => r.result.createObjectStore("s", { keyPath: "id" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const db = await abrir("qa-sintetica");
    await new Promise((res, rej) => { const t = db.transaction("s", "readwrite"); t.objectStore("s").put({ id: 1, v: "x" }); t.oncomplete = res; t.onerror = () => rej(t.error); });
    const v = await new Promise((res) => { const q = db.transaction("s").objectStore("s").get(1); q.onsuccess = () => res(q.result); });
    db.close(); await new Promise((res) => { const r = indexedDB.deleteDatabase("qa-sintetica"); r.onsuccess = r.onerror = r.onblocked = res; });
    igual(v && v.v, "x"); return { lecturaEscritura: "ok" };
  }, { grupo: "indexeddb" });

  // ══ H · F-SEC-1 (usuarios.js) en DOM real ══
  if (taller) {
    for (const [camino, etiqueta] of [["rol", "cambiar el rol"], ["baja", "dar de baja / reactivar"], ["editar", "editar nombre y teléfono"]]) {
      await caso(`F-SEC-1 · ${etiqueta}: img/onerror, svg/onload, script y variante de C3 → el canario NO se ejecuta y no se inyecta ningún elemento`, async () => {
        const { app, estado } = await abrirUsuarios(B); const fallas = []; let ejecutados = 0, inyectados = 0;
        for (const [n, p] of P_ERROR) {
          const o = await observarToast(B, app, estado, camino, p);
          if (o.xss !== 0) ejecutados++; if (JSON.stringify(o.antes) !== JSON.stringify(o.despues) || o.hijos.length !== 1) inyectados++;
          fallas.push(...juzgarToast(n, p, o));
        }
        if (fallas.length) throw new Error(fallas.join(" | "));
        return { payloads: P_ERROR.length, canarioEjecutado: ejecutados, marcadoInyectado: inyectados };
      }, { grupo: "F-SEC-1" });
    }
    await caso("F-SEC-1 · contraste: la caja «Nuevo usuario» (camino HTML) recibe el mismo texto escapado: solo un <p>, texto literal, sin ejecución", async () => {
      const { app, estado } = await abrirUsuarios(B); const fallas = [];
      for (const [n, p] of P_ERROR) {
        estado.resp = { status: 500, body: { error: p } }; app.win.__xss = 0;
        if (!app.$("#cardNuevoUsuario") || app.$("#cardNuevoUsuario").style.display === "none") app.$("#btnNuevoUsuario").click();
        app.$("#nuNombre").value = "Persona"; app.$("#nuCorreo").value = "nueva@example.test"; app.$("#btnCrearUsuario").click();
        await esperarHasta(() => app.$("#nuResultado").children.length > 0, { desc: "resultado de crear" }); await pausa(500);
        const caja = app.$("#nuResultado");
        if (app.win.__xss !== 0) fallas.push(`${n}: canario ejecutado`);
        if (JSON.stringify([...caja.children].map((c) => c.tagName)) !== '["P"]' || caja.querySelectorAll("*").length !== 1) fallas.push(`${n}: la caja tiene elementos ajenos`);
        if (caja.textContent !== p) fallas.push(`${n}: texto no literal`);
        caja.textContent = "";
      }
      if (fallas.length) throw new Error(fallas.join(" | "));
    }, { grupo: "F-SEC-1" });
  }

  // ══ I · F-SEC-2 (currentUser.rol → #ajustesInfo) en DOM real ══
  if (taller) {
    await caso("F-SEC-2 (defensa en profundidad) · currentUser FORZADO con un rol hostil (img/onerror, svg/onload, script, variante de C3, comillas/ampersand): #ajustesInfo solo tiene su <b> y su <br>, el canario NO se ejecuta y el rol se lee tal cual", async () => {
      const fallas = []; let ejecutados = 0, inyectados = 0, alcance = null;
      for (const [n, p] of P_ROL) {
        const o = await observarAjustesInyectando(B, p); if (o.xss !== 0) ejecutados++; if (o.descendientes !== 2) inyectados++;
        fallas.push(...juzgarAjustes(n, p, o));
        if (n === "img/onerror") alcance = { via: "currentUser forzado (el portero ya no deja llegar un rol hostil por sesion guardada)", showViewAjustesConRolDesconocido: o.app.win.showView("ajustes") ? "permitido" : "negado por puedeVerVista" };
        o.app.cerrar();
      }
      if (fallas.length) throw new Error(fallas.join(" | "));
      return { payloads: P_ROL.length, canarioEjecutado: ejecutados, marcadoInyectado: inyectados, alcance };
    }, { grupo: "F-SEC-2" });

    const NORMALES = [["admin", "administrador", { cuenta: C.adminActivo }, "Admin Activo"], ["mecanico", "mecánico", { sesion: sesionLocal("mecanico") }, "Persona Sintetica"],
      ["cajero", "cajero", { cuenta: C.cajeroActivo }, "Cajero Activo"], ["desarrollador", "desarrollador", { inyectar: true }, "Persona Sintetica"]];   // el desarrollador ya no arranca el taller ni con sesion guardada: se fuerza currentUser
    await caso("F-SEC-2 · roles normales (admin, mecánico, cajero, desarrollador): #ajustesInfo se pinta EXACTAMENTE como antes «Usuario: <b>nombre</b> (etiqueta)<br>…»", async () => {
      const vistos = {};
      for (const [rol, etiqueta, opc, nombre] of NORMALES) {
        const o = opc.inyectar ? await observarAjustesInyectando(B, rol) : await observarAjustes(B, opc.sesion || null, { cuenta: opc.cuenta || null });
        igual(o.est, "shell", `${rol}: arranque`); igual(o.xss, 0, `${rol}: canario`); mismo(o.hijos, ["B", "BR"], `${rol}: hijos`);
        ok(new RegExp(`^\\s*Usuario: <b>${nombre}</b> \\(${etiqueta}\\)<br>\\s*Este dispositivo arrancó en blanco · \\d+ registros guardados en total\\.\\s*$`).test(o.html), `${rol}: HTML distinto del de antes: ${o.html.replace(/\s+/g, " ")}`);
        vistos[rol] = o.texto;
        if (rol === "admin") {   // navegacion REAL a Ajustes con el menu: la vista se abre y vuelve a pintar lo mismo
          o.app.$('.nav-item[data-view="ajustes"]').click(); await pausa(500);
          ok(o.app.activo("view-ajustes"), "admin: la vista Ajustes debe abrirse"); mismo([...o.app.$("#ajustesInfo").children].map((c) => c.tagName), ["B", "BR"], "admin: hijos tras navegar"); igual(o.app.win.__xss, 0);
        }
        o.app.cerrar();
      }
      return { vistos };
    }, { grupo: "F-SEC-2" });
  }

  // ══ ROL DESCONOCIDO (4E-C4-FIX): el portero falla cerrado con una sesion GUARDADA que trae un rol raro ══
  const ROLES_RAROS = [["«superadmin»", "superadmin"], ["«foo»", "foo"], ["cadena vacia", ""], ["numero 7", 7], ["objeto {}", {}], ["arreglo []", []], ["arreglo ['admin']", ["admin"]], ["img/onerror", P_ROL[0][1]]];
  await caso(`ROL DESCONOCIDO · ${taller ? "TALLER" : "MI TRABAJO"}: una sesión GUARDADA con un rol raro (superadmin, foo, vacío, número, objeto, arreglo, marcado) FALLA CERRADO: se ve el login con el aviso, no se abre ninguna base, se descarta enti_session, el canario no se ejecuta`, async () => {
    const vistos = {};
    for (const [n, rol] of ROLES_RAROS) {
      const sesion = taller ? sesionLocal(rol) : { ...sesionLocal(rol), origen: "supabase", perfilId: UUID(3), activo: true };
      const app = await B.abrirApp({ almacen: { enti_session: sesion } }); const est = await B.esperarArranque(app); await pausa(500);
      igual(est, "login", `${n}: debe verse el login`); igual(app.activo("shell"), false, `${n}: la app NO debe abrirse`); mismo(await basesTaller(), [], `${n}: no debe abrirse ninguna base`);
      igual(localStorage.getItem("enti_session"), null, `${n}: debe descartarse enti_session`); igual(app.win.__xss, 0, `${n}: canario`); igual((app.$("#ajustesInfo")?.innerHTML || "").trim(), "", `${n}: Ajustes no debe pintarse`);
      const msg = app.$("#loginError").textContent.trim(); ok(msg.length > 0, `${n}: debe explicarse el rechazo`);
      if (taller && rol !== "") igual(msg, "Tu rol no tiene acceso a ENTIMOTORS Taller.", `${n}: mensaje`);
      vistos[n] = msg; app.cerrar();
    }
    return { vistos };
  }, { grupo: "ROL DESCONOCIDO" });
  if (taller) await caso("ROL DESCONOCIDO · TALLER: el desarrollador con sesión guardada TAMPOCO abre el taller (cuenta técnica); admin, cajero y mecánico local siguen entrando", async () => {
    const dev = await B.abrirApp({ almacen: { enti_session: sesionLocal("desarrollador") } }); igual(await B.esperarArranque(dev), "login"); igual(dev.activo("shell"), false); mismo(await basesTaller(), []);
    const msg = dev.$("#loginError").textContent.trim(); igual(msg, "Cuenta técnica: no abre el taller. Usa el panel técnico."); dev.cerrar();
    const entran = {}; for (const rol of ["admin", "cajero", "mecanico"]) { const app = await B.abrirApp({ almacen: { enti_session: sesionLocal(rol) } }); igual(await B.esperarArranque(app), "shell", `${rol} debe seguir entrando`); entran[rol] = "shell"; app.cerrar(); }
    return { desarrolladorDenegado: msg, siguenEntrando: entran };
  }, { grupo: "ROL DESCONOCIDO" });

  // ══ J · F-FUNC-1 (recuperacion de contraseña) con fetch del navegador ══
  if (taller) for (const sc of ESCENARIOS) {
    await caso(`F-FUNC-1 · ${sc.nombre}`, async () => {
      const app = await abrirRecuperacion(B);
      if (sc.preparar) sc.preparar(B); if (sc.despues) sc.despues(app);
      const e = COMPLETAR(B, app, await enviarClave(B, app)); const fallas = [];
      if (e.xss !== 0) fallas.push(`CANARIO EJECUTADO (window.__xss=${e.xss})`);
      if (e.elementosNuevos) fallas.push(`elementos nuevos en #rcvError: ${e.elementosNuevos}`);
      if (Object.values(e.canario).some((v) => v === "PRESENTE")) fallas.push(`contraseña PRESENTE en ${Object.entries(e.canario).filter(([, v]) => v === "PRESENTE").map(([k]) => k).join(",")}`);
      if (sc.clase === "exito") { if (!/Contraseña establecida correctamente\./.test(e.cuerpo)) fallas.push(`sin confirmacion: «${e.cuerpo}»`); }
      else if (sc.clase === "enlace") { if (!/Enlace no válido o expirado/.test(e.cuerpo)) fallas.push(`sin pantalla de enlace no valido: «${e.cuerpo}»`); if (e.error === AVISO_RED) fallas.push("un 401/403 se presento como fallo de red"); }
      else {
        if (!e.hayFormulario) fallas.push("el formulario desaparecio: no se puede reintentar");
        if (!e.boton || e.boton.texto !== "Establecer contraseña" || e.boton.deshabilitado) fallas.push(`boton no restaurado: ${JSON.stringify(e.boton)}`);
        if (!e.campos || e.campos.some((c) => c !== "")) fallas.push("los campos de contraseña no quedaron vacios");
        if (sc.clase === "red") { if (e.error !== AVISO_RED) fallas.push(`aviso «${e.error}» en vez de «${AVISO_RED}»`); }
        else if (sc.clase === "http") { if (e.error === AVISO_RED) fallas.push("un HTTP real se presento como fallo de red"); if (e.error !== sc.mensaje) fallas.push(`mensaje visible «${e.error}» ≠ el del servidor`); }
        else if (sc.clase === "malformada") { if (!e.error || e.error === AVISO_RED) fallas.push(`mensaje no seguro/legible: «${e.error}»`); if (/undefined|\bnull\b|<|>/.test(e.error || "")) fallas.push(`mensaje con basura/marcado: «${e.error}»`); }
      }
      if (fallas.length) throw new Error(fallas.join(" | "));
      return { clase: sc.clase, mensajeVisible: sc.clase === "exito" || sc.clase === "enlace" ? e.cuerpo.slice(0, 60) : e.error, boton: e.boton, canario: e.canario };
    }, { grupo: "F-FUNC-1" });
  }
  if (taller) {
    await caso("OBS-4 CERRADO · un HTTP 200 que no trae un usuario (HTML, vacío, null, arreglo, JSON truncado) NO es éxito: mensaje seguro, formulario utilizable; un 200 con objeto sí lo es", async () => {
      const GENERICO = "No se pudo establecer la contraseña."; const vistos = {};
      for (const [n, cuerpoHttp] of [["HTML (portal cautivo)", "<html>portal cautivo</html>"], ["vacío", ""], ["null", "null"], ["arreglo []", "[]"], ["JSON truncado", '{"id": "0000000']]) {
        const app = await abrirRecuperacion(B); put(B, resp(cuerpoHttp, 200)); const e = COMPLETAR(B, app, await enviarClave(B, app)); const fallas = [];
        if (/Contraseña establecida correctamente\./.test(e.cuerpo)) fallas.push("se dio por establecida");
        if (e.error !== GENERICO) fallas.push(`mensaje «${e.error}»`); if (!e.hayFormulario) fallas.push("sin formulario");
        if (!e.boton || e.boton.texto !== "Establecer contraseña" || e.boton.deshabilitado) fallas.push("boton no restaurado"); if (!e.campos || e.campos.some((c) => c !== "")) fallas.push("campos no vacios");
        if (e.xss !== 0) fallas.push("canario ejecutado"); if (Object.values(e.canario).some((v) => v === "PRESENTE")) fallas.push("contraseña presente");
        if (fallas.length) throw new Error(`${n}: ${fallas.join(", ")}`); vistos[n] = "rechazado con mensaje seguro"; app.cerrar();
      }
      const ok200 = await abrirRecuperacion(B); put(B, json({ id: "00000000-0000-4000-8000-000000000099", email: "persona-nueva@example.test" }, 200)); const e2 = await enviarClave(B, ok200);
      ok(/Contraseña establecida correctamente\./.test(e2.cuerpo), "un 200 con objeto debe seguir siendo exito");
      return { OBS4: "CERRADO", vistos, exitoConObjeto: "PASS" };
    }, { grupo: "OBS" });
    await caso("OBS-5 CERRADO · el texto de error se toma de message, msg, error_description o error (primera CADENA no vacía); un objeto anidado da el mensaje genérico, NUNCA «[object Object]»", async () => {
      const GENERICO = "No se pudo establecer la contraseña."; const vistos = {};
      for (const [n, cuerpoE, esperado] of [["error objeto anidado {error:{mensaje:'fallo'}}", { error: { mensaje: "fallo" } }, GENERICO], ["message (cadena)", { message: "texto-message" }, "texto-message"], ["msg (cadena)", { msg: "texto-msg" }, "texto-msg"],
        ["error_description (cadena)", { error_description: "texto-ed" }, "texto-ed"], ["error (cadena)", { error: "texto-error" }, "texto-error"], ["message objeto → siguiente candidato (msg)", { message: { a: 1 }, msg: "texto-msg2" }, "texto-msg2"]]) {
        const app = await abrirRecuperacion(B); put(B, json(cuerpoE, 500)); const e = COMPLETAR(B, app, await enviarClave(B, app));
        igual(e.error, esperado, n); ok(!/\[object/.test(e.error), `${n}: «[object Object]»`); igual(e.xss, 0, `${n}: canario`); igual(e.elementosNuevos, 0, `${n}: elementos dentro de #rcvError`); ok(e.hayFormulario, `${n}: formulario`);
        vistos[n] = e.error; app.cerrar();
      }
      return { OBS5: "CERRADO", vistos };
    }, { grupo: "OBS" });
  }

  // ══ L · AUTH con el formulario de login REAL ══
  const CASOS_AUTH = taller ? [
    { id: "sin-sesion", nombre: "sin sesión", esperado: "login" },
    { id: "adminActivo", nombre: "admin activo", cuenta: C.adminActivo, esperado: "shell", rol: "administrador" },
    { id: "adminInactivo", nombre: "admin inactivo (activo=false)", cuenta: C.adminInactivo, esperado: "denegado", texto: /dada de baja/ },
    { id: "mecanicoActivo", nombre: "mecánico activo (en el TALLER)", cuenta: C.mecanicoActivo, esperado: "denegado", texto: /Mi Trabajo/ },
    { id: "mecanicoInactivo", nombre: "mecánico inactivo (activo=false)", cuenta: C.mecanicoInactivo, esperado: "denegado", texto: /dada de baja/ },
    { id: "cajeroActivo", nombre: "cajero activo", cuenta: C.cajeroActivo, esperado: "shell", rol: "cajero" },
    { id: "cajeroInactivo", nombre: "cajero inactivo (activo=false)", cuenta: C.cajeroInactivo, esperado: "denegado", texto: /dada de baja/ },
    { id: "desarrollador", nombre: "desarrollador (cuenta técnica)", cuenta: C.desarrollador, esperado: "denegado", texto: /Cuenta técnica/ },
    { id: "sinPerfil", nombre: "sin perfil", cuenta: C.sinPerfil, esperado: "denegado", texto: /no tiene perfil/ },
    { id: "error", nombre: "error de Supabase (HTTP 500 al leer el perfil)", cuenta: C.adminActivo, servidor: (s) => { s.perfilesHttp = 500; }, esperado: "denegado", texto: /.+/ },
    { id: "rolDesconocido", nombre: "rol desconocido («superadmin», activo): FAIL-CLOSED", cuenta: C.rolDesconocido, esperado: "denegado", texto: /Tu rol no tiene acceso a ENTIMOTORS Taller/ },
  ] : [
    { id: "sin-sesion", nombre: "sin sesión", esperado: "login" },
    { id: "mecanicoActivo", nombre: "mecánico activo", cuenta: C.mecanicoActivo, esperado: "shell", rol: "mecánico" },
    { id: "mecanicoInactivo", nombre: "mecánico inactivo (activo=false)", cuenta: C.mecanicoInactivo, esperado: "denegado", texto: /dada de baja/ },
    { id: "adminActivo", nombre: "admin activo (cuenta del TALLER)", cuenta: C.adminActivo, esperado: "denegado", texto: /Taller/ },
    { id: "cajeroActivo", nombre: "cajero activo", cuenta: C.cajeroActivo, esperado: "denegado", texto: /Taller/ },
    { id: "desarrollador", nombre: "desarrollador", cuenta: C.desarrollador, esperado: "denegado", texto: /.+/ },
    { id: "sinPerfil", nombre: "sin perfil", cuenta: C.sinPerfil, esperado: "denegado", texto: /no tiene perfil/ },
    { id: "error", nombre: "error de Supabase (HTTP 500 al leer el perfil)", cuenta: C.mecanicoActivo, servidor: (s) => { s.perfilesHttp = 500; }, esperado: "denegado", texto: /.+/ },
    { id: "rolDesconocido", nombre: "rol desconocido («superadmin»)", cuenta: C.rolDesconocido, esperado: "denegado", texto: /.+/ },
  ];
  for (const sc of CASOS_AUTH) {
    await caso(`AUTH · ${sc.nombre}`, async () => {
      const app = await B.abrirApp({ servidor: (s) => { if (sc.servidor) sc.servidor(s); } });
      igual(await B.esperarArranque(app), "login", "sin sesion guardada se ve el login");
      if (sc.id === "sin-sesion") { igual(app.activo("shell"), false); mismo(await basesTaller(), [], "sin sesion no se abre ninguna base"); return { estado: "login" }; }
      app.$("#loginUser").value = sc.cuenta.correo; app.$("#loginPass").value = sc.cuenta.clave;
      app.$("#loginForm button[type=submit]").click();
      await esperarHasta(() => app.activo("shell") || app.$("#loginError").textContent.trim() !== "" || app.$("#loginError").innerHTML.trim() !== "", { desc: "resultado del login" });
      await pausa(700);
      const shell = app.activo("shell"), msg = app.$("#loginError").textContent.trim(), bases = await basesTaller(), guardada = localStorage.getItem("enti_session");
      const dbg = { shell, mensaje: msg, bases, rolPie: app.$("#loggedUserRole")?.textContent ?? null };
      if (sc.esperado === "shell") { ok(shell, `debia entrar: ${JSON.stringify(dbg)}`); ok(bases.length === 1, `debia abrir UNA base: ${bases}`); if (sc.rol) ok((app.$("#loggedUserRole").textContent || "").startsWith(sc.rol), `rol visible «${app.$("#loggedUserRole").textContent}»`); }
      else if (sc.esperado === "denegado") {
        ok(!shell, `FAIL-CLOSED: la app se abrio: ${JSON.stringify(dbg)}`); mismo(bases, [], "FAIL-CLOSED: no debe abrirse ninguna base"); ok(!guardada, "no debe quedar enti_session");
        ok(sc.texto.test(msg) && msg.length > 0, `mensaje inesperado «${msg}»`);
      } else if (sc.esperado === "actual") { return { UNKNOWN_ROLE_CURRENT_BEHAVIOR: shell ? "ADMITIDO: entra al taller (rol «superadmin»)" : `DENEGADO: «${msg}»`, ...dbg }; }
      return dbg;
    }, { grupo: "AUTH" });
  }
  await caso("AUTH · activo=false con SESIÓN GUARDADA en el arranque: se cierra la sesión, se vuelve al login y no se abre ninguna base", async () => {
    const c = C.adminInactivo;
    const app = await B.abrirApp({ cuenta: c, almacen: { enti_session: { user: c.correo, uid: c.uid, perfilId: c.uid, nombre: "Admin Inactivo", telefono: "", rol: "admin", origen: "supabase", activo: true } } });
    const est = await B.esperarArranque(app); await pausa(500);
    igual(est, "login"); igual(app.activo("shell"), false); mismo(await basesTaller(), []); igual(localStorage.getItem("enti_session"), null, "debe descartarse enti_session");
    return { mensaje: app.$("#loginError").textContent.trim() };
  }, { grupo: "AUTH" });
  await caso(`AUTH · login LOCAL por usuario (sin correo): ${taller ? "sin config-local.js queda deshabilitado" : "en «Mi Trabajo» se rechaza ANTES de mirar la lista TEAM"}`, async () => {
    const app = await B.abrirApp({}); await B.esperarArranque(app);
    app.$("#loginUser").value = "wilkin"; app.$("#loginPass").value = "cualquier-cosa"; app.$("#loginForm button[type=submit]").click();
    await esperarHasta(() => app.$("#loginError").textContent.trim() !== "", { desc: "mensaje" }); await pausa(300);
    igual(app.activo("shell"), false); mismo(await basesTaller(), []);
    const msg = app.$("#loginError").textContent.trim(); ok(taller ? msg === "Usuario o contraseña incorrectos." : /solo con tu correo/.test(msg), `mensaje «${msg}»`);
    return { mensaje: msg };
  }, { grupo: "AUTH" });

  if (!taller) {
    await caso("MI TRABAJO · mecánico activo: vista «Mi Trabajo», base propia por perfil (nunca la del taller), sin acceso a vistas de gestión", async () => {
      const app = await B.abrirApp({ cuenta: C.mecanicoActivo }); igual(await B.esperarArranque(app), "shell"); await pausa(400);
      ok(app.activo("view-mi-trabajo"), "debe verse Mi Trabajo"); const bases = await basesTaller();
      mismo(bases, [`entimotors_os_demo_mec_${C.mecanicoActivo.uid}`], "solo la base del propio perfil");
      const visibles = app.$$(".nav-item[data-view]").filter((b) => b.style.display !== "none").map((b) => b.dataset.view);
      mismo(visibles, ["mi-trabajo"], "solo Mi Trabajo en el menu");
      igual(app.win.showView("finanzas"), false, "showView('finanzas') debe negarse");
      // 4E-C4-FIX: la limitacion es VISIBLE dentro de la app y nada promete trabajo asignado
      const NOTA = "La asignación y sincronización de trabajos entre dispositivos estará disponible en una versión posterior.";
      const nota = app.$("#miTrabajoAlcance"); ok(nota && nota.textContent.trim() === NOTA, `nota de alcance: «${nota && nota.textContent.trim()}»`);
      ok(app.win.getComputedStyle(nota).display !== "none" && nota.getClientRects().length > 0, "la nota debe estar VISIBLE (dentro de la vista activa)");
      igual(app.$("#miTrabajoSub").textContent, `${C.mecanicoActivo.perfil.nombre} · acceso para mecánicos.`);
      igual(app.$("#miTrabajoCitas").textContent.trim(), "No hay citas en este dispositivo."); igual(app.$("#miTrabajoOrdenes").textContent.trim(), "No hay órdenes abiertas en este dispositivo."); igual(app.$("#miTrabajoHistorial").textContent.trim(), "Todavía no hay trabajos entregados en este dispositivo.");
      ok(!/asignad/i.test(app.$("#view-mi-trabajo").textContent), "la vista no debe hablar de trabajo asignado");
      return { menuVisible: visibles, bases, registroSW: B.H.swRegistros, notaVisible: "SI", subtitulo: app.$("#miTrabajoSub").textContent };
    }, { grupo: "MI TRABAJO" });
    await caso("MI TRABAJO · el build NO trae panel técnico ni config-local, y su manifest/producto son los de mecánicos", async () => {
      const app = await B.abrirApp({}); await B.esperarArranque(app);
      const r = {}; for (const f of ["panel-tecnico.html", "config-local.js", "hacer-build-mecanicos.sh", "supabase/entimotors-usuarios.sql"]) r[f] = (await fetch(`/${f}`)).status;
      for (const [f, st] of Object.entries(r)) igual(st, 404, `${f} no debe servirse`);
      const bt = await (await fetch("/build-target.js")).text(); ok(/producto:\s*"mecanico"/.test(bt), "build-target.js debe declarar mecanico");
      const man = await (await fetch("/manifest.json")).json(); igual(man.description, "Acceso para mecánicos — ENTIMOTORS", "el manifest no debe prometer trabajo asignado");
      ok(!app.doc.querySelector('script[src^="config-local"]'), "index.html no debe referenciar config-local.js");
      return { estados: r, manifest: man.name, descripcion: man.description };
    }, { grupo: "MI TRABAJO" });
  }

  // ══ OBS-3 (4E-C4-FIX): eliminar una cita es SOLO del administrador, en la UI real ══
  if (taller) await caso("OBS-3 CERRADO · eliminar una cita en la UI real: el ADMIN la borra; el cajero y el mecánico local se BLOQUEAN con el aviso y la cita sigue ahí", async () => {
    const vistos = {};
    for (const [rol, opc, borra] of [["admin", { cuenta: C.adminActivo }, true], ["cajero", { cuenta: C.cajeroActivo }, false], ["mecanico local", { almacen: { enti_session: sesionLocal("mecanico") } }, false]]) {
      const r = await eliminarCita(B, opc);
      if (borra) { ok(/^Cita eliminada/.test(r.aviso), `${rol}: «${r.aviso}»`); igual(r.quedan, 0, `${rol}: la cita debe borrarse`); }
      else { igual(r.aviso, "Solo el administrador elimina una cita", `${rol}: aviso`); ok(r.apagado, `${rol}: aviso «off»`); igual(r.quedan, 1, `${rol}: la cita NO debe borrarse`); }
      vistos[rol] = borra ? "borra" : "DENEGADO";
    }
    return { vistos };
  }, { grupo: "OBS" });

  // ══ M · USUARIOS ══
  if (taller) {
    await caso("USUARIOS · admin: abre la superficie desde el menú, ve la lista y las acciones reales (rol, baja, editar, nuevo)", async () => {
      const { app } = await abrirUsuarios(B);
      ok(app.activo("view-usuarios"), "la vista debe estar activa"); igual(app.$$("#usuariosCuerpo tbody tr").length, 2, "filas");
      const desc = app.$("#view-usuarios .view-head p").textContent; ok(!/Los permisos los aplica el servidor/.test(desc), "el texto no debe sobreafirmar"); ok(/Las cuentas las protege el servidor/.test(desc) && /datos de este dispositivo/.test(desc) && /aplicación/.test(desc), `texto de la pantalla: «${desc}»`);
      igual(app.$$(".u-rol").length, 1); igual(app.$$(".u-estado").length, 1); igual(app.$$(".u-editar").length, 1); ok(app.$("#btnNuevoUsuario"), "boton nuevo");
      return { filas: 2 };
    }, { grupo: "USUARIOS" });
    await caso("USUARIOS · acciones con éxito (cambiar rol, dar de baja, editar): aviso «on», y el api-server recibe PATCH /api/admin/usuarios/<id> con el cuerpo y la sesión correctos", async () => {
      const { app, estado } = await abrirUsuarios(B); const vistos = {};
      for (const [camino, texto, cuerpo] of [["rol", "Rol actualizado", { rol: "cajero" }], ["baja", "Usuario dado de baja", { activo: false }], ["editar", "Datos actualizados", { nombre: "x", telefono: "y" }]]) {
        estado.resp = { status: 200, body: {} }; const n = app.$$("#toastWrap .toast").length; const l0 = B.H.servidor.llamadas.length;
        await dispararCamino(app, camino);
        const t = await esperarHasta(() => { const x = app.$$("#toastWrap .toast"); return x.length > n ? x[x.length - 1] : null; }, { desc: `aviso de ${camino}` });
        igual(t.textContent, texto); ok(t.querySelector(".dot.on"), "el aviso de exito debe ser «on»");
        const p = B.H.servidor.llamadas.slice(l0).find((l) => l.host === "api" && l.metodo === "PATCH"); ok(p, "debe haber un PATCH");
        igual(p.ruta, `/api/admin/usuarios/${UUID(103)}`); mismo(p.cuerpo, cuerpo, "cuerpo del PATCH"); igual(p.auth, "sesion", "debe ir con la sesion del admin");
        vistos[camino] = { aviso: t.textContent, ruta: p.ruta };
        await esperarHasta(() => tablaLista(app), { desc: "tabla tras la accion" });
      }
      return { vistos };
    }, { grupo: "USUARIOS" });
    await caso("USUARIOS · listado hostil (nombre, correo, teléfono con marcado): se muestra como TEXTO, el canario no se ejecuta y no hay elementos ajenos", async () => {
      const lista = [LISTA[0], { id: UUID(104), nombre: '<img src=x onerror="window.__xss=21">', correo: '<svg onload="window.__xss=22">@example.test', telefono: `"'><svg onload="window.__xss=23">`, rol: "mecanico", activo: true, esUsted: false }];
      const { app } = await abrirUsuarios(B, { lista }); await pausa(700);
      igual(app.win.__xss, 0, "canario"); const celdas = app.$$("#usuariosCuerpo tbody tr")[1].children;
      igual(celdas[0].textContent, lista[1].nombre); igual(celdas[1].textContent, lista[1].correo); igual(celdas[2].textContent, lista[1].telefono);
      igual(app.$$("#usuariosCuerpo img, #usuariosCuerpo svg, #usuariosCuerpo script").length, 0, "elementos ajenos en la tabla");
      return { celdasComoTexto: 3 };
    }, { grupo: "USUARIOS" });
    for (const [rol, cuenta] of [["cajero", C.cajeroActivo], ["mecánico local", null]]) {
      await caso(`USUARIOS · ${rol} (no admin): el menú oculta «Usuarios», showView se niega y render() no llama al api-server`, async () => {
        const app = await B.abrirApp({ cuenta, almacen: cuenta ? {} : { enti_session: sesionLocal("mecanico") } }); igual(await B.esperarArranque(app), "shell");
        const btn = app.$('.nav-item[data-view="usuarios"]'); ok(btn.style.display === "none", "el boton debe estar oculto");
        igual(app.win.showView("usuarios"), false, "showView debe negarse"); await app.win.PantallaUsuarios.render(); await pausa(200);
        ok(/solo para el administrador/.test(app.$("#usuariosCuerpo").textContent), `mensaje: ${app.$("#usuariosCuerpo").textContent}`);
        igual(app.$$(".u-rol, .u-estado, .u-editar, #btnNuevoUsuario").length, 0, "no debe haber acciones de admin");
        igual(B.H.servidor.llamadas.filter((l) => l.host === "api").length, 0, "no debe llamar al api-server");
        return { menuOculto: true };
      }, { grupo: "USUARIOS" });
    }
  }

  // ══ N · PANEL TÉCNICO (solo taller) ══
  if (taller) {
    const PANEL = [
      { nombre: "sesión ausente", cuenta: null, estado: /sin sesión/, rol: "—", cajas: false },
      { nombre: "mecánico activo", cuenta: C.mecanicoActivo, estado: /con sesión/, rol: "mecanico", cajas: false },
      { nombre: "mecánico inactivo", cuenta: C.mecanicoInactivo, estado: /con sesión/, rol: "—", cajas: false },
      { nombre: "usuario no permitido (cajero)", cuenta: C.cajeroActivo, estado: /con sesión/, rol: "cajero", cajas: false },
      { nombre: "contraste: desarrollador (permitido)", cuenta: C.desarrollador, estado: /con sesión/, rol: "desarrollador", cajas: true },
    ];
    for (const sc of PANEL) {
      await caso(`PANEL TÉCNICO · ${sc.nombre}`, async () => {
        const app = await B.abrirApp({ ruta: "/panel-tecnico.html", cuenta: sc.cuenta, modoDatos: null });
        await esperarHasta(() => app.$("#sesEstado") && (sc.cuenta ? app.$("#sesRol").textContent !== "—" || sc.rol === "—" : true), { desc: "panel cargado" }); await pausa(800);
        ok(sc.estado.test(app.$("#sesEstado").textContent), `estado «${app.$("#sesEstado").textContent}»`); igual(app.$("#sesRol").textContent, sc.rol, "rol mostrado");
        igual(!app.$("#cajaCifras").hidden && !app.$("#cajaTablas").hidden, sc.cajas, "cajas de cifras/tablas");
        igual(app.win.__xss, 0); igual(app.$("#errN").textContent.trim(), "0", "errores de consola del panel");
        return { estado: app.$("#sesEstado").textContent, rol: app.$("#sesRol").textContent, versionVisible: app.$("#version").textContent };
      }, { grupo: "PANEL" });
    }
    await caso("PANEL TÉCNICO · PANEL_VERSION (COSMETIC_VERSION_ONLY): el literal visible coincide con VERSION_APP de app.js (3.13.0)", async () => {
      const app = await B.abrirApp({ ruta: "/panel-tecnico.html", modoDatos: null }); await pausa(400);
      const visible = app.$("#version").textContent.trim(); const src = await (await fetch("/app.js")).text(); const v = /const VERSION_APP = "([^"]+)"/.exec(src)[1];
      igual(visible, v, "el panel debe mostrar la version actual");
      return { versionVisible: visible, VERSION_APP: v, COSMETIC_VERSION_STALE: visible !== v ? "SI" : "NO" };
    }, { grupo: "PANEL" });
  }

  // ══ U · MULTI-TAB basico (dos iframes del mismo origen y perfil) ══
  if (taller) await caso("MULTI-TAB (iframes del mismo origen; no son pestañas) · la sesión guardada se comparte; cerrar sesión en B no cambia A hasta recargar (no hay listener «storage»)", async () => {
    const a = await B.abrirApp({ cuenta: C.adminActivo }); igual(await B.esperarArranque(a), "shell");
    const iframeB = document.createElement("iframe"); iframeB.style.cssText = "width:800px;height:500px"; document.body.appendChild(iframeB); iframeB.src = "/index.html";
    await new Promise((r) => iframeB.addEventListener("load", r, { once: true }));
    const b = { doc: iframeB.contentDocument, win: iframeB.contentWindow, $: (s) => iframeB.contentDocument.querySelector(s), activo: (id) => iframeB.contentDocument.getElementById(id)?.classList.contains("active") };
    await esperarHasta(() => b.activo("shell") && (b.$("#ajustesInfo").innerHTML.trim() !== ""), { desc: "B arranca con la sesion compartida" });
    b.$("#btnLogout").click(); await esperarHasta(() => localStorage.getItem("enti_session") === null, { desc: "B cierra sesion" }); await pausa(500);
    const aSigueAbierta = a.activo("shell"); iframeB.remove();
    return { sesionCompartida: "SI", trasLogoutEnB_AsigueAbierta: aSigueAbierta ? "SI (sin sincronizacion entre pestañas: comportamiento actual)" : "NO" };
  }, { grupo: "MULTI-TAB" });

  // ══ V · COPY SIN SINCRONIZACION (4E-C5.1): la interfaz no afirma sincronizacion operativa; el simulador de conexion usa los textos nuevos ══
  const cuentaProducto = taller ? C.adminActivo : C.mecanicoActivo;
  const NOTA_MT = "La asignación y sincronización de trabajos entre dispositivos estará disponible en una versión posterior.";
  await caso("COPY · el HTML servido trae el chip «En línea · datos locales» y, con la app arrancada, NINGÚN texto ni atributo visible dice «sincroniz…» salvo la nota honesta de Mi Trabajo", async () => {
    const servido = new DOMParser().parseFromString(await (await fetch("/index.html")).text(), "text/html");
    igual(servido.getElementById("syncLabel").textContent, "En línea · datos locales", "chip inicial del HTML servido");
    const app = await B.abrirApp({ cuenta: cuentaProducto }); igual(await B.esperarArranque(app), "shell"); await pausa(300);
    igual(app.$("#syncLabel").textContent, "Solo en este dispositivo · respalda seguido", "chip tras el arranque"); igual(app.$("#syncDot").className, "dot off");
    const copia = app.doc.body.cloneNode(true); for (const n of copia.querySelectorAll("script,style")) n.remove();
    const texto = copia.textContent, atributos = [...copia.querySelectorAll("[title],[aria-label],[placeholder],[alt]")].flatMap((e) => ["title", "aria-label", "placeholder", "alt"].map((a) => e.getAttribute(a) || ""));
    const menciones = (texto.match(/sincroniz/gi) || []).length;
    igual(menciones, 1, "una sola mencion de «sincroniz…» en todo el texto de la app"); ok(texto.includes(NOTA_MT), "y es la nota honesta de Mi Trabajo");
    ok(!/sincroniz/i.test(texto.replace(NOTA_MT, "")), "ningun otro texto dice «sincroniz…»"); ok(!atributos.some((a) => /sincroniz/i.test(a)), "ningun atributo visible dice «sincroniz…»");
    return { chipServido: servido.getElementById("syncLabel").textContent, chipArrancada: app.$("#syncLabel").textContent, mencionesEnLaApp: menciones, producto: taller ? "taller" : "mi-trabajo" };
  }, { grupo: "COPY" });
  await caso("COPY · «Simular sin conexión» en el navegador real: «Modo sin conexión activado» → «Conexión restaurada — procesando cambios locales…» → «Cambios guardados localmente» (nada de «sincroniz…»)", async () => {
    const app = await B.abrirApp({ cuenta: cuentaProducto }); igual(await B.esperarArranque(app), "shell"); await pausa(300);
    const boton = app.$("#offlineToggle"), vistos = [], ver = () => { for (const t of app.$$("#toastWrap .toast").map((x) => x.textContent)) if (!vistos.includes(t)) vistos.push(t); return vistos; };
    boton.click(); await esperarHasta(() => ver().includes("Modo sin conexión activado"), { desc: "aviso de modo sin conexión" });
    igual(boton.textContent, "Volver a estar en línea"); app.win.markDirty(); ok(app.win.eval("pending") >= 1, "sin conexion queda al menos un cambio pendiente");
    boton.click(); await esperarHasta(() => ver().includes("Conexión restaurada — procesando cambios locales…"), { desc: "aviso de proceso" });
    await esperarHasta(() => ver().includes("Cambios guardados localmente"), { ms: 4000, desc: "aviso final (1200 ms despues)" });
    igual(app.win.eval("pending"), 0, "los pendientes vuelven a 0"); igual(boton.textContent, "Simular sin conexión");
    ok(!vistos.some((t) => /sincroniz/i.test(t)), `ningun aviso debe decir «sincroniz…»: ${JSON.stringify(vistos)}`);
    igual(app.$("#syncLabel").textContent, "Solo en este dispositivo · respalda seguido", "el chip sigue diciendo la verdad"); igual(app.$("#syncDot").className, "dot off");
    return { avisos: vistos, chipFinal: app.$("#syncLabel").textContent, producto: taller ? "taller" : "mi-trabajo" };
  }, { grupo: "COPY" });
  // ══ C7-FIX-A · OBS-7 (chip del usuario), OBS-8 («Nuevo usuario» a la vista) y OBS-10 («Buscar actualización ahora» no destructivo) ══
  await casosC7FixA({ B, taller, C, abrirUsuarios, LISTA, UUID, cuentaProducto });

  // ══ C7-FIX-B · OBS-9 PLAN B: recuperación mediada por el administrador («Generar enlace», ayuda del login, texto de recovery, recorrido completo) ══
  await casosC7FixB({ B, taller, C, LISTA, UUID, cuentaProducto, enviarClave });
}
