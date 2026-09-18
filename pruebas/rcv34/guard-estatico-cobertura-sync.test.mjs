// RCV-34 Fase B3T - fixtures del coverage gate del source-sync (guard-estatico-cobertura-sync.mjs).
//
// NO VERIFICA PRODUCCION. Cada caso muta una COPIA EN MEMORIA de los archivos reales (nunca escribe ni
// modifica un archivo del repositorio) y exige que el guard falle por la razon correcta. Los mutantes
// del source-sync re-fijan su SHA-256 (en el manifest y en la opcion syncSha256) para demostrar que las
// comprobaciones SEMANTICAS detectan el cambio por si solas, sin depender del pin de SHA.
//
// Uso: node guard-estatico-cobertura-sync.test.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cargarContexto, evaluarCobertura, informe, RUTAS, REPO_ROOT, FUENTES_HISTORICAS } from "./guard-estatico-cobertura-sync.mjs";

const REAL = cargarContexto();
const SYNC = RUTAS.sync;
const MANIFIESTO = RUTAS.manifiesto;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const clonar = () => new Map([...REAL.archivos].map(([k, v]) => [k, Buffer.from(v)]));
const correr = (m, opciones) => evaluarCobertura({ archivos: m }, opciones);

// huellas de los archivos reales ANTES de los casos: al final deben seguir identicas
const HUELLAS_ANTES = new Map([...REAL.archivos].map(([k, v]) => [k, sha(v)]));

// ─────────────────────────────────────────────────────────────────────────── helpers ─────────
const txt = (m, r) => m.get(r).toString("latin1");
const setTxt = (m, r, s) => m.set(r, Buffer.from(s, "latin1"));
function reemplazar(m, r, de, a) {
  const s = txt(m, r);
  if (!s.includes(de)) throw new Error(`fixture invalido: no encuentra "${de.slice(0, 60)}" en ${r}`);
  setTxt(m, r, s.replace(de, () => a));
}
function regex(m, r, re, f) {
  const s = txt(m, r);
  if (!re.test(s)) throw new Error(`fixture invalido: la expresion ${re} no coincide en ${r}`);
  setTxt(m, r, s.replace(re, f));
}
const json = (m, r) => JSON.parse(m.get(r).toString("utf8"));
const setJson = (m, r, o) => m.set(r, Buffer.from(JSON.stringify(o, null, 2) + "\n"));
// re-fija el SHA del source-sync (manifest + opcion) para que SYNC_SHA no sea lo unico que lo detecte
function repinSync(m) {
  const s = sha(m.get(SYNC));
  const man = json(m, MANIFIESTO); man.source_sync.sha256 = s; setJson(m, MANIFIESTO, man);
  return { syncSha256: s };
}
function repinEvidencia(m) {
  const man = json(m, MANIFIESTO);
  if (m.get(RUTAS.pre)) man.canonico.evidencia_pre_b3r.sha256 = sha(m.get(RUTAS.pre));
  if (m.get(RUTAS.post)) man.canonico.evidencia_post_rcv35.sha256 = sha(m.get(RUTAS.post));
  setJson(m, MANIFIESTO, man);
}
function mutarManifiesto(m, fn) { const man = json(m, MANIFIESTO); fn(man); setJson(m, MANIFIESTO, man); }
function mutarBaseline(m, fn) { const b = json(m, RUTAS.baseline); fn(b); setJson(m, RUTAS.baseline, b); }
const RLS = FUENTES_HISTORICAS[0], USU = FUENTES_HISTORICAS[1], ROL = FUENTES_HISTORICAS[2];
const entrada = (arr, archivo, firma) => arr.find(e => e.archivo === archivo && e.firma === firma);

// ─────────────────────────────────────────────────────────────────────────── arnes ───────────
const casos = [];
const caso = (nombre, fn) => casos.push({ nombre, fn });
function fallos(res) { return res.fallos.map(f => f.id); }
function detecta(res, ...ids) {
  const f = fallos(res);
  if (res.ok) throw new Error("el mutante NO fue detectado (todo PASS)");
  for (const id of ids) if (!f.includes(id)) throw new Error(`se esperaba FAIL en ${id}; fallos reales: [${f}]`);
}
function noFalla(res, ...ids) {
  const f = fallos(res);
  for (const id of ids) if (f.includes(id)) throw new Error(`${id} no debia fallar; fallos reales: [${f}]`);
}
function soloFalla(res, ...ids) {
  const f = fallos(res).sort();
  if (JSON.stringify(f) !== JSON.stringify([...ids].sort())) throw new Error(`se esperaba fallar SOLO [${ids}]; fallos reales: [${f}]`);
}

