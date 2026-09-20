// PRUEBAS DE MUTACION del runtime multiusuario. Demuestran que los tests de 03/04 NO son vacios:
// se altera EN MEMORIA una linea de seguridad (nunca en disco) y la propiedad correspondiente debe
// ROMPERSE. Si un mutante sobreviviera, esa propiedad no estaria protegida por ninguna prueba.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { nuevoEntorno, enviarLogin, sesionAppDe, toasts, como, dbFalsa, CUENTAS } from "./helpers/flujos.mjs";
import { UUID } from "./helpers/supabase-mock.mjs";
import { idbFalsa } from "./helpers/idb-falsa.mjs";

const MEC_SB = { rol: "mecanico", origen: "supabase", perfilId: UUID(3), nombre: "Mecanico Activo", activo: true };
const ADMIN_SB = { rol: "admin", origen: "supabase", perfilId: UUID(1), nombre: "Admin Activo", activo: true };
const MEC_LOCAL = { rol: "mecanico", origen: "local", nombre: "Mecánico 1" };
const cambiar = (de, a) => (t) => t.replace(de, a);

// Cada propiedad devuelve true si la garantia de seguridad SE CUMPLE.
const PROPIEDADES = {
  "el portero del taller rechaza al mecanico con cuenta": (m) => nuevoEntorno({ producto: "admin", mutar: m }).win.sesionAdmitida(MEC_SB).ok === false,
  "el portero de Mi Trabajo rechaza a un admin": (m) => nuevoEntorno({ producto: "mecanico", mutar: m }).win.sesionAdmitida(ADMIN_SB).ok === false,
  "el portero de Mi Trabajo rechaza una cuenta de baja": (m) => nuevoEntorno({ producto: "mecanico", mutar: m }).win.sesionAdmitida({ ...MEC_SB, activo: false }).ok === false,
  "el portero de Mi Trabajo rechaza una sesion sin perfilId": (m) => nuevoEntorno({ producto: "mecanico", mutar: m }).win.sesionAdmitida({ ...MEC_SB, perfilId: undefined }).ok === false,
  "el portero de Mi Trabajo rechaza una sesion de origen local": (m) => nuevoEntorno({ producto: "mecanico", mutar: m }).win.sesionAdmitida({ ...MEC_SB, origen: "local" }).ok === false,
  "startApp repite el portero y no abre ninguna base para un mecanico en el taller": async (m) => {
    const e = nuevoEntorno({ producto: "admin", espiarStartApp: false, mutar: m }); await e.asentar();
    await e.win.startApp(MEC_SB).catch(() => {}); await e.asentar(); return e.idbAbiertas.length === 0;
  },
  "arranque: un perfil dado de baja no arranca la app con la sesion guardada": async (m) => {
    const c = CUENTAS.adminInactivo, e = nuevoEntorno({ cuenta: c, sesionGuardada: sesionAppDe(c, { activo: true }), perfilCacheado: { uid: c.uid, nombre: "x", rol: "admin", activo: true }, mutar: m }); await e.asentar();
    return e.startApp.length === 0;
  },
  "login: una cuenta dada de baja no entra": async (m) => {
    const c = CUENTAS.adminInactivo, e = nuevoEntorno({ mutar: m }); await e.asentar(); await enviarLogin(e, c.correo, c.clave); return e.startApp.length === 0;
  },
  "login: el desarrollador no abre el taller": async (m) => {
    const c = CUENTAS.desarrollador, e = nuevoEntorno({ mutar: m }); await e.asentar(); await enviarLogin(e, c.correo, c.clave); return e.startApp.length === 0;
  },
  "denegarSesion cierra la sesion de Supabase": async (m) => {
    const c = CUENTAS.mecanicoActivo, e = nuevoEntorno({ producto: "admin", cuenta: c, sesionGuardada: sesionAppDe(c), espiarStartApp: false, mutar: m }); await e.asentar(); return e.servidor.cierres === 1;
  },
  "updateOrder: el mecanico no toca la orden de otro": async (m) => {
    const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); const db = dbFalsa(e, { ordenes: [{ id: 7, estado: "recibido", mecanicoId: UUID(55) }] });
    await e.win.updateOrder(7, (o) => { o.estado = "diagnostico"; }); return db.guardados().length === 0;
  },
  "updateOrder: el mecanico no toca una orden ya entregada": async (m) => {
    const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); const db = dbFalsa(e, { ordenes: [{ id: 7, estado: "entregado", mecanicoId: MEC_SB.perfilId }] });
    await e.win.updateOrder(7, (o) => { o.km = 1; }); return db.guardados().length === 0;
  },
  "updateOrder: el mecanico no se salta etapas": async (m) => {
    const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); const db = dbFalsa(e, { ordenes: [{ id: 7, estado: "recibido", mecanicoId: MEC_SB.perfilId }] });
    await e.win.updateOrder(7, (o) => { o.estado = "reparacion"; }); return db.guardados().length === 0;
  },
  "updateOrder: el mecanico no entrega": async (m) => {
    const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); const db = dbFalsa(e, { ordenes: [{ id: 7, estado: "calidad", mecanicoId: MEC_SB.perfilId }] });
    await e.win.updateOrder(7, (o) => { o.estado = "entregado"; }); return db.guardados().length === 0;
  },
  "el mecanico con cuenta solo ve su pantalla (no ve Clientes)": (m) => { const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); return e.win.puedeVerVista("clientes") === false; },
  "el portero del taller solo admite roles conocidos (lista blanca)": (m) => { const w = nuevoEntorno({ producto: "admin", mutar: m }).win; return w.sesionAdmitida({ ...ADMIN_SB, rol: "superadmin" }).ok === false && w.sesionAdmitida({ ...ADMIN_SB, rol: {} }).ok === false && w.sesionAdmitida(ADMIN_SB).ok === true; },
  "el desarrollador no ve ninguna vista del taller": (m) => { const e = nuevoEntorno({ mutar: m }); como(e, { rol: "desarrollador", origen: "supabase", perfilId: UUID(7) }); return e.win.puedeVerVista("dashboard") === false; },
  "el cajero no ve Usuarios": (m) => { const e = nuevoEntorno({ mutar: m }); como(e, { rol: "cajero", origen: "supabase", perfilId: UUID(5) }); return e.win.puedeVerVista("usuarios") === false; },
  "exigeGestion bloquea al mecanico": (m) => { const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); return e.win.exigeGestion("x") === false; },
  "solo el admin asigna mecanico": (m) => { const e = nuevoEntorno({ mutar: m }); como(e, { rol: "cajero", origen: "supabase", perfilId: UUID(5) }); return e.win.puedeAsignarMecanico() === false; },
  "esTrabajoPropio compara por UUID": (m) => { const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); return e.win.esTrabajoPropio({ mecanicoId: UUID(99) }) === false; },
  "el mecanico con cuenta no abre la ficha del cliente": async (m) => {
    const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); dbFalsa(e, { clientes: [{ id: 1, nombre: "C" }], motos: [], ordenes: [], citas: [] });
    await e.win.openClienteDetalle(1).catch(() => {}); return toasts(e).includes("La ficha del cliente es del administrador");
  },
  "Mi Trabajo solo muestra ordenes propias": async (m) => {
    const e = nuevoEntorno({ producto: "mecanico", mutar: m }); como(e, MEC_SB);
    dbFalsa(e, { clientes: [{ id: 1, nombre: "C", telefono: "" }], motos: [{ id: 1, marca: "H", modelo: "X", placa: "A" }], citas: [], ordenes: [{ id: 11, estado: "reparacion", clienteId: 1, motoId: 1, falla: "AJENA-XYZ", mecanicoId: UUID(60) }] });
    await e.win.renderMiTrabajo(); return !e.doc.getElementById("miTrabajoOrdenes").innerHTML.includes("AJENA-XYZ");
  },
  "Mi Trabajo no tiene login local (aunque se inyecten las claves)": async (m) => {
    const e = nuevoEntorno({ producto: "mecanico", mutar: m, preparar: (env) => { env.win.ENTIMOTORS_LOCAL = { teamPasswords: { mecanico1: "clave-local-sintetica-1" } }; } }); await e.asentar();
    const leidas = []; e.espiar("claveLocal", (u) => { leidas.push(u); return "clave-local-sintetica-1"; });
    await enviarLogin(e, "mecanico1", "clave-local-sintetica-1"); return e.startApp.length === 0 && leidas.length === 0; // el portero es una 2.a barrera: la invariante es que NI SIQUIERA se consulta la clave local
  },
  "openOrder: el mecanico no abre la orden de otro": async (m) => {
    const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); e.doc.getElementById("inputKm").previousElementSibling = e.doc.createElement("label");
    dbFalsa(e, { ordenes: [{ id: 7, estado: "recibido", mecanicoId: UUID(60), motoId: 1, clienteId: 1 }], motos: [{ id: 1, marca: "H", modelo: "X" }], clientes: [{ id: 1, nombre: "C" }], citas: [] });
    await e.win.openOrder(7).catch(() => {}); await e.asentar(); return e.evaluar("currentOrderId") === null;
  },
  "la barra de acciones del mecanico no retrocede ni factura": (m) => {
    const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); e.win.updateActionBar({ id: 1, estado: "reparacion", mecanicoId: MEC_SB.perfilId });
    return e.doc.getElementById("btnRetroceder").style.display === "none" && e.doc.getElementById("btnImprimirFactura").style.display === "none";
  },
  "el mecanico no carga los importes del presupuesto": async (m) => {
    const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); let cargado = false; e.espiar("renderPresupuestoStage", async () => { cargado = true; });
    await e.win.renderStageContent({ id: 1, estado: "presupuesto", mecanicoId: MEC_SB.perfilId }).catch(() => {}); return cargado === false;
  },
  "la venta queda atribuida al uuid del usuario": async (m) => {
    const e = nuevoEntorno({ mutar: m }); como(e, MEC_SB); const idb = idbFalsa({ inventario: [] }); e.win.__idb = idb.db; e.evaluar("db = window.__idb");
    await e.win.registrarVentaRapida({ items: [{ inventarioId: null, nombre: "x", cantidad: 1, precio: 10 }], metodoPago: "tarjeta" }); return idb.filas("ventas_rapidas")[0].mecanicoId === MEC_SB.perfilId;
  },
  "la produccion separa tocayos por uuid": async (m) => {
    const e = nuevoEntorno({ mutar: m }); const t = Date.parse("2099-06-15T12:00:00Z"); const f = (id, u) => ({ id, finalizada: true, finalizadoEn: t, mecanico: "Ana", mecanicoId: u, items: [{ cantidad: 1, precio: 100 }] });
    dbFalsa(e, { ordenes: [f(1, UUID(3)), f(2, UUID(4))], ventas_rapidas: [], creditos: [] }); return (await e.win.calcularProduccion("2099-01-01", "2099-12-31")).porMecanico.length === 2;
  },
  "el arranque del mecanico muestra Mi Trabajo y no lee tablas de negocio": async (m) => {
    const e = nuevoEntorno({ producto: "mecanico", mutar: m }); como(e, MEC_SB); dbFalsa(e, { clientes: [], motos: [], citas: [], ordenes: [] }); const leidas = []; e.win.__leidas = leidas;
    e.evaluar("const g = DB.getAll; DB.getAll = async (s) => { window.__leidas.push(s); return g(s); };"); await e.win.continuarArranque("blanco").catch(() => {}); await e.asentar();
    return e.doc.getElementById("view-mi-trabajo").classList.contains("active") && leidas.every((x) => ["clientes", "motos", "citas", "ordenes"].includes(x));
  },
  "el mecanico local no edita una cita (guarda del boton)": async (m) => {
    const e = nuevoEntorno({ mutar: m }); como(e, MEC_LOCAL); dbFalsa(e, { citas: [{ id: 1, clienteId: 1, fecha: "2000-01-01", hora: "10:00", motivo: "x" }], clientes: [{ id: 1, nombre: "C", telefono: "" }], motos: [], ordenes: [] });
    const llamadas = []; e.espiar("abrirModalEditarCita", async (id) => { llamadas.push(id); }); await e.win.renderCitasList(); await e.asentar();
    await e.doc.querySelectorAll('[data-action="editar"]')[0].disparar("click", { stopPropagation() {} }); await e.asentar(); return llamadas.length === 0;
  },
};

