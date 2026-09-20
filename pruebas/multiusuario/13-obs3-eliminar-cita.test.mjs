// OBS-3 (4E-C4-FIX) — ELIMINAR UNA CITA es SOLO del administrador.
// Evidencia de la intencion: (1) el aviso dice «Solo el administrador elimina una cita»; (2) la politica historica del esquema
// (citas_admin_borra: «solo el admin borra»); (3) las otras acciones que SI admiten al cajero lo dicen expresamente («…o el cajero»).
// Antes, la guarda era exigeGestion() (admin o cajero) y el cajero borraba la cita. Ahora es esAdmin(). NO cambia ninguna otra guarda.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { leer } from "./helpers/entorno.mjs";
import { nuevoEntorno, como, dbFalsa, toasts } from "./helpers/flujos.mjs";
import { UUID } from "./helpers/supabase-mock.mjs";

const json = (x) => JSON.parse(JSON.stringify(x));
const AVISO = "Solo el administrador elimina una cita";
const U = {
  admin: { rol: "admin", origen: "supabase", perfilId: UUID(1), nombre: "Admin Activo", activo: true },
  adminLocal: { rol: "admin", origen: "local", nombre: "Usuario de Prueba" },
  cajero: { rol: "cajero", origen: "supabase", perfilId: UUID(5), nombre: "Cajero", activo: true },
  mecanico: { rol: "mecanico", origen: "supabase", perfilId: UUID(3), nombre: "Mecanico Activo", activo: true },
  mecanicoLocal: { rol: "mecanico", origen: "local", nombre: "Mecánico 1" },
  desarrollador: { rol: "desarrollador", origen: "supabase", perfilId: UUID(7), nombre: "Dev", activo: true },
  desconocido: { rol: "superadmin", origen: "supabase", perfilId: UUID(9), nombre: "Raro", activo: true },
  sinRol: { rol: "", origen: "local", nombre: "Sin rol" },
  sinSesion: null,
};
const CLIENTE = { id: 1, nombre: "Cliente Sintetico", telefono: "" };
const cita = (id, extra = {}) => ({ id, clienteId: 1, fecha: "2000-01-01", hora: "10:00", motivo: "revision", ...extra });

/** Pantalla de citas de un usuario, con DB.delete espiada y las funciones de flujo reemplazadas por espias. */
async function escenario(usuario, { mutar, historial = false } = {}) {
  const e = nuevoEntorno(mutar ? { mutar: { app: mutar } } : {}); como(e, usuario); if (historial) e.evaluar('citasFiltro = "historial"');
  const db = dbFalsa(e, { citas: [cita(1), cita(2, { estado: "ausente" }), cita(3, { fecha: "2099-01-01" })], clientes: [CLIENTE], motos: [], ordenes: [] });
  const llamadas = []; for (const f of ["abrirOrdenDesdeCita", "abrirModalEditarCita", "abrirModalMoverCita"]) e.espiar(f, async (id) => { llamadas.push([f, id]); });
  e.evaluar("DB.delete = async (s, id) => { (window.__borrados ||= []).push([s, id]); }");
  await e.win.renderCitasList(); await e.asentar();
  const boton = (accion, id) => e.doc.querySelectorAll(`[data-action="${accion}"]`).find((b) => b.dataset.id === String(id));
  return { e, db, llamadas, boton };
}
const eliminar = async (usuario, opciones) => { const s = await escenario(usuario, opciones); await s.boton("eliminar", 1).disparar("click", { stopPropagation() {} }); await s.e.asentar(); return s; };
const borrados = (s) => json(s.e.win.__borrados ?? []);

describe("OBS-3 · eliminar una cita: admin PERMITIDO; cajero, mecanico y cualquier otro rol DENEGADOS", () => {
  for (const n of ["admin", "adminLocal"]) test(`${n}: PERMITIDO — borra la cita y avisa «Cita eliminada»`, async () => {
    const s = await eliminar(U[n]); assert.deepEqual(borrados(s), [["citas", 1]]); assert.ok(toasts(s.e).some((t) => /^Cita eliminada/.test(t)), JSON.stringify(toasts(s.e))); assert.ok(!toasts(s.e).includes(AVISO));
  });
  for (const n of ["cajero", "mecanico", "mecanicoLocal", "desarrollador", "desconocido", "sinRol", "sinSesion"]) test(`${n}: DENEGADO — se BLOQUEA con «${AVISO}», no borra, no abre WhatsApp y no escribe nada`, async () => {
    const s = await eliminar(U[n]); assert.deepEqual(toasts(s.e).slice(-1), [AVISO]); assert.deepEqual(borrados(s), [], "no debe borrar"); assert.deepEqual(json(s.e.ventanas), [], "no debe abrir WhatsApp"); assert.deepEqual(json(s.db.guardados()), []);
  });
  test("las citas que NO se eliminan siguen intactas: una denegacion no toca las demas", async () => {
    const s = await eliminar(U.cajero); assert.equal(s.e.win.__borrados, undefined); assert.equal(s.e.doc.querySelectorAll('[data-action="eliminar"]').length >= 1, true, "el boton sigue pintado (la guarda es del handler, no del pintado)");
  });
});

