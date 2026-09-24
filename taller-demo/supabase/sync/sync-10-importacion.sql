-- ENTIMOTORS OS 3.14.0 · SYNC-10 · IMPORTACIÓN ATÓMICA DEL RESPALDO 3.13 · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere SYNC-1, SYNC-2, SYNC-3 y SYNC-3b aplicados.
--
-- POR QUÉ (auditoría SYNC-11 + SYNC-10): el importador de SYNC-3b aplica tabla por tabla, UNA llamada HTTP por trozo:
-- un corte a mitad dejaba la nube con clientes pero sin órdenes (lote 'aplicando', que no se puede revertir). Aquí:
--   public.import_aplicar_paquete(p_lote, p_paquete) — TODO el respaldo en UNA transacción (todo o nada):
--     · solo el administrador; el lote debe haber pasado su dry-run (import_iniciar + import_dry_run_ok, SYNC-3b);
--     · vuelve a exigir la nube VACÍA de datos operativos en el momento de aplicar (otro dispositivo pudo crear algo
--       entre el dry-run y la importación): nunca se mezcla un respaldo encima de datos existentes;
--     · aplica en orden de dependencias fijo (no el del JSON) reutilizando import_aplicar_lote (mismas reglas: columnas
--       que gobierna el servidor excluidas, inventario con cantidad 0 + UNA apertura 'importacion' del ledger, ventas/
--       créditos históricos SIN tocar stock ni caja de hoy) y enlaza ordenes.credito_id al final;
--     · ESTRICTO: si una sola fila no entra (duplicada, inválida) se cancela todo — nada se omite en silencio;
--     · verificar_invariantes() tiene que dar [] ANTES de confirmar la transacción; si no, se cancela todo;
--     · reintento idempotente: el mismo lote ya aplicado devuelve el resultado guardado con repetida:true (una respuesta
--       perdida nunca produce una segunda importación).
-- Además: import_estado(p_lote) — lectura del estado de UN lote para que el cliente se recupere tras un cierre.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE v_fail text := '';
BEGIN
  IF to_regprocedure('public.import_aplicar_lote(uuid,text,jsonb)') IS NULL OR to_regprocedure('public.import_cerrar_carga(uuid,jsonb)') IS NULL THEN
    v_fail := v_fail || 'falta SYNC-3b (import_aplicar_lote/import_cerrar_carga); ';
  END IF;
  IF to_regprocedure('public.verificar_invariantes()') IS NULL THEN v_fail := v_fail || 'falta verificar_invariantes(); '; END IF;
  IF to_regclass('public.import_lotes') IS NULL THEN v_fail := v_fail || 'falta import_lotes (SYNC-1); '; END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-10 STOP (precondiciones, nada modificado): %', v_fail; END IF;
END
$pre$;

