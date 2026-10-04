-- ENTIMOTORS OS 3.15.0 · BLOQUE 7 · ROLLBACK de sync-15g-rendimiento-rls.sql · NO EJECUTADO EN PRODUCCIÓN
-- Devuelve cada política de lectura a su expresión anterior (la misma regla, evaluada por fila). Va ANTES del rollback de 15f.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
ALTER POLICY abonos_lee ON public.abonos USING (public.ve_todo_el_taller());
ALTER POLICY auditoria_admin_lee ON public.auditoria USING (public.es_admin());
ALTER POLICY caja_lee ON public.caja_movimientos USING (public.puede_cobrar());
ALTER POLICY categorias_lee ON public.categorias_inv USING (public.ve_todo_el_taller());
ALTER POLICY citas_lee ON public.citas USING (public.ve_todo_el_taller());
ALTER POLICY clientes_lee ON public.clientes USING (public.ve_todo_el_taller());
ALTER POLICY cotizacion_items_lee ON public.cotizacion_items USING (public.ve_todo_el_taller());
ALTER POLICY cotizaciones_lee ON public.cotizaciones USING (public.ve_todo_el_taller());
ALTER POLICY credito_items_lee ON public.credito_items USING (public.ve_todo_el_taller());
ALTER POLICY creditos_lee ON public.creditos USING (public.ve_todo_el_taller());
ALTER POLICY inventario_lee ON public.inventario USING (public.ve_todo_el_taller());
ALTER POLICY mensajes_lee ON public.mensajes USING ((destinatario_id = auth.uid() AND public.es_mecanico_activo()) OR public.es_admin());
ALTER POLICY motos_lee ON public.motos USING (public.ve_todo_el_taller());
ALTER POLICY orden_items_lee ON public.orden_items USING (public.ve_todo_el_taller());
ALTER POLICY ordenes_lee ON public.ordenes USING (public.ve_todo_el_taller());
ALTER POLICY venta_items_lee ON public.venta_items USING (public.ve_todo_el_taller());
ALTER POLICY ventas_lee ON public.ventas USING (public.ve_todo_el_taller());
ALTER POLICY cms_lee ON public.web_cms USING (public.es_equipo());
DELETE FROM public.sync_fases WHERE fase = '15g';
COMMIT;
