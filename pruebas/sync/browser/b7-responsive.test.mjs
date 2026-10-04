// 3.15.0 · BLOQUE 7 · RESPONSIVE + TÁCTIL/RATÓN/TECLADO + ACCESIBILIDAD BÁSICA sobre la app REAL (Chromium y Firefox).
// Todos los perfiles son EMULADOS (tamaño de ventana + tipo de puntero del navegador headless; ningún dispositivo físico). El puntero
// táctil se CONFIRMA dentro de la página con matchMedia("(pointer: coarse)") y se anota: si el navegador no lo emuló, se dice.
//   SYNC_NAVEGADORES=chromium,firefox node --test --test-concurrency=1 pruebas/sync/browser/b7-responsive.test.mjs
//   B7_SALIDA=<archivo .jsonl> (opcional)   B7_RAIZ=<carpeta con taller-demo/> (p. ej. la copia ANTES, para comparar)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { sembrarVolumen } from "./lib/volumen.mjs";
import { prepararSesion, anotar } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const RAIZ = process.env.B7_RAIZ ? process.env.B7_RAIZ + "/taller-demo" : null;
const SALIDA = process.env.B7_SALIDA || null;
// [nombre, ancho, alto, táctil]
export const PERFILES_DISPOSITIVO = [
  ["teléfono pequeño", 320, 568, true], ["Android", 360, 640, true], ["iPhone SE", 375, 667, true], ["iPhone moderno", 390, 844, true],
  ["Android grande", 414, 896, true], ["teléfono ancho", 480, 800, true], ["tablet 7\"", 600, 960, true], ["tablet vertical", 768, 1024, true],
  ["tablet 800", 800, 1280, true], ["tablet horizontal", 1024, 768, true],
  ["PC ventana 768 (ratón)", 768, 900, false], ["PC ventana 800 (ratón)", 800, 600, false], ["laptop modesta 1024", 1024, 768, false],
  ["laptop 1280", 1280, 800, false], ["desktop 1440", 1440, 900, false], ["desktop 1920", 1920, 1080, false],
];
const VISTAS = ["dashboard", "ordenes", "clientes", "citas", "cotizaciones", "inventario", "pos", "finanzas", "creditos", "ajustes", "mensajes"];

/* Los navegadores headless no abren ventanas de menos de ~500 px (Chromium y Firefox): para los teléfonos angostos la app se carga
   en un MARCO (iframe) del ancho exacto dentro de una ventana mayor — las media queries responden al ancho del marco (mismo método que
   UI-1C) y el puntero sigue siendo el del navegador (táctil emulado). Devuelve { d, ev(fn, arg, opc), marco }. */
async function abrirPerfil(nav, nombre, w, h, tactil, producto = null) {
  const marco = w < 500;
  const d = await abrirDispositivo({ navegador: nav, nombre, pagina: "index.html", real: true, producto, raiz: RAIZ, ventana: marco ? [1024, 900] : [w, h], tactil });
  if (marco) {
    const ok = await d.eval(async (x) => {
      const f = document.createElement("iframe"); f.id = "marcoB7"; f.src = "/index.html";
      f.style.cssText = `width:${x.w}px;height:${x.h}px;border:0;position:fixed;top:0;left:0;z-index:2147483647;background:#fff`;
      document.body.appendChild(f);
      const lim = Date.now() + 60000;
      while (Date.now() < lim) { try { if (f.contentWindow.document.readyState === "complete" && typeof f.contentWindow.startApp === "function") return true; } catch (e) { /* cargando */ } await new Promise((r) => setTimeout(r, 100)); }
      return false;
    }, { w, h }, { plazoMs: 70000 });
    if (!ok) { await d.cerrar(); throw new Error(`el marco de ${w}px no cargó`); }
  }
  const ev = (fn, arg, opc) => (marco
    ? d.eval(async (x) => { const win = document.getElementById("marcoB7").contentWindow; return await win.eval("(" + x.src + ")")(x.arg); }, { src: fn.toString(), arg: arg === undefined ? null : arg }, opc)
    : d.eval(fn, arg, opc));
  return { d, ev, marco };
}

