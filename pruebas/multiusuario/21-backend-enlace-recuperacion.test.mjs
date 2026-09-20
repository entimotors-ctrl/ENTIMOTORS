// OBS-9 · PLAN B (4E-C7-FIX-B) — BACKEND: POST /api/admin/usuarios/:id/enlace. RECUPERACION MEDIADA POR EL ADMINISTRADOR.
// El administrador genera un enlace de recuperacion de un solo uso para una persona del equipo, lo copia y se lo pasa. No hay correo, ni SMTP, ni ruta publica.
//
// Aqui se ejecuta el api-server REAL (api-server/src/routes/admin-usuarios.ts, convertido de TS a JS por helpers/ts-a-js.mjs) contra un Supabase FALSO:
// sin red, sin cuentas reales, sin `npm install`. Todo enlace, token y clave de este archivo es sintetico; NUNCA se imprime un enlace (los mensajes de
// fallo solo dicen QUE fallo). Cada garantia de seguridad lleva su prueba de MUTACION: se altera el fuente en memoria y el escenario debe romperse.
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { crearBackend, nuevoEstado, volcado, limpiarBackend, FUENTE_TS, uuid, ID_ADMIN, TOKEN_ADMIN, SERVICE_KEY, ANON_KEY, ORIGEN_TALLER, ORIGEN_MITRABAJO } from "./helpers/backend-admin-usuarios.mjs";
import { tsAJs } from "./helpers/ts-a-js.mjs";

after(() => limpiarBackend());

const RUTA = "/admin/usuarios/:id/enlace";
const U = { mecanico: uuid(3), cajero: uuid(4), desarrollador: uuid(5), baja: uuid(6), otroAdmin: uuid(7), rolRaro: uuid(8), sinCorreo: uuid(9), cajero2: uuid(10) };
const REDIRECT_TALLER = "https://taller.example.test/entimotors-os/index.html", REDIRECT_MT = "https://mitrabajo.example.test/index.html";
const CUERPO_ESPERADO = ["enlaceParaEstablecerClave", "nota"];

/** Estado con dos sesiones extra: un cajero (no admin) y un admin dado de baja. */
const estadoBase = (extra = {}) => { const e = nuevoEstado(extra); e.sesiones.set("token-del-cajero", { id: U.cajero2, email: "cajero2@example.test" }); e.sesiones.set("token-admin-de-baja", { id: U.otroAdmin, email: "otroadmin@example.test" }); return e; };
const pedir = async (id, { env, estado = estadoBase(), opciones = {}, transpilar } = {}) => { const be = await crearBackend({ env, estado, transpilar }); const r = await be.ejecutar("POST", RUTA, { params: { id }, cuerpoProhibido: true, ...opciones }); return { be, estado, r }; };
/** exigirAdmin lee el perfil de QUIEN LLAMA; ninguna lectura debe ser de otra persona (el objetivo). */
const soloLeyoAlAdmin = (estado) => assert.ok(estado.llamadas.leerPerfil.every((l) => l.filtros.length === 1 && l.filtros[0][1] === ID_ADMIN), "se consulto a otra persona");
const sinRastro = (estado) => { assert.equal(estado.llamadas.generateLink.length, 0, "NO debe pedir ningun enlace"); assert.equal(estado.llamadas.actualizarPerfil.length, 0, "NO debe escribir en perfiles"); };

// ═════════════════════════════ AUTORIZACION ═════════════════════════════
describe("OBS-9 backend · solo un administrador autenticado", () => {
  test("1 · sin sesion (sin cabecera Authorization) → 401 y NO se genera nada", async () => {
    const { r, estado } = await pedir(U.mecanico, { opciones: { token: null } });
    assert.equal(r.status, 401); assert.match(r.cuerpo.error, /iniciar sesión/); sinRastro(estado); assert.equal(estado.llamadas.getUserById.length, 0);
  });
  test("1b · token que Supabase no reconoce → 401", async () => {
    const { r, estado } = await pedir(U.mecanico, { opciones: { token: "token-inventado" } }); assert.equal(r.status, 401); assert.match(r.cuerpo.error, /no es válida|caducado/); sinRastro(estado);
  });
  test("2 · un usuario que NO es administrador (cajero) → 403, aunque tenga sesion valida; no se lee ni el objetivo", async () => {
    const { r, estado } = await pedir(U.mecanico, { opciones: { token: "token-del-cajero" } });
    assert.equal(r.status, 403); assert.match(r.cuerpo.error, /Solo el administrador/); sinRastro(estado); assert.equal(estado.llamadas.getUserById.length, 0);
  });
  test("2b · un administrador DADO DE BAJA con sesion aun vigente → 403", async () => {
    const { r, estado } = await pedir(U.mecanico, { opciones: { token: "token-admin-de-baja" } }); assert.equal(r.status, 403); sinRastro(estado);
  });
  test("sin SUPABASE_ANON_KEY el servidor apaga la gestion de usuarios (misma puerta que el resto): 503 y nada se genera", async () => {
    const { r, estado } = await pedir(U.mecanico, { env: { SUPABASE_ANON_KEY: undefined } }); assert.equal(r.status, 503); assert.match(r.cuerpo.error, /SUPABASE_ANON_KEY/); sinRastro(estado);
  });
});

