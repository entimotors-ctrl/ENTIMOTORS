// F-SEC-1 (4E-C3-FIX1) — REGRESION DE SEGURIDAD: el texto de error que llega del api-server NO controla marcado HTML.
// Flujo original: textoDeFallo() ESCAPA → quitarHtml() DES-ESCAPA → aviso() → toast() (app.js) asigna a innerHTML.
// Propiedad obligatoria: lo que llega al sumidero final (innerHTML del toast) es EXACTAMENTE su propio <span> + el
// mensaje ESCAPADO; ningun elemento nuevo, ningun manejador, y el usuario LEE el mensaje tal cual lo envio el servidor.
// Se comprueba la ESTRUCTURA del sumidero (lista de etiquetas), no la presencia de una palabra. No se ejecuta JS.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { escaparHtml, marcadoPeligroso } from "./helpers/dom.mjs";
import { leer } from "./helpers/entorno.mjs";
import { nuevoEntorno, CUENTAS } from "./helpers/flujos.mjs";
import { UUID, URL_API } from "./helpers/supabase-mock.mjs";

const PAYLOADS = [
  ["img/onerror", "<img src=x onerror=alert(1)>"],
  ["svg/onload", "<svg onload=alert(1)>"],
  ["svg/onload tras romper atributo (variante de C3)", `"'><svg onload=alert(1)>`],
  ["script", "<script>alert(1)</script>"],
  ["iframe/javascript:", '<iframe src="javascript:alert(1)"></iframe>'],
  ["entidades ya codificadas por el servidor", "&lt;img src=x onerror=alert(1)&gt;"],
];
const CARACTERES = `a<b>c&d"e'f`;
const NORMALES = ["Usuario ya existe", "No autorizado", "Error del servidor", "Nombre <inválido>", "Tom & Jerry"];
const DEFECTO = "No se pudo completar la operación.";
const PREFIJO = '<span class="dot off"></span>';
const U = (n, extra = {}) => ({ id: UUID(100 + n), nombre: `Persona ${n}`, correo: `persona${n}@example.test`, telefono: "", rol: "mecanico", activo: true, esUsted: false, ...extra });

/** Pantalla «Usuarios y equipo» de un admin. `respuestaError` = { status, body } que devuelve el api-server a cualquier PATCH/POST. */
async function pantalla(respuestaError, { mutar, apiUrl = URL_API } = {}) {
  const env = nuevoEntorno({ producto: "admin", cuenta: CUENTAS.adminActivo, apiUrl, ...(mutar ? { mutar } : {}) }); await env.asentar();
  env.servidor.api = async (metodo) => (metodo === "GET" ? { status: 200, body: { usuarios: [U(1, { rol: "admin", esUsted: true }), U(3)] } } : respuestaError);
  await env.win.PantallaUsuarios.render(); await env.asentar();
  return env;
}
const error = (mensaje, status = 500) => ({ status, body: { error: mensaje } });

// Los tres caminos que llegan a aviso(): cada uno provoca un PATCH rechazado por el servidor.
const CAMINOS = [
  ["cambiar el rol", async (env) => { const s = env.doc.querySelectorAll(".u-rol")[0]; s.value = "cajero"; await s.disparar("change"); }],
  ["dar de baja / reactivar", async (env) => { await env.doc.querySelectorAll(".u-estado")[0].disparar("click"); }],
  ["editar nombre y telefono", async (env) => { env.win.showPrompt = async () => "x"; await env.doc.querySelectorAll(".u-editar")[0].disparar("click"); }],
];
async function provocar(camino, respuesta, opciones) { const env = await pantalla(respuesta, opciones); await camino(env); await env.asentar(); return env; }

