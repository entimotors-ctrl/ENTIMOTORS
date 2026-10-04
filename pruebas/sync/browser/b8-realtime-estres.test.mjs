// 3.15.0 · BLOQUE 8 · GATE B3_REALTIME_L — ESTRÉS CONTROLADO del tiempo real (Mi Trabajo real + Supabase Realtime real de la pila).
// Registra por unión (SIN tokens): iat, exp, instante de pedido, instante de respuesta, resultado, motivo del servidor, estado de sesión,
// claims no sensibles (rol, sub = mecánico sí/no) y relojes (cliente, Postgres del laboratorio, contenedor Realtime).
//   R1 · 50 uniones seguidas con token válido (cerrar y volver a unirse)       R2 · token que CADUCA en 2/4/8 s: unirse antes → ok
//   R3 · token YA caducado (−1 s): rechazo determinista, con motivo              R4 · renovación cerca de la caducidad (access_token)
//   R5 · caducidad real + token nuevo → vuelve                                   R6 · reconexión (Realtime caído/vuelve) ×5
//   R7 · cerrar sesión + entrar otro mecánico (cambio de usuario)                R8 · usuario DESACTIVADO → fuera
//   R9 · dos dispositivos del mismo mecánico + 20 avisos → ambos todos           R10 · el escenario EXACTO de L (token de 15 s emitido
//        ANTES de abrir el navegador) ×10: cuánto margen queda entre la unión y la caducidad
//   B8_RT_SALIDA=<.jsonl>   SYNC_NAVEGADORES=chromium,firefox
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const SALIDA = process.env.B8_RT_SALIDA || null;
let pila;
before(async () => { pila = await iniciarPila({ realtime: true }); });
after(async () => { await pila?.detener(); });

const claimsDe = (t) => { const c = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()); return { iat: c.iat, exp: c.exp, role: c.role, sub_es_mecanico: c.sub === PERFILES.mecanico || c.sub === PERFILES.mecanico2 }; };
const relojLab = () => Number(pila.sql("select round(extract(epoch from clock_timestamp()) * 1000)"));
const relojRt = () => Number(spawnSync("docker", ["exec", "entimotors-sync-rt", "date", "+%s%3N"], { encoding: "utf8" }).stdout.trim()) || null;
const registrar = (fila) => { if (SALIDA) fs.appendFileSync(SALIDA, JSON.stringify(fila) + "\n"); return fila; };

async function abrirMT(nav, nombre, token, perfil = PERFILES.mecanico) {
  const d = await abrirDispositivo({ navegador: nav, nombre, pagina: "index.html", real: true, producto: "mecanico", raiz: process.env.B8_RAIZ ? process.env.B8_RAIZ + "/taller-demo" : null });
  await prepararSesion(d, token);
  if (process.env.B8_DIAG_R7) await d.eval(() => { window.__diag = [];   // diagnóstico (solo con B8_DIAG_R7): quién marca el fallo del almacén (pila), sin más espías
    for (const f of (window.__diagTodo ? ["mostrarFalloAlmacen", "denegarSesion", "cerrarPorCuentaEliminada", "comprobarCuentaPropia", "ponerAlDia"] : ["mostrarFalloAlmacen"])) { const o = window[f]; if (typeof o !== "function") continue;
      window[f] = function () { window.__diag.push({ f, t: Date.now(), arg: JSON.stringify(arguments[0] ?? null).slice(0, 100), usuario: currentUser?.uid?.slice(-4), pila: (new Error().stack || "").split("\n").slice(2, 12).map((x) => x.trim().slice(0, 70)) }); return o.apply(this, arguments); }; }
    return true; });
  await d.eval(async (a) => { await startApp({ uid: a.id, nombre: "Mec", rol: "mecanico", origen: "supabase", activo: true, perfilId: a.id, user: null }); return true; }, { id: perfil }, { plazoMs: 60000 });
  return d;
}
/** Una unión medida: pone el token, cierra el Realtime y lo vuelve a abrir; espera el resultado (conectado / rechazado). */
const unir = (d, token, { cerrar = true } = {}) => d.eval(async (a) => {
  window.__token = a.token;
  const t0 = Date.now();
  const demora_orden_ms = t0 - a.enviado;   // cuánto tardó la página en ATENDER la orden (puente/hilo ocupado)
  if (a.cerrar) { detenerRealtime(); prepararRealtime(); } else syncRt.reintentar();
  // al reintentar SIN cerrar, el estado de partida ya es «sin-acceso»: se espera a «conectado» (hasta 30 s: un latido del cliente)
  const lim = Date.now() + (a.cerrar ? 15000 : 30000);
  const fin = a.cerrar ? ["conectado", "sin-acceso", "sin-sesion"] : ["conectado"];
  while (Date.now() < lim && !fin.includes(rtEstado)) await new Promise((r) => setTimeout(r, 15));
  const canales = syncRt ? syncRt.canales(true) : {};
  const c = Object.values(canales)[0] || {};
  return { demora_orden_ms, pedido_ms: t0, respuesta_ms: Date.now(), estado: rtEstado, motivo: c.motivo || null, detalle: c.detalle || null, sesion: !!window.SupabaseCliente.sesion() };
}, { token, cerrar, enviado: Date.now() }, { plazoMs: 30000 });
const fila = (nav, caso, token, r) => registrar({ nav, caso, ...claimsDe(token), ...r, reloj_cliente_ms: r.respuesta_ms, reloj_lab_ms: relojLab(), reloj_rt_ms: relojRt(),
  margen_hasta_exp_ms: claimsDe(token).exp * 1000 - r.pedido_ms });

