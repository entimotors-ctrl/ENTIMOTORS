// F-FUNC-1 (4E-C3-FIX2) — REGRESION FUNCIONAL: un fallo de TRANSPORTE al enviar la contraseña de recuperacion llega a
// recovery.js como «sin-conexion» / «tiempo-agotado» (y se ve «Sin conexión con el servidor. Inténtalo otra vez.»), en vez de
// disfrazarse de rechazo del servidor.
// Contrato real (auth.js Auth.establecerClave ← supabase-client.js pedir(), que NUNCA lanza):
//   pedir()                       →  {ok:true} | {ok:false, motivo: sin-permiso (401/403) | error-servidor (otro HTTP) | sin-conexion | tiempo-agotado | desactivado, detalle}
//   Auth.establecerClave (PRE)    →  sin-permiso → «enlace-caducado»; TODO lo demas → «rechazada-por-el-servidor»  ← el defecto
//   Auth.establecerClave (POST)   →  sin-permiso → «enlace-caducado»; sin-conexion / tiempo-agotado → SE CONSERVAN; el resto → «rechazada-por-el-servidor»
//   recovery.js                   →  enlace-caducado → pantalla de enlace no valido; sin-conexion|tiempo-agotado → aviso de red; otro → r.detalle
// Solo Supabase sintetico: ninguna llamada real. La contraseña es sintetica y NUNCA se imprime en un mensaje de fallo.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { sinFugas } from "./helpers/entorno.mjs";
import { marcadoPeligroso } from "./helpers/dom.mjs";
import { nuevoEntorno } from "./helpers/flujos.mjs";
import { crearServidor } from "./helpers/supabase-mock.mjs";

const CORREO = "persona-nueva@example.test";
const CLAVE = "Clave-Sintetica-9";
const AVISO_RED = "Sin conexión con el servidor. Inténtalo otra vez.";
const TEXTO_BOTON = "Establecer contraseña";
const XSS = ["<img src=x onerror=alert(1)>", "<script>alert(1)</script>", `"'><svg onload=alert(1)>`];

/** Entorno con un enlace de recuperacion valido en la URL. `mutar` altera auth.js SOLO en memoria. */
function conEnlace({ servidor = crearServidor(), mutar } = {}) {
  const tok = servidor.emitirRecuperacion(CORREO);
  const env = nuevoEntorno({ servidor, hash: `#access_token=${tok}&type=recovery&expires_in=3600`, ...(mutar ? { mutar: { auth: mutar } } : {}) });
  const eventos = []; env.win.Auth?.alCambiar((e) => eventos.push(e));
  env.eventos = eventos; env.tok = tok;
  return env;
}
const listo = async (o) => { const e = conEnlace(o); await e.asentar(); return e; };
/** Sustituye SOLO el PUT de la contraseña; el resto de llamadas siguen yendo al servidor sintetico. */
const forzarPut = (env, hacer) => { const f = env.win.fetch; env.win.fetch = (u, i) => (i?.method === "PUT" ? hacer(u, i) : f(u, i)); };
const responde = (cuerpo, status, statusText = "") => () => Promise.resolve(new Response(cuerpo, { status, statusText }));
const json = (o, status) => responde(JSON.stringify(o), status);
const rechaza = (err) => () => Promise.reject(err);
const abortada = () => Object.assign(new Error("The user aborted a request."), { name: "AbortError" });

async function escribir(env, a = CLAVE, b = CLAVE) { env.doc.getElementById("rcvClave").value = a; env.doc.getElementById("rcvClave2").value = b; await env.doc.getElementById("rcvForm").disparar("submit"); await env.asentar(); }
const errorVisible = (env) => env.doc.getElementById("rcvError")?.textContent ?? null;
const cuerpo = (env) => env.doc.getElementById("rcvCuerpo").innerHTML;
const boton = (env) => env.doc.querySelector("#rcvForm button[type=submit]");