const MUTANTES = [
  // [propiedad, archivo, descripcion, transformacion]
  ["el portero del taller rechaza al mecanico con cuenta", "app", 'quitar el rechazo de mecanico/supabase en el taller', cambiar('if (session.rol === "mecanico" && session.origen === "supabase")', "if (false)")],
  ["el portero de Mi Trabajo rechaza a un admin", "app", "aceptar cualquier rol en Mi Trabajo", cambiar('if (session.rol !== "mecanico")', "if (false)")],
  ["el portero de Mi Trabajo rechaza una cuenta de baja", "app", "no mirar activo en Mi Trabajo", cambiar("if (session.activo === false)", "if (false)")],
  ["el portero de Mi Trabajo rechaza una sesion sin perfilId", "app", "no exigir perfilId", cambiar('typeof session.perfilId !== "string" || !session.perfilId', "false")],
  ["el portero de Mi Trabajo rechaza una sesion de origen local", "app", "aceptar origen local en Mi Trabajo", cambiar('if (session.origen !== "supabase")', "if (false)")],
  ["startApp repite el portero y no abre ninguna base para un mecanico en el taller", "app", "quitar el portero de startApp", cambiar("if (!admitida.ok) { await denegarSesion(admitida.motivo); return; }", "")],
  ["arranque: un perfil dado de baja no arranca la app con la sesion guardada", "app", "no descartar la sesion ante cuenta-desactivada", cambiar('["cuenta-desactivada", "sin-perfil", "sin-permiso"].includes(r.motivo)', "false")],
  ["login: una cuenta dada de baja no entra", "auth", "ignorar activo=false en Auth.cargarPerfil", cambiar("if (fila.activo === false) return mal(", "if (false) return mal(")],
  // dos capas (entrarConSesion y el portero): el mutante quita LAS DOS; quitar solo una ya no rompe la propiedad, y eso es lo deseado
  ["login: el desarrollador no abre el taller", "app", "quitar el corte del desarrollador en entrarConSesion Y en el portero", (t) => cambiar('if (typeof session.rol !== "string" || !ROLES_DEL_TALLER.includes(session.rol))', "if (false)")(cambiar('if (session.rol === "desarrollador")\n    return', "if (false)\n    return")(cambiar('if (!ES_APP_MECANICOS && session.rol === "desarrollador") {', "if (false) {")(t)))],
  ["el portero del taller solo admite roles conocidos (lista blanca)", "app", "quitar la lista blanca de roles del portero", cambiar('if (typeof session.rol !== "string" || !ROLES_DEL_TALLER.includes(session.rol))', "if (false)")],
  ["denegarSesion cierra la sesion de Supabase", "app", "no cerrar la sesion al denegar", cambiar("try { await Auth.cerrarSesion(); } catch { /* la sesión local ya quedó fuera */ }", "")],
  ["updateOrder: el mecanico no toca la orden de otro", "app", "quitar la comprobacion de propiedad", cambiar("if (!esTrabajoPropio(actual)) {", "if (false) {")],
  ["updateOrder: el mecanico no toca una orden ya entregada", "app", "quitar el bloqueo de entregadas", cambiar('if (actual?.estado === "entregado") {', "if (false) {")],
  ["updateOrder: el mecanico no se salta etapas", "app", "quitar la regla del peldano", cambiar("if (!paso?.siguiente || tentativa.estado !== paso.siguiente) {", "if (false) {")],
  ["updateOrder: el mecanico no entrega", "app", "quitar la regla del peldano (entrega)", cambiar("if (!paso?.siguiente || tentativa.estado !== paso.siguiente) {", "if (false) {")],
  ["el mecanico con cuenta solo ve su pantalla (no ve Clientes)", "app", "no ocultar vistas al mecanico", cambiar("if (esMecanicoCuenta()) return VISTAS_FUERA_DEL_MECANICO;", "")],
  ["el desarrollador no ve ninguna vista del taller", "app", "quitar el bloqueo del desarrollador", cambiar("if (VISTAS_OCULTAS_POR_ROL[currentUser.rol] === null) return false;", "")],
  ["el cajero no ve Usuarios", "app", "vaciar las vistas del cajero", cambiar("return VISTAS_OCULTAS_POR_ROL[currentUser?.rol] ?? VISTAS_SOLO_ADMIN.concat(\"mi-trabajo\");", "return [];")],
  ["exigeGestion bloquea al mecanico", "app", "exigeGestion siempre deja pasar", cambiar("if (puedeGestionarTaller()) return true;", "return true;")],
  ["solo el admin asigna mecanico", "app", "cualquiera asigna", cambiar("function puedeAsignarMecanico() { return esAdmin(); }", "function puedeAsignarMecanico() { return true; }")],
  ["esTrabajoPropio compara por UUID", "app", "toda orden es propia", cambiar("registro.mecanicoId === mio;", "true;")],
  ["Mi Trabajo solo muestra ordenes propias", "app", "listar todas las ordenes abiertas, no solo las propias", cambiar("const abiertas = ordenes.filter(esTrabajoPropio).filter(", "const abiertas = ordenes.filter(")],
  ["Mi Trabajo no tiene login local (aunque se inyecten las claves)", "app", "no cortar el camino local en Mi Trabajo", cambiar("if (!PERMITE_LOGIN_LOCAL) {", "if (false) {")],
  ["openOrder: el mecanico no abre la orden de otro", "app", "quitar la comprobacion de propiedad al abrir", cambiar("if (esMecanicoCuenta() && !esTrabajoPropio(o)) {", "if (false) {")],
  ["la barra de acciones del mecanico no retrocede ni factura", "app", "tratar al mecanico como admin en la barra", cambiar("  if (esMecanicoCuenta()) {\n    btnFactura.style.display = \"none\";", "  if (false) {\n    btnFactura.style.display = \"none\";")],
  ["el mecanico no carga los importes del presupuesto", "app", "cargar el presupuesto tambien para el mecanico", cambiar("simplemente no se pide el bloque. */\n    if (esMecanicoCuenta()) {", "simplemente no se pide el bloque. */\n    if (false) {")],
  ["la venta queda atribuida al uuid del usuario", "app", "atribuir la venta solo por nombre", cambiar("fechaISO, creadoEn: Date.now(), ...asignacionDelUsuarioActual(),\n    };\n\n    const ventaReq", "fechaISO, creadoEn: Date.now(), mecanico: currentUser?.nombre || \"\",\n    };\n\n    const ventaReq")],
  ["la produccion separa tocayos por uuid", "app", "agrupar solo por nombre", cambiar("const { id, nombre, clave } = identidadMecanico(o);", 'const { id, nombre } = identidadMecanico(o); const clave = nombre || "(sin asignar)";')],
  ["el arranque del mecanico muestra Mi Trabajo y no lee tablas de negocio", "app", "no distinguir al mecanico en continuarArranque", cambiar('  if (esMecanicoCuenta()) {\n    showView("mi-trabajo");', '  if (false) {\n    showView("mi-trabajo");')],
  ["el mecanico local no edita una cita (guarda del boton)", "app", "quitar la guarda del boton editar", cambiar('if (!exigeGestion("Solo el administrador o el cajero editan una cita")) return;', "")],
  ["el mecanico con cuenta no abre la ficha del cliente", "app", "quitar el bloqueo de la ficha", cambiar('if (esMecanicoCuenta()) { bloquear("La ficha del cliente es del administrador"); return; }', "")],
];

describe("mutantes: la propiedad se cumple con el runtime real y se ROMPE con el runtime alterado", () => {
  for (const [prop, archivo, que, mut] of MUTANTES) {
    test(`${prop} — mutante: ${que}`, async () => {
      assert.ok(PROPIEDADES[prop], `propiedad desconocida: ${prop}`);
      assert.equal(await PROPIEDADES[prop]({}), true, "con el runtime REAL la propiedad debe cumplirse");
      assert.equal(await PROPIEDADES[prop]({ [archivo]: mut }), false, "el mutante SOBREVIVE: ninguna prueba protege esta garantia");
    });
  }
  test("cobertura de propiedades: cada propiedad declarada tiene al menos un mutante", () => {
    const con = new Set(MUTANTES.map((m) => m[0]));
    assert.deepEqual(Object.keys(PROPIEDADES).filter((p) => !con.has(p)), []);
  });
});