// ═══════════════════════════════════════════════════════════════════ archivos reales ═════════
caso("real: el repositorio real pasa 100% (0 FAIL)", () => {
  const res = correr(clonar());
  if (!res.ok) throw new Error(`fallos reales: [${fallos(res)}]`);
  if (res.resultados.length < 30) throw new Error(`pocos checks: ${res.resultados.length}`);
});
caso("real: resumen 17/17 fingerprints, ACL 17/17-17/17-16/17-17/17, 5 triggers, 6/3/1/1/2, 13 baseline, 2 source-only", () => {
  const s = correr(clonar()).resumen;
  const c = s.clasificacion;
  const ok = s.fingerprints === 17 && s.acl.PUBLIC === 17 && s.acl.anon === 17 && s.acl.authenticated === 16 && s.acl.crear_perfil_authenticated === false &&
    s.acl.service_role === 17 && s.triggers === 5 && s.baseline === 13 && s.source_only_excluidas === 2 &&
    c.ACTIVE_SOURCE_MATCHES_CANONICAL === 6 && c.ACTIVE_SOURCE_DIVERGED_SUPERSEDED_BY_CANONICAL === 3 && c.SUPERSEDED_HISTORICAL === 1 &&
    c.ROLLBACK_ONLY === 1 && c.SOURCE_ONLY_NOT_DEPLOYED === 2 && s.rol_actual_md5 === "e66ee46e01d3df511ee5bd4d0f2a178a";
  if (!ok) throw new Error(JSON.stringify(s));
});
caso("real: el informe imprime NO VERIFICA PRODUCCIÓN al inicio y al final", () => {
  const t = informe(correr(clonar())).split("\n");
  if (!t[1].startsWith("NO VERIFICA PRODUCCIÓN") || t[t.length - 1] !== "NO VERIFICA PRODUCCIÓN") throw new Error("falta el aviso");
});
caso("real: la CLI (proceso hijo) sale con 0, imprime TODO PASS y NO VERIFICA PRODUCCIÓN", () => {
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "guard-estatico-cobertura-sync.mjs")], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.includes("TODO PASS") || !r.stdout.includes("NO VERIFICA PRODUCCIÓN")) throw new Error(`status=${r.status} ${r.stdout.slice(-300)}`);
});

// ═══════════════════════════════════════════════════════════════════════════ baseline ═══════
caso("baseline: 1 caracter del hash de una entrada cambiado", () => {
  const m = clonar();
  mutarBaseline(m, b => { b[0].hash = (b[0].hash[0] === "a" ? "b" : "a") + b[0].hash.slice(1); });
  detecta(correr(m), "BASELINE_HASHES_REV8", "CLASIFICACION_13_13");
});
caso("baseline: entrada FALTANTE (12 en vez de 13)", () => {
  const m = clonar(); mutarBaseline(m, b => { b.pop(); });
  detecta(correr(m), "BASELINE_13", "CLASIFICACION_13_13", "BASELINE_HASHES_REV8");
});
caso("baseline: entrada EXTRA (14 en vez de 13)", () => {
  const m = clonar(); mutarBaseline(m, b => { b.push({ ...b[0], firma: "public.otra_funcion()" }); });
  detecta(correr(m), "BASELINE_13", "CLASIFICACION_13_13");
});
caso("baseline: entrada HUERFANA (archivo inexistente reemplaza a una real)", () => {
  const m = clonar(); mutarBaseline(m, b => { b[0] = { ...b[0], archivo: "taller-demo/supabase/no-existe.sql" }; });
  detecta(correr(m), "BASELINE_13", "CLASIFICACION_13_13");
});
caso("baseline: incluye el source-sync (nunca debe baselinearse)", () => {
  const m = clonar(); mutarBaseline(m, b => { b[0] = { ...b[0], archivo: SYNC }; });
  detecta(correr(m), "BASELINE_13", "CLASIFICACION_13_13");
});
caso("baseline: campo extra categoria_actual (formato del volcado sin limpiar)", () => {
  const m = clonar(); mutarBaseline(m, b => { b[0].categoria_actual = "nueva_insegura"; });
  detecta(correr(m), "BASELINE_13");
});
caso("baseline: entrada duplicada (archivo+firma)", () => {
  const m = clonar(); mutarBaseline(m, b => { b[1] = { ...b[0] }; });
  detecta(correr(m), "BASELINE_13");
});
caso("baseline: no es un array JSON", () => {
  const m = clonar(); m.set(RUTAS.baseline, Buffer.from("{}"));
  detecta(correr(m), "BASELINE_13", "CLASIFICACION_13_13");
});