-- statement_timeout propio: `authenticated` tiene 8 s (Supabase). PostgREST (v12+, db-hoisted-tx-settings) aplica el
-- statement_timeout declarado en la función como SET LOCAL antes de llamarla: el importador entero cabe en UNA transacción.
CREATE OR REPLACE FUNCTION public.import_aplicar_paquete(p_lote uuid, p_paquete jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '120s'
AS $function$
DECLARE
  l record; t text; r jsonb; v_n bigint; v_inv jsonb; v_res jsonb := '{}'::jsonb; v_filas jsonb; v_estado text; v_msg text;
  v_orden text[] := ARRAY['categorias_inv','clientes','motos','inventario','ordenes','orden_items','cotizaciones','cotizacion_items',
                          'citas','ventas','venta_items','creditos','credito_items','abonos','caja_movimientos'];
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador importa' USING ERRCODE = '42501'; END IF;
  IF p_paquete IS NULL OR jsonb_typeof(p_paquete) <> 'object' THEN RAISE EXCEPTION 'El paquete debe ser un objeto' USING ERRCODE = '22023'; END IF;
  SELECT * INTO l FROM public.import_lotes WHERE id = p_lote FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El lote no existe' USING ERRCODE = '23503'; END IF;
  -- reintento tras respuesta perdida: el lote ya está aplicado → mismo resultado, sin volver a importar
  IF l.estado IN ('aplicado', 'confirmado') THEN
    RETURN jsonb_build_object('lote_id', p_lote, 'estado', l.estado, 'insertadas', l.conteos_insertados, 'repetida', true);
  END IF;
  IF l.estado <> 'dry_run_ok' THEN
    RAISE EXCEPTION 'El lote no está listo para aplicar (estado %): el dry-run es obligatorio', l.estado USING ERRCODE = '22000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_lotes WHERE estado IN ('aplicado', 'confirmado', 'aplicando') AND id <> p_lote) THEN
    RAISE EXCEPTION 'Ya hay otra importación aplicada o en curso: solo se permite una' USING ERRCODE = '22000';
  END IF;
  SELECT (SELECT count(*) FROM public.clientes) + (SELECT count(*) FROM public.motos) + (SELECT count(*) FROM public.inventario)
       + (SELECT count(*) FROM public.ordenes) + (SELECT count(*) FROM public.ventas) + (SELECT count(*) FROM public.creditos)
       + (SELECT count(*) FROM public.caja_movimientos) + (SELECT count(*) FROM public.citas) + (SELECT count(*) FROM public.cotizaciones)
       + (SELECT count(*) FROM public.categorias_inv) INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'La nube ya tiene datos operativos (% filas): la importación exige una base vacía', v_n USING ERRCODE = '22000';
  END IF;

  FOREACH t IN ARRAY v_orden LOOP
    v_filas := COALESCE(p_paquete -> t, '[]'::jsonb);
    IF jsonb_typeof(v_filas) <> 'array' THEN RAISE EXCEPTION 'El paquete trae «%» con un formato inválido', t USING ERRCODE = '22023'; END IF;
    CONTINUE WHEN jsonb_array_length(v_filas) = 0;
    BEGIN
      r := public.import_aplicar_lote(p_lote, t, v_filas);
    EXCEPTION WHEN OTHERS THEN
      -- privacidad: el DETAIL de Postgres trae la fila entera (nombres, teléfonos, montos) y PostgREST lo devolvería al
      -- cliente. Se relanza SOLO con la tabla y el mensaje corto; clase 22 → HTTP 400 → rechazo terminal, sin reintento.
      GET STACKED DIAGNOSTICS v_estado = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      RAISE EXCEPTION 'La tabla % no se pudo importar (% %): no se importa nada', t, v_estado, left(v_msg, 160) USING ERRCODE = '22000';
    END;
    -- estricto: nada se omite en silencio (duplicado, fila vacía, conflicto de llave) → todo o nada
    IF (r ->> 'insertadas')::int <> (r ->> 'leidas')::int THEN
      RAISE EXCEPTION 'La tabla % no entró completa (% de % filas): no se importa nada', t, r ->> 'insertadas', r ->> 'leidas' USING ERRCODE = '22000';
    END IF;
    v_res := v_res || jsonb_build_object(t, (r ->> 'insertadas')::int);
  END LOOP;
  IF v_res = '{}'::jsonb THEN RAISE EXCEPTION 'El respaldo no trae ningún dato que importar' USING ERRCODE = '22023'; END IF;
  v_filas := COALESCE(p_paquete -> 'enlaces', '[]'::jsonb);
  IF jsonb_array_length(v_filas) > 0 THEN
    r := public.import_aplicar_lote(p_lote, 'enlaces', v_filas);
    IF (r ->> 'insertadas')::int <> (r ->> 'leidas')::int THEN
      RAISE EXCEPTION 'Enlaces orden→crédito incompletos (% de %): no se importa nada', r ->> 'insertadas', r ->> 'leidas' USING ERRCODE = '22000';
    END IF;
  END IF;

  v_inv := public.verificar_invariantes();
  IF v_inv <> '[]'::jsonb THEN
    RAISE EXCEPTION 'El respaldo rompe invariantes del sistema (%): no se importa nada', left(v_inv::text, 400) USING ERRCODE = '22000';
  END IF;
  PERFORM public.import_cerrar_carga(p_lote, NULL);
  RETURN jsonb_build_object('lote_id', p_lote, 'estado', 'aplicado', 'insertadas', v_res, 'repetida', false);
END
$function$;

CREATE OR REPLACE FUNCTION public.import_estado(p_lote uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE l record;
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador' USING ERRCODE = '42501'; END IF;
  SELECT id, estado, backup_id, backup_sha256, conteos_insertados, aplicado_en, confirmado_en INTO l FROM public.import_lotes WHERE id = p_lote;
  IF NOT FOUND THEN RETURN jsonb_build_object('lote_id', p_lote, 'estado', 'inexistente'); END IF;
  RETURN jsonb_build_object('lote_id', l.id, 'estado', l.estado, 'backup_id', l.backup_id, 'backup_sha256', l.backup_sha256,
    'insertadas', l.conteos_insertados, 'aplicado_en', l.aplicado_en, 'confirmado_en', l.confirmado_en);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.import_aplicar_paquete(uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_aplicar_paquete(uuid,jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.import_estado(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_estado(uuid) TO authenticated, service_role;

DO $post$
DECLARE v_fail text := '';
BEGIN
  IF to_regprocedure('public.import_aplicar_paquete(uuid,jsonb)') IS NULL THEN v_fail := v_fail || 'falta import_aplicar_paquete(); '; END IF;
  IF has_function_privilege('anon', 'public.import_aplicar_paquete(uuid,jsonb)', 'EXECUTE') THEN v_fail := v_fail || 'import_aplicar_paquete() ejecutable por anon; '; END IF;
  IF has_function_privilege('anon', 'public.import_estado(uuid)', 'EXECUTE') THEN v_fail := v_fail || 'import_estado() ejecutable por anon; '; END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-10 STOP (postcondiciones, se revierte todo): %', v_fail; END IF;
  RAISE NOTICE 'SYNC-10: postcondiciones OK (importación atómica e idempotente, solo administrador).';
END
$post$;

COMMIT;
