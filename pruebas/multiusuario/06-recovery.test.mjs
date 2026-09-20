// taller-demo/recovery.js REAL + Auth + supabase-client + el arranque de app.js: el enlace de un solo uso con el que
// una persona recien dada de alta elige SU contraseña. Solo Supabase sintetico; ningun enlace ni token real.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { sinFugas, crearEntorno } from "./helpers/entorno.mjs";
import { marcadoPeligroso } from "./helpers/dom.mjs";
import { nuevoEntorno, activo, CUENTAS } from "./helpers/flujos.mjs";
import { crearServidor } from "./helpers/supabase-mock.mjs";

const CORREO = "persona-nueva@example.test";
const CLAVE_BUENA = "Clave-Sintetica-9";
const XSS = ['<img src=x onerror=alert(1)>', "<script>alert(1)</script>", `"'><svg onload=alert(1)>`];

/** Entorno con un enlace de recuperacion en la URL. `forma` decide como llega el token. */
function conEnlace({ forma = "sesion", servidor = crearServidor(), tipo = "recovery", token, hashTok, correo = CORREO, producto = "admin", ...resto } = {}) {
  const tok = token ?? servidor.emitirRecuperacion(correo, hashTok ? { hash: hashTok } : {});
  const enlaces = {
    sesion: { hash: `#access_token=${tok}&type=${tipo}&expires_in=3600` },
    canje: { search: `?token_hash=${hashTok || "hash-sintetico-1"}&type=${tipo}` },
    canjeEnHash: { hash: `#token_hash=${hashTok || "hash-sintetico-1"}&type=${tipo}` },
  };
  const eventos = [];
  const env = nuevoEntorno({ servidor, producto, ...(enlaces[forma] || {}), ...resto });
  env.win.Auth?.alCambiar((e) => eventos.push(e));
  env.eventos = eventos; env.tok = tok;
  return env;
}
const formulario = (env) => env.doc.getElementById("rcvForm");
async function escribir(env, a, b) { env.doc.getElementById("rcvClave").value = a; env.doc.getElementById("rcvClave2").value = b; await formulario(env).disparar("submit"); await env.asentar(); }
const errorVisible = (env) => env.doc.getElementById("rcvError").textContent;
const cuerpo = (env) => env.doc.getElementById("rcvCuerpo").innerHTML;
const llamadasSb = (env) => env.servidor.llamadas.filter((l) => l.host === "supabase");
const urlLimpiada = (env) => env.navegaciones.some((n) => n.tipo === "replaceState");

describe("detectar() — que trae la URL", () => {
  const detectar = (o) => nuevoEntorno(o).win.RecuperarClave.detectar();
  test("(b) fragmento con sesion: access_token + type=recovery", () => assert.deepEqual(JSON.parse(JSON.stringify(detectar({ hash: "#access_token=T1&type=recovery" }))), { que: "sesion", token: "T1", verificacion: "recovery" }));
  test("(b) type=invite tambien es un alta", () => assert.equal(detectar({ hash: "#access_token=T1&type=invite" }).que, "sesion"));
  test("type=magiclink NO es una recuperacion (es un acceso directo): se ignora", () => assert.equal(detectar({ hash: "#access_token=T1&type=magiclink" }).que, "ninguno"));
  test("access_token sin type, o con type desconocido, se ignora", () => { for (const h of ["#access_token=T1", "#access_token=T1&type=signup", "#access_token=T1&type="]) assert.equal(detectar({ hash: h }).que, "ninguno", h); });
  test("(c) token_hash en la query o en el fragmento, con type valido", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(detectar({ search: "?token_hash=H1&type=recovery" }))), { que: "canje", tokenHash: "H1", verificacion: "recovery" });
    assert.equal(detectar({ hash: "#token_hash=H1&type=invite" }).que, "canje"); assert.equal(detectar({ search: "?token_hash=H1&type=magiclink" }).que, "ninguno"); assert.equal(detectar({ search: "?token_hash=H1" }).que, "ninguno");
  });
  test("(a) error de Supabase: tiene prioridad sobre un access_token que venga en la misma URL", () => {
    const d = detectar({ hash: "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid&access_token=T1&type=recovery" });
    assert.equal(d.que, "error"); assert.equal(d.codigo, "otp_expired");
  });
  test("(a) error tambien en la query", () => assert.equal(detectar({ search: "?error=server_error&error_description=x" }).que, "error"));
  test("(d) PKCE: ?code=<uuid> se reconoce; un code que no es UUID se ignora", () => {
    assert.equal(detectar({ search: "?code=123e4567-e89b-42d3-a456-426614174000" }).que, "pkce");
    for (const c of ["abc", "123e4567", "' OR 1=1 --", "<script>"]) assert.equal(detectar({ search: `?code=${encodeURIComponent(c)}` }).que, "ninguno", c);
  });
  test("sin parametros: ninguno, y hayEnlace() es false", () => { const e = nuevoEntorno({}); assert.equal(e.win.RecuperarClave.detectar().que, "ninguno"); assert.equal(e.win.RecuperarClave.hayEnlace(), false); });
  test("la lectura de la URL se hace UNA sola vez (cambiar la URL despues no cambia el resultado)", () => {
    const e = nuevoEntorno({ hash: "#access_token=T1&type=recovery" }); assert.equal(e.win.RecuperarClave.detectar().que, "sesion");
    e.win.location.hash = ""; assert.equal(e.win.RecuperarClave.detectar().que, "sesion"); e.win.RecuperarClave._olvidarDeteccion(); assert.equal(e.win.RecuperarClave.detectar().que, "ninguno");
  });
  test("parametros mal formados no revientan", () => { for (const h of ["#%E0%A4%A", "#&&&==", "#access_token", "#=&="]) assert.doesNotThrow(() => detectar({ hash: h }), h); });
});

