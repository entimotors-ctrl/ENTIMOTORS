-- ENTIMOTORS OS 3.15.0 · BLOQUE 2 · PRESUPUESTOS + INVENTARIO + STOCK (modelo definitivo) · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere la cadena SYNC 1..10 + sync-15a. Idempotente. NO MUEVE STOCK al aplicarse.
--
-- MODELO
--  · Tipo de renglón explícito (cotizacion_items.tipo, orden_items.tipo): 'mano_obra' | 'repuesto_inventario' | 'repuesto_manual'.
--    repuesto_inventario ⇔ inventario_id NOT NULL. NULL = «sin clasificar» (solo renglones manuales anteriores a 3.15: nunca se infiere
--    por el texto). Solo repuesto_inventario toca stock.
--  · Estado del presupuesto de la orden (ordenes.presupuesto_estado): 'pendiente' | 'aprobado' | 'rechazado'. Sin reservas: pendiente y
--    rechazado no descuentan; aprobar descuenta; lo decide SOLO el servidor (RPC), nunca el CRUD.
--  · Cada renglón lleva orden_items.cantidad_aplicada = stock que consume HOY, y aplicada_legado = la parte consumida antes de 3.15 SIN
--    fila en el ledger (p. ej. descontada en la 3.13 y traída ya descontada por la importación). Invariante (verificar_invariantes):
--        −Σ ledger(orden_item_id) = cantidad_aplicada − aplicada_legado
--  · Toda operación RECONCILIA el renglón a su objetivo y mueve solo la diferencia (sync_reconciliar_renglon), con la orden y el renglón
--    bloqueados (FOR UPDATE) y el stock bloqueado por producto: aprobar dos veces, reintentar, dos pestañas o dos dispositivos llegan al
--    mismo objetivo y la diferencia ya es 0 → exactamente una vez. Nunca stock negativo (p_offline=false en sync_stock_mover). Respaldo
--    físico: índice único (op_id, orden_item_id, inventario_id) en el ledger.
--        objetivo = 0                          si la orden está anulada/borrada o el presupuesto rechazado, o el renglón no es de inventario
--                 = cantidad                   si el presupuesto está aprobado
--                 = LEAST(aplicada, cantidad)  si está pendiente (solo conserva lo que un renglón ANTERIOR a 3.15 ya había consumido)
--  · Precio y costo históricos: el renglón guarda su precio (el que se cotizó/editó) y su costo_unitario, sellado al aplicarse por primera
--    vez; cambiar el precio o el costo del producto después no lo altera.
--
-- COMPATIBILIDAD 3.14.1 (backfill sin tocar el ledger ni inventario.cantidad):
--  · renglones con inventario_id → tipo 'repuesto_inventario'; los manuales quedan NULL («sin clasificar»).
--  · órdenes activas: cantidad_aplicada = cantidad y aplicada_legado = cantidad + Σ ledger (lo que el ledger no explica ya se consumió
--    antes de 3.15). Órdenes anuladas/borradas: cantidad_aplicada = −Σ ledger, aplicada_legado = 0.
--  · presupuesto_estado = 'aprobado' si la orden tenía aprobación registrada, está cobrada o va por reparación/calidad/entrega; si no, 'pendiente'.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regprocedure('public.cotizacion_aceptada_inmutable()') IS NULL OR to_regprocedure('public.sync_stock_mover(uuid,numeric,text,uuid,boolean,timestamptz,uuid,uuid,uuid,uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'SYNC-15B STOP: falta sync-15a o SYNC-3';
  END IF;
END
$pre$;

-- registro de fases (sirve al rollback para saber desde cuándo hay datos de 3.15)
CREATE TABLE IF NOT EXISTS public.sync_fases (fase text PRIMARY KEY, aplicada_en timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE public.sync_fases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_fases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sync_fases TO service_role;

ALTER TABLE public.cotizacion_items ADD COLUMN IF NOT EXISTS tipo text;
ALTER TABLE public.orden_items ADD COLUMN IF NOT EXISTS tipo text;
ALTER TABLE public.orden_items ADD COLUMN IF NOT EXISTS cantidad_aplicada numeric NOT NULL DEFAULT 0;
ALTER TABLE public.orden_items ADD COLUMN IF NOT EXISTS aplicada_legado numeric NOT NULL DEFAULT 0;
ALTER TABLE public.ordenes ADD COLUMN IF NOT EXISTS presupuesto_estado text NOT NULL DEFAULT 'pendiente';
ALTER TABLE public.ordenes ADD COLUMN IF NOT EXISTS aprobado_en timestamptz;
ALTER TABLE public.ordenes ADD COLUMN IF NOT EXISTS aprobado_por uuid;
ALTER TABLE public.ordenes ADD COLUMN IF NOT EXISTS rechazado_en timestamptz;
ALTER TABLE public.ordenes ADD COLUMN IF NOT EXISTS aprobacion_via text;

-- BACKFILL de compatibilidad: UNA sola vez (la marca de fase lo hace idempotente). No toca el ledger ni inventario.cantidad.
DO $backfill$
DECLARE r record; v_ledger numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM public.sync_fases WHERE fase = '15b') THEN RETURN; END IF;
  UPDATE public.cotizacion_items SET tipo = 'repuesto_inventario' WHERE inventario_id IS NOT NULL AND tipo IS NULL;
  FOR r IN SELECT i.id, i.cantidad, (o.anulada OR o.deleted_at IS NOT NULL) AS inactiva
             FROM public.orden_items i JOIN public.ordenes o ON o.id = i.orden_id WHERE i.inventario_id IS NOT NULL LOOP
    SELECT COALESCE(sum(m.cantidad), 0) INTO v_ledger FROM public.inventario_movimientos m WHERE m.orden_item_id = r.id;
    IF r.inactiva THEN
      IF -v_ledger < 0 THEN RAISE EXCEPTION 'SYNC-15B STOP: el renglón % (orden inactiva) tiene más stock devuelto que consumido (ledger %)', r.id, v_ledger; END IF;
      UPDATE public.orden_items SET tipo = 'repuesto_inventario', cantidad_aplicada = -v_ledger, aplicada_legado = 0 WHERE id = r.id;
    ELSE
      IF r.cantidad + v_ledger < 0 OR r.cantidad + v_ledger > r.cantidad THEN
        RAISE EXCEPTION 'SYNC-15B STOP: el renglón % tiene un ledger (%) incompatible con su cantidad (%): revisar a mano antes de migrar', r.id, v_ledger, r.cantidad;
      END IF;
      UPDATE public.orden_items SET tipo = 'repuesto_inventario', cantidad_aplicada = r.cantidad, aplicada_legado = r.cantidad + v_ledger WHERE id = r.id;
    END IF;
  END LOOP;
  UPDATE public.ordenes SET
    presupuesto_estado = CASE WHEN aprobacion IS NOT NULL OR finalizada OR estado IN ('reparacion', 'calidad', 'entregado') THEN 'aprobado' ELSE 'pendiente' END,
    aprobacion_via = CASE WHEN aprobacion IS NOT NULL OR finalizada OR estado IN ('reparacion', 'calidad', 'entregado')
                          THEN COALESCE(NULLIF(aprobacion->>'via', ''), 'compatibilidad-3.14') END,
    aprobado_en = CASE WHEN aprobacion IS NOT NULL OR finalizada OR estado IN ('reparacion', 'calidad', 'entregado')
                       THEN COALESCE(CASE WHEN (aprobacion->>'en') ~ '^\d+$' THEN to_timestamp((aprobacion->>'en')::bigint / 1000.0) END, finalizado_en, creado_en) END;
  INSERT INTO public.sync_fases (fase) VALUES ('15b');
END
$backfill$;

-- restricciones (tras el backfill)
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cotizacion_items_tipo_chk') THEN
    ALTER TABLE public.cotizacion_items ADD CONSTRAINT cotizacion_items_tipo_chk CHECK (
      (tipo IS NULL AND inventario_id IS NULL) OR (tipo = 'repuesto_inventario' AND inventario_id IS NOT NULL) OR (tipo IN ('mano_obra', 'repuesto_manual') AND inventario_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orden_items_tipo_chk') THEN
    ALTER TABLE public.orden_items ADD CONSTRAINT orden_items_tipo_chk CHECK (
      (tipo IS NULL AND inventario_id IS NULL) OR (tipo = 'repuesto_inventario' AND inventario_id IS NOT NULL) OR (tipo IN ('mano_obra', 'repuesto_manual') AND inventario_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orden_items_aplicada_chk') THEN
    ALTER TABLE public.orden_items ADD CONSTRAINT orden_items_aplicada_chk CHECK (cantidad_aplicada >= 0 AND aplicada_legado >= 0 AND (inventario_id IS NOT NULL OR cantidad_aplicada = 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ordenes_presupuesto_estado_chk') THEN
    ALTER TABLE public.ordenes ADD CONSTRAINT ordenes_presupuesto_estado_chk CHECK (presupuesto_estado IN ('pendiente', 'aprobado', 'rechazado'));
  END IF;
END
$chk$;
-- respaldo físico del «una vez»: una misma operación no puede mover dos veces el mismo producto de un mismo renglón.
-- El índice de SYNC-1 (op, producto, tipo) impedía que UNA operación moviera dos renglones del MISMO producto (p. ej. aprobar una orden con
-- dos renglones de neumático): pasa a cubrir solo los movimientos SIN renglón (ventas, créditos, ajustes, importación: igual que antes) y los
-- de renglón quedan cubiertos por (op, renglón, producto).
DO $idx$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'inventario_mov_op_uidx' AND indexdef LIKE '%orden_item_id IS NULL%') THEN
    DROP INDEX IF EXISTS public.inventario_mov_op_uidx;
    CREATE UNIQUE INDEX inventario_mov_op_uidx ON public.inventario_movimientos (op_id, inventario_id, tipo) WHERE op_id IS NOT NULL AND orden_item_id IS NULL;
  END IF;
END
$idx$;
CREATE UNIQUE INDEX IF NOT EXISTS inventario_movimientos_op_renglon_uq ON public.inventario_movimientos (op_id, orden_item_id, inventario_id)
  WHERE op_id IS NOT NULL AND orden_item_id IS NOT NULL;

-- ═════════════════════════ NÚCLEO: reconciliar un renglón a su objetivo (interno) ═════════════════════════
CREATE OR REPLACE FUNCTION public.sync_reconciliar_renglon(p_item uuid, p_objetivo numeric, p_op uuid, p_reverso uuid DEFAULT NULL, p_motivo text DEFAULT NULL)
 RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE it record; v_delta numeric;
BEGIN
  SELECT i.id, i.orden_id, i.inventario_id, i.cantidad_aplicada INTO it FROM public.orden_items i WHERE i.id = p_item FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El renglón % no existe', p_item USING ERRCODE = '23503'; END IF;
  IF it.inventario_id IS NULL THEN RETURN 0; END IF;
  v_delta := COALESCE(p_objetivo, 0) - it.cantidad_aplicada;
  IF v_delta > 0 THEN
    -- sale del inventario: online nunca negativo (sync_stock_mover bloquea con 23514 y el nombre del producto)
    PERFORM public.sync_stock_mover(it.inventario_id, -v_delta, 'orden_item', p_op, false, clock_timestamp(), NULL, NULL, it.orden_id, it.id, p_reverso, p_motivo);
    IF it.cantidad_aplicada = 0 THEN   -- costo histórico: se sella al consumirse por primera vez
      UPDATE public.orden_items oi SET costo_unitario = COALESCE(inv.costo_compra, 0), costo_estimado = false
        FROM public.inventario inv WHERE oi.id = it.id AND inv.id = it.inventario_id;
    END IF;
  ELSIF v_delta < 0 THEN
    PERFORM public.sync_stock_mover(it.inventario_id, -v_delta, 'reverso_item_orden', p_op, false, clock_timestamp(), NULL, NULL, it.orden_id, it.id, p_reverso,
                                    COALESCE(p_motivo, 'Ajuste del renglón de la orden'));
  END IF;
  IF v_delta <> 0 THEN UPDATE public.orden_items SET cantidad_aplicada = COALESCE(p_objetivo, 0) WHERE id = it.id; END IF;
  RETURN v_delta;
END
$function$;

-- objetivo de un renglón según el estado de su orden (interno)
CREATE OR REPLACE FUNCTION public.sync_objetivo_renglon(p_estado text, p_inactiva boolean, p_tipo text, p_cantidad numeric, p_aplicada numeric)
 RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_inactiva OR p_tipo IS DISTINCT FROM 'repuesto_inventario' OR p_estado = 'rechazado' THEN 0
              WHEN p_estado = 'aprobado' THEN p_cantidad
              ELSE LEAST(p_aplicada, p_cantidad) END
$function$;

-- comprueba ANTES de mover nada que hay existencia para llevar todos los renglones de una orden a su objetivo; un solo error con la
-- lista completa de faltantes (nunca media orden ni movimientos parciales: el error aborta la transacción entera) (interno)
CREATE OR REPLACE FUNCTION public.sync_verificar_existencias(p_orden uuid, p_estado text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record; v_falta text := '';
BEGIN
  -- primero los candados (orden fijo por id: sin interbloqueos entre aprobaciones), después la lectura: nunca se decide con un dato viejo
  PERFORM 1 FROM public.inventario WHERE id IN (SELECT oi.inventario_id FROM public.orden_items oi WHERE oi.orden_id = p_orden AND oi.inventario_id IS NOT NULL)
    ORDER BY id FOR UPDATE;
  FOR r IN
    SELECT inv.id, inv.nombre, inv.cantidad AS hay, sum(public.sync_objetivo_renglon(p_estado, false, oi.tipo, oi.cantidad, oi.cantidad_aplicada) - oi.cantidad_aplicada) AS pide
      FROM public.orden_items oi JOIN public.inventario inv ON inv.id = oi.inventario_id
     WHERE oi.orden_id = p_orden GROUP BY inv.id, inv.nombre, inv.cantidad ORDER BY inv.id
  LOOP
    IF r.pide > 0 AND r.hay - r.pide < 0 THEN v_falta := v_falta || format('%s%s (hay %s, se necesitan %s)', CASE WHEN v_falta = '' THEN '' ELSE '; ' END, r.nombre, r.hay, r.pide); END IF;
  END LOOP;
  IF v_falta <> '' THEN RAISE EXCEPTION 'SIN_EXISTENCIA: no hay stock suficiente de %', v_falta USING ERRCODE = '23514'; END IF;
END
$function$;

-- reconcilia TODOS los renglones de una orden (interno). Devuelve cuántas unidades se movieron (suma de |delta|).
CREATE OR REPLACE FUNCTION public.sync_reconciliar_orden(p_orden uuid, p_op uuid, p_reverso uuid DEFAULT NULL, p_motivo text DEFAULT NULL)
 RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE o record; it record; v_mov numeric := 0;
BEGIN
  SELECT presupuesto_estado, (anulada OR deleted_at IS NOT NULL) AS inactiva INTO o FROM public.ordenes WHERE id = p_orden;
  IF NOT o.inactiva THEN PERFORM public.sync_verificar_existencias(p_orden, o.presupuesto_estado); END IF;
  FOR it IN SELECT id, tipo, cantidad, cantidad_aplicada FROM public.orden_items WHERE orden_id = p_orden AND inventario_id IS NOT NULL ORDER BY inventario_id, id LOOP
    v_mov := v_mov + abs(public.sync_reconciliar_renglon(it.id, public.sync_objetivo_renglon(o.presupuesto_estado, o.inactiva, it.tipo, it.cantidad, it.cantidad_aplicada), p_op, p_reverso, p_motivo));
  END LOOP;
  RETURN v_mov;
END
$function$;

-- tipo de un renglón nuevo: explícito (validado) o, para clientes 3.14.1 que no lo mandan, solo el deducible por el vínculo (nunca por texto)
CREATE OR REPLACE FUNCTION public.sync_tipo_renglon(p_tipo text, p_inventario uuid)
 RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $function$
BEGIN
  IF p_tipo IS NULL OR btrim(p_tipo) = '' THEN RETURN CASE WHEN p_inventario IS NOT NULL THEN 'repuesto_inventario' END; END IF;
  IF p_tipo NOT IN ('mano_obra', 'repuesto_inventario', 'repuesto_manual') THEN RAISE EXCEPTION 'Tipo de renglón desconocido: %', p_tipo USING ERRCODE = '22023'; END IF;
  IF (p_tipo = 'repuesto_inventario') <> (p_inventario IS NOT NULL) THEN
    RAISE EXCEPTION 'Un repuesto del inventario necesita su producto, y la mano de obra o un repuesto manual no llevan producto' USING ERRCODE = '22023';
  END IF;
  RETURN p_tipo;
END
$function$;

-- ═════════════════════════ RENGLONES DE LA ORDEN ═════════════════════════
DROP FUNCTION IF EXISTS public.agregar_item_orden(uuid, uuid, uuid, text, numeric, numeric, uuid, boolean, timestamptz, text);
CREATE OR REPLACE FUNCTION public.agregar_item_orden(p_op uuid, p_orden_id uuid, p_inventario_id uuid, p_nombre text,
    p_cantidad numeric, p_precio numeric, p_item_id uuid DEFAULT NULL, p_offline boolean DEFAULT false,
    p_occurred_at timestamptz DEFAULT NULL, p_device text DEFAULT NULL, p_tipo text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; o record; v_item uuid; v_nom text; v_costo numeric := 0; v_tipo text; v_res jsonb; v_mov numeric;
BEGIN
  IF NOT public.ve_todo_el_taller() THEN RAISE EXCEPTION 'Solo el administrador o el cajero agregan ítems' USING ERRCODE = '42501'; END IF;
  IF p_cantidad IS NULL OR p_cantidad <= 0 OR p_precio IS NULL OR p_precio < 0 THEN RAISE EXCEPTION 'Cantidad y precio deben ser válidos' USING ERRCODE = '22023'; END IF;
  v_tipo := public.sync_tipo_renglon(p_tipo, p_inventario_id);
  v_hash := md5(jsonb_build_array(p_orden_id, p_inventario_id, p_nombre, p_cantidad, p_precio, p_item_id, p_offline, p_occurred_at, p_tipo)::text);
  v_prev := public.sync_op_iniciar(p_op, 'agregar_item_orden', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  SELECT ord.id, ord.finalizada, ord.anulada, ord.deleted_at, ord.presupuesto_estado INTO o FROM public.ordenes ord WHERE ord.id = p_orden_id FOR UPDATE;
  IF NOT FOUND OR o.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'La orden no existe' USING ERRCODE = '23503'; END IF;
  IF o.finalizada OR o.anulada THEN RAISE EXCEPTION 'La orden ya está cerrada: no admite más ítems' USING ERRCODE = '22000'; END IF;
  v_item := COALESCE(p_item_id, gen_random_uuid());
  v_nom := NULLIF(btrim(COALESCE(p_nombre, '')), '');
  IF p_inventario_id IS NOT NULL THEN
    SELECT i.costo_compra, COALESCE(v_nom, i.nombre) INTO v_costo, v_nom FROM public.inventario i WHERE i.id = p_inventario_id AND i.deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'El repuesto ya no existe en el inventario' USING ERRCODE = '23503'; END IF;
  END IF;
  IF v_nom IS NULL THEN RAISE EXCEPTION 'Falta la descripción del renglón' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.orden_items (id, orden_id, inventario_id, tipo, nombre, cantidad, precio, costo_unitario, costo_estimado, created_by)
  VALUES (v_item, p_orden_id, p_inventario_id, v_tipo, v_nom, p_cantidad, p_precio, COALESCE(v_costo, 0), false, auth.uid());
  -- presupuesto aprobado → el repuesto sale ya (la diferencia); pendiente/rechazado → no toca stock
  v_mov := public.sync_reconciliar_orden(p_orden_id, p_op, NULL, 'Renglón agregado a la orden');
  UPDATE public.ordenes SET last_op_id = p_op WHERE id = p_orden_id;
  PERFORM public.sync_auditar('agregar-item', 'ordenes', p_orden_id::text, v_nom || ' x' || p_cantidad || ' a ' || p_precio || ' · ' || COALESCE(v_tipo, 'sin clasificar')
                              || ' · stock movido ' || v_mov, p_op, p_device);
  v_res := jsonb_build_object('item_id', v_item, 'tipo', v_tipo, 'stock_movido', v_mov, 'presupuesto', o.presupuesto_estado, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'agregar_item_orden', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.actualizar_item_orden(p_op uuid, p_item_id uuid, p_cantidad numeric, p_precio numeric, p_nombre text DEFAULT NULL,
    p_inventario_id uuid DEFAULT NULL, p_tipo text DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; it record; o record; v_tipo text; v_nom text; v_mov numeric := 0; v_res jsonb; v_cambia_producto boolean; v_costo numeric;
BEGIN
  IF NOT public.ve_todo_el_taller() THEN RAISE EXCEPTION 'Solo el administrador o el cajero editan ítems' USING ERRCODE = '42501'; END IF;
  IF p_cantidad IS NULL OR p_cantidad <= 0 OR p_precio IS NULL OR p_precio < 0 THEN RAISE EXCEPTION 'Cantidad y precio deben ser válidos' USING ERRCODE = '22023'; END IF;
  v_tipo := public.sync_tipo_renglon(p_tipo, p_inventario_id);
  v_hash := md5(jsonb_build_array(p_item_id, p_cantidad, p_precio, p_nombre, p_inventario_id, p_tipo)::text);
  v_prev := public.sync_op_iniciar(p_op, 'actualizar_item_orden', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  SELECT oi.orden_id INTO it FROM public.orden_items oi WHERE oi.id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'El ítem ya no existe' USING ERRCODE = '23503'; END IF;
  SELECT ord.id, ord.finalizada, ord.anulada, ord.deleted_at INTO o FROM public.ordenes ord WHERE ord.id = it.orden_id FOR UPDATE;
  IF o.finalizada OR o.anulada OR o.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'La orden ya está cerrada: no se editan ítems' USING ERRCODE = '22000'; END IF;
  SELECT oi.* INTO it FROM public.orden_items oi WHERE oi.id = p_item_id FOR UPDATE;
  v_cambia_producto := it.inventario_id IS DISTINCT FROM p_inventario_id;
  v_nom := NULLIF(btrim(COALESCE(p_nombre, '')), '');
  IF v_cambia_producto THEN
    -- A → B (o repuesto ↔ manual/mano de obra): primero vuelve TODO lo aplicado de A, después entra B según el estado; misma transacción
    v_mov := v_mov + abs(public.sync_reconciliar_renglon(p_item_id, 0, p_op, NULL, 'Cambio de producto en el renglón'));
    v_costo := 0;
    IF p_inventario_id IS NOT NULL THEN
      SELECT i.costo_compra, COALESCE(v_nom, i.nombre) INTO v_costo, v_nom FROM public.inventario i WHERE i.id = p_inventario_id AND i.deleted_at IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'El repuesto ya no existe en el inventario' USING ERRCODE = '23503'; END IF;
    END IF;
    UPDATE public.orden_items SET inventario_id = p_inventario_id, tipo = v_tipo, nombre = COALESCE(v_nom, nombre), cantidad = p_cantidad, precio = p_precio,
           costo_unitario = COALESCE(v_costo, 0), aplicada_legado = 0 WHERE id = p_item_id;
  ELSE
    UPDATE public.orden_items SET tipo = COALESCE(v_tipo, tipo), nombre = COALESCE(v_nom, nombre), cantidad = p_cantidad, precio = p_precio WHERE id = p_item_id;
  END IF;
  -- solo la diferencia: 2→3 saca 1; 3→1 devuelve 2; cambiar solo el precio no mueve nada
  v_mov := v_mov + public.sync_reconciliar_orden(it.orden_id, p_op, NULL, 'Renglón modificado');
  UPDATE public.ordenes SET last_op_id = p_op WHERE id = it.orden_id;
  PERFORM public.sync_auditar('editar-item', 'ordenes', it.orden_id::text,
    it.nombre || ': ' || it.cantidad || ' × ' || it.precio || ' → ' || COALESCE(v_nom, it.nombre) || ': ' || p_cantidad || ' × ' || p_precio || ' · stock movido ' || v_mov, p_op, p_device);
  v_res := jsonb_build_object('item_id', p_item_id, 'stock_movido', v_mov, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'actualizar_item_orden', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.quitar_item_orden(p_op uuid, p_item_id uuid, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; it record; o record; v_res jsonb; v_dev numeric;
BEGIN
  IF NOT public.ve_todo_el_taller() THEN RAISE EXCEPTION 'Solo el administrador o el cajero quitan ítems' USING ERRCODE = '42501'; END IF;
  v_hash := md5(p_item_id::text);
  v_prev := public.sync_op_iniciar(p_op, 'quitar_item_orden', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  SELECT oi.orden_id INTO it FROM public.orden_items oi WHERE oi.id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'El ítem ya no existe' USING ERRCODE = '23503'; END IF;
  SELECT ord.finalizada, ord.anulada INTO o FROM public.ordenes ord WHERE ord.id = it.orden_id FOR UPDATE;
  IF o.finalizada OR o.anulada THEN RAISE EXCEPTION 'La orden ya está cerrada: no se quitan ítems' USING ERRCODE = '22000'; END IF;
  SELECT oi.id, oi.orden_id, oi.nombre, oi.cantidad, oi.cantidad_aplicada INTO it FROM public.orden_items oi WHERE oi.id = p_item_id FOR UPDATE;
  -- devuelve EXACTAMENTE lo aplicado (0 si el presupuesto nunca se aprobó); el movimiento compensatorio conserva el id del renglón
  v_dev := -public.sync_reconciliar_renglon(p_item_id, 0, p_op, NULL, 'Ítem quitado de la orden');
  DELETE FROM public.orden_items WHERE id = p_item_id;
  UPDATE public.ordenes SET last_op_id = p_op WHERE id = it.orden_id;
  PERFORM public.sync_auditar('quitar-item', 'ordenes', it.orden_id::text, it.nombre || ' x' || it.cantidad || ' · devuelto al inventario ' || v_dev, p_op, p_device);
  v_res := jsonb_build_object('devuelto', v_dev, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'quitar_item_orden', v_hash, p_device, v_res);
END
$function$;

-- ═════════════════════════ DECISIÓN DEL PRESUPUESTO ═════════════════════════
CREATE OR REPLACE FUNCTION public.decidir_presupuesto_orden(p_op uuid, p_orden_id uuid, p_decision text, p_via text DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; o record; v_mov numeric; v_res jsonb; v_nuevo text; v_ya boolean := false;
BEGIN
  IF NOT public.ve_todo_el_taller() THEN RAISE EXCEPTION 'Solo el administrador o el cajero deciden presupuestos' USING ERRCODE = '42501'; END IF;
  IF p_decision NOT IN ('aprobar', 'rechazar', 'reabrir') THEN RAISE EXCEPTION 'Decisión desconocida: %', p_decision USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_orden_id, p_decision, p_via)::text);
  v_prev := public.sync_op_iniciar(p_op, 'decidir_presupuesto_orden', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  SELECT * INTO o FROM public.ordenes WHERE id = p_orden_id FOR UPDATE;
  IF NOT FOUND OR o.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'La orden no existe' USING ERRCODE = '23503'; END IF;
  IF o.anulada THEN RAISE EXCEPTION 'La orden está anulada' USING ERRCODE = '22000'; END IF;
  v_nuevo := CASE p_decision WHEN 'aprobar' THEN 'aprobado' WHEN 'rechazar' THEN 'rechazado' ELSE 'pendiente' END;
  IF o.finalizada AND v_nuevo <> o.presupuesto_estado THEN RAISE EXCEPTION 'La orden ya se cobró: su presupuesto no cambia' USING ERRCODE = '22000'; END IF;
  IF p_decision = 'reabrir' AND o.presupuesto_estado <> 'rechazado' THEN
    RAISE EXCEPTION 'Solo un presupuesto rechazado se reabre (desaprobar uno aprobado no está permitido)' USING ERRCODE = '22000';
  END IF;
  v_ya := o.presupuesto_estado = v_nuevo;
  UPDATE public.ordenes SET presupuesto_estado = v_nuevo,
         aprobado_en = CASE WHEN v_nuevo = 'aprobado' THEN COALESCE(CASE WHEN v_ya THEN aprobado_en END, clock_timestamp()) ELSE aprobado_en END,
         aprobado_por = CASE WHEN v_nuevo = 'aprobado' AND NOT v_ya THEN auth.uid() ELSE aprobado_por END,
         aprobacion_via = CASE WHEN v_nuevo = 'aprobado' AND NOT v_ya THEN COALESCE(NULLIF(btrim(p_via), ''), 'local') ELSE aprobacion_via END,
         rechazado_en = CASE WHEN v_nuevo = 'rechazado' AND NOT v_ya THEN clock_timestamp() WHEN v_nuevo = 'pendiente' THEN NULL ELSE rechazado_en END,
         aprobacion = CASE WHEN v_nuevo = 'aprobado' AND NOT v_ya THEN jsonb_build_object('via', COALESCE(NULLIF(btrim(p_via), ''), 'local'), 'en', (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
                           WHEN v_nuevo <> 'aprobado' THEN NULL ELSE aprobacion END,
         last_op_id = p_op
   WHERE id = p_orden_id;
  -- aprobar: verifica TODO el stock y descuenta cada repuesto exactamente la diferencia (0 si ya estaba aplicado); rechazar: devuelve lo aplicado
  v_mov := public.sync_reconciliar_orden(p_orden_id, p_op, NULL, CASE v_nuevo WHEN 'aprobado' THEN 'Presupuesto aprobado' WHEN 'rechazado' THEN 'Presupuesto rechazado' ELSE 'Presupuesto reabierto' END);
  PERFORM public.sync_auditar('presupuesto-' || p_decision, 'ordenes', p_orden_id::text, v_nuevo || CASE WHEN v_ya THEN ' (ya lo estaba)' ELSE '' END || ' · stock movido ' || v_mov, p_op, p_device);
  v_res := jsonb_build_object('orden_id', p_orden_id, 'presupuesto', v_nuevo, 'ya_estaba', v_ya, 'stock_movido', v_mov, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'decidir_presupuesto_orden', v_hash, p_device, v_res);
END
$function$;

-- ═════════════════════════ COTIZACIÓN ═════════════════════════
CREATE OR REPLACE FUNCTION public.sync_guardar_items_cotizacion(p_op uuid, p_cotizacion_id uuid, p_items jsonb, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; c record; v_n int := 0; v_res jsonb; x jsonb; v_inv uuid; v_tipo text;
BEGIN
  IF NOT public.ve_todo_el_taller() THEN RAISE EXCEPTION 'Solo el administrador o el cajero editan cotizaciones' USING ERRCODE = '42501'; END IF;
  IF p_cotizacion_id IS NULL THEN RAISE EXCEPTION 'Falta la cotización' USING ERRCODE = '22004'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'p_items debe ser un arreglo JSON' USING ERRCODE = '22023'; END IF;

  v_hash := md5(jsonb_build_array(p_cotizacion_id, p_items)::text);
  v_prev := public.sync_op_iniciar(p_op, 'sync_guardar_items_cotizacion', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  SELECT co.id, co.deleted_at, co.estado, co.orden_id INTO c FROM public.cotizaciones co WHERE co.id = p_cotizacion_id FOR UPDATE;
  IF NOT FOUND OR c.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'La cotización no existe' USING ERRCODE = '23503'; END IF;
  IF c.estado = 'aceptada' OR c.orden_id IS NOT NULL THEN
    RAISE EXCEPTION 'COTIZACION_YA_ACEPTADA: sus renglones ya no se editan (manda la orden)' USING ERRCODE = '22000';
  END IF;

  DELETE FROM public.cotizacion_items WHERE cotizacion_id = p_cotizacion_id;
  FOR x IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF COALESCE(btrim(x->>'nombre'), '') = '' THEN RAISE EXCEPTION 'Falta el nombre de un renglón' USING ERRCODE = '22023'; END IF;
    IF NOT (x ? 'cantidad') OR (x->>'cantidad')::numeric <= 0 THEN RAISE EXCEPTION 'La cantidad de «%» debe ser mayor a cero', x->>'nombre' USING ERRCODE = '22023'; END IF;
    IF NOT (x ? 'precio') OR x->'precio' = 'null'::jsonb OR (x->>'precio')::numeric < 0 THEN RAISE EXCEPTION 'El precio de «%» falta o es negativo', x->>'nombre' USING ERRCODE = '22023'; END IF;
    v_inv := NULLIF(x->>'inventario_id', '')::uuid;
    v_tipo := public.sync_tipo_renglon(x->>'tipo', v_inv);
    INSERT INTO public.cotizacion_items (cotizacion_id, inventario_id, tipo, nombre, cantidad, precio)
    VALUES (p_cotizacion_id, v_inv, v_tipo, x->>'nombre', (x->>'cantidad')::numeric, (x->>'precio')::numeric);
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.cotizaciones SET last_op_id = p_op WHERE id = p_cotizacion_id;
  PERFORM public.sync_auditar('guardar-items', 'cotizaciones', p_cotizacion_id::text, v_n || ' renglón(es)', p_op, p_device);
  v_res := jsonb_build_object('cotizacion_id', p_cotizacion_id, 'items', v_n, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'sync_guardar_items_cotizacion', v_hash, p_device, v_res);
END
$function$;

-- aceptar = aprobar: la orden nace con el presupuesto APROBADO y los repuestos del inventario salen exactamente una vez, todo en la misma
-- transacción; si falta existencia de cualquier producto, no se crea nada (ni orden, ni cliente, ni movimientos, ni cotización aceptada)
CREATE OR REPLACE FUNCTION public.convertir_cotizacion(p_op uuid, p_cotizacion_id uuid, p_orden_id uuid DEFAULT NULL,
    p_mecanico_id uuid DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_prev jsonb; v_hash text; c record; v_cli uuid; v_moto uuid; v_orden uuid; v_res jsonb; v_mec text := '';
  v_desc text; v_placa text; v_mm text; v_marca text; v_n int; v_inv int; v_mov numeric;
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
    v_desc := btrim(COALESCE(c.moto_desc, ''));
    v_placa := NULLIF(btrim(substring(v_desc FROM '·\s*placa\s+(.*)$')), '');
    v_mm := btrim(regexp_replace(v_desc, '\s*·?\s*placa\s+.*$', ''));
    v_marca := COALESCE(NULLIF(split_part(v_mm, ' ', 1), ''), '—');
    INSERT INTO public.motos (cliente_id, marca, modelo, placa, km)
    VALUES (v_cli, v_marca, NULLIF(btrim(substr(v_mm, length(split_part(v_mm, ' ', 1)) + 1)), ''), v_placa, 0) RETURNING id INTO v_moto;
  END IF;

  v_orden := COALESCE(p_orden_id, gen_random_uuid());
  INSERT INTO public.ordenes (id, cliente_id, moto_id, estado, falla, mecanico, mecanico_id, origen_trabajo, cotizacion_local_id, dispositivo,
      presupuesto_estado, aprobado_en, aprobado_por, aprobacion_via, aprobacion)
  VALUES (v_orden, v_cli, v_moto, 'recibido', COALESCE(NULLIF(c.diagnostico, ''), 'Trabajo cotizado en la cotización ' || substr(c.id::text, 1, 8)),
          COALESCE(v_mec, ''), p_mecanico_id, 'taller', c.local_id, p_device,
          'aprobado', clock_timestamp(), auth.uid(), 'cotizacion', jsonb_build_object('via', 'cotizacion', 'en', (extract(epoch FROM clock_timestamp()) * 1000)::bigint));

  INSERT INTO public.orden_items (orden_id, inventario_id, tipo, nombre, cantidad, precio, costo_unitario, costo_estimado, created_by, creado_en)
  SELECT v_orden, ci.inventario_id, COALESCE(ci.tipo, CASE WHEN ci.inventario_id IS NOT NULL THEN 'repuesto_inventario' END), ci.nombre, ci.cantidad, ci.precio,
         CASE WHEN ci.inventario_id IS NOT NULL THEN COALESCE(i.costo_compra, 0) ELSE 0 END, false, auth.uid(),
         clock_timestamp() + (row_number() OVER (ORDER BY ci.ctid)) * interval '1 microsecond'
    FROM public.cotizacion_items ci LEFT JOIN public.inventario i ON i.id = ci.inventario_id
   WHERE ci.cotizacion_id = c.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  SELECT count(*) INTO v_inv FROM public.cotizacion_items ci WHERE ci.cotizacion_id = c.id AND ci.inventario_id IS NOT NULL;
  -- descuento exactamente una vez (verifica TODO antes de mover; si falta algo, la excepción deshace la conversión entera)
  v_mov := public.sync_reconciliar_orden(v_orden, p_op, NULL, 'Cotización aceptada');

  UPDATE public.cotizaciones SET estado = 'aceptada', orden_id = v_orden, aceptada_en = clock_timestamp(), cliente_id = v_cli, moto_id = v_moto,
         last_op_id = p_op WHERE id = c.id;
  PERFORM public.sync_auditar('convertir', 'cotizaciones', c.id::text, 'Orden ' || v_orden || ' · ' || v_n || ' renglón(es), ' || v_inv || ' de inventario · stock movido ' || v_mov, p_op, p_device);
  v_res := jsonb_build_object('orden_id', v_orden, 'cliente_id', v_cli, 'moto_id', v_moto, 'items', v_n, 'items_inventario', v_inv,
                              'stock_movido', v_mov, 'sin_stock', '[]'::jsonb, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'convertir_cotizacion', v_hash, p_device, v_res);
END
$function$;

-- ═════════════════════════ COBRO Y ANULACIÓN ═════════════════════════
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
  IF o.presupuesto_estado = 'rechazado' THEN RAISE EXCEPTION 'El presupuesto de esta orden está rechazado: no se cobra' USING ERRCODE = '22000'; END IF;
  v_occ := LEAST(COALESCE(p_occurred_at, clock_timestamp()), clock_timestamp());

  -- 3.15: entregar y cobrar implica que los repuestos se usaron. Un presupuesto que nunca se aprobó se aprueba aquí (vía «entrega») y sus
  -- repuestos salen exactamente una vez; si falta existencia, no se cobra nada (la excepción deshace todo).
  IF o.presupuesto_estado <> 'aprobado' THEN
    UPDATE public.ordenes SET presupuesto_estado = 'aprobado', aprobado_en = clock_timestamp(), aprobado_por = auth.uid(), aprobacion_via = 'entrega' WHERE id = p_orden_id;
  END IF;
  PERFORM public.sync_reconciliar_orden(p_orden_id, p_op, NULL, 'Orden entregada y cobrada');

  SELECT COALESCE(sum(cantidad * precio), 0), COALESCE(sum(CASE WHEN inventario_id IS NOT NULL THEN costo_unitario * cantidad ELSE 0 END), 0)
    INTO v_total, v_costo FROM public.orden_items WHERE orden_id = p_orden_id;
  v_total := round(v_total, 2);
  v_margen := CASE WHEN v_total > 0 THEN round(((v_total - v_costo) / v_total) * 100, 2) END;

  IF v_total > 0 AND p_tipo_cobro = 'credito' THEN
    SELECT c.nombre, c.telefono INTO v_cli FROM public.clientes c WHERE c.id = o.cliente_id;
    IF LEAST(COALESCE(p_abono, 0), v_total) > 0 AND COALESCE(p_abono, 0) > v_total + 0.01 THEN
      RAISE EXCEPTION 'La entrada supera el total' USING ERRCODE = '23514';
    END IF;
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
DECLARE v_prev jsonb; v_hash text; o record; a record; v_dinero boolean; v_rev uuid; v_cred record; v_comp numeric := 0; v_res jsonb; v_modo text; v_aut uuid;
        it record; v_dev numeric := 0;
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
    -- 3.15: vuelve EXACTAMENTE lo aplicado de cada renglón (0 si su presupuesto nunca se aprobó); antes se devolvía la cantidad completa
    FOR it IN SELECT id FROM public.orden_items WHERE orden_id = p_orden_id AND inventario_id IS NOT NULL ORDER BY inventario_id, id LOOP
      v_dev := v_dev - public.sync_reconciliar_renglon(it.id, 0, p_op, v_rev, p_motivo);
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
      FOR it IN SELECT id FROM public.orden_items WHERE orden_id = p_orden_id AND inventario_id IS NOT NULL ORDER BY inventario_id, id LOOP
        v_dev := v_dev - public.sync_reconciliar_renglon(it.id, 0, p_op, v_rev, p_motivo);
      END LOOP;
    END IF;
    UPDATE public.ordenes SET anulada = true, anulada_en = clock_timestamp(), last_op_id = p_op WHERE id = p_orden_id;
  END IF;
  PERFORM public.sync_auditar('anular-orden', 'ordenes', p_orden_id::text, v_modo || ': ' || p_motivo || ' · devuelto al inventario ' || v_dev, p_op, p_device, v_aut);
  v_res := jsonb_build_object('reverso_id', v_rev, 'modo', v_modo, 'compensado', v_comp, 'devuelto', v_dev, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'anular_orden', v_hash, p_device, v_res);
END
$function$;

-- ═════════════════════════ INVARIANTES ═════════════════════════
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
  -- 3.15: lo aplicado de cada renglón cuadra con su ledger (salvo la parte legada, consumida antes de 3.15)
  FOR r IN SELECT oi.id, oi.cantidad_aplicada, oi.aplicada_legado, COALESCE((SELECT sum(m.cantidad) FROM public.inventario_movimientos m WHERE m.orden_item_id = oi.id), 0) AS ledger
             FROM public.orden_items oi WHERE oi.inventario_id IS NOT NULL LOOP
    IF -r.ledger <> r.cantidad_aplicada - r.aplicada_legado THEN
      v := v || jsonb_build_object('invariante', 'renglon=ledger', 'orden_item_id', r.id, 'aplicada', r.cantidad_aplicada, 'legado', r.aplicada_legado, 'ledger', r.ledger);
    END IF;
  END LOOP;
  -- 3.15: en un presupuesto aprobado (orden activa), cada repuesto del inventario tiene aplicada exactamente su cantidad
  FOR r IN SELECT oi.id, oi.cantidad, oi.cantidad_aplicada FROM public.orden_items oi JOIN public.ordenes o ON o.id = oi.orden_id
            WHERE o.presupuesto_estado = 'aprobado' AND NOT o.anulada AND o.deleted_at IS NULL AND oi.tipo = 'repuesto_inventario' AND oi.cantidad_aplicada <> oi.cantidad LOOP
    v := v || jsonb_build_object('invariante', 'aprobado=aplicado', 'orden_item_id', r.id, 'cantidad', r.cantidad, 'aplicada', r.cantidad_aplicada);
  END LOOP;
  RETURN v;
END
$function$;

-- ═════════════════════════ ACL (literales, uno por función) ═════════════════════════
REVOKE EXECUTE ON FUNCTION public.sync_reconciliar_renglon(uuid,numeric,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_reconciliar_renglon(uuid,numeric,uuid,uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_objetivo_renglon(text,boolean,text,numeric,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_objetivo_renglon(text,boolean,text,numeric,numeric) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_verificar_existencias(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_verificar_existencias(uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_reconciliar_orden(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_reconciliar_orden(uuid,uuid,uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_tipo_renglon(text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_tipo_renglon(text,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.agregar_item_orden(uuid,uuid,uuid,text,numeric,numeric,uuid,boolean,timestamptz,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agregar_item_orden(uuid,uuid,uuid,text,numeric,numeric,uuid,boolean,timestamptz,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.actualizar_item_orden(uuid,uuid,numeric,numeric,text,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.actualizar_item_orden(uuid,uuid,numeric,numeric,text,uuid,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.quitar_item_orden(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quitar_item_orden(uuid,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.decidir_presupuesto_orden(uuid,uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decidir_presupuesto_orden(uuid,uuid,text,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_guardar_items_cotizacion(uuid,uuid,jsonb,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.convertir_cotizacion(uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_cotizacion(uuid,uuid,uuid,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.finalizar_orden(uuid,uuid,text,text,numeric,text,date,timestamptz,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalizar_orden(uuid,uuid,text,text,numeric,text,date,timestamptz,text,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.anular_orden(uuid,uuid,text,boolean,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anular_orden(uuid,uuid,text,boolean,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.verificar_invariantes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verificar_invariantes() TO authenticated, service_role;

DO $post$
DECLARE n int;
BEGIN
  IF to_regprocedure('public.agregar_item_orden(uuid,uuid,uuid,text,numeric,numeric,uuid,boolean,timestamptz,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'SYNC-15B STOP: quedó la firma vieja de agregar_item_orden (sobrecarga ambigua)';
  END IF;
  SELECT count(*) INTO n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('sync_reconciliar_renglon','sync_objetivo_renglon','sync_verificar_existencias','sync_reconciliar_orden','sync_tipo_renglon',
                       'agregar_item_orden','actualizar_item_orden','quitar_item_orden','decidir_presupuesto_orden')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF n <> 0 THEN RAISE EXCEPTION 'SYNC-15B STOP: % funciones ejecutables por anon', n; END IF;
  IF (SELECT count(*) FROM public.verificar_invariantes() AS x WHERE jsonb_array_length(x) > 0) > 0 THEN
    RAISE EXCEPTION 'SYNC-15B STOP: invariantes rotos tras la migración: %', public.verificar_invariantes();
  END IF;
  RAISE NOTICE 'SYNC-15B: modelo de presupuestos + stock listo (backfill sin mover stock).';
END
$post$;
COMMIT;
