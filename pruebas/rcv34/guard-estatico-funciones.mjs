// RCV-34 Fase 3G · guard ESTATICO de repositorio (REV8).
//
// Anade sobre REV7: (A) toda role_specification (GRANT/REVOKE individual, GRANT ON ALL
// FUNCTIONS/ROUTINES, ALTER DEFAULT PRIVILEGES) se normaliza distinguiendo identificador citado
// ("anon", case preservado) de identificador no citado (anon/ANON/AnOn, se pliega a minusculas);
// un identificador citado en minusculas exacto "anon" SI es el rol real anon; un identificador
// citado con otra capitalizacion ("ANON") NO se asume el mismo rol; la palabra clave PUBLIC (el
// pseudo-rol) solo se reconoce sin comillas, nunca como "public" citado (que seria, en cambio, un
// rol real hipotetico llamado literalmente "public", fuera del alcance de esta regla). Toda
// role_specification que no pueda reconocerse con confianza (comillas sin cerrar, sintaxis
// irreconocible) FALLA CERRADO (se reporta junto a las referencias de funcion no parseables). (B)
// "ALL FUNCTIONS/ROUTINES IN SCHEMA" admite una LISTA de schemas separados por comas (incluyendo
// identificadores citados), no solo uno; el guard no necesita decidir si cada schema es "de app":
// basta que la lista de roles objetivo incluya PUBLIC o anon para marcar prohibited_grant_global.
//
// Anade sobre REV6: (A) "ON ALL FUNCTIONS/ROUTINES IN SCHEMA" y "ALTER DEFAULT PRIVILEGES ...
// ON FUNCTIONS/ROUTINES" reconocen tambien la palabra clave ROUTINES (sinonimo de FUNCTIONS desde
// Postgres 11) y los privilegios GRANT ALL / ALL PRIVILEGES ademas de EXECUTE, en ambas formas;
// (B) el sufijo "WITH GRANT OPTION" se separa tambien en los detectores GLOBALES (ON ALL
// FUNCTIONS/ROUTINES, ALTER DEFAULT PRIVILEGES), no solo en el GRANT individual; (C) un prefijo
// "GROUP " antes del nombre de un rol (sintaxis historica equivalente a nombrar el rol directo) se
// normaliza al mismo rol, en GRANT/REVOKE individuales, GRANT global y ALTER DEFAULT PRIVILEGES;
// (D) "ON ROUTINE ..." se reconoce igual que "ON FUNCTION ..." en GRANT/REVOKE individuales, con
// la misma normalizacion de firma (sin extender a CREATE PROCEDURE); (E) el sufijo "GRANTED BY
// <rol>" (antes de WITH GRANT OPTION en GRANT, o despues de la lista de roles en REVOKE) se separa
// del nombre de rol para no leerlo como un rol inexistente.
//
// Anade sobre REV5: (A) un baseline legacy (hash de CREATE identico) ya NO puede ocultar un GRANT
// explicito nuevo que deje PUBLIC/anon con EXECUTE; (B) una referencia de funcion dentro de un
// REVOKE/GRANT top-level que no se pueda normalizar con confianza produce FAIL CLOSED
// (UNPARSEABLE_ACL_REFERENCE) en vez de desaparecer en silencio; (C) "WITH GRANT OPTION" y los
// sufijos CASCADE/RESTRICT de REVOKE se reconocen y se separan del nombre del rol; (D)
// ALTER DEFAULT PRIVILEGES ... GRANT ALL/ALL PRIVILEGES ON FUNCTIONS tambien cuenta como
// prohibited_grant_global; (E) cualquier region lexica sin cerrar (comentario de bloque, string,
// E-string, dollar-quote) al final del archivo produce un fallo global UNTERMINATED_LEXICAL_REGION
// aunque el archivo no tenga ningun CREATE FUNCTION; (G) el hash de archivo de una excepcion se
// calcula sobre los bytes crudos del archivo (Buffer), no releyendo como UTF-8.
//
// Anade sobre REV4: manifest de excepciones criptograficas (guard-estatico-excepciones.json) para
// prohibited_grant deliberados y ya revisados (p.ej. el rollback 02). Cada excepcion exige el
// SHA-256 exacto del archivo completo + coincidencia EXACTA de tipo+firma+privilegio+conjunto de
// roles; nunca por nombre de archivo. Nunca puede exceptuar un ALTER DEFAULT PRIVILEGES ni un
// GRANT sobre TODAS las funciones de un schema (tipo "prohibited_grant_global").
//
// Detecta CREATE [OR REPLACE] FUNCTION top-level en schemas de aplicacion (sin prefijo, o
// "public.") y exige, para cada firma completa (schema+nombre+tipos), que el ESTADO FINAL del
// ACL top-level -tras reproducir en orden todos los REVOKE/GRANT posteriores al CREATE de esa
// firma en el mismo archivo- dege PUBLIC y anon revocados y al menos un rol con EXECUTE
// concedido. Tambien detecta, de forma independiente y sin necesidad de que el archivo cree
// ninguna funcion, cualquier GRANT top-level que deje a PUBLIC o anon con EXECUTE sobre una
// funcion existente (categoria "prohibited_grant"), incluyendo GRANT sobre TODAS las funciones
// de un schema y ALTER DEFAULT PRIVILEGES que conceda EXECUTE a esos roles.
//
// No es un parser SQL completo: ante parentesis sin cerrar, cuerpo no reconocible, tipo de
// argumento no soportado, dollar-quote/string sin cerrar, o multiples CREATE [OR REPLACE] de la
// misma firma en un archivo (ambiguo), FALLA CERRADO (categoria "unparseable"), nunca en
// silencio.
//
// Lexer minimo: clasifica el archivo en zonas top-level / comentario de linea / comentario de
// bloque (con anidamiento) / string de comilla simple (estandar o E'...' con escapes de barra
// invertida) / bloque dollar-quoted. Todo el matching de sentencias ocurre SOLO sobre una version
// "enmascarada" donde las zonas que no son top-level quedan en blanco.
//
// El hash de deuda historica preserva el fragmento EXACTO (solo normaliza fin de linea y quita
// BOM): el objetivo es detectar cualquier cambio de contenido, no equivalencia SQL.
//
// Uso:
//   node guard-estatico-funciones.mjs <archivo.sql> [...]                  -> analiza esos archivos
//   node guard-estatico-funciones.mjs --repo                               -> descubre y analiza
//       todos los *.sql bajo el repo (REPO_ROOT), excluyendo node_modules.
//   node guard-estatico-funciones.mjs --dump-hashes <archivo.sql> [...]    -> imprime {archivo,
//       firma, hash} de cada funcion NO segura, para construir/actualizar el baseline.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
export const BASELINE_PATH = path.join(SCRIPT_DIR, "guard-estatico-baseline.json");
const EXCLUSIONES_REPO = [/(^|\/)node_modules(\/|$)/];