describe("iniciar() — enlaces que NO se pueden completar", () => {
  test("sin enlace: iniciar() devuelve false y no toca la pantalla ni la red", () => {
    const e = nuevoEntorno({}); assert.equal(e.win.RecuperarClave.iniciar(), false); assert.equal(activo(e, "gateRecovery"), false); assert.equal(e.servidor.llamadas.length, 0);
  });
  test("error de Supabase (enlace caducado/gastado): pantalla de «no valido o expirado», URL limpiada y CERO llamadas", async () => {
    const e = nuevoEntorno({ hash: "#error=access_denied&error_code=otp_expired&error_description=x" }); await e.asentar();
    assert.equal(activo(e, "gateRecovery"), true); assert.match(cuerpo(e), /Enlace no válido o expirado/); assert.match(cuerpo(e), /un solo uso/); assert.equal(e.servidor.llamadas.length, 0); assert.equal(urlLimpiada(e), true);
    assert.equal(e.doc.getElementById("rcvForm").oyentes("submit").length, 0, "no debe haber formulario");
  });
  test("otro error (no caducidad): titulo «Enlace no valido» a secas", async () => {
    const e = nuevoEntorno({ hash: "#error=server_error&error_code=unexpected_failure" }); await e.asentar(); assert.match(cuerpo(e), /<b>Enlace no válido<\/b>/);
  });
  test("XSS: error_description y error_code NUNCA se pintan (texto fijo), sea lo que sea que traiga la URL", async () => {
    for (const p of XSS) {
      const e = nuevoEntorno({ hash: `#error=access_denied&error_code=${encodeURIComponent(p)}&error_description=${encodeURIComponent(p)}` }); await e.asentar();
      assert.ok(!cuerpo(e).includes("alert(1)"), p); assert.deepEqual(marcadoPeligroso(cuerpo(e)), []);
    }
  });
  test("PKCE: mensaje propio, sin llamadas, URL limpiada", async () => {
    const e = nuevoEntorno({ search: "?code=123e4567-e89b-42d3-a456-426614174000" }); await e.asentar();
    assert.match(cuerpo(e), /Este enlace no se puede completar aquí/); assert.equal(e.servidor.llamadas.length, 0); assert.equal(urlLimpiada(e), true);
  });
  test("sin conexion: «Sin conexion» + «Reintentar» (recarga); NO se llama a nadie y el enlace NO se descarta de la URL", async () => {
    const e = conEnlace({ online: false }); await e.asentar();
    assert.match(cuerpo(e), /<b>Sin conexión<\/b>/); assert.equal(e.servidor.llamadas.length, 0); assert.equal(urlLimpiada(e), false, "el enlace sigue en la barra para poder reintentar");
    await e.doc.getElementById("rcvVolver").disparar("click"); assert.equal(e.navegaciones.some((n) => n.tipo === "reload"), true);
  });
  test("Supabase sin configurar (config nula): explica que no se puede comprobar el enlace y no lo intenta", async () => {
    const e = crearEntorno({ config: null, hash: "#access_token=T1&type=recovery", scripts: ["build-target", "supabase-client", "auth", "recovery", "app"] }); await e.asentar();
    assert.match(e.doc.getElementById("rcvCuerpo").innerHTML, /No se puede comprobar el enlace/); assert.equal(e.servidor.llamadas.length, 0);
  });
  test("token desconocido o gastado: «no valido o expirado», sin formulario, URL limpiada, y NO se abre sesion", async () => {
    for (const tok of ["token-inventado", null]) {
      const s = crearServidor(); const t = tok ?? s.emitirRecuperacion(CORREO); if (!tok) s._recuperacion.get(t).vigente = false;
      const e = conEnlace({ servidor: s, token: t }); await e.asentar();
      assert.match(cuerpo(e), /Enlace no válido o expirado/); assert.equal(e.win.Auth.enRecuperacion(), false); assert.equal(urlLimpiada(e), true);
      assert.equal(e.almacen.getItem("entimotors_sb_sesion"), null); assert.equal(e.almacen.getItem("enti_session"), null); assert.deepEqual(e.eventos, []);
    }
  });
  test("token_hash gastado o desconocido: «no valido o expirado», sin sesion", async () => {
    const s = crearServidor(); s.emitirRecuperacion(CORREO, { hash: "hash-gastado" }); s.gastarHash("hash-gastado");
    for (const h of ["hash-gastado", "hash-que-no-existe"]) { const e = conEnlace({ servidor: s, forma: "canje", hashTok: h, token: "x" }); await e.asentar(); assert.match(cuerpo(e), /Enlace no válido o expirado/, h); assert.equal(e.win.Auth.enRecuperacion(), false); }
  });
  test("token_hash: red caida al canjear → «Sin conexion», no «enlace invalido»", async () => {
    const s = crearServidor(); s.red = "caida"; const e = conEnlace({ servidor: s, forma: "canje", hashTok: "h2" }); await e.asentar();
    assert.match(cuerpo(e), /<b>Sin conexión<\/b>/); assert.equal(e.win.Auth.enRecuperacion(), false);
  });
  test("token: red caida al comprobarlo → «Sin conexion»", async () => {
    const s = crearServidor(); s.red = "caida"; const e = conEnlace({ servidor: s }); await e.asentar(); assert.match(cuerpo(e), /<b>Sin conexión<\/b>/);
  });
});

