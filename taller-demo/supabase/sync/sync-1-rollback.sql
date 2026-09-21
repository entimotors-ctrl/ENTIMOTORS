-- ENTIMOTORS OS 3.14.0 · SYNC-1 · ROLLBACK del esquema cloud · NO EJECUTADO EN PRODUCCIÓN
-- Devuelve el esquema exactamente al estado de producción del 2026-09-21 (catálogo de SYNC-0).
--
-- SEGURIDAD: se niega a revertir si hay información que se perdería (filas en las tablas nuevas o stock negativo; las tablas
-- de negocio conservan sus datos: solo se quitan columnas de sincronización). Para forzarlo a propósito:
--     PGOPTIONS="-c sync.forzar_rollback=si" psql -f sync-1-rollback.sql
-- Sin ese permiso explícito, un rollback nunca destruye datos.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $guarda$
DECLARE t text; n bigint; v_fail text := '';
BEGIN
  IF COALESCE(current_setting('sync.forzar_rollback', true), '') = 'si' THEN
    RAISE NOTICE 'SYNC-1 ROLLBACK: forzado explícitamente; se descartan los datos de las tablas nuevas.';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['sync_ops','inventario_movimientos','reversos','import_lotes','import_registros',
                           'import_mapeo_mecanicos','admin_pin','admin_pin_intentos','autorizaciones_admin'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n > 0 THEN v_fail := v_fail || format('%s tiene %s filas; ', t, n); END IF;
    END IF;
  END LOOP;
  IF to_regclass('public.inventario') IS NOT NULL AND EXISTS (SELECT 1 FROM public.inventario WHERE cantidad < 0) THEN
    v_fail := v_fail || 'hay stock negativo (no se puede restaurar inventario_cantidad_check); ';
  END IF;
  IF v_fail <> '' THEN
    RAISE EXCEPTION 'SYNC-1 ROLLBACK STOP (se perdería información; nada modificado): % Usa PGOPTIONS="-c sync.forzar_rollback=si" solo si lo decides.', v_fail;
  END IF;
END
$guarda$;

-- triggers y tablas nuevas -----------------------------------------------------------------------------------------
DO $tr$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','ordenes','cotizaciones','categorias_inv','inventario',
                           'web_cms','ventas','creditos','abonos','caja_movimientos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zz_sync_sello ON public.%I', t);
  END LOOP;
END
$tr$;
DROP TABLE IF EXISTS public.autorizaciones_admin, public.admin_pin_intentos, public.admin_pin,
  public.import_mapeo_mecanicos, public.import_registros, public.import_lotes, public.reversos,
  public.inventario_movimientos, public.sync_ops CASCADE;
DROP FUNCTION IF EXISTS public.sync_ledger_aplicar();
DROP FUNCTION IF EXISTS public.sync_sellar();

-- restricciones añadidas -------------------------------------------------------------------------------------------
ALTER TABLE public.ordenes DROP CONSTRAINT IF EXISTS ordenes_fotos_sin_base64;
ALTER TABLE public.motos DROP CONSTRAINT IF EXISTS motos_foto_path_sin_base64;
ALTER TABLE public.inventario DROP CONSTRAINT IF EXISTS inventario_foto_sin_base64;

-- columnas añadidas (los índices y FK que dependen de ellas caen con la columna) ---------------------------------
DO $cols$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','ordenes','cotizaciones','categorias_inv','inventario',
                           'web_cms','ventas','creditos','abonos','caja_movimientos'] LOOP
    EXECUTE format($f$ALTER TABLE public.%I
      DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS rev, DROP COLUMN IF EXISTS created_by,
      DROP COLUMN IF EXISTS updated_by, DROP COLUMN IF EXISTS last_op_id$f$, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','ordenes','cotizaciones','categorias_inv','inventario'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS deleted_by', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['ventas','creditos','abonos','caja_movimientos'] LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', t || '_op_id_uidx');
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS occurred_at, DROP COLUMN IF EXISTS op_id', t);
  END LOOP;
END
$cols$;
ALTER TABLE public.ventas DROP COLUMN IF EXISTS mecanico_id, DROP COLUMN IF EXISTS capturada_offline,
  DROP COLUMN IF EXISTS anulada, DROP COLUMN IF EXISTS anulada_en;
ALTER TABLE public.creditos DROP COLUMN IF EXISTS mecanico_id, DROP COLUMN IF EXISTS anulado, DROP COLUMN IF EXISTS anulado_en;
ALTER TABLE public.abonos DROP COLUMN IF EXISTS anulado, DROP COLUMN IF EXISTS anulado_en;
ALTER TABLE public.caja_movimientos DROP COLUMN IF EXISTS reverso_de;
ALTER TABLE public.orden_items DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS creado_en;
ALTER TABLE public.venta_items DROP COLUMN IF EXISTS creado_en;
ALTER TABLE public.credito_items DROP COLUMN IF EXISTS creado_en;
ALTER TABLE public.cotizacion_items DROP COLUMN IF EXISTS creado_en;
ALTER TABLE public.motos DROP COLUMN IF EXISTS cilindraje, DROP COLUMN IF EXISTS foto_path, DROP COLUMN IF EXISTS mantenimiento;
ALTER TABLE public.inventario DROP COLUMN IF EXISTS foto_path, DROP COLUMN IF EXISTS requiere_revision,
  DROP COLUMN IF EXISTS revision_motivo, DROP COLUMN IF EXISTS revision_desde;
ALTER TABLE public.ordenes DROP COLUMN IF EXISTS abono_inicial, DROP COLUMN IF EXISTS abono_metodo,
  DROP COLUMN IF EXISTS credito_id, DROP COLUMN IF EXISTS anulada, DROP COLUMN IF EXISTS anulada_en;
ALTER TABLE public.citas DROP COLUMN IF EXISTS confirmada;
ALTER TABLE public.cotizaciones DROP COLUMN IF EXISTS aceptada_en;
ALTER TABLE public.auditoria DROP COLUMN IF EXISTS device_id, DROP COLUMN IF EXISTS operation_id,
  DROP COLUMN IF EXISTS autorizado_por, DROP COLUMN IF EXISTS resultado;

-- estado original de producción: comentario de la columna y CHECK del stock ---------------------------------------
COMMENT ON COLUMN public.inventario.cantidad IS NULL;
ALTER TABLE public.inventario DROP CONSTRAINT IF EXISTS inventario_cantidad_check;
ALTER TABLE public.inventario ADD CONSTRAINT inventario_cantidad_check CHECK (cantidad >= 0::numeric);

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND column_name IN ('rev','updated_at','op_id','requiere_revision')) THEN
    RAISE EXCEPTION 'SYNC-1 ROLLBACK STOP: quedan columnas de sincronización';
  END IF;
  RAISE NOTICE 'SYNC-1 ROLLBACK: esquema devuelto al estado de producción (2026-09-21).';
END
$post$;

COMMIT;
