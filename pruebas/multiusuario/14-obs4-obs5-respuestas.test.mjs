// OBS-4 y OBS-5 (4E-C4-FIX) — forma de las RESPUESTAS del servidor.
//
// OBS-4  Auth.establecerClave: un HTTP 200 solo es EXITO si trae la forma minima del contrato (Supabase Auth contesta al PUT con el
//        usuario: un objeto). HTML, texto, vacio, null, arreglo, escalar o JSON truncado → «respuesta-invalida» (rechazo seguro):
//        NO es fallo de red (no «sin-conexion»), NO se sale de la recuperacion y se puede reintentar.
// OBS-5  Mensajes de error: se elige la primera CADENA no vacia entre message, msg, error_description y error (supabase-client.js pedir())
//        o error, message, msg (usuarios.js pedir(), api-server). Un objeto NO se convierte a texto: nunca «[object Object]».
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { marcadoPeligroso } from "./helpers/dom.mjs";
import { leer } from "./helpers/entorno.mjs";
import { nuevoEntorno, CUENTAS } from "./helpers/flujos.mjs";
import { crearServidor, UUID, URL_API } from "./helpers/supabase-mock.mjs";

const CORREO = "persona-nueva@example.test";
const CLAVE = "Clave-Sintetica-9";
const GENERICO = "No se pudo establecer la contraseña.";
const XSS = ["<img src=x onerror=alert(1)>", "<script>alert(1)</script>", `"'><svg onload=alert(1)>`];

function conEnlace({ mutar } = {}) {
  const servidor = crearServidor(); const tok = servidor.emitirRecuperacion(CORREO);
  const env = nuevoEntorno({ servidor, hash: `#access_token=${tok}&type=recovery&expires_in=3600`, ...(mutar ? { mutar } : {}) });
  const eventos = []; env.win.Auth?.alCambiar((e) => eventos.push(e)); env.eventos = eventos; env.tok = tok; return env;
}
const listo = async (o) => { const e = conEnlace(o); await e.asentar(); return e; };
const forzarPut = (env, hacer) => { const f = env.win.fetch; env.win.fetch = (u, i) => (i?.method === "PUT" ? hacer(u, i) : f(u, i)); };
const responde = (cuerpo, status, statusText = "") => () => Promise.resolve(new Response(cuerpo, { status, statusText }));
const json = (o, status, statusText) => responde(JSON.stringify(o), status, statusText);
async function escribir(env) { env.doc.getElementById("rcvClave").value = CLAVE; env.doc.getElementById("rcvClave2").value = CLAVE; await env.doc.getElementById("rcvForm").disparar("submit"); await env.asentar(); }
const errorVisible = (env) => env.doc.getElementById("rcvError")?.textContent ?? null;
const cuerpo = (env) => env.doc.getElementById("rcvCuerpo").innerHTML;
const boton = (env) => env.doc.querySelector("#rcvForm button[type=submit]");
const cambiar = (de, a) => (t) => { const r = t.split(de).join(a); if (r === t) throw new Error(`mutante sin efecto: ${de}`); return r; };

// ═════════════════════════════════ OBS-4 ═════════════════════════════════
const VALIDAS = [["objeto con usuario ({id, email})", json({ id: UUID(99), email: CORREO }, 200)], ["objeto vacio ({}): la forma minima es «objeto»; no se exigen campos", json({}, 200)], ["objeto con campos extra", json({ id: UUID(99), email: CORREO, role: "authenticated", extra: { a: 1 } }, 200)]];
const INVALIDAS = [
  ["HTML (p. ej. un portal cautivo)", responde("<html><body>portal</body></html>", 200)],
  ["texto arbitrario", responde("OK", 200)], ["cuerpo vacio", responde("", 200)],
  ["JSON null", responde("null", 200)], ["arreglo vacio", responde("[]", 200)], ["arreglo con un usuario", responde(JSON.stringify([{ id: UUID(99) }]), 200)],
  ["JSON truncado", responde('{"id": "0000000', 200)], ["JSON escalar: cadena", responde('"ok"', 200)], ["JSON escalar: numero", responde("123", 200)], ["JSON escalar: booleano", responde("true", 200)],
  ["solo espacios", responde("   ", 200)],
];