let pila;
before(async () => { pila = await iniciarPila(); sembrarVolumen(pila, "actual"); });
after(async () => { await pila?.detener(); });

/** Revisión de la pantalla activa, dentro de la página. Devuelve lo que falla (vacío = bien) y medidas. */
const REVISAR = async ({ vistas, mt }) => {
  // textos LARGOS reales (el desborde de la barra depende de ellos): nombre de usuario largo y el estado de sincronización más largo
  document.getElementById("loggedUserName").textContent = "Administrador del taller";
  const lbl = document.getElementById("syncLabel"); if (lbl) lbl.textContent = "Descarga inicial incompleta · reintentando";
  const cw = () => document.documentElement.clientWidth, ch = () => document.documentElement.clientHeight;
  const visible = (e) => { const r = e.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(e); return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0; };
  const nombre = (e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/)[0] : ""}`;
  // un contenedor que desplaza a propósito (tabla ancha dentro de un envoltorio con scroll) no es desborde de la página
  const enScroll = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true; } return false; };
  const fijo = (e) => { for (let p = e; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === "fixed") return true; return false; };
  const problemas = [];
  const medidas = { ancho: cw(), alto: ch(), tactil: matchMedia("(pointer: coarse)").matches, hover: matchMedia("(hover: hover)").matches, vistas: {} };
  const revisarVista = (v) => {
    const f = [];
    if (document.documentElement.scrollWidth > cw() + 1) f.push(`scroll horizontal ${document.documentElement.scrollWidth}/${cw()}`);
    const fuera = [...document.querySelectorAll("#shell *")].filter((e) => visible(e) && !fijo(e) && !enScroll(e) && (e.getBoundingClientRect().right > cw() + 1 || e.getBoundingClientRect().left < -1));
    if (fuera.length) f.push("fuera del ancho: " + fuera.slice(0, 4).map((e) => `${nombre(e)}→${Math.round(e.getBoundingClientRect().right)}`).join(", "));
    // barra superior (el hallazgo heredado de 768 px): NADA de lo visible dentro de #topbar puede quedar fuera del ancho, aunque un
    // contenedor lo recorte (recortado = inalcanzable para el dedo o el ratón)
    const barraFuera = [...document.querySelectorAll("#topbar *")].filter((e) => visible(e) && !fijo(e) && (e.getBoundingClientRect().right > cw() + 1 || e.getBoundingClientRect().left < -1));
    if (barraFuera.length) f.push("barra superior fuera del ancho: " + barraFuera.slice(0, 4).map((e) => `${nombre(e)}→${Math.round(e.getBoundingClientRect().right)}`).join(", "));
    // barra superior: cada control completo a la vista y sin encimarse
    const ctrls = ["#btnMenuToggle", "#btnBuscarGlobal", "#btnNotificaciones", "#btnCuenta", ".brand"].map((s) => document.querySelector(s)).filter((e) => e && visible(e));
    for (const e of ctrls) { const r = e.getBoundingClientRect(); if (r.right > cw() + 0.5 || r.left < -0.5 || r.top < -0.5) f.push(`barra: ${nombre(e)} cortado (${Math.round(r.left)}–${Math.round(r.right)})`); }
    for (let i = 0; i < ctrls.length; i++) for (let j = i + 1; j < ctrls.length; j++) {
      if (ctrls[i].contains(ctrls[j]) || ctrls[j].contains(ctrls[i])) continue;   // el botón del menú vive DENTRO de .brand: no es «encima»
      const a = ctrls[i].getBoundingClientRect(), b = ctrls[j].getBoundingClientRect();
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) f.push(`barra: ${nombre(ctrls[i])} encima de ${nombre(ctrls[j])}`);
    }
    // objetivos táctiles: con dedo, todo botón/enlace visible de la vista ≥ 24×24 (WCAG 2.2 AA); se cuentan los < 32 como aviso
    const vista = document.querySelector(".view.active");
    const toques = [...document.querySelectorAll("#topbar button, .view.active button, .view.active a[href], .view.active select, .view.active input:not([type=hidden])")].filter(visible);
    const chicos = toques.filter((e) => { const r = e.getBoundingClientRect(); return (e.tagName === "INPUT" && /checkbox|radio/.test(e.type)) ? false : (r.width < 24 || r.height < 24); });
    const justos = toques.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 32 || r.height < 32; });
    return { fallos: f, toquesChicos: chicos.slice(0, 6).map((e) => `${nombre(e)} ${Math.round(e.getBoundingClientRect().width)}×${Math.round(e.getBoundingClientRect().height)}`), nChicos: chicos.length, nMenos32: justos.length, nToques: toques.length, vistaOk: !!vista };
  };
  for (const v of vistas) {
    if (!showView(v)) { medidas.vistas[v] = "sin acceso"; continue; }
    try { await renderByView[v]?.(); } catch (e) { /* se revisa lo que haya */ }
    await new Promise((r) => setTimeout(r, 60));
    const r = revisarVista(v);
    medidas.vistas[v] = { chicos: r.nChicos, menos32: r.nMenos32, toques: r.nToques, ejemplosChicos: r.toquesChicos };
    for (const x of r.fallos) problemas.push(`${v}: ${x}`);
    if (medidas.tactil && r.nChicos) problemas.push(`${v}: ${r.nChicos} objetivo(s) táctil(es) < 24 px: ${r.toquesChicos.join(", ")}`);
  }
  // menú lateral / cajón: abrir y ver que todo el menú es alcanzable
  const menu = document.getElementById("btnMenuToggle");
  if (menu && visible(menu)) {
    menu.click(); await new Promise((r) => setTimeout(r, 300));
    const sb = document.getElementById("sidebar").getBoundingClientRect();
    if (sb.left < -1 || sb.right > cw() + 1) problemas.push(`cajón fuera de pantalla (${Math.round(sb.left)}–${Math.round(sb.right)})`);
    const cs = getComputedStyle(document.getElementById("sidebar"));
    if (sb.height > ch() + 1 && !/auto|scroll/.test(cs.overflowY)) problemas.push("cajón más alto que la pantalla y sin desplazamiento");
    closeMobileSidebar(); await new Promise((r) => setTimeout(r, 250));
  }
  // cuenta (desplegable o en línea): sus botones a la vista al abrirla
  const cuenta = document.getElementById("btnCuenta");
  if (cuenta && visible(cuenta)) {
    cuenta.click(); await new Promise((r) => setTimeout(r, 120));
    for (const b of document.querySelectorAll("#accountPanel button")) if (visible(b)) { const r = b.getBoundingClientRect(); if (r.right > cw() + 1 || r.left < -1 || r.bottom > ch() + 1) problemas.push(`cuenta: ${nombre(b)} fuera de pantalla`); }
    document.getElementById("accountPanel").classList.remove("open");
  }
  // modales: cada uno, abierto a la fuerza, cabe o se puede desplazar hasta sus botones
  medidas.modales = 0;
  for (const bg of document.querySelectorAll(".modal-bg")) {
    const estaba = bg.classList.contains("active");
    bg.classList.add("active"); await new Promise((r) => setTimeout(r, 20));
    const m = bg.querySelector(".modal") || bg.firstElementChild;
    if (m && visible(m)) {
      medidas.modales++;
      const r = m.getBoundingClientRect(), cb = getComputedStyle(bg), cm = getComputedStyle(m);
      const desplaza = /auto|scroll/.test(cb.overflowY) || /auto|scroll/.test(cm.overflowY);
      if (r.right > cw() + 1 || r.left < -1) problemas.push(`modal ${bg.id || nombre(m)}: más ancho que la pantalla (${Math.round(r.width)}/${cw()})`);
      if ((r.bottom > ch() + 1 || r.top < -1) && !desplaza) problemas.push(`modal ${bg.id || nombre(m)}: más alto que la pantalla y sin desplazamiento`);
    }
    if (!estaba) bg.classList.remove("active");
  }
  return { problemas, medidas };
};

/** Accesibilidad básica (una vez por navegador y producto): nombres, etiquetas, foco visible, contraste obvio, foco en modal, hover. */
const ACCESIBILIDAD = async () => {
  const visible = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const nombre = (e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/)[0] : ""}`;
  const accesible = (e) => (e.getAttribute("aria-label") || e.getAttribute("aria-labelledby") || e.getAttribute("title") || e.textContent || "").trim().length > 0;
  const out = { sinNombre: [], sinEtiqueta: [], sinFocoVisible: [], contrasteBajo: [], hoverNecesario: [], focoModal: null };
  const todas = [];
  for (const v of ["dashboard", "ordenes", "clientes", "citas", "cotizaciones", "inventario", "pos", "finanzas", "creditos", "ajustes", "mensajes", "mi-trabajo"]) {
    if (!document.getElementById("view-" + v) || !showView(v)) continue;
    try { await renderByView[v]?.(); } catch (e) { /* lo que haya */ }
    await new Promise((r) => setTimeout(r, 40));
    for (const b of document.querySelectorAll("#topbar button, #sidebar button, .view.active button, .view.active a[href]")) if (visible(b) && !accesible(b)) out.sinNombre.push(`${v}: ${nombre(b)}`);
    for (const i of document.querySelectorAll(".view.active input:not([type=hidden]), .view.active select, .view.active textarea")) {
      if (!visible(i)) continue;
      const tiene = i.getAttribute("aria-label") || i.getAttribute("aria-labelledby") || i.closest("label") || (i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)) || i.getAttribute("title");
      if (!tiene) out.sinEtiqueta.push(`${v}: ${nombre(i)}${i.placeholder ? ` (solo placeholder «${i.placeholder.slice(0, 30)}»)` : ""}`);
    }
    for (const e of document.querySelectorAll("#topbar button, #sidebar .nav-item, .view.active button, .view.active input, .view.active select")) if (visible(e)) todas.push([v, e]);
  }
  // foco visible: al enfocar con teclado debe verse (outline o sombra); se mira una muestra de cada tipo
  const muestra = []; const vistos = new Set();
  for (const [v, e] of todas) { const k = e.tagName + "." + (typeof e.className === "string" ? e.className.split(" ")[0] : ""); if (!vistos.has(k)) { vistos.add(k); muestra.push([v, e]); } }
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  for (const [v, e] of muestra) {
    showView(v); e.focus({ focusVisible: true });
    const cs = getComputedStyle(e);
    const visibleFoco = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none");
    if (document.activeElement === e && !visibleFoco) out.sinFocoVisible.push(`${v}: ${nombre(e)}`);
    e.blur();
  }
  // contraste obvio (texto normal < 4.5:1) en una muestra de texto visible
  const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const fondo = (e) => { for (let p = e; p; p = p.parentElement) { const c = rgb(getComputedStyle(p).backgroundColor); if (c.length >= 3 && (c.length < 4 || c[3] > 0.9)) return c; } return rgb(getComputedStyle(document.body).backgroundColor); };
  const textos = new Map();
  showView("dashboard");
  for (const e of document.querySelectorAll("#shell *")) {
    if (!visible(e) || !e.childNodes.length || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(e), c = rgb(cs.color), f = fondo(e);
    const L1 = lum(c), L2 = lum(f), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const grande = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
    if (ratio < (grande ? 3 : 4.5)) textos.set(`${nombre(e)} ${cs.color} sobre rgb(${f.slice(0, 3).join(",")}) = ${ratio.toFixed(2)}`, 1);
  }
  out.contrasteBajo = [...textos.keys()].slice(0, 15); out.nContrasteBajo = textos.size;
  // una función necesaria no puede depender de hover: reglas :hover que MUESTRAN algo oculto
  for (const hoja of document.styleSheets) { let reglas; try { reglas = hoja.cssRules; } catch (e) { continue; }
    for (const r of reglas || []) if (r.selectorText && /:hover/.test(r.selectorText) && /display:\s*(block|flex|grid|inline)|visibility:\s*visible|opacity:\s*1/.test(r.cssText)) out.hoverNecesario.push(r.selectorText); }
  // foco en modal: el buscador global (Ctrl+K) lleva el foco a su campo; Escape cierra el cajón
  if (window.abrirBuscadorGlobal) { abrirBuscadorGlobal(); await new Promise((r) => setTimeout(r, 150)); out.focoModal = document.getElementById("modalBuscarGlobal").contains(document.activeElement); cerrarBuscadorGlobal(); }
  out.sinNombre = [...new Set(out.sinNombre)]; out.sinEtiqueta = [...new Set(out.sinEtiqueta)];
  return out;
};

