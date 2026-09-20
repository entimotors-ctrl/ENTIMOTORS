// app.js REAL — funciones NUEVAS o CAMBIADAS respecto a 4ef632a que NO son el portero/login/arranque de 04:
// login local (TEAM), identidad de mecanico, produccion por mecanico, UI del mecanico con cuenta (barra de acciones,
// etapas, presupuesto, detalle), ventas y creditos atribuidos por uuid, y el arranque del mecanico (no toca tablas
// que no necesita). Ver README, «Funciones cambiadas por los commits multiusuario».
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { marcadoPeligroso } from "./helpers/dom.mjs";
import { idbFalsa } from "./helpers/idb-falsa.mjs";
import { leer } from "./helpers/entorno.mjs";
import { nuevoEntorno, enviarLogin, toasts, como, dbFalsa, activo } from "./helpers/flujos.mjs";
import { UUID } from "./helpers/supabase-mock.mjs";

const MEC_SB = { rol: "mecanico", origen: "supabase", perfilId: UUID(3), nombre: "Mecanico Activo", activo: true };
const ADMIN_SB = { rol: "admin", origen: "supabase", perfilId: UUID(1), nombre: "Admin Activo", activo: true };
const CAJERO = { rol: "cajero", origen: "supabase", perfilId: UUID(5), nombre: "Cajero", activo: true };
const MEC_LOCAL = { rol: "mecanico", origen: "local", nombre: "Mecánico 1" };
const CLAVE_LOCAL = "clave-local-sintetica-1";
const json = (x) => JSON.parse(JSON.stringify(x));

describe("funciones pequenas nuevas", () => {
  const e = nuevoEntorno();
  test("etiquetaEtapa: nombre legible; clave desconocida se devuelve tal cual; vacio → «—»", () => {
    assert.equal(e.win.etiquetaEtapa("recibido"), e.evaluar("STAGES.find(s => s.key === 'recibido').label")); assert.equal(e.win.etiquetaEtapa("no-existe"), "no-existe");
    for (const v of [undefined, null, ""]) assert.equal(e.win.etiquetaEtapa(v), "—");
  });
  test("pareceCorreo: exige algo@algo.algo", () => {
    for (const v of ["a@b.co", "persona@example.test", "x.y@z.w.v"]) assert.equal(e.win.pareceCorreo(v), true, v);
    for (const v of ["prueba", "a@b", "@b.co", "a@.co", "", "sin arroba.com"]) assert.equal(e.win.pareceCorreo(v), false, v);
  });
  test("identidadMecanico: por uuid si lo hay, si no por nombre; «—» y vacio son «(sin asignar)»", () => {
    const f = (r) => json(e.win.identidadMecanico(r));
    assert.deepEqual(f({ mecanicoId: UUID(3), mecanico: "Ana" }), { id: UUID(3), nombre: "Ana", clave: UUID(3) });
    assert.deepEqual(f({ mecanico: "Ana" }), { id: null, nombre: "Ana", clave: "Ana" });
    for (const r of [{ mecanico: "—" }, { mecanico: "" }, {}, null, undefined]) assert.deepEqual(f(r), { id: null, nombre: "", clave: "(sin asignar)" }, JSON.stringify(r));
    assert.deepEqual(f({ mecanicoId: UUID(3), mecanico: "—" }), { id: UUID(3), nombre: "", clave: UUID(3) });
  });
  test("sesionDesdePerfil: perfilId estable, origen supabase, activo salvo activo===false; sin telefono", () => {
    const s = (p, c = "x@example.test") => json(e.win.sesionDesdePerfil(p, c));
    assert.deepEqual(s({ uid: UUID(3), nombre: "Ana", rol: "mecanico", activo: true }), { user: "x@example.test", uid: UUID(3), perfilId: UUID(3), nombre: "Ana", telefono: "", rol: "mecanico", origen: "supabase", activo: true });
    assert.equal(s({ uid: UUID(3), nombre: "A", rol: "admin", activo: false }).activo, false);
    assert.equal(s({ id: UUID(4), nombre: "A", rol: "admin" }).perfilId, UUID(4), "cae a perfil.id si no hay uid");
    assert.equal(s({ nombre: "A", rol: "admin" }).perfilId, null);
  });
  test("GAP (caracterizacion): un perfil SIN el campo activo se trata como activo (solo activo===false es baja); lo cubre Auth y el RLS", () => {
    assert.equal(json(e.win.sesionDesdePerfil({ uid: UUID(3), nombre: "A", rol: "admin" }, "x@example.test")).activo, true);
  });
  test("tieneIdentidadMecanico / vistaInicial / esAdmin / esCajero", () => {
    const con = (u) => { const x = nuevoEntorno(); como(x, u); return x.win; };
    assert.equal(con(MEC_SB).tieneIdentidadMecanico(), true); assert.equal(con({ ...MEC_SB, perfilId: null }).tieneIdentidadMecanico(), false); assert.equal(con(ADMIN_SB).tieneIdentidadMecanico(), false);
    assert.equal(con(MEC_SB).vistaInicial(), "mi-trabajo"); assert.equal(con(ADMIN_SB).vistaInicial(), "dashboard"); assert.equal(con(MEC_LOCAL).vistaInicial(), "dashboard");
    assert.equal(con(ADMIN_SB).esAdmin(), true); assert.equal(con(CAJERO).esAdmin(), false); assert.equal(con(CAJERO).esCajero(), true); assert.equal(con(null).esAdmin(), false);
  });
  test("nombreBaseParaSesion: cada identidad su base; en Mi Trabajo NUNCA la del taller", () => {
    const t = nuevoEntorno({ producto: "admin" }).win, m = nuevoEntorno({ producto: "mecanico" }).win;
    assert.equal(t.nombreBaseParaSesion(ADMIN_SB), "entimotors_os_demo"); assert.equal(t.nombreBaseParaSesion(MEC_LOCAL), "entimotors_os_demo"); assert.equal(t.nombreBaseParaSesion(MEC_SB), `entimotors_os_demo_mec_${UUID(3)}`);
    assert.equal(m.nombreBaseParaSesion(MEC_SB), `entimotors_os_demo_mec_${UUID(3)}`);
    for (const s of [ADMIN_SB, CAJERO, MEC_LOCAL, { ...MEC_SB, perfilId: null }, { ...MEC_SB, origen: "local" }, null]) assert.equal(m.nombreBaseParaSesion(s), null, JSON.stringify(s));
  });
  test("dos mecanicos distintos abren bases distintas", () => {
    const t = nuevoEntorno().win; assert.notEqual(t.nombreBaseParaSesion(MEC_SB), t.nombreBaseParaSesion({ ...MEC_SB, perfilId: UUID(4) }));
  });
  test("pintarModoLogin: sin Supabase configurado no muestra nada; con Supabase distingue conectado / sin señal", async () => {
    const con = nuevoEntorno({}); await con.asentar(); assert.match(con.doc.getElementById("loginModo").textContent, /Conectado al servidor/);
    con.setOnline(false); con.win.pintarModoLogin(); assert.match(con.doc.getElementById("loginModo").textContent, /Sin señal — solo acceso local/);
    const sin = nuevoEntorno({ scripts: ["build-target", "app"] }); sin.win.ENTIMOTORS_SUPABASE = undefined; sin.win.pintarModoLogin(); assert.equal(sin.doc.getElementById("loginModo").textContent, "");
  });
});

