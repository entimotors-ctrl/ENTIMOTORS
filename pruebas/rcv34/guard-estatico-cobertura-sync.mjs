// RCV-34 Fase B3T - coverage gate ESTATICO del source-sync canonico (POST RCV-35).
//
// NO VERIFICA PRODUCCION. Compara ARCHIVOS del repositorio contra evidencia ya capturada (manifest
// B3R y verificacion 03 de RCV-35). No consulta ni ejecuta nada contra Supabase ni PostgreSQL.
//
// Que exige (FAIL CLOSED: cualquier duda es un FAIL, nunca se asume):
//   * el source-sync es EXACTAMENTE el archivo fijado por SHA-256, define EXACTAMENTE las 17 funciones
//     canonicas (17 firmas distintas, ninguna extra ni faltante) y cada cuerpo reproduce BYTE A BYTE
//     (md5 + bytes + CR + LF) la huella de produccion: 16 del manifest B3R y rol_actual() del estado
//     POST-RCV35 (md5 e66ee46e...), con "AND p.activo", y nunca el PRE inseguro (527f940b...);
//   * ACL: PUBLIC y anon cerrados 17/17, authenticated 16/17 (crear_perfil_al_registrarse() no),
//     service_role 17/17, sin roles ni firmas extra; ademas REV8 las clasifica 17/17 seguras;
//   * los 5 triggers exactos, sin DROP TRIGGER ni ALTER DEFAULT PRIVILEGES, transaccion BEGIN..COMMIT;
//   * .gitattributes deja el source-sync en "-text" (Git no puede normalizar sus CRLF intencionales);
//   * la evidencia PRE (B3R) y POST (RCV35) coexisten, estan fijadas por SHA-256 y no llevan cuerpos;
//   * las 2 funciones SOURCE_ONLY_NOT_DEPLOYED no aparecen en el source-sync ni en produccion;
//   * baseline = exactamente 13 entradas, clasificadas 13/13 (6/3/1/1/2) y verificadas contra los
//     cuerpos reales de los SQL historicos; los archivos protegidos conservan su SHA-256.
//
// Uso:
//   node guard-estatico-cobertura-sync.mjs        -> evalua el repositorio real
// Como libreria (fixtures): evaluarCobertura({ archivos: Map<rutaRelativa, Buffer> }, opciones).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analizarTexto } from "./guard-estatico-funciones.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

export const RUTAS = {
  sync: "taller-demo/supabase/entimotors-rcv34-source-sync.sql",
  gitattributes: ".gitattributes",
  baseline: "pruebas/rcv34/guard-estatico-baseline.json",
  manifiesto: "pruebas/rcv34/guard-estatico-cobertura-sync.json",
  pre: "pruebas/rcv34/produccion-funciones-20260918.json",
  post: "pruebas/rcv35/produccion-post-fix-20260918.json",
};
const RLS = "taller-demo/supabase/entimotors-fase4d-rls.sql";
const USUARIOS = "taller-demo/supabase/entimotors-usuarios.sql";
const ROLLBACK = "taller-demo/supabase/entimotors-fase4d-rollback.sql";
export const FUENTES_HISTORICAS = [RLS, USUARIOS, ROLLBACK];
export const PROTEGIDOS_REQUERIDOS = [
  "pruebas/rcv34/guard-estatico-funciones.mjs", "pruebas/rcv34/guard-estatico-funciones.test.mjs",
  "pruebas/rcv34/guard-estatico-excepciones.json", "pruebas/rcv34/01-cierre-triggers-public.sql",
  "pruebas/rcv34/02-rollback-cierre-triggers.sql", "pruebas/rcv34/04-guard-funciones-public.sql",
  "pruebas/rcv35/01-fix-rol-actual-activo.sql", "pruebas/rcv35/03-verificacion-post-fix-readonly.sql",
];

// Invariantes fijados EN CODIGO (y repetidos en el manifest, que debe coincidir): para relajarlos
// hay que tocar dos archivos a la vista de la revision.
export const INV = {
  syncSha256: "6530b27cb7d339338a78a3300b4e62d6c73d23c33aa7e53b1d64ceeddb63ab73",
  rolPost: "e66ee46e01d3df511ee5bd4d0f2a178a",
  rolPre: "527f940b66f3c7b88b746dc3a676bdb9",
  reglaGitattributes: "taller-demo/supabase/entimotors-rcv34-source-sync.sql -text",
};
export const CREAR_PERFIL = "crear_perfil_al_registrarse()";
export const FIRMAS_CANONICAS = [
  "rol_actual()", "es_admin()", "puede_cobrar()", CREAR_PERFIL,
  "registrar_venta(uuid,text,text,numeric,jsonb,integer,text)", "registrar_abono(uuid,numeric,text,text)",
  "proteger_caja_ligada()", "proteger_rol_perfil()", "ve_todo_el_taller()", "es_mecanico_activo()",
  "mi_cliente(uuid)", "mi_moto(uuid)", "mecanico_solo_avance_tecnico()", "estadisticas_tecnicas()",
  "es_equipo()", "es_desarrollador()", "estado_tecnico()",
];
export const TRIGGERS = [
  { tabla: "auth.users", nombre: "al_crear_usuario", funcion: CREAR_PERFIL, tgtype: 5, descripcion: "AFTER INSERT" },
  { tabla: "public.caja_movimientos", nombre: "no_borrar_caja_ligada", funcion: "proteger_caja_ligada()", tgtype: 11, descripcion: "BEFORE DELETE" },
  { tabla: "public.citas", nombre: "citas_mecanico_avance", funcion: "mecanico_solo_avance_tecnico()", tgtype: 19, descripcion: "BEFORE UPDATE" },
  { tabla: "public.ordenes", nombre: "ordenes_mecanico_avance", funcion: "mecanico_solo_avance_tecnico()", tgtype: 19, descripcion: "BEFORE UPDATE" },
  { tabla: "public.perfiles", nombre: "proteger_rol_perfil_trigger", funcion: "proteger_rol_perfil()", tgtype: 19, descripcion: "BEFORE UPDATE" },
];
export const SOURCE_ONLY = ["proteger_admin_unico()", "proteger_borrado_admin()"];
export const CLASES = {
  ACTIVE_SOURCE_MATCHES_CANONICAL: 6,
  ACTIVE_SOURCE_DIVERGED_SUPERSEDED_BY_CANONICAL: 3,
  SUPERSEDED_HISTORICAL: 1,
  ROLLBACK_ONLY: 1,
  SOURCE_ONLY_NOT_DEPLOYED: 2,
};
// membresia exacta de cada clase: archivo|firma
const K = (a, f) => `${a}|public.${f}`;
export const MEMBRESIA = {
  ACTIVE_SOURCE_MATCHES_CANONICAL: [
    K(RLS, "ve_todo_el_taller()"), K(RLS, "es_mecanico_activo()"), K(RLS, "mi_cliente(uuid)"),
    K(RLS, "mi_moto(uuid)"), K(RLS, "mecanico_solo_avance_tecnico()"), K(RLS, "estadisticas_tecnicas()")],
  ACTIVE_SOURCE_DIVERGED_SUPERSEDED_BY_CANONICAL: [
    K(USUARIOS, "es_equipo()"), K(USUARIOS, "es_desarrollador()"), K(USUARIOS, "estado_tecnico()")],
  SUPERSEDED_HISTORICAL: [K(USUARIOS, "estadisticas_tecnicas()")],
  ROLLBACK_ONLY: [K(ROLLBACK, "estadisticas_tecnicas()")],
  SOURCE_ONLY_NOT_DEPLOYED: [K(USUARIOS, "proteger_admin_unico()"), K(USUARIOS, "proteger_borrado_admin()")],
};
const LOGICA_ROL_ACTUAL = "selectcoalesce((selectp.rolfrompublic.perfilespwherep.id=auth.uid()andp.activolimit1),'');";

