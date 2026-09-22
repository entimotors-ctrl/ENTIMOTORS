-- ENTIMOTORS OS 3.14.0 · SYNC-6 · ROLLBACK de ordenes_tecnico_mias / avanzar_orden_tecnico · NO EJECUTADO EN PRODUCCIÓN
-- Quita las dos funciones nuevas. NO borra datos ni toca el trigger ordenes_mecanico_avance (es de fase4d, no de
-- SYNC-6). Tras este rollback, Mi Trabajo vuelve a quedarse sin poder leer ni avanzar órdenes en modo nube —
-- exactamente el estado documentado como pendiente al cerrar SYNC-5.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.avanzar_orden_tecnico(uuid, uuid, jsonb, text);
DROP FUNCTION IF EXISTS public.ordenes_tecnico_mias();

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('avanzar_orden_tecnico', 'ordenes_tecnico_mias')) THEN
    RAISE EXCEPTION 'SYNC-6 ROLLBACK STOP: alguna función sigue existiendo';
  END IF;
  RAISE NOTICE 'SYNC-6 ROLLBACK: ordenes_tecnico_mias/avanzar_orden_tecnico retiradas.';
END
$post$;
COMMIT;
