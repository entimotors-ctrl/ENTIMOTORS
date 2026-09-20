// ROL DESCONOCIDO (4E-C4-FIX) — el portero (sesionAdmitida) FALLA CERRADO.
// Antes, el taller admitia cualquier rol que no estuviera en la lista de vistas restringidas («superadmin» entraba con el nivel operativo de
// un mecanico local). Ahora hay lista blanca segun el comportamiento YA soportado:
//   TALLER      admin · cajero · mecanico (solo con sesion LOCAL de la lista TEAM). Mecanico con cuenta → Mi Trabajo. Desarrollador → panel tecnico.
//   MI TRABAJO  unicamente mecanico con cuenta de Supabase, activo y con perfilId.
// Los roles validos NO cambian de privilegios (se comprueba con vistas y guardas de gestion).
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { nuevoEntorno, como, enviarLogin, sesionAppDe, CUENTAS } from "./helpers/flujos.mjs";
import { UUID } from "./helpers/supabase-mock.mjs";

const ADMIN_SB = { rol: "admin", origen: "supabase", perfilId: UUID(1), nombre: "Admin Activo", activo: true };
const ADMIN_LOCAL = { rol: "admin", origen: "local", nombre: "Usuario de Prueba" };
const CAJERO = { rol: "cajero", origen: "supabase", perfilId: UUID(5), nombre: "Cajero", activo: true };
const MEC_SB = { rol: "mecanico", origen: "supabase", perfilId: UUID(3), nombre: "Mecanico Activo", activo: true };
const MEC_LOCAL = { rol: "mecanico", origen: "local", nombre: "Mecánico 1" };
const DEV = { rol: "desarrollador", origen: "supabase", perfilId: UUID(7), nombre: "Dev", activo: true };
const MOTIVO_TALLER = "Tu rol no tiene acceso a ENTIMOTORS Taller.";
const MOTIVO_MT = "Esta cuenta se usa desde ENTIMOTORS Taller, no desde Mi Trabajo.";
const MOTIVO_SIN_SESION = "No se pudo leer tu sesión. Vuelve a entrar.";
const admitir = (producto, s) => nuevoEntorno({ producto }).win.sesionAdmitida(s);

// roles inventados y formas raras del campo `rol` (todas deben fallar cerradas)
const RAROS = [["«superadmin»", "superadmin"], ["«foo»", "foo"], ["otra capitalizacion «Admin»", "Admin"], ["«ADMIN»", "ADMIN"], ["con espacio «admin »", "admin "], ["«root»", "root"], ["«mecanico » ", "mecanico "],
  ["numero", 7], ["objeto {}", {}], ["objeto {rol:'admin'}", { rol: "admin" }], ["arreglo []", []], ["arreglo ['admin']", ["admin"]], ["booleano true", true], ["<img…> (XSS)", "<img src=x onerror=alert(1)>"]];
const SIN_ROL = [["cadena vacia", ""], ["null", null], ["undefined", undefined], ["0", 0], ["false", false]];

describe("TALLER · un rol desconocido FALLA CERRADO (cualquiera sea su forma y su origen)", () => {
  for (const [n, rol] of RAROS) for (const origen of ["supabase", "local", undefined]) test(`rol ${n}, origen ${origen ?? "ausente"} → deniega con «${MOTIVO_TALLER}»`, () => {
    const r = admitir("admin", { ...ADMIN_SB, origen, rol }); assert.deepEqual([r.ok, r.motivo], [false, MOTIVO_TALLER]);
  });
  for (const [n, rol] of SIN_ROL) test(`sin rol (${n}) → deniega («No se pudo leer tu sesión»)`, () => { const r = admitir("admin", { ...ADMIN_SB, rol }); assert.deepEqual([r.ok, r.motivo], [false, MOTIVO_SIN_SESION]); });
  test("la razon NO repite el rol recibido (no se refleja un valor controlado por quien manipula la sesion)", () => { const r = admitir("admin", { ...ADMIN_SB, rol: "<img src=x onerror=alert(1)>" }); assert.ok(!/img|onerror/.test(r.motivo)); });
});

