// OBS-E1a (3.15.1) — en el detalle de una orden (administrador), la barra de etapas y los selectores «mecánico» y «origen del trabajo»
// guardaban en la nube AL PRIMER TOQUE, sin preguntar: cada toque era una escritura (+1 revisión). Medido en la evidencia del cierre de
// 3.15.0 (orden 9: rev 3 → 5 por un cambio y su reversión hechos sin querer al desplazar en el teléfono). Además, tocar la etapa EN LA
// QUE YA ESTABA la orden también guardaba (+1 revisión sin ningún cambio).
// Contrato: la etapa actual no hace nada; cualquier otro cambio pide confirmación (showConfirm) y SOLO se guarda si se acepta; si se
// cancela, nada se guarda y el selector vuelve a lo guardado. El permiso se comprueba ANTES de preguntar (el cajero ni ve la pregunta).
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { nuevoEntorno, toasts, como, dbFalsa } from "./helpers/flujos.mjs";
import { UUID } from "./helpers/supabase-mock.mjs";

const ADMIN_SB = { rol: "admin", origen: "supabase", perfilId: UUID(1), nombre: "Admin Activo", activo: true };
const CAJERO = { rol: "cajero", origen: "supabase", perfilId: UUID(5), nombre: "Cajero", activo: true };
const orden = (estado = "diagnostico", extra = {}) => ({ id: 7, estado, motoId: 1, clienteId: 1, mecanico: "", mecanicoId: null, origenTrabajo: "taller", items: [], ...extra });

/** Entorno con la orden 7 en la base falsa; `respuesta` = lo que contesta el diálogo de confirmación. */
function entorno({ usuario = ADMIN_SB, respuesta = true, estado = "diagnostico", mutar } = {}) {
  const e = nuevoEntorno(mutar ? { mutar: { app: mutar } } : {}); como(e, usuario);
  const db = dbFalsa(e, { ordenes: [orden(estado)], motos: [{ id: 1, marca: "Honda", modelo: "XR", placa: "" }], clientes: [{ id: 1, nombre: "Cliente", telefono: "" }] });
  const preguntas = []; e.win.showConfirm = async (texto, opciones) => { preguntas.push({ texto, opciones }); return respuesta; };
  e.espiar("openOrder", async () => {}); e.espiar("renderOrdersList", () => {});
  e.evaluar("currentOrderId = 7");
  return { e, db, preguntas, guardadas: () => db.guardados().filter(([s]) => s === "ordenes").map(([, v]) => v) };
}
const STAGES = (e) => e.evaluar("STAGES.map(s => s.key)");
const etapa = (e, key) => e.doc.querySelectorAll(".stage")[STAGES(e).indexOf(key)];

describe("OBS-E1a · barra de etapas del detalle", () => {
  test("tocar la etapa ACTUAL no guarda ni pregunta (antes: +1 revisión sin cambio)", async () => {
    const t = entorno(); t.e.win.renderStageTracker("diagnostico", false);
    await etapa(t.e, "diagnostico").disparar("click"); await t.e.asentar();
    assert.deepEqual(t.guardadas(), []); assert.deepEqual(t.preguntas, []);
  });
  test("tocar otra etapa PREGUNTA, con el número de orden y el nombre de la etapa; si se cancela no se guarda nada", async () => {
    const t = entorno({ respuesta: false }); t.e.win.renderStageTracker("diagnostico", false);
    await etapa(t.e, "reparacion").disparar("click"); await t.e.asentar();
    const label = t.e.evaluar("STAGES.find(s => s.key === 'reparacion').label");
    assert.equal(t.preguntas.length, 1); assert.equal(t.preguntas[0].texto, `¿Pasar la orden #7 a «${label}»?`); assert.equal(t.preguntas[0].opciones.titulo, "Cambiar etapa");
    assert.deepEqual(t.guardadas(), []); assert.ok(!toasts(t.e).some((x) => /^Etapa:/.test(x)));
  });
  test("si se acepta, se guarda UNA vez con la etapa nueva y avisa «Etapa: …»", async () => {
    const t = entorno({ respuesta: true }); t.e.win.renderStageTracker("diagnostico", false);
    await etapa(t.e, "reparacion").disparar("click"); await t.e.asentar();
    assert.equal(t.guardadas().length, 1); assert.equal(t.guardadas()[0].estado, "reparacion");
    assert.ok(toasts(t.e).includes(`Etapa: ${t.e.evaluar("STAGES.find(s => s.key === 'reparacion').label")}`));
  });
  test("una orden finalizada sigue sin moverse y sin preguntar", async () => {
    const t = entorno(); t.e.win.renderStageTracker("diagnostico", true);
    await etapa(t.e, "reparacion").disparar("click"); await t.e.asentar();
    assert.deepEqual(t.guardadas(), []); assert.deepEqual(t.preguntas, []); assert.ok(toasts(t.e).includes("Este trabajo ya está finalizado"));
  });
});

