// app.js REAL, tramos multiusuario (los que cambiaron los 6 commits desde 4ef632a): portero de sesion,
// separacion taller / Mi Trabajo, vistas por rol, guardas, login con Supabase, arranque con sesion guardada,
// caducidad de sesion y updateOrder para el mecanico. Se ejecuta el codigo real; solo IndexedDB se sustituye.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { sinLlamadasAjenas, sinFugas } from "./helpers/entorno.mjs";
import { nuevoEntorno, enviarLogin, sesionAppDe, perfilDe, activo, toasts, como, dbFalsa, CUENTAS, crearServidor } from "./helpers/flujos.mjs";
import { UUID } from "./helpers/supabase-mock.mjs";

const ADMIN_SB = { rol: "admin", origen: "supabase", perfilId: UUID(1), nombre: "Admin Activo", activo: true };
const ADMIN_LOCAL = { rol: "admin", origen: "local", nombre: "Usuario de Prueba" };
const CAJERO = { rol: "cajero", origen: "supabase", perfilId: UUID(5), nombre: "Cajero", activo: true };
const MEC_SB = { rol: "mecanico", origen: "supabase", perfilId: UUID(3), nombre: "Mecanico Activo", activo: true };
const MEC_LOCAL = { rol: "mecanico", origen: "local", nombre: "Mecánico 1" };
const DEV = { rol: "desarrollador", origen: "supabase", perfilId: UUID(7), nombre: "Dev", activo: true };
const RARO = { rol: "superadmin", origen: "supabase", perfilId: UUID(9), nombre: "Raro", activo: true };
const VISTAS = ["dashboard", "citas", "ordenes", "clientes", "cotizaciones", "inventario", "pos", "creditos", "finanzas", "web-cms", "ajustes", "usuarios", "mi-trabajo"];

describe("sesionAdmitida — el portero", () => {
  const admitir = (producto, s) => { const e = nuevoEntorno({ producto }); return e.win.sesionAdmitida(s); };
  const MOTIVOS = {
    sinSesion: "No se pudo leer tu sesión. Vuelve a entrar.",
    soloCorreo: "Aquí se entra solo con tu correo y contraseña de ENTIMOTORS.",
    esDelTaller: "Esta cuenta se usa desde ENTIMOTORS Taller, no desde Mi Trabajo.",
    baja: "Esta cuenta está dada de baja. Habla con el administrador.",
    sinIdentidad: "No se pudo validar tu identidad de trabajador. Habla con el administrador.",
    esDeMecanicos: "Esta cuenta debe ingresar desde ENTIMOTORS Mi Trabajo.",
  };
  describe("producto TALLER", () => {
    for (const [nombre, s] of [["null", null], ["undefined", undefined], ["{} sin rol", {}], ["rol vacio", { rol: "" }]])
      test(`sesion invalida (${nombre}) → deniega`, () => { const r = admitir("admin", s); assert.deepEqual([r.ok, r.motivo], [false, MOTIVOS.sinSesion]); });
    for (const [nombre, s] of [["admin local (TEAM)", ADMIN_LOCAL], ["admin con cuenta", ADMIN_SB], ["cajero con cuenta", CAJERO], ["mecanico LOCAL (TEAM)", MEC_LOCAL]])
      test(`admite: ${nombre}`, () => assert.equal(admitir("admin", s).ok, true));
    test("DENIEGA al mecanico con cuenta de Supabase: debe entrar por Mi Trabajo", () => { const r = admitir("admin", MEC_SB); assert.deepEqual([r.ok, r.motivo], [false, MOTIVOS.esDeMecanicos]); });
    test("CERRADO (4E-C4-FIX): DENIEGA un rol desconocido («superadmin»): el portero del taller tiene lista blanca [admin, cajero, mecanico]", () => { const r = admitir("admin", RARO); assert.deepEqual([r.ok, r.motivo], [false, "Tu rol no tiene acceso a ENTIMOTORS Taller."]); });
    test("lista blanca: «foo», «Admin» (otra capitalizacion), espacios, numero, objeto, arreglo y booleano se deniegan; los tres roles validos siguen entrando", () => {
      for (const rol of ["foo", "Admin", "ADMIN", " admin", "admin ", "superadmin", 7, {}, [], ["admin"], true]) { const r = admitir("admin", { ...ADMIN_SB, rol }); assert.equal(r.ok, false, JSON.stringify(rol)); assert.equal(r.motivo, "Tu rol no tiene acceso a ENTIMOTORS Taller.", JSON.stringify(rol)); }
      for (const s of [ADMIN_SB, ADMIN_LOCAL, CAJERO, MEC_LOCAL]) assert.equal(admitir("admin", s).ok, true, s.rol);
    });
    test("GAP (caracterizacion): el portero del taller NO mira activo=false (lo cubre Auth.cargarPerfil aguas arriba)", () => assert.equal(admitir("admin", { ...ADMIN_SB, activo: false }).ok, true));
    test("«desarrollador»: el portero tambien lo DENIEGA (ademas de entrarConSesion/arrancarConSesion, que lo cortan antes): defensa en profundidad para sesiones ya guardadas", () => { const r = admitir("admin", DEV); assert.deepEqual([r.ok, r.motivo], [false, "Cuenta técnica: no abre el taller. Usa el panel técnico."]); });
  });
  describe("producto MI TRABAJO", () => {
    test("admite SOLO al mecanico con cuenta, con perfilId y sin baja", () => {
      assert.equal(admitir("mecanico", MEC_SB).ok, true);
      assert.equal(admitir("mecanico", { ...MEC_SB, activo: undefined }).ok, true, "activo ausente no es baja");
    });
    const DENIEGA = [
      ["origen local", { ...MEC_SB, origen: "local" }, "soloCorreo"], ["sin origen", { ...MEC_SB, origen: undefined }, "soloCorreo"],
      ["admin con cuenta", ADMIN_SB, "esDelTaller"], ["cajero con cuenta", CAJERO, "esDelTaller"], ["desarrollador", DEV, "esDelTaller"], ["rol desconocido", RARO, "esDelTaller"],
      ["mecanico dado de baja", { ...MEC_SB, activo: false }, "baja"],
      ["sin perfilId (undefined)", { ...MEC_SB, perfilId: undefined }, "sinIdentidad"], ["perfilId vacio", { ...MEC_SB, perfilId: "" }, "sinIdentidad"],
      ["perfilId null", { ...MEC_SB, perfilId: null }, "sinIdentidad"], ["perfilId numerico", { ...MEC_SB, perfilId: 123 }, "sinIdentidad"], ["perfilId objeto", { ...MEC_SB, perfilId: {} }, "sinIdentidad"],
      ["sesion nula", null, "sinSesion"], ["sin rol", { origen: "supabase" }, "sinSesion"],
    ];
    for (const [nombre, s, clave] of DENIEGA) test(`DENIEGA: ${nombre}`, () => { const r = admitir("mecanico", s); assert.deepEqual([r.ok, r.motivo], [false, MOTIVOS[clave]]); });
  });
});

