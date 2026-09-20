// OBS-8 (4E-C7-FIX-A) — «+ Nuevo usuario» abria el formulario DEBAJO de la lista: con unas pocas personas en el equipo caia por debajo del
// pliegue, y con el el enlace generado (#nuResultado). Correccion: SOLO reordenar el bloque en render() de usuarios.js — la tarjeta
// #cardNuevoUsuario se pinta ANTES de la tarjeta «Equipo». Ids, handlers, display:none, textos, roles, POST/PATCH: intactos.
//
// Aqui (DOM sintetico): orden, ocultacion inicial, que los ids sigan DENTRO de la tarjeta, que abrir/cancelar y el alta funcionen igual,
// y pruebas de MUTACION del comprobador. Que el formulario quede a la vista de verdad (escritorio, portatil, móvil) lo miden los casos OBS-8
// de la suite de navegador (Chrome y Firefox), porque aqui no hay layout.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { leer } from "./helpers/entorno.mjs";
import { nuevoEntorno, toasts, CUENTAS } from "./helpers/flujos.mjs";
import { UUID, URL_API } from "./helpers/supabase-mock.mjs";

const FUENTE = leer("usuarios.js");
const U = (n, extra = {}) => ({ id: UUID(100 + n), nombre: `Persona ${n}`, correo: `persona${n}@example.test`, telefono: `9999-000${n}`, rol: "mecanico", activo: true, esUsted: false, ...extra });
const EQUIPO = () => [U(1, { rol: "admin", esUsted: true, nombre: "Admin Activo" }), U(2, { rol: "admin" }), U(3), U(4, { rol: "cajero" }), U(5, { activo: false }), U(6, { rol: "desarrollador" }), U(7)];
const IDS_DEL_FORMULARIO = ["nuNombre", "nuCorreo", "nuTelefono", "nuRol", "btnCrearUsuario", "btnCancelarUsuario", "nuResultado"];

async function pantalla({ api } = {}) {
  const env = nuevoEntorno({ producto: "admin", cuenta: CUENTAS.adminActivo, sesionGuardada: null, apiUrl: URL_API });
  const pedidos = [];
  env.servidor.api = async (metodo, ruta, cuerpo, auth) => {
    pedidos.push({ metodo, ruta, cuerpo, auth });
    if (api) { const r = await api(metodo, ruta, cuerpo); if (r) return r; }
    return metodo === "GET" ? { status: 200, body: { usuarios: EQUIPO() } } : { status: 200, body: {} };
  };
  await env.asentar(); env.pedidos = pedidos;
  await env.win.PantallaUsuarios.render(); await env.asentar();
  env.cuerpo = () => env.doc.getElementById("usuariosCuerpo");
  return env;
}

/** Comprueba sobre el HTML que render() asigno a #usuariosCuerpo. Se usa tal cual sobre el real y sobre los mutantes. */
function verificarOrden(html) {
  const R = []; const chk = (id, ok, detalle = "") => R.push({ id, ok: Boolean(ok), detalle: ok ? "" : detalle });
  const iForm = html.indexOf('id="cardNuevoUsuario"'), iBoton = html.indexOf('id="btnNuevoUsuario"'), iTabla = html.indexOf("<table"), iEquipo = html.indexOf('<h3 class="font-display" style="font-size:0.95rem; margin:0;">Equipo');
  chk("O1 el formulario está ANTES de la lista de equipo (tabla)", iForm >= 0 && iTabla > iForm, `form@${iForm} tabla@${iTabla}`);
  chk("O2 el formulario está ANTES del encabezado «Equipo · N» y de su botón", iForm >= 0 && iEquipo > iForm && iBoton > iForm, `form@${iForm} equipo@${iEquipo} boton@${iBoton}`);
  const etiqueta = /<div class="card" id="cardNuevoUsuario" style="([^"]*)">/.exec(html);
  chk("O3 sigue oculto de inicio (display:none en linea)", !!etiqueta && /display:\s*none/.test(etiqueta[1]), `etiqueta=${etiqueta && etiqueta[0]}`);
  chk("O4 separación hacia la lista por ABAJO (margin-bottom), no por arriba", !!etiqueta && /margin-bottom:\s*1rem/.test(etiqueta[1]) && !/margin-top/.test(etiqueta[1]), `estilo=${etiqueta && etiqueta[1]}`);
  // los ids del formulario viven dentro de SU tarjeta (entre su apertura y la apertura de la tarjeta «Equipo»)
  const sub = iForm >= 0 && iTabla > iForm ? html.slice(iForm, html.indexOf('<div class="card">', iForm)) : "";
  const fuera = iForm >= 0 ? html.slice(html.indexOf('<div class="card">', iForm)) : html;
  chk("O5 todos los ids del formulario (y el recuadro del enlace) están dentro de la tarjeta nueva", IDS_DEL_FORMULARIO.every((x) => sub.includes(`id="${x}"`)), `faltan: ${IDS_DEL_FORMULARIO.filter((x) => !sub.includes(`id="${x}"`))}`);
  chk("O6 ninguno de esos ids se repite en la tarjeta «Equipo»", IDS_DEL_FORMULARIO.every((x) => !fuera.includes(`id="${x}"`)), "id duplicado fuera de la tarjeta");
  chk("O7 cada id aparece UNA sola vez en toda la pantalla", [...IDS_DEL_FORMULARIO, "cardNuevoUsuario", "btnNuevoUsuario"].every((x) => html.split(`id="${x}"`).length === 2), "id repetido o ausente");
  return R;
}
const fallos = (r) => r.filter((x) => !x.ok).map((x) => x.id.split(" ")[0]);

