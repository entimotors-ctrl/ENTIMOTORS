// 3.15.0 · Bloque 5 · guard ESTATICO de EVOLUCION de las funciones canonicas RCV-34 (complementa REV8; no lo modifica).
//
// NO VERIFICA PRODUCCION. Solo lee archivos del repositorio.
//
// El hueco que cierra: REV8 comprueba que cada CREATE FUNCTION cierre su ACL, y el coverage gate fija el source-sync canonico;
// ninguno de los dos mira si una migracion POSTERIOR (taller-demo/supabase/sync/*.sql, u otro .sql) redefine una de las 17
// funciones canonicas. Una migracion podia reescribir rol_actual(), es_admin() o puede_cobrar() con el ACL bien cerrado y todo
// seguia en verde. Desde 3.15 una funcion canonica puede EVOLUCIONAR, pero solo de forma DECLARADA:
//
//   * fuera de las fuentes exentas (source-sync, 3 historicas, SQL protegidos de RCV-34/35), todo CREATE/ALTER/DROP FUNCTION y
//     todo GRANT/REVOKE sobre una firma canonica tiene que estar declarado en evoluciones-canonicas.json Y en EVOLUCIONES (aqui):
//     relajarlo exige tocar dos archivos a la vista de la revision;
//   * una redefinicion declarada = cuerpo canonico (byte a byte) + EXACTAMENTE los reemplazos declarados, cada uno una sola vez;
//     la cabecera (RETURNS, LANGUAGE, volatilidad, SECURITY DEFINER, SET search_path) identica a la canonica; md5 del cuerpo fijado;
//   * ALTER FUNCTION / DROP FUNCTION de una canonica: nunca;
//   * el ACL declarado se compara sentencia por sentencia y el estado final deja PUBLIC y anon SIN EXECUTE.
//
// Uso: node guard-evolucion-canonicas.mjs            -> evalua el repositorio real
// Como libreria (fixtures): evaluarEvolucion({ archivos: Map<rutaRelativa, Buffer> }).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { descubrirSql } from "./guard-estatico-funciones.mjs";
import { FIRMAS_CANONICAS, FUENTES_HISTORICAS, RUTAS, REPO_ROOT } from "./guard-estatico-cobertura-sync.mjs";

export const MANIFIESTO = "pruebas/rcv34/evoluciones-canonicas.json";
export const EXENTOS = [RUTAS.sync, ...FUENTES_HISTORICAS, "pruebas/rcv34/01-cierre-triggers-public.sql",
  "pruebas/rcv34/02-rollback-cierre-triggers.sql", "pruebas/rcv35/01-fix-rol-actual-activo.sql"];

// Fijado EN CODIGO (el manifiesto debe coincidir). archivo|firma -> md5 del cuerpo y numero de reemplazos.
export const EVOLUCIONES = {
  "taller-demo/supabase/sync/sync-15e-finanzas.sql|estadisticas_tecnicas()": { md5: "ba8ce62526487ba738fe21a924db2f46", reemplazos: 1 },
  "taller-demo/supabase/sync/sync-15e-rollback.sql|estadisticas_tecnicas()": { md5: "86948fdcaf03939a1d0929004cd9c730", reemplazos: 0 },
};
// ACL declarada por archivo: lista EXACTA de sentencias sobre firmas canonicas (tipo|firma|roles ordenados).
export const ACL = {
  "taller-demo/supabase/sync/sync-15e-finanzas.sql": [
    "revoke|estadisticas_tecnicas()|anon,public", "grant|estadisticas_tecnicas()|authenticated,service_role",
    "revoke|registrar_venta(uuid,text,text,numeric,jsonb,integer,text)|anon,authenticated,public",
    "grant|registrar_venta(uuid,text,text,numeric,jsonb,integer,text)|service_role",
    "revoke|registrar_abono(uuid,numeric,text,text)|anon,authenticated,public", "grant|registrar_abono(uuid,numeric,text,text)|service_role",
  ],
  "taller-demo/supabase/sync/sync-15e-rollback.sql": [
    "revoke|estadisticas_tecnicas()|anon,public", "grant|estadisticas_tecnicas()|authenticated,service_role",
    "revoke|registrar_venta(uuid,text,text,numeric,jsonb,integer,text)|anon,public",
    "grant|registrar_venta(uuid,text,text,numeric,jsonb,integer,text)|authenticated,service_role",
    "revoke|registrar_abono(uuid,numeric,text,text)|anon,public", "grant|registrar_abono(uuid,numeric,text,text)|authenticated,service_role",
  ],
};