// Cada escenario: preparar(env) deja al servidor / a la red en ese estado; `clase` decide que debe ver la persona.
//   exito · enlace (401/403) · http (respuesta REAL del servidor) · red (fallo de TRANSPORTE)
const HTTP = (status, mensaje) => [`HTTP ${status} con mensaje del servidor`, (e) => forzarPut(e, json({ message: mensaje }, status)), { ok: false, motivo: "rechazada-por-el-servidor", detalle: mensaje }, "http"];
const ESCENARIOS = [
  ["exito (200)", () => {}, { ok: true }, "exito"],
  ["401: el enlace se gasto mientras se escribia (respuesta real del servidor sintetico)", (e) => { e.servidor._recuperacion.get(e.tok).vigente = false; }, { ok: false, motivo: "enlace-caducado" }, "enlace"],
  ["403", (e) => forzarPut(e, json({ msg: "Forbidden" }, 403)), { ok: false, motivo: "enlace-caducado" }, "enlace"],
  HTTP(400, "Solicitud incorrecta"), HTTP(409, "Conflicto"), HTTP(422, "Password is known to be weak"), HTTP(429, "Demasiadas peticiones"),
  HTTP(500, "Error interno"), HTTP(502, "Bad gateway"), HTTP(503, "Servicio no disponible"),
  ["red caida: fetch rechaza con TypeError(«Failed to fetch») (servidor sintetico)", (e) => { e.servidor.red = "caida"; }, { ok: false, motivo: "sin-conexion", detalle: "Failed to fetch" }, "red"],
  ["tiempo agotado: fetch aborta con AbortError (servidor sintetico)", (e) => { e.servidor.red = "timeout"; }, { ok: false, motivo: "tiempo-agotado", detalle: "The operation was aborted" }, "red"],
  ["red caida con el texto de OTRO navegador (Firefox): la clasificacion no depende del mensaje", (e) => forzarPut(e, rechaza(new TypeError("NetworkError when attempting to fetch resource."))), { ok: false, motivo: "sin-conexion" }, "red"],
  ["AbortError propio (otro texto)", (e) => forzarPut(e, rechaza(abortada())), { ok: false, motivo: "tiempo-agotado" }, "red"],
  ["fetch rechaza sin motivo (undefined)", (e) => forzarPut(e, rechaza(undefined)), { ok: false, motivo: "sin-conexion" }, "red"],
  ["dispositivo sin red (navigator.onLine = false): ni siquiera se llama a fetch", (e) => { e.setOnline(false); }, { ok: false, motivo: "sin-conexion" }, "red"],
];

/** Violaciones del contrato de Auth.establecerClave para un escenario (lista vacia = cumple). */
async function violacionesAuth([, preparar, esperado, clase], mutar) {
  const e = await listo(mutar ? { mutar } : {}); preparar(e); const v = [];
  let r; try { r = await e.win.Auth.establecerClave(CLAVE); } catch (x) { return [`lanzo: ${String(x)}`]; }
  if (r.ok !== esperado.ok) v.push(`ok=${r.ok}, se esperaba ${esperado.ok}`);
  if (esperado.motivo !== undefined && r.motivo !== esperado.motivo) v.push(`motivo=«${r.motivo}», se esperaba «${esperado.motivo}»`);
  if (esperado.detalle !== undefined && r.detalle !== esperado.detalle) v.push(`detalle=«${r.detalle}», se esperaba «${esperado.detalle}»`);
  if (JSON.stringify(r).includes(CLAVE)) v.push("la contraseña aparece en el resultado serializado");
  const sigue = e.win.Auth.enRecuperacion();
  if (clase === "exito") { if (sigue) v.push("tras el exito debe salir de recuperacion"); if (!e.eventos.includes("SIGNED_OUT")) v.push("falta SIGNED_OUT tras el exito"); }
  else if (clase === "red" || clase === "http") { if (!sigue) v.push("tras un fallo reintentable debe seguir en recuperacion"); if (e.eventos.includes("SIGNED_OUT")) v.push("un fallo no debe emitir SIGNED_OUT"); if (e.servidor.clavesEstablecidas.length) v.push("el servidor no debio aplicar la contraseña"); }
  return v;
}