// ═════════════════════════════ CAMINO FELIZ ═════════════════════════════
describe("OBS-9 backend · administrador + persona activa → enlace", () => {
  test("3 · genera el enlace: 200, SOLO {enlaceParaEstablecerClave, nota}, Cache-Control no-store, y generateLink recibe el correo GUARDADO y type «recovery»", async () => {
    const { r, estado } = await pedir(U.cajero);
    assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.cuerpo).sort(), CUERPO_ESPERADO); assert.equal(r.cabeceras["cache-control"], "no-store");
    assert.equal(estado.llamadas.generateLink.length, 1); assert.equal(estado.llamadas.generateLink[0].type, "recovery"); assert.equal(estado.llamadas.generateLink[0].email, "cajero@example.test");
    assert.equal(r.cuerpo.enlaceParaEstablecerClave, estado.enlacesEmitidos[0].enlace); assert.match(r.cuerpo.nota, /un solo uso/);
    assert.deepEqual(estado.llamadas.getUserById, [U.cajero], "el correo se lee de Auth por el id del objetivo");
  });
  test("3b · NO toca a la persona: ninguna escritura en perfiles (no reactiva, no cambia rol, no cambia nombre)", async () => {
    const { estado } = await pedir(U.mecanico); const antes = JSON.stringify([...estadoBase().perfiles]); assert.equal(estado.llamadas.actualizarPerfil.length, 0); assert.equal(JSON.stringify([...estado.perfiles]), antes);
  });
  test("3c · cada peticion pide UN enlace nuevo (el ultimo enlace anula al anterior en Supabase; aqui se comprueba que no se reutiliza ninguno)", async () => {
    const estado = estadoBase(); const be = await crearBackend({ estado });
    const a = await be.ejecutar("POST", RUTA, { params: { id: U.mecanico } }), b = await be.ejecutar("POST", RUTA, { params: { id: U.mecanico } });
    assert.notEqual(a.cuerpo.enlaceParaEstablecerClave, b.cuerpo.enlaceParaEstablecerClave); assert.equal(estado.llamadas.generateLink.length, 2);
  });
});

describe("OBS-9 backend · el DESTINO lo decide el servidor por el ROL guardado (Taller o Mi Trabajo)", () => {
  test("7 · mecanico → Mi Trabajo (ENTIMOTORS_MECHANIC_ORIGIN)", async () => { const { estado } = await pedir(U.mecanico); assert.equal(estado.llamadas.generateLink[0].redirectTo, REDIRECT_MT); });
  test("8 · cajero → Taller (ENTIMOTORS_ADMIN_ORIGIN, con su ruta /entimotors-os/)", async () => { const { estado } = await pedir(U.cajero); assert.equal(estado.llamadas.generateLink[0].redirectTo, REDIRECT_TALLER); });
  test("9 · desarrollador → Taller", async () => { const { estado } = await pedir(U.desarrollador); assert.equal(estado.llamadas.generateLink[0].redirectTo, REDIRECT_TALLER); });
  test("los dos origenes salen de las variables de entorno del servidor (no hay valores por defecto): otro valor, otro destino", async () => {
    const { estado } = await pedir(U.mecanico, { env: { ENTIMOTORS_MECHANIC_ORIGIN: "https://otro.example.test/app/" } }); assert.equal(estado.llamadas.generateLink[0].redirectTo, "https://otro.example.test/app/index.html");
  });
});