describe("login LOCAL (lista TEAM) — solo existe en el taller", () => {
  const conLocal = (o = {}) => nuevoEntorno({ preparar: (env) => { env.win.ENTIMOTORS_LOCAL = { teamPasswords: { prueba: CLAVE_LOCAL, mecanico1: CLAVE_LOCAL } }; }, ...o });
  test("TALLER: usuario del equipo + clave local válida → entra con origen «local», sin llamar a Supabase", async () => {
    const e = conLocal(); await e.asentar(); const r = await enviarLogin(e, "prueba", CLAVE_LOCAL);
    assert.equal(r.error, ""); assert.equal(e.startApp.length, 1); const s = e.startApp[0][0]; assert.deepEqual([s.user, s.rol, s.origen], ["prueba", "admin", "local"]); assert.equal(e.servidor.llamadas.length, 0);
    assert.equal(JSON.parse(e.almacen.getItem("enti_session")).origen, "local"); assert.equal(r.claveEnDom, "");
  });
  test("TALLER: el usuario se normaliza a minusculas y se recorta", async () => {
    const e = conLocal(); await e.asentar(); await enviarLogin(e, "  MECANICO1 ", CLAVE_LOCAL); assert.equal(e.startApp.length, 1); assert.equal(e.startApp[0][0].rol, "mecanico");
  });
  test("TALLER: clave mala, usuario desconocido y clave vacia → «Usuario o contraseña incorrectos.» y no se abre nada", async () => {
    for (const [u, p] of [["prueba", "mala"], ["desconocido", CLAVE_LOCAL], ["prueba", ""], ["", ""]]) {
      const e = conLocal(); await e.asentar(); const r = await enviarLogin(e, u, p); assert.equal(r.error, "Usuario o contraseña incorrectos.", `${u}/${p}`); assert.equal(e.startApp.length, 0); assert.equal(e.almacen.getItem("enti_session"), null);
    }
  });
  test("TALLER sin config-local.js (sin claves locales): el login local queda DESHABILITADO aunque el usuario exista y la clave sea vacia o «undefined»", async () => {
    for (const p of ["", "undefined", "null"]) { const e = nuevoEntorno(); await e.asentar(); const r = await enviarLogin(e, "prueba", p); assert.equal(r.error, "Usuario o contraseña incorrectos.", p); assert.equal(e.startApp.length, 0); }
  });
  test("TALLER, correo SIN conexion y Supabase disponible: intenta el camino de Supabase, que falla sin salir a la red, y sugiere el usuario local", async () => {
    const e = nuevoEntorno({ online: false }); await e.asentar(); const r = await enviarLogin(e, "persona@example.test", "x"); assert.equal(r.error, "Sin conexión con el servidor. Entra con tu usuario local."); assert.equal(e.servidor.llamadas.length, 0); assert.equal(e.startApp.length, 0);
  });
  test("TALLER, correo, SIN conexion y Supabase NO disponible: cae al camino local con el mensaje «para entrar con correo hace falta señal»", async () => {
    const e = nuevoEntorno({ online: false }); await e.asentar(); e.win.Auth.disponible = () => false; const r = await enviarLogin(e, "persona@example.test", "x");
    assert.equal(r.error, "Sin conexión: para entrar con correo hace falta señal."); assert.equal(e.servidor.llamadas.length, 0); assert.equal(e.startApp.length, 0);
  });
  test("TALLER, correo CON conexion y Supabase NO disponible: cae al camino local y dice «Usuario o contraseña incorrectos.»", async () => {
    const e = nuevoEntorno({}); await e.asentar(); e.win.Auth.disponible = () => false; const r = await enviarLogin(e, "persona@example.test", "x"); assert.equal(r.error, "Usuario o contraseña incorrectos."); assert.equal(e.servidor.llamadas.length, 0);
  });
  test("TALLER: un usuario del equipo con sesion local es admitido incluso siendo «mecanico» (modo local historico)", async () => {
    const e = conLocal(); await e.asentar(); await enviarLogin(e, "mecanico1", CLAVE_LOCAL); assert.equal(e.startApp.length, 1);
  });
  test("MI TRABAJO: el camino local NO EXISTE — aunque alguien inyecte window.ENTIMOTORS_LOCAL con las claves correctas, no entra, no se lee la clave y no se guarda nada", async () => {
    const e = conLocal({ producto: "mecanico" }); await e.asentar(); const leidas = []; e.espiar("claveLocal", (u) => { leidas.push(u); return CLAVE_LOCAL; });
    const r = await enviarLogin(e, "mecanico1", CLAVE_LOCAL);
    assert.equal(r.error, "Aquí se entra solo con tu correo y contraseña de ENTIMOTORS."); assert.equal(e.startApp.length, 0); assert.deepEqual(leidas, [], "ni siquiera debe consultar la lista TEAM"); assert.equal(e.almacen.getItem("enti_session"), null); assert.deepEqual(e.idbAbiertas, []);
  });
  test("MI TRABAJO: ni siquiera con un usuario local que NO parece correo se llega a comparar claves (para todos los usuarios de la lista)", async () => {
    for (const u of ["prueba", "mecanico1", "mecanico2"]) { const e = conLocal({ producto: "mecanico" }); await e.asentar(); const r = await enviarLogin(e, u, CLAVE_LOCAL); assert.equal(r.error, "Aquí se entra solo con tu correo y contraseña de ENTIMOTORS.", u); assert.equal(e.startApp.length, 0); }
  });
  test("MI TRABAJO: el login por correo (Supabase) sigue funcionando en paralelo", async () => {
    const { CUENTAS } = await import("./helpers/flujos.mjs"); const e = conLocal({ producto: "mecanico" }); await e.asentar(); const r = await enviarLogin(e, CUENTAS.mecanicoActivo.correo, CUENTAS.mecanicoActivo.clave); assert.equal(r.error, ""); assert.equal(e.startApp.length, 1);
  });
  test("wireLoginGate es idempotente: tras mostrarse el login por el portero sigue habiendo UN solo oyente de submit", async () => {
    const e = nuevoEntorno({ producto: "mecanico" }); await e.asentar(); assert.equal(e.doc.getElementById("loginForm").oyentes("submit").length, 1);
    e.win.entrarConSesion({ ...ADMIN_SB }); await e.asentar(); e.win.entrarConSesion({ ...ADMIN_SB }); await e.asentar(); assert.equal(e.doc.getElementById("loginForm").oyentes("submit").length, 1);
    assert.equal(activo(e, "gateLogin"), true);
  });
  test("un envio del formulario procesa UNA sola vez (sin duplicados tras denegar)", async () => {
    const e = nuevoEntorno({ producto: "mecanico" }); await e.asentar(); e.win.entrarConSesion({ ...ADMIN_SB }); await e.asentar();
    const antes = e.servidor.llamadas.length; await enviarLogin(e, "persona@example.test", "x"); assert.equal(e.servidor.llamadas.filter((l) => l.ruta.includes("/auth/v1/token")).length, 1, `llamadas: ${e.servidor.llamadas.length - antes}`);
  });
});

