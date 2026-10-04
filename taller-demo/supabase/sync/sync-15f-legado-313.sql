-- ENTIMOTORS OS 3.15.0 · BLOQUE 6 · ESTADO DE MIGRACIÓN 3.13 EN EL SERVIDOR · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere la cadena SYNC 1..10 (import_lotes) + 15a..15e. Idempotente. Solo lectura.
--
-- Hasta 3.14.1 el aviso «datos de la versión 3.13 sin pasar a la nube» dependía de una marca en el localStorage de CADA dispositivo:
-- otro teléfono/PC con la base 3.13 lo volvía a ofrecer aunque el negocio ya estuviera migrado. Desde 3.15 el dispositivo pregunta al
-- servidor, que es quien sabe:
--  · migracion_313_estado(): ¿hay una importación CONFIRMADA? (un dispositivo nuevo sin datos 3.13 ya no ofrece importar como flujo normal)
--  · migracion_313_presentes(ids): de los uuid deterministas (import-313.js · uuidDe) de los registros 3.13 de ESTE dispositivo, ¿cuáles
--    ya existen en la nube? Lo que falte se sigue mostrando (p. ej. el registro 119): NADA se marca ni se descarta en el servidor.
-- Sin tablas nuevas ni cambios de datos: el rollback solo quita las dos funciones.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sync_fases WHERE fase = '15e') THEN RAISE EXCEPTION 'SYNC-15F STOP: falta sync-15e'; END IF;
  IF to_regclass('public.import_lotes') IS NULL THEN RAISE EXCEPTION 'SYNC-15F STOP: falta SYNC-10 (import_lotes)'; END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.migracion_313_estado()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v jsonb; u record;
BEGIN
  IF NOT public.es_equipo() THEN RAISE EXCEPTION 'Solo el equipo del taller' USING ERRCODE = '42501'; END IF;
  IF public.rol_actual() = 'mecanico' THEN RAISE EXCEPTION 'Solo administrador o caja' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(jsonb_object_agg(estado, n), '{}'::jsonb) INTO v FROM (SELECT estado, count(*) AS n FROM public.import_lotes GROUP BY estado) x;
  SELECT confirmado_en, left(backup_sha256, 12) AS sha, conteos_insertados INTO u
    FROM public.import_lotes WHERE estado = 'confirmado' ORDER BY confirmado_en DESC LIMIT 1;
  RETURN jsonb_build_object('lotes', v, 'migrado', u.confirmado_en IS NOT NULL, 'ultimo_confirmado_en', u.confirmado_en,
    'ultimo_respaldo', u.sha, 'ultimo_insertados', u.conteos_insertados,
    'sin_confirmar', coalesce((v->>'aplicado')::int, 0) + coalesce((v->>'aplicando')::int, 0));
END
$function$;

-- p_ids = {"clientes": [uuid, …], "ordenes": […], …}; responde {"clientes": [los que existen], …}. Solo tablas del legado 3.13.
CREATE OR REPLACE FUNCTION public.migracion_313_presentes(p_ids jsonb)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE t text; r jsonb := '{}'::jsonb; ids uuid[]; hay uuid[]; total int := 0;
  permitidas CONSTANT text[] := ARRAY['clientes','motos','ordenes','inventario','citas','cotizaciones','ventas','caja_movimientos','creditos','categorias_inv'];
BEGIN
  IF NOT public.es_equipo() THEN RAISE EXCEPTION 'Solo el equipo del taller' USING ERRCODE = '42501'; END IF;
  IF public.rol_actual() = 'mecanico' THEN RAISE EXCEPTION 'Solo administrador o caja' USING ERRCODE = '42501'; END IF;
  IF p_ids IS NULL OR jsonb_typeof(p_ids) <> 'object' THEN RAISE EXCEPTION 'Se espera un objeto {tabla: [uuid]}' USING ERRCODE = '22023'; END IF;
  FOR t IN SELECT jsonb_object_keys(p_ids) LOOP
    IF NOT t = ANY (permitidas) THEN RAISE EXCEPTION 'Tabla no permitida: %', t USING ERRCODE = '22023'; END IF;
    IF jsonb_typeof(p_ids->t) <> 'array' THEN RAISE EXCEPTION 'Se espera una lista de uuid en %', t USING ERRCODE = '22023'; END IF;
    SELECT coalesce(array_agg(x::uuid), '{}') INTO ids FROM jsonb_array_elements_text(p_ids->t) x;
    total := total + coalesce(array_length(ids, 1), 0);
    IF total > 30000 THEN RAISE EXCEPTION 'Demasiados identificadores (máximo 30000)' USING ERRCODE = '22023'; END IF;
    -- borrados suaves incluidos: si está (aunque se haya borrado después), ya se migró
    EXECUTE format('SELECT coalesce(array_agg(id), ''{}'') FROM public.%I WHERE id = ANY ($1)', t) INTO hay USING ids;
    r := r || jsonb_build_object(t, to_jsonb(hay));
  END LOOP;
  RETURN r;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.migracion_313_estado() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.migracion_313_estado() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.migracion_313_presentes(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.migracion_313_presentes(jsonb) TO authenticated, service_role;

INSERT INTO public.sync_fases (fase) VALUES ('15f') ON CONFLICT (fase) DO NOTHING;
DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.migracion_313_presentes(jsonb)', 'EXECUTE') THEN RAISE EXCEPTION 'SYNC-15F STOP: anon ejecuta'; END IF;
  RAISE NOTICE 'SYNC-15F: estado de migración 3.13 en el servidor listo (solo lectura).';
END
$post$;
COMMIT;
