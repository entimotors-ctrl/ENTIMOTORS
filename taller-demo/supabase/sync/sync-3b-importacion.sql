-- ENTIMOTORS OS 3.14.0 · SYNC-3b · IMPORTACIÓN DEL RESPALDO POR LOTE · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere sync-1, sync-2 y sync-3-rpc aplicados.
--
-- UN SOLO ORIGEN REAL (el dispositivo del cliente). Flujo, todo solo para el administrador:
--   import_iniciar        crea el lote (dry_run). Exige nube vacía de datos operativos y NINGÚN otro lote aplicado.
--   import_dry_run_ok     registra el informe del dry-run; sin él, no se puede aplicar (el servidor lo exige).
--   import_guardar_mapeo  D-5: por cada nombre de mecánico legado, perfil real o SIN ASIGNAR. Nunca por nombre.
--   import_aplicar_lote   inserta un trozo de una tabla (orden de dependencias lo lleva el cliente). ON CONFLICT DO NOTHING
--                         sobre las llaves únicas → reimportar el mismo trozo no duplica. Los ids son UUID deterministas
--                         por origen/entidad/local_id calculados por el cliente; NUNCA se fusiona por entero.
--                         El inventario entra con cantidad 0 y su saldo llega como movimiento de apertura del ledger.
--                         Las ventas y créditos históricos se insertan tal cual: NO tocan stock ni caja de hoy.
--   import_cerrar_carga   el lote pasa a 'aplicado'.
--   import_confirmar_lote 'confirmado': cierra el rollback y cualquier segundo import.
--   revertir_lote_importacion  SOLO antes de confirmar y sin actividad posterior; única puerta de borrado físico.
-- El registro de auditoría local NO se importa (queda en el respaldo original): la auditoría del servidor sella identidad real.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regprocedure('public.sync_op_iniciar(uuid,text,text)') IS NULL THEN RAISE EXCEPTION 'SYNC-3b STOP: falta sync-3-rpc'; END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.import_iniciar(p_lote uuid, p_legacy_device text, p_sha256 text, p_backup_id text,
    p_version_app text, p_esquema integer, p_conteos jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_n bigint; v_id uuid := COALESCE(p_lote, gen_random_uuid());
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador importa' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.import_lotes WHERE estado IN ('aplicado', 'confirmado')) THEN
    RAISE EXCEPTION 'Ya hay un lote de importación aplicado: solo se permite uno' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_lotes WHERE id = v_id) THEN
    RETURN jsonb_build_object('lote_id', v_id, 'reanudado', true);
  END IF;
  SELECT (SELECT count(*) FROM public.clientes) + (SELECT count(*) FROM public.motos) + (SELECT count(*) FROM public.inventario)
       + (SELECT count(*) FROM public.ordenes) + (SELECT count(*) FROM public.ventas) + (SELECT count(*) FROM public.creditos)
       + (SELECT count(*) FROM public.caja_movimientos) + (SELECT count(*) FROM public.citas) + (SELECT count(*) FROM public.cotizaciones)
       + (SELECT count(*) FROM public.categorias_inv) INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'La nube ya tiene datos operativos (% filas): la importación inicial exige una base vacía', v_n USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.import_lotes (id, legacy_device_id, backup_sha256, backup_id, version_app, esquema_db, estado, conteos_leidos, creado_por)
  VALUES (v_id, p_legacy_device, p_sha256, p_backup_id, p_version_app, p_esquema, 'dry_run', p_conteos, auth.uid());
  RETURN jsonb_build_object('lote_id', v_id, 'nube_vacia', true, 'reanudado', false);
END
$function$;

