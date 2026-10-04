// 3.15.0 · BLOQUE 8 · CRÉDITO con red lenta (decisión del propietario): escritura autoritativa → confirmación → la UI muestra el
// resultado → las descargas secundarias en SEGUNDO PLANO. Nunca «registrado» antes de que el servidor confirme; un fallo de la
// actualización posterior NO convierte un crédito confirmado en «falló». App real (modo nube, por la interfaz) + pila local.
//   B8_RAIZ=<carpeta con taller-demo/> mide otra versión (ANTES = la misma app esperando las 3 descargas). Registro B8_CREDITO_LENTO.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES, RED } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const RAIZ_APP = process.env.B8_RAIZ ? process.env.B8_RAIZ + "/taller-demo" : null;
const ETQ = process.env.B8_ETIQUETA || "despues";
let pila; const R = {};
before(async () => { pila = await iniciarPila(); });
after(async () => { Object.assign(RED, { latenciaMs: 0, kbps: 0 }); await pila?.detener(); console.log(`B8_CREDITO_LENTO ${ETQ} ${JSON.stringify(R)}`); });
const n = (q) => Number(pila.sql(q));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function abrir(nav) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8cl-${ETQ}-${nav}`, pagina: "index.html", real: true, raiz: RAIZ_APP });
  await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
  await d.eval(async () => {
    window.print = () => {};
    const real = window.fetch.bind(window);
    window.__falla = null;   // "antes" | "despues" (registrar_credito: sin llegar / llega y se pierde la respuesta) | "descargas"
    window.fetch = async (u, i) => {
      const url = String(u?.url || u);
      if (url.indexOf(window.ENTIMOTORS_SUPABASE.url) === 0 && window.__sinRed) throw new TypeError("Failed to fetch");
      if (window.__falla === "antes" && url.includes("/rpc/registrar_credito")) { window.__falla = null; throw new TypeError("Failed to fetch"); }
      if (window.__falla === "despues" && url.includes("/rpc/registrar_credito")) { window.__falla = null; await real(u, i); throw new TypeError("Failed to fetch"); }
      if (window.__falla === "descargas" && (i?.method || "GET") === "GET" && /\/rest\/v1\/(creditos|inventario|caja_movimientos)\?/.test(url)) throw new TypeError("Failed to fetch");
      return real(u, i);
    };
    await startApp({ uid: "00000000-0000-4000-8000-000000000001", nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null });
    if (window.esperarDescargaArranque) await esperarDescargaArranque();
    return true;
  }, null, { plazoMs: 120000 });
  return d;
}
// crédito por «Nuevo crédito» con un cliente nuevo único (sin coincidencias: no aparece el selector); mide hasta que la UI muestra el resultado
async function credito(d, { nombre, precio, dobleClic = false, falla = null, esperarListo = true }) {
  return d.eval(async (a) => {
    window.__toasts = []; window.__estadosRegistro = []; window.__falla = a.falla; showView("creditos");
    document.getElementById("btnNuevoCredito").click(); await new Promise((r) => setTimeout(r, 300));
    document.getElementById("creditoNombre").value = a.nombre; document.getElementById("creditoTelefono").value = String(90000000 + a.precio);
    document.getElementById("creditoItemOrigen").value = "manual"; toggleCreditoItemOrigen();
    document.getElementById("creditoItemNombre").value = "Servicio " + a.nombre; document.getElementById("creditoItemCantidad").value = "1"; document.getElementById("creditoItemPrecio").value = String(a.precio);
    document.getElementById("btnAgregarItemCredito").click(); await new Promise((r) => setTimeout(r, 150));
    const t0 = performance.now(); const g = document.getElementById("btnGuardarCredito"); g.click(); if (a.dobleClic) g.click();
    const modal = () => document.getElementById("modalCredito").classList.contains("active");
    let h = Date.now() + 120000; while (modal() && Date.now() < h) await new Promise((r) => setTimeout(r, 50));
    const ui_ms = Math.round(performance.now() - t0);
    const mensaje = (window.__toasts || []).filter((t) => !/^Registrando/.test(t)).slice(-1)[0] || null;
    h = Date.now() + 120000; while (a.esperarListo && !["listo", "actualizacion-pendiente", "en-cola"].includes(document.body.dataset.registroEstado) && Date.now() < h) await new Promise((r) => setTimeout(r, 50));
    return { ui_ms, listo_ms: Math.round(performance.now() - t0), mensaje, estados: (window.__estadosRegistro || []).slice(), toasts: (window.__toasts || []).slice(-3) };
  }, { nombre, precio, dobleClic, falla, esperarListo }, { plazoMs: 260000 });
}
const vaciar = (d) => d.eval(async () => { window.__sinRed = false; window.__falla = null; const h = Date.now() + 60000;
  while (Date.now() < h) { await syncMotor.sincronizar(); if (!(await syncBd.outbox.todos()).some((q) => q.estado === "pending" || q.estado === "syncing")) break; await new Promise((r) => setTimeout(r, 300)); } return true; }, null, { plazoMs: 80000 });
const enNube = (precio) => ({ creditos: n(`select count(*) from public.creditos where total = ${precio}`), saldo: Number(pila.sql(`select coalesce(sum(saldo), -1) from public.creditos where total = ${precio}`)),
  caja: n(`select count(*) from public.caja_movimientos where credito_id in (select id from public.creditos where total = ${precio})`), cliente_ligado: n(`select count(*) from public.creditos c join public.clientes k on k.id = c.cliente_id where c.total = ${precio}`) });

for (const nav of NAVS) test(`crédito con red lenta · ${ETQ} · ${nav}`, async () => {
  pila.limpiar(); const r = {}; R[nav] = r;
  const d = await abrir(nav);
  try {
    r.rapida = await credito(d, { nombre: "CL Rapida", precio: 1001 }); r.rapida.nube = enNube(1001);
    Object.assign(RED, { latenciaMs: 2500, kbps: 0 }); r.lenta_2500 = await credito(d, { nombre: "CL Lenta", precio: 1002 }); Object.assign(RED, { latenciaMs: 0, kbps: 0 }); r.lenta_2500.nube = enNube(1002);
    Object.assign(RED, { latenciaMs: 1000, kbps: 1000 }); r.latencia_alta = await credito(d, { nombre: "CL Latencia", precio: 1003 }); Object.assign(RED, { latenciaMs: 0, kbps: 0 }); r.latencia_alta.nube = enNube(1003);
    if (ETQ === "despues") {
      r.perdida_antes = await credito(d, { nombre: "CL Perdida Antes", precio: 1004, falla: "antes" }); await vaciar(d); r.perdida_antes.nube = enNube(1004);
      r.perdida_despues = await credito(d, { nombre: "CL Perdida Despues", precio: 1005, falla: "despues" }); await vaciar(d); r.perdida_despues.nube = enNube(1005);
      await d.eval(() => { window.__sinRed = true; return true; });
      r.sin_red = await credito(d, { nombre: "CL Sin Red", precio: 1006 }); r.sin_red.nube_antes = enNube(1006).creditos; await vaciar(d); r.sin_red.nube = enNube(1006);
      r.doble_clic = await credito(d, { nombre: "CL Doble", precio: 1007, dobleClic: true }); r.doble_clic.nube = enNube(1007);
      r.refresco_falla = await credito(d, { nombre: "CL Refresco", precio: 1008, falla: "descargas" }); await d.eval(() => { window.__falla = null; return true; }); r.refresco_falla.nube = enNube(1008);
      await esperar(2000); await d.reabrir(90000); await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
      r.reabrir = await d.eval(async () => { await startApp({ uid: "00000000-0000-4000-8000-000000000001", nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null });
        if (window.esperarDescargaArranque) await esperarDescargaArranque();
        const cs = await DB.getAll("creditos"); return { locales: cs.filter((c) => /^CL /.test(c.clienteNombre)).length, nombres: [...new Set(cs.map((c) => c.clienteNombre))].filter((x) => /^CL /.test(x)).length }; }, null, { plazoMs: 120000 });
    }
  } finally { Object.assign(RED, { latenciaMs: 0, kbps: 0 }); await d.cerrar(); }
  // contrato (en ANTES solo se mide)
  for (const k of ["rapida", "lenta_2500", "latencia_alta"]) assert.deepEqual([r[k].nube.creditos, r[k].nube.cliente_ligado], [1, 1], `${k}: un crédito ligado a su cliente`);
  if (ETQ !== "despues") return;
  for (const k of ["rapida", "lenta_2500", "latencia_alta"]) {
    assert.match(r[k].mensaje || "", /^Crédito registrado/, `${k}: dice registrado`);
    assert.ok(r[k].estados.indexOf("registrado") >= 0 && r[k].estados.indexOf("registrado") < r[k].estados.indexOf("actualizando"), `${k}: REGISTRADO antes de ACTUALIZANDO ${JSON.stringify(r[k].estados)}`);
    assert.equal(r[k].estados.at(-1), "listo");
    assert.equal(r[k].nube.saldo, [1001, 1002, 1003][["rapida", "lenta_2500", "latencia_alta"].indexOf(k)], `${k}: saldo = total (sin entrada)`); assert.equal(r[k].nube.caja, 0, "sin entrada no hay caja");
  }
  for (const k of ["perdida_antes", "perdida_despues", "sin_red"]) {
    assert.ok(!/^Crédito registrado/.test(r[k].mensaje || ""), `${k}: NO dice «registrado» sin confirmación (${r[k].mensaje})`); assert.match(r[k].mensaje || "", /se confirmará/);
    assert.equal(r[k].nube.creditos, 1, `${k}: llega UNA vez`);
  }
  assert.equal(r.sin_red.nube_antes, 0);
  assert.equal(r.doble_clic.nube.creditos, 1, "doble clic: uno");
  assert.match(r.refresco_falla.mensaje || "", /^Crédito registrado/, "refresco que falla: el crédito SIGUE registrado");
  assert.equal(r.refresco_falla.estados.at(-1), "actualizacion-pendiente"); assert.ok(r.refresco_falla.toasts.some((t) => /quedó registrado\. Faltan datos/.test(t)));
  assert.ok(!r.refresco_falla.toasts.some((t) => /No se pudo registrar/.test(t))); assert.equal(r.refresco_falla.nube.creditos, 1);
  assert.equal(r.reabrir.nombres, 8, "tras reabrir: los 8 créditos, sin duplicados"); assert.equal(r.reabrir.locales, 8);
});