describe("OBS-4 · Auth.establecerClave: 200 con objeto valido = EXITO", () => {
  for (const [n, h] of VALIDAS) test(n, async () => {
    const e = await listo(); forzarPut(e, h); const r = await e.win.Auth.establecerClave(CLAVE);
    assert.equal(r.ok, true); assert.equal(e.win.Auth.enRecuperacion(), false); assert.ok(e.eventos.includes("SIGNED_OUT"));
  });
  test("flujo normal con el servidor sintetico (PUT real del mock): sigue siendo exito y la pantalla lo confirma", async () => {
    const e = await listo(); await escribir(e); assert.match(cuerpo(e), /Contraseña establecida correctamente\./); assert.deepEqual(e.servidor.clavesEstablecidas, [CLAVE.length]);
  });
});

describe("OBS-4 · un 200 que NO trae un usuario se RECHAZA con «respuesta-invalida» (no es fallo de red, no sale de la recuperacion)", () => {
  for (const [n, h] of INVALIDAS) test(n, async () => {
    const e = await listo(); forzarPut(e, h); const r = await e.win.Auth.establecerClave(CLAVE);
    assert.deepEqual([r.ok, r.motivo, r.detalle], [false, "respuesta-invalida", ""]);
    assert.notEqual(r.motivo, "sin-conexion"); assert.notEqual(r.motivo, "tiempo-agotado"); assert.notEqual(r.motivo, "enlace-caducado");
    assert.equal(e.win.Auth.enRecuperacion(), true, "se puede reintentar"); assert.ok(!e.eventos.includes("SIGNED_OUT")); assert.ok(!JSON.stringify(r).includes(CLAVE));
  });
  test("en pantalla: mensaje generico y seguro, el boton se restaura, los campos se sueltan, el formulario sigue y NO se muestra «establecida correctamente»", async () => {
    for (const [n, h] of INVALIDAS) {
      const e = await listo(); forzarPut(e, h); await escribir(e);
      assert.equal(errorVisible(e), GENERICO, n); assert.doesNotMatch(cuerpo(e), /establecida correctamente/, n); assert.ok(e.doc.getElementById("rcvForm"), n);
      assert.equal(boton(e).disabled, false, n); assert.equal(boton(e).textContent, "Establecer contraseña", n); assert.equal(e.doc.getElementById("rcvClave").value, "", n); assert.equal(e.doc.getElementById("rcvClave2").value, "", n);
      assert.deepEqual(marcadoPeligroso(e.doc.sumideros.map((s) => s.html).join("")), [], n);
    }
  });
  test("el contenido del cuerpo invalido NO se refleja en pantalla (ni como texto ni como marcado)", async () => {
    for (const p of XSS) { const e = await listo(); forzarPut(e, responde(p, 200)); await escribir(e); assert.equal(errorVisible(e), GENERICO, p); assert.ok(!e.doc.sumideros.some((s) => s.html.includes("onerror") || s.html.includes("onload")), p); }
  });
  test("F-FUNC-1 intacto: red caida / tiempo agotado siguen llegando como sin-conexion / tiempo-agotado (no se confunden con respuesta-invalida)", async () => {
    for (const [red, motivo] of [["caida", "sin-conexion"], ["timeout", "tiempo-agotado"]]) { const e = await listo(); e.servidor.red = red; const r = await e.win.Auth.establecerClave(CLAVE); assert.deepEqual([r.ok, r.motivo], [false, motivo]); }
  });
  test("y un 401/403/422/500 real siguen su camino de siempre (enlace-caducado / rechazada-por-el-servidor)", async () => {
    for (const [st, motivo] of [[401, "enlace-caducado"], [403, "enlace-caducado"], [422, "rechazada-por-el-servidor"], [500, "rechazada-por-el-servidor"]]) { const e = await listo(); forzarPut(e, json({ message: "x" }, st)); const r = await e.win.Auth.establecerClave(CLAVE); assert.deepEqual([r.ok, r.motivo], [false, motivo], String(st)); }
  });
});

