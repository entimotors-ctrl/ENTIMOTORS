// 3.15.0 · BLOQUE 8 · DIAGNÓSTICO del parón visto en el estrés del Realtime (A/B): tras 8,3 s SIN órdenes del arnés, ¿cuánto tarda la
// página en atender una orden? A = el token de la sesión CADUCA en ese intervalo con el canal unido; B = token que no caduca.
// Registra (sin tokens) la demora, los cambios de rtEstado y qué funciones de la app corrieron (comprobarCuentaPropia, avisos…).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium").split(",").filter((n) => NAVEGADORES[n]);
let pila;
before(async () => { pila = await iniciarPila({ realtime: true }); });
after(async () => { await pila?.detener(); });
const R = {};
for (const nav of NAVS) for (const [caso, seg] of [["A-caduca", 8], ["B-no-caduca", 3600], ["A-caduca-2", 8], ["B-no-caduca-2", 3600]]) test(`diag ${caso} · ${nav}`, async () => {
  pila.limpiar();
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8diag-${nav}-${caso}`, pagina: "index.html", real: true, producto: "mecanico" });
  try {
    await prepararSesion(d, pila.jwt(PERFILES.mecanico, { segundos: seg }));
    await d.eval(async (a) => {
      window.__log = []; const t0 = Date.now(), L = (x) => window.__log.push({ t: Date.now() - t0, ...x });
      for (const f of ["comprobarCuentaPropia", "cerrarPorCuentaEliminada", "denegarSesion", "pintarEstadoVivo", "ponerAlDia", "procesarAvisos", "renderMiTrabajo"]) {
        const o = window[f]; if (typeof o !== "function") continue;
        window[f] = function (...args) { L({ f, rt: rtEstado }); const r = o.apply(this, args); if (r && r.then) r.then(() => L({ f: f + ":fin" }), () => L({ f: f + ":error" })); return r; };
      }
      const fo = window.fetch; window.fetch = function (u, i) { const t = Date.now(); const url = String(u?.url || u); const p = fo.call(this, u, i); p.then((r) => L({ fetch: url.replace(/^https?:\/\/[^/]+/, "").split("?")[0], status: r.status, ms: Date.now() - t }), () => L({ fetch: url.split("?")[0], error: true, ms: Date.now() - t })); return p; };
      await startApp({ uid: a.id, nombre: "Mec", rol: "mecanico", origen: "supabase", activo: true, perfilId: a.id, user: null });
      const lim = Date.now() + 15000; while (Date.now() < lim && rtEstado !== "conectado") await new Promise((r) => setTimeout(r, 20));
      L({ listo: rtEstado });
      return true;
    }, { id: PERFILES.mecanico }, { plazoMs: 60000 });
    await new Promise((r) => setTimeout(r, 8300));
    const enviado = Date.now();
    const eco = await d.eval((e) => ({ demora: Date.now() - e, rt: rtEstado }), enviado, { plazoMs: 30000 });
    const log = await d.eval(() => window.__log, null, { plazoMs: 30000 });
    R[`${nav} ${caso}`] = { demora_ms: eco.demora, rt: eco.rt, log: log.filter((x) => !x.fetch || !/__cmd|__res/.test(x.fetch)) };
    console.log(`B8_DIAG ${nav} ${caso} ${JSON.stringify(R[`${nav} ${caso}`])}`);
    assert.ok(true);
  } finally { await d.cerrar(); }
});

// C · la secuencia del estrés: N uniones cerrando/reabriendo el Realtime y después una unión con token de 8 s que caduca SIN órdenes;
// sondas cada segundo (demora de la página) + registro de la app.
for (const nav of NAVS) for (const n of [0, 10, 50]) test(`diag C · ${n} uniones previas + caducidad · ${nav}`, async () => {
  pila.limpiar();
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8diagC-${nav}-${n}`, pagina: "index.html", real: true, producto: "mecanico" });
  try {
    await prepararSesion(d, pila.jwt(PERFILES.mecanico, { segundos: 3600 }));
    await d.eval(async (a) => { await startApp({ uid: a.id, nombre: "Mec", rol: "mecanico", origen: "supabase", activo: true, perfilId: a.id, user: null }); return true; }, { id: PERFILES.mecanico }, { plazoMs: 60000 });
    const unir = (t) => d.eval(async (t) => { window.__token = t; detenerRealtime(); prepararRealtime(); const lim = Date.now() + 15000; while (Date.now() < lim && !["conectado", "sin-acceso", "sin-sesion"].includes(rtEstado)) await new Promise((r) => setTimeout(r, 15)); return rtEstado; }, t, { plazoMs: 30000 });
    for (let i = 0; i < n; i++) await unir(pila.jwt(PERFILES.mecanico, { segundos: 120 }));
    await d.eval(() => { window.__log = []; const t0 = Date.now(); window.__t0 = t0; const L = (x) => window.__log.push({ t: Date.now() - t0, ...x });
      const fo = window.fetch; window.fetch = function (u, i) { const t = Date.now(); const url = String(u?.url || u); const p = fo.call(this, u, i); if (!/__cmd|__res/.test(url)) p.then((r) => L({ fetch: url.replace(/^https?:\/\/[^/]+/, "").split("?")[0], status: r.status, ms: Date.now() - t }), () => L({ fetch: url, error: true })); return p; };
      const pe = window.pintarEstadoVivo; window.pintarEstadoVivo = function () { L({ rt: rtEstado }); return pe.apply(this, arguments); }; return true; });
    const union8 = await unir(pila.jwt(PERFILES.mecanico, { segundos: 8 }));
    const sondas = [];
    for (let s = 0; s < 22; s++) { const e = Date.now(); const r = await d.eval((e) => ({ demora: Date.now() - e, rt: rtEstado, t: Date.now() - window.__t0 }), e, { plazoMs: 30000 }); sondas.push({ s, ...r, total: Date.now() - e }); await new Promise((x) => setTimeout(x, 1000)); }
    const log = await d.eval(() => window.__log, null, { plazoMs: 30000 });
    console.log(`B8_DIAG_C ${nav} previas=${n} union8=${union8} sondas=${JSON.stringify(sondas.filter((x) => x.total > 200 || x.s % 5 === 0))} log=${JSON.stringify(log)}`);
  } finally { await d.cerrar(); }
});

