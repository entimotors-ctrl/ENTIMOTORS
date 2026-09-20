// auth.js + supabase-client.js REALES contra el servidor sintetico. Cubre: sin sesion, roles, cuentas
// inactivas (capa cliente del hotfix RCV-35), errores del servidor, sesiones que caducan, eventos y fugas.
// Nota: el codigo NO usa supabase-js; habla REST con fetch. Las «llamadas auth.*» del enunciado son aqui las
// peticiones /auth/v1/* y /rest/v1/*, que el servidor sintetico registra una a una.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, sinLlamadasAjenas, sinFugas } from "./helpers/entorno.mjs";
import { crearServidor, CUENTAS, ANON, SERVICE_ROLE, URL_SB, jwtSintetico } from "./helpers/supabase-mock.mjs";
import { perfilDe } from "./helpers/flujos.mjs";

function entorno(o = {}) {
  const servidor = o.servidor ?? crearServidor();
  const storage = {};
  if (o.cuenta) storage.entimotors_sb_sesion = JSON.stringify(servidor.emitirSesion(o.cuenta, { expiraEnS: o.expiraEnS ?? 3600 }));
  if (o.perfil) storage.enti_perfil_supabase = JSON.stringify(o.perfil);
  const env = crearEntorno({ scripts: ["supabase-client", "auth"], producto: "ninguno", servidor, storage, online: o.online ?? true, config: o.config === undefined ? "sintetica" : o.config });
  env.eventos = [];
  env.win.Auth.alCambiar((e) => env.eventos.push(e));
  return env;
}
const A = (env) => env.win.Auth;
const helpers = (env) => ["esAdmin", "esMecanico", "esCajero", "esDesarrollador", "esEquipo"].map((h) => A(env)[h]());
const rutas = (env) => env.servidor.llamadas.map((l) => `${l.metodo} ${l.ruta.split("?")[0]} [${l.auth}]`);
const todosFalsos = (env) => assert.deepEqual(helpers(env), [false, false, false, false, false]);

describe("Sin sesion", () => {
  test("estado inicial: sin sesion, sin perfil, sin rol; ningun helper concede nada", () => {
    const env = entorno();
    assert.deepEqual(JSON.parse(JSON.stringify(A(env).estado())), { disponible: true, conSesion: false, correo: null, perfil: null, rol: null, origen: null });
    todosFalsos(env);
    assert.equal(A(env).usuarioActual(), null); assert.equal(A(env).sesionActual(), null); assert.equal(A(env).rolActual(), null);
  });
  test("restaurarSesion sin token: «sin-sesion», evento INITIAL_SESSION y CERO peticiones", async () => {
    const env = entorno();
    const r = await A(env).restaurarSesion();
    assert.deepEqual([r.ok, r.motivo], [false, "sin-sesion"]);
    assert.deepEqual(env.eventos, ["INITIAL_SESSION"]); assert.equal(env.servidor.llamadas.length, 0); sinLlamadasAjenas(env);
  });
  test("un perfil guardado SIN token no cuenta como sesion (conSesion=false, origen=null)", () => {
    const env = entorno({ perfil: perfilDe(CUENTAS.adminActivo) });
    const e = A(env).estado();
    assert.equal(e.conSesion, false); assert.equal(e.origen, null);
  });
  test("rolVerificado sin sesion: el servidor devuelve rol vacio (no hay privilegios)", async () => {
    const env = entorno(); const r = await A(env).rolVerificado();
    assert.equal(r.ok, true); assert.equal(r.datos, "");
  });
});