for (const nav of NAVS) {
  test(`RESPONSIVE · Taller · ${nav} · ${PERFILES_DISPOSITIVO.length} perfiles EMULADOS`, async () => {
    const res = {}; const fallos = [];
    for (const [nombre, w, h, tactil] of PERFILES_DISPOSITIVO) {
      const { d, ev, marco } = await abrirPerfil(nav, `b7r-${nav}-${w}`, w, h, tactil);
      try {
        // un navegador que no puede abrir una ventana tan angosta (Firefox headless: mínimo ~500 px) NO se cuenta como probado en ese ancho
        const real = await ev(() => innerWidth);
        if (Math.abs(real - w) > 20) { res[`${nombre} ${w}×${h}`] = { emulado: false, NO_EMULABLE: `el navegador abrió ${real} px` }; continue; }
        await prepararSesion({ eval: ev }, pila.jwt(PERFILES.admin, { segundos: 7200 }));
        await ev(async (a) => { await startApp({ uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null }); if (window.esperarDescargaArranque) await esperarDescargaArranque(); return true; }, { id: PERFILES.admin }, { plazoMs: 120000 });
        const r = await ev(REVISAR, { vistas: VISTAS, mt: false }, { plazoMs: 120000 });
        res[`${nombre} ${w}×${h}`] = { emulado: true, marco, tactilPedido: tactil, tactilConfirmado: r.medidas.tactil, anchoReal: r.medidas.ancho, problemas: r.problemas, modales: r.medidas.modales,
          objetivosMenos32: Object.values(r.medidas.vistas).reduce((s, x) => s + (x.menos32 || 0), 0) };
        for (const p of r.problemas) fallos.push(`${nombre} ${w}px: ${p}`);
      } finally { await d.cerrar(); }
    }
    anotar(SALIDA, `responsive|${nav}|taller`, { perfiles: res });
    assert.deepEqual(fallos, [], fallos.join("\n"));
  });

  test(`RESPONSIVE · Mi Trabajo · ${nav} · perfiles EMULADOS`, async () => {
    const res = {}; const fallos = [];
    for (const [nombre, w, h, tactil] of PERFILES_DISPOSITIVO.filter((p) => [320, 360, 390, 414, 768, 1024, 1280, 1920].includes(p[1]))) {
      const { d, ev, marco } = await abrirPerfil(nav, `b7rm-${nav}-${w}`, w, h, tactil, "mecanico");
      try {
        const real = await ev(() => innerWidth);
        if (Math.abs(real - w) > 20) { res[`${nombre} ${w}×${h}`] = { emulado: false, NO_EMULABLE: `el navegador abrió ${real} px` }; continue; }
        await prepararSesion({ eval: ev }, pila.jwt(PERFILES.mecanico, { segundos: 7200 }));
        await ev(async (a) => { await startApp({ uid: a.id, nombre: "Mec Uno", rol: "mecanico", origen: "supabase", activo: true, perfilId: a.id, user: null }); return true; }, { id: PERFILES.mecanico }, { plazoMs: 120000 });
        const r = await ev(REVISAR, { vistas: ["mi-trabajo"], mt: true }, { plazoMs: 120000 });
        // detalle de una orden propia (acciones del mecánico) también
        const r2 = await ev(async () => { const o = (await DB.getAll("ordenes"))[0]; if (!o) return { problemas: [] }; await openOrder(o.id); await new Promise((x) => setTimeout(x, 80));
          const cw = document.documentElement.clientWidth; const p = [];
          if (document.documentElement.scrollWidth > cw + 1) p.push(`detalle de orden: scroll horizontal ${document.documentElement.scrollWidth}/${cw}`);
          for (const b of document.querySelectorAll(".view.active button")) { const r = b.getBoundingClientRect(); if (r.width > 0 && (r.right > cw + 1 || r.left < -1)) p.push(`detalle de orden: botón fuera de pantalla ${b.textContent.trim().slice(0, 30)}`);
            if (r.width > 0 && matchMedia("(pointer: coarse)").matches && (r.width < 24 || r.height < 24)) p.push(`detalle de orden: botón < 24 px «${b.textContent.trim().slice(0, 30)}»`); }
          return { problemas: p }; }, null, { plazoMs: 60000 });
        res[`${nombre} ${w}×${h}`] = { emulado: true, marco, tactilPedido: tactil, tactilConfirmado: r.medidas.tactil, problemas: [...r.problemas, ...r2.problemas] };
        for (const p of [...r.problemas, ...r2.problemas]) fallos.push(`${nombre} ${w}px: ${p}`);
      } finally { await d.cerrar(); }
    }
    anotar(SALIDA, `responsive|${nav}|mitrabajo`, { perfiles: res });
    assert.deepEqual(fallos, [], fallos.join("\n"));
  });

  test(`ACCESIBILIDAD básica · ${nav} · Taller (1280, ratón) y Mi Trabajo (390, táctil)`, async () => {
    const R = {};
    for (const [prod, w, h, tactil, rol] of [["taller", 1280, 800, false, "admin"], ["mitrabajo", 390, 844, true, "mecanico"]]) {
      const { d, ev } = await abrirPerfil(nav, `b7a-${nav}-${prod}`, w, h, tactil, prod === "mitrabajo" ? "mecanico" : null);
      try {
        await prepararSesion({ eval: ev }, pila.jwt(PERFILES[rol], { segundos: 7200 }));
        await ev(async (a) => { await startApp({ uid: a.id, nombre: a.rol, rol: a.rol, origen: "supabase", activo: true, perfilId: a.rol === "mecanico" ? a.id : null, user: null }); return true; }, { id: PERFILES[rol], rol }, { plazoMs: 120000 });
        R[prod] = await ev(ACCESIBILIDAD, null, { plazoMs: 120000 });
      } finally { await d.cerrar(); }
    }
    anotar(SALIDA, `accesibilidad|${nav}`, R);
    for (const [prod, r] of Object.entries(R)) {
      assert.deepEqual(r.sinNombre, [], `${prod}: botones sin nombre accesible`);
      assert.deepEqual(r.sinFocoVisible, [], `${prod}: controles sin foco visible`);
      assert.deepEqual(r.hoverNecesario, [], `${prod}: funciones que dependen de hover`);
    }
    assert.equal(R.taller.focoModal, true, "el buscador (Ctrl+K) lleva el foco a su campo");
  });
}