describe("entrarConSesion / denegarSesion / startApp — nada se abre sin permiso", () => {
  test("TALLER + desarrollador: mensaje de «Cuenta tecnica», signOut, NO guarda sesion, NO arranca, NO abre bases", async () => {
    const env = nuevoEntorno({ producto: "admin" }); await env.asentar();
    const cierres = []; env.win.Auth.cerrarSesion = () => { cierres.push(1); return Promise.resolve({ ok: true }); };
    env.win.entrarConSesion(DEV);
    assert.match(env.doc.getElementById("loginError").innerHTML, /Cuenta técnica: no abre el taller/);
    assert.equal(cierres.length, 1); assert.equal(env.almacen.getItem("enti_session"), null); assert.equal(env.startApp.length, 0); assert.deepEqual(env.idbAbiertas, []);
  });
  test("TALLER + mecanico con cuenta: denegarSesion — login visible, shell cerrado, sesion borrada y NINGUNA base abierta", async () => {
    const c = CUENTAS.mecanicoActivo, env = nuevoEntorno({ producto: "admin" }); await env.asentar();
    env.almacen.setItem("enti_session", "previa");
    env.win.entrarConSesion(sesionAppDe(c)); await env.asentar();
    assert.equal(env.doc.getElementById("loginError").textContent, "Esta cuenta debe ingresar desde ENTIMOTORS Mi Trabajo.");
    assert.equal(activo(env, "gateLogin"), true); assert.equal(activo(env, "shell"), false);
    assert.equal(env.almacen.getItem("enti_session"), null); assert.equal(env.startApp.length, 0); assert.deepEqual(env.idbAbiertas, []);
  });
  test("MI TRABAJO + admin/cajero/desarrollador con cuenta: entrarConSesion los deniega sin guardar nada ni abrir ninguna base", async () => {
    for (const cuenta of [CUENTAS.adminActivo, CUENTAS.cajeroActivo, CUENTAS.desarrollador]) {
      const env = nuevoEntorno({ producto: "mecanico" }); await env.asentar();
      env.win.entrarConSesion(sesionAppDe(cuenta)); await env.asentar();
      assert.equal(env.doc.getElementById("loginError").textContent, "Esta cuenta se usa desde ENTIMOTORS Taller, no desde Mi Trabajo.", cuenta.perfil.rol);
      assert.equal(env.almacen.getItem("enti_session"), null); assert.equal(env.startApp.length, 0); assert.deepEqual(env.idbAbiertas, []);
    }
  });
  test("DEFENSA EN PROFUNDIDAD — arranque con sesion de Supabase VALIDA de una cuenta de otro producto: arrancarConSesion no pasa por el portero, pero startApp real lo corta (sin bases, signOut, sin enti_session)", async () => {
    for (const [producto, cuenta, mensaje] of [
      ["admin", CUENTAS.mecanicoActivo, "Esta cuenta debe ingresar desde ENTIMOTORS Mi Trabajo."],
      ["mecanico", CUENTAS.adminActivo, "Esta cuenta se usa desde ENTIMOTORS Taller, no desde Mi Trabajo."],
      ["mecanico", CUENTAS.cajeroActivo, "Esta cuenta se usa desde ENTIMOTORS Taller, no desde Mi Trabajo."],
    ]) {
      const env = nuevoEntorno({ producto, cuenta, sesionGuardada: sesionAppDe(cuenta), espiarStartApp: false }); await env.asentar();
      assert.equal(env.doc.getElementById("loginError").textContent, mensaje, `${producto}/${cuenta.perfil.rol}`);
      assert.equal(activo(env, "gateLogin"), true); assert.equal(activo(env, "shell"), false); assert.equal(env.evaluar("currentUser"), null);
      assert.equal(env.almacen.getItem("enti_session"), null); assert.deepEqual(env.idbAbiertas, []); assert.equal(env.servidor.cierres, 1, "debe cerrarse la sesion de Supabase");
    }
  });
  test("una sesion que se admite se guarda y arranca la app exactamente una vez", async () => {
    const env = nuevoEntorno({ producto: "admin" }); await env.asentar();
    env.win.entrarConSesion(ADMIN_LOCAL);
    assert.equal(env.startApp.length, 1); assert.equal(env.startApp[0][0].rol, "admin"); assert.equal(JSON.parse(env.almacen.getItem("enti_session")).origen, "local");
    assert.equal(activo(env, "gateLogin"), false);
  });
  test("startApp REPITE el portero antes de abrir nada: TALLER + mecanico con cuenta → no abre ninguna base", async () => {
    const env = nuevoEntorno({ producto: "admin", espiarStartApp: false }); await env.asentar();
    await env.win.startApp(MEC_SB); await env.asentar();
    assert.deepEqual(env.idbAbiertas, []); assert.equal(env.evaluar("currentUser"), null); assert.equal(activo(env, "gateLogin"), true);
  });
  test("startApp: MI TRABAJO + admin → no abre ninguna base", async () => {
    const env = nuevoEntorno({ producto: "mecanico", espiarStartApp: false }); await env.asentar();
    await env.win.startApp(ADMIN_SB); await env.asentar();
    assert.deepEqual(env.idbAbiertas, []); assert.equal(env.evaluar("currentUser"), null);
  });
  test("startApp: el mecanico con cuenta abre SU base (por perfilId) — nunca la del taller", async () => {
    const env = nuevoEntorno({ producto: "mecanico", espiarStartApp: false }); await env.asentar();
    await assert.rejects(env.win.startApp(MEC_SB), /indexedDB deshabilitado/);
    assert.deepEqual(env.idbAbiertas.map((b) => b.nombre), [`entimotors_os_demo_mec_${MEC_SB.perfilId}`]);
    const env2 = nuevoEntorno({ producto: "admin", espiarStartApp: false }); await env2.asentar();
    await assert.rejects(env2.win.startApp(ADMIN_SB), /indexedDB deshabilitado/);
    assert.deepEqual(env2.idbAbiertas.map((b) => b.nombre), ["entimotors_os_demo"]);
  });
  test("startApp: el rol se muestra como TEXTO en la barra (textContent, no innerHTML)", async () => {
    const env = nuevoEntorno({ producto: "admin", espiarStartApp: false }); await env.asentar();
    await assert.rejects(env.win.startApp({ ...ADMIN_SB, nombre: "<b>x</b>" }));
    assert.equal(env.doc.getElementById("loggedUserName").textContent, "<b>x</b>");
    assert.ok(!env.doc.sumideros.some((s) => s.id === "loggedUserName"), "no debe pasar por innerHTML");
  });
});