describe("MI TRABAJO · un rol desconocido FALLA CERRADO (ya lo hacia: se comprueba y se protege)", () => {
  for (const [n, rol] of [...RAROS, ["«mecanico » (espacio)", "mecanico "], ["«Mecanico»", "Mecanico"]]) test(`rol ${n} → deniega`, () => { const r = admitir("mecanico", { ...MEC_SB, rol }); assert.equal(r.ok, false); assert.equal(r.motivo, MOTIVO_MT); });
  for (const [n, rol] of SIN_ROL) test(`sin rol (${n}) → deniega`, () => { const r = admitir("mecanico", { ...MEC_SB, rol }); assert.deepEqual([r.ok, r.motivo], [false, MOTIVO_SIN_SESION]); });
  test("el desarrollador tambien se deniega en Mi Trabajo", () => assert.equal(admitir("mecanico", DEV).ok, false));
});

describe("ROLES VALIDOS · sin regresion en ninguno de los dos productos", () => {
  test("TALLER admite: admin (cuenta y local), cajero, mecanico LOCAL", () => { for (const s of [ADMIN_SB, ADMIN_LOCAL, CAJERO, MEC_LOCAL]) assert.equal(admitir("admin", s).ok, true, s.rol + "/" + s.origen); });
  test("TALLER sigue negando al mecanico con cuenta («debe ingresar desde Mi Trabajo») y al desarrollador (cuenta tecnica)", () => {
    assert.deepEqual([admitir("admin", MEC_SB).ok, admitir("admin", MEC_SB).motivo], [false, "Esta cuenta debe ingresar desde ENTIMOTORS Mi Trabajo."]);
    assert.deepEqual([admitir("admin", DEV).ok, admitir("admin", DEV).motivo], [false, "Cuenta técnica: no abre el taller. Usa el panel técnico."]);
  });
  test("MI TRABAJO admite SOLO al mecanico con cuenta activa y con perfilId; niega a admin, cajero y desarrollador", () => {
    assert.equal(admitir("mecanico", MEC_SB).ok, true); for (const s of [ADMIN_SB, CAJERO, DEV, ADMIN_LOCAL, MEC_LOCAL]) assert.equal(admitir("mecanico", s).ok, false, s.rol + "/" + s.origen);
  });
  // Estas tablas son las de ANTES de 4E-C4-FIX (medidas con el runtime real): ninguna cambia.
  const VISTAS = ["dashboard", "citas", "ordenes", "clientes", "cotizaciones", "inventario", "pos", "creditos", "finanzas", "web-cms", "ajustes", "usuarios", "mi-trabajo"];
  const ESPERADO = {
    admin: { u: ADMIN_SB, vistas: VISTAS.filter((v) => v !== "mi-trabajo"), gestiona: true, asigna: true },
    cajero: { u: CAJERO, vistas: ["dashboard", "citas", "ordenes", "clientes", "cotizaciones", "inventario", "pos", "creditos", "finanzas"], gestiona: true, asigna: false },
    "mecanico LOCAL": { u: MEC_LOCAL, vistas: ["dashboard", "citas", "ordenes", "clientes", "cotizaciones", "inventario", "pos", "creditos"], gestiona: false, asigna: false },
    "mecanico con cuenta": { u: MEC_SB, vistas: ["mi-trabajo"], gestiona: false, asigna: false },
  };
  for (const [n, x] of Object.entries(ESPERADO)) test(`${n}: mismas vistas y mismas guardas de gestion que antes`, () => {
    const e = nuevoEntorno(); como(e, x.u);
    assert.deepEqual(VISTAS.filter((v) => e.evaluar(`puedeVerVista(${JSON.stringify(v)})`)), x.vistas); assert.equal(e.evaluar("puedeGestionarTaller()"), x.gestiona); assert.equal(e.evaluar("puedeAsignarMecanico()"), x.asigna);
  });
});

