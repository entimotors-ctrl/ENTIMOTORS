// 3.15.0 · BLOQUE 7 · RED: la app real con perfiles de red EMULADOS (no se asume Wi-Fi rápido). Chromium y Firefox.
//   A · «lie-fi»: Internet (el CDN de Chart.js) pasa por un proxy SUMIDERO que acepta la conexión y nunca responde. ¿Arranca la app?
//   B · perfiles en el gateway (lo que ve el navegador de Supabase): rápida · lenta (400 kbps, 150 ms por petición) · latencia alta
//       (1 Mbps, 600 ms). Arranque en frío (dispositivo nuevo) y en caliente (reabrir), y una tarea principal (alta de cliente hasta que el
//       servidor la confirma): tiempo, peticiones y bytes. Volumen: el de producción («actual»); el arranque en caliente también con 3 000.
//   C · sin red → trabajo guardado en el dispositivo → vuelve la red → llega UNA vez.
//   B7_RAIZ=<carpeta con taller-demo/> (p. ej. la copia ANTES)   B7_ETIQUETA=antes|despues   B7_SALIDA=<.jsonl>
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { iniciarPila, PERFILES, RED } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { sembrarVolumen } from "./lib/volumen.mjs";
import { prepararSesion, anotar } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const RAIZ = process.env.B7_RAIZ ? process.env.B7_RAIZ + "/taller-demo" : null;
const ETQ = process.env.B7_ETIQUETA || "despues";
const SALIDA = process.env.B7_SALIDA || null;
const PERFILES_RED = { rapida: { latenciaMs: 0, kbps: 0 }, lenta: { latenciaMs: 150, kbps: 400 }, latencia_alta: { latenciaMs: 600, kbps: 1000 } };

let pila, sumidero; const colgadas = new Set();
before(async () => {
  pila = await iniciarPila();
  sumidero = net.createServer((s) => { colgadas.add(s); s.on("error", () => {}); s.on("close", () => colgadas.delete(s)); });   // acepta y NUNCA responde
  await new Promise((r) => sumidero.listen(0, "127.0.0.1", r));
});
after(async () => { Object.assign(RED, { latenciaMs: 0, kbps: 0 }); for (const s of colgadas) s.destroy(); sumidero?.close(); await pila?.detener(); });
const red = (p0) => { const p = pila.peticiones.slice(p0); const r = p.filter((x) => x.metodo !== "OPTIONS"); return { peticiones: r.length, preflight: p.length - r.length, kb: Math.round(r.reduce((s, x) => s + (x.bytes || 0), 0) / 1024) }; };
const arrancar = (d) => d.eval(async (a) => {
  const t0 = performance.now();
  await startApp({ uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null });
  const t1 = performance.now();
  if (typeof esperarDescargaArranque === "function") await esperarDescargaArranque();
  return { utilizable_ms: Math.round(t1 - t0), alDia_ms: Math.round(performance.now() - t0), shell: document.getElementById("shell").classList.contains("active") };
}, { id: PERFILES.admin }, { plazoMs: 600000 });
async function recargar(d) {
  await d.eval(() => { window.__paginaVieja = true; setTimeout(() => location.reload(), 30); return true; });
  await new Promise((r) => setTimeout(r, 400));
  for (let i = 0; i < 240; i++) { try { if ((await d.eval(() => !window.__paginaVieja && document.readyState, null, { plazoMs: 3000 })) === "complete") return; } catch { /* navegando */ } await new Promise((r) => setTimeout(r, 250)); }
}
const tarea = (d) => d.eval(async () => {
  const t0 = performance.now();
  const id = await DB.save("clientes", { nombre: "Cliente red " + Math.random().toString(36).slice(2, 7), telefono: "99990000" });
  const local = performance.now() - t0;
  const h = Date.now() + 120000;
  while (Date.now() < h) { await syncMotor.sincronizar(); const p = (await syncBd.outbox.todos()).filter((x) => x.estado === "pending" || x.estado === "syncing"); if (!p.length) break; await new Promise((r) => setTimeout(r, 20)); }
  const c = await DB.get("clientes", id);
  return { local_ms: Math.round(local), confirmado_ms: Math.round(performance.now() - t0), uid: c?.uid || null };
}, null, { plazoMs: 200000 });