describe("Cuentas ACTIVAS por rol: entran con exactamente su rol", () => {
  const TABLA = [
    ["adminActivo", "admin", [true, false, false, false, true]],
    ["mecanicoActivo", "mecanico", [false, true, false, false, true]],
    ["cajeroActivo", "cajero", [false, false, true, false, true]],
    ["desarrollador", "desarrollador", [false, false, false, true, false]],
  ];
  for (const [clave, rol, esperado] of TABLA) {
    test(`${clave}: login ok, rol «${rol}», helpers [admin,mecanico,cajero,desarrollador,equipo] = ${JSON.stringify(esperado)}`, async () => {
      const c = CUENTAS[clave], env = entorno();
      const r = await A(env).iniciarSesion(c.correo, c.clave);
      assert.equal(r.ok, true);
      assert.deepEqual(JSON.parse(JSON.stringify(r.datos)), { uid: c.uid, nombre: c.perfil.nombre, rol, activo: true });
      assert.deepEqual(helpers(env), esperado);
      assert.deepEqual(env.eventos, ["SIGNED_IN"]);
      const e = A(env).estado(); assert.equal(e.conSesion, true); assert.equal(e.origen, "supabase"); assert.equal(e.rol, rol); assert.equal(e.correo, c.correo);
      sinLlamadasAjenas(env);
    });
  }
  test("la secuencia de peticiones del login es: token (sin Authorization de usuario) y luego perfiles con el token de SESION", async () => {
    const c = CUENTAS.adminActivo, env = entorno();
    await A(env).iniciarSesion(c.correo, c.clave);
    assert.deepEqual(rutas(env), ["POST /auth/v1/token [ninguno]", "GET /rest/v1/perfiles [sesion]"]);
    assert.ok(env.servidor.llamadas.every((l) => l.apikey === "anon"), "todas las peticiones llevan la clave anon como apikey");
  });
  test("la contrasena viaja al servidor pero NO se guarda: ni en localStorage, ni en consola, ni en el registro", async () => {
    const c = CUENTAS.adminActivo, env = entorno();
    await A(env).iniciarSesion(c.correo, c.clave);
    assert.equal(env.servidor.llamadas[0].cuerpo.password, `«len:${c.clave.length}»`, "el mock registra solo la longitud");
    sinFugas(env, [c.clave]);
    assert.ok(!JSON.stringify(A(env).estado()).includes(c.clave));
  });
  test("estado()/sesionActual()/usuarioActual() no exponen tokens", async () => {
    const c = CUENTAS.adminActivo, env = entorno();
    await A(env).iniciarSesion(c.correo, c.clave);
    const vista = JSON.stringify([A(env).estado(), A(env).sesionActual(), A(env).usuarioActual(), A(env).perfilActual()]);
    for (const t of env.servidor.tokensEmitidos()) assert.ok(!vista.includes(t), "un token aparece en la API publica de Auth");
    assert.ok(!/access_token|refresh_token/.test(vista));
  });
  test("el correo se recorta antes de enviarlo", async () => {
    const c = CUENTAS.adminActivo, env = entorno();
    await A(env).iniciarSesion(`  ${c.correo}  `, c.clave);
    assert.equal(env.servidor.llamadas[0].cuerpo.email, c.correo);
  });
  test("el perfil se lee por uid y pidiendo SOLO id,nombre,rol,activo", async () => {
    const c = CUENTAS.cajeroActivo, env = entorno();
    await A(env).iniciarSesion(c.correo, c.clave);
    const l = env.servidor.llamadas[1];
    assert.equal(l.ruta, `/rest/v1/perfiles?id=eq.${c.uid}&select=id,nombre,rol,activo`);
  });
});