describe("OBS-9 backend · lo que mande el CLIENTE no cuenta (correo, rol, redirect: se ignoran)", () => {
  const HOSTIL = { redirect_to: "https://malo.example.test/robar", redirectTo: "https://malo.example.test/robar", redirect: "https://malo.example.test/robar", next: "https://malo.example.test", email: "victima@example.test", correo: "victima@example.test", rol: "admin", role: "admin", id: ID_ADMIN };
  test("10 · redirect enviado (cuerpo, query y cabeceras Origin/Referer/Host) → IGNORADO: el destino es el del servidor", async () => {
    const { estado, r } = await pedir(U.cajero, { opciones: { body: HOSTIL, query: { redirect_to: "https://malo.example.test/robar" }, headers: { origin: "https://malo.example.test", referer: "https://malo.example.test/x", host: "malo.example.test" }, cuerpoProhibido: false } });
    assert.equal(r.status, 200); assert.equal(estado.llamadas.generateLink[0].redirectTo, REDIRECT_TALLER); assert.ok(!JSON.stringify(estado.llamadas.generateLink).includes("malo.example.test"));
  });
  test("11 · correo enviado → IGNORADO: generateLink recibe el correo que Auth tiene para ESE id, no el del cuerpo", async () => {
    const { estado } = await pedir(U.mecanico, { opciones: { body: HOSTIL, cuerpoProhibido: false } }); assert.equal(estado.llamadas.generateLink[0].email, "mecanico@example.test"); assert.ok(!JSON.stringify(estado.llamadas.generateLink).includes("victima@"));
  });
  test("12 · rol enviado («admin», o el de otro producto) → IGNORADO: manda el rol guardado en perfiles", async () => {
    const a = await pedir(U.cajero, { opciones: { body: { rol: "mecanico", role: "mecanico" }, cuerpoProhibido: false } }); assert.equal(a.estado.llamadas.generateLink[0].redirectTo, REDIRECT_TALLER, "un cajero NO se manda a Mi Trabajo");
    const b = await pedir(U.mecanico, { opciones: { body: { rol: "cajero" }, cuerpoProhibido: false } }); assert.equal(b.estado.llamadas.generateLink[0].redirectTo, REDIRECT_MT, "un mecanico NO se manda al Taller");
  });
  test("y la ruta NI SIQUIERA LEE req.body: con el cuerpo prohibido (lanzaria si se tocara) sigue respondiendo 200", async () => {
    const { r } = await pedir(U.cajero, { opciones: { cuerpoProhibido: true } }); assert.equal(r.status, 200);
  });
  test("el id de la URL se toma de los parametros, no del cuerpo: un id en el cuerpo no cambia el objetivo", async () => {
    const { estado } = await pedir(U.cajero, { opciones: { body: { id: U.mecanico }, cuerpoProhibido: false } }); assert.deepEqual(estado.llamadas.getUserById, [U.cajero]);
  });
});

// ═════════════════════════════ FALLO CERRADO ═════════════════════════════
describe("OBS-9 backend · a quien NO se le genera enlace (fallo cerrado, mensaje claro, sin escribir nada)", () => {
  test("6 · el PROPIO administrador → 400 con mensaje claro (Supabase Auth); no se lee el objetivo ni se pide enlace", async () => {
    const { r, estado } = await pedir(ID_ADMIN); assert.equal(r.status, 400); assert.match(r.cuerpo.error, /propia cuenta/); assert.match(r.cuerpo.error, /panel de Supabase/); sinRastro(estado);
    assert.equal(estado.llamadas.getUserById.length, 0); soloLeyoAlAdmin(estado);   // ni siquiera consulta a la persona
  });
  test("otra cuenta de administrador (aunque no sea la propia) → 400: las cuentas admin se recuperan desde el panel de Supabase", async () => {
    const { r, estado } = await pedir(U.otroAdmin); assert.equal(r.status, 400); assert.match(r.cuerpo.error, /administrador/); sinRastro(estado);
  });
  test("4 · objetivo inexistente → 404", async () => {
    const { r, estado } = await pedir(uuid(999)); assert.equal(r.status, 404); assert.match(r.cuerpo.error, /no existe/); sinRastro(estado); assert.equal(estado.llamadas.getUserById.length, 0);
  });
  test("5 · objetivo INACTIVO (dado de baja) → 409 «reactívala antes»; NO se genera enlace y la cuenta SIGUE inactiva (no se reactiva)", async () => {
    const { r, estado } = await pedir(U.baja); assert.equal(r.status, 409); assert.match(r.cuerpo.error, /dada de baja/); assert.match(r.cuerpo.error, /Reactívala/); sinRastro(estado);
    assert.equal(estado.perfiles.get(U.baja).activo, false);
  });
  test("id con mala forma → 400 (sin consultar nada)", async () => {
    for (const id of ["no-es-un-id", "../../etc/passwd", "1", "x".repeat(36), ""]) { const { r, estado } = await pedir(id); assert.equal(r.status, 400, id); assert.match(r.cuerpo.error, /Identificador no válido/); sinRastro(estado); soloLeyoAlAdmin(estado); }
  });
  test("rol que no es asignable (p. ej. «superadmin») → 409; NO se manda a ninguna app", async () => {
    const { r, estado } = await pedir(U.rolRaro); assert.equal(r.status, 409); assert.match(r.cuerpo.error, /rol/); sinRastro(estado);
  });
  test("correo ausente en Auth → 409; getUserById con error → 502; getUserById que LANZA → 502; ninguno pide enlace", async () => {
    const a = await pedir(U.sinCorreo); assert.equal(a.r.status, 409); assert.match(a.r.cuerpo.error, /correo/); sinRastro(a.estado);
    const e2 = estadoBase({ getUserById: async () => ({ data: { user: null }, error: { message: "DETALLE-INTERNO-DE-SUPABASE", status: 500 } }) }); const b = await pedir(U.cajero, { estado: e2 }); assert.equal(b.r.status, 502); sinRastro(e2); assert.ok(!JSON.stringify(b.r.cuerpo).includes("DETALLE-INTERNO"));
    const e3 = estadoBase({ getUserById: async () => { throw new TypeError("fetch failed: ECONNRESET-INTERNO"); } }); const c = await pedir(U.cajero, { estado: e3 }); assert.equal(c.r.status, 502); sinRastro(e3); assert.ok(!JSON.stringify(c.r.cuerpo).includes("ECONNRESET"));
  });
  test("error al leer perfiles → 500 con mensaje generico (sin el texto de la base)", async () => {
    const e = estadoBase(); e.errorPerfiles = "relation perfiles DETALLE-INTERNO"; const { r } = await pedir(U.cajero, { estado: e }); assert.equal(r.status, 500); assert.ok(!JSON.stringify(r.cuerpo).includes("DETALLE-INTERNO")); sinRastro(e);
  });
});

