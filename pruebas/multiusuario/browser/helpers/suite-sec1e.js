// SECURITY-1E (3.14.1) en el motor REAL: Ajustes → Seguridad → «Cambiar contraseña del administrador».
// Lo invoca suite-app.js. Taller: visibilidad por rol, campos y colores MEDIDOS en tema oscuro y claro (texto, caret, fondo, borde,
// etiqueta), mostrar/ocultar, foco, envío único contra PUT /api/admin/clave INTERCEPTADO (nunca producción), Retry-After, limpieza al
// salir, que la contraseña (el CANARIO del banco) no queda en DOM, localStorage, sessionStorage, IndexedDB ni consola, y 360/768/1280.
// Mi Trabajo: el mecánico nunca ve la tarjeta.
import { pausa, ok, igual, mismo, esperarHasta } from "/__h/helpers/pagina.js";

const CAMPOS = ["claveActual", "claveNueva", "claveConfirmar"];
const NUEVA = "una frase nueva bastante larga";

// ── color: rgb(a) del motor → luminancia WCAG; el fondo translúcido se compone sobre el de abajo ──
const rgba = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
const sobre = (c, f) => ({ r: c.r * c.a + f.r * (1 - c.a), g: c.g * c.a + f.g * (1 - c.a), b: c.b * c.a + f.b * (1 - c.a), a: 1 });
const lum = (c) => [c.r, c.g, c.b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((t, v, i) => t + v * [0.2126, 0.7152, 0.0722][i], 0);
const contraste = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Fondo efectivo de un elemento: compone los fondos (translúcidos o no) de él y sus ancestros sobre el del documento. */
function fondoEfectivo(app, el) {
  const capas = [];
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = rgba(app.win.getComputedStyle(e).backgroundColor); if (c && c.a > 0) { capas.push(c); if (c.a >= 1) break; } }
  let f = capas.length && capas[capas.length - 1].a >= 1 ? capas.pop() : { r: 255, g: 255, b: 255, a: 1 };
  for (const c of capas.reverse()) f = sobre(c, f);
  return f;
}

/** Contraseñas del banco guardadas en almacenes REALES (localStorage, sessionStorage, todas las bases IndexedDB del origen). */
async function almacenesContienen(app, texto) {
  const w = app.win, hallado = [];
  if (JSON.stringify(Object.entries(w.localStorage)).includes(texto)) hallado.push("localStorage");
  if (JSON.stringify(Object.entries(w.sessionStorage)).includes(texto)) hallado.push("sessionStorage");
  if (w.document.cookie.includes(texto)) hallado.push("cookie");
  for (const d of await w.indexedDB.databases()) {
    const db = await new Promise((res, rej) => { const r = w.indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("base bloqueada")); });
    try { for (const n of db.objectStoreNames) { const filas = await new Promise((res, rej) => { const q = db.transaction(n).objectStore(n).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); if (JSON.stringify(filas).includes(texto)) hallado.push(`IndexedDB:${d.name}/${n}`); } }
    finally { db.close(); }
  }
  return hallado;
}

/** Escribe como lo haría una persona (valor + evento input). */
function escribir(app, id, valor) { const i = app.doc.getElementById(id); i.focus(); i.value = valor; i.dispatchEvent(new app.win.Event("input", { bubbles: true })); }

async function abrirAjustes(B, cuenta) {
  const app = await B.abrirApp({ cuenta }); igual(await B.esperarArranque(app), "shell", "arranca"); await pausa(300);
  app.$('.nav-item[data-view="ajustes"]').click(); await pausa(250);
  return app;
}

