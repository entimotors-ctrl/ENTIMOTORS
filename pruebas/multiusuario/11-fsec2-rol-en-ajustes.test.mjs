// F-SEC-2 (4E-C3-FIX2) — REGRESION DE SEGURIDAD: currentUser.rol NO controla marcado HTML en «Ajustes».
// app.js renderAjustes() pinta `Usuario: <b>nombre</b> (rol)` en #ajustesInfo con innerHTML. El NOMBRE siempre se escapo; el rol
// no: `NOMBRE_ROL[rol] || rol` cae al rol CRUDO cuando no es uno de los cuatro conocidos.
// Alcance real: el rol de una sesion de servidor esta acotado por perfiles_rol_check (4 valores); el rol crudo solo llega con una
// sesion guardada manipulada en el dispositivo (enti_session). Desde 4E-C4-FIX el portero (sesionAdmitida) YA la deniega (lista blanca),
// asi que el escape de «Ajustes» queda como DEFENSA EN PROFUNDIDAD: se sigue probando forzando currentUser, sin pasar por el portero.
// Propiedad obligatoria: lo que llega a innerHTML es SU PROPIA plantilla (<b>, </b>, <br>) + el rol ESCAPADO una sola vez; ningun
// elemento nuevo, ningun manejador, y quien mira la pantalla LEE el rol tal cual. Se comprueba la ESTRUCTURA del sumidero (lista
// de etiquetas), no la presencia de una palabra. No se ejecuta JS.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { escaparHtml, marcadoPeligroso } from "./helpers/dom.mjs";
import { leer } from "./helpers/entorno.mjs";
import { nuevoEntorno, como, dbFalsa } from "./helpers/flujos.mjs";
import { UUID } from "./helpers/supabase-mock.mjs";

const PAYLOADS = [
  ["img/onerror", "<img src=x onerror=alert(1)>"],
  ["svg/onload", "<svg onload=alert(1)>"],
  ["svg/onload tras romper atributo (variante de C3)", `"'><svg onload=alert(1)>`],
  ["script", "<script>alert(1)</script>"],
  ["iframe/javascript:", '<iframe src="javascript:alert(1)"></iframe>'],
  ["entidades ya codificadas", "&lt;img src=x onerror=alert(1)&gt;"],
];
const CARACTERES = `a<b>c&d"e'f`;
const NOMBRE = "Persona Sintetica";
const ROLES_NORMALES = [["admin", "administrador"], ["mecanico", "mecánico"], ["cajero", "cajero"], ["desarrollador", "desarrollador"]];
// Plantilla EXACTA de #ajustesInfo con un rol normal, capturada ANTES del fix: el fix no debe cambiar ni un caracter.
const DORADO = (etiqueta) => `\n    Usuario: <b>${NOMBRE}</b> (${etiqueta})<br>\n    Este dispositivo arrancó en blanco · 0 registros guardados en total.\n  `;
const ETIQUETAS_PROPIAS = ["<b>", "</b>", "<br>"];

const etiquetas = (html) => html.match(/<\/?[A-Za-z!?][^>]*>/g) || [];
/** Lo que un navegador MOSTRARIA como texto: se vuelca el HTML a un nodo y se lee su texto. */
const textoVisible = (env, html) => { const d = env.doc.createElement("div"); d.innerHTML = html; return d.textContent; };

/** Entorno con la sesion `usuario` ya puesta como currentUser, y Ajustes pintado. */
async function ajustes(usuario, { mutar } = {}) {
  const env = nuevoEntorno(mutar ? { mutar: { app: mutar } } : {});
  como(env, usuario === null ? null : { origen: "supabase", perfilId: UUID(9), nombre: NOMBRE, activo: true, ...usuario }); dbFalsa(env, {});
  await env.win.renderAjustes();
  return env;
}
const infoHtml = (env) => env.doc.getElementById("ajustesInfo").innerHTML;
const parteRol = (html) => (/<b>.*<\/b> \((.*)\)<br>\n\s*Este dispositivo/s.exec(html) || [])[1];