describe("produccion por mecanico (calcularProduccion)", () => {
  const rango = ["2099-01-01", "2099-12-31"], t = Date.parse("2099-06-15T12:00:00Z");
  const fin = (o) => ({ finalizada: true, finalizadoEn: t, items: [{ cantidad: 1, precio: 100 }], ...o });
  const calcular = async (ordenes) => { const e = nuevoEntorno(); dbFalsa(e, { ordenes, ventas_rapidas: [], creditos: [] }); return json(await e.win.calcularProduccion(...rango)); };
  test("dos tocayos con cuenta propia NO suman en la misma fila (se agrupa por uuid)", async () => {
    const r = await calcular([fin({ id: 1, mecanico: "Ana", mecanicoId: UUID(3) }), fin({ id: 2, mecanico: "Ana", mecanicoId: UUID(4) })]);
    assert.equal(r.porMecanico.length, 2); assert.deepEqual(r.porMecanico.map((m) => m.mecanicoId).sort(), [UUID(3), UUID(4)].sort()); assert.ok(r.porMecanico.every((m) => m.nombre === "Ana" && m.completados === 1 && m.producido === 100));
  });
  test("los registros VIEJOS (sin uuid) siguen agrupando por nombre, como siempre", async () => {
    const r = await calcular([fin({ id: 1, mecanico: "Ana" }), fin({ id: 2, mecanico: "Ana" }), fin({ id: 3, mecanico: "Luis" })]);
    const ana = r.porMecanico.find((m) => m.nombre === "Ana"); assert.deepEqual([ana.completados, ana.producido, ana.mecanicoId], [2, 200, null]); assert.equal(r.porMecanico.length, 2);
  });
  test("mismo uuid con nombres distintos → una fila, con la etiqueta humana mas reciente (nunca el uuid)", async () => {
    const r = await calcular([fin({ id: 1, mecanico: "Ana", mecanicoId: UUID(3) }), fin({ id: 2, mecanico: "Ana Perez", mecanicoId: UUID(3) })]);
    assert.equal(r.porMecanico.length, 1); assert.equal(r.porMecanico[0].nombre, "Ana Perez"); assert.equal(r.porMecanico[0].completados, 2); assert.ok(!r.porMecanico[0].nombre.includes(UUID(3)));
  });
  test("sin asignar → «(sin asignar)»; pendientes son una foto actual, independiente del rango de fechas", async () => {
    const r = await calcular([fin({ id: 1 }), { id: 2, finalizada: false, mecanico: "Luis", items: [] }, { id: 3, finalizada: false, mecanicoId: UUID(3), mecanico: "Ana", items: [] }]);
    assert.ok(r.porMecanico.some((m) => m.nombre === "(sin asignar)" && m.completados === 1)); assert.equal(r.porMecanico.find((m) => m.nombre === "Luis").pendientes, 1); assert.equal(r.porMecanico.find((m) => m.mecanicoId === UUID(3)).pendientes, 1);
  });
  test("el trabajo del NEGOCIO nunca se atribuye a un mecanico", async () => {
    const r = await calcular([fin({ id: 1, mecanico: "Ana", mecanicoId: UUID(3), origenTrabajo: "negocio" })]); assert.equal(r.porMecanico.length, 0); assert.equal(r.negocio, 100); assert.equal(r.taller, 0);
  });
  test("promedio = producido / completados; ordenado de mayor a menor producido", async () => {
    const r = await calcular([fin({ id: 1, mecanico: "A", items: [{ cantidad: 1, precio: 50 }] }), fin({ id: 2, mecanico: "B", items: [{ cantidad: 2, precio: 100 }] }), fin({ id: 3, mecanico: "B", items: [{ cantidad: 1, precio: 100 }] })]);
    assert.deepEqual(r.porMecanico.map((m) => m.nombre), ["B", "A"]); assert.equal(r.porMecanico[0].promedio, 150);
  });
});