// ═════════════════════════════════════════════════════════════════════════ clasificacion ═════
caso("clasificacion: una entrada MATCH pasa a DIVERGED (conteos y cuerpo real)", () => {
  const m = clonar();
  mutarManifiesto(m, man => { entrada(man.clasificacion, RLS, "public.ve_todo_el_taller()").clasificacion = "ACTIVE_SOURCE_DIVERGED_SUPERSEDED_BY_CANONICAL"; });
  detecta(correr(m), "CLASIFICACION_CONTEOS", "CLASIFICACION_CONTRA_FUENTES");
});
caso("clasificacion: entrada del baseline SIN clasificar (12/13)", () => {
  const m = clonar(); mutarManifiesto(m, man => { man.clasificacion.pop(); });
  detecta(correr(m), "CLASIFICACION_13_13", "CLASIFICACION_CONTEOS");
});
caso("clasificacion: entrada extra sin baseline (14)", () => {
  const m = clonar(); mutarManifiesto(m, man => { man.clasificacion.push({ ...man.clasificacion[0], firma: "public.otra()" }); });
  detecta(correr(m), "CLASIFICACION_13_13");
});
caso("clasificacion: clase inventada", () => {
  const m = clonar(); mutarManifiesto(m, man => { man.clasificacion[0].clasificacion = "MAGIC_CLASS"; });
  detecta(correr(m), "CLASIFICACION_CONTEOS");
});
caso("clasificacion: ROLLBACK_ONLY asignado a la definicion de usuarios (no es el archivo de rollback)", () => {
  const m = clonar();
  mutarManifiesto(m, man => { entrada(man.clasificacion, USU, "public.estadisticas_tecnicas()").clasificacion = "ROLLBACK_ONLY"; });
  detecta(correr(m), "CLASIFICACION_CONTEOS", "CLASIFICACION_CONTRA_FUENTES");
});
caso("clasificacion: ROLLBACK_ONLY pasa a SUPERSEDED_HISTORICAL", () => {
  const m = clonar();
  mutarManifiesto(m, man => { entrada(man.clasificacion, ROL, "public.estadisticas_tecnicas()").clasificacion = "SUPERSEDED_HISTORICAL"; });
  detecta(correr(m), "CLASIFICACION_CONTEOS");
});
caso("clasificacion: una SOURCE_ONLY se reclasifica como DIVERGED (existiria en produccion)", () => {
  const m = clonar();
  mutarManifiesto(m, man => { entrada(man.clasificacion, USU, "public.proteger_admin_unico()").clasificacion = "ACTIVE_SOURCE_DIVERGED_SUPERSEDED_BY_CANONICAL"; });
  detecta(correr(m), "CLASIFICACION_CONTEOS", "CLASIFICACION_CONTRA_FUENTES");
});
caso("clasificacion: md5 del cuerpo historico alterado en el manifest", () => {
  const m = clonar();
  mutarManifiesto(m, man => { entrada(man.clasificacion, RLS, "public.mi_moto(uuid)").md5_cuerpo_fuente = "0".repeat(32); });
  detecta(correr(m), "CLASIFICACION_CONTRA_FUENTES");
});
caso("fuente historica: 1 byte cambiado en un cuerpo de fase4d-rls (baseline y clasificacion lo detectan)", () => {
  const m = clonar(); const s = txt(m, RLS);
  const i = s.indexOf("function public.ve_todo_el_taller"); const j = s.indexOf("'cajero'", i);
  if (i < 0 || j < 0) throw new Error("fixture invalido");
  setTxt(m, RLS, s.slice(0, j) + "'cajerO'" + s.slice(j + "'cajero'".length));
  detecta(correr(m), "BASELINE_HASHES_REV8", "CLASIFICACION_CONTRA_FUENTES");
});

