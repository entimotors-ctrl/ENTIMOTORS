-- ENTIMOTORS OS 3.14.1 · SECURITY-1C · ROLLBACK del límite de intentos del cambio de contraseña · NO EJECUTADO EN PRODUCCIÓN
-- Quita las dos funciones y la tabla admin_clave_intentos. La tabla es EVIDENCIA (solo agregar): si tiene filas, el rollback se NIEGA
-- salvo permiso explícito en la sesión:  SET sec.forzar_rollback = 'si';  (o PGOPTIONS="-c sec.forzar_rollback=si" donde se respete).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
DO $pre$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.admin_clave_intentos') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.admin_clave_intentos' INTO n;
    IF n > 0 AND current_setting('sec.forzar_rollback', true) IS DISTINCT FROM 'si' THEN
      RAISE EXCEPTION 'ROLLBACK STOP: admin_clave_intentos tiene % filas (evidencia). Para borrarla: SET sec.forzar_rollback = ''si''', n;
    END IF;
  END IF;
END
$pre$;
DROP FUNCTION IF EXISTS public.clave_resolver_intento(uuid, bigint, text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.clave_reservar_intento(uuid, integer, integer, integer, integer);
DROP TABLE IF EXISTS public.admin_clave_intentos;
COMMIT;