CREATE OR REPLACE FUNCTION public.import_dry_run_ok(p_lote uuid, p_informe jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador importa' USING ERRCODE = '42501'; END IF;
  UPDATE public.import_lotes SET estado = 'dry_run_ok', informe = p_informe WHERE id = p_lote AND estado IN ('dry_run', 'dry_run_ok');
  IF NOT FOUND THEN RAISE EXCEPTION 'El lote no está en dry-run' USING ERRCODE = '55000'; END IF;
  RETURN jsonb_build_object('lote_id', p_lote, 'estado', 'dry_run_ok');
END
$function$;

CREATE OR REPLACE FUNCTION public.import_guardar_mapeo(p_lote uuid, p_mapeo jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE x record; n int := 0;
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador importa' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.import_lotes WHERE id = p_lote AND estado IN ('dry_run', 'dry_run_ok', 'aplicando')) THEN
    RAISE EXCEPTION 'El lote no admite mapeo' USING ERRCODE = '55000';
  END IF;
  FOR x IN SELECT * FROM jsonb_to_recordset(p_mapeo) AS m(nombre text, perfil_id uuid, sin_asignar boolean, conteos jsonb) LOOP
    IF x.nombre IS NULL OR btrim(x.nombre) = '' THEN RAISE EXCEPTION 'Nombre legado vacío' USING ERRCODE = '22023'; END IF;
    IF x.perfil_id IS NULL AND NOT COALESCE(x.sin_asignar, false) THEN
      RAISE EXCEPTION 'El nombre «%» necesita un perfil real o SIN ASIGNAR (no se adivina por nombre)', x.nombre USING ERRCODE = '22023';
    END IF;
    IF x.perfil_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.perfiles p WHERE p.id = x.perfil_id) THEN
      RAISE EXCEPTION 'El perfil elegido para «%» no existe', x.nombre USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.import_mapeo_mecanicos (lote_id, nombre_legado, perfil_id, sin_asignar, conteos, decidido_por)
    VALUES (p_lote, x.nombre, x.perfil_id, x.perfil_id IS NULL, x.conteos, auth.uid())
    ON CONFLICT (lote_id, nombre_legado) DO UPDATE SET perfil_id = EXCLUDED.perfil_id, sin_asignar = EXCLUDED.sin_asignar,
        conteos = EXCLUDED.conteos, decidido_por = EXCLUDED.decidido_por, decidido_en = clock_timestamp();
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('lote_id', p_lote, 'decisiones', n);
END
$function$;

CREATE OR REPLACE FUNCTION public.import_aplicar_lote(p_lote uuid, p_tabla text, p_filas jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_estado text; v_cols text; v_leidas int; v_ins int := 0; v_excl text[]; r record; v_mov uuid; v_rid uuid;
  v_tablas text[] := ARRAY['categorias_inv','clientes','motos','inventario','ordenes','orden_items','cotizaciones','cotizacion_items',
                           'citas','ventas','venta_items','creditos','credito_items','abonos','caja_movimientos','web_cms'];
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador importa' USING ERRCODE = '42501'; END IF;
  SELECT estado INTO v_estado FROM public.import_lotes WHERE id = p_lote FOR UPDATE;
  IF NOT FOUND OR v_estado NOT IN ('dry_run_ok', 'aplicando') THEN
    RAISE EXCEPTION 'El lote no está listo para aplicar: el dry-run es obligatorio (estado %)', COALESCE(v_estado, 'inexistente') USING ERRCODE = '55000';
  END IF;
  IF p_filas IS NULL OR jsonb_typeof(p_filas) <> 'array' THEN RAISE EXCEPTION 'p_filas debe ser un arreglo' USING ERRCODE = '22023'; END IF;
  UPDATE public.import_lotes SET estado = 'aplicando' WHERE id = p_lote AND estado = 'dry_run_ok';
  v_leidas := jsonb_array_length(p_filas);

  IF p_tabla = 'enlaces' THEN
    -- referencias hacia atrás (ordenes.credito_id) una vez que ya existen los créditos
    UPDATE public.ordenes o SET credito_id = x.credito_id
      FROM jsonb_to_recordset(p_filas) AS x(id uuid, credito_id uuid)
     WHERE o.id = x.id AND EXISTS (SELECT 1 FROM public.import_registros ir WHERE ir.lote_id = p_lote AND ir.tabla = 'ordenes' AND ir.registro_id = x.id);
    GET DIAGNOSTICS v_ins = ROW_COUNT;
    RETURN jsonb_build_object('tabla', p_tabla, 'leidas', v_leidas, 'insertadas', v_ins, 'omitidas', v_leidas - v_ins);
  END IF;

  IF NOT (p_tabla = ANY (v_tablas)) THEN RAISE EXCEPTION 'Tabla no importable: %', p_tabla USING ERRCODE = '22023'; END IF;
  -- columnas que el servidor gobierna: nunca se aceptan del respaldo
  v_excl := ARRAY['updated_at','rev','created_by','updated_by','last_op_id','deleted_at','deleted_by','op_id'];
  IF p_tabla = 'inventario' THEN v_excl := v_excl || ARRAY['cantidad','requiere_revision','revision_motivo','revision_desde']; END IF;
  IF p_tabla = 'ordenes' THEN v_excl := v_excl || ARRAY['credito_id']; END IF;
  -- fila por fila con SUS propias claves: lo que el respaldo no trae toma el DEFAULT de la columna (no un NULL)
  FOR r IN SELECT f FROM jsonb_array_elements(p_filas) AS f LOOP
    SELECT string_agg(quote_ident(k), ', ' ORDER BY k) INTO v_cols
      FROM (SELECT jsonb_object_keys(r.f) AS k) q
     WHERE k IN (SELECT c.column_name FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = p_tabla)
       AND NOT (k = ANY (v_excl));
    CONTINUE WHEN v_cols IS NULL;
    v_rid := NULL;
    IF p_tabla = 'web_cms' THEN
      EXECUTE format('INSERT INTO public.web_cms (%s) SELECT %s FROM jsonb_populate_record(NULL::public.web_cms, $1) ON CONFLICT DO NOTHING RETURNING md5(clave)::uuid', v_cols, v_cols) INTO v_rid USING r.f;
    ELSE
      EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) ON CONFLICT DO NOTHING RETURNING id', p_tabla, v_cols, v_cols, p_tabla) INTO v_rid USING r.f;
    END IF;
    IF v_rid IS NOT NULL THEN
      INSERT INTO public.import_registros (lote_id, tabla, registro_id) VALUES (p_lote, p_tabla, v_rid);
      v_ins := v_ins + 1;
    END IF;
  END LOOP;

  IF p_tabla = 'inventario' THEN
    -- el saldo del respaldo entra como apertura del ledger (así cantidad = suma del ledger, también para lo importado)
    FOR r IN SELECT x.id, x.cantidad FROM jsonb_to_recordset(p_filas) AS x(id uuid, cantidad numeric)
              WHERE x.cantidad IS NOT NULL AND x.cantidad <> 0
                AND EXISTS (SELECT 1 FROM public.import_registros ir WHERE ir.lote_id = p_lote AND ir.tabla = 'inventario' AND ir.registro_id = x.id)
                AND NOT EXISTS (SELECT 1 FROM public.inventario_movimientos m WHERE m.inventario_id = x.id AND m.tipo = 'importacion') LOOP
      INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad, motivo, created_by)
      VALUES (r.id, 'importacion', r.cantidad, 'Apertura por importación del respaldo', auth.uid()) RETURNING id INTO v_mov;
      INSERT INTO public.import_registros (lote_id, tabla, registro_id) VALUES (p_lote, 'inventario_movimientos', v_mov);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('tabla', p_tabla, 'leidas', v_leidas, 'insertadas', v_ins, 'omitidas', v_leidas - v_ins);
