// 3.15.0 · CHECKPOINT 8A · REPRODUCCIÓN de los reportes del cliente (crédito «queda en cero / no me deja», Venta rápida con nombre libre).
// App REAL en modo nube, por la interfaz (clics), contra la pila local. B8A_VERSION=3.14.1 corre la app de PRODUCCIÓN (commit e807f65,
// esquema SIN 15a–15g); por defecto la 3.15 del árbol. Solo OBSERVA y registra (no corrige nada):
//   K1 crédito con cliente NUEVO sin teléfono → y un 2.º intento igual     K2 igual con teléfono
//   K3 Venta rápida «Cobrar servicio» al CRÉDITO con nombre libre          K4 Venta rápida de CONTADO con nombre libre
//   K5 control: crédito a un cliente que YA está en la nube
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { iniciarPila, PERFILES, RAIZ, FASES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium").split(",").filter((n) => NAVEGADORES[n]);
const V = process.env.B8A_VERSION || "3.15";
const RAIZ_APP = V === "3.14.1" ? path.resolve(RAIZ, "../ENTIMOTORS-3.15-bloque8/candidatos/base-3.14.1/taller-demo") : null;
let pila;
before(async () => { pila = await iniciarPila(V === "3.14.1" ? { excluir: FASES.filter((f) => /^15/.test(f)) } : {}); });
after(async () => { await pila?.detener(); });
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(x), '[]') from (${q}) x`));

async function abrir(nav, et) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8a-${et}-${nav}`, pagina: "index.html", real: true, raiz: RAIZ_APP });
  await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
  await d.eval(async () => { window.__confirm = []; const sc = window.showConfirm; window.showConfirm = async (m, o) => { window.__confirm.push(String(m).slice(0, 120)); return window.__respuestaConfirm ?? false; };
    await startApp({ uid: "00000000-0000-4000-8000-000000000001", nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null });
    if (window.esperarDescargaArranque) await esperarDescargaArranque(); return VERSION_APP; }, null, { plazoMs: 120000 });
  return d;
}
// lo que la persona ve + lo que quedó en el dispositivo
const estado = (d, nombre) => d.eval(async (nombre) => {
  await new Promise((r) => setTimeout(r, 300));
  const cl = (await DB.getAll("clientes")).filter((c) => c.nombre === nombre);
  const cr = (await DB.getAll("creditos")).filter((c) => c.clienteNombre === nombre);
  const vt = (await DB.getAll("ventas_rapidas")).filter((c) => c.clienteNombre === nombre);
  const ob = (await syncBd.outbox.todos()).map((q) => ({ ent: q.entidad, rpc: q.rpc || null, tipo: q.tipo || q.op || null, estado: q.estado, error: q.error ? (q.error.codigo || q.error.clase) + ":" + String(q.error.mensaje || "").slice(0, 90) : null }));
  return { toasts: (window.__toasts || []).slice(-4), confirm: window.__confirm.slice(-2), modales: [...document.querySelectorAll(".modal.active")].map((m) => m.id),
    local: { clientes: cl.length, creditos: cr.map((c) => ({ total: c.total, saldo: c.saldo, pend: !!c._pend })), ventas: vt.length }, outbox: ob,
    creditoTotalVisible: document.getElementById("creditoTotal")?.textContent || null, carrito: (typeof creditoCarrito !== "undefined" ? creditoCarrito.length : null) };
}, nombre, { plazoMs: 30000 });
const servidor = (nombre) => ({ clientes: nube(`select count(*) n from public.clientes where nombre = '${nombre}'`)[0].n,
  creditos: nube(`select total, saldo from public.creditos where cliente_nombre = '${nombre}'`), ventas: nube(`select count(*) n from public.ventas where cliente_nombre = '${nombre}'`)[0].n });

