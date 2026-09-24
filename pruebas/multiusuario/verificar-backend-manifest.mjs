#!/usr/bin/env node
// VERIFICADOR DETERMINISTA del manifest del BACKEND (api-server/) del candidato 3.13.0: pruebas/multiusuario/release-3.13.0-backend-manifest.json.
// El manifest del frontend (release-3.13.0-manifest.json) NO cubre api-server/; este lo cubre por separado (fuente, pruebas y, desde 4E-C9, los archivos
// COMPILADOS de api-server/dist/, grupo `generated_build_artifacts`). Sin dependencias, sin red, sin fecha ni azar:
// la misma entrada da SIEMPRE la misma salida (y el mismo codigo de salida).
//
//   node pruebas/multiusuario/verificar-backend-manifest.mjs                 → MATCH N archivos  (salida 0)  |  MANIFEST_MISMATCH <archivo> … + FAIL (salida 1)
//   node pruebas/multiusuario/verificar-backend-manifest.mjs --raiz <dir>    → lo mismo sobre OTRA raiz (una copia temporal); lee el manifest de <dir>/pruebas/multiusuario/
//   node pruebas/multiusuario/verificar-backend-manifest.mjs --regenerar     → SOLO para quien mantiene el freeze: reescribe sha256/bytes de los archivos YA listados (no añade ni quita)
//   … --manifest pruebas/multiusuario/release-3.14.0-backend-manifest.json  → otro manifest (3.14.0: backend y, con formato
//                                                                            entimotors-release-freeze/1, el del frontend). Sin la opción: el de 3.13.0, como siempre.
//
// Como se calcula cada hash (para reproducirlo a mano): SHA-256 de los BYTES EXACTOS del archivo en disco (sin normalizar saltos de linea ni codificacion);
// `bytes` es su tamaño. `sha256sum <archivo>` da el mismo valor. Cada ruta es RELATIVA a la raiz del repositorio y con «/» como separador.
// Falla CERRADO: ruta absoluta o con «..», campo mal formado, archivo ausente, duplicado o lista sin ordenar → problema.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// grupos por formato: el backend lleva además lo compilado (dist/); el manifest de release del frontend, la documentación
const GRUPOS_POR_FORMATO = { "entimotors-backend-freeze/1": ["runtime_files", "test_files", "generated_build_artifacts"], "entimotors-release-freeze/1": ["runtime_files", "documentation_files", "test_files"] };
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const RAIZ = path.resolve(opcion("raiz") ?? path.join(AQUI, "..", ".."));
const REL_MANIFEST = opcion("manifest") ?? "pruebas/multiusuario/release-3.13.0-backend-manifest.json";
if (path.isAbsolute(REL_MANIFEST) || REL_MANIFEST.split(/[\\/]/).includes("..")) { console.log(`MANIFEST_RUTA_INVALIDA ${REL_MANIFEST}`); console.log("FAIL 1 problemas"); process.exit(1); }
const RUTA_MANIFEST = path.join(RAIZ, ...REL_MANIFEST.split("/"));
const REGENERAR = args.includes("--regenerar");

const problemas = [];
const marca = (codigo, detalle) => problemas.push(`${codigo} ${detalle}`);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let manifiesto;
try { manifiesto = JSON.parse(fs.readFileSync(RUTA_MANIFEST, "utf8")); }
catch (e) { console.log(`MANIFEST_ILEGIBLE ${path.relative(RAIZ, RUTA_MANIFEST)}`); console.log("FAIL 1 problemas"); process.exit(1); }
const GRUPOS = GRUPOS_POR_FORMATO[manifiesto.format] || [];
if (!GRUPOS.length) marca("MANIFEST_FORMATO", String(manifiesto.format));

let total = 0; const vistos = new Set();
for (const grupo of GRUPOS) {
  const lista = manifiesto[grupo];
  if (!Array.isArray(lista) || lista.length === 0) { marca("MANIFEST_GRUPO_VACIO", grupo); continue; }
  const rutas = lista.map((e) => e && e.path);
  if (JSON.stringify(rutas) !== JSON.stringify([...rutas].sort())) marca("MANIFEST_SIN_ORDENAR", grupo);
  for (const e of lista) {
    total++;
    const p = e && e.path;
    if (typeof p !== "string" || p === "" || path.isAbsolute(p) || p.includes("\\") || p.split("/").includes("..") || p.split("/").includes(".")) { marca("MANIFEST_RUTA_INVALIDA", JSON.stringify(p)); continue; }
    if (vistos.has(p)) { marca("MANIFEST_DUPLICADO", p); continue; } vistos.add(p);
    if (!/^[0-9a-f]{64}$/.test(String(e.sha256)) || !Number.isInteger(e.bytes) || e.bytes < 0) { marca("MANIFEST_ENTRADA_MAL_FORMADA", p); continue; }
    const destino = path.join(RAIZ, ...p.split("/"));
    let bytes; try { bytes = fs.readFileSync(destino); } catch { marca("MANIFEST_MISSING", p); continue; }
    if (REGENERAR) { e.sha256 = sha(bytes); e.bytes = bytes.length; continue; }
    if (sha(bytes) !== e.sha256 || bytes.length !== e.bytes) marca("MANIFEST_MISMATCH", p);
  }
}

if (REGENERAR) {
  if (problemas.length) { for (const l of problemas) console.log(l); console.log(`FAIL ${problemas.length} problemas (no se reescribio nada)`); process.exit(1); }
  fs.writeFileSync(RUTA_MANIFEST, JSON.stringify(manifiesto, null, 2) + "\n"); console.log(`REGENERADO ${total} archivos`); process.exit(0);
}
for (const l of problemas) console.log(l);
console.log(problemas.length ? `FAIL ${problemas.length} problemas` : `MATCH ${total} archivos`);
process.exit(problemas.length ? 1 : 0);
