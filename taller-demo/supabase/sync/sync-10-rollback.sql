-- ENTIMOTORS OS 3.14.0 · SYNC-10 · ROLLBACK de la importación atómica · NO EJECUTADO EN PRODUCCIÓN
-- Quita las dos funciones nuevas. NO borra datos: lo importado se conserva (para deshacer una importación NO confirmada
-- está revertir_lote_importacion de SYNC-3b). Los ERRCODE 23503 de sync-5/sync-6 viven en sus propios archivos.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.import_aplicar_paquete(uuid, jsonb);
DROP FUNCTION IF EXISTS public.import_estado(uuid);

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('import_aplicar_paquete', 'import_estado')) THEN
    RAISE EXCEPTION 'SYNC-10 ROLLBACK STOP: las funciones siguen existiendo';
  END IF;
  RAISE NOTICE 'SYNC-10 ROLLBACK: import_aplicar_paquete/import_estado retiradas (lo importado se conserva).';
END
$post$;
COMMIT;