// ═════════════════════════════════════════════════════════════════════════ source-sync ═══════
caso("sync: 1 byte cambiado en el cuerpo de es_admin, SHA re-fijado (la huella semantica lo detecta)", () => {
  const m = clonar(); reemplazar(m, SYNC, "SELECT public.rol_actual() = 'admin';", "SELECT public.rol_actual() = 'admiN';");
  const o = repinSync(m); const r = correr(m, o);
  detecta(r, "SYNC_FINGERPRINTS"); noFalla(r, "SYNC_SHA", "MANIFIESTO_CONSISTENTE");
});
caso("sync: CRLF→LF en todo el archivo, SHA re-fijado (6 cuerpos cambian de huella)", () => {
  const m = clonar(); setTxt(m, SYNC, txt(m, SYNC).replace(/\r\n/g, "\n"));
  const o = repinSync(m); const r = correr(m, o);
  detecta(r, "SYNC_FINGERPRINTS"); noFalla(r, "SYNC_SHA");
  if (!/es_admin/.test(r.fallos.find(f => f.id === "SYNC_FINGERPRINTS").detalle)) throw new Error("no menciona es_admin");
});
caso("sync: 1 byte cambiado en un comentario SIN re-fijar el SHA (solo el pin lo detecta)", () => {
  const m = clonar(); reemplazar(m, SYNC, "PREPARADO / NO EJECUTADO", "PREPARADO / NO EJECUTADX");
  soloFalla(correr(m), "SYNC_SHA");
});
caso("sync: se quita AND p.activo de rol_actual, SHA re-fijado (filtro + md5 POST + huella)", () => {
  const m = clonar(); reemplazar(m, SYNC, "        AND p.activo\n", "");
  const o = repinSync(m); const r = correr(m, o);
  detecta(r, "ROL_ACTUAL_FILTRO", "ROL_ACTUAL_POST", "SYNC_FINGERPRINTS"); noFalla(r, "SYNC_SHA");
});
caso("sync: la constante md5 de la postcondicion ya no es la POST-RCV35, SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "c_md5_rol_actual constant text := 'e66ee46e01d3df51", "c_md5_rol_actual constant text := 'e66ee46e01d3df50");
  const o = repinSync(m); detecta(correr(m, o), "ROL_ACTUAL_POST");
});
caso("sync: el md5 PRE inseguro 527f940b... aparece como valor, SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "-- NO EJECUTAR SIN AUTORIZACION", "-- 527f940b66f3c7b88b746dc3a676bdb9\n-- NO EJECUTAR SIN AUTORIZACION");
  const o = repinSync(m); detecta(correr(m, o), "ROL_ACTUAL_NO_PRE");
});
caso("sync: el cuerpo embebido de rol_actual reproduciria el PRE (md5 PRE simulado)", () => {
  const m = clonar();
  const s = txt(m, SYNC); const i = s.indexOf("CREATE OR REPLACE FUNCTION public.rol_actual()"); const a = s.indexOf("$function$", i) + 10; const b = s.indexOf("$function$", a);
  const md5Post = createHash("md5").update(Buffer.from(s.slice(a, b), "latin1")).digest("hex");
  detecta(correr(m, { rolPre: md5Post }), "ROL_ACTUAL_NO_PRE");
});
caso("sync: falta una funcion (se elimina la definicion de mi_moto), SHA re-fijado", () => {
  const m = clonar(); regex(m, SYNC, /CREATE OR REPLACE FUNCTION public\.mi_moto\([^)]*\)[\s\S]*?\$function\$;\n/, "");
  const o = repinSync(m); detecta(correr(m, o), "SYNC_DEFS_17", "SYNC_FIRMAS_EXACTAS", "SYNC_FINGERPRINTS");
});
caso("sync: funcion EXTRA (public.extra()), SHA re-fijado", () => {
  const m = clonar();
  reemplazar(m, SYNC, "-- ACL EXPLICITO", "CREATE OR REPLACE FUNCTION public.extra()\n RETURNS integer\n LANGUAGE sql\nAS $function$ select 1 $function$;\n\n-- ACL EXPLICITO");
  const o = repinSync(m); detecta(correr(m, o), "SYNC_DEFS_17", "SYNC_FIRMAS_EXACTAS");
});
caso("sync: firma DUPLICADA (es_admin definida dos veces), SHA re-fijado", () => {
  const m = clonar(); const s = txt(m, SYNC);
  const def = /CREATE OR REPLACE FUNCTION public\.es_admin\(\)[\s\S]*?\$function\$;\n/.exec(s)[0];
  reemplazar(m, SYNC, "-- ACL EXPLICITO", def + "\n-- ACL EXPLICITO");
  const o = repinSync(m); detecta(correr(m, o), "SYNC_FIRMAS_DISTINTAS", "SYNC_DEFS_17");
});
caso("sync: aparece una funcion SOURCE_ONLY (proteger_admin_unico), SHA re-fijado", () => {
  const m = clonar();
  reemplazar(m, SYNC, "-- ACL EXPLICITO", "CREATE OR REPLACE FUNCTION public.proteger_admin_unico()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ begin return new; end $function$;\n\n-- ACL EXPLICITO");
  const o = repinSync(m); detecta(correr(m, o), "SOURCE_ONLY_EXCLUIDAS", "SYNC_DEFS_17");
});

