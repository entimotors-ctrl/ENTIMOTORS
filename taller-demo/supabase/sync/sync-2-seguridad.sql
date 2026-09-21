-- ENTIMOTORS OS 3.14.0 · SYNC-2 · RLS Y SEGURIDAD POR ROL · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere sync-1-esquema.sql ya aplicado.
--
-- SEGURIDAD BASADA SOLO EN auth.uid(), perfil, rol, activo y mecanico_id (D-1: un solo taller, sin tenant).
-- PARTE DE LAS POLÍTICAS REALES de producción (catálogo SYNC-0). Lo que cambia:
--   1. DINERO (ventas, venta_items, creditos, credito_items, abonos, caja_movimientos): authenticated ya no inserta,
--      modifica ni borra; solo las RPC SECURITY DEFINER (SYNC-3). Hoy el cajero puede insertar directo en ventas/créditos/
--      abonos y actualizar créditos sin pasar por ninguna regla, y el admin puede borrar y editar ventas y caja.
--   2. NADIE BORRA FÍSICAMENTE (REVERSAL_ONLY): trigger sync_guardia en dinero, ledger, reversos, sync_ops, auditoría,
--      autorizaciones y en los maestros (estos usan borrado suave). También frente a service_role y al dueño de la tabla.
--      ÚNICA excepción: rollback de una importación aún NO confirmada (GUC entimotors.rollback_lote + lote 'aplicado').
--   3. INVENTARIO: la cantidad solo cambia por el ledger (privilegios por columna). Maestro de productos solo admin (D-4).
--   4. ÓRDENES: UPDATE por columnas (finalización, margen, anulación y borrado son de las RPC). El mecánico deja de leer
--      `ordenes`/`citas`/`clientes`/`motos` directamente (hoy ve margen, tipo de cobro y método de pago de sus órdenes):
--      su acceso pasa a RPC que devuelven solo columnas seguras (SYNC-6).
--   5. AUDITORÍA: solo se agrega; el trigger sella usuario, rol e identidad reales (hoy cualquiera del equipo puede insertar
--      filas con cualquier usuario y rol).
--   6. STORAGE: rutas <entidad>/<registro_uuid>/<archivo>; el mecánico solo lee/sube fotos de órdenes que tiene asignadas.
--   7. Se quitan TRUNCATE/REFERENCES/TRIGGER/MAINTAIN a authenticated en todas las tablas operativas.
--
-- NO TOCA las 17 funciones fijadas por md5 (RCV-34). Una sola transacción; idempotente; si algo no cuadra, se revierte todo.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

-- PRECONDICIONES ------------------------------------------------------------------------------------------------
DO $pre$
DECLARE v_fail text := '';
BEGIN
  IF to_regclass('public.sync_ops') IS NULL OR to_regprocedure('public.sync_sellar()') IS NULL THEN
    v_fail := v_fail || 'falta SYNC-1 (sync_ops/sync_sellar); ';
  END IF;
  IF to_regclass('storage.objects') IS NULL THEN v_fail := v_fail || 'falta storage.objects; '; END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-2 STOP (precondiciones, nada modificado): %', v_fail; END IF;
END
$pre$;

-- 1. FUNCIONES ----------------------------------------------------------------------------------------------------
-- Guardia única de escritura. Modos (TG_ARGV[0]): 'sin_borrado' (maestros: se borra con deleted_at),
-- 'inmutable' (solo agregar), 'campos' (solo cambian las columnas de TG_ARGV[1]). Bloquea DELETE y TRUNCATE.
-- SECURITY DEFINER para poder consultar import_lotes sin dar acceso a nadie más.
CREATE OR REPLACE FUNCTION public.sync_guardia()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_modo text := TG_ARGV[0];
  v_lote text := current_setting('entimotors.rollback_lote', true);
  v_ok boolean := false;
  v_perm text[];
