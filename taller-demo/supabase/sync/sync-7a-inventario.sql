-- ENTIMOTORS OS 3.14.0 · SYNC-7A · STOCK DE APERTURA DEL INVENTARIO · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere SYNC-1 y SYNC-3 ya aplicados.
--
-- QUÉ HACE (aditivo; no toca columnas, políticas ni las 17 funciones de RCV-34)
-- SYNC-7A sincroniza el MAESTRO de `inventario` (nombre/modelo/precios/categoría) como un mapper CRUD normal
-- (ver la cabecera de sync-mappers.js) — pero `cantidad` NUNCA viaja por ese camino: es columna derivada del
-- ledger desde SYNC-1 (`inventario.cantidad`, trigger `sync_ledger_aplicar` sobre `inventario_movimientos`,
-- decisión D-3/MATERIALIZED_RPC ya tomada, no se reabre aquí). Un producto NUEVO nace en la nube con
-- `cantidad = 0` (columna con default, nadie la manda en el INSERT del maestro) — este archivo agrega la única
-- pieza que faltaba: la RPC que registra el stock CON el que nace el producto, como UN movimiento de ledger
-- `tipo = 'apertura'` (ya reservado en el CHECK de `inventario_movimientos` desde SYNC-1, sin usar hasta ahora).
--
-- public.registrar_stock_inicial(p_op, p_inventario_id, p_cantidad, p_device) — mismo patrón que ajustar_stock
-- (sync_op_iniciar/sync_op_guardar + sync_stock_mover): idempotente por operation_id (un reintento con el MISMO
-- p_op nunca duplica el movimiento — sync_op_iniciar). Solo el administrador (D-4, igual que el maestro; a
-- diferencia de ajustar_stock, aquí NO hay camino de cajero con PIN: dar de alta un producto ya es 100% admin,
-- así que no se llama a sync_autorizar ni entra en ACCIONES_CON_PIN del cliente).
--
-- CONTRATO PARA LA MIGRACIÓN FUTURA (SYNC-9, sección 6 de la fase): un producto recibe como máximo UNA apertura
-- en toda su vida, sin importar el operation_id con el que se llame — así, el día que se migre el stock real
-- del respaldo, cada producto entra UNA sola vez con su cantidad de ese momento; no hay forma de reconstruir la
-- existencia histórica volviendo a aplicar aperturas (eso duplicaría el stock encima de ventas/ajustes ya
-- aplicados). Esta regla es del SERVIDOR (no confía en que el cliente solo la llame una vez): se comprueba
-- con un EXISTS sobre inventario_movimientos, no con el operation_id.
-- SYNC-7B: "El repuesto no existe" pasa de P0002 (HTTP 500, se reintentaba para siempre) a 23503 (409, terminal).
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

-- PRECONDICIONES ------------------------------------------------------------------------------------------------
DO $pre$
DECLARE v_fail text := '';
BEGIN
  IF to_regprocedure('public.sync_op_iniciar(uuid,text,text)') IS NULL
     OR to_regprocedure('public.sync_op_guardar(uuid,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('public.sync_auditar(text,text,text,text,uuid,text,uuid,text)') IS NULL
     OR to_regprocedure('public.sync_stock_mover(uuid,numeric,text,uuid,boolean,timestamptz,uuid,uuid,uuid,uuid,uuid,text)') IS NULL THEN
    v_fail := v_fail || 'falta SYNC-3 (sync_op_iniciar/sync_op_guardar/sync_auditar/sync_stock_mover); ';
  END IF;
  IF to_regprocedure('public.es_admin()') IS NULL THEN v_fail := v_fail || 'falta es_admin(); '; END IF;
  IF to_regclass('public.inventario') IS NULL OR to_regclass('public.inventario_movimientos') IS NULL THEN
    v_fail := v_fail || 'faltan tablas base (inventario/inventario_movimientos); ';
  END IF;
  -- 'apertura' debe seguir siendo un tipo válido del ledger (reservado desde SYNC-1) — si el CHECK cambiara y
  -- quitara este valor, mejor fallar aquí que insertar un movimiento que el propio esquema ya no espera.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.inventario_movimientos'::regclass AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%''apertura''%'
  ) THEN
    v_fail := v_fail || 'inventario_movimientos ya no acepta tipo=''apertura'' (revisar el CHECK de SYNC-1); ';
  END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-7A STOP (precondiciones, nada modificado): %', v_fail; END IF;
END
$pre$;

-- STOCK DE APERTURA ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_stock_inicial(p_op uuid, p_inventario_id uuid, p_cantidad numeric, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; v_saldo numeric; v_res jsonb;
BEGIN
  IF NOT public.es_admin() THEN
    RAISE EXCEPTION 'Solo el administrador da de alta el stock inicial de un repuesto' USING ERRCODE = '42501';
  END IF;
  IF p_cantidad IS NULL OR p_cantidad < 0 THEN
    RAISE EXCEPTION 'La cantidad inicial no puede ser negativa' USING ERRCODE = '22023';
  END IF;

  v_hash := md5(jsonb_build_array(p_inventario_id, p_cantidad)::text);
  v_prev := public.sync_op_iniciar(p_op, 'registrar_stock_inicial', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  IF NOT EXISTS (SELECT 1 FROM public.inventario i WHERE i.id = p_inventario_id AND i.deleted_at IS NULL FOR UPDATE) THEN
    RAISE EXCEPTION 'El repuesto no existe' USING ERRCODE = '23503';
  END IF;
  -- contrato de migración (SYNC-9, ver cabecera del archivo): como máximo una apertura por producto, para
  -- siempre, sin importar el operation_id.
  IF EXISTS (SELECT 1 FROM public.inventario_movimientos m WHERE m.inventario_id = p_inventario_id AND m.tipo = 'apertura') THEN
    RAISE EXCEPTION 'Este repuesto ya tiene un stock de apertura registrado' USING ERRCODE = '22000';
  END IF;

  v_saldo := public.sync_stock_mover(p_inventario_id, p_cantidad, 'apertura', p_op, false, clock_timestamp(),
      NULL, NULL, NULL, NULL, NULL, 'Stock inicial al crear el repuesto');
  PERFORM public.sync_auditar('stock-apertura', 'inventario', p_inventario_id::text, 'Apertura de ' || COALESCE(p_cantidad, 0), p_op, p_device);
  v_res := jsonb_build_object('inventario_id', p_inventario_id, 'cantidad', p_cantidad, 'saldo', COALESCE(v_saldo, 0), 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'registrar_stock_inicial', v_hash, p_device, v_res);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.registrar_stock_inicial(uuid, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_stock_inicial(uuid, uuid, numeric, text) TO authenticated, service_role;

-- POSTCONDICIONES (fallan cerradas) ---------------------------------------------------------------------------
DO $post$
DECLARE v_fail text := '';
BEGIN
  IF to_regprocedure('public.registrar_stock_inicial(uuid,uuid,numeric,text)') IS NULL THEN
    v_fail := v_fail || 'falta registrar_stock_inicial(); ';
  END IF;
  IF has_function_privilege('anon', 'public.registrar_stock_inicial(uuid,uuid,numeric,text)', 'EXECUTE') THEN
    v_fail := v_fail || 'registrar_stock_inicial() ejecutable por anon; ';
  END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-7A STOP (postcondiciones, se revierte todo): %', v_fail; END IF;
  RAISE NOTICE 'SYNC-7A: postcondiciones OK (stock de apertura instalado, solo admin, solo authenticated).';
END
$post$;

COMMIT;