const SCHEMAS_APP = new Set([undefined, "public"]);
const SCHEMAS_EXCLUIDOS = new Set(["auth", "storage", "realtime", "graphql", "graphql_public",
  "extensions", "vault", "pgsodium", "supabase_functions", "cron", "net", "pgbouncer"]);

// ─────────────────────────────────────────────────────────────────────────── lexer minimo ──────
function lexer(texto) {
  const n = texto.length;
  const spans = [];
  let i = 0, topStart = 0;
  const flushTop = (hasta) => { if (hasta > topStart) spans.push({ tipo: "top", inicio: topStart, fin: hasta }); };

  while (i < n) {
    const c = texto[i];
    if (c === "-" && texto[i + 1] === "-") {
      flushTop(i);
      let j = texto.indexOf("\n", i); if (j === -1) j = n;
      spans.push({ tipo: "line_comment", inicio: i, fin: j });
      i = j; topStart = i; continue;
    }
    if (c === "/" && texto[i + 1] === "*") {
      // comentarios de bloque anidados: Postgres los admite.
      flushTop(i);
      let depth = 1, j = i + 2;
      while (j < n && depth > 0) {
        if (texto[j] === "/" && texto[j + 1] === "*") { depth++; j += 2; continue; }
        if (texto[j] === "*" && texto[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      spans.push({ tipo: "block_comment", inicio: i, fin: j, cerrado: depth === 0 });
      i = j; topStart = i; continue;
    }
    if (c === "'") {
      flushTop(i);
      const prev = texto[i - 1], prevPrev = texto[i - 2];
      const esEscape = (prev === "E" || prev === "e") && !/[a-zA-Z0-9_]/.test(prevPrev || "");
      let j = i + 1, cerrado = false;
      while (j < n) {
        if (esEscape && texto[j] === "\\") { j += 2; continue; }
        if (texto[j] === "'") {
          if (texto[j + 1] === "'") { j += 2; continue; }
          cerrado = true; j += 1; break;
        }
        j++;
      }
      spans.push({ tipo: "string", inicio: i, fin: j, cerrado });
      i = j; topStart = i; continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(texto.slice(i));
      if (m) {
        const tag = m[0];
        const finApertura = i + tag.length;
        const k = texto.indexOf(tag, finApertura);
        const fin = k === -1 ? n : k + tag.length;
        flushTop(i);
        spans.push({ tipo: "dollar", inicio: i, fin, tag, cerrado: k !== -1 });
        i = fin; topStart = i; continue;
      }
    }
    i++;
  }
  flushTop(n);

  const chars = texto.split("");
  for (const s of spans) {
    if (s.tipo === "top") continue;
    for (let k = s.inicio; k < s.fin; k++) chars[k] = chars[k] === "\n" ? "\n" : " ";
  }
  return { mascarado: chars.join(""), spans };
}

// Cualquier region lexica que nunca cerro (comentario de bloque, string, E-string, dollar-quote)
// deja al lexer sin certeza de que el resto del archivo se enmascaro correctamente: debe fallar
// GLOBALMENTE, aunque el archivo no tenga ningun CREATE FUNCTION.
function detectarRegionesSinCerrar(spans) {
  return spans.filter(s => s.cerrado === false)
    .map(s => ({ tipo: s.tipo, detalle: `region lexica sin cerrar (${s.tipo}) a partir del caracter ${s.inicio}` }));
}

// ────────────────────────────────────────────────────────────── escaneo de parentesis/comas ────
function escanearParentesis(s, iAbre) {
  // `s` ya esta enmascarado (sin strings vivos): no hace falta saltar literales.
  let depth = 1, i = iAbre + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "(") { depth++; i++; continue; }
    if (c === ")") { depth--; i++; if (depth === 0) return i - 1; continue; }
    i++;
  }
  return null;
}

function splitNivel1(s) {
  const partes = []; let depth = 0, actual = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { partes.push(actual); actual = ""; continue; }
    actual += c;
  }
  partes.push(actual);
  return partes.map(p => p.trim()).filter(Boolean);
}

// ───────────────────────────────────────────────────────────────── normalizacion de tipos ──────
const TIPO_MULTIPALABRA = [
  "timestamp with time zone", "timestamp without time zone",
  "time with time zone", "time without time zone",
  "double precision", "character varying", "bit varying",
];
const ALIAS_UNAPALABRA = {
  uuid: "uuid", text: "text",
  numeric: "numeric", decimal: "numeric",
  integer: "integer", int: "integer", int4: "integer",
  smallint: "smallint", int2: "smallint",
  bigint: "bigint", int8: "bigint",
  boolean: "boolean", bool: "boolean",
  jsonb: "jsonb", json: "json",
  real: "real", float4: "real", float8: "double precision",
  varchar: "character varying",
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
  date: "date", bytea: "bytea", inet: "inet", cidr: "cidr", macaddr: "macaddr",
  money: "money", xml: "xml",
  bit: "bit", varbit: "bit varying",
  char: "character", character: "character", bpchar: "character",
};
const RE_MULTIPALABRA = new RegExp(`^(${TIPO_MULTIPALABRA.map(t => t.replace(/\s+/g, "\\s+")).join("|")})$`, "i");

function normalizarTipoUnico(rawTipo) {
  let t = rawTipo.trim().replace(/\s+/g, " ").toLowerCase();
  let esArreglo = false;
  for (;;) {
    let m = /^(.*?)\s*\[\s*\d*\s*\]$/.exec(t);
    if (m) { t = m[1]; esArreglo = true; continue; }
    m = /^(.*)\s+array$/i.exec(t);
    if (m) { t = m[1]; esArreglo = true; continue; }
    break;
  }
  if (RE_MULTIPALABRA.test(t)) {
    const canon = TIPO_MULTIPALABRA.find(p => p.toLowerCase() === t.replace(/\s+/g, " "));
    if (canon) return canon + (esArreglo ? "[]" : "");
  }
  const mPrec = /^([a-z ]+?)\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\)$/.exec(t);
  const base = mPrec ? mPrec[1].trim() : t;
  if (RE_MULTIPALABRA.test(base)) {
    const canon = TIPO_MULTIPALABRA.find(p => p.toLowerCase() === base);
    if (canon) return canon + (esArreglo ? "[]" : "");
  }
  if (ALIAS_UNAPALABRA[base]) return ALIAS_UNAPALABRA[base] + (esArreglo ? "[]" : "");
  return null;
}