/** Violaciones de la propiedad para un rol concreto (lista vacia = propiedad cumplida). `rol` es lo que viaja en la sesion. */
async function violaciones(rol, opciones) {
  const env = await ajustes({ rol }, opciones); const html = infoHtml(env); const v = [];
  const texto = String(rol);
  if (JSON.stringify(etiquetas(html)) !== JSON.stringify(ETIQUETAS_PROPIAS)) v.push(`etiquetas en el sumidero: ${JSON.stringify(etiquetas(html))}`);
  if (marcadoPeligroso(html).length) v.push(`marcado activo: ${[...new Set(marcadoPeligroso(html))].join(", ")}`);
  if (parteRol(html) !== escaparHtml(texto)) v.push(`el rol no llego escapado exactamente una vez: «${parteRol(html)}»`);
  if (!textoVisible(env, html).includes(`Usuario: ${NOMBRE} (${texto})`)) v.push("el usuario no leeria el rol tal cual");
  return v;
}
async function violacionesTodas(roles, opciones) {
  const mal = []; for (const [nombre, rol] of roles) { const v = await violaciones(rol, opciones); if (v.length) mal.push(`${nombre}: ${v.join("; ")}`); } return mal;
}

describe("F-SEC-2 · el rol de la sesion NO llega como marcado a #ajustesInfo", () => {
  test("img/onerror, svg/onload, variante de C3, script, iframe y entidades → el sumidero recibe solo <b>, </b>, <br> + el rol escapado", async () => {
    const mal = await violacionesTodas(PAYLOADS); assert.deepEqual(mal, [], `F-SEC-2: ${mal.join(" | ")}`);
  });
  test("comillas, ampersand y ángulos (a<b>c&d\"e'f) se conservan de forma SEGURA: el usuario los ve tal cual y el sumidero los lleva como entidades", async () => {
    assert.deepEqual(await violacionesTodas([["caracteres", CARACTERES]]), []);
    assert.equal(parteRol(infoHtml(await ajustes({ rol: CARACTERES }))), "a&lt;b&gt;c&amp;d&quot;e&#39;f");
  });
  test("un rol que NO es cadena (arreglo JSON con el payload, en una sesion guardada) tampoco entra como marcado", async () => {
    // JSON.parse de enti_session puede devolver un arreglo: String([x]) === x, asi que sin escapar se interpola crudo.
    const mal = await violacionesTodas([["arreglo con img/onerror", ["<img src=x onerror=alert(1)>"]], ["arreglo con svg/onload", ["<svg onload=alert(1)>"]]]);
    assert.deepEqual(mal, [], `F-SEC-2: ${mal.join(" | ")}`);
  });
  test("claves heredadas de Object (constructor, __proto__, toString): NOMBRE_ROL[rol] las resuelve, y aun asi no aparece ningun elemento nuevo", async () => {
    for (const rol of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const html = infoHtml(await ajustes({ rol })); assert.deepEqual(etiquetas(html), ETIQUETAS_PROPIAS, rol); assert.deepEqual(marcadoPeligroso(html), [], rol);
    }
  });
  test("el hostil tambien es seguro cuando el NOMBRE y el ROL son hostiles a la vez (cada uno escapado una vez)", async () => {
    const [, p] = PAYLOADS[0]; const env = await ajustes({ rol: p, nombre: p }); const html = infoHtml(env);
    assert.deepEqual(etiquetas(html), ETIQUETAS_PROPIAS); assert.deepEqual(marcadoPeligroso(html), []); assert.ok(html.includes(`<b>${escaparHtml(p)}</b> (${escaparHtml(p)})<br>`));
  });
});