async function creditoModal(d, { nombre, telefono = "", respuestaConfirm = false }) {
  await d.eval(async (a) => {
    window.__toasts = []; window.__respuestaConfirm = a.respuestaConfirm; showView("creditos");
    document.getElementById("btnNuevoCredito").click(); await new Promise((r) => setTimeout(r, 400));
    document.getElementById("creditoNombre").value = a.nombre; document.getElementById("creditoTelefono").value = a.telefono;
    document.getElementById("creditoItemOrigen").value = "manual"; toggleCreditoItemOrigen();
    document.getElementById("creditoItemNombre").value = "Servicio " + a.nombre; document.getElementById("creditoItemCantidad").value = "1"; document.getElementById("creditoItemPrecio").value = "500";
    document.getElementById("btnAgregarItemCredito").click(); await new Promise((r) => setTimeout(r, 200));
    document.getElementById("btnGuardarCredito").click(); return true;
  }, { nombre, telefono, respuestaConfirm }, { plazoMs: 20000 });
  await new Promise((r) => setTimeout(r, 12000));   // ejecutar() espera el veredicto hasta ~10 s
}
async function servicioPOS(d, { nombre, tipo }) {
  await d.eval(async (a) => {
    window.__toasts = []; showView("pos"); await new Promise((r) => setTimeout(r, 300));
    document.getElementById("btnAgregarServicioPOS").click(); await new Promise((r) => setTimeout(r, 300));
    document.getElementById("servicioPOSNombre").value = "Servicio " + a.nombre; document.getElementById("servicioPOSCantidad").value = "1"; document.getElementById("servicioPOSPrecio").value = "300";
    document.getElementById("servicioPOSCliente").value = a.nombre;
    document.querySelector(`#servicioPOSTipoCobro .seg-opt[data-tipo="${a.tipo}"]`).click();
    if (a.tipo === "contado") { document.getElementById("servicioPOSMetodo").value = "efectivo"; document.getElementById("servicioPOSEfectivoRecibido").value = "300"; }
    document.getElementById("btnCobrarServicioPOS").click(); return true;
  }, { nombre, tipo }, { plazoMs: 20000 });
  await new Promise((r) => setTimeout(r, 12000));
}

for (const nav of NAVS) test(`8A · crédito / Venta rápida con cliente nuevo · app ${V} · ${nav}`, async () => {
  pila.limpiar();
  pila.sql(`insert into public.clientes (id, nombre) values ('${crypto.randomUUID()}', 'Cliente K5')`);
  const d = await abrir(nav, V.replace(/\./g, ""));
  const R = { version: V };
  try {
    await creditoModal(d, { nombre: "Cliente K1" }); R.K1_intento1 = { ui: await estado(d, "Cliente K1"), nube: servidor("Cliente K1") };
    await d.eval(() => { document.getElementById("modalCredito").classList.remove("active"); return true; });
    await creditoModal(d, { nombre: "Cliente K1" }); R.K1_intento2 = { ui: await estado(d, "Cliente K1"), nube: servidor("Cliente K1") };
    await d.eval(() => { document.getElementById("modalCredito").classList.remove("active"); return true; });
    await creditoModal(d, { nombre: "Cliente K2", telefono: "9999-0002" }); R.K2_intento1 = { ui: await estado(d, "Cliente K2"), nube: servidor("Cliente K2") };
    await d.eval(() => { document.getElementById("modalCredito").classList.remove("active"); return true; });
    await creditoModal(d, { nombre: "Cliente K2", telefono: "9999-0002" }); R.K2_intento2 = { ui: await estado(d, "Cliente K2"), nube: servidor("Cliente K2") };
    await d.eval(() => { document.querySelectorAll(".modal.active").forEach((m) => m.classList.remove("active")); return true; });
    await servicioPOS(d, { nombre: "Cliente K3", tipo: "credito" }); R.K3 = { ui: await estado(d, "Cliente K3"), nube: servidor("Cliente K3") };
    await d.eval(() => { document.querySelectorAll(".modal.active").forEach((m) => m.classList.remove("active")); return true; });
    await servicioPOS(d, { nombre: "Cliente K4", tipo: "contado" }); R.K4 = { ui: await estado(d, "Cliente K4"), nube: servidor("Cliente K4") };
    await d.eval(() => { document.querySelectorAll(".modal.active").forEach((m) => m.classList.remove("active")); return true; });
    await d.eval(async () => { const c = (await DB.getAll("clientes")).find((x) => x.nombre === "Cliente K5"); window.__k5 = c ? c.id : null; return !!c; });
    await d.eval(async () => { window.__toasts = []; showView("creditos"); document.getElementById("btnNuevoCredito").click(); await new Promise((r) => setTimeout(r, 400));
      creditoClienteSel = { clienteId: window.__k5 }; document.getElementById("creditoNombre").value = "Cliente K5";
      document.getElementById("creditoItemOrigen").value = "manual"; toggleCreditoItemOrigen(); document.getElementById("creditoItemNombre").value = "Servicio K5";
      document.getElementById("creditoItemCantidad").value = "1"; document.getElementById("creditoItemPrecio").value = "500"; document.getElementById("btnAgregarItemCredito").click();
      await new Promise((r) => setTimeout(r, 200)); document.getElementById("btnGuardarCredito").click(); return true; }, null, { plazoMs: 20000 });
    await new Promise((r) => setTimeout(r, 12000)); R.K5 = { ui: await estado(d, "Cliente K5"), nube: servidor("Cliente K5") };
    R.sync_ops = nube(`select kind, count(*) n from public.sync_ops group by kind order by kind`);
  } finally {
    console.log(`B8A_CREDITO ${nav} ${JSON.stringify(R)}`);
    await d.cerrar();
  }
  assert.ok(true);   // reproducción: el veredicto se lee del registro
});