describe("el flujo completo: enlace valido → contraseña nueva", () => {
  test("(b) enlace con sesion: comprueba el token contra el servidor (con el token de RECUPERACION), emite PASSWORD_RECOVERY y muestra el formulario con la cuenta", async () => {
    const e = conEnlace({}); await e.asentar();
    assert.equal(activo(e, "gateRecovery"), true); assert.match(cuerpo(e), /Cuenta: <b>persona-nueva@example\.test<\/b>/); assert.ok(formulario(e).oyentes("submit").length === 1);
    const l = llamadasSb(e).filter((x) => x.ruta === "/auth/v1/user"); assert.deepEqual(l.map((x) => [x.metodo, x.auth]), [["GET", "recuperacion"]]);
    assert.equal(e.win.Auth.enRecuperacion(), true); assert.equal(e.win.Auth.correoEnRecuperacion(), CORREO); assert.deepEqual(e.eventos, ["PASSWORD_RECOVERY"]);
  });
  test("(c) token_hash en la query: primero POST /auth/v1/verify, luego comprueba el token recibido y muestra el formulario", async () => {
    const s = crearServidor(); const e = conEnlace({ servidor: s, forma: "canje", hashTok: "hash-ok" }); await e.asentar();
    const l = llamadasSb(e); assert.deepEqual(l.map((x) => `${x.metodo} ${x.ruta} ${x.auth}`), ["POST /auth/v1/verify ninguno", "GET /auth/v1/user recuperacion"], "el canje va con apikey publica y SIN Authorization"); assert.equal(l[0].apikey, "anon"); assert.deepEqual(l[0].cuerpo, { type: "recovery", token_hash: `«len:${"hash-ok".length}»` }, "el registro del mock enmascara token_hash");
    assert.match(cuerpo(e), /Cuenta: <b>/); assert.equal(e.win.Auth.enRecuperacion(), true);
  });
  test("(c) token_hash en el fragmento y tipo invite: mismo camino", async () => {
    const e = conEnlace({ forma: "canjeEnHash", tipo: "invite", hashTok: "hash-inv" }); await e.asentar(); assert.match(cuerpo(e), /rcvForm/); assert.equal(llamadasSb(e)[0].cuerpo.type, "invite");
  });
  test("el arranque de app.js SALE al ver el enlace: no muestra instalar ni login y NO abre ninguna base", async () => {
    const e = conEnlace({ standalone: false, preparar: (env) => { env.doc.getElementById("gateInstall").classList.add("active"); env.doc.getElementById("gateLogin").classList.add("active"); } }); await e.asentar();
    assert.equal(activo(e, "gateRecovery"), true); assert.equal(activo(e, "gateInstall"), false); assert.equal(activo(e, "gateLogin"), false); assert.equal(e.startApp.length, 0); assert.deepEqual(e.idbAbiertas, []);
  });
  test("con una sesion de OTRA persona guardada en el dispositivo, el enlace NO arranca su app y no consulta su perfil", async () => {
    const admin = CUENTAS.adminActivo, s = crearServidor(); const tok = s.emitirRecuperacion(CORREO);
    const e = nuevoEntorno({ servidor: s, cuenta: admin, sesionGuardada: { user: admin.correo, rol: "admin", origen: "supabase", perfilId: admin.uid, activo: true }, hash: `#access_token=${tok}&type=recovery` }); await e.asentar();
    assert.equal(e.startApp.length, 0); assert.deepEqual(e.idbAbiertas, []); assert.equal(llamadasSb(e).filter((x) => /perfiles|rpc/.test(x.ruta)).length, 0); assert.match(cuerpo(e), /Cuenta: <b>/);
  });
  test("mismo flujo en el producto Mi Trabajo", async () => {
    const e = conEnlace({ producto: "mecanico" }); await e.asentar(); assert.match(cuerpo(e), /Cuenta: <b>/); assert.equal(e.win.Auth.enRecuperacion(), true);
  });
  test("XSS: un correo hostil devuelto por el servidor se pinta ESCAPADO en «Cuenta:»", async () => {
    for (const p of XSS) { const e = conEnlace({ correo: p }); await e.asentar(); assert.deepEqual(marcadoPeligroso(cuerpo(e)), [], p); assert.match(cuerpo(e), /Cuenta: <b>/); }
  });
  test("el formulario NO se rellena de antemano y pide contraseña con autocomplete new-password", async () => {
    const e = conEnlace({}); await e.asentar(); const h = cuerpo(e);
    assert.equal((h.match(/type="password"/g) || []).length, 2); assert.equal((h.match(/autocomplete="new-password"/g) || []).length, 2); assert.ok(!/value=/.test(h));
  });
});

