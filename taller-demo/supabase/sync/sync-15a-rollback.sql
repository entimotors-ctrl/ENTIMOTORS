-- ENTIMOTORS OS 3.15.0 · BLOQUE 1A · ROLLBACK de sync-15a-cotizacion-inventario.sql · NO EJECUTADO EN PRODUCCIÓN
-- Devuelve convertir_cotizacion y sync_guardar_items_cotizacion a sus cuerpos de SYNC-3 / SYNC-5 (copiados LITERALMENTE de esos
-- archivos) y retira la guarda de cotización aceptada. No toca datos: las órdenes ya convertidas se conservan tal cual.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS cotizacion_aceptada_inmutable ON public.cotizaciones;
DROP FUNCTION IF EXISTS public.cotizacion_aceptada_inmutable();

CREATE OR REPLACE FUNCTION public.convertir_cotizacion(p_op uuid, p_cotizacion_id uuid, p_orden_id uuid DEFAULT NULL,
    p_mecanico_id uuid DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_prev jsonb; v_hash text; c record; v_cli uuid; v_moto uuid; v_orden uuid; r record; v_sin jsonb := '[]'::jsonb;
  v_stock numeric; v_res jsonb; v_mec text; v_marca text;
BEGIN
  IF NOT public.ve_todo_el_taller() THEN RAISE EXCEPTION 'Solo el administrador o el cajero convierten cotizaciones' USING ERRCODE = '42501'; END IF;
  v_hash := md5(jsonb_build_array(p_cotizacion_id, p_orden_id, p_mecanico_id)::text);
  v_prev := public.sync_op_iniciar(p_op, 'convertir_cotizacion', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  SELECT * INTO c FROM public.cotizaciones WHERE id = p_cotizacion_id FOR UPDATE;
  IF NOT FOUND OR c.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'La cotización no existe' USING ERRCODE = '23503'; END IF;
  IF c.estado <> 'pendiente' THEN RAISE EXCEPTION 'La cotización ya fue %', c.estado USING ERRCODE = '22000'; END IF;

  v_cli := c.cliente_id;
  IF v_cli IS NULL THEN INSERT INTO public.clientes (nombre, telefono) VALUES (c.cliente_nombre, COALESCE(c.cliente_telefono, '')) RETURNING id INTO v_cli; END IF;
  v_moto := c.moto_id;
  IF v_moto IS NULL THEN
    v_marca := COALESCE(NULLIF(split_part(COALESCE(c.moto_desc, ''), ' ', 1), ''), '—');
    INSERT INTO public.motos (cliente_id, marca, modelo, km) VALUES (v_cli, v_marca, btrim(substr(COALESCE(c.moto_desc, ''), length(v_marca) + 1)), 0) RETURNING id INTO v_moto;
  END IF;
  SELECT p.nombre INTO v_mec FROM public.perfiles p WHERE p.id = auth.uid();
  v_orden := COALESCE(p_orden_id, gen_random_uuid());
  INSERT INTO public.ordenes (id, cliente_id, moto_id, estado, falla, mecanico, mecanico_id, origen_trabajo, cotizacion_local_id, dispositivo)
  VALUES (v_orden, v_cli, v_moto, 'recibido', COALESCE(NULLIF(c.diagnostico, ''), 'Trabajo cotizado en la cotización ' || substr(c.id::text, 1, 8)),
          COALESCE(v_mec, ''), p_mecanico_id, 'taller', NULL, NULL);

  -- por producto: si alcanza el stock, sale (y las líneas quedan ligadas); si no, las líneas van sin ligar y se avisa (nunca negativo)
  FOR r IN SELECT ci.inventario_id AS inv, sum(ci.cantidad) AS cant FROM public.cotizacion_items ci
            WHERE ci.cotizacion_id = c.id AND ci.inventario_id IS NOT NULL GROUP BY ci.inventario_id ORDER BY ci.inventario_id LOOP
    SELECT i.cantidad INTO v_stock FROM public.inventario i WHERE i.id = r.inv AND i.deleted_at IS NULL FOR UPDATE;
    IF FOUND AND v_stock >= r.cant THEN
      PERFORM public.sync_stock_mover(r.inv, -r.cant, 'orden_item', p_op, false, clock_timestamp(), NULL, NULL, v_orden);
    ELSE
      v_sin := v_sin || to_jsonb(r.inv);
    END IF;
  END LOOP;
  INSERT INTO public.orden_items (orden_id, inventario_id, nombre, cantidad, precio, costo_unitario, costo_estimado, created_by)
  SELECT v_orden, CASE WHEN ci.inventario_id IS NOT NULL AND NOT (to_jsonb(ci.inventario_id) <@ v_sin) THEN ci.inventario_id END,
         ci.nombre, ci.cantidad, ci.precio,
         CASE WHEN ci.inventario_id IS NOT NULL AND NOT (to_jsonb(ci.inventario_id) <@ v_sin) THEN COALESCE(i.costo_compra, 0) ELSE 0 END, false, auth.uid()
    FROM public.cotizacion_items ci LEFT JOIN public.inventario i ON i.id = ci.inventario_id WHERE ci.cotizacion_id = c.id;

  UPDATE public.cotizaciones SET estado = 'aceptada', orden_id = v_orden, aceptada_en = clock_timestamp(), cliente_id = v_cli, moto_id = v_moto, last_op_id = p_op WHERE id = c.id;
  PERFORM public.sync_auditar('convertir', 'cotizaciones', c.id::text, 'Orden ' || v_orden, p_op, p_device);
  v_res := jsonb_build_object('orden_id', v_orden, 'cliente_id', v_cli, 'moto_id', v_moto, 'sin_stock', v_sin, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'convertir_cotizacion', v_hash, p_device, v_res);
END
$function$;

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

REVOKE EXECUTE ON FUNCTION public.convertir_cotizacion(uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_cotizacion(uuid,uuid,uuid,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text) TO authenticated, service_role;
COMMIT;