// ─────────────────────────────────────────────────────────────────────────── utilidades ─────────
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const md5 = (b) => createHash("md5").update(b).digest("hex");
const contar = (b, byte) => { let n = 0; for (const x of b) if (x === byte) n++; return n; };
function parseJSON(buf) { if (!buf) return null; try { return JSON.parse(buf.toString("utf8")); } catch { return null; } }
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const igual = (a, b) => canon(a) === canon(b);
const faltan = (esperado, actual) => esperado.filter(x => !actual.includes(x));
const sobran = (esperado, actual) => actual.filter(x => !esperado.includes(x));

const ALIAS_TIPO = { uuid: "uuid", text: "text", numeric: "numeric", jsonb: "jsonb", integer: "integer", int: "integer", int4: "integer", boolean: "boolean", bool: "boolean" };
function tiposDeArgs(txt) {
  const t = txt.trim();
  if (!t) return [];
  const out = [];
  for (const a of t.split(",")) {
    const toks = a.trim().split(/\s+/);
    const tipo = ALIAS_TIPO[toks[toks.length - 1].toLowerCase()];
    if (!tipo) return null; // tipo no soportado: fail closed
    out.push(tipo);
  }
  return out;
}

// Definiciones CREATE OR REPLACE FUNCTION public.x(...) ... AS $function$ ... $function$; del source-sync.
// Se trabaja sobre latin1 (1 byte = 1 caracter) para que los cuerpos se midan en BYTES exactos.
export function parsearDefiniciones(latin1) {
  const defs = [];
  const re = /^create\s+or\s+replace\s+function\s+public\.([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gim;
  let m;
  while ((m = re.exec(latin1))) {
    const ini = m.index;
    const cab = /\sas\s+\$function\$/gi;
    cab.lastIndex = re.lastIndex;
    const a = cab.exec(latin1);
    if (!a) { defs.push({ nombre: m[1], ini, error: "sin AS $function$" }); continue; }
    const bIni = a.index + a[0].length;
    const bFin = latin1.indexOf("$function$", bIni);
    if (bFin < 0) { defs.push({ nombre: m[1], ini, error: "cuerpo sin cerrar" }); continue; }
    const tipos = tiposDeArgs(m[2]);
    defs.push({
      nombre: m[1], ini, bIni, bFin, fin: bFin + "$function$".length,
      firma: tipos === null ? null : `${m[1]}(${tipos.join(",")})`,
      error: tipos === null ? "tipo de argumento no reconocido" : undefined,
      cuerpo: Buffer.from(latin1.slice(bIni, bFin), "latin1"),
    });
    re.lastIndex = bFin + "$function$".length;
  }
  return defs;
}

// Cuerpo de una funcion de un SQL historico (una sola ocurrencia por nombre, primer bloque $tag$).
export function cuerpoHistorico(latin1, nombre) {
  const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${nombre}\\s*\\(`, "gi");
  const ms = [...latin1.matchAll(re)];
  if (ms.length !== 1) return { error: `${ms.length} definiciones de ${nombre} (se esperaba 1)` };
  const desde = ms[0].index + ms[0][0].length;
  const m = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(latin1.slice(desde));
  if (!m) return { error: `${nombre}: sin cuerpo dollar-quoted` };
  const tag = m[0];
  const ini = desde + m.index + tag.length;
  const fin = latin1.indexOf(tag, ini);
  if (fin < 0) return { error: `${nombre}: cuerpo sin cerrar` };
  const b = Buffer.from(latin1.slice(ini, fin), "latin1");
  return { md5: md5(b), bytes: b.length };
}

// Texto "de nivel superior": sin cuerpos de funcion, sin bloques DO y sin comentarios de linea.
function sinCuerposNiDo(latin1, defs) {
  const chars = latin1.split("");
  for (const d of defs) {
    if (d.bIni === undefined) continue;
    for (let i = d.bIni; i < d.bFin; i++) if (chars[i] !== "\n") chars[i] = " ";
  }
  return chars.join("").replace(/\$(pre|trg|post)\$[\s\S]*?\$\1\$/g, m => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, m => " ".repeat(m.length));
}
// Igual, pero conservando los bloques DO (para detectar DDL peligroso escondido dentro de ellos).
function sinCuerposNiComentarios(latin1, defs) {
  const chars = latin1.split("");
  for (const d of defs) {
    if (d.bIni === undefined) continue;
    for (let i = d.bIni; i < d.bFin; i++) if (chars[i] !== "\n") chars[i] = " ";
  }
  return chars.join("").replace(/--[^\n]*/g, m => " ".repeat(m.length));
}

// ─────────────────────────────────────────────────────────────────────────── .gitattributes ──
function globARegex(pat) {
  let p = pat;
  const anclado = p.startsWith("/");
  if (anclado) p = p.slice(1);
  const tieneBarra = p.includes("/");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") { re += ".*"; i++; if (p[i + 1] === "/") i++; } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp((anclado || tieneBarra ? "^" : "(?:^|/)") + re + "$");
}
// Estado FINAL del atributo `text` para `ruta` (la ultima regla que coincide gana): set | unset | unspecified | <valor>.
export function estadoTextGit(texto, ruta) {
  let estado = "unspecified";
  let regla = false;
  for (const linea of texto.split(/\r?\n/)) {
    const l = linea.trim();
    if (!l || l.startsWith("#")) continue;
    const partes = l.split(/\s+/);
    let re;
    try { re = globARegex(partes[0]); } catch { continue; }
    if (!re.test(ruta)) continue;
    for (const a of partes.slice(1)) {
      if (a === "text") estado = "set";
      else if (a === "-text" || a === "binary") estado = "unset";
      else if (a === "!text") estado = "unspecified";
      else if (a.startsWith("text=")) estado = a.slice(5);
    }
    if (partes[0] === ruta && partes.slice(1).includes("-text")) regla = true;
  }
  return { estado, reglaExacta: regla };
}

// ────────────────────────────────────────────────────────────────────────────── ACL estatica ──
const RE_ACL = /\b(revoke|grant)\b([^;]*);/gi;
const RE_ACL_CANONICA = /^\s+execute\s+on\s+function\s+public\.([a-z_0-9]+\([^)]*\))\s+(from|to)\s+(.+?)\s*$/i;
export function analizarAcl(nivelSuperior) {
  const estados = new Map(); // firma -> Map(rol -> boolean)
  const sentencias = { revoke: 0, grant: 0 };
  const raras = [];
  for (const m of nivelSuperior.matchAll(RE_ACL)) {
    const tipo = m[1].toLowerCase();
    const c = RE_ACL_CANONICA.exec(m[2]);
    if (!c || (tipo === "revoke") !== (c[2].toLowerCase() === "from")) { raras.push(m[0].replace(/\s+/g, " ").trim()); continue; }
    const firma = c[1].replace(/\s+/g, "");
    const roles = c[3].split(",").map(r => r.trim().toLowerCase());
    if (roles.some(r => !/^[a-z_][a-z0-9_]*$/.test(r))) { raras.push(m[0].replace(/\s+/g, " ").trim()); continue; }
    sentencias[tipo]++;
    if (!estados.has(firma)) estados.set(firma, new Map());
    for (const r of roles) estados.get(firma).set(r, tipo === "grant");
  }
  return { estados, sentencias, raras };
}

// ───────────────────────────────────────────────────────────────────────────────── triggers ──
function bloqueDo(texto, tag) {
  const m = new RegExp(`DO\\s+\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$\\s*;`).exec(texto);
  return m ? m[1] : null;
}
function filasTriggers(bloque, conDescripcion) {
  if (bloque === null) return null;
  const re = conDescripcion
    ? /\(\s*'((?:auth|public)\.[a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*'([a-z_]+\(\))'\s*,\s*(\d+)\s*,\s*'([A-Z ]+)'\s*\)/g
    : /\(\s*'((?:auth|public)\.[a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*'([a-z_]+\(\))'\s*,\s*(\d+)\s*\)/g;
  return [...bloque.matchAll(re)].map(m => ({ tabla: m[1], nombre: m[2], funcion: m[3], tgtype: Number(m[4]), ...(conDescripcion ? { descripcion: m[5] } : {}) }));
}

// ───────────────────────────────────────────────────────────────────────────────── evidencia ──
function clavesOSospechosos(v, ruta = "$", out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => clavesOSospechosos(x, `${ruta}[${i}]`, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (/(^|_)(b64|base64|cuerpo|definicion|prosrc)$/i.test(k) && k !== "md5_prosrc") out.push(`${ruta}.${k}`);
      clavesOSospechosos(x, `${ruta}.${k}`, out);
    }
  } else if (typeof v === "string" && v.length > 120 && /^[A-Za-z0-9+/=]+$/.test(v)) out.push(`${ruta} (cadena base64 de ${v.length})`);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────── evaluacion ──
export function evaluarCobertura(ctx, opciones = {}) {
  const A = ctx.archivos;
  const syncEsperado = opciones.syncSha256 ?? INV.syncSha256;
  const R = [];
  const resumen = {};
  const chk = (id, cond, detalle = "") => { R.push({ id, ok: Boolean(cond), detalle: cond ? "" : detalle }); return Boolean(cond); };
  const grupo = (id, fn) => { try { fn(); } catch (e) { R.push({ id, ok: false, detalle: `excepcion inesperada: ${e.message}` }); } };

  const bufSync = A.get(RUTAS.sync);
  const man = parseJSON(A.get(RUTAS.manifiesto));
  const pre = parseJSON(A.get(RUTAS.pre));
  const post = parseJSON(A.get(RUTAS.post));
  const latin1 = bufSync ? bufSync.toString("latin1") : "";
  const defs = parsearDefiniciones(latin1);
  const firmasDefs = defs.map(d => d.firma);
  const preFunciones = Array.isArray(pre?.funciones) ? pre.funciones : [];
  const firmasPre = preFunciones.map(f => f.firma);
  const canonicoPre = new Map(preFunciones.map(f => [f.firma, f]));

  // ---- manifest
  grupo("MANIFIESTO_CONSISTENTE", () => {
    if (!man) return void chk("MANIFIESTO_CONSISTENTE", false, "manifiesto de cobertura ausente o JSON invalido");
    const p = [];
    if (man.formato !== "rcv34-cobertura-sync/1") p.push("formato");
    if (man.source_sync?.archivo !== RUTAS.sync) p.push("source_sync.archivo");
    if (man.source_sync?.sha256 !== syncEsperado) p.push("source_sync.sha256 distinto del fijado en el guard");
    if (man.source_sync?.funciones !== 17 || man.source_sync?.triggers !== 5) p.push("source_sync.funciones/triggers");
    if (man.gitattributes?.archivo !== RUTAS.gitattributes || man.gitattributes?.regla !== INV.reglaGitattributes) p.push("gitattributes");
    if (man.canonico?.rol_actual_post_rcv35_md5 !== INV.rolPost) p.push("canonico.rol_actual_post_rcv35_md5");
    if (man.canonico?.rol_actual_pre_inseguro_md5 !== INV.rolPre) p.push("canonico.rol_actual_pre_inseguro_md5");
    if (man.canonico?.evidencia_pre_b3r?.archivo !== RUTAS.pre) p.push("canonico.evidencia_pre_b3r.archivo");
    if (man.canonico?.evidencia_post_rcv35?.archivo !== RUTAS.post) p.push("canonico.evidencia_post_rcv35.archivo");
    if (!igual(man.triggers, TRIGGERS)) p.push("triggers");
    if (!igual(man.source_only, SOURCE_ONLY)) p.push("source_only");
    if (!igual(man.conteos_esperados, { ...CLASES, total: 13 })) p.push("conteos_esperados");
    if (man.baseline?.archivo !== RUTAS.baseline || man.baseline?.entradas !== 13) p.push("baseline");
    if (!igual(man.acl, { PUBLIC_cerrado: 17, anon_cerrado: 17, authenticated_true: 16, sin_authenticated: [CREAR_PERFIL], service_role_true: 17 })) p.push("acl");
    chk("MANIFIESTO_CONSISTENTE", p.length === 0, `el manifiesto no coincide con los invariantes del guard: ${p.join(", ")}`);
  });

  // ---- source-sync: identidad y estructura
  grupo("SYNC_SHA", () => {
    const real = bufSync ? sha256(bufSync) : null;
    chk("SYNC_SHA", real === syncEsperado, `sha256 del source-sync=${real} (se esperaba ${syncEsperado})`);
  });
  grupo("SYNC_DEFS_17", () => {
    const totalCreate = (latin1.match(/\bcreate\s+(?:or\s+replace\s+)?function\b/gi) || []).length;
    const malas = defs.filter(d => d.error).map(d => `${d.nombre}: ${d.error}`);
    chk("SYNC_DEFS_17", defs.length === 17 && totalCreate === 17 && malas.length === 0,
      `definiciones=${defs.length}, CREATE FUNCTION totales=${totalCreate} (se esperaban 17 y 17)${malas.length ? "; " + malas.join("; ") : ""}`);
  });
  grupo("SYNC_FIRMAS_DISTINTAS", () => {
    const set = new Set(firmasDefs);
    chk("SYNC_FIRMAS_DISTINTAS", firmasDefs.length === 17 && set.size === 17 && !set.has(null), `firmas distintas=${set.size} de ${firmasDefs.length}`);
  });
  grupo("SYNC_FIRMAS_EXACTAS", () => {
    const f1 = faltan(FIRMAS_CANONICAS, firmasDefs), s1 = sobran(FIRMAS_CANONICAS, firmasDefs);
    const f2 = faltan(firmasPre, firmasDefs), s2 = sobran(firmasPre, firmasDefs);
    chk("SYNC_FIRMAS_EXACTAS", !f1.length && !s1.length && !f2.length && !s2.length && firmasPre.length === 17,
      `faltan=[${[...f1, ...f2]}] sobran=[${[...s1, ...s2]}] (manifest B3R con ${firmasPre.length} funciones)`);
  });

  // ---- fingerprints byte-exact 17/17 (+ rol_actual POST)
  grupo("SYNC_FINGERPRINTS", () => {
    const malos = []; let ok = 0;
    for (const firma of FIRMAS_CANONICAS) {
      const d = defs.find(x => x.firma === firma);
      const e = firma === "rol_actual()"
        ? (post ? { md5: post.md5_prosrc, bytes: post.bytes, cr: post.cr, lf: post.lf } : null)
        : (canonicoPre.has(firma) ? { md5: canonicoPre.get(firma).md5_prosrc, bytes: canonicoPre.get(firma).bytes, cr: canonicoPre.get(firma).cr, lf: canonicoPre.get(firma).lf } : null);
      if (!d || !e) { malos.push(`${firma}: ${!d ? "no definida" : "sin huella esperada"}`); continue; }
      const real = { md5: md5(d.cuerpo), bytes: d.cuerpo.length, cr: contar(d.cuerpo, 13), lf: contar(d.cuerpo, 10) };
      if (real.md5 === e.md5 && real.bytes === e.bytes && real.cr === e.cr && real.lf === e.lf) ok++;
      else malos.push(`${firma}: md5 ${real.md5.slice(0, 8)}/${String(e.md5).slice(0, 8)} bytes ${real.bytes}/${e.bytes} CR ${real.cr}/${e.cr} LF ${real.lf}/${e.lf}`);
    }
    resumen.fingerprints = ok;
    chk("SYNC_FINGERPRINTS", ok === 17, `fingerprints byte-exact ${ok}/17; distintos: ${malos.join(" | ")}`);
  });

  // ---- rol_actual POST-RCV35
  grupo("ROL_ACTUAL", () => {
    const rol = defs.find(d => d.firma === "rol_actual()");
    const md5Rol = rol ? md5(rol.cuerpo) : null;
    const norm = rol ? rol.cuerpo.toString("latin1").toLowerCase().replace(/\s+/g, "") : "";
    const cte = /c_md5_rol_actual\s+constant\s+text\s*:=\s*'([0-9a-f]{32})'/.exec(latin1)?.[1];
    const lista = /"rol_actual\(\)"\s*:\s*"([0-9a-f]{32})"/.exec(latin1)?.[1];
    resumen.rol_actual_md5 = md5Rol;
    chk("ROL_ACTUAL_POST", md5Rol === INV.rolPost && post?.md5_prosrc === INV.rolPost && cte === INV.rolPost && lista === INV.rolPost,
      `md5 del cuerpo embebido=${md5Rol}; evidencia POST=${post?.md5_prosrc}; constante de postcondicion=${cte}; lista canonica=${lista} (todos deben ser ${INV.rolPost})`);
    chk("ROL_ACTUAL_FILTRO", Boolean(rol) && rol.cuerpo.toString("latin1").includes("AND p.activo") && norm.includes("andp.activo") && norm === LOGICA_ROL_ACTUAL,
      "el cuerpo embebido de rol_actual() NO es la logica esperada con el filtro AND p.activo");
    const rolPre = opciones.rolPre ?? INV.rolPre; // el override existe solo para los fixtures
    chk("ROL_ACTUAL_NO_PRE", md5Rol !== rolPre && !latin1.includes(rolPre),
      `el source-sync reproduce o contiene el md5 PRE inseguro ${rolPre}`);
  });

  // ---- ACL
  grupo("ACL", () => {
    const top = sinCuerposNiDo(latin1, defs);
    const { estados, sentencias, raras } = analizarAcl(top);
    const rolesPermitidos = new Set(["public", "anon", "authenticated", "service_role"]);
    const desconocidas = [...estados.keys()].filter(f => !FIRMAS_CANONICAS.includes(f));
    const extras = [];
    for (const [f, mapa] of estados) for (const [r, v] of mapa) if (v === true && !["authenticated", "service_role"].includes(r)) extras.push(`${f}->${r}`);
    for (const [f, mapa] of estados) for (const r of mapa.keys()) if (!rolesPermitidos.has(r)) extras.push(`${f} nombra el rol ${r}`);
    const estadoDe = (f, r) => estados.get(f)?.get(r);
    const cuenta = (r, val, lista = FIRMAS_CANONICAS) => lista.filter(f => estadoDe(f, r) === val).length;
    const sinCrear = FIRMAS_CANONICAS.filter(f => f !== CREAR_PERFIL);
    resumen.acl = {
      PUBLIC: cuenta("public", false), anon: cuenta("anon", false),
      authenticated: cuenta("authenticated", true), service_role: cuenta("service_role", true),
      crear_perfil_authenticated: estadoDe(CREAR_PERFIL, "authenticated"),
    };
    chk("ACL_PUBLIC", resumen.acl.PUBLIC === 17, `PUBLIC cerrado (REVOKE explicito) en ${resumen.acl.PUBLIC}/17`);
    chk("ACL_ANON", resumen.acl.anon === 17 && cuenta("anon", true) === 0, `anon cerrado en ${resumen.acl.anon}/17`);
    chk("ACL_AUTHENTICATED", cuenta("authenticated", true, sinCrear) === 16 && resumen.acl.authenticated === 16, `authenticated concedido en ${resumen.acl.authenticated}/17 (se esperaban 16, sin crear_perfil)`);
    chk("ACL_CREAR_PERFIL", estadoDe(CREAR_PERFIL, "authenticated") === false, `crear_perfil_al_registrarse(): authenticated=${estadoDe(CREAR_PERFIL, "authenticated")} (se esperaba false, revocado explicitamente)`);
    chk("ACL_SERVICE_ROLE", resumen.acl.service_role === 17, `service_role concedido en ${resumen.acl.service_role}/17`);
    chk("ACL_SIN_EXTRAS", raras.length === 0 && desconocidas.length === 0 && extras.length === 0 && sentencias.revoke === 17 && sentencias.grant === 17,
      `REVOKE=${sentencias.revoke} GRANT=${sentencias.grant} (17 y 17); sentencias no reconocidas=[${raras}]; firmas ajenas=[${desconocidas}]; roles extra=[${extras}]`);
    // REV8 (sin tocarlo): las 17 deben salir segura_actual, sin prohibited_grant ni ACL/lexico no parseable
    const rev8 = analizarTexto(RUTAS.sync, bufSync ? bufSync.toString("utf8") : "", new Map());
    const cats = rev8.funciones.map(f => f.categoria);
    chk("REV8_SYNC_SEGURO", rev8.funciones.length === 17 && cats.every(c => c === "segura_actual") && rev8.prohibidos.length === 0 &&
      rev8.erroresLexicos.length === 0 && rev8.aclNoParseables.length === 0,
      `REV8 sobre el source-sync: ${cats.filter(c => c === "segura_actual").length}/${rev8.funciones.length} segura_actual, prohibidos=${rev8.prohibidos.length}, lexicos=${rev8.erroresLexicos.length}, ACL no parseables=${rev8.aclNoParseables.length}`);
  });

  // ---- triggers y DDL prohibido
  grupo("TRIGGERS", () => {
    const filasTrg = filasTriggers(bloqueDo(latin1, "trg"), true);
    const filasPost = filasTriggers(bloqueDo(latin1, "post"), false);
    const esperadoTrg = TRIGGERS.map(({ tabla, nombre, funcion, tgtype, descripcion }) => ({ tabla, nombre, funcion, tgtype, descripcion }));
    const esperadoPost = TRIGGERS.map(({ tabla, nombre, funcion, tgtype }) => ({ tabla, nombre, funcion, tgtype }));
    const ord = (l) => (l ?? []).map(canon).sort();
    const bloqueTrg = bloqueDo(latin1, "trg") ?? "";
    const bloquePost = bloqueDo(latin1, "post") ?? "";
    const ok = igual(ord(filasTrg), ord(esperadoTrg)) && igual(ord(filasPost), ord(esperadoPost)) &&
      /FOR EACH ROW EXECUTE FUNCTION public\.%s/.test(bloqueTrg) && /v_trg_total\s*<>\s*5/.test(bloquePost);
    resumen.triggers = (filasTrg ?? []).filter(f => esperadoTrg.some(e => canon(e) === canon(f))).length;
    chk("TRIGGERS_5", ok, `triggers del bloque $trg$=${filasTrg?.length ?? "no encontrado"}, de $post$=${filasPost?.length ?? "no encontrado"}; deben ser exactamente los 5 esperados, por fila, con la comprobacion de 5 en total`);
  });
  grupo("DDL", () => {
    const t = sinCuerposNiComentarios(latin1, defs);
    chk("SYNC_SIN_DROP_TRIGGER", !/\bdrop\s+trigger\b/i.test(t), "el source-sync contiene DROP TRIGGER (los triggers se validan o crean, nunca se borran a ciegas)");
    chk("SYNC_SIN_ALTER_DEFAULT_PRIVILEGES", !/\balter\s+default\s+privileges\b/i.test(t), "el source-sync contiene ALTER DEFAULT PRIVILEGES");
    const prohibido = [/\bgrant\s+all\b/i, /\bdrop\s+(?:function|table|schema|policy|extension|role)\b/i, /\bowner\s+to\b/i, /\btruncate\b/i,
      /\binsert\s+into\b/i, /\bdelete\s+from\b/i, /\bupdate\s+[a-z_."]+\s+set\b/i, /\balter\s+(?:table|function|role|schema|policy)\b/i,
      /\bcreate\s+(?:table|policy|schema|extension|role|view|index)\b/i].filter(re => re.test(t)).map(re => re.source);
    chk("SYNC_SIN_DDL_PROHIBIDO", prohibido.length === 0, `DDL/DML fuera de alcance en el source-sync: ${prohibido.join(", ")}`);
    const top = sinCuerposNiDo(latin1, defs).trim();
    const sets = ["SET LOCAL search_path = pg_catalog, public;", "SET LOCAL statement_timeout = '30s';", "SET LOCAL lock_timeout = '5s';"];
    chk("SYNC_TRANSACCION", top.startsWith("BEGIN;") && top.endsWith("COMMIT;") && (top.match(/\bBEGIN;/g) || []).length === 1 &&
      (top.match(/\bCOMMIT;/g) || []).length === 1 && sets.every(s => top.includes(s)),
      "el source-sync no es una unica transaccion BEGIN;..COMMIT; con SET LOCAL search_path/statement_timeout/lock_timeout");
  });

  // ---- .gitattributes
  grupo("GITATTRIBUTES", () => {
    const buf = A.get(RUTAS.gitattributes);
    const { estado, reglaExacta } = buf ? estadoTextGit(buf.toString("utf8"), RUTAS.sync) : { estado: "sin .gitattributes", reglaExacta: false };
    chk("GITATTRIBUTES_TEXT_UNSET", estado === "unset" && reglaExacta,
      `atributo text del source-sync=${estado}, regla exacta "${INV.reglaGitattributes}" ${reglaExacta ? "presente" : "AUSENTE"} (Git normalizaria los CRLF intencionales)`);
  });

  // ---- evidencia PRE (B3R) y POST (RCV35)
  grupo("EVIDENCIA", () => {
    const pinPre = man?.canonico?.evidencia_pre_b3r?.sha256, pinPost = man?.canonico?.evidencia_post_rcv35?.sha256;
    const shaPre = A.get(RUTAS.pre) ? sha256(A.get(RUTAS.pre)) : null, shaPost = A.get(RUTAS.post) ? sha256(A.get(RUTAS.post)) : null;
    const rolPre = canonicoPre.get("rol_actual()");
    const sosPre = pre ? clavesOSospechosos(pre) : ["no legible"], sosPost = post ? clavesOSospechosos(post) : ["no legible"];
    chk("EVIDENCIA_PRE_B3R", Boolean(pre) && shaPre !== null && shaPre === pinPre && pre.total === 17 && pre.normales === 13 && pre.trigger === 4 &&
      firmasPre.length === 17 && rolPre?.md5_prosrc === INV.rolPre && sosPre.length === 0,
      `evidencia B3R: sha ${shaPre === pinPre ? "fijado OK" : "NO coincide con el fijado"}, funciones=${firmasPre.length}, rol_actual PRE md5=${rolPre?.md5_prosrc} (se esperaba ${INV.rolPre}), campos sospechosos=[${sosPre}]`);
    const acl = post?.acl_efectiva;
    chk("EVIDENCIA_POST_RCV35", Boolean(post) && shaPost !== null && shaPost === pinPost && post.firma === "rol_actual()" && post.md5_prosrc === INV.rolPost &&
      post.bytes === 158 && post.cr === 0 && post.lf === 11 && post.owner === "postgres" && post.security_definer === true && post.search_path === "public" &&
      acl?.PUBLIC_execute === false && acl?.anon_execute === false && acl?.authenticated_execute === true && acl?.service_role_execute === true &&
      post.contiene_filtro_activo === true && post.cuerpo_es_la_logica_esperada === true && post.cumple_estado_post_fix === true && sosPost.length === 0,
      `evidencia POST RCV35: sha ${shaPost === pinPost ? "fijado OK" : "NO coincide con el fijado"}, md5=${post?.md5_prosrc}, cumple_estado_post_fix=${post?.cumple_estado_post_fix}, campos sospechosos=[${sosPost}]`);
    chk("EVIDENCIA_PRE_POST_COEXISTEN", Boolean(pre) && Boolean(post) && rolPre?.md5_prosrc === INV.rolPre && post?.md5_prosrc === INV.rolPost &&
      rolPre?.md5_prosrc !== post?.md5_prosrc,
      `PRE (B3R) y POST (RCV35) deben coexistir y diferir: PRE=${rolPre?.md5_prosrc} POST=${post?.md5_prosrc}`);
    resumen.evidencia = { pre: rolPre?.md5_prosrc, post: post?.md5_prosrc };
  });

  // ---- source-only
  grupo("SOURCE_ONLY", () => {
    const enSync = SOURCE_ONLY.filter(f => latin1.includes(f.split("(")[0]));
    const enProd = SOURCE_ONLY.filter(f => firmasPre.includes(f) || FIRMAS_CANONICAS.includes(f) || JSON.stringify(post ?? {}).includes(f.split("(")[0]));
    resumen.source_only_excluidas = SOURCE_ONLY.length - enSync.length - enProd.length;
    chk("SOURCE_ONLY_EXCLUIDAS", enSync.length === 0 && enProd.length === 0, `SOURCE_ONLY presentes en el source-sync=[${enSync}] o en la lista de produccion/canonica=[${enProd}]`);
  });

  // ---- baseline y clasificacion
  const baselineBuf = A.get(RUTAS.baseline);
  const baseline = parseJSON(baselineBuf);
  let entradas = [];
  grupo("BASELINE", () => {
    const p = [];
    if (!Array.isArray(baseline)) p.push("no es un array JSON");
    else {
      const vistos = new Set();
      baseline.forEach((e, i) => {
        const claves = e && typeof e === "object" ? Object.keys(e).sort().join(",") : "";
        if (claves !== "archivo,firma,hash") p.push(`entrada ${i}: campos ${claves || "invalidos"} (solo archivo,firma,hash)`);
        else if (typeof e.archivo !== "string" || typeof e.firma !== "string" || !/^[0-9a-f]{64}$/.test(e.hash)) p.push(`entrada ${i}: valores invalidos`);
        else {
          const k = `${e.archivo}|${e.firma}`;
          if (vistos.has(k)) p.push(`duplicado ${k}`); vistos.add(k);
          if (!FUENTES_HISTORICAS.includes(e.archivo)) p.push(`entrada ${i}: archivo no permitido en el baseline (${e.archivo})`);
          entradas.push(e);
        }
      });
      if (baseline.length !== 13) p.push(`${baseline.length} entradas (se esperaban exactamente 13)`);
    }
    resumen.baseline = Array.isArray(baseline) ? baseline.length : null;
    chk("BASELINE_13", p.length === 0, p.join("; "));
  });
  grupo("BASELINE_REV8", () => {
    const indice = new Map(entradas.map(e => [`${e.archivo}|${e.firma}`, e.hash]));
    let legacy = 0; const malos = [];
    for (const archivo of FUENTES_HISTORICAS) {
      const buf = A.get(archivo);
      if (!buf) { malos.push(`${archivo}: ausente`); continue; }
      const r = analizarTexto(archivo, buf.toString("utf8"), indice);
      for (const f of r.funciones) {
        if (f.categoria === "legacy_baseline") legacy++;
        else if (f.categoria !== "segura_actual") malos.push(`${archivo.split("/").pop()} ${f.firma}: ${f.categoria}`);
      }
      if (r.aclNoParseables.length || r.erroresLexicos.length) malos.push(`${archivo}: ACL/lexico no parseable`);
    }
    chk("BASELINE_HASHES_REV8", legacy === 13 && malos.length === 0, `legacy_baseline=${legacy}/13 con los hashes del baseline sobre los SQL reales; problemas: ${malos.join(" | ")}`);
  });
  grupo("CLASIFICACION", () => {
    const cl = Array.isArray(man?.clasificacion) ? man.clasificacion : [];
    const keyBase = (e) => `${e.archivo}|${e.firma}|${e.hash}`;
    const kb = entradas.map(keyBase), kc = cl.map(keyBase);
    const dup = kc.length !== new Set(kc).size;
    const huerfanasBase = faltan(kc, kb), extrasClas = faltan(kb, kc);
    chk("CLASIFICACION_13_13", cl.length === 13 && kb.length === 13 && !dup && !huerfanasBase.length && !extrasClas.length,
      `clasificadas=${cl.length}/13; entradas del baseline SIN clasificar (huerfanas)=[${huerfanasBase.map(k => k.split("|").slice(0, 2).join("|"))}]; clasificaciones SIN baseline=[${extrasClas.map(k => k.split("|").slice(0, 2).join("|"))}]${dup ? "; duplicadas" : ""}`);

    const cont = {}; for (const e of cl) cont[e.clasificacion] = (cont[e.clasificacion] ?? 0) + 1;
    const invalidas = cl.filter(e => !(e.clasificacion in CLASES)).map(e => e.clasificacion);
    const porClase = {}; for (const e of cl) (porClase[e.clasificacion] ??= []).push(`${e.archivo}|${e.firma}`);
    const membresiaOk = Object.keys(CLASES).every(c => igual([...(porClase[c] ?? [])].sort(), [...MEMBRESIA[c]].sort()));
    resumen.clasificacion = cont;
    chk("CLASIFICACION_CONTEOS", invalidas.length === 0 && Object.entries(CLASES).every(([c, n]) => (cont[c] ?? 0) === n) && membresiaOk && cl.length === 13,
      `conteos=${JSON.stringify(cont)} (esperados ${JSON.stringify(CLASES)}); clases invalidas=[${invalidas}]; membresia exacta ${membresiaOk ? "OK" : "NO coincide"}`);

    // cada clase contra el cuerpo REAL de la fuente historica
    const problemas = [];
    for (const e of cl) {
      const buf = A.get(e.archivo);
      if (!buf) { problemas.push(`${e.firma}: archivo ausente`); continue; }
      const nombre = String(e.firma).replace(/^public\./, "").split("(")[0];
      const c = cuerpoHistorico(buf.toString("latin1"), nombre);
      if (c.error) { problemas.push(c.error); continue; }
      if (c.md5 !== e.md5_cuerpo_fuente || c.bytes !== e.bytes_cuerpo_fuente) problemas.push(`${e.firma} (${e.archivo.split("/").pop()}): el cuerpo historico cambio respecto al manifiesto`);
      const sinPublic = String(e.firma).replace(/^public\./, "");
      const canon = canonicoPre.get(sinPublic);
      switch (e.clasificacion) {
        case "ACTIVE_SOURCE_MATCHES_CANONICAL":
          if (!canon || canon.md5_prosrc !== c.md5) problemas.push(`${sinPublic}: se clasifico como MATCH pero su cuerpo NO es el canonico de produccion`);
          break;
        case "ACTIVE_SOURCE_DIVERGED_SUPERSEDED_BY_CANONICAL":
          if (!canon || canon.md5_prosrc === c.md5) problemas.push(`${sinPublic}: se clasifico como DIVERGED pero su cuerpo coincide con el canonico (o no existe en produccion)`);
          break;
        case "SUPERSEDED_HISTORICAL":
          if (!canon || canon.md5_prosrc === c.md5 || !cl.some(o => o !== e && o.firma === e.firma && o.clasificacion === "ACTIVE_SOURCE_MATCHES_CANONICAL"))
            problemas.push(`${sinPublic}: SUPERSEDED_HISTORICAL exige un cuerpo distinto del canonico y otra definicion activa que lo reemplace`);
          break;
        case "ROLLBACK_ONLY":
          if (e.archivo !== ROLLBACK || !canon || canon.md5_prosrc === c.md5) problemas.push(`${sinPublic}: ROLLBACK_ONLY exige el archivo de rollback y un cuerpo distinto del canonico`);
          break;
        case "SOURCE_ONLY_NOT_DEPLOYED":
          if (canon || FIRMAS_CANONICAS.includes(sinPublic) || !SOURCE_ONLY.includes(sinPublic)) problemas.push(`${sinPublic}: SOURCE_ONLY_NOT_DEPLOYED no puede existir en produccion ni en la lista canonica`);
          break;
        default: problemas.push(`${sinPublic}: clase desconocida ${e.clasificacion}`);
      }
    }
    chk("CLASIFICACION_CONTRA_FUENTES", cl.length === 13 && problemas.length === 0, problemas.join(" | ") || `clasificadas=${cl.length}`);
  });

  // ---- archivos protegidos
  grupo("PROTEGIDOS", () => {
    const lista = Array.isArray(man?.protegidos) ? man.protegidos : [];
    const rutas = lista.map(p => p.archivo);
    const p = faltan(PROTEGIDOS_REQUERIDOS, rutas).map(r => `${r}: no esta fijado en el manifiesto`);
    for (const e of lista) {
      const buf = A.get(e.archivo);
      if (!buf) p.push(`${e.archivo}: ausente`);
      else if (sha256(buf) !== e.sha256) p.push(`${e.archivo}: SHA-256 distinto del fijado`);
    }
    chk("PROTEGIDOS_SHA", p.length === 0, p.join("; "));
  });

  const fallos = R.filter(r => !r.ok);
  return { resultados: R, fallos, ok: fallos.length === 0, resumen };
}

// ────────────────────────────────────────────────────────────────────────────────── contexto ──
export function cargarContexto(repoRoot = REPO_ROOT) {
  const A = new Map();
  const leer = (rel) => {
    if (typeof rel !== "string" || path.isAbsolute(rel) || rel.split("/").includes("..")) return;
    try { A.set(rel, readFileSync(path.join(repoRoot, rel))); } catch { /* ausente: el check correspondiente falla */ }
  };
  [RUTAS.sync, RUTAS.gitattributes, RUTAS.baseline, RUTAS.manifiesto, RUTAS.pre, RUTAS.post, ...FUENTES_HISTORICAS, ...PROTEGIDOS_REQUERIDOS].forEach(leer);
  const man = parseJSON(A.get(RUTAS.manifiesto));
  for (const p of Array.isArray(man?.protegidos) ? man.protegidos : []) leer(p?.archivo);
  return { archivos: A };
}

export function informe(res) {
  const l = [];
  l.push("RCV-34 B3T - coverage gate del source-sync canonico (POST RCV-35)");
  l.push("NO VERIFICA PRODUCCIÓN: compara archivos del repositorio con evidencia ya capturada; no consulta ni ejecuta nada contra Supabase/PostgreSQL.");
  l.push("");
  for (const r of res.resultados) l.push(`${r.ok ? "PASS" : "FAIL"}  [${r.id}]${r.ok ? "" : "  -> " + r.detalle}`);
  const s = res.resumen;
  l.push("");
  l.push(`resumen: baseline=${s.baseline} clasificacion=${JSON.stringify(s.clasificacion)}`);
  l.push(`resumen: fingerprints_byte_exact=${s.fingerprints ?? "?"}/17 rol_actual_md5=${s.rol_actual_md5} PRE=${s.evidencia?.pre} POST=${s.evidencia?.post}`);
  l.push(`resumen: ACL PUBLIC_cerrado=${s.acl?.PUBLIC}/17 anon_cerrado=${s.acl?.anon}/17 authenticated=${s.acl?.authenticated}/17 crear_perfil_authenticated=${s.acl?.crear_perfil_authenticated} service_role=${s.acl?.service_role}/17 triggers=${s.triggers}/5 source_only_excluidas=${s.source_only_excluidas}/2`);
  l.push("");
  l.push(res.fallos.length ? `${res.fallos.length} FAIL` : "TODO PASS");
  l.push("NO VERIFICA PRODUCCIÓN");
  return l.join("\n");
}

function main() {
  const res = evaluarCobertura(cargarContexto());
  console.log(informe(res));
  process.exit(res.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
