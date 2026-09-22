-- ENTIMOTORS OS 3.14.0 · SYNC-7A · ROLLBACK de registrar_stock_inicial · NO EJECUTADO EN PRODUCCIÓN
-- Quita la función nueva. NO borra datos: los movimientos de apertura que ya escribió (tabla de SYNC-1,
-- inventario_movimientos) se conservan, igual que inventario.cantidad ya derivada de ellos.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.registrar_stock_inicial(uuid, uuid, numeric, text);

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'registrar_stock_inicial') THEN
    RAISE EXCEPTION 'SYNC-7A ROLLBACK STOP: la función sigue existiendo';
  END IF;
  RAISE NOTICE 'SYNC-7A ROLLBACK: registrar_stock_inicial retirada (los movimientos de apertura ya escritos se conservan).';
END
$post$;
COMMIT;
