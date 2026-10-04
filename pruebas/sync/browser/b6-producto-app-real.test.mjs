// 3.15.0 · BLOQUE 6 · el PRODUCTO publicable en un navegador real (Postgres + PostgREST reales con 15f). Se sirven los ARTEFACTOS que
// generan hacer-build-taller.sh y hacer-build-mecanicos.sh (no el código fuente).
//   L17 / L18 · recorriendo TODAS las pantallas visibles de cada rol, el texto en pantalla no tiene frases de demo/desarrollo
//   L09 / L10 / L11 / L12 · «Gestor Web ↗» solo para el admin; abre la URL real en otra pestaña; cajero y mecánico no lo ven ni lo abren
//   L19 · el HUD que inyecta Netlify (sus iframes) no se ve en Mi Trabajo
//   L05 / L06 · aviso 3.13 decidido por el SERVIDOR: con el negocio migrado muestra SOLO el registro que falta (el «119»), sin ofrecer
//               importar; cuando está en la nube, desaparece; un dispositivo nuevo no ofrece «Traer mis datos»
//   L08 · el producto no crea datos de ejemplo (sin config-local: ni «Ver un ejemplo», ni cuenta «prueba», ni siembra)
//   SYNC_NAVEGADORES=chromium,firefox node --test --test-concurrency=1 pruebas/sync/browser/b6-producto-app-real.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { PROHIBIDAS } from "../node/helpers/no-demo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../taller-demo");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-b6-app-"));
const TALLER = path.join(T, "taller"), MT = path.join(T, "mitrabajo");
let pila;
before(async () => {
  for (const [s, d] of [["hacer-build-taller.sh", TALLER], ["hacer-build-mecanicos.sh", MT]]) assert.equal(spawnSync("bash", [path.join(DEMO, s), d]).status, 0, s);
  pila = await iniciarPila({ fasesExtra: ["sec-1c-clave-intentos"] });
});
after(async () => { await pila?.detener(); fs.rmSync(T, { recursive: true, force: true }); });
const U = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
let n = 0;