describe("UI del mecanico con cuenta (barra de acciones, etapas, presupuesto)", () => {
  const ord = (estado, extra = {}) => ({ id: 7, estado, mecanicoId: MEC_SB.perfilId, ...extra });
  const barra = (e) => ({ avanzar: e.doc.getElementById("btnAvanzar"), retro: e.doc.getElementById("btnRetroceder"), factura: e.doc.getElementById("btnImprimirFactura"), wa: e.doc.getElementById("btnEnviarFacturaWA"), badge: e.doc.getElementById("finalizadoBadge") });
  const PASOS = { recibido: "Empezar diagnóstico", diagnostico: "Diagnóstico listo para presupuesto", presupuesto: "Empezar reparación", reparacion: "Pasar a control de calidad" };
  for (const [estado, texto] of Object.entries(PASOS)) test(`updateActionBar (mecanico) en «${estado}»: solo «${texto}»; sin retroceder, sin factura, sin WhatsApp`, () => {
    const e = nuevoEntorno(); como(e, MEC_SB); e.win.updateActionBar(ord(estado)); const b = barra(e);
    assert.deepEqual([b.avanzar.style.display, b.avanzar.textContent, b.retro.style.display, b.factura.style.display, b.wa.style.display, b.badge.style.display], ["inline-flex", texto, "none", "none", "none", "none"]);
  });
  test("updateActionBar (mecanico) en «calidad»: SIN boton; su parte termino y se lo dice", () => {
    const e = nuevoEntorno(); como(e, MEC_SB); e.win.updateActionBar(ord("calidad")); const b = barra(e); assert.equal(b.avanzar.style.display, "none"); assert.equal(b.badge.style.display, "inline-flex"); assert.match(b.badge.textContent, /pendiente de entrega/);
  });
  test("updateActionBar (mecanico) en «entregado»: solo lectura, sin boton, sin factura", () => {
    const e = nuevoEntorno(); como(e, MEC_SB); e.win.updateActionBar(ord("entregado")); const b = barra(e); assert.deepEqual([b.avanzar.style.display, b.factura.style.display, b.badge.textContent], ["none", "none", "Trabajo entregado — solo lectura"]);
  });
  test("updateActionBar (admin) en la ultima etapa SI muestra factura y WhatsApp", () => {
    const e = nuevoEntorno(); como(e, ADMIN_SB); const ultima = e.evaluar("STAGES[STAGES.length - 1].key"); e.win.updateActionBar({ id: 1, estado: ultima }); const b = barra(e); assert.equal(b.factura.style.display, "inline-flex"); assert.equal(b.wa.style.display, "inline-flex");
  });
  test("renderStageTracker: el mecanico ve las etapas DESHABILITADAS y sin oyentes de clic; el admin las tiene activas", () => {
    const m = nuevoEntorno(); como(m, MEC_SB); m.win.renderStageTracker("diagnostico", false); const etapas = m.doc.querySelectorAll(".stage"); assert.ok(etapas.length >= 5);
    assert.ok(etapas.every((b) => b.disabled === true && b.oyentes("click").length === 0));
    const a = nuevoEntorno(); como(a, ADMIN_SB); a.win.renderStageTracker("diagnostico", false); assert.ok(a.doc.querySelectorAll(".stage").every((b) => b.disabled === false && b.oyentes("click").length === 1));
  });
  test("renderStageContent en «presupuesto»: el mecanico NO carga el bloque de importes (ni se pide); admin y cajero SI", async () => {
    const m = nuevoEntorno(); como(m, MEC_SB); const llamadas = []; m.espiar("renderPresupuestoStage", async () => { llamadas.push("m"); });
    await m.win.renderStageContent(ord("presupuesto")); assert.deepEqual(llamadas, []); assert.match(m.doc.getElementById("stageContent").innerHTML, /La cotización la prepara administración/); assert.ok(!/\$|L\s?\d|precio|total/i.test(m.doc.getElementById("stageContent").innerHTML.replace(/var\(--[^)]*\)/g, "")));
    for (const u of [ADMIN_SB, CAJERO]) { const a = nuevoEntorno(); como(a, u); const l = []; a.espiar("renderPresupuestoStage", async () => { l.push(u.rol); }); await a.win.renderStageContent(ord("presupuesto")); assert.deepEqual(l, [u.rol]); }
  });
  test("renderStageContent en «entregado» (mecanico): «ya se entrego», sin importes, cobro ni garantia", async () => {
    const m = nuevoEntorno(); como(m, MEC_SB); await m.win.renderStageContent(ord("entregado", { garantiaDias: 30, tipoCobro: "efectivo", total: 999 }));
    const h = m.doc.getElementById("stageContent").innerHTML; assert.match(h, /Este trabajo ya se entregó/); assert.ok(!/garant|999|efectivo|cobro/i.test(h.replace(/Este trabajo ya se entregó\. Queda como historial: puedes consultarlo, no modificarlo\./, "")));
  });
  test("renderDetalleMecanico: cajero y mecanico ven el nombre como TEXTO (sin selector); el admin ve el selector", () => {
    for (const u of [CAJERO, MEC_SB]) { const e = nuevoEntorno(); como(e, u); e.win.renderDetalleMecanico(ord("recibido", { mecanico: "Ana" })); const h = e.doc.getElementById("detalleMecanicoWrap").innerHTML; assert.match(h, /Asignada a <b>Ana<\/b>/); assert.ok(!/<select/.test(h), u.rol); }
    const a = nuevoEntorno(); como(a, ADMIN_SB); a.win.renderDetalleMecanico(ord("recibido")); assert.match(a.doc.getElementById("detalleMecanicoWrap").innerHTML, /<select id="detalleMecanicoSel"/);
  });
  test("renderDetalleMecanico: aunque el rol cambie despues de pintar el selector, el cambio se BLOQUEA y no se guarda nada", async () => {
    const e = nuevoEntorno(); como(e, ADMIN_SB); const db = dbFalsa(e, { ordenes: [ord("recibido")] }); e.win.renderDetalleMecanico(ord("recibido")); como(e, CAJERO);
    await e.doc.getElementById("detalleMecanicoSel").disparar("change", { target: { value: "Mecánico 1" } }); await e.asentar(); assert.deepEqual(db.guardados(), []); assert.ok(toasts(e).includes("Solo el administrador asigna trabajo"));
  });
  test("renderDetalleMecanico: el nombre de un mecanico hostil se escapa", () => {
    for (const p of ['<img src=x onerror=alert(1)>', `"'><svg onload=alert(1)>`]) { const e = nuevoEntorno(); como(e, CAJERO); e.win.renderDetalleMecanico(ord("recibido", { mecanico: p })); assert.deepEqual(marcadoPeligroso(e.doc.getElementById("detalleMecanicoWrap").innerHTML), [], p); }
  });
  test("bloquearCamposSiEntregada: el mecanico no edita una orden entregada ni ajena; en la suya abierta SI", () => {
    const campos = (e) => ["inputKm", "inputFotos"].map((id) => e.doc.getElementById(id).disabled);
    let e = nuevoEntorno(); como(e, MEC_SB); e.win.bloquearCamposSiEntregada(ord("entregado")); assert.deepEqual(campos(e), [true, true]);
    e = nuevoEntorno(); como(e, MEC_SB); e.win.bloquearCamposSiEntregada(ord("reparacion", { mecanicoId: UUID(60) })); assert.deepEqual(campos(e), [true, true]);
    e = nuevoEntorno(); como(e, MEC_SB); e.win.bloquearCamposSiEntregada(ord("reparacion")); assert.deepEqual(campos(e), [false, false]);
    e = nuevoEntorno(); como(e, ADMIN_SB); e.win.bloquearCamposSiEntregada(ord("entregado")); assert.deepEqual(campos(e), [false, false], "el admin no se ve afectado");
  });
  test("openOrder: el mecanico NO puede abrir la orden de otro por id (ni desde un enlace/buscador): aviso, vuelve a Mi Trabajo y no cambia la orden actual", async () => {
    const e = nuevoEntorno(); como(e, MEC_SB); dbFalsa(e, { ordenes: [ord("recibido", { mecanicoId: UUID(60), motoId: 1, clienteId: 1 })], motos: [{ id: 1, marca: "H", modelo: "X" }], clientes: [{ id: 1, nombre: "C" }], citas: [] });
    await e.win.openOrder(7); await e.asentar(); assert.deepEqual(toasts(e).slice(0, 1), ["Ese trabajo no está asignado a ti"]); assert.equal(e.evaluar("currentOrderId"), null); assert.equal(e.doc.getElementById("view-mi-trabajo").classList.contains("active"), true);
    assert.equal(e.doc.getElementById("detalleTitulo").textContent, "", "no debe haber pintado nada de la orden ajena");
  });
  test("openOrder: la orden PROPIA se abre; datos del cliente escapados; sin errores", async () => {
    for (const p of ['<img src=x onerror=alert(1)>', `"'><svg onload=alert(1)>`]) {
      const e = nuevoEntorno(); como(e, MEC_SB); e.doc.getElementById("inputKm").previousElementSibling = e.doc.createElement("label"); dbFalsa(e, { ordenes: [ord("reparacion", { motoId: 1, clienteId: 1, falla: "ruido" })], motos: [{ id: 1, marca: "H", modelo: "X", placa: p }], clientes: [{ id: 1, nombre: p, telefono: p }], citas: [] });
      await e.win.openOrder(7); await e.asentar(); assert.equal(e.evaluar("currentOrderId"), 7); assert.match(e.doc.getElementById("detalleTitulo").textContent, /Orden #7/);
      assert.deepEqual(marcadoPeligroso(e.doc.getElementById("detalleSub").innerHTML), [], p); assert.equal(e.doc.getElementById("detalleFalla").textContent, "ruido");
    }
  });
  test("openOrder: una orden inexistente no revienta", async () => { const e = nuevoEntorno(); como(e, MEC_SB); dbFalsa(e, { ordenes: [] }); assert.equal(await e.win.openOrder(99), undefined); });
  test("renderWidgetRow: con la vista vedada, el clic NO marca ninguna pestaña ni dibuja esa vista; con permiso, si", async () => {
    for (const [usuario, permitido] of [[MEC_SB, false], [ADMIN_SB, true]]) {
      const e = nuevoEntorno(); como(e, usuario); const dibujadas = []; e.win.__d = dibujadas; e.evaluar("renderByView.finanzas = () => window.__d.push('finanzas')");
      e.doc.getElementById("sidebar").innerHTML = '<button class="nav-item" data-view="finanzas">f</button>';
      e.win.renderWidgetRow("w", [{ ic: "x", val: 1, lbl: "Finanzas", goto: "finanzas" }]);
      const [boton] = e.doc.getElementById("w").querySelectorAll(".widget-mini"); assert.equal(boton.oyentes("click").length, 1); await boton.disparar("click");
      assert.deepEqual(dibujadas, permitido ? ["finanzas"] : [], usuario.rol); assert.equal(e.doc.getElementById("view-finanzas").classList.contains("active"), permitido);
    }
  });
});

