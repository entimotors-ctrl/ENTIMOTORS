// 3.15.0 · BLOQUE 3 · RENDIMIENTO en reposo y coste de un aviso (app real + Realtime real, Chromium).
// Por dispositivo SOLO (Mi Trabajo y Taller), 60 s sin cambios: peticiones HTTP, CPU del navegador (utime+stime de sus procesos) y
// bytes del socket. Tres escenarios: 3.15 con avisos conectados · 3.15 con Realtime caído (red de seguridad 30 s) · 3.14.1 publicada
// (e807f65, B3_BASE). Además, el coste de UN aviso de asignación (bytes por el socket + la petición selectiva).
//   B3_BASE=<carpeta con taller-demo/ de e807f65> SYNC_NAVEGADORES=chromium node --test pruebas/sync/browser/b3-rendimiento.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { iniciarPila, PERFILES, REST_URL } from "./lib/pila.mjs";
import { abrirDispositivo } from "./lib/dispositivo.mjs";

const VENTANA_MS = Number(process.env.B3_VENTANA_MS || 60000);
let pila;
before(async () => { pila = await iniciarPila({ realtime: true }); });
after(async () => { await pila?.detener(); });
const R = {};

function cpuDe(perfil) {
  const pids = spawnSync("pgrep", ["-f", perfil], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  let t = 0;
  for (const p of pids) { try { const c = fs.readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" "); t += Number(c[11]) + Number(c[12]); } catch { /* terminó */ } }
  return t / 100;   // segundos (CLK_TCK = 100)
}
async function abrir(rol, { producto = null, raiz = null } = {}) {
  const d = await abrirDispositivo({ navegador: "chromium", nombre: `b3r-${rol}-${Math.random().toString(36).slice(2, 6)}`, pagina: "index.html", real: true, producto, raiz });
  await d.eval(async (a) => {
    window.toast = () => {};
    window.SupabaseCliente.sesion = () => ({ access_token: a.token }); window.SupabaseCliente.estado = () => ({ activo: true, conSesion: true }); window.SupabaseCliente.refrescarSesion = async () => ({ ok: true });
    const mec = a.rol === "mecanico";
    currentUser = { uid: a.id, nombre: a.rol, rol: a.rol, origen: "supabase", activo: true, perfilId: mec ? a.id : null };
    await prepararModoNube({ rol: a.rol, origen: "supabase", activo: true, uid: a.id, perfilId: mec ? a.id : null });
    document.getElementById("shell").classList.add("active");
    if (mec) { showView("mi-trabajo"); await renderMiTrabajo(); }
    return true;
  }, { token: pila.jwt(PERFILES[rol], { segundos: 7200 }), id: PERFILES[rol], rol });
  return d;
}
async function medir(d, etiqueta) {
  await new Promise((r) => setTimeout(r, Number(process.env.B3_ASIENTO_MS || 8000)));   // se asienta el arranque (descarga inicial, primer ciclo)
  const p0 = pila.peticiones.length, c0 = cpuDe(d.perfil), b0 = pila.realtimeMetricas();
  await new Promise((r) => setTimeout(r, VENTANA_MS));
  const pet = pila.peticiones.slice(p0).filter((p) => p.metodo !== "OPTIONS");
  const b1 = pila.realtimeMetricas();
  R[etiqueta] = { peticiones_min: Math.round(pet.filter((p) => p.metodo !== "WS").length * 60000 / VENTANA_MS), rutas: [...new Set(pet.map((p) => `${p.metodo} ${p.ruta}`))].slice(0, 12),
    cpu_s_min: Math.round((cpuDe(d.perfil) - c0) * 60000 / VENTANA_MS * 100) / 100, bytes_socket_min: Math.round(((b1.bytesAlCliente - b0.bytesAlCliente) + (b1.bytesDelCliente - b0.bytesDelCliente)) * 60000 / VENTANA_MS),
    conexiones_nuevas: b1.conexiones - b0.conexiones };
  return R[etiqueta];
}