describe("validacion y envio de la contraseña", () => {
  const listo = async (o = {}) => { const e = conEnlace(o); await e.asentar(); return e; };
  const puts = (e) => llamadasSb(e).filter((l) => l.metodo === "PUT");
  for (const [nombre, a, b, msg] of [
    ["vacia", "", "", "Escribe una contraseña."], ["muy corta (7)", "abcdefg", "abcdefg", "La contraseña debe tener al menos 8 caracteres."],
    ["no coinciden", CLAVE_BUENA, CLAVE_BUENA + "x", "Las dos contraseñas no coinciden."], ["confirmacion vacia", CLAVE_BUENA, "", "Las dos contraseñas no coinciden."],
  ]) test(`${nombre}: «${msg}» y NO se envia nada`, async () => { const e = await listo(); await escribir(e, a, b); assert.equal(errorVisible(e), msg); assert.equal(puts(e).length, 0); assert.equal(e.win.Auth.enRecuperacion(), true); });
  test("exactamente 8 caracteres es valido", async () => { const e = await listo(); await escribir(e, "abcdefgh", "abcdefgh"); assert.equal(puts(e).length, 1); });
  test("un error de validacion se borra al corregirlo", async () => {
    const e = await listo(); await escribir(e, "abc", "abc"); assert.notEqual(errorVisible(e), ""); await escribir(e, CLAVE_BUENA, CLAVE_BUENA); assert.equal(errorVisible(e), "");
  });
  test("EXITO: PUT /auth/v1/user en Supabase con el token de recuperacion; campos vaciados; «establecida correctamente»; URL limpiada", async () => {
    const e = await listo(); await escribir(e, CLAVE_BUENA, CLAVE_BUENA);
    const [p] = puts(e); assert.deepEqual([p.host, p.ruta, p.auth], ["supabase", "/auth/v1/user", "recuperacion"]); assert.deepEqual(p.cuerpo, { password: `«len:${CLAVE_BUENA.length}»` });
    assert.deepEqual(e.servidor.clavesEstablecidas, [CLAVE_BUENA.length]);
    assert.equal(e.doc.getElementById("rcvClave").value, ""); assert.equal(e.doc.getElementById("rcvClave2").value, "");
    assert.match(cuerpo(e), /Contraseña establecida correctamente\./); assert.match(cuerpo(e), /Ir a iniciar sesión/); assert.equal(urlLimpiada(e), true);
  });
  test("EXITO: sale del modo recuperacion, avisa SIGNED_OUT y NO deja iniciada ninguna sesion", async () => {
    const e = await listo(); await escribir(e, CLAVE_BUENA, CLAVE_BUENA);
    assert.equal(e.win.Auth.enRecuperacion(), false); assert.deepEqual(e.eventos, ["PASSWORD_RECOVERY", "SIGNED_OUT"]);
    assert.equal(e.win.Auth.estado().conSesion, false); assert.equal(e.almacen.getItem("entimotors_sb_sesion"), null); assert.equal(e.almacen.getItem("enti_session"), null); assert.equal(e.startApp.length, 0);
  });
  test("EXITO: la contraseña y el token NO aparecen en almacenamiento, consola ni HTML; nada va al api-server de ENTIMOTORS", async () => {
    const e = await listo(); await escribir(e, CLAVE_BUENA, CLAVE_BUENA);
    sinFugas(e, [CLAVE_BUENA, e.tok]); assert.equal(e.servidor.llamadas.filter((l) => l.host === "api").length, 0);
    for (const v of Object.values(e.almacen.volcado())) assert.ok(!v.includes(CLAVE_BUENA) && !v.includes(e.tok)); for (const v of Object.values(e.almacenSesion.volcado())) assert.ok(!v.includes(CLAVE_BUENA) && !v.includes(e.tok));
    assert.ok(!JSON.stringify(e.consola).includes(CLAVE_BUENA)); assert.ok(!e.doc.sumideros.some((s) => s.html.includes(CLAVE_BUENA)));
  });
  test("EXITO: el enlace es de UN SOLO USO — abrirlo otra vez (mismo servidor) ya no sirve", async () => {
    const s = crearServidor(); const e = await listo({ servidor: s }); await escribir(e, CLAVE_BUENA, CLAVE_BUENA);
    const e2 = nuevoEntorno({ servidor: s, hash: `#access_token=${e.tok}&type=recovery` }); await e2.asentar();
    assert.match(cuerpo(e2), /Enlace no válido o expirado/); assert.equal(e2.win.Auth.enRecuperacion(), false);
  });
  test("EXITO: sin la contraseña vieja ni datos de sesion previos en ninguna llamada", async () => {
    const e = await listo(); await escribir(e, CLAVE_BUENA, CLAVE_BUENA); assert.ok(llamadasSb(e).every((l) => l.auth !== "sesion"));
  });
  test("«Ir a iniciar sesion»: sale de recuperacion, limpia la URL y recarga en la ruta base (el arranque normal decide)", async () => {
    const e = await listo(); await escribir(e, CLAVE_BUENA, CLAVE_BUENA); await e.doc.getElementById("rcvVolver").disparar("click");
    const r = e.navegaciones.filter((n) => n.tipo === "replace"); assert.deepEqual(r.map((n) => n.url), ["/index.html"]);
  });
  test("el servidor rechaza la contraseña (politica): se muestra SU motivo como TEXTO y se puede reintentar", async () => {
    for (const p of ["Password is known to be weak", ...XSS]) {
      const e = await listo(); const f = e.win.fetch;
      e.win.fetch = (u, i) => (i?.method === "PUT" ? Promise.resolve(new Response(JSON.stringify({ message: p }), { status: 422 })) : f(u, i));
      await escribir(e, CLAVE_BUENA, CLAVE_BUENA);
      assert.equal(errorVisible(e), p); assert.deepEqual(marcadoPeligroso(e.doc.sumideros.map((s) => s.html).join("")), []);
      assert.equal(e.win.Auth.enRecuperacion(), true, "sigue en recuperacion: puede reintentar"); assert.equal(e.doc.getElementById("rcvClave").value, "", "la contraseña se suelta igualmente");
    }
  });
  test("red caida al enviar: la contraseña se suelta, el boton se restaura y se sigue en recuperacion (el TEXTO exacto del aviso «sin conexion» lo fija 12-ffunc1-establecer-clave; F-FUNC-1 CERRADO)", async () => {
    const e = await listo(); e.servidor.red = "caida"; await escribir(e, CLAVE_BUENA, CLAVE_BUENA);
    assert.notEqual(errorVisible(e), "", "debe haber algun aviso"); assert.equal(e.doc.getElementById("rcvClave").value, ""); assert.equal(e.win.Auth.enRecuperacion(), true);
    const b = e.doc.querySelector("#rcvForm button[type=submit]"); assert.equal(b.disabled, false); assert.equal(b.textContent, "Establecer contraseña"); assert.equal(e.servidor.clavesEstablecidas.length, 0);
  });
  test("el enlace se gasta mientras se escribe (401 al enviar): pantalla de «no valido o expirado»", async () => {
    const e = await listo(); e.servidor._recuperacion.get(e.tok).vigente = false; await escribir(e, CLAVE_BUENA, CLAVE_BUENA);
    assert.match(cuerpo(e), /Enlace no válido o expirado/); assert.equal(urlLimpiada(e), true);
  });
  test("«Volver» desde una pantalla de error sale de recuperacion (si la habia) y recarga", async () => {
    const e = await listo(); e.servidor._recuperacion.get(e.tok).vigente = false; await escribir(e, CLAVE_BUENA, CLAVE_BUENA);
    await e.doc.getElementById("rcvVolver").disparar("click"); assert.ok(e.navegaciones.some((n) => n.tipo === "replace"));
  });
  test("si Auth.establecerClave lanzara una excepcion, el boton no se queda en «Guardando…» y se suelta la contraseña", async () => {
    const e = await listo(); e.win.Auth.establecerClave = () => Promise.reject(new Error("x")); await escribir(e, CLAVE_BUENA, CLAVE_BUENA);
    assert.match(errorVisible(e), /No se pudo establecer la contraseña/); assert.equal(e.doc.getElementById("rcvClave").value, ""); assert.equal(e.doc.querySelector("#rcvForm button[type=submit]").textContent, "Establecer contraseña");
  });
  test("Auth.establecerClave fuera de recuperacion se niega (no hay token que usar)", async () => {
    const e = nuevoEntorno({}); const r = await e.win.Auth.establecerClave("abcdefgh"); assert.deepEqual([r.ok, r.motivo], [false, "sin-recuperacion"]); assert.equal(e.servidor.llamadas.length, 0);
  });
  test("el token de recuperacion vive SOLO en memoria: recargar (entorno nuevo, mismo almacenamiento) no lo recupera", async () => {
    const e = await listo(); const previo = e.almacen.volcado();
    const e2 = nuevoEntorno({ servidor: e.servidor, storageExtra: previo }); await e2.asentar();
    assert.equal(e2.win.Auth.enRecuperacion(), false); assert.ok(!JSON.stringify(previo).includes(e.tok));
  });
});

