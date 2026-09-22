-- ENTIMOTORS OS 3.14.0 · SYNC-5 · ROLLBACK de sync_guardar_items_cotizacion · NO EJECUTADO EN PRODUCCIÓN
-- Quita la función nueva. NO borra datos: los renglones que ya escribió (tabla de SYNC-1) se conservan.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.sync_guardar_items_cotizacion(uuid, uuid, jsonb, text);

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'sync_guardar_items_cotizacion') THEN
    RAISE EXCEPTION 'SYNC-5 ROLLBACK STOP: la función sigue existiendo';
  END IF;
  RAISE NOTICE 'SYNC-5 ROLLBACK: sync_guardar_items_cotizacion retirada (los renglones ya escritos se conservan).';
END
$post$;
COMMIT;
