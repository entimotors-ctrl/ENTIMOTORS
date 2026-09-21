-- ENTIMOTORS OS 3.14.0 · SYNC-3 (+3b) · ROLLBACK de las RPC · NO EJECUTADO EN PRODUCCIÓN
-- Quita las funciones nuevas. NO borra datos: el ledger, los reversos, sync_ops y demás filas que las RPC hayan escrito
-- son válidos y quedan (las tablas son de SYNC-1). Las 17 funciones de RCV-34 no se tocan.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.import_totales();
DROP FUNCTION IF EXISTS public.revertir_lote_importacion(uuid);
DROP FUNCTION IF EXISTS public.import_confirmar_lote(uuid);
DROP FUNCTION IF EXISTS public.import_cerrar_carga(uuid, jsonb);
DROP FUNCTION IF EXISTS public.import_aplicar_lote(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.import_guardar_mapeo(uuid, jsonb);
DROP FUNCTION IF EXISTS public.import_dry_run_ok(uuid, jsonb);
DROP FUNCTION IF EXISTS public.import_iniciar(uuid, text, text, text, text, integer, jsonb);
DROP FUNCTION IF EXISTS public.verificar_invariantes();
DROP FUNCTION IF EXISTS public.anular_orden(uuid, uuid, text, boolean, uuid, text);
DROP FUNCTION IF EXISTS public.reversar_caja(uuid, uuid, text, uuid, text);
DROP FUNCTION IF EXISTS public.reversar_credito(uuid, uuid, text, uuid, text);
DROP FUNCTION IF EXISTS public.reversar_abono(uuid, uuid, text, uuid, text);
DROP FUNCTION IF EXISTS public.registrar_devolucion(uuid, uuid, jsonb, text, boolean, uuid, text);
DROP FUNCTION IF EXISTS public.reversar_venta(uuid, uuid, text, uuid, text);
DROP FUNCTION IF EXISTS public.registrar_movimiento_caja(uuid, text, text, numeric, text, text, timestamptz, text);
DROP FUNCTION IF EXISTS public.ajustar_stock(uuid, uuid, text, numeric, numeric, uuid, text);
DROP FUNCTION IF EXISTS public.convertir_cotizacion(uuid, uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.finalizar_orden(uuid, uuid, text, text, numeric, text, date, timestamptz, text, uuid);
DROP FUNCTION IF EXISTS public.quitar_item_orden(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.agregar_item_orden(uuid, uuid, uuid, text, numeric, numeric, uuid, boolean, timestamptz, text);
DROP FUNCTION IF EXISTS public.registrar_credito(uuid, uuid, text, text, jsonb, date, text, numeric, text, timestamptz, boolean, text, uuid, text, uuid);
DROP FUNCTION IF EXISTS public.registrar_abono_v2(uuid, uuid, numeric, text, timestamptz, text);
DROP FUNCTION IF EXISTS public.registrar_venta_v2(uuid, uuid, text, text, numeric, jsonb, timestamptz, boolean, text, uuid, uuid);
DROP FUNCTION IF EXISTS public.sync_reversar_credito_i(uuid, uuid, text, boolean);
DROP FUNCTION IF EXISTS public.sync_reversar_abono_i(uuid, timestamptz, text);
DROP FUNCTION IF EXISTS public.sync_registrar_reverso(text, text, uuid, text, uuid, text, uuid, boolean, uuid, jsonb);
DROP FUNCTION IF EXISTS public.sync_compensar_caja(text, uuid, text, timestamptz, text, numeric);
DROP FUNCTION IF EXISTS public.sync_abonar(uuid, numeric, text, timestamptz, uuid, text);
DROP FUNCTION IF EXISTS public.sync_autorizar(uuid, text, text, uuid, uuid, numeric);
DROP FUNCTION IF EXISTS public.sync_hash_critico(text, uuid, numeric);
DROP FUNCTION IF EXISTS public.sync_caja(text, text, numeric, text, text, timestamptz, uuid, uuid, uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS public.sync_stock_mover(uuid, numeric, text, uuid, boolean, timestamptz, uuid, uuid, uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.sync_auditar(text, text, text, text, uuid, text, uuid, text);
DROP FUNCTION IF EXISTS public.sync_op_guardar(uuid, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.sync_op_iniciar(uuid, text, text);

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('registrar_venta_v2','registrar_credito','import_aplicar_lote','sync_op_iniciar')) THEN
    RAISE EXCEPTION 'SYNC-3 ROLLBACK STOP: quedan RPC';
  END IF;
  RAISE NOTICE 'SYNC-3 ROLLBACK: RPC retiradas (los datos escritos por ellas se conservan).';
END
$post$;
COMMIT;