describe("OBS-4 · mutantes (en memoria): sin la validacion, un 200 basura vuelve a contar como exito", () => {
  const LINEA = 'if (!r.datos || typeof r.datos !== "object" || Array.isArray(r.datos)) return mal("respuesta-invalida");';
  const propiedad = async (mutar) => {
    for (const [, h] of INVALIDAS) { const e = await listo(mutar ? { mutar: { auth: mutar } } : {}); forzarPut(e, h); const r = await e.win.Auth.establecerClave(CLAVE); if (r.ok !== false || r.motivo !== "respuesta-invalida" || !e.win.Auth.enRecuperacion()) return false; }
    for (const [, h] of VALIDAS) { const e = await listo(mutar ? { mutar: { auth: mutar } } : {}); forzarPut(e, h); if ((await e.win.Auth.establecerClave(CLAVE)).ok !== true) return false; }
    return true;
  };
  test("con el codigo REAL la propiedad se cumple (linea base)", async () => assert.equal(await propiedad(), true));
  test("mutante: se QUITA la validacion (el 200 no-JSON vuelve a ser exito)", async () => assert.equal(await propiedad(cambiar(LINEA, "")), false));
  test("mutante: solo se comprueba `!r.datos` (aceptaria HTML, texto, arreglos y escalares no vacios)", async () => assert.equal(await propiedad(cambiar(LINEA, 'if (!r.datos) return mal("respuesta-invalida");')), false));
  test("mutante: se permite el arreglo (typeof [] es «object»)", async () => assert.equal(await propiedad(cambiar(" || Array.isArray(r.datos)", "")), false));
  test("mutante: la respuesta invalida se disfraza de FALLO DE RED (sin-conexion) → la prueba lo detecta", async () => assert.equal(await propiedad(cambiar('return mal("respuesta-invalida");', 'return mal("sin-conexion");')), false));
  test("mutante: la respuesta invalida saca de la recuperacion (recuperacion = null) → la prueba lo detecta", async () => assert.equal(await propiedad(cambiar('return mal("respuesta-invalida");', 'recuperacion = null; return mal("respuesta-invalida");')), false));
});

// ═════════════════════════════════ OBS-5 ═════════════════════════════════
// Cada caso: cuerpo de un HTTP 500 → detalle esperado (lo que deja pedir() en r.detalle) y lo que VE la persona en la pantalla de contraseña.
const STATUS = "Internal Server Error";
const CASOS5 = [
  ["message (cadena)", json({ message: "mensaje-a" }, 500, STATUS), "mensaje-a"],
  ["msg (cadena) — el campo de los errores de GoTrue", json({ msg: "mensaje-b" }, 500, STATUS), "mensaje-b"],
  ["error_description (cadena)", json({ error_description: "mensaje-c" }, 500, STATUS), "mensaje-c"],
  ["error (cadena)", json({ error: "mensaje-d" }, 500, STATUS), "mensaje-d"],
  ["prioridad: message > msg > error_description > error", json({ error: "d", error_description: "c", msg: "b", message: "a" }, 500, STATUS), "a"],
  ["prioridad: msg > error_description > error", json({ error: "d", error_description: "c", msg: "b" }, 500, STATUS), "b"],
  ["message es OBJETO → se salta al siguiente candidato (msg)", json({ message: { x: 1 }, msg: "mensaje-b" }, 500, STATUS), "mensaje-b"],
  ["message es ARREGLO → se salta (error)", json({ message: ["x"], error: "mensaje-d" }, 500, STATUS), "mensaje-d"],
  ["message vacio y msg solo espacios → se salta (error)", json({ message: "", msg: "   ", error: "mensaje-d" }, 500, STATUS), "mensaje-d"],
  ["message numerico → se salta", json({ message: 42, error: "mensaje-d" }, 500, STATUS), "mensaje-d"],
  ["error OBJETO anidado ({error:{mensaje:'fallo'}}) → sin cadenas: texto de estado", json({ error: { mensaje: "fallo" } }, 500, STATUS), STATUS],
  ["error OBJETO anidado y sin texto de estado → detalle vacio (la pantalla pone su mensaje generico)", json({ error: { mensaje: "fallo" } }, 500), ""],
  ["payload vacio ({})", json({}, 500, STATUS), STATUS], ["payload null", responde("null", 500, STATUS), STATUS], ["payload arreglo", responde("[1,2]", 500, STATUS), STATUS],
  ["payload MALFORMADO: HTML", responde("<html><body>error</body></html>", 500, STATUS), STATUS], ["payload MALFORMADO: JSON truncado", responde('{"message": "se cor', 500, STATUS), STATUS],
  ["payload vacio y sin texto de estado", responde("", 500), ""],
];

