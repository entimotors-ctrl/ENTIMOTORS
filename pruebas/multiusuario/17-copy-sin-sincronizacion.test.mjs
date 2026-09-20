// COPY SIN SINCRONIZACION (4E-C5.1) — 3.13.0 = identidad + acceso + roles; los datos operativos son LOCALES a cada dispositivo.
// Propiedad congelada: la interfaz NO afirma sincronizacion operativa («sincronizado», «sincronizando», «sincronizacion» describiendo datos actuales).
// Los tres textos heredados del simulador de conexion se cambiaron (solo la cadena visible; sin tocar logica, temporizadores ni condiciones):
//   chip inicial de index.html        «En línea · sincronizado»                             → «En línea · datos locales»
//   aviso al «volver a estar en linea» «Conexión restaurada — sincronizando cambios pendientes» → «Conexión restaurada — procesando cambios locales…»
//   aviso final (1200 ms despues)      «Todo sincronizado»                                    → «Cambios guardados localmente»
// Unica mencion restante de «sincroniz…» con texto visible: la nota HONESTA de Mi Trabajo («…estará disponible en una versión posterior»).
// Unica cadena de codigo restante: la rama de renderSyncChip() bajo `HAY_SERVIDOR = true`, INALCANZABLE hoy (const false; retorno previo).
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { leer, RUNTIME } from "./helpers/entorno.mjs";
import { nuevoEntorno, toasts } from "./helpers/flujos.mjs";

const INDEX = leer("index.html"), APP = leer("app.js");
const NOTA_MT = "La asignación y sincronización de trabajos entre dispositivos estará disponible en una versión posterior.";
const NUEVO = { chip: "En línea · datos locales", proceso: "Conexión restaurada — procesando cambios locales…", final: "Cambios guardados localmente", chipArranque: "Solo en este dispositivo · respalda seguido" };
const VIEJO = { chip: "En línea · sincronizado", proceso: "Conexión restaurada — sincronizando cambios pendientes", final: "Todo sincronizado" };
const SINCRO = /sincroniz/i;
const RAMA_MUERTA = 'label.textContent = "En línea · sincronizado";';

// ── lectores ──
const textoVisible = (html) => html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const atributosVisibles = (html) => [...html.matchAll(/\b(?:title|placeholder|aria-label|alt|value|content)="([^"]*)"/g)].map((m) => m[1]);
/** Por cada linea de JS, la parte que es CODIGO (comentarios de linea y de bloque en blanco; las cadenas se conservan). Devuelve las que nombran «sincroniz…». */
function codigoConSincronizacion(js) {
  const salida = []; let bloque = false, cadena = null;
  js.split("\n").forEach((linea, n) => {
    let codigo = "";
    for (let i = 0; i < linea.length; i++) {
      const c = linea[i], d = linea[i + 1];
      if (bloque) { if (c === "*" && d === "/") { bloque = false; i++; } continue; }
      if (cadena) { codigo += c; if (c === "\\") { codigo += d ?? ""; i++; } else if (c === cadena) cadena = null; continue; }
      if (c === "/" && d === "*") { bloque = true; i++; continue; }
      if (c === "/" && d === "/") break;
      if (c === '"' || c === "'" || c === "`") cadena = c;
      codigo += c;
    }
    if (cadena && cadena !== "`") cadena = null;      // una cadena "…" o '…' no cruza lineas (la de plantilla si puede)
    if (SINCRO.test(codigo)) salida.push({ linea: n + 1, codigo: codigo.trim() });
  });
  return salida;
}
const cuenta = (t, s) => t.split(s).length - 1;

