-- ENTIMOTORS OS 3.14.0 · SYNC-1 · ESQUEMA CLOUD (aditivo) · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Se prueba solo contra el Postgres local.
--
-- PARTE DEL CATÁLOGO REAL (SYNC-0, 2026-09-21): 18 tablas operativas, todas con RLS, casi vacías; UNIQUE(dispositivo,
-- local_id) en 10 tablas; sin taller_id (D-1: un solo taller, NO multi-tenant); 17 funciones fijadas por md5 (RCV-34)
-- que este archivo NO toca.
--
-- QUÉ HACE (todo aditivo, salvo UNA relajación aprobada por D-3, ver el final):
--   1. Columnas de sello en las tablas sincronizables: updated_at, rev, created_by, updated_by, last_op_id
--      (+ deleted_at/deleted_by en los maestros) y un trigger `zz_sync_sello` que las escribe SIEMPRE el servidor.
--      El nombre empieza por «zz» a propósito: los triggers BEFORE se ejecutan por orden alfabético y este debe correr
--      DESPUÉS de `*_mecanico_avance`, que compara la fila completa y bloquearía al mecánico si viera el sello ya puesto.
--   2. Columnas de hechos (occurred_at, op_id, anulada…) y de fidelidad con el respaldo 3.13.0.
--   3. Tablas nuevas: sync_ops, inventario_movimientos (ledger), reversos, import_lotes, import_registros,
--      import_mapeo_mecanicos, admin_pin, admin_pin_intentos, autorizaciones_admin. Todas con RLS activo y SIN políticas
--      (niegan todo a authenticated) y sin privilegios para anon/authenticated: solo las funciones SECURITY DEFINER y
--      service_role las tocan (SYNC-2 y SYNC-3 las gobiernan).
--   4. Ledger: al insertar un movimiento se recalcula inventario.cantidad y se marca requiere_revision si queda negativo.
--   5. Fotos: nada de base64 en tablas (CHECK). Las fotos van a Storage y aquí solo viaja la ruta.
--
-- UNA RELAJACIÓN (decisión D-3): se elimina CHECK inventario_cantidad_check (cantidad >= 0). Una venta hecha offline se
-- acepta aunque deje el stock negativo; se conserva, se marca requiere_revision y se avisa al administrador. El stock
-- NUNCA se recorta a cero. La venta ONLINE sigue bloqueándose por falta de stock, en la RPC (SYNC-3).
--
-- DISEÑO: una sola transacción; idempotente (segunda ejecución = mismo estado); si algo no cuadra, RAISE y se revierte todo.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

-- PRECONDICIONES ------------------------------------------------------------------------------------------------
DO $pre$
DECLARE t text; v_fail text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['perfiles','categorias_inv','clientes','motos','inventario','ordenes','orden_items',
    'cotizaciones','cotizacion_items','citas','ventas','venta_items','creditos','credito_items','abonos',
    'caja_movimientos','web_cms','auditoria'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN v_fail := v_fail || format('falta public.%s; ', t); END IF;
  END LOOP;
  -- D-1: un solo taller. Si aparece cualquier resto multi-taller, se aborta: este plan no lo contempla.
  IF to_regclass('public.talleres') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND column_name IN ('taller_id', 'tenant_id')) THEN
    v_fail := v_fail || 'hay objetos multi-taller (talleres/taller_id/tenant_id): D-1 exige un solo taller; ';
  END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-1 STOP (precondiciones, nada modificado): %', v_fail; END IF;
END
$pre$;

-- 1. FUNCIONES DE SELLO Y LEDGER ---------------------------------------------------------------------------------
-- El sello lo escribe el servidor: lo que mande el cliente en estas columnas se ignora.
CREATE OR REPLACE FUNCTION public.sync_sellar()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.rev := 1;
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
    NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  ELSE
    NEW.rev := COALESCE(OLD.rev, 0) + 1;
    NEW.created_by := OLD.created_by;                       -- el autor original es inmutable
    NEW.updated_by := COALESCE(auth.uid(), OLD.updated_by);
  END IF;
  NEW.updated_at := clock_timestamp();                      -- cursor de descarga (updated_at, id)
  RETURN NEW;
END
$function$;