describe("OBS-8 · orden de la pantalla real de Usuarios y equipo", () => {
  test("las 7 comprobaciones de orden pasan sobre el HTML que pinta render()", async () => {
    const env = await pantalla();
    const R = verificarOrden(env.cuerpo().innerHTML); assert.equal(R.length, 7);
    assert.deepEqual(R.filter((x) => !x.ok), [], "comprobaciones fallidas");
  });
  test("el fuente de usuarios.js declara la tarjeta antes que el botón «+ Nuevo usuario» y que la tabla", () => {
    const i = FUENTE.indexOf('id="cardNuevoUsuario"'), b = FUENTE.indexOf('id="btnNuevoUsuario"'), t = FUENTE.indexOf("<table>");
    assert.ok(i > 0 && b > i && t > i, `card@${i} boton@${b} tabla@${t}`);
  });
  test("«+ Nuevo usuario» muestra el formulario y «Cancelar» lo oculta (los handlers siguen enganchados a los mismos ids)", async () => {
    const env = await pantalla(); const card = env.doc.getElementById("cardNuevoUsuario");
    card.style.display = "none";
    await env.doc.getElementById("btnNuevoUsuario").disparar("click"); assert.equal(card.style.display, "");
    await env.doc.getElementById("btnNuevoUsuario").disparar("click"); assert.equal(card.style.display, "none", "el botón alterna");
    await env.doc.getElementById("btnNuevoUsuario").disparar("click"); assert.equal(card.style.display, "");
    await env.doc.getElementById("btnCancelarUsuario").disparar("click"); assert.equal(card.style.display, "none");
  });
  test("el alta NO cambia: mismo POST, mismo cuerpo, y el enlace generado se pinta en #nuResultado (dentro de la tarjeta de arriba)", async () => {
    const enlace = "https://synthetic.example/index.html#access_token=TOKEN-SINTETICO&type=recovery";
    const env = await pantalla({ api: async (m) => (m === "POST" ? { status: 201, body: { usuario: { id: UUID(150), correo: "ana@example.test", nombre: "Ana", telefono: "", rol: "mecanico", activo: true }, enlaceParaEstablecerClave: enlace, motivoSinEnlace: null, nota: "Pásale este enlace a la persona." } } : null) });
    env.doc.getElementById("nuNombre").value = "Ana"; env.doc.getElementById("nuCorreo").value = "ana@example.test"; env.doc.getElementById("nuTelefono").value = ""; env.doc.getElementById("nuRol").value = "mecanico";
    await env.doc.getElementById("btnCrearUsuario").disparar("click"); await env.asentar();
    const post = env.pedidos.filter((p) => p.metodo === "POST"); assert.equal(post.length, 1);
    assert.deepEqual(post[0].cuerpo, { nombre: "Ana", correo: "ana@example.test", telefono: "", rol: "mecanico" });
    assert.ok(post[0].ruta.endsWith("/api/admin/usuarios"), post[0].ruta);
    const h = env.doc.getElementById("nuResultado").innerHTML;
    assert.match(h, /Cuenta creada/); assert.ok(h.includes("TOKEN-SINTETICO"), "el enlace debe verse para poder copiarlo"); assert.match(h, /btnCopiarEnlace/); assert.match(h, /btnListoUsuario/);
    assert.ok(toasts(env).includes("Usuario creado"));
  });
  test("«Listo · actualizar lista» vuelve a pintar la pantalla con el formulario otra vez arriba y oculto", async () => {
    const env = await pantalla({ api: async (m) => (m === "POST" ? { status: 201, body: { usuario: { id: UUID(151) }, enlaceParaEstablecerClave: null, motivoSinEnlace: "sin-origin", nota: "x" } } : null) });
    env.doc.getElementById("nuNombre").value = "Ana"; env.doc.getElementById("nuCorreo").value = "ana@example.test"; env.doc.getElementById("nuRol").value = "mecanico";
    await env.doc.getElementById("btnCrearUsuario").disparar("click"); await env.asentar();
    await env.doc.getElementById("btnListoUsuario").disparar("click"); await env.asentar();
    assert.deepEqual(verificarOrden(env.cuerpo().innerHTML).filter((x) => !x.ok), []);
    assert.equal(env.pedidos.filter((p) => p.metodo === "GET").length, 2, "vuelve a pedir la lista");
  });
  test("no cambian los roles asignables, ni las acciones por fila (rol, baja, editar), ni el texto de la contraseña", async () => {
    const env = await pantalla(); const h = env.cuerpo().innerHTML;
    for (const rol of ["mecanico", "cajero", "desarrollador"]) assert.ok(h.includes(`<option value="${rol}">`), `rol ${rol}`);
    assert.ok(!h.includes('<option value="admin">'), "no se ofrece admin");
    assert.equal((h.match(/class="u-rol"/g) || []).length, 5); assert.equal((h.match(/u-estado/g) || []).length, 5); assert.equal((h.match(/u-editar/g) || []).length, 5);
    assert.match(h, /La contraseña no se pone aquí\. Al crear la cuenta se genera un enlace de un solo uso/);
    assert.match(h, /Equipo · 7/);
  });
});

