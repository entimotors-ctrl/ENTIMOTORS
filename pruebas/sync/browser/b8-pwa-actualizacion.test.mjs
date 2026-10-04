// 3.15.0 · BLOQUE 8 · G · ACTUALIZACIÓN REAL DE LA PWA 3.14.1 → 3.15 (Service Worker de verdad, MISMO origen, Chromium y Firefox).
// Se publica la 3.14.1 (Taller: el commit 3.14.1; Mi Trabajo: su build 3.14.1 == el público salvo el HUD de Netlify), la persona trabaja
// (un dato ya sincronizado + una operación PENDIENTE sin red), y el sitio pasa a servir el CANDIDATO 3.15.0 (staging, no publicado).
//   A · en línea: aviso → «Crear copia y actualizar» → 3.15.0
//   B · SIN RED durante el aviso: «Crear copia y actualizar» → 3.15.0 desde la caché nueva, sin red
//   C · cerrar SIN actualizar y reabrir (el worker en espera se activa al no quedar pestañas de la vieja, como dice _headers)
// En todos: IndexedDB (entimotors_sync y entimotors_os_demo) con los MISMOS registros, la operación pendiente intacta y enviada UNA vez
// al volver la red, localStorage (sesión real incluida) intacto, cachés viejas borradas, y una reapertura más sigue en 3.15.0.
//   B8_CANDIDATOS = carpeta de preparar-candidatos.sh (por defecto ../ENTIMOTORS-3.15-bloque8/candidatos)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { iniciarPila, PERFILES, RAIZ } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const CAND = path.resolve(process.env.B8_CANDIDATOS || path.join(RAIZ, "../ENTIMOTORS-3.15-bloque8/candidatos"));
const RAICES = {
  taller: { v314: path.join(CAND, "base-3.14.1/taller-demo"), v315: path.join(CAND, "taller-3.15.0") },
  mt: { v314: path.join(CAND, "base-3.14.1/mitrabajo-3.14.1"), v315: path.join(CAND, "mitrabajo-3.15.0") },
};
const CACHE_315 = Object.fromEntries(Object.entries(RAICES).map(([p, r]) => [p, (fs.readFileSync(path.join(r.v315, "sw.js"), "utf8").match(/const CACHE_NAME = "([^"]+)"/) || [])[1]]));
const ESCENARIOS = (process.env.B8_PWA_ESCENARIOS || "A,B,C").split(",");
let pila;
before(async () => { for (const p of Object.values(RAICES)) for (const r of Object.values(p)) assert.ok(fs.existsSync(path.join(r, "sw.js")), `falta ${r}`); pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });
const R = [];

const USUARIO = { taller: { uid: PERFILES.admin, nombre: "Admin", rol: "admin", perfilId: null }, mt: { uid: PERFILES.mecanico, nombre: "Mec", rol: "mecanico", perfilId: PERFILES.mecanico } };
async function arrancar(d, prod, { sinRed = false } = {}) {
  await prepararSesion(d, pila.jwt(USUARIO[prod].uid, { segundos: 7200 }));
  return d.eval(async (u) => {
    window.__sinRed = u.sinRed;
    const real = window.fetch.bind(window);
    window.fetch = (x, i) => (String(x?.url || x).indexOf(window.ENTIMOTORS_SUPABASE.url) === 0 && window.__sinRed ? Promise.reject(new TypeError("Failed to fetch")) : real(x, i));
    const { sinRed: _s, ...usuario } = u; await startApp({ ...usuario, origen: "supabase", activo: true, user: null });
    if (window.esperarDescargaArranque) await esperarDescargaArranque();
    return VERSION_APP;
  }, { ...USUARIO[prod], sinRed }, { plazoMs: 120000 });
}
// foto del dispositivo SIN pasar por la app: cada base y almacén con su número de registros, las operaciones pendientes, localStorage y cachés
const foto = (d) => d.eval(async () => {
  const abrir = (n) => new Promise((ok, mal) => { const r = indexedDB.open(n); r.onsuccess = () => ok(r.result); r.onerror = () => mal(r.error); });
  const pedir = (q) => new Promise((ok, mal) => { q.onsuccess = () => ok(q.result); q.onerror = () => mal(q.error); });
  const idb = {}; let pendientes = [];
  const nombres = (await indexedDB.databases()).map((x) => x.name).filter((n) => /^entimotors/.test(n)).sort();
  for (const n of nombres) {
    const db = await abrir(n); idb[n] = { version: db.version };
    for (const s of db.objectStoreNames) idb[n][s] = await pedir(db.transaction(s).objectStore(s).count());
    if (db.objectStoreNames.contains("outbox")) pendientes = pendientes.concat((await pedir(db.transaction("outbox").objectStore("outbox").getAll())).filter((x) => x.estado === "pending" || x.estado === "syncing").map((x) => `${n}:${x.op_id || x.id}`)).sort();
    db.close();
  }
  const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
  const reg = await navigator.serviceWorker.getRegistration();
  return { version: typeof VERSION_APP !== "undefined" ? VERSION_APP : null, idb, pendientes, ls, caches: (await caches.keys()).sort(),
    controlador: navigator.serviceWorker.controller ? new URL(navigator.serviceWorker.controller.scriptURL).pathname : null, esperando: !!reg?.waiting, instalando: !!reg?.installing,
    // qué hay en las cachés que NO son la de esta versión (diagnóstico)
    otras: Object.fromEntries(await Promise.all((await caches.keys()).filter((k) => typeof VERSION_APP === "undefined" || !k.endsWith("v" + VERSION_APP)).map(async (k) => { const c = await caches.open(k); const ent = [];
      for (const q of (await c.keys()).slice(0, 6)) { const res = await c.match(q); const u = new URL(q.url); const t = u.pathname === "/" || u.pathname.endsWith(".html") ? await res.clone().text() : "";
        ent.push(`${u.pathname}${u.search} @${(res.headers.get("date") || "").slice(17, 25)}${t ? " v" + ((t.match(/app\.js\?v=([\d.]+)/) || [])[1]) : ""}`); }
      return [k, ent]; }))), ahora: new Date().toISOString().slice(11, 19) };
}, null, { plazoMs: 30000 });
// tras una recarga/reapertura: la página nueva puede tardar; se reintenta hasta que conteste
async function esperarPagina(d, ms = 60000) {
  const h = Date.now() + ms; let e;
  while (Date.now() < h) { try { return await d.eval(() => (typeof VERSION_APP !== "undefined" && document.readyState === "complete" ? VERSION_APP : null), null, { plazoMs: 5000 }); } catch (x) { e = x; } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`la página no volvió: ${e?.message}`);
}
async function esperarVersion(d, v, ms = 60000) {
  const h = Date.now() + ms; let ult;
  while (Date.now() < h) { ult = await esperarPagina(d, ms).catch(() => null); if (ult === v) return v; await new Promise((r) => setTimeout(r, 700)); }
  return ult;
}
// los almacenes que guardan DATOS de la persona (lo de control —cursores, meta, bitácora— puede crecer al arrancar la versión nueva)
const DATOS = ["clientes", "motos", "ordenes", "orden_items", "inventario", "ventas", "creditos", "abonos", "caja", "citas", "cotizaciones", "cotizacion_items", "fotos", "mensajes", "outbox", "mapa", "blobs"];
function compararDatos(a, b) {
  const dif = [];
  for (const base of Object.keys(a.idb)) {
    if (!b.idb[base]) { dif.push(`${base} DESAPARECIÓ`); continue; }
    if (a.idb[base].version !== b.idb[base].version) dif.push(`${base}: versión ${a.idb[base].version} → ${b.idb[base].version}`);
    for (const s of DATOS) if (s in a.idb[base] && a.idb[base][s] !== b.idb[base][s]) dif.push(`${base}.${s}: ${a.idb[base][s]} → ${b.idb[base][s]}`);
    for (const s of Object.keys(a.idb[base] || {})) if (s !== "version" && !(s in (b.idb[base] || {}))) dif.push(`${base}.${s} DESAPARECIÓ`);
  }
  const lsPerdidas = Object.keys(a.ls).filter((k) => b.ls[k] === undefined);
  return { dif, lsPerdidas, lsCambiadas: Object.keys(a.ls).filter((k) => b.ls[k] !== undefined && b.ls[k] !== a.ls[k]) };
}

for (const nav of NAVS) for (const prod of ["taller", "mt"]) for (const esc of ESCENARIOS) test(`PWA 3.14.1 → 3.15.0 · ${prod} · ${esc} · ${nav}`, async () => {
  pila.limpiar();
  const ord = crypto.randomUUID(), cli = crypto.randomUUID(), moto = crypto.randomUUID();
  if (prod === "mt") pila.sql(`insert into public.clientes (id, nombre) values ('${cli}', 'Cliente G'); insert into public.motos (id, cliente_id, marca, modelo, placa) values ('${moto}', '${cli}', 'Honda', 'CB', 'G-1');
    insert into public.ordenes (id, cliente_id, moto_id, estado, falla, mecanico, mecanico_id, origen_trabajo) values ('${ord}', '${cli}', '${moto}', 'recibido', 'Prueba G', 'Mec Uno', '${PERFILES.mecanico}', 'taller');`);
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8pwa-${prod}-${esc}-${nav}`, pagina: "index.html", real: true, raiz: RAICES[prod].v314, plazoApertura: 60000 });
  const r = { nav, prod, esc };
  try {
    r.version_inicial = await arrancar(d, prod);
    assert.equal(r.version_inicial, "3.14.1");
    // el SW 3.14.1 controla la página
    await d.eval(async () => { await navigator.serviceWorker.ready; const h = Date.now() + 20000; while (!navigator.serviceWorker.controller && Date.now() < h) await new Promise((x) => setTimeout(x, 100)); return !!navigator.serviceWorker.controller; }, null, { plazoMs: 30000 });
    // trabajo: un dato YA en la nube y una operación PENDIENTE (sin red)
    await d.eval(async (a) => {
      const vaciar = async () => { const h = Date.now() + 30000; while (Date.now() < h) { await syncMotor.sincronizar(); if (!(await syncBd.outbox.todos()).some((q) => q.estado === "pending" || q.estado === "syncing")) return; await new Promise((x) => setTimeout(x, 200)); } };
      if (a.prod === "taller") {
        await DB.save("clientes", { nombre: "G sincronizado", telefono: "1" }); await vaciar();
        window.__sinRed = true; await DB.save("clientes", { nombre: "G pendiente", telefono: "2" });
      } else {
        const o = (await DB.getAll("ordenes")).find((x) => x.uid === a.ord); if (!o) throw new Error("la orden no bajó");
        window.__sinRed = true; await updateOrder(o.id, (x) => { x.estado = "diagnostico"; });
      }
      return true;
    }, { prod, ord }, { plazoMs: 60000 });
    const antes = await foto(d);
    r.antes = { version: antes.version, caches: antes.caches, pendientes: antes.pendientes.length };
    assert.ok(antes.pendientes.length >= 1, "hay una operación pendiente antes de actualizar");
    // se publica el candidato 3.15.0 en el mismo origen
    d.servir(RAICES[prod].v315);
    const aviso = await d.eval(async () => {
      const reg = await navigator.serviceWorker.getRegistration(); await reg.update();
      let h = Date.now() + 40000; while (!reg.waiting && Date.now() < h) await new Promise((x) => setTimeout(x, 150));
      h = Date.now() + 10000; while (!document.getElementById("modalVersionNueva")?.classList.contains("active") && Date.now() < h) await new Promise((x) => setTimeout(x, 100));
      return { esperando: !!reg.waiting, aviso: !!document.getElementById("modalVersionNueva")?.classList.contains("active"), version: VERSION_APP };
    }, null, { plazoMs: 70000 });
    r.aviso = aviso;
    assert.deepEqual(aviso, { esperando: true, aviso: true, version: "3.14.1" }, "la 3.15 queda ESPERANDO, se avisa, y la 3.14.1 sigue funcionando (nada automático)");
    if (esc === "B") d.redApp(false);   // SIN red para los archivos de la app (la nube también está cortada desde antes)
    if (esc === "A" || esc === "B") {
      // la página se recarga sola al activarse la 3.15 (controllerchange): la respuesta de este eval puede no llegar
      r.clic_t = new Date().toISOString().slice(11, 19);
      await d.eval(() => { setTimeout(() => document.getElementById("btnCopiaYActualizar").click(), 50); return true; }, null, { plazoMs: 10000 });
    } else {
      // Chromium escribe localStorage a disco en lotes diferidos (unos segundos): cerrar a los ~3 s de la primera escritura de la
      // sesión la pierde con o sin actualización (propiedad del navegador, no de la 3.15). Pausa realista antes de cerrar.
      await new Promise((x) => setTimeout(x, 7000));
      await d.reabrir(90000);
      await esperarPagina(d, 60000);
      // Firefox atiende la primera navegación tras reabrir con el worker VIEJO (la 3.15 sigue esperando; la página es la 3.15 porque la
      // 3.14.1 es red-primero) — conforme al spec y al diseño («la nueva espera a que se cierre la anterior»; «Ahora no» no reabre el aviso).
      // Chromium activa la nueva al arrancar. En los dos: datos intactos YA; y si sigue esperando, se termina por el camino normal.
      const f = await foto(d);
      r.tras_reabrir = { version: f.version, esperando: f.esperando, instalando: f.instalando, caches: f.caches, dif: compararDatos(antes, f).dif, pendientes_iguales: JSON.stringify(f.pendientes) === JSON.stringify(antes.pendientes) };
      assert.deepEqual(r.tras_reabrir.dif, [], "datos intactos al reabrir con la 3.15 esperando o ya activa");
      assert.equal(r.tras_reabrir.pendientes_iguales, true, "la operación pendiente sigue");
      // Firefox no conserva el worker en espera al reiniciar: lo vuelve a instalar con la comprobación del arranque → se espera a que quede listo
      const pendiente315 = f.esperando || f.instalando || await d.eval(async () => { const reg = await navigator.serviceWorker.getRegistration(); const h = Date.now() + 20000;
        while (Date.now() < h && !reg.waiting) { if (navigator.serviceWorker.controller && caches && (await caches.keys()).length === 1) break; await new Promise((x) => setTimeout(x, 200)); } return !!reg.waiting; }, null, { plazoMs: 30000 });
      r.tras_reabrir.pendiente315 = pendiente315;
      if (pendiente315) {
        await arrancar(d, prod, { sinRed: true });   // la persona entra (la nube sigue cortada: lo pendiente sigue pendiente)
        r.buscar = await d.eval(async () => { const r = await buscarActualizacion(); return { r, aviso: !!document.getElementById("modalVersionNueva")?.classList.contains("active") }; }, null, { plazoMs: 40000 });
        assert.deepEqual(r.buscar, { r: "nueva", aviso: true }, "«Buscar actualización» encuentra la 3.15 esperando y abre el aviso");
        await d.eval(async () => { const reg = await navigator.serviceWorker.getRegistration(); const w = reg.waiting; const t0 = Date.now();
          const anotar = (x) => { try { const a = JSON.parse(sessionStorage.getItem("__diag") || "[]"); a.push({ t: Date.now() - t0, ...x }); sessionStorage.setItem("__diag", JSON.stringify(a)); } catch (e) {} };
          w.addEventListener("statechange", () => anotar({ w: w.state })); navigator.serviceWorker.addEventListener("controllerchange", () => anotar({ cc: 1 }));
          window.addEventListener("beforeunload", () => anotar({ unload: 1, w: w.state }));
          setTimeout(() => document.getElementById("btnCopiaYActualizar").click(), 50); return true; }, null, { plazoMs: 10000 });
      }
    }
    if (esc === "C") {
      // la página YA era 3.15 (servida por el worker viejo): lo que se espera es el CAMBIO de worker (sin ninguno en espera), que recarga
      const h = Date.now() + 60000; let ok = false;
      while (Date.now() < h && !ok) { ok = await d.eval(async () => { const reg = await navigator.serviceWorker.getRegistration(); return document.readyState === "complete" && !reg.waiting && !reg.installing; }, null, { plazoMs: 5000 }).catch(() => false); if (!ok) await new Promise((x) => setTimeout(x, 700)); }
      await new Promise((x) => setTimeout(x, 3000));   // la recarga de respaldo (2,5 s) del botón puede llegar después del cambio
      r.diag = await d.eval(() => sessionStorage.getItem("__diag"), null, { plazoMs: 10000 }).catch(() => null);
    }
    r.version_tras = await esperarVersion(d, "3.15.0", 60000);
    // el activate de la 3.15 borra la caché vieja dentro de su waitUntil: se da hasta 15 s (y se anota cuánto tardó)
    r.caches_ms = await d.eval(async (c) => { const t0 = Date.now(); while (Date.now() - t0 < 15000) { const k = await caches.keys(); if (k.length === 1 && k[0] === c) break; await new Promise((x) => setTimeout(x, 200)); } return Date.now() - t0; }, CACHE_315[prod], { plazoMs: 20000 });
    const despues = await foto(d);
    r.despues = { version: despues.version, esperando: despues.esperando, caches: despues.caches, otras: despues.otras, ahora: despues.ahora, pendientes: despues.pendientes.length, controlador: despues.controlador };
    r.integridad = compararDatos(antes, despues);
    assert.equal(despues.version, "3.15.0", `pasó a 3.15.0 (${esc}): ${JSON.stringify(r.despues)}`);
    assert.deepEqual(despues.caches, [CACHE_315[prod]], "solo la caché nueva: la 3.14.1 se borró");
    assert.deepEqual(r.integridad.dif, [], "IndexedDB con los mismos datos y la misma versión de esquema");
    assert.deepEqual(despues.pendientes, antes.pendientes, "la operación pendiente sigue, la misma");
    assert.deepEqual(r.integridad.lsPerdidas, [], "localStorage (sesión real incluida) intacto");
    // vuelve la red: la operación pendiente llega UNA vez
    d.redApp(true);
    assert.equal(await arrancar(d, prod), "3.15.0");
    await d.eval(async () => { const h = Date.now() + 40000; while (Date.now() < h) { await syncMotor.sincronizar(); if (!(await syncBd.outbox.todos()).some((q) => q.estado === "pending" || q.estado === "syncing")) break; await new Promise((x) => setTimeout(x, 250)); }
      return (await syncBd.outbox.todos()).filter((q) => q.estado === "rejected").length; }, null, { plazoMs: 60000 }).then((rech) => { r.rechazadas = rech; });
    assert.equal(r.rechazadas, 0);
    if (prod === "taller") assert.equal(pila.sql(`select count(*) || '|' || (select count(*) from public.clientes where nombre = 'G sincronizado') from public.clientes where nombre = 'G pendiente'`), "1|1", "cada cliente UNA vez en la nube");
    else assert.equal(pila.sql(`select estado from public.ordenes where id = '${ord}'`), "diagnostico", "el avance pendiente del mecánico llegó");
    // D · reabrir una vez más: sigue en 3.15.0, con sus datos
    const f1 = await foto(d);
    await new Promise((x) => setTimeout(x, 7000));   // ver el cierre de C: localStorage se escribe a disco en diferido
    await d.reabrir(90000);
    r.version_reabrir = await esperarVersion(d, "3.15.0", 60000);
    const f2 = await foto(d);
    r.reabrir = compararDatos(f1, f2);
    if (process.env.B8_PWA_DIAG) { r.paginas = []; for (let i = 0; i < 6; i++) r.paginas.push(await d.eval(async () => ({ hl: history.length, opener: !!window.opener, ref: document.referrer, top: window.top === window, dbs: (await indexedDB.databases()).length, ls: localStorage.length, vis: document.visibilityState, url: location.pathname + location.search + location.hash, nombre: window.name }), null, { plazoMs: 10000 })); }
    if (r.reabrir.dif.length && process.env.B8_PWA_DIAG) {   // diagnóstico: qué hay en disco y qué origen ve la página
      const lista = (dir, prof = 0) => { try { return fs.readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return prof < 2 && fs.statSync(p).isDirectory() ? [n + "/", ...lista(p, prof + 1).map((x) => "  " + n + "/" + x)] : [n]; }); } catch (e) { return [String(e.message)]; } };
      r.diag_disco = lista(path.join(d.perfil, "storage", "default")).slice(0, 40);
      r.diag_pagina = await d.eval(async () => ({ origen: location.origin, dbs: (await indexedDB.databases()).map((x) => x.name), ls: localStorage.length, persist: await navigator.storage.persisted(), est: await navigator.storage.estimate() }), null, { plazoMs: 10000 });
      await new Promise((x) => setTimeout(x, 5000));
      r.diag_pagina_5s = await d.eval(async () => ({ dbs: (await indexedDB.databases()).map((x) => x.name), ls: localStorage.length }), null, { plazoMs: 10000 });
    }
    assert.equal(r.version_reabrir, "3.15.0"); assert.deepEqual(r.reabrir.dif, []); assert.deepEqual(r.reabrir.lsPerdidas, []);
  } finally {
    console.log(`B8_PWA ${JSON.stringify(r)}`); R.push(r);
    await d.cerrar();
  }
});