describe("OBS-E1a · selectores «mecánico» y «origen del trabajo» del detalle", () => {
  const cambiar = async (t, id, valor) => { const s = t.e.doc.getElementById(id); s.value = valor; await s.disparar("change", { target: s }); await t.e.asentar(); return s; };
  test("mecánico: cancelar NO guarda y el selector VUELVE a lo guardado", async () => {
    const t = entorno({ respuesta: false }); await t.e.win.renderDetalleMecanico(orden());
    const antes = t.e.doc.getElementById("detalleMecanicoSel").value;
    const s = await cambiar(t, "detalleMecanicoSel", "Mecánico 1");
    assert.equal(t.preguntas.length, 1); assert.match(t.preguntas[0].texto, /^¿Asignar la orden #7 a «.+»\?$/); assert.equal(t.preguntas[0].opciones.titulo, "Cambiar mecánico");
    assert.deepEqual(t.guardadas(), []); assert.equal(s.value, antes);
  });
  test("mecánico: aceptar guarda UNA vez y avisa «Mecánico actualizado»", async () => {
    const t = entorno({ respuesta: true }); await t.e.win.renderDetalleMecanico(orden());
    await cambiar(t, "detalleMecanicoSel", "Mecánico 1");
    assert.equal(t.guardadas().length, 1); assert.ok(toasts(t.e).includes("Mecánico actualizado"));
  });
  test("mecánico: sin permiso (cajero) se bloquea ANTES de preguntar: ni pregunta ni guarda", async () => {
    const t = entorno({ respuesta: true }); await t.e.win.renderDetalleMecanico(orden()); como(t.e, CAJERO);
    await cambiar(t, "detalleMecanicoSel", "Mecánico 1");
    assert.deepEqual(t.preguntas, []); assert.deepEqual(t.guardadas(), []); assert.ok(toasts(t.e).includes("Solo el administrador asigna trabajo"));
  });
  test("origen: cancelar NO guarda y el selector vuelve a «taller»; aceptar guarda «negocio» una vez", async () => {
    const no = entorno({ respuesta: false }); await no.e.win.renderDetalleMecanico(orden());
    const s = await cambiar(no, "detalleOrigenSel", "negocio");
    assert.equal(no.preguntas[0].texto, "¿Marcar la orden #7 como trabajo del negocio?"); assert.deepEqual(no.guardadas(), []); assert.equal(s.value, "taller");
    const si = entorno({ respuesta: true }); await si.e.win.renderDetalleMecanico(orden());
    await cambiar(si, "detalleOrigenSel", "negocio");
    assert.equal(si.guardadas().length, 1); assert.equal(si.guardadas()[0].origenTrabajo, "negocio"); assert.ok(toasts(si.e).includes("Origen del trabajo actualizado"));
  });
});

describe("mutantes (en memoria): sin la confirmación vuelve el guardado al primer toque", () => {
  const cambiarTxt = (de, a) => (t) => { const r = t.split(de).join(a); if (r === t) throw new Error(`mutante sin efecto: ${de}`); return r; };
  test("mutante: la etapa actual vuelve a guardar → la prueba lo detecta", async () => {
    const t = entorno({ mutar: cambiarTxt("      if (i === idx) return;\n", "") }); t.e.win.renderStageTracker("diagnostico", false);
    await etapa(t.e, "diagnostico").disparar("click"); await t.e.asentar();
    assert.notDeepEqual(t.guardadas(), [], "el mutante debía guardar sin cambio");
  });
  test("mutante: la barra no pregunta → con «cancelar» se guarda igual (detectado)", async () => {
    const t = entorno({ respuesta: false, mutar: cambiarTxt("if (!(await showConfirm(`¿Pasar la orden", "if (false && !(await showConfirm(`¿Pasar la orden") });
    t.e.win.renderStageTracker("diagnostico", false); await etapa(t.e, "reparacion").disparar("click"); await t.e.asentar();
    assert.equal(t.guardadas().length, 1, "el mutante debía guardar aunque se cancelara");
  });
  test("mutante: el selector de mecánico no pregunta → con «cancelar» se guarda igual (detectado)", async () => {
    const t = entorno({ respuesta: false, mutar: cambiarTxt("if (!(await showConfirm(`¿Asignar la orden", "if (false && !(await showConfirm(`¿Asignar la orden") });
    await t.e.win.renderDetalleMecanico(orden()); const s = t.e.doc.getElementById("detalleMecanicoSel"); s.value = "Mecánico 1"; await s.disparar("change", { target: s }); await t.e.asentar();
    assert.equal(t.guardadas().length, 1);
  });
});
