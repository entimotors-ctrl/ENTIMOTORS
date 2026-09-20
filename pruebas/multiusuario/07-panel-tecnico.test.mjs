// taller-demo/panel-tecnico.html REAL (su <script> en linea, tal cual) sobre supabase-client.js real y el Supabase
// sintetico. El panel es la pantalla del rol «desarrollador»: cifras agregadas y estado de RLS, sin datos de clientes.
// IMPORTANTE: quien decide QUE devuelve cada RPC es el SERVIDOR; el servidor sintetico de aqui es un modelo mio y solo
// sirve para comprobar como REACCIONA el panel (pinta, oculta, escapa). La politica real de los RPC es del SQL (GAP).
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, leer, sinFugas } from "./helpers/entorno.mjs";
import { crearServidor, CUENTAS } from "./helpers/supabase-mock.mjs";

const HTML = leer("panel-tecnico.html");
const INLINE = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const XSS = ['<img src=x onerror=alert(1)>', "<script>alert(1)</script>", `"'><svg onload=alert(1)>`];
const cambiar = (de, a) => (t) => { const r = t.replace(de, a); if (r === t) throw new Error("mutante sin efecto"); return r; };

function panel({ cuenta = null, servidor = crearServidor(), online = true, mutar } = {}) {
  const almacen = {}; if (cuenta) almacen.entimotors_sb_sesion = JSON.stringify(servidor.emitirSesion(cuenta));
  const env = crearEntorno({ producto: "ninguno", scripts: ["supabase-client"], servidor, storage: almacen, online });
  env.evaluar(mutar ? mutar(INLINE[0]) : INLINE[0]);
  return env;
}
const txt = (env, id) => env.doc.getElementById(id).textContent;
const oculto = (env, id) => env.doc.getElementById(id).hidden;
async function entrar(env, correo, clave) {
  env.doc.getElementById("correo").value = correo; env.doc.getElementById("clave").value = clave;
  await env.doc.getElementById("formLogin").disparar("submit"); await env.asentar();
}
const texto = (env, sel) => env.doc.getElementById(sel).children.map((h) => h.textContent);

