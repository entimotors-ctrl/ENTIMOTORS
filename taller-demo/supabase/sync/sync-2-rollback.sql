-- ENTIMOTORS OS 3.14.0 · SYNC-2 · ROLLBACK de seguridad · NO EJECUTADO EN PRODUCCIÓN
-- Devuelve políticas, privilegios y triggers al estado posterior a SYNC-1 (que es el de producción + columnas de sello).
-- Las definiciones de las políticas originales salen del catálogo real de producción (SYNC-0).
--
-- ATENCIÓN: esto REABRE el dinero al borrado y a la edición directa. Solo para volver atrás una versión aún no
-- publicada. Se niega si ya existen reversos, ledger o autorizaciones (información que la vieja seguridad no protege).
-- Para forzarlo a propósito:  PGOPTIONS="-c sync.forzar_rollback=si" psql -f sync-2-rollback.sql
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $guarda$
DECLARE v_fail text := ''; n bigint;
BEGIN
  IF COALESCE(current_setting('sync.forzar_rollback', true), '') = 'si' THEN
    RAISE NOTICE 'SYNC-2 ROLLBACK: forzado explícitamente.'; RETURN;
  END IF;
  IF to_regclass('public.reversos') IS NOT NULL THEN
    SELECT (SELECT count(*) FROM public.reversos) + (SELECT count(*) FROM public.inventario_movimientos)
         + (SELECT count(*) FROM public.autorizaciones_admin) INTO n;
    IF n > 0 THEN v_fail := v_fail || format('hay %s filas de reversos/ledger/autorizaciones que la seguridad antigua no protege; ', n); END IF;
  END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-2 ROLLBACK STOP (nada modificado): % Usa PGOPTIONS="-c sync.forzar_rollback=si" solo si lo decides.', v_fail; END IF;
END
$guarda$;

-- triggers y funciones nuevas --------------------------------------------------------------------------------------
DO $tr$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','ordenes','cotizaciones','categorias_inv','inventario'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guardia_fila ON public.%I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS zz_sync_sello_borrado ON public.%I', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['ventas','creditos','abonos','autorizaciones_admin','caja_movimientos','venta_items','credito_items',
      'inventario_movimientos','reversos','sync_ops','admin_pin_intentos','auditoria','import_registros','import_lotes','import_mapeo_mecanicos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guardia_fila ON public.%I', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','ordenes','cotizaciones','categorias_inv','inventario','ventas','creditos','abonos',
      'autorizaciones_admin','caja_movimientos','venta_items','credito_items','inventario_movimientos','reversos','sync_ops',
      'admin_pin_intentos','auditoria','import_registros','import_lotes','import_mapeo_mecanicos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guardia_truncate ON public.%I', t);
  END LOOP;
END
$tr$;
DROP TRIGGER IF EXISTS sync_auditoria_sellar ON public.auditoria;

