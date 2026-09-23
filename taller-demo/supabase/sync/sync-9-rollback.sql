-- ENTIMOTORS OS 3.14.0 · SYNC-9 · ROLLBACK de agregar_foto_orden y de los límites del bucket · NO EJECUTADO EN PRODUCCIÓN
-- Quita la función nueva y devuelve entimotors-taller a SIN límites (como estaba). NO borra datos: las rutas ya
-- ligadas en ordenes.fotos y los objetos de Storage se conservan.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.agregar_foto_orden(uuid, uuid, text, text);
UPDATE storage.buckets SET allowed_mime_types = NULL, file_size_limit = NULL WHERE id = 'entimotors-taller';

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'agregar_foto_orden') THEN
    RAISE EXCEPTION 'SYNC-9 ROLLBACK STOP: la función sigue existiendo';
  END IF;
  RAISE NOTICE 'SYNC-9 ROLLBACK: agregar_foto_orden retirada y bucket sin límites (fotos y objetos ya guardados se conservan).';
END
$post$;
COMMIT;