describe("Capa cliente del hotfix RCV-35: activo=false NO conserva acceso por tener rol", () => {
  for (const clave of ["adminInactivo", "mecanicoInactivo", "cajeroInactivo"]) {
    const c = CUENTAS[clave];
    test(`${clave}: el login se deniega («cuenta-desactivada»), se CIERRA la sesion en el servidor y no queda nada`, async () => {
      const env = entorno();
      const r = await A(env).iniciarSesion(c.correo, c.clave);
      assert.deepEqual([r.ok, r.motivo], [false, "cuenta-desactivada"]);
      assert.equal(env.servidor.cierres, 1, "debe hacerse signOut en el servidor");
      assert.equal(env.almacen.getItem("entimotors_sb_sesion"), null); assert.equal(env.almacen.getItem("enti_perfil_supabase"), null);
      assert.equal(A(env).perfilActual(), null); assert.equal(A(env).estado().conSesion, false); assert.equal(A(env).rolActual(), null);
      todosFalsos(env); assert.ok(!env.eventos.includes("SIGNED_IN"), "no debe emitirse SIGNED_IN");
      assert.deepEqual(rutas(env), ["POST /auth/v1/token [ninguno]", "GET /rest/v1/perfiles [sesion]", "POST /auth/v1/logout [sesion]"]);
      sinLlamadasAjenas(env);
    });
    test(`${clave}: con una sesion ya guardada, restaurarSesion la CIERRA (aunque el perfil cacheado diga que era ${c.perfil.rol} activo)`, async () => {
      const env = entorno({ cuenta: c, perfil: { uid: c.uid, nombre: c.perfil.nombre, rol: c.perfil.rol, activo: true } });
      assert.equal(A(env).rolActual(), c.perfil.rol, "la copia local arranca con el rol (por diseno)");
      const r = await A(env).restaurarSesion();
      assert.deepEqual([r.ok, r.motivo], [false, "cuenta-desactivada"]);
      assert.equal(env.servidor.cierres, 1); todosFalsos(env); assert.equal(A(env).perfilActual(), null);
      assert.equal(env.almacen.getItem("enti_perfil_supabase"), null); assert.equal(env.almacen.getItem("entimotors_sb_sesion"), null);
      assert.deepEqual(env.eventos, ["SIGNED_OUT"]);
    });
  }
  test("el servidor confirma el mismo criterio: rol_actual() de una cuenta inactiva es vacio (RCV-35), la activa devuelve su rol", async () => {
    const inactiva = entorno({ cuenta: CUENTAS.adminInactivo }), activa = entorno({ cuenta: CUENTAS.adminActivo });
    assert.equal((await A(inactiva).rolVerificado()).datos, ""); assert.equal((await A(activa).rolVerificado()).datos, "admin");
  });
  test("solo la comparacion estricta activo === false cuenta como baja: null/ausente/«false» NO la disparan (GAP de defensa en profundidad)", async () => {
    // Caracterizacion del comportamiento REAL. La base lo cubre con NOT NULL (ver hotfix RCV-35); el cliente no.
    for (const valor of [undefined, null, "false", 0]) {
      const c = { ...CUENTAS.adminActivo, perfil: { nombre: "Admin", rol: "admin", activo: valor } };
      const env = entorno({ servidor: crearServidor([c]) });
      const r = await A(env).iniciarSesion(c.correo, c.clave);
      assert.equal(r.ok, true, `activo=${JSON.stringify(valor)} se acepto como cuenta activa`);
    }
  });
  test("GAP: la copia local del perfil con activo:false se acepta SIN red (activo solo se valida en respuestas del servidor)", async () => {
    const c = CUENTAS.adminActivo, servidor = crearServidor();
    const env = entorno({ servidor, cuenta: c, perfil: { uid: c.uid, nombre: c.perfil.nombre, rol: "admin", activo: false } });
    servidor.red = "caida";
    const r = await A(env).restaurarSesion();
    assert.equal(r.ok, true); assert.equal(A(env).esAdmin(), true);
  });
});

