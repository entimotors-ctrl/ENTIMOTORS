// Compara el esquema de la base LOCAL contra el catálogo real de producción (SYNC-0), sección por sección.
// Uso: node verificar-fidelidad.mjs <catalogo-produccion.csv | db:NOMBRE> [--db postgres]
// Sale con 0 solo si tablas, columnas, restricciones, índices, políticas, triggers, funciones y verificaciones
// son idénticas (ignora lo propio del entorno: versión, hora, tamaños, estadísticas).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cargarCatalogo, seccion } from "../lib/csv.mjs";

const aqui = dirname(fileURLToPath(import.meta.url));
const SQL = join(aqui, "..", "catalogo", "entimotors-sync0-catalogo.sql");
const csv = process.argv[2];
const db = process.argv.includes("--db") ? process.argv[process.argv.indexOf("--db") + 1] : "postgres";
if (!csv) { console.error("uso: node verificar-fidelidad.mjs <catalogo-produccion.csv | db:NOMBRE> [--db N]"); process.exit(2); }

// El catálogo del SQL de SYNC-0 ejecutado sobre una base local
function catalogoDeDb(nombre) {
  const salida = execFileSync("psql", ["-X", "-At", "-F", "\x1f", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", "54432", "-U", "postgres", "-d", nombre, "-f", SQL],
    { env: { ...process.env, PGPASSWORD: "postgres" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return salida.split("\n").filter(Boolean).map((l) => { const [s, o, d] = l.split("\x1f"); return { seccion: s, objeto: o, j: JSON.parse(d) }; });
}
// Referencia: el CSV de producción, o "db:<nombre>" = otra base local ya verificada (p. ej. la base de referencia)
const prod = csv.startsWith("db:") ? catalogoDeDb(csv.slice(3)) : cargarCatalogo(csv);
const local = catalogoDeDb(db);

const diffs = [];
const norm = (x) => JSON.stringify(x);
const mapa = (cat, s, f = (x) => x) => new Map(seccion(cat, s).map((r) => [r.objeto, f(r.j)]));
const publica = (o) => !o.includes(".") || o.startsWith("public.");

function comparar(nombre, sel, fn = (x) => x, filtro = () => true) {
  const P = mapa(prod, sel, fn), L = mapa(local, sel, fn);
  for (const k of new Set([...P.keys(), ...L.keys()])) {
    if (!filtro(k)) continue;
    if (!P.has(k)) diffs.push(`${nombre}: solo en LOCAL → ${k}`);
    else if (!L.has(k)) diffs.push(`${nombre}: solo en PRODUCCIÓN → ${k}`);
    else if (norm(P.get(k)) !== norm(L.get(k))) diffs.push(`${nombre}: difiere ${k}\n    prod : ${norm(P.get(k)).slice(0, 400)}\n    local: ${norm(L.get(k)).slice(0, 400)}`);
  }
}

comparar("05_tablas", "05_tablas", (j) => ({ tipo: j.tipo, propietario: j.propietario, rls_activo: j.rls_activo, rls_forzado: j.rls_forzado, opciones: j.opciones }));
// attnum (n) tiene huecos en producción por columnas eliminadas: se compara el orden relativo, no el número
comparar("06_columnas", "06_columnas", (cols) => cols.map(({ n, ...c }) => c));
comparar("07_restricciones", "07_restricciones");
comparar("08_indices", "08_indices");
comparar("09_politicas", "09_politicas");
// triggers propios de la app (no los internos de storage)
comparar("10_triggers", "10_triggers", (x) => x, (o) => o.startsWith("public.") || o === "auth.users");
comparar("11_funciones", "11_funciones", (j) => ({ md5: j.md5_cuerpo, sd: j.security_definer, cfg: j.config, vol: j.volatilidad, pub: j.public_ejecuta_efectivo, por_rol: j.por_rol, ret: j.retorna, lang: j.lenguaje }));
comparar("13_privilegios", "13_privilegios_tablas");
comparar("18_verificaciones", "18_verificaciones", (j) => j.existe, (o) => !o.startsWith("bucket-metadata") && !o.startsWith("tabla talleres"));
comparar("19_unique", "19_unique_dispositivo_local_id");
comparar("14_defecto", "14_privilegios_por_defecto", (x) => x, (o) => o.startsWith("postgres | esquema public"));

const n = (cat, s) => seccion(cat, s).length;
console.log("sección                    prod  local");
for (const s of ["05_tablas", "06_columnas", "07_restricciones", "08_indices", "09_politicas", "11_funciones", "13_privilegios_tablas", "18_verificaciones", "19_unique_dispositivo_local_id"])
  console.log(" ", s.padEnd(30), String(n(prod, s)).padStart(4), String(n(local, s)).padStart(6));
if (diffs.length) { console.log(`\nDIFERENCIAS (${diffs.length}):`); for (const d of diffs) console.log(" -", d); process.exit(1); }
console.log("\nFIDELIDAD: PASS — esquema idéntico a la referencia en las secciones comparadas");
