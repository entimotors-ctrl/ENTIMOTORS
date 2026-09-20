// 4E-C7-FIX-A · casos de NAVEGADOR REAL (Chrome y Firefox) para OBS-7, OBS-8 y OBS-10. Los invoca suite-app.js al final de `correr()`.
//   OBS-7  → el chip del usuario se MIDE en el motor real, en escritorio y en móvil (tamaño real del iframe): compacto, elipsis y sin desbordes.
//   OBS-8  → «+ Nuevo usuario» deja el formulario A LA VISTA (sin desplazarse) en escritorio, portátil y móvil; el alta y el enlace siguen igual.
//   OBS-10 → el handler REAL de «Buscar actualización ahora» contra un Service Worker FALSO y controlable (en el navegador real; el SW REAL se prueba
//            en el entorno PWA): nunca desregistra, nunca borra cachés, nunca recarga, nunca activa el worker; abre el MISMO modal.
// Todo dato es sintético; la red sigue cerrada por el prelude.
import { esperarHasta, pausa, ok, igual, mismo } from "/__h/helpers/pagina.js";

const LARGO = "Administrador General de ENTIMOTORS Honduras S. de R.L.";   // 56 letras: cabe en el maximo que admite el api-server (60)
const px = (v) => parseFloat(v);

/** Cambia el tamaño REAL del iframe (los @media de la app se evalúan contra el iframe) y deja que se asiente el layout. */
async function tamano(app, ancho, alto) { app.iframe.style.width = `${ancho}px`; app.iframe.style.height = `${alto}px`; await pausa(350); }

/** Service Worker FALSO y controlable dentro del iframe, con espías. El handler es el REAL; lo único falso es lo que devuelve el navegador. */
function montarSW(app, { sw = "con-registro", registro = {}, controller = true } = {}) {
  const t = { unregister: 0, getRegistrations: 0, getRegistration: 0, register: [], update: 0, postMessage: [], cachesDelete: [], cachesKeys: 0, descargas: [], orden: [] };
  const worker = (estado) => {
    const oy = new Set();
    const w = { state: estado, addEventListener: (tipo, fn) => { if (tipo === "statechange") oy.add(fn); }, removeEventListener: (tipo, fn) => { oy.delete(fn); },
      postMessage: (m) => { t.postMessage.push(JSON.parse(JSON.stringify(m))); t.orden.push(`postMessage:${m && m.tipo}`); }, oyentes: () => oy.size,
      _a(nuevo) { w.state = nuevo; [...oy].forEach((f) => f({ type: "statechange" })); } };
    return w;
  };
  const reg = { active: worker("activated"), waiting: null, installing: null, ...registro,
    update: async () => { t.update++; if (reg._alActualizar) await reg._alActualizar(reg); return reg; },
    unregister: async () => { t.unregister++; return true; } };
  const N = app.win.navigator;
  if (sw === "sin-soporte") {
    // `"serviceWorker" in navigator` mira tambien el prototipo: hay que quitar el stub del prelude Y el getter nativo (solo en ESTE iframe).
    delete N.serviceWorker; delete app.win.Navigator.prototype.serviceWorker; ok(!("serviceWorker" in N), "el navegador simulado NO debe tener serviceWorker");
  } else Object.defineProperty(N, "serviceWorker", { configurable: true, value: {
    controller: controller ? { state: "activated" } : null,
    getRegistration: async () => { t.getRegistration++; return sw === "sin-registro" ? undefined : reg; },
    getRegistrations: async () => { t.getRegistrations++; return sw === "sin-registro" ? [] : [reg]; },
    register: async (url, opc) => { t.register.push([url, opc && opc.updateViaCache]); if (reg._registrarFalla) throw new Error("SecurityError"); return reg; },
    addEventListener() {}, removeEventListener() {},
  } });
  // CacheStorage REAL, con sus métodos envueltos: si el handler intentara borrar o consultar cachés, quedaría anotado (y no se borra nada real).
  const c = app.win.caches; c.delete = (k) => { t.cachesDelete.push(k); return Promise.resolve(true); }; const keysOriginal = c.keys.bind(c); c.keys = () => { t.cachesKeys++; return keysOriginal(); };
  app.win.__vivo = "vivo";   // si la página se recargara, esta marca desaparece
  return { t, reg, worker };
}
const enLinea = (app, valor) => Object.defineProperty(app.win.navigator, "onLine", { configurable: true, get: () => valor });
const modalVisible = (app) => { const m = app.$("#modalVersionNueva"); if (!m || !m.classList.contains("active")) return false; const r = m.getBoundingClientRect(); return r.width > 0 && r.height > 0 && app.win.getComputedStyle(m).display !== "none"; };
const toasts = (app) => app.$$("#toastWrap .toast").map((x) => x.textContent);
const pulsar = (app) => app.$("#btnForzarActualizacion").click();
/** Nada destructivo pasó: ni unregister, ni borrado/consulta de cachés, ni activar-ya, ni recarga (la marca de la ventana sigue viva). */
function sinDestruir(app, t, { permitePostMessage = false } = {}) {
  igual(t.unregister, 0, "unregister"); igual(t.getRegistrations, 0, "getRegistrations"); mismo(t.cachesDelete, [], "caches.delete"); igual(t.cachesKeys, 0, "caches.keys");
  if (!permitePostMessage) mismo(t.postMessage, [], "activar-ya");
  igual(app.win.__vivo, "vivo", "la página se recargó");
}

