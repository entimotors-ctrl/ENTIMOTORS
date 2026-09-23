-- ENTIMOTORS OS 3.14.0 · SYNC-9 · FOTOS DE ÓRDENES: LIGADO SOLO-AGREGAR + LÍMITES DEL BUCKET · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere SYNC-1, SYNC-2, SYNC-3 y SYNC-6 ya aplicados.
--
-- POR QUÉ (defectos DEMOSTRADOS contra PostgREST + Postgres + storage-api reales, pruebas/sync/browser/sync9-core):
--   1. PÉRDIDA DE FOTOS ENTRE DISPOSITIVOS. Mi Trabajo ligaba cada foto con avanzar_orden_tecnico (SYNC-6) mandando
--      el arreglo `fotos` COMPLETO de su copia local: el dispositivo 2 del mismo mecánico reemplazaba ["p1"] por
--      ["p2"] y la foto p1 (ya en Storage) desaparecía de la orden.
--   2. FOTO SUBIDA Y NUNCA LIGADA. Ese mismo ligado mandaba también el `estado` local; con un estado viejo el
--      trigger ordenes_mecanico_avance lo rechaza ("una etapa a la vez") y la foto quedaba huérfana.
--   3. METADATA SIN OBJETO. `fotos` aceptaba cualquier texto (rutas de otra orden, URLs).
--   4. BUCKET SIN LÍMITES. entimotors-taller aceptaba cualquier tipo y tamaño (un text/plain vacío, por ejemplo).
--
-- QUÉ HACE (aditivo; NO toca avanzar_orden_tecnico, ni las políticas de Storage de SYNC-2, ni las 17 de RCV-34)
--   · public.agregar_foto_orden(p_op, p_orden_id, p_path, p_device): AGREGA una ruta a ordenes.fotos si no estaba
--     (nunca reemplaza el arreglo). Mismas reglas que avanzar_orden_tecnico: solo mecánico ACTIVO, orden asignada a
--     quien llama (si no, 42501 "ya no está asignada"), orden abierta (si no, 22000). Además: la ruta debe ser
--     EXACTAMENTE ordenes/<p_orden_id>/<uuid>.jpg (22023) y el objeto debe EXISTIR en Storage y no estar vacío (23503/
--     22023): nunca metadata apuntando a nada. Idempotente por operation_id (sync_op_iniciar/sync_op_guardar).
--   · entimotors-taller: allowed_mime_types = {image/jpeg} (lo único que produce el cliente: SyncFotos.comprimir) y
--     file_size_limit = 10 MiB (una foto comprimida a 1600 px ronda cientos de KB). Solo afecta subidas NUEVAS.
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
  IF to_regprocedure('public.es_mecanico_activo()') IS NULL THEN v_fail := v_fail || 'falta es_mecanico_activo(); '; END IF;
  IF to_regprocedure('public.avanzar_orden_tecnico(uuid,uuid,jsonb,text)') IS NULL THEN v_fail := v_fail || 'falta SYNC-6 (avanzar_orden_tecnico); '; END IF;
  IF to_regclass('public.ordenes') IS NULL OR to_regclass('storage.objects') IS NULL OR to_regclass('storage.buckets') IS NULL THEN
    v_fail := v_fail || 'faltan tablas base (ordenes / storage.objects / storage.buckets); ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'entimotors-taller' AND public = false) THEN
    v_fail := v_fail || 'el bucket entimotors-taller no existe o no es privado; ';
  END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-9 STOP (precondiciones, nada modificado): %', v_fail; END IF;
END
$pre$;