test("Mi Trabajo en reposo: con avisos 0 peticiones/min; sin avisos (red de seguridad) no más que 3.14.1", async () => {
  const d = await abrir("mecanico", { producto: "mecanico" });
  try {
    assert.equal(await d.eval(async () => { const h = Date.now() + 15000; while (Date.now() < h) { if (rtEstado === "conectado") return true; await new Promise((r) => setTimeout(r, 50)); } return rtEstado; }), true);
    const con = await medir(d, "mitrabajo_3.15_avisos");
    assert.equal(con.peticiones_min, 0, `peticiones con avisos: ${JSON.stringify(con.rutas)}`);
    pila.realtimeCaido(true);
    const sin = await medir(d, "mitrabajo_3.15_sin_avisos");
    pila.realtimeCaido(false);
    assert.ok(sin.peticiones_min <= 8, `red de seguridad: ${sin.peticiones_min}/min`);
  } finally { await d.cerrar(); }
  if (process.env.B3_BASE) {
    const v = await abrir("mecanico", { producto: "mecanico", raiz: process.env.B3_BASE + "/taller-demo" });
    try { const base = await medir(v, "mitrabajo_3.14.1"); assert.ok(R["mitrabajo_3.15_sin_avisos"].peticiones_min <= base.peticiones_min, `3.15 sin avisos (${R["mitrabajo_3.15_sin_avisos"].peticiones_min}) ≤ 3.14.1 (${base.peticiones_min})`); }
    finally { await v.cerrar(); }
  }
});

test("Taller en reposo: con avisos 0 peticiones/min; sin avisos, lo mismo que 3.14.1", async () => {
  const d = await abrir("admin");
  try {
    assert.equal(await d.eval(async () => { const h = Date.now() + 15000; while (Date.now() < h) { if (rtEstado === "conectado") return true; await new Promise((r) => setTimeout(r, 50)); } return rtEstado; }), true);
    const con = await medir(d, "taller_3.15_avisos");
    assert.equal(con.peticiones_min, 0, `peticiones con avisos: ${JSON.stringify(con.rutas)}`);
    pila.realtimeCaido(true);
    await medir(d, "taller_3.15_sin_avisos");
    pila.realtimeCaido(false);
  } finally { await d.cerrar(); }
  if (process.env.B3_BASE) {
    const v = await abrir("admin", { raiz: process.env.B3_BASE + "/taller-demo" });
    try { await medir(v, "taller_3.14.1"); } finally { await v.cerrar(); }
  }
});

test("coste de UN aviso de asignación: bytes por el socket y la petición selectiva (sin descargar todo)", async () => {
  pila.limpiar();
  const mec = await abrir("mecanico", { producto: "mecanico" });
  try {
    await mec.eval(async () => { const h = Date.now() + 15000; while (Date.now() < h && rtEstado !== "conectado") await new Promise((r) => setTimeout(r, 50)); return rtEstado; });
    await new Promise((r) => setTimeout(r, 3000));
    const p0 = pila.peticiones.length, b0 = pila.realtimeMetricas().bytesAlCliente;
    pila.sql(`insert into public.ordenes (id, estado, falla, mecanico, mecanico_id) values ('00000000-0000-4000-9000-00000000e501', 'recibido', 'Coste de un aviso', 'Mec Uno', '${PERFILES.mecanico}')`);
    assert.ok(await mec.eval(async () => { const h = Date.now() + 5000; while (Date.now() < h) { if (document.getElementById("miTrabajoOrdenes").textContent.includes("Coste de un aviso")) return true; await new Promise((r) => setTimeout(r, 20)); } return false; }));
    await new Promise((r) => setTimeout(r, 1000));
    const pet = pila.peticiones.slice(p0).filter((p) => p.metodo !== "OPTIONS" && p.metodo !== "WS");
    const url = `${REST_URL}/rest/v1/rpc/ordenes_tecnico_mias?select=*&id=eq.00000000-0000-4000-9000-00000000e501&limit=1`;
    const cuerpo = await (await fetch(url, { headers: { apikey: "anon-sintetica", Authorization: `Bearer ${pila.jwt(PERFILES.mecanico)}` } })).text();
    R.un_aviso = { bytes_socket_al_cliente: pila.realtimeMetricas().bytesAlCliente - b0, peticiones: pet.map((p) => `${p.metodo} ${p.ruta}`), bytes_respuesta_selectiva: cuerpo.length };
    assert.equal(pet.length, 1, `una sola petición (la del registro): ${JSON.stringify(R.un_aviso.peticiones)}`);
    assert.ok(R.un_aviso.bytes_socket_al_cliente < 600, `aviso pequeño: ${R.un_aviso.bytes_socket_al_cliente} B`);
    const payload = pila.sql(`select count(*) from realtime.messages where payload->>'id' = '00000000-0000-4000-9000-00000000e501' and payload::text not like '%Coste%'`);
    assert.ok(Number(payload) >= 1, "el aviso no lleva el texto de la orden");
  } finally { await mec.cerrar(); }
});

after(() => console.log("RENDIMIENTO_B3 " + JSON.stringify(R)));
