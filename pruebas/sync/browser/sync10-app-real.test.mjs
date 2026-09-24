// SYNC-10 · APP REAL (index.html + app.js de verdad) en Chrome y Firefox contra PostgREST + Postgres reales:
//   · TELÉFONO VIEJO: entimotors_os_demo v6 con los datos de la 3.13 → actualización a 3.14 → sesión de nube → el aviso
//     los hace visibles → importador (datos del teléfono) → vista previa → confirmar → verificado → la base local sigue
//     intacta → terminar. OTRO dispositivo inicia sesión y ve lo mismo, sin demo.
//   · TELÉFONO NUEVO / nube vacía «de producción»: sin «Ver un ejemplo», sin siembra por ningún camino (botón, modo demo
//     guardado de antes, llamadas directas a seedIfEmpty/sembrarDatosPrueba), también con la nube NO vacía. El modo demo
//     LOCAL legítimo (sin nube) sigue sembrando solo en el teléfono.
//   · ARCHIVO de respaldo por el <input type=file> real: válido → importa; de EJEMPLO / roto → rechazado sin subir nada.
//   · SIN RED: no se importa. «Restaurar» y «Empezar de cero» no existen con nube.
//   · P0002 en «Mi Trabajo»: avance pendiente de una orden que el admin borró → rechazo TERMINAL visible en «⚠ Por
//     revisar», sin reintento infinito.
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/sync10-app-real.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { iniciarPila, PERFILES, RAIZ } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { paridad } from "./lib/paridad.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const FIX = path.join(RAIZ, "pruebas/sync/fixtures");
const TEXTO = fs.readFileSync(path.join(FIX, "respaldo-313-realista.json"), "utf8");
const TEXTO_DEMO = fs.readFileSync(path.join(FIX, "respaldo-313-demo.json"), "utf8");
const RESPALDO = JSON.parse(TEXTO);
const OPERATIVOS = ["clientes", "motos", "ordenes", "inventario", "citas", "cotizaciones", "ventas_rapidas", "caja_movimientos", "creditos", "categorias_inv"];
const TOTAL_313 = OPERATIVOS.reduce((a, s) => a + RESPALDO.data[s].length, 0);
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