export async function casosC7FixA({ B, taller, C, abrirUsuarios, LISTA, UUID, cuentaProducto }) {
  // ═══════════════════════ OBS-7 · chip del usuario (solo el Taller: es el que muestra el menú de cuenta con el chip del admin) ═══════════════════════
  if (taller) {
    await B.caso("OBS-7 CERRADO · chip del usuario, medido en el motor real: ESCRITORIO compacto y con elipsis (sin romper el topbar) · MÓVIL con el nombre completo y sin desbordes", async () => {
      const app = await B.abrirApp({ cuenta: C.adminActivo }); igual(await B.esperarArranque(app), "shell", "arranque");
      const d = app.doc, w = app.win, chip = () => app.$(".user-chip"), nom = () => app.$("#loggedUserName"), rol = () => app.$("#loggedUserRole");
      const med = () => { const r = chip().getBoundingClientRect(), cs = w.getComputedStyle(chip()), tb = app.$("#topbar").getBoundingClientRect(), n = nom(), lo = app.$("#btnLogout").getBoundingClientRect();
        return { chipW: Math.round(r.width), chipH: Math.round(r.height), radio: px(cs.borderTopLeftRadius), topbarH: Math.round(tb.height), docW: d.documentElement.scrollWidth, vw: w.innerWidth,
          nomRecortado: n.scrollWidth > n.clientWidth + 1, rolRecortado: rol().scrollWidth > rol().clientWidth + 1, textOverflow: w.getComputedStyle(n).textOverflow, whiteSpace: w.getComputedStyle(n).whiteSpace,
          logoutH: Math.round(lo.height), logoutDer: Math.round(lo.right), nombre: n.textContent, rolTxt: rol().textContent }; };
      const t = { desktop: {}, movil: {} };
      // ── escritorio 1280 ──
      await tamano(app, 1280, 800); nom().textContent = "Admin Activo"; await pausa(150);
      let m = med(); t.desktop.normal = m;
      ok(m.chipH <= 46, `chip de ${m.chipH}px: debe ser compacto (antes ~50px)`); ok(m.radio < 30, `radio ${m.radio}px: ya no es una píldora de 999px`); ok(m.topbarH <= 61, `topbar ${m.topbarH}px`);
      ok(!m.nomRecortado && !m.rolRecortado, "un nombre normal y su rol caben enteros (sin elipsis)"); igual(m.docW <= m.vw, true, "sin desborde horizontal");
      nom().textContent = LARGO; await pausa(200); m = med(); t.desktop.largo = m;
      ok(m.chipW <= 14 * 16 + 4, `el chip no pasa de 14rem: ${m.chipW}px`); ok(m.nomRecortado, "el nombre largo se recorta"); igual(m.textOverflow, "ellipsis", "con elipsis"); igual(m.whiteSpace, "nowrap");
      ok(m.docW <= m.vw, `el nombre largo NO desborda la página: scrollWidth ${m.docW} > ${m.vw}`); ok(m.topbarH <= 61, `el topbar no crece (${m.topbarH}px)`);
      ok(m.logoutDer <= m.vw, `«Cerrar sesión» sigue dentro de la pantalla (${m.logoutDer} > ${m.vw})`); ok(m.logoutH <= 50, `«Cerrar sesión» no se parte en 3 líneas (${m.logoutH}px)`);
      // ── móvil 390 ──
      nom().textContent = "Admin Activo"; await tamano(app, 390, 844); app.$("#btnCuenta").click(); await pausa(300);
      m = med(); t.movil.normal = m; const panel = app.$("#accountPanel").getBoundingClientRect();
      ok(app.$("#accountPanel").classList.contains("open"), "el panel de cuenta abre"); igual(m.whiteSpace, "normal", "móvil: white-space normal"); ok(!m.nomRecortado, "móvil: nombre completo");
      ok(m.docW <= m.vw, `móvil sin desborde (${m.docW} > ${m.vw})`); ok(m.chipW <= Math.round(panel.width) + 1, "el chip cabe en el panel");
      nom().textContent = LARGO; await pausa(250); m = med(); t.movil.largo = m; const panel2 = app.$("#accountPanel").getBoundingClientRect(), chipR = chip().getBoundingClientRect();
      igual(m.whiteSpace, "normal"); igual(m.textOverflow, "clip"); ok(!m.nomRecortado, "móvil: el nombre LARGO se ve completo (varias líneas), no recortado"); ok(m.docW <= m.vw, `móvil con nombre largo sin desborde (${m.docW} > ${m.vw})`);
      ok(chipR.right <= panel2.right + 1 && chipR.left >= panel2.left - 1, "el chip no se sale del panel"); ok(chipR.height > 45, "en móvil el nombre largo ocupa varias líneas");
      return t;
    }, { grupo: "OBS-7" });
  }

  // ═══════════════════════ OBS-8 · «+ Nuevo usuario» a la vista (solo el Taller) ═══════════════════════
  if (taller) {
    const equipo = () => [LISTA[0], ...Array.from({ length: 6 }, (_, i) => ({ id: UUID(110 + i), nombre: `Persona ${i + 3}`, correo: `persona${i + 3}@example.test`, telefono: `9704-000${i}`,
      rol: ["mecanico", "cajero", "desarrollador"][i % 3], activo: i !== 3, esUsted: false }))];
    await B.caso("OBS-8 CERRADO · con 7 personas en el equipo, «+ Nuevo usuario» deja el formulario COMPLETO a la vista (sin desplazarse) en escritorio, portátil y móvil, y ANTES de la lista", async () => {
      const { app } = await abrirUsuarios(B, { lista: equipo() }); const out = {};
      const posicion = (a, b) => !!(a.compareDocumentPosition(b) & app.win.Node.DOCUMENT_POSITION_FOLLOWING);
      for (const [nombre, ancho, alto] of [["escritorio 1280×900", 1280, 900], ["portátil 1024×640", 1024, 640], ["móvil 390×844", 390, 844]]) {
        await tamano(app, ancho, alto); const main = app.$("main") || app.doc.scrollingElement; main.scrollTop = 0;
        const card = app.$("#cardNuevoUsuario"), boton = app.$("#btnNuevoUsuario"), tabla = app.$("#usuariosCuerpo table");
        if (card.style.display !== "none") app.$("#btnCancelarUsuario").click();
        igual(card.style.display, "none", `${nombre}: oculto de inicio`);
        ok(posicion(card, boton) && posicion(card, tabla), `${nombre}: el formulario está ANTES del botón «Nuevo usuario» y de la tabla`);
        boton.click(); await pausa(250);
        const r = card.getBoundingClientRect(), vh = app.win.innerHeight;
        ok(card.style.display !== "none" && r.height > 0, `${nombre}: el formulario se muestra`);
        ok(r.top >= 0 && r.bottom <= vh, `${nombre}: el formulario NO cabe a la vista: top ${Math.round(r.top)} bottom ${Math.round(r.bottom)} viewport ${vh}`);
        const bt = boton.getBoundingClientRect(); ok(bt.top >= 0 && bt.top < vh, `${nombre}: el botón sigue a la vista (${Math.round(bt.top)})`);
        out[nombre] = { top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: vh, altoTarjeta: Math.round(r.height), boton: Math.round(bt.top) };
        app.$("#btnCancelarUsuario").click(); await pausa(100);
      }
      return out;
    }, { grupo: "OBS-8" });

    await B.caso("OBS-8 CERRADO · el alta NO cambió: mismo POST y cuerpo, y el ENLACE generado (#nuResultado) queda a la vista dentro de la tarjeta de arriba (portátil 1024×640)", async () => {
      const { app, estado } = await abrirUsuarios(B, { lista: equipo() }); const enlace = "https://synthetic.example/index.html#access_token=TOKEN-SINTETICO&type=recovery";
      estado.resp = { status: 201, body: { usuario: { id: UUID(150), correo: "ana@example.test", nombre: "Ana", telefono: "9704-1234", rol: "mecanico", activo: true }, enlaceParaEstablecerClave: enlace, motivoSinEnlace: null, nota: "Pásale este enlace a la persona." } };
      await tamano(app, 1024, 640); app.$("#btnNuevoUsuario").click(); await pausa(200);
      app.$("#nuNombre").value = "Ana"; app.$("#nuCorreo").value = "ana@example.test"; app.$("#nuTelefono").value = "9704-1234"; app.$("#nuRol").value = "mecanico";
      const l0 = B.H.servidor.llamadas.length; app.$("#btnCrearUsuario").click();
      await esperarHasta(() => app.$("#nuEnlace"), { desc: "el enlace generado" });
      const p = B.H.servidor.llamadas.slice(l0).find((l) => l.host === "api" && l.metodo === "POST"); ok(p, "debe haber un POST"); igual(p.ruta, "/api/admin/usuarios"); mismo(p.cuerpo, { nombre: "Ana", correo: "ana@example.test", telefono: "9704-1234", rol: "mecanico" }, "cuerpo del POST");
      igual(app.$("#nuEnlace").value, enlace, "el enlace generado se ve para copiarlo"); ok(app.$("#btnCopiarEnlace") && app.$("#btnListoUsuario"), "botones de copiar y de listo");
      const r = app.$("#nuResultado").getBoundingClientRect(), vh = app.win.innerHeight; ok(r.top >= 0 && r.top < vh - 20, `el recuadro del enlace debe verse sin desplazarse: top ${Math.round(r.top)} viewport ${vh}`);
      ok(app.$("#cardNuevoUsuario").contains(app.$("#nuResultado")), "el resultado sigue dentro de la tarjeta del formulario");
      ok(toasts(app).includes("Usuario creado"), "aviso «Usuario creado»");
      return { topResultado: Math.round(r.top), viewport: vh };
    }, { grupo: "OBS-8" });
  }

  // ═══════════════════════ OBS-10 · «Buscar actualización ahora» (Taller y Mi Trabajo: mismo index.html) ═══════════════════════
  const abrir = async () => { const app = await B.abrirApp({ cuenta: cuentaProducto }); igual(await B.esperarArranque(app), "shell", "arranque"); await pausa(300); return app; };
  const YA = "Ya tienes la última versión";

  await B.caso("OBS-10 CERRADO · ACTIVE sin novedades: «Ya tienes la última versión»; update() una vez; sin modal; y un update() que FALLA o una conexión caída no destruyen nada", async () => {
    const app = await abrir(); const { t, reg } = montarSW(app);
    pulsar(app); await esperarHasta(() => toasts(app).includes(YA), { desc: "«Ya tienes la última versión»" });
    igual(t.update, 1); ok(!modalVisible(app), "sin modal"); sinDestruir(app, t); await esperarHasta(() => !app.$("#btnForzarActualizacion").disabled, { desc: "botón liberado" });
    reg._alActualizar = async () => { throw new TypeError("Failed to update a ServiceWorker: network error"); }; const n = toasts(app).length; pulsar(app);
    await esperarHasta(() => toasts(app).includes("No se pudo comprobar ahora. Revisa tu conexión e inténtalo de nuevo."), { desc: "aviso de fallo" }); ok(!modalVisible(app)); sinDestruir(app, t);
    return { update: t.update, avisos: toasts(app).length - n };
  }, { grupo: "OBS-10" });

  await B.caso("OBS-10 CERRADO · WAITING: abre el MISMO modal (3 opciones) sin update() ni activar-ya; «Ahora no» lo cierra sin instalar; el botón lo REABRE cuando la persona quiere", async () => {
    const app = await abrir(); const { t, reg, worker } = montarSW(app); reg.waiting = worker("installed");
    pulsar(app); await esperarHasta(() => modalVisible(app), { desc: "modal de versión nueva" });
    igual(t.update, 0, "ya estaba esperando: no se busca"); sinDestruir(app, t);
    for (const id of ["btnCopiaYActualizar", "btnSoloCopia", "btnActualizarDespues"]) ok(app.$(`#modalVersionNueva #${id}`), `falta ${id}`);
    ok(/Crear copia y actualizar/.test(app.$("#btnCopiaYActualizar").textContent) && /Solo crear copia/.test(app.$("#btnSoloCopia").textContent) && /Ahora no/.test(app.$("#btnActualizarDespues").textContent), "textos de las 3 opciones");
    app.$("#btnActualizarDespues").click(); await pausa(200); ok(!modalVisible(app), "«Ahora no» cierra el aviso"); sinDestruir(app, t); igual(reg.waiting.state, "installed", "sigue esperando");
    ok(toasts(app).includes("De acuerdo — puedes actualizar cuando quieras desde Ajustes"), "aviso de «Ahora no»");
    app.win.abrirAvisoVersionNueva(); await pausa(150); ok(!modalVisible(app), "el aviso AUTOMÁTICO respeta el «Ahora no» en esta sesión");
    await esperarHasta(() => !app.$("#btnForzarActualizacion").disabled, { desc: "botón liberado" }); pulsar(app); await esperarHasta(() => modalVisible(app), { desc: "modal reabierto por la persona" });
    sinDestruir(app, t); return { reabierto: true };
  }, { grupo: "OBS-10" });

  await B.caso("OBS-10 CERRADO · INSTALLING: espera a «installed» y ENTONCES abre el modal; si la instalación falla («redundant») avisa y no abre nada", async () => {
    const app = await abrir(); const { t, reg, worker } = montarSW(app); const w = worker("installing"); reg._alActualizar = async (r) => { r.installing = w; };
    pulsar(app); await esperarHasta(() => t.update === 1 && w.oyentes() === 1, { desc: "esperando la instalación" });
    ok(!modalVisible(app), "aún no: sigue instalando"); ok(!toasts(app).includes(YA), "no debe decir «al día» mientras instala");
    w._a("installed"); await esperarHasta(() => modalVisible(app), { desc: "modal tras «installed»" }); igual(w.oyentes(), 0, "deja de escuchar"); sinDestruir(app, t);
    app.$("#btnActualizarDespues").click(); await pausa(150); app.cerrar();
    const app2 = await abrir(); const m2 = montarSW(app2); const w2 = m2.worker("installing"); m2.reg.installing = w2;
    pulsar(app2); await esperarHasta(() => w2.oyentes() === 1, { desc: "escuchando" }); w2._a("redundant");
    await esperarHasta(() => toasts(app2).includes("No se pudo preparar la versión nueva. Inténtalo otra vez con conexión."), { desc: "aviso de instalación fallida" });
    ok(!modalVisible(app2)); igual(w2.oyentes(), 0); sinDestruir(app2, m2.t);
    return { instalado: true, redundante: true };
  }, { grupo: "OBS-10" });

  await B.caso("OBS-10 CERRADO · OFFLINE: aviso de red; NO se consulta el registro, NO se llama a update(), NO se desregistra ni se borra ninguna caché y NO se recarga (la app conserva su capacidad offline)", async () => {
    const app = await abrir(); const { t, reg, worker } = montarSW(app); reg.waiting = worker("installed"); enLinea(app, false);
    pulsar(app); await esperarHasta(() => toasts(app).includes("Sin conexión: ahora no se puede buscar actualizaciones. La app sigue funcionando igual."), { desc: "aviso sin conexión" });
    igual(t.getRegistration, 0, "ni consulta el registro"); igual(t.update, 0); ok(!modalVisible(app), "ni abre el modal sin red"); sinDestruir(app, t); igual(reg.active.state, "activated");
    enLinea(app, true); await esperarHasta(() => !app.$("#btnForzarActualizacion").disabled, { desc: "botón liberado" }); pulsar(app); await esperarHasta(() => modalVisible(app), { desc: "con red vuelve a funcionar" });
    return { sinRedSeguro: true };
  }, { grupo: "OBS-10" });

  await B.caso("OBS-10 CERRADO · SIN Service Worker: sin soporte → informa; sin registro → registra sw.js (updateViaCache «none»), SIN update() ni recarga; registro que falla → aviso seguro", async () => {
    const a1 = await abrir(); const m1 = montarSW(a1, { sw: "sin-soporte" }); pulsar(a1);
    await esperarHasta(() => toasts(a1).includes("Este navegador no permite buscar actualizaciones automáticas."), { desc: "aviso sin soporte" }); ok(!modalVisible(a1)); igual(m1.t.unregister, 0); mismo(m1.t.cachesDelete, []); igual(a1.win.__vivo, "vivo"); a1.cerrar();
    const a2 = await abrir(); const m2 = montarSW(a2, { sw: "sin-registro" }); pulsar(a2);
    await esperarHasta(() => toasts(a2).includes("Instalación preparada en este dispositivo."), { desc: "registro preparado" });
    mismo(m2.t.register, [["./sw.js", "none"]], "misma llamada de registro que el arranque"); igual(m2.t.update, 0); sinDestruir(a2, m2.t); a2.cerrar();
    const a3 = await abrir(); const m3 = montarSW(a3, { sw: "sin-registro" }); m3.reg._registrarFalla = true; pulsar(a3);
    await esperarHasta(() => toasts(a3).includes("No se pudo preparar la instalación en este dispositivo."), { desc: "aviso de registro fallido" }); sinDestruir(a3, m3.t);
    return { sinSoporte: true, registra: true, registroFalla: true };
  }, { grupo: "OBS-10" });

  await B.caso("OBS-10 CERRADO · «Solo crear copia de seguridad»: copia REAL (IndexedDB real) verificada y descargada; NO activa el worker, NO recarga, el aviso sigue abierto", async () => {
    const app = await abrir(); const { t, reg, worker } = montarSW(app); reg.waiting = worker("installed");
    app.win.descargarArchivo = (nombre, texto) => { t.descargas.push({ nombre, bytes: String(texto).length }); t.orden.push("descarga"); };   // no se baja ningún archivo en el CI
    pulsar(app); await esperarHasta(() => modalVisible(app), { desc: "modal" });
    app.$("#btnSoloCopia").click(); await esperarHasta(() => t.descargas.length === 1, { ms: 12000, desc: "copia descargada" });
    ok(t.descargas[0].bytes > 50, `la copia trae contenido (${t.descargas[0].bytes} bytes)`); ok(/\.json$/.test(t.descargas[0].nombre) || t.descargas[0].nombre.length > 0, "nombre de archivo de la copia");
    await esperarHasta(() => toasts(app).some((x) => /^Copia verificada · \d+ registros$/.test(x)), { desc: "aviso de copia verificada" });
    sinDestruir(app, t); ok(modalVisible(app), "el aviso sigue abierto"); igual(reg.waiting.state, "installed"); await pausa(2800); igual(app.win.__vivo, "vivo", "ninguna recarga programada");
    return { bytes: t.descargas[0].bytes };
  }, { grupo: "OBS-10" });

  await B.caso("OBS-10 CERRADO · «Crear copia y actualizar»: la copia va PRIMERO (real y verificada) y solo DESPUÉS «activar-ya» al worker que esperaba (única vía que lo activa)", async () => {
    const app = await abrir(); const { t, reg, worker } = montarSW(app); reg.waiting = worker("installed");
    app.win.descargarArchivo = (nombre, texto) => { t.descargas.push({ nombre, bytes: String(texto).length }); t.orden.push("descarga"); };
    pulsar(app); await esperarHasta(() => modalVisible(app), { desc: "modal" });
    app.$("#btnCopiaYActualizar").click(); await esperarHasta(() => t.postMessage.length === 1, { ms: 12000, desc: "activar-ya" });
    mismo(t.orden, ["descarga", "postMessage:activar-ya"], "la copia va antes que el activar-ya"); mismo(t.postMessage, [{ tipo: "activar-ya" }]); ok(t.descargas[0].bytes > 50, "copia con contenido");
    igual(t.unregister, 0); mismo(t.cachesDelete, []); igual(t.getRegistrations, 0);
    const marca = app.win.__vivo; app.cerrar();   // se cierra antes de los 2,5 s de la recarga de respaldo
    return { orden: t.orden, marca };
  }, { grupo: "OBS-10" });
}