describe("OBS-9 backend · origenes y Supabase: fallo seguro y mensajes aptos para la pantalla", () => {
  test("origen NO configurado: mecanico sin ENTIMOTORS_MECHANIC_ORIGIN → 503 «sin-origin» (no se manda al taller «mientras tanto»); el cajero sigue funcionando", async () => {
    const env = { ENTIMOTORS_MECHANIC_ORIGIN: "" }; const a = await pedir(U.mecanico, { env }); assert.equal(a.r.status, 503); assert.equal(a.r.cuerpo.motivoSinEnlace, "sin-origin"); assert.match(a.r.cuerpo.error, /ENTIMOTORS_MECHANIC_ORIGIN/); assert.equal(a.estado.llamadas.generateLink.length, 0);
    const b = await pedir(U.cajero, { env }); assert.equal(b.r.status, 200);
  });
  test("origen invalido (sin https://) → 503 «origin-invalido»", async () => {
    const a = await pedir(U.cajero, { env: { ENTIMOTORS_ADMIN_ORIGIN: "taller.example.test" } }); assert.equal(a.r.status, 503); assert.equal(a.r.cuerpo.motivoSinEnlace, "origin-invalido"); assert.equal(a.estado.llamadas.generateLink.length, 0);
  });
  test("13 · generateLink devuelve error → 502 «supabase-rechazo» con el aviso de las Redirect URLs; NADA del error de Supabase llega al cliente", async () => {
    const e = estadoBase({ generateLink: async () => ({ data: { properties: null, user: null }, error: { message: "MENSAJE-INTERNO-SECRETO", status: 422, code: "validation_failed" } }) });
    const { r } = await pedir(U.cajero, { estado: e }); assert.equal(r.status, 502); assert.equal(r.cuerpo.motivoSinEnlace, "supabase-rechazo"); assert.match(r.cuerpo.error, /Redirect URLs/);
    assert.ok(!JSON.stringify(r.cuerpo).includes("MENSAJE-INTERNO")); assert.equal(r.cuerpo.enlaceParaEstablecerClave, undefined);
  });
  test("generateLink LANZA (red, DNS, timeout) → 502 «error-de-red», sin trazas ni el mensaje interno", async () => {
    const e = estadoBase({ generateLink: async () => { throw new Error("getaddrinfo ENOTFOUND INTERNO"); } }); const { r } = await pedir(U.cajero, { estado: e });
    assert.equal(r.status, 502); assert.equal(r.cuerpo.motivoSinEnlace, "error-de-red"); assert.ok(!JSON.stringify(r.cuerpo).includes("ENOTFOUND")); assert.ok(!("stack" in r.cuerpo));
  });
  test("14 · respuesta MALFORMADA (sin action_link, no-cadena, sin esquema http(s), esquema peligroso, vacia) → 502 «sin-action-link»; jamas se devuelve algo como enlace", async () => {
    const respuestas = [{ data: { properties: {}, user: {} }, error: null }, { data: { properties: null }, error: null }, { data: null, error: null }, { data: { properties: { action_link: { url: "x" } } }, error: null },
      { data: { properties: { action_link: 12345 } }, error: null }, { data: { properties: { action_link: "" } }, error: null }, { data: { properties: { action_link: "javascript:alert(1)" } }, error: null },
      { data: { properties: { action_link: "recuperacion-sin-esquema" } }, error: null }, { data: { properties: { action_link: "https://x.example.test/ok con espacios" } }, error: null }];
    for (const [i, resp] of respuestas.entries()) { const e = estadoBase({ generateLink: async () => resp }); const { r } = await pedir(U.cajero, { estado: e }); assert.equal(r.status, 502, `respuesta ${i}`); assert.equal(r.cuerpo.motivoSinEnlace, "sin-action-link", `respuesta ${i}`); assert.equal(r.cuerpo.enlaceParaEstablecerClave, undefined, `respuesta ${i}`); }
  });
});