BEGIN
  -- ÚNICA excepción: el rollback controlado de una importación que todavía no se confirmó.
  IF TG_OP = 'DELETE' AND COALESCE(v_lote, '') <> '' THEN
    SELECT EXISTS (SELECT 1 FROM public.import_lotes l WHERE l.id::text = v_lote AND l.estado = 'aplicado') INTO v_ok;
    IF v_ok THEN RETURN OLD; END IF;
  END IF;

  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'No se puede borrar físicamente en %: %', TG_TABLE_NAME,
      CASE WHEN v_modo = 'sin_borrado' THEN 'usa el borrado suave (deleted_at)'
           ELSE 'la información financiera y de trazabilidad no se borra; se revierte con un movimiento compensatorio' END
      USING ERRCODE = '23001';
  END IF;

  -- UPDATE
  IF v_modo = 'inmutable' THEN
    RAISE EXCEPTION 'La tabla % es de solo agregar: sus registros no se modifican', TG_TABLE_NAME USING ERRCODE = '23001';
  ELSIF v_modo = 'campos' THEN
    v_perm := string_to_array(TG_ARGV[1], ',');
    IF (to_jsonb(NEW) - v_perm) IS DISTINCT FROM (to_jsonb(OLD) - v_perm) THEN
      RAISE EXCEPTION 'En % solo pueden cambiar: %', TG_TABLE_NAME, TG_ARGV[1] USING ERRCODE = '23001';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

-- Borrado suave: solo el administrador borra o restaura un maestro, y deleted_by lo pone el servidor.
CREATE OR REPLACE FUNCTION public.sync_sellar_borrado()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    IF auth.uid() IS NOT NULL AND NOT public.es_admin() THEN
      RAISE EXCEPTION 'Solo el administrador borra o restaura registros' USING ERRCODE = '42501';
    END IF;
    NEW.deleted_by := CASE WHEN NEW.deleted_at IS NULL THEN NULL ELSE COALESCE(auth.uid(), OLD.deleted_by) END;
  ELSE
    NEW.deleted_by := OLD.deleted_by;
  END IF;
  RETURN NEW;
END
$function$;

-- Auditoría: la identidad la pone el servidor; el cliente no puede firmar como otro ni con otro rol.
CREATE OR REPLACE FUNCTION public.sync_auditoria_sellar()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.usuario_id := auth.uid();
    NEW.rol := public.rol_actual();
    NEW.usuario := COALESCE((SELECT p.nombre FROM public.perfiles p WHERE p.id = auth.uid()), '—');
  END IF;
  RETURN NEW;
END
$function$;