// ═════════════════════════════════════════════════════════════════════════════════ ACL ══════
caso("ACL: es_admin sin REVOKE de anon (anon abierto), SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "REVOKE EXECUTE ON FUNCTION public.es_admin() FROM PUBLIC, anon;", "REVOKE EXECUTE ON FUNCTION public.es_admin() FROM PUBLIC;");
  const o = repinSync(m); const r = correr(m, o); detecta(r, "ACL_ANON", "REV8_SYNC_SEGURO"); noFalla(r, "ACL_PUBLIC");
});
caso("ACL: es_admin sin REVOKE de PUBLIC, SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "REVOKE EXECUTE ON FUNCTION public.es_admin() FROM PUBLIC, anon;", "REVOKE EXECUTE ON FUNCTION public.es_admin() FROM anon;");
  const o = repinSync(m); const r = correr(m, o); detecta(r, "ACL_PUBLIC", "REV8_SYNC_SEGURO"); noFalla(r, "ACL_ANON");
});
caso("ACL: GRANT EXECUTE a anon anadido tras el cierre, SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "GRANT EXECUTE ON FUNCTION public.mi_moto(uuid) TO authenticated, service_role;", "GRANT EXECUTE ON FUNCTION public.mi_moto(uuid) TO authenticated, service_role, anon;");
  const o = repinSync(m); detecta(correr(m, o), "ACL_ANON", "ACL_SIN_EXTRAS", "REV8_SYNC_SEGURO");
});
caso("ACL: mi_moto pierde authenticated (15/17), SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "GRANT EXECUTE ON FUNCTION public.mi_moto(uuid) TO authenticated, service_role;", "GRANT EXECUTE ON FUNCTION public.mi_moto(uuid) TO service_role;");
  const o = repinSync(m); detecta(correr(m, o), "ACL_AUTHENTICATED");
});
caso("ACL: crear_perfil_al_registrarse conserva authenticated, SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "GRANT EXECUTE ON FUNCTION public.crear_perfil_al_registrarse() TO service_role;", "GRANT EXECUTE ON FUNCTION public.crear_perfil_al_registrarse() TO authenticated, service_role;");
  const o = repinSync(m); detecta(correr(m, o), "ACL_CREAR_PERFIL", "ACL_AUTHENTICATED");
});
caso("ACL: puede_cobrar pierde service_role, SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "GRANT EXECUTE ON FUNCTION public.puede_cobrar() TO authenticated, service_role;", "GRANT EXECUTE ON FUNCTION public.puede_cobrar() TO authenticated;");
  const o = repinSync(m); detecta(correr(m, o), "ACL_SERVICE_ROLE");
});
caso("ACL: GRANT a un rol ajeno (dashboard_user), SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "GRANT EXECUTE ON FUNCTION public.mi_moto(uuid) TO authenticated, service_role;", "GRANT EXECUTE ON FUNCTION public.mi_moto(uuid) TO authenticated, service_role, dashboard_user;");
  const o = repinSync(m); detecta(correr(m, o), "ACL_SIN_EXTRAS");
});