END
$function$;

CREATE OR REPLACE FUNCTION public.import_cerrar_carga(p_lote uuid, p_conteos jsonb DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_c jsonb;
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador importa' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(jsonb_object_agg(tabla, n), '{}'::jsonb) INTO v_c FROM (SELECT tabla, count(*) AS n FROM public.import_registros WHERE lote_id = p_lote GROUP BY tabla) q;
  UPDATE public.import_lotes SET estado = 'aplicado', aplicado_en = clock_timestamp(), conteos_insertados = v_c, conteos_omitidos = p_conteos
   WHERE id = p_lote AND estado = 'aplicando';
  IF NOT FOUND THEN RAISE EXCEPTION 'El lote no está aplicándose' USING ERRCODE = '55000'; END IF;
  RETURN jsonb_build_object('lote_id', p_lote, 'estado', 'aplicado', 'insertadas', v_c);
END
$function$;

CREATE OR REPLACE FUNCTION public.import_confirmar_lote(p_lote uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador importa' USING ERRCODE = '42501'; END IF;
  UPDATE public.import_lotes SET estado = 'confirmado', confirmado_en = clock_timestamp() WHERE id = p_lote AND estado = 'aplicado';
  IF NOT FOUND THEN RAISE EXCEPTION 'Solo se confirma un lote aplicado' USING ERRCODE = '55000'; END IF;
  RETURN jsonb_build_object('lote_id', p_lote, 'estado', 'confirmado');
END
$function$;

-- Rollback: SOLO antes de confirmar y sin actividad posterior. Es la única puerta de borrado físico del sistema.
CREATE OR REPLACE FUNCTION public.revertir_lote_importacion(p_lote uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE l record; t text; n int; v_tot jsonb := '{}'::jsonb;
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador revierte una importación' USING ERRCODE = '42501'; END IF;
  SELECT * INTO l FROM public.import_lotes WHERE id = p_lote FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El lote no existe' USING ERRCODE = 'P0002'; END IF;
  IF l.estado = 'confirmado' THEN RAISE EXCEPTION 'El lote ya fue CONFIRMADO: ya no se puede revertir' USING ERRCODE = '55000'; END IF;
  IF l.estado <> 'aplicado' THEN RAISE EXCEPTION 'Solo se revierte un lote aplicado (estado %)', l.estado USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM public.sync_ops o WHERE o.creado_en >= l.aplicado_en) OR EXISTS (SELECT 1 FROM public.reversos r WHERE r.creado_en >= l.aplicado_en) THEN
    RAISE EXCEPTION 'Ya hay actividad posterior a la importación: no se puede revertir sin perder trabajo real' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('entimotors.rollback_lote', p_lote::text, true);
  -- el trigger de RCV-34 protege la caja ligada; solo aquí, dentro de esta transacción, se suspende y se restablece
  ALTER TABLE public.caja_movimientos DISABLE TRIGGER no_borrar_caja_ligada;
  FOREACH t IN ARRAY ARRAY['caja_movimientos','abonos','credito_items','creditos','venta_items','ventas','citas','cotizacion_items',
                           'cotizaciones','orden_items','ordenes','inventario_movimientos','inventario','motos','clientes','categorias_inv'] LOOP
    EXECUTE format('DELETE FROM public.%I WHERE id IN (SELECT registro_id FROM public.import_registros WHERE lote_id = $1 AND tabla = %L)', t, t) USING p_lote;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_tot := v_tot || jsonb_build_object(t, n);
  END LOOP;
  DELETE FROM public.web_cms WHERE md5(clave)::uuid IN (SELECT registro_id FROM public.import_registros WHERE lote_id = p_lote AND tabla = 'web_cms');
  ALTER TABLE public.caja_movimientos ENABLE TRIGGER no_borrar_caja_ligada;
  PERFORM set_config('entimotors.rollback_lote', '', true);
  UPDATE public.import_lotes SET estado = 'revertido', revertido_en = clock_timestamp() WHERE id = p_lote;
  RETURN jsonb_build_object('lote_id', p_lote, 'estado', 'revertido', 'borradas', v_tot);
END
$function$;

-- Totales para verificar la importación contra el respaldo (conteos, ventas, caja por día, créditos, stock).
CREATE OR REPLACE FUNCTION public.import_totales()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v jsonb;
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object(
    'clientes', (SELECT count(*) FROM public.clientes), 'motos', (SELECT count(*) FROM public.motos),
    'inventario', jsonb_build_object('n', (SELECT count(*) FROM public.inventario), 'unidades', (SELECT COALESCE(sum(cantidad), 0) FROM public.inventario)),
    'ordenes', (SELECT count(*) FROM public.ordenes), 'citas', (SELECT count(*) FROM public.citas), 'cotizaciones', (SELECT count(*) FROM public.cotizaciones),
    'ventas', jsonb_build_object('n', (SELECT count(*) FROM public.ventas), 'total', (SELECT COALESCE(sum(total), 0) FROM public.ventas)),
    'creditos', jsonb_build_object('n', (SELECT count(*) FROM public.creditos), 'total', (SELECT COALESCE(sum(total), 0) FROM public.creditos), 'saldo', (SELECT COALESCE(sum(saldo), 0) FROM public.creditos)),
    'abonos', jsonb_build_object('n', (SELECT count(*) FROM public.abonos), 'monto', (SELECT COALESCE(sum(monto), 0) FROM public.abonos)),
    'caja', jsonb_build_object('ingresos', (SELECT COALESCE(sum(monto), 0) FROM public.caja_movimientos WHERE tipo = 'ingreso'), 'egresos', (SELECT COALESCE(sum(monto), 0) FROM public.caja_movimientos WHERE tipo = 'egreso'),
       'por_dia', (SELECT COALESCE(jsonb_object_agg(d, neto), '{}'::jsonb) FROM (SELECT (COALESCE(occurred_at, creado_en) AT TIME ZONE 'UTC')::date::text AS d,
                     sum(CASE tipo WHEN 'ingreso' THEN monto ELSE -monto END) AS neto FROM public.caja_movimientos GROUP BY 1) q))
  ) INTO v;
  RETURN v;
END
$function$;

-- ACL: ninguna función es ejecutable por PUBLIC ni anon (sentencias literales para el guard REV8)
REVOKE EXECUTE ON FUNCTION public.import_iniciar(uuid,text,text,text,text,integer,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_iniciar(uuid,text,text,text,text,integer,jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.import_dry_run_ok(uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_dry_run_ok(uuid,jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.import_guardar_mapeo(uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_guardar_mapeo(uuid,jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.import_aplicar_lote(uuid,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_aplicar_lote(uuid,text,jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.import_cerrar_carga(uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_cerrar_carga(uuid,jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.import_confirmar_lote(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_confirmar_lote(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.revertir_lote_importacion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revertir_lote_importacion(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.import_totales() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_totales() TO authenticated, service_role;

COMMIT;