/** HTML COMPLETO asignado a innerHTML por cada toast (el sumidero final). */
const toastsHtml = (env) => env.doc.sumideros.filter((s) => /^<span class="dot /.test(s.html)).map((s) => s.html);
const etiquetas = (html) => html.match(/<\/?[A-Za-z!?][^>]*>/g) || [];
/** Lo que un navegador MOSTRARIA como texto: se vuelca el HTML a un nodo y se lee su texto (etiquetas fuera, entidades decodificadas una vez). */
const textoVisible = (env, html) => { const d = env.doc.createElement("div"); d.innerHTML = html; return d.textContent; };

/** Violaciones de la propiedad para un mensaje concreto del servidor (lista vacia = propiedad cumplida). */
async function violaciones(camino, mensaje, opciones) {
  const env = await provocar(camino, error(mensaje), opciones); const v = []; const t = toastsHtml(env);
  if (t.length !== 1) return [`se esperaba 1 toast y hubo ${t.length}`];
  const html = t[0];
  const tags = etiquetas(html);
  if (JSON.stringify(tags) !== JSON.stringify(['<span class="dot off">', "</span>"])) v.push(`etiquetas en el sumidero: ${JSON.stringify(tags)}`);
  if (marcadoPeligroso(html).length) v.push(`marcado activo: ${[...new Set(marcadoPeligroso(html))].join(", ")}`);
  if (html !== PREFIJO + escaparHtml(mensaje)) v.push("el mensaje no llego escapado exactamente una vez");
  if (textoVisible(env, html) !== mensaje) v.push(`el usuario leeria «${textoVisible(env, html)}» en vez de «${mensaje}»`);
  return v;
}
async function violacionesTodas(mensajes, opciones) {
  const mal = [];
  for (const [donde, camino] of CAMINOS) for (const m of mensajes) { const [nombre, texto] = Array.isArray(m) ? m : [m, m]; const v = await violaciones(camino, texto, opciones); if (v.length) mal.push(`${donde} / ${nombre}: ${v.join("; ")}`); }
  return mal;
}

describe("F-SEC-1 · el texto de error del servidor NO llega como marcado al toast", () => {
  for (const [donde, camino] of CAMINOS) test(`${donde}: img/onerror, svg/onload, variante de C3, script, iframe y entidades → el sumidero recibe solo su <span> + el mensaje escapado`, async () => {
    const mal = []; for (const [nombre, texto] of PAYLOADS) { const v = await violaciones(camino, texto); if (v.length) mal.push(`${nombre}: ${v.join("; ")}`); }
    assert.deepEqual(mal, [], `F-SEC-1: ${mal.join(" | ")}`);
  });
  test("caracteres < > & \" ' se conservan de forma SEGURA: el usuario los ve tal cual y el sumidero los lleva como entidades", async () => {
    assert.deepEqual(await violacionesTodas([CARACTERES]), []);
    const env = await provocar(CAMINOS[0][1], error(CARACTERES)); assert.equal(toastsHtml(env)[0], `${PREFIJO}a&lt;b&gt;c&amp;d&quot;e&#39;f`);
  });
  test("un 401/403 muestra su texto FIJO y el mensaje del servidor no se refleja en absoluto", async () => {
    for (const status of [401, 403]) for (const [, camino] of CAMINOS) {
      const env = await provocar(camino, { status, body: { error: "<img src=x onerror=alert(1)>" } }); const t = toastsHtml(env);
      assert.deepEqual(t, [PREFIJO + (status === 401 ? "Tu sesión ha caducado. Vuelve a entrar." : "Solo el administrador puede gestionar usuarios.")]);
    }
  });
  test("contraste: dentro de la caja «Nuevo usuario» (camino HTML, sin cambios) el mismo texto sigue llegando escapado", async () => {
    for (const [, p] of PAYLOADS) {
      const env = await pantalla(error(p)); await env.doc.getElementById("btnCrearUsuario").disparar("click"); await env.asentar();
      const html = env.doc.getElementById("nuResultado").innerHTML; assert.deepEqual(marcadoPeligroso(html), [], p); assert.deepEqual(etiquetas(html), ['<p class="gate-error" style="margin:0;">', "</p>"], p);
    }
  });
});

describe("no regresion de mensajes: el usuario sigue leyendo texto comprensible", () => {
  test("mensajes normales del servidor (incluidos «Nombre <inválido>» y «Tom & Jerry») se ven EXACTAMENTE como los envio el servidor", async () => {
    assert.deepEqual(await violacionesTodas(NORMALES), []);
  });
  test("ningun mensaje normal se convierte en [object Object], undefined, null ni en entidades duplicadas (&amp;amp; / &amp;lt;)", async () => {
    for (const [, camino] of CAMINOS) for (const m of NORMALES) {
      const env = await provocar(camino, error(m, 409)); const [html] = toastsHtml(env);
      assert.ok(!/\[object Object\]|undefined|\bnull\b|&amp;amp;|&amp;lt;|&amp;gt;/.test(html), `${m}: ${html}`); assert.equal(textoVisible(env, html), m);
    }
  });
  test("errores vacios, nulos o sin cuerpo JSON: mensaje generico legible y el flujo sigue (no revienta ni deja el boton bloqueado)", async () => {
    const VACIOS = [{ status: 500, body: {} }, { status: 500, body: { error: "" } }, { status: 500, body: { error: null } }, { status: 500, body: { error: 0 } }, { status: 500, body: { error: false } }, { status: 500, body: null }, { status: 500, body: [] }, { status: 422, body: "texto plano" }];
    for (const [donde, camino] of CAMINOS) for (const r of VACIOS) {
      const env = await provocar(camino, r); assert.deepEqual(toastsHtml(env), [PREFIJO + DEFECTO], `${donde} ${JSON.stringify(r.body)}`);
      const b = env.doc.querySelectorAll(".u-estado")[0]; assert.equal(b.disabled, false, "el boton no debe quedarse bloqueado");
    }
  });
  test("cada motivo de fallo muestra el MISMO texto en el aviso (toast) que en la caja de errores (HTML): sin divergencia entre las dos rutas", async () => {
    const CASOS = [
      ["401 sesion caducada", async () => ({ resp: { status: 401, body: {} } })],
      ["403 sin permiso", async () => ({ resp: { status: 403, body: {} } })],
      ["500 con mensaje", async () => ({ resp: error("Fallo interno controlado") })],
      ["500 con marcado", async () => ({ resp: error("<b>x</b> & <i>y</i>") })],
      ["500 sin cuerpo", async () => ({ resp: { status: 500, body: null } })],
      ["sin conexion", async () => ({ resp: error("x"), preparar: (env) => { env.servidor.red = "caida"; } })],
      ["tiempo agotado", async () => ({ resp: error("x"), preparar: (env) => { env.servidor.red = "timeout"; } })],
      ["sin apiUrl (sin-servidor)", async () => ({ resp: error("x"), preparar: (env) => { env.win.ENTIMOTORS_SUPABASE.apiUrl = ""; } })],
    ];
    for (const [nombre, montar] of CASOS) {
      const { resp, preparar } = await montar();
      const a = await pantalla(resp); preparar && preparar(a); await CAMINOS[0][1](a); await a.asentar();
      const b = await pantalla(resp); preparar && preparar(b); await b.doc.getElementById("btnCrearUsuario").disparar("click"); await b.asentar();
      const enToast = textoVisible(a, toastsHtml(a)[0]), enCaja = textoVisible(b, b.doc.getElementById("nuResultado").innerHTML);
      assert.equal(enToast, enCaja, nombre); assert.ok(enToast.length > 0, nombre);
    }
  });
  test("caracterizacion (sin cambios): un error NO textual del servidor se muestra igual en toast y caja — comportamiento previo, fuera de F-SEC-1", async () => {
    const resp = { status: 500, body: { error: { codigo: 7 } } };
    const a = await pantalla(resp); await CAMINOS[0][1](a); await a.asentar(); const b = await pantalla(resp); await b.doc.getElementById("btnCrearUsuario").disparar("click"); await b.asentar();
    assert.equal(textoVisible(a, toastsHtml(a)[0]), textoVisible(b, b.doc.getElementById("nuResultado").innerHTML));
  });
  test("los avisos de EXITO siguen siendo texto fijo: «Rol actualizado», «Usuario dado de baja», «Datos actualizados»", async () => {
    for (const [i, esperado] of [[0, "Rol actualizado"], [1, "Usuario dado de baja"], [2, "Datos actualizados"]]) {
      const env = await pantalla({ status: 200, body: {} }); await CAMINOS[i][1](env); await env.asentar();
      assert.ok(toastsHtml(env).some((h) => h === `<span class="dot on"></span>${esperado}`), esperado);
    }
  });
});

/** Guarda estatica sobre el TEXTO de usuarios.js. Devuelve la lista de violaciones (vacia = cumple). */
function guardaEstatica(s) {
  const v = [];
  if (/quitarHtml/.test(s)) v.push("quitarHtml presente");
  if (/\.innerHTML\s*=\s*\w+\s*;\s*return\s+\w+\.(textContent|innerText)/.test(s)) v.push("patron de des-escape por DOM (innerHTML=…; return …textContent)");
  const aviso = /function aviso\(msg\)\s*\{([^}]*)\}/.exec(s);
  if (!aviso) v.push("no se encontro aviso()"); else if (!/toast\(esc\(msg\),\s*"off"\)/.test(aviso[1])) v.push("aviso() no escapa antes de entregar al toast");
  const llamadas = [...new Set([...s.matchAll(/(?<!function\s)(?<![\w.])aviso\(([^;]*?)\);/g)].map((m) => m[1]))];  // llamadas, no la definicion
  if (llamadas.length !== 1 || llamadas[0] !== "textoPlanoDeFallo(r)") v.push(`aviso() recibe algo distinto de texto plano: ${JSON.stringify(llamadas)}`);
  return v;
}
describe("guarda estatica de usuarios.js: no vuelve el patron «escapar → des-escapar → innerHTML»", () => {
  test("usuarios.js real cumple la guarda: sin quitarHtml, sin des-escape por DOM, aviso() escapa y solo recibe texto PLANO", () => assert.deepEqual(guardaEstatica(leer("usuarios.js")), []));
});