describe("continuarArranque del mecanico — solo lo que necesita", () => {
  test("no lee ninguna tabla de negocio (inventario, ventas, caja, creditos, cotizaciones, web_cms) y muestra Mi Trabajo", async () => {
    const e = nuevoEntorno({ producto: "mecanico" }); como(e, MEC_SB); dbFalsa(e, { clientes: [], motos: [], citas: [], ordenes: [] });
    const leidas = []; const orig = e.evaluar("DB.getAll"); e.win.__orig = orig; e.win.__leidas = leidas; e.evaluar("const g = DB.getAll; DB.getAll = async (s) => { window.__leidas.push(s); return g(s); };");
    await e.win.continuarArranque("blanco"); await e.asentar();
    const permitidas = new Set(["clientes", "motos", "citas", "ordenes"]); assert.deepEqual(leidas.filter((s) => !permitidas.has(s)), [], `tablas leidas: ${[...new Set(leidas)]}`);
    assert.equal(e.doc.getElementById("view-mi-trabajo").classList.contains("active"), true); assert.equal(e.doc.getElementById("fabHome").classList.contains("fab-hidden"), true);
  });
  test("contraste: los renderers de negocio que el mecanico se salta SI leen esas tablas (por eso no se ejecutan para el)", async () => {
    const e = nuevoEntorno(); como(e, ADMIN_SB); dbFalsa(e, {}); const leidas = []; e.win.__leidas = leidas; e.evaluar("const g = DB.getAll; DB.getAll = async (s) => { window.__leidas.push(s); return g(s); };");
    for (const r of ["renderInventario", "renderFinanzas", "renderPOS", "renderCotizaciones", "renderWebCMS"]) { try { await e.win[r](); } catch { /* el DOM sintetico no reproduce todas las pantallas; solo interesa que tablas piden */ } }
    assert.ok(["inventario", "ventas_rapidas", "caja_movimientos", "cotizaciones"].some((t) => leidas.includes(t)), `leidas: ${[...new Set(leidas)]}`);
  });
});