describe("F-FUNC-1 · contrato de Auth.establecerClave: cada fallo llega con SU motivo", () => {
  for (const esc of ESCENARIOS) test(esc[0], async () => { const v = await violacionesAuth(esc); assert.deepEqual(v, [], v.join(" | ")); });
  test("ninguna respuesta HTTP real se disfraza de fallo de red: 400/409/422/429/500/502/503 → «rechazada-por-el-servidor» con el mensaje del servidor intacto", async () => {
    for (const [nombre, prep, esperado, clase] of ESCENARIOS.filter((x) => x[3] === "http")) { const v = await violacionesAuth([nombre, prep, esperado, clase]); assert.deepEqual(v, [], nombre); }
  });
  test("un motivo desconocido del cliente NO se convierte en «sin-conexion» (no se etiqueta como red lo que no se sabe que lo sea)", async () => {
    const e = await listo(); e.win.SupabaseCliente.actualizarUsuario = () => Promise.resolve({ ok: false, motivo: "error-interno-del-cliente", detalle: "x" });
    const r = await e.win.Auth.establecerClave(CLAVE); assert.deepEqual([r.ok, r.motivo, r.detalle], [false, "rechazada-por-el-servidor", "x"]);
  });
  test("una excepcion de PROGRAMACION dentro del cliente no se relabela como red: la promesa sigue rechazandose (recovery.js ya tiene su .catch)", async () => {
    const e = await listo(); e.win.SupabaseCliente.actualizarUsuario = () => Promise.reject(new TypeError("x is not a function"));
    await assert.rejects(() => e.win.Auth.establecerClave(CLAVE)); assert.equal(e.win.Auth.enRecuperacion(), true);
  });
  test("contraste (contrato previo intacto): fuera de recuperacion → «sin-recuperacion»; sin llamadas", async () => {
    const e = nuevoEntorno({}); const r = await e.win.Auth.establecerClave(CLAVE); assert.deepEqual([r.ok, r.motivo], [false, "sin-recuperacion"]); assert.equal(e.servidor.llamadas.length, 0);
  });
});

describe("F-FUNC-1 · respuesta MALFORMADA del servidor: se falla cerrado y el mensaje es seguro", () => {
  const MALAS = [
    ["500 con HTML (con marcado)", responde("<html><img src=x onerror=alert(1)></html>", 500, "Internal Server Error")],
    ["500 con cuerpo vacio y sin texto de estado", responde("", 500)],
    ["500 con JSON null", responde("null", 500, "Internal Server Error")],
    ["500 con un arreglo JSON", responde("[1,2,3]", 500, "Internal Server Error")],
    ["500 con texto plano", responde("upstream connect error", 500, "Internal Server Error")],
    ["500 con JSON truncado", responde('{"message": "se cor', 500, "Internal Server Error")],
  ];
  for (const [nombre, hacer] of MALAS) test(`${nombre}: NO es exito, NO es «sin conexion», no lanza, y la pantalla muestra texto plano`, async () => {
    const e = await listo(); forzarPut(e, hacer);
    const r = await e.win.Auth.establecerClave(CLAVE); assert.equal(r.ok, false); assert.equal(r.motivo, "rechazada-por-el-servidor"); assert.equal(e.servidor.clavesEstablecidas.length, 0);
    const u = await listo(); forzarPut(u, hacer); await escribir(u);
    assert.notEqual(errorVisible(u), AVISO_RED); assert.ok(errorVisible(u).length > 0, "debe haber un mensaje"); assert.ok(!/undefined|\bnull\b/.test(errorVisible(u)), errorVisible(u));
    assert.deepEqual(marcadoPeligroso(u.doc.sumideros.map((s) => s.html).join("")), []); assert.equal(boton(u).disabled, false); assert.equal(u.win.Auth.enRecuperacion(), true);
  });
  test("CERRADO (OBS-5, 4E-C4-FIX): un `error` de objeto anidado en un HTTP 500 ya NO se pinta como «[object Object]»: mensaje generico seguro (detalle en 14-obs4-obs5)", async () => {
    const u = await listo(); forzarPut(u, json({ error: { codigo: 7 } }, 500)); await escribir(u);
    assert.equal(errorVisible(u), "No se pudo establecer la contraseña."); assert.deepEqual(marcadoPeligroso(u.doc.sumideros.map((s) => s.html).join("")), []);
  });
  test("CERRADO (OBS-4, 4E-C4-FIX): un HTTP 200 con cuerpo no-JSON YA NO cuenta como exito: «respuesta-invalida», no es fallo de red, sigue en recuperacion (detalle en 14-obs4-obs5)", async () => {
    const e = await listo(); forzarPut(e, responde("<html>OK</html>", 200)); const r = await e.win.Auth.establecerClave(CLAVE);
    assert.deepEqual([r.ok, r.motivo], [false, "respuesta-invalida"]); assert.equal(e.win.Auth.enRecuperacion(), true); assert.equal(e.eventos.includes("SIGNED_OUT"), false);
  });
  test("el texto del servidor con marcado se muestra como TEXTO (recovery.js usa textContent): sin elementos nuevos", async () => {
    for (const p of XSS) { const u = await listo(); forzarPut(u, json({ message: p }, 500)); await escribir(u); assert.equal(errorVisible(u), p); assert.deepEqual(marcadoPeligroso(u.doc.sumideros.map((s) => s.html).join("")), [], p); }
  });
});