// ═════════════════════════════ SECRETOS ═════════════════════════════
describe("OBS-9 backend · ningun secreto en respuestas ni registros", () => {
  const baterias = async () => {
    const estado = estadoBase(); const be = await crearBackend({ estado }); const N = [];
    const corre = async (id, o) => { const r = await be.ejecutar("POST", RUTA, { params: { id }, ...o }); N.push(r); return r; };
    await corre(U.cajero); await corre(U.mecanico); await corre(U.desarrollador); await corre(U.baja); await corre(ID_ADMIN); await corre(uuid(999)); await corre("mal-id"); await corre(U.rolRaro); await corre(U.sinCorreo); await corre(U.cajero, { token: null }); await corre(U.cajero, { token: "token-del-cajero" });
    estado.generateLink = async () => { throw new Error("falla de red"); }; await corre(U.cajero);
    estado.generateLink = async () => ({ data: { properties: null }, error: { message: "rechazado", status: 400 } }); await corre(U.cajero);
    return { estado, respuestas: N };
  };
  test("15 · ni la clave de servicio, ni la anonima, ni el token del admin, ni NINGUN enlace/token de recuperacion aparecen en los REGISTROS (aunque se pidieron enlaces reales del mock)", async () => {
    const { estado } = await baterias(); const logs = JSON.stringify(estado.logs);
    for (const [n, v] of [["clave de servicio", SERVICE_KEY], ["clave anonima", ANON_KEY], ["token del admin", TOKEN_ADMIN], ["token del cajero", "token-del-cajero"]]) assert.ok(!logs.includes(v), `${n} en los registros`);
    assert.ok(estado.enlacesEmitidos.length >= 3, "el escenario debe haber emitido enlaces de verdad");
    for (const e of estado.enlacesEmitidos) { assert.ok(!logs.includes(e.token), "un token de recuperacion llego a los registros"); assert.ok(!logs.includes(e.enlace), "un enlace llego a los registros"); assert.ok(!logs.includes("verify?token"), "un fragmento de enlace llego a los registros"); }
  });
  test("15b · en las RESPUESTAS el enlace solo aparece en el 200 y solo en `enlaceParaEstablecerClave`; ningun error lo contiene; ningun secreto de servidor sale", async () => {
    const { estado, respuestas } = await baterias(); const ok = respuestas.filter((r) => r.status === 200), malas = respuestas.filter((r) => r.status !== 200);
    assert.equal(ok.length, 3); for (const r of ok) assert.deepEqual(Object.keys(r.cuerpo).sort(), CUERPO_ESPERADO);
    const enlaces = estado.enlacesEmitidos.map((e) => e.enlace), tokens = estado.enlacesEmitidos.map((e) => e.token);
    for (const r of malas) { const t = JSON.stringify(r); for (const x of [...enlaces, ...tokens, SERVICE_KEY, ANON_KEY, TOKEN_ADMIN]) assert.ok(!t.includes(x), `una respuesta de error contiene un secreto (${r.status})`); assert.ok(!("stack" in (r.cuerpo || {}))); }
    const todo = JSON.stringify(respuestas); for (const x of [SERVICE_KEY, ANON_KEY, TOKEN_ADMIN]) assert.ok(!todo.includes(x), "un secreto de servidor salio en una respuesta");
  });
  test("15c · el unico registro de exito lleva ids (quien lo pidio y para quien), rol y evento; NO el correo ni el enlace", async () => {
    const { estado } = await pedir(U.cajero); const info = estado.logs.filter((l) => l.nivel === "info"); assert.equal(info.length, 1);
    const [obj] = info[0].args; assert.deepEqual(Object.keys(obj).sort(), ["evento", "para", "por", "rol"]); assert.equal(obj.para, U.cajero); assert.equal(obj.por, ID_ADMIN); assert.ok(!JSON.stringify(info).includes("@"), "el correo no se registra");
  });
});