// ═══════════════════════════════════════════════════════════════════════════ triggers ═══════
caso("triggers: citas_mecanico_avance con evento distinto en $trg$ (BEFORE DELETE = 11), SHA re-fijado", () => {
  const m = clonar();
  regex(m, SYNC, /('citas_mecanico_avance',\s+'mecanico_solo_avance_tecnico\(\)',\s+)19(,\s+')BEFORE UPDATE'/, (_, a, b) => `${a}11${b}BEFORE DELETE'`);
  const o = repinSync(m); detecta(correr(m, o), "TRIGGERS_5");
});
caso("triggers: falta un trigger en la tabla de $post$ (4 en vez de 5), SHA re-fijado", () => {
  const m = clonar(); const s = txt(m, SYNC); const i = s.indexOf("DO $post$");
  const cola = s.slice(i).replace(/\s*\('public\.ordenes',\s+'ordenes_mecanico_avance',[^\n]*\n/, "\n");
  if (cola === s.slice(i)) throw new Error("fixture invalido");
  setTxt(m, SYNC, s.slice(0, i) + cola);
  const o = repinSync(m); detecta(correr(m, o), "TRIGGERS_5");
});
caso("triggers: proteger_rol_perfil_trigger ejecuta otra funcion en $trg$, SHA re-fijado", () => {
  const m = clonar();
  regex(m, SYNC, /('proteger_rol_perfil_trigger',\s+)'proteger_rol_perfil\(\)'(,\s+19,\s+'BEFORE UPDATE')/, (_, a, b) => `${a}'proteger_caja_ligada()'${b}`);
  const o = repinSync(m); detecta(correr(m, o), "TRIGGERS_5");
});
caso("triggers: al_crear_usuario pasa a BEFORE INSERT (tgtype 7) en $trg$, SHA re-fijado", () => {
  const m = clonar();
  regex(m, SYNC, /('al_crear_usuario',\s+'crear_perfil_al_registrarse\(\)',\s+)5(,\s+')AFTER INSERT'/, (_, a, b) => `${a}7${b}BEFORE INSERT'`);
  const o = repinSync(m); detecta(correr(m, o), "TRIGGERS_5");
});
caso("DDL: DROP TRIGGER a nivel superior, SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "-- TRIGGERS (5)", "DROP TRIGGER IF EXISTS x ON public.perfiles;\n-- TRIGGERS (5)");
  const o = repinSync(m); detecta(correr(m, o), "SYNC_SIN_DROP_TRIGGER");
});
caso("DDL: DROP TRIGGER escondido dentro de un bloque DO, SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "  v_validados int := 0;\nBEGIN\n", "  v_validados int := 0;\nBEGIN\n  EXECUTE 'DROP TRIGGER IF EXISTS x ON public.perfiles';\n");
  const o = repinSync(m); detecta(correr(m, o), "SYNC_SIN_DROP_TRIGGER");
});
caso("DDL: ALTER DEFAULT PRIVILEGES anadido, SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "-- TRIGGERS (5)", "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;\n-- TRIGGERS (5)");
  const o = repinSync(m); detecta(correr(m, o), "SYNC_SIN_ALTER_DEFAULT_PRIVILEGES");
});
caso("DDL: GRANT ALL anadido, SHA re-fijado", () => {
  const m = clonar(); reemplazar(m, SYNC, "-- TRIGGERS (5)", "GRANT ALL ON FUNCTION public.es_admin() TO authenticated;\n-- TRIGGERS (5)");
  const o = repinSync(m); detecta(correr(m, o), "SYNC_SIN_DDL_PROHIBIDO");
});
caso("DDL: el archivo ya no termina en COMMIT;, SHA re-fijado", () => {
  const m = clonar(); const s = txt(m, SYNC); const i = s.lastIndexOf("COMMIT;");
  setTxt(m, SYNC, s.slice(0, i) + s.slice(i + "COMMIT;".length));
  const o = repinSync(m); detecta(correr(m, o), "SYNC_TRANSACCION");
});

