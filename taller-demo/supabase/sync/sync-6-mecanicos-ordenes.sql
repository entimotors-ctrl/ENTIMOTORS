-- ENTIMOTORS OS 3.14.0 · SYNC-6 · ÓRDENES + MI TRABAJO + ASIGNACIÓN REAL + FOTOS · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere SYNC-1, SYNC-2 y SYNC-3 ya aplicados, y el
-- trigger `ordenes_mecanico_avance` (entimotors-fase4d-rls.sql, función mecanico_solo_avance_tecnico) presente:
-- este archivo NO lo crea, lo REUTILIZA — es la única fuente de verdad de qué columnas técnicas puede tocar
-- un mecánico y de que solo avanza una etapa a la vez. SYNC-2 ya cerró el acceso DIRECTO del mecánico a
-- `ordenes`/`orden_items` (RLS); este archivo abre el único camino que le queda: dos funciones SECURITY DEFINER.
--
-- QUÉ HACE (todo aditivo; no toca columnas, políticas ni las 17 funciones de RCV-34)
--   1. public.ordenes_tecnico_mias()  — lectura. Función (no vista) a propósito: incluye el nombre del cliente y
--      la moto (marca/modelo/placa) como COLUMNAS PLANAS, no relaciones — el mecánico no tiene ni tendrá acceso
--      directo a `clientes`/`motos` (SYNC-2), así que sin este aplanado Mi Trabajo no podría mostrar de quién es
--      la moto. Los ítems viajan embebidos como jsonb (id, nombre, cantidad — SIN precio/costo: SYNC-6 sección 7).
--      SECURITY DEFINER + STABLE: PostgREST la sirve por GET igual que una tabla, así que el motor de sync
--      (sync-engine.js) la pagina con el mismo cursor (updated_at, id) sin que el motor sepa que es una función.
--   2. public.avanzar_orden_tecnico(p_op, p_orden_id, p_campos, p_device) — escritura. Idempotente
--      (sync_op_iniciar/sync_op_guardar, mismo patrón que sync-3-rpc.sql). Solo toca las columnas que ya
--      protegía el trigger `ordenes_mecanico_avance`: estado, diagnostico, reparacion_notas, calidad_checklist,
--      fotos, km_salida, falla. La función NO reimplementa esas reglas (una etapa por vez, nunca "entregado",
--      mecanico_id intocable): las hereda del trigger, que sigue en la tabla y se dispara igual dentro de un
--      SECURITY DEFINER. Lo que SÍ hace la función, porque el trigger no puede: reconfirmar EN EL MOMENTO DE
--      ESCRIBIR que la orden sigue siendo del mecánico que llama y que sigue abierta — la comprobación exacta que
--      pide SYNC-6 sección 9 (reasignación u cierre mientras el mecánico estaba desconectado → operación
--      rechazada, nunca se sobrescribe silenciosamente). El texto de las dos excepciones es EXACTAMENTE el que
--      Mi Trabajo debe mostrarle al mecánico (sync-rest.js ya expone `error.mensaje`; no hace falta traducirlo).
--
--   OJO — la función NO pone `last_op_id`: `ordenes_mecanico_avance` corre ANTES que `zz_sync_sello` (el prefijo
--   «zz» es a propósito, ver sync-1-esquema.sql) pero DESPUÉS de que el UPDATE arma la fila NEW — si esta función
--   tocara `last_op_id` (que no está en la lista de columnas permitidas del trigger), el propio trigger
--   rechazaría la actualización del mecánico por "fuera de lo permitido". `zz_sync_sello` ya sube updated_at/rev
--   en cualquier UPDATE, con o sin last_op_id: no hace falta para que la descarga incremental vea el cambio.
--
--   Storage no cambia: las políticas de SYNC-2 (taller_lee_media/taller_sube_media, ruta ordenes/<uuid>/<archivo>,
--   mecanico_asignado_a_orden) ya cubren exactamente esta necesidad y se REUTILIZAN tal cual.
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
     OR to_regprocedure('public.sync_auditar(text,text,text,text,uuid,text,uuid,text)') IS NULL THEN
    v_fail := v_fail || 'falta SYNC-3 (sync_op_iniciar/sync_op_guardar/sync_auditar); ';
  END IF;
  IF to_regprocedure('public.es_mecanico_activo()') IS NULL THEN
    v_fail := v_fail || 'falta es_mecanico_activo() (fase4d); ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ordenes_mecanico_avance'
                  AND tgrelid = 'public.ordenes'::regclass AND NOT tgisinternal) THEN
    v_fail := v_fail || 'falta el trigger ordenes_mecanico_avance sobre public.ordenes (fase4d); ';
  END IF;
  IF to_regclass('public.ordenes') IS NULL OR to_regclass('public.orden_items') IS NULL
     OR to_regclass('public.perfiles') IS NULL THEN
    v_fail := v_fail || 'faltan tablas base (ordenes/orden_items/perfiles); ';
  END IF;
  -- SYNC-2 debe seguir cerrando el acceso directo del MECÁNICO: orden_items solo se escribe por RPC (cero
  -- políticas de escritura, sin excepción). ordenes SÍ conserva ordenes_crea/ordenes_edita para admin/cajero
  -- (ve_todo_el_taller(), de fase4d/SYNC-2 — nunca se quitan, el Taller sigue escribiendo la tabla directo); lo
  -- que no debe existir ahí es una política de escritura que dé paso al mecánico (comprobado por texto, igual
  -- que el propio postcondition de SYNC-2 en sync-2-seguridad.sql).
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'orden_items'
              AND cmd IN ('INSERT', 'UPDATE', 'DELETE')) THEN
    v_fail := v_fail || 'orden_items tiene una política de escritura para authenticated (debe ser solo por RPC): SYNC-2 no está intacto; ';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ordenes' AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
              AND (COALESCE(qual, '') ~* 'es_mecanico_activo|mecanico_id\s*=\s*auth\.uid'
                   OR COALESCE(with_check, '') ~* 'es_mecanico_activo|mecanico_id\s*=\s*auth\.uid')) THEN
    v_fail := v_fail || 'ordenes tiene una política de escritura que da acceso directo al mecánico: SYNC-2 no está intacto; ';
  END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-6 STOP (precondiciones, nada modificado): %', v_fail; END IF;