describe("ventas rapidas y creditos — atribuidos por identidad (registrarVentaRapida / registrarCredito)", () => {
  const preparar = (usuario, inicial = {}) => { const e = nuevoEntorno(); como(e, usuario); const idb = idbFalsa({ inventario: [{ id: 1, nombre: "Aceite", cantidad: 5, costoCompra: 40 }], ...inicial }); e.win.__idb = idb.db; e.evaluar("db = window.__idb"); return { e, idb }; };
  const ITEMS = (cant = 2) => [{ inventarioId: 1, nombre: "Aceite", cantidad: cant, precio: 100 }, { inventarioId: null, nombre: "Mano de obra", cantidad: 1, precio: 50 }];
  test("venta de un mecanico con cuenta: queda a su nombre Y a su uuid; descuenta stock; anota caja", async () => {
    const { e, idb } = preparar(MEC_SB); const r = await e.win.registrarVentaRapida({ items: ITEMS(), metodoPago: "efectivo", efectivoRecibido: 300 });
    const v = idb.filas("ventas_rapidas")[0]; assert.deepEqual([v.mecanico, v.mecanicoId, r.total, v.cambio], [MEC_SB.nombre, MEC_SB.perfilId, 250, 50]);
    assert.equal(idb.filas("inventario")[0].cantidad, 3); assert.equal(idb.filas("caja_movimientos").length, 1); assert.equal(idb.filas("caja_movimientos")[0].monto, 250); assert.equal(r.faltantes.length, 0);
    assert.equal(v.items[0].costoUnitario, 40); assert.equal(v.items[1].costoUnitario, undefined, "el item manual no toca costos ni stock");
  });
  test("venta de una sesion LOCAL (sin uuid): conserva el nombre y mecanicoId queda null (compatibilidad)", async () => {
    const { e, idb } = preparar(MEC_LOCAL); await e.win.registrarVentaRapida({ items: ITEMS(1), metodoPago: "tarjeta" }); const v = idb.filas("ventas_rapidas")[0]; assert.deepEqual([v.mecanico, v.mecanicoId], ["Mecánico 1", null]);
  });
  test("venta de un admin con cuenta: se atribuye a su uuid", async () => {
    const { e, idb } = preparar(ADMIN_SB); await e.win.registrarVentaRapida({ items: ITEMS(1), metodoPago: "tarjeta" }); assert.equal(idb.filas("ventas_rapidas")[0].mecanicoId, ADMIN_SB.perfilId);
  });
  test("stock insuficiente: nunca queda negativo y el faltante se ANOTA (no se traga en silencio)", async () => {
    const { e, idb } = preparar(ADMIN_SB); const r = await e.win.registrarVentaRapida({ items: ITEMS(9), metodoPago: "tarjeta" }); assert.equal(idb.filas("inventario")[0].cantidad, 0); assert.equal(r.faltantes.length, 1); assert.match(r.faltantes[0], /Aceite \(pedía 9, había 5\)/);
  });
  test("carrito vacio → error claro y NO se abre ninguna transaccion", async () => {
    const { e, idb } = preparar(ADMIN_SB); for (const items of [[], undefined, null]) await assert.rejects(e.win.registrarVentaRapida({ items, metodoPago: "efectivo" }), /El carrito está vacío/); assert.equal(idb.transacciones.length, 0);
  });
  test("credito: queda a nombre y uuid del usuario; descuenta stock; NO registra ingreso en caja todavia", async () => {
    const { e, idb } = preparar(MEC_SB); const r = await e.win.registrarCredito({ clienteId: 1, clienteNombre: "Cliente", clienteTelefono: "", items: ITEMS(1), vencimiento: null, nota: "" });
    const c = idb.filas("creditos")[0]; assert.deepEqual([c.mecanico, c.mecanicoId, c.total, c.saldo, c.abonado, c.estado], [MEC_SB.nombre, MEC_SB.perfilId, 150, 150, 0, "pendiente"]);
    assert.equal(idb.filas("inventario")[0].cantidad, 4); assert.equal(idb.filas("caja_movimientos").length, 0); assert.equal(r.faltantes.length, 0);
  });
  test("credito sin items → error claro", async () => { const { e } = preparar(ADMIN_SB); await assert.rejects(e.win.registrarCredito({ items: [] }), /Agrega al menos un repuesto o servicio/); });
});