const uno = (q) => pila.sql(q);
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (${q}) t`));
const filasNube = () => Number(uno(`select (select count(*) from public.clientes) + (select count(*) from public.motos) + (select count(*) from public.inventario)
  + (select count(*) from public.ordenes) + (select count(*) from public.citas) + (select count(*) from public.categorias_inv) + (select count(*) from public.ventas)
  + (select count(*) from public.creditos) + (select count(*) from public.caja_movimientos) + (select count(*) from public.cotizaciones)`));
const demoEnNube = () => Number(uno(`select count(*) from public.clientes where nombre in ('Carlos Reyes','Marlon Zúniga','Deysi Martínez','Ana Gómez','Roberto Cruz','Fernanda López')`));
const esperar = async (d, fn, arg, ms = 30000) => { const hasta = Date.now() + ms; let v; while (Date.now() < hasta) { v = await d.eval(fn, arg); if (v) return v; await new Promise((r) => setTimeout(r, 250)); } return v; };

/** Sesión (nube o local) por el camino REAL de arranque: startApp(sesión) → prepararModoNube → gate / shell. Sin login UI
    ni GoTrue (igual que las otras suites app-real): SupabaseCliente apunta al gateway local con un JWT sintético. */
async function arrancar(d, rol, o = {}) {
  return d.eval(async (a) => {
    window.__toasts = []; window.toast = function (m) { window.__toasts.push(String(m)); };
    window.__descargas = []; window.descargarArchivo = function (nombre, texto) { window.__descargas.push({ nombre, bytes: texto.length }); };
    window.showConfirm = async function () { return true; };
    if (!window.__fetchReal) {
      window.__fetchReal = window.fetch.bind(window);
      window.fetch = function (url, init) {
        const u = String(url && url.url ? url.url : url);
        const m = /\/rpc\/([a-z_]+)/.exec(u); if (m) (window.__rpcs = window.__rpcs || []).push(m[1]);
        if (u.indexOf(window.ENTIMOTORS_SUPABASE.url) === 0 && window.__sinRed) return Promise.reject(new TypeError("Failed to fetch"));
        return window.__fetchReal(url, init);
      };
    }
    window.__sinRed = !!a.sinRed;
    if (a.local313) {   // el teléfono ya tenía la 3.13: sus datos en entimotors_os_demo v6 (mismo esquema, mismos ids)
      const x = await openDb("entimotors_os_demo");
      const r = JSON.parse(a.local313);
      await new Promise((ok, mal) => { const t = x.transaction(Object.keys(r.data), "readwrite"); for (const [s, filas] of Object.entries(r.data)) for (const f of filas) t.objectStore(s).put(f); t.oncomplete = ok; t.onerror = () => mal(t.error); });
      x.close();
    }
    if (a.modo) localStorage.setItem("enti_modo_datos", a.modo);
    const sesion = a.local
      ? { user: "admin", nombre: "Admin local", rol: "admin", origen: "local", perfilId: null }
      : { user: a.rol + "@example.test", uid: a.id, perfilId: a.id, nombre: "Nube " + a.rol, rol: a.rol, origen: "supabase", activo: true, telefono: "" };
    if (!a.local) {
      window.__token = a.token;
      window.SupabaseCliente.sesion = function () { return window.__token ? { access_token: window.__token } : null; };
      window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true, usuario: a.rol + "@example.test" }; };
      window.SupabaseCliente.refrescarSesion = async function () { return { ok: !!window.__token }; };
    }
    await startApp(sesion);
    await new Promise((r) => setTimeout(r, 400));
    return { gate: document.getElementById("gateModo").classList.contains("active"), shell: document.getElementById("shell").classList.contains("active") };
  }, { rol, id: PERFILES[rol], token: pila.jwt(PERFILES[rol]), sinRed: !!o.sinRed, local313: o.local313 || null, modo: o.modo || null, local: !!o.local }, { plazoMs: 60000 });
}
const contarLocal = (d) => d.eval(async (ss) => { const out = {}; for (const s of ss) out[s] = (await idbGetAll(s)).length; return out; }, OPERATIVOS);
const visible = (id) => { const e = document.getElementById(id); return !!e && e.style.display !== "none" && getComputedStyle(e).display !== "none"; };

let n = 0;
for (const nav of NAVS) {
  describe(`SYNC-10 · app real · ${nav}`, () => {
    const abiertos = [];
    const abrirD = async () => { const d = await abrirDispositivo({ navegador: nav, nombre: `10app-${nav}-${++n}`, pagina: "index.html", real: true }); abiertos.push(d); return d; };
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });

    test("TELÉFONO VIEJO 3.13 → 3.14 → nube vacía: los datos locales NO quedan invisibles → importar → verificado → la base local intacta → terminar", async () => {
      pila.limpiar();
      const d = await abrirD();
      const a = await arrancar(d, "admin", { local313: TEXTO, modo: "blanco" });
      assert.equal(a.shell, true, "el teléfono ya había elegido modo: entra directo");
      const aviso = await esperar(d, () => { const e = document.getElementById("aviso313"); return e.style.display === "block" ? e.textContent : null; });
      assert.match(aviso, new RegExp(`${TOTAL_313} registros de la versión anterior`), "el aviso dice cuántos registros hay en el teléfono");
      assert.equal(filasNube(), 0, "nada se subió solo");
      const localAntes = await contarLocal(d);
      assert.equal(Object.values(localAntes).reduce((x, y) => x + y, 0), TOTAL_313);

      const prev = await d.eval(async () => {
        document.getElementById("btnAviso313").click();
        for (let i = 0; i < 40 && !document.getElementById("modalImport313").classList.contains("active"); i++) await new Promise((r) => setTimeout(r, 100));
        document.getElementById("btnImp313Local").click();
        for (let i = 0; i < 100 && !/lista para recibir|ya tiene datos|No se pudo/.test(document.getElementById("imp313Destino").textContent); i++) await new Promise((r) => setTimeout(r, 100));
        return { resumen: document.getElementById("imp313Resumen").textContent, destino: document.getElementById("imp313Destino").textContent,
          boton: document.getElementById("btnConfirmarImp313").style.display !== "none", rpcs: (window.__rpcs || []).slice() };
      }, null, { plazoMs: 30000 });
      assert.match(prev.resumen, /Clientes\s*\d+/); assert.match(prev.destino, /vacía/); assert.equal(prev.boton, true);
      assert.ok(!prev.rpcs.includes("import_iniciar") && !prev.rpcs.includes("import_aplicar_paquete"), "elegir la fuente NO importa nada");
      for (const c of RESPALDO.data.clientes) assert.ok(!prev.resumen.includes(c.nombre), "la vista previa solo muestra cantidades");

      const fin = await d.eval(async () => {
        document.getElementById("btnConfirmarImp313").click();
        for (let i = 0; i < 300 && !/Verificado|No cuadra|No se importó/.test(document.getElementById("imp313Resultado").textContent); i++) await new Promise((r) => setTimeout(r, 100));
        return { resultado: document.getElementById("imp313Resultado").textContent, descargas: window.__descargas.slice(), terminar: document.getElementById("btnFinalizarImp313").style.display !== "none",
          marca: JSON.parse(localStorage.getItem("enti_import_313")), clientesVista: (await DB.getAll("clientes")).length };
      }, null, { plazoMs: 60000 });
      assert.match(fin.resultado, /Verificado/, fin.resultado);
      assert.equal(fin.descargas.length, 1, "antes de subir se guardó una copia de los datos del teléfono");
      assert.equal(fin.marca.estado, "aplicado"); assert.equal(fin.terminar, true);
      assert.equal(fin.clientesVista, RESPALDO.data.clientes.length, "la app ya muestra los clientes (desde la nube)");
      assert.deepEqual(paridad(RESPALDO, nube), [], "MIGRATION_PARITY_CHECK");
      assert.equal(uno(`select public.verificar_invariantes()::text`), "[]");
      assert.deepEqual(await contarLocal(d), localAntes, "entimotors_os_demo NO se borró ni se tocó");

      const t = await d.eval(async () => {
        document.getElementById("btnFinalizarImp313").click();
        for (let i = 0; i < 50 && JSON.parse(localStorage.getItem("enti_import_313")).estado !== "terminado"; i++) await new Promise((r) => setTimeout(r, 100));
        document.getElementById("btnCerrarImp313").click();
        await new Promise((r) => setTimeout(r, 500));
        return { marca: JSON.parse(localStorage.getItem("enti_import_313")).estado, aviso: document.getElementById("aviso313").style.display };
      });
      assert.equal(t.marca, "terminado"); assert.equal(t.aviso, "none");
      assert.equal(nube(`select estado from public.import_lotes`)[0].estado, "confirmado");
      assert.deepEqual(await contarLocal(d), localAntes, "tras terminar, la base local sigue ahí (limpiarla es otra decisión)");
      // con nube: «Restaurar» y «Empezar de cero» no están, y sus manejadores se niegan igual
      const aj = await d.eval(async () => {
        await renderAjustes();
        const v = (id) => document.getElementById(id).style.display !== "none";
        const out = { restaurar: v("cardRestaurar"), cero: v("cardEmpezarDeCero"), importar: v("cardImport313") };
        window.__toasts = []; document.getElementById("btnEmpezarDeCero").click(); await new Promise((r) => setTimeout(r, 200));
        out.toast = window.__toasts.slice(); return out;
      });
      assert.deepEqual([aj.restaurar, aj.cero, aj.importar], [false, false, true]);
      assert.ok(aj.toast.some((x) => /no se borra nada/.test(x)));
      assert.deepEqual(await contarLocal(d), localAntes);
      assert.equal(demoEnNube(), 0);
    });

    test("MULTIDISPOSITIVO: OTRO teléfono inicia sesión y ve los mismos datos importados (sin demo, sin aviso de datos locales)", async () => {
      const d = await abrirD();
      const a = await arrancar(d, "admin");
      assert.equal(a.shell, true, "la nube ya tiene clientes: no hay gate");
      const r = await d.eval(async () => ({ clientes: (await DB.getAll("clientes")).length, motos: (await DB.getAll("motos")).length, ordenes: (await DB.getAll("ordenes")).length,
        ventas: (await DB.getAll("ventas_rapidas")).length, creditos: (await DB.getAll("creditos")).length, inventario: (await DB.getAll("inventario")).map((x) => x.cantidad).sort((p, q) => p - q),
        aviso: document.getElementById("aviso313").style.display }));
      assert.deepEqual([r.clientes, r.motos, r.ordenes, r.ventas, r.creditos],
        [RESPALDO.data.clientes.length, RESPALDO.data.motos.length, RESPALDO.data.ordenes.length, RESPALDO.data.ventas_rapidas.length, RESPALDO.data.creditos.length]);
      assert.deepEqual(r.inventario, RESPALDO.data.inventario.map((x) => x.cantidad).sort((p, q) => p - q), "stock exacto también en el otro teléfono");
      assert.equal(r.aviso, "none"); assert.equal(demoEnNube(), 0);
    });

    test("B2 · TELÉFONO NUEVO + nube VACÍA de producción: sin «Ver un ejemplo»; ni el botón, ni un modo demo guardado, ni seedIfEmpty/sembrarDatosPrueba siembran NADA", async () => {
      pila.limpiar();
      const d = await abrirD();
      const a = await arrancar(d, "admin");
      assert.equal(a.gate, true, "nube vacía y sin modo elegido: pregunta");
      const g = await d.eval(() => {
        const v = (id) => document.getElementById(id).style.display !== "none";
        return { demo: v("btnModoDemo"), importar: v("btnModoImportar"), aviso: v("gateModoNubeAviso") };
      });
      assert.deepEqual(g, { demo: false, importar: true, aviso: true });
      await d.eval(async () => { await elegirModoDatos("demo"); await seedIfEmpty(); await sembrarDatosPrueba(); await new Promise((r) => setTimeout(r, 1500)); return true; }, null, { plazoMs: 60000 });
      assert.equal(filasNube(), 0, "0 filas demo en la nube"); assert.equal(demoEnNube(), 0);
      assert.equal(await d.eval(() => localStorage.getItem("enti_modo_datos")), "blanco", "pedir «demo» en nube queda en blanco");
      assert.deepEqual(Object.values(await contarLocal(d)).reduce((x, y) => x + y, 0), 0, "ni en la nube ni en el teléfono");
      // un teléfono que en la 3.13 había elegido «Ver un ejemplo» (modo demo guardado) y ahora entra con nube
      const d2 = await abrirD();
      await arrancar(d2, "admin", { modo: "demo" });
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(filasNube(), 0, "modo demo guardado + nube vacía → 0 filas demo");
      // el cajero en un teléfono nuevo: tampoco ve el importador
      const d3 = await abrirD();
      await arrancar(d3, "cajero");
      assert.equal(await d3.eval(() => document.getElementById("btnModoImportar").style.display), "none");
    });

    test("B2 · nube NO vacía: modo demo guardado y siembras directas → 0 filas demo", async () => {
      pila.limpiar();
      uno(`insert into public.clientes (id, nombre, telefono) values ('00000000-0000-4000-9000-000000000b01', 'Cliente real', '1')`);
      const d = await abrirD();
      await arrancar(d, "admin", { modo: "demo" });
      await d.eval(async () => { await seedIfEmpty(); await sembrarDatosPrueba(); await new Promise((r) => setTimeout(r, 1500)); return true; }, null, { plazoMs: 60000 });
      assert.equal(filasNube(), 1); assert.equal(demoEnNube(), 0);
    });

    test("B2 · modo demo LOCAL legítimo (sesión local, sin nube): «Ver un ejemplo» sigue funcionando SOLO en el teléfono", async () => {
      pila.limpiar();
      const d = await abrirD();
      const a = await arrancar(d, "admin", { local: true });
      assert.equal(a.gate, true);
      const r = await d.eval(async () => {
        const vis = document.getElementById("btnModoDemo").style.display !== "none";
        document.getElementById("btnModoDemo").click();
        for (let i = 0; i < 100 && !(await idbGetAll("clientes")).length; i++) await new Promise((ok) => setTimeout(ok, 100));
        return { vis, clientes: (await idbGetAll("clientes")).map((c) => c.nombre), imp: document.getElementById("btnModoImportar").style.display };
      }, null, { plazoMs: 60000 });
      assert.equal(r.vis, true); assert.ok(r.clientes.includes("Carlos Reyes"), "el ejemplo se sembró en el teléfono"); assert.equal(r.imp, "none");
      assert.equal(filasNube(), 0, "y nada llegó a la nube");
    });

    test("ARCHIVO por el <input type=file> real: respaldo de EJEMPLO → rechazado; JSON roto → rechazado; respaldo válido → importado y verificado", async () => {
      pila.limpiar();
      const d = await abrirD();
      await arrancar(d, "admin", { modo: "blanco" });
      const elegir = (txt, nombre) => d.eval(async (a) => {
        if (!document.getElementById("modalImport313").classList.contains("active")) await abrirImport313();
        imp313Reiniciar();   // sin el texto del archivo anterior: la espera de abajo mira solo el resultado de ESTE archivo
        const dt = new DataTransfer(); dt.items.add(new File([a.txt], a.nombre, { type: "application/json" }));
        const inp = document.getElementById("inputImp313"); inp.files = dt.files; inp.dispatchEvent(new Event("change"));
        for (let i = 0; i < 100 && !/No se subió nada|lista para recibir|ya tiene datos|No se pudo/.test(document.getElementById("imp313Resumen").textContent + document.getElementById("imp313Destino").textContent); i++) await new Promise((r) => setTimeout(r, 100));
        return { resumen: document.getElementById("imp313Resumen").textContent, boton: document.getElementById("btnConfirmarImp313").style.display !== "none", rpcs: (window.__rpcs || []).slice() };
      }, { txt, nombre }, { plazoMs: 30000 });
      const demo = await elegir(TEXTO_DEMO, "entimotors-backup-demo.json");
      assert.match(demo.resumen, /datos de EJEMPLO/); assert.equal(demo.boton, false);
      const roto = await elegir(TEXTO.slice(0, 5000), "roto.json");
      assert.match(roto.resumen, /JSON dañado/); assert.equal(roto.boton, false);
      assert.ok(!roto.rpcs.includes("import_iniciar"), "nada se intentó importar");
      const ok = await elegir(TEXTO, "entimotors-backup-2026-09-23.json");
      assert.equal(ok.boton, true);
      const fin = await d.eval(async () => {
        document.getElementById("btnConfirmarImp313").click();
        for (let i = 0; i < 300 && !/Verificado|No cuadra|No se importó/.test(document.getElementById("imp313Resultado").textContent); i++) await new Promise((r) => setTimeout(r, 100));
        return { resultado: document.getElementById("imp313Resultado").textContent, descargas: window.__descargas.length };
      }, null, { plazoMs: 60000 });
      assert.match(fin.resultado, /Verificado/); assert.equal(fin.descargas, 0, "el archivo elegido ya es su propia copia");
      assert.deepEqual(paridad(RESPALDO, nube), []); assert.equal(demoEnNube(), 0);
    });

    test("SIN RED: la nube no se puede comprobar → no se ofrece importar; forzar el botón tampoco sube nada", async () => {
      pila.limpiar();
      const d = await abrirD();
      await arrancar(d, "admin", { local313: TEXTO, modo: "blanco" });
      const r = await d.eval(async () => {
        window.__sinRed = true; forcedOffline = true;
        await abrirImport313();
        document.getElementById("btnImp313Local").click();
        for (let i = 0; i < 100 && !/No se pudo comprobar|vacía/.test(document.getElementById("imp313Destino").textContent); i++) await new Promise((ok) => setTimeout(ok, 100));
        const out = { destino: document.getElementById("imp313Destino").textContent, boton: document.getElementById("btnConfirmarImp313").style.display !== "none" };
        window.__toasts = []; document.getElementById("btnConfirmarImp313").click(); await new Promise((ok) => setTimeout(ok, 500));
        out.toasts = window.__toasts.slice(); out.marca = localStorage.getItem("enti_import_313"); return out;
      }, null, { plazoMs: 30000 });
      assert.match(r.destino, /No se pudo comprobar/); assert.equal(r.boton, false);
      assert.equal(r.marca, null, "no empezó ninguna importación"); assert.equal(filasNube(), 0);
    });

    test("P0002 · «Mi Trabajo»: avance SIN RED de una orden que el admin BORRA → al volver: rechazo TERMINAL visible en «⚠ Por revisar», sin reintento infinito ni daño", async () => {
      pila.limpiar();
      const O = "00000000-0000-4000-9000-000000000c03";
      uno(`insert into public.clientes (id, nombre) values ('00000000-0000-4000-9000-000000000c01', 'Cli P2');
           insert into public.motos (id, cliente_id, marca, placa, km) values ('00000000-0000-4000-9000-000000000c02', '00000000-0000-4000-9000-000000000c01', 'Honda', 'P2-1', 1);
           insert into public.ordenes (id, cliente_id, moto_id, estado, falla, mecanico, mecanico_id, origen_trabajo)
             values ('${O}', '00000000-0000-4000-9000-000000000c01', '00000000-0000-4000-9000-000000000c02', 'recibido', 'ruido', 'Mec Uno', '${PERFILES.mecanico}', 'taller');`);
      const m = await abrirDispositivo({ navegador: nav, nombre: `10app-mec-${nav}-${++n}`, pagina: "index.html", real: true, producto: "mecanico" }); abiertos.push(m);
      const r1 = await m.eval(async (a) => {
        window.__toasts = []; window.toast = function (x) { window.__toasts.push(String(x)); };
        window.__fetchReal = window.fetch.bind(window);
        window.fetch = function (url, init) { const u = String(url && url.url ? url.url : url); if (/avanzar_orden_tecnico/.test(u)) window.__avances = (window.__avances || 0) + 1;
          if (window.__sinRed && u.indexOf(window.ENTIMOTORS_SUPABASE.url) === 0) return Promise.reject(new TypeError("Failed to fetch")); return window.__fetchReal(url, init); };
        window.SupabaseCliente.sesion = () => ({ access_token: a.token }); window.SupabaseCliente.estado = () => ({ activo: true, conSesion: true, usuario: "mecanico@example.test" });
        window.SupabaseCliente.refrescarSesion = async () => ({ ok: true });
        currentUser = { uid: a.id, nombre: "mecanico", rol: "mecanico", origen: "supabase", activo: true, perfilId: a.id, user: null };
        await prepararModoNube({ rol: "mecanico", origen: "supabase", activo: true, uid: a.id, perfilId: a.id });
        const [o] = await DB.getAll("ordenes");
        window.__sinRed = true; forcedOffline = true;
        await updateOrder(o.id, (x) => { x.estado = "diagnostico"; });
        return (await syncBd.outbox.todos()).map((x) => x.rpc);
      }, { token: pila.jwt(PERFILES.mecanico), id: PERFILES.mecanico }, { plazoMs: 60000 });
      assert.deepEqual(r1, ["avanzar_orden_tecnico"]);
      uno(`update public.ordenes set deleted_at = now() where id = '${O}'`);   // el administrador la elimina
      const r2 = await m.eval(async () => {
        window.__sinRed = false; forcedOffline = false; window.__avances = 0;
        for (let k = 0; k < 4; k++) {   // varias rondas: si fuera un error «de servidor» seguiría reintentando
          for (const x of await syncBd.outbox.todos()) if (x.estado === "pending" && x.siguiente_en > Date.now()) await syncBd.outbox.actualizar(x.seq, { siguiente_en: 0 });
          await syncMotor.sincronizar(); await new Promise((ok) => setTimeout(ok, 300));
        }
        const cola = await syncBd.outbox.todos(); const rev = await syncMotor.revision();
        return { avances: window.__avances, cola: cola.map((x) => ({ estado: x.estado, clase: x.error && x.error.clase, codigo: x.error && x.error.codigo })), rev: rev.rechazadas.map((x) => x.entidad), toasts: window.__toasts.slice() };
      }, null, { plazoMs: 60000 });
      assert.equal(r2.avances, 1, "UN intento, no uno cada ≤5 min para siempre");
      assert.deepEqual(r2.cola.map((x) => [x.estado, x.clase, x.codigo]), [["rejected", "conflicto", "23503"]]);
      assert.deepEqual(r2.rev, ["ordenes"], "a la vista en «⚠ Por revisar» (no desaparece en silencio)");
      assert.ok(r2.toasts.some((t) => /no existe/.test(t)), JSON.stringify(r2.toasts));
      assert.deepEqual(nube(`select estado, deleted_at is not null as borrada from public.ordenes where id = '${O}'`), [{ estado: "recibido", borrada: true }], "sin daño de datos");
    });
  });
}