END
$pre$;

-- 1. LECTURA SEGURA PARA EL MECÁNICO --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ordenes_tecnico_mias()
 RETURNS TABLE (
   id uuid, estado text, falla text, diagnostico jsonb, reparacion_notas text, calidad_checklist jsonb,
   fotos jsonb, km_salida numeric, garantia_dias integer, mecanico text, mecanico_id uuid,
   finalizada boolean, finalizado_en timestamptz, entregado_en timestamptz, origen_trabajo text,
   cliente_nombre text, cliente_telefono text, moto_marca text, moto_modelo text, moto_placa text,
   items jsonb, updated_at timestamptz, rev integer, deleted_at timestamptz
 )
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT
    o.id, o.estado, o.falla, o.diagnostico, o.reparacion_notas, o.calidad_checklist, o.fotos,
    o.km_salida, o.garantia_dias, o.mecanico, o.mecanico_id, o.finalizada, o.finalizado_en,
    o.entregado_en, o.origen_trabajo,
    c.nombre, c.telefono, m.marca, m.modelo, m.placa,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id', oi.id, 'nombre', oi.nombre, 'cantidad', oi.cantidad) ORDER BY oi.creado_en)
                FROM public.orden_items oi WHERE oi.orden_id = o.id), '[]'::jsonb),
    o.updated_at, o.rev, o.deleted_at
  FROM public.ordenes o
  LEFT JOIN public.clientes c ON c.id = o.cliente_id
  LEFT JOIN public.motos m ON m.id = o.moto_id
  WHERE public.es_mecanico_activo() AND o.mecanico_id = auth.uid() AND o.deleted_at IS NULL
