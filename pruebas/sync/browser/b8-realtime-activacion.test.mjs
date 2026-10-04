// 3.15.0 · BLOQUE 8 · CASO Y (causa medida en b8-realtime-y): Realtime activa el «broadcast desde la base» con el PRIMER join privado y
// no entrega lo que se avisa en los ~6–10 s siguientes (ni lo reenvía), aunque el canal diga «ok». Esta prueba abre Mi Trabajo con la pila
// RECIÉN levantada (Realtime en frío) y, en cuanto el canal está «conectado», hace dos cambios DENTRO de esa ventana:
//   1 · le asignan una orden nueva → tiene que aparecer en el dispositivo en ≤ 20 s (sin esperar el ciclo periódico)
//   2 · (otra pila en frío) desactivan su cuenta → el dispositivo se cierra con «cuenta eliminada o desactivada» en ≤ 20 s
// Registro B8_RT_ACTIVACION. Con la app anterior (sin la puesta al día tras la primera conexión) tarda el ciclo periódico o más.
import test from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const RAIZ_APP = process.env.B8_RAIZ ? process.env.B8_RAIZ + "/taller-demo" : null;
const R = {};
const TOPE = 45000;

async function abrirMT(pila, nav, nombre) {
  const d = await abrirDispositivo({ navegador: nav, nombre, pagina: "index.html", real: true, producto: "mecanico", raiz: RAIZ_APP });
  await prepararSesion(d, pila.jwt(PERFILES.mecanico, { segundos: 7200 }));
  await d.eval(async (id) => { window.__denegado = null; const dn = window.denegarSesion; window.denegarSesion = async (m) => { window.__denegado = { m: String(m).slice(0, 80), t: Date.now() }; return dn(m); };
    await startApp({ uid: id, nombre: "Mec", rol: "mecanico", origen: "supabase", activo: true, perfilId: id, user: null });
    const h = Date.now() + 30000; while (Date.now() < h && rtEstado !== "conectado") await new Promise((r) => setTimeout(r, 20)); return rtEstado; }, PERFILES.mecanico, { plazoMs: 90000 });
  return d;
}
for (const nav of NAVS) test(`caso Y en la app: lo que pasa en la ventana de activación de Realtime llega igual · ${nav}`, async () => {
  const r = {}; R[nav] = r;
  // 1 · orden asignada en la ventana
  let pila = await iniciarPila({ realtime: true });
  try {
    const c = crypto.randomUUID(), m = crypto.randomUUID(), o = crypto.randomUUID();
    pila.sql(`insert into public.clientes (id, nombre) values ('${c}', 'Cliente Y'); insert into public.motos (id, cliente_id, marca, modelo, placa) values ('${m}', '${c}', 'Honda', 'CB', 'Y-1');`);
    const d = await abrirMT(pila, nav, `b8y-orden-${nav}`);
    try {
      const t0 = Date.now();
      pila.sql(`insert into public.ordenes (id, cliente_id, moto_id, estado, falla, mecanico, mecanico_id, origen_trabajo) values ('${o}', '${c}', '${m}', 'recibido', 'Orden en la ventana', 'Mec Uno', '${PERFILES.mecanico}', 'taller')`);
      r.orden_ms = await d.eval(async (a) => { const h = Date.now() + a.tope; while (Date.now() < h) { if ((await DB.getAll("ordenes")).some((x) => x.uid === a.o)) return Date.now() - a.t0; await new Promise((x) => setTimeout(x, 200)); } return null; }, { o, t0, tope: TOPE }, { plazoMs: TOPE + 10000 });
    } finally { await d.cerrar(); }
  } finally { await pila.detener(); }
  // 2 · cuenta desactivada en la ventana
  pila = await iniciarPila({ realtime: true });
  try {
    const d = await abrirMT(pila, nav, `b8y-cuenta-${nav}`);
    try {
      const t0 = Date.now();
      pila.sql(`update public.perfiles set activo = false where id = '${PERFILES.mecanico}'`);
      r.cuenta = await d.eval(async (a) => { const h = Date.now() + a.tope; while (Date.now() < h) { if (window.__denegado) return { ms: window.__denegado.t - a.t0, mensaje: window.__denegado.m }; await new Promise((x) => setTimeout(x, 200)); } return null; }, { t0, tope: TOPE }, { plazoMs: TOPE + 10000 });
    } finally { pila.sql(`update public.perfiles set activo = true where id = '${PERFILES.mecanico}'`); await d.cerrar(); }
  } finally { await pila.detener(); }
  console.log(`B8_RT_ACTIVACION ${nav} ${JSON.stringify(r)}`);
  assert.ok(r.orden_ms != null && r.orden_ms <= 20000, `la orden asignada en la ventana aparece en ≤ 20 s: ${r.orden_ms}`);
  assert.ok(r.cuenta && r.cuenta.ms <= 20000 && /eliminada o desactivada/.test(r.cuenta.mensaje), `la desactivación en la ventana cierra en ≤ 20 s: ${JSON.stringify(r.cuenta)}`);
});