describe("Vistas y permisos por rol (puedeVerVista / showView / aplicarPermisosPorRol)", () => {
  const visibles = (env, u) => { como(env, u); return VISTAS.filter((v) => env.win.puedeVerVista(v)); };
  const todasMenos = (...ocultas) => VISTAS.filter((v) => !ocultas.includes(v));
  const CASOS = [
    ["admin (cuenta)", ADMIN_SB, todasMenos("mi-trabajo")],
    ["admin local", ADMIN_LOCAL, todasMenos("mi-trabajo")],
    ["cajero", CAJERO, todasMenos("web-cms", "ajustes", "usuarios", "mi-trabajo")],
    ["mecanico LOCAL (TEAM)", MEC_LOCAL, todasMenos("finanzas", "web-cms", "ajustes", "usuarios", "mi-trabajo")],
    ["mecanico con CUENTA: solo su pantalla", MEC_SB, ["mi-trabajo"]],
    ["desarrollador: ninguna", DEV, []],
  ];
  for (const [nombre, u, esperado] of CASOS) test(`${nombre}`, () => assert.deepEqual(visibles(nuevoEntorno(), u), esperado));
  test("GAP (caracterizacion): un rol DESCONOCIDO cae en el fallback y ve las vistas operativas (POS, creditos, clientes…) — no hay «negar todo»", () => {
    assert.deepEqual(visibles(nuevoEntorno(), RARO), todasMenos("finanzas", "web-cms", "ajustes", "usuarios", "mi-trabajo"));
  });
  test("un rol desconocido NUNCA ve las vistas de administrador (finanzas, web-cms, ajustes, usuarios)", () => {
    const v = visibles(nuevoEntorno(), RARO); for (const x of ["finanzas", "web-cms", "ajustes", "usuarios"]) assert.ok(!v.includes(x), x);
  });
  test("sin usuario (arranque) todo es visible pero no hay shell abierto (documentado: «durante el arranque no hay rol todavia»)", () => {
    assert.deepEqual(visibles(nuevoEntorno(), null), VISTAS);
  });
  test("showView deniega con aviso y NO cambia de vista; permite la vista propia", () => {
    const env = nuevoEntorno(); como(env, MEC_SB);
    assert.equal(env.win.showView("finanzas"), false); assert.deepEqual(toasts(env), ["No tienes acceso a esa sección"]);
    assert.equal(env.doc.getElementById("view-finanzas").classList.contains("active"), false);
    assert.equal(env.win.showView("mi-trabajo"), true); assert.equal(env.doc.getElementById("view-mi-trabajo").classList.contains("active"), true);
  });
  test("aplicarPermisosPorRol oculta en el menu exactamente lo que el rol no puede ver", () => {
    const env = nuevoEntorno();
    env.doc.getElementById("sidebar").innerHTML = VISTAS.map((v) => `<button class="nav-item" data-view="${v}">${v}</button>`).join("");
    for (const [nombre, u, esperado] of CASOS.filter((c) => c[1] !== DEV)) {
      como(env, u); env.win.aplicarPermisosPorRol();
      const ocultas = env.doc.querySelectorAll(".nav-item[data-view]").filter((b) => b.style.display === "none").map((b) => b.dataset.view);
      assert.deepEqual(VISTAS.filter((v) => !ocultas.includes(v)), esperado, nombre);
    }
  });
});

