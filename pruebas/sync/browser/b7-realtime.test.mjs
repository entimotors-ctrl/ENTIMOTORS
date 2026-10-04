// 3.15.0 · BLOQUE 7 · RENDIMIENTO DEL TIEMPO REAL (app real Mi Trabajo + Supabase Realtime real de la pila, Chromium y Firefox).
//   · conexión: del arranque a «conectado»      · un aviso: latencia servidor → pantalla (mediana de 5), bytes por el socket
//   · ráfaga de 100 asignaciones en <1 s: cuánto tarda en estar TODO en pantalla, cuántas peticiones (se agrupan) y que no se pierde ninguna
//   · reconexión: se corta el Realtime, pasan cosas, vuelve → lo ocurrido llega (sin polling constante mientras está conectado)
//   B7_RAIZ / B7_ETIQUETA / B7_SALIDA como las demás pruebas del Bloque 7.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion, anotar } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const RAIZ = process.env.B7_RAIZ ? process.env.B7_RAIZ + "/taller-demo" : null;
const ETQ = process.env.B7_ETIQUETA || "despues";
const SALIDA = process.env.B7_SALIDA || null;
let pila;
before(async () => { pila = await iniciarPila({ realtime: true }); });
after(async () => { await pila?.detener(); });
const mediana = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const idOrden = (n) => `00000000-0000-4000-9000-0000b7${String(n).padStart(6, "0")}`;
const enPantalla = (d, textos, ms) => d.eval(async (a) => {
  const t0 = performance.now(), h = Date.now() + a.ms;
  while (Date.now() < h) { const txt = document.getElementById("miTrabajoOrdenes").textContent; if (a.textos.every((x) => txt.includes(x))) return Math.round(performance.now() - t0); await new Promise((r) => setTimeout(r, 15)); }
  return null;
}, { textos, ms }, { plazoMs: ms + 10000 });

