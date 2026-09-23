-- ENTIMOTORS OS 3.14.0 · SYNC-3 · RPC TRANSACCIONALES E IDEMPOTENTES · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere sync-1 y sync-2 aplicados.
--
-- TODA escritura de dinero, stock y caja pasa por estas funciones (SYNC-2 cerró el acceso directo). No se toca
-- ninguna de las 17 funciones fijadas por RCV-34: registrar_venta y registrar_abono siguen como están; las versiones nuevas
-- se llaman *_v2. Cada RPC es atómica (todo o nada) e idempotente:
--   · operation_id obligatorio. sync_ops + un candado por operation_id garantizan: mismo op_id → mismo resultado y el
--     efecto UNA sola vez, incluso con reintentos concurrentes. Mismo op_id con otros parámetros → error.
--   · Inventario: la cantidad es el ledger. Online, la falta de stock BLOQUEA la venta; offline (D-3) se acepta, el stock
--     queda negativo si toca, se marca requiere_revision y se audita. Nunca se recorta a cero.
--   · REVERSAL_ONLY: anular/devolver/revertir inserta movimientos compensatorios y una fila en `reversos`; el original
--     se conserva. Las acciones del cajero exigen una autorización de un solo uso (PIN administrativo, SYNC-3P).
--   · El servidor calcula totales, costos y márgenes; lo que diga el cliente sobre ellos se ignora.
--
-- SYNC-7 (auditoría de errores, sección 2): las 14 validaciones terminales de esta hoja (ya anulado/cerrado/
-- finalizado/revertido, o "no es la orden esperada") usaban ERRCODE 55000 (object_not_in_prerequisite_state).
-- SYNC-6 encontró empíricamente que PostgREST mapea la clase 55 a HTTP 500, y sync-rest.js clasifica CUALQUIER
-- 5xx como "servidor" (reintentable) — un rechazo terminal no debe reintentarse jamás. Cambiadas a ERRCODE
-- 22000 (data_exception, clase 22 → 400 → "validacion" en sync-cliente, terminal), mismo patrón ya verificado
-- contra PostgREST real en sync-6-mecanicos-ordenes.sql. sync-engine.js trata "validacion" y "conflicto" IGUAL
-- (ninguna se reintenta: ver `flush()`, la lista `k === "permiso" || k === "validacion" || k === "conflicto"`),
-- así que no hace falta distinguir sub-clase aquí. Revisado también sync-3p-pin.sql (PIN_CAMBIADO, ERRCODE
-- 55000): SIN CAMBIOS — pin.ts (api-server) lo atrapa por el TEXTO del mensaje ("PIN_CAMBIADO"), no por el
-- status HTTP, así que el bug de mapeo no lo afecta. sync-3b-importacion.sql (10 apariciones de 55000) tampoco
-- se tocó: es una herramienta de migración de una sola vez que SYNC-7 no consume en el flujo de venta/caja/
-- crédito del día a día — fuera de alcance ("NO hacer reemplazo ciego global").
--
-- SYNC-7B (auditoría del ERRCODE restante, sección 3): las 15 validaciones "X no existe / no encontrado" de esta hoja
-- usaban P0002 (no_data_found). PostgREST mapea toda la clase P0 salvo P0001 a HTTP 500 → sync-rest.js "servidor" →
-- reintento infinito de un rechazo que nunca se arregla solo (p. ej. una venta offline de un repuesto que otro
-- dispositivo borró). Revisadas una por una: TODAS son "la referencia no existe" → cambiadas a 23503
-- (foreign_key_violation → HTTP 409 → "conflicto", terminal). Mismo cambio en sync-7a-inventario.sql. Lo que se
-- queda reintentable A PROPÓSITO: 55P03 (lock_timeout), 40001/40P01 (serialización/deadlock), 57014 (timeout) —
-- son temporales de verdad. 23514 (stock insuficiente online, abono > saldo) y 22xxx ya caen en 400 → "validacion".
-- 23505 OP_ID_REUTILIZADO → 409 → "conflicto". sync-5/sync-6 conservan P0002 (fuera de alcance de SYNC-7B; anotado
-- en ENTIMOTORS-SYNC-3.14-STATE.md).
-- SYNC-7B (sección 14): sync_autorizar recibe además p_device y exige que coincida con el device_id con el que el
-- backend del PIN emitió la autorización — la autorización ya no es transferible a otro dispositivo del mismo usuario.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('public.sync_ops') IS NULL OR to_regprocedure('public.sync_guardia()') IS NULL THEN
    RAISE EXCEPTION 'SYNC-3 STOP: faltan SYNC-1/SYNC-2';
  END IF;
END
$pre$;

-- ═════════════════════════ HELPERS INTERNOS (no se exponen a los clientes) ═════════════════════════
CREATE OR REPLACE FUNCTION public.sync_op_iniciar(p_op uuid, p_kind text, p_hash text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev record;
BEGIN
  IF p_op IS NULL THEN RAISE EXCEPTION 'operation_id es obligatorio' USING ERRCODE = '22004'; END IF;
  -- serializa los reintentos concurrentes del mismo operation_id: el segundo espera y luego ve el resultado guardado
  PERFORM pg_advisory_xact_lock(hashtextextended(p_op::text, 0));
  SELECT o.kind, o.request_hash, o.user_id, o.resultado INTO v_prev FROM public.sync_ops o WHERE o.op_id = p_op;
  IF FOUND THEN
    IF v_prev.kind <> p_kind OR v_prev.request_hash IS DISTINCT FROM p_hash OR v_prev.user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'OP_ID_REUTILIZADO: el operation_id % ya se usó para otra operación', p_op USING ERRCODE = '23505';
    END IF;
    RETURN v_prev.resultado;
  END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.sync_op_guardar(p_op uuid, p_kind text, p_hash text, p_device text, p_res jsonb)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  INSERT INTO public.sync_ops (op_id, kind, user_id, device_id, request_hash, resultado)
  VALUES (p_op, p_kind, auth.uid(), p_device, p_hash, p_res) RETURNING resultado
$function$;

CREATE OR REPLACE FUNCTION public.sync_auditar(p_accion text, p_entidad text, p_entidad_id text, p_detalle text,
    p_op uuid, p_device text, p_autorizado uuid DEFAULT NULL, p_resultado text DEFAULT NULL)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  INSERT INTO public.auditoria (usuario_id, usuario, rol, accion, entidad, entidad_id, detalle, device_id, operation_id, autorizado_por, resultado)
  VALUES (auth.uid(), COALESCE((SELECT p.nombre FROM public.perfiles p WHERE p.id = auth.uid()), '—'), public.rol_actual(),
          p_accion, p_entidad, p_entidad_id, p_detalle, p_device, p_op, p_autorizado, COALESCE(p_resultado, 'ok'))
$function$;

-- Un movimiento de stock = una fila del ledger. Online: la falta de stock bloquea. Offline: se acepta y se marca.
CREATE OR REPLACE FUNCTION public.sync_stock_mover(p_inv uuid, p_delta numeric, p_tipo text, p_op uuid, p_offline boolean,
    p_occ timestamptz, p_venta uuid DEFAULT NULL, p_credito uuid DEFAULT NULL, p_orden uuid DEFAULT NULL,
    p_item uuid DEFAULT NULL, p_reverso uuid DEFAULT NULL, p_motivo text DEFAULT NULL)
 RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_stock numeric; v_nombre text; v_saldo numeric;
BEGIN
  IF p_delta = 0 THEN RETURN NULL; END IF;
  SELECT i.cantidad, i.nombre INTO v_stock, v_nombre FROM public.inventario i WHERE i.id = p_inv AND i.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El repuesto % ya no existe en el inventario', p_inv USING ERRCODE = '23503'; END IF;
  IF p_delta < 0 AND NOT COALESCE(p_offline, false) AND v_stock + p_delta < 0 THEN
    RAISE EXCEPTION 'Sin stock suficiente de % (hay %, se piden %)', v_nombre, v_stock, -p_delta USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad, motivo, op_id, venta_id, credito_id, orden_id,
      orden_item_id, reverso_id, capturada_offline, created_by, occurred_at)
  VALUES (p_inv, p_tipo, p_delta, p_motivo, p_op, p_venta, p_credito, p_orden, p_item, p_reverso,
      COALESCE(p_offline, false) AND p_delta < 0, auth.uid(), COALESCE(p_occ, clock_timestamp()))
  RETURNING saldo_despues INTO v_saldo;
  RETURN v_saldo;
