-- ENTIMOTORS OS 3.14.0 · SYNC-3P · ROLLBACK del límite de intentos del PIN · NO EJECUTADO EN PRODUCCIÓN
-- Quita las dos funciones. NO borra admin_pin, admin_pin_intentos ni autorizaciones_admin (tablas de SYNC-1): su historia se conserva.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.pin_desbloquear(uuid);
DROP FUNCTION IF EXISTS public.pin_guardar(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.pin_emitir_autorizacion(uuid, text, uuid, text, text, uuid, text, integer, text, integer);
DROP FUNCTION IF EXISTS public.pin_reservar_intento(uuid, text, text, text, uuid, integer, integer, integer, integer, integer);
COMMIT;