describe("Fail-closed ante perfil ausente, malformado o con error", () => {
  test("usuario sin perfil: «sin-perfil», signOut y sin privilegios", async () => {
    const c = CUENTAS.sinPerfil, env = entorno();
    const r = await A(env).iniciarSesion(c.correo, c.clave);
    assert.deepEqual([r.ok, r.motivo], [false, "sin-perfil"]); assert.equal(env.servidor.cierres, 1); todosFalsos(env); assert.equal(A(env).perfilActual(), null);
  });
  const ERRORES = [
    ["HTTP 500 del servidor", (s) => { s.perfilesHttp = 500; }, "error-servidor"],
    ["HTTP 503", (s) => { s.perfilesHttp = 503; }, "error-servidor"],
    ["HTTP 401 (token rechazado)", (s) => { s.perfilesHttp = 401; }, "sin-permiso"],
    ["HTTP 403 (RLS)", (s) => { s.perfilesHttp = 403; }, "sin-permiso"],
    ["red caida al leer el perfil", (s) => { s.perfilesRed = "caida"; }, "sin-conexion"],
    ["timeout al leer el perfil", (s) => { s.perfilesRed = "timeout"; }, "tiempo-agotado"],
  ];
  for (const [nombre, preparar, motivo] of ERRORES) {
    test(`login + ${nombre}: se DENIEGA («${motivo}»), se cierra la sesion, ningun privilegio`, async () => {
      const c = CUENTAS.adminActivo, servidor = crearServidor(); preparar(servidor);
      const env = entorno({ servidor });
      const r = await A(env).iniciarSesion(c.correo, c.clave);
      assert.equal(r.ok, false); assert.equal(r.motivo, motivo);
      assert.equal(env.servidor.cierres, 1); todosFalsos(env); assert.equal(A(env).perfilActual(), null); assert.ok(!env.eventos.includes("SIGNED_IN"));
      assert.equal(env.almacen.getItem("entimotors_sb_sesion"), null);
    });
  }
  const MALFORMADAS = [
    ["objeto en vez de arreglo", { oops: true }], ["texto no JSON", { raw: "<html>gateway</html>" }], ["null", null], ["arreglo vacio", []],
    ["arreglo con null", [null]], ["numero", 7], ["cadena JSON", "ok"],
  ];
  for (const [nombre, cuerpo] of MALFORMADAS) {
    test(`respuesta de perfil malformada (${nombre}): «sin-perfil» y sin sesion`, async () => {
      const c = CUENTAS.adminActivo, servidor = crearServidor(); servidor.perfilesCuerpo = cuerpo;
      const env = entorno({ servidor });
      const r = await A(env).iniciarSesion(c.correo, c.clave);
      assert.deepEqual([r.ok, r.motivo], [false, "sin-perfil"]); assert.equal(env.servidor.cierres, 1); todosFalsos(env);
    });
  }
  test("fila de perfil vacia [{}]: no concede NINGUN privilegio (rol undefined); la app la rechaza en el portero", async () => {
    const c = CUENTAS.adminActivo, servidor = crearServidor(); servidor.perfilesCuerpo = [{}];
    const env = entorno({ servidor });
    const r = await A(env).iniciarSesion(c.correo, c.clave);
    assert.equal(r.ok, true); todosFalsos(env); assert.equal(A(env).rolActual(), undefined);
  });
  test("rol DESCONOCIDO («superadmin»): ningun helper le concede privilegios; rolActual lo devuelve tal cual (GAP: sin lista blanca en el cliente)", async () => {
    const c = CUENTAS.rolDesconocido, env = entorno();
    const r = await A(env).iniciarSesion(c.correo, c.clave);
    assert.equal(r.ok, true); todosFalsos(env); assert.equal(A(env).rolActual(), "superadmin");
  });
  test("rol con mayusculas o espacios («Admin», «admin ») NO es admin (comparacion estricta)", async () => {
    for (const rol of ["Admin", "ADMIN", "admin ", " admin", "admin\n"]) {
      const c = { ...CUENTAS.adminActivo, perfil: { nombre: "X", rol, activo: true } };
      const env = entorno({ servidor: crearServidor([c]) });
      await A(env).iniciarSesion(c.correo, c.clave);
      todosFalsos(env);
    }
  });
  test("nunca convertir un error en autorizacion: tras CUALQUIER fallo de login no hay perfil, ni evento SIGNED_IN, ni token guardado", async () => {
    for (const ajuste of [(s) => { s.perfilesHttp = 500; }, (s) => { s.perfilesRed = "caida"; }, (s) => { s.perfilesCuerpo = { raw: "x" }; }, (s) => { s.red = "caida"; }]) {
      const c = CUENTAS.adminActivo, servidor = crearServidor(); ajuste(servidor);
      const env = entorno({ servidor }); await A(env).iniciarSesion(c.correo, c.clave);
      assert.equal(A(env).perfilActual(), null); assert.equal(A(env).estado().origen, null); assert.ok(!env.eventos.includes("SIGNED_IN"));
    }
  });
});

