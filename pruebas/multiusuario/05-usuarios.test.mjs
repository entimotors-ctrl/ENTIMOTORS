// taller-demo/usuarios.js REAL: la pantalla «Usuarios y equipo». Habla solo con el api-server sintetico
// (api.synthetic.test); nunca con Supabase para administrar cuentas. Lo que se comprueba aqui es el LADO
// CLIENTE: quien llama, con que credencial, a donde, y como pinta lo que le devuelven. Que el api-server
// rechace a un no-admin es del BACKEND y no se prueba aqui (ver README, tabla de GAPS).
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { sinFugas } from "./helpers/entorno.mjs";
import { marcadoPeligroso, escaparHtml } from "./helpers/dom.mjs";
import { nuevoEntorno, toasts, CUENTAS } from "./helpers/flujos.mjs";
import { UUID, SERVICE_ROLE, ANON, URL_API } from "./helpers/supabase-mock.mjs";

const XSS = ['<img src=x onerror=alert(1)>', "<script>alert(1)</script>", `"'><svg onload=alert(1)>`];
const U = (n, extra = {}) => ({ id: UUID(100 + n), nombre: `Persona ${n}`, correo: `persona${n}@example.test`, telefono: `9999-000${n}`, rol: "mecanico", activo: true, esUsted: false, ...extra });
const EQUIPO = () => [U(1, { rol: "admin", esUsted: true, nombre: "Admin Activo" }), U(2, { rol: "admin" }), U(3), U(4, { rol: "cajero" }), U(5, { activo: false }), U(6, { rol: "desarrollador" })];

/** Entorno con un admin (u otra cuenta) ya autenticado y un api-server sintetico programable. */
async function pantalla({ cuenta = CUENTAS.adminActivo, producto = "admin", apiUrl = URL_API, usuarios = EQUIPO(), api, online = true, mutar, preparar } = {}) {
  const env = nuevoEntorno({ producto, cuenta, sesionGuardada: null, apiUrl, online, ...(mutar ? { mutar } : {}), ...(preparar ? { preparar } : {}) });
  const pedidos = [];
  env.servidor.api = async (metodo, ruta, cuerpo, auth) => {
    pedidos.push({ metodo, ruta, cuerpo, auth });
    if (api) { const r = await api(metodo, ruta, cuerpo, auth, pedidos); if (r) return r; }
    if (metodo === "GET") return { status: 200, body: { usuarios } };
    return { status: 200, body: {} };
  };
  env.intentos = []; const fetchOriginal = env.win.fetch;
  env.win.fetch = (u, i) => { if (String(u).includes("/api/admin/usuarios")) env.intentos.push(String(u)); return fetchOriginal(u, i); };
  await env.asentar();
  env.pedidos = pedidos;
  env.cuerpo = () => env.doc.getElementById("usuariosCuerpo");
  env.hijos = (clase) => env.doc.querySelectorAll(clase);
  env.dibujar = async () => { await env.win.PantallaUsuarios.render(); await env.asentar(); };
  return env;
}
const llamadasApi = (env) => env.servidor.llamadas.filter((l) => l.host === "api");

describe("render — condiciones para que la pantalla tenga sentido", () => {
  test("un NO-admin (cajero) ve «solo para el administrador» y NO se hace ninguna llamada al servidor", async () => {
    const env = await pantalla({ cuenta: CUENTAS.cajeroActivo }); await env.dibujar();
    assert.match(env.cuerpo().innerHTML, /Esta sección es solo para el administrador\./); assert.equal(llamadasApi(env).length, 0); assert.equal(env.pedidos.length, 0);
  });
  test("un mecanico (en Mi Trabajo) tampoco: mensaje y CERO llamadas", async () => {
    const env = await pantalla({ cuenta: CUENTAS.mecanicoActivo, producto: "mecanico" }); await env.dibujar();
    assert.match(env.cuerpo().innerHTML, /solo para el administrador/); assert.equal(llamadasApi(env).length, 0);
  });
  test("sin sesion de Supabase (nadie autenticado): no es admin → mensaje y cero llamadas", async () => {
    const env = nuevoEntorno({ apiUrl: URL_API }); await env.asentar(); await env.win.PantallaUsuarios.render(); await env.asentar();
    assert.match(env.doc.getElementById("usuariosCuerpo").innerHTML, /solo para el administrador/); assert.equal(env.servidor.llamadas.length, 0);
  });
  test("sin apiUrl configurado: pide configurarlo y NO llama a nadie", async () => {
    const env = await pantalla({ apiUrl: "" }); await env.dibujar();
    assert.match(env.cuerpo().innerHTML, /Falta indicar la dirección del servidor/); assert.equal(llamadasApi(env).length, 0);
  });
  test("sin conexion: explica que la pantalla necesita internet y NO llama a nadie (no hay copia local)", async () => {
    const env = await pantalla({}); env.setOnline(false); await env.dibujar();
    assert.match(env.cuerpo().innerHTML, /no está disponible sin conexión/); assert.equal(llamadasApi(env).length, 0);
  });
  test("sin elemento contenedor no revienta (la vista no esta montada)", async () => {
    const env = await pantalla({}); env.doc.ids.delete("usuariosCuerpo");
    env.doc.getElementById = (id) => (id === "usuariosCuerpo" ? null : env.doc.ids.get(id));
    await env.win.PantallaUsuarios.render(); assert.equal(env.pedidos.length, 0);
  });
});

describe("la llamada al api-server: a donde, con que credencial", () => {
  test("GET /api/admin/usuarios con el token de SESION del admin, en el host del api-server y sin apikey/service-role", async () => {
    const env = await pantalla({}); await env.dibujar();
    const l = llamadasApi(env); assert.equal(l.length, 1);
    assert.deepEqual([l[0].metodo, l[0].ruta, l[0].auth, l[0].apikey], ["GET", "/api/admin/usuarios", "sesion", "ninguna"]);
    assert.equal(env.servidor.llamadas.filter((x) => x.host === "supabase" && /usuarios|admin/.test(x.ruta) && !/perfiles|auth\/v1/.test(x.ruta)).length, 0, "no debe administrar cuentas hablando con Supabase");
    sinFugas(env, [SERVICE_ROLE]);
  });
  test("la clave de servicio no existe en NINGUNA de las cabeceras enviadas (el navegador no la conoce)", async () => {
    const env = await pantalla({}); const cab = []; const f = env.win.fetch;
    env.win.fetch = (u, init) => { cab.push(JSON.stringify(init?.headers || {})); return f(u, init); };
    await env.dibujar(); assert.ok(cab.length > 0); for (const c of cab) { assert.ok(!c.includes(SERVICE_ROLE)); assert.ok(!/service_role/i.test(c)); }
    assert.ok(!env.win.ENTIMOTORS_SUPABASE.serviceRole && !env.win.ENTIMOTORS_SUPABASE.service_role);
  });
  test("las barras finales de apiUrl no duplican separadores", async () => {
    const env = await pantalla({ apiUrl: `${URL_API}///` }); await env.dibujar();
    assert.equal(llamadasApi(env)[0].ruta, "/api/admin/usuarios");
  });
  test("solo se llama al host del api-server: ningun host ajeno", async () => {
    const env = await pantalla({}); await env.dibujar(); assert.deepEqual(env.servidor.ajenas, []); assert.deepEqual(env.servidor.inesperadas, []);
  });
  test("el token que se envia es el de la sesion ACTUAL en el momento de la llamada (no uno copiado antes)", async () => {
    const env = await pantalla({}); const enviados = []; const f = env.win.fetch;
    env.win.fetch = (u, init) => { if (String(u).startsWith(URL_API)) enviados.push(String(init.headers.Authorization)); return f(u, init); };
    await env.dibujar(); const primero = enviados.at(-1);
    const nueva = env.servidor.emitirSesion(CUENTAS.adminActivo); env.win.SupabaseCliente.sesion = () => nueva; // como tras una renovacion
    await env.dibujar();
    assert.equal(enviados.length, 2); assert.notEqual(enviados[1], primero); assert.equal(enviados[1], `Bearer ${nueva.access_token}`);
    assert.equal(llamadasApi(env).at(-1).auth, "sesion");
  });
});