// ═════════════════════════════════════════════════════════════════════════ .gitattributes ═══
const GA = ".gitattributes";
caso("gitattributes: archivo ausente", () => { const m = clonar(); m.delete(GA); detecta(correr(m), "GITATTRIBUTES_TEXT_UNSET"); });
caso("gitattributes: la regla dice text (sin el guion)", () => {
  const m = clonar(); m.set(GA, Buffer.from(`${RUTAS.sync} text\n`)); detecta(correr(m), "GITATTRIBUTES_TEXT_UNSET");
});
caso("gitattributes: una regla posterior * text=auto anula el -text", () => {
  const m = clonar(); m.set(GA, Buffer.from(`${RUTAS.sync} -text\n* text=auto\n`)); detecta(correr(m), "GITATTRIBUTES_TEXT_UNSET");
});
caso("gitattributes: la regla -text esta comentada", () => {
  const m = clonar(); m.set(GA, Buffer.from(`# ${RUTAS.sync} -text\n`)); detecta(correr(m), "GITATTRIBUTES_TEXT_UNSET");
});
caso("gitattributes: regla para otra ruta (no cubre el source-sync)", () => {
  const m = clonar(); m.set(GA, Buffer.from("taller-demo/supabase/otro.sql -text\n")); detecta(correr(m), "GITATTRIBUTES_TEXT_UNSET");
});

// ═════════════════════════════════════════════════════════════════════════════ evidencia ═════
caso("evidencia PRE (B3R): el md5 de rol_actual ya no es el PRE 527f940b, SHA re-fijado", () => {
  const m = clonar(); const p = json(m, RUTAS.pre); p.funciones.find(f => f.firma === "rol_actual()").md5_prosrc = "0".repeat(32);
  setJson(m, RUTAS.pre, p); repinEvidencia(m); detecta(correr(m), "EVIDENCIA_PRE_B3R", "EVIDENCIA_PRE_POST_COEXISTEN");
});
caso("evidencia PRE y POST no coexisten: el PRE trae el mismo md5 que el POST, SHA re-fijado", () => {
  const m = clonar(); const p = json(m, RUTAS.pre); p.funciones.find(f => f.firma === "rol_actual()").md5_prosrc = "e66ee46e01d3df511ee5bd4d0f2a178a";
  setJson(m, RUTAS.pre, p); repinEvidencia(m); detecta(correr(m), "EVIDENCIA_PRE_POST_COEXISTEN");
});
caso("evidencia PRE: contenido alterado SIN re-fijar el SHA", () => {
  const m = clonar(); const p = json(m, RUTAS.pre); p.formato = "otro"; setJson(m, RUTAS.pre, p); detecta(correr(m), "EVIDENCIA_PRE_B3R");
});
caso("evidencia PRE ausente", () => { const m = clonar(); m.delete(RUTAS.pre); detecta(correr(m), "EVIDENCIA_PRE_B3R", "SYNC_FIRMAS_EXACTAS"); });
caso("evidencia POST: cumple_estado_post_fix=false, SHA re-fijado", () => {
  const m = clonar(); const p = json(m, RUTAS.post); p.cumple_estado_post_fix = false; setJson(m, RUTAS.post, p); repinEvidencia(m);
  detecta(correr(m), "EVIDENCIA_POST_RCV35");
});
caso("evidencia POST: md5 distinto de e66ee46e, SHA re-fijado", () => {
  const m = clonar(); const p = json(m, RUTAS.post); p.md5_prosrc = "0".repeat(32); setJson(m, RUTAS.post, p); repinEvidencia(m);
  detecta(correr(m), "EVIDENCIA_POST_RCV35", "ROL_ACTUAL_POST", "EVIDENCIA_PRE_POST_COEXISTEN");
});
caso("evidencia POST: anon con EXECUTE, SHA re-fijado", () => {
  const m = clonar(); const p = json(m, RUTAS.post); p.acl_efectiva.anon_execute = true; setJson(m, RUTAS.post, p); repinEvidencia(m);
  detecta(correr(m), "EVIDENCIA_POST_RCV35");
});
caso("evidencia POST: lleva un campo prosrc_b64 (no deben guardarse cuerpos), SHA re-fijado", () => {
  const m = clonar(); const p = json(m, RUTAS.post); p.prosrc_b64 = "QQ=="; setJson(m, RUTAS.post, p); repinEvidencia(m);
  detecta(correr(m), "EVIDENCIA_POST_RCV35");
});
caso("evidencia POST ausente", () => { const m = clonar(); m.delete(RUTAS.post); detecta(correr(m), "EVIDENCIA_POST_RCV35", "EVIDENCIA_PRE_POST_COEXISTEN", "ROL_ACTUAL_POST"); });
caso("source-only: el manifest de produccion (B3R) incluye proteger_borrado_admin, SHA re-fijado", () => {
  const m = clonar(); const p = json(m, RUTAS.pre); p.funciones.push({ firma: "proteger_borrado_admin()", md5_prosrc: "1".repeat(32), bytes: 1, caracteres: 1, cr: 0, lf: 0 });
  setJson(m, RUTAS.pre, p); repinEvidencia(m); detecta(correr(m), "SOURCE_ONLY_EXCLUIDAS", "SYNC_FIRMAS_EXACTAS");
});