describe("renderCitasList — cada boton de una cita esta protegido por rol (exigeGestion)", () => {
  const CLIENTE = { id: 1, nombre: "Cliente Sintetico", telefono: "" };
  const cita = (id, extra = {}) => ({ id, clienteId: 1, fecha: "2000-01-01", hora: "10:00", motivo: "revision", ...extra }); // fecha pasada: el dia ya llego → botones llego/ausente
  const escenario = async (usuario, { historial = false } = {}) => {
    const e = nuevoEntorno(); como(e, usuario); if (historial) e.evaluar('citasFiltro = "historial"');  // las citas cerradas solo se listan en «Historial»
    const db = dbFalsa(e, { citas: [cita(1), cita(2, { estado: "ausente" }), cita(3, { fecha: "2099-01-01" })], clientes: [CLIENTE], motos: [], ordenes: [] });
    const llamadas = []; for (const f of ["abrirOrdenDesdeCita", "abrirModalEditarCita", "abrirModalMoverCita"]) e.espiar(f, async (id) => { llamadas.push([f, id]); });
    e.evaluar("DB.delete = async (s, id) => { (window.__borrados ||= []).push([s, id]); }");
    await e.win.renderCitasList(); await e.asentar();
    const boton = (accion, id) => e.doc.querySelectorAll(`[data-action="${accion}"]`).find((b) => b.dataset.id === String(id));
    return { e, db, llamadas, boton };
  };
  const MENSAJES = { llego: "Solo el administrador o el cajero registran la llegada", editar: "Solo el administrador o el cajero editan una cita", mover: "Solo el administrador o el cajero mueven una cita", ausente: "Solo el administrador o el cajero marcan una ausencia", reabrir: "Solo el administrador o el cajero reabren una cita", recordar: "Los recordatorios los envía el administrador o el cajero" };
  const ACCIONES = [["llego", 1], ["editar", 1], ["mover", 1], ["ausente", 1], ["reabrir", 2], ["recordar", 3]];
  test("el mecanico LOCAL (TEAM) ve los botones pero cada uno se BLOQUEA con su aviso, sin abrir nada ni escribir en la base", async () => {
    for (const [accion, id] of ACCIONES) {
      const { e, db, llamadas, boton } = await escenario(MEC_LOCAL, { historial: accion === "reabrir" }); const b = boton(accion, id); assert.ok(b, `no se pinto el boton ${accion}`);
      await b.disparar("click", { stopPropagation() {} }); await e.asentar();
      assert.deepEqual(toasts(e).slice(-1), [MENSAJES[accion]], accion); assert.deepEqual(json(llamadas), [], accion); assert.deepEqual(json(db.guardados()), [], accion); assert.deepEqual(json(e.ventanas), [], `${accion}: no debe abrir WhatsApp`);
    }
  });
  test("el boton «eliminar» del mecanico LOCAL se bloquea y no borra nada", async () => {
    const { e, llamadas, boton } = await escenario(MEC_LOCAL); await boton("eliminar", 1).disparar("click", { stopPropagation() {} }); await e.asentar();
    assert.deepEqual(toasts(e).slice(-1), ["Solo el administrador elimina una cita"]); assert.equal(e.win.__borrados, undefined); assert.deepEqual(json(llamadas), []); assert.deepEqual(json(e.ventanas), [], "no debe abrir WhatsApp");
  });
  test("el cajero y el admin SI pueden: llego/editar/mover abren su flujo; ausente y reabrir guardan", async () => {
    for (const usuario of [CAJERO, ADMIN_SB]) {
      let s = await escenario(usuario);
      await s.boton("llego", 1).disparar("click", { stopPropagation() {} }); await s.boton("editar", 1).disparar("click", { stopPropagation() {} }); await s.boton("mover", 1).disparar("click", { stopPropagation() {} }); await s.e.asentar();
      assert.deepEqual(json(s.llamadas), [["abrirOrdenDesdeCita", 1], ["abrirModalEditarCita", 1], ["abrirModalMoverCita", 1]], usuario.rol);
      s = await escenario(usuario); await s.boton("ausente", 1).disparar("click", { stopPropagation() {} }); await s.e.asentar(); assert.equal(s.db.guardados().at(-1)[1].estado, "ausente", usuario.rol);
      s = await escenario(usuario, { historial: true }); await s.boton("reabrir", 2).disparar("click", { stopPropagation() {} }); await s.e.asentar(); assert.equal(s.db.guardados().at(-1)[1].estado, undefined, usuario.rol);
    }
  });
  test("CERRADO (OBS-3, 4E-C4-FIX): «eliminar» una cita es SOLO del administrador: el cajero se BLOQUEA con el aviso, sin borrar ni abrir WhatsApp; el admin si borra (ver 13-obs3…)", async () => {
    const c = await escenario(CAJERO); await c.boton("eliminar", 1).disparar("click", { stopPropagation() {} }); await c.e.asentar();
    assert.deepEqual(toasts(c.e).slice(-1), ["Solo el administrador elimina una cita"]); assert.equal(c.e.win.__borrados, undefined, "el cajero NO borra"); assert.deepEqual(json(c.e.ventanas), [], "no debe abrir WhatsApp");
    const a = await escenario(ADMIN_SB); await a.boton("eliminar", 1).disparar("click", { stopPropagation() {} }); await a.e.asentar();
    assert.deepEqual(json(a.e.win.__borrados), [["citas", 1]], "el admin borra la cita");
  });
});