// ═════════════════════════════ EL ALTA NO CAMBIO (comparte el helper) ═════════════════════════════
describe("OBS-9 backend · el ALTA de usuarios sigue igual y comparte la generacion del enlace", () => {
  const ALTA = { nombre: "Persona Nueva", correo: "Nueva@Example.test", telefono: "9704-1234", rol: "mecanico" };
  test("alta correcta → 201 con la misma forma de antes {usuario, enlaceParaEstablecerClave, motivoSinEnlace: null, nota}; enlace a Mi Trabajo para un mecanico; la clave de un uso NO sale", async () => {
    const estado = estadoBase(); const be = await crearBackend({ estado }); const r = await be.ejecutar("POST", "/admin/usuarios", { body: ALTA });
    assert.equal(r.status, 201); assert.deepEqual(Object.keys(r.cuerpo).sort(), ["enlaceParaEstablecerClave", "motivoSinEnlace", "nota", "usuario"]);
    assert.equal(r.cuerpo.motivoSinEnlace, null); assert.equal(r.cuerpo.usuario.correo, "nueva@example.test"); assert.equal(estado.llamadas.generateLink[0].redirectTo, REDIRECT_MT); assert.equal(estado.llamadas.generateLink[0].type, "recovery");
    assert.match(r.cuerpo.nota, /Pásale este enlace a la persona/); assert.ok(!JSON.stringify(r).includes("password") && !volcado(estado).includes("clave"), "ninguna clave sale");
  });
  test("alta con el origen sin configurar → sigue siendo 201 (la cuenta EXISTE) con enlace null, motivo «sin-origin» y la nota de Supabase → Reset password", async () => {
    const estado = estadoBase(); const be = await crearBackend({ estado, env: { ENTIMOTORS_MECHANIC_ORIGIN: "" } }); const r = await be.ejecutar("POST", "/admin/usuarios", { body: ALTA });
    assert.equal(r.status, 201); assert.equal(r.cuerpo.enlaceParaEstablecerClave, null); assert.equal(r.cuerpo.motivoSinEnlace, "sin-origin"); assert.match(r.cuerpo.nota, /ENTIMOTORS_MECHANIC_ORIGIN/); assert.match(r.cuerpo.nota, /Reset password/);
  });
  test("alta con generateLink rechazado → 201, enlace null, motivo «supabase-rechazo» y el aviso de las Redirect URLs", async () => {
    const estado = estadoBase({ generateLink: async () => ({ data: { properties: null }, error: { message: "x", status: 422 } }) }); const be = await crearBackend({ estado }); const r = await be.ejecutar("POST", "/admin/usuarios", { body: ALTA });
    assert.equal(r.status, 201); assert.equal(r.cuerpo.motivoSinEnlace, "supabase-rechazo"); assert.match(r.cuerpo.nota, /Redirect URLs/);
  });
  test("el fuente tiene UN SOLO generateLink y UNA SOLA funcion que decide el destino: el alta y «generar enlace» la comparten (no se duplica logica sensible)", () => {
    const ts = fs.readFileSync(FUENTE_TS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal((ts.match(/\.generateLink\(/g) || []).length, 1, "generateLink debe llamarse en un solo lugar");
    assert.equal((ts.match(/destinoDeRecuperacion\(/g) || []).length, 2, "definicion + UNA llamada (dentro del helper)");
    assert.equal((ts.match(/generarEnlaceDeRecuperacion\(/g) || []).length, 3, "definicion + alta + generar enlace");
  });
});

// ═════════════════════════════ ESTATICO ═════════════════════════════
const BLOQUE = { ini: "router.post(\"/admin/usuarios/:id/enlace\"", fin: "/* ───────────────── PATCH /api/admin/usuarios/:id" };
const codigoSinComentarios = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const bloqueRuta = (ts) => { const a = ts.indexOf(BLOQUE.ini), b = ts.indexOf(BLOQUE.fin); assert.ok(a > 0 && b > a, "no se encontro la ruta"); return codigoSinComentarios(ts.slice(a, b)); };
/** Lo que la ruta NO debe contener. */
const PROHIBIDO = [/req\.body/, /req\.query/, /req\.headers/, /req\.get\(/, /redirectTo/, /redirect_to/, /(ADMIN|MECHANIC)_ORIGIN/, /req\.\S*origin/i, /email\s*:/, /console\./];
const malEnRuta = (ts) => PROHIBIDO.filter((rx) => rx.test(bloqueRuta(ts))).map(String);
describe("OBS-9 backend · la ruta, leida en el codigo", () => {
  const TS = fs.readFileSync(FUENTE_TS, "utf8");
  test("la ruta NO lee body, query ni cabeceras, NO nombra redirect/origin y NO usa console (solo el logger)", () => assert.deepEqual(malEnRuta(TS), []));
  test("usa las MISMAS puertas que el resto de /admin/usuarios: exigirConfiguracion y exigirAdmin, en ese orden", () => assert.match(TS, /router\.post\("\/admin\/usuarios\/:id\/enlace", exigirConfiguracion, exigirAdmin, async/));
  test("ninguna llamada al logger nombra el enlace ni action_link como dato", () => {
    const codigo = codigoSinComentarios(TS); const llamadas = [...codigo.matchAll(/logger\.\w+\(([\s\S]*?)\);/g)].map((m) => m[1]);
    for (const l of llamadas) { assert.ok(!/\benlace\b/.test(l.replace(/"[^"]*"/g, "")), `logger con «enlace» como dato: ${l.slice(0, 60)}`); assert.ok(!/\baccion\b|action_link\s*[,}:]/.test(l.replace(/"[^"]*"/g, "")), "logger con el action_link"); }
  });
  test("el fuente declara la ruta con Cache-Control no-store como primer paso", () => assert.match(bloqueRuta(TS), /res\.setHeader\("Cache-Control", "no-store"\);/));
  test("el modulo exporta destinoDeRecuperacion (ya lo usaban otras pruebas y la documentacion) y NO hay ninguna ruta publica nueva", async () => {
    const be = await crearBackend({}); assert.equal(typeof be.destino, "function");
    for (const r of be.rutas) assert.ok(r.handlers.length >= 3 && /^\/admin\/usuarios/.test(r.ruta), `ruta sin las puertas de administrador: ${r.metodo} ${r.ruta}`);
    assert.deepEqual(be.rutas.map((r) => `${r.metodo} ${r.ruta}`), ["GET /admin/usuarios", "POST /admin/usuarios", "POST /admin/usuarios/:id/enlace", "PATCH /admin/usuarios/:id"]);
  });
});

// ═════════════════════════════ MUTACION ═════════════════════════════
describe("OBS-9 backend · pruebas de MUTACION: cada garantia se rompe si se altera la linea que la sostiene", () => {
  const TS = fs.readFileSync(FUENTE_TS, "utf8");
  const sustituir = (de, a) => { assert.ok(TS.includes(de), `el mutante no encuentra: ${de.slice(0, 70)}`); return TS.replace(de, a); };
  const mutante = (ts) => (f) => tsAJs(ts(f));
  /** El mutante debe APLICARSE, COMPILAR, y romper el escenario (una afirmacion o un fallo de ejecucion; nunca un error de sintaxis). */
  const debeFallar = (nombre, mutadoTS, escenario) => test(`mutante «${nombre}» → el escenario FALLA`, async () => {
    const js = tsAJs(mutadoTS); assert.notEqual(mutadoTS, TS, "el mutante no cambio nada"); assert.doesNotThrow(() => new vm.Script(js.replace(/^import .*$/gm, "").replace(/^export default /gm, "").replace(/^export /gm, "")), "el mutante no compila");
    await assert.rejects(async () => escenario((f) => tsAJs(mutadoTS)), (e) => { assert.ok(!(e instanceof SyntaxError), `el mutante «${nombre}» no se pudo ejecutar: ${e.message}`); return true; }, `el mutante «${nombre}» SOBREVIVIO`);
  });
  const enlaceOk = async (t) => { const { r, estado } = await pedir(U.cajero, { transpilar: t }); assert.equal(r.status, 200); return { r, estado }; };
  const RUTA_ID = 'router.post("/admin/usuarios/:id/enlace", exigirConfiguracion, exigirAdmin, async';

  debeFallar("la ruta deja de exigir administrador", sustituir(RUTA_ID, 'router.post("/admin/usuarios/:id/enlace", exigirConfiguracion, async'), async (t) => { const { r } = await pedir(U.mecanico, { transpilar: t, opciones: { token: null } }); assert.equal(r.status, 401); });
  debeFallar("se permite generar el enlace del PROPIO admin", sustituir("if (id === req.quien!.id) {\n    res.status(400).json({ error: \"No se genera un enlace", "if (false) {\n    res.status(400).json({ error: \"No se genera un enlace"), async (t) => { const { r, estado } = await pedir(ID_ADMIN, { transpilar: t }); assert.equal(r.status, 400); assert.match(r.cuerpo.error, /propia cuenta/); sinRastro(estado); });
  debeFallar("se acepta un usuario INACTIVO", sustituir("if (perfil.activo !== true) {\n    res.status(409)", "if (false) {\n    res.status(409)"), async (t) => { const { r, estado } = await pedir(U.baja, { transpilar: t }); assert.equal(r.status, 409); sinRastro(estado); });
  debeFallar("se acepta el objetivo administrador", sustituir('if (perfil.rol === "admin") {\n    res.status(400).json({ error: "La cuenta del administrador no se gestiona', 'if (false) {\n    res.status(400).json({ error: "La cuenta del administrador no se gestiona'), async (t) => { const { r, estado } = await pedir(U.otroAdmin, { transpilar: t }); assert.equal(r.status, 400); sinRastro(estado); });
  debeFallar("el correo se toma del CUERPO del cliente", sustituir('correo = typeof cuenta?.user?.email === "string" ? cuenta.user.email.trim() : "";', 'correo = String((req.body as Record<string, unknown>)?.["correo"] ?? cuenta?.user?.email ?? "");'), async (t) => { const { estado } = await pedir(U.mecanico, { transpilar: t, opciones: { body: { correo: "victima@example.test" }, cuerpoProhibido: false } }); assert.equal(estado.llamadas.generateLink[0].email, "mecanico@example.test"); });
  debeFallar("el rol se toma del CUERPO del cliente", sustituir("const generado = await generarEnlaceDeRecuperacion(correo, perfil.rol);", 'const generado = await generarEnlaceDeRecuperacion(correo, String((req.body as Record<string, unknown>)?.["rol"] ?? perfil.rol));'), async (t) => { const { estado } = await pedir(U.cajero, { transpilar: t, opciones: { body: { rol: "mecanico" }, cuerpoProhibido: false } }); assert.equal(estado.llamadas.generateLink[0].redirectTo, REDIRECT_TALLER); });
  debeFallar("la ruta lee req.body aunque no lo use (se detecta con el cuerpo prohibido)", sustituir('res.setHeader("Cache-Control", "no-store");\n  const id = String(req.params["id"] ?? "");\n\n  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "Identificador no válido." }); return; }\n  if (id === req.quien!.id) {\n    res.status(400).json({ error: "No se genera', 'res.setHeader("Cache-Control", "no-store");\n  void req.body;\n  const id = String(req.params["id"] ?? "");\n\n  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "Identificador no válido." }); return; }\n  if (id === req.quien!.id) {\n    res.status(400).json({ error: "No se genera'), async (t) => { await enlaceOk(t); });
  debeFallar("se REGISTRA el enlace", sustituir('logger.info({ evento: "enlace-recuperacion-generado", por: req.quien!.id, para: id, rol: perfil.rol }, "enlace de recuperación generado");', 'logger.info({ evento: "enlace-recuperacion-generado", por: req.quien!.id, para: id, rol: perfil.rol, enlace: generado.enlace }, "enlace de recuperación generado");'), async (t) => { const { estado } = await pedir(U.cajero, { transpilar: t }); const logs = JSON.stringify(estado.logs); for (const e of estado.enlacesEmitidos) assert.ok(!logs.includes(e.token), "un token llego a los registros"); });
  debeFallar("se registra el TOKEN del administrador", sustituir('logger.info({ evento: "enlace-recuperacion-generado", por: req.quien!.id, para: id, rol: perfil.rol }', 'logger.info({ evento: "enlace-recuperacion-generado", por: req.quien!.token, para: id, rol: perfil.rol }'), async (t) => { const { estado } = await pedir(U.cajero, { transpilar: t }); assert.ok(!JSON.stringify(estado.logs).includes(TOKEN_ADMIN), "el token del admin llego a los registros"); });
  debeFallar("se devuelve el mensaje interno de Supabase", sustituir('return { ok: false, motivo: "supabase-rechazo",\n               aviso: "Supabase no aceptó generar el enlace. Revisa que la dirección de vuelta esté en Authentication → URL Configuration → Redirect URLs." };', 'return { ok: false, motivo: "supabase-rechazo", aviso: String(errEnlace.message) };'), async (t) => { const e = estadoBase({ generateLink: async () => ({ data: null, error: { message: "MENSAJE-INTERNO-SECRETO", status: 400 } }) }); const { r } = await pedir(U.cajero, { estado: e, transpilar: t }); assert.ok(!JSON.stringify(r.cuerpo).includes("MENSAJE-INTERNO")); });
  debeFallar("se acepta cualquier action_link (sin validar que sea una cadena http(s))", sustituir('if (typeof accion !== "string" || !/^https?:\\/\\/\\S+$/i.test(accion)) {', "if (false) {"), async (t) => { const e = estadoBase({ generateLink: async () => ({ data: { properties: { action_link: "javascript:alert(1)" } }, error: null }) }); const { r } = await pedir(U.cajero, { estado: e, transpilar: t }); assert.equal(r.status, 502); });
  debeFallar("se quita Cache-Control: no-store", sustituir('res.setHeader("Cache-Control", "no-store");\n  const id = String(req.params["id"] ?? "");\n\n  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "Identificador no válido." }); return; }\n  if (id === req.quien!.id) {\n    res.status(400).json({ error: "No se genera', 'const id = String(req.params["id"] ?? "");\n\n  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "Identificador no válido." }); return; }\n  if (id === req.quien!.id) {\n    res.status(400).json({ error: "No se genera'), async (t) => { const { r } = await enlaceOk(t); assert.equal(r.cabeceras["cache-control"], "no-store"); });
  debeFallar("el destino de un mecanico deja de salir del origen de Mi Trabajo (todos al Taller)", sustituir('if (rol === "mecanico") base = MECHANIC_ORIGIN;', 'if (rol === "mecanico") base = ADMIN_ORIGIN;'), async (t) => { const { estado } = await pedir(U.mecanico, { transpilar: t }); assert.equal(estado.llamadas.generateLink[0].redirectTo, REDIRECT_MT); });
  test("mutante ESTATICO: reintroducir req.body / redirectTo en la ruta → el comprobador estatico lo detecta; el codigo real esta limpio", () => {
    assert.deepEqual(malEnRuta(TS), []); assert.ok(malEnRuta(sustituir("const id = String(req.params[\"id\"] ?? \"\");\n\n  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: \"Identificador no válido.\" }); return; }\n  if (id === req.quien!.id) {\n    res.status(400).json({ error: \"No se genera", "const id = String(req.body?.id ?? req.params[\"id\"] ?? \"\");\n\n  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: \"Identificador no válido.\" }); return; }\n  if (id === req.quien!.id) {\n    res.status(400).json({ error: \"No se genera")).length > 0);
  });
});