-- políticas: se eliminan las nuevas y se restauran las originales de producción ---------------------------------------
DROP POLICY IF EXISTS cotizacion_items_borra ON public.cotizacion_items;
DROP POLICY IF EXISTS inventario_admin_crea ON public.inventario;
DROP POLICY IF EXISTS inventario_admin_edita ON public.inventario;
DROP POLICY IF EXISTS categorias_admin_crea ON public.categorias_inv;
DROP POLICY IF EXISTS categorias_admin_edita ON public.categorias_inv;
DROP POLICY IF EXISTS "ventas_cobra" ON public."ventas";
CREATE POLICY "ventas_cobra" ON public."ventas" AS PERMISSIVE FOR INSERT TO public WITH CHECK (puede_cobrar());
DROP POLICY IF EXISTS "ventas_admin_edita" ON public."ventas";
CREATE POLICY "ventas_admin_edita" ON public."ventas" AS PERMISSIVE FOR UPDATE TO public USING (es_admin()) WITH CHECK (es_admin());
DROP POLICY IF EXISTS "ventas_admin_borra" ON public."ventas";
CREATE POLICY "ventas_admin_borra" ON public."ventas" AS PERMISSIVE FOR DELETE TO public USING (es_admin());
DROP POLICY IF EXISTS "venta_items_crea" ON public."venta_items";
CREATE POLICY "venta_items_crea" ON public."venta_items" AS PERMISSIVE FOR INSERT TO public WITH CHECK (puede_cobrar());
DROP POLICY IF EXISTS "creditos_crea" ON public."creditos";
CREATE POLICY "creditos_crea" ON public."creditos" AS PERMISSIVE FOR INSERT TO public WITH CHECK (puede_cobrar());
DROP POLICY IF EXISTS "creditos_edita" ON public."creditos";
CREATE POLICY "creditos_edita" ON public."creditos" AS PERMISSIVE FOR UPDATE TO public USING (puede_cobrar()) WITH CHECK (puede_cobrar());
DROP POLICY IF EXISTS "creditos_admin_borra" ON public."creditos";
CREATE POLICY "creditos_admin_borra" ON public."creditos" AS PERMISSIVE FOR DELETE TO public USING (es_admin());
DROP POLICY IF EXISTS "credito_items_crea" ON public."credito_items";
CREATE POLICY "credito_items_crea" ON public."credito_items" AS PERMISSIVE FOR INSERT TO public WITH CHECK (puede_cobrar());
DROP POLICY IF EXISTS "abonos_crea" ON public."abonos";
CREATE POLICY "abonos_crea" ON public."abonos" AS PERMISSIVE FOR INSERT TO public WITH CHECK (puede_cobrar());
DROP POLICY IF EXISTS "caja_crea" ON public."caja_movimientos";
CREATE POLICY "caja_crea" ON public."caja_movimientos" AS PERMISSIVE FOR INSERT TO public WITH CHECK (puede_cobrar());
DROP POLICY IF EXISTS "caja_admin_edita" ON public."caja_movimientos";
CREATE POLICY "caja_admin_edita" ON public."caja_movimientos" AS PERMISSIVE FOR UPDATE TO public USING (es_admin()) WITH CHECK (es_admin());
DROP POLICY IF EXISTS "caja_admin_borra" ON public."caja_movimientos";
CREATE POLICY "caja_admin_borra" ON public."caja_movimientos" AS PERMISSIVE FOR DELETE TO public USING (es_admin());
DROP POLICY IF EXISTS "clientes_admin_borra" ON public."clientes";
CREATE POLICY "clientes_admin_borra" ON public."clientes" AS PERMISSIVE FOR DELETE TO public USING (es_admin());
DROP POLICY IF EXISTS "motos_admin_borra" ON public."motos";
CREATE POLICY "motos_admin_borra" ON public."motos" AS PERMISSIVE FOR DELETE TO public USING (es_admin());
DROP POLICY IF EXISTS "citas_admin_borra" ON public."citas";
CREATE POLICY "citas_admin_borra" ON public."citas" AS PERMISSIVE FOR DELETE TO public USING (es_admin());
DROP POLICY IF EXISTS "ordenes_admin_borra" ON public."ordenes";
CREATE POLICY "ordenes_admin_borra" ON public."ordenes" AS PERMISSIVE FOR DELETE TO public USING (es_admin());
DROP POLICY IF EXISTS "cotizaciones_admin_borra" ON public."cotizaciones";
CREATE POLICY "cotizaciones_admin_borra" ON public."cotizaciones" AS PERMISSIVE FOR DELETE TO public USING (es_admin());
DROP POLICY IF EXISTS "orden_items_crea" ON public."orden_items";
CREATE POLICY "orden_items_crea" ON public."orden_items" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (ve_todo_el_taller());
DROP POLICY IF EXISTS "orden_items_edita" ON public."orden_items";
CREATE POLICY "orden_items_edita" ON public."orden_items" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (ve_todo_el_taller()) WITH CHECK (ve_todo_el_taller());
DROP POLICY IF EXISTS "orden_items_admin_borra" ON public."orden_items";
CREATE POLICY "orden_items_admin_borra" ON public."orden_items" AS PERMISSIVE FOR DELETE TO public USING (es_admin());
DROP POLICY IF EXISTS "cotizacion_items_admin_borra" ON public."cotizacion_items";
CREATE POLICY "cotizacion_items_admin_borra" ON public."cotizacion_items" AS PERMISSIVE FOR DELETE TO public USING (es_admin());
DROP POLICY IF EXISTS "inventario_admin" ON public."inventario";
CREATE POLICY "inventario_admin" ON public."inventario" AS PERMISSIVE FOR ALL TO public USING (es_admin()) WITH CHECK (es_admin());
DROP POLICY IF EXISTS "categorias_admin" ON public."categorias_inv";
CREATE POLICY "categorias_admin" ON public."categorias_inv" AS PERMISSIVE FOR ALL TO public USING (es_admin()) WITH CHECK (es_admin());
DROP POLICY IF EXISTS "ordenes_lee" ON public."ordenes";
CREATE POLICY "ordenes_lee" ON public."ordenes" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((ve_todo_el_taller() OR (es_mecanico_activo() AND (mecanico_id = auth.uid()))));
DROP POLICY IF EXISTS "ordenes_edita" ON public."ordenes";
CREATE POLICY "ordenes_edita" ON public."ordenes" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((ve_todo_el_taller() OR (es_mecanico_activo() AND (mecanico_id = auth.uid())))) WITH CHECK ((ve_todo_el_taller() OR (es_mecanico_activo() AND (mecanico_id = auth.uid()))));
DROP POLICY IF EXISTS "citas_lee" ON public."citas";
CREATE POLICY "citas_lee" ON public."citas" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((ve_todo_el_taller() OR (es_mecanico_activo() AND (mecanico_id = auth.uid()))));
DROP POLICY IF EXISTS "clientes_lee" ON public."clientes";
CREATE POLICY "clientes_lee" ON public."clientes" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((ve_todo_el_taller() OR mi_cliente(id)));
DROP POLICY IF EXISTS "motos_lee" ON public."motos";
CREATE POLICY "motos_lee" ON public."motos" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((ve_todo_el_taller() OR mi_moto(id)));
DROP POLICY IF EXISTS "auditoria_crea" ON public."auditoria";
CREATE POLICY "auditoria_crea" ON public."auditoria" AS PERMISSIVE FOR INSERT TO public WITH CHECK (es_equipo());
DROP POLICY IF EXISTS "taller_lee_media" ON storage."objects";
CREATE POLICY "taller_lee_media" ON storage."objects" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((bucket_id = 'entimotors-taller'::text) AND ve_todo_el_taller()));
DROP POLICY IF EXISTS "taller_sube_media" ON storage."objects";
CREATE POLICY "taller_sube_media" ON storage."objects" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((bucket_id = 'entimotors-taller'::text) AND ve_todo_el_taller()));

