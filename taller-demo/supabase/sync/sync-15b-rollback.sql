-- ENTIMOTORS OS 3.15.0 · BLOQUE 2 · ROLLBACK de sync-15b-presupuestos-stock.sql · NO EJECUTADO EN PRODUCCIÓN
-- Vuelve a SYNC-3 (agregar/quitar/finalizar/anular/verificar_invariantes) y a sync-15a (convertir_cotizacion, sync_guardar_items_cotizacion),
-- cuerpos copiados LITERALMENTE de esos archivos; quita las funciones, el índice, las restricciones y las columnas de 3.15. No mueve stock.
-- SE NIEGA si ya hubo actividad de 3.15 (renglones, movimientos o decisiones de presupuesto posteriores a la migración): tras operar con 3.15,
-- volver a las funciones 3.14 (que asumen «renglón = stock consumido») descuadraría el inventario. Forzar solo a sabiendas:
--   PGOPTIONS="-c sync.forzar_rollback=si"                                  (local)
--   psql -c "SET sync.forzar_rollback = 'si'" -f sync-15b-rollback.sql      (pooler de Supabase: ignora PGOPTIONS; misma sesión)
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE t timestamptz; n int;
BEGIN
  SELECT aplicada_en INTO t FROM public.sync_fases WHERE fase = '15b';
  IF t IS NULL THEN RETURN; END IF;
  SELECT (SELECT count(*) FROM public.inventario_movimientos WHERE creado_en > t)
       + (SELECT count(*) FROM public.orden_items WHERE creado_en > t)
       + (SELECT count(*) FROM public.ordenes WHERE aprobado_en > t OR rechazado_en > t)
       + (SELECT count(*) FROM public.cotizacion_items WHERE tipo IN ('mano_obra', 'repuesto_manual')) INTO n;
  IF n > 0 AND COALESCE(current_setting('sync.forzar_rollback', true), '') <> 'si' THEN
    RAISE EXCEPTION 'ROLLBACK STOP: hay % registro(s) de actividad 3.15 posteriores a la migración; volver a 3.14 descuadraría el stock', n;
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.decidir_presupuesto_orden(uuid,uuid,text,text,text);
DROP FUNCTION IF EXISTS public.actualizar_item_orden(uuid,uuid,numeric,numeric,text,uuid,text,text);
DROP FUNCTION IF EXISTS public.agregar_item_orden(uuid,uuid,uuid,text,numeric,numeric,uuid,boolean,timestamptz,text,text);
DROP FUNCTION IF EXISTS public.sync_reconciliar_orden(uuid,uuid,uuid,text);
DROP FUNCTION IF EXISTS public.sync_verificar_existencias(uuid,text);
DROP FUNCTION IF EXISTS public.sync_reconciliar_renglon(uuid,numeric,uuid,uuid,text);
DROP FUNCTION IF EXISTS public.sync_objetivo_renglon(text,boolean,text,numeric,numeric);
DROP FUNCTION IF EXISTS public.sync_tipo_renglon(text,uuid);