describe("OBS-8 · pruebas de MUTACION del comprobador (el orden viejo y los ids rotos se DETECTAN)", () => {
  let base;
  const crear = async () => (base ||= (await pantalla()).cuerpo().innerHTML);
  const inicioForm = (h) => h.indexOf('<div class="card" id="cardNuevoUsuario"');
  const bloqueForm = (h) => h.slice(inicioForm(h), h.indexOf('<div class="card">', inicioForm(h)));
  test("mutante «formulario DESPUÉS de la lista» (el orden de antes) → falla O1 y O2", async () => {
    const h = await crear(); const f = bloqueForm(h); const m = h.replace(f, "") + f;
    const r = fallos(verificarOrden(m)); assert.ok(r.includes("O1") && r.includes("O2"), JSON.stringify(r));
  });
  test("mutante «sin display:none inicial» → falla O3", async () => {
    const h = await crear(); const r = fallos(verificarOrden(h.replace('margin-bottom:1rem; display:none;', 'margin-bottom:1rem;'))); assert.ok(r.includes("O3"), JSON.stringify(r));
  });
  test("mutante «margin-top:1rem» (el espaciado de antes) → falla O4", async () => {
    const h = await crear(); const r = fallos(verificarOrden(h.replace('margin-bottom:1rem; display:none;', 'margin-top:1rem; display:none;'))); assert.ok(r.includes("O4"), JSON.stringify(r));
  });
  test("mutante «#nuResultado fuera de la tarjeta» → falla O5", async () => {
    const h = await crear(); const r = fallos(verificarOrden(h.replace('<div id="nuResultado" style="margin-top:0.6rem;"></div>', "") + '<div id="nuResultado"></div>')); assert.ok(r.includes("O5"), JSON.stringify(r));
  });
  test("mutante «id duplicado» → falla O7", async () => {
    const h = await crear(); const r = fallos(verificarOrden(h + '<button id="btnCrearUsuario"></button>')); assert.ok(r.includes("O7"), JSON.stringify(r));
  });
  test("control: sin mutar no falla ninguna", async () => assert.deepEqual(fallos(verificarOrden(await crear())), []));
});