describe("Guardas de identidad y de gestion", () => {
  const con = (u) => { const e = nuevoEntorno(); como(e, u); return e; };
  test("esMecanicoCuenta exige rol mecanico + origen supabase + perfilId; el TEAM local NO cuenta", () => {
    assert.equal(con(MEC_SB).win.esMecanicoCuenta(), true);
    for (const u of [MEC_LOCAL, { ...MEC_SB, origen: "local" }, { ...MEC_SB, perfilId: null }, { ...MEC_SB, perfilId: "" }, ADMIN_SB, RARO, null]) assert.equal(con(u).win.esMecanicoCuenta(), false, JSON.stringify(u));
  });
  test("puedeGestionarTaller / puedeAsignarMecanico: gestion = admin o cajero; asignar = solo admin", () => {
    const t = [[ADMIN_SB, true, true], [ADMIN_LOCAL, true, true], [CAJERO, true, false], [MEC_SB, false, false], [MEC_LOCAL, false, false], [DEV, false, false], [RARO, false, false], [null, false, false]];
    for (const [u, g, a] of t) { const e = con(u); assert.deepEqual([e.win.puedeGestionarTaller(), e.win.puedeAsignarMecanico()], [g, a], JSON.stringify(u)); }
  });
  test("exigeGestion: deja pasar a admin/cajero; a los demas los BLOQUEA con aviso (mensaje propio o el generico)", () => {
    const e1 = con(CAJERO); assert.equal(e1.win.exigeGestion("x"), true); assert.deepEqual(toasts(e1), []);
    for (const u of [MEC_SB, MEC_LOCAL, DEV, RARO, null]) {
      const e = con(u);
      assert.equal(e.win.exigeGestion("Solo el administrador o el cajero editan una cita"), false, JSON.stringify(u));
      assert.deepEqual(toasts(e), ["Solo el administrador o el cajero editan una cita"]);
      assert.equal(e.win.exigeGestion(), false); assert.equal(toasts(e).at(-1), "Esa acción es del administrador");
    }
  });
  test("esTrabajoPropio: propiedad por UUID, nunca por nombre; sin id = de nadie", () => {
    const e = con(MEC_SB), f = e.win.esTrabajoPropio;
    assert.equal(f({ mecanicoId: MEC_SB.perfilId }), true);
    for (const r of [{ mecanicoId: UUID(99) }, { mecanicoId: null }, { mecanicoId: "" }, {}, null, undefined, { mecanico: MEC_SB.nombre }]) assert.equal(f(r), false, JSON.stringify(r));
    const sinId = con({ ...MEC_SB, perfilId: null }); assert.equal(sinId.win.esTrabajoPropio({ mecanicoId: null }), false); assert.equal(sinId.win.esTrabajoPropio({ mecanicoId: undefined }), false);
  });
  test("puedeEditarTecnico: mecanico con cuenta = solo lo suyo y sin entregar; admin/cajero siempre; TEAM local (sin gestion) no", () => {
    const suya = { mecanicoId: MEC_SB.perfilId, estado: "reparacion" };
    const m = con(MEC_SB).win.puedeEditarTecnico;
    assert.equal(m(suya), true); assert.equal(m({ ...suya, estado: "entregado" }), false); assert.equal(m({ ...suya, mecanicoId: UUID(50) }), false); assert.equal(m({}), false); assert.equal(m(undefined), false);
    assert.equal(con(ADMIN_SB).win.puedeEditarTecnico({ estado: "entregado" }), true); assert.equal(con(CAJERO).win.puedeEditarTecnico({}), true);
    assert.equal(con(MEC_LOCAL).win.puedeEditarTecnico(suya), false); assert.equal(con(RARO).win.puedeEditarTecnico(suya), false);
  });
  test("asignacionDesdeSelect: quien no es admin crea SIN ASIGNAR (no se inventa un nombre)", () => {
    for (const u of [CAJERO, MEC_SB, MEC_LOCAL, RARO]) assert.deepEqual(JSON.parse(JSON.stringify(con(u).win.asignacionDesdeSelect("ordenMecanico"))), { mecanico: "", mecanicoId: null }, JSON.stringify(u));
  });
  test("asignacionDesdeSelect (admin): toma nombre y perfilId de la opcion elegida", () => {
    const e = con(ADMIN_SB), sel = e.doc.getElementById("ordenMecanico"); sel.value = "Ana";
    sel.selectedOptions = [{ dataset: { perfilId: UUID(3) } }];
    assert.deepEqual(JSON.parse(JSON.stringify(e.win.asignacionDesdeSelect("ordenMecanico"))), { mecanico: "Ana", mecanicoId: UUID(3) });
  });
  test("asignacionDelUsuarioActual: el trabajo que crea el usuario queda a su nombre y a su UUID", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(con(MEC_SB).win.asignacionDelUsuarioActual())), { mecanico: MEC_SB.nombre, mecanicoId: MEC_SB.perfilId });
    assert.deepEqual(JSON.parse(JSON.stringify(con(null).win.asignacionDelUsuarioActual())), { mecanico: "", mecanicoId: null });
  });
  // 3.14.0 (SYNC-6): poblarSelectMecanico es async (espera la lista real de mecánicos de la nube) → se espera antes de afirmar
  test("poblarSelectMecanico: quien no puede asignar NO ve el selector (queda «Sin asignar»); el admin lo ve poblado y escapado", async () => {
    const e = con(CAJERO); const sel = e.doc.getElementById("ordenMecanico");
    await e.win.poblarSelectMecanico("ordenMecanico"); assert.equal(sel.style.display, "none"); assert.equal(sel.innerHTML, '<option value="">Sin asignar</option>'); assert.equal(sel.value, "");
    const a = con(ADMIN_SB); await a.win.poblarSelectMecanico("ordenMecanico");
    assert.match(a.doc.getElementById("ordenMecanico").innerHTML, /Mecánico 1/);
  });
  test("openClienteDetalle: el mecanico con cuenta NO abre la ficha del cliente y ni siquiera lee la base", async () => {
    const e = con(MEC_SB); const db = dbFalsa(e, { clientes: [{ id: 1, nombre: "Cliente Sintetico" }] });
    let lecturas = 0; e.evaluar("DB.get = async () => { window.__lecturas = (window.__lecturas||0)+1; return { id: 1, nombre: 'x' }; }");
    await e.win.openClienteDetalle(1); assert.equal(e.win.__lecturas || 0, 0, "leyo la base"); assert.deepEqual(toasts(e), ["La ficha del cliente es del administrador"]);
    assert.deepEqual(db.guardados(), []);
  });
});

