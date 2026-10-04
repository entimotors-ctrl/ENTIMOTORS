// 3.15.0 · Bloque 5 · fixtures del guard de EVOLUCION de funciones canonicas (guard-evolucion-canonicas.mjs).
// NO VERIFICA PRODUCCION. Cada caso muta una COPIA EN MEMORIA de los archivos reales y exige que el guard falle por la razon
// correcta (y que el repositorio real siga pasando). Ningun archivo del repositorio se escribe.
// Uso: node guard-evolucion-canonicas.test.mjs
import { createHash } from "node:crypto";
import { cargarContexto, evaluarEvolucion, MANIFIESTO } from "./guard-evolucion-canonicas.mjs";

const REAL = cargarContexto();
const E15 = "taller-demo/supabase/sync/sync-15e-finanzas.sql";
const R15 = "taller-demo/supabase/sync/sync-15e-rollback.sql";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const HUELLAS = new Map([...REAL.archivos].map(([k, v]) => [k, sha(v)]));
const clonar = () => new Map([...REAL.archivos].map(([k, v]) => [k, Buffer.from(v)]));
const txt = (m, r) => m.get(r).toString("utf8");
const set = (m, r, s) => m.set(r, Buffer.from(s, "utf8"));
function reemplazar(m, r, de, a) { const s = txt(m, r); if (!s.includes(de)) throw new Error(`fixture invalido: «${de.slice(0, 60)}» no está en ${r}`); set(m, r, s.replace(de, () => a)); }
const nueva = (m, r, s) => set(m, r, s);

let pass = 0, fail = 0;
function caso(nombre, f) {
  try { f(); pass++; console.log(`PASS  ${nombre}`); } catch (e) { fail++; console.log(`FAIL  ${nombre}\n      ${e.message}`); }
}
function detecta(m, ...ids) {
  const r = evaluarEvolucion({ archivos: m });
  const malos = r.filter((x) => !x.ok).map((x) => x.id);
  for (const id of ids) if (!malos.includes(id)) throw new Error(`se esperaba FAIL en ${id}; fallaron: [${malos.join(", ")}]`);
}

caso("repo real: TODO PASS", () => { const r = evaluarEvolucion(REAL); const m = r.filter((x) => !x.ok); if (m.length) throw new Error(m.map((x) => x.id + ": " + x.detalle).join(" | ")); });

