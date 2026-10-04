// 3.15.0 · BLOQUE 8 · FOTOS DEL MECÁNICO → TALLER (app real Taller + Mi Trabajo, Storage real y Realtime real de la pila).
//   F1 · el mecánico toma una foto en Mi Trabajo → sube a Storage y se liga (agregar_foto_orden) → el Taller, con ESA orden abierta y sin
//        recargar, la muestra sola (aviso en vivo + URL firmada que carga de verdad). La caja también la ve.
//   F2 · el Taller NO sube sus propias fotos ni pisa la evidencia al editar la orden (fotos de la nube intactas); sus fotos locales siguen.
//   F3 · otro mecánico NO puede firmar la ruta (Storage niega) — la evidencia es del taller, no de cualquiera.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
let pila;
before(async () => { pila = await iniciarPila({ storage: true, realtime: true }); });
after(async () => { await pila?.detener(); });
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(x), '[]') from (${q}) x`));
const fotosNube = (o) => nube(`select coalesce(fotos, '[]'::jsonb) as f from public.ordenes where id = '${o}'`)[0].f;

async function taller(nav, rol) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8f-${rol}-${nav}`, pagina: "index.html", real: true });
  await prepararSesion(d, pila.jwt(PERFILES[rol], { segundos: 3600 }));
  await d.eval(async (a) => { await startApp({ uid: a.id, nombre: a.rol, rol: a.rol, origen: "supabase", activo: true, perfilId: null, user: null });
    if (window.esperarDescargaArranque) await esperarDescargaArranque();
    const h = Date.now() + 20000; while (Date.now() < h && rtEstado !== "conectado") await new Promise((r) => setTimeout(r, 50));
    return rtEstado; }, { id: PERFILES[rol], rol }, { plazoMs: 90000 });
  return d;
}
async function mitrabajo(nav, perfil) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8f-mt-${nav}-${perfil.slice(-2)}`, pagina: "index.html", real: true, producto: "mecanico" });
  await prepararSesion(d, pila.jwt(perfil, { segundos: 3600 }));
  await d.eval(async (a) => { await startApp({ uid: a.id, nombre: "Mec", rol: "mecanico", origen: "supabase", activo: true, perfilId: a.id, user: null }); return true; }, { id: perfil }, { plazoMs: 90000 });
  return d;
}
const verFotosNube = (d, u, ms) => d.eval(async (a) => {
  const h = Date.now() + a.ms;
  while (Date.now() < h) {
    const imgs = [...document.querySelectorAll("#detalleFotos img[data-foto-nube]")];
    if (imgs.length && imgs.every((im) => im.complete)) return { n: imgs.length, cargadas: imgs.filter((im) => im.naturalWidth > 0).length, firmadas: imgs.every((im) => /\/object\/sign\//.test(im.src)), locales: document.querySelectorAll("#detalleFotos img:not([data-foto-nube])").length, t: Date.now() };
    await new Promise((r) => setTimeout(r, 100));
  }
  const loc = (await DB.getAll("ordenes")).find((x) => x.uid === a.u);
  return { n: 0, texto: document.getElementById("detalleFotos").textContent.slice(0, 120), html: document.getElementById("detalleFotos").innerHTML.slice(0, 160),
    fotosNube: loc && loc.fotosNube, fotosLocales: loc && (loc.fotos || []).length, rev: loc && loc._rev, avisos: syncRt && syncRt.metricas().avisos, cursor: await syncBd.cursor.get("ordenes"),
    rol: currentUser && currentUser.rol, vista: document.querySelector(".view.active")?.id, abierta: currentOrderId, idLocal: loc && loc.id, rt: rtEstado };
}, { u, ms }, { plazoMs: ms + 10000 });

for (const nav of NAVS) test(`FOTOS mecánico → Taller · ${nav}`, async () => {
  pila.limpiar();
  const o = crypto.randomUUID(), c = crypto.randomUUID(), m = crypto.randomUUID();
  pila.sql(`insert into public.clientes (id, nombre) values ('${c}', 'Cliente fotos'); insert into public.motos (id, cliente_id, marca, modelo, placa) values ('${m}', '${c}', 'Honda', 'CB', 'FT-1');
    insert into public.ordenes (id, cliente_id, moto_id, estado, falla, mecanico, mecanico_id, origen_trabajo) values ('${o}', '${c}', '${m}', 'diagnostico', 'Evidencia B8', 'Mec Uno', '${PERFILES.mecanico}', 'taller');`);
  const adm = await taller(nav, "admin"), caja = await taller(nav, "cajero"), mec = await mitrabajo(nav, PERFILES.mecanico);
  try {
    // el Taller abre la orden y le agrega una foto PROPIA (local, como siempre)
    const abrirOrden = (d) => d.eval(async (u) => { const loc = (await DB.getAll("ordenes")).find((x) => x.uid === u); showView("ordenes"); await openOrder(loc.id); return loc.id; }, o, { plazoMs: 30000 });
    const idAdm = await abrirOrden(adm); await abrirOrden(caja);
    await adm.eval(async (id) => { await updateOrder(id, (ord) => { ord.fotos = (ord.fotos || []).concat(["data:image/png;base64,iVBORw0KGgo="]); }); await openOrder(id); return true; }, idAdm, { plazoMs: 30000 });
    // el mecánico toma y sube su foto
    const t0 = Date.now();
    await mec.eval(async (u) => {
      const loc = (await DB.getAll("ordenes")).find((x) => x.uid === u); currentOrderId = loc.id; showView("detalle");
      const cv = document.createElement("canvas"); cv.width = 320; cv.height = 240; const x = cv.getContext("2d"); x.fillStyle = "#c00"; x.fillRect(0, 0, 320, 240);
      const file = new File([await new Promise((ok) => cv.toBlob(ok, "image/jpeg", 0.9))], "evidencia.jpg", { type: "image/jpeg" });
      const dt = new DataTransfer(); dt.items.add(file); const inp = document.getElementById("inputFotos"); inp.files = dt.files; inp.dispatchEvent(new Event("change"));
      const h = Date.now() + 30000;
      while (Date.now() < h) { await flushFotosPendientes(); await syncMotor.sincronizar(); if (!(await syncBd.blobs.todos()).length && !(await syncBd.outbox.todos()).some((q) => q.estado === "pending" || q.estado === "syncing")) break; await new Promise((r) => setTimeout(r, 200)); }
      return true;
    }, o, { plazoMs: 60000 });
    const g = fotosNube(o);
    assert.equal(g.length, 1, "UNA foto ligada en la nube");
    // F1 · el Taller (orden abierta, sin recargar) y la caja la ven solos
    const va = await verFotosNube(adm, o, 20000), vc = await verFotosNube(caja, o, 20000);
    const F1 = { admin: va, caja: vc, segundos_hasta_verla: va.t ? Math.round((va.t - t0) / 100) / 10 : null };
    console.log(`B8_FOTOS ${nav} ${JSON.stringify(F1)} nube_rev=${pila.sql(`select rev || ' ' || updated_at from public.ordenes where id = '${o}'`)} orden=${o} avisos=${pila.sql(`select string_agg(to_char(inserted_at, 'HH24:MI:SS.MS') || ' ' || topic || ' ' || payload::text, ' ; ' order by inserted_at) from realtime.messages where inserted_at > now() - interval '40 seconds'`)}`);
    assert.equal(va.n, 1, `el Taller ve la foto del mecánico sin recargar: ${JSON.stringify(va)}`); assert.equal(va.cargadas, 1, "la imagen carga de verdad"); assert.equal(va.firmadas, true, "URL firmada");
    assert.equal(va.locales, 1, "y su propia foto local sigue");
    assert.equal(vc.n, 1, "la caja también"); assert.equal(vc.cargadas, 1);
    // F2 · el Taller edita la orden: la evidencia de la nube NO se pisa y su foto local NO sube
    await adm.eval(async (id) => { await updateOrder(id, (ord) => { ord.falla = "Evidencia B8 (editada)"; }); const h = Date.now() + 20000; while (Date.now() < h) { await syncMotor.sincronizar(); if (!(await syncBd.outbox.todos()).some((q) => q.estado === "pending" || q.estado === "syncing")) break; await new Promise((r) => setTimeout(r, 200)); } return true; }, idAdm, { plazoMs: 40000 });
    assert.equal(nube(`select falla from public.ordenes where id = '${o}'`)[0].falla, "Evidencia B8 (editada)");
    assert.deepEqual(fotosNube(o), g, "la evidencia del mecánico sigue intacta en la nube (el Taller no sube ni pisa fotos)");
    assert.equal(Number(pila.sql(`select count(*) from storage.objects where bucket_id = 'entimotors-taller' and name like 'ordenes/${o}/%'`)), 1, "en Storage solo la del mecánico");
  } finally { await adm.cerrar(); await caja.cerrar(); await mec.cerrar(); }
  // F3 · otro mecánico no puede firmar la ruta
  const otro = await mitrabajo(nav, PERFILES.mecanico2);
  try {
    const r = await otro.eval(async (ruta) => { const u = await obtenerUrlFotoFirmada(ruta); return u ? "firmó" : "negado"; }, fotosNube(o)[0], { plazoMs: 30000 });
    assert.equal(r, "negado", "otro mecánico no obtiene la evidencia");
  } finally { await otro.cerrar(); }
});