describe("no regresion visual: con roles normales la pantalla es EXACTAMENTE la de antes", () => {
  for (const [rol, etiqueta] of ROLES_NORMALES) test(`rol «${rol}» → «(${etiqueta})» y el HTML completo de #ajustesInfo es identico al de antes del fix`, async () => {
    const html = infoHtml(await ajustes({ rol })); assert.equal(html, DORADO(etiqueta));
    assert.deepEqual(etiquetas(html), ETIQUETAS_PROPIAS); assert.deepEqual(marcadoPeligroso(html), []);   // la etiqueta conocida no es el rol crudo: no aplica «rol escapado», si «sin marcado»
  });
  test("un rol desconocido pero inocuo se sigue mostrando literal (no se restringen valores nuevos en esta fase)", async () => {
    for (const rol of ["auditor", "Supervisor de patio", "rol-2"]) { assert.equal(infoHtml(await ajustes({ rol })), DORADO(rol), rol); assert.deepEqual(await violaciones(rol), [], rol); }
  });
  test("rol vacio, null, ausente o falso → «(—)» sin romper la pantalla; sin sesion → «Usuario: — (—)»", async () => {
    for (const rol of ["", null, undefined, 0, false]) assert.equal(infoHtml(await ajustes({ rol })), DORADO("—"), String(rol));
    const sin = await ajustes(null); assert.equal(infoHtml(sin), "\n    Usuario: <b>—</b> (—)<br>\n    Este dispositivo arrancó en blanco · 0 registros guardados en total.\n  ");
  });
  test("solo cambia lo que hay dentro del paréntesis: el resto de #ajustesInfo (nombre, modo, registros) queda igual", async () => {
    const env = await ajustes({ rol: "<img src=x onerror=alert(1)>" }); const html = infoHtml(env);
    assert.equal(html.replace(/\(.*\)/s.exec(html)[0], "(X)"), DORADO("X"));
  });
});

describe("cadena completa: sesion guardada manipulada → portero (lista blanca, 4E-C4-FIX) y, como defensa en profundidad, el escape de «Ajustes» (no hay red)", () => {
  const hostil = { user: "x", nombre: NOMBRE, telefono: "", rol: "<img src=x onerror=alert(1)>", origen: "local" };
  test("enti_session con rol hostil: el portero la DENIEGA — no se abre ninguna base, se descarta enti_session, se avisa y #ajustesInfo NUNCA se pinta", async () => {
    const env = nuevoEntorno({ sesionGuardada: hostil, espiarStartApp: false }); await env.asentar();
    assert.equal(env.evaluar(`sesionAdmitida(${JSON.stringify(hostil)})`).ok, false);   // .ok y no deepEqual: el objeto nace en otro realm de node:vm
    assert.deepEqual(env.idbAbiertas, []); assert.equal(env.almacen.getItem("enti_session"), null);
    assert.equal(env.doc.getElementById("loginError").textContent, "Tu rol no tiene acceso a ENTIMOTORS Taller."); assert.equal(infoHtml(env), "");
  });
  test("defensa en profundidad: aun forzando currentUser con ese rol (sin pasar por el portero), #ajustesInfo NO recibe marcado", async () => {
    const env = nuevoEntorno(); como(env, hostil); dbFalsa(env, {}); await env.win.renderAjustes();
    assert.deepEqual(etiquetas(infoHtml(env)), ETIQUETAS_PROPIAS); assert.deepEqual(marcadoPeligroso(infoHtml(env)), []);
  });
});