END
$function$;

-- Movimiento de caja (solo agregar). Monto 0 = no se registra nada.
CREATE OR REPLACE FUNCTION public.sync_caja(p_tipo text, p_categoria text, p_monto numeric, p_metodo text, p_desc text,
    p_occ timestamptz, p_op uuid, p_venta uuid DEFAULT NULL, p_credito uuid DEFAULT NULL, p_orden uuid DEFAULT NULL,
    p_id_abono text DEFAULT NULL, p_reverso_de uuid DEFAULT NULL)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RETURN NULL; END IF;
  INSERT INTO public.caja_movimientos (tipo, categoria, monto, metodo_pago, descripcion, venta_id, credito_id, orden_id,
      id_abono, reverso_de, occurred_at, op_id)
  VALUES (p_tipo, p_categoria, p_monto, p_metodo, p_desc, p_venta, p_credito, p_orden, p_id_abono, p_reverso_de,
      COALESCE(p_occ, clock_timestamp()), p_op)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$function$;

-- ¿Quién puede hacer una acción sensible? El admin por sí mismo; el cajero solo con una autorización vigente de UN SOLO USO
-- ligada a usuario, acción, entidad y registro (y a la versión del PIN). El mecánico nunca.
CREATE OR REPLACE FUNCTION public.sync_hash_critico(p_accion text, p_registro uuid, p_monto numeric)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT md5(p_accion || '|' || p_registro::text || '|' || to_char(round(COALESCE(p_monto, 0), 2), 'FM999999999990.00'))
$function$;