// ── verificaciones estaticas (funciones puras: sirven para el codigo real y para los mutantes) ──
function violacionesIndex(html) {
  const v = [];
  if (SINCRO.test(textoVisible(html).replace(NOTA_MT, ""))) v.push("texto visible con «sincroniz…»");
  for (const a of atributosVisibles(html)) if (SINCRO.test(a.replace(NOTA_MT, ""))) v.push(`atributo visible: ${a}`);
  if (!html.includes(`<span id="syncLabel">${NUEVO.chip}</span>`)) v.push("el chip inicial no es «En línea · datos locales»");
  return v;
}
function violacionesApp(js) {
  const v = [];
  for (const { codigo } of codigoConSincronizacion(js)) if (codigo !== RAMA_MUERTA) v.push(`cadena de codigo con «sincroniz…»: ${codigo}`);
  if (js.includes(RAMA_MUERTA)) {                                               // la unica admitida: solo si sigue siendo INALCANZABLE
    const f = js.indexOf("function renderSyncChip()"), corte = /if \(!HAY_SERVIDOR\) \{[\s\S]*?return;\s*\}/.exec(js.slice(f));
    if (!/^const HAY_SERVIDOR = false;$/m.test(js) || f < 0 || !corte || f + corte.index + corte[0].length > js.indexOf(RAMA_MUERTA)) v.push("la rama «sincronizado» es alcanzable");
  }
  for (const k of ["proceso", "final"]) if (cuenta(js, NUEVO[k]) !== 1) v.push(`falta el aviso nuevo «${NUEVO[k]}»`);
  return v;
}

describe("index.html · texto visible", () => {
  test("el chip inicial dice «En línea · datos locales» y ya no «sincronizado»", () => {
    assert.ok(INDEX.includes(`<span id="syncLabel">${NUEVO.chip}</span>`)); assert.ok(!INDEX.includes(VIEJO.chip));
  });
  test("solo queda UNA mencion de «sincroniz…» y es la nota honesta de Mi Trabajo (no hay «sincronizado/sincronizando» en el texto visible ni en atributos)", () => {
    const v = textoVisible(INDEX); assert.equal(cuenta(v, NOTA_MT), 1); assert.deepEqual(violacionesIndex(INDEX), []);
    assert.ok(!/sincronizad|sincronizando/i.test(v)); assert.equal((v.match(/sincroniz/gi) || []).length, 1);
  });
});

