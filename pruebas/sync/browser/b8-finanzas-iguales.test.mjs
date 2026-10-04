// 3.15.0 · BLOQUE 8 · L · LAS OPTIMIZACIONES DEL BLOQUE 7 NO CAMBIARON NINGÚN NÚMERO (Chromium y Firefox).
// MISMA base (3 000 movimientos sembrados una sola vez), MISMO reloj y zona America/Tegucigalpa: la app ANTES del Bloque 7
// (B8_RAIZ_ANTES, por defecto ENTIMOTORS-3.15-bloque7/base-antes) y la ACTUAL calculan Finanzas (tarjetas locales + resultado del
// servidor) para varios rangos y el Dashboard. Se comparan TODOS los números que se ven, en orden: tienen que ser idénticos.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { iniciarPila, PERFILES, RAIZ } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { sembrarVolumen } from "./lib/volumen.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const ANTES = path.resolve(process.env.B8_RAIZ_ANTES || path.join(RAIZ, "../ENTIMOTORS-3.15-bloque7/base-antes/taller-demo"));
let pila;
before(async () => { assert.ok(fs.existsSync(path.join(ANTES, "app.js")), `falta ${ANTES}`); pila = await iniciarPila(); sembrarVolumen(pila, "3000"); });
after(async () => { await pila?.detener(); });

async function medir(nav, raiz, etiqueta) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8fin-${etiqueta}-${nav}`, pagina: "index.html", real: true, raiz, plazoApertura: 60000 });
  try {
    await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
    return await d.eval(async (mutar) => {
      await startApp({ uid: "00000000-0000-4000-8000-000000000001", nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null });
      if (window.esperarDescargaArranque) await esperarDescargaArranque();
      // control de la prueba (B8_FIN_MUTANTE=1): un movimiento de caja de L 1 SOLO en «después» → los números TIENEN que diferir
      if (mutar) { syncMotor?.detener?.(); for (const { name } of await indexedDB.databases()) await new Promise((ok, mal) => { const r = indexedDB.open(name); r.onerror = mal; r.onsuccess = () => {
        if (!r.result.objectStoreNames.contains("caja_movimientos")) { r.result.close(); ok(); return; }
        const t = r.result.transaction("caja_movimientos", "readwrite"), st = t.objectStore("caja_movimientos"); const c = st.openCursor();
        c.onsuccess = () => { const cur = c.result; if (!cur) return; const m = cur.value; window.__tipos = window.__tipos || {}; window.__tipos[m.tipo] = (window.__tipos[m.tipo] || 0) + 1;
          if (!window.__mutado && FechaNegocio.enRango(m.fechaISO, FechaNegocio.sumarDias(FechaNegocio.hoy(), -6), FechaNegocio.hoy())) { cur.update({ ...m, monto: Number(m.monto) + 1 }); window.__mutado = { tipo: m.tipo, monto: m.monto, fecha: m.fechaISO }; } cur.continue(); };
        t.oncomplete = () => { r.result.close(); ok(); }; }; }); }
      const numeros = (el) => (el.innerText.match(/L\s?-?[\d,]+(\.\d+)?|-?\d[\d,]*(\.\d+)?/g) || []).map((x) => x.replace(/\s/g, ""));
      const esperarServidor = async () => { const h = Date.now() + 20000; while (Date.now() < h && /Calculando|Cargando/i.test(document.getElementById("view-finanzas").innerText)) await new Promise((r) => setTimeout(r, 100)); };
      const hoy = FechaNegocio.hoy(), R = {};
      for (const [k, desde, hasta] of [["hoy", hoy, hoy], ["7d", FechaNegocio.sumarDias(hoy, -6), hoy], ["30d", FechaNegocio.sumarDias(hoy, -30), hoy],
        ["365d", FechaNegocio.sumarDias(hoy, -365), hoy], ["pasado", FechaNegocio.sumarDias(hoy, -200), FechaNegocio.sumarDias(hoy, -100)]]) {
        showView("finanzas");
        document.getElementById("finDesde").value = desde; document.getElementById("finHasta").value = hasta;
        await renderFinanzas(); await esperarServidor(); await new Promise((r) => setTimeout(r, 300));
        // sin la tabla de movimientos paginada (mismo dato, otra presentación): tarjetas, resultado, rendimiento por mecánico
        const v = document.getElementById("view-finanzas").cloneNode(true); v.querySelectorAll(".fin-table-card").forEach((x) => x.remove());
        document.body.appendChild(v); v.style.display = "block"; R[k] = numeros(v); v.remove();
      }
      showView("dashboard"); await renderDashboard(); await new Promise((r) => setTimeout(r, 300));
      R.dashboard = numeros(document.getElementById("view-dashboard"));
      return { R, zona: Intl.DateTimeFormat().resolvedOptions().timeZone, hoy, mutado: window.__mutado || null, tipos: window.__tipos || null };
    }, etiqueta === "despues" && process.env.B8_FIN_MUTANTE === "1", { plazoMs: 240000 });
  } finally { await d.cerrar(); }
}

for (const nav of NAVS) test(`FINANZAS: mismos números antes y después del Bloque 7 · ${nav}`, async () => {
  const a = await medir(nav, ANTES, "antes"), b = await medir(nav, null, "despues");
  const resumen = Object.fromEntries(Object.keys(a.R).map((k) => [k, { n: a.R[k].length, iguales: JSON.stringify(a.R[k]) === JSON.stringify(b.R[k]) }]));
  console.log(`B8_FIN ${nav} hoy=${a.hoy} muestra30d=${a.R["30d"].slice(0, 12).join(" ")} ${JSON.stringify(resumen)}${b.mutado || b.tipos ? " mutante=" + JSON.stringify({ mutado: b.mutado, tipos: b.tipos }) : ""}`);
  for (const k of Object.keys(a.R)) {
    assert.ok(a.R[k].length > 3, `${k}: se leyeron números`);
    assert.deepEqual(b.R[k], a.R[k], `${k}: los números cambiaron`);
  }
});