// D · la secuencia EXACTA de R2 del estrés (incluidas las llamadas síncronas del arnés: psql y docker exec para los relojes), con el
// puente de la página registrado (cuándo pide órdenes y cuándo las recibe) y cronometrando las llamadas síncronas de Node.
import { spawnSync } from "node:child_process";
for (const nav of NAVS) test(`diag D · secuencia R2 con relojes síncronos · ${nav}`, async () => {
  pila.limpiar();
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8diagD-${nav}`, pagina: "index.html", real: true, producto: "mecanico" });
  const nodo = [];
  try {
    await prepararSesion(d, pila.jwt(PERFILES.mecanico, { segundos: 3600 }));
    await d.eval(async (a) => { await startApp({ uid: a.id, nombre: "Mec", rol: "mecanico", origen: "supabase", activo: true, perfilId: a.id, user: null });
      window.__huecos = []; let ult = Date.now(); setInterval(() => { const n = Date.now(); if (n - ult > 300) window.__huecos.push({ desde: ult, ms: n - ult, rt: rtEstado }); ult = n; }, 100);
      window.__ev = []; const E = (x) => window.__ev.push({ t: Date.now(), ...x });
      const pe = window.pintarEstadoVivo; window.pintarEstadoVivo = function () { E({ rt: rtEstado }); return pe.apply(this, arguments); };
      for (const f of ["comprobarCuentaPropia", "cerrarPorCuentaEliminada", "denegarSesion", "ponerAlDia", "procesarAvisos", "alCambiosRemotos", "renderMiTrabajo", "flushFotosPendientes"]) { const o = window[f]; if (typeof o === "function") window[f] = function () { E({ f }); const r = o.apply(this, arguments); if (r && r.then) r.then(() => E({ f: f + ":fin" }), () => E({ f: f + ":error" })); return r; }; }
      const al = window.alert; window.alert = function (m) { E({ alert: String(m).slice(0, 80) }); }; window.confirm = function (m) { E({ confirm: String(m).slice(0, 80) }); return false; };
      window.__puente = []; const fo = window.fetch; window.fetch = function (u, i) { const url = String(u?.url || u); if (/__cmd/.test(url)) { const t = Date.now(); const p = fo.call(this, u, i); p.then(() => window.__puente.push({ pide: t, recibe: Date.now() }), () => window.__puente.push({ pide: t, error: Date.now() })); return p; } return fo.call(this, u, i); };
      return true; }, { id: PERFILES.mecanico }, { plazoMs: 60000 });
    const unir = (t) => d.eval(async (a) => { const t0 = Date.now(); window.__token = a.t; detenerRealtime(); prepararRealtime(); const lim = Date.now() + 15000; while (Date.now() < lim && !["conectado", "sin-acceso", "sin-sesion"].includes(rtEstado)) await new Promise((r) => setTimeout(r, 15)); return { demora: t0 - a.enviado, estado: rtEstado, t0 }; }, { t, enviado: Date.now() }, { plazoMs: 40000 });
    const relojes = () => { const a = Date.now(); pila.sql("select 1"); const b = Date.now(); spawnSync("docker", ["exec", "entimotors-sync-rt", "date", "+%s%3N"], { encoding: "utf8" }); nodo.push({ psql_ms: b - a, docker_exec_ms: Date.now() - b, en: a }); };
    const res = [];
    for (const seg of [2, 4, 8, 2, 4, 8, 2]) { const t = pila.jwt(PERFILES.mecanico, { segundos: seg }); const r = await unir(t); res.push({ seg, ...r }); relojes(); await new Promise((x) => setTimeout(x, seg * 1000 + 300)); }
    const puente = await d.eval(() => window.__puente, null, { plazoMs: 30000 });
    const extra = await d.eval(() => ({ huecos: window.__huecos, ev: window.__ev.slice(-40), toasts: (window.__toasts || []).slice(-10) }), null, { plazoMs: 30000 });
    console.log(`B8_DIAG_D2 ${nav} ${JSON.stringify(extra)}`);
    const huecos = puente.filter((p) => p.recibe - p.pide > 15500 || p.error);
    console.log(`B8_DIAG_D ${nav} uniones=${JSON.stringify(res)} nodo=${JSON.stringify(nodo)} peticiones_puente_largas=${JSON.stringify(huecos.map((p) => ({ ms: (p.recibe || p.error) - p.pide, error: !!p.error })))}`);
  } finally { await d.cerrar(); }
});
