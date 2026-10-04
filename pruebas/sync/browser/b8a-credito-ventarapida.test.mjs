// 3.15.0 · CHECKPOINT 8A · CRÉDITO y VENTA RÁPIDA con clientes: app REAL (modo nube, por la interfaz) + pila local. Contrato:
//   · nunca se crea un cliente en silencio ni se une a uno existente por el nombre solo: decide la persona (usar existente / crear / nada)
//   · «Cancelar» no tiene significado oculto y deja el formulario y el carrito tal cual
//   · la venta guarda el nombre usado (instantánea) — factura y reimpresión lo conservan aunque luego cambie el cliente maestro
// Casos: duplicados (mismo teléfono, teléfono distinto, sin teléfono, nombre parecido, homónimos, reintento, sin red) · CLIENT-CREDIT-01…06
// · CLIENT-QUICKSALE-01…06 · crédito desde la Venta rápida. Registro B8A_CVR. B8A_VERSION=3.14.1 corre la app de producción (debe FALLAR).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { iniciarPila, PERFILES, RAIZ, FASES, RED } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const V = process.env.B8A_VERSION || "3.15";
const RAIZ_APP = V === "3.14.1" ? path.resolve(RAIZ, "../ENTIMOTORS-3.15-bloque8/candidatos/base-3.14.1/taller-demo") : null;
let pila; const R = {};
before(async () => { pila = await iniciarPila(V === "3.14.1" ? { excluir: FASES.filter((f) => /^15/.test(f)) } : {}); });
after(async () => { RED.latenciaMs = 0; await pila?.detener(); console.log(`B8A_CVR ${V} ${JSON.stringify(R)}`); });
const uno = (q) => pila.sql(q);
const cuenta = (tabla, cond) => Number(uno(`select count(*) from public.${tabla} where ${cond}`));