describe("updateOrder — el mecanico con cuenta solo avanza SU trabajo, un peldano, y nunca entrega", () => {
  const escenario = (usuario, orden) => { const e = nuevoEntorno(); como(e, usuario); const db = dbFalsa(e, { ordenes: orden ? [orden] : [] }); return { e, db }; };
  const suya = (estado, extra = {}) => ({ id: 7, estado, mecanicoId: MEC_SB.perfilId, km: 100, ...extra });
  const avance = (est) => (o) => { o.estado = est; };
  test("avance valido de un peldano en su orden: se guarda", async () => {
    const { e, db } = escenario(MEC_SB, suya("recibido")); const o = await e.win.updateOrder(7, avance("diagnostico"));
    assert.equal(o.estado, "diagnostico"); assert.equal(db.guardados().length, 1); assert.deepEqual(toasts(e), []);
  });
  for (const [de, a, motivo] of [
    ["recibido", "presupuesto", "Solo puedes avanzar una etapa a la vez"], ["diagnostico", "reparacion", "Solo puedes avanzar una etapa a la vez"],
    ["diagnostico", "recibido", "Solo puedes avanzar una etapa a la vez"], ["reparacion", "diagnostico", "Solo puedes avanzar una etapa a la vez"],
    ["calidad", "entregado", "Entregar y cobrar es del administrador"], ["reparacion", "entregado", "Entregar y cobrar es del administrador"],
    ["calidad", "reparacion", "Solo puedes avanzar una etapa a la vez"],
  ]) test(`BLOQUEA ${de} → ${a}: «${motivo}» y no guarda`, async () => {
    const { e, db } = escenario(MEC_SB, suya(de)); const o = await e.win.updateOrder(7, avance(a));
    assert.equal(o.estado, de); assert.deepEqual(db.guardados(), []); assert.deepEqual(toasts(e), [motivo]);
  });
  test("una orden de OTRO mecanico: «Ese trabajo no esta asignado a ti» y no guarda", async () => {
    const { e, db } = escenario(MEC_SB, suya("recibido", { mecanicoId: UUID(55) })); await e.win.updateOrder(7, avance("diagnostico"));
    assert.deepEqual(db.guardados(), []); assert.deepEqual(toasts(e), ["Ese trabajo no está asignado a ti"]);
  });
  test("una orden SIN asignar (mecanicoId nulo) no es de nadie: se bloquea", async () => {
    for (const mecanicoId of [null, undefined, ""]) { const { e, db } = escenario(MEC_SB, suya("recibido", { mecanicoId })); await e.win.updateOrder(7, avance("diagnostico")); assert.deepEqual(db.guardados(), [], String(mecanicoId)); }
  });
  test("una orden inexistente no revienta: se bloquea y devuelve undefined", async () => {
    const { e, db } = escenario(MEC_SB, null); const o = await e.win.updateOrder(7, avance("diagnostico"));
    assert.equal(o, undefined); assert.deepEqual(db.guardados(), []);
  });
  test("una orden YA ENTREGADA (aunque sea suya) es de solo lectura", async () => {
    const { e, db } = escenario(MEC_SB, suya("entregado")); await e.win.updateOrder(7, (o) => { o.km = 5; });
    assert.deepEqual(db.guardados(), []); assert.deepEqual(toasts(e), ["Este trabajo ya fue entregado"]);
  });
  test("puede tocar otros campos de SU orden sin cambiar de etapa (p. ej. km)", async () => {
    const { e, db } = escenario(MEC_SB, suya("reparacion")); const o = await e.win.updateOrder(7, (x) => { x.km = 250; });
    assert.equal(o.km, 250); assert.equal(db.guardados().length, 1);
  });
  test("cambiar de etapa Y otro campo a la vez sigue sujeto a la regla del peldano", async () => {
    const { e, db } = escenario(MEC_SB, suya("recibido")); await e.win.updateOrder(7, (x) => { x.estado = "reparacion"; x.km = 1; });
    assert.deepEqual(db.guardados(), []);
  });
  test("el mutator se prueba sobre una COPIA: una orden bloqueada no queda modificada en la base", async () => {
    const { e } = escenario(MEC_SB, suya("recibido")); await e.win.updateOrder(7, avance("presupuesto"));
    assert.equal(e.win.__datos.ordenes[0].estado, "recibido");
  });
  test("admin y cajero pueden llevar la orden a cualquier etapa, incluso entregado", async () => {
    for (const u of [ADMIN_SB, CAJERO]) { const { e, db } = escenario(u, suya("calidad")); const o = await e.win.updateOrder(7, avance("entregado")); assert.equal(o.estado, "entregado"); assert.equal(db.guardados().length, 1); }
  });
  test("caracterizacion: el mecanico de la lista TEAM LOCAL (sin cuenta) conserva el comportamiento historico (sin restricciones)", async () => {
    const { e, db } = escenario(MEC_LOCAL, suya("recibido", { mecanicoId: undefined })); const o = await e.win.updateOrder(7, avance("entregado"));
    assert.equal(o.estado, "entregado"); assert.equal(db.guardados().length, 1);
  });
});