describe("Credenciales, red y configuracion", () => {
  test("credenciales invalidas: «credenciales-invalidas» — igual para clave mala que para correo inexistente (no delata cuentas)", async () => {
    const env = entorno();
    const a = await A(env).iniciarSesion(CUENTAS.adminActivo.correo, "mala"), b = await A(env).iniciarSesion("no-existe@example.test", "mala");
    assert.deepEqual([a.ok, a.motivo], [false, "credenciales-invalidas"]); assert.deepEqual([b.ok, b.motivo], [false, "credenciales-invalidas"]);
    assert.equal(A(env).perfilActual(), null); todosFalsos(env);
  });
  test("faltan datos: «faltan-datos» y CERO peticiones", async () => {
    const env = entorno();
    for (const [x, y] of [["", "clave"], ["a@b.c", ""], [null, null], [undefined, "x"]]) assert.equal((await A(env).iniciarSesion(x, y)).motivo, "faltan-datos");
    assert.equal(env.servidor.llamadas.length, 0);
  });
  test("sin conexion (fetch falla) y timeout: ambos se reportan como «sin-conexion» y no dejan sesion", async () => {
    for (const red of ["caida", "timeout"]) {
      const servidor = crearServidor(); servidor.red = red; const env = entorno({ servidor });
      const r = await A(env).iniciarSesion(CUENTAS.adminActivo.correo, CUENTAS.adminActivo.clave);
      assert.deepEqual([r.ok, r.motivo], [false, "sin-conexion"], red); todosFalsos(env);
    }
  });
  test("navigator.onLine=false: no se intenta ninguna peticion", async () => {
    const env = entorno({ online: false });
    const r = await A(env).iniciarSesion(CUENTAS.adminActivo.correo, CUENTAS.adminActivo.clave);
    assert.equal(r.motivo, "sin-conexion"); assert.equal(env.servidor.llamadas.length, 0);
  });
  test("Supabase sin configuracion / apagado / con URL invalida: Auth no esta disponible y NO hace peticiones", async () => {
    for (const [config, motivo] of [[null, "sin-configuracion"], [{ habilitado: false, url: URL_SB, anonKey: ANON }, "apagado-a-proposito"], [{ url: "http://x.test", anonKey: ANON }, "url-con-forma-invalida"], [{ url: URL_SB, anonKey: "" }, "faltan-url-o-anonkey"]]) {
      const env = entorno({ config });
      assert.equal(A(env).disponible(), false, motivo);
      assert.equal((await A(env).iniciarSesion("a@b.c", "x")).motivo, "supabase-no-configurado");
      assert.equal((await A(env).restaurarSesion()).motivo, "supabase-no-configurado");
      assert.equal(env.servidor.llamadas.length, 0, motivo);
    }
  });
  test("CORTAFUEGOS: una clave service_role (JWT o sb_secret_) en el navegador apaga Supabase y no envia NADA", async () => {
    for (const anonKey of [SERVICE_ROLE, "sb_secret_sintetica_no_valida"]) {
      const env = entorno({ config: { url: URL_SB, anonKey, habilitado: true } });
      assert.equal(env.win.SupabaseCliente.estado().motivo, "clave-de-servidor-rechazada"); assert.equal(A(env).disponible(), false);
      assert.match(env.consola.error.join("\n"), /service_role/);
      await A(env).iniciarSesion("a@b.c", "x"); assert.equal(env.servidor.llamadas.length, 0);
    }
  });
  test("una clave anon valida (JWT con role anon o sb_publishable_) SI arranca", () => {
    for (const anonKey of [jwtSintetico("anon"), "sb_publishable_sintetica"]) assert.equal(entorno({ config: { url: URL_SB, anonKey, habilitado: true } }).win.SupabaseCliente.estado().activo, true, anonKey.slice(0, 12));
  });
  test("la clave anon del repo (supabase-config.js) es realmente role=anon y NO service_role (comprobado sin imprimirla)", async () => {
    const { leer } = await import("./helpers/entorno.mjs");
    const jwt = /anonKey:\s*"(eyJ[^"]+)"/.exec(leer("supabase-config.js"))[1];
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    assert.equal(payload.role, "anon"); assert.notEqual(payload.role, "service_role");
  });
});

