// Genera, desde el catálogo REAL de producción (SYNC-0), el DDL de la base de referencia local:
//   baseline-a-tablas.sql     tablas, restricciones, índices y RLS (SIN funciones)
//   baseline-c-politicas.sql  políticas RLS (se aplican después de las funciones)
// Las 17 funciones y los 5 triggers NO se generan aquí: los aporta entimotors-rcv34-source-sync.sql,
// cuyas huellas md5 coinciden 17/17 con producción (verificado en SYNC-0).
//
// Uso: node generar-baseline.mjs <catalogo.csv> [dirSalida]
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cargarCatalogo, seccion } from "../lib/csv.mjs";

const aqui = dirname(fileURLToPath(import.meta.url));
const csv = process.argv[2];
const salida = process.argv[3] || aqui;
if (!csv) { console.error("uso: node generar-baseline.mjs <catalogo.csv> [dirSalida]"); process.exit(2); }

const cat = cargarCatalogo(csv);
const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

// Solo las tablas de la app del taller. products/projects/videos/project_images son del sitio web público
// y no participan en la sincronización; se incluyen igualmente para que la base local sea idéntica.
const tablas = seccion(cat, "05_tablas").filter((f) => f.j.tipo === "r").map((f) => f.objeto).sort();
const columnas = Object.fromEntries(seccion(cat, "06_columnas").map((f) => [f.objeto, f.j]));
const restricciones = Object.fromEntries(seccion(cat, "07_restricciones").map((f) => [f.objeto, f.j]));
const indices = Object.fromEntries(seccion(cat, "08_indices").map((f) => [f.objeto, f.j]));
const politicas = seccion(cat, "09_politicas");

let a = "-- GENERADO por generar-baseline.mjs desde el catálogo real de producción (2026-09-21). NO editar a mano.\n" +
        "-- Solo tablas, restricciones, índices y RLS. Sin funciones (las aporta el source-sync de RCV-34).\n\n";

// secuencias que usan los DEFAULT nextval(...) (tablas del sitio web); el catálogo no trae sus parámetros
const secuencias = new Set();
for (const t of tablas) for (const c of columnas[t]) {
  const m = /nextval\('([A-Za-z0-9_.]+)'::regclass\)/.exec(c.default || "");
  if (m) secuencias.add(m[1].replace(/^public\./, ""));
}
for (const sq of [...secuencias].sort()) a += `CREATE SEQUENCE public.${q(sq)};\n`;
if (secuencias.size) a += "\n";

for (const t of tablas) {
  const cols = columnas[t];
  a += `CREATE TABLE public.${q(t)} (\n` +
    cols.map((c) => `  ${q(c.columna)} ${c.tipo}${c.not_null ? " NOT NULL" : ""}${c.default ? " DEFAULT " + c.default : ""}`).join(",\n") +
    "\n);\n\n";
}

const orden = { "PRIMARY KEY": 0, UNIQUE: 1, CHECK: 2, "FOREIGN KEY": 3 };
const todas = [];
for (const t of tablas) for (const k of restricciones[t] || []) todas.push({ t, ...k });
todas.sort((x, y) => (orden[x.tipo] - orden[y.tipo]) || x.t.localeCompare(y.t) || x.nombre.localeCompare(y.nombre));
for (const k of todas) a += `ALTER TABLE public.${q(k.t)} ADD CONSTRAINT ${q(k.nombre)} ${k.definicion};\n`;
a += "\n";

// índices que NO respaldan una restricción (los de PK/UNIQUE ya los crea ADD CONSTRAINT)
const nombresRestriccion = new Set(todas.map((k) => k.nombre));
for (const t of tablas) for (const i of indices[t] || []) {
  if (nombresRestriccion.has(i.nombre)) continue;
  a += `${i.definicion};\n`;
}
a += "\n";
for (const f of seccion(cat, "05_tablas").filter((x) => x.j.tipo === "r")) {
  if (f.j.rls_activo) a += `ALTER TABLE public.${q(f.objeto)} ENABLE ROW LEVEL SECURITY;\n`;
  if (f.j.rls_forzado) a += `ALTER TABLE public.${q(f.objeto)} FORCE ROW LEVEL SECURITY;\n`;
}

// comentarios de tabla y de columna (la fase 4C dejó comentarios en citas/ordenes.mecanico[_id])
const lit = (t) => `'${String(t).replace(/'/g, "''")}'`;
a += "\n";
for (const f of seccion(cat, "05_tablas").filter((x) => x.j.tipo === "r")) {
  if (f.j.comentario) a += `COMMENT ON TABLE public.${q(f.objeto)} IS ${lit(f.j.comentario)};\n`;
  for (const col of columnas[f.objeto]) if (col.comentario) a += `COMMENT ON COLUMN public.${q(f.objeto)}.${q(col.columna)} IS ${lit(col.comentario)};\n`;
}

// privilegios exactos de cada tabla, tal como los guarda producción (relacl)
const PRIV = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", D: "TRUNCATE", x: "REFERENCES", t: "TRIGGER", m: "MAINTAIN" };
a += "\n";
for (const f of seccion(cat, "13_privilegios_tablas").sort((x, y) => x.objeto.localeCompare(y.objeto))) {
  a += `REVOKE ALL ON TABLE public.${q(f.objeto)} FROM anon, authenticated, service_role;\n`;
  const acl = (f.j.acl || "").replace(/^\{|\}$/g, "").split(",").filter(Boolean);
  for (const e of acl) {
    const [quien, resto] = e.split("=");
    if (!["anon", "authenticated", "service_role"].includes(quien)) continue;
    const privs = [...resto.split("/")[0]].map((l) => PRIV[l]).filter(Boolean).join(", ");
    if (privs) a += `GRANT ${privs} ON TABLE public.${q(f.objeto)} TO ${quien};\n`;
  }
}

let c = "-- GENERADO por generar-baseline.mjs desde el catálogo real de producción (2026-09-21). NO editar a mano.\n" +
        "-- Políticas RLS de public y storage.objects. Requiere las funciones del source-sync ya aplicadas.\n\n";
for (const f of politicas.sort((x, y) => x.objeto.localeCompare(y.objeto))) {
  const [esq, tab] = f.objeto.split(".");
  for (const p of f.j) {
    const roles = (p.roles || []).map((r) => (r === "public" ? "public" : q(r))).join(", ") || "public";
    c += `CREATE POLICY ${q(p.nombre)} ON ${esq}.${q(tab)} AS ${p.permisiva} FOR ${p.comando} TO ${roles}` +
         (p.usa ? ` USING (${p.usa})` : "") + (p.con_check ? ` WITH CHECK (${p.con_check})` : "") + ";\n";
  }
}

writeFileSync(join(salida, "baseline-a-tablas.sql"), a);
writeFileSync(join(salida, "baseline-c-politicas.sql"), c);
console.log(`tablas=${tablas.length} restricciones=${todas.length} politicas=${politicas.reduce((n, f) => n + f.j.length, 0)}`);