// ═════════════════════════════════════════════════════════════════ manifest y protegidos ═════
caso("manifiesto: conteos_esperados alterados", () => {
  const m = clonar(); mutarManifiesto(m, man => { man.conteos_esperados.ROLLBACK_ONLY = 2; }); detecta(correr(m), "MANIFIESTO_CONSISTENTE");
});
caso("manifiesto: el md5 POST de rol_actual ya no es e66ee46e", () => {
  const m = clonar(); mutarManifiesto(m, man => { man.canonico.rol_actual_post_rcv35_md5 = "527f940b66f3c7b88b746dc3a676bdb9"; }); detecta(correr(m), "MANIFIESTO_CONSISTENTE");
});
caso("manifiesto: SHA del source-sync distinto del fijado en el guard", () => {
  const m = clonar(); mutarManifiesto(m, man => { man.source_sync.sha256 = "0".repeat(64); }); detecta(correr(m), "MANIFIESTO_CONSISTENTE");
});
caso("manifiesto ausente", () => { const m = clonar(); m.delete(MANIFIESTO); detecta(correr(m), "MANIFIESTO_CONSISTENTE", "CLASIFICACION_13_13", "PROTEGIDOS_SHA"); });
caso("protegidos: el guard REV8 cambia 1 byte", () => {
  const m = clonar(); const r = "pruebas/rcv34/guard-estatico-funciones.mjs"; m.set(r, Buffer.concat([m.get(r), Buffer.from(" ")])); detecta(correr(m), "PROTEGIDOS_SHA");
});
caso("protegidos: RCV35 01 cambia 1 byte", () => {
  const m = clonar(); const r = "pruebas/rcv35/01-fix-rol-actual-activo.sql"; m.set(r, Buffer.concat([m.get(r), Buffer.from(" ")])); detecta(correr(m), "PROTEGIDOS_SHA");
});
caso("protegidos: el manifiesto deja de fijar el rollback 02", () => {
  const m = clonar(); mutarManifiesto(m, man => { man.protegidos = man.protegidos.filter(p => !p.archivo.includes("02-rollback")); }); detecta(correr(m), "PROTEGIDOS_SHA");
});
caso("protegidos: falta el archivo protegido 04", () => { const m = clonar(); m.delete("pruebas/rcv34/04-guard-funciones-public.sql"); detecta(correr(m), "PROTEGIDOS_SHA"); });

// ══════════════════════════════════════════════════════════════════════ integridad del propio test ═
caso("los fixtures NO modificaron ningun archivo real (SHA-256 de disco = SHA-256 de antes)", () => {
  for (const [rel, antes] of HUELLAS_ANTES) {
    const ahora = sha(readFileSync(path.join(REPO_ROOT, rel)));
    if (ahora !== antes) throw new Error(`${rel} cambio durante los fixtures`);
  }
  if (correr(clonar()).ok !== true) throw new Error("el repositorio real ya no pasa");
});

// ─────────────────────────────────────────────────────────────────────────── ejecucion ───────
let pass = 0;
casos.forEach((c, i) => {
  try { c.fn(); pass++; console.log(`PASS  ${String(i + 1).padStart(2)} ${c.nombre}`); }
  catch (e) { console.log(`FAIL  ${String(i + 1).padStart(2)} ${c.nombre}\n        -> ${e.message}`); }
});
console.log(`\n${pass}/${casos.length} PASS`);
console.log("NO VERIFICA PRODUCCIÓN");
process.exit(pass === casos.length ? 0 : 1);
