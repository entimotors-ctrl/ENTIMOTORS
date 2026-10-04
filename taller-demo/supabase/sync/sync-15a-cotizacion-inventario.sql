-- ENTIMOTORS OS 3.15.0 · BLOQUE 1A · COTIZACIÓN ↔ INVENTARIO + CONVERSIÓN ATÓMICA · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere la cadena SYNC 1..10 (+ sec-1c) aplicada. Idempotente.
--
-- 1) convertir_cotizacion (misma firma de SYNC-3): la conversión de una cotización en orden es UNA transacción e idempotente
--    por operation_id (sync_op_iniciar + candado), y la cotización se bloquea con FOR UPDATE: de dos dispositivos que acepten a
--    la vez, uno crea la orden y el otro recibe COTIZACION_YA_ACEPTADA (terminal, con el id de la orden en DETAIL). Cambios:
--    · NO MUEVE STOCK. Cada renglón de inventario pasa a la orden CON su inventario_id (antes, si no alcanzaba el stock, se
--      soltaba el vínculo y se descontaba por producto). El descuento exactamente-una-vez al APROBAR es del Bloque 2; así no hay
--      que desmontar nada: la conversión solo copia, y el Bloque 2 decide cuándo aplica el stock de cada renglón.
--    · Precio histórico: el renglón de la orden copia el precio de la cotización (no el precio actual del producto); el costo se
--      sella con el costo de compra del momento de la conversión.
--    · Mecánico solo por uuid real (D-5): el texto `mecanico` sale de ese perfil, nunca del nombre de quien convierte.
--    · Se aceptan cotizaciones 'pendiente' y 'rechazada' (el cliente puede cambiar de opinión); nunca una 'aceptada'.
--    · La moto que se crea (si la cotización no tenía) se arma desde «Marca Modelo · placa X» sin meter la placa en el modelo.
-- 2) sync_guardar_items_cotizacion (misma firma de SYNC-5): rechaza editar renglones de una cotización ya aceptada.
-- 3) Guarda en cotizaciones: una cotización aceptada no vuelve a otro estado y su orden_id no cambia (ni por el CRUD ni por un
--    cliente 3.14.1 viejo): impide una segunda conversión aunque alguien edite el estado a mano.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regprocedure('public.convertir_cotizacion(uuid,uuid,uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text)') IS NULL
     OR to_regclass('public.cotizaciones') IS NULL OR to_regclass('public.orden_items') IS NULL THEN
    RAISE EXCEPTION 'SYNC-15A STOP: faltan SYNC-3/SYNC-5';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.convertir_cotizacion(p_op uuid, p_cotizacion_id uuid, p_orden_id uuid DEFAULT NULL,
    p_mecanico_id uuid DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_prev jsonb; v_hash text; c record; v_cli uuid; v_moto uuid; v_orden uuid; v_res jsonb; v_mec text := '';
  v_desc text; v_placa text; v_mm text; v_marca text; v_n int; v_inv int;
BEGIN
  IF NOT public.ve_todo_el_taller() THEN RAISE EXCEPTION 'Solo el administrador o el cajero convierten cotizaciones' USING ERRCODE = '42501'; END IF;
  IF p_cotizacion_id IS NULL THEN RAISE EXCEPTION 'Falta la cotización' USING ERRCODE = '22004'; END IF;
  v_hash := md5(jsonb_build_array(p_cotizacion_id, p_orden_id, p_mecanico_id)::text);
  v_prev := public.sync_op_iniciar(p_op, 'convertir_cotizacion', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  SELECT * INTO c FROM public.cotizaciones WHERE id = p_cotizacion_id FOR UPDATE;
  IF NOT FOUND OR c.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'La cotización no existe' USING ERRCODE = '23503'; END IF;
  IF c.estado = 'aceptada' OR c.orden_id IS NOT NULL THEN
    RAISE EXCEPTION 'COTIZACION_YA_ACEPTADA: esta cotización ya se convirtió en una orden' USING ERRCODE = '22000', DETAIL = COALESCE(c.orden_id::text, '');
  END IF;
  IF c.estado NOT IN ('pendiente', 'rechazada') THEN RAISE EXCEPTION 'La cotización está en estado «%» y no se puede convertir', c.estado USING ERRCODE = '22000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cotizacion_items ci WHERE ci.cotizacion_id = c.id) THEN
    RAISE EXCEPTION 'La cotización no tiene renglones' USING ERRCODE = '22023';
  END IF;
  IF p_mecanico_id IS NOT NULL THEN
    SELECT p.nombre INTO v_mec FROM public.perfiles p WHERE p.id = p_mecanico_id AND p.rol = 'mecanico' AND p.activo;
    IF NOT FOUND THEN RAISE EXCEPTION 'El mecánico indicado no existe o no está activo' USING ERRCODE = '23503'; END IF;
  END IF;

  v_cli := c.cliente_id;
  IF v_cli IS NULL THEN
    INSERT INTO public.clientes (nombre, telefono) VALUES (c.cliente_nombre, COALESCE(c.cliente_telefono, '')) RETURNING id INTO v_cli;
  END IF;
  v_moto := c.moto_id;
  IF v_moto IS NULL THEN
    -- moto_desc la arma la app como «Marca Modelo · placa X» (cualquiera de las partes puede faltar)
    v_desc := btrim(COALESCE(c.moto_desc, ''));
    v_placa := NULLIF(btrim(substring(v_desc FROM '·\s*placa\s+(.*)$')), '');
    v_mm := btrim(regexp_replace(v_desc, '\s*·?\s*placa\s+.*$', ''));
    v_marca := COALESCE(NULLIF(split_part(v_mm, ' ', 1), ''), '—');
    INSERT INTO public.motos (cliente_id, marca, modelo, placa, km)
    VALUES (v_cli, v_marca, NULLIF(btrim(substr(v_mm, length(split_part(v_mm, ' ', 1)) + 1)), ''), v_placa, 0) RETURNING id INTO v_moto;
  END IF;

  v_orden := COALESCE(p_orden_id, gen_random_uuid());
  INSERT INTO public.ordenes (id, cliente_id, moto_id, estado, falla, mecanico, mecanico_id, origen_trabajo, cotizacion_local_id, dispositivo)
  VALUES (v_orden, v_cli, v_moto, 'recibido', COALESCE(NULLIF(c.diagnostico, ''), 'Trabajo cotizado en la cotización ' || substr(c.id::text, 1, 8)),
          COALESCE(v_mec, ''), p_mecanico_id, 'taller', c.local_id, p_device);

  -- copia fiel de los renglones: el producto de origen (inventario_id) se conserva SIEMPRE; precio = el de la cotización
  -- (histórico); costo = costo de compra de hoy. Sin movimiento de stock: eso lo decide la aprobación (Bloque 2).
  -- creado_en escalonado 1 µs por renglón: la orden conserva el orden de los renglones de la cotización (la app los ordena así)
  INSERT INTO public.orden_items (orden_id, inventario_id, nombre, cantidad, precio, costo_unitario, costo_estimado, created_by, creado_en)
  SELECT v_orden, ci.inventario_id, ci.nombre, ci.cantidad, ci.precio,
         CASE WHEN ci.inventario_id IS NOT NULL THEN COALESCE(i.costo_compra, 0) ELSE 0 END, false, auth.uid(),
         clock_timestamp() + (row_number() OVER (ORDER BY ci.ctid)) * interval '1 microsecond'
    FROM public.cotizacion_items ci LEFT JOIN public.inventario i ON i.id = ci.inventario_id
   WHERE ci.cotizacion_id = c.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  SELECT count(*) INTO v_inv FROM public.cotizacion_items ci WHERE ci.cotizacion_id = c.id AND ci.inventario_id IS NOT NULL;

  UPDATE public.cotizaciones SET estado = 'aceptada', orden_id = v_orden, aceptada_en = clock_timestamp(), cliente_id = v_cli, moto_id = v_moto,
         last_op_id = p_op WHERE id = c.id;
  PERFORM public.sync_auditar('convertir', 'cotizaciones', c.id::text, 'Orden ' || v_orden || ' · ' || v_n || ' renglón(es), ' || v_inv || ' de inventario', p_op, p_device);
  v_res := jsonb_build_object('orden_id', v_orden, 'cliente_id', v_cli, 'moto_id', v_moto, 'items', v_n, 'items_inventario', v_inv,
                              'stock_movido', false, 'sin_stock', '[]'::jsonb, 'repetida', false);
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

  SELECT co.id, co.deleted_at, co.estado, co.orden_id INTO c FROM public.cotizaciones co WHERE co.id = p_cotizacion_id FOR UPDATE;
  IF NOT FOUND OR c.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'La cotización no existe' USING ERRCODE = '23503'; END IF;
  -- 3.15 (Bloque 1A): lo que manda tras aceptar es la orden; los renglones de una cotización aceptada ya no se reemplazan
  IF c.estado = 'aceptada' OR c.orden_id IS NOT NULL THEN
    RAISE EXCEPTION 'COTIZACION_YA_ACEPTADA: sus renglones ya no se editan (manda la orden)' USING ERRCODE = '22000';
  END IF;

  DELETE FROM public.cotizacion_items WHERE cotizacion_id = p_cotizacion_id;
  FOR x IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF COALESCE(btrim(x->>'nombre'), '') = '' THEN RAISE EXCEPTION 'Falta el nombre de un renglón' USING ERRCODE = '22023'; END IF;
    IF NOT (x ? 'cantidad') OR (x->>'cantidad')::numeric <= 0 THEN RAISE EXCEPTION 'La cantidad de «%» debe ser mayor a cero', x->>'nombre' USING ERRCODE = '22023'; END IF;
    IF NOT (x ? 'precio') OR (x->>'precio')::numeric < 0 THEN RAISE EXCEPTION 'El precio de «%» no puede ser negativo', x->>'nombre' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.cotizacion_items (cotizacion_id, inventario_id, nombre, cantidad, precio)
    VALUES (p_cotizacion_id, NULLIF(x->>'inventario_id', '')::uuid, x->>'nombre', (x->>'cantidad')::numeric, (x->>'precio')::numeric);
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.cotizaciones SET last_op_id = p_op WHERE id = p_cotizacion_id;
  PERFORM public.sync_auditar('guardar-items', 'cotizaciones', p_cotizacion_id::text, v_n || ' renglón(es)', p_op, p_device);
  v_res := jsonb_build_object('cotizacion_id', p_cotizacion_id, 'items', v_n, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'sync_guardar_items_cotizacion', v_hash, p_device, v_res);
END
$function$;

-- Guarda: una cotización aceptada no se «des-acepta» ni cambia de orden (aplica a todos: CRUD, clientes viejos y service_role).
CREATE OR REPLACE FUNCTION public.cotizacion_aceptada_inmutable()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.orden_id IS NOT NULL AND NEW.orden_id IS DISTINCT FROM OLD.orden_id THEN
    RAISE EXCEPTION 'COTIZACION_YA_ACEPTADA: la orden de esta cotización no se cambia' USING ERRCODE = '22000';
  END IF;
  IF OLD.estado = 'aceptada' AND NEW.estado IS DISTINCT FROM 'aceptada' THEN
    RAISE EXCEPTION 'COTIZACION_YA_ACEPTADA: una cotización aceptada no vuelve a otro estado' USING ERRCODE = '22000';
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS cotizacion_aceptada_inmutable ON public.cotizaciones;
CREATE TRIGGER cotizacion_aceptada_inmutable BEFORE UPDATE ON public.cotizaciones FOR EACH ROW EXECUTE FUNCTION public.cotizacion_aceptada_inmutable();

REVOKE EXECUTE ON FUNCTION public.convertir_cotizacion(uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_cotizacion(uuid,uuid,uuid,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.cotizacion_aceptada_inmutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cotizacion_aceptada_inmutable() TO service_role;

DO $post$
BEGIN
  IF position('sync_stock_mover' IN (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.convertir_cotizacion(uuid,uuid,uuid,uuid,text)'))) > 0 THEN
    RAISE EXCEPTION 'SYNC-15A STOP: convertir_cotizacion todavía mueve stock';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cotizacion_aceptada_inmutable' AND tgrelid = 'public.cotizaciones'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'SYNC-15A STOP: falta la guarda de cotización aceptada';
  END IF;
  IF has_function_privilege('anon', 'public.convertir_cotizacion(uuid,uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SYNC-15A STOP: anon ejecuta convertir_cotizacion';
  END IF;
  RAISE NOTICE 'SYNC-15A: convertir_cotizacion sin stock + guarda de aceptada listas.';
END
$post$;
COMMIT;
