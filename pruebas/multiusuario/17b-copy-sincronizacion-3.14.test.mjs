// COPY DE SINCRONIZACIÓN · contrato de 3.14.0 (árbol de trabajo). 3.13.0 no sincronizaba y su guarda (17-copy-sin-sincronizacion,
// sobre el tag v3.13.0) prohibía hablar de «sincroniz…». En 3.14.0 la sincronización EXISTE, así que la regla cambia a:
//   · el texto VISIBLE del HTML (taller y build de Mi Trabajo) sigue sin decir «sincroniz…» (la interfaz habla de «nube», «En línea»,
//     «⚠ Por revisar»…), y la nota vieja de Mi Trabajo («estará disponible en una versión posterior») ya no existe;
//   · en el CÓDIGO solo hay las menciones de esta LISTA CERRADA (app.js y sync-engine.js). Cualquier otra —texto nuevo que prometa
//     algo, un archivo más— hace fallar la prueba y obliga a revisarla aquí a propósito.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { leer, RUNTIME, ES_313 } from "./helpers/entorno.mjs";

const SINCRO = /sincroniz/i;
const NOTA_VIEJA = "La asignación y sincronización de trabajos entre dispositivos estará disponible en una versión posterior.";
const textoVisible = (html) => html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const atributosVisibles = (html) => [...html.matchAll(/\b(?:title|placeholder|aria-label|alt|value|content)="([^"]*)"/g)].map((m) => m[1]);
/** Mismo lector que 17-copy-sin-sincronizacion: por línea, el CÓDIGO (sin comentarios; las cadenas se conservan) que nombra «sincroniz…». */
function codigoConSincronizacion(js) {
  const salida = []; let bloque = false, cadena = null;
  js.split("\n").forEach((linea) => {
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
    if (cadena && cadena !== "`") cadena = null;
    if (SINCRO.test(codigo)) salida.push(codigo.trim());
  });
  return salida;
}
const LISTA = JSON.parse(fs.readFileSync(new URL("./17b-copy-sincronizacion-3.14.lista.json", import.meta.url), "utf8"));
const enRuntime = (raiz) => {
  const out = {};
  for (const f of fs.readdirSync(raiz).filter((x) => x.endsWith(".js")).sort()) { const c = codigoConSincronizacion(fs.readFileSync(path.join(raiz, f), "utf8")); if (c.length) out[f] = c; }
  return out;
};

describe("3.14.0 · texto visible", () => {
  test("se ejecuta sobre el árbol de trabajo (no sobre el tag 3.13.0)", () => assert.equal(ES_313, false));
  test("index.html: NINGÚN texto ni atributo visible dice «sincroniz…», y la nota vieja de Mi Trabajo ya no existe", () => {
    const idx = leer("index.html");
    assert.ok(!SINCRO.test(textoVisible(idx))); assert.deepEqual(atributosVisibles(idx).filter((a) => SINCRO.test(a)), []);
    assert.ok(!idx.includes(NOTA_VIEJA)); assert.match(idx, /id="miTrabajoAlcance"[\s\S]{0,200}trabajos que el administrador te asigna/);
  });
});

describe("3.14.0 · código", () => {
  test("las menciones de «sincroniz…» en el código son EXACTAMENTE las de la lista cerrada (archivo y texto, en orden)", () => {
    assert.deepEqual(enRuntime(RUNTIME), LISTA);
  });
  test("la lista cerrada no está vacía y solo abarca app.js y sync-engine.js", () => {
    assert.deepEqual(Object.keys(LISTA).sort(), ["app.js", "sync-engine.js"]); assert.ok(LISTA["app.js"].length > 0 && LISTA["sync-engine.js"].length > 0);
  });
  test("MUTANTES: un aviso nuevo con «sincroniz…» (o la nota vieja de vuelta) hace fallar las guardas", () => {
    const app = leer("app.js") + '\ntoast("Todo sincronizado");';
    assert.notDeepEqual(codigoConSincronizacion(app), LISTA["app.js"]);
    assert.ok(SINCRO.test(textoVisible(leer("index.html").replace("</body>", `<p>${NOTA_VIEJA}</p></body>`))));
  });
  test("el BUILD de Mi Trabajo (hacer-build-mecanicos.sh, en /tmp) cumple lo mismo: sin «sincroniz…» visible y el mismo código", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-314-copy-")), destino = path.join(tmp, "mecanicos");
    try {
      const r = spawnSync("bash", [path.join(RUNTIME, "hacer-build-mecanicos.sh"), destino], { encoding: "utf8", env: { PATH: process.env.PATH, LC_ALL: "C.UTF-8" } }); assert.equal(r.status, 0, r.stderr);
      const idx = fs.readFileSync(path.join(destino, "index.html"), "utf8");
      assert.ok(!SINCRO.test(textoVisible(idx))); assert.ok(!idx.includes(NOTA_VIEJA));
      assert.deepEqual(enRuntime(destino), LISTA);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