-- Ledger: cada movimiento bloquea el repuesto, calcula el saldo resultante y actualiza inventario.cantidad.
CREATE OR REPLACE FUNCTION public.sync_ledger_aplicar()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_antes numeric; v_despues numeric;
BEGIN
  SELECT cantidad INTO v_antes FROM public.inventario WHERE id = NEW.inventario_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El repuesto % no existe en el inventario', NEW.inventario_id;
  END IF;
  v_despues := v_antes + NEW.cantidad;
  NEW.saldo_despues := v_despues;
  IF v_despues < 0 THEN NEW.requiere_revision := true; END IF;
  UPDATE public.inventario
     SET cantidad = v_despues,
         requiere_revision = requiere_revision OR v_despues < 0,
         revision_motivo = CASE WHEN v_despues < 0 THEN 'Stock negativo tras ' || NEW.tipo ELSE revision_motivo END,
         revision_desde = CASE WHEN v_despues < 0 THEN COALESCE(revision_desde, clock_timestamp()) ELSE revision_desde END
   WHERE id = NEW.inventario_id;
  RETURN NEW;
END
$function$;

-- Solo service_role puede ejecutarlas por RPC; los triggers no necesitan EXECUTE para dispararse.
REVOKE EXECUTE ON FUNCTION public.sync_sellar() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_sellar() TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_ledger_aplicar() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_ledger_aplicar() TO service_role;