export async function casosSec1E({ B, taller, C }) {
  const { caso } = B;
  if (!taller) {
    await caso("SEC-1E · Mi Trabajo: el mecánico con cuenta NO ve Ajustes ni la tarjeta Seguridad (y showView no la abre)", async () => {
      const app = await B.abrirApp({ cuenta: C.mecanicoActivo }); igual(await B.esperarArranque(app), "shell"); await pausa(300);
      const card = app.$("#cardSeguridad"); ok(!card || card.getBoundingClientRect().width === 0, "tarjeta invisible");
      igual(app.win.eval('showView("ajustes")'), false, "showView(ajustes) rechazado");
      app.cerrar(); return {};
    }, { grupo: "SEC-1E" });
    return;
  }

  await caso("SEC-1E · visibilidad: el ADMIN ve Ajustes → Seguridad; el CAJERO y el MECÁNICO local no (ni por showView); la tarjeta es solo del admin", async () => {
    const r = {};
    const admin = await abrirAjustes(B, C.adminActivo);
    ok(admin.activo("view-ajustes"), "admin: Ajustes abierta");
    const card = admin.$("#cardSeguridad"); ok(card.getBoundingClientRect().height > 0, "admin: tarjeta visible");
    igual(admin.$("#tituloSeguridad").textContent.trim(), "Seguridad"); igual(admin.$("#tituloClaveAdmin").textContent.trim(), "Cambiar contraseña del administrador");
    ok(admin.$("#formClaveAdmin").getBoundingClientRect().height > 0, "admin: formulario visible");
    r.admin = "visible"; admin.cerrar();
    for (const [rol, opc] of [["cajero", { cuenta: C.cajeroActivo }], ["mecanico local", { almacen: { enti_session: { user: "usuario-sintetico", nombre: "Persona Sintetica", telefono: "", rol: "mecanico", origen: "local" } } }]]) {
      const app = await B.abrirApp(opc); igual(await B.esperarArranque(app), "shell", `${rol}: arranca`); await pausa(250);
      igual(app.win.eval('showView("ajustes")'), false, `${rol}: showView(ajustes) rechazado`);
      ok(!app.activo("view-ajustes"), `${rol}: Ajustes no se abre`);
      igual(app.win.getComputedStyle(app.$("#cardSeguridad")).display, "none", `${rol}: tarjeta oculta`);
      r[rol] = "oculta"; app.cerrar();
    }
    return r;
  }, { grupo: "SEC-1E" });

  await caso("SEC-1E · campos: type=password al abrir, autocomplete current/new/new, label real asociado, vacíos; mostrar/ocultar por campo con aria correcto y sin tocar el valor", async () => {
    const app = await abrirAjustes(B, C.adminActivo);
    const ac = { claveActual: "current-password", claveNueva: "new-password", claveConfirmar: "new-password" };
    for (const id of CAMPOS) {
      const i = app.doc.getElementById(id);
      igual(i.type, "password", `${id}: type`); igual(i.getAttribute("autocomplete"), ac[id], `${id}: autocomplete`); igual(i.value, "", `${id}: vacío`);
      ok(i.labels && i.labels.length === 1 && i.labels[0].textContent.trim().length > 5, `${id}: label asociado`);
    }
    escribir(app, "claveNueva", B.CANARIO);
    const btn = app.$('.btn-ver-clave[data-campo="claveNueva"]');
    igual(btn.getAttribute("aria-label"), "Mostrar contraseña"); igual(btn.getAttribute("aria-pressed"), "false");
    btn.click(); await pausa(50);
    igual(app.doc.getElementById("claveNueva").type, "text", "mostrar"); igual(btn.getAttribute("aria-label"), "Ocultar contraseña"); igual(btn.getAttribute("aria-pressed"), "true");
    igual(btn.querySelector("use").getAttribute("href"), "#i-ojo-tachado"); ok(app.doc.getElementById("claveNueva").value === B.CANARIO, "el valor no cambia");
    igual(app.doc.getElementById("claveActual").type, "password", "los demás siguen ocultos");
    btn.click(); await pausa(50);
    igual(app.doc.getElementById("claveNueva").type, "password", "ocultar"); igual(btn.querySelector("use").getAttribute("href"), "#i-ojo");
    // teclado: todo es enfocable, en orden de lectura; el campo enfocado tiene contorno visible
    const orden = app.$$("#formClaveAdmin input, #formClaveAdmin button").map((e) => e.id || e.dataset.campo);
    mismo(orden, ["claveActual", "claveActual", "claveNueva", "claveNueva", "claveConfirmar", "claveConfirmar", "btnCambiarClave"], "orden de tabulación");
    for (const e of app.$$("#formClaveAdmin input, #formClaveAdmin button")) ok(e.tabIndex >= 0 && !e.disabled, "enfocable");
    app.doc.getElementById("claveActual").focus(); await pausa(30);
    ok(app.win.getComputedStyle(app.doc.getElementById("claveActual")).outlineStyle !== "none", "foco visible en el campo");
    for (const b of app.$$(".btn-ver-clave")) ok((b.getAttribute("aria-label") || "").length > 0 && b.type === "button", "botón con nombre accesible, type=button");
    // salir de Ajustes lo borra y lo oculta todo
    btn.click(); app.$('.nav-item[data-view="dashboard"]').click(); await pausa(150);
    mismo(CAMPOS.map((id) => app.doc.getElementById(id).value), ["", "", ""], "vacíos al salir"); mismo(CAMPOS.map((id) => app.doc.getElementById(id).type), ["password", "password", "password"], "ocultos al salir");
    app.cerrar(); return {};
  }, { grupo: "SEC-1E" });

  await caso("SEC-1E · VISIBILIDAD DEL TEXTO (defecto de la aceptación): en tema OSCURO y CLARO el texto escrito, el caret, el fondo, el borde y las etiquetas se miden con contraste suficiente, también mostrado (type=text)", async () => {
    const app = await abrirAjustes(B, C.adminActivo);
    for (const id of CAMPOS) escribir(app, id, "texto de prueba visible");
    const medidas = {};
    for (const tema of ["dark", "light"]) {
      app.doc.documentElement.setAttribute("data-theme", tema); await pausa(120);
      for (const tipo of ["password", "text"]) {
        for (const id of CAMPOS) {
          const i = app.doc.getElementById(id); i.type = tipo;
          const cs = app.win.getComputedStyle(i), fondo = fondoEfectivo(app, i);
          const texto = rgba(cs.color), relleno = rgba(cs.webkitTextFillColor || cs.getPropertyValue("-webkit-text-fill-color") || cs.color), caret = rgba(cs.caretColor), borde = sobre(rgba(cs.borderTopColor), fondo);
          const etiqueta = app.$(`label[for="${id}"]`), fondoEtiqueta = fondoEfectivo(app, etiqueta);
          ok(texto && texto.a === 1, `${tema}/${tipo}/${id}: color de texto opaco (${cs.color})`);
          ok(contraste(texto, fondo) >= 7, `${tema}/${tipo}/${id}: texto ${contraste(texto, fondo).toFixed(2)}:1`);
          if (relleno) ok(contraste(sobre(relleno, fondo), fondo) >= 7, `${tema}/${tipo}/${id}: text-fill ${contraste(sobre(relleno, fondo), fondo).toFixed(2)}:1`);
          ok(caret && contraste(caret, fondo) >= 3, `${tema}/${tipo}/${id}: caret ${caret ? contraste(caret, fondo).toFixed(2) : "?"}:1 (${cs.caretColor})`);
          ok(contraste(borde, fondo) > 1.15, `${tema}/${tipo}/${id}: borde distinguible (${contraste(borde, fondo).toFixed(2)}:1)`);
          ok(contraste(rgba(app.win.getComputedStyle(etiqueta).color), fondoEtiqueta) >= 4.5, `${tema}/${id}: etiqueta ${contraste(rgba(app.win.getComputedStyle(etiqueta).color), fondoEtiqueta).toFixed(2)}:1`);
          if (id === "claveNueva") medidas[`${tema}/${tipo}`] = { texto: cs.color, fondo: `rgb(${fondo.r.toFixed(0)},${fondo.g.toFixed(0)},${fondo.b.toFixed(0)})`, caret: cs.caretColor, contraste: +contraste(texto, fondo).toFixed(2) };
        }
      }
      const ayuda = app.$("#claveAyuda"); ok(contraste(rgba(app.win.getComputedStyle(ayuda).color), fondoEfectivo(app, ayuda)) >= 4.5, `${tema}: ayuda legible`);
    }
    for (const id of CAMPOS) app.doc.getElementById(id).type = "password";
    ok(medidas["dark/password"].texto !== medidas["light/password"].texto, "el color del texto cambia con el tema (no es fijo ni heredado del sistema)");
    app.doc.documentElement.removeAttribute("data-theme");
    app.cerrar(); return { medidas };
  }, { grupo: "SEC-1E" });

  await caso("SEC-1E · envío: doble clic = UNA sola petición PUT /api/admin/clave con Bearer y EXACTAMENTE los tres campos; éxito accesible, campos vacíos y ocultos; la contraseña (canario) no queda en DOM, almacenes (incl. IndexedDB) ni consola", async () => {
    const app = await abrirAjustes(B, C.adminActivo);
    const vistas = [];
    B.H.interceptor = (u, m, init) => {
      if (u.pathname !== "/api/admin/clave") return undefined;
      const h = new Headers(init.headers || {}), cuerpo = JSON.parse(init.body);
      const sesion = JSON.parse(app.win.localStorage.getItem("entimotors_sb_sesion") || "{}");   // S1: la sesión actual del Taller
      vistas.push({ m, bearer: !!sesion.access_token && h.get("Authorization") === `Bearer ${sesion.access_token}`, ct: h.get("Content-Type"), claves: Object.keys(cuerpo).sort(), actualEsCanario: cuerpo.clave_actual === B.CANARIO, cache: init.cache, cred: init.credentials });
      return pausa(250).then(() => new Response(JSON.stringify({ ok: true, otras_sesiones_cerradas: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    };
    escribir(app, "claveActual", B.CANARIO); escribir(app, "claveNueva", NUEVA); escribir(app, "claveConfirmar", NUEVA);
    app.$('.btn-ver-clave[data-campo="claveActual"]').click();
    const btn = app.$("#btnCambiarClave"); btn.click(); btn.click(); app.$("#formClaveAdmin").requestSubmit(); await pausa(60);
    ok(btn.disabled && btn.getAttribute("aria-busy") === "true", "botón deshabilitado y ocupado mientras envía");
    igual(app.doc.getElementById("claveActual").type, "password", "al enviar se vuelve a ocultar");
    await esperarHasta(() => app.$("#claveEstado").getAttribute("data-tipo") === "ok", { desc: "éxito" });
    igual(vistas.length, 1, "una sola petición");
    mismo(vistas[0], { m: "PUT", bearer: true, ct: "application/json", claves: ["clave_actual", "clave_confirmacion", "clave_nueva"], actualEsCanario: true, cache: "no-store", cred: "omit" }, "forma de la petición");
    const estado = app.$("#claveEstado");
    igual(estado.getAttribute("role"), "status"); igual(estado.getAttribute("aria-live"), "polite");
    igual(estado.textContent.trim(), "Contraseña actualizada correctamente. Las demás sesiones de administrador fueron cerradas.");
    ok(estado.querySelector('svg.ic use[href="#i-check"]'), "símbolo de éxito (no solo color)");
    mismo(CAMPOS.map((id) => app.doc.getElementById(id).value), ["", "", ""], "vacíos"); mismo(CAMPOS.map((id) => app.doc.getElementById(id).type), ["password", "password", "password"], "ocultos");
    ok(!btn.disabled, "se puede seguir usando"); ok(app.activo("view-ajustes") && app.activo("shell"), "sin recargar ni cerrar sesión");
    mismo(await almacenesContienen(app, B.CANARIO), [], "canario en almacenes"); mismo(await almacenesContienen(app, NUEVA), [], "contraseña nueva en almacenes");
    const donde = B.buscarCanario(app); mismo(donde, { dom: "AUSENTE", localStorage: "AUSENTE", sessionStorage: "AUSENTE", consola: "AUSENTE" }, "canario");
    app.cerrar(); return { peticiones: vistas.length };
  }, { grupo: "SEC-1E" });

  await caso("SEC-1E · respuestas: CLAVE_INCORRECTA, CLAVE_DEBIL, SESION_INVALIDA, 409 y 429 con Retry-After (botón bloqueado), 503 y error genérico → textos propios, sin el cuerpo del servidor; validación local sin petición", async () => {
    const app = await abrirAjustes(B, C.adminActivo);
    let respuesta = null, n = 0;
    B.H.interceptor = (u) => { if (u.pathname !== "/api/admin/clave") return undefined; n++; return Promise.resolve(respuesta()); };
    const r = (status, cuerpo, cab = {}) => () => new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), { status, headers: { "Content-Type": "application/json", ...cab } });
    const intentar = async (a = "actual de prueba", nueva = NUEVA, conf = nueva) => {
      escribir(app, "claveActual", a); escribir(app, "claveNueva", nueva); escribir(app, "claveConfirmar", conf);
      app.$("#btnCambiarClave").click();
      await esperarHasta(() => { const t = app.$("#claveEstado").textContent; return t && !/Cambiando/.test(t); }, { desc: "respuesta" }); await pausa(30);
      return app.$("#claveEstado").textContent.trim();
    };
    const vistos = {};
    for (const [nombre, status, cuerpo, esperado] of [
      ["CLAVE_INCORRECTA", 401, { codigo: "CLAVE_INCORRECTA", error: "INTERNO-xyz" }, "La contraseña actual no es correcta."],
      ["CLAVE_DEBIL", 400, { codigo: "CLAVE_DEBIL", error: "INTERNO-xyz" }, "no cumple los requisitos"],
      ["SESION_INVALIDA", 401, { codigo: "SESION_INVALIDA", error: "INTERNO-xyz" }, "vuelve a entrar"],
      ["ERROR_INTERNO", 500, { codigo: "ERROR_INTERNO", error: "INTERNO-xyz", stack: "at x" }, "No se pudo cambiar la contraseña"],
      ["no JSON", 502, "<html>INTERNO-xyz</html>", "No se pudo cambiar la contraseña"],
    ]) {
      respuesta = r(status, cuerpo); const t = await intentar();
      ok(t.includes(esperado), `${nombre}: «${t}»`); ok(!t.includes("INTERNO-xyz"), `${nombre}: sin el cuerpo del servidor`);
      mismo(CAMPOS.map((id) => app.doc.getElementById(id).type), ["password", "password", "password"], `${nombre}: ocultos`);
      vistos[nombre] = t;
    }
    // validación local: no llega al servidor
    const antes = n;
    ok((await intentar("x", NUEVA, "otra distinta y larga")).includes("La confirmación no coincide"), "no coinciden");
    ok((await intentar(NUEVA, NUEVA, NUEVA)).includes("distinta de la actual"), "igual a la actual");
    ok((await intentar("x", "corta", "corta")).includes("al menos 12 caracteres"), "corta");
    igual(n, antes, "la validación local no envía nada");
    // 409 / 429 / 503: aviso, botón bloqueado el tiempo indicado
    for (const [status, cuerpo, cab, texto] of [[409, { codigo: "CAMBIO_EN_CURSO" }, { "Retry-After": "40" }, "40 s."], [429, { codigo: "DEMASIADOS_INTENTOS" }, { "Retry-After": "900" }, "15 min."], [503, { codigo: "AUTH_NO_DISPONIBLE" }, {}, "1 min."]]) {
      respuesta = r(status, cuerpo, cab); const t = await intentar();
      ok(t.endsWith(texto), `${status}: «${t}»`); ok(app.$("#btnCambiarClave").disabled, `${status}: botón bloqueado`);
      igual(app.$("#claveEstado").getAttribute("data-tipo"), "aviso", `${status}: aviso`);
      const n0 = n; app.$("#formClaveAdmin").requestSubmit(); await pausa(80); igual(n, n0, `${status}: bloqueado no envía`);
      app.win.eval("claveEsperaHasta = 0; clearTimeout(claveEsperaTimer); bloquearFormClave(false)");   // solo para seguir probando en esta misma página
      vistos[status] = t;
    }
    app.cerrar(); return { vistos };
  }, { grupo: "SEC-1E" });

  await caso("SEC-1E · 360/768/1280 en tema oscuro y claro: la tarjeta, los campos y los botones de mostrar caben; nada fuera de la barra superior se sale; sin scroll horizontal (salvo la barra heredada a 768)", async () => {
    const app = await abrirAjustes(B, C.adminActivo);
    const r = {};
    for (const tema of ["dark", "light"]) {
      app.doc.documentElement.setAttribute("data-theme", tema);
      for (const w of [360, 768, 1280]) {
        app.iframe.style.width = `${w}px`; await pausa(250);
        const cw = app.doc.documentElement.clientWidth, barra = app.$("#topbar");
        const card = app.$("#cardSeguridad").getBoundingClientRect();
        ok(card.right <= cw + 1 && card.left >= -1, `${tema} @${w}: tarjeta dentro (${Math.round(card.left)}–${Math.round(card.right)} / ${cw})`);
        for (const e of app.$$("#cardSeguridad *")) { const b = e.getBoundingClientRect(); if (b.width > 0) ok(b.right <= card.right + 1, `${tema} @${w}: ${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""} dentro de la tarjeta`); }
        for (const id of CAMPOS) {
          const i = app.doc.getElementById(id).getBoundingClientRect(), b = app.$(`.btn-ver-clave[data-campo="${id}"]`).getBoundingClientRect();
          ok(b.left >= i.left && b.right <= i.right + 0.5 && b.top >= i.top - 0.5 && b.bottom <= i.bottom + 0.5, `${tema} @${w}: botón de mostrar dentro de ${id}`);
          ok(b.width >= 24 && b.height >= 24, `${tema} @${w}: botón de mostrar ≥ 24 px`);
        }
        const fuera = app.$$("body *").filter((e) => !barra.contains(e) && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > cw + 1 && app.win.getComputedStyle(e).position !== "fixed");
        mismo(fuera.map((e) => e.id || e.tagName), [], `${tema} @${w}: nada fuera de la barra se sale`);
        if (w !== 768) ok(app.doc.documentElement.scrollWidth <= cw + 1, `${tema} @${w}: sin scroll horizontal`);
        r[`${tema}@${w}`] = `${app.doc.documentElement.scrollWidth}/${cw}`;
      }
    }
    app.doc.documentElement.removeAttribute("data-theme"); app.iframe.style.width = "1000px";
    app.cerrar(); return { anchos: r };
  }, { grupo: "SEC-1E" });
}
