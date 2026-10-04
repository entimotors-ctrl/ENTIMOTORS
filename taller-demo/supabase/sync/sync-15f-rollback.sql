-- ENTIMOTORS OS 3.15.0 · BLOQUE 6 · ROLLBACK de sync-15f-legado-313.sql · NO EJECUTADO EN PRODUCCIÓN
-- 15f no crea tablas ni datos: quitar sus dos funciones deja el esquema exactamente como con 15e. Va ANTES del rollback de 15e.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
DROP FUNCTION IF EXISTS public.migracion_313_estado();
DROP FUNCTION IF EXISTS public.migracion_313_presentes(jsonb);
DELETE FROM public.sync_fases WHERE fase = '15f';
COMMIT;