const NOMBRES = new Map(FIRMAS_CANONICAS.map((f) => [f.slice(0, f.indexOf("(")), f]));
const md5 = (s) => createHash("md5").update(s).digest("hex");

/* Quita comentarios (-- y /* *\/) sin tocar literales '...' ni cuerpos $tag$...$tag$: lo que queda se busca con expresiones.
   Los cuerpos $...$ se CONSERVAN (una sentencia dinamica EXECUTE 'CREATE FUNCTION ...' dentro de un cuerpo tambien cuenta). */
export function sinComentarios(t) {
  let o = "", i = 0;
  while (i < t.length) {
    if (t.startsWith("--", i)) { const f = t.indexOf("\n", i); i = f < 0 ? t.length : f; continue; }
    if (t.startsWith("/*", i)) { const f = t.indexOf("*/", i + 2); i = f < 0 ? t.length : f + 2; o += " "; continue; }
    if (t[i] === "'") { const f = t.indexOf("'", i + 1); const fin = f < 0 ? t.length : f + 1; o += t.slice(i, fin); i = fin; continue; }
    const d = /^\$([A-Za-z_]\w*)?\$/.exec(t.slice(i, i + 64));
    if (d) { const cierre = t.indexOf(d[0], i + d[0].length); const fin = cierre < 0 ? t.length : cierre + d[0].length; o += t.slice(i, fin); i = fin; continue; }
    o += t[i++];
  }
  return o;
}
const ID = String.raw`(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?`;
function tipos(args) {   // "(p_x uuid, p_y text DEFAULT 'a')" o "(uuid,text)" -> "uuid,text"
  return args.split(",").map((a) => a.replace(/\bdefault\b[\s\S]*$/i, "").replace(/=.*$/, "").trim()).filter(Boolean)
    .map((a) => { const p = a.split(/\s+/); return (p.length > 1 && !/^(double|character|timestamp|time)$/i.test(p[0]) ? p.slice(1) : p).join(" ").toLowerCase(); })
    .join(",").replace(/\s+/g, " ");
}
function firmaDe(nombre, args) { return `${nombre}(${tipos(args)})`; }

