// 4E-C7-FIX-B · casos de NAVEGADOR REAL (Chrome y Firefox) para OBS-9 · PLAN B (recuperacion mediada por el administrador). Los invoca suite-app.js al final.
//   Taller  → Usuarios → «Generar enlace» → caja de resultado → «Copiar enlace»; vida del enlace (reemplazo, cerrar, salir de la vista, cerrar sesion, sin
//             storage / IndexedDB / consola); XSS; y el recorrido COMPLETO: enlace de un cajero → abrirlo → contraseña nueva → entrar como cajero.
//   Mi Trabajo → el recorrido de un mecanico con un enlace generado por el «servidor» (en Mi Trabajo no hay pantalla de Usuarios) → entra a Mi Trabajo.
//   Ambos   → ayuda visible en el login (escritorio y móvil) y texto de recovery (RECOVERY ≠ INVITE).
// Todo dato es sintético; la red sigue cerrada por el prelude; el enlace/token/contraseña solo existe en memoria del navegador de la prueba.
import { esperarHasta, pausa, ok, igual, mismo } from "/__h/helpers/pagina.js";

const HELP = "¿Olvidaste tu contraseña? Pide al administrador que te genere un enlace de recuperación.";
const INTRO = { recovery: "Elige tu contraseña para entrar a ENTIMOTORS OS.", invite: "Has sido invitado a ENTIMOTORS OS. Crea tu contraseña para activar tu acceso." };
const tamano = async (app, ancho, alto) => { app.iframe.style.width = `${ancho}px`; app.iframe.style.height = `${alto}px`; await pausa(350); };
const toasts = (app) => app.$$("#toastWrap .toast").map((x) => x.textContent);
const caja = (app) => app.$("#cardEnlaceRecuperacion");
const campo = (app) => caja(app).querySelector("input");
const botonDe = (app, texto) => [...caja(app).querySelectorAll("button")].find((b) => b.textContent === texto);
const hashDe = (enlace) => new URL(enlace).hash;
/** Tras `location.replace` el iframe tiene un DOCUMENTO NUEVO: se devuelve un «app» que apunta a el (el `doc` viejo de abrirApp ya no sirve). */
const fresca = (app) => { const doc = app.iframe.contentDocument; return { ...app, doc, win: app.iframe.contentWindow, $: (x) => doc.querySelector(x), $$: (x) => [...doc.querySelectorAll(x)], activo: (id) => !!doc.getElementById(id)?.classList.contains("active") }; };
const tokenDe = (enlace) => new URLSearchParams(hashDe(enlace).slice(1)).get("access_token");

/** ¿Aparece `texto` en algun almacen del navegador? localStorage, sessionStorage y TODAS las bases IndexedDB del origen (contenido real). */
async function almacenesContienen(app, texto) {
  const w = app.win, partes = { localStorage: JSON.stringify(Object.entries(w.localStorage)), sessionStorage: JSON.stringify(Object.entries(w.sessionStorage)) };
  const hallado = Object.entries(partes).filter(([, v]) => v.includes(texto)).map(([k]) => k);
  for (const d of await w.indexedDB.databases()) {
    const db = await new Promise((res, rej) => { const r = w.indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("base bloqueada")); });
    try { for (const n of db.objectStoreNames) { const filas = await new Promise((res, rej) => { const q = db.transaction(n).objectStore(n).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); if (JSON.stringify(filas).includes(texto)) hallado.push(`IndexedDB:${d.name}/${n}`); } }
    finally { db.close(); }
  }
  return hallado;
}

