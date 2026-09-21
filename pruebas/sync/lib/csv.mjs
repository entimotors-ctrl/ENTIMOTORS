// Lector del CSV del catálogo de esquema (SYNC-0). RFC 4180: comillas, "" escapa, CRLF o LF.
// Sin dependencias. Solo lee metadatos de esquema: el catálogo nunca contiene filas de negocio.
import { readFileSync } from "node:fs";

export function parseCsv(texto) {
  const filas = [];
  let fila = [], campo = "", enComillas = false, i = 0;
  while (i < texto.length) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i += 2; continue; }
        enComillas = false; i++; continue;
      }
      campo += c; i++; continue;
    }
    if (c === '"') { enComillas = true; i++; continue; }
    if (c === ",") { fila.push(campo); campo = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = ""; i++; continue; }
    campo += c; i++;
  }
  if (enComillas) throw new Error("CSV con comillas sin cerrar (truncado o corrupto)");
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

/** Devuelve [{seccion, objeto, j}] con `j` = detalle ya parseado. Falla si el CSV no es válido. */
export function cargarCatalogo(ruta) {
  const filas = parseCsv(readFileSync(ruta, "utf8"));
  const cab = filas.shift();
  if (!cab || cab.join(",") !== "seccion,objeto,detalle") throw new Error("cabecera de catálogo inesperada");
  return filas.map((f, n) => {
    if (f.length !== 3) throw new Error(`fila ${n + 2}: se esperaban 3 columnas y hay ${f.length}`);
    return { seccion: f[0], objeto: f[1], j: JSON.parse(f[2]) };
  });
}

export const seccion = (cat, s) => cat.filter((f) => f.seccion === s);