describe("Mi Trabajo — renderMiTrabajo filtra por UUID", () => {
  test("solo muestra las citas y ordenes ASIGNADAS por uuid al mecanico; las entregadas van al historial", async () => {
    const e = nuevoEntorno({ producto: "mecanico" }); como(e, MEC_SB);
    dbFalsa(e, {
      clientes: [{ id: 1, nombre: "Cliente Uno", telefono: "" }], motos: [{ id: 1, marca: "Honda", modelo: "XR", placa: "AAA111" }],
      citas: [{ id: 1, clienteId: 1, fecha: "2099-01-01", hora: "10:00", motivo: "cita mia", mecanicoId: MEC_SB.perfilId }, { id: 2, clienteId: 1, fecha: "2099-01-01", hora: "11:00", motivo: "cita de otro", mecanicoId: UUID(60) }, { id: 3, clienteId: 1, fecha: "2099-01-01", hora: "12:00", motivo: "sin asignar" }],
      ordenes: [{ id: 10, estado: "reparacion", clienteId: 1, motoId: 1, falla: "falla mia", mecanicoId: MEC_SB.perfilId }, { id: 11, estado: "reparacion", clienteId: 1, motoId: 1, falla: "falla ajena", mecanicoId: UUID(60) }, { id: 12, estado: "entregado", clienteId: 1, motoId: 1, falla: "entregada mia", mecanicoId: MEC_SB.perfilId }, { id: 13, estado: "recibido", clienteId: 1, motoId: 1, falla: "por nombre", mecanico: MEC_SB.nombre }],
    });
    await e.win.renderMiTrabajo();
    const citas = e.doc.getElementById("miTrabajoCitas").innerHTML, ords = e.doc.getElementById("miTrabajoOrdenes").innerHTML, hist = e.doc.getElementById("miTrabajoHistorial").innerHTML;
    assert.match(citas, /cita mia/); assert.ok(!/cita de otro|sin asignar/.test(citas));
    assert.match(ords, /falla mia/); assert.ok(!/falla ajena|por nombre|entregada mia/.test(ords), "no debe mostrar lo ajeno, lo asignado solo por nombre ni lo entregado");
    assert.match(hist, /entregada mia/); assert.match(hist, /Solo lectura/);
    assert.equal(e.doc.getElementById("miTrabajoSub").textContent, `${MEC_SB.nombre} · acceso para mecánicos.`);
  });
  test("sin trabajo en el dispositivo: mensajes vacios que NO prometen asignacion, sin errores", async () => {
    const e = nuevoEntorno({ producto: "mecanico" }); como(e, MEC_SB); dbFalsa(e, { clientes: [], motos: [], citas: [], ordenes: [] });
    await e.win.renderMiTrabajo();
    assert.match(e.doc.getElementById("miTrabajoCitas").innerHTML, /No hay citas en este dispositivo/); assert.match(e.doc.getElementById("miTrabajoOrdenes").innerHTML, /No hay órdenes abiertas en este dispositivo/);
    assert.match(e.doc.getElementById("miTrabajoHistorial").innerHTML, /Todavía no hay trabajos entregados en este dispositivo/);
    for (const id of ["miTrabajoCitas", "miTrabajoOrdenes", "miTrabajoHistorial", "miTrabajoSub"]) assert.ok(!/asignad/i.test(e.doc.getElementById(id).innerHTML + e.doc.getElementById(id).textContent), `${id} no debe hablar de trabajo asignado`);
  });
});

describe("Login por formulario con Supabase (Auth real + app.js real)", () => {
  const ok = async (cuenta, producto = "admin") => { const e = nuevoEntorno({ producto }); await e.asentar(); const r = await enviarLogin(e, cuenta.correo, cuenta.clave); return { e, r }; };
  test("TALLER + admin activo: entra; sesion de app con rol/perfilId/origen/activo; la clave se borra del DOM y no se filtra", async () => {
    const c = CUENTAS.adminActivo, { e, r } = await ok(c);
    assert.equal(r.error, ""); assert.equal(r.claveEnDom, ""); assert.equal(e.startApp.length, 1);
    const s = e.startApp[0][0]; assert.deepEqual([s.rol, s.origen, s.perfilId, s.activo, s.user], ["admin", "supabase", c.uid, true, c.correo]);
    assert.deepEqual(JSON.parse(e.almacen.getItem("enti_session")), JSON.parse(JSON.stringify(s)));
    sinFugas(e, [c.clave]); sinLlamadasAjenas(e);
  });
  test("el correo se normaliza a minusculas antes de enviarlo", async () => {
    const c = CUENTAS.adminActivo, e = nuevoEntorno(); await e.asentar();
    await enviarLogin(e, c.correo.toUpperCase(), c.clave); assert.equal(e.servidor.llamadas[0].cuerpo.email, c.correo);
  });
  const MENSAJES = [
    ["clave incorrecta", () => [CUENTAS.adminActivo.correo, "mala"], undefined, "Correo o contraseña incorrectos."],
    ["cuenta dada de baja", () => [CUENTAS.adminInactivo.correo, CUENTAS.adminInactivo.clave], undefined, "Esta cuenta está dada de baja. Habla con el administrador."],
    ["cuenta sin perfil", () => [CUENTAS.sinPerfil.correo, CUENTAS.sinPerfil.clave], undefined, "La cuenta existe pero no tiene perfil asignado."],
    ["sin conexion", () => [CUENTAS.adminActivo.correo, CUENTAS.adminActivo.clave], (s) => { s.red = "caida"; }, "Sin conexión con el servidor. Entra con tu usuario local."],
    ["error 500 al leer el perfil", () => [CUENTAS.adminActivo.correo, CUENTAS.adminActivo.clave], (s) => { s.perfilesHttp = 500; }, "No se pudo entrar. Inténtalo de nuevo."],
    ["perfil malformado", () => [CUENTAS.adminActivo.correo, CUENTAS.adminActivo.clave], (s) => { s.perfilesCuerpo = { oops: 1 }; }, "La cuenta existe pero no tiene perfil asignado."],
  ];
  for (const [nombre, cred, ajustar, mensaje] of MENSAJES) test(`${nombre}: «${mensaje}» y NO se abre ninguna sesion`, async () => {
    const servidor = crearServidor(); if (ajustar) ajustar(servidor);
    const e = nuevoEntorno({ servidor }); await e.asentar(); const [u, p] = cred();
    const r = await enviarLogin(e, u, p);
    assert.equal(r.error, mensaje); assert.equal(e.startApp.length, 0); assert.equal(e.almacen.getItem("enti_session"), null); assert.deepEqual(e.idbAbiertas, []);
    if (!/conexión/.test(mensaje)) sinLlamadasAjenas(e);
  });
  test("TALLER + desarrollador: Auth lo autentica, pero la app NO abre el taller (mensaje tecnico + signOut)", async () => {
    const { e } = await ok(CUENTAS.desarrollador);
    assert.match(e.doc.getElementById("loginError").innerHTML, /Cuenta técnica/); assert.equal(e.startApp.length, 0); assert.equal(e.servidor.cierres, 1); assert.equal(e.almacen.getItem("enti_session"), null);
  });
  test("TALLER + mecanico con cuenta: se rechaza, se hace signOut y no se abre ninguna base", async () => {
    const { e, r } = await ok(CUENTAS.mecanicoActivo);
    assert.equal(r.error, "Esta cuenta debe ingresar desde ENTIMOTORS Mi Trabajo."); assert.equal(e.startApp.length, 0); assert.equal(e.servidor.cierres, 1); assert.deepEqual(e.idbAbiertas, []); assert.equal(e.almacen.getItem("enti_session"), null);
  });
  test("MI TRABAJO + mecanico activo: entra con su perfilId", async () => {
    const c = CUENTAS.mecanicoActivo, { e, r } = await ok(c, "mecanico");
    assert.equal(r.error, ""); assert.equal(e.startApp.length, 1); assert.deepEqual([e.startApp[0][0].rol, e.startApp[0][0].perfilId], ["mecanico", c.uid]);
  });
  test("MI TRABAJO + mecanico dado de baja: nunca llega a entrar (Auth lo corta) y se cierra la sesion", async () => {
    const { e, r } = await ok(CUENTAS.mecanicoInactivo, "mecanico");
    assert.equal(r.error, "Esta cuenta está dada de baja. Habla con el administrador."); assert.equal(e.startApp.length, 0); assert.equal(e.servidor.cierres, 1);
  });
  test("MI TRABAJO + admin/cajero: se rechazan, se cierra la sesion, no se guarda nada", async () => {
    for (const c of [CUENTAS.adminActivo, CUENTAS.cajeroActivo]) { const { e } = await ok(c, "mecanico"); assert.equal(e.doc.getElementById("loginError").textContent, "Esta cuenta se usa desde ENTIMOTORS Taller, no desde Mi Trabajo."); assert.equal(e.startApp.length, 0); assert.equal(e.servidor.cierres, 1); assert.equal(e.almacen.getItem("enti_session"), null); }
  });
  test("CERRADO (4E-C4-FIX): TALLER + cuenta con rol desconocido («superadmin»): se rechaza, se hace signOut y no se abre ninguna base", async () => {
    const { e, r } = await ok(CUENTAS.rolDesconocido);
    assert.equal(r.error, "Tu rol no tiene acceso a ENTIMOTORS Taller."); assert.equal(e.startApp.length, 0); assert.equal(e.servidor.cierres, 1); assert.deepEqual(e.idbAbiertas, []); assert.equal(e.almacen.getItem("enti_session"), null);
  });
  test("perfil vacio [{}]: la sesion no tiene rol y el portero la rechaza («No se pudo leer tu sesion»)", async () => {
    const servidor = crearServidor(); servidor.perfilesCuerpo = [{}];
    const e = nuevoEntorno({ servidor }); await e.asentar(); const c = CUENTAS.adminActivo; await enviarLogin(e, c.correo, c.clave);
    assert.equal(e.startApp.length, 0); assert.equal(e.doc.getElementById("loginError").textContent, "No se pudo leer tu sesión. Vuelve a entrar.");
  });
});