for (const nav of NAVS) {
  test(`R1–R9 · estrés del Realtime · ${nav}`, async () => {
    pila.limpiar();
    const d = await abrirMT(nav, `b8rt-${nav}`, pila.jwt(PERFILES.mecanico, { segundos: 3600 }));
    const R = {};
    try {
      // R1 · 50 uniones
      const r1 = [];
      for (let i = 0; i < 50; i++) { const t = pila.jwt(PERFILES.mecanico, { segundos: 120 }); r1.push(fila(nav, "R1", t, await unir(d, t))); }
      R.R1 = { uniones: r1.length, ok: r1.filter((x) => x.estado === "conectado").length, ms_max: Math.max(...r1.map((x) => x.respuesta_ms - x.pedido_ms)), fallos: r1.filter((x) => x.estado !== "conectado").map((x) => ({ estado: x.estado, motivo: x.motivo, detalle: x.detalle, margen: x.margen_hasta_exp_ms })) };
      // R2 · caduca pronto pero se une antes
      const r2 = [];
      for (const seg of [2, 4, 8, 2, 4, 8]) { const t = pila.jwt(PERFILES.mecanico, { segundos: seg }); r2.push(fila(nav, `R2-${seg}s`, t, await unir(d, t))); await new Promise((r) => setTimeout(r, seg * 1000 + 300)); }
      R.R2 = r2.map((x) => ({ caso: x.caso, estado: x.estado, margen_ms: x.margen_hasta_exp_ms, ms: x.respuesta_ms - x.pedido_ms }));
      // R3 · ya caducado
      const r3 = [];
      for (let i = 0; i < 5; i++) { const t = pila.jwt(PERFILES.mecanico, { segundos: -1 }); r3.push(fila(nav, "R3", t, await unir(d, t))); }
      R.R3 = r3.map((x) => ({ estado: x.estado, motivo: x.motivo, detalle: x.detalle }));
      // R4 · renovación cerca de la caducidad (el latido manda access_token nuevo sin cerrar el canal)
      const t4 = pila.jwt(PERFILES.mecanico, { segundos: 6 });
      const u4 = fila(nav, "R4-union", t4, await unir(d, t4));
      await new Promise((r) => setTimeout(r, 4000));
      const t4b = pila.jwt(PERFILES.mecanico, { segundos: 600 });
      await d.eval((t) => { window.__token = t; return true; }, t4b);
      // pasa la caducidad del primero: si el servidor cierra el canal, el LATIDO del cliente (≤25 s) lo vuelve a unir con el token nuevo
      const r4 = await d.eval(async () => { const t0 = Date.now(), lim = t0 + 40000; let visto = null; while (Date.now() < lim) { if (rtEstado !== "conectado" && !visto) visto = Date.now() - t0; if (visto != null && rtEstado === "conectado") return { recupera_ms: Date.now() - t0, cayo_a_ms: visto }; await new Promise((r) => setTimeout(r, 100)); } return { estado: rtEstado, cayo_a_ms: visto }; }, null, { plazoMs: 50000 });
      R.R4 = { union: u4.estado, ...r4, final: await d.eval(() => rtEstado) };
      // R5 · caducidad REAL sin renovar → se pierde; token nuevo → vuelve
      const t5 = pila.jwt(PERFILES.mecanico, { segundos: 5 });
      await unir(d, t5);
      const cae = await d.eval(async () => { const lim = Date.now() + 70000; while (Date.now() < lim) { if (rtEstado !== "conectado") return { estado: rtEstado, en_ms: Date.now() }; await new Promise((r) => setTimeout(r, 100)); } return { estado: rtEstado }; }, null, { plazoMs: 80000 });
      const t5b = pila.jwt(PERFILES.mecanico, { segundos: 600 });
      R.R5 = { tras_caducar: cae.estado, cae_tras_exp_ms: cae.en_ms ? cae.en_ms - claimsDe(t5).exp * 1000 : null, vuelve: (await unir(d, t5b, { cerrar: false })).estado };
      // R6 · reconexión ×5
      const r6 = [];
      for (let i = 0; i < 5; i++) {
        pila.realtimeCaido(true); await new Promise((r) => setTimeout(r, 1500)); pila.realtimeCaido(false);
        r6.push(await d.eval(async () => { const t0 = Date.now(), lim = t0 + 30000; while (Date.now() < lim && rtEstado !== "conectado") await new Promise((r) => setTimeout(r, 50)); return { estado: rtEstado, ms: Date.now() - t0 }; }, null, { plazoMs: 40000 }));
      }
      R.R6 = r6;
      // R7 · cambio de usuario: cerrar sesión (lo que hace «Cerrar sesión») + otro mecánico en el mismo navegador
      await d.eval(async () => { detenerRealtime(); syncMotor.detener(); return true; });
      const t7 = pila.jwt(PERFILES.mecanico2, { segundos: 600 });
      await prepararSesion(d, t7);
      if (process.env.B8_DIAG_R7) console.log("B8_DIAG_R7 " + JSON.stringify(await d.eval(() => ({ falloAlmacen: typeof falloAlmacen !== "undefined" ? falloAlmacen : "?", sync: window.ENTIMOTORS_SYNC, motor: !!syncMotor, bd: !!syncBd,
        estado: SupabaseCliente.estado(), usuario: currentUser?.uid?.slice(-4), shell: document.getElementById("shell").classList.contains("active"), diag: (window.__diag || []).slice(-12) }), null, { plazoMs: 20000 })));
      await d.eval(async (a) => { try { await startApp({ uid: a.id, nombre: "Mec Dos", rol: "mecanico", origen: "supabase", activo: true, perfilId: a.id, user: null }); }
        catch (e) { throw new Error(e.message + " · diag=" + JSON.stringify(window.__diag || null)); } return true; }, { id: PERFILES.mecanico2 }, { plazoMs: 60000 });
      R.R7 = await d.eval(async () => { const lim = Date.now() + 20000; while (Date.now() < lim && rtEstado !== "conectado") await new Promise((r) => setTimeout(r, 50)); return { estado: rtEstado, temas: Object.keys(syncRt.canales()) }; }, null, { plazoMs: 30000 });
      // R8 · el mecánico 2 es DESACTIVADO mientras está conectado → fuera (aviso de cuenta + comprobación con el servidor)
      pila.sql(`update public.perfiles set activo = false where id = '${PERFILES.mecanico2}'`);
      R.R8 = await d.eval(async () => { const lim = Date.now() + 40000; while (Date.now() < lim) { if (rtEstado !== "conectado" || !document.getElementById("shell").classList.contains("active")) return { estado: rtEstado, shell: document.getElementById("shell").classList.contains("active") }; await new Promise((r) => setTimeout(r, 100)); } return { estado: rtEstado, shell: true }; }, null, { plazoMs: 50000 });
      pila.sql(`update public.perfiles set activo = true where id = '${PERFILES.mecanico2}'`);
    } finally { await d.cerrar(); }
    // R9 · dos dispositivos del mismo mecánico + 20 asignaciones
    pila.limpiar();
    const a = await abrirMT(nav, `b8rt9a-${nav}`, pila.jwt(PERFILES.mecanico, { segundos: 3600 }));
    const b = await abrirMT(nav, `b8rt9b-${nav}`, pila.jwt(PERFILES.mecanico, { segundos: 3600 }));
    try {
      for (const d of [a, b]) await d.eval(async () => { const lim = Date.now() + 20000; while (Date.now() < lim && rtEstado !== "conectado") await new Promise((r) => setTimeout(r, 50)); return rtEstado; }, null, { plazoMs: 30000 });
      pila.sql(Array.from({ length: 20 }, (_, i) => `insert into public.ordenes (id, estado, falla, mecanico, mecanico_id) values ('00000000-0000-4000-9000-0000b8${String(i).padStart(6, "0")}', 'recibido', 'Estres R9 ${i}', 'Mec Uno', '${PERFILES.mecanico}');`).join("\n"));
      const ver = (d) => d.eval(async () => { const lim = Date.now() + 20000; while (Date.now() < lim) { const n = (await DB.getAll("ordenes")).filter((o) => /^Estres R9/.test(o.falla || "")).length; if (n === 20) return n; await new Promise((r) => setTimeout(r, 100)); } return (await DB.getAll("ordenes")).filter((o) => /^Estres R9/.test(o.falla || "")).length; }, null, { plazoMs: 30000 });
      R.R9 = { a: await ver(a), b: await ver(b) };
    } finally { await a.cerrar(); await b.cerrar(); }
    registrar({ nav, resumen: R });
    console.log(`B8_RT ${nav} ${JSON.stringify(R)}`);
    assert.equal(R.R1.ok, 50, `50/50 uniones: ${JSON.stringify(R.R1.fallos)}`);
    assert.ok(R.R2.every((x) => x.estado === "conectado"), `token que caduca pronto pero se une antes: ${JSON.stringify(R.R2)}`);
    assert.ok(R.R3.every((x) => x.estado === "sin-acceso" && x.motivo === "acceso"), `token caducado: rechazo determinista ${JSON.stringify(R.R3)}`);
    assert.equal(R.R4.final, "conectado", `renovación: el canal sigue o vuelve solo con el token nuevo: ${JSON.stringify(R.R4)}`);
    assert.equal(R.R5.vuelve, "conectado");
    assert.ok(R.R6.every((x) => x.estado === "conectado"), JSON.stringify(R.R6));
    assert.equal(R.R7.estado, "conectado"); assert.deepEqual(R.R7.temas, [`mt:${PERFILES.mecanico2}`]);
    assert.equal(R.R8.shell, false, `desactivado → fuera: ${JSON.stringify(R.R8)}`);
    assert.deepEqual(R.R9, { a: 20, b: 20 });
  });

  test(`R10 · escenario EXACTO de L ×10 (token de 15 s emitido antes de abrir) · ${nav}`, async () => {
    const r = [];
    for (let i = 0; i < 10; i++) {
      const t = pila.jwt(PERFILES.mecanico, { segundos: 15 }), emitido = Date.now();
      const d = await abrirMT(nav, `b8rtL-${nav}-${i}`, t);
      try {
        const u = await d.eval(async () => { const lim = Date.now() + 25000; while (Date.now() < lim && !["conectado", "sin-acceso", "sin-sesion"].includes(rtEstado)) await new Promise((x) => setTimeout(x, 15)); const c = Object.values(syncRt.canales(true))[0] || {}; return { estado: rtEstado, en_ms: Date.now(), motivo: c.motivo || null, detalle: c.detalle || null }; }, null, { plazoMs: 30000 });
        r.push(registrar({ nav, caso: "R10", ...claimsDe(t), emitido_ms: emitido, estado: u.estado, motivo: u.motivo, detalle: u.detalle,
          union_tras_emision_ms: u.en_ms - emitido, margen_hasta_exp_ms: claimsDe(t).exp * 1000 - u.en_ms, reloj_lab_ms: relojLab(), reloj_rt_ms: relojRt() }));
      } finally { await d.cerrar(); }
    }
    const ok = r.filter((x) => x.estado === "conectado");
    console.log(`B8_RT_L ${nav} ok ${ok.length}/10 · unión tras emisión ms: ${r.map((x) => x.union_tras_emision_ms).join(",")} · margen ms: ${r.map((x) => x.margen_hasta_exp_ms).join(",")}`);
    // si alguna falla con margen POSITIVO holgado (> 3 s), es un defecto del producto/servidor, no del reloj de la prueba
    const raros = r.filter((x) => x.estado !== "conectado" && x.margen_hasta_exp_ms > 3000);
    assert.deepEqual(raros, [], "rechazos con token todavía vigente");
  });
}