async function abrir(nav, et) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8a-cvr-${et}-${nav}`, pagina: "index.html", real: true, raiz: RAIZ_APP });
  await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
  await d.eval(async () => {
    // imprimir el ticket abre el diálogo del sistema: en Firefox sin pantalla BLOQUEA la página (en un teléfono la persona lo cierra)
    window.__impresiones = 0; window.print = () => { window.__impresiones++; };
    const real = window.fetch.bind(window);
    window.__perderRespuesta = null;   // "registrar_credito" | "registrar_venta_v2": el servidor APLICA y la respuesta se pierde (una vez)
    window.fetch = async (u, i) => {
      const url = String(u?.url || u);
      if (url.indexOf(window.ENTIMOTORS_SUPABASE.url) === 0 && window.__sinRed) throw new TypeError("Failed to fetch");
      if (window.__perderRespuesta && url.includes("/rpc/" + window.__perderRespuesta)) { window.__perderRespuesta = null; await real(u, i); throw new TypeError("Failed to fetch"); }
      return real(u, i);
    };
    await startApp({ uid: "00000000-0000-4000-8000-000000000001", nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null });
    if (window.esperarDescargaArranque) await esperarDescargaArranque();
    return true;
  }, null, { plazoMs: 120000 });
  return d;
}
// vacía la cola con red; devuelve lo que quede (para diagnosticar) en vez de colgarse
const sincronizar = (d) => d.eval(async () => { window.__sinRed = false; const h = Date.now() + 40000;
  while (Date.now() < h) { await Promise.race([syncMotor.sincronizar(), new Promise((r) => setTimeout(r, 8000))]); if (!(await syncBd.outbox.todos()).some((q) => q.estado === "pending" || q.estado === "syncing")) break; await new Promise((r) => setTimeout(r, 300)); }
  if (typeof bajarNube === "function") await Promise.race([bajarNube(["clientes", "creditos", "ventas_rapidas"]), new Promise((r) => setTimeout(r, 8000))]);
  return (await syncBd.outbox.todos()).filter((q) => q.estado !== "done").map((q) => ({ e: q.entidad, rpc: q.rpc || null, estado: q.estado, intentos: q.intentos, err: q.error ? (q.error.clase + ":" + q.error.codigo + ":" + String(q.error.mensaje || "").slice(0, 60)) : null })); }, null, { plazoMs: 80000 });
// el selector de cliente: espera a que aparezca y devuelve lo que ofrece (o null si no aparece)
const selector = (d, ms = 4000) => d.eval(async (ms) => { const h = Date.now() + ms; const m = () => document.getElementById("modalCoincidencias");
  while (Date.now() < h && !(m() && m().classList.contains("active"))) await new Promise((r) => setTimeout(r, 50));
  if (!m() || !m().classList.contains("active")) return null;
  return { titulo: document.getElementById("coincTitulo").textContent, opciones: [...document.querySelectorAll("#coincLista button")].map((b) => b.textContent),
    sinRegistrar: document.getElementById("btnCoincSinRegistrar").style.display !== "none" }; }, ms, { plazoMs: ms + 5000 });
const elegir = (d, que) => d.eval((que) => { const btn = que.startsWith("usar:") ? [...document.querySelectorAll("#coincLista button")].find((b) => b.textContent.includes(que.slice(5)))
  : document.getElementById({ nuevo: "btnCoincNuevo", cancelar: "btnCoincCancelar", "sin-registrar": "btnCoincSinRegistrar" }[que]); btn.click(); return true; }, que, { plazoMs: 10000 });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
// crédito desde «Créditos → Nuevo crédito» (por la interfaz). No espera el final: el selector puede aparecer en medio.
const creditoModal = (d, { nombre, telefono = "", precio = 500, dobleClic = false }) => d.eval(async (a) => {
  window.__toasts = []; showView("creditos"); document.getElementById("btnNuevoCredito").click(); await new Promise((r) => setTimeout(r, 400));
  document.getElementById("creditoNombre").value = a.nombre; document.getElementById("creditoTelefono").value = a.telefono;
  document.getElementById("creditoItemOrigen").value = "manual"; toggleCreditoItemOrigen();
  document.getElementById("creditoItemNombre").value = "Servicio " + a.nombre; document.getElementById("creditoItemCantidad").value = "1"; document.getElementById("creditoItemPrecio").value = String(a.precio);
  document.getElementById("btnAgregarItemCredito").click(); await new Promise((r) => setTimeout(r, 200));
  const g = document.getElementById("btnGuardarCredito"); g.click(); if (a.dobleClic) g.click(); return true;
}, { nombre, telefono, precio, dobleClic }, { plazoMs: 20000 });
const formularioCredito = (d) => d.eval(() => ({ abierto: document.getElementById("modalCredito").classList.contains("active"), nombre: document.getElementById("creditoNombre").value,
  carrito: typeof creditoCarrito !== "undefined" ? creditoCarrito.length : null, toasts: (window.__toasts || []).slice(-2) }), null, { plazoMs: 10000 });
const cerrarModales = (d) => d.eval(() => { document.querySelectorAll(".modal-bg.active").forEach((m) => m.classList.remove("active")); return true; }, null, { plazoMs: 10000 });
const sembrar = (nombre, tel = null) => { const id = crypto.randomUUID(); uno(`insert into public.clientes (id, nombre, telefono) values ('${id}', '${nombre}', ${tel ? `'${tel}'` : "null"})`); return id; };

for (const nav of NAVS) test(`8A · crédito y Venta rápida con clientes · app ${V} · ${nav}`, async () => {
  pila.limpiar();
  const idAna = sembrar("Ana Pérez", "9999-0001"), idJ1 = sembrar("Juan López", "9999-1111"), idJ2 = sembrar("Juan López", "9999-2222"), idMaria = sembrar("María Gómez");
  const d = await abrir(nav, V.replace(/\./g, "")); const r = {}; R[nav] = r;
  try {
    // ── D1 · mismo teléfono (y nombre escrito distinto): se ofrece el existente y se usa — sin cliente nuevo
    await creditoModal(d, { nombre: "ana perez", telefono: "99990001" }); let s = await selector(d); r.D1 = s;
    assert.ok(s && s.opciones.some((o) => /Ana Pérez/.test(o) && /mismo teléfono/.test(o)), `D1 mismo teléfono: ${JSON.stringify(s)}`);
    await elegir(d, "usar:Ana Pérez"); await esperar(12000); await sincronizar(d);
    assert.equal(cuenta("clientes", "nombre ilike 'ana p%'"), 1, "D1: no se creó otro cliente"); assert.equal(cuenta("creditos", `cliente_id = '${idAna}'`), 1, "D1: crédito ligado al existente");
    await cerrarModales(d);
    // ── D2 · mismo nombre, teléfono DISTINTO (posible homónimo): se pregunta; crear uno nuevo es decisión explícita
    await creditoModal(d, { nombre: "Ana Pérez", telefono: "9999-0099" }); s = await selector(d); r.D2 = s;
    assert.ok(s && s.opciones.some((o) => /mismo nombre/.test(o)), "D2 se ofrece el homónimo");
    await elegir(d, "nuevo"); await esperar(12000); await sincronizar(d);
    assert.equal(cuenta("clientes", "nombre = 'Ana Pérez'"), 2, "D2: el nuevo SOLO porque se eligió crear");
    await cerrarModales(d);
    // ── D3 · SIN teléfono y mismo nombre: ya no se crea en silencio; «Cancelar» deja el formulario tal cual y no crea nada
    await creditoModal(d, { nombre: "María Gómez" }); s = await selector(d); r.D3 = s;
    assert.ok(s && s.opciones.some((o) => /María Gómez/.test(o)), "D3 sin teléfono también avisa");
    await elegir(d, "cancelar"); await esperar(800); let f = await formularioCredito(d); r.D3_tras_cancelar = f;
    assert.deepEqual([f.abierto, f.nombre, f.carrito], [true, "María Gómez", 1], "Cancelar = no se hace nada; el formulario queda");
    assert.equal(cuenta("clientes", "nombre = 'María Gómez'"), 1); assert.equal(cuenta("creditos", "cliente_nombre = 'María Gómez'"), 0);
    await cerrarModales(d);
    // ── D4 · nombre PARECIDO
    await creditoModal(d, { nombre: "Maria Gomes" }); s = await selector(d); r.D4 = s;
    assert.ok(s && s.opciones.some((o) => /María Gómez/.test(o) && /parecido/.test(o)), "D4 nombre parecido");
    await elegir(d, "cancelar"); await cerrarModales(d);
    // ── D5 · HOMÓNIMOS: los dos aparecen; nada se elige solo
    await creditoModal(d, { nombre: "Juan López" }); s = await selector(d); r.D5 = s;
    assert.equal(s?.opciones.filter((o) => /Juan López/.test(o)).length, 2, "D5 los dos homónimos"); await elegir(d, "usar:9999-2222"); await esperar(12000); await sincronizar(d);
    assert.equal(cuenta("creditos", `cliente_id = '${idJ2}'`), 1); assert.equal(cuenta("creditos", `cliente_id = '${idJ1}'`), 0, "el elegido, no el primero");
    await cerrarModales(d);
    // ── CLIENT-CREDIT-01 normal (cliente nuevo sin coincidencias: sin preguntar) + CREDIT-03 REINTENTO del mismo nombre → se ofrece el recién creado
    await creditoModal(d, { nombre: "Pedro Nuevo", telefono: "9999-5555" }); s = await selector(d, 2500); r.C01_selector = s; await esperar(12000); await sincronizar(d);
    assert.equal(s, null, "C01: sin coincidencias no se pregunta"); assert.equal(cuenta("creditos", "cliente_nombre = 'Pedro Nuevo'"), 1);
    await cerrarModales(d);
    await creditoModal(d, { nombre: "Pedro Nuevo", telefono: "9999-5555" }); s = await selector(d); r.C03 = s;
    assert.ok(s?.opciones.some((o) => /Pedro Nuevo/.test(o)), "C03 el reintento ofrece el cliente ya creado"); await elegir(d, "usar:Pedro Nuevo"); await esperar(12000); await sincronizar(d);
    assert.equal(cuenta("clientes", "nombre = 'Pedro Nuevo'"), 1, "C03 sin cliente duplicado"); assert.equal(cuenta("creditos", "cliente_nombre = 'Pedro Nuevo'"), 2, "dos créditos porque se pidieron dos");
    await cerrarModales(d);
    // ── CLIENT-CREDIT-02 RESPUESTA PERDIDA: el servidor aplica, la app no recibe respuesta → reintenta con el MISMO op → UN crédito
    await d.eval(() => { window.__perderRespuesta = "registrar_credito"; return true; });
    await creditoModal(d, { nombre: "Ana Pérez", telefono: "9999-0001", precio: 222 }); await selector(d); await elegir(d, "usar:9999-0001"); await esperar(12000);
    r.C02_ui = await formularioCredito(d); await sincronizar(d);
    assert.equal(cuenta("creditos", "total = 222"), 1, "C02: UN crédito aunque se perdió la respuesta"); assert.ok(!r.C02_ui.toasts.some((t) => /No se pudo registrar/.test(t)), "C02 sin error falso");
    await cerrarModales(d);
    // ── CLIENT-CREDIT-04 DOBLE CLIC
    await creditoModal(d, { nombre: "Doble Clic", telefono: "9999-7777", precio: 333, dobleClic: true }); await esperar(12000); await sincronizar(d);
    assert.equal(cuenta("creditos", "total = 333"), 1, "C04: un crédito"); assert.equal(cuenta("clientes", "nombre = 'Doble Clic'"), 1);
    await cerrarModales(d);
    // ── CLIENT-CREDIT-05 RED LENTA (2,5 s por petición)
    RED.latenciaMs = 2500; const t0 = Date.now();
    await creditoModal(d, { nombre: "Red Lenta", telefono: "9999-8888", precio: 444 }); await esperar(1500);
    r.C05_inmediato = await d.eval(() => ({ boton: document.getElementById("btnGuardarCredito").textContent, toasts: (window.__toasts || []).slice(-2) }), null, { plazoMs: 10000 });
    // la persona, sin ver nada, vuelve a tocar «Nuevo crédito»: el formulario en curso NO se vacía
    await d.eval(() => { document.getElementById("btnNuevoCredito").click(); return true; }, null, { plazoMs: 10000 }); await esperar(300);
    r.C05_reabrir = await formularioCredito(d);
    const h = Date.now() + 90000; while (Date.now() < h && (await formularioCredito(d)).abierto) await esperar(500);
    r.C05_ms_hasta_cerrar = Date.now() - t0; r.C05_ui = await formularioCredito(d);
    RED.latenciaMs = 0; await sincronizar(d);
    assert.ok(/Registrando/.test(r.C05_inmediato.boton) || r.C05_inmediato.toasts.some((t) => /Registrando/.test(t)), `C05 aviso inmediato: ${JSON.stringify(r.C05_inmediato)}`);
    assert.deepEqual([r.C05_reabrir.nombre, r.C05_reabrir.carrito], ["Red Lenta", 1], "C05 «Nuevo crédito» no vacía el que se está enviando");
    assert.equal(cuenta("creditos", "total = 444"), 1, "C05: un crédito con la red lenta"); assert.ok(!r.C05_ui.toasts.some((t) => /No se pudo registrar/.test(t)));
    await cerrarModales(d);
    // ── CLIENT-CREDIT-06 SIN RED → RECONEXIÓN (cliente nuevo + crédito): pendientes, y al volver llegan UNA vez y ligados
    await d.eval(() => { window.__sinRed = true; return true; });
    await creditoModal(d, { nombre: "Sin Red", telefono: "9999-9999", precio: 555 }); await esperar(12000); r.C06_ui = await formularioCredito(d);
    assert.equal(cuenta("creditos", "total = 555"), 0, "sin red no llegó"); r.C06_cola = await sincronizar(d);
    assert.equal(cuenta("creditos", "total = 555"), 1); assert.equal(cuenta("creditos c join public.clientes k on k.id = c.cliente_id", "c.total = 555 and k.nombre = 'Sin Red'"), 1, "C06 ligado a SU cliente");
    await cerrarModales(d);

    // ════ VENTA RÁPIDA ════
    const vender = (o) => d.eval(async (o) => {
      window.__toasts = []; showView("pos"); await new Promise((x) => setTimeout(x, 300));
      posCarrito.length = 0; posCarrito.push({ inventarioId: null, nombre: "Servicio " + o.tag, cantidad: 1, precio: o.precio }); renderPosCarrito();
      document.getElementById("posCliente").value = o.clienteId ? String(o.clienteId) : ""; document.getElementById("posCliente").dispatchEvent(new Event("change"));
      const inp = document.getElementById("posClienteNombre"); inp.value = o.nombre || ""; inp.dispatchEvent(new Event("input"));
      if (o.tipo === "credito") document.querySelector('#posTipoCobro .seg-opt[data-tipo="credito"]').click();
      else { document.querySelector('#posTipoCobro .seg-opt[data-tipo="contado"]').click(); document.getElementById("posMetodo").value = "efectivo"; document.getElementById("posEfectivoRecibido").value = String(o.precio); }
      document.getElementById("btnCobrar").click(); return true;
    }, o, { plazoMs: 20000 });
    const idLocal = (nombre) => d.eval(async (n) => ((await DB.getAll("clientes")).find((c) => c.nombre === n) || {}).id || null, nombre, { plazoMs: 10000 });
    // QUICKSALE-01 cliente existente
    await vender({ tag: "Q1", precio: 101, clienteId: await idLocal("María Gómez") }); await esperar(12000); await sincronizar(d);
    assert.equal(cuenta("ventas", `total = 101 and cliente_id = '${idMaria}' and cliente_nombre = 'María Gómez'`), 1, "Q01");
    // QUICKSALE-02/03 nombre escrito: la venta vale sin registrar al cliente, y la factura lleva ESE nombre
    const clientesAntes = cuenta("clientes", "true");
    await vender({ tag: "Q2", precio: 102, nombre: "Don Chepe" }); await esperar(12000);
    r.Q03_ticket = await d.eval(() => document.getElementById("ticketCliente")?.textContent || null, null, { plazoMs: 10000 });
    await sincronizar(d);
    assert.equal(cuenta("ventas", "total = 102 and cliente_id is null and cliente_nombre = 'Don Chepe'"), 1, "Q02 venta con el nombre, sin cliente");
    assert.equal(cuenta("clientes", "true"), clientesAntes, "Q02 no se creó ningún cliente"); assert.equal(r.Q03_ticket, "Don Chepe", "Q03 la factura lleva el nombre");
    // QUICKSALE-04 «Agregar como cliente»: opcional, con coincidencias; nuevo solo si se elige
    await d.eval(() => { showView("pos"); const i = document.getElementById("posClienteNombre"); i.value = "Doña Rosa"; i.dispatchEvent(new Event("input"));
      const b = document.getElementById("btnPosAgregarCliente"); const vis = b.style.display !== "none"; b.click(); return vis; }, null, { plazoMs: 10000 }).then((v) => { r.Q04_boton_visible = v; });
    s = await selector(d); r.Q04 = s; assert.ok(s, "Q04 se abre el selector"); await elegir(d, "nuevo"); await esperar(1500);
    r.Q04_select = await d.eval(() => { const sel = document.getElementById("posCliente"); return sel.options[sel.selectedIndex]?.textContent; }, null, { plazoMs: 10000 });
    assert.equal(r.Q04_select, "Doña Rosa", "Q04 queda elegido para la venta");
    await d.eval(() => { const i = document.getElementById("posClienteNombre"); i.value = "ana perez"; i.dispatchEvent(new Event("input")); document.getElementById("btnPosAgregarCliente").click(); return true; }, null, { plazoMs: 10000 });
    s = await selector(d); assert.ok(s?.opciones.some((o) => /Ana Pérez/.test(o)), "Q04b coincidencia ofrecida"); await elegir(d, "usar:9999-0001"); await esperar(800);
    await sincronizar(d); assert.equal(cuenta("clientes", "nombre ilike 'ana p%'"), 2, "Q04b no se duplicó (siguen los 2 de D1/D2)");
    // QUICKSALE-05 reimprimir con el nombre HISTÓRICO aunque el cliente maestro cambie
    await vender({ tag: "Q5", precio: 105, clienteId: await idLocal("Doña Rosa") }); await esperar(12000); await sincronizar(d);
    uno(`update public.clientes set nombre = 'Rosa Cambiada' where nombre = 'Doña Rosa'`);
    await d.eval(async () => { await bajarNube(["clientes", "ventas_rapidas"]); document.getElementById("btnReimprimirTicket").click(); return true; }, null, { plazoMs: 30000 }); await esperar(1500);
    r.Q05_ticket = await d.eval(() => document.getElementById("ticketCliente")?.textContent || null, null, { plazoMs: 10000 });
    assert.equal(r.Q05_ticket, "Doña Rosa", "Q05 la reimpresión conserva el nombre facturado");
    assert.equal(cuenta("ventas", "total = 105 and cliente_nombre = 'Doña Rosa'"), 1, "Q05 la venta en la nube conserva el nombre");
    // QUICKSALE-06 sin red → reconexión con nombre escrito
    await d.eval(() => { window.__sinRed = true; return true; });
    await vender({ tag: "Q6", precio: 106, nombre: "Cliente Sin Red" }); await esperar(12000);
    assert.equal(cuenta("ventas", "total = 106"), 0); await sincronizar(d);
    assert.equal(cuenta("ventas", "total = 106 and cliente_nombre = 'Cliente Sin Red' and cliente_id is null"), 1, "Q06 una vez, con su nombre");
    // ── 5 · CRÉDITO desde la Venta rápida con nombre escrito: se pregunta (no se crea en silencio); cancelar deja carrito y nombre; «solo con el nombre» vale
    await vender({ tag: "QC", precio: 107, nombre: "Fiado Sin Ficha", tipo: "credito" }); s = await selector(d); r.QC = s;
    assert.ok(s && s.sinRegistrar, "QC: se ofrece seguir solo con el nombre"); await elegir(d, "cancelar"); await esperar(800);
    r.QC_tras_cancelar = await d.eval(() => ({ carrito: posCarrito.length, nombre: document.getElementById("posClienteNombre").value }), null, { plazoMs: 10000 });
    assert.deepEqual(r.QC_tras_cancelar, { carrito: 1, nombre: "Fiado Sin Ficha" }, "QC cancelar no resetea nada");
    await d.eval(() => { document.getElementById("btnCobrar").click(); return true; }, null, { plazoMs: 10000 }); await selector(d); await elegir(d, "sin-registrar"); await esperar(12000); await sincronizar(d);
    assert.equal(cuenta("creditos", "total = 107 and cliente_id is null and cliente_nombre = 'Fiado Sin Ficha'"), 1, "QC crédito solo con el nombre");
    assert.equal(cuenta("clientes", "nombre = 'Fiado Sin Ficha'"), 0, "QC sin cliente creado en silencio");
  } finally { await d.cerrar(); }
});