caso("M1 una migración nueva redefine puede_cobrar() SIN declararlo (aunque cierre bien su ACL) → FAIL", () => {
  const m = clonar();
  nueva(m, "taller-demo/supabase/sync/sync-15f-x.sql", `BEGIN;
CREATE OR REPLACE FUNCTION public.puede_cobrar()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT true $function$;
REVOKE EXECUTE ON FUNCTION public.puede_cobrar() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.puede_cobrar() TO authenticated, service_role;
COMMIT;`);
  detecta(m, "EVOL_SIN_CAMBIOS_NO_DECLARADOS");
});
caso("M2 15e cambia ALGO MÁS del cuerpo (quita el control de rol) → FAIL", () => {
  const m = clonar();
  reemplazar(m, E15, "  if not (public.es_admin() or public.es_desarrollador()) then\n    raise exception 'Solo el administrador y el desarrollador pueden consultar las estad",
                     "  if false then\n    raise exception 'Solo el administrador y el desarrollador pueden consultar las estad");
  detecta(m, "EVOL_CUERPOS_EXACTOS");
});
caso("M3 15e cambia la cabecera a SECURITY INVOKER → FAIL", () => {
  const m = clonar();
  const s = txt(m, E15); const i = s.indexOf("CREATE OR REPLACE FUNCTION public.estadisticas_tecnicas()");
  set(m, E15, s.slice(0, i) + s.slice(i).replace(" STABLE SECURITY DEFINER", " STABLE SECURITY INVOKER"));
  detecta(m, "EVOL_CUERPOS_EXACTOS");
});
caso("M4 15e cambia el search_path de la canónica → FAIL", () => {
  const m = clonar();
  const s = txt(m, E15); const i = s.indexOf("CREATE OR REPLACE FUNCTION public.estadisticas_tecnicas()");
  set(m, E15, s.slice(0, i) + s.slice(i).replace(" SET search_path TO 'public'", " SET search_path TO 'public', 'pg_temp'"));
  detecta(m, "EVOL_CUERPOS_EXACTOS");
});
caso("M5 15e abre estadisticas_tecnicas a anon → FAIL", () => {
  const m = clonar();
  reemplazar(m, E15, "GRANT EXECUTE ON FUNCTION public.estadisticas_tecnicas() TO authenticated, service_role;",
                     "GRANT EXECUTE ON FUNCTION public.estadisticas_tecnicas() TO authenticated, service_role, anon;");
  detecta(m, "EVOL_ACL_EXACTA");
});
caso("M6 otra migración vuelve a dar registrar_venta (v1, sin op_id) a authenticated sin declararlo → FAIL", () => {
  const m = clonar();
  nueva(m, "taller-demo/supabase/sync/sync-15f-y.sql", "GRANT EXECUTE ON FUNCTION public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) TO authenticated;");
  detecta(m, "EVOL_SIN_CAMBIOS_NO_DECLARADOS");
});
caso("M7 ALTER FUNCTION public.rol_actual() SECURITY INVOKER en una migración → FAIL (nunca permitido)", () => {
  const m = clonar();
  nueva(m, "taller-demo/supabase/sync/sync-15f-z.sql", "ALTER FUNCTION public.rol_actual() SECURITY INVOKER;");
  detecta(m, "EVOL_SIN_CAMBIOS_NO_DECLARADOS");
});
caso("M8 DROP FUNCTION IF EXISTS es_admin() (sin esquema) → FAIL", () => {
  const m = clonar();
  nueva(m, "pruebas/sync/sql/zz.sql", "DROP FUNCTION IF EXISTS es_admin();");
  detecta(m, "EVOL_SIN_CAMBIOS_NO_DECLARADOS");
});
caso("M9 nombre entre comillas \"public\".\"mi_moto\"(uuid) también se detecta → FAIL", () => {
  const m = clonar();
  nueva(m, "taller-demo/supabase/sync/sync-15f-w.sql", `CREATE FUNCTION "public"."mi_moto"(p uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`);
  detecta(m, "EVOL_SIN_CAMBIOS_NO_DECLARADOS");
});
caso("M10 el rollback deja de ser la canónica exacta → FAIL", () => {
  const m = clonar();
  reemplazar(m, R15, "'auditoria',         (select count(*) from public.auditoria)", "'auditoria',         (select count(*) + 0 from public.auditoria)");
  detecta(m, "EVOL_CUERPOS_EXACTOS");
});
caso("M11 relajar SOLO el manifiesto (otro md5) sin tocar el código → FAIL", () => {
  const m = clonar();
  const j = JSON.parse(txt(m, MANIFIESTO)); j.evoluciones[0].funciones[0].md5_nuevo = "0".repeat(32); set(m, MANIFIESTO, JSON.stringify(j));
  detecta(m, "EVOL_MANIFIESTO_CONSISTENTE");
});
caso("M12 declarar un reemplazo más amplio en el manifiesto (sin tocar el código) → FAIL", () => {
  const m = clonar();
  const j = JSON.parse(txt(m, MANIFIESTO)); j.evoluciones[0].funciones[0].reemplazos.push({ de: "x", a: "y" }); set(m, MANIFIESTO, JSON.stringify(j));
  detecta(m, "EVOL_MANIFIESTO_CONSISTENTE");
});
caso("M13 15e define estadisticas_tecnicas DOS veces en el mismo archivo → FAIL", () => {
  const m = clonar();
  const s = txt(m, E15); const i = s.indexOf("CREATE OR REPLACE FUNCTION public.estadisticas_tecnicas()"); const f = s.indexOf("end $function$;", i) + 15;
  set(m, E15, s + "\n" + s.slice(i, f) + "\n");
  detecta(m, "EVOL_CUERPOS_EXACTOS");
});
caso("M14 una redefinición escondida en SQL dinámico (EXECUTE '...CREATE FUNCTION public.es_admin()...') → FAIL", () => {
  const m = clonar();
  nueva(m, "taller-demo/supabase/sync/sync-15f-v.sql", "DO $d$ BEGIN EXECUTE $q$CREATE OR REPLACE FUNCTION public.es_admin() RETURNS boolean LANGUAGE sql AS 'select true'$q$; END $d$;");
  detecta(m, "EVOL_SIN_CAMBIOS_NO_DECLARADOS");
});
caso("N1 un COMENTARIO que menciona CREATE FUNCTION public.es_admin() no es un cambio (sin falso positivo)", () => {
  const m = clonar();
  nueva(m, "taller-demo/supabase/sync/sync-15f-u.sql", "-- antes: CREATE OR REPLACE FUNCTION public.es_admin() ...\n/* GRANT EXECUTE ON FUNCTION public.es_admin() TO anon; */\nSELECT 1;");
  const r = evaluarEvolucion({ archivos: m }).filter((x) => !x.ok);
  if (r.length) throw new Error("falso positivo: " + r.map((x) => x.id).join(","));
});
caso("N2 LLAMAR a una canónica (public.es_admin() dentro de otra función) no es redefinirla", () => {
  const m = clonar();
  nueva(m, "taller-demo/supabase/sync/sync-15f-t.sql", "CREATE OR REPLACE FUNCTION public.otra() RETURNS boolean LANGUAGE sql AS $$ SELECT public.es_admin() $$;");
  const r = evaluarEvolucion({ archivos: m }).filter((x) => !x.ok);
  if (r.length) throw new Error("falso positivo: " + r.map((x) => x.id).join(","));
});

const cambiados = [...REAL.archivos].filter(([k, v]) => HUELLAS.get(k) !== sha(v)).map(([k]) => k);
caso("los archivos reales siguen idénticos tras los mutantes", () => { if (cambiados.length) throw new Error(cambiados.join(", ")); });
console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