describe("mutantes: si se reintroduce el des-escape o se entrega marcado sin escape, la prueba VUELVE A FALLAR (en memoria; ningun archivo real se toca)", () => {
  const cambiar = (de, a) => (t) => { const r = t.split(de).join(a); if (r === t) throw new Error(`mutante sin efecto: ${de}`); return r; };
  const QUITAR_HTML = 'function quitarHtml(s) { var d = document.createElement("div"); d.innerHTML = s; return d.textContent; }\n  global.PantallaUsuarios =';
  const componer = (...f) => (t) => f.reduce((acc, fn) => fn(acc), t);
  const MUTANTES = [
    ["aviso() entrega el mensaje SIN escapar", cambiar('toast(esc(msg), "off")', 'toast(msg, "off")')],
    ["vuelve el flujo ORIGINAL de F-SEC-1: quitarHtml(textoDeFallo(r)) + aviso sin escape", componer(cambiar("aviso(textoPlanoDeFallo(r))", "aviso(quitarHtml(textoDeFallo(r)))"), cambiar('toast(esc(msg), "off")', 'toast(msg, "off")'), cambiar("global.PantallaUsuarios =", QUITAR_HTML))],
    ["el mensaje se escapa DOS veces (entidades duplicadas ilegibles)", cambiar('toast(esc(msg), "off")', 'toast(esc(esc(msg)), "off")')],
    ["el texto plano se entrega como HTML de textoDeFallo (escapado y luego tratado como texto → «&lt;…»)", cambiar("aviso(textoPlanoDeFallo(r))", "aviso(textoDeFallo(r))")],
  ];
  const propiedad = async (mutar) => (await violacionesTodas([...PAYLOADS, ...NORMALES, CARACTERES], mutar ? { mutar: { usuarios: mutar } } : undefined)).length === 0;
  test("con el codigo REAL la propiedad se cumple (linea base de los mutantes)", async () => assert.equal(await propiedad(), true));
  for (const [nombre, mut] of MUTANTES) test(`mutante: ${nombre}`, async () => assert.equal(await propiedad(mut), false, "el mutante SOBREVIVE: ninguna prueba protege esta garantia"));
  test("mutante estatico: reintroducir SOLO la funcion quitarHtml (aunque aviso siga escapando) rompe la guarda estatica", () => {
    const mutado = cambiar("global.PantallaUsuarios =", QUITAR_HTML)(leer("usuarios.js"));
    assert.ok(guardaEstatica(mutado).includes("quitarHtml presente")); assert.ok(guardaEstatica(mutado).includes("patron de des-escape por DOM (innerHTML=…; return …textContent)"));
  });
  test("mutante estatico: aviso() sin escape rompe la guarda; alimentarlo con quitarHtml(textoDeFallo(r)) tambien", () => {
    assert.ok(guardaEstatica(cambiar('toast(esc(msg), "off")', 'toast(msg, "off")')(leer("usuarios.js"))).includes("aviso() no escapa antes de entregar al toast"));
    assert.ok(guardaEstatica(cambiar("aviso(textoPlanoDeFallo(r))", "aviso(quitarHtml(textoDeFallo(r)))")(leer("usuarios.js"))).some((x) => /recibe algo distinto/.test(x)));
  });
});