describe("GAPS de producto detectados al probar (caracterizaciones, no fallos)", () => {
  test("GAP-PROD-1: la lista TEAM es estatica y NO trae perfilId → el selector de mecanico del admin no puede asignar trabajo a un mecanico CON CUENTA (mecanicoId siempre null desde la UI)", () => {
    const e = nuevoEntorno(); como(e, ADMIN_SB); e.win.poblarSelectMecanico("ordenMecanico", "Mecánico 1", UUID(3));
    const html = e.doc.getElementById("ordenMecanico").innerHTML; assert.ok(!/data-perfil-id/.test(html), "ninguna opcion lleva perfilId");
    assert.ok(e.evaluar("TEAM").every((t) => t.perfilId === undefined));
  });
  test("GAP-PROD-2: los datos del taller son LOCALES a cada dispositivo — ningun archivo del runtime lee ni escribe tablas de negocio en Supabase (solo «perfiles» en auth.js); por eso este QA NO puede probar un flujo admin→mecanico entre dispositivos", () => {
    const usos = []; for (const f of ["app.js", "usuarios.js", "recovery.js", "auth.js", "supabase-client.js"]) for (const m of leer(f).matchAll(/\.tabla\(\s*["']([a-z_]+)["']\s*\)/g)) usos.push(`${f}:${m[1]}`);
    assert.deepEqual(usos, ["auth.js:perfiles"]); assert.ok(!/\.tabla\(|SupabaseCliente\.rpc\(/.test(leer("app.js")));
  });
});
