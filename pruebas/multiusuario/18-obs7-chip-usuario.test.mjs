// OBS-7 (4E-C7-FIX-A) — el chip del usuario en el topbar («Admin Activo / administrador») se veía apretado en escritorio y con un nombre largo
// (el api-server admite hasta 60 letras) rompía el topbar. Corrección: SOLO CSS de index.html, sin tocar el marcado ni ningun JS.
//
// Lo que aqui se congela (leyendo el CSS REAL de index.html, sin navegador; el efecto de pintado lo miden los casos OBS-7 de la suite de navegador):
//   escritorio → `.user-chip` compacto (radio y padding chicos, line-height 1.25) con `max-width`, y elipsis en nombre y rol;
//   móvil      → el bloque `.account-panel …` conserva lo que ya tenia (padding .6rem .7rem, radio .6rem, white-space normal) y ADEMAS anula
//                el tope y la elipsis: nombre completo, en varias lineas si hace falta.
// Cada garantia lleva su prueba de mutacion: se altera el CSS en memoria y la comprobacion debe romperse.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { leer } from "./helpers/entorno.mjs";

const INDEX = leer("index.html");
const MEDIA_MOVIL = /@media \(max-width: 900px\) and \(pointer: coarse\), \(max-width: 640px\)\s*\{/;
const MARCADO_CHIP = '<span class="chip user-chip"><span class="who"><span id="loggedUserName">—</span><small id="loggedUserRole"></small></span></span>';

// ── lector de CSS minimo (las reglas de index.html no anidan mas de un @media) ──
function bloque(texto, desdeRegex) {
  const m = desdeRegex.exec(texto); if (!m) return null;
  let i = m.index + m[0].length, d = 1;
  for (; i < texto.length && d > 0; i++) d += (texto[i] === "{") - (texto[i] === "}");
  return { dentro: texto.slice(m.index + m[0].length, i - 1), inicio: m.index, fin: i };
}
const reglasDe = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim().replace(/\s+/g, " "), cuerpo: m[2] }));
const decl = (cuerpo, prop) => { const m = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(cuerpo); return m ? m[1].trim() : null; };
/** Especificidad (ids, clases/atributos/pseudo, elementos) del ultimo compuesto de una lista de selectores; solo cubre lo que usa index.html aqui. */
function especificidad(sel) {
  const a = (sel.match(/#[\w-]+/g) || []).length, b = (sel.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
  const e = (sel.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:[\w-]+|[>+~]/g, " ").match(/\b[a-z][a-z0-9]*\b/gi) || []).length;
  return [a, b, e];
}
const mayor = (x, y) => { for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const rem = (v) => { const m = /^([\d.]+)rem$/.exec(String(v || "").trim()); return m ? Number(m[1]) : NaN; };

/** Devuelve [{id, ok, detalle}] para un index.html dado. Se usa tal cual sobre el real y sobre los mutantes. */
function verificarChip(html) {
  const R = []; const chk = (id, ok, detalle = "") => R.push({ id, ok: Boolean(ok), detalle: ok ? "" : detalle });
  const css = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
  const mv = bloque(css, MEDIA_MOVIL);
  const escritorio = reglasDe(css.slice(0, mv ? mv.inicio : css.length) + (mv ? css.slice(mv.fin) : ""));
  const movil = mv ? reglasDe(mv.dentro) : [];
  const de = (lista, sel) => lista.filter((r) => r.sel === sel).map((r) => r.cuerpo).join(";");
  const chip = de(escritorio, ".user-chip"), quien = de(escritorio, ".user-chip .who");
  const elipsis = de(escritorio, ".user-chip .who > span, .user-chip .who small");
  const rol = de(escritorio, ".user-chip .who small");
  const chipM = de(movil, ".account-panel .user-chip"), textoM = de(movil, ".account-panel .user-chip .who > span, .account-panel .user-chip .who small");

  chk("D1 escritorio: tope de ancho en rem entre 12 y 20", rem(decl(chip, "max-width")) >= 12 && rem(decl(chip, "max-width")) <= 20, `max-width=${decl(chip, "max-width")}`);
  chk("D2 escritorio: ya no es una pildora de 999px", !/999px/.test(decl(chip, "border-radius") || "999px"), `border-radius=${decl(chip, "border-radius")}`);
  chk("D3 escritorio: line-height compacto (<= 1.35) en el chip", Number(decl(chip, "line-height")) > 0 && Number(decl(chip, "line-height")) <= 1.35, `line-height=${decl(chip, "line-height")}`);
  chk("D4 escritorio: padding vertical chico (<= .4rem)", rem((decl(chip, "padding") || "").split(/\s+/)[0]) <= 0.4, `padding=${decl(chip, "padding")}`);
  chk("D5 escritorio: .who puede encogerse (min-width:0), requisito de la elipsis en un hijo flex", decl(quien, "min-width") === "0", `min-width=${decl(quien, "min-width")}`);
  chk("D6 escritorio: nombre y rol recortan con elipsis", decl(elipsis, "overflow") === "hidden" && decl(elipsis, "text-overflow") === "ellipsis" && decl(elipsis, "white-space") === "nowrap" && decl(elipsis, "display") === "block", `regla=${elipsis}`);
  chk("D7 escritorio: el rol conserva su estilo propio (peso 400, color tenue, .72rem)", decl(rol, "font-weight") === "400" && /text-faint/.test(decl(rol, "color") || "") && decl(rol, "font-size") === "0.72rem", `regla=${rol}`);

  chk("M1 móvil: se conserva el fondo, padding .6rem .7rem y radio .6rem de antes", /var\(--panel\)/.test(decl(chipM, "background") || "") && decl(chipM, "padding") === "0.6rem 0.7rem" && decl(chipM, "border-radius") === "0.6rem", `regla=${chipM}`);
  chk("M2 móvil: se quita el tope de ancho del escritorio", decl(chipM, "max-width") === "none", `max-width=${decl(chipM, "max-width")}`);
  chk("M3 móvil: nombre y rol completos, en varias lineas (sin elipsis ni nowrap)", decl(textoM, "overflow") === "visible" && decl(textoM, "text-overflow") === "clip" && decl(textoM, "white-space") === "normal" && decl(textoM, "overflow-wrap") === "anywhere", `regla=${textoM}`);
  chk("M4 móvil: se conserva `.account-panel .chip { white-space: normal; width: 100% }`", decl(de(movil, ".account-panel .chip"), "white-space") === "normal" && decl(de(movil, ".account-panel .chip"), "width") === "100%", "falta la regla heredada");
  chk("M5 la regla móvil GANA por especificidad a la de escritorio (si no, la elipsis seguiria activa en el móvil)",
    mayor(especificidad(".account-panel .user-chip"), especificidad(".user-chip")) && mayor(especificidad(".account-panel .user-chip .who > span"), especificidad(".user-chip .who > span")), "especificidad insuficiente");
  chk("M6 el @media móvil sigue siendo el mismo (mismo umbral que .account-panel/#btnCuenta)", !!mv && /\.account-panel\.open\s*\{\s*display:\s*flex/.test(mv.dentro), "no se encontro el bloque móvil esperado");
  chk("S1 el marcado del chip no cambia (una sola vez, mismos ids y anidacion)", html.split(MARCADO_CHIP).length === 2, "el marcado del chip cambio");
  return R;
}
const fallos = (r) => r.filter((x) => !x.ok).map((x) => x.id.split(" ")[0]);

describe("OBS-7 · CSS real de index.html", () => {
  const R = verificarChip(INDEX);
  for (const c of R) test(c.id, () => assert.ok(c.ok, c.detalle));
  test("las 14 comprobaciones existen (nadie las borro para que pase)", () => assert.equal(R.length, 14));
});

describe("OBS-7 · pruebas de MUTACION: cada garantia se rompe si se altera la linea que la sostiene", () => {
  const mutar = (de, a) => { assert.ok(INDEX.includes(de), `el mutante no encuentra: ${de}`); return INDEX.replace(de, a); };
  const casos = [
    ["quitar el tope de ancho del escritorio", () => mutar("padding: 0.3rem 0.9rem; border-radius: 0.9rem; line-height: 1.25; max-width: 14rem; }", "padding: 0.3rem 0.9rem; border-radius: 0.9rem; line-height: 1.25; }"), "D1"],
    ["volver a la pildora de 999px", () => mutar("border-radius: 0.9rem; line-height: 1.25;", "border-radius: 999px; line-height: 1.25;"), "D2"],
    ["dejar el line-height heredado de 1.5", () => mutar("border-radius: 0.9rem; line-height: 1.25;", "border-radius: 0.9rem; line-height: 1.5;"), "D3"],
    ["padding vertical grande", () => mutar("padding: 0.3rem 0.9rem; border-radius: 0.9rem;", "padding: 0.9rem 0.9rem; border-radius: 0.9rem;"), "D4"],
    ["quitar min-width:0 de .who", () => mutar("font-size: 0.85rem; min-width: 0; }", "font-size: 0.85rem; }"), "D5"],
    ["quitar la elipsis", () => mutar("display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }", "display: block; }"), "D6"],
    ["el rol pierde su estilo", () => mutar(".user-chip .who small { font-weight: 400; color: var(--text-faint); font-size: 0.72rem; }", ".user-chip .who small { font-weight: 400; }"), "D7"],
    ["móvil: cambiar el padding de antes", () => mutar("padding: 0.6rem 0.7rem; border-radius: 0.6rem; max-width: none; }", "padding: 0.2rem 0.2rem; border-radius: 0.6rem; max-width: none; }"), "M1"],
    ["móvil: dejar el tope de ancho", () => mutar("border-radius: 0.6rem; max-width: none; }", "border-radius: 0.6rem; }"), "M2"],
    ["móvil: dejar la elipsis (nombre recortado)", () => mutar("overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }", "}"), "M3"],
    ["móvil: perder la regla heredada .account-panel .chip", () => mutar(".account-panel .chip { white-space: normal; width: 100%; }", ".account-panel .chip { width: 100%; }"), "M4"],
    ["móvil: bajar la especificidad de la regla que anula la elipsis", () => mutar(".account-panel .user-chip .who > span, .account-panel .user-chip .who small {", ".user-chip .who > span, .user-chip .who small {"), "M3"],
    ["alterar el marcado del chip", () => mutar(MARCADO_CHIP, MARCADO_CHIP.replace("chip user-chip", "user-chip")), "S1"],
  ];
  for (const [nombre, crear, id] of casos) {
    test(`mutante «${nombre}» → falla ${id}`, () => { const f = fallos(verificarChip(crear())); assert.ok(f.includes(id), `el mutante NO fue detectado por ${id}; fallaron: ${JSON.stringify(f)}`); });
  }
  test("control: sin mutar no falla ninguna", () => assert.deepEqual(fallos(verificarChip(INDEX)), []));
});
