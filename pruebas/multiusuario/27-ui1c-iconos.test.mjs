// UI-1C (3.14.1): iconografía SVG propia. Sprite de index.html + icono() de app.js (lista CERRADA).
// Estático sobre los archivos REALES (index.html, app.js) y dinámico con el app.js real en vm (icono, renderWidgetRow, botón de tema).
// El render real en Chrome/Firefox (tamaños, colores, tema, 360/768/1280, Taller y Mi Trabajo) lo cubre el caso «UI-1C» de browser/helpers/suite-app.js.
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RUNTIME } from "./helpers/entorno.mjs";
import { marcadoPeligroso } from "./helpers/dom.mjs";
import { nuevoEntorno } from "./helpers/flujos.mjs";

const INDEX = fs.readFileSync(path.join(RUNTIME, "index.html"), "utf8");
const APP = fs.readFileSync(path.join(RUNTIME, "app.js"), "utf8");
const SPRITE = INDEX.slice(INDEX.indexOf('<svg xmlns="http://www.w3.org/2000/svg" id="spriteIconos"'), INDEX.indexOf("</svg>", INDEX.indexOf('id="spriteIconos"')) + 6);
const SIMBOLOS = [...SPRITE.matchAll(/<symbol id="i-([a-z-]+)"([^>]*)>([\s\S]*?)<\/symbol>/g)].map((m) => ({ id: m[1], attrs: m[2], cuerpo: m[3] }));
const IDS = SIMBOLOS.map((s) => s.id);
const ICONOS = nuevoEntorno().evaluar("[...ICONOS]");
// marcado EXACTO que produce icono(): se retira antes de buscar etiquetas peligrosas (cualquier otro <svg> sigue contando)
const sinIconos = (html) => String(html).replace(/<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-[a-z-]+"><\/use><\/svg>/g, "");

// los 12 módulos principales y su símbolo (UI-1C)
const MODULOS = { tpv: "pos", cotizacion: "cotizaciones", orden: "ordenes", cita: "citas", cliente: "clientes", inventario: "inventario",
  finanzas: "finanzas", credito: "creditos", mantenimiento: null, web: "web-cms", ajustes: "ajustes", "stock-bajo": null };
const CONTROLES = ["menu", "buscar", "notificaciones", "inicio", "sol", "luna", "alerta", "cerrar", "volver"];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{23F3}\u{2630}]/u;