-- Storage: ¿es una orden ACTIVA asignada al mecánico que llama? (recibe texto: una ruta mal formada da false, no error)
CREATE OR REPLACE FUNCTION public.mecanico_asignado_a_orden(p_orden text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.es_mecanico_activo()
     AND p_orden ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     AND EXISTS (SELECT 1 FROM public.ordenes o
                  WHERE o.id::text = lower(p_orden) AND o.mecanico_id = auth.uid()
                    AND o.estado <> 'entregado' AND NOT o.anulada AND o.deleted_at IS NULL)
$function$;

REVOKE EXECUTE ON FUNCTION public.sync_guardia() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_guardia() TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_sellar_borrado() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_sellar_borrado() TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_auditoria_sellar() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_auditoria_sellar() TO service_role;
REVOKE EXECUTE ON FUNCTION public.mecanico_asignado_a_orden(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mecanico_asignado_a_orden(text) TO authenticated, service_role;

-- 2. PRIVILEGIOS ------------------------------------------------------------------------------------------------
-- authenticated no necesita TRUNCATE/REFERENCES/TRIGGER/MAINTAIN en ninguna tabla operativa
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.perfiles, public.categorias_inv, public.clientes, public.motos, public.inventario, public.ordenes, public.orden_items,
  public.cotizaciones, public.cotizacion_items, public.citas, public.ventas, public.venta_items, public.creditos,
  public.credito_items, public.abonos, public.caja_movimientos, public.web_cms, public.auditoria
  FROM authenticated;

-- DINERO: solo por RPC. Ni authenticated ni service_role escriben directo (las RPC corren como dueño).
REVOKE INSERT, UPDATE, DELETE ON public.ventas, public.venta_items, public.creditos, public.credito_items,
  public.abonos, public.caja_movimientos FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.ventas, public.venta_items,
  public.creditos, public.credito_items, public.abonos, public.caja_movimientos FROM service_role;

-- las líneas de una orden mueven stock: solo por RPC (agregar/quitar ítem)
REVOKE INSERT, UPDATE, DELETE ON public.orden_items FROM authenticated;

-- maestros: sin borrado físico para nadie (borrado suave)
REVOKE DELETE ON public.clientes, public.motos, public.citas, public.ordenes, public.cotizaciones,
  public.categorias_inv, public.inventario FROM authenticated;

-- ledger, reversos, sync_ops y auditoría: nadie modifica ni borra (service_role solo agrega y lee)
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.inventario_movimientos, public.reversos,
  public.sync_ops, public.admin_pin_intentos, public.auditoria, public.autorizaciones_admin FROM service_role;

-- inventario: cantidad, requiere_revision y el sello NO son escribibles por ningún cliente (solo ledger/RPC)
REVOKE INSERT, UPDATE ON public.inventario FROM authenticated;
GRANT INSERT (id, local_id, dispositivo, nombre, modelo, categoria_id, costo_compra, precio_venta, stock_minimo,
              codigo_barras, publicar_en_web, foto_url, foto_path)
  ON public.inventario TO authenticated;
GRANT UPDATE (nombre, modelo, categoria_id, costo_compra, precio_venta, stock_minimo, codigo_barras,
              publicar_en_web, foto_url, foto_path, deleted_at)
  ON public.inventario TO authenticated;

-- órdenes: finalización, margen, crédito, anulación y borrado son de las RPC
REVOKE INSERT, UPDATE ON public.ordenes FROM authenticated;
GRANT INSERT (id, local_id, dispositivo, cliente_id, moto_id, estado, falla, diagnostico, reparacion_notas,
              calidad_checklist, fotos, aprobacion, mecanico, mecanico_id, origen_trabajo, cita_local_id,
              cotizacion_local_id, km_salida, garantia_dias, tipo_cobro, metodo_pago, abono_inicial, abono_metodo)
  ON public.ordenes TO authenticated;
GRANT UPDATE (cliente_id, moto_id, estado, falla, diagnostico, reparacion_notas, calidad_checklist, fotos, aprobacion,
              mecanico, mecanico_id, origen_trabajo, km_salida, garantia_dias, entregado_en, tipo_cobro, metodo_pago,
              abono_inicial, abono_metodo)
  ON public.ordenes TO authenticated;

-- auditoría: el cliente solo aporta qué pasó; quién y con qué rol lo sella el servidor
REVOKE INSERT, UPDATE, DELETE ON public.auditoria FROM authenticated;
GRANT INSERT (accion, entidad, entidad_id, detalle, device_id, operation_id) ON public.auditoria TO authenticated;

-- 3. POLÍTICAS ---------------------------------------------------------------------------------------------------
-- dinero: solo lectura para admin y cajero (ve_todo_el_taller/puede_cobrar); ninguna política de escritura
DROP POLICY IF EXISTS ventas_cobra ON public.ventas;
DROP POLICY IF EXISTS ventas_admin_edita ON public.ventas;
DROP POLICY IF EXISTS ventas_admin_borra ON public.ventas;
DROP POLICY IF EXISTS venta_items_crea ON public.venta_items;
DROP POLICY IF EXISTS creditos_crea ON public.creditos;
DROP POLICY IF EXISTS creditos_edita ON public.creditos;
DROP POLICY IF EXISTS creditos_admin_borra ON public.creditos;
DROP POLICY IF EXISTS credito_items_crea ON public.credito_items;
DROP POLICY IF EXISTS abonos_crea ON public.abonos;
DROP POLICY IF EXISTS caja_crea ON public.caja_movimientos;
DROP POLICY IF EXISTS caja_admin_edita ON public.caja_movimientos;
DROP POLICY IF EXISTS caja_admin_borra ON public.caja_movimientos;

-- maestros: se acabó el DELETE (borrado suave por UPDATE de deleted_at, solo admin)
DROP POLICY IF EXISTS clientes_admin_borra ON public.clientes;
DROP POLICY IF EXISTS motos_admin_borra ON public.motos;
DROP POLICY IF EXISTS citas_admin_borra ON public.citas;
DROP POLICY IF EXISTS ordenes_admin_borra ON public.ordenes;
DROP POLICY IF EXISTS cotizaciones_admin_borra ON public.cotizaciones;

-- líneas de orden: solo lectura (las escribe la RPC)
DROP POLICY IF EXISTS orden_items_crea ON public.orden_items;
DROP POLICY IF EXISTS orden_items_edita ON public.orden_items;
DROP POLICY IF EXISTS orden_items_admin_borra ON public.orden_items;

-- líneas de cotización: no mueven stock ni dinero; el equipo puede reemplazarlas al editar la cotización
DROP POLICY IF EXISTS cotizacion_items_admin_borra ON public.cotizacion_items;
DROP POLICY IF EXISTS cotizacion_items_borra ON public.cotizacion_items;
CREATE POLICY cotizacion_items_borra ON public.cotizacion_items AS PERMISSIVE FOR DELETE TO authenticated
  USING (public.ve_todo_el_taller());

-- inventario y categorías: el maestro es solo del administrador (D-4); ya no hay política FOR ALL (incluía DELETE)
DROP POLICY IF EXISTS inventario_admin ON public.inventario;
DROP POLICY IF EXISTS inventario_admin_crea ON public.inventario;
CREATE POLICY inventario_admin_crea ON public.inventario AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (public.es_admin());
DROP POLICY IF EXISTS inventario_admin_edita ON public.inventario;
CREATE POLICY inventario_admin_edita ON public.inventario AS PERMISSIVE FOR UPDATE TO authenticated
  USING (public.es_admin()) WITH CHECK (public.es_admin());
DROP POLICY IF EXISTS categorias_admin ON public.categorias_inv;
DROP POLICY IF EXISTS categorias_admin_crea ON public.categorias_inv;
CREATE POLICY categorias_admin_crea ON public.categorias_inv AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (public.es_admin());
DROP POLICY IF EXISTS categorias_admin_edita ON public.categorias_inv;
CREATE POLICY categorias_admin_edita ON public.categorias_inv AS PERMISSIVE FOR UPDATE TO authenticated
  USING (public.es_admin()) WITH CHECK (public.es_admin());

-- el mecánico NO lee ni escribe estas tablas directamente: entra por RPC con columnas seguras (SYNC-6)
DROP POLICY IF EXISTS ordenes_lee ON public.ordenes;
CREATE POLICY ordenes_lee ON public.ordenes AS PERMISSIVE FOR SELECT TO authenticated USING (public.ve_todo_el_taller());
DROP POLICY IF EXISTS ordenes_edita ON public.ordenes;
CREATE POLICY ordenes_edita ON public.ordenes AS PERMISSIVE FOR UPDATE TO authenticated
  USING (public.ve_todo_el_taller()) WITH CHECK (public.ve_todo_el_taller());
DROP POLICY IF EXISTS citas_lee ON public.citas;
CREATE POLICY citas_lee ON public.citas AS PERMISSIVE FOR SELECT TO authenticated USING (public.ve_todo_el_taller());
DROP POLICY IF EXISTS clientes_lee ON public.clientes;
CREATE POLICY clientes_lee ON public.clientes AS PERMISSIVE FOR SELECT TO authenticated USING (public.ve_todo_el_taller());
DROP POLICY IF EXISTS motos_lee ON public.motos;
CREATE POLICY motos_lee ON public.motos AS PERMISSIVE FOR SELECT TO authenticated USING (public.ve_todo_el_taller());

-- auditoría: solo se agrega y solo con la propia identidad (el trigger la sella; la política lo comprueba)
DROP POLICY IF EXISTS auditoria_crea ON public.auditoria;
CREATE POLICY auditoria_crea ON public.auditoria AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (public.es_equipo() AND usuario_id = auth.uid());

-- 4. TRIGGERS ----------------------------------------------------------------------------------------------------
DO $tr$
DECLARE t text; v_lista text;
BEGIN
  -- maestros: sin DELETE físico + borrado suave con autor real
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','ordenes','cotizaciones','categorias_inv','inventario'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guardia_fila ON public.%I', t);
    EXECUTE format('CREATE TRIGGER sync_guardia_fila BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.sync_guardia(%L)', t, 'sin_borrado');
    EXECUTE format('DROP TRIGGER IF EXISTS zz_sync_sello_borrado ON public.%I', t);
    EXECUTE format('CREATE TRIGGER zz_sync_sello_borrado BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.sync_sellar_borrado()', t);
  END LOOP;

  -- dinero con estado derivado: solo cambian las columnas que las RPC gobiernan
  FOR t, v_lista IN SELECT * FROM (VALUES
    ('ventas',   'anulada,anulada_en,updated_at,rev,updated_by,last_op_id'),
    ('creditos', 'abonado,saldo,estado,anulado,anulado_en,updated_at,rev,updated_by,last_op_id'),
    ('abonos',   'anulado,anulado_en,updated_at,rev,updated_by,last_op_id'),
    ('autorizaciones_admin', 'consumida_en,consumida_op')) AS v(tabla, columnas)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guardia_fila ON public.%I', t);
    EXECUTE format('CREATE TRIGGER sync_guardia_fila BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.sync_guardia(%L, %L)', t, 'campos', v_lista);
  END LOOP;

  -- solo agregar
  FOREACH t IN ARRAY ARRAY['caja_movimientos','venta_items','credito_items','inventario_movimientos','reversos',
                           'sync_ops','admin_pin_intentos','auditoria','import_registros'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guardia_fila ON public.%I', t);
    EXECUTE format('CREATE TRIGGER sync_guardia_fila BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.sync_guardia(%L)', t, 'inmutable');
  END LOOP;

  -- importación: los lotes y el mapeo de mecánicos se actualizan pero no se borran
  FOREACH t IN ARRAY ARRAY['import_lotes','import_mapeo_mecanicos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guardia_fila ON public.%I', t);
    EXECUTE format('CREATE TRIGGER sync_guardia_fila BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.sync_guardia(%L)', t, 'sin_borrado');
  END LOOP;

  -- TRUNCATE bloqueado en todas las protegidas
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','ordenes','cotizaciones','categorias_inv','inventario','ventas',
      'creditos','abonos','autorizaciones_admin','caja_movimientos','venta_items','credito_items','inventario_movimientos',
      'reversos','sync_ops','admin_pin_intentos','auditoria','import_registros','import_lotes','import_mapeo_mecanicos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guardia_truncate ON public.%I', t);
    EXECUTE format('CREATE TRIGGER sync_guardia_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.sync_guardia(%L)', t, 'sin_borrado');
  END LOOP;
END
$tr$;

DROP TRIGGER IF EXISTS sync_auditoria_sellar ON public.auditoria;
CREATE TRIGGER sync_auditoria_sellar BEFORE INSERT ON public.auditoria FOR EACH ROW EXECUTE FUNCTION public.sync_auditoria_sellar();

-- 5. STORAGE: <entidad>/<registro_uuid>/<archivo> en el bucket privado del taller ---------------------------------
DROP POLICY IF EXISTS taller_lee_media ON storage.objects;
CREATE POLICY taller_lee_media ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated
  USING (bucket_id = 'entimotors-taller'
     AND (public.ve_todo_el_taller()
          OR (array_length(storage.foldername(name), 1) = 2
              AND (storage.foldername(name))[1] = 'ordenes'
              AND public.mecanico_asignado_a_orden((storage.foldername(name))[2]))));
DROP POLICY IF EXISTS taller_sube_media ON storage.objects;
CREATE POLICY taller_sube_media ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'entimotors-taller'
     AND array_length(storage.foldername(name), 1) = 2
     AND ((public.ve_todo_el_taller() AND (storage.foldername(name))[1] IN ('motos', 'ordenes', 'inventario'))
          OR ((storage.foldername(name))[1] = 'ordenes'
              AND public.mecanico_asignado_a_orden((storage.foldername(name))[2]))));
