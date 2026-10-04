-- ENTIMOTORS OS 3.15.0 · BLOQUE 5 · ROLLBACK de sync-15e-finanzas.sql · NO EJECUTADO EN PRODUCCIÓN
-- 15e no crea ni cambia datos: su rollback es siempre seguro. Quita las garantías únicas, los índices, finanzas_resumen y
-- finanzas_invariantes; devuelve estadisticas_tecnicas() a la definición CANÓNICA RCV-34 (copia literal del source-sync) y el EXECUTE de
-- authenticated sobre registrar_venta / registrar_abono v1. Va ANTES del rollback de 15d.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.finanzas_resumen(date,date,timestamptz);
DROP FUNCTION IF EXISTS public.finanzas_invariantes();
DROP INDEX IF EXISTS public.caja_un_ingreso_por_venta;
DROP INDEX IF EXISTS public.caja_un_ingreso_por_orden;
DROP INDEX IF EXISTS public.caja_un_movimiento_por_abono;
DROP INDEX IF EXISTS public.caja_una_compensacion;
DROP INDEX IF EXISTS public.creditos_uno_vivo_por_orden;
DROP INDEX IF EXISTS public.idx_caja_momento;
DROP INDEX IF EXISTS public.idx_ventas_momento;
DROP INDEX IF EXISTS public.idx_creditos_momento;
DROP INDEX IF EXISTS public.idx_ordenes_finalizado_en;
DROP INDEX IF EXISTS public.idx_ordenes_entregadas_abiertas;
DROP INDEX IF EXISTS public.idx_creditos_orden;
DROP INDEX IF EXISTS public.idx_caja_orden;

-- la matriz de destructivas vuelve a la de 15d (sin restaurar_respaldo)
CREATE OR REPLACE FUNCTION public.sync_accion_destructiva(p_accion text)
 RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT p_accion = ANY (ARRAY['reversar_venta', 'reversar_credito', 'reversar_abono', 'reversar_caja', 'anular_orden', 'eliminar_usuario'])
$function$;
REVOKE EXECUTE ON FUNCTION public.sync_accion_destructiva(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_accion_destructiva(text) TO authenticated, service_role;

-- estadisticas_tecnicas(): definición canónica RCV-34 (md5(prosrc) 86948fdcaf03939a1d0929004cd9c730)
CREATE OR REPLACE FUNCTION public.estadisticas_tecnicas()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_rol text;
begin
  v_rol := public.rol_actual();
  -- rol_actual() ya filtra por activo = true, así que un usuario dado de baja
  -- recibe null y no pasa de aquí.
  if not (public.es_admin() or public.es_desarrollador()) then
    raise exception 'Solo el administrador y el desarrollador pueden consultar las estadísticas técnicas';
  end if;
  -- SOLO count(*). Ni un nombre, ni un teléfono, ni un importe, ni un UUID.
  return jsonb_build_object(
    'clientes',          (select count(*) from public.clientes),
    'motos',             (select count(*) from public.motos),
    'ordenes',           (select count(*) from public.ordenes),
    'ordenes_abiertas',  (select count(*) from public.ordenes where not finalizada),
    'cotizaciones',      (select count(*) from public.cotizaciones),
    'citas',             (select count(*) from public.citas),
    'inventario',        (select count(*) from public.inventario),
    'ventas',            (select count(*) from public.ventas),
    'ventas_hoy',        (select count(*) from public.ventas where creado_en::date = current_date),
    'creditos',          (select count(*) from public.creditos),
    'creditos_abiertos', (select count(*) from public.creditos where estado <> 'pagado'),
    'abonos',            (select count(*) from public.abonos),
    'movimientos_caja',  (select count(*) from public.caja_movimientos),
    'auditoria',         (select count(*) from public.auditoria)
  );
end $function$;

REVOKE EXECUTE ON FUNCTION public.estadisticas_tecnicas() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estadisticas_tecnicas() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.registrar_abono(uuid,numeric,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_abono(uuid,numeric,text,text) TO authenticated, service_role;

DELETE FROM public.sync_fases WHERE fase = '15e';

DO $post$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.estadisticas_tecnicas()'::regprocedure)) <> '86948fdcaf03939a1d0929004cd9c730' THEN
    RAISE EXCEPTION 'ROLLBACK 15E STOP: estadisticas_tecnicas no volvió a la canónica';
  END IF;
  RAISE NOTICE 'ROLLBACK 15E: listo.';
END
$post$;
COMMIT;