async function abrir(nav, rol, raiz) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b6-${rol}-${nav}-${++n}`, pagina: "index.html", real: true, raiz, producto: rol === "mecanico" ? "mecanico" : null });
  const gateTexto = await d.eval(() => document.body.innerText);
  await d.eval(async (a) => {
    window.__toasts = []; window.toast = (m) => window.__toasts.push(String(m));
    window.__abiertas = []; window.open = (u, t, f) => { window.__abiertas.push({ u, t, f }); return null; };
    window.SupabaseCliente.sesion = () => ({ access_token: a.token }); window.SupabaseCliente.estado = () => ({ activo: true, conSesion: true }); window.SupabaseCliente.refrescarSesion = async () => ({ ok: true });
    const mec = a.rol === "mecanico";
    currentUser = { uid: a.id, nombre: a.rol, rol: a.rol, origen: "supabase", activo: true, perfilId: mec ? a.id : null };
    if (!db) db = await openDb(BASE_TALLER);
    await prepararModoNube({ rol: a.rol, origen: "supabase", activo: true, uid: a.id, perfilId: mec ? a.id : null });
    document.getElementById("shell").classList.add("active");
    aplicarModoProducto(); aplicarPermisosPorRol();
    if (mec) { showView("mi-trabajo"); await renderMiTrabajo(); }
  }, { token: pila.jwt(PERFILES[rol], { segundos: 3600 }), id: PERFILES[rol], rol });
  return { d, gateTexto };
}
/** Visita cada pantalla que el rol ve en el menú y junta el texto VISIBLE (innerText no incluye lo oculto). */
const recorrer = (d) => d.eval(async () => {
  const textos = [document.getElementById("topbar")?.innerText || ""];
  const vistas = [...document.querySelectorAll(".nav-item[data-view]")].filter((b) => b.style.display !== "none" && b.dataset.view !== "web-cms").map((b) => b.dataset.view);
  for (const v of vistas) {
    if (!showView(v)) continue;
    try { await renderByView[v]?.(); } catch (e) { textos.push("ERROR_RENDER " + v + ": " + e.message); }
    await new Promise((r) => setTimeout(r, 30));
    textos.push("[" + v + "] " + document.getElementById("view-" + v).innerText);
  }
  document.getElementById("btnCuenta")?.click(); textos.push(document.getElementById("accountPanel")?.innerText || "");
  return { vistas, texto: textos.join("\n") };
});
const prohibidas = (t) => PROHIBIDAS.filter((re) => re.test(t)).map(String);

for (const nav of NAVS) {
  describe(`3.15 · Bloque 6 · producto publicable · ${nav}`, () => {
    before(() => pila.limpiar());

    test("L17 / L09 / L12 / L08 · Taller (admin): ninguna pantalla con textos de demo; «Gestor Web ↗» abre la URL real; sin ejemplos", async () => {
      const { d, gateTexto } = await abrir(nav, "admin", TALLER);
      try {
        assert.deepEqual(prohibidas(gateTexto), [], "pantalla de acceso");
        const r = await recorrer(d);
        assert.ok(r.vistas.length >= 10, "recorrió las pantallas del admin: " + r.vistas.join(","));
        assert.deepEqual(prohibidas(r.texto), [], prohibidas(r.texto).join(" "));
        assert.doesNotMatch(r.texto, /ERROR_RENDER/);
        const g = await d.eval(async () => {
          const antes = document.querySelector(".view.active")?.id;
          const b = document.querySelector('.nav-item[data-view="web-cms"]'); b.click();
          return { visible: b.style.display !== "none", texto: b.textContent.trim(), abiertas: window.__abiertas, antes, despues: document.querySelector(".view.active")?.id,
            dev: modoDesarrollo(), local: window.ENTIMOTORS_LOCAL === undefined, sim: document.getElementById("offlineToggle").style.display, tag: document.getElementById("topbarTag").textContent };
        });
        assert.equal(g.visible, true); assert.match(g.texto, /Gestor Web/);
        assert.deepEqual(g.abiertas, [{ u: "https://www.entimotors.com/admin.html", t: "_blank", f: "noopener,noreferrer" }], "L12: la URL real, otra pestaña, sin pasar nada");
        assert.equal(g.despues, g.antes, "no abre ninguna vista local");
        assert.deepEqual([g.dev, g.local, g.sim, g.tag], [false, true, "none", "OS"], "producto: sin herramientas de desarrollo");
        // L08: ni pidiendo «demo» se siembra algo en la nube del taller
        const antes = Number(pila.sql("select (select count(*) from clientes) + (select count(*) from ordenes) + (select count(*) from inventario)"));
        await d.eval(async () => { prepararGateModo(); await elegirModoDatos("demo"); await seedIfEmpty(); return true; });
        assert.equal(await d.eval(() => document.getElementById("btnModoDemo").style.display), "none", "«Ver un ejemplo» no se ofrece");
        assert.equal(Number(pila.sql("select (select count(*) from clientes) + (select count(*) from ordenes) + (select count(*) from inventario)")), antes, "L08: nada sembrado en la nube");
        assert.equal(await d.eval(async () => (await idbGetAll("clientes")).length), 0, "L08: nada sembrado en la base local");
      } finally { await d.cerrar(); }
    });

    test("L10 · Taller (cajero): no ve «Gestor Web» ni puede abrirlo; sus pantallas sin textos de demo", async () => {
      const { d } = await abrir(nav, "cajero", TALLER);
      try {
        const r = await recorrer(d);
        assert.ok(!r.vistas.includes("web-cms"));
        assert.deepEqual(prohibidas(r.texto), [], prohibidas(r.texto).join(" "));
        const g = await d.eval(() => ({ nav: document.querySelector('.nav-item[data-view="web-cms"]').style.display, qa: document.querySelector('.qa-btn[data-view="web-cms"]')?.style.display,
          abre: abrirGestorWeb(), abiertas: window.__abiertas.length }));
        assert.deepEqual(g, { nav: "none", qa: "none", abre: false, abiertas: 0 });
      } finally { await d.cerrar(); }
    });

    test("L18 / L11 / L19 · Mi Trabajo (mecánico, artefacto de Netlify): sin textos de demo, sin Gestor Web, y el HUD inyectado no se ve", async () => {
      const { d, gateTexto } = await abrir(nav, "mecanico", MT);
      try {
        assert.deepEqual(prohibidas(gateTexto), []);
        const r = await d.eval(async () => {
          // lo que Netlify inyecta en producción: la insignia/barra en iframes con estos ids
          for (const id of ["nl-badge-frame", "nl-hud-frame"]) { const f = document.createElement("iframe"); f.id = id; f.srcdoc = "<p>Netlify</p>"; f.style.cssText = "position:fixed;bottom:0;right:0;width:200px;height:60px;display:block"; document.body.appendChild(f); }
          await new Promise((ok) => setTimeout(ok, 50));
          const hud = ["nl-badge-frame", "nl-hud-frame"].map((id) => getComputedStyle(document.getElementById(id)).display);
          return { texto: document.getElementById("topbar").innerText + "\n" + document.getElementById("view-mi-trabajo").innerText, hud, gestor: abrirGestorWeb(), abiertas: window.__abiertas.length,
            titulo: document.title, sw: navigator.serviceWorker ? "sí" : "no" };
        });
        assert.deepEqual(prohibidas(r.texto), [], prohibidas(r.texto).join(" "));
        assert.deepEqual(r.hud, ["none", "none"], "L19");
        assert.equal(r.gestor, false); assert.equal(r.abiertas, 0);
        assert.equal(r.titulo, "ENTIMOTORS · Mi Trabajo");
      } finally { await d.cerrar(); }
    });

    test("L05 / L06 · aviso 3.13 decidido por el servidor: solo el registro que falta, sin ofrecer importar; migrado y sin pendientes → nada", async () => {
      pila.limpiar();
      pila.sql(`delete from public.import_lotes; insert into public.import_lotes (legacy_device_id, backup_sha256, estado, creado_por, aplicado_en, confirmado_en)
                values ('telefono', repeat('b', 64), 'confirmado', '${PERFILES.admin}', now(), now());`);
      const { d } = await abrir(nav, "admin", TALLER);
      try {
        // la base 3.13 del TELÉFONO: 3 clientes y 2 movimientos de caja; la nube ya tiene los 3 clientes y 1 movimiento (mismos uuid deterministas)
        const u = await d.eval(async () => {
          for (const s of ["clientes", "caja_movimientos"]) for (const x of await idbGetAll(s)) await idbDelete?.(s, x.id);
          for (let i = 1; i <= 3; i++) await idbSave("clientes", { id: i, nombre: "Cliente legado " + i, telefono: "70" + i });
          await idbSave("caja_movimientos", { id: 1, tipo: "ingreso", categoria: "Otro", monto: 10, fechaISO: "2026-09-20T10:00:00Z" });
          await idbSave("caja_movimientos", { id: 2, tipo: "ingreso", categoria: "Cobro de crédito", monto: 75, fechaISO: "2026-09-26T15:00:00Z" });
          return { c: await Promise.all([1, 2, 3].map((i) => Import313.uuidDe("clientes", i))), m1: await Import313.uuidDe("caja_movimientos", 1), m2: await Import313.uuidDe("caja_movimientos", 2) };
        });
        pila.sql(`set session_replication_role = replica;
          insert into public.clientes (id, nombre, telefono) values ${u.c.map((x, i) => `('${x}', 'Cliente legado ${i + 1}', '70${i + 1}')`).join(",")};
          insert into public.caja_movimientos (id, tipo, categoria, monto, occurred_at) values ('${u.m1}', 'ingreso', 'Otro', 10, now());
          reset session_replication_role;`);
        const a = await d.eval(async () => { await revisarDatos313(); const el = document.getElementById("aviso313"); el.querySelector("details")?.setAttribute("open", "");
          return { ve: el.style.display !== "none", texto: el.innerText, boton: !!document.getElementById("btnAviso313") }; });
        assert.equal(a.ve, true, "L06: el registro que falta se ve");
        assert.match(a.texto, /1 registro de la versión anterior \(3\.13\) que no está en la nube/);
        assert.match(a.texto, /caja_movimientos #2/, "identifica cuál");
        assert.equal(a.boton, false, "negocio migrado: importar ya no es el flujo normal");
        // al estar en la nube (resuelto por el camino que se decida), el aviso desaparece — lo dice el servidor, no una marca local
        pila.sql(`set session_replication_role = replica; insert into public.caja_movimientos (id, tipo, categoria, monto, occurred_at) values ('${u.m2}', 'ingreso', 'Cobro de crédito', 75, now()); reset session_replication_role;`);
        const b = await d.eval(async () => { localStorage.removeItem("enti_import_313"); await revisarDatos313(); return document.getElementById("aviso313").style.display; });
        assert.equal(b, "none", "L05: sin pendientes → sin aviso, aunque este dispositivo no tenga marca local");
        // dispositivo NUEVO (sin datos 3.13) con el negocio migrado: no ofrece «Traer mis datos de la versión anterior»
        const c = await d.eval(async () => {
          for (const s of ["clientes", "caja_movimientos"]) for (const x of await idbGetAll(s)) await idbDelete(s, x.id);
          prepararGateModo(); await new Promise((ok) => setTimeout(ok, 600));
          return { importar: document.getElementById("btnModoImportar").style.display, estado: await estadoLegado313() };
        });
        assert.equal(c.importar, "none"); assert.equal(c.estado.migrado, true); assert.equal(c.estado.local, 0);
      } finally { await d.cerrar(); }
    });
  });
}