-- privilegios: se quitan los permisos por columna y se vuelve a los de tabla completos ---------------------------------
REVOKE INSERT (id, local_id, dispositivo, nombre, modelo, categoria_id, costo_compra, precio_venta, stock_minimo, codigo_barras, publicar_en_web, foto_url, foto_path),
       UPDATE (nombre, modelo, categoria_id, costo_compra, precio_venta, stock_minimo, codigo_barras, publicar_en_web, foto_url, foto_path, deleted_at)
  ON public.inventario FROM authenticated;
REVOKE INSERT (id, local_id, dispositivo, cliente_id, moto_id, estado, falla, diagnostico, reparacion_notas, calidad_checklist, fotos, aprobacion, mecanico, mecanico_id, origen_trabajo, cita_local_id, cotizacion_local_id, km_salida, garantia_dias, tipo_cobro, metodo_pago, abono_inicial, abono_metodo),
       UPDATE (cliente_id, moto_id, estado, falla, diagnostico, reparacion_notas, calidad_checklist, fotos, aprobacion, mecanico, mecanico_id, origen_trabajo, km_salida, garantia_dias, entregado_en, tipo_cobro, metodo_pago, abono_inicial, abono_metodo)
  ON public.ordenes FROM authenticated;
REVOKE INSERT (accion, entidad, entidad_id, detalle, device_id, operation_id) ON public.auditoria FROM authenticated;
GRANT ALL ON TABLE public.perfiles, public.categorias_inv, public.clientes, public.motos, public.inventario, public.ordenes,
  public.orden_items, public.cotizaciones, public.cotizacion_items, public.citas, public.ventas, public.venta_items,
  public.creditos, public.credito_items, public.abonos, public.caja_movimientos, public.web_cms, public.auditoria
  TO authenticated, service_role;
GRANT ALL ON TABLE public.inventario_movimientos, public.reversos, public.sync_ops, public.admin_pin_intentos,
  public.autorizaciones_admin TO service_role;

DROP FUNCTION IF EXISTS public.mecanico_asignado_a_orden(text);
DROP FUNCTION IF EXISTS public.sync_auditoria_sellar();
DROP FUNCTION IF EXISTS public.sync_sellar_borrado();
DROP FUNCTION IF EXISTS public.sync_guardia();

DO $post$
BEGIN
  IF NOT has_table_privilege('authenticated', 'public.ventas', 'INSERT') THEN
    RAISE EXCEPTION 'SYNC-2 ROLLBACK STOP: no se restauraron los privilegios';
  END IF;
  RAISE NOTICE 'SYNC-2 ROLLBACK: seguridad devuelta al estado anterior (dinero reabierto).';
END
$post$;

COMMIT;