for (const nav of NAVS) test(`REALTIME · Mi Trabajo · ${nav} · ${ETQ}`, async () => {
  pila.limpiar();
  const d = await abrirDispositivo({ navegador: nav, nombre: `b7rt-${nav}`, pagina: "index.html", real: true, producto: "mecanico", raiz: RAIZ });
  const R = {};
  try {
    await prepararSesion(d, pila.jwt(PERFILES.mecanico, { segundos: 7200 }));
    R.conexion_ms = await d.eval(async (a) => {
      const t0 = performance.now();
      await startApp({ uid: a.id, nombre: "Mec Uno", rol: "mecanico", origen: "supabase", activo: true, perfilId: a.id, user: null });
      const h = Date.now() + 20000; while (Date.now() < h && rtEstado !== "conectado") await new Promise((r) => setTimeout(r, 20));
      return rtEstado === "conectado" ? Math.round(performance.now() - t0) : null;
    }, { id: PERFILES.mecanico }, { plazoMs: 60000 });
    assert.ok(R.conexion_ms, "Realtime conecta");
    await new Promise((r) => setTimeout(r, 1500));
    // un aviso: latencia (mediana de 5) y coste
    const lat = []; let bytes = 0, pets = 0;
    for (let i = 1; i <= 5; i++) {
      const b0 = pila.realtimeMetricas().bytesAlCliente, p0 = pila.peticiones.length;
      const t0 = Date.now();
      pila.sql(`insert into public.ordenes (id, estado, falla, mecanico, mecanico_id) values ('${idOrden(i)}', 'recibido', 'Aviso B7 ${i}', 'Mec Uno', '${PERFILES.mecanico}')`);
      const vis = await enPantalla(d, [`Aviso B7 ${i}`], 10000);
      lat.push(vis == null ? null : Date.now() - t0);
      await new Promise((r) => setTimeout(r, 400));
      bytes += pila.realtimeMetricas().bytesAlCliente - b0; pets += pila.peticiones.slice(p0).filter((x) => x.metodo !== "OPTIONS" && x.metodo !== "WS").length;
    }
    R.un_aviso = { latencias_ms: lat, mediana_ms: mediana(lat.filter((x) => x != null)), bytes_socket_por_aviso: Math.round(bytes / 5), peticiones_por_aviso: pets / 5 };
    // ráfaga de 100 asignaciones en una sola sentencia (una operación grande) y en 100 sentencias seguidas
    for (const modo of ["una_sentencia", "cien_sentencias"]) {
      const base = modo === "una_sentencia" ? 100 : 300;
      const p0 = pila.peticiones.length, b0 = pila.realtimeMetricas().bytesAlCliente;
      const t0 = Date.now();
      if (modo === "una_sentencia") pila.sql(`insert into public.ordenes (id, estado, falla, mecanico, mecanico_id) select ('00000000-0000-4000-9000-0000b7' || lpad((${base} + g)::text, 6, '0'))::uuid, 'recibido', 'Rafaga B7 ' || (${base} + g), 'Mec Uno', '${PERFILES.mecanico}' from generate_series(1, 100) g`);
      else pila.sql(Array.from({ length: 100 }, (_, g) => `insert into public.ordenes (id, estado, falla, mecanico, mecanico_id) values ('${idOrden(base + g + 1)}', 'recibido', 'Rafaga B7 ${base + g + 1}', 'Mec Uno', '${PERFILES.mecanico}');`).join("\n"));
      const envio = Date.now() - t0;
      const vis = await enPantalla(d, [`Rafaga B7 ${base + 1}`, `Rafaga B7 ${base + 50}`, `Rafaga B7 ${base + 100}`], 30000);
      const todo = vis == null ? null : Date.now() - t0;
      await new Promise((r) => setTimeout(r, 1500));
      const cuenta = await d.eval(async (b) => (await DB.getAll("ordenes")).filter((o) => /^Rafaga B7 /.test(o.falla || "") && Number(o.falla.slice(10)) > b && Number(o.falla.slice(10)) <= b + 100).length, base);
      R[`rafaga_100_${modo}`] = { envio_servidor_ms: envio, todo_en_pantalla_ms: todo, en_cache: cuenta, peticiones: pila.peticiones.slice(p0).filter((x) => x.metodo !== "OPTIONS" && x.metodo !== "WS").length,
        kb_socket: Math.round((pila.realtimeMetricas().bytesAlCliente - b0) / 1024) };
      assert.equal(cuenta, 100, `${modo}: las 100 llegaron, ninguna perdida`);
    }
    // reposo: con avisos conectados, sin polling constante (30 s). Antes se espera a que la RÁFAGA termine de procesarse (3 s sin
    // ninguna petición): lo que queda de sus avisos no es «polling».
    for (let q = 0; q < 60; q++) { const n0 = pila.peticiones.length; await new Promise((r) => setTimeout(r, 3000)); if (pila.peticiones.length === n0) break; }
    const p0 = pila.peticiones.length; await new Promise((r) => setTimeout(r, 30000));
    const reposo = pila.peticiones.slice(p0).filter((x) => x.metodo !== "OPTIONS" && x.metodo !== "WS");
    R.reposo_30s_peticiones = reposo.length; R.reposo_rutas = [...new Set(reposo.map((x) => `${x.metodo} ${x.ruta}`))];
    // reconexión
    pila.realtimeCaido(true);
    await new Promise((r) => setTimeout(r, 2000));
    pila.sql(`insert into public.ordenes (id, estado, falla, mecanico, mecanico_id) values ('${idOrden(900)}', 'recibido', 'Mientras caido B7', 'Mec Uno', '${PERFILES.mecanico}')`);
    const t0 = Date.now();
    pila.realtimeCaido(false);
    const vis = await enPantalla(d, ["Mientras caido B7"], 60000);
    R.reconexion = { lo_ocurrido_en_pantalla_ms: vis == null ? null : Date.now() - t0, estado: await d.eval(() => rtEstado) };
    anotar(SALIDA, `${ETQ}|${nav}|realtime`, R);
    assert.ok(R.un_aviso.mediana_ms != null && R.un_aviso.mediana_ms < 2000, `un aviso < 2 s (mediana ${R.un_aviso.mediana_ms})`);
    assert.equal(R.reposo_30s_peticiones, 0, "sin polling con los avisos conectados");
    assert.ok(R.reconexion.lo_ocurrido_en_pantalla_ms != null, "lo ocurrido con el Realtime caído llega al reconectar");
  } finally { await d.cerrar(); }
});