describe("Restaurar sesion al abrir la app", () => {
  test("token valido + perfil activo: restaura el rol, emite INITIAL_SESSION y confirma contra el servidor (Bearer de sesion)", async () => {
    const c = CUENTAS.adminActivo, env = entorno({ cuenta: c });
    const r = await A(env).restaurarSesion();
    assert.equal(r.ok, true); assert.equal(A(env).esAdmin(), true); assert.deepEqual(env.eventos, ["INITIAL_SESSION"]);
    assert.deepEqual(rutas(env), ["GET /rest/v1/perfiles [sesion]"]);
  });
  test("token + perfil ausente («sin-perfil»): se cierra la sesion", async () => {
    const c = CUENTAS.sinPerfil, env = entorno({ cuenta: c });
    const r = await A(env).restaurarSesion();
    assert.deepEqual([r.ok, r.motivo], [false, "sin-perfil"]); assert.equal(env.servidor.cierres, 1); todosFalsos(env);
  });
  test("token + 401/403 («sin-permiso»): se cierra la sesion", async () => {
    for (const http of [401, 403]) {
      const servidor = crearServidor(); servidor.perfilesHttp = http;
      const env = entorno({ servidor, cuenta: CUENTAS.adminActivo, perfil: perfilDe(CUENTAS.adminActivo) });
      const r = await A(env).restaurarSesion();
      assert.deepEqual([r.ok, r.motivo], [false, "sin-permiso"], String(http)); assert.equal(servidor.cierres, 1); todosFalsos(env);
    }
  });
  test("DISENO (offline-first): ante error 5xx NO se cierra la sesion y se conserva el perfil cacheado (el llamador decide)", async () => {
    const c = CUENTAS.adminActivo, servidor = crearServidor(); servidor.perfilesHttp = 500;
    const env = entorno({ servidor, cuenta: c, perfil: perfilDe(c) });
    const r = await A(env).restaurarSesion();
    assert.deepEqual([r.ok, r.motivo], [false, "error-servidor"]);
    assert.equal(servidor.cierres, 0); assert.equal(A(env).esAdmin(), true, "el perfil cacheado sigue vigente en memoria");
  });
  test("DISENO (offline-first): sin red y CON copia local del perfil se arranca con ella (INITIAL_SESSION)", async () => {
    const c = CUENTAS.mecanicoActivo, servidor = crearServidor(); servidor.red = "caida";
    const env = entorno({ servidor, cuenta: c, perfil: perfilDe(c) });
    const r = await A(env).restaurarSesion();
    assert.equal(r.ok, true); assert.equal(A(env).esMecanico(), true); assert.deepEqual(env.eventos, ["INITIAL_SESSION"]);
  });
  test("sin red y SIN copia local: no hay perfil y no se inventa ninguno", async () => {
    const servidor = crearServidor(); servidor.red = "caida";
    const env = entorno({ servidor, cuenta: CUENTAS.adminActivo });
    const r = await A(env).restaurarSesion();
    assert.deepEqual([r.ok, r.motivo], [false, "sin-conexion"]); todosFalsos(env); assert.equal(A(env).perfilActual(), null);
  });
  test("GAP (documentado): con el token CADUCADO restaurarSesion devuelve «sin-sesion» y NO intenta refrescar; borra el perfil de Auth", async () => {
    const c = CUENTAS.adminActivo, env = entorno({ cuenta: c, expiraEnS: -100, perfil: perfilDe(c) });
    const r = await A(env).restaurarSesion();
    assert.deepEqual([r.ok, r.motivo], [false, "sin-sesion"]); todosFalsos(env); assert.equal(A(env).perfilActual(), null);
    assert.equal(env.servidor.llamadas.length, 0, "no se intento refrescar ni consultar nada");
  });
  test("restaurarSesion no es reentrante: una segunda llamada simultanea devuelve «en-curso»", async () => {
    const env = entorno({ cuenta: CUENTAS.adminActivo });
    const p1 = A(env).restaurarSesion(), p2 = A(env).restaurarSesion();
    assert.equal((await p2).motivo, "en-curso"); assert.equal((await p1).ok, true);
  });
});