describe("traduccion de fallos (pedir + textoDeFallo)", () => {
  const CASOS = [
    ["401 → sesion caducada", { status: 401, body: { error: "expired" } }, /Tu sesión ha caducado\. Vuelve a entrar\./],
    ["403 → solo el administrador", { status: 403, body: { error: "forbidden" } }, /Solo el administrador puede gestionar usuarios\./],
    ["500 con mensaje → se muestra el mensaje del servidor, escapado", { status: 500, body: { error: "Fallo interno controlado" } }, /Fallo interno controlado/],
    ["500 sin cuerpo JSON → mensaje generico", { status: 500, body: null }, /No se pudo completar la operación\./],
    ["422 con cuerpo sin campo error → mensaje generico", { status: 422, body: { otro: 1 } }, /No se pudo completar la operación\./],
  ];
  for (const [nombre, respuesta, patron] of CASOS) test(nombre, async () => {
    const env = await pantalla({ api: async () => respuesta }); await env.dibujar();
    assert.match(env.cuerpo().innerHTML, patron); assert.deepEqual(marcadoPeligroso(env.cuerpo().innerHTML), []);
    assert.ok(!/Equipo ·/.test(env.cuerpo().innerHTML), "no debe pintar la tabla si el listado fallo");
  });
  test("red caida → «Sin conexion con el servidor»", async () => {
    const env = await pantalla({}); env.servidor.red = "caida"; await env.dibujar(); assert.match(env.cuerpo().innerHTML, /Sin conexión con el servidor\. Esta pantalla necesita internet\./);
  });
  test("AbortError → «tardo demasiado»", async () => {
    const env = await pantalla({}); env.servidor.red = "timeout"; await env.dibujar(); assert.match(env.cuerpo().innerHTML, /El servidor tardó demasiado en responder\./);
  });
  test("una peticion colgada se aborta a los 20 s (AbortController real) y se avisa", async () => {
    const env = await pantalla({}); let senal = null;
    env.win.fetch = (u, init) => new Promise((_, rechazar) => { senal = init.signal; init.signal.addEventListener("abort", () => { const e = new Error("abort"); e.name = "AbortError"; rechazar(e); }); });
    const p = env.win.PantallaUsuarios.render(); await env.asentar(); assert.equal(senal.aborted, false);
    await env.avanzar(19900); assert.equal(senal.aborted, false); await env.avanzar(200); await p; await env.asentar();
    assert.equal(senal.aborted, true); assert.match(env.cuerpo().innerHTML, /El servidor tardó demasiado en responder\./);
  });
  test("token ausente en la sesion del cliente → «sesion caducada» sin llamar al servidor", async () => {
    const env = await pantalla({}); env.evaluar("SupabaseCliente.sesion = () => null"); const antes = llamadasApi(env).length;
    await env.dibujar(); assert.match(env.cuerpo().innerHTML, /Tu sesión ha caducado/); assert.equal(llamadasApi(env).length, antes);
  });
});

