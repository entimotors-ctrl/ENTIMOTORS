// 3.15.0 · BLOQUE 8 · CARRERA en el CAMBIO DE USUARIO (causa del fallo de b8-realtime-estres R7): una puesta al día de la sesión
// anterior que termina mientras la nueva prepara su almacén (syncBd momentáneamente nulo) pintaba, encontraba «sin almacén» y dejaba
// marcado el fallo → la sesión NUEVA arrancaba con «ALMACEN_NO_DISPONIBLE» (falso). Cadena medida: alCambiosRemotos → renderMiTrabajo →
// DB.getAll → exigirAlmacen. Determinista: la base nueva tarda 4 s en abrir y en medio se repinta. B8_RAIZ=<árbol> = otra versión (la anterior FALLA).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES, RED } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const RAIZ_APP = process.env.B8_RAIZ ? process.env.B8_RAIZ + "/taller-demo" : null;
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { Object.assign(RED, { latenciaMs: 0, kbps: 0 }); await pila?.detener(); });

for (const nav of NAVS) test(`cambio de usuario con una puesta al día en curso: la sesión nueva arranca bien · ${nav}`, async () => {
  pila.limpiar();
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8-carrera-${nav}`, pagina: "index.html", real: true, producto: "mecanico", raiz: RAIZ_APP });
  try {
    await prepararSesion(d, pila.jwt(PERFILES.mecanico, { segundos: 3600 }));
    await d.eval(async (id) => { await startApp({ uid: id, nombre: "Mec", rol: "mecanico", origen: "supabase", activo: true, perfilId: id, user: null }); return true; }, PERFILES.mecanico, { plazoMs: 60000 });
    Object.assign(RED, { latenciaMs: 1500, kbps: 0 });   // la puesta al día de la sesión anterior tarda
    await d.eval(() => { window.__pad = ponerAlDia("reconexion"); return true; }, null, { plazoMs: 10000 });
    await prepararSesion(d, pila.jwt(PERFILES.mecanico2, { segundos: 3600 }));
    const r = await d.eval(async (id) => {
      try { detenerRealtime(); } catch (e) { /* */ } try { syncMotor?.detener(); } catch (e) { /* */ }
      // ventana DETERMINISTA: la base de la sesión nueva tarda 4 s en abrir; la puesta al día vieja (red de 1,5 s) termina dentro
      const abrir = SyncDB.abrirSeguro; SyncDB.abrirSeguro = async (o) => { await new Promise((x) => setTimeout(x, 4000)); return abrir.call(SyncDB, o); };
      let error = null;
      const arranque = startApp({ uid: id, nombre: "Mec Dos", rol: "mecanico", origen: "supabase", activo: true, perfilId: id, user: null }).catch((e) => { error = String(e.message).slice(0, 80); });
      // DENTRO de la ventana (la base nueva aún no abrió): llega un aviso / termina una puesta al día de la sesión anterior → repintar
      await new Promise((x) => setTimeout(x, 800));
      try { await alCambiosRemotos([{ ent: "*" }]); } catch (e) { /* lo que pinte por su cuenta */ }
      await arranque;
      await Promise.race([window.__pad, new Promise((x) => setTimeout(x, 20000))]);   // la puesta al día vieja termina
      await new Promise((x) => setTimeout(x, 500));
      return { error, falloAlmacen: falloAlmacen ? falloAlmacen.tipo || "sí" : null, shell: document.getElementById("shell").classList.contains("active"),
        gateAlmacen: document.getElementById("gateAlmacen")?.classList.contains("active") || false, usuario: currentUser?.uid?.slice(-4),
        leer: await DB.getAll("clientes").then(() => "ok", (e) => String(e.message).slice(0, 60)) };
    }, PERFILES.mecanico2, { plazoMs: 90000 });
    Object.assign(RED, { latenciaMs: 0, kbps: 0 });
    console.log(`B8_CARRERA ${nav} ${JSON.stringify(r)}`);
    assert.deepEqual(r, { error: null, falloAlmacen: null, shell: true, gateAlmacen: false, usuario: PERFILES.mecanico2.slice(-4), leer: "ok" });
  } finally { Object.assign(RED, { latenciaMs: 0, kbps: 0 }); await d.cerrar(); }
});