describe("app.js · cadenas de codigo", () => {
  test("los avisos del boton «Simular sin conexión» son los nuevos y los viejos ya no existen como texto", () => {
    assert.equal(cuenta(APP, `toast(forcedOffline ? "Modo sin conexión activado" : "${NUEVO.proceso}");`), 1);
    assert.equal(cuenta(APP, `toast("${NUEVO.final}");`), 1);
    for (const t of [VIEJO.proceso, "toast(\"Todo sincronizado\")"]) assert.ok(!APP.includes(t), `ya no debe existir: ${t}`);
  });
  test("la unica cadena de codigo con «sincroniz…» es la rama de HAY_SERVIDOR=true, inalcanzable (const false + retorno previo)", () => {
    assert.deepEqual(codigoConSincronizacion(APP).map((x) => x.codigo), [RAMA_MUERTA]); assert.deepEqual(violacionesApp(APP), []);
    assert.equal(cuenta(APP, "const HAY_SERVIDOR = false;"), 1);
  });
  test("ningun otro archivo del runtime (js, html, json) trae «sincroniz…» como texto de interfaz", () => {
    const archivos = [...fs.readdirSync(RUNTIME), ...fs.readdirSync(path.join(RUNTIME, "build-mecanicos")).map((f) => `build-mecanicos/${f}`)]
      .filter((f) => /\.(js|html|json)$/.test(f) && f !== "app.js" && f !== "index.html");
    assert.ok(archivos.length >= 10, `se esperaban los archivos del runtime (hay ${archivos.length})`);
    for (const f of archivos) {
      const t = leer(f);
      const hallado = f.endsWith(".js") ? codigoConSincronizacion(t) : f.endsWith(".html") ? [textoVisible(t), ...atributosVisibles(t)].filter((x) => SINCRO.test(x)) : SINCRO.test(t) ? [t] : [];
      assert.deepEqual(hallado, [], `${f} no debe hablar de sincronizacion en la interfaz`);
    }
  });
  test("el BUILD de Mi Trabajo (hacer-build-mecanicos.sh, en /tmp) solo trae la nota honesta", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-c51-build-")), destino = path.join(tmp, "mecanicos");
    try {
      const r = spawnSync("bash", [path.join(RUNTIME, "hacer-build-mecanicos.sh"), destino], { encoding: "utf8", env: { PATH: process.env.PATH, LC_ALL: "C.UTF-8" } }); assert.equal(r.status, 0, r.stderr);
      const idx = fs.readFileSync(path.join(destino, "index.html"), "utf8"); assert.deepEqual(violacionesIndex(idx), []);
      assert.equal((textoVisible(idx).match(/sincroniz/gi) || []).length, 1); assert.deepEqual(codigoConSincronizacion(fs.readFileSync(path.join(destino, "app.js"), "utf8")).map((x) => x.codigo), [RAMA_MUERTA]);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ── comportamiento del simulador de conexion (runtime real en el DOM sintetico): solo cambio el TEXTO ──
async function recorrer({ mutar, conPendientes = true } = {}) {
  const env = nuevoEntorno({ ...(mutar ? { mutar } : {}) }); await env.asentar();
  const boton = env.doc.getElementById("offlineToggle"), chip = () => [env.doc.getElementById("syncLabel").textContent, env.doc.getElementById("syncDot").className];
  const r = { chips: [], toasts: [], botones: [] };
  env.evaluar("renderSyncChip()"); r.chips.push(chip());                                    // en linea, nada pendiente
  await boton.click(); r.botones.push(boton.textContent); r.chips.push(chip());               // sin conexion simulada
  if (conPendientes) { const t0 = env.timersPendientes(); env.evaluar("markDirty()"); r.chips.push(chip()); r.pendientes = env.evaluar("pending"); r.timersMarkDirty = env.timersPendientes() - t0; }
  const t1 = env.timersPendientes(); await boton.click(); r.botones.push(boton.textContent); r.chips.push(chip());   // vuelve a estar en linea
  r.timersAlVolver = env.timersPendientes() - t1;
  await env.avanzar(1199); r.antesDeLos1200 = toasts(env).slice(); r.pendientesAntes = env.evaluar("pending");
  await env.avanzar(1); r.toasts = toasts(env).slice(); r.pendientesDespues = env.evaluar("pending"); r.chips.push(chip());
  r.hayServidor = env.evaluar("HAY_SERVIDOR"); r.errores = env.consola.error.slice();
  return r;
}
const violacionesFlujo = (r) => {
  const v = [];
  for (const t of r.toasts) if (SINCRO.test(t)) v.push(`aviso con «sincroniz…»: ${t}`);
  for (const [t] of r.chips) if (SINCRO.test(t)) v.push(`chip con «sincroniz…»: ${t}`);
  if (!r.toasts.includes(NUEVO.proceso)) v.push("falta el aviso de proceso"); if (!r.toasts.includes(NUEVO.final)) v.push("falta el aviso final");
  return v;
};

describe("Simular sin conexión · el flujo real muestra los textos nuevos y NADA de sincronizacion", () => {
  test("con cambios pendientes: «Modo sin conexión activado» → «Conexión restaurada — procesando cambios locales…» → (1200 ms) «Cambios guardados localmente»", async () => {
    const r = await recorrer();
    assert.deepEqual(r.toasts, ["Modo sin conexión activado", NUEVO.proceso, NUEVO.final]); assert.deepEqual(violacionesFlujo(r), []);
    assert.deepEqual(r.botones, ["Volver a estar en línea", "Simular sin conexión"]);
    assert.deepEqual(r.errores, []);
  });
  test("la logica NO cambio: el aviso final llega a los 1200 ms exactos y solo si habia cambios pendientes; los pendientes se ponen en 0", async () => {
    const r = await recorrer();
    assert.equal(r.pendientes, 1); assert.equal(r.timersMarkDirty, 0, "sin conexion, markDirty no programa temporizador");
    assert.deepEqual(r.antesDeLos1200, ["Modo sin conexión activado", NUEVO.proceso]); assert.equal(r.pendientesAntes, 1);
    assert.equal(r.pendientesDespues, 0);
    const sin = await recorrer({ conPendientes: false }); assert.deepEqual(sin.toasts, ["Modo sin conexión activado", NUEVO.proceso], "sin pendientes no hay aviso final");
    assert.equal(r.timersAlVolver - sin.timersAlVolver, 1, "con pendientes se programa UN temporizador mas (el de 1200 ms)");
  });
  test("el chip nunca dice «sincronizado»: en linea, sin conexion simulada, con pendientes y al terminar muestra siempre «Solo en este dispositivo · respalda seguido»", async () => {
    const r = await recorrer(); assert.equal(r.hayServidor, false);
    assert.equal(r.chips.length, 5); for (const [texto, punto] of r.chips) assert.deepEqual([texto, punto], [NUEVO.chipArranque, "dot off"]);
  });
});

describe("Las guardas DETECTAN la regresion (mutantes en memoria; nada se escribe en disco)", () => {
  const conViejo = (o, n) => (t) => t.replace(o, n);
  test("index.html con el chip viejo, o con «sincronizado» en cualquier texto visible o atributo → violacion", () => {
    assert.ok(violacionesIndex(INDEX.replace(NUEVO.chip, VIEJO.chip)).length >= 1);
    assert.ok(violacionesIndex(INDEX.replace("<h1>", "<h1>Todo sincronizado ")).length >= 1 || !INDEX.includes("<h1>"));
    assert.ok(violacionesIndex(INDEX.replace('id="offlineToggle"', 'id="offlineToggle" aria-label="Datos sincronizados"')).length >= 1);
  });
  test("app.js: reponer cualquiera de los avisos viejos, o alcanzar la rama «sincronizado», o dejarla sin guarda → violacion", () => {
    assert.ok(violacionesApp(APP.replace(NUEVO.proceso, VIEJO.proceso)).length >= 1);
    assert.ok(violacionesApp(APP.replace(`toast("${NUEVO.final}")`, `toast("${VIEJO.final}")`)).length >= 1);
    assert.ok(violacionesApp(APP.replace("const HAY_SERVIDOR = false;", "const HAY_SERVIDOR = true;")).length >= 1);
    assert.ok(violacionesApp(APP.replace(/if \(!HAY_SERVIDOR\) \{/, "if (HAY_SERVIDOR === 1) {")).length >= 1);
    assert.ok(violacionesApp(APP + `\nfunction x() { toast("Ya sincronizado con el servidor"); }\n`).length >= 1);
    assert.deepEqual(violacionesApp(APP + "\n// un comentario que dice sincronizado no cuenta\n/* ni este sincronización */\n"), []);
  });
  test("el flujo real detecta el aviso viejo de proceso, el viejo final y la rama «sincronizado» alcanzada (runtime mutado)", async () => {
    assert.ok(violacionesFlujo(await recorrer({ mutar: { app: conViejo(NUEVO.proceso, VIEJO.proceso) } })).length >= 1);
    assert.ok(violacionesFlujo(await recorrer({ mutar: { app: conViejo(`toast("${NUEVO.final}")`, `toast("${VIEJO.final}")`) } })).length >= 1);
    const abierta = await recorrer({ mutar: { app: conViejo("const HAY_SERVIDOR = false;", "const HAY_SERVIDOR = true;") } });
    assert.ok(violacionesFlujo(abierta).length >= 1 && abierta.chips.some(([t]) => /sincroniz/i.test(t)));
  });
});