describe("la tabla del equipo", () => {
  test("pinta una fila por persona, con conteo, rol legible y estado", async () => {
    const env = await pantalla({}); await env.dibujar(); const h = env.cuerpo().innerHTML;
    assert.match(h, /Equipo · 6/); for (const n of ["Administrador", "Mecánico", "Cajero", "Desarrollador"]) assert.ok(h.includes(`<td>${n}</td>`), n);
    assert.equal((h.match(/<tr>/g) || []).length, 1 + 6, "cabecera + una fila por persona"); assert.ok(h.includes("Inactivo")); assert.ok(h.includes("(tú)"));
  });
  test("sin controles para uno mismo ni para otros admin (ni cambiar rol, ni baja, ni editar)", async () => {
    const env = await pantalla({}); await env.dibujar();
    const ids = (c) => env.hijos(c).map((e) => e.dataset.id);
    for (const c of [".u-rol", ".u-estado", ".u-editar"]) { assert.ok(!ids(c).includes(UUID(101)), `${c}: yo`); assert.ok(!ids(c).includes(UUID(102)), `${c}: otro admin`); }
    assert.deepEqual(ids(".u-rol"), [UUID(103), UUID(104), UUID(105), UUID(106)]);
  });
  test("las opciones de rol NO incluyen «admin»: no se puede crear ni ascender a administrador desde esta pantalla", async () => {
    const env = await pantalla({}); await env.dibujar(); const h = env.cuerpo().innerHTML;
    for (const sel of h.matchAll(/<select[^>]*>(.*?)<\/select>/g)) { const vals = [...sel[1].matchAll(/value="([^"]*)"/g)].map((m) => m[1]); assert.deepEqual(vals, ["mecanico", "cajero", "desarrollador"]); }
  });
  test("el boton de estado depende de activo: «Dar de baja» / «Reactivar», con data-activo coherente", async () => {
    const env = await pantalla({}); await env.dibujar();
    const b = Object.fromEntries(env.hijos(".u-estado").map((e) => [e.dataset.id, e.dataset.activo])); assert.equal(b[UUID(103)], "1"); assert.equal(b[UUID(105)], "0");
    assert.match(env.cuerpo().innerHTML, /data-activo="1">Dar de baja</); assert.match(env.cuerpo().innerHTML, /data-activo="0">Reactivar</);
  });
  test("lista vacia / respuesta sin campo usuarios: no revienta y dice «Equipo · 0»", async () => {
    for (const body of [{ usuarios: [] }, {}, { usuarios: null }]) { const env = await pantalla({ api: async (m) => (m === "GET" ? { status: 200, body } : null) }); await env.dibujar(); assert.match(env.cuerpo().innerHTML, /Equipo · 0/); }
  });
  test("XSS: nombre, correo, telefono y rol con cargas hostiles se pintan ESCAPADOS (sin etiquetas ni manejadores nuevos)", async () => {
    for (const p of XSS) {
      const env = await pantalla({ usuarios: [U(1, { rol: "admin", esUsted: true }), U(3, { nombre: p, correo: p, telefono: p }), U(4, { rol: p })] }); await env.dibujar();
      const h = env.cuerpo().innerHTML; assert.deepEqual(marcadoPeligroso(h), [], `payload ${p}`);
      assert.ok(h.includes(escaparHtml(p)), "el dato debe verse como texto");
      assert.equal(env.hijos(".u-editar").length, 2, "el dato no debe crear elementos nuevos"); // U3 y U4 (el admin no tiene controles)
    }
  });
  test("XSS en atributo: data-nombre con comillas no puede salirse del atributo", async () => {
    const p = `"'><svg onload=alert(1)>`; const env = await pantalla({ usuarios: [U(3, { nombre: p, telefono: p })] }); await env.dibujar();
    const [boton] = env.hijos(".u-editar"); assert.equal(boton.dataset.nombre, p, "el atributo conserva el texto exacto, sin ejecutar nada"); assert.equal(boton.dataset.telefono, p);
    assert.deepEqual(marcadoPeligroso(env.cuerpo().innerHTML), []);
  });
  test("XSS en id: un id hostil no rompe el atributo data-id", async () => {
    const p = `"><img src=x onerror=alert(1)>`; const env = await pantalla({ usuarios: [U(3, { id: p })] }); await env.dibujar();
    assert.deepEqual(marcadoPeligroso(env.cuerpo().innerHTML), []); assert.equal(env.hijos(".u-rol")[0].dataset.id, p);
  });
});

describe("acciones sobre una persona", () => {
  test("cambiar rol: PATCH /<id> con SOLO {rol}, aviso «Rol actualizado» y recarga de la lista", async () => {
    const env = await pantalla({}); await env.dibujar();
    const sel = env.hijos(".u-rol").find((e) => e.dataset.id === UUID(103)); sel.value = "cajero"; await sel.disparar("change"); await env.asentar();
    const patch = env.pedidos.find((p) => p.metodo === "PATCH"); assert.deepEqual([patch.ruta, patch.cuerpo, patch.auth], [`/api/admin/usuarios/${UUID(103)}`, { rol: "cajero" }, "sesion"]);
    assert.ok(toasts(env).includes("Rol actualizado")); assert.equal(env.pedidos.filter((p) => p.metodo === "GET").length, 2);
  });
  test("cambiar rol rechazado (403): aviso del motivo y la lista se recarga para volver al valor real", async () => {
    const env = await pantalla({ api: async (m) => (m === "PATCH" ? { status: 403, body: { error: "nope" } } : null) }); await env.dibujar();
    const sel = env.hijos(".u-rol")[0]; sel.value = "desarrollador"; await sel.disparar("change"); await env.asentar();
    assert.deepEqual(toasts(env).slice(-1), ["Solo el administrador puede gestionar usuarios."]); assert.equal(env.pedidos.filter((p) => p.metodo === "GET").length, 2);
  });
  test("dar de baja: envia {activo:false} y avisa; reactivar: {activo:true}", async () => {
    const env = await pantalla({}); await env.dibujar();
    const baja = env.hijos(".u-estado").find((e) => e.dataset.id === UUID(103)); await baja.disparar("click"); await env.asentar();
    assert.deepEqual(env.pedidos.find((p) => p.metodo === "PATCH").cuerpo, { activo: false }); assert.ok(toasts(env).includes("Usuario dado de baja"));
    const env2 = await pantalla({}); await env2.dibujar();
    const alta = env2.hijos(".u-estado").find((e) => e.dataset.id === UUID(105)); await alta.disparar("click"); await env2.asentar();
    assert.deepEqual(env2.pedidos.find((p) => p.metodo === "PATCH").cuerpo, { activo: true }); assert.ok(toasts(env2).includes("Usuario reactivado"));
  });
  test("dar de baja rechazado (500): aviso y NO dice «dado de baja»; el boton se reactiva", async () => {
    const env = await pantalla({ api: async (m) => (m === "PATCH" ? { status: 500, body: { error: "Base no disponible" } } : null) }); await env.dibujar();
    const b = env.hijos(".u-estado")[0]; await b.disparar("click"); await env.asentar();
    assert.ok(!toasts(env).includes("Usuario dado de baja")); assert.ok(toasts(env).includes("Base no disponible")); assert.equal(b.disabled, false);
  });
  test("editar: dos preguntas, valores recortados, PATCH {nombre,telefono}", async () => {
    const env = await pantalla({}); await env.dibujar(); const resp = ["  Nuevo Nombre  ", " 8888-1111 "], preguntas = [];
    env.win.showPrompt = async (texto, opts) => { preguntas.push([texto, opts]); return resp.shift(); };
    const ed = env.hijos(".u-editar").find((e) => e.dataset.id === UUID(103)); await ed.disparar("click"); await env.asentar();
    assert.equal(preguntas[0][1].valorInicial, "Persona 3"); assert.equal(preguntas[1][1].valorInicial, "9999-0003");
    assert.deepEqual(env.pedidos.find((p) => p.metodo === "PATCH").cuerpo, { nombre: "Nuevo Nombre", telefono: "8888-1111" }); assert.ok(toasts(env).includes("Datos actualizados"));
  });
  test("editar cancelado (en la primera o en la segunda pregunta): NO se envia nada", async () => {
    for (const resp of [[null], ["Nombre", null]]) {
      const env = await pantalla({}); await env.dibujar(); env.win.showPrompt = async () => resp.shift();
      await env.hijos(".u-editar")[0].disparar("click"); await env.asentar(); assert.equal(env.pedidos.filter((p) => p.metodo === "PATCH").length, 0);
    }
  });
  test("mientras hay una operacion en curso se ignoran las demas (no hay doble envio)", async () => {
    let liberar; const espera = new Promise((r) => { liberar = r; });
    const env = await pantalla({ api: async (m) => { if (m === "PATCH") await espera; return null; } }); await env.dibujar();
    const [a, b] = env.hijos(".u-estado"); const p1 = a.disparar("click"); await env.asentar(); const p2 = b.disparar("click"); await env.asentar();
    assert.equal(env.pedidos.filter((p) => p.metodo === "PATCH").length, 1); liberar(); await p1; await p2; await env.asentar();
    assert.equal(env.pedidos.filter((p) => p.metodo === "PATCH").length, 1);
  });
  test("OBSERVACION (endurecimiento, no explotable desde entrada de usuario): el id NO se codifica en la ruta; un id con «../» devuelto por el servidor cambiaria de endpoint", async () => {
    // El id lo genera Postgres (UUID) y llega en la respuesta del PROPIO api-server; ningun campo que escriba un
    // usuario llega a esta ruta. Por eso es una observacion H-1 y no un hallazgo: haria falta un backend comprometido.
    const env = await pantalla({ usuarios: [U(3, { id: "abc/../../otra" })] }); await env.dibujar();
    await env.hijos(".u-estado")[0].disparar("click"); await env.asentar();
    assert.equal(env.pedidos.find((p) => p.metodo === "PATCH").ruta, "/api/admin/otra", "caracterizacion: el navegador normaliza los segmentos «..»");
  });
});

describe("crear usuario", () => {
  const rellenar = (env, d) => { for (const [id, v] of Object.entries({ nuNombre: d.nombre, nuCorreo: d.correo, nuTelefono: d.telefono, nuRol: d.rol })) env.doc.getElementById(id).value = v; };
  const RESP = { enlaceParaEstablecerClave: "https://app.synthetic.test/#access_token=ficticio&type=recovery", nota: "Comparte este enlace por un canal seguro." };
  test("el formulario NO tiene campo de contraseña: la clave la elige la persona con un enlace de un solo uso", async () => {
    const env = await pantalla({}); await env.dibujar(); const h = env.cuerpo().innerHTML;
    assert.ok(!/type="password"/i.test(h)); assert.ok(!/id="nu(Clave|Pass|Password|Contras)/i.test(h)); assert.match(h, /El administrador nunca llega a conocerla/);
  });
  test("POST con nombre/correo/telefono/rol recortados y SIN ningun campo de clave", async () => {
    const env = await pantalla({ api: async (m) => (m === "POST" ? { status: 201, body: RESP } : null) }); await env.dibujar();
    rellenar(env, { nombre: "  Ana Pérez ", correo: " ana@example.test ", telefono: " 5555-0000 ", rol: "cajero" });
    await env.doc.getElementById("btnCrearUsuario").disparar("click"); await env.asentar();
    const post = env.pedidos.find((p) => p.metodo === "POST"); assert.deepEqual([post.ruta, post.auth], ["/api/admin/usuarios", "sesion"]);
    assert.deepEqual(post.cuerpo, { nombre: "Ana Pérez", correo: "ana@example.test", telefono: "5555-0000", rol: "cajero" });
    assert.ok(!Object.keys(post.cuerpo).some((k) => /pass|clave|contras/i.test(k)));
  });
  test("cuenta creada: muestra el enlace en un campo de SOLO LECTURA con el valor escapado, y NO refresca la lista sola", async () => {
    const env = await pantalla({ api: async (m) => (m === "POST" ? { status: 201, body: RESP } : null) }); await env.dibujar();
    rellenar(env, { nombre: "Ana", correo: "ana@example.test", telefono: "", rol: "mecanico" }); await env.doc.getElementById("btnCrearUsuario").disparar("click"); await env.asentar();
    const h = env.doc.getElementById("nuResultado").innerHTML;
    assert.match(h, /Cuenta creada\./); assert.match(h, /<input type="text" readonly value="/); assert.ok(h.includes(escaparHtml(RESP.enlaceParaEstablecerClave)));
    assert.match(h, /Comparte este enlace por un canal seguro\./); assert.deepEqual(marcadoPeligroso(h), []);
    assert.equal(env.pedidos.filter((p) => p.metodo === "GET").length, 1, "no debe recargar la lista todavia"); assert.ok(toasts(env).includes("Usuario creado"));
  });
  test("«Listo · actualizar lista» recarga la lista", async () => {
    const env = await pantalla({ api: async (m) => (m === "POST" ? { status: 201, body: RESP } : null) }); await env.dibujar();
    rellenar(env, { nombre: "Ana", correo: "ana@example.test", telefono: "", rol: "mecanico" }); await env.doc.getElementById("btnCrearUsuario").disparar("click"); await env.asentar();
    await env.doc.getElementById("btnListoUsuario").disparar("click"); await env.asentar(); assert.equal(env.pedidos.filter((p) => p.metodo === "GET").length, 2);
  });
  test("«Copiar enlace» usa el portapapeles con el enlace y marca «Copiado»", async () => {
    const env = await pantalla({ api: async (m) => (m === "POST" ? { status: 201, body: RESP } : null) }); await env.dibujar();
    const copiado = []; env.win.navigator.clipboard.writeText = async (t) => { copiado.push(t); };
    rellenar(env, { nombre: "Ana", correo: "ana@example.test", telefono: "", rol: "mecanico" }); await env.doc.getElementById("btnCrearUsuario").disparar("click"); await env.asentar();
    env.doc.getElementById("nuEnlace").value = RESP.enlaceParaEstablecerClave; const b = env.doc.getElementById("btnCopiarEnlace"); await b.disparar("click"); await env.asentar();
    assert.deepEqual(copiado, [RESP.enlaceParaEstablecerClave]); assert.equal(b.textContent, "Copiado");
  });
  test("respuesta sin enlace: no pinta campo ni boton de copiar, pero sigue confirmando", async () => {
    const env = await pantalla({ api: async (m) => (m === "POST" ? { status: 201, body: { nota: "Listo" } } : null) }); await env.dibujar();
    rellenar(env, { nombre: "Ana", correo: "ana@example.test", telefono: "", rol: "mecanico" }); await env.doc.getElementById("btnCrearUsuario").disparar("click"); await env.asentar();
    const h = env.doc.getElementById("nuResultado").innerHTML; assert.ok(!/readonly|btnCopiarEnlace/.test(h)); assert.match(h, /Cuenta creada\./);
  });
  test("error al crear (correo repetido): se muestra el mensaje del servidor ESCAPADO dentro de la caja y no se crea nada", async () => {
    for (const p of XSS) {
      const env = await pantalla({ api: async (m) => (m === "POST" ? { status: 409, body: { error: `Correo ya usado: ${p}` } } : null) }); await env.dibujar();
      rellenar(env, { nombre: "Ana", correo: "ana@example.test", telefono: "", rol: "mecanico" }); await env.doc.getElementById("btnCrearUsuario").disparar("click"); await env.asentar();
      const h = env.doc.getElementById("nuResultado").innerHTML; assert.match(h, /gate-error/); assert.deepEqual(marcadoPeligroso(h), [], p); assert.ok(h.includes(escaparHtml(p)));
      assert.ok(!toasts(env).includes("Usuario creado"));
    }
  });
  test("«Nuevo usuario» / «Cancelar» muestran y ocultan el formulario", async () => {
    const env = await pantalla({}); await env.dibujar(); const card = env.doc.getElementById("cardNuevoUsuario");
    assert.equal(card.style.display, undefined); // el HTML lo trae oculto (display:none en linea)
    card.style.display = "none"; await env.doc.getElementById("btnNuevoUsuario").disparar("click"); assert.equal(card.style.display, "");
    await env.doc.getElementById("btnCancelarUsuario").disparar("click"); assert.equal(card.style.display, "none");
  });
  test("el boton se bloquea mientras crea y se restaura despues, incluso si falla", async () => {
    const env = await pantalla({ api: async (m) => (m === "POST" ? { status: 500, body: { error: "x" } } : null) }); await env.dibujar();
    rellenar(env, { nombre: "Ana", correo: "a@example.test", telefono: "", rol: "mecanico" }); const b = env.doc.getElementById("btnCrearUsuario");
    await b.disparar("click"); await env.asentar(); assert.equal(b.disabled, false); assert.equal(b.textContent, "Crear");
  });
});

describe("mutantes de usuarios.js: cada garantia se ROMPE si se altera la linea que la sostiene", () => {
  const cambiar = (de, a) => (t) => t.replace(de, a);
  const RESP = { enlaceParaEstablecerClave: "https://app.synthetic.test/#x", nota: "n" };
  const P = XSS[0];
  const PROPIEDADES = {
    "un no-admin no llama al servidor": async (m) => { const e = await pantalla({ cuenta: CUENTAS.cajeroActivo, mutar: m }); await e.dibujar(); return e.pedidos.length === 0; },
    "el listado se pide con el token de sesion": async (m) => { const e = await pantalla({ mutar: m }); await e.dibujar(); return llamadasApi(e)[0]?.auth === "sesion"; },
    "el nombre se pinta escapado": async (m) => { const e = await pantalla({ usuarios: [U(3, { nombre: P })], mutar: m }); await e.dibujar(); return marcadoPeligroso(e.cuerpo().innerHTML).length === 0; },
    "el correo se pinta escapado": async (m) => { const e = await pantalla({ usuarios: [U(3, { correo: P })], mutar: m }); await e.dibujar(); return marcadoPeligroso(e.cuerpo().innerHTML).length === 0; },
    "data-nombre no se sale del atributo": async (m) => { const e = await pantalla({ usuarios: [U(3, { nombre: `"><img src=x onerror=alert(1)>` })], mutar: m }); await e.dibujar(); return marcadoPeligroso(e.cuerpo().innerHTML).length === 0; },
    "dar de baja envia activo:false": async (m) => { const e = await pantalla({ mutar: m }); await e.dibujar(); await e.hijos(".u-estado").find((x) => x.dataset.id === UUID(103)).disparar("click"); await e.asentar(); return e.pedidos.find((p) => p.metodo === "PATCH")?.cuerpo?.activo === false; },
    "el error al crear se muestra escapado": async (m) => {
      const e = await pantalla({ api: async (x) => (x === "POST" ? { status: 409, body: { error: P } } : null), mutar: m }); await e.dibujar();
      await e.doc.getElementById("btnCrearUsuario").disparar("click"); await e.asentar(); return marcadoPeligroso(e.doc.getElementById("nuResultado").innerHTML).length === 0;
    },
    "el enlace se pinta escapado": async (m) => {
      const e = await pantalla({ api: async (x) => (x === "POST" ? { status: 201, body: { ...RESP, enlaceParaEstablecerClave: `"><img src=x onerror=alert(1)>` } } : null), mutar: m }); await e.dibujar();
      await e.doc.getElementById("btnCrearUsuario").disparar("click"); await e.asentar(); return marcadoPeligroso(e.doc.getElementById("nuResultado").innerHTML).length === 0;
    },
    "no se puede crear un administrador desde la pantalla": async (m) => { const e = await pantalla({ mutar: m }); await e.dibujar(); return !/<option value="admin"/.test(e.cuerpo().innerHTML); },
    "sin conexion no se llama al servidor": async (m) => { const e = await pantalla({ mutar: m }); e.setOnline(false); await e.dibujar(); return e.intentos.length === 0; },
    "sin apiUrl no se llama a nadie": async (m) => { const e = await pantalla({ apiUrl: "", mutar: m }); await e.dibujar(); return e.intentos.length === 0; },
    "el cuerpo de crear no lleva clave": async (m) => {
      const e = await pantalla({ api: async (x) => (x === "POST" ? { status: 201, body: RESP } : null), mutar: m }); await e.dibujar();
      await e.doc.getElementById("btnCrearUsuario").disparar("click"); await e.asentar(); return !Object.keys(e.pedidos.find((p) => p.metodo === "POST").cuerpo).some((k) => /pass|clave/i.test(k));
    },
  };
  const MUTANTES = [
    ["un no-admin no llama al servidor", "quitar la comprobacion de admin", cambiar("if (!global.Auth || !Auth.esAdmin()) {", "if (false) {")],
    ["el listado se pide con el token de sesion", "enviar un token que no es el de la sesion", cambiar('Authorization: "Bearer " + ses.access_token', 'Authorization: "Bearer invalido"')],
    ["el nombre se pinta escapado", "no escapar el nombre en la celda", cambiar('"<td>" + esc(u.nombre) + (u.esUsted', '"<td>" + u.nombre + (u.esUsted')],
    ["el correo se pinta escapado", "no escapar el correo", cambiar('"<td>" + esc(u.correo) + "</td>"', '"<td>" + u.correo + "</td>"')],
    ["data-nombre no se sale del atributo", "no escapar data-nombre", cambiar("'\" data-nombre=\"' + esc(u.nombre) +", "'\" data-nombre=\"' + u.nombre +")],
    ["dar de baja envia activo:false", "invertir el valor de activo", cambiar('{ activo: b.dataset.activo !== "1" }', '{ activo: b.dataset.activo === "1" }')],
    ["el error al crear se muestra escapado", "no escapar el mensaje del servidor", cambiar("return esc(r.mensaje || \"No se pudo completar la operación.\");", "return (r.mensaje || \"No se pudo completar la operación.\");")],
    ["el enlace se pinta escapado", "no escapar el enlace", cambiar("' + esc(enlace) + '", "' + enlace + '")],
    ["no se puede crear un administrador desde la pantalla", "ofrecer «admin» como rol", cambiar('{ valor: "cajero", texto: "Cajero" },', '{ valor: "cajero", texto: "Cajero" }, { valor: "admin", texto: "Administrador" },')],
    ["sin conexion no se llama al servidor", "quitar TODAS las comprobaciones de conexion (aviso y pedir)", (t) => t.replaceAll("navigator.onLine === false", "false")],
    ["sin apiUrl no se llama a nadie", "quitar TODAS las comprobaciones de apiUrl (aviso y pedir)", (t) => t.replaceAll("if (!baseApi()) {", "if (false) {").replaceAll("if (!base) return", "if (false) return")],
    ["el cuerpo de crear no lleva clave", "enviar una clave elegida por el admin", cambiar('rol: document.getElementById("nuRol").value,\n      });', 'rol: document.getElementById("nuRol").value, password: "x",\n      });')],
  ];
  for (const [prop, que, mut] of MUTANTES) test(`${prop} — mutante: ${que}`, async () => {
    assert.equal(await PROPIEDADES[prop]({}), true, "con el runtime REAL la propiedad debe cumplirse");
    assert.equal(await PROPIEDADES[prop]({ usuarios: mut }), false, "el mutante SOBREVIVE: ninguna prueba protege esta garantia");
  });
  test("cada propiedad tiene al menos un mutante", () => assert.deepEqual(Object.keys(PROPIEDADES).filter((p) => !MUTANTES.some((m) => m[0] === p)), []));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// OBS-9 · PLAN B (4E-C7-FIX-B) — «GENERAR ENLACE» (recuperacion mediada por el administrador). Solo el LADO CLIENTE: el servidor lo prueba
// 21-backend-enlace-recuperacion. Todo enlace/token de aqui es sintetico. Cada garantia lleva su prueba de MUTACION.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const ENLACE = (n = 1) => `https://synthetic.example.test/entimotors-os/index.html#access_token=TOKEN-SINTETICO-${n}&type=recovery&x=%C3%B1`;
const nodos = (el) => [el, ...((el.children || []).flatMap(nodos))];
const etiqueta = (n) => String(n.tagName || "").toLowerCase();
const cajaEnlace = (env) => env.doc.getElementById("cardEnlaceRecuperacion");
const campoEnlace = (env) => nodos(cajaEnlace(env)).find((n) => etiqueta(n) === "input");
/** Oculta = el `display:none` que trae el HTML (el DOM falso no lo refleja en style.display hasta que se toca) o el que pone limpiarEnlace(). */
const oculta = (env) => cajaEnlace(env).style.display !== "";
const boton = (env, texto) => nodos(cajaEnlace(env)).find((n) => etiqueta(n) === "button" && n.textContent === texto);
const escaparTexto = (t) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** Entorno de admin con «Generar enlace» listo: el confirm se acepta (o se rechaza) y el api-server responde `respuesta(id, n)` al POST de enlace. */
async function conEnlace({ respuesta = (id, n) => ({ status: 200, body: { enlaceParaEstablecerClave: ENLACE(n), nota: "x" } }), acepta = true, mutar, preparar, cuenta, producto } = {}) {
  let n = 0;
  const env = await pantalla({ mutar, preparar, ...(cuenta ? { cuenta } : {}), ...(producto ? { producto } : {}),
    api: async (m, ruta) => { const x = /\/api\/admin\/usuarios\/([^/]+)\/enlace$/.exec(ruta); return m === "POST" && x ? respuesta(x[1], ++n) : null; } });
  env.preguntas = []; env.win.showConfirm = async (texto, opts) => { env.preguntas.push({ texto, opts }); return acepta; };
  await env.dibujar();
  env.generar = async (id) => { const b = env.hijos(".u-enlace").find((e) => e.dataset.id === id); await b.disparar("click"); await env.asentar(); return b; };
  env.pedidosEnlace = () => env.pedidos.filter((p) => p.metodo === "POST" && /\/enlace$/.test(p.ruta));
  return env;
}

describe("OBS-9 · «Generar enlace»: quién lo ve", () => {
  test("el administrador lo ve en las personas ACTIVAS que no son administrador (U3 mecánico, U4 cajero, U6 desarrollador)", async () => {
    const env = await conEnlace(); assert.deepEqual(env.hijos(".u-enlace").map((b) => b.dataset.id).sort(), [UUID(103), UUID(104), UUID(106)].sort());
    assert.equal((env.cuerpo().innerHTML.match(/class="btn small ghost u-enlace"[^>]*>Generar enlace<\/button>/g) || []).length, 3, "el texto del botón es «Generar enlace»");
  });
  test("NO aparece en su PROPIA fila, ni en la de otro administrador, ni en la de una persona INACTIVA", async () => {
    const env = await conEnlace(); const ids = env.hijos(".u-enlace").map((b) => b.dataset.id);
    assert.ok(!ids.includes(UUID(101)), "propia fila (admin, «tú»)"); assert.ok(!ids.includes(UUID(102)), "otro administrador"); assert.ok(!ids.includes(UUID(105)), "persona inactiva");
  });
  test("aunque el servidor marque `esUsted` en una cuenta que no es admin, tampoco: la propia fila nunca tiene acciones", async () => {
    const env = await pantalla({ usuarios: [U(1, { rol: "admin", esUsted: true }), U(3, { esUsted: true })] }); await env.dibujar();
    assert.equal(env.hijos(".u-enlace").length, 0);
  });
  test("un cajero o un mecánico (en Mi Trabajo) NO llegan a la pantalla: ningún botón y ni una llamada al servidor", async () => {
    for (const [cuenta, producto] of [[CUENTAS.cajeroActivo, "admin"], [CUENTAS.mecanicoActivo, "mecanico"]]) {
      const env = await conEnlace({ cuenta, producto }); assert.equal(env.hijos(".u-enlace").length, 0); assert.equal(env.pedidos.length, 0); assert.equal(llamadasApi(env).length, 0);
      assert.match(env.cuerpo().innerHTML, /solo para el administrador/);
    }
  });
});

describe("OBS-9 · «Generar enlace»: la petición", () => {
  test("pide confirmación CLARA (nombre, un solo uso, reemplaza el anterior, no se envía por correo); si se rechaza NO hay ninguna llamada", async () => {
    const env = await conEnlace({ acepta: false }); await env.generar(UUID(103));
    assert.equal(env.preguntas.length, 1); const q = env.preguntas[0];
    assert.match(q.texto, /Persona 3/); assert.match(q.texto, /un solo uso/); assert.match(q.texto, /dejará de servir/); assert.match(q.texto, /no se envía por correo/);
    assert.equal(q.opts.titulo, "Generar enlace de recuperación"); assert.equal(q.opts.textoOk, "Generar enlace"); assert.equal(q.opts.textoCancelar, "Cancelar");
    assert.equal(env.pedidosEnlace().length, 0); assert.ok(oculta(env));
  });
  test("al confirmar: POST /api/admin/usuarios/<id>/enlace, SIN cuerpo (no manda correo, rol ni redirect), con la sesión del admin", async () => {
    const env = await conEnlace(); await env.generar(UUID(104)); const [p] = env.pedidosEnlace();
    assert.equal(env.pedidosEnlace().length, 1); assert.equal(p.metodo, "POST"); assert.equal(p.ruta, `/api/admin/usuarios/${UUID(104)}/enlace`); assert.equal(p.auth, "sesion");
    assert.ok(p.cuerpo === undefined || p.cuerpo === null || p.cuerpo === "", `el POST no debe llevar cuerpo: ${JSON.stringify(p.cuerpo)}`);
  });
  test("el botón se bloquea mientras se genera y no se lanzan dos peticiones", async () => {
    let suelta; const env = await conEnlace({ respuesta: () => new Promise((r) => { suelta = () => r({ status: 200, body: { enlaceParaEstablecerClave: ENLACE(1) } }); }) });
    const b = env.hijos(".u-enlace")[0]; const p = b.disparar("click"); await env.asentar(); assert.equal(b.disabled, true);
    await env.hijos(".u-enlace")[1].disparar("click"); await env.asentar(); assert.equal(env.pedidosEnlace().length, 1, "la segunda no debe salir mientras la primera sigue");
    suelta(); await p; await env.asentar(); assert.equal(b.disabled, false);
  });
});

describe("OBS-9 · «Generar enlace»: el resultado", () => {
  test("se muestra en la caja de resultado: campo de solo lectura con el enlace EXACTO, «Copiar enlace» y «Cerrar»; aviso «Enlace generado» (sin el enlace)", async () => {
    const env = await conEnlace(); await env.generar(UUID(103)); const caja = cajaEnlace(env), campo = campoEnlace(env);
    assert.equal(caja.style.display, ""); assert.equal(campo.value, ENLACE(1)); assert.equal(campo.readOnly, true); assert.equal(campo.attributes.readonly, "readonly");
    assert.ok(boton(env, "Copiar enlace") && boton(env, "Cerrar")); assert.match(caja.textContent, /Para: Persona 3\./); assert.match(caja.textContent, /No se envía por correo/);
    assert.ok(toasts(env).includes("Enlace generado")); assert.ok(!toasts(env).join("").includes("TOKEN-SINTETICO"));
  });
  test("SEGURO: se pinta con nodos DOM, NUNCA con innerHTML con datos del servidor (ni el enlace ni el nombre pasan por marcado)", async () => {
    const env = await conEnlace(); await env.generar(UUID(103));
    assert.ok(env.doc.sumideros.every((s) => !s.html.includes("TOKEN-SINTETICO")), "el enlace llegó a un innerHTML");
    assert.deepEqual(nodos(cajaEnlace(env)).slice(1).map(etiqueta).sort(), ["button", "button", "div", "h3", "input", "p"], "la caja tiene EXACTAMENTE los nodos previstos");
  });
  test("XSS: un enlace o un nombre con marcado se ve como TEXTO/valor: no crea elementos ni ejecuta nada", async () => {
    const hostil = 'https://x.example.test/"><svg/onload=alert(1)>#a=1';
    const env = await pantalla({ usuarios: [U(1, { rol: "admin", esUsted: true }), U(3, { nombre: '<img src=x onerror="window.__xss=1">' })], api: async (m, r) => (m === "POST" && /enlace$/.test(r) ? { status: 200, body: { enlaceParaEstablecerClave: hostil } } : null) });
    env.win.showConfirm = async () => true; env.win.__xss = 0; await env.dibujar(); await env.hijos(".u-enlace")[0].disparar("click"); await env.asentar();
    assert.equal(campoEnlace(env).value, hostil); assert.equal(env.win.__xss, 0); assert.deepEqual(marcadoPeligroso(cajaEnlace(env).innerHTML || ""), []);
    assert.equal(nodos(cajaEnlace(env)).filter((n) => ["img", "svg", "script"].includes(etiqueta(n))).length, 0); assert.ok(cajaEnlace(env).textContent.includes('<img src=x onerror="window.__xss=1">'), "el nombre se lee como texto literal");
  });
  test("un «enlace» que no es http(s) (javascript:, sin esquema, con espacios, número, null, objeto) NO se muestra: aviso y caja vacía", async () => {
    for (const malo of ["javascript:alert(1)", "sin-esquema", "https://x.test/a b", 12345, null, { url: "https://x.test" }, "", "data:text/html,<script>1</script>"]) {
      const env = await conEnlace({ respuesta: () => ({ status: 200, body: { enlaceParaEstablecerClave: malo } }) }); await env.generar(UUID(103));
      assert.ok(oculta(env), String(malo)); assert.equal(campoEnlace(env), undefined); assert.ok(toasts(env).some((t) => /no devolvió un enlace utilizable/.test(t)), String(malo));
      assert.equal(env.hijos(".u-enlace")[0].disabled, false, "el botón se libera");
    }
  });
  test("error del servidor (403, 404, 409, 502, 503): se pinta como TEXTO escapado en el aviso; sin caja; y el botón vuelve a funcionar", async () => {
    for (const [status, texto] of [[403, "Solo el administrador puede gestionar usuarios."], [404, "Ese usuario no existe."], [409, "Esa cuenta está dada de baja. Reactívala antes de generar un enlace de recuperación."], [502, "Supabase no aceptó generar el enlace."], [503, "Falta ENTIMOTORS_MECHANIC_ORIGIN en el servidor."]]) {
      const env = await conEnlace({ respuesta: () => ({ status, body: { error: texto } }) }); await env.generar(UUID(103));
      assert.ok(env.doc.sumideros.some((s) => /^<span class="dot off"><\/span>/.test(s.html) && s.html.includes(escaparTexto(texto))), `${status}: el aviso debe traer el mensaje`);
      assert.ok(oculta(env), `${status}: sin caja`); assert.equal(env.hijos(".u-enlace")[0].disabled, false, `${status}: botón liberado`);
    }
  });
  test("error con marcado hostil en el mensaje del servidor: texto escapado, sin elementos, canario sin ejecutar", async () => {
    const env = await conEnlace({ respuesta: () => ({ status: 409, body: { error: '<img src=x onerror="window.__xss=2"><script>window.__xss=3</script>' } }) }); env.win.__xss = 0; await env.generar(UUID(103));
    const t = env.doc.sumideros.filter((s) => /^<span class="dot off">/.test(s.html)).map((s) => s.html); assert.equal(t.length, 1); assert.deepEqual(marcadoPeligroso(t[0]), []); assert.equal(env.win.__xss, 0); assert.ok(t[0].includes("&lt;img"));
  });
  test("sin conexión: mensaje claro, ninguna llamada y ninguna caja", async () => {
    const env = await conEnlace(); env.setOnline(false); await env.generar(UUID(103)); assert.equal(env.pedidosEnlace().length, 0); assert.ok(toasts(env).some((t) => /Sin conexión con el servidor/.test(t))); assert.ok(oculta(env));
  });
});

describe("OBS-9 · «Generar enlace»: Copiar enlace", () => {
  test("copia EXACTAMENTE lo que se ve (con &, %, # y acentos codificados), sin recortar ni cambiar nada, y el botón dice «Copiado»", async () => {
    const env = await conEnlace(); const copiados = []; env.win.navigator.clipboard = { writeText: async (t) => { copiados.push(t); } };
    await env.generar(UUID(103)); const b = boton(env, "Copiar enlace"); await b.disparar("click"); await env.asentar();
    assert.deepEqual(copiados, [ENLACE(1)]); assert.equal(b.textContent, "Copiado"); assert.equal(campoEnlace(env).value, ENLACE(1), "el campo no cambió");
  });
  test("si el navegador NO deja copiar (sin permiso y sin execCommand): aviso «cópialo a mano» y el enlace sigue en el campo", async () => {
    const env = await conEnlace(); env.win.navigator.clipboard = { writeText: async () => { throw new Error("NotAllowedError"); } }; env.doc.execCommand = () => false;
    await env.generar(UUID(103)); await boton(env, "Copiar enlace").disparar("click"); await env.asentar();
    assert.ok(toasts(env).some((t) => /cópialo a mano/.test(t))); assert.equal(campoEnlace(env).value, ENLACE(1));
  });
  test("sin API de portapapeles usa document.execCommand('copy') sobre el campo", async () => {
    const env = await conEnlace(); env.win.navigator.clipboard = undefined; const orden = []; env.doc.execCommand = (c) => { orden.push(c); return true; };
    await env.generar(UUID(103)); const b = boton(env, "Copiar enlace"); await b.disparar("click"); await env.asentar(); assert.deepEqual(orden, ["copy"]); assert.equal(b.textContent, "Copiado");
  });
});

describe("OBS-9 · «Generar enlace»: vida del enlace (no se guarda en ningún sitio y se retira)", () => {
  test("NO queda en localStorage, sessionStorage, consola, bitácora ni base local (solo en el campo)", async () => {
    const env = await conEnlace(); const audit = env.espiar("registrarAuditoria"); await env.generar(UUID(103)); await boton(env, "Copiar enlace").disparar("click"); await env.asentar();
    const todo = JSON.stringify({ l: env.almacen.volcado(), s: env.almacenSesion.volcado(), c: env.consola, idb: env.idbAbiertas, a: env.alertas, nav: env.navegaciones, ventanas: env.ventanas.length });
    assert.ok(!todo.includes("TOKEN-SINTETICO") && !todo.includes("type=recovery") && !todo.includes("synthetic.example.test"), "el enlace o su token llegó a un almacén, a la consola o a la navegación"); assert.equal(audit.length, 0, "no se escribe en la bitácora");
    assert.ok(env.doc.sumideros.every((s) => !s.html.includes("TOKEN-SINTETICO")), "ni a un innerHTML"); assert.ok(campoEnlace(env).value.includes("TOKEN-SINTETICO"), "solo vive en el campo");
  });
  test("un enlace NUEVO reemplaza al anterior: una sola caja, con el nuevo; el campo viejo queda VACÍO", async () => {
    const env = await conEnlace(); await env.generar(UUID(103)); const viejo = campoEnlace(env); assert.equal(viejo.value, ENLACE(1));
    await env.generar(UUID(104)); const nuevo = campoEnlace(env); assert.equal(nuevo.value, ENLACE(2)); assert.equal(nodos(cajaEnlace(env)).filter((n) => etiqueta(n) === "input").length, 1); assert.equal(viejo.value, "", "el enlace anterior se vació"); assert.match(cajaEnlace(env).textContent, /Persona 4/);
  });
  test("el enlace anterior se retira ANTES de pedir el nuevo (si el nuevo falla, no queda el viejo a la vista)", async () => {
    let n = 0; const env = await conEnlace({ respuesta: () => (++n === 1 ? { status: 200, body: { enlaceParaEstablecerClave: ENLACE(1) } } : { status: 409, body: { error: "nope" } }) });
    await env.generar(UUID(103)); assert.equal(campoEnlace(env).value, ENLACE(1)); await env.generar(UUID(104)); assert.equal(campoEnlace(env), undefined); assert.ok(oculta(env));
  });
  test("«Cerrar» retira el enlace (caja vacía y oculta, campo vaciado)", async () => {
    const env = await conEnlace(); await env.generar(UUID(103)); const campo = campoEnlace(env); await boton(env, "Cerrar").disparar("click");
    assert.ok(oculta(env)); assert.equal(cajaEnlace(env).children.length, 0); assert.equal(campo.value, "");
  });
  test("volver a pintar la pantalla (o volver a entrar en ella) NO deja el enlace anterior", async () => {
    const env = await conEnlace(); await env.generar(UUID(103)); const campo = campoEnlace(env); await env.dibujar();
    assert.equal(campo.value, ""); assert.ok(oculta(env)); assert.equal(cajaEnlace(env).children.length, 0);
  });
  test("cerrar sesión (evento SIGNED_OUT de Auth) retira el enlace", async () => {
    const env = await conEnlace(); await env.generar(UUID(103)); const campo = campoEnlace(env); await env.win.Auth.cerrarSesion(); await env.asentar();
    assert.equal(campo.value, ""); assert.ok(oculta(env)); assert.equal(cajaEnlace(env).children.length, 0);
  });
  test("cambiar de vista (la sección deja de estar `active`) retira el enlace; mientras siga activa, NO", async () => {
    const obs = []; const preparar = (env) => { env.win.MutationObserver = class { constructor(cb) { this.cb = cb; obs.push(this); } observe(el, o) { this.el = el; this.o = o; } disconnect() {} }; };
    const env = await conEnlace({ preparar }); assert.equal(obs.length, 1, "un solo observador"); assert.equal(obs[0].el, env.doc.getElementById("view-usuarios")); assert.equal(JSON.stringify(obs[0].o), JSON.stringify({ attributes: true, attributeFilter: ["class"] }));
    env.doc.getElementById("view-usuarios").classList.add("active"); await env.generar(UUID(103)); const campo = campoEnlace(env);
    obs[0].cb([]); assert.equal(campo.value, ENLACE(1), "sigue en la pantalla: no se retira");
    env.doc.getElementById("view-usuarios").classList.remove("active"); obs[0].cb([]); assert.equal(campo.value, ""); assert.ok(oculta(env));
  });
});

describe("OBS-9 · «Generar enlace»: pruebas de MUTACIÓN de usuarios.js", () => {
  const mut = (de, a) => (t) => { assert.ok(t.includes(de), `el mutante no encuentra: ${de.slice(0, 70)}`); return t.replace(de, a); };
  const casos = [
    ["el botón aparece también en personas INACTIVAS", mut("(u.activo ? '<button class=\"btn small ghost u-enlace\"", "(true ? '<button class=\"btn small ghost u-enlace\""), async (m) => { const e = await conEnlace({ mutar: { usuarios: m } }); assert.ok(!e.hijos(".u-enlace").some((b) => b.dataset.id === UUID(105))); }],
    ["se pinta la caja con innerHTML (el enlace pasa por marcado)", mut("caja.appendChild(campo); caja.appendChild(fila);", "caja.appendChild(campo); caja.appendChild(fila); caja.innerHTML += enlace;"), async (m) => { const e = await conEnlace({ mutar: { usuarios: m } }); await e.generar(UUID(103)); assert.ok(e.doc.sumideros.every((s) => !s.html.includes("TOKEN-SINTETICO"))); }],
    ["el enlace se guarda en localStorage", mut("campo.value = enlace; campo.readOnly = true; campoEnlace = campo;", "campo.value = enlace; campo.readOnly = true; campoEnlace = campo; localStorage.setItem('ultimo_enlace', enlace);"), async (m) => { const e = await conEnlace({ mutar: { usuarios: m } }); await e.generar(UUID(103)); assert.ok(!JSON.stringify(e.almacen.volcado()).includes("TOKEN-SINTETICO")); }],
    ["el enlace se guarda en sessionStorage", mut("campo.value = enlace; campo.readOnly = true; campoEnlace = campo;", "campo.value = enlace; campo.readOnly = true; campoEnlace = campo; sessionStorage.setItem('ultimo_enlace', enlace);"), async (m) => { const e = await conEnlace({ mutar: { usuarios: m } }); await e.generar(UUID(103)); assert.ok(!JSON.stringify(e.almacenSesion.volcado()).includes("TOKEN-SINTETICO")); }],
    ["el enlace se escribe en la consola", mut("mostrarEnlace(nombre, enlace);\n        bien(\"Enlace generado\");", "console.log(enlace); mostrarEnlace(nombre, enlace);\n        bien(\"Enlace generado\");"), async (m) => { const e = await conEnlace({ mutar: { usuarios: m } }); await e.generar(UUID(103)); assert.ok(!JSON.stringify(e.consola).includes("TOKEN-SINTETICO")); }],
    ["«Copiar enlace» altera el texto copiado", mut("var texto = campo.value, listo", "var texto = campo.value.trim() + ' ', listo"), async (m) => { const e = await conEnlace({ mutar: { usuarios: m } }); const c = []; e.win.navigator.clipboard = { writeText: async (t) => c.push(t) }; await e.generar(UUID(103)); await boton(e, "Copiar enlace").disparar("click"); await e.asentar(); assert.deepEqual(c, [ENLACE(1)]); }],
    ["limpiarEnlace no hace nada (el enlace nunca se retira)", mut("function limpiarEnlace() {", "function limpiarEnlace() { return;"), async (m) => { const e = await conEnlace({ mutar: { usuarios: m } }); await e.generar(UUID(103)); await boton(e, "Cerrar").disparar("click"); assert.equal(cajaEnlace(e).children.length, 0); }],
    ["cerrar sesión ya no retira el enlace", mut("if (evento === \"SIGNED_OUT\") limpiarEnlace();", "if (evento === \"NUNCA\") limpiarEnlace();"), async (m) => { const e = await conEnlace({ mutar: { usuarios: m } }); await e.generar(UUID(103)); const campo = campoEnlace(e); await e.win.Auth.cerrarSesion(); await e.asentar(); assert.equal(campo.value, ""); }],
    ["se acepta cualquier «enlace» (sin validar http/https)", mut("function esEnlaceUtil(x) { return typeof x === \"string\" && /^https?:\\/\\/\\S+$/i.test(x); }", "function esEnlaceUtil(x) { return true; }"), async (m) => { const e = await conEnlace({ mutar: { usuarios: m }, respuesta: () => ({ status: 200, body: { enlaceParaEstablecerClave: "javascript:alert(1)" } }) }); await e.generar(UUID(103)); assert.equal(campoEnlace(e), undefined); }],
    ["se genera SIN pedir confirmación", mut("if (!acepto) return;", "if (false) return;"), async (m) => { const e = await conEnlace({ mutar: { usuarios: m }, acepta: false }); await e.generar(UUID(103)); assert.equal(e.pedidosEnlace().length, 0); }],
    ["el POST manda un cuerpo con el correo o el rol", mut("await pedir(\"POST\", \"/\" + encodeURIComponent(b.dataset.id) + \"/enlace\");", "await pedir(\"POST\", \"/\" + encodeURIComponent(b.dataset.id) + \"/enlace\", { correo: \"x@example.test\", rol: \"admin\" });"), async (m) => { const e = await conEnlace({ mutar: { usuarios: m } }); await e.generar(UUID(103)); const [p] = e.pedidosEnlace(); assert.ok(p.cuerpo === undefined || p.cuerpo === null || p.cuerpo === ""); }],
    ["el botón no se libera tras un error", mut("enCurso = false; b.disabled = false;\n        if (!r.ok) { aviso(textoPlanoDeFallo(r)); return; }\n        var enlace", "enCurso = false;\n        if (!r.ok) { aviso(textoPlanoDeFallo(r)); return; }\n        var enlace"), async (m) => { const e = await conEnlace({ mutar: { usuarios: m }, respuesta: () => ({ status: 409, body: { error: "x" } }) }); const b = await e.generar(UUID(103)); assert.equal(b.disabled, false); }],
  ];
  for (const [nombre, m, escenario] of casos) test(`mutante «${nombre}» → falla`, async () => { await assert.rejects(async () => escenario(m), (e) => { assert.ok(!(e instanceof SyntaxError) && !/el mutante no encuentra|mutante sin efecto/.test(e.message), `el mutante no se pudo aplicar: ${e.message}`); return true; }, `el mutante «${nombre}» SOBREVIVIÓ`); });
  test("control: con un cambio INOCUO (un comentario) todos los escenarios pasan: los mutantes fallan por su defecto, no por el montaje", async () => { for (const [, , esc] of casos) await esc((t) => `${t}\n/* control */`); });
});