describe("Arranque con sesion guardada (arrancarConSesion) — que pasa con cada estado del servidor", () => {
  const arrancar = async (o) => { const e = nuevoEntorno(o); await e.asentar(); return e; };
  const cuenta = CUENTAS.adminActivo;
  const guardada = (extra = {}) => sesionAppDe(cuenta, extra);
  test("token valido + perfil activo: arranca con el rol del SERVIDOR (el perfil manda sobre lo guardado)", async () => {
    const e = await arrancar({ cuenta, sesionGuardada: guardada({ rol: "cajero" }) });
    assert.equal(e.startApp.length, 1); assert.equal(e.startApp[0][0].rol, "admin"); assert.equal(JSON.parse(e.almacen.getItem("enti_session")).rol, "admin");
  });
  test("perfil dado de baja: NO arranca; login visible con «dada de baja»; se borra la sesion; signOut", async () => {
    const c = CUENTAS.adminInactivo, e = await arrancar({ cuenta: c, sesionGuardada: sesionAppDe(c, { activo: true }), perfilCacheado: { uid: c.uid, nombre: "x", rol: "admin", activo: true } });
    assert.equal(e.startApp.length, 0); assert.equal(activo(e, "gateLogin"), true); assert.equal(e.doc.getElementById("loginError").textContent, "Esta cuenta está dada de baja.");
    assert.equal(e.almacen.getItem("enti_session"), null); assert.equal(e.servidor.cierres, 1); assert.deepEqual(e.idbAbiertas, []);
  });
  for (const [nombre, ajuste, cuentaX] of [["sin perfil", () => {}, CUENTAS.sinPerfil], ["403 del servidor", (s) => { s.perfilesHttp = 403; }, cuenta], ["401 del servidor", (s) => { s.perfilesHttp = 401; }, cuenta]])
    test(`${nombre}: NO arranca; login visible con «ya no tiene perfil valido»; se borra la sesion`, async () => {
      const servidor = crearServidor(); ajuste(servidor);
      const e = await arrancar({ servidor, cuenta: cuentaX, sesionGuardada: { user: cuentaX.correo, uid: cuentaX.uid, perfilId: cuentaX.uid, nombre: "Nombre Guardado", rol: "admin", origen: "supabase", activo: true } });
      assert.equal(e.startApp.length, 0); assert.equal(e.doc.getElementById("loginError").textContent, "Esta cuenta ya no tiene perfil válido."); assert.equal(e.almacen.getItem("enti_session"), null);
    });
  test("desarrollador con sesion guardada: no abre el taller; mensaje tecnico; signOut; se borra la sesion", async () => {
    const c = CUENTAS.desarrollador, e = await arrancar({ cuenta: c, sesionGuardada: sesionAppDe(c) });
    assert.equal(e.startApp.length, 0); assert.match(e.doc.getElementById("loginError").innerHTML, /Cuenta técnica/); assert.equal(e.almacen.getItem("enti_session"), null); assert.equal(e.servidor.cierres, 1);
  });
  test("MI TRABAJO: un mecanico activo con sesion guardada arranca; uno dado de baja NO", async () => {
    const a = CUENTAS.mecanicoActivo, ea = await arrancar({ producto: "mecanico", cuenta: a, sesionGuardada: sesionAppDe(a) });
    assert.equal(ea.startApp.length, 1);
    const b = CUENTAS.mecanicoInactivo, eb = await arrancar({ producto: "mecanico", cuenta: b, sesionGuardada: sesionAppDe(b, { activo: true }) });
    assert.equal(eb.startApp.length, 0); assert.equal(eb.doc.getElementById("loginError").textContent, "Esta cuenta está dada de baja."); assert.equal(eb.servidor.cierres, 1);
  });
  test("una sesion guardada corrupta se ignora: muestra el login y no arranca", async () => {
    const e = await arrancar({ storageExtra: { enti_session: "{no es json" } });
    assert.equal(e.startApp.length, 0); assert.equal(activo(e, "gateLogin"), true);
  });
  test("una sesion LOCAL (TEAM) guardada arranca sin tocar Supabase (modo local historico)", async () => {
    const e = await arrancar({ sesionGuardada: { user: "prueba", nombre: "Usuario de Prueba", rol: "admin", origen: "local" } });
    assert.equal(e.startApp.length, 1); assert.equal(e.servidor.llamadas.length, 0);
  });
  // ── caracterizacion de la politica offline-first: se documenta lo que HACE el codigo, marcado como DISENO/GAP ──
  test("DISENO: error 5xx del servidor → se arranca con la sesion GUARDADA («el taller no se queda fuera»)", async () => {
    const servidor = crearServidor(); servidor.perfilesHttp = 500;
    const e = await arrancar({ servidor, cuenta, sesionGuardada: guardada(), perfilCacheado: perfilDe(cuenta) });
    assert.equal(e.startApp.length, 1); assert.equal(e.startApp[0][0].rol, "admin");
  });
  test("DISENO: sin red y con copia local del perfil → arranca con esa copia", async () => {
    const servidor = crearServidor(); servidor.red = "caida";
    const e = await arrancar({ servidor, cuenta, sesionGuardada: guardada(), perfilCacheado: perfilDe(cuenta) });
    assert.equal(e.startApp.length, 1);
  });
  test("GAP: una sesion guardada de origen supabase SIN token de Supabase («sin-sesion») arranca igual, con el rol GUARDADO (la baja no la alcanza sin conexion con el servidor)", async () => {
    const e = await arrancar({ sesionGuardada: guardada() });
    assert.equal(e.startApp.length, 1); assert.equal(e.startApp[0][0].rol, "admin"); assert.equal(e.servidor.llamadas.length, 0);
  });
  test("GAP: con el token de acceso CADUCADO tampoco se intenta refrescar ni confirmar: arranca con la sesion guardada", async () => {
    const e = await arrancar({ cuenta, expiraEnS: -100, sesionGuardada: guardada() });
    assert.equal(e.startApp.length, 1); assert.equal(e.servidor.llamadas.length, 0);
  });
  test("GAP: en TALLER una sesion guardada con activo:false tambien arranca si no hay servidor que la contradiga", async () => {
    const e = await arrancar({ sesionGuardada: guardada({ activo: false }) });
    assert.equal(e.startApp.length, 1);
  });
});