/** Sentencias que tocan firmas canonicas en un texto (ya sin comentarios). */
export function tocarCanonicas(t) {
  const out = [];
  const reDef = new RegExp(String.raw`\b(create\s+(?:or\s+replace\s+)?function|alter\s+function|drop\s+function(?:\s+if\s+exists)?)\s+${ID}\s*\(([^)]*)\)`, "gi");
  let m;
  while ((m = reDef.exec(t))) {
    const nombre = m[2].toLowerCase();
    if (!NOMBRES.has(nombre)) continue;
    const verbo = /^create/i.test(m[1]) ? "create" : /^alter/i.test(m[1]) ? "alter" : "drop";
    out.push({ tipo: verbo, firma: firmaDe(nombre, m[3]), pos: m.index });
  }
  const reAcl = new RegExp(String.raw`\b(grant|revoke)\s+(?:all(?:\s+privileges)?|execute)\s+on\s+function\s+${ID}\s*\(([^)]*)\)\s+(?:to|from)\s+([^;]+);`, "gi");
  while ((m = reAcl.exec(t))) {
    const nombre = m[2].toLowerCase();
    if (!NOMBRES.has(nombre)) continue;
    const roles = m[4].split(",").map((r) => r.trim().replace(/"/g, "").toLowerCase()).filter(Boolean).sort();
    out.push({ tipo: m[1].toLowerCase(), firma: firmaDe(nombre, m[3]), roles, pos: m.index });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

/** Cabecera (desde el nombre hasta AS $tag$) y cuerpo de la definicion de `nombre`. */
export function definicion(texto, nombre) {
  const re = new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+${ID}\s*\(`, "gi");
  let m;
  while ((m = re.exec(texto))) {
    if (m[1].toLowerCase() !== nombre) continue;
    const as = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(texto.slice(m.index));
    if (!as) return null;
    const iniCuerpo = m.index + as.index + as[0].length;
    const finCuerpo = texto.indexOf(as[1], iniCuerpo);
    if (finCuerpo < 0) return null;
    const cabecera = texto.slice(m.index, m.index + as.index).replace(/\s+/g, " ").trim().toLowerCase();
    return { cabecera, cuerpo: texto.slice(iniCuerpo, finCuerpo) };
  }
  return null;
}

export function evaluarEvolucion(ctx, opciones = {}) {
  const EV = opciones.evoluciones || EVOLUCIONES, AC = opciones.acl || ACL;
  const res = []; const chk = (id, ok, detalle) => res.push({ id, ok: !!ok, detalle });
  const leer = (r) => ctx.archivos.get(r)?.toString("utf8");

  // manifiesto = codigo
  let man = null;
  try { man = JSON.parse(leer(MANIFIESTO)); } catch { man = null; }
  const probMan = [];
  if (!man || man.version !== 1) probMan.push("manifiesto ausente o version != 1");
  else {
    const decl = {};
    for (const e of man.evoluciones || []) for (const f of e.funciones || []) decl[`${e.archivo}|${f.firma}`] = { md5: f.md5_nuevo, reemplazos: (f.reemplazos || []).length };
    const a = JSON.stringify(Object.keys(decl).sort().map((k) => [k, decl[k]])), b = JSON.stringify(Object.keys(EV).sort().map((k) => [k, EV[k]]));
    if (a !== b) probMan.push("funciones declaradas en el manifiesto ≠ EVOLUCIONES del codigo");
    const aclM = {};
    for (const e of man.evoluciones || []) aclM[e.archivo] = (e.acl || []).slice();
    if (JSON.stringify(Object.keys(aclM).sort().map((k) => [k, aclM[k]])) !== JSON.stringify(Object.keys(AC).sort().map((k) => [k, AC[k]]))) probMan.push("ACL del manifiesto ≠ ACL del codigo");
    if (JSON.stringify((man.exentos || []).slice().sort()) !== JSON.stringify(EXENTOS.slice().sort())) probMan.push("exentos del manifiesto ≠ codigo");
  }
  chk("EVOL_MANIFIESTO_CONSISTENTE", probMan.length === 0, probMan.join("; ") || "manifiesto = codigo");

  // canonica
  const canon = leer(RUTAS.sync) ? Buffer.from(ctx.archivos.get(RUTAS.sync)).toString("utf8") : null;
  chk("EVOL_CANONICA_LEIDA", !!canon, "source-sync canonico legible");
  if (!canon) return res;

  // barrido: toda sentencia sobre una canonica fuera de los exentos
  const sinDeclarar = [], vistos = new Map();
  const archivos = [...ctx.archivos.keys()].filter((r) => /\.sql$/i.test(r) && !EXENTOS.includes(r));
  for (const r of archivos) {
    const toques = tocarCanonicas(sinComentarios(leer(r)));
    for (const t of toques) {
      const clave = `${r}|${t.firma}`;
      if (t.tipo === "alter" || t.tipo === "drop") { sinDeclarar.push(`${r}: ${t.tipo.toUpperCase()} FUNCTION ${t.firma} (nunca permitido)`); continue; }
      if (t.tipo === "create") { if (!EV[clave]) sinDeclarar.push(`${r}: redefine ${t.firma} sin declararlo`); else vistos.set(clave, (vistos.get(clave) || 0) + 1); continue; }
      const linea = `${t.tipo}|${t.firma}|${t.roles.join(",")}`;
      if (!AC[r]) sinDeclarar.push(`${r}: ${linea} sin declarar`);
      else (vistos.get(r + "#acl") || vistos.set(r + "#acl", []).get(r + "#acl")).push(linea);
    }
  }
  chk("EVOL_SIN_CAMBIOS_NO_DECLARADOS", sinDeclarar.length === 0, sinDeclarar.join(" | ") || `${archivos.length} archivos .sql fuera de las fuentes exentas revisados`);

  // cada evolucion declarada existe una vez, cabecera igual, cuerpo = canonico + reemplazos exactos, md5 fijado
  const probDef = [];
  for (const [clave, esp] of Object.entries(EV)) {
    const [r, firma] = clave.split("|"); const nombre = firma.slice(0, firma.indexOf("("));
    if ((vistos.get(clave) || 0) !== 1) { probDef.push(`${clave}: ${vistos.get(clave) || 0} definiciones (se exige 1)`); continue; }
    const nueva = definicion(leer(r), nombre), orig = definicion(canon, nombre);
    if (!nueva || !orig) { probDef.push(`${clave}: no se pudo extraer la definicion`); continue; }
    if (nueva.cabecera !== orig.cabecera) probDef.push(`${clave}: la cabecera cambio («${nueva.cabecera}» ≠ «${orig.cabecera}»)`);
    const decl = (man?.evoluciones || []).find((e) => e.archivo === r)?.funciones?.find((f) => f.firma === firma);
    let esperado = orig.cuerpo;
    for (const rep of decl?.reemplazos || []) {
      const n = esperado.split(rep.de).length - 1;
      if (n !== 1) { probDef.push(`${clave}: el reemplazo declarado aparece ${n} veces en la canonica (se exige 1)`); continue; }
      esperado = esperado.replace(rep.de, () => rep.a);
    }
    if (nueva.cuerpo !== esperado) probDef.push(`${clave}: el cuerpo NO es la canonica + los reemplazos declarados (hay otro cambio)`);
    if (md5(nueva.cuerpo) !== esp.md5) probDef.push(`${clave}: md5 del cuerpo ${md5(nueva.cuerpo)} ≠ fijado ${esp.md5}`);
    if ((decl?.reemplazos || []).length !== esp.reemplazos) probDef.push(`${clave}: ${(decl?.reemplazos || []).length} reemplazos declarados ≠ ${esp.reemplazos} fijados`);
  }
  chk("EVOL_CUERPOS_EXACTOS", probDef.length === 0, probDef.join(" | ") || `${Object.keys(EV).length} evoluciones: cabecera canonica, cuerpo = canonica + reemplazos declarados, md5 fijado`);

  // ACL: sentencias exactas y estado final sin PUBLIC/anon
  const probAcl = [];
  for (const [r, lista] of Object.entries(AC)) {
    const reales = vistos.get(r + "#acl") || [];
    if (JSON.stringify(reales) !== JSON.stringify(lista)) probAcl.push(`${r}: ACL ${JSON.stringify(reales)} ≠ declarada ${JSON.stringify(lista)}`);
    const fin = new Map();
    for (const l of reales) { const [tipo, firma, roles] = l.split("|"); for (const rol of roles.split(",")) fin.set(`${firma}|${rol}`, tipo === "grant"); }
    for (const [k, v] of fin) if (v && /\|(public|anon)$/.test(k)) probAcl.push(`${r}: ${k} termina con EXECUTE`);
  }
  chk("EVOL_ACL_EXACTA", probAcl.length === 0, probAcl.join(" | ") || "ACL declarada sentencia por sentencia; PUBLIC y anon cerrados");
  return res;
}

export function cargarContexto(repoRoot = REPO_ROOT) {
  const archivos = new Map();
  const rel = (p) => path.relative(repoRoot, p).split(path.sep).join("/");
  for (const p of descubrirSql(repoRoot)) archivos.set(rel(p), readFileSync(p));
  archivos.set(MANIFIESTO, readFileSync(path.join(repoRoot, MANIFIESTO)));
  return { archivos };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = evaluarEvolucion(cargarContexto());
  for (const r of res) console.log(`${r.ok ? "PASS" : "FAIL"}  [${r.id}]  ${r.detalle}`);
  const mal = res.filter((r) => !r.ok).length;
  console.log(mal ? `\n${mal} FAIL` : "\nTODO PASS\nNO VERIFICA PRODUCCIÓN");
  process.exit(mal ? 1 : 0);
}