-- LIGADO SOLO-AGREGAR -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agregar_foto_orden(p_op uuid, p_orden_id uuid, p_path text, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; o record; v_tam bigint; v_res jsonb;
BEGIN
  IF NOT public.es_mecanico_activo() THEN
    RAISE EXCEPTION 'Solo un mecánico activo agrega fotos a su trabajo' USING ERRCODE = '42501';
  END IF;
  IF p_orden_id IS NULL OR p_path IS NULL
     OR p_path !~ ('^ordenes/' || lower(p_orden_id::text) || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$') THEN
    RAISE EXCEPTION 'Ruta de foto inválida para esta orden' USING ERRCODE = '22023';
  END IF;

  v_hash := md5(jsonb_build_array(p_orden_id, p_path)::text);
  v_prev := public.sync_op_iniciar(p_op, 'agregar_foto_orden', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  SELECT ord.id, ord.mecanico_id, ord.estado, ord.finalizada, ord.anulada, ord.deleted_at
    INTO o FROM public.ordenes ord WHERE ord.id = p_orden_id FOR UPDATE;
  IF NOT FOUND OR o.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'La orden no existe' USING ERRCODE = '23503';
  END IF;
  IF o.mecanico_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'La orden ya no está asignada a tu cuenta.' USING ERRCODE = '42501';
  END IF;
  IF o.finalizada OR o.anulada OR o.estado = 'entregado' THEN
    RAISE EXCEPTION 'Este trabajo ya no admite cambios técnicos: se cerró mientras estabas desconectado.' USING ERRCODE = '22000';
  END IF;
  -- nunca metadata sin objeto: la foto tiene que estar de verdad en el bucket privado, y no vacía
  SELECT COALESCE((so.metadata ->> 'size')::bigint, 0) INTO v_tam
    FROM storage.objects so WHERE so.bucket_id = 'entimotors-taller' AND so.name = p_path;
  IF NOT FOUND THEN RAISE EXCEPTION 'La foto no está en el almacenamiento' USING ERRCODE = '23503'; END IF;
  IF v_tam <= 0 THEN RAISE EXCEPTION 'La foto está vacía' USING ERRCODE = '22023'; END IF;

  -- SOLO AGREGA (nunca reemplaza el arreglo): dos dispositivos del mismo mecánico ya no se pisan las fotos
  UPDATE public.ordenes
     SET fotos = CASE WHEN COALESCE(fotos, '[]'::jsonb) ? p_path THEN fotos ELSE COALESCE(fotos, '[]'::jsonb) || jsonb_build_array(p_path) END
   WHERE id = p_orden_id;

  PERFORM public.sync_auditar('agregar-foto', 'ordenes', p_orden_id::text, p_path, p_op, p_device);
  v_res := jsonb_build_object('orden_id', p_orden_id, 'path', p_path, 'repetida', false);
  RETURN public.sync_op_guardar(p_op, 'agregar_foto_orden', v_hash, p_device, v_res);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.agregar_foto_orden(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agregar_foto_orden(uuid, uuid, text, text) TO authenticated, service_role;

-- LÍMITES DEL BUCKET PRIVADO (solo subidas nuevas; lo ya guardado no se toca) --------------------------------------
UPDATE storage.buckets SET allowed_mime_types = ARRAY['image/jpeg'], file_size_limit = 10485760 WHERE id = 'entimotors-taller';

-- POSTCONDICIONES (fallan cerradas) ---------------------------------------------------------------------------
DO $post$
DECLARE v_fail text := '';
BEGIN
  IF to_regprocedure('public.agregar_foto_orden(uuid,uuid,text,text)') IS NULL THEN v_fail := v_fail || 'falta agregar_foto_orden(); '; END IF;
  IF has_function_privilege('anon', 'public.agregar_foto_orden(uuid,uuid,text,text)', 'EXECUTE') THEN
    v_fail := v_fail || 'agregar_foto_orden() ejecutable por anon; ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'entimotors-taller' AND public = false
                  AND allowed_mime_types = ARRAY['image/jpeg'] AND file_size_limit = 10485760) THEN
    v_fail := v_fail || 'límites de entimotors-taller no aplicados; ';
  END IF;
  -- SYNC-2 intacto: las políticas de Storage no cambian aquí
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname IN ('taller_lee_media', 'taller_sube_media', 'taller_borra_media')) <> 3 THEN
    v_fail := v_fail || 'faltan políticas de Storage de SYNC-2/producción; ';
  END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-9 STOP (postcondiciones, se revierte todo): %', v_fail; END IF;
  RAISE NOTICE 'SYNC-9: postcondiciones OK (ligado de fotos solo-agregar; bucket privado con límites).';
END
$post$;

COMMIT;
