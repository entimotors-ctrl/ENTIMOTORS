-- ENTIMOTORS OS 3.15.0 · BLOQUE 3 · ROLLBACK de sync-15c-mensajes-realtime.sql · NO EJECUTADO EN PRODUCCIÓN
-- Quita los triggers de aviso, las políticas de canal (realtime.messages), las funciones y la tabla de mensajes. No toca ninguna
-- otra tabla ni la publicación de Realtime (15c no la cambió). Debe correr ANTES que sync-15b-rollback.sql (15b borra sync_fases).
-- SE NIEGA si ya hay mensajes (borrar la tabla los perdería). Forzar solo tras exportarlos, a sabiendas:
--   PGOPTIONS="-c sync.forzar_rollback=si"                                  (local)
--   psql -c "SET sync.forzar_rollback = 'si'" -f sync-15c-rollback.sql      (pooler de Supabase: ignora PGOPTIONS; misma sesión)
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE n int := 0;
BEGIN
  IF to_regclass('public.mensajes') IS NOT NULL THEN SELECT count(*) INTO n FROM public.mensajes; END IF;
  IF n > 0 AND COALESCE(current_setting('sync.forzar_rollback', true), '') <> 'si' THEN
    RAISE EXCEPTION 'ROLLBACK STOP: hay % mensaje(s); exportarlos antes de quitar la tabla (o forzar a sabiendas)', n;
  END IF;
END
$pre$;

DO $rt$
BEGIN
  IF to_regclass('realtime.messages') IS NULL THEN RETURN; END IF;
  EXECUTE 'DROP POLICY IF EXISTS entimotors_rt_mecanico ON realtime.messages';
  EXECUTE 'DROP POLICY IF EXISTS entimotors_rt_taller ON realtime.messages';
  EXECUTE 'DROP POLICY IF EXISTS entimotors_rt_admin ON realtime.messages';
END
$rt$;

DO $taller$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','categorias_inv','inventario','cotizaciones','cotizacion_items','ordenes','orden_items',
                           'ventas','creditos','abonos','caja_movimientos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zz_rt_taller ON public.%I', t);
  END LOOP;
END
$taller$;
DROP TRIGGER IF EXISTS zz_rt_mecanico ON public.ordenes;
DROP TRIGGER IF EXISTS zz_rt_mecanico ON public.orden_items;
DROP TRIGGER IF EXISTS zz_rt_mecanico ON public.citas;

DROP FUNCTION IF EXISTS public.marcar_mensaje_leido(uuid,uuid,text);
DROP FUNCTION IF EXISTS public.enviar_mensaje(uuid,uuid,uuid,text,uuid,uuid,text);
DROP FUNCTION IF EXISTS public.citas_tecnico_mias();
DROP TABLE IF EXISTS public.mensajes;
DROP FUNCTION IF EXISTS public.sync_rt_taller();
DROP FUNCTION IF EXISTS public.sync_rt_mensajes();
DROP FUNCTION IF EXISTS public.sync_rt_citas();
DROP FUNCTION IF EXISTS public.sync_rt_orden_items();
DROP FUNCTION IF EXISTS public.sync_rt_ordenes();
DROP FUNCTION IF EXISTS public.sync_rt_aviso(text,jsonb);
DROP FUNCTION IF EXISTS public.mensajes_inmutable();

DELETE FROM public.sync_fases WHERE fase = '15c';

DO $post$
BEGIN
  IF to_regclass('public.mensajes') IS NOT NULL OR to_regprocedure('public.sync_rt_aviso(text,jsonb)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('zz_rt_taller', 'zz_rt_mecanico') AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'ROLLBACK 15C STOP: quedaron objetos de 15c';
  END IF;
  RAISE NOTICE 'SYNC-15C: rollback completo.';
END
$post$;
COMMIT;