-- taller_borra_media (solo admin) se conserva tal cual.

-- POSTCONDICIONES (fallan cerradas) ---------------------------------------------------------------------------------
DO $post$
DECLARE t text; v_fail text := ''; n int;
BEGIN
  FOREACH t IN ARRAY ARRAY['ventas','venta_items','creditos','credito_items','abonos','caja_movimientos'] LOOP
    IF has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE,TRUNCATE') THEN v_fail := v_fail || t || ' escribible por authenticated; '; END IF;
    IF has_table_privilege('service_role', 'public.' || t, 'INSERT,UPDATE,DELETE,TRUNCATE') THEN v_fail := v_fail || t || ' escribible por service_role; '; END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND cmd <> 'SELECT') THEN v_fail := v_fail || t || ' conserva políticas de escritura; '; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['perfiles','categorias_inv','clientes','motos','inventario','ordenes','orden_items','cotizaciones',
      'cotizacion_items','citas','ventas','venta_items','creditos','credito_items','abonos','caja_movimientos','web_cms','auditoria'] LOOP
    IF has_table_privilege('authenticated', 'public.' || t, 'TRUNCATE') THEN v_fail := v_fail || t || ' con TRUNCATE para authenticated; '; END IF;
  END LOOP;
  IF has_column_privilege('authenticated', 'public.inventario', 'cantidad', 'UPDATE') OR has_column_privilege('authenticated', 'public.inventario', 'cantidad', 'INSERT') THEN
    v_fail := v_fail || 'inventario.cantidad escribible por authenticated; ';
  END IF;
  IF has_column_privilege('authenticated', 'public.ordenes', 'finalizada', 'UPDATE') OR has_column_privilege('authenticated', 'public.ordenes', 'margen', 'UPDATE') THEN
    v_fail := v_fail || 'ordenes.finalizada/margen escribibles por authenticated; ';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('ordenes','citas','clientes','motos')
     AND cmd IN ('SELECT','UPDATE') AND (COALESCE(qual,'') LIKE '%es_mecanico_activo%' OR COALESCE(qual,'') LIKE '%mi_cliente%' OR COALESCE(qual,'') LIKE '%mi_moto%');
  IF n <> 0 THEN v_fail := v_fail || 'el mecánico conserva acceso directo a ordenes/citas/clientes/motos; '; END IF;
  SELECT count(*) INTO n FROM pg_trigger WHERE tgname IN ('sync_guardia_fila','sync_guardia_truncate') AND NOT tgisinternal;
  IF n <> 7 + 4 + 9 + 2 + 22 THEN v_fail := v_fail || format('triggers de guardia = % (se esperaban 44); ', n); END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-2 STOP (postcondiciones, se revierte todo): %', v_fail; END IF;
  RAISE NOTICE 'SYNC-2: postcondiciones OK (dinero cerrado, guardias activas, mecánico sin acceso directo).';
END
$post$;

COMMIT;