-- SYNC-7B: la autorización también queda ligada al DISPOSITIVO que la pidió (no transferible): la firma de 6 argumentos
-- de SYNC-3 se retira y la nueva recibe p_device (el mismo `p_device` que cada RPC ya recibía para auditoría).
DROP FUNCTION IF EXISTS public.sync_autorizar(uuid, text, text, uuid, uuid, numeric);
CREATE OR REPLACE FUNCTION public.sync_autorizar(p_auth uuid, p_accion text, p_entidad text, p_registro uuid,
    p_op uuid, p_monto numeric, p_device text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_aut uuid;
BEGIN
  IF public.es_admin() THEN RETURN jsonb_build_object('o_autorizado', NULL, 'o_admin', true); END IF;
  IF NOT public.puede_cobrar() THEN
    RAISE EXCEPTION 'Este usuario no puede realizar esta acción' USING ERRCODE = '42501';
  END IF;
  IF p_auth IS NULL THEN
    RAISE EXCEPTION 'AUTORIZACION_REQUERIDA: esta acción necesita la autorización del administrador' USING ERRCODE = '42501';
  END IF;
  UPDATE public.autorizaciones_admin a
     SET consumida_en = clock_timestamp(), consumida_op = p_op
   WHERE a.id = p_auth AND a.solicitante_id = auth.uid() AND a.accion = p_accion AND a.entidad = p_entidad
     AND a.registro_id = p_registro AND a.consumida_en IS NULL AND a.expira_en > clock_timestamp()
     AND a.device_id IS NOT DISTINCT FROM p_device
     AND a.pin_version = (SELECT p.version FROM public.admin_pin p WHERE p.perfil_id = a.autorizado_por)
     AND (a.payload_hash IS NULL OR a.payload_hash = public.sync_hash_critico(p_accion, p_registro, p_monto))
  RETURNING a.autorizado_por INTO v_aut;
  IF v_aut IS NULL THEN
    RAISE EXCEPTION 'AUTORIZACION_INVALIDA: la autorización no existe, caducó, ya se usó o no corresponde a esta acción' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('o_autorizado', v_aut, 'o_admin', false);
END
$function$;

-- Aplica un abono a un crédito: abono + saldo + caja. Interno: lo usan registrar_abono_v2, registrar_credito y finalizar_orden.
CREATE OR REPLACE FUNCTION public.sync_abonar(p_credito uuid, p_monto numeric, p_metodo text, p_occ timestamptz,
    p_op uuid, p_id_abono text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE c record; v_abonado numeric; v_saldo numeric; v_estado text; v_abono uuid;
BEGIN
  SELECT total, abonado, anulado INTO c FROM public.creditos WHERE id = p_credito FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Crédito no encontrado' USING ERRCODE = '23503'; END IF;
  IF c.anulado THEN RAISE EXCEPTION 'El crédito está anulado' USING ERRCODE = '22000'; END IF;
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'El abono debe ser mayor que cero' USING ERRCODE = '22023'; END IF;
  IF p_monto > (c.total - c.abonado) + 0.01 THEN
    RAISE EXCEPTION 'El abono (%) supera el saldo pendiente (%)', p_monto, c.total - c.abonado USING ERRCODE = '23514';
  END IF;
  v_abonado := c.abonado + p_monto;
  v_saldo := GREATEST(0, c.total - v_abonado);
  v_estado := CASE WHEN v_saldo <= 0.001 THEN 'pagado' ELSE 'parcial' END;
  INSERT INTO public.abonos (id_abono, credito_id, monto, metodo_pago, occurred_at, op_id)
  VALUES (p_id_abono, p_credito, p_monto, p_metodo, COALESCE(p_occ, clock_timestamp()), p_op) RETURNING id INTO v_abono;
  UPDATE public.creditos SET abonado = v_abonado, saldo = v_saldo, estado = v_estado WHERE id = p_credito;
  PERFORM public.sync_caja('ingreso', 'Cobro de crédito', p_monto, p_metodo, 'Abono a crédito', p_occ, NULL,
                           NULL, p_credito, NULL, p_id_abono, NULL);
  RETURN jsonb_build_object('abono_id', v_abono, 'saldo', v_saldo, 'estado', v_estado);
END
$function$;

-- ═════════════════════════ VENTAS, ABONOS Y CRÉDITOS ═════════════════════════
CREATE OR REPLACE FUNCTION public.registrar_venta_v2(p_op uuid, p_cliente_id uuid, p_cliente_nombre text, p_metodo_pago text,
    p_efectivo numeric, p_items jsonb, p_occurred_at timestamptz DEFAULT NULL, p_offline boolean DEFAULT false,
    p_device text DEFAULT NULL, p_venta_id uuid DEFAULT NULL, p_mecanico_id uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_prev jsonb; v_hash text; v_id uuid; v_total numeric := 0; v_occ timestamptz; v_off boolean;
  r record; v_saldo numeric; v_neg jsonb := '[]'::jsonb; v_mec text; v_res jsonb;
BEGIN
  IF NOT public.puede_cobrar() THEN RAISE EXCEPTION 'Este usuario no tiene permiso para cobrar' USING ERRCODE = '42501'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'La venta no tiene renglones' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(btrim(p_metodo_pago), '') = '' THEN RAISE EXCEPTION 'Falta el método de pago' USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_cliente_id, p_cliente_nombre, p_metodo_pago, p_efectivo, p_items, p_occurred_at, p_offline, p_venta_id, p_mecanico_id)::text);
  v_prev := public.sync_op_iniciar(p_op, 'registrar_venta_v2', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  v_occ := LEAST(COALESCE(p_occurred_at, clock_timestamp()), clock_timestamp());
  -- el servidor no puede verificar que fue offline: solo se acepta stock negativo si el hecho es anterior a la recepción
  v_off := COALESCE(p_offline, false) AND v_occ < clock_timestamp() - interval '20 seconds';

  FOR r IN SELECT * FROM jsonb_to_recordset(p_items) AS x(item_id uuid, inventario_id uuid, nombre text, cantidad numeric, precio numeric) LOOP
    IF r.cantidad IS NULL OR r.cantidad <= 0 OR r.precio IS NULL OR r.precio < 0 THEN
      RAISE EXCEPTION 'Renglón inválido: cantidad y precio deben ser positivos' USING ERRCODE = '22023';
    END IF;
    IF r.inventario_id IS NULL AND COALESCE(btrim(r.nombre), '') = '' THEN RAISE EXCEPTION 'Renglón sin nombre' USING ERRCODE = '22023'; END IF;
    v_total := v_total + r.cantidad * r.precio;
  END LOOP;
  v_total := round(v_total, 2);
  SELECT p.nombre INTO v_mec FROM public.perfiles p WHERE p.id = COALESCE(p_mecanico_id, auth.uid());
  v_id := COALESCE(p_venta_id, gen_random_uuid());

  INSERT INTO public.ventas (id, cliente_id, cliente_nombre, metodo_pago, total, efectivo_recibido, cambio, mecanico, mecanico_id,
      dispositivo, occurred_at, op_id, capturada_offline)
  VALUES (v_id, p_cliente_id, p_cliente_nombre, p_metodo_pago, v_total, p_efectivo, GREATEST(0, COALESCE(p_efectivo, 0) - v_total),
      v_mec, COALESCE(p_mecanico_id, auth.uid()), p_device, v_occ, p_op, COALESCE(p_offline, false));

  -- stock: un movimiento por producto, en orden fijo para evitar interbloqueos
  FOR r IN SELECT x.inventario_id AS inv, sum(x.cantidad) AS cant
             FROM jsonb_to_recordset(p_items) AS x(inventario_id uuid, cantidad numeric)
            WHERE x.inventario_id IS NOT NULL GROUP BY x.inventario_id ORDER BY x.inventario_id LOOP
    v_saldo := public.sync_stock_mover(r.inv, -r.cant, 'venta', p_op, v_off, v_occ, v_id);
    IF v_saldo < 0 THEN v_neg := v_neg || jsonb_build_object('inventario_id', r.inv, 'saldo', v_saldo); END IF;
  END LOOP;

  INSERT INTO public.venta_items (id, venta_id, inventario_id, nombre, cantidad, precio, costo_unitario, costo_estimado)
  SELECT COALESCE(x.item_id, gen_random_uuid()), v_id, x.inventario_id, COALESCE(NULLIF(btrim(x.nombre), ''), i.nombre),
         x.cantidad, x.precio, COALESCE(i.costo_compra, 0), false
    FROM jsonb_to_recordset(p_items) AS x(item_id uuid, inventario_id uuid, nombre text, cantidad numeric, precio numeric)
    LEFT JOIN public.inventario i ON i.id = x.inventario_id;

  PERFORM public.sync_caja('ingreso', 'Venta mostrador', v_total, p_metodo_pago, 'Venta #' || substr(v_id::text, 1, 8), v_occ, p_op, v_id);
  PERFORM public.sync_auditar('venta', 'ventas', v_id::text, 'Total ' || v_total, p_op, p_device);
  IF jsonb_array_length(v_neg) > 0 THEN
    PERFORM public.sync_auditar('stock_negativo', 'inventario', v_id::text, 'Venta offline dejó stock negativo: ' || v_neg::text, p_op, p_device, NULL, 'revision');
  END IF;

  v_res := jsonb_build_object('venta_id', v_id, 'total', v_total, 'stock_negativo', v_neg, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'registrar_venta_v2', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.registrar_abono_v2(p_op uuid, p_credito_id uuid, p_monto numeric, p_metodo text,
    p_occurred_at timestamptz DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; v_res jsonb; v_occ timestamptz;
BEGIN
  IF NOT public.puede_cobrar() THEN RAISE EXCEPTION 'Este usuario no tiene permiso para registrar abonos' USING ERRCODE = '42501'; END IF;
  v_hash := md5(jsonb_build_array(p_credito_id, p_monto, p_metodo, p_occurred_at)::text);
  v_prev := public.sync_op_iniciar(p_op, 'registrar_abono_v2', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  v_occ := LEAST(COALESCE(p_occurred_at, clock_timestamp()), clock_timestamp());
  v_res := public.sync_abonar(p_credito_id, p_monto, p_metodo, v_occ, p_op, p_op::text);
  PERFORM public.sync_auditar('abono', 'creditos', p_credito_id::text, 'Abono ' || p_monto || ' · saldo ' || (v_res->>'saldo'), p_op, p_device);
  v_res := v_res || jsonb_build_object('repetida', false);
  RETURN public.sync_op_guardar(p_op, 'registrar_abono_v2', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.registrar_credito(p_op uuid, p_cliente_id uuid, p_cliente_nombre text, p_cliente_telefono text,
    p_items jsonb, p_vencimiento date DEFAULT NULL, p_nota text DEFAULT NULL, p_abono_inicial numeric DEFAULT 0,
    p_abono_metodo text DEFAULT NULL, p_occurred_at timestamptz DEFAULT NULL, p_offline boolean DEFAULT false,
    p_device text DEFAULT NULL, p_credito_id uuid DEFAULT NULL, p_origen text DEFAULT NULL, p_orden_id uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_prev jsonb; v_hash text; v_id uuid; v_total numeric := 0; v_occ timestamptz; v_off boolean; r record;
  v_neg jsonb := '[]'::jsonb; v_saldo numeric; v_res jsonb; v_ab jsonb;
BEGIN
  IF NOT public.puede_cobrar() THEN RAISE EXCEPTION 'Este usuario no tiene permiso para registrar créditos' USING ERRCODE = '42501'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Agrega al menos un repuesto o servicio' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(btrim(p_cliente_nombre), '') = '' THEN RAISE EXCEPTION 'Falta el cliente' USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_cliente_id, p_cliente_nombre, p_cliente_telefono, p_items, p_vencimiento, p_nota, p_abono_inicial,
                                  p_abono_metodo, p_occurred_at, p_offline, p_credito_id, p_origen, p_orden_id)::text);
  v_prev := public.sync_op_iniciar(p_op, 'registrar_credito', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  v_occ := LEAST(COALESCE(p_occurred_at, clock_timestamp()), clock_timestamp());
  v_off := COALESCE(p_offline, false) AND v_occ < clock_timestamp() - interval '20 seconds';
  FOR r IN SELECT * FROM jsonb_to_recordset(p_items) AS x(cantidad numeric, precio numeric) LOOP
    IF r.cantidad IS NULL OR r.cantidad <= 0 OR r.precio IS NULL OR r.precio < 0 THEN
      RAISE EXCEPTION 'Renglón inválido: cantidad y precio deben ser positivos' USING ERRCODE = '22023';
    END IF;
    v_total := v_total + r.cantidad * r.precio;
  END LOOP;
  v_total := round(v_total, 2);
  IF COALESCE(p_abono_inicial, 0) > v_total + 0.01 THEN RAISE EXCEPTION 'La entrada supera el total del crédito' USING ERRCODE = '23514'; END IF;
  v_id := COALESCE(p_credito_id, gen_random_uuid());

  INSERT INTO public.creditos (id, cliente_id, cliente_nombre, cliente_telefono, total, abonado, saldo, estado, origen, orden_id,
      nota, vencimiento, mecanico, mecanico_id, dispositivo, occurred_at, op_id)
  VALUES (v_id, p_cliente_id, p_cliente_nombre, p_cliente_telefono, v_total, 0, v_total, 'pendiente', p_origen, p_orden_id, p_nota,
      p_vencimiento, (SELECT p.nombre FROM public.perfiles p WHERE p.id = auth.uid()), auth.uid(), p_device, v_occ, p_op);

  FOR r IN SELECT x.inventario_id AS inv, sum(x.cantidad) AS cant
             FROM jsonb_to_recordset(p_items) AS x(inventario_id uuid, cantidad numeric)
            WHERE x.inventario_id IS NOT NULL GROUP BY x.inventario_id ORDER BY x.inventario_id LOOP
    v_saldo := public.sync_stock_mover(r.inv, -r.cant, 'credito', p_op, v_off, v_occ, NULL, v_id);
    IF v_saldo < 0 THEN v_neg := v_neg || jsonb_build_object('inventario_id', r.inv, 'saldo', v_saldo); END IF;
  END LOOP;
  INSERT INTO public.credito_items (id, credito_id, inventario_id, nombre, cantidad, precio, costo_unitario)
  SELECT COALESCE(x.item_id, gen_random_uuid()), v_id, x.inventario_id, COALESCE(NULLIF(btrim(x.nombre), ''), i.nombre),
         x.cantidad, x.precio, COALESCE(i.costo_compra, x.costo_unitario, 0)
    FROM jsonb_to_recordset(p_items) AS x(item_id uuid, inventario_id uuid, nombre text, cantidad numeric, precio numeric, costo_unitario numeric)
    LEFT JOIN public.inventario i ON i.id = x.inventario_id;

  IF COALESCE(p_abono_inicial, 0) > 0 THEN
    v_ab := public.sync_abonar(v_id, p_abono_inicial, COALESCE(p_abono_metodo, 'efectivo'), v_occ, NULL, p_op::text || ':ini');
  END IF;
  PERFORM public.sync_auditar('credito', 'creditos', v_id::text, 'Total ' || v_total, p_op, p_device);
  IF jsonb_array_length(v_neg) > 0 THEN
    PERFORM public.sync_auditar('stock_negativo', 'inventario', v_id::text, 'Crédito offline dejó stock negativo: ' || v_neg::text, p_op, p_device, NULL, 'revision');
  END IF;
  v_res := jsonb_build_object('credito_id', v_id, 'total', v_total, 'saldo', COALESCE((v_ab->>'saldo')::numeric, v_total), 'stock_negativo', v_neg, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'registrar_credito', v_hash, p_device, v_res);
END
$function$;

-- ═════════════════════════ ÓRDENES ═════════════════════════
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

-- ═════════════════════════ STOCK MANUAL Y CAJA MANUAL ═════════════════════════
CREATE OR REPLACE FUNCTION public.ajustar_stock(p_op uuid, p_inventario_id uuid, p_motivo text, p_delta numeric DEFAULT NULL,
    p_conteo numeric DEFAULT NULL, p_autorizacion uuid DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; v_actual numeric; v_delta numeric; v_saldo numeric; a record; v_res jsonb;
BEGIN
  IF (p_delta IS NULL) = (p_conteo IS NULL) THEN RAISE EXCEPTION 'Indica p_delta o p_conteo (uno solo)' USING ERRCODE = '22023'; END IF;
  IF COALESCE(length(btrim(p_motivo)), 0) < 3 THEN RAISE EXCEPTION 'El motivo del ajuste es obligatorio' USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_inventario_id, p_motivo, p_delta, p_conteo)::text);
  v_prev := public.sync_op_iniciar(p_op, 'ajustar_stock', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  SELECT i.cantidad INTO v_actual FROM public.inventario i WHERE i.id = p_inventario_id AND i.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El repuesto no existe' USING ERRCODE = '23503'; END IF;
  v_delta := COALESCE(p_delta, p_conteo - v_actual);
  SELECT * INTO a FROM jsonb_to_record(public.sync_autorizar(p_autorizacion, 'ajustar_stock', 'inventario', p_inventario_id, p_op, v_delta, p_device)) AS x(o_autorizado uuid, o_admin boolean);
  IF v_delta <> 0 THEN
    v_saldo := public.sync_stock_mover(p_inventario_id, v_delta, 'ajuste', p_op, true, clock_timestamp(), NULL, NULL, NULL, NULL, NULL, p_motivo);
  ELSE v_saldo := v_actual; END IF;
  -- un ajuste autorizado que deja el stock en orden resuelve la revisión pendiente
  IF v_saldo >= 0 THEN
    UPDATE public.inventario SET requiere_revision = false, revision_motivo = NULL, revision_desde = NULL WHERE id = p_inventario_id AND requiere_revision;
  END IF;
  PERFORM public.sync_auditar('ajuste-stock', 'inventario', p_inventario_id::text, p_motivo || ' · delta ' || v_delta, p_op, p_device, a.o_autorizado);
  v_res := jsonb_build_object('inventario_id', p_inventario_id, 'delta', v_delta, 'saldo', v_saldo, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'ajustar_stock', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.registrar_movimiento_caja(p_op uuid, p_tipo text, p_categoria text, p_monto numeric, p_metodo text,
    p_descripcion text DEFAULT NULL, p_occurred_at timestamptz DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; v_id uuid; v_res jsonb;
BEGIN
  IF NOT public.puede_cobrar() THEN RAISE EXCEPTION 'Este usuario no tiene permiso para registrar movimientos de caja' USING ERRCODE = '42501'; END IF;
  IF p_tipo NOT IN ('ingreso', 'egreso') OR p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'Tipo y monto inválidos' USING ERRCODE = '22023'; END IF;
  -- las categorías del sistema solo las generan las operaciones reales (venta, cobro de crédito, servicio, reversos)
  IF COALESCE(p_categoria, '') IN ('Venta mostrador', 'Cobro de crédito', 'Servicio taller') OR COALESCE(p_categoria, '') LIKE 'Reverso%' OR COALESCE(p_categoria, '') LIKE 'Devoluci%' THEN
    RAISE EXCEPTION 'Esa categoría la genera el sistema; no se registra a mano' USING ERRCODE = '22023';
  END IF;
  v_hash := md5(jsonb_build_array(p_tipo, p_categoria, p_monto, p_metodo, p_descripcion, p_occurred_at)::text);
  v_prev := public.sync_op_iniciar(p_op, 'registrar_movimiento_caja', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  v_id := public.sync_caja(p_tipo, p_categoria, round(p_monto, 2), p_metodo, p_descripcion, LEAST(COALESCE(p_occurred_at, clock_timestamp()), clock_timestamp()), p_op);
  PERFORM public.sync_auditar('registrar', 'caja_movimientos', v_id::text, p_tipo || ' ' || p_monto || ' · ' || COALESCE(p_categoria, ''), p_op, p_device);
  v_res := jsonb_build_object('movimiento_id', v_id, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'registrar_movimiento_caja', v_hash, p_device, v_res);
END
$function$;

-- ═════════════════════════ REVERSOS (REVERSAL_ONLY) ═════════════════════════
-- Compensa el ingreso/egreso de caja ligado a una condición y devuelve el id del movimiento compensatorio (uno por original).
CREATE OR REPLACE FUNCTION public.sync_compensar_caja(p_where_col text, p_id uuid, p_categoria text, p_occ timestamptz, p_desc text, p_monto_max numeric DEFAULT NULL)
 RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE m record; v_tot numeric := 0; v_rest numeric := p_monto_max; v_m numeric;
BEGIN
  FOR m IN EXECUTE format('SELECT id, tipo, monto, metodo_pago FROM public.caja_movimientos WHERE %I = $1 AND reverso_de IS NULL AND categoria IS DISTINCT FROM ''Devolución'' ORDER BY creado_en', p_where_col) USING p_id LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.caja_movimientos x WHERE x.reverso_de = m.id);
    v_m := m.monto;
    IF v_rest IS NOT NULL THEN v_m := LEAST(m.monto, v_rest); v_rest := v_rest - v_m; END IF;
    CONTINUE WHEN v_m <= 0;
    PERFORM public.sync_caja(CASE m.tipo WHEN 'ingreso' THEN 'egreso' ELSE 'ingreso' END, p_categoria, v_m, m.metodo_pago, p_desc, p_occ, NULL,
                             NULL, NULL, NULL, NULL, m.id);
    v_tot := v_tot + v_m;
  END LOOP;
  RETURN v_tot;
END
$function$;

CREATE OR REPLACE FUNCTION public.sync_registrar_reverso(p_tipo text, p_entidad text, p_registro uuid, p_motivo text, p_op uuid,
    p_device text, p_auth_uid uuid, p_admin boolean, p_autorizacion uuid, p_detalle jsonb)
 RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  INSERT INTO public.reversos (tipo, entidad, registro_id, motivo, solicitado_por, autorizado_por, actuo_como_admin, autorizacion_id, operation_id, device_id, detalle)
  VALUES (p_tipo, p_entidad, p_registro, p_motivo, auth.uid(), p_auth_uid, p_admin, p_autorizacion, p_op, p_device, p_detalle) RETURNING id
$function$;

CREATE OR REPLACE FUNCTION public.reversar_venta(p_op uuid, p_venta_id uuid, p_motivo text, p_autorizacion uuid DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; v record; a record; it record; v_rev uuid; v_dev_monto numeric; v_comp numeric; v_res jsonb; v_dev_qty numeric;
BEGIN
  IF COALESCE(length(btrim(p_motivo)), 0) < 3 THEN RAISE EXCEPTION 'El motivo es obligatorio' USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_venta_id, p_motivo)::text);
  v_prev := public.sync_op_iniciar(p_op, 'reversar_venta', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  SELECT id, total, anulada INTO v FROM public.ventas WHERE id = p_venta_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La venta no existe' USING ERRCODE = '23503'; END IF;
  IF v.anulada THEN RAISE EXCEPTION 'La venta ya está anulada' USING ERRCODE = '22000'; END IF;
  SELECT * INTO a FROM jsonb_to_record(public.sync_autorizar(p_autorizacion, 'reversar_venta', 'ventas', p_venta_id, p_op, v.total, p_device)) AS x(o_autorizado uuid, o_admin boolean);
  SELECT COALESCE(sum((r.detalle->>'monto')::numeric), 0) INTO v_dev_monto FROM public.reversos r WHERE r.entidad = 'ventas' AND r.registro_id = p_venta_id AND r.tipo = 'devolucion';
  v_rev := public.sync_registrar_reverso('venta', 'ventas', p_venta_id, p_motivo, p_op, p_device, a.o_autorizado, a.o_admin, p_autorizacion,
                                         jsonb_build_object('total', v.total, 'ya_devuelto', v_dev_monto));
  -- stock: lo vendido menos lo ya devuelto, por renglón
  FOR it IN SELECT vi.id, vi.inventario_id, vi.cantidad FROM public.venta_items vi WHERE vi.venta_id = p_venta_id AND vi.inventario_id IS NOT NULL ORDER BY vi.inventario_id, vi.id LOOP
    SELECT COALESCE(sum((x.cantidad)::numeric), 0) INTO v_dev_qty
      FROM public.reversos r, jsonb_to_recordset(r.detalle->'items') AS x(venta_item_id uuid, cantidad numeric, reingresa boolean)
     WHERE r.entidad = 'ventas' AND r.registro_id = p_venta_id AND r.tipo = 'devolucion' AND x.venta_item_id = it.id AND COALESCE(x.reingresa, true);
    IF it.cantidad - v_dev_qty > 0 THEN
      PERFORM public.sync_stock_mover(it.inventario_id, it.cantidad - v_dev_qty, 'reverso_venta', NULL, true, clock_timestamp(), p_venta_id, NULL, NULL, it.id, v_rev, p_motivo);
    END IF;
  END LOOP;
  v_comp := public.sync_compensar_caja('venta_id', p_venta_id, 'Reverso venta', clock_timestamp(), 'Anulación de venta #' || substr(p_venta_id::text, 1, 8), v.total - v_dev_monto);
  UPDATE public.ventas SET anulada = true, anulada_en = clock_timestamp(), last_op_id = p_op WHERE id = p_venta_id;
  PERFORM public.sync_auditar('anular-venta', 'ventas', p_venta_id::text, p_motivo, p_op, p_device, a.o_autorizado);
  v_res := jsonb_build_object('reverso_id', v_rev, 'compensado', v_comp, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'reversar_venta', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.registrar_devolucion(p_op uuid, p_venta_id uuid, p_items jsonb, p_motivo text, p_reingresa_stock boolean DEFAULT true,
    p_autorizacion uuid DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; v record; a record; x record; vi record; v_rev uuid; v_monto numeric := 0; v_ya numeric; v_res jsonb; v_items jsonb := '[]'::jsonb; v_pagado numeric;
BEGIN
  IF COALESCE(length(btrim(p_motivo)), 0) < 3 THEN RAISE EXCEPTION 'El motivo es obligatorio' USING ERRCODE = '22023'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Indica qué se devuelve' USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_venta_id, p_items, p_motivo, p_reingresa_stock)::text);
  v_prev := public.sync_op_iniciar(p_op, 'registrar_devolucion', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  SELECT id, total, anulada INTO v FROM public.ventas WHERE id = p_venta_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La venta no existe' USING ERRCODE = '23503'; END IF;
  IF v.anulada THEN RAISE EXCEPTION 'La venta ya está anulada' USING ERRCODE = '22000'; END IF;
  FOR x IN SELECT * FROM jsonb_to_recordset(p_items) AS y(venta_item_id uuid, cantidad numeric) LOOP
    IF x.cantidad IS NULL OR x.cantidad <= 0 THEN RAISE EXCEPTION 'Cantidad de devolución inválida' USING ERRCODE = '22023'; END IF;
    SELECT * INTO vi FROM public.venta_items WHERE id = x.venta_item_id AND venta_id = p_venta_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'El renglón % no pertenece a la venta', x.venta_item_id USING ERRCODE = '22023'; END IF;
    SELECT COALESCE(sum(z.cantidad), 0) INTO v_ya FROM public.reversos r, jsonb_to_recordset(r.detalle->'items') AS z(venta_item_id uuid, cantidad numeric)
     WHERE r.entidad = 'ventas' AND r.registro_id = p_venta_id AND r.tipo = 'devolucion' AND z.venta_item_id = x.venta_item_id;
    IF v_ya + x.cantidad > vi.cantidad THEN RAISE EXCEPTION 'No se puede devolver más de lo vendido (renglón %)', vi.nombre USING ERRCODE = '23514'; END IF;
    v_monto := v_monto + round(x.cantidad * vi.precio, 2);
    v_items := v_items || jsonb_build_object('venta_item_id', x.venta_item_id, 'cantidad', x.cantidad, 'reingresa', COALESCE(p_reingresa_stock, true));
  END LOOP;
  SELECT * INTO a FROM jsonb_to_record(public.sync_autorizar(p_autorizacion, 'registrar_devolucion', 'ventas', p_venta_id, p_op, v_monto, p_device)) AS x(o_autorizado uuid, o_admin boolean);
  v_rev := public.sync_registrar_reverso('devolucion', 'ventas', p_venta_id, p_motivo, p_op, p_device, a.o_autorizado, a.o_admin, p_autorizacion,
                                         jsonb_build_object('monto', v_monto, 'items', v_items));
  IF COALESCE(p_reingresa_stock, true) THEN
    FOR x IN SELECT y.venta_item_id, y.cantidad, vi2.inventario_id FROM jsonb_to_recordset(p_items) AS y(venta_item_id uuid, cantidad numeric)
               JOIN public.venta_items vi2 ON vi2.id = y.venta_item_id WHERE vi2.inventario_id IS NOT NULL ORDER BY vi2.inventario_id, y.venta_item_id LOOP
      PERFORM public.sync_stock_mover(x.inventario_id, x.cantidad, 'devolucion', NULL, true, clock_timestamp(), p_venta_id, NULL, NULL, x.venta_item_id, v_rev, p_motivo);
    END LOOP;
  END IF;
  -- el reembolso sale de caja como un egreso ligado a la venta (el original se conserva)
  PERFORM public.sync_caja('egreso', 'Devolución', v_monto, (SELECT c.metodo_pago FROM public.caja_movimientos c WHERE c.venta_id = p_venta_id AND c.reverso_de IS NULL ORDER BY c.creado_en LIMIT 1),
                           'Devolución de venta #' || substr(p_venta_id::text, 1, 8), clock_timestamp(), NULL, p_venta_id, NULL, NULL, NULL, NULL);
  PERFORM public.sync_auditar('devolucion', 'ventas', p_venta_id::text, p_motivo || ' · ' || v_monto, p_op, p_device, a.o_autorizado);
  v_res := jsonb_build_object('reverso_id', v_rev, 'reembolso', v_monto, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'registrar_devolucion', v_hash, p_device, v_res);
END
$function$;

-- Reversa un abono vigente: saldo, estado y caja compensatoria. Interno (lo usan reversar_abono y reversar_credito).
CREATE OR REPLACE FUNCTION public.sync_reversar_abono_i(p_abono uuid, p_occ timestamptz, p_desc text)
 RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE ab record; c record; v_abonado numeric; v_saldo numeric; v_caja uuid;
BEGIN
  SELECT * INTO ab FROM public.abonos WHERE id = p_abono FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El abono no existe' USING ERRCODE = '23503'; END IF;
  IF ab.anulado THEN RETURN 0; END IF;
  SELECT total, abonado INTO c FROM public.creditos WHERE id = ab.credito_id FOR UPDATE;
  v_abonado := GREATEST(0, c.abonado - ab.monto); v_saldo := c.total - v_abonado;
  UPDATE public.creditos SET abonado = v_abonado, saldo = v_saldo,
         estado = CASE WHEN v_saldo <= 0.001 THEN 'pagado' WHEN v_abonado <= 0.001 THEN 'pendiente' ELSE 'parcial' END WHERE id = ab.credito_id;
  UPDATE public.abonos SET anulado = true, anulado_en = p_occ WHERE id = p_abono;
  SELECT id INTO v_caja FROM public.caja_movimientos WHERE id_abono = ab.id_abono AND reverso_de IS NULL ORDER BY creado_en LIMIT 1;
  PERFORM public.sync_caja('egreso', 'Reverso de abono', ab.monto, ab.metodo_pago, p_desc, p_occ, NULL, NULL, ab.credito_id, NULL, NULL, v_caja);
  RETURN ab.monto;
END
$function$;

CREATE OR REPLACE FUNCTION public.reversar_abono(p_op uuid, p_abono_id uuid, p_motivo text, p_autorizacion uuid DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; ab record; a record; v_rev uuid; v_m numeric; v_res jsonb;
BEGIN
  IF COALESCE(length(btrim(p_motivo)), 0) < 3 THEN RAISE EXCEPTION 'El motivo es obligatorio' USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_abono_id, p_motivo)::text);
  v_prev := public.sync_op_iniciar(p_op, 'reversar_abono', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  SELECT id, monto, anulado, credito_id INTO ab FROM public.abonos WHERE id = p_abono_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El abono no existe' USING ERRCODE = '23503'; END IF;
  IF ab.anulado THEN RAISE EXCEPTION 'El abono ya está anulado' USING ERRCODE = '22000'; END IF;
  SELECT * INTO a FROM jsonb_to_record(public.sync_autorizar(p_autorizacion, 'reversar_abono', 'abonos', p_abono_id, p_op, ab.monto, p_device)) AS x(o_autorizado uuid, o_admin boolean);
  v_rev := public.sync_registrar_reverso('abono', 'abonos', p_abono_id, p_motivo, p_op, p_device, a.o_autorizado, a.o_admin, p_autorizacion, jsonb_build_object('monto', ab.monto, 'credito_id', ab.credito_id));
  v_m := public.sync_reversar_abono_i(p_abono_id, clock_timestamp(), 'Reverso de abono a crédito');
  UPDATE public.abonos SET last_op_id = p_op WHERE id = p_abono_id;
  PERFORM public.sync_auditar('reversar-abono', 'abonos', p_abono_id::text, p_motivo, p_op, p_device, a.o_autorizado);
  v_res := jsonb_build_object('reverso_id', v_rev, 'monto', v_m, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'reversar_abono', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.sync_reversar_credito_i(p_credito uuid, p_rev uuid, p_motivo text, p_devolver_stock boolean)
 RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE ab record; it record; v_tot numeric := 0;
BEGIN
  FOR ab IN SELECT id FROM public.abonos WHERE credito_id = p_credito AND NOT anulado ORDER BY creado_en LOOP
    v_tot := v_tot + public.sync_reversar_abono_i(ab.id, clock_timestamp(), 'Reverso de abono por anulación de crédito');
  END LOOP;
  IF p_devolver_stock THEN
    FOR it IN SELECT ci.id, ci.inventario_id, ci.cantidad FROM public.credito_items ci WHERE ci.credito_id = p_credito AND ci.inventario_id IS NOT NULL ORDER BY ci.inventario_id, ci.id LOOP
      PERFORM public.sync_stock_mover(it.inventario_id, it.cantidad, 'reverso_credito', NULL, true, clock_timestamp(), NULL, p_credito, NULL, it.id, p_rev, p_motivo);
    END LOOP;
  END IF;
  UPDATE public.creditos SET anulado = true, anulado_en = clock_timestamp() WHERE id = p_credito;
  RETURN v_tot;
END
$function$;

CREATE OR REPLACE FUNCTION public.reversar_credito(p_op uuid, p_credito_id uuid, p_motivo text, p_autorizacion uuid DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; c record; a record; v_rev uuid; v_m numeric; v_res jsonb;
BEGIN
  IF COALESCE(length(btrim(p_motivo)), 0) < 3 THEN RAISE EXCEPTION 'El motivo es obligatorio' USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_credito_id, p_motivo)::text);
  v_prev := public.sync_op_iniciar(p_op, 'reversar_credito', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  SELECT id, total, anulado, orden_id INTO c FROM public.creditos WHERE id = p_credito_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El crédito no existe' USING ERRCODE = '23503'; END IF;
  IF c.anulado THEN RAISE EXCEPTION 'El crédito ya está anulado' USING ERRCODE = '22000'; END IF;
  SELECT * INTO a FROM jsonb_to_record(public.sync_autorizar(p_autorizacion, 'reversar_credito', 'creditos', p_credito_id, p_op, c.total, p_device)) AS x(o_autorizado uuid, o_admin boolean);
  v_rev := public.sync_registrar_reverso('credito', 'creditos', p_credito_id, p_motivo, p_op, p_device, a.o_autorizado, a.o_admin, p_autorizacion, jsonb_build_object('total', c.total));
  v_m := public.sync_reversar_credito_i(p_credito_id, v_rev, p_motivo, c.orden_id IS NULL);   -- créditos de una orden: el stock ya salió con la orden
  UPDATE public.creditos SET last_op_id = p_op WHERE id = p_credito_id;
  PERFORM public.sync_auditar('reversar-credito', 'creditos', p_credito_id::text, p_motivo, p_op, p_device, a.o_autorizado);
  v_res := jsonb_build_object('reverso_id', v_rev, 'abonos_revertidos', v_m, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'reversar_credito', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.reversar_caja(p_op uuid, p_caja_id uuid, p_motivo text, p_autorizacion uuid DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; m record; a record; v_rev uuid; v_id uuid; v_res jsonb;
BEGIN
  IF COALESCE(length(btrim(p_motivo)), 0) < 3 THEN RAISE EXCEPTION 'El motivo es obligatorio' USING ERRCODE = '22023'; END IF;
  v_hash := md5(jsonb_build_array(p_caja_id, p_motivo)::text);
  v_prev := public.sync_op_iniciar(p_op, 'reversar_caja', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;
  SELECT * INTO m FROM public.caja_movimientos WHERE id = p_caja_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El movimiento no existe' USING ERRCODE = '23503'; END IF;
  IF m.venta_id IS NOT NULL OR m.credito_id IS NOT NULL OR m.orden_id IS NOT NULL OR m.id_abono IS NOT NULL OR m.reverso_de IS NOT NULL THEN
    RAISE EXCEPTION 'Este movimiento respalda otra operación: reviértela desde su origen (venta, crédito, abono u orden)' USING ERRCODE = '22000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.caja_movimientos x WHERE x.reverso_de = p_caja_id) THEN RAISE EXCEPTION 'El movimiento ya está revertido' USING ERRCODE = '22000'; END IF;
  SELECT * INTO a FROM jsonb_to_record(public.sync_autorizar(p_autorizacion, 'reversar_caja', 'caja_movimientos', p_caja_id, p_op, m.monto, p_device)) AS x(o_autorizado uuid, o_admin boolean);
  v_rev := public.sync_registrar_reverso('caja', 'caja_movimientos', p_caja_id, p_motivo, p_op, p_device, a.o_autorizado, a.o_admin, p_autorizacion, jsonb_build_object('monto', m.monto, 'tipo', m.tipo));
  v_id := public.sync_caja(CASE m.tipo WHEN 'ingreso' THEN 'egreso' ELSE 'ingreso' END, 'Reverso de caja', m.monto, m.metodo_pago, 'Reverso: ' || COALESCE(m.descripcion, m.categoria, ''), clock_timestamp(), NULL, NULL, NULL, NULL, NULL, p_caja_id);
  PERFORM public.sync_auditar('reversar-caja', 'caja_movimientos', p_caja_id::text, p_motivo, p_op, p_device, a.o_autorizado);
  v_res := jsonb_build_object('reverso_id', v_rev, 'movimiento_compensatorio', v_id, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'reversar_caja', v_hash, p_device, v_res);
END
$function$;

-- Órdenes sin dinero: borrado suave (solo admin) devolviendo el stock. Finalizadas o con dinero: NO se eliminan, se anulan.
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

-- ═════════════════════════ INVARIANTES ═════════════════════════
-- Devuelve las violaciones encontradas (vacío = todo cuadra). Solo el administrador.
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

-- ═════════════════════════ ACL: ninguna función es ejecutable por PUBLIC ni anon ═════════════════════════
-- (sentencias literales: el guard REV8 del repo las exige una por función)
-- internas: solo service_role puede invocarlas por RPC (las RPC públicas las llaman como dueño)
REVOKE EXECUTE ON FUNCTION public.sync_op_iniciar(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_op_iniciar(uuid,text,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_op_guardar(uuid,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_op_guardar(uuid,text,text,text,jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_auditar(text,text,text,text,uuid,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_auditar(text,text,text,text,uuid,text,uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_stock_mover(uuid,numeric,text,uuid,boolean,timestamptz,uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_stock_mover(uuid,numeric,text,uuid,boolean,timestamptz,uuid,uuid,uuid,uuid,uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_caja(text,text,numeric,text,text,timestamptz,uuid,uuid,uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_caja(text,text,numeric,text,text,timestamptz,uuid,uuid,uuid,uuid,text,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_autorizar(uuid,text,text,uuid,uuid,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_autorizar(uuid,text,text,uuid,uuid,numeric,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_abonar(uuid,numeric,text,timestamptz,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_abonar(uuid,numeric,text,timestamptz,uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_compensar_caja(text,uuid,text,timestamptz,text,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_compensar_caja(text,uuid,text,timestamptz,text,numeric) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_registrar_reverso(text,text,uuid,text,uuid,text,uuid,boolean,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_registrar_reverso(text,text,uuid,text,uuid,text,uuid,boolean,uuid,jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_reversar_abono_i(uuid,timestamptz,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_reversar_abono_i(uuid,timestamptz,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_reversar_credito_i(uuid,uuid,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_reversar_credito_i(uuid,uuid,text,boolean) TO service_role;
-- públicas: las llama la app con su sesión; cada una comprueba rol y permisos por dentro
REVOKE EXECUTE ON FUNCTION public.sync_hash_critico(text,uuid,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_hash_critico(text,uuid,numeric) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.registrar_venta_v2(uuid,uuid,text,text,numeric,jsonb,timestamptz,boolean,text,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_venta_v2(uuid,uuid,text,text,numeric,jsonb,timestamptz,boolean,text,uuid,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.registrar_abono_v2(uuid,uuid,numeric,text,timestamptz,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_abono_v2(uuid,uuid,numeric,text,timestamptz,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.registrar_credito(uuid,uuid,text,text,jsonb,date,text,numeric,text,timestamptz,boolean,text,uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_credito(uuid,uuid,text,text,jsonb,date,text,numeric,text,timestamptz,boolean,text,uuid,text,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.agregar_item_orden(uuid,uuid,uuid,text,numeric,numeric,uuid,boolean,timestamptz,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agregar_item_orden(uuid,uuid,uuid,text,numeric,numeric,uuid,boolean,timestamptz,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.quitar_item_orden(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quitar_item_orden(uuid,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.finalizar_orden(uuid,uuid,text,text,numeric,text,date,timestamptz,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalizar_orden(uuid,uuid,text,text,numeric,text,date,timestamptz,text,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.convertir_cotizacion(uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_cotizacion(uuid,uuid,uuid,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.ajustar_stock(uuid,uuid,text,numeric,numeric,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajustar_stock(uuid,uuid,text,numeric,numeric,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.registrar_movimiento_caja(uuid,text,text,numeric,text,text,timestamptz,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_movimiento_caja(uuid,text,text,numeric,text,text,timestamptz,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.reversar_venta(uuid,uuid,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reversar_venta(uuid,uuid,text,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.registrar_devolucion(uuid,uuid,jsonb,text,boolean,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_devolucion(uuid,uuid,jsonb,text,boolean,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.reversar_abono(uuid,uuid,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reversar_abono(uuid,uuid,text,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.reversar_credito(uuid,uuid,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reversar_credito(uuid,uuid,text,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.reversar_caja(uuid,uuid,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reversar_caja(uuid,uuid,text,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.anular_orden(uuid,uuid,text,boolean,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anular_orden(uuid,uuid,text,boolean,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.verificar_invariantes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verificar_invariantes() TO authenticated, service_role;

-- POSTCONDICIONES ---------------------------------------------------------------------------------------------------
DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND (p.proname LIKE 'sync\_%' OR p.proname IN ('registrar_venta_v2','registrar_abono_v2','registrar_credito','agregar_item_orden','quitar_item_orden',
          'finalizar_orden','convertir_cotizacion','ajustar_stock','registrar_movimiento_caja','reversar_venta','registrar_devolucion','reversar_abono',
          'reversar_credito','reversar_caja','anular_orden','verificar_invariantes'))
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'));
  IF n <> 0 THEN RAISE EXCEPTION 'SYNC-3 STOP: % funciones ejecutables por PUBLIC/anon', n; END IF;
  RAISE NOTICE 'SYNC-3: RPC instaladas; ninguna ejecutable por PUBLIC ni anon.';
END
$post$;

COMMIT;