CREATE OR REPLACE FUNCTION public.agregar_item_orden(p_op uuid, p_orden_id uuid, p_inventario_id uuid, p_nombre text,
    p_cantidad numeric, p_precio numeric, p_item_id uuid DEFAULT NULL, p_offline boolean DEFAULT false,
    p_occurred_at timestamptz DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; o record; v_item uuid; v_occ timestamptz; v_off boolean; v_saldo numeric; v_costo numeric := 0; v_nom text; v_res jsonb;
BEGIN
  IF NOT public.ve_todo_el_taller() THEN RAISE EXCEPTION 'Solo el administrador o el cajero agregan ítems' USING ERRCODE = '42501'; END IF;
  IF p_cantidad IS NULL OR p_cantidad <= 0 OR p_precio IS NULL OR p_precio < 0 THEN RAISE EXCEPTION 'Cantidad y precio deben ser válidos' USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_orden_id, p_inventario_id, p_nombre, p_cantidad, p_precio, p_item_id, p_offline, p_occurred_at)::text);
  v_prev := public.sync_op_iniciar(p_op, 'agregar_item_orden', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  SELECT ord.id, ord.finalizada, ord.anulada, ord.deleted_at INTO o FROM public.ordenes ord WHERE ord.id = p_orden_id FOR UPDATE;
  IF NOT FOUND OR o.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'La orden no existe' USING ERRCODE = '23503'; END IF;
  IF o.finalizada OR o.anulada THEN RAISE EXCEPTION 'La orden ya está cerrada: no admite más ítems' USING ERRCODE = '22000'; END IF;
  v_occ := LEAST(COALESCE(p_occurred_at, clock_timestamp()), clock_timestamp());
  v_off := COALESCE(p_offline, false) AND v_occ < clock_timestamp() - interval '20 seconds';
  v_item := COALESCE(p_item_id, gen_random_uuid());
  v_nom := p_nombre;
  IF p_inventario_id IS NOT NULL THEN
    SELECT i.costo_compra, i.nombre INTO v_costo, v_nom FROM public.inventario i WHERE i.id = p_inventario_id AND i.deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'El repuesto ya no existe en el inventario' USING ERRCODE = '23503'; END IF;
    v_saldo := public.sync_stock_mover(p_inventario_id, -p_cantidad, 'orden_item', p_op, v_off, v_occ, NULL, NULL, p_orden_id, v_item);
  END IF;
  IF COALESCE(btrim(v_nom), '') = '' THEN RAISE EXCEPTION 'Falta el nombre del ítem' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.orden_items (id, orden_id, inventario_id, nombre, cantidad, precio, costo_unitario, costo_estimado, created_by)
  VALUES (v_item, p_orden_id, p_inventario_id, v_nom, p_cantidad, p_precio, COALESCE(v_costo, 0), false, auth.uid());
  UPDATE public.ordenes SET last_op_id = p_op WHERE id = p_orden_id;          -- sube updated_at/rev para la descarga
  PERFORM public.sync_auditar('agregar-item', 'ordenes', p_orden_id::text, v_nom || ' x' || p_cantidad || ' a ' || p_precio, p_op, p_device);
  v_res := jsonb_build_object('item_id', v_item, 'saldo_stock', v_saldo, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'agregar_item_orden', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.quitar_item_orden(p_op uuid, p_item_id uuid, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; it record; o record; v_res jsonb; v_saldo numeric;
BEGIN
  IF NOT public.ve_todo_el_taller() THEN RAISE EXCEPTION 'Solo el administrador o el cajero quitan ítems' USING ERRCODE = '42501'; END IF;
  v_hash := md5(p_item_id::text);
  v_prev := public.sync_op_iniciar(p_op, 'quitar_item_orden', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  SELECT oi.id, oi.orden_id, oi.inventario_id, oi.cantidad, oi.nombre INTO it FROM public.orden_items oi WHERE oi.id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El ítem ya no existe' USING ERRCODE = '23503'; END IF;
  SELECT ord.finalizada, ord.anulada INTO o FROM public.ordenes ord WHERE ord.id = it.orden_id FOR UPDATE;
  IF o.finalizada OR o.anulada THEN RAISE EXCEPTION 'La orden ya está cerrada: no se quitan ítems' USING ERRCODE = '22000'; END IF;
  IF it.inventario_id IS NOT NULL THEN
    v_saldo := public.sync_stock_mover(it.inventario_id, it.cantidad, 'reverso_item_orden', p_op, false, clock_timestamp(), NULL, NULL, it.orden_id, it.id, NULL, 'Ítem quitado de la orden');
  END IF;
  DELETE FROM public.orden_items WHERE id = p_item_id;
  UPDATE public.ordenes SET last_op_id = p_op WHERE id = it.orden_id;
  PERFORM public.sync_auditar('quitar-item', 'ordenes', it.orden_id::text, it.nombre || ' x' || it.cantidad, p_op, p_device);
  v_res := jsonb_build_object('devuelto', it.cantidad, 'saldo_stock', v_saldo, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'quitar_item_orden', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.finalizar_orden(p_op uuid, p_orden_id uuid, p_tipo_cobro text, p_metodo_pago text DEFAULT NULL,
    p_abono numeric DEFAULT 0, p_abono_metodo text DEFAULT NULL, p_vencimiento date DEFAULT NULL,
    p_occurred_at timestamptz DEFAULT NULL, p_device text DEFAULT NULL, p_credito_id uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_prev jsonb; v_hash text; o record; v_total numeric; v_costo numeric; v_margen numeric; v_occ timestamptz;
  v_credito uuid; v_cli record; v_res jsonb; v_ab jsonb;
BEGIN
  IF NOT public.puede_cobrar() THEN RAISE EXCEPTION 'Este usuario no tiene permiso para cobrar' USING ERRCODE = '42501'; END IF;
  IF p_tipo_cobro NOT IN ('contado', 'credito') THEN RAISE EXCEPTION 'tipo_cobro debe ser contado o credito' USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_orden_id, p_tipo_cobro, p_metodo_pago, p_abono, p_abono_metodo, p_vencimiento, p_occurred_at, p_credito_id)::text);
  v_prev := public.sync_op_iniciar(p_op, 'finalizar_orden', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  SELECT * INTO o FROM public.ordenes WHERE id = p_orden_id FOR UPDATE;
  IF NOT FOUND OR o.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'La orden no existe' USING ERRCODE = '23503'; END IF;
  IF o.finalizada THEN RAISE EXCEPTION 'Esta orden ya estaba finalizada: no se vuelve a cobrar' USING ERRCODE = '22000'; END IF;
  IF o.anulada THEN RAISE EXCEPTION 'La orden está anulada' USING ERRCODE = '22000'; END IF;
  IF o.estado <> 'entregado' THEN RAISE EXCEPTION 'La orden debe estar entregada para finalizarla' USING ERRCODE = '22000'; END IF;
  v_occ := LEAST(COALESCE(p_occurred_at, clock_timestamp()), clock_timestamp());

  SELECT COALESCE(sum(cantidad * precio), 0), COALESCE(sum(CASE WHEN inventario_id IS NOT NULL THEN costo_unitario * cantidad ELSE 0 END), 0)
    INTO v_total, v_costo FROM public.orden_items WHERE orden_id = p_orden_id;
  v_total := round(v_total, 2);
  v_margen := CASE WHEN v_total > 0 THEN round(((v_total - v_costo) / v_total) * 100, 2) END;

  IF v_total > 0 AND p_tipo_cobro = 'credito' THEN
    SELECT c.nombre, c.telefono INTO v_cli FROM public.clientes c WHERE c.id = o.cliente_id;
    IF LEAST(COALESCE(p_abono, 0), v_total) > 0 AND COALESCE(p_abono, 0) > v_total + 0.01 THEN
      RAISE EXCEPTION 'La entrada supera el total' USING ERRCODE = '23514';
    END IF;
    -- el stock ya salió cuando se agregó cada repuesto: el crédito NO vuelve a descontarlo (inventario_id nulo)
    v_credito := COALESCE(p_credito_id, gen_random_uuid());
    INSERT INTO public.creditos (id, cliente_id, cliente_nombre, cliente_telefono, total, abonado, saldo, estado, origen, orden_id, nota,
        vencimiento, mecanico, mecanico_id, occurred_at, op_id)
    VALUES (v_credito, o.cliente_id, COALESCE(v_cli.nombre, 'Cliente'), v_cli.telefono, v_total, 0, v_total, 'pendiente', 'orden', p_orden_id,
        'Orden de taller #' || substr(p_orden_id::text, 1, 8), p_vencimiento, (SELECT p.nombre FROM public.perfiles p WHERE p.id = auth.uid()), auth.uid(), v_occ, p_op);
    INSERT INTO public.credito_items (credito_id, inventario_id, nombre, cantidad, precio, costo_unitario)
    SELECT v_credito, NULL, nombre, cantidad, precio, costo_unitario FROM public.orden_items WHERE orden_id = p_orden_id;
    IF COALESCE(p_abono, 0) > 0 THEN
      v_ab := public.sync_abonar(v_credito, LEAST(p_abono, v_total), COALESCE(p_abono_metodo, 'efectivo'), v_occ, NULL, p_op::text || ':ini');
    END IF;
  ELSIF v_total > 0 THEN
    PERFORM public.sync_caja('ingreso', 'Servicio taller', v_total, COALESCE(p_metodo_pago, 'efectivo'),
                             'Orden de taller #' || substr(p_orden_id::text, 1, 8), v_occ, p_op, NULL, NULL, p_orden_id);
  END IF;

  UPDATE public.ordenes SET finalizada = true, finalizado_en = v_occ, entregado_en = COALESCE(entregado_en, v_occ),
         margen = v_margen, tipo_cobro = p_tipo_cobro, metodo_pago = COALESCE(p_metodo_pago, 'efectivo'), abono_inicial = p_abono,
         abono_metodo = COALESCE(p_abono_metodo, 'efectivo'), credito_id = v_credito, last_op_id = p_op
   WHERE id = p_orden_id;
  PERFORM public.sync_auditar('finalizar', 'ordenes', p_orden_id::text, 'Total ' || v_total || ' · ' || p_tipo_cobro, p_op, p_device);
  v_res := jsonb_build_object('orden_id', p_orden_id, 'total', v_total, 'margen', v_margen, 'credito_id', v_credito, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'finalizar_orden', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.anular_orden(p_op uuid, p_orden_id uuid, p_motivo text, p_devolver_stock boolean DEFAULT false,
    p_autorizacion uuid DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; o record; a record; it record; v_dinero boolean; v_rev uuid; v_cred record; v_comp numeric := 0; v_res jsonb; v_modo text; v_aut uuid;
BEGIN
  IF COALESCE(length(btrim(p_motivo)), 0) < 3 THEN RAISE EXCEPTION 'El motivo es obligatorio' USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_orden_id, p_motivo, p_devolver_stock)::text);
  v_prev := public.sync_op_iniciar(p_op, 'anular_orden', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  SELECT * INTO o FROM public.ordenes WHERE id = p_orden_id FOR UPDATE;
  IF NOT FOUND OR o.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'La orden no existe' USING ERRCODE = '23503'; END IF;
  IF o.anulada THEN RAISE EXCEPTION 'La orden ya está anulada' USING ERRCODE = '22000'; END IF;
  v_dinero := o.finalizada OR EXISTS (SELECT 1 FROM public.caja_movimientos c WHERE c.orden_id = p_orden_id)
              OR EXISTS (SELECT 1 FROM public.creditos c WHERE c.orden_id = p_orden_id);
  IF NOT v_dinero THEN
    IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador elimina órdenes' USING ERRCODE = '42501'; END IF;
    v_modo := 'eliminar';
    v_rev := public.sync_registrar_reverso('orden', 'ordenes', p_orden_id, p_motivo, p_op, p_device, NULL, true, NULL, jsonb_build_object('modo', v_modo));
    -- la orden nunca se cobró: los repuestos que se le agregaron vuelven al inventario (antes se perdían al borrarla)
    FOR it IN SELECT oi.id, oi.inventario_id, oi.cantidad FROM public.orden_items oi WHERE oi.orden_id = p_orden_id AND oi.inventario_id IS NOT NULL ORDER BY oi.inventario_id, oi.id LOOP
      PERFORM public.sync_stock_mover(it.inventario_id, it.cantidad, 'reverso_item_orden', NULL, true, clock_timestamp(), NULL, NULL, p_orden_id, it.id, v_rev, p_motivo);
    END LOOP;
    UPDATE public.ordenes SET deleted_at = clock_timestamp(), last_op_id = p_op WHERE id = p_orden_id;
  ELSE
    v_modo := 'anular';
    SELECT * INTO a FROM jsonb_to_record(public.sync_autorizar(p_autorizacion, 'anular_orden', 'ordenes', p_orden_id, p_op, NULL, p_device)) AS x(o_autorizado uuid, o_admin boolean);
    v_aut := a.o_autorizado;
    v_rev := public.sync_registrar_reverso('orden', 'ordenes', p_orden_id, p_motivo, p_op, p_device, a.o_autorizado, a.o_admin, p_autorizacion, jsonb_build_object('modo', v_modo, 'devolver_stock', p_devolver_stock));
    v_comp := public.sync_compensar_caja('orden_id', p_orden_id, 'Reverso de orden', clock_timestamp(), 'Anulación de orden #' || substr(p_orden_id::text, 1, 8));
    FOR v_cred IN SELECT id FROM public.creditos WHERE orden_id = p_orden_id AND NOT anulado LOOP
      v_comp := v_comp + public.sync_reversar_credito_i(v_cred.id, v_rev, p_motivo, false);
    END LOOP;
    IF p_devolver_stock THEN
      FOR it IN SELECT oi.id, oi.inventario_id, oi.cantidad FROM public.orden_items oi WHERE oi.orden_id = p_orden_id AND oi.inventario_id IS NOT NULL ORDER BY oi.inventario_id, oi.id LOOP
        PERFORM public.sync_stock_mover(it.inventario_id, it.cantidad, 'reverso_item_orden', NULL, true, clock_timestamp(), NULL, NULL, p_orden_id, it.id, v_rev, p_motivo);
      END LOOP;
    END IF;
    UPDATE public.ordenes SET anulada = true, anulada_en = clock_timestamp(), last_op_id = p_op WHERE id = p_orden_id;
  END IF;
  PERFORM public.sync_auditar('anular-orden', 'ordenes', p_orden_id::text, v_modo || ': ' || p_motivo, p_op, p_device, v_aut);
  v_res := jsonb_build_object('reverso_id', v_rev, 'modo', v_modo, 'compensado', v_comp, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'anular_orden', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.verificar_invariantes()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '[]'::jsonb; r record;
BEGIN
  IF NOT public.es_admin() AND auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'Solo el administrador' USING ERRCODE = '42501'; END IF;
  FOR r IN SELECT i.id, i.cantidad, COALESCE(sum(m.cantidad), 0) AS ledger FROM public.inventario i
             LEFT JOIN public.inventario_movimientos m ON m.inventario_id = i.id GROUP BY i.id, i.cantidad HAVING i.cantidad <> COALESCE(sum(m.cantidad), 0) LOOP
    v := v || jsonb_build_object('invariante', 'stock=ledger', 'inventario_id', r.id, 'cantidad', r.cantidad, 'ledger', r.ledger);
  END LOOP;
  FOR r IN SELECT i.id FROM public.inventario i WHERE i.cantidad < 0 AND NOT i.requiere_revision LOOP
    v := v || jsonb_build_object('invariante', 'negativo_sin_revision', 'inventario_id', r.id);
  END LOOP;
  FOR r IN SELECT c.id, c.total, c.abonado, c.saldo, COALESCE(sum(a.monto) FILTER (WHERE NOT a.anulado), 0) AS vigentes
             FROM public.creditos c LEFT JOIN public.abonos a ON a.credito_id = c.id GROUP BY c.id, c.total, c.abonado, c.saldo
           HAVING abs(c.abonado - COALESCE(sum(a.monto) FILTER (WHERE NOT a.anulado), 0)) > 0.01 OR abs(c.saldo - (c.total - c.abonado)) > 0.01 LOOP
    v := v || jsonb_build_object('invariante', 'saldo=total-abonos_vigentes', 'credito_id', r.id, 'abonado', r.abonado, 'vigentes', r.vigentes);
  END LOOP;
  FOR r IN SELECT ve.id, ve.total, COALESCE(sum(vi.cantidad * vi.precio), 0) AS lineas FROM public.ventas ve
             LEFT JOIN public.venta_items vi ON vi.venta_id = ve.id GROUP BY ve.id, ve.total HAVING abs(ve.total - COALESCE(sum(vi.cantidad * vi.precio), 0)) > 0.01 LOOP
    v := v || jsonb_build_object('invariante', 'venta=suma_de_renglones', 'venta_id', r.id, 'total', r.total, 'lineas', r.lineas);
  END LOOP;
  RETURN v;
END
$function$;

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

DROP INDEX IF EXISTS public.inventario_movimientos_op_renglon_uq;
DROP INDEX IF EXISTS public.inventario_mov_op_uidx;
CREATE UNIQUE INDEX inventario_mov_op_uidx ON public.inventario_movimientos (op_id, inventario_id, tipo) WHERE op_id IS NOT NULL;
ALTER TABLE public.cotizacion_items DROP CONSTRAINT IF EXISTS cotizacion_items_tipo_chk;
ALTER TABLE public.orden_items DROP CONSTRAINT IF EXISTS orden_items_tipo_chk;
ALTER TABLE public.orden_items DROP CONSTRAINT IF EXISTS orden_items_aplicada_chk;
ALTER TABLE public.ordenes DROP CONSTRAINT IF EXISTS ordenes_presupuesto_estado_chk;
ALTER TABLE public.cotizacion_items DROP COLUMN IF EXISTS tipo;
ALTER TABLE public.orden_items DROP COLUMN IF EXISTS tipo, DROP COLUMN IF EXISTS cantidad_aplicada, DROP COLUMN IF EXISTS aplicada_legado;
ALTER TABLE public.ordenes DROP COLUMN IF EXISTS presupuesto_estado, DROP COLUMN IF EXISTS aprobado_en, DROP COLUMN IF EXISTS aprobado_por,
  DROP COLUMN IF EXISTS rechazado_en, DROP COLUMN IF EXISTS aprobacion_via;
DROP TABLE IF EXISTS public.sync_fases;

REVOKE EXECUTE ON FUNCTION public.agregar_item_orden(uuid,uuid,uuid,text,numeric,numeric,uuid,boolean,timestamptz,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agregar_item_orden(uuid,uuid,uuid,text,numeric,numeric,uuid,boolean,timestamptz,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.quitar_item_orden(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quitar_item_orden(uuid,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.finalizar_orden(uuid,uuid,text,text,numeric,text,date,timestamptz,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalizar_orden(uuid,uuid,text,text,numeric,text,date,timestamptz,text,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.anular_orden(uuid,uuid,text,boolean,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anular_orden(uuid,uuid,text,boolean,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.verificar_invariantes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verificar_invariantes() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.convertir_cotizacion(uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_cotizacion(uuid,uuid,uuid,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text) TO authenticated, service_role;
COMMIT;
