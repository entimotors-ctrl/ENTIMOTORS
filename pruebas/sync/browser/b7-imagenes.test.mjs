// 3.15.0 · BLOQUE 7 · IMÁGENES (app real, Chromium y Firefox). Una foto de cámara SINTÉTICA (4000×3000, JPEG 0.95 con ruido: se
// comprime mal, como una foto real) entra por la MISMA función que usa el Taller al tomar una foto de orden/moto/repuesto (fotoLocal;
// antes de 3.15 B7: fileToDataUrl, el original tal cual). Se mide lo guardado, leer las órdenes y pintar su lista con las 8 órdenes (volumen de producción) con foto.
//   B7_RAIZ=<carpeta con taller-demo/> (ANTES)   B7_ETIQUETA=antes|despues   B7_SALIDA=<.jsonl>
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { sembrarVolumen } from "./lib/volumen.mjs";
import { prepararSesion, anotar, rssMb } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const RAIZ = process.env.B7_RAIZ ? process.env.B7_RAIZ + "/taller-demo" : null;
const ETQ = process.env.B7_ETIQUETA || "despues";
const SALIDA = process.env.B7_SALIDA || null;
let pila;
before(async () => { pila = await iniciarPila(); sembrarVolumen(pila, "actual"); });
after(async () => { await pila?.detener(); });

for (const nav of NAVS) test(`IMÁGENES · fotos de orden del Taller · ${nav} · ${ETQ}`, async () => {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b7img-${nav}`, pagina: "index.html", real: true, raiz: RAIZ, gc: nav === "chromium" });
  try {
    await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
    await d.eval(async (a) => { await startApp({ uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null }); if (window.esperarDescargaArranque) await esperarDescargaArranque(); return true; }, { id: PERFILES.admin }, { plazoMs: 120000 });
    const r = await d.eval(async () => {
      const gc = async () => { if (window.gc) { window.gc(); await new Promise((x) => setTimeout(x, 50)); window.gc(); } };
      const heap = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : null);
      // foto sintética: ruido de color (se comprime mal) 4000×3000
      const c = document.createElement("canvas"); c.width = 4000; c.height = 3000; const g = c.getContext("2d");
      const img = g.createImageData(4000, 3000); for (let i = 0; i < img.data.length; i += 4) { const v = (i * 2654435761) >>> 24; img.data[i] = v; img.data[i + 1] = (v * 7) & 255; img.data[i + 2] = (v * 13) & 255; img.data[i + 3] = 255; }
      g.putImageData(img, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.95));
      const file = new File([blob], "camara.jpg", { type: "image/jpeg" });
      const guardar = window.fotoLocal || window.fileToDataUrl;    // antes de B7 el Taller guardaba el original (fileToDataUrl)
      const t0 = performance.now(); const dataUrl = await guardar(file); const tCaptura = performance.now() - t0;
      const dim = await new Promise((ok) => { const im = new Image(); im.onload = () => ok([im.naturalWidth, im.naturalHeight]); im.onerror = () => ok(null); im.src = dataUrl; });
      // las 8 órdenes (volumen de producción) con esa foto (el Taller no sube sus fotos a la nube: quedan en la caché del dispositivo)
      const ords = (await DB.getAll("ordenes")).slice(0, 8);
      await syncBd.transaccion(["ordenes"], "readwrite", async (t) => { for (const o of ords) { o.fotos = [dataUrl]; await t.put("ordenes", o); } });
      await gc(); const h0 = heap();
      const med = async (f) => { const v = []; for (let i = 0; i < 5; i++) { const t = performance.now(); await f(); await new Promise((x) => requestAnimationFrame(() => setTimeout(x, 0))); v.push(performance.now() - t); } v.sort((a, b) => a - b); return Math.round(v[2]); };
      const getAll = await med(() => DB.getAll("ordenes"));
      showView("ordenes");
      const lista = await med(() => renderOrdersList());
      await new Promise((x) => setTimeout(x, 500)); await gc();
      const h1 = heap();
      const detalle = await med(() => openOrder(ords[0].id));
      const imgs = [...document.querySelectorAll("#ordersList img.order-thumb")];
      return { original_kb: Math.round(file.size / 1024), guardada_kb: Math.round((dataUrl.length * 3) / 4 / 1024), dimensiones_guardadas: dim, captura_ms: Math.round(tCaptura),
        ordenes_con_foto: ords.length, getAll_ordenes_ms: getAll, lista_ordenes_ms: lista, detalle_orden_ms: detalle, heap_antes_lista_mb: h0, heap_con_lista_mb: h1,
        miniaturas_lazy: imgs.filter((i) => i.loading === "lazy").length, miniaturas: imgs.length };
    }, null, { plazoMs: 300000 });
    r.rss_mb = rssMb(d.pid);
    anotar(SALIDA, `${ETQ}|${nav}|imagenes`, r);
    if (ETQ === "despues") {
      assert.ok(r.guardada_kb < r.original_kb / 3, `la foto nueva se guarda comprimida: ${r.guardada_kb} KB de ${r.original_kb} KB`);
      assert.ok(Math.max(...r.dimensiones_guardadas) === 1600, `lado mayor 1600 px (evidencia legible): ${r.dimensiones_guardadas}`);
      assert.equal(r.miniaturas_lazy, r.miniaturas, "miniaturas con carga diferida");
    }
  } finally { await d.cerrar(); }
});