describe("OBS-5 · supabase-client.js pedir(): el detalle es SIEMPRE una cadena y nunca un objeto", () => {
  for (const [n, h, detalle] of CASOS5) test(n, async () => {
    const e = await listo(); forzarPut(e, h); const r = await e.win.Auth.establecerClave(CLAVE);
    assert.equal(r.ok, false); assert.equal(typeof r.detalle, "string"); assert.equal(r.detalle, detalle);
  });
  test("la persona ve el texto (o el generico) como TEXTO PLANO: nunca «[object Object]», sin elementos nuevos y con el flujo utilizable", async () => {
    for (const [n, h, detalle] of CASOS5) {
      const e = await listo(); forzarPut(e, h); await escribir(e); const visto = errorVisible(e);
      assert.equal(visto, detalle || GENERICO, n); assert.doesNotMatch(visto, /\[object|undefined|null/, n); assert.equal(e.doc.getElementById("rcvError").querySelectorAll("*").length, 0, n);
      assert.equal(boton(e).disabled, false, n); assert.ok(e.doc.getElementById("rcvForm"), n);
    }
  });
  test("un mensaje CON marcado se muestra como texto (recovery.js usa textContent): sin elementos nuevos", async () => {
    for (const p of XSS) { const e = await listo(); forzarPut(e, json({ msg: p }, 500, STATUS)); await escribir(e); assert.equal(errorVisible(e), p); assert.deepEqual(marcadoPeligroso(e.doc.sumideros.map((s) => s.html).join("")), [], p); }
  });
  test("el 401 y el 403 siguen siendo «enlace-caducado» aunque su cuerpo traiga objetos anidados", async () => {
    for (const st of [401, 403]) { const e = await listo(); forzarPut(e, json({ error: { mensaje: "x" }, msg: { y: 1 } }, st)); const r = await e.win.Auth.establecerClave(CLAVE); assert.deepEqual([r.ok, r.motivo, typeof r.detalle], [false, "enlace-caducado", "string"], String(st)); }
  });
});

// ── el hermano de pedir(): usuarios.js (api-server responde {error: "<texto>"}) ──
const U = (n, extra = {}) => ({ id: UUID(100 + n), nombre: `Persona ${n}`, correo: `persona${n}@example.test`, telefono: "", rol: "mecanico", activo: true, esUsted: false, ...extra });
async function toastDeError(cuerpoDeError, { mutar } = {}) {
  const env = nuevoEntorno({ producto: "admin", cuenta: CUENTAS.adminActivo, apiUrl: URL_API, ...(mutar ? { mutar: { usuarios: mutar } } : {}) }); await env.asentar();
  env.servidor.api = async (metodo) => (metodo === "GET" ? { status: 200, body: { usuarios: [U(1, { rol: "admin", esUsted: true }), U(3)] } } : { status: 500, body: cuerpoDeError });
  await env.win.PantallaUsuarios.render(); await env.asentar(); await env.doc.querySelectorAll(".u-estado")[0].disparar("click"); await env.asentar();
  const t = env.doc.sumideros.filter((s) => /^<span class="dot off">/.test(s.html)).map((s) => s.html.replace(/^<span class="dot off"><\/span>/, ""));
  return t;
}
const GEN_U = "No se pudo completar la operación.";
const CASOS_U = [
  ["error (cadena) — el contrato del api-server", { error: "Usuario ya existe" }, "Usuario ya existe"], ["message (cadena)", { message: "mensaje-m" }, "mensaje-m"], ["msg (cadena)", { msg: "mensaje-n" }, "mensaje-n"],
  ["prioridad: error > message > msg", { msg: "n", message: "m", error: "e" }, "e"],
  ["error OBJETO anidado → se salta a message", { error: { mensaje: "fallo" }, message: "mensaje-m" }, "mensaje-m"],
  ["error OBJETO anidado y sin mas cadenas → generico, NUNCA «[object Object]»", { error: { mensaje: "fallo" } }, GEN_U],
  ["cuerpo vacio ({})", {}, GEN_U], ["cuerpo arreglo", [1], GEN_U], ["cuerpo null", null, GEN_U], ["cuerpo texto plano", "texto plano", GEN_U],
];
describe("OBS-5 · usuarios.js pedir(): el aviso es texto legible o el generico, nunca «[object Object]»", () => {
  for (const [n, cuerpoE, esperado] of CASOS_U) test(n, async () => { const t = await toastDeError(cuerpoE); assert.deepEqual(t, [esperado]); assert.doesNotMatch(t[0], /\[object/); });
  test("un mensaje con marcado sigue llegando ESCAPADO (F-SEC-1 intacto)", async () => { const t = await toastDeError({ error: XSS[0] }); assert.deepEqual(t, ["&lt;img src=x onerror=alert(1)&gt;"]); });
});

describe("OBS-5 · mutantes (en memoria): si se vuelve a la extraccion anterior, la prueba VUELVE A FALLAR", () => {
  const SB_ARR = "primeraCadena([cuerpo.message, cuerpo.msg, cuerpo.error_description, cuerpo.error])";
  const propiedadSB = async (mutar) => {
    for (const [, h, detalle] of CASOS5) { const e = await listo(mutar ? { mutar: { "supabase-client": mutar } } : {}); forzarPut(e, h); const r = await e.win.Auth.establecerClave(CLAVE); if (typeof r.detalle !== "string" || r.detalle !== detalle) return false; }
    return true;
  };
  test("linea base: con el codigo REAL se cumple", async () => assert.equal(await propiedadSB(), true));
  test("mutante: extraccion ANTERIOR (message || error_description || error; los objetos pasan como objeto)", async () => assert.equal(await propiedadSB(cambiar(SB_ARR, "(cuerpo.message || cuerpo.error_description || cuerpo.error)")), false));
  test("mutante: se pierde `msg` (el campo de GoTrue)", async () => assert.equal(await propiedadSB(cambiar(SB_ARR, "primeraCadena([cuerpo.message, cuerpo.error_description, cuerpo.error])")), false));
  test("mutante: primeraCadena acepta cualquier valor verdadero (un objeto vuelve a ganar)", async () => assert.equal(await propiedadSB(cambiar('typeof c === "string" && c.trim() !== ""', "c")), false));
  test("mutante: primeraCadena acepta cadenas vacias o de solo espacios", async () => assert.equal(await propiedadSB(cambiar('typeof c === "string" && c.trim() !== ""', 'typeof c === "string"')), false));
  const propiedadU = async (mutar) => { for (const [, cuerpoE, esperado] of CASOS_U) { const t = await toastDeError(cuerpoE, { mutar }); if (t.length !== 1 || t[0] !== esperado) return false; } return true; };
  test("linea base (usuarios.js): con el codigo REAL se cumple", async () => assert.equal(await propiedadU(), true));
  test("mutante (usuarios.js): extraccion ANTERIOR ((datos && datos.error) || generico) → «[object Object]»", async () => assert.equal(await propiedadU(cambiar('primeraCadena(datos && typeof datos === "object" ? [datos.error, datos.message, datos.msg] : [])', "(datos && datos.error)")), false));
  test("mutante (usuarios.js): se pierde `msg`", async () => assert.equal(await propiedadU(cambiar("[datos.error, datos.message, datos.msg]", "[datos.error, datos.message]")), false));
  test("guarda estatica: ninguna de las dos extracciones vuelve a hacer `x.message || … || x.error` sobre objetos crudos", () => {
    assert.ok(!/cuerpo\.message \|\| cuerpo\.error_description/.test(leer("supabase-client.js"))); assert.ok(!/\(datos && datos\.error\)/.test(leer("usuarios.js")));
  });
});
