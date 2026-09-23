// SYNC-9 · APP REAL «Mi Trabajo» (index.html + app.js de verdad, build de mecánico) con Storage REAL (storage-api local de la
// pila) + PostgREST/Postgres reales: foto elegida en el <input> real SIN red → recarga → con red → Storage + ligado → OTRO
// dispositivo la muestra (<img> con URL firmada que carga de verdad); sesión caducada (no sube, no se pierde); cuenta
// desactivada (fail closed, cero subidas); orden reasignada (rechazo visible en «⚠ Por revisar»); archivo que no es imagen;
// sin fuga entre usuarios del mismo navegador (Cache API / base local / estado). Todo se afirma en la NUBE.
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/sync9-app-real.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
let pila;
before(async () => { pila = await iniciarPila({ storage: true }); });
after(async () => { await pila?.detener(); });

const uno = (q) => pila.sql(q);
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(x), '[]') from (${q}) x`));
const objetos = (o) => nube(`select name from storage.objects where bucket_id = 'entimotors-taller' and name like 'ordenes/${o}/%' order by name`).map((x) => x.name);
const fotosNube = (o) => nube(`select coalesce(fotos, '[]'::jsonb) as f from public.ordenes where id = '${o}'`)[0].f;
function orden(mecanico = PERFILES.mecanico) {
  const o = crypto.randomUUID(), c = crypto.randomUUID(), m = crypto.randomUUID();
  uno(`insert into public.clientes (id, nombre, telefono) values ('${c}', 'Cliente MT', '555');
       insert into public.motos (id, cliente_id, marca, modelo, placa, km) values ('${m}', '${c}', 'Honda', 'CB', 'MT-${o.slice(0, 4)}', 1);
       insert into public.ordenes (id, cliente_id, moto_id, estado, falla, mecanico, mecanico_id, origen_trabajo) values ('${o}', '${c}', '${m}', 'recibido', 'ruido', 'Mec', '${mecanico}', 'taller');`);
  return o;
}

let n = 0;
async function abrir(nav, rol, o = {}) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `9app-${rol}-${nav}-${++n}`, pagina: "index.html", real: true, producto: "mecanico" });
  await entrar(d, rol, o);
  return d;
}
function entrar(d, rol, o = {}) {
  return d.eval(async (a) => {
    window.__toasts = [];
    window.toast = function (m) { window.__toasts.push(String(m)); };
    if (!window.__fetchReal) {
      window.__fetchReal = window.fetch.bind(window);
      window.fetch = function (url, init) {
        const u = String(url && url.url ? url.url : url);
        if (u.indexOf(window.ENTIMOTORS_SUPABASE.url) === 0 && window.__sinRed) return Promise.reject(new TypeError("Failed to fetch"));
        return window.__fetchReal(url, init);
      };
    }
    window.__sinRed = !!a.sinRed;
    window.__token = a.token;
    window.SupabaseCliente.sesion = function () { return window.__token ? { access_token: window.__token } : null; };
    window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true, usuario: a.rol + "@example.test" }; };
    window.SupabaseCliente.refrescarSesion = async function () { return { ok: !!window.__token }; };
    currentUser = { uid: a.id, nombre: a.rol, rol: "mecanico", origen: "supabase", activo: true, perfilId: a.id, user: null };
    await prepararModoNube({ rol: "mecanico", origen: "supabase", activo: true, uid: a.id, perfilId: a.id });
    window.__elegirFoto = async (ordenUid, contenido) => {   // el <input type=file> REAL de la app, con una foto hecha en canvas
      const loc = (await DB.getAll("ordenes")).find((x) => x.uid === ordenUid);
      currentOrderId = loc.id;
      let file;
      if (contenido === "texto") file = new File(["no soy una imagen"], "foto.jpg", { type: "image/jpeg" });
      else {
        const c = document.createElement("canvas"); c.width = 320; c.height = 240; const x = c.getContext("2d"); x.fillStyle = "#246"; x.fillRect(0, 0, 320, 240);
        file = new File([await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.9))], "Fotó (ñ) 1.jpg", { type: "image/jpeg" });
      }
      const dt = new DataTransfer(); dt.items.add(file);
      const inp = document.getElementById("inputFotos"); inp.files = dt.files; inp.dispatchEvent(new Event("change"));
      for (let i = 0; i < 50; i++) { await new Promise((ok) => setTimeout(ok, 100)); if ((await syncBd.blobs.todos()).length || window.__toasts.some((t) => /foto/i.test(t) && /No se pudo/.test(t))) break; }
      await new Promise((ok) => setTimeout(ok, 300));
      return loc.id;
    };
    window.__subirYSincronizar = async () => {
      for (const b of await syncBd.blobs.todos()) if (b.siguiente_en) await syncBd.transaccion(["blobs"], "readwrite", (t) => t.put("blobs", { ...b, siguiente_en: 0 }));
      await flushFotosPendientes();
      for (let i = 0; i < 40; i++) {
        const p = (await syncBd.outbox.todos()).filter((x) => x.estado === "pending" || x.estado === "syncing");
        if (!p.length) break;
        for (const x of p) if (x.siguiente_en > Date.now()) await syncBd.outbox.actualizar(x.seq, { siguiente_en: 0 });
        await syncMotor.sincronizar(); await new Promise((ok) => setTimeout(ok, 150));
      }
      await syncMotor.pullTodo();
      return (await syncBd.blobs.todos()).map((b) => b.estado);
    };
    return true;
  }, { token: pila.jwt(PERFILES[rol]), id: PERFILES[rol], rol, sinRed: !!o.sinRed });
}
async function recargar(d, rol, o = {}) {
  const marca = "m" + Math.random();
  await d.eval((m) => { window.__marca = m; setTimeout(() => location.reload(), 50); return true; }, marca);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await d.eval(() => (document.readyState === "complete" ? window.__marca || "nueva" : "cargando"), null, { plazoMs: 3000 })) === "nueva") break; } catch { /* orden perdida en la descarga */ }
  }
  await entrar(d, rol, o);
}
const paso = async (nombre, fn) => { const t0 = Date.now(); try { return await fn(); } catch (e) { throw new Error(`[paso ${nombre}, ${Date.now() - t0} ms] ${e.message}`); } };

for (const nav of NAVS) {
  describe(`SYNC-9 · app real Mi Trabajo + Storage real · ${nav}`, () => {
    const abiertos = [];
    const abrirD = async (rol, o) => { const d = await abrir(nav, rol, o); abiertos.push(d); return d; };
    after(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });

    test("foto elegida SIN red → recarga sin red (la foto persiste) → con red: UNA foto en Storage, ligada; OTRO dispositivo la MUESTRA", async () => {
      const o = orden();
      const A = await paso("abrir A", () => abrirD("mecanico"));
      await paso("sin red + foto", () => A.eval(async (u) => { window.__sinRed = true; forcedOffline = true; await window.__elegirFoto(u); return true; }, o));
      assert.deepEqual(await A.eval(async () => (await syncBd.blobs.todos()).map((b) => b.estado)), ["pendiente"]);
      await paso("recargar sin red", () => recargar(A, "mecanico", { sinRed: true }));
      assert.equal(await A.eval(async () => (await syncBd.blobs.todos()).length), 1, "el Blob sobrevivió a la recarga");
      assert.equal(objetos(o).length, 0);
      const est = await paso("volver", () => A.eval(async () => { window.__sinRed = false; forcedOffline = false; return window.__subirYSincronizar(); }));
      assert.deepEqual(est, [], "subida y quitada de la cola");
      const g = objetos(o);
      assert.equal(g.length, 1); assert.deepEqual(fotosNube(o), g);
      assert.ok(!/ñ|Fot|\(/.test(g[0]), "la ruta es propia (uuid), nunca el nombre del archivo");
      const B = await paso("abrir B", () => abrirD("mecanico"));
      const v = await paso("B muestra", () => B.eval(async (u) => {
        await syncMotor.pullTodo();
        const ord = (await DB.getAll("ordenes")).find((x) => x.uid === u);
        await renderDetalleFotos(ord);
        const imgs = [...document.querySelectorAll("#detalleFotos img")];
        for (let i = 0; i < 50 && imgs.some((im) => !im.complete); i++) await new Promise((ok) => setTimeout(ok, 100));
        return { fotos: ord.fotos, n: imgs.length, cargadas: imgs.filter((im) => im.naturalWidth > 0).length, firmada: imgs.every((im) => /\/object\/sign\//.test(im.src)) };
      }, o));
      assert.deepEqual(v.fotos, g); assert.equal(v.n, 1); assert.equal(v.cargadas, 1, "la imagen se ve de verdad"); assert.equal(v.firmada, true, "URL firmada, nunca pública");
    });

    test("sesión caducada con foto pendiente: aviso, NADA sube (ni anónimo), la foto no se pierde; con sesión nueva sube", async () => {
      const o = orden();
      const A = await paso("abrir", () => abrirD("mecanico"));
      const antes = await A.eval(async (u) => { window.__sinRed = true; await window.__elegirFoto(u); window.__sinRed = false; window.__token = null; window.__toasts = [];
        for (const b of await syncBd.blobs.todos()) await syncBd.transaccion(["blobs"], "readwrite", (t) => t.put("blobs", { ...b, siguiente_en: 0 }));
        return (await syncBd.blobs.todos())[0].intentos || 0; }, o);   // el intento SIN RED al elegirla sí cuenta (fallo de red real)
      const r = await paso("sin sesión", () => A.eval(async () => { await flushFotosPendientes(); return { blobs: (await syncBd.blobs.todos()).map((b) => [b.estado, b.intentos || 0]), toasts: window.__toasts.slice() }; }));
      assert.deepEqual(r.blobs, [["pendiente", antes]], "sigue pendiente y la sesión caducada NO gasta intentos");
      assert.ok(r.toasts.some((t) => /sesión caducó/.test(t)), JSON.stringify(r.toasts));
      assert.equal(objetos(o).length, 0);
      const est = await paso("con sesión", () => A.eval(async (t) => { window.__token = t; syncMotor.reanudar(); return window.__subirYSincronizar(); }, pila.jwt(PERFILES.mecanico)));
      assert.deepEqual(est, []); assert.equal(objetos(o).length, 1); assert.equal(fotosNube(o).length, 1);
    });

    test("cuenta DESACTIVADA con foto pendiente: fail closed (se cierra la sesión) y CERO subidas", async () => {
      const o = orden();
      const A = await paso("abrir", () => abrirD("mecanico"));
      await A.eval(async (u) => { window.__sinRed = true; await window.__elegirFoto(u); window.__sinRed = false; return true; }, o);
      uno(`update public.perfiles set activo = false where id = '${PERFILES.mecanico}'`);
      try {
        const r = await paso("inactiva", () => A.eval(async () => {
          syncMotor.reanudar(); await flushFotosPendientes();
          for (let i = 0; i < 30 && !document.getElementById("gateLogin").classList.contains("active"); i++) await new Promise((ok) => setTimeout(ok, 100));
          return { gate: document.getElementById("gateLogin").classList.contains("active"), blobs: (await syncBd.blobs.todos()).map((b) => b.estado) };
        }));
        assert.equal(r.gate, true); assert.deepEqual(r.blobs, ["pendiente"], "la foto no se pierde ni se marca rechazada");
        assert.equal(objetos(o).length, 0, "nada subió con la cuenta desactivada");
      } finally { uno(`update public.perfiles set activo = true where id = '${PERFILES.mecanico}'`); }
    });

    test("orden REASIGNADA mientras no había red: la foto se rechaza y queda VISIBLE en «⚠ Por revisar» (sin montos), se atiende con «Entendido»", async () => {
      const o = orden();
      const A = await paso("abrir", () => abrirD("mecanico"));
      await A.eval(async (u) => { window.__sinRed = true; await window.__elegirFoto(u); window.__sinRed = false; return true; }, o);
      uno(`update public.ordenes set mecanico_id = '${PERFILES.mecanico2}' where id = '${o}'`);
      const r = await paso("revisión", () => A.eval(async () => {
        for (const b of await syncBd.blobs.todos()) await syncBd.transaccion(["blobs"], "readwrite", (t) => t.put("blobs", { ...b, siguiente_en: 0 }));   // sin esperar el backoff del intento sin red
        await flushFotosPendientes();
        await renderSyncChipNube();
        const boton = document.getElementById("btnRevisionSync").textContent;
        await abrirRevisionSync();
        const texto = document.getElementById("revisionSyncLista").textContent;
        document.querySelector("[data-rev-foto]").click();
        for (let i = 0; i < 30 && document.querySelector("[data-rev-foto]"); i++) await new Promise((ok) => setTimeout(ok, 100));
        return { boton, texto, quedan: (await SyncFotos.rechazadas(syncBd)).length };
      }));
      assert.match(r.boton, /⚠ \d+ por revisar/); assert.match(r.texto, /Fotos · La nube no aceptó una foto/);
      assert.ok(!/Bearer|token|eyJ/.test(r.texto), "nada sensible en la lista");
      assert.equal(r.quedan, 0); assert.equal(objetos(o).length, 0); assert.deepEqual(fotosNube(o), []);
    });

    test("un archivo que no es imagen (aunque se llame .jpg) no entra a la cola; nada sube", async () => {
      const o = orden();
      const A = await paso("abrir", () => abrirD("mecanico"));
      const r = await A.eval(async (u) => { await window.__elegirFoto(u, "texto"); return { blobs: (await syncBd.blobs.todos()).length, toasts: window.__toasts.slice() }; }, o);
      assert.equal(r.blobs, 0); assert.ok(r.toasts.some((t) => /No se pudo procesar una foto/.test(t)), JSON.stringify(r.toasts));
      assert.equal(objetos(o).length, 0);
    });

    test("SIN FUGA entre usuarios del mismo navegador: A ve su foto, sale; B entra y no la encuentra (ni Cache API, ni su base, ni el DOM)", async () => {
      const o = orden();
      const A = await paso("abrir A", () => abrirD("mecanico"));
      await A.eval(async (u) => { await window.__elegirFoto(u); await window.__subirYSincronizar(); const ord = (await DB.getAll("ordenes")).find((x) => x.uid === u); await renderDetalleFotos(ord); await new Promise((ok) => setTimeout(ok, 800)); return true; }, o);
      assert.equal(objetos(o).length, 1);
      await paso("salir y entrar B", () => recargar(A, "mecanico2"));
      const r = await A.eval(async (u) => {
        const claves = [];
        for (const k of await caches.keys()) for (const req of await (await caches.open(k)).keys()) claves.push(req.url);
        return { cacheStorage: claves.filter((x) => /storage\/v1|\/object\//.test(x)), ordenes: (await DB.getAll("ordenes")).filter((x) => x.uid === u).length,
          base: syncBd.nombre, dom: document.getElementById("detalleFotos").innerHTML.includes(u) };
      }, o);
      assert.deepEqual(r.cacheStorage, [], "el SW no guardó fotos ni URLs firmadas");
      assert.equal(r.ordenes, 0, "B no tiene la orden de A"); assert.match(r.base, /_mec_/, "cada mecánico, su propia base");
      assert.equal(r.dom, false);
    });
  });
}