export async function casosC7FixB({ B, taller, C, LISTA, UUID, cuentaProducto, enviarClave }) {
  // ── el «servidor» de la prueba: hace lo que hace el api-server (enlace de un solo uso, destino por rol) con el Supabase falso ──
  const PERSONAS = () => [LISTA[0],
    { id: UUID(120), nombre: "Cajero Uno", correo: C.cajeroActivo.correo, telefono: "9704-0002", rol: "cajero", activo: true, esUsted: false },
    { id: UUID(121), nombre: "Mecánico Uno", correo: C.mecanicoActivo.correo, telefono: "9704-0003", rol: "mecanico", activo: true, esUsted: false },
    { id: UUID(122), nombre: "Dev Uno", correo: "dev@example.test", telefono: "", rol: "desarrollador", activo: true, esUsted: false },
    { id: UUID(123), nombre: "Otro Admin", correo: "otro-admin@example.test", telefono: "", rol: "admin", activo: true, esUsted: false },
    { id: UUID(124), nombre: "Mecánico De Baja", correo: "baja@example.test", telefono: "", rol: "mecanico", activo: false, esUsted: false }];
  const abrirAdmin = async ({ respuesta } = {}) => {
    const personas = PERSONAS();
    const app = await B.abrirApp({ cuenta: C.adminActivo, servidor: (s) => { s.api = async (metodo, ruta) => {
      if (metodo === "GET") return { status: 200, body: { usuarios: personas } };
      const m = /\/api\/admin\/usuarios\/([^/]+)\/enlace$/.exec(ruta); if (metodo !== "POST" || !m) return { status: 404, body: { error: "ruta no simulada" } };
      const p = personas.find((x) => x.id === m[1]); if (respuesta) return respuesta(p, s);
      if (!p || !p.activo) return { status: 409, body: { error: "Esa cuenta está dada de baja." } };
      return { status: 200, body: { enlaceParaEstablecerClave: `${location.origin}/index.html#access_token=${s.emitirRecuperacion(p.correo)}&type=recovery&expires_in=3600`, nota: "x" } };
    }; } });
    igual(await B.esperarArranque(app), "shell", "arranque como admin"); app.$('.nav-item[data-view="usuarios"]').click();
    await esperarHasta(() => app.$$(".u-rol").length > 0 && !/Cargando/.test(app.$("#usuariosCuerpo")?.textContent || ""), { desc: "tabla de usuarios" });
    return { app, personas };
  };
  const generar = async (app, id) => {
    const b = app.$$(".u-enlace").find((x) => x.dataset.id === id); ok(b, "botón «Generar enlace» de esa persona"); const avisos = toasts(app).length; b.click();
    await esperarHasta(() => app.$("#modalConfirm").classList.contains("active"), { desc: "confirmación" }); const texto = app.$("#confirmMensaje").textContent; app.$("#btnConfirmAceptar").click();
    // termina cuando sale UN aviso nuevo (éxito «Enlace generado» o el error) y el botón vuelve a estar libre
    await esperarHasta(() => toasts(app).length > avisos && !b.disabled && !app.$("#modalConfirm").classList.contains("active"), { desc: "petición terminada" }); return texto;
  };

  // ═══════════════════════ Taller: «Generar enlace» ═══════════════════════
  if (taller) {
    await B.caso("OBS-9 · Usuarios: «Generar enlace» solo para personas ACTIVAS que no son administrador (ni tú, ni otro admin, ni inactivas), con confirmación clara y POST sin cuerpo", async () => {
      const { app, personas } = await abrirAdmin();
      mismo(app.$$(".u-enlace").map((b) => b.dataset.id).sort(), [UUID(120), UUID(121), UUID(122)].sort(), "solo cajero, mecánico y desarrollador activos");
      const filaAdmin = app.$$("#usuariosCuerpo tbody tr")[0]; ok(!filaAdmin.querySelector(".u-enlace"), "tu propia fila no tiene el botón");
      const l0 = B.H.servidor.llamadas.length; const texto = await generar(app, UUID(120));
      ok(/Cajero Uno/.test(texto) && /un solo uso/.test(texto) && /dejará de servir/.test(texto) && /no se envía por correo/.test(texto), `confirmación clara: ${texto}`);
      const posts = B.H.servidor.llamadas.slice(l0).filter((l) => l.host === "api" && l.metodo === "POST"); igual(posts.length, 1); igual(posts[0].ruta, `/api/admin/usuarios/${UUID(120)}/enlace`); igual(posts[0].auth, "sesion");
      ok(posts[0].cuerpo === undefined || posts[0].cuerpo === null || posts[0].cuerpo === "", "sin cuerpo: no manda correo, rol ni redirect");
      return { botones: 3, confirmacion: true };
    }, { grupo: "OBS-9" });

    await B.caso("OBS-9 · Usuarios: la caja de resultado queda A LA VISTA (portátil 1024×640), el campo es de solo lectura y «Copiar enlace» copia EXACTAMENTE el enlace", async () => {
      const { app } = await abrirAdmin(); await tamano(app, 1024, 640); const copiados = [];
      Object.defineProperty(app.win.navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { copiados.push(t); } } });
      await generar(app, UUID(120)); const c = caja(app), cm = campo(app), r = c.getBoundingClientRect(), vh = app.win.innerHeight;
      ok(c.style.display !== "none" && r.height > 0, "la caja se muestra"); ok(r.top >= 0 && r.bottom <= vh, `la caja NO cabe a la vista: top ${Math.round(r.top)} bottom ${Math.round(r.bottom)} viewport ${vh}`);
      ok(cm.readOnly && cm.value.startsWith(`${location.origin}/index.html#access_token=`) && /&type=recovery/.test(cm.value), "campo de solo lectura con el enlace"); ok(/Para: Cajero Uno\./.test(c.textContent) && /No se envía por correo/.test(c.textContent));
      const enlace = cm.value, bc = botonDe(app, "Copiar enlace"); bc.click(); await esperarHasta(() => bc.textContent === "Copiado", { desc: "«Copiado»" });
      mismo(copiados, [enlace], "se copia EXACTAMENTE lo que se ve"); igual(campo(app).value, enlace, "el campo no cambió");
      // sin API de portapapeles: vía antigua (execCommand) sobre el campo
      Object.defineProperty(app.win.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("NotAllowedError"); } } }); const ordenes = []; app.doc.execCommand = (o) => { ordenes.push(o); return true; };
      bc.textContent = "Copiar enlace"; bc.click(); await esperarHasta(() => ordenes.length === 1, { desc: "execCommand" }); mismo(ordenes, ["copy"]); await esperarHasta(() => bc.textContent === "Copiado", { desc: "«Copiado» por la vía antigua" });
      return { topCaja: Math.round(r.top), viewport: vh };
    }, { grupo: "OBS-9" });

    await B.caso("OBS-9 · Usuarios: vida del enlace — uno nuevo REEMPLAZA al anterior; «Cerrar», salir de la pantalla y cerrar sesión lo RETIRAN (el campo queda vacío)", async () => {
      const { app } = await abrirAdmin(); await generar(app, UUID(120)); const viejo = campo(app), valorViejo = viejo.value; ok(valorViejo.length > 30);
      await generar(app, UUID(121)); const nuevo = campo(app); ok(nuevo.value && nuevo.value !== valorViejo, "otro enlace"); igual(viejo.value, "", "el campo anterior se vació"); igual(caja(app).querySelectorAll("input").length, 1, "una sola caja"); ok(/Mecánico Uno/.test(caja(app).textContent));
      botonDe(app, "Cerrar").click(); await pausa(50); igual(caja(app).children.length, 0); igual(caja(app).style.display, "none"); igual(nuevo.value, "");
      await generar(app, UUID(120)); const c3 = campo(app); ok(c3.value); app.$('.nav-item[data-view="ajustes"]').click(); await esperarHasta(() => c3.value === "", { desc: "retirado al salir de la pantalla" });
      igual(c3.value, "", "al salir de la pantalla el enlace se retira"); app.$('.nav-item[data-view="usuarios"]').click(); await esperarHasta(() => app.$$(".u-enlace").length > 0, { desc: "volver a Usuarios" }); igual(caja(app).children.length, 0, "al volver no hay enlace");
      await generar(app, UUID(122)); const c4 = campo(app); ok(c4.value); await app.win.Auth.cerrarSesion(); await pausa(100); igual(c4.value, "", "cerrar sesión retira el enlace"); igual(caja(app).children.length, 0);
      return { reemplazo: true, cerrar: true, salirDeVista: true, cerrarSesion: true };
    }, { grupo: "OBS-9" });

    await B.caso("OBS-9 · Usuarios: el enlace NO se guarda en localStorage, sessionStorage, IndexedDB (contenido real), consola ni bitácora; y NO se pinta con innerHTML", async () => {
      const { app } = await abrirAdmin(); await generar(app, UUID(120)); botonDe(app, "Copiar enlace").click(); await pausa(300);
      const enlace = campo(app).value, tok = tokenDe(enlace); ok(tok && tok.length > 8);
      mismo(await almacenesContienen(app, tok), [], "el token llegó a un almacén"); mismo(await almacenesContienen(app, "type=recovery"), [], "el enlace llegó a un almacén");
      ok(!JSON.stringify(B.H.consola).includes(tok) && !JSON.stringify(B.H.errores).includes(tok), "el token llegó a la consola"); ok(!app.$("#usuariosCuerpo").innerHTML.includes(tok), "el enlace está en el HTML serializado (debe vivir solo como `value` del campo)");
      const bitacora = await app.win.eval("DB.getAll('auditoria')"); ok(!JSON.stringify(bitacora).includes(tok), "el enlace llegó a la bitácora");
      return { almacenesRevisados: "localStorage, sessionStorage, IndexedDB" };
    }, { grupo: "OBS-9" });

    await B.caso("OBS-9 · Usuarios: errores del servidor y payloads XSS se ven como TEXTO (sin markup, canario sin ejecutar) y no dejan caja", async () => {
      const hostil = '<img src=x onerror="window.__xss=41"><svg onload="window.__xss=42">';
      const { app } = await abrirAdmin({ respuesta: () => ({ status: 409, body: { error: hostil } }) }); app.win.__xss = 0; await generar(app, UUID(120)); await pausa(500);
      const t = app.$$("#toastWrap .toast").pop(); igual(t.textContent, hostil, "el texto se ve literal"); igual(t.querySelectorAll("img,svg,script").length, 0); igual(app.win.__xss, 0, "canario"); igual(caja(app).children.length, 0); igual(caja(app).style.display, "none");
      const b = app.$$(".u-enlace")[0]; ok(!b.disabled, "el botón se libera"); app.cerrar();
      const a2 = await abrirAdmin({ respuesta: () => ({ status: 200, body: { enlaceParaEstablecerClave: 'https://x.example.test/"><svg/onload=window.__xss=43>#a=1' } }) }); a2.app.win.__xss = 0; await generar(a2.app, UUID(120)); await pausa(400);
      igual(campo(a2.app).value, 'https://x.example.test/"><svg/onload=window.__xss=43>#a=1', "solo como value"); igual(a2.app.win.__xss, 0); igual(caja(a2.app).querySelectorAll("svg,img,script").length, 0); a2.app.cerrar();
      const a3 = await abrirAdmin({ respuesta: () => ({ status: 200, body: { enlaceParaEstablecerClave: "javascript:alert(1)" } }) }); a3.app.win.__xss = 0; await generar(a3.app, UUID(120)); await pausa(400);
      igual(a3.app.$$("#cardEnlaceRecuperacion input").length, 0, "un enlace que no es http(s) no se muestra"); ok(toasts(a3.app).some((x) => /no devolvió un enlace utilizable/.test(x)));
      return { xss: 0 };
    }, { grupo: "OBS-9" });
  }

  // ═══════════════════════ Ambos productos: ayuda del login y texto de recovery ═══════════════════════
  await B.caso("OBS-9 · Login: la ayuda «¿Olvidaste tu contraseña?…» se ve completa en escritorio y en móvil, debajo del formulario, sin campos nuevos ni promesa de correo", async () => {
    const app = await B.abrirApp({ modoDatos: null }); igual(await B.esperarArranque(app), "login", "pantalla de login"); const out = {};
    for (const [n, w, h] of [["escritorio 1280×800", 1280, 800], ["móvil 390×844", 390, 844]]) {
      await tamano(app, w, h); const a = app.$("#loginAyuda"), f = app.$("#loginForm"), tarjeta = app.$("#gateLogin .gate-card"), ra = a.getBoundingClientRect(), rf = f.getBoundingClientRect(), rt = tarjeta.getBoundingClientRect(), vw = app.win.innerWidth;
      igual(a.textContent, HELP, `${n}: texto`); ok(ra.width > 0 && ra.height > 0, `${n}: visible`); ok(ra.top >= rf.bottom - 1, `${n}: debajo del formulario`); ok(ra.left >= rt.left - 1 && ra.right <= rt.right + 1, `${n}: dentro de la tarjeta`);
      ok(ra.right <= vw && app.doc.documentElement.scrollWidth <= vw, `${n}: sin desborde horizontal`); ok(parseFloat(app.win.getComputedStyle(a).fontSize) >= 12, `${n}: fuente legible (${app.win.getComputedStyle(a).fontSize})`);
      ok(a.scrollWidth <= a.clientWidth + 1, `${n}: el texto no se recorta`); out[n] = { ancho: Math.round(ra.width), alto: Math.round(ra.height) };
    }
    mismo([...app.$$("#gateLogin input")].map((i) => i.id), ["loginUser", "loginPass"], "sin campos nuevos"); igual(app.$$("#gateLogin form").length, 1); ok(!/enviar[eé]mos|te enviamos|por correo/i.test(app.$("#gateLogin").textContent), "no promete correo");
    return out;
  }, { grupo: "OBS-9" });

  await B.caso("OBS-9 · Recovery: un enlace type=recovery dice «Elige tu contraseña…» (nunca «invitado»); type=invite conserva «Has sido invitado…»; caducado/gastado pide otro al administrador", async () => {
    for (const [tipo, esperado] of [["recovery", INTRO.recovery], ["invite", INTRO.invite]]) {
      const app = await B.abrirApp({ hash: (s) => `#access_token=${s.emitirRecuperacion(C.cajeroActivo.correo)}&type=${tipo}&expires_in=3600` }); igual(await B.esperarArranque(app), "recuperacion", tipo);
      await esperarHasta(() => app.$("#rcvForm"), { desc: "formulario de contraseña" }); igual(app.$("#rcvIntro").textContent, esperado, tipo); if (tipo === "recovery") ok(!/invitad/i.test(app.$("#gateRecovery").textContent), "recovery no dice «invitado»"); app.cerrar();
    }
    const e = await B.abrirApp({ hash: "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired" }); igual(await B.esperarArranque(e), "recuperacion");
    ok(/Solicita al administrador que genere un nuevo enlace\./.test(e.$("#rcvCuerpo").textContent), "pide otro enlace al administrador"); igual(e.$("#rcvIntro").textContent, INTRO.recovery);
    return { recovery: true, invite: true, caducado: true };
  }, { grupo: "OBS-9" });

  // ═══════════════════════ Recorrido completo por producto ═══════════════════════
  if (taller) {
    await B.caso("OBS-9 · EXTREMO A EXTREMO (Taller): el admin genera el enlace de un CAJERO → se abre en el Taller → contraseña nueva → entra como cajero (contraseña nunca visible)", async () => {
      const { app: admin } = await abrirAdmin(); await generar(admin, UUID(120)); const enlace = campo(admin).value, tok = tokenDe(enlace), correo = C.cajeroActivo.correo; admin.cerrar();
      igual(new URL(enlace).origin, location.origin, "un cajero aterriza en el Taller (este origen)");
      const app = await B.abrirApp({ hash: hashDe(enlace), servidor: (s) => s._recuperacion.set(tok, { correo, vigente: true }) }); igual(await B.esperarArranque(app), "recuperacion");
      await esperarHasta(() => app.$("#rcvForm"), { desc: "formulario" }); ok(new RegExp(`Cuenta: ${correo.replace(".", "\\.")}`).test(app.$("#rcvCuerpo").textContent), "la cuenta del enlace"); igual(app.$("#rcvIntro").textContent, INTRO.recovery);
      const r = await enviarClave(B, app); ok(/Contraseña establecida correctamente\./.test(r.cuerpo), `resultado: ${r.cuerpo}`); igual(B.H.servidor.clavesEstablecidas.length, 1);
      app.$("#rcvVolver").click(); await esperarHasta(() => { const d = fresca(app); return d.activo("gateLogin") && d.$("#loginForm"); }, { desc: "login tras «Ir a iniciar sesión»" }); await pausa(400);
      // la contraseña sintética elegida es el canario: se usa para entrar (nunca se imprime)
      const n = fresca(app); n.$("#loginUser").value = correo; n.$("#loginPass").value = B.CANARIO; n.$("#loginForm").requestSubmit();
      await esperarHasta(() => fresca(app).activo("shell"), { ms: 15000, desc: "entra al Taller" }); const f = fresca(app); igual(f.win.eval("currentUser.rol"), "cajero", "entra como cajero");
      igual(B.buscarCanario(f).dom, "AUSENTE", "la contraseña no queda en el DOM"); igual(B.buscarCanario(f).localStorage, "AUSENTE"); igual(B.buscarCanario(f).sessionStorage, "AUSENTE"); igual(B.buscarCanario(f).consola, "AUSENTE");
      return { rol: "cajero", producto: "taller" };
    }, { grupo: "OBS-9" });
  } else {
    await B.caso("OBS-9 · EXTREMO A EXTREMO (Mi Trabajo): enlace de un MECÁNICO (generado por el servidor) → se abre en Mi Trabajo → contraseña nueva → entra a Mi Trabajo como mecánico", async () => {
      const correo = C.mecanicoActivo.correo; let tok;
      const app = await B.abrirApp({ hash: (s) => { tok = s.emitirRecuperacion(correo); return `#access_token=${tok}&type=recovery&expires_in=3600`; } }); igual(await B.esperarArranque(app), "recuperacion");
      await esperarHasta(() => app.$("#rcvForm"), { desc: "formulario" }); igual(app.$("#rcvIntro").textContent, INTRO.recovery); ok(!/invitad/i.test(app.$("#gateRecovery").textContent));
      const r = await enviarClave(B, app); ok(/Contraseña establecida correctamente\./.test(r.cuerpo), `resultado: ${r.cuerpo}`);
      app.$("#rcvVolver").click(); await esperarHasta(() => { const d = fresca(app); return d.activo("gateLogin") && d.$("#loginForm"); }, { desc: "login" }); await pausa(400);
      const n = fresca(app); n.$("#loginUser").value = correo; n.$("#loginPass").value = B.CANARIO; n.$("#loginForm").requestSubmit();
      await esperarHasta(() => fresca(app).activo("shell"), { ms: 15000, desc: "entra a Mi Trabajo" }); const f = fresca(app); igual(f.win.eval("currentUser.rol"), "mecanico", "entra como mecánico"); ok(f.activo("view-mi-trabajo"), "abre Mi Trabajo");
      igual(B.buscarCanario(f).dom, "AUSENTE"); igual(B.buscarCanario(f).localStorage, "AUSENTE"); igual(B.buscarCanario(f).sessionStorage, "AUSENTE"); igual(B.buscarCanario(f).consola, "AUSENTE");
      return { rol: "mecanico", producto: "mi-trabajo" };
    }, { grupo: "OBS-9" });
  }
}