/** Violaciones de lo que VE la persona en recovery.js para un escenario (lista vacia = cumple). */
async function violacionesPantalla([, preparar, esperado, clase], mutar) {
  const e = await listo(mutar ? { mutar } : {}); preparar(e); await escribir(e); const v = [];
  const visible = errorVisible(e);
  if (clase === "red") {
    if (visible !== AVISO_RED) v.push(`aviso «${visible}», se esperaba «${AVISO_RED}»`);
    if (!e.doc.getElementById("rcvForm")) v.push("el formulario desaparecio: no se puede reintentar");
    if (/Sin conexión<\/b>/.test(cuerpo(e))) v.push("se sustituyo el formulario por la pantalla completa de «Sin conexión»");
  } else if (clase === "http") {
    if (visible === AVISO_RED) v.push("una respuesta real del servidor se presento como fallo de red");
    if (visible !== esperado.detalle) v.push(`el usuario ve «${visible}» en vez del mensaje del servidor «${esperado.detalle}»`);
  } else if (clase === "enlace") {
    if (!/Enlace no válido o expirado/.test(cuerpo(e))) v.push("falta la pantalla de enlace no valido o expirado");
  } else if (clase === "exito") {
    if (!/Contraseña establecida correctamente\./.test(cuerpo(e))) v.push("falta la confirmacion de exito");
  }
  if (clase === "red" || clase === "http") {
    if (boton(e).disabled !== false || boton(e).textContent !== TEXTO_BOTON) v.push("el boton no se restauro");
    if (e.doc.getElementById("rcvClave").value !== "" || e.doc.getElementById("rcvClave2").value !== "") v.push("la contraseña quedo escrita en el formulario");
    if (!e.win.Auth.enRecuperacion()) v.push("ya no esta en recuperacion");
  }
  try { sinFugas(e, [CLAVE, e.tok]); } catch (x) { v.push(`fuga: ${x.message}`); }
  for (const w of Object.values(e.almacenSesion.volcado())) if (String(w).includes(CLAVE)) v.push("la contraseña llego al almacenamiento de sesion");
  return v;
}

describe("F-FUNC-1 · lo que VE la persona en recovery.js (UI real) y la contraseña NO se expone", () => {
  for (const esc of ESCENARIOS) test(`${esc[0]} → pantalla correcta, boton restaurado, contraseña soltada y sin fugas`, async () => { const v = await violacionesPantalla(esc); assert.deepEqual(v, [], v.join(" | ")); });
  test("tras un fallo de red se puede reintentar A MANO con la contraseña reescrita y funciona (sin reintentos automaticos)", async () => {
    const e = await listo(); e.servidor.red = "caida"; await escribir(e); assert.equal(errorVisible(e), AVISO_RED);
    const antes = e.servidor.llamadas.filter((l) => l.metodo === "PUT").length; assert.equal(antes, 1, "un solo intento, sin reintentos automaticos");
    e.servidor.red = "ok"; await escribir(e); assert.match(cuerpo(e), /Contraseña establecida correctamente\./); assert.deepEqual(e.servidor.clavesEstablecidas, [CLAVE.length]);
  });
  test("mientras la peticion esta en vuelo el boton queda bloqueado en «Guardando…» (la proteccion contra el doble clic) y se restaura al terminar", async () => {
    const e = await listo(); let soltar; forzarPut(e, () => new Promise((res) => { soltar = () => res(new Response(JSON.stringify({ id: 1 }), { status: 200 })); }));
    e.doc.getElementById("rcvClave").value = CLAVE; e.doc.getElementById("rcvClave2").value = CLAVE; const enviado = e.doc.getElementById("rcvForm").disparar("submit");
    assert.equal(boton(e).disabled, true); assert.equal(boton(e).textContent, "Guardando…");
    await enviado; soltar(); await e.asentar(); assert.match(cuerpo(e), /Contraseña establecida correctamente\./);
  });
  test("la contraseña sintetica no aparece en consola, HTML, almacenamiento, alertas ni en el registro de llamadas (que solo guarda su longitud) en NINGUN escenario, y ninguno llama a un host ajeno", async () => {
    for (const [nombre, preparar] of ESCENARIOS) {
      const e = await listo(); preparar(e); await escribir(e);
      assert.ok(!JSON.stringify(e.consola).includes(CLAVE), nombre); assert.ok(!JSON.stringify(e.servidor.llamadas).includes(CLAVE), nombre); assert.ok(!JSON.stringify(e.alertas).includes(CLAVE), nombre);
      for (const v of Object.values(e.almacen.volcado())) assert.ok(!String(v).includes(CLAVE), nombre);
      assert.ok(!e.doc.sumideros.some((s) => s.html.includes(CLAVE)), nombre);
      assert.equal(e.servidor.ajenas.length, 0, `${nombre}: llamada a un host ajeno`); assert.equal(e.servidor.inesperadas.length, 0, `${nombre}: llamada inesperada`);   // ningun mock hace red real
    }
  });
});