for (const nav of NAVS) {
  test(`A · lie-fi (CDN sin respuesta) · ${nav} · ${ETQ}`, async () => {
    const t0 = Date.now(); let d = null, r;
    try {
      d = await abrirDispositivo({ navegador: nav, nombre: `b7lie-${nav}`, pagina: "index.html", real: true, raiz: RAIZ, proxySumidero: sumidero.address().port, plazoApertura: 20000 });
      r = await d.eval(() => ({ app: typeof startApp === "function", listo: document.readyState, chart: typeof Chart }));
      r.abre_ms = Date.now() - t0;
      await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
      Object.assign(r, await arrancar(d));
    } catch (e) { r = { abre_ms: null, error: String(e.message).slice(0, 160), bloqueadoMasDe_ms: Date.now() - t0 }; }
    finally { await d?.cerrar(); }
    anotar(SALIDA, `${ETQ}|${nav}|liefi`, r);
    if (ETQ === "despues") { assert.ok(r.abre_ms != null && r.abre_ms < 15000, `la app arranca aunque el CDN no responda: ${JSON.stringify(r)}`); assert.equal(r.shell, true); }
  });

  test(`B · perfiles de red · ${nav} · ${ETQ}`, async () => {
    const R = {};
    for (const [perfil, cfg] of Object.entries(PERFILES_RED)) {
      for (const vol of ["actual", "3000"]) {
        sembrarVolumen(pila, vol);
        Object.assign(RED, { latenciaMs: 0, kbps: 0 });   // la descarga inicial de 3 000 por red lenta no es el caso a medir aquí (se mide aparte con «actual»)
        if (vol === "actual") Object.assign(RED, cfg);
        const d = await abrirDispositivo({ navegador: nav, nombre: `b7red-${nav}-${perfil}-${vol}`, pagina: "index.html", real: true, raiz: RAIZ, redEstaticos: true, plazoApertura: 120000 });
        try {
          await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
          let p0 = pila.peticiones.length;
          const frio = await arrancar(d); frio.red = red(p0);
          Object.assign(RED, cfg);
          await recargar(d);
          await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
          p0 = pila.peticiones.length;
          const caliente = await arrancar(d); caliente.red = red(p0);
          await new Promise((r) => setTimeout(r, 500));
          p0 = pila.peticiones.length;
          const t = await tarea(d); t.red = red(p0);
          R[`${perfil}|${vol}`] = { frio: vol === "actual" ? frio : "(descarga inicial por red rápida)", caliente, tarea_alta_cliente: t };
          assert.ok(t.uid, `${perfil}/${vol}: el cliente llegó al servidor`);
        } finally { await d.cerrar(); Object.assign(RED, { latenciaMs: 0, kbps: 0 }); }
      }
    }
    anotar(SALIDA, `${ETQ}|${nav}|perfiles-red`, R);
  });

  test(`C · sin red y reconexión · ${nav} · ${ETQ}`, async () => {
    sembrarVolumen(pila, "actual");
    const d = await abrirDispositivo({ navegador: nav, nombre: `b7off-${nav}`, pagina: "index.html", real: true, raiz: RAIZ });
    try {
      await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
      await arrancar(d);
      await recargar(d);
      await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
      // sin red: fetch a la nube falla al instante (como el modo avión) y el navegador se declara offline
      const r = await d.eval(async (a) => {
        const real = window.fetch.bind(window);
        window.fetch = (u, i) => (String(u?.url || u).indexOf(window.ENTIMOTORS_SUPABASE.url) === 0 && window.__sinRed ? Promise.reject(new TypeError("Failed to fetch")) : real(u, i));
        window.__sinRed = true;
        const t0 = performance.now();
        await startApp({ uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null });
        const abre = performance.now() - t0;
        if (typeof esperarDescargaArranque === "function") await esperarDescargaArranque();
        const id = await DB.save("clientes", { nombre: "Sin red B7", telefono: "1" });
        await new Promise((x) => setTimeout(x, 800));
        const pend = (await syncBd.outbox.todos()).filter((x) => x.estado === "pending").length;
        const chip = document.getElementById("syncLabel").textContent;
        window.__sinRed = false;
        const t1 = performance.now();
        const h = Date.now() + 30000;
        while (Date.now() < h) { await syncMotor.sincronizar(); if (!(await syncBd.outbox.todos()).some((x) => x.estado === "pending" || x.estado === "syncing")) break; await new Promise((x) => setTimeout(x, 50)); }
        return { abre_sin_red_ms: Math.round(abre), pendientes_sin_red: pend, chip_sin_red: chip, reconexion_hasta_confirmado_ms: Math.round(performance.now() - t1), uid: (await DB.get("clientes", id))?.uid || null };
      }, { id: PERFILES.admin }, { plazoMs: 120000 });
      r.en_servidor = Number(pila.sql("select count(*) from public.clientes where nombre = 'Sin red B7'"));
      anotar(SALIDA, `${ETQ}|${nav}|offline`, r);
      assert.equal(r.pendientes_sin_red, 1, "sin red queda UNA operación pendiente");
      assert.equal(r.en_servidor, 1, "al volver la red llega UNA vez");
    } finally { await d.cerrar(); }
  });
}