describe("UI-1C · sprite SVG", () => {
  test("existe UNA vez, oculto para lectores de pantalla y sin ocupar espacio", () => {
    assert.equal(INDEX.split('id="spriteIconos"').length - 1, 1);
    assert.match(SPRITE, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" id="spriteIconos" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">/);
  });
  test("están los 12 símbolos de módulo y los controles generales", () => {
    for (const id of [...Object.keys(MODULOS), ...CONTROLES]) assert.ok(IDS.includes(id), `falta i-${id}`);
  });
  test("sprite y lista cerrada de app.js coinciden EXACTAMENTE (ni símbolos huérfanos ni nombres sin símbolo); sin duplicados", () => {
    assert.deepEqual([...IDS].sort(), [...ICONOS].sort());
    assert.equal(new Set(IDS).size, IDS.length);
    assert.equal(nuevoEntorno().evaluar("Object.isFrozen(ICONOS)"), true);
  });
  for (const s of SIMBOLOS) {
    test(`i-${s.id}: viewBox 24, trazo 1.75 redondeado, currentColor, sin relleno; nada externo ni ejecutable`, () => {
      assert.equal(s.attrs, ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"');
      assert.doesNotMatch(s.cuerpo, /<(image|script|foreignObject|use|a|style|title|text)\b/i);
      assert.doesNotMatch(s.cuerpo, /\bon[a-z]+\s*=|href|url\(|https?:|data:/i);
      // el único color distinto de currentColor es el acento, y va por variable
      for (const m of s.cuerpo.matchAll(/(stroke|fill|style)="([^"]*)"/g)) assert.equal(`${m[1]}="${m[2]}"`, 'style="stroke:var(--ic-acento,currentColor)"', `i-${s.id}`);
      assert.doesNotMatch(s.cuerpo, /#[0-9a-f]{3,8}\b|rgb/i);
    });
  }
  test("peso razonable: el sprite completo pesa menos de 14 KB", () => assert.ok(SPRITE.length < 14 * 1024, `${SPRITE.length} bytes`));
});

describe("UI-1C · ninguna referencia rota", () => {
  test("cada <use href> de index.html apunta a un símbolo que existe", () => {
    const refs = [...INDEX.matchAll(/<use\b[^>]*href="#([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 30, `${refs.length}`);
    for (const r of refs) assert.ok(r.startsWith("i-") && IDS.includes(r.slice(2)), r);
  });
  test("cada icono(\"…\") y cada «ic: \"…\"» de app.js está en la lista cerrada; el botón de tema solo alterna #i-sol / #i-luna", () => {
    const nombres = [...APP.matchAll(/icono\("([^"]+)"\)/g), ...APP.matchAll(/\bic: "([^"]*)"/g)].map((m) => m[1]);
    assert.ok(nombres.length >= 37, `${nombres.length}`);
    for (const n of nombres) assert.ok(ICONOS.includes(n), n);
    for (const h of APP.matchAll(/"#i-([a-z-]+)"/g)) assert.ok(IDS.includes(h[1]), h[1]);
  });
  test("ningún «ic:» de app.js sigue siendo un emoji", () => {
    for (const m of APP.matchAll(/\bic: "([^"]*)"/g)) assert.doesNotMatch(m[1], EMOJI, m[0]);
  });
});

describe("UI-1C · icono() es una lista cerrada", () => {
  const env = nuevoEntorno();
  test("un nombre conocido da EXACTAMENTE el marcado decorativo esperado", () => {
    for (const n of ICONOS) assert.equal(env.win.icono(n), `<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-${n}"></use></svg>`);
  });
  test("cualquier otra cosa devuelve \"\" (sin interpolar nada)", () => {
    for (const x of ["", "x", "TPV", " tpv", "tpv ", "__proto__", "constructor", "toString", "hasOwnProperty", 'tpv"><img src=x onerror=alert(1)>',
      "<svg onload=alert(1)>", "i-tpv", "#i-tpv", "tpv#", "../tpv", null, undefined, 7, {}, ["tpv"], { toString: () => "tpv" }, true])
      assert.equal(env.win.icono(x), "", JSON.stringify(String(x)));
  });
  test("mutar la lista desde fuera no cuela un nombre nuevo", () => {
    const e = nuevoEntorno(); try { e.evaluar('ICONOS.push("evil")'); } catch { /* congelada */ }
    assert.equal(e.win.icono("evil"), "");
  });
});

describe("UI-1C · los 12 módulos principales ya no dependen de emoji", () => {
  const qa = (v) => (INDEX.match(new RegExp(`<button type="button" class="qa-btn" data-view="${v}">([\\s\\S]*?)</button>`)) || [])[1];
  for (const [simbolo, vista] of Object.entries(MODULOS).filter(([, v]) => v)) {
    test(`acceso rápido «${vista}» → i-${simbolo}, sin emoji; se conservan texto, data-view y número`, () => {
      const html = qa(vista); assert.ok(html, vista);
      assert.match(html, new RegExp(`<span class="qa-ic"><svg class="ic" aria-hidden="true" focusable="false"><use href="#i-${simbolo}"></use></svg></span>`));
      assert.doesNotMatch(html, EMOJI); assert.match(html, /<span class="qa-num">\d+<\/span>/); assert.match(html, /<span class="qa-lbl">[^<]+<\/span>/);
    });
  }
  test("menú lateral: cada opción con data-view lleva su icono (y ya no el punto .sw); se conservan texto y data-view", () => {
    const esperado = { "mi-trabajo": "mantenimiento", dashboard: "dashboard", pos: "tpv", ordenes: "orden", cotizaciones: "cotizacion", citas: "cita", clientes: "cliente",
      inventario: "inventario", finanzas: "finanzas", creditos: "credito", "web-cms": "web", usuarios: "usuarios", ajustes: "ajustes",
      mensajes: "usuarios" };   // 3.15 (Bloque 3): «Mensajes al equipo» (solo admin), con el icono de equipo
    const items = [...INDEX.matchAll(/<button class="nav-item(?: active)?" data-view="([^"]+)"><svg class="ic" aria-hidden="true" focusable="false"><use href="#i-([a-z-]+)"><\/use><\/svg>([^<]+)/g)];
    assert.deepEqual(Object.fromEntries(items.map((m) => [m[1], m[2]])), esperado);
    assert.doesNotMatch(INDEX, /class="sw"|\.nav-item \.sw/);
  });
  test("Mantenimiento y Stock bajo: widgets del Dashboard y avisos con su símbolo", () => {
    assert.match(APP, /\{ ic: "mantenimiento", val: mantenimientos, lbl: "Mantenimientos"/);
    assert.match(APP, /\{ ic: "stock-bajo", val: repuestosBajos, lbl: "Stock bajo"/);
    assert.match(APP, /avisos\.push\(\{ ic: "mantenimiento", titulo: `Mantenimiento:/);
    assert.match(APP, /avisos\.push\(\{ ic: "stock-bajo", titulo: `Stock bajo:/);
    assert.match(APP, /\{ ic: "stock-bajo", val: stockBajo\.length, lbl: "Stock bajo"/);
  });
  test("los tres pintores pasan el nombre por icono() (el dato nunca es marcado)", () => {
    assert.match(APP, /<span class="ic">\$\{icono\(r\.ic\)\}<\/span>/);
    assert.match(APP, /<span class="ic">\$\{icono\(a\.ic\)\}<\/span>/);
    assert.match(APP, /<span class="ic">\$\{icono\(m\.ic\)\}<\/span>/);
    assert.doesNotMatch(APP, /\$\{(r|a|m)\.ic\}/);
  });
  test("renderWidgetRow real: símbolo correcto; un ic desconocido o con HTML no pinta nada; la etiqueta sigue escapada", () => {
    const env = nuevoEntorno();
    env.win.renderWidgetRow("widgetRow", [{ ic: "orden", val: 1, lbl: "Órdenes" }, { ic: '"><img src=x onerror=alert(1)>', val: 2, lbl: "<img src=x onerror=alert(2)>" }]);
    const h = env.doc.getElementById("widgetRow").innerHTML;
    assert.match(h, /<span class="ic"><svg class="ic" aria-hidden="true" focusable="false"><use href="#i-orden"><\/use><\/svg><\/span>/);
    assert.match(h, /<span class="ic"><\/span><span class="val">2<\/span>/);
    assert.deepEqual(marcadoPeligroso(sinIconos(h)), []);
    assert.match(h, /&lt;img src=x onerror=alert\(2\)&gt;/);
  });
});

describe("UI-1C · accesibilidad", () => {
  test("todo <svg class=\"ic…\"> de index.html es decorativo: aria-hidden=\"true\" y focusable=\"false\", sin <title>", () => {
    const svgs = [...INDEX.matchAll(/<svg class="ic[^"]*"([^>]*)>/g)];
    assert.ok(svgs.length >= 35, `${svgs.length}`);
    for (const s of svgs) assert.match(s[1], /^ aria-hidden="true" focusable="false"$/, s[0]);
    assert.doesNotMatch(SPRITE, /<title>/);
  });
  test("los botones que son SOLO icono conservan su aria-label (menú, buscar, avisos, cuenta, inicio)", () => {
    for (const id of ["btnMenuToggle", "btnBuscarGlobal", "btnNotificaciones", "btnCuenta", "fabHome"]) {
      const m = INDEX.match(new RegExp(`<button[^>]*id="${id}"[^>]*>([\\s\\S]*?)</button>`)); assert.ok(m, id);
      assert.match(m[0], /aria-label="[^"]{4,}"/, id);
      const texto = m[1].replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<span class="badge-dot"[\s\S]*?<\/span>/, "").trim();
      assert.equal(texto, "", `${id}: sin texto visible (lo nombra aria-label)`); assert.match(m[1], /<use href="#i-/, id);
    }
  });
  test("las ✕ de «cliente seleccionado» pasan a icono(\"cerrar\") y conservan aria-label", () => {
    const b = [...APP.matchAll(/<button type="button" id="btnQuitar\w+ClienteSel" title="Quitar selección" aria-label="Quitar cliente seleccionado">\$\{icono\("cerrar"\)\}<\/button>/g)];
    assert.equal(b.length, 4);
  });
  test("la etiqueta visible de los accesos rápidos y del menú sigue siendo texto", () => {
    for (const l of ["Venta rápida (TPV)", "Cotizaciones", "Órdenes de servicio", "Citas", "Clientes y motos", "Inventario", "Finanzas y caja", "Créditos", "Gestor Web ↗", "Ajustes"])
      assert.ok(INDEX.includes(`<span class="qa-lbl">${l}</span>`), l);
  });
});

describe("UI-1C · tema", () => {
  const boton = (tema) => {
    const env = nuevoEntorno(); if (tema) env.doc.documentElement.setAttribute("data-theme", tema);
    const antes = env.doc.sumideros.length; env.win.actualizarBotonTema();
    return { href: env.doc.getElementById("btnTemaIcono").getAttribute("href"), texto: env.doc.getElementById("btnTemaTexto").textContent, sumideros: env.doc.sumideros.length - antes };
  };
  test("oscuro → ofrece «Modo claro» con i-sol; claro → «Modo oscuro» con i-luna; sin innerHTML", () => {
    assert.deepEqual(boton("dark"), { href: "#i-sol", texto: "Modo claro", sumideros: 0 });
    assert.deepEqual(boton("light"), { href: "#i-luna", texto: "Modo oscuro", sumideros: 0 });
    assert.deepEqual(boton(null), { href: "#i-sol", texto: "Modo claro", sumideros: 0 });   // sin preferencia guardada: oscuro por defecto
  });
  test("CSS: los iconos heredan currentColor; activo del menú y hover de accesos en rojo ENTIMOTORS; el acento solo por --ic-acento", () => {
    assert.match(INDEX, /svg\.ic \{ width: 1em; height: 1em;/);
    assert.match(INDEX, /\.nav-item\.active \.ic \{ color: var\(--red\); \}/);
    assert.match(INDEX, /\.qa-btn:hover \.qa-ic \{ color: var\(--red\); \}/);
    assert.match(INDEX, /\.qa-btn \.qa-ic \.ic \{ --ic-acento: var\(--red\); \}/);
    assert.match(INDEX, /\.ic \{ --ic-acento: currentColor; \}/);
  });
});

describe("UI-1C.1 · ajuste visual final", () => {
  test("accesos rápidos: icono ≈37 % mayor (1.6rem → 2.2rem) con márgenes negativos que devuelven la fila a su alto (no crece la tarjeta)", () => {
    assert.match(INDEX, /\.qa-btn \.qa-ic \{ display: inline-flex; font-size: 2\.2rem; line-height: 1; margin: -0\.3rem 0 -0\.3rem -0\.2rem; color: var\(--text\); \}/);
    // 2.2rem − 0.3rem − 0.3rem = 1.6rem: exactamente el alto de línea anterior
    assert.equal(Math.round((2.2 - 0.3 - 0.3) * 100) / 100, 1.6);
  });
  test("solo crecen los accesos rápidos: menú lateral, widgets, buscador y avisos conservan su tamaño", () => {
    assert.match(INDEX, /\.nav-item \.ic \{ font-size: 1\.15rem;/);
    assert.match(INDEX, /\.widget-mini \.ic \{ display: inline-flex; font-size: 1\.3rem;/);
    assert.match(INDEX, /\.search-result-row \.ic \{ display: inline-flex; font-size: 1\.2rem;/);
    assert.match(INDEX, /\.notif-row \.ic \{ display: inline-flex; font-size: 1\.15rem;/);
  });
  test("herramientas decorativas: opacidad 0.3 (antes 0.5), color apagado y dibujo al 75 % SIN tocar la caja ni la animación", () => {
    assert.match(INDEX, /\.qa-falling-tools \{ position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; opacity: 0\.3; color: var\(--text-muted\); \}/);
    assert.match(INDEX, /\.qa-falling-tools svg\.qa-tool \{ box-sizing: border-box; padding: 0\.125em; \}/);
    assert.match(INDEX, /\.qa-tool \{ position: absolute; top: -15%; font-size: 1\.1rem; opacity: 0; animation: qa-fall linear infinite; \}/);
    assert.match(INDEX, /100% \{ transform: translateY\(720%\) rotate\(200deg\); opacity: 0; \}/);
    assert.equal([...INDEX.matchAll(/<svg class="ic qa-tool t\d"/g)].length, 6);
  });
  test("i-cliente simplificado: persona + moto en 7 trazos sin grupos, busto mayor y moto sin cruces; un único acento pequeño (la cabeza, antes cabeza + hombros)", () => {
    const c = SIMBOLOS.find((s) => s.id === "cliente").cuerpo;
    assert.equal([...c.matchAll(/<(circle|path|rect)\b/g)].length, 7);
    assert.equal([...c.matchAll(/--ic-acento/g)].length, 1);
    assert.match(c, /^<circle cx="7\.2" cy="4\.8" r="2\.5" style="stroke:var\(--ic-acento,currentColor\)"\/>/);
    assert.equal([...c.matchAll(/<circle\b/g)].length, 3, "cabeza + 2 ruedas");
    assert.doesNotMatch(c, /<g\b/);
  });
});

describe("UI-1C · Mi Trabajo hereda el mismo sprite", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-ui1c-mt-"));
  after(() => fs.rmSync(TMP, { recursive: true, force: true }));
  test("el build real (hacer-build-mecanicos.sh, en /tmp) trae el sprite idéntico y todas sus referencias resuelven", () => {
    const destino = path.join(TMP, "mt");
    const r = spawnSync("bash", [path.join(RUNTIME, "hacer-build-mecanicos.sh"), destino], { encoding: "utf8", env: { PATH: process.env.PATH, LC_ALL: "C.UTF-8" } });
    assert.equal(r.status, 0, r.stderr);
    const idx = fs.readFileSync(path.join(destino, "index.html"), "utf8");
    assert.ok(idx.includes(SPRITE), "sprite idéntico al del taller");
    for (const m of idx.matchAll(/<use\b[^>]*href="#i-([^"]+)"/g)) assert.ok(IDS.includes(m[1]), m[1]);
    assert.equal(fs.readFileSync(path.join(destino, "app.js"), "utf8"), APP, "mismo app.js (misma icono())");
  });
});