// El nombre de parametro (si existe) nunca contiene espacios, mientras que un tipo puede tener
// varias palabras o precision pegada sin espacio. Se tokeniza por espacios y se prueba, de mas a
// menos palabras, el SUFIJO de tokens que coincide con un tipo conocido.
function extraerTipoDeArg(argRaw) {
  let a = argRaw.trim();
  if (!a) return null;
  a = a.replace(/\s+(?:default|=)\s+[\s\S]+$/i, "").trim();
  a = a.replace(/^(in|out|inout|variadic)\s+/i, "").trim();
  if (!a) return null;

  const tokens = a.split(/\s+/);
  for (let len = Math.min(4, tokens.length); len >= 1; len--) {
    const candidato = tokens.slice(tokens.length - len).join(" ");
    const r = normalizarTipoUnico(candidato);
    if (r !== null) return r;
  }
  return null;
}

function normalizarFirma(schema, nombre, argsTxt) {
  const args = splitNivel1(argsTxt);
  const tipos = [];
  for (const a of args) {
    const t = extraerTipoDeArg(a);
    if (t === null) return null;
    tipos.push(t);
  }
  return `${(schema || "public").toLowerCase()}.${nombre.toLowerCase()}(${tipos.join(",")})`;
}

// Hash NO destructivo: el objetivo es detectar CAMBIO de contenido, no equivalencia SQL. Solo se
// normaliza fin de linea y se quita un BOM inicial; no se toca mayus/minus, espacios internos,
// contenido de strings/cuerpos ni comentarios dentro del fragmento.
function normalizarFragmento(txt) {
  return txt.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function sha256(texto) {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

// ──────────────────────────────────────────────────────────── localizar cuerpo de la funcion ───
function localizarCuerpo(mascarado, spans, idxInicio) {
  const candidato = spans.find(s => (s.tipo === "dollar" || s.tipo === "string") && s.inicio >= idxInicio);
  if (!candidato) return null;
  const entreMedio = mascarado.slice(idxInicio, candidato.inicio);
  if (entreMedio.includes(";")) return null;
  if (!candidato.cerrado) return null;
  const semi = mascarado.indexOf(";", candidato.fin);
  if (semi === -1) return null;
  return semi;
}

// ────────────────────────────────────────────────────────────── asociacion de REVOKE/GRANT ─────
function splitListaFunciones(s) {
  const partes = []; let depth = 0, actual = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { partes.push(actual); actual = ""; continue; }
    actual += c;
  }
  partes.push(actual);
  return partes.map(p => p.trim()).filter(Boolean);
}

function parsearRefFuncion(parte) {
  const m = /^(?:("?[a-z_][\w]*"?)\.)?("?[a-z_][\w]*"?)\s*\(([\s\S]*)\)\s*$/i.exec(parte.trim());
  if (!m) return null;
  const schema = (m[1] || "public").replace(/"/g, "");
  const nombre = m[2].replace(/"/g, "");
  return normalizarFirma(schema, nombre, m[3]);
}

// GRANT admite los sufijos "WITH GRANT OPTION" y "GRANTED BY <rol>" (en ese orden) pegados a la
// lista de roles; REVOKE admite "GRANTED BY <rol>" seguido de "CASCADE"/"RESTRICT". Ninguno de
// estos es un nombre de rol: hay que separarlos antes de partir por comas, o "anon with grant
// option"/"anon granted by postgres"/"anon cascade" se leerian como un rol inexistente y el
// REVOKE/GRANT dejaria de aplicarse a "anon" de verdad (fail-open).
function limpiarSufijoGrant(rolesTxt) {
  let t = rolesTxt;
  t = t.replace(/\s+granted\s+by\s+[^\s,;]+\s*$/i, "");
  t = t.replace(/\s+with\s+grant\s+option\s*$/i, "");
  return t.trim();
}
function limpiarSufijoRevoke(rolesTxt) {
  let t = rolesTxt;
  t = t.replace(/\s+(cascade|restrict)\s*$/i, "");
  t = t.replace(/\s+granted\s+by\s+[^\s,;]+\s*$/i, "");
  return t.trim();
}

// Divide una lista separada por comas en tokens, sin partir dentro de un identificador citado
// ("..."), donde "" representa una comilla literal escapada. No usa split(",") ciego: una coma
// dentro de comillas (p.ej. un schema o rol citado que contuviera una coma) no debe partir la
// lista en el lugar equivocado.
function splitListaIdentificadores(txt) {
  const partes = [];
  let actual = "", dentroComillas = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (c === '"') {
      if (dentroComillas && txt[i + 1] === '"') { actual += '""'; i++; continue; }
      dentroComillas = !dentroComillas;
      actual += c;
      continue;
    }
    if (c === "," && !dentroComillas) { partes.push(actual); actual = ""; continue; }
    actual += c;
  }
  partes.push(actual);
  return partes.map(p => p.trim()).filter(Boolean);
}

// Un identificador SQL simple: o bien no citado (se pliega a minusculas, como hace Postgres con
// cualquier identificador no delimitado), o bien citado con comillas dobles ("..."), donde el
// contenido EXACTO (case preservado) es el nombre real del catalogo y "" dentro de las comillas es
// una comilla literal escapada. Si el token no encaja EXACTAMENTE en uno de los dos casos
// (comillas sin cerrar, texto sobrante tras el cierre, o sintaxis irreconocible), retorna null:
// FAIL CLOSED, nunca se asume una interpretacion.
function parsearIdentificador(tokenRaw) {
  const t = tokenRaw.trim();
  if (!t) return null;
  if (t[0] === '"') {
    let j = 1, contenido = "", cerrado = false;
    while (j < t.length) {
      if (t[j] === '"') {
        if (t[j + 1] === '"') { contenido += '"'; j += 2; continue; }
        j++; cerrado = true; break;
      }
      contenido += t[j]; j++;
    }
    if (!cerrado || j !== t.length || contenido.length === 0) return null;
    return { nombre: contenido, citado: true };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(t)) return null;
  return { nombre: t.toLowerCase(), citado: false };
}

// role_specification de GRANT/REVOKE: admite el prefijo sintactico "GROUP " (equivalente
// historico a nombrar el rol directamente) antes del identificador de rol propiamente dicho,
// citado o no.
function parsearRolSpec(tokenRaw) {
  let t = tokenRaw.trim();
  const mGroup = /^group\s+/i.exec(t);
  if (mGroup) t = t.slice(mGroup[0].length);
  return parsearIdentificador(t);
}

function parsearListaRoles(rolesTxt) {
  const roles = [], noParseables = [];
  for (const token of splitListaIdentificadores(rolesTxt)) {
    const spec = parsearRolSpec(token);
    if (spec === null) noParseables.push(token); else roles.push(spec);
  }
  return { roles, noParseables };
}

function parsearListaSchemas(schemasTxt) {
  const schemas = [], noParseables = [];
  for (const token of splitListaIdentificadores(schemasTxt)) {
    const spec = parsearIdentificador(token);
    if (spec === null) noParseables.push(token); else schemas.push(spec.nombre);
  }
  return { schemas, noParseables };
}

// PUBLIC es una PALABRA CLAVE de la gramatica de role_specification (nunca un role_name), distinta
// de nombrar un rol real. Por eso "public" CITADO no es el pseudo-rol PUBLIC: es, en cambio, un
// identificador de rol real hipotetico llamado literalmente "public" (fuera del alcance de esta
// regla, que solo persigue el pseudo-rol PUBLIC y el rol real anon). Se usa un Symbol (nunca un
// string) como clave interna: un Symbol nunca es === a ningun string, asi que ningun identificador
// citado -por extrano que sea su contenido literal- puede colisionar jamas con esta clave, en el
// mapa de estado ACL, con el pseudo-rol PUBLIC sin comillas.
const CLAVE_PUBLIC_KEYWORD = Symbol("PUBLIC_KEYWORD");
function claveRol(spec) {
  if (!spec.citado && spec.nombre === "public") return CLAVE_PUBLIC_KEYWORD;
  return spec.nombre;
}
// El rol real anon SIEMPRE tiene nombre de catalogo en minusculas: "anon" no citado (se pliega) y
// "anon" citado (case ya identico) SI son el mismo rol real; "ANON" citado NO se asume el mismo
// rol (podria ser, en teoria, un rol real distinto con ese nombre exacto en mayusculas).
function rolPeligrosoDe(spec) {
  if (!spec.citado && spec.nombre === "public") return "public";
  if (spec.nombre === "anon") return "anon";
  return null;
}

// Todos los eventos ACL top-level del archivo, en orden de aparicion (posicion de caracter). Si
// alguna referencia de funcion dentro de la lista no se puede normalizar con confianza, se reporta
// en `referenciasNoParseables` (FAIL CLOSED) en vez de desaparecer en silencio del evento.
function extraerEventosGlobal(mascarado) {
  const eventos = [];
  const referenciasNoParseables = [];
  const reRevoke = /revoke\s+(?:execute|all(?:\s+privileges)?)\s+on\s+(?:function|routine)\s+([^;]+?)\s+from\s+([^;]+);/gi;
  const reGrant  = /grant\s+(?:execute|all(?:\s+privileges)?)\s+on\s+(?:function|routine)\s+([^;]+?)\s+to\s+([^;]+);/gi;

  function resolverFirmas(listaTxt, m, sentencia) {
    const firmas = [];
    for (const parte of splitListaFunciones(listaTxt)) {
      const f = parsearRefFuncion(parte);
      if (f === null) {
        referenciasNoParseables.push({ pos: m.index, detalle: `${sentencia}: la referencia "${parte.trim()}" no se pudo normalizar con confianza (tipo de argumento no soportado o sintaxis irreconocible)` });
        continue;
      }
      firmas.push(f);
    }
    return firmas;
  }

  function resolverRoles(rolesTxt, m, sentencia) {
    const { roles, noParseables } = parsearListaRoles(rolesTxt);
    for (const token of noParseables) {
      referenciasNoParseables.push({ pos: m.index, detalle: `${sentencia}: la role_specification "${token}" no se pudo normalizar con confianza` });
    }
    return roles.map(claveRol);
  }

  for (const m of mascarado.matchAll(reRevoke)) {
    const firmas = resolverFirmas(m[1], m, "REVOKE");
    const roles = resolverRoles(limpiarSufijoRevoke(m[2]), m, "REVOKE");
    eventos.push({ tipo: "revoke", firmas, roles, pos: m.index });
  }
  for (const m of mascarado.matchAll(reGrant)) {
    const firmas = resolverFirmas(m[1], m, "GRANT");
    const roles = resolverRoles(limpiarSufijoGrant(m[2]), m, "GRANT");
    eventos.push({ tipo: "grant", firmas, roles, pos: m.index });
  }
  return { eventos: eventos.sort((a, b) => a.pos - b.pos), referenciasNoParseables };
}

// Patrones peligrosos que no dependen de una firma concreta: GRANT sobre TODAS las funciones de
// un schema, y ALTER DEFAULT PRIVILEGES que conceda EXECUTE a PUBLIC/anon.
// Hallazgos SIEMPRE no-exceptuables (RCV-34 Fase 3D, seccion E): ningun manifest de excepciones
// puede autorizar un GRANT masivo por schema ni un ALTER DEFAULT PRIVILEGES peligroso.
function detectarPatronesPeligrosos(mascarado) {
  const hallazgos = [];
  const referenciasNoParseables = [];
  // "ROUTINES" es sinonimo de "FUNCTIONS" en estas dos sentencias desde Postgres 11: ambas
  // palabras clave deben tratarse igual de peligrosas. La lista de schemas admite varios
  // separados por coma (incluyendo identificadores citados): no hace falta decidir si cada schema
  // es "de app" para esta regla, basta con que la lista de roles objetivo incluya PUBLIC o anon.
  const reAll = /grant\s+(execute|all(?:\s+privileges)?)\s+on\s+all\s+(functions|routines)\s+in\s+schema\s+([^;]+?)\s+to\s+([^;]+);/gi;
  for (const m of mascarado.matchAll(reAll)) {
    const { noParseables: schemasNoParseables } = parsearListaSchemas(m[3]);
    for (const token of schemasNoParseables) {
      referenciasNoParseables.push({ pos: m.index, detalle: `GRANT ON ALL ${m[2].toUpperCase()} IN SCHEMA: el schema "${token}" no se pudo normalizar con confianza` });
    }
    const { roles, noParseables: rolesNoParseables } = parsearListaRoles(limpiarSufijoGrant(m[4]));
    for (const token of rolesNoParseables) {
      referenciasNoParseables.push({ pos: m.index, detalle: `GRANT ON ALL ${m[2].toUpperCase()}: la role_specification "${token}" no se pudo normalizar con confianza` });
    }
    if (roles.some(r => rolPeligrosoDe(r) !== null)) {
      hallazgos.push({ tipo: "prohibited_grant_global", exceptionable: false,
        detalle: `GRANT ${m[1].trim()} ON ALL ${m[2].toUpperCase()} IN SCHEMA ${m[3].trim()} TO ${m[4].trim()}` });
    }
  }
  const reDefault = /alter\s+default\s+privileges\b[^;]*?\bgrant\s+(execute|all(?:\s+privileges)?)\s+on\s+(functions|routines)\s+to\s+([^;]+);/gi;
  for (const m of mascarado.matchAll(reDefault)) {
    const { roles, noParseables: rolesNoParseables } = parsearListaRoles(limpiarSufijoGrant(m[3]));
    for (const token of rolesNoParseables) {
      referenciasNoParseables.push({ pos: m.index, detalle: `ALTER DEFAULT PRIVILEGES ON ${m[2].toUpperCase()}: la role_specification "${token}" no se pudo normalizar con confianza` });
    }
    if (roles.some(r => rolPeligrosoDe(r) !== null)) {
      hallazgos.push({ tipo: "prohibited_grant_global", exceptionable: false,
        detalle: `ALTER DEFAULT PRIVILEGES ... GRANT ${m[1].trim().toUpperCase()} ON ${m[2].toUpperCase()} TO ${m[3].trim()}` });
    }
  }
  return { hallazgos, referenciasNoParseables };
}

// ─────────────────────────────────────────────────────────────────────────── baseline ──────────
export function validarBaseline(ruta = BASELINE_PATH) {
  const problemas = [];
  let arr;
  try {
    arr = JSON.parse(readFileSync(ruta, "utf8"));
  } catch (e) {
    return { ok: false, problemas: [`no existe o no se pudo parsear ${ruta}: ${e.message}`], indice: new Map(), claves: new Set() };
  }
  if (!Array.isArray(arr)) return { ok: false, problemas: ["el baseline no es un array JSON"], indice: new Map(), claves: new Set() };

  const vistos = new Set(), indice = new Map(), claves = new Set();
  arr.forEach((e, i) => {
    if (!e || typeof e !== "object") { problemas.push(`entrada ${i}: no es un objeto`); return; }
    const { archivo, firma, hash } = e;
    let valida = true;
    if (!archivo || typeof archivo !== "string") { problemas.push(`entrada ${i}: falta o es invalido "archivo"`); valida = false; }
    if (!firma || typeof firma !== "string") { problemas.push(`entrada ${i}: falta o es invalido "firma"`); valida = false; }
    if (!hash || typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) { problemas.push(`entrada ${i}: "hash" no es SHA-256 valido (64 hex)`); valida = false; }
    if (!valida) return;
    const key = `${archivo}|${firma}`;
    if (vistos.has(key)) { problemas.push(`entrada ${i}: duplicado archivo+firma (${key})`); return; }
    vistos.add(key); indice.set(key, hash.toLowerCase()); claves.add(key);
  });
  return { ok: problemas.length === 0, problemas, indice, claves };
}

// entradas del baseline cuyo archivo no forma parte del conjunto escaneado en modo explicito no
// se consideran huerfanas (no se les pidio evaluarse); en --repo, TODAS deben corresponder a algo
// realmente encontrado.
export function detectarHuerfanas(baselineClaves, clavesEncontradas, archivosEscaneados, modoRepo) {
  return [...baselineClaves].filter(k => {
    const archivo = k.slice(0, k.indexOf("|"));
    if (!modoRepo && !archivosEscaneados.has(archivo)) return false;
    return !clavesEncontradas.has(k);
  });
}

// ────────────────────────────────────────────────────────── excepciones de prohibited_grant ────
// RCV-34 Fase 3D: manifest de excepciones para prohibited_grant deliberados y ya revisados (p.ej.
// el rollback 02, que a proposito restaura un ACL previo que incluye PUBLIC/anon). Nunca por
// nombre de archivo: cada excepcion exige el SHA-256 exacto del archivo completo, tipo, firma,
// privilegio y el conjunto EXACTO de roles peligrosos que autoriza. Solo neutraliza el hallazgo
// que coincide en TODOS esos campos; nunca autoriza ALTER DEFAULT PRIVILEGES ni GRANT sobre TODAS
// las funciones de un schema (esos hallazgos usan tipo "prohibited_grant_global", que ninguna
// excepcion valida puede declarar).
export const EXCEPCIONES_PATH = path.join(SCRIPT_DIR, "guard-estatico-excepciones.json");
const TIPOS_EXCEPCION_PERMITIDOS = new Set(["prohibited_grant"]);
const PRIVILEGIOS_PERMITIDOS = new Set(["execute"]);

export function validarExcepciones(ruta = EXCEPCIONES_PATH) {
  let arr;
  try {
    arr = JSON.parse(readFileSync(ruta, "utf8"));
  } catch (e) {
    // sin manifest: no es un error (0 excepciones), a menos que el archivo exista y este corrupto
    if (e.code === "ENOENT") return { ok: true, problemas: [], lista: [] };
    return { ok: false, problemas: [`no se pudo parsear ${ruta}: ${e.message}`], lista: [] };
  }
  if (!Array.isArray(arr)) return { ok: false, problemas: ["el manifest de excepciones no es un array JSON"], lista: [] };

  const problemas = [];
  const vistos = new Set();
  const lista = [];
  arr.forEach((e, i) => {
    if (!e || typeof e !== "object") { problemas.push(`entrada ${i}: no es un objeto`); return; }
    const { archivo, sha256_archivo, tipo, firma, roles, privilegio, razon } = e;
    let valida = true;
    if (!archivo || typeof archivo !== "string") { problemas.push(`entrada ${i}: falta o es invalido "archivo"`); valida = false; }
    if (!sha256_archivo || typeof sha256_archivo !== "string" || !/^[0-9a-f]{64}$/i.test(sha256_archivo)) {
      problemas.push(`entrada ${i}: "sha256_archivo" no es SHA-256 valido (64 hex)`); valida = false;
    }
    if (tipo !== undefined && !TIPOS_EXCEPCION_PERMITIDOS.has(tipo)) { problemas.push(`entrada ${i}: "tipo" no soportado (${tipo})`); valida = false; }
    if (tipo === undefined) { problemas.push(`entrada ${i}: falta "tipo"`); valida = false; }
    if (!firma || typeof firma !== "string" || !/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\(.*\)$/i.test(firma)) {
      problemas.push(`entrada ${i}: "firma" invalida o con formato irreconocible`); valida = false;
    }
    if (!Array.isArray(roles) || roles.length === 0 || roles.some(r => typeof r !== "string" || !r.trim())) {
      problemas.push(`entrada ${i}: "roles" debe ser un array no vacio de strings`); valida = false;
    }
    if (privilegio !== undefined && !PRIVILEGIOS_PERMITIDOS.has(privilegio)) { problemas.push(`entrada ${i}: "privilegio" no permitido (${privilegio})`); valida = false; }
    if (privilegio === undefined) { problemas.push(`entrada ${i}: falta "privilegio"`); valida = false; }
    if (!razon || typeof razon !== "string" || !razon.trim()) { problemas.push(`entrada ${i}: falta "razon" humana`); valida = false; }
    if (!valida) return;

    const rolesOrdenados = [...roles.map(r => r.toLowerCase().trim())].sort();
    const key = `${archivo}|${tipo}|${firma}|${privilegio}|${rolesOrdenados.join(",")}`;
    if (vistos.has(key)) { problemas.push(`entrada ${i}: excepcion duplicada (${key})`); return; }
    vistos.add(key);
    lista.push({ archivo, sha256_archivo: sha256_archivo.toLowerCase(), tipo, firma, roles: rolesOrdenados, privilegio, razon });
  });
  return { ok: problemas.length === 0, problemas, lista };
}

// Verifica el SHA-256 REAL de cada archivo referenciado por una excepcion, sobre los BYTES crudos
// del archivo (igual que sha256sum), no releyendo como UTF-8 y recodificando. Nunca se actualiza
// el hash automaticamente: si no coincide, la excepcion queda marcada como invalida (no se aplica).
export function verificarHashExcepciones(lista, repoRoot = REPO_ROOT) {
  return lista.map(e => {
    let hashReal = null;
    try {
      const buf = readFileSync(path.join(repoRoot, e.archivo)); // sin "utf8": Buffer de bytes crudos
      hashReal = createHash("sha256").update(buf).digest("hex");
    } catch { /* no existe */ }
    return { ...e, _hashArchivoOk: hashReal !== null && hashReal === e.sha256_archivo };
  });
}

// Empareja hallazgos prohibited_grant EXCEPTIONABLES (nunca los "_global") con excepciones cuyo
// hash de archivo es valido, exigiendo coincidencia EXACTA de archivo+tipo+firma+privilegio+
// conjunto de roles. Cada excepcion solo puede consumirse una vez.
export function clasificarProhibidos(porArchivo, excepcionesConHash) {
  const detectados = [], exceptuados = [], noExceptuados = [];
  const consumidas = new Set();
  for (const { archivo, prohibidos } of porArchivo) {
    for (const p of prohibidos) {
      const item = { ...p, archivo };
      if (!p.exceptionable) { detectados.push(item); noExceptuados.push(item); continue; }
      detectados.push(item);
      const rolesFinding = [...p.roles].sort().join(",");
      const idx = excepcionesConHash.findIndex((e, i) =>
        !consumidas.has(i) && e._hashArchivoOk && e.archivo === archivo && e.tipo === "prohibited_grant" &&
        e.firma === p.firma && e.privilegio === p.privilegio && e.roles.join(",") === rolesFinding);
      if (idx !== -1) { consumidas.add(idx); exceptuados.push({ ...item, excepcion: excepcionesConHash[idx] }); }
      else noExceptuados.push(item);
    }
  }
  return { detectados, exceptuados, noExceptuados, consumidas };
}

// excepciones nunca usadas: en --repo, cualquier excepcion no consumida es huerfana. En modo
// explicito, solo cuentan las excepciones cuyo archivo si formaba parte del conjunto escaneado.
export function detectarExcepcionesHuerfanas(excepcionesConHash, consumidas, archivosEscaneados, modoRepo) {
  return excepcionesConHash
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => {
      if (consumidas.has(i)) return false;
      if (!modoRepo && !archivosEscaneados.has(e.archivo)) return false;
      return true;
    })
    .map(({ e }) => e);
}

// ──────────────────────────────────────────────────────────── analisis de un texto/archivo ─────
export function analizarTexto(archivoRel, textoOriginal, baselineIndice) {
  const { mascarado, spans } = lexer(textoOriginal);

  // E: integridad global del lexer. Se reporta aunque el archivo no tenga ningun CREATE FUNCTION.
  const erroresLexicos = detectarRegionesSinCerrar(spans);

  // conteo independiente, sin conciencia de schema (control cruzado del bug de conteos falsos)
  const createTopLevelCount = (mascarado.match(/\bcreate\s+(?:or\s+replace\s+)?function\b/gi) || []).length;

  const reHeader = /create\s+(?:or\s+replace\s+)?function\s+(?:("?[a-z_][\w]*"?)\.)?("?[a-z_][\w]*"?)\s*\(/gi;
  const crudas = [];
  let m;
  while ((m = reHeader.exec(mascarado))) {
    const schema = m[1]?.replace(/"/g, "");
    const excluida = !SCHEMAS_APP.has(schema?.toLowerCase()) || (schema && SCHEMAS_EXCLUIDOS.has(schema.toLowerCase()));
    crudas.push({ excluida, inicioDef: m.index, idxAbre: reHeader.lastIndex - 1, schema: schema || "public", nombre: m[2].replace(/"/g, "") });
  }
  const createAppScope = crudas.filter(d => !d.excluida).length;
  const createExcludedScope = crudas.filter(d => d.excluida).length;

  let defs = crudas.filter(d => !d.excluida).map(d => {
    const idxCierre = escanearParentesis(mascarado, d.idxAbre);
    if (idxCierre === null) return { ...d, unparseable: "parentesis de argumentos sin cerrar" };
    const argsTxt = mascarado.slice(d.idxAbre + 1, idxCierre);
    const finRel = localizarCuerpo(mascarado, spans, idxCierre + 1);
    if (finRel === null) return { ...d, unparseable: "no se reconocio un cuerpo AS $tag$...$tag$ / AS '...' antes de otra sentencia (o el cuerpo no cerro)" };
    const firma = normalizarFirma(d.schema, d.nombre, argsTxt);
    if (firma === null) return { ...d, unparseable: `tipo de argumento no reconocido en (${argsTxt.trim()})` };
    return { ...d, finAbs: finRel, firma };
  });

  // B: multiples CREATE [OR REPLACE] de la misma firma en el archivo -> ambiguo, FAIL CLOSED
  const porFirma = new Map();
  for (const d of defs) if (!d.unparseable) (porFirma.get(d.firma) || porFirma.set(d.firma, []).get(d.firma)).push(d);
  defs = defs.map(d => {
    if (d.unparseable) return d;
    const grupo = porFirma.get(d.firma);
    if (grupo.length > 1) return { ...d, unparseable: `hay ${grupo.length} CREATE [OR REPLACE] FUNCTION de la misma firma en este archivo: ambiguo, no se evalua automaticamente` };
    return d;
  });

  const { eventos: eventosGlobal, referenciasNoParseables: aclNoParseablesEventos } = extraerEventosGlobal(mascarado);
  const { hallazgos: prohibidos, referenciasNoParseables: aclNoParseablesGlobal } = detectarPatronesPeligrosos(mascarado);
  const aclNoParseables = [...aclNoParseablesEventos, ...aclNoParseablesGlobal];

  function estadoFinalDesde(firma, desdePos) {
    const estado = new Map();
    for (const e of eventosGlobal) {
      if (e.pos <= desdePos || !e.firmas.includes(firma)) continue;
      for (const r of e.roles) estado.set(r, e.tipo === "grant");
    }
    return estado;
  }

  const createUnicoPorFirma = new Map();
  for (const d of defs) if (!d.unparseable) createUnicoPorFirma.set(d.firma, d);

  // A/B: estado FINAL del ACL, solo eventos posteriores al CREATE de esa firma en este archivo
  const funciones = defs.map(f => {
    if (f.unparseable) {
      return { firma: `${f.schema}.${f.nombre}(...)`, categoria: "unparseable", ok: false,
               motivos: [`UNPARSEABLE_FUNCTION: ${f.unparseable}`] };
    }
    const estado = estadoFinalDesde(f.firma, f.finAbs);
    const publicRevocado = estado.get(CLAVE_PUBLIC_KEYWORD) === false;
    const anonRevocado = estado.get("anon") === false;
    const otorgaAlguno = [...estado.values()].some(v => v === true);
    const cerrada = publicRevocado && anonRevocado && otorgaAlguno;

    // A: un baseline legacy (hash de CREATE identico) SOLO exime la deuda ACL HISTORICA; nunca un
    // GRANT explicito NUEVO que deje PUBLIC/anon concedidos tras el CREATE. Se evalua aqui, antes
    // de cualquier categorizacion, para que ni "segura_actual" ni "legacy_baseline" lo oculten.
    const publicAbierto = estado.get(CLAVE_PUBLIC_KEYWORD) === true;
    const anonAbierto = estado.get("anon") === true;
    if (publicAbierto || anonAbierto) {
      const rolesPeligrosos = [publicAbierto ? "public" : null, anonAbierto ? "anon" : null].filter(Boolean).sort();
      prohibidos.push({
        tipo: "prohibited_grant", exceptionable: true, firma: f.firma, privilegio: "execute",
        roles: rolesPeligrosos,
        detalle: `${f.firma}: un GRANT explicito posterior al CREATE deja EXECUTE concedido a ${rolesPeligrosos.join(" y ")} (esto nunca lo exime un baseline legacy)`,
      });
    }

    if (cerrada) return { firma: f.firma, categoria: "segura_actual", ok: true };

    const fragmentoCrudo = textoOriginal.slice(f.inicioDef, f.finAbs + 1);
    const hashActual = sha256(normalizarFragmento(fragmentoCrudo));
    const keyBaseline = `${archivoRel}|${f.firma}`;
    const hashBaseline = baselineIndice.get(keyBaseline);
    const motivosBase = [];
    if (!publicRevocado) motivosBase.push(`falta REVOKE ... FROM PUBLIC vigente al final del archivo (estado final PUBLIC=${estado.get(CLAVE_PUBLIC_KEYWORD) ?? "nunca tocado tras el CREATE"})`);
    if (!anonRevocado) motivosBase.push(`falta REVOKE ... FROM anon vigente al final del archivo (estado final anon=${estado.get("anon") ?? "nunca tocado tras el CREATE"})`);
    if (!otorgaAlguno) motivosBase.push("ningun rol termina con EXECUTE concedido tras el CREATE");

    if (hashBaseline === hashActual) {
      return { firma: f.firma, categoria: "legacy_baseline", ok: true, hashActual,
               motivos: ["deuda historica exenta por guard-estatico-baseline.json: " + motivosBase.join("; ")] };
    }
    if (hashBaseline !== undefined) {
      return { firma: f.firma, categoria: "legacy_modificada", ok: false, hashActual,
               motivos: ["la funcion cambio respecto al baseline historico (archivo+firma coinciden, hash no): " +
                         "debe cerrar su ACL o el baseline debe actualizarse a conciencia; " + motivosBase.join("; ")] };
    }
    return { firma: f.firma, categoria: "nueva_insegura", ok: false, hashActual, motivos: motivosBase };
  });

  // C: firmas SIN CREATE local pero tocadas por REVOKE/GRANT en este archivo -> si terminan con
  // PUBLIC o anon concedidos, es una migracion que "reabre" una funcion existente: FAIL, aunque
  // el archivo no cree ninguna funcion.
  const firmasReferenciadas = new Set();
  for (const e of eventosGlobal) for (const fi of e.firmas) firmasReferenciadas.add(fi);
  for (const firma of firmasReferenciadas) {
    if (createUnicoPorFirma.has(firma)) continue; // ya evaluada arriba
    const estado = estadoFinalDesde(firma, -1);
    const publicAbierto = estado.get(CLAVE_PUBLIC_KEYWORD) === true;
    const anonAbierto = estado.get("anon") === true;
    if (publicAbierto || anonAbierto) {
      const rolesPeligrosos = [publicAbierto ? "public" : null, anonAbierto ? "anon" : null].filter(Boolean);
      prohibidos.push({
        tipo: "prohibited_grant", exceptionable: true, firma, privilegio: "execute",
        roles: rolesPeligrosos.sort(),
        detalle: `${firma}: termina con EXECUTE concedido a ${rolesPeligrosos.join(" y ")} (sin CREATE FUNCTION de esa firma en este archivo)`,
      });
    }
  }

  return { archivo: archivoRel, funciones, createTopLevelCount, createAppScope, createExcludedScope,
           definicionesDetectadas: defs.length, prohibidos, erroresLexicos, aclNoParseables };
}

export function analizarArchivo(rutaArchivo, baselineIndice, repoRoot = REPO_ROOT) {
  const original = readFileSync(rutaArchivo, "utf8");
  const archivoRel = path.relative(repoRoot, path.resolve(rutaArchivo)).split(path.sep).join("/");
  return analizarTexto(archivoRel, original, baselineIndice);
}

// ───────────────────────────────────────────────────────────────── descubrimiento del repo ─────
export function descubrirSql(repoRoot = REPO_ROOT) {
  const encontrados = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      const rel = path.relative(repoRoot, p).split(path.sep).join("/");
      if (EXCLUSIONES_REPO.some(re => re.test(rel))) continue;
      if (entry.isDirectory()) { walk(p); continue; }
      if (entry.isFile() && /\.sql$/i.test(entry.name)) encontrados.push(p);
    }
  })(repoRoot);
  return encontrados.sort();
}

// ──────────────────────────────────────────────────────────────────────────── CLI ──────────────
function main() {
  const argv = process.argv.slice(2);
  const dumpHashes = argv.includes("--dump-hashes");
  const modoRepo = argv.includes("--repo");
  const archivos = argv.filter(a => a !== "--dump-hashes" && a !== "--repo");

  const baseline = validarBaseline();
  if (!baseline.ok && !dumpHashes) {
    console.log("BASELINE INVALIDO:");
    for (const p of baseline.problemas) console.log(`  - ${p}`);
    console.log("\nTODO FAIL (baseline corrupto: no se evalua ninguna deuda historica hasta corregirlo)");
    process.exit(1);
  }
  if (!baseline.ok && dumpHashes) console.log("(aviso: no hay baseline valido; --dump-hashes continua para poder generar uno nuevo)");

  const excepcionesValidadas = validarExcepciones();
  if (!excepcionesValidadas.ok && !dumpHashes) {
    console.log("MANIFEST DE EXCEPCIONES INVALIDO:");
    for (const p of excepcionesValidadas.problemas) console.log(`  - ${p}`);
    console.log("\nTODO FAIL (excepciones corruptas: ningun prohibited_grant se exceptua hasta corregirlo)");
    process.exit(1);
  }

  let rutas;
  if (modoRepo) {
    rutas = descubrirSql();
    console.log(`--repo: ${rutas.length} archivo(s) .sql descubiertos bajo ${REPO_ROOT}`);
  } else {
    if (archivos.length === 0) {
      console.log("uso: node guard-estatico-funciones.mjs [--repo | --dump-hashes] <archivo.sql> [...]");
      process.exit(2);
    }
    rutas = archivos;
  }

  const reporte = rutas.map(a => analizarArchivo(a, baseline.indice));

  if (dumpHashes) {
    const filas = [];
    for (const r of reporte) for (const f of r.funciones) {
      if (f.categoria === "unparseable" || f.categoria === "segura_actual") continue;
      filas.push({ archivo: r.archivo, firma: f.firma, hash: f.hashActual, categoria_actual: f.categoria });
    }
    console.log(JSON.stringify(filas, null, 2));
    process.exit(0);
  }

  const contadores = { legacy_baseline: 0, segura_actual: 0, nueva_insegura: 0, legacy_modificada: 0, unparseable: 0 };
  let fallos = 0, totalHeader = 0, totalAppScope = 0, totalExcludedScope = 0, totalDefs = 0;
  let erroresLexicosTotal = 0, aclNoParseablesTotal = 0;
  const clavesEncontradas = new Set();
  const archivosEscaneados = new Set(reporte.map(r => r.archivo));

  for (const r of reporte) {
    totalHeader += r.createTopLevelCount || 0;
    totalAppScope += r.createAppScope || 0;
    totalExcludedScope += r.createExcludedScope || 0;
    totalDefs += r.definicionesDetectadas || 0;
    for (const f of r.funciones) {
      contadores[f.categoria]++;
      if (!f.ok) fallos++;
      if (f.categoria !== "unparseable") clavesEncontradas.add(`${r.archivo}|${f.firma}`);
      console.log(`${f.ok ? "PASS" : "FAIL"}  [${f.categoria}]  ${r.archivo}  ${f.firma}${f.motivos ? "  -> " + f.motivos.join(" | ") : ""}`);
    }
    for (const el of r.erroresLexicos || []) {
      erroresLexicosTotal++; fallos++;
      console.log(`FAIL  [UNTERMINATED_LEXICAL_REGION]  ${r.archivo}  -> ${el.detalle}`);
    }
    for (const an of r.aclNoParseables || []) {
      aclNoParseablesTotal++; fallos++;
      console.log(`FAIL  [UNPARSEABLE_ACL_REFERENCE]  ${r.archivo}  -> ${an.detalle}`);
    }
  }

  const excepcionesConHash = verificarHashExcepciones(excepcionesValidadas.lista);
  for (const e of excepcionesConHash) {
    if (!e._hashArchivoOk) console.log(`FAIL  [EXCEPTION_FILE_HASH_MISMATCH]  ${e.archivo}  ${e.firma}  -> sha256_archivo del manifest no coincide con el archivo real`);
  }
  const hashMismatch = excepcionesConHash.filter(e => !e._hashArchivoOk).length;
  fallos += hashMismatch;

  const porArchivoProhibidos = reporte.map(r => ({ archivo: r.archivo, prohibidos: r.prohibidos }));
  const { detectados, exceptuados, noExceptuados, consumidas } = clasificarProhibidos(porArchivoProhibidos, excepcionesConHash);
  for (const p of exceptuados) {
    console.log(`PASS  [exception-approved]  ${p.archivo}  ${p.firma}  roles=${p.roles.join(",")}  razon="${p.excepcion.razon}"`);
  }
  for (const p of noExceptuados) {
    fallos++;
    console.log(`FAIL  [${p.tipo}]  ${p.archivo}  -> ${p.detalle}`);
  }

  const excepcionesHuerfanas = detectarExcepcionesHuerfanas(excepcionesConHash, consumidas, archivosEscaneados, modoRepo);
  if (excepcionesHuerfanas.length > 0) {
    fallos += excepcionesHuerfanas.length;
    for (const e of excepcionesHuerfanas) console.log(`FAIL  [EXCEPTION_ORPHAN]  ${e.archivo}  ${e.firma}  -> excepcion sin hallazgo prohibited_grant correspondiente`);
  }

  const huerfanas = detectarHuerfanas(baseline.claves, clavesEncontradas, archivosEscaneados, modoRepo);
  if (huerfanas.length > 0) {
    fallos += huerfanas.length;
    for (const h of huerfanas) console.log(`FAIL  [baseline_huerfano]  entrada de guard-estatico-baseline.json sin funcion correspondiente: ${h}`);
  }

  if (totalHeader !== totalAppScope + totalExcludedScope) {
    fallos++;
    console.log(`FAIL  [conteo_inconsistente]  CREATE FUNCTION top-level=${totalHeader} vs app_scope+excluded_scope=${totalAppScope + totalExcludedScope}`);
  }
  if (totalAppScope !== totalDefs) {
    fallos++;
    console.log(`FAIL  [conteo_inconsistente]  create_app_scope=${totalAppScope} vs definiciones_procesadas=${totalDefs}`);
  }

  console.log(`\ncreate_top_level_total=${totalHeader} create_app_scope=${totalAppScope} create_excluded_scope=${totalExcludedScope} definiciones_procesadas=${totalDefs}`);
  console.log(`legacy_baseline_count=${contadores.legacy_baseline} funciones_seguras_actuales=${contadores.segura_actual} ` +
              `funciones_nuevas_inseguras=${contadores.nueva_insegura} funciones_legacy_modificadas=${contadores.legacy_modificada} ` +
              `unparseable=${contadores.unparseable}`);
  console.log(`prohibited_grants_detectados=${detectados.length} prohibited_grants_exceptuados=${exceptuados.length} ` +
              `prohibited_grants_no_exceptuados=${noExceptuados.length} excepciones_huerfanas=${excepcionesHuerfanas.length}`);
  console.log(`errores_lexicos=${erroresLexicosTotal} acl_no_parseables=${aclNoParseablesTotal}`);
  console.log(fallos ? `${fallos} FAIL` : "TODO PASS");
  process.exit(fallos ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
