-- ENTIMOTORS OS 3.14.1 · SECURITY-1C · límite PERSISTENTE de intentos para el futuro CAMBIO DE CONTRASEÑA del administrador
-- NO EJECUTADO EN PRODUCCIÓN. NO EJECUTAR SIN AUTORIZACIÓN EXPLÍCITA. Requiere SYNC-1 y SYNC-2 (perfiles, sync_guardia).
--
-- Por qué no se reutiliza pin_reservar_intento / admin_pin_intentos (SYNC-3P): exige que exista un PIN, y cuenta TODAS las filas
-- «reservado» sin mirar la acción; mezclar aquí los intentos de contraseña consumiría el cupo del PIN de los cajeros y podría llegar
-- al bloqueo 'infinity' del PIN. Esta tabla es independiente y no toca nada del PIN.
--
-- Qué guarda (y qué NO): perfil_id, resultado, creado_en y el enlace a la reserva que resuelve. NUNCA contraseña, hash, token,
-- PIN, correo ni IP. Solo agregar (sync_guardia 'inmutable' + TRUNCATE bloqueado): el historial se conserva; un éxito NO borra
-- nada, solo mueve el punto desde el que se cuenta.
--
-- Uso previsto (SECURITY-1D, backend con service_role, DESPUÉS de comprobar que quien llama es el admin):
--   1. clave_reservar_intento(admin, max, ventana, bloqueo, ttl) → {permitido, intento_id, intentos_restantes}
--        | {permitido:false, motivo:'bloqueado'|'en_curso', reintentar_en_s} | {permitido:false, motivo:'no_admin'}
--   2. verificar la contraseña actual / cambiarla
--   3. clave_resolver_intento(admin, intento_id, 'ok'|'fallido'|'anulado', max, ventana, bloqueo)
-- Reglas: cada RESERVA cuenta como intento hasta que un 'ok' posterior reinicia la cuenta (una reserva que nunca se resuelve cuenta
-- como fallida: falla cerrado).
-- ENMIENDA (SECURITY-1D, autorizada): 'anulado' = el proveedor de Auth NO dio una respuesta concluyente sobre la contraseña (red,
-- timeout, 5xx, 429, reautenticación exigida). Queda como evidencia, NO cuenta como intento, NO reinicia la cuenta (no mueve la base
-- como 'ok') y NO toca un bloqueo vigente. Solo se anula EXPLÍCITAMENTE: una reserva abandonada que vence su TTL sigue contando. Con `max` intentos contados en la ventana → evento 'bloqueado' que dura `bloqueo` minutos; al vencer,
-- la cuenta arranca de cero. Una reserva sin resolver dentro de su TTL = cambio EN CURSO: otra reserva simultánea se rechaza.
-- Todo bajo pg_advisory_xact_lock POR PERFIL: dos peticiones del mismo admin se serializan; perfiles distintos no se esperan.
-- Solo service_role ejecuta; anon/authenticated no ven la tabla ni ejecutan nada. No afecta al login de Supabase.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('public.perfiles') IS NULL OR to_regprocedure('public.sync_guardia()') IS NULL THEN
    RAISE EXCEPTION 'SECURITY-1C STOP: faltan SYNC-1/SYNC-2 (perfiles, sync_guardia)';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.admin_clave_intentos (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  perfil_id   uuid NOT NULL REFERENCES public.perfiles (id),
  resultado   text NOT NULL,
  intento_id  bigint REFERENCES public.admin_clave_intentos (id),
  creado_en   timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- CHECK con nombre fijo y recreados: el forward re-aplica igual sobre una base que tenga la versión anterior (sin 'anulado')
ALTER TABLE public.admin_clave_intentos DROP CONSTRAINT IF EXISTS admin_clave_intentos_resultado_check;
ALTER TABLE public.admin_clave_intentos ADD CONSTRAINT admin_clave_intentos_resultado_check
  CHECK (resultado IN ('reservado', 'ok', 'fallido', 'anulado', 'bloqueado'));
ALTER TABLE public.admin_clave_intentos DROP CONSTRAINT IF EXISTS admin_clave_intentos_resolucion;
ALTER TABLE public.admin_clave_intentos ADD CONSTRAINT admin_clave_intentos_resolucion
  CHECK ((resultado IN ('ok', 'fallido', 'anulado')) = (intento_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS admin_clave_intentos_una_resolucion ON public.admin_clave_intentos (intento_id) WHERE intento_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_clave_intentos_perfil ON public.admin_clave_intentos (perfil_id, creado_en DESC);
COMMENT ON TABLE public.admin_clave_intentos IS
  'SECURITY-1C: intentos de cambio de contraseña del admin. Solo agregar. Sin secretos: ni contraseña, ni hash, ni token, ni PIN, ni correo, ni IP.';

-- cerrada al cliente: RLS sin políticas y sin privilegios para anon/authenticated; service_role solo LEE (escribe solo por las funciones)
ALTER TABLE public.admin_clave_intentos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_clave_intentos FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.admin_clave_intentos TO service_role;
REVOKE ALL ON SEQUENCE public.admin_clave_intentos_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- solo agregar (misma guarda que admin_pin_intentos y auditoria)
DROP TRIGGER IF EXISTS sync_guardia_fila ON public.admin_clave_intentos;
CREATE TRIGGER sync_guardia_fila BEFORE UPDATE OR DELETE ON public.admin_clave_intentos FOR EACH ROW EXECUTE FUNCTION public.sync_guardia('inmutable');
DROP TRIGGER IF EXISTS sync_guardia_truncate ON public.admin_clave_intentos;
CREATE TRIGGER sync_guardia_truncate BEFORE TRUNCATE ON public.admin_clave_intentos FOR EACH STATEMENT EXECUTE FUNCTION public.sync_guardia('sin_borrado');

CREATE OR REPLACE FUNCTION public.clave_reservar_intento(p_perfil uuid, p_max integer, p_ventana_min integer, p_bloqueo_min integer, p_ttl_seg integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_ahora timestamptz; v_bloq timestamptz; v_ok timestamptz; v_base timestamptz; v_n integer; v_pend timestamptz; v_id bigint;
BEGIN
  IF p_perfil IS NULL OR p_max IS NULL OR p_max NOT BETWEEN 1 AND 20 OR p_ventana_min IS NULL OR p_ventana_min NOT BETWEEN 1 AND 1440
     OR p_bloqueo_min IS NULL OR p_bloqueo_min NOT BETWEEN 1 AND 1440 OR p_ttl_seg IS NULL OR p_ttl_seg NOT BETWEEN 10 AND 600 THEN
    RAISE EXCEPTION 'clave_reservar_intento: parámetros fuera de rango' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_clave:' || p_perfil::text, 0));
  v_ahora := clock_timestamp();                                   -- DESPUÉS del candado: lo esperado no cuenta como tiempo pasado

  -- solo la cuenta de un administrador activo tiene contador; cualquier otro perfil no deja rastro ni puede bloquear a nadie
  IF NOT EXISTS (SELECT 1 FROM public.perfiles p WHERE p.id = p_perfil AND p.rol = 'admin' AND p.activo) THEN
    RETURN jsonb_build_object('permitido', false, 'motivo', 'no_admin');
  END IF;

  -- ¿bloqueo vigente?
  SELECT max(creado_en) INTO v_bloq FROM public.admin_clave_intentos WHERE perfil_id = p_perfil AND resultado = 'bloqueado';
  IF v_bloq IS NOT NULL AND v_ahora < v_bloq + make_interval(mins => p_bloqueo_min) THEN
    RETURN jsonb_build_object('permitido', false, 'motivo', 'bloqueado',
      'reintentar_en_s', GREATEST(1, ceil(extract(epoch FROM (v_bloq + make_interval(mins => p_bloqueo_min) - v_ahora))))::int);
  END IF;

  -- ¿cambio EN CURSO? (reserva sin resolver dentro de su TTL)
  SELECT max(r.creado_en) INTO v_pend FROM public.admin_clave_intentos r
   WHERE r.perfil_id = p_perfil AND r.resultado = 'reservado' AND r.creado_en > v_ahora - make_interval(secs => p_ttl_seg)
     AND NOT EXISTS (SELECT 1 FROM public.admin_clave_intentos x WHERE x.intento_id = r.id);
  IF v_pend IS NOT NULL THEN
    RETURN jsonb_build_object('permitido', false, 'motivo', 'en_curso',
      'reintentar_en_s', GREATEST(1, ceil(extract(epoch FROM (v_pend + make_interval(secs => p_ttl_seg) - v_ahora))))::int);
  END IF;

  -- intentos que cuentan: reservas NO anuladas desde el último éxito, el último bloqueo o el inicio de la ventana (lo más reciente)
  SELECT max(creado_en) INTO v_ok FROM public.admin_clave_intentos WHERE perfil_id = p_perfil AND resultado = 'ok';
  v_base := GREATEST(v_ahora - make_interval(mins => p_ventana_min), COALESCE(v_ok, '-infinity'), COALESCE(v_bloq, '-infinity'));
  SELECT count(*) INTO v_n FROM public.admin_clave_intentos r WHERE r.perfil_id = p_perfil AND r.resultado = 'reservado' AND r.creado_en > v_base
     AND NOT EXISTS (SELECT 1 FROM public.admin_clave_intentos x WHERE x.intento_id = r.id AND x.resultado = 'anulado');   -- anulada: no cuenta
  IF v_n >= p_max THEN          -- solo alcanzable con reservas que nunca se resolvieron (el resolver ya bloquea al llegar al máximo)
    INSERT INTO public.admin_clave_intentos (perfil_id, resultado) VALUES (p_perfil, 'bloqueado');
    RETURN jsonb_build_object('permitido', false, 'motivo', 'bloqueado', 'reintentar_en_s', p_bloqueo_min * 60);
  END IF;

  INSERT INTO public.admin_clave_intentos (perfil_id, resultado) VALUES (p_perfil, 'reservado') RETURNING id INTO v_id;
  RETURN jsonb_build_object('permitido', true, 'intento_id', v_id, 'intentos_restantes', p_max - v_n - 1);
END
$function$;

CREATE OR REPLACE FUNCTION public.clave_resolver_intento(p_perfil uuid, p_intento bigint, p_resultado text, p_max integer, p_ventana_min integer, p_bloqueo_min integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_ahora timestamptz; v_bloq timestamptz; v_ok timestamptz; v_base timestamptz; v_n integer;
BEGIN
  IF p_perfil IS NULL OR p_intento IS NULL OR p_resultado IS NULL OR p_resultado NOT IN ('ok', 'fallido', 'anulado')
     OR p_max IS NULL OR p_max NOT BETWEEN 1 AND 20 OR p_ventana_min IS NULL OR p_ventana_min NOT BETWEEN 1 AND 1440
     OR p_bloqueo_min IS NULL OR p_bloqueo_min NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'clave_resolver_intento: parámetros fuera de rango' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_clave:' || p_perfil::text, 0));
  v_ahora := clock_timestamp();
  IF NOT EXISTS (SELECT 1 FROM public.admin_clave_intentos WHERE id = p_intento AND perfil_id = p_perfil AND resultado = 'reservado') THEN
    RAISE EXCEPTION 'clave_resolver_intento: la reserva no existe o no es de este perfil' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_clave_intentos WHERE intento_id = p_intento) THEN
    RAISE EXCEPTION 'clave_resolver_intento: la reserva ya se resolvió' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.admin_clave_intentos (perfil_id, resultado, intento_id) VALUES (p_perfil, p_resultado, p_intento);
  IF p_resultado = 'ok' THEN
    RETURN jsonb_build_object('resultado', 'ok', 'bloqueado', false, 'intentos_restantes', p_max);   -- la cuenta vuelve a cero
  END IF;

  -- fallido: ¿se llegó al máximo? El bloqueo empieza AHORA (con el fallo que lo alcanza), no en el intento siguiente.
  -- anulado: solo informa lo que queda (ni cuenta, ni bloquea, ni desbloquea, ni reinicia)
  SELECT max(creado_en) INTO v_bloq FROM public.admin_clave_intentos WHERE perfil_id = p_perfil AND resultado = 'bloqueado';
  SELECT max(creado_en) INTO v_ok FROM public.admin_clave_intentos WHERE perfil_id = p_perfil AND resultado = 'ok';
  v_base := GREATEST(v_ahora - make_interval(mins => p_ventana_min), COALESCE(v_ok, '-infinity'), COALESCE(v_bloq, '-infinity'));
  SELECT count(*) INTO v_n FROM public.admin_clave_intentos r WHERE r.perfil_id = p_perfil AND r.resultado = 'reservado' AND r.creado_en > v_base
     AND NOT EXISTS (SELECT 1 FROM public.admin_clave_intentos x WHERE x.intento_id = r.id AND x.resultado = 'anulado');   -- anulada: no cuenta
  IF p_resultado = 'anulado' THEN
    RETURN jsonb_build_object('resultado', 'anulado', 'bloqueado', v_bloq IS NOT NULL AND v_ahora < v_bloq + make_interval(mins => p_bloqueo_min),
                              'intentos_restantes', GREATEST(0, p_max - v_n));
  END IF;
  IF v_n >= p_max AND (v_bloq IS NULL OR v_ahora >= v_bloq + make_interval(mins => p_bloqueo_min)) THEN
    INSERT INTO public.admin_clave_intentos (perfil_id, resultado) VALUES (p_perfil, 'bloqueado');
    RETURN jsonb_build_object('resultado', 'fallido', 'bloqueado', true, 'intentos_restantes', 0, 'reintentar_en_s', p_bloqueo_min * 60);
  END IF;
  RETURN jsonb_build_object('resultado', 'fallido', 'bloqueado', false, 'intentos_restantes', GREATEST(0, p_max - v_n));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.clave_reservar_intento(uuid, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clave_reservar_intento(uuid, integer, integer, integer, integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.clave_resolver_intento(uuid, bigint, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clave_resolver_intento(uuid, bigint, text, integer, integer, integer) TO service_role;

-- POSTCONDICIONES (fallan cerradas)
DO $post$
DECLARE r text; f text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_clave_intentos'::regclass) THEN RAISE EXCEPTION 'SECURITY-1C: RLS apagado'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_clave_intentos') THEN RAISE EXCEPTION 'SECURITY-1C: la tabla no debe tener políticas'; END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.admin_clave_intentos', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN RAISE EXCEPTION 'SECURITY-1C: % tiene privilegios sobre la tabla', r; END IF;
    FOREACH f IN ARRAY ARRAY['public.clave_reservar_intento(uuid,integer,integer,integer,integer)', 'public.clave_resolver_intento(uuid,bigint,text,integer,integer,integer)'] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN RAISE EXCEPTION 'SECURITY-1C: % puede ejecutar %', r, f; END IF;
    END LOOP;
  END LOOP;
  IF has_table_privilege('service_role', 'public.admin_clave_intentos', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'SECURITY-1C: service_role no debe escribir directo'; END IF;
  IF NOT has_function_privilege('service_role', 'public.clave_reservar_intento(uuid,integer,integer,integer,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.clave_resolver_intento(uuid,bigint,text,integer,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY-1C: service_role debe poder ejecutar las funciones';
  END IF;
END
$post$;

COMMIT;