-- 2. COLUMNAS DE SELLO + TRIGGER ----------------------------------------------------------------------------------
DO $sello$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','ordenes','cotizaciones','categorias_inv','inventario',
                           'web_cms','ventas','creditos','abonos','caja_movimientos'] LOOP
    EXECUTE format($f$ALTER TABLE public.%I
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      ADD COLUMN IF NOT EXISTS rev integer NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.perfiles (id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.perfiles (id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS last_op_id uuid$f$, t);
    EXECUTE format('DROP TRIGGER IF EXISTS zz_sync_sello ON public.%I', t);
    EXECUTE format('CREATE TRIGGER zz_sync_sello BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.sync_sellar()', t);
    -- cursor de descarga incremental: (updated_at, llave). web_cms no tiene id: su llave es `clave`.
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (updated_at, %s)',
                   'idx_' || t || '_sync', t, CASE WHEN t = 'web_cms' THEN 'clave' ELSE 'id' END);
  END LOOP;

  -- borrado suave: solo los maestros. El dinero NO se borra ni se marca borrado: se revierte (SYNC-3).
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','ordenes','cotizaciones','categorias_inv','inventario'] LOOP
    EXECUTE format($f$ALTER TABLE public.%I
      ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
      ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.perfiles (id) ON DELETE SET NULL$f$, t);
  END LOOP;
END
$sello$;

-- 3. HECHOS: quién, cuándo ocurrió de verdad y con qué operación (idempotencia) ----------------------------------
DO $hechos$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ventas','creditos','abonos','caja_movimientos'] LOOP
    EXECUTE format($f$ALTER TABLE public.%I
      ADD COLUMN IF NOT EXISTS occurred_at timestamptz,
      ADD COLUMN IF NOT EXISTS op_id uuid$f$, t);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (op_id) WHERE op_id IS NOT NULL', t || '_op_id_uidx', t);
  END LOOP;
END
$hechos$;
COMMENT ON COLUMN public.ventas.occurred_at IS 'Cuándo ocurrió la venta en el mundo real (puede ser anterior a creado_en si se hizo offline). Los reportes usan COALESCE(occurred_at, creado_en).';

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS mecanico_id uuid REFERENCES public.perfiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS capturada_offline boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anulada boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anulada_en timestamptz;
ALTER TABLE public.creditos
  ADD COLUMN IF NOT EXISTS mecanico_id uuid REFERENCES public.perfiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS anulado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anulado_en timestamptz;
ALTER TABLE public.abonos
  ADD COLUMN IF NOT EXISTS anulado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anulado_en timestamptz;
ALTER TABLE public.caja_movimientos
  ADD COLUMN IF NOT EXISTS reverso_de uuid REFERENCES public.caja_movimientos (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_caja_reverso_de ON public.caja_movimientos (reverso_de) WHERE reverso_de IS NOT NULL;

-- hijos: quién los creó y cuándo (se descargan embebidos en su padre; las RPC tocan updated_at del padre)
ALTER TABLE public.orden_items
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.perfiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS creado_en timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE public.venta_items ADD COLUMN IF NOT EXISTS creado_en timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE public.credito_items ADD COLUMN IF NOT EXISTS creado_en timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE public.cotizacion_items ADD COLUMN IF NOT EXISTS creado_en timestamptz NOT NULL DEFAULT clock_timestamp();

-- 4. FIDELIDAD CON EL RESPALDO 3.13.0 -----------------------------------------------------------------------------
ALTER TABLE public.motos
  ADD COLUMN IF NOT EXISTS cilindraje text,
  ADD COLUMN IF NOT EXISTS foto_path text,
  ADD COLUMN IF NOT EXISTS mantenimiento jsonb;
ALTER TABLE public.inventario
  ADD COLUMN IF NOT EXISTS foto_path text,
  ADD COLUMN IF NOT EXISTS requiere_revision boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS revision_motivo text,
  ADD COLUMN IF NOT EXISTS revision_desde timestamptz;
ALTER TABLE public.ordenes
  ADD COLUMN IF NOT EXISTS abono_inicial numeric(12,2),
  ADD COLUMN IF NOT EXISTS abono_metodo text,
  ADD COLUMN IF NOT EXISTS credito_id uuid REFERENCES public.creditos (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS anulada boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anulada_en timestamptz;
ALTER TABLE public.citas ADD COLUMN IF NOT EXISTS confirmada boolean NOT NULL DEFAULT false;
ALTER TABLE public.cotizaciones ADD COLUMN IF NOT EXISTS aceptada_en timestamptz;
ALTER TABLE public.auditoria
  ADD COLUMN IF NOT EXISTS device_id text,
  ADD COLUMN IF NOT EXISTS operation_id uuid,
  ADD COLUMN IF NOT EXISTS autorizado_por uuid,
  ADD COLUMN IF NOT EXISTS resultado text;
COMMENT ON COLUMN public.inventario.cantidad IS 'Derivada del ledger (inventario_movimientos): solo cambia por RPC. Puede ser negativa si una venta offline se aceptó (D-3); entonces requiere_revision = true.';

-- fotos: NUNCA base64 en tablas (Storage). Las tablas están casi vacías, así que se validan al crear.
ALTER TABLE public.ordenes DROP CONSTRAINT IF EXISTS ordenes_fotos_sin_base64;
ALTER TABLE public.ordenes ADD CONSTRAINT ordenes_fotos_sin_base64
  CHECK (fotos IS NULL OR fotos::text !~ 'data:[A-Za-z]+/[A-Za-z0-9.+-]+;base64');
ALTER TABLE public.motos DROP CONSTRAINT IF EXISTS motos_foto_path_sin_base64;
ALTER TABLE public.motos ADD CONSTRAINT motos_foto_path_sin_base64 CHECK (foto_path IS NULL OR foto_path !~ '^data:');
ALTER TABLE public.inventario DROP CONSTRAINT IF EXISTS inventario_foto_sin_base64;
ALTER TABLE public.inventario ADD CONSTRAINT inventario_foto_sin_base64
  CHECK ((foto_path IS NULL OR foto_path !~ '^data:') AND (foto_url IS NULL OR foto_url !~ '^data:'));

-- D-3: el stock puede quedar negativo (venta offline aceptada). La relajación es deliberada y está aprobada.
ALTER TABLE public.inventario DROP CONSTRAINT IF EXISTS inventario_cantidad_check;

-- 5. TABLAS NUEVAS ------------------------------------------------------------------------------------------------
-- Idempotencia de operaciones: mismo operation_id = mismo resultado y efecto una sola vez.
CREATE TABLE IF NOT EXISTS public.sync_ops (
  op_id        uuid PRIMARY KEY,
  kind         text NOT NULL,
  user_id      uuid,
  device_id    text,
  request_hash text,
  resultado    jsonb NOT NULL,
  creado_en    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_sync_ops_creado ON public.sync_ops (creado_en DESC);

-- Ledger de inventario: cantidad con signo (entrada +, salida −). Solo se agrega.
CREATE TABLE IF NOT EXISTS public.inventario_movimientos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventario_id     uuid NOT NULL REFERENCES public.inventario (id) ON DELETE RESTRICT,
  tipo              text NOT NULL CHECK (tipo IN ('apertura','venta','credito','orden_item','devolucion',
                        'reverso_venta','reverso_credito','reverso_item_orden','ajuste','importacion')),
  cantidad          numeric(12,2) NOT NULL CHECK (cantidad <> 0),
  saldo_despues     numeric(12,2) NOT NULL DEFAULT 0,
  motivo            text,
  op_id             uuid,
  venta_id          uuid,
  credito_id        uuid,
  orden_id          uuid,
  orden_item_id     uuid,
  reverso_id        uuid,
  capturada_offline boolean NOT NULL DEFAULT false,
  requiere_revision boolean NOT NULL DEFAULT false,
  created_by        uuid,
  occurred_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  creado_en         timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS inventario_mov_op_uidx ON public.inventario_movimientos (op_id, inventario_id, tipo) WHERE op_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inv_mov_inventario ON public.inventario_movimientos (inventario_id, creado_en DESC);
DROP TRIGGER IF EXISTS inventario_movimientos_aplicar ON public.inventario_movimientos;
CREATE TRIGGER inventario_movimientos_aplicar BEFORE INSERT ON public.inventario_movimientos
  FOR EACH ROW EXECUTE FUNCTION public.sync_ledger_aplicar();

-- Reversos financieros (REVERSAL_ONLY): el registro original se conserva siempre.
CREATE TABLE IF NOT EXISTS public.reversos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo              text NOT NULL CHECK (tipo IN ('venta','devolucion','abono','credito','caja','orden')),
  entidad           text NOT NULL,
  registro_id       uuid NOT NULL,
  motivo            text NOT NULL CHECK (length(btrim(motivo)) >= 3),
  solicitado_por    uuid NOT NULL,
  autorizado_por    uuid,
  actuo_como_admin  boolean NOT NULL DEFAULT false,
  autorizacion_id   uuid,
  operation_id      uuid NOT NULL UNIQUE,
  device_id         text,
  detalle           jsonb,
  creado_en         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (actuo_como_admin OR autorizado_por IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS reversos_unico_total_uidx ON public.reversos (entidad, registro_id, tipo)
  WHERE tipo IN ('venta','abono','credito','caja','orden');
CREATE INDEX IF NOT EXISTS idx_reversos_registro ON public.reversos (entidad, registro_id);

-- Importación del respaldo del cliente: un solo lote aplicado, dry-run obligatorio, rollback por lote.
CREATE TABLE IF NOT EXISTS public.import_lotes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_device_id   text NOT NULL,
  backup_id          text,
  backup_sha256      text NOT NULL CHECK (backup_sha256 ~ '^[0-9a-f]{64}$'),
  version_app        text,
  esquema_db         integer,
  estado             text NOT NULL DEFAULT 'dry_run'
                     CHECK (estado IN ('dry_run','dry_run_ok','aplicando','aplicado','confirmado','revertido','fallido')),
  conteos_leidos     jsonb,
  conteos_insertados jsonb,
  conteos_omitidos   jsonb,
  informe            jsonb,
  creado_por         uuid NOT NULL,
  creado_en          timestamptz NOT NULL DEFAULT clock_timestamp(),
  aplicado_en        timestamptz,
  confirmado_en      timestamptz,
  revertido_en       timestamptz
);
-- un solo lote aplicado o confirmado a la vez: el segundo import se rechaza en la base
CREATE UNIQUE INDEX IF NOT EXISTS import_lotes_un_aplicado_uidx ON public.import_lotes ((true)) WHERE estado IN ('aplicado','confirmado');

CREATE TABLE IF NOT EXISTS public.import_registros (
  lote_id     uuid NOT NULL REFERENCES public.import_lotes (id) ON DELETE RESTRICT,
  tabla       text NOT NULL,
  registro_id uuid NOT NULL,
  PRIMARY KEY (lote_id, tabla, registro_id)
);

-- D-5: cada nombre de mecánico legado lo decide el administrador (perfil real o SIN ASIGNAR). Nunca por coincidencia de nombre.
CREATE TABLE IF NOT EXISTS public.import_mapeo_mecanicos (
  lote_id        uuid NOT NULL REFERENCES public.import_lotes (id) ON DELETE RESTRICT,
  nombre_legado  text NOT NULL,
  perfil_id      uuid REFERENCES public.perfiles (id) ON DELETE SET NULL,
  sin_asignar    boolean NOT NULL DEFAULT false,
  conteos        jsonb,
  decidido_por   uuid NOT NULL,
  decidido_en    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (lote_id, nombre_legado),
  CHECK (perfil_id IS NOT NULL OR sin_asignar)
);

-- PIN administrativo (D-7): NUNCA el PIN; solo su hash scrypt(HMAC(pin, pepper), sal).
CREATE TABLE IF NOT EXISTS public.admin_pin (
  perfil_id        uuid PRIMARY KEY REFERENCES public.perfiles (id) ON DELETE CASCADE,
  hash             text NOT NULL,
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  actualizado_por  uuid,
  actualizado_en   timestamptz NOT NULL DEFAULT clock_timestamp(),
  bloqueado_hasta  timestamptz
);
CREATE TABLE IF NOT EXISTS public.admin_pin_intentos (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitante_id  uuid,
  device_id       text,
  accion          text,
  entidad         text,
  registro_id     uuid,
  resultado       text NOT NULL CHECK (resultado IN ('reservado','ok','pin_incorrecto','bloqueado_solicitante',
                    'bloqueado_global','bloqueado_admin','sin_pin','no_permitido','cuenta_inactiva')),
  creado_en       timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_pin_intentos_solicitante ON public.admin_pin_intentos (solicitante_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_pin_intentos_creado ON public.admin_pin_intentos (creado_en DESC);
CREATE TABLE IF NOT EXISTS public.autorizaciones_admin (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitante_id  uuid NOT NULL,
  rol_solicitante text NOT NULL,
  autorizado_por  uuid NOT NULL,
  accion          text NOT NULL,
  entidad         text NOT NULL,
  registro_id     uuid NOT NULL,
  device_id       text,
  pin_version     integer NOT NULL,
  payload_hash    text,
  expira_en       timestamptz NOT NULL,
  consumida_en    timestamptz,
  consumida_op    uuid,
  creado_en       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expira_en > creado_en)
);
CREATE INDEX IF NOT EXISTS idx_autorizaciones_solicitante ON public.autorizaciones_admin (solicitante_id, creado_en DESC);

-- las tablas nuevas nacen cerradas: RLS activo, sin políticas y sin privilegios para anon/authenticated
DO $cerrar$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sync_ops','inventario_movimientos','reversos','import_lotes','import_registros',
                           'import_mapeo_mecanicos','admin_pin','admin_pin_intentos','autorizaciones_admin'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
END
$cerrar$;

-- POSTCONDICIONES (fallan cerradas) ---------------------------------------------------------------------------------
DO $post$
DECLARE t text; v_fail text := ''; n int;
BEGIN
  FOREACH t IN ARRAY ARRAY['sync_ops','inventario_movimientos','reversos','import_lotes','import_registros',
                           'import_mapeo_mecanicos','admin_pin','admin_pin_intentos','autorizaciones_admin'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass('public.' || t) AND c.relrowsecurity) THEN
      v_fail := v_fail || format('%s sin RLS; ', t);
    END IF;
    IF has_table_privilege('authenticated', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE') THEN
      v_fail := v_fail || format('%s abierta a authenticated; ', t);
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM pg_trigger WHERE tgname = 'zz_sync_sello' AND NOT tgisinternal;
  IF n <> 12 THEN v_fail := v_fail || format('zz_sync_sello en %s tablas (se esperaban 12); ', n); END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventario_cantidad_check') THEN
    v_fail := v_fail || 'sigue el CHECK inventario_cantidad_check; ';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND column_name IN ('taller_id', 'tenant_id')) THEN
    v_fail := v_fail || 'apareció taller_id/tenant_id; ';
  END IF;
  -- las 17 funciones de RCV-34 no se tocan: la coincidencia de md5 la comprueba la prueba SQL (pruebas/sync/sql)
  IF v_fail <> '' THEN RAISE EXCEPTION 'SYNC-1 STOP (postcondiciones, se revierte todo): %', v_fail; END IF;
  RAISE NOTICE 'SYNC-1: postcondiciones OK (12 tablas selladas, 9 tablas nuevas cerradas, sin multi-taller).';
END
$post$;

COMMIT;