describe("el archivo: solo lo que debe llevar", () => {
  test("carga exactamente dos scripts externos (config y cliente de Supabase) y UN script en linea", () => {
    assert.deepEqual([...HTML.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]), ["supabase-config.js", "supabase-client.js"]); assert.equal(INLINE.length, 1);
  });
  test("NO usa ningun sumidero de HTML ni de codigo (innerHTML/outerHTML/insertAdjacentHTML/document.write/eval/new Function)", () => {
    for (const patron of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/, /setTimeout\s*\(\s*["'`]/]) assert.ok(!patron.test(INLINE[0]), String(patron));
  });
  test("no toca localStorage ni hace fetch por su cuenta: todo pasa por SupabaseCliente", () => {
    for (const patron of [/localStorage/, /sessionStorage/, /\bfetch\s*\(/, /XMLHttpRequest/, /service_role/i]) assert.ok(!patron.test(INLINE[0]), String(patron));
  });
  test("no carga app.js ni la base local: no puede abrir datos del taller", () => {
    assert.ok(!/app\.js|usuarios\.js|auth\.js|indexedDB\.open|DB\./.test(INLINE[0] + HTML.replace(/<!--[\s\S]*?-->/g, "").match(/<script[^>]*src[^>]*>/g).join("")));
  });
  test("el aviso de privacidad y el pie describen lo que hace (solo conteos)", () => { assert.match(HTML, /devuelve cero filas de clientes/); assert.match(HTML, /nunca mostrará información real de un cliente/); });
  test("PANEL_VERSION (COSMETIC_VERSION_ONLY, 4E-C4-FIX): el literal visible coincide con VERSION_APP; es fijo, NO derivado, y ninguna logica lo lee", (t) => {
    const visible = /<span class="version" id="version">([^<]*)<\/span>/.exec(HTML)[1];
    const app = leer("app.js"); const v = /const VERSION_APP = "([^"]+)"/.exec(app)[1];
    assert.match(visible, /^\d+\.\d+\.\d+$/); assert.equal(visible, v, "el literal visible del panel debe ser la version actual"); assert.ok(!/["']version["']/.test(INLINE[0]) && !/VERSION_APP/.test(INLINE[0]), "ningun codigo lee ni escribe esa version");
    const shell = /const SHELL\s*=\s*\[([\s\S]*?)\]/.exec(leer("sw.js"))[1]; assert.ok(shell.length > 20 && !/panel-tecnico/.test(shell), "el panel no esta en el precache: la version visible no afecta a la cache");
    t.diagnostic(`PANEL_VERSION: panel-tecnico.html muestra «${visible}» y VERSION_APP es «${v}»`);
  });
});

describe("sin sesion", () => {
  test("arranca en «sin sesion»: usuario y rol vacios, cajas de datos ocultas y CERO llamadas autenticadas", async () => {
    const env = panel({}); await env.asentar();
    assert.equal(txt(env, "sesEstado"), "sin sesión"); assert.equal(txt(env, "sesUsuario"), "—"); assert.equal(txt(env, "sesRol"), "—");
    assert.equal(oculto(env, "cajaCifras"), true); assert.equal(oculto(env, "cajaTablas"), true); assert.equal(oculto(env, "btnSalir"), true);
    assert.equal(env.servidor.llamadas.length, 0);
  });
  test("«Estado de la aplicacion» lista el entorno y no revienta sin serviceWorker", async () => {
    const env = panel({}); await env.asentar(); const filas = texto(env, "listaEstado").join("|");
    assert.match(filas, /Página cargada/); assert.match(filas, /Cliente Supabase/); assert.match(filas, /Conexión/); assert.match(filas, /Autenticación/); assert.match(filas, /sin sesión/);
  });
  test("se re-comprueba el entorno cada 30 s", async () => {
    const env = panel({}); await env.asentar();
    env.setOnline(false); await env.avanzar(30500); assert.match(texto(env, "listaEstado").join("|"), /sin red/);
  });
});

describe("iniciar sesion", () => {
  test("desarrollador: «con sesion», su correo, su rol, las cifras y la tabla de RLS — con el token de SESION en cada RPC", async () => {
    const c = CUENTAS.desarrollador, env = panel({}); await env.asentar(); await entrar(env, c.correo, c.clave);
    assert.equal(txt(env, "sesEstado"), "con sesión"); assert.equal(txt(env, "sesUsuario"), c.correo); assert.equal(txt(env, "sesRol"), "desarrollador");
    assert.equal(oculto(env, "cajaCifras"), false); assert.equal(oculto(env, "cajaTablas"), false); assert.equal(oculto(env, "btnSalir"), false); assert.equal(env.doc.getElementById("btnEntrar").disabled, true);
    assert.deepEqual(texto(env, "cifras"), ["3clientes", "2motos", "5órdenes", "1ventas"]);
    const rpcs = env.servidor.llamadas.filter((l) => l.ruta.startsWith("/rest/v1/rpc/")); assert.deepEqual(rpcs.map((l) => l.ruta.split("/").pop()), ["rol_actual", "estadisticas_tecnicas", "estado_tecnico"]);
    assert.ok(rpcs.every((l) => l.auth === "sesion")); env.servidor.reiniciarRegistro();
  });
  test("la contraseña se borra del formulario, no se guarda en ningun sitio y no aparece en consola ni HTML", async () => {
    const c = CUENTAS.desarrollador, env = panel({}); await env.asentar(); await entrar(env, c.correo, c.clave);
    assert.equal(env.doc.getElementById("clave").value, ""); sinFugas(env, [c.clave]); assert.deepEqual(env.servidor.ajenas, []); assert.deepEqual(env.servidor.inesperadas, []);
  });
  test("contraseña incorrecta: «no se pudo entrar» en rojo, boton habilitado, contraseña borrada, sin llamadas de datos", async () => {
    const c = CUENTAS.desarrollador, env = panel({}); await env.asentar(); await entrar(env, c.correo, "mala");
    assert.equal(txt(env, "sesEstado"), "no se pudo entrar"); assert.equal(env.doc.getElementById("sesEstado").className, "f"); assert.equal(env.doc.getElementById("btnEntrar").disabled, false); assert.equal(env.doc.getElementById("clave").value, "");
    assert.equal(env.servidor.llamadas.filter((l) => l.ruta.includes("/rpc/")).length, 0); assert.equal(oculto(env, "cajaCifras"), true);
  });
  test("sin red: «sin conexion»", async () => {
    const s = crearServidor(); s.red = "caida"; const env = panel({ servidor: s }); await env.asentar(); await entrar(env, CUENTAS.desarrollador.correo, CUENTAS.desarrollador.clave);
    assert.equal(txt(env, "sesEstado"), "sin conexión");
  });
  test("cuenta de baja: el servidor devuelve rol vacio y sin datos → el panel muestra «—» y NO pinta cifras ni tabla (RCV-35 visto desde el cliente)", async () => {
    const c = CUENTAS.adminInactivo, env = panel({}); await env.asentar(); await entrar(env, c.correo, c.clave);
    assert.equal(txt(env, "sesRol"), "—"); assert.equal(oculto(env, "cajaCifras"), true); assert.equal(oculto(env, "cajaTablas"), true); assert.deepEqual(texto(env, "cifras"), []);
  });
  test("un rol sin permiso sobre las estadisticas (mecanico): rol visible pero ninguna cifra", async () => {
    const c = CUENTAS.mecanicoActivo, env = panel({}); await env.asentar(); await entrar(env, c.correo, c.clave);
    assert.equal(txt(env, "sesRol"), "mecanico"); assert.equal(oculto(env, "cajaCifras"), true); assert.equal(oculto(env, "cajaTablas"), true);
  });
  test("con una sesion ya guardada arranca directamente con datos", async () => {
    const env = panel({ cuenta: CUENTAS.desarrollador }); await env.asentar(); assert.equal(txt(env, "sesEstado"), "con sesión"); assert.equal(oculto(env, "cajaCifras"), false);
  });
  test("Salir: cierra la sesion en el servidor, oculta las cajas y vuelve a «sin sesion»", async () => {
    const c = CUENTAS.desarrollador, env = panel({}); await env.asentar(); await entrar(env, c.correo, c.clave);
    await env.doc.getElementById("btnSalir").disparar("click"); await env.asentar();
    assert.equal(env.servidor.cierres, 1); assert.equal(txt(env, "sesEstado"), "sin sesión"); assert.equal(oculto(env, "cajaCifras"), true); assert.equal(oculto(env, "cajaTablas"), true); assert.equal(oculto(env, "btnSalir"), true); assert.equal(txt(env, "sesRol"), "—");
    assert.equal(env.almacen.getItem("entimotors_sb_sesion"), null);
  });
  test("caracterizacion: la sesion del panel usa la MISMA clave de almacenamiento que la app (mismo origen)", async () => {
    const c = CUENTAS.desarrollador, env = panel({}); await env.asentar(); await entrar(env, c.correo, c.clave); assert.notEqual(env.almacen.getItem("entimotors_sb_sesion"), null);
  });
});

describe("respuestas hostiles o malformadas del servidor: el panel pinta TEXTO", () => {
  test("XSS: tabla, cifras y correo con cargas hostiles quedan como texto; el panel NUNCA asigna innerHTML", async () => {
    for (const p of XSS) {
      const dev = { ...CUENTAS.desarrollador, correo: p }; const s = crearServidor([dev]);
      s.rpc.estado_tecnico = { body: { tablas: [{ tabla: p, rls: false, politicas: p }, { tabla: "ok", rls: true, politicas: 1 }] } };
      s.rpc.estadisticas_tecnicas = { body: { clientes: p, [p]: 5, motos: 2 } };
      const env = panel({ servidor: s }); await env.asentar(); await entrar(env, p, dev.clave);
      assert.equal(txt(env, "sesUsuario"), p, "el correo hostil va como texto"); assert.deepEqual(env.doc.sumideros, [], `el panel no debe usar innerHTML (${p})`);
      assert.deepEqual(env.doc.getElementById("cifras").children.map((d) => d.children[0].textContent), [p, "2"], "solo claves conocidas; el valor va como texto");
      assert.equal(env.doc.getElementById("tablas").children[0].children[0].textContent, p); assert.equal(env.doc.getElementById("tablas").children[0].children[2].textContent, p);
    }
  });
  test("RLS apagado se marca «APAGADO» con clase de fallo; activo con clase correcta", async () => {
    const s = crearServidor(); s.rpc.estado_tecnico = { body: { tablas: [{ tabla: "a", rls: false, politicas: 0 }, { tabla: "b", rls: true, politicas: 4 }] } };
    const env = panel({ servidor: s }); await env.asentar(); await entrar(env, CUENTAS.desarrollador.correo, CUENTAS.desarrollador.clave);
    const [a, b] = env.doc.getElementById("tablas").children; assert.deepEqual([a.children[1].textContent, a.children[1].className], ["APAGADO", "f"]); assert.deepEqual([b.children[1].textContent, b.children[1].className], ["activo", "p"]);
  });
  test("respuestas malformadas (sin tablas, null, sin cuerpo, texto suelto): no revienta y oculta la caja", async () => {
    for (const cuerpo of [{}, null, "texto", { tablas: null }, []]) {
      const s = crearServidor(); s.rpc.estado_tecnico = { body: cuerpo }; s.rpc.estadisticas_tecnicas = { body: cuerpo };
      const env = panel({ servidor: s }); await env.asentar(); await assert.doesNotReject(entrar(env, CUENTAS.desarrollador.correo, CUENTAS.desarrollador.clave), JSON.stringify(cuerpo)); assert.equal(oculto(env, "cajaTablas"), true, JSON.stringify(cuerpo));
    }
  });
  test("error 500 en un RPC: la caja se oculta, la pagina sigue viva y se cuenta como estado, no como excepcion", async () => {
    const s = crearServidor(); s.rpc.estadisticas_tecnicas = { status: 500, body: { message: "boom" } };
    const env = panel({ servidor: s }); await env.asentar(); await entrar(env, CUENTAS.desarrollador.correo, CUENTAS.desarrollador.clave);
    assert.equal(oculto(env, "cajaCifras"), true); assert.equal(oculto(env, "cajaTablas"), false); assert.equal(txt(env, "sesEstado"), "con sesión");
  });
  test("rol devuelto con marcado: se pinta como texto", async () => {
    for (const p of XSS) { const s = crearServidor(); s.rpc.rol_actual = { body: JSON.stringify(p) }; const env = panel({ servidor: s }); await env.asentar(); await entrar(env, CUENTAS.desarrollador.correo, CUENTAS.desarrollador.clave); assert.equal(txt(env, "sesRol"), p); assert.deepEqual(env.doc.sumideros, []); }
  });
});

describe("contadores de errores tecnicos", () => {
  test("error de ventana y promesa rechazada incrementan sus contadores (solo numeros: no guarda mensajes ni datos)", async () => {
    const env = panel({}); await env.asentar();
    for (const fn of env.oyentesVentana.error || []) fn({ message: "dato sensible ficticio" }); for (const fn of env.oyentesVentana.unhandledrejection || []) fn({ reason: "dato sensible ficticio" });
    for (const fn of env.oyentesVentana.unhandledrejection || []) fn({});
    assert.equal(txt(env, "errN"), "1"); assert.equal(txt(env, "rechN"), "2"); assert.equal(env.doc.getElementById("errN").className, "f");
    assert.ok(!env.doc.sumideros.some((s) => s.html.includes("dato sensible")) && !["errN", "rechN"].some((i) => txt(env, i).includes("sensible")));
  });
});

describe("mutantes del panel: cada garantia se ROMPE si se altera la linea que la sostiene", () => {
  const P = XSS[0];
  const casos = [
    ["la tabla se pinta como texto", cambiar("td.textContent = v;", "td.innerHTML = v;"), async (m) => { const s = crearServidor(); s.rpc.estado_tecnico = { body: { tablas: [{ tabla: P, rls: true, politicas: 1 }] } }; const e = panel({ servidor: s, mutar: m }); await e.asentar(); await entrar(e, CUENTAS.desarrollador.correo, CUENTAS.desarrollador.clave); return e.doc.sumideros.length === 0; }],
    ["las cifras se pintan como texto", cambiar("b.textContent = est.datos[k];", "b.innerHTML = est.datos[k];"), async (m) => { const s = crearServidor(); s.rpc.estadisticas_tecnicas = { body: { clientes: P } }; const e = panel({ servidor: s, mutar: m }); await e.asentar(); await entrar(e, CUENTAS.desarrollador.correo, CUENTAS.desarrollador.clave); return e.doc.sumideros.length === 0; }],
    ["el rol se pinta como texto", cambiar('$("sesRol").textContent = r.ok && r.datos ? r.datos : "—";', '$("sesRol").innerHTML = r.ok && r.datos ? r.datos : "—";'), async (m) => { const s = crearServidor(); s.rpc.rol_actual = { body: JSON.stringify(P) }; const e = panel({ servidor: s, mutar: m }); await e.asentar(); await entrar(e, CUENTAS.desarrollador.correo, CUENTAS.desarrollador.clave); return e.doc.sumideros.length === 0; }],
    ["la contraseña se borra del formulario", cambiar('$("clave").value = "";', ""), async (m) => { const e = panel({ mutar: m }); await e.asentar(); await entrar(e, CUENTAS.desarrollador.correo, CUENTAS.desarrollador.clave); return e.doc.getElementById("clave").value === ""; }],
    ["al salir se ocultan las cifras", cambiar('$("cajaCifras").hidden = true; $("cajaTablas").hidden = true;\n      return;', "return;"), async (m) => { const e = panel({ mutar: m }); await e.asentar(); await entrar(e, CUENTAS.desarrollador.correo, CUENTAS.desarrollador.clave); await e.doc.getElementById("btnSalir").disparar("click"); await e.asentar(); return e.doc.getElementById("cajaCifras").hidden === true; }],
    ["solo se pintan las cifras conocidas", cambiar("Object.keys(ETIQUETAS).forEach(function (k) {", "Object.keys(est.datos).forEach(function (k) {"), async (m) => { const s = crearServidor(); s.rpc.estadisticas_tecnicas = { body: { clientes: 1, [P]: 5 } }; const e = panel({ servidor: s, mutar: m }); await e.asentar(); await entrar(e, CUENTAS.desarrollador.correo, CUENTAS.desarrollador.clave); return e.doc.getElementById("cifras").children.length === 1; }],
  ];
  for (const [prop, mut, propiedad] of casos) test(`${prop}`, async () => {
    assert.equal(await propiedad(undefined), true, "con el panel REAL la propiedad debe cumplirse");
    assert.equal(await propiedad(mut), false, "el mutante SOBREVIVE: ninguna prueba protege esta garantia");
  });
});