describe("mutantes: si se RESTAURA la clasificacion anterior (o se clasifica mal), las pruebas de red VUELVEN A FALLAR (en memoria; ningun archivo real se toca)", () => {
  const cambiar = (de, a) => (t) => { const r = t.split(de).join(a); if (r === t) throw new Error(`mutante sin efecto: ${de}`); return r; };
  const LINEA_RED = 'if (r.motivo === "sin-conexion" || r.motivo === "tiempo-agotado") return mal(r.motivo, r.detalle);';
  const MUTANTES = [
    ["se RESTAURA la clasificacion anterior: todo lo que no es sin-permiso → «rechazada-por-el-servidor»", cambiar(LINEA_RED, "")],
    ["se conserva «sin-conexion» pero se pierde «tiempo-agotado»", cambiar(LINEA_RED, 'if (r.motivo === "sin-conexion") return mal(r.motivo, r.detalle);')],
    ["se conserva «tiempo-agotado» pero se pierde «sin-conexion»", cambiar(LINEA_RED, 'if (r.motivo === "tiempo-agotado") return mal(r.motivo, r.detalle);')],
    ["clasificacion DEMASIADO amplia: cualquier rechazo del servidor se presenta como «sin-conexion»", cambiar('return mal("rechazada-por-el-servidor", r.detalle);', 'return mal("sin-conexion", r.detalle);')],
    ["el motivo de red se conserva pero se BORRA el detalle (se esconde el error)", cambiar(LINEA_RED, 'if (r.motivo === "sin-conexion" || r.motivo === "tiempo-agotado") return mal(r.motivo, "");')],
    ["se pierde el contrato previo de 401/403 → «enlace-caducado»", cambiar('if (r.motivo === "sin-permiso") return mal("enlace-caducado", r.detalle);', "")],
  ];
  const propiedad = async (mutar) => {
    for (const esc of ESCENARIOS) { if ((await violacionesAuth(esc, mutar)).length) return false; if ((await violacionesPantalla(esc, mutar)).length) return false; }
    return true;
  };
  test("con el codigo REAL la propiedad se cumple (linea base de los mutantes)", async () => assert.equal(await propiedad(), true));
  for (const [nombre, mut] of MUTANTES) test(`mutante: ${nombre}`, async () => assert.equal(await propiedad(mut), false, "el mutante SOBREVIVE: ninguna prueba protege esta garantia"));
  test("el mutante «clasificacion anterior» rompe EXACTAMENTE las pruebas de red (y solo esas): exito, enlace y HTTP siguen bien", async () => {
    const mut = MUTANTES[0][1]; const rotos = [];
    for (const esc of ESCENARIOS) if ((await violacionesAuth(esc, mut)).length || (await violacionesPantalla(esc, mut)).length) rotos.push(esc[3]);
    assert.ok(rotos.length > 0); assert.deepEqual([...new Set(rotos)], ["red"]);
  });
});