/** Guarda estatica sobre el TEXTO de app.js: cada ${…} de la plantilla de #ajustesInfo es un valor interno o UNA sola llamada a esc(). */
function guardaEstatica(s) {
  const v = [];
  const plantilla = /getElementById\("ajustesInfo"\)\.innerHTML\s*=\s*`([^`]*)`/.exec(s);
  if (!plantilla) return ["no se encontro la plantilla de #ajustesInfo"];
  const INTERNOS = new Set(["modo", "totalRegistros"]);   // cadena/numero calculados dentro de renderAjustes, nunca de la sesion
  const unaSolaLlamadaEsc = (e) => {
    if (!e.startsWith("esc(")) return false;
    let d = 0; for (let i = 3; i < e.length; i++) { if (e[i] === "(") d++; else if (e[i] === ")" && --d === 0) return i === e.length - 1; }
    return false;
  };
  const expresiones = [...plantilla[1].matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
  if (!expresiones.length) v.push("la plantilla no interpola nada (¿cambio de forma?)");
  for (const e of expresiones) if (!INTERNOS.has(e) && !unaSolaLlamadaEsc(e)) v.push(`interpolacion sin esc(): \${${e}}`);
  if (!expresiones.some((e) => /currentUser\?\.rol/.test(e) && unaSolaLlamadaEsc(e))) v.push("el rol no va dentro de una llamada esc()");
  return v;
}
describe("guarda estatica de app.js: ninguna interpolacion de #ajustesInfo llega sin esc()", () => {
  test("app.js real cumple la guarda: nombre y rol van cada uno dentro de UNA llamada a esc(); solo modo y totalRegistros van directos", () => assert.deepEqual(guardaEstatica(leer("app.js")), []));
});

describe("mutantes: si se quita el escape del rol (o se «arregla» mal), la prueba VUELVE A FALLAR (en memoria; ningun archivo real se toca)", () => {
  const cambiar = (de, a) => (t) => { const r = t.split(de).join(a); if (r === t) throw new Error(`mutante sin efecto: ${de}`); return r; };
  const ROL = 'NOMBRE_ROL[currentUser?.rol] || currentUser?.rol || "—"';
  const MUTANTES = [
    ["se QUITA el escape del rol (el codigo original de F-SEC-2)", cambiar(`(\${esc(${ROL})})`, `(\${${ROL}})`)],
    ["se escapa solo la ETIQUETA de NOMBRE_ROL, no el rol crudo (esc en el punto equivocado)", cambiar(`(\${esc(${ROL})})`, '(${esc(NOMBRE_ROL[currentUser?.rol]) || currentUser?.rol || "—"})')],
    ["el rol se escapa DOS veces (entidades duplicadas ilegibles)", cambiar(`(\${esc(${ROL})})`, `(\${esc(esc(${ROL}))})`)],
    ["se «arregla» restringiendo: todo rol desconocido se muestra como «—» (cambia la logica de valores, fuera de alcance)", cambiar(`(\${esc(${ROL})})`, '(${NOMBRE_ROL[currentUser?.rol] || "—"})')],
  ];
  const propiedad = async (mutar) => {
    const seguro = (await violacionesTodas([...PAYLOADS, ["caracteres", CARACTERES], ["desconocido inocuo", "auditor"]], mutar ? { mutar } : undefined)).length === 0;
    if (!seguro) return false;
    for (const [rol, etiqueta] of ROLES_NORMALES) if (infoHtml(await ajustes({ rol }, mutar ? { mutar } : undefined)) !== DORADO(etiqueta)) return false;
    return true;
  };
  test("con el codigo REAL la propiedad se cumple (linea base de los mutantes)", async () => assert.equal(await propiedad(), true));
  for (const [nombre, mut] of MUTANTES) test(`mutante: ${nombre}`, async () => assert.equal(await propiedad(mut), false, "el mutante SOBREVIVE: ninguna prueba protege esta garantia"));
  test("mutante estatico: quitar el escape del rol rompe la guarda estatica; escaparlo solo a medias, tambien", () => {
    const real = leer("app.js");
    assert.ok(guardaEstatica(cambiar(`(\${esc(${ROL})})`, `(\${${ROL}})`)(real)).some((x) => /interpolacion sin esc\(\)/.test(x)));
    assert.ok(guardaEstatica(cambiar(`(\${esc(${ROL})})`, '(${esc(NOMBRE_ROL[currentUser?.rol]) || currentUser?.rol || "—"})')(real)).some((x) => /interpolacion sin esc\(\)/.test(x)));
  });
});
