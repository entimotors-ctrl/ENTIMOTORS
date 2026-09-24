-- ENTIMOTORS OS 3.14.0 · SYNC-5 · RENGLONES DE COTIZACIÓN · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere sync-1, sync-2 y sync-3 aplicados.
--
-- POR QUÉ UNA RPC Y NO EL CAMINO GENÉRICO (outbox + PATCH condicionado por rev):
-- cotizacion_items es hijo de cotizaciones (SYNC-1 no le agregó updated_at/rev/deleted_at ni trigger de
-- sello: no tiene cursor de descarga propio). Sus renglones viajan EMBEBIDOS en la fila de la cotización
-- (PostgREST: select=*,cotizacion_items(...)) y se escriben con un reemplazo atómico de todos los renglones,
-- idempotente por operation_id igual que el resto de SYNC-3. Cualquier cambio en los renglones toca
-- cotizaciones.last_op_id para que zz_sync_sello suba su rev/updated_at: así el pull del padre lo detecta.
--
-- Esta RPC NO mueve dinero ni stock (D-11, SYNC-5 no toca inventario transaccional): inventario_id viaja
-- solo como referencia opcional, nunca cambia inventario.cantidad. Igual que agregar_item_orden/
-- quitar_item_orden, exige ve_todo_el_taller() (admin o cajero) porque SYNC-2 ya puso esa misma condición
-- para poder borrar renglones de cotizacion_items.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('public.cotizacion_items') IS NULL OR to_regprocedure('public.sync_op_iniciar(uuid,text,text)') IS NULL
     OR to_regprocedure('public.ve_todo_el_taller()') IS NULL THEN
    RAISE EXCEPTION 'SYNC-5 STOP: faltan SYNC-1/SYNC-2/SYNC-3';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.sync_guardar_items_cotizacion(p_op uuid, p_cotizacion_id uuid, p_items jsonb, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; c record; v_n int := 0; v_res jsonb; x jsonb;
BEGIN
  IF NOT public.ve_todo_el_taller() THEN RAISE EXCEPTION 'Solo el administrador o el cajero editan cotizaciones' USING ERRCODE = '42501'; END IF;
  IF p_cotizacion_id IS NULL THEN RAISE EXCEPTION 'Falta la cotización' USING ERRCODE = '22004'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'p_items debe ser un arreglo JSON' USING ERRCODE = '22023'; END IF;

  v_hash := md5(jsonb_build_array(p_cotizacion_id, p_items)::text);
  v_prev := public.sync_op_iniciar(p_op, 'sync_guardar_items_cotizacion', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  SELECT co.id, co.deleted_at INTO c FROM public.cotizaciones co WHERE co.id = p_cotizacion_id FOR UPDATE;
  -- SYNC-10: 23503 (no P0002 → HTTP 500 → reintento infinito): la cotización borrada es un rechazo terminal, a la vista.
  IF NOT FOUND OR c.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'La cotización no existe' USING ERRCODE = '23503'; END IF;

  -- reemplazo atómico: fuera de aquí nadie hace INSERT/UPDATE/DELETE directo en cotizacion_items (RLS D-2)
  DELETE FROM public.cotizacion_items WHERE cotizacion_id = p_cotizacion_id;
  FOR x IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF COALESCE(btrim(x->>'nombre'), '') = '' THEN RAISE EXCEPTION 'Falta el nombre de un renglón' USING ERRCODE = '22023'; END IF;
    IF NOT (x ? 'cantidad') OR (x->>'cantidad')::numeric <= 0 THEN RAISE EXCEPTION 'La cantidad de «%» debe ser mayor a cero', x->>'nombre' USING ERRCODE = '22023'; END IF;
    IF NOT (x ? 'precio') OR (x->>'precio')::numeric < 0 THEN RAISE EXCEPTION 'El precio de «%» no puede ser negativo', x->>'nombre' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.cotizacion_items (cotizacion_id, inventario_id, nombre, cantidad, precio)
    VALUES (p_cotizacion_id, NULLIF(x->>'inventario_id', '')::uuid, x->>'nombre', (x->>'cantidad')::numeric, (x->>'precio')::numeric);
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.cotizaciones SET last_op_id = p_op WHERE id = p_cotizacion_id;   -- sube rev/updated_at: el pull del padre lo detecta
  PERFORM public.sync_auditar('guardar-items', 'cotizaciones', p_cotizacion_id::text, v_n || ' renglón(es)', p_op, p_device);
  v_res := jsonb_build_object('cotizacion_id', p_cotizacion_id, 'items', v_n, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'sync_guardar_items_cotizacion', v_hash, p_device, v_res);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text) TO authenticated, service_role;

DO $post$
BEGIN
  IF to_regprocedure('public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'SYNC-5 STOP: sync_guardar_items_cotizacion no quedó creada';
  END IF;
  RAISE NOTICE 'SYNC-5: sync_guardar_items_cotizacion lista.';
END
$post$;
COMMIT;