describe("FLUJOS REALES · el rol desconocido no abre nada por ninguna via", () => {
  test("login con Supabase (cuenta activa con rol «superadmin»): TALLER y MI TRABAJO la rechazan, hacen signOut, no guardan sesion y no abren ninguna base", async () => {
    for (const [producto, mensaje] of [["admin", MOTIVO_TALLER], ["mecanico", MOTIVO_MT]]) {
      const e = nuevoEntorno({ producto }); await e.asentar(); const c = CUENTAS.rolDesconocido; const r = await enviarLogin(e, c.correo, c.clave);
      assert.equal(r.error, mensaje, producto); assert.equal(e.startApp.length, 0, producto); assert.equal(e.servidor.cierres, 1, producto); assert.deepEqual(e.idbAbiertas, [], producto); assert.equal(e.almacen.getItem("enti_session"), null, producto);
    }
  });
  test("sesion GUARDADA en el dispositivo con un rol raro (arranque real con startApp real): se rechaza, se descarta enti_session, no se abre ninguna base y se ve el aviso", async () => {
    for (const producto of ["admin", "mecanico"]) for (const rol of ["superadmin", "foo", {}, [], 7]) {
      const s = { ...sesionAppDe(CUENTAS.adminActivo), rol, ...(producto === "admin" ? { origen: "local" } : {}) };
      const e = nuevoEntorno({ producto, sesionGuardada: s, espiarStartApp: false }); await e.asentar();
      assert.deepEqual(e.idbAbiertas, [], `${producto}/${JSON.stringify(rol)}`); assert.equal(e.almacen.getItem("enti_session"), null, `${producto}/${JSON.stringify(rol)}`);
      assert.ok(e.doc.getElementById("loginError").textContent.length > 0, "debe explicarse el rechazo"); assert.equal(e.doc.getElementById("shell").classList.contains("active"), false);
    }
  });
  test("startApp directo (defensa en profundidad) con un rol raro: no abre ninguna base", async () => {
    for (const producto of ["admin", "mecanico"]) { const e = nuevoEntorno({ producto, espiarStartApp: false }); await e.asentar(); await e.win.startApp({ ...ADMIN_SB, rol: "superadmin" }).catch(() => {}); await e.asentar(); assert.deepEqual(e.idbAbiertas, [], producto); }
  });
  test("el arranque con una sesion VALIDA del taller (admin local, cajero, mecanico local) sigue llegando a startApp y el portero la admite (la apertura de la base real la cubre el QA de navegador)", async () => {
    for (const s of [ADMIN_LOCAL, MEC_LOCAL, { ...CAJERO, origen: "local" }]) { const e = nuevoEntorno({ producto: "admin", sesionGuardada: s }); await e.asentar(); assert.equal(e.startApp.length, 1, s.rol); assert.equal(e.win.sesionAdmitida(s).ok, true, s.rol); }
  });
});

describe("mutantes (en memoria): si se afloja la lista blanca, la prueba VUELVE A FALLAR", () => {
  const cambiar = (de, a) => (t) => { const r = t.split(de).join(a); if (r === t) throw new Error(`mutante sin efecto: ${de}`); return r; };
  const propiedad = (mutar) => {
    const w = nuevoEntorno({ producto: "admin", ...(mutar ? { mutar: { app: mutar } } : {}) }).win;
    for (const [, rol] of RAROS) if (w.sesionAdmitida({ ...ADMIN_SB, rol }).ok !== false) return false;
    for (const s of [ADMIN_SB, ADMIN_LOCAL, CAJERO, MEC_LOCAL]) if (w.sesionAdmitida(s).ok !== true) return false;
    return w.sesionAdmitida(DEV).ok === false && w.sesionAdmitida(MEC_SB).ok === false;
  };
  test("linea base: con el codigo REAL se cumple", () => assert.equal(propiedad(), true));
  test("mutante: se quita la lista blanca (vuelve el fail-open)", () => assert.equal(propiedad(cambiar('if (typeof session.rol !== "string" || !ROLES_DEL_TALLER.includes(session.rol))', "if (false)")), false));
  test("mutante: la lista incluye un rol de mas («foo»)", () => assert.equal(propiedad(cambiar('["admin", "cajero", "mecanico"]', '["admin", "cajero", "mecanico", "foo"]')), false));
  test("mutante: la lista pierde «cajero» (regresion de un rol valido)", () => assert.equal(propiedad(cambiar('["admin", "cajero", "mecanico"]', '["admin", "mecanico"]')), false));
  test("mutante: la lista incluye «desarrollador» y se quita su regla explicita (el desarrollador entraria al taller)", () => assert.equal(propiedad((t) => cambiar('["admin", "cajero", "mecanico"]', '["admin", "cajero", "mecanico", "desarrollador"]')(cambiar('if (session.rol === "desarrollador")\n    return', "if (false)\n    return")(t))), false));
});