describe("mutantes de recovery / auth / arranque: cada garantia se ROMPE si se altera la linea que la sostiene", () => {
  const cambiar = (de, a) => (t) => t.replace(de, a);
  const listo = async (o = {}) => { const e = conEnlace(o); await e.asentar(); return e; };
  const PROPIEDADES = {
    "magiclink no es una recuperacion": (m) => nuevoEntorno({ hash: "#access_token=T1&type=magiclink", mutar: m }).win.RecuperarClave.detectar().que === "ninguno",
    "una contraseña corta no se envia": async (m) => { const e = await listo({ mutar: m }); await escribir(e, "abc", "abc"); return llamadasSb(e).filter((l) => l.metodo === "PUT").length === 0; },
    "una confirmacion distinta no se envia": async (m) => { const e = await listo({ mutar: m }); await escribir(e, CLAVE_BUENA, "otra-cosa-1"); return llamadasSb(e).filter((l) => l.metodo === "PUT").length === 0; },
    "la contraseña se suelta tras enviar": async (m) => { const e = await listo({ mutar: m }); await escribir(e, CLAVE_BUENA, CLAVE_BUENA); return e.doc.getElementById("rcvClave").value === "" && e.doc.getElementById("rcvClave2").value === ""; },
    "la URL se limpia al terminar": async (m) => { const e = await listo({ mutar: m }); await escribir(e, CLAVE_BUENA, CLAVE_BUENA); return urlLimpiada(e); },
    "el correo se pinta escapado": async (m) => { const e = await listo({ correo: XSS[0], mutar: m }); return marcadoPeligroso(cuerpo(e)).length === 0; },
    "un enlace gastado no muestra el formulario": async (m) => { const s = crearServidor(); const t = s.emitirRecuperacion(CORREO); s._recuperacion.get(t).vigente = false; const e = conEnlace({ servidor: s, token: t, mutar: m }); await e.asentar(); return e.win.Auth.enRecuperacion() === false; },
    "tras el exito no se queda en modo recuperacion": async (m) => { const e = await listo({ mutar: m }); await escribir(e, CLAVE_BUENA, CLAVE_BUENA); return e.win.Auth.enRecuperacion() === false; },
    "el enlace pausa el arranque normal (no abre la app de otra persona)": async (m) => {
      const a = CUENTAS.adminActivo, s = crearServidor(), t = s.emitirRecuperacion(CORREO);
      const e = nuevoEntorno({ servidor: s, cuenta: a, sesionGuardada: { user: a.correo, rol: "admin", origen: "supabase", perfilId: a.uid, activo: true }, hash: `#access_token=${t}&type=recovery`, mutar: m }); await e.asentar(); return e.startApp.length === 0;
    },
    "el error de la URL nunca se pinta": async (m) => { const e = nuevoEntorno({ hash: `#error=access_denied&error_code=x&error_description=${encodeURIComponent("<img src=x onerror=alert(1)>")}`, mutar: m }); await e.asentar(); return !cuerpo(e).includes("onerror"); },
  };
  const MUTANTES = [
    ["magiclink no es una recuperacion", "recovery", "aceptar magiclink como alta", cambiar('var TIPOS = ["recovery", "invite"];', 'var TIPOS = ["recovery", "invite", "magiclink"];')],
    ["una contraseña corta no se envia", "recovery", "quitar el minimo de 8", cambiar("if (clave.length < MINIMO) {", "if (false) {")],
    ["una confirmacion distinta no se envia", "recovery", "no comparar la confirmacion", cambiar("if (clave !== copia) {", "if (false) {")],
    ["la contraseña se suelta tras enviar", "recovery", "dejar la contraseña escrita en el formulario", cambiar('      c1.value = ""; c2.value = "";\n      boton.disabled = false; boton.textContent = "Establecer contraseña";\n      if (r.ok)', '      boton.disabled = false; boton.textContent = "Establecer contraseña";\n      if (r.ok)')],
    ["la URL se limpia al terminar", "recovery", "no limpiar la URL tras el exito", cambiar("if (r.ok) { limpiarURL(); estadoListo(); return; }", "if (r.ok) { estadoListo(); return; }")],
    ["el correo se pinta escapado", "recovery", "no escapar el correo", cambiar("Cuenta: <b>' + esc(correo)", "Cuenta: <b>' + (correo)")],
    ["un enlace gastado no muestra el formulario", "auth", "no confirmar el token contra el servidor", (t) => t.replace('return SB.comprobarToken(token).then(function (r) {\n        if (!r.ok) {', 'return SB.comprobarToken(token).then(function (r) {\n        if (false) {')],
    ["tras el exito no se queda en modo recuperacion", "auth", "no olvidar el token tras el exito", cambiar("        recuperacion = null;\n        avisar(\"SIGNED_OUT\");\n        return bien(null);\n      });\n    },\n\n    /* PASO 7", "        avisar(\"SIGNED_OUT\");\n        return bien(null);\n      });\n    },\n\n    /* PASO 7")],
    ["el enlace pausa el arranque normal (no abre la app de otra persona)", "app", "no salir tras iniciar la recuperacion", cambiar("if (RecuperarClave.iniciar()) return;", "RecuperarClave.iniciar();")],
    ["el error de la URL nunca se pinta", "recovery", "pintar error_description en la pantalla", cambiar('"Solicita al administrador que genere un nuevo enlace. " +\n        "Los enlaces son de un solo uso', 'decodeURIComponent(location.hash) + "Solicita al administrador que genere un nuevo enlace. " +\n        "Los enlaces son de un solo uso')],
  ];
  for (const [prop, archivo, que, mut] of MUTANTES) test(`${prop} — mutante: ${que}`, async () => {
    assert.equal(await PROPIEDADES[prop]({}), true, "con el runtime REAL la propiedad debe cumplirse");
    assert.equal(await PROPIEDADES[prop]({ [archivo]: mut }), false, "el mutante SOBREVIVE: ninguna prueba protege esta garantia");
  });
  test("cada propiedad tiene al menos un mutante", () => assert.deepEqual(Object.keys(PROPIEDADES).filter((p) => !MUTANTES.some((m) => m[0] === p)), []));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// OBS-9 · PLAN B (4E-C7-FIX-B) — el texto de la pantalla «Establecer contraseña» distingue INVITE de RECOVERY.
// Los enlaces del alta y de «Generar enlace» son de tipo `recovery`: NO son una invitacion, asi que no dicen «Has sido invitado».
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
import { leer } from "./helpers/entorno.mjs";
const TEXTO_RECOVERY = "Elige tu contraseña para entrar a ENTIMOTORS OS.", TEXTO_INVITE = "Has sido invitado a ENTIMOTORS OS. Crea tu contraseña para activar tu acceso.";
const intro = (env) => env.doc.getElementById("rcvIntro").textContent;
describe("OBS-9 · texto de bienvenida según el tipo de enlace", () => {
  test("type=recovery (alta o «Generar enlace»), enlace con sesión: «Elige tu contraseña…» y NUNCA «invitado»", async () => {
    const e = conEnlace({ tipo: "recovery" }); await e.asentar(); assert.equal(intro(e), TEXTO_RECOVERY); assert.ok(!/invitad/i.test(intro(e)));
  });
  test("type=recovery con token_hash (query y fragmento): el mismo texto", async () => {
    for (const forma of ["canje", "canjeEnHash"]) { const e = conEnlace({ forma, tipo: "recovery", hashTok: `hash-${forma}` }); await e.asentar(); assert.equal(intro(e), TEXTO_RECOVERY, forma); assert.match(cuerpo(e), /rcvForm/, forma); }
  });
  test("type=invite: «Has sido invitado…»", async () => {
    const e = conEnlace({ tipo: "invite" }); await e.asentar(); assert.equal(intro(e), TEXTO_INVITE);
  });
  test("enlace caducado/gastado o PKCE (sin tipo utilizable): texto neutro de recovery, nunca «invitado»; y el mensaje real de «pídele otro al administrador»", async () => {
    const caducado = nuevoEntorno({ hash: "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired" }); await caducado.asentar();
    const pkce = nuevoEntorno({ search: "?code=00000000-0000-4000-8000-000000000001" }); await pkce.asentar();
    for (const e of [caducado, pkce]) { assert.equal(intro(e), TEXTO_RECOVERY); assert.match(cuerpo(e), /Solicita al administrador que genere un nuevo enlace\./); }
  });
  test("token gastado (segunda vez que se abre el mismo enlace): «no válido o expirado» y pide otro al administrador", async () => {
    const s = crearServidor(); const a = conEnlace({ servidor: s }); await a.asentar(); await escribir(a, CLAVE_BUENA, CLAVE_BUENA);
    const b = nuevoEntorno({ servidor: s, hash: `#access_token=${a.tok}&type=recovery` }); await b.asentar();
    assert.match(cuerpo(b), /Enlace no válido o expirado/); assert.match(cuerpo(b), /Solicita al administrador que genere un nuevo enlace\./); assert.equal(intro(b), TEXTO_RECOVERY);
  });
  test("ningún estado de la pantalla promete correo ni «te enviamos…»: la recuperación la hace el administrador", async () => {
    const estados = [];
    for (const o of [{}, { tipo: "invite" }]) { const e = conEnlace(o); await e.asentar(); estados.push(cuerpo(e) + intro(e)); }
    const e2 = conEnlace({}); await e2.asentar(); await escribir(e2, CLAVE_BUENA, CLAVE_BUENA); estados.push(cuerpo(e2));
    const e3 = nuevoEntorno({ hash: "#error=access_denied&error_code=otp_expired" }); await e3.asentar(); estados.push(cuerpo(e3));
    for (const t of estados) assert.ok(!/te enviamos|te hemos enviado|correo electr|revisa tu (bandeja|correo)|enviar[áa] un/i.test(t), t.slice(0, 80));
  });
  test("index.html: el texto de partida es el neutro y «Has sido invitado» ya NO está escrito en el HTML (solo en recovery.js, para type=invite)", () => {
    const html = leer("index.html"), js = leer("recovery.js");
    assert.match(html, /<p class="desc" id="rcvIntro">Elige tu contraseña para entrar a ENTIMOTORS OS\.<\/p>/); assert.ok(!html.includes("Has sido invitado"));
    assert.ok(js.includes(TEXTO_INVITE) && js.includes(TEXTO_RECOVERY) && /d\.verificacion === "invite" \? TEXTO_INTRO\.invite : TEXTO_INTRO\.recovery/.test(js));
  });
  test("MUTANTE: recovery.js usa el texto de invitación para todos los tipos → «invitado» sale con type=recovery", async () => {
    const e = conEnlace({ tipo: "recovery", mutar: { recovery: (t) => t.replace('d.verificacion === "invite" ? TEXTO_INTRO.invite : TEXTO_INTRO.recovery', "TEXTO_INTRO.invite") } }); await e.asentar();
    assert.match(intro(e), /invitado/, "el mutante debe reproducir el defecto");
  });
  test("MUTANTE: recovery.js nunca distingue invite (todos «Elige tu contraseña») → type=invite pierde su texto", async () => {
    const e = conEnlace({ tipo: "invite", mutar: { recovery: (t) => t.replace('d.verificacion === "invite" ? TEXTO_INTRO.invite : TEXTO_INTRO.recovery', "TEXTO_INTRO.recovery") } }); await e.asentar();
    assert.notEqual(intro(e), TEXTO_INVITE);
  });
});
