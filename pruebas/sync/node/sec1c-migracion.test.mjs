// SECURITY-1C · comprobaciones ESTÁTICAS de la migración y su rollback (sin Docker). El comportamiento real lo prueba
// `pruebas/sync/correr-sql.sh sec1c` contra PostgreSQL local (límites, concurrencia, RLS, rollback, re-aplicación).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RAIZ } from "./helpers/compilar.mjs";

const DIR = path.join(RAIZ, "taller-demo/supabase/sync");
const F = fs.readFileSync(path.join(DIR, "sec-1c-clave-intentos.sql"), "utf8");
const R = fs.readFileSync(path.join(DIR, "sec-1c-rollback.sql"), "utf8");
const codigo = (s) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");   // sin comentarios

test("forward: una sola transacción, con precondiciones, timeouts y postcondiciones; nunca ejecutado en producción", () => {
  assert.match(F, /^-- .*SECURITY-1C/m); assert.match(F, /NO EJECUTADO EN PRODUCCIÓN/);
  assert.match(codigo(F), /^BEGIN;/m); assert.match(codigo(F), /^COMMIT;\s*$/m);
  assert.match(F, /SET LOCAL lock_timeout/); assert.match(F, /SET LOCAL statement_timeout/);
  assert.match(F, /SECURITY-1C STOP/); assert.match(F, /POSTCONDICIONES/);
});
test("sin secretos: la tabla y las funciones no tienen ni reciben contraseña, hash, token, PIN, correo ni IP", () => {
  const tabla = /CREATE TABLE IF NOT EXISTS public\.admin_clave_intentos \(([\s\S]*?)\n\);/.exec(F)[1];
  const cols = [...tabla.matchAll(/^\s{2}(\w+)\s/gm)].map((m) => m[1]).filter((c) => c !== "CONSTRAINT");
  assert.deepEqual(cols, ["id", "perfil_id", "resultado", "intento_id", "creado_en"]);
  for (const firma of F.matchAll(/FUNCTION public\.clave_\w+\(([^)]*)\)\s*\n\s*RETURNS/g)) assert.doesNotMatch(firma[1], /clave|pass|hash|token|pin|correo|mail|\bip\b/i, firma[1]);
});
test("cerrada al cliente: RLS, REVOKE a anon/authenticated, EXECUTE solo service_role; ningún GRANT a anon/authenticated", () => {
  const c = codigo(F);
  assert.match(c, /ALTER TABLE public\.admin_clave_intentos ENABLE ROW LEVEL SECURITY;/);
  assert.match(c, /REVOKE ALL ON TABLE public\.admin_clave_intentos FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(c, /GRANT SELECT ON TABLE public\.admin_clave_intentos TO service_role;/);
  assert.equal([...c.matchAll(/GRANT EXECUTE ON FUNCTION public\.clave_\w+\([^)]*\) TO service_role;/g)].length, 2);
  assert.equal([...c.matchAll(/REVOKE EXECUTE ON FUNCTION public\.clave_\w+\([^)]*\) FROM PUBLIC, anon, authenticated;/g)].length, 2);
  assert.doesNotMatch(c, /GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i);
  assert.doesNotMatch(c, /CREATE POLICY/i);
  assert.equal([...c.matchAll(/SECURITY DEFINER SET search_path TO 'public'/g)].length, 2);
});
test("candado POR perfil (pg_advisory_xact_lock sobre admin_clave:<perfil>) en las dos funciones, antes de leer el reloj", () => {
  const c = codigo(F);
  assert.equal([...c.matchAll(/PERFORM pg_advisory_xact_lock\(hashtextextended\('admin_clave:' \|\| p_perfil::text, 0\)\);\n\s*v_ahora := clock_timestamp\(\);/g)].length, 2);
  assert.doesNotMatch(c, /pg_advisory_lock\(/, "nunca un candado de sesión (no se liberaría solo)");
});
test("no toca el PIN, el login de Supabase ni nada existente (solo crea lo suyo)", () => {
  const c = codigo(F);
  assert.doesNotMatch(c, /admin_pin|pin_reservar|pin_guardar|autorizaciones_admin|auth\.(users|sessions|refresh_tokens)/);
  assert.doesNotMatch(c, /\b(ALTER|DROP)\s+(TABLE|FUNCTION|POLICY)\s+(?!IF EXISTS sync_guardia|public\.admin_clave_intentos)/i);
  assert.match(c, /EXECUTE FUNCTION public\.sync_guardia\('inmutable'\)/); assert.match(c, /EXECUTE FUNCTION public\.sync_guardia\('sin_borrado'\)/);
});
test("ENMIENDA 1D · «anulado»: admitido en el CHECK y en el resolver; las reservas anuladas no cuentan (en reservar Y en resolver); solo se anula explícitamente", () => {
  const c = codigo(F);
  assert.match(c, /CHECK \(resultado IN \('reservado', 'ok', 'fallido', 'anulado', 'bloqueado'\)\)/);
  assert.match(c, /CHECK \(\(resultado IN \('ok', 'fallido', 'anulado'\)\) = \(intento_id IS NOT NULL\)\)/);
  assert.match(c, /p_resultado NOT IN \('ok', 'fallido', 'anulado'\)/);
  assert.equal([...c.matchAll(/NOT EXISTS \(SELECT 1 FROM public\.admin_clave_intentos x WHERE x\.intento_id = r\.id AND x\.resultado = 'anulado'\)/g)].length, 2);
  assert.doesNotMatch(c, /INSERT INTO public\.admin_clave_intentos \([^)]*\) VALUES \([^)]*'anulado'/, "nunca se inserta un anulado automático");
  assert.equal([...c.matchAll(/v_base := GREATEST\(v_ahora - make_interval\(mins => p_ventana_min\), COALESCE\(v_ok, '-infinity'\), COALESCE\(v_bloq, '-infinity'\)\);/g)].length, 2, "solo 'ok' y 'bloqueado' mueven la base");
});
test("rollback: quita EXACTAMENTE lo que crea el forward y se niega a borrar evidencia sin permiso explícito", () => {
  const c = codigo(R);
  assert.match(c, /^BEGIN;/m); assert.match(c, /^COMMIT;\s*$/m);
  assert.deepEqual([...c.matchAll(/DROP (FUNCTION|TABLE) IF EXISTS ([\w.]+)/g)].map((m) => m[2]).sort(),
    ["public.admin_clave_intentos", "public.clave_reservar_intento", "public.clave_resolver_intento"]);
  assert.match(c, /ROLLBACK STOP/); assert.match(c, /current_setting\('sec\.forzar_rollback', true\) IS DISTINCT FROM 'si'/);
  assert.doesNotMatch(c, /admin_pin|auditoria|perfiles/);
});