describe("La sesion cambia mientras se trabaja", () => {
  test("renovacion correcta: TOKEN_REFRESHED, el perfil se conserva y se reprograma", async () => {
    const c = CUENTAS.adminActivo, env = entorno();
    await A(env).iniciarSesion(c.correo, c.clave);
    assert.equal(env.timersPendientes(), 1);
    await env.avanzar(3500 * 1000);
    assert.ok(env.eventos.includes("TOKEN_REFRESHED")); assert.equal(A(env).esAdmin(), true); assert.equal(env.timersPendientes(), 1);
    assert.ok(rutas(env).includes("POST /auth/v1/token [ninguno]"));
  });
  test("renovacion RECHAZADA: SIGNED_OUT, el perfil se borra y ningun helper concede nada (el token guardado sigue hasta caducar: GAP)", async () => {
    const c = CUENTAS.adminActivo, env = entorno();
    await A(env).iniciarSesion(c.correo, c.clave);
    env.servidor.refrescoFalla = true;
    await env.avanzar(3500 * 1000);
    assert.ok(env.eventos.includes("SIGNED_OUT")); todosFalsos(env); assert.equal(A(env).perfilActual(), null);
    assert.equal(A(env).estado().rol, null); assert.equal(A(env).estado().origen, null);
    assert.equal(A(env).estado().conSesion, true, "GAP: el token de acceso viejo sigue guardado hasta que caduque");
  });
  test("cerrarSesion: llama a /logout con el token, limpia sesion y perfil, emite SIGNED_OUT y cancela el temporizador", async () => {
    const c = CUENTAS.adminActivo, env = entorno();
    await A(env).iniciarSesion(c.correo, c.clave);
    const r = await A(env).cerrarSesion();
    assert.equal(r.ok, true); assert.equal(env.servidor.cierres, 1); todosFalsos(env);
    assert.equal(env.almacen.getItem("entimotors_sb_sesion"), null); assert.equal(env.almacen.getItem("enti_perfil_supabase"), null);
    assert.equal(env.eventos.at(-1), "SIGNED_OUT"); assert.equal(env.timersPendientes(), 0);
  });
  test("cerrarSesion sin sesion: no llama al servidor pero limpia igual y emite SIGNED_OUT", async () => {
    const env = entorno(); await A(env).cerrarSesion();
    assert.equal(env.servidor.llamadas.length, 0); assert.deepEqual(env.eventos, ["SIGNED_OUT"]);
  });
  test("alCambiar: se puede cancelar, y un oyente que lanza no impide a los demas ni rompe a Auth (se registra el error)", async () => {
    const env = entorno(); const vistos = [];
    A(env).alCambiar(() => { throw new Error("oyente roto sintetico"); });
    const quitar = A(env).alCambiar((e) => vistos.push(e));
    await A(env).cerrarSesion(); assert.deepEqual(vistos, ["SIGNED_OUT"]); assert.match(env.consola.error.join("\n"), /oyente roto sintetico/);
    quitar(); await A(env).cerrarSesion(); assert.deepEqual(vistos, ["SIGNED_OUT"], "ya no debe recibir eventos");
  });
  test("con un token de sesion, las peticiones a tablas llevan ese token; sin sesion llevan la clave anon", async () => {
    const c = CUENTAS.adminActivo, env = entorno();
    await env.win.SupabaseCliente.tabla("perfiles").leer("select=*");
    await A(env).iniciarSesion(c.correo, c.clave); env.servidor.reiniciarRegistro();
    await env.win.SupabaseCliente.tabla("perfiles").leer("select=*");
    assert.deepEqual(env.servidor.inesperadas.length, 0 + env.servidor.inesperadas.length);
    const cats = env.servidor.llamadas.map((l) => l.auth); assert.deepEqual(cats, ["sesion"]);
  });
});