describe("La sesion de Supabase cae mientras se trabaja", () => {
  test("SIGNED_OUT con el shell abierto y sesion supabase guardada: se borra la sesion, aviso y recarga a los 2,5 s", async () => {
    const c = CUENTAS.adminActivo, e = nuevoEntorno({ cuenta: c, sesionGuardada: sesionAppDe(c) }); await e.asentar();
    e.doc.getElementById("shell").classList.add("active");
    await e.win.Auth.cerrarSesion(); await e.asentar();
    assert.equal(e.almacen.getItem("enti_session"), null); assert.deepEqual(toasts(e).at(-1), "Tu sesión ha caducado. Vuelve a entrar.");
    assert.equal(e.navegaciones.some((n) => n.tipo === "reload"), false); await e.avanzar(2600); assert.equal(e.navegaciones.some((n) => n.tipo === "reload"), true);
  });
  test("SIGNED_OUT sin shell abierto (p. ej. en el login) no recarga ni avisa", async () => {
    const e = nuevoEntorno({}); await e.asentar(); await e.win.Auth.cerrarSesion(); await e.avanzar(3000);
    assert.equal(e.navegaciones.some((n) => n.tipo === "reload"), false); assert.ok(!toasts(e).includes("Tu sesión ha caducado. Vuelve a entrar."));
  });
  test("SIGNED_OUT con una sesion LOCAL abierta no la toca", async () => {
    const e = nuevoEntorno({ sesionGuardada: { user: "prueba", rol: "admin", origen: "local" } }); await e.asentar();
    e.doc.getElementById("shell").classList.add("active"); await e.win.Auth.cerrarSesion(); await e.avanzar(3000);
    assert.notEqual(e.almacen.getItem("enti_session"), null); assert.equal(e.navegaciones.some((n) => n.tipo === "reload"), false);
  });
  test("«Cerrar sesion»: con sesion de Supabase hace signOut, borra enti_session y recarga; NO borra la base local", async () => {
    const c = CUENTAS.adminActivo, e = nuevoEntorno({ cuenta: c, sesionGuardada: sesionAppDe(c), perfilCacheado: perfilDe(c) }); await e.asentar();
    e.almacen.setItem("enti_modo_datos", "demo");
    await e.doc.getElementById("btnLogout").disparar("click"); await e.asentar();
    assert.equal(e.servidor.cierres, 1); assert.equal(e.almacen.getItem("enti_session"), null); assert.equal(e.navegaciones.some((n) => n.tipo === "reload"), true);
    assert.equal(e.almacen.getItem("enti_modo_datos"), "demo", "no debe tocar preferencias ni datos locales"); assert.deepEqual(e.idbAbiertas, []);
  });
});