describe("OBS-3 · NO se alteran las demas guardas de gestion: el cajero conserva llegada, editar, mover, ausencia y reabrir", () => {
  test("cajero: llegada / editar / mover abren su flujo; ausencia y reabrir guardan (igual que antes)", async () => {
    let s = await escenario(U.cajero);
    for (const [a, id] of [["llego", 1], ["editar", 1], ["mover", 1]]) await s.boton(a, id).disparar("click", { stopPropagation() {} }); await s.e.asentar();
    assert.deepEqual(json(s.llamadas), [["abrirOrdenDesdeCita", 1], ["abrirModalEditarCita", 1], ["abrirModalMoverCita", 1]]);
    s = await escenario(U.cajero); await s.boton("ausente", 1).disparar("click", { stopPropagation() {} }); await s.e.asentar(); assert.equal(s.db.guardados().at(-1)[1].estado, "ausente");
    s = await escenario(U.cajero, { historial: true }); await s.boton("reabrir", 2).disparar("click", { stopPropagation() {} }); await s.e.asentar(); assert.equal(s.db.guardados().at(-1)[1].estado, undefined);
  });
  test("los textos y guardas de las otras acciones siguen en el codigo: exigeGestion para llegada, editar, mover, ausencia, reabrir, recordatorios y abrir orden", () => {
    const src = leer("app.js");
    for (const t of ["Solo el administrador o el cajero registran la llegada", "Solo el administrador o el cajero editan una cita", "Solo el administrador o el cajero mueven una cita", "Solo el administrador o el cajero marcan una ausencia", "Solo el administrador o el cajero reabren una cita", "Los recordatorios los envía el administrador o el cajero", "Las órdenes las abre el administrador o el cajero"])
      assert.ok(src.includes(`exigeGestion("${t}")`), t);
    assert.equal((src.match(/exigeGestion\("/g) || []).length, 7, "siete guardas de gestion (la de eliminar ya no es una de ellas)");
  });
  test("exigeGestion() no cambio: sigue dejando pasar a admin y cajero", () => {
    for (const [u, esperado] of [[U.admin, true], [U.cajero, true], [U.mecanico, false], [U.mecanicoLocal, false], [U.desconocido, false]]) { const e = nuevoEntorno(); como(e, u); assert.equal(e.win.exigeGestion("x"), esperado, u.rol); }
  });
});

describe("OBS-3 · guarda estatica y mutantes (en memoria): si se vuelve a la guarda anterior, la prueba VUELVE A FALLAR", () => {
  const cambiar = (de, a) => (t) => { const r = t.split(de).join(a); if (r === t) throw new Error(`mutante sin efecto: ${de}`); return r; };
  const GUARDA = 'if (!esAdmin()) { bloquear("Solo el administrador elimina una cita"); return; }';
  test("el codigo real usa esAdmin() y NO exigeGestion() en «eliminar»", () => {
    const src = leer("app.js"); assert.ok(src.includes(GUARDA)); assert.ok(!src.includes(`exigeGestion("${AVISO}")`));
  });
  const propiedad = async (mutar) => {
    const a = await eliminar(U.admin, { mutar }); if (JSON.stringify(borrados(a)) !== '[["citas",1]]') return false;
    for (const n of ["cajero", "mecanico", "mecanicoLocal", "desconocido"]) { const s = await eliminar(U[n], { mutar }); if (borrados(s).length) return false; }
    return true;
  };
  test("con el codigo REAL la propiedad se cumple (linea base)", async () => assert.equal(await propiedad(), true));
  test("mutante: se vuelve a exigeGestion() (el cajero borraba la cita) → la prueba lo detecta", async () => assert.equal(await propiedad(cambiar(GUARDA, 'if (!exigeGestion("Solo el administrador elimina una cita")) return;')), false));
  test("mutante: se quita la guarda por completo (cualquiera borra) → la prueba lo detecta", async () => assert.equal(await propiedad(cambiar(GUARDA, "")), false));
  test("mutante: la guarda pasa a esAdmin() || puedeGestionarTaller() (admite al cajero por otra via) → la prueba lo detecta", async () => assert.equal(await propiedad(cambiar("if (!esAdmin()) { bloquear(\"Solo el administrador elimina una cita\")", "if (!(esAdmin() || puedeGestionarTaller())) { bloquear(\"Solo el administrador elimina una cita\")")), false));
});