$function$;

REVOKE EXECUTE ON FUNCTION public.ordenes_tecnico_mias() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ordenes_tecnico_mias() TO authenticated, service_role;

-- 2. AVANCE TÉCNICO (ESCRITURA) --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.avanzar_orden_tecnico(p_op uuid, p_orden_id uuid, p_campos jsonb, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_prev jsonb; v_hash text; o record; v_res jsonb; v_k text;
  v_permitidos text[] := ARRAY['estado', 'diagnostico', 'reparacion_notas', 'calidad_checklist', 'fotos', 'km_salida', 'falla'];
BEGIN
  IF NOT public.es_mecanico_activo() THEN
    RAISE EXCEPTION 'Solo un mecánico activo avanza el trabajo técnico' USING ERRCODE = '42501';
  END IF;
  IF p_campos IS NULL OR jsonb_typeof(p_campos) <> 'object' OR p_campos = '{}'::jsonb THEN
    RAISE EXCEPTION 'No hay ningún campo técnico para guardar' USING ERRCODE = '22023';
  END IF;
  FOR v_k IN SELECT jsonb_object_keys(p_campos) LOOP
    IF NOT (v_k = ANY (v_permitidos)) THEN
      RAISE EXCEPTION 'Un mecánico no puede modificar «%»', v_k USING ERRCODE = '42501';
    END IF;
  END LOOP;

  v_hash := md5(jsonb_build_array(p_orden_id, p_campos)::text);
  v_prev := public.sync_op_iniciar(p_op, 'avanzar_orden_tecnico', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  SELECT ord.id, ord.mecanico_id, ord.estado, ord.finalizada, ord.anulada, ord.deleted_at
    INTO o FROM public.ordenes ord WHERE ord.id = p_orden_id FOR UPDATE;
  IF NOT FOUND OR o.deleted_at IS NOT NULL THEN
    -- SYNC-10 (P0002, reproducido en SYNC-11): P0002 llega por PostgREST como HTTP 500 → clase «servidor» → la cola lo
    -- reintentaba cada ≤5 min PARA SIEMPRE (la orden ya no existe: nunca va a funcionar). 23503 (dependencia inexistente)
    -- → 409 → clase «conflicto» → rechazo terminal, visible en «⚠ Por revisar». Mismo criterio que SYNC-7B con el dinero.
    RAISE EXCEPTION 'La orden no existe' USING ERRCODE = '23503';
  END IF;
  -- SYNC-6 sección 9, caso 1: reasignada mientras el mecánico estaba desconectado.
  IF o.mecanico_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'La orden ya no está asignada a tu cuenta.' USING ERRCODE = '42501';
  END IF;
  -- SYNC-6 sección 9, caso 2: entregada/anulada mientras el mecánico estaba desconectado. Nunca se reabre.
  -- ERRCODE de clase 22 (data exception) a propósito, NO 55000: PostgREST mapea la clase 55 a HTTP 500, y el
  -- cliente (sync-rest.js) clasifica cualquier 5xx como clase "servidor" (se reintenta más tarde) — exactamente
  -- lo que SYNC-6 sección 9 NO quiere aquí (el cierre es definitivo, nunca se arregla reintentando). Clase 22
  -- mapea a HTTP 400 -> clase "validacion" en el cliente (rechazo terminal), verificado contra PostgREST real.
  IF o.finalizada OR o.anulada OR o.estado = 'entregado' THEN
    RAISE EXCEPTION 'Este trabajo ya no admite cambios técnicos: se cerró mientras estabas desconectado.' USING ERRCODE = '22000';
  END IF;

  -- El trigger ordenes_mecanico_avance (fase4d) impone el resto: una etapa por vez, nunca "entregado",
  -- mecanico_id/mecanico intocables, y fail-closed si algo fuera de v_permitidos cambiara.
  UPDATE public.ordenes SET
    estado            = COALESCE(p_campos ->> 'estado', estado),
    diagnostico       = CASE WHEN p_campos ? 'diagnostico' THEN p_campos -> 'diagnostico' ELSE diagnostico END,
    reparacion_notas  = CASE WHEN p_campos ? 'reparacion_notas' THEN p_campos ->> 'reparacion_notas' ELSE reparacion_notas END,
    calidad_checklist = CASE WHEN p_campos ? 'calidad_checklist' THEN p_campos -> 'calidad_checklist' ELSE calidad_checklist END,
    fotos             = CASE WHEN p_campos ? 'fotos' THEN p_campos -> 'fotos' ELSE fotos END,
    km_salida         = CASE WHEN p_campos ? 'km_salida' THEN (p_campos ->> 'km_salida')::numeric ELSE km_salida END,
    falla             = CASE WHEN p_campos ? 'falla' THEN p_campos ->> 'falla' ELSE falla END
  WHERE id = p_orden_id;

  PERFORM public.sync_auditar('avance-tecnico', 'ordenes', p_orden_id::text, p_campos::text, p_op, p_device);
  v_res := jsonb_build_object('orden_id', p_orden_id, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'avanzar_orden_tecnico', v_hash, p_device, v_res);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.avanzar_orden_tecnico(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.avanzar_orden_tecnico(uuid, uuid, jsonb, text) TO authenticated, service_role;

-- POSTCONDICIONES (fallan cerradas) ---------------------------------------------------------------------------
DO $post$
DECLARE v_fail text := '';
BEGIN
  IF to_regprocedure('public.ordenes_tecnico_mias()') IS NULL THEN v_fail := v_fail || 'falta ordenes_tecnico_mias(); '; END IF;
  IF to_regprocedure('public.avanzar_orden_tecnico(uuid,uuid,jsonb,text)') IS NULL THEN v_fail := v_fail || 'falta avanzar_orden_tecnico(); '; END IF;
  IF has_function_privilege('anon', 'public.ordenes_tecnico_mias()', 'EXECUTE') THEN v_fail := v_fail || 'ordenes_tecnico_mias() ejecutable por anon; '; END IF;
  IF has_function_privilege('anon', 'public.avanzar_orden_tecnico(uuid,uuid,jsonb,text)', 'EXECUTE') THEN v_fail := v_fail || 'avanzar_orden_tecnico() ejecutable por anon; '; END IF;
  -- SYNC-2 sigue intacto: el mecánico sigue sin poder escribir la tabla directo (su único camino es la RPC de
  -- arriba). ordenes_crea/ordenes_edita (admin/cajero, ve_todo_el_taller()) siguen ahí a propósito.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'orden_items' AND cmd IN ('INSERT', 'UPDATE', 'DELETE')) THEN
    v_fail := v_fail || 'orden_items ganó una política de escritura: SYNC-2 ya no está intacto; ';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ordenes' AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
              AND (COALESCE(qual, '') ~* 'es_mecanico_activo|mecanico_id\s*=\s*auth\.uid'
                   OR COALESCE(with_check, '') ~* 'es_mecanico_activo|mecanico_id\s*=\s*auth\.uid')) THEN
    v_fail := v_fail || 'ordenes ganó una política de escritura que da acceso directo al mecánico: SYNC-2 ya no está intacto; ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ordenes_mecanico_avance' AND tgrelid = 'public.ordenes'::regclass AND NOT tgisinternal) THEN
    v_fail := v_fail || 'el trigger ordenes_mecanico_avance desapareció; ';
  END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-6 STOP (postcondiciones, se revierte todo): %', v_fail; END IF;
  RAISE NOTICE 'SYNC-6: postcondiciones OK (lectura y avance técnico del mecánico solo por función, RLS directa sigue cerrada).';
END
$post$;

COMMIT;
