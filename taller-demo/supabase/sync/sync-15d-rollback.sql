-- ENTIMOTORS OS 3.15.0 · BLOQUE 4 · ROLLBACK de sync-15d-owner-pin-usuarios.sql · NO EJECUTADO EN PRODUCCIÓN
-- Vuelve a SYNC-3/3P/7B: sync_autorizar (el admin vuelve a pasar sin autorización), pin_emitir_autorizacion, pin_guardar y pin_desbloquear
-- con sus cuerpos LITERALES de sync-3-rpc.sql y sync-3p-pin.sql; quita las funciones, triggers, columnas y restricciones de 15d.
-- SE NIEGA si ya hay usuarios ELIMINADOS: quitar la marca los dejaría como simples «inactivos» reactivables y el borrado físico con
-- historial volvería a ser posible. Forzar solo a sabiendas (igual que 15b/15c):
--   PGOPTIONS="-c sync.forzar_rollback=si"                                  (local)
--   psql -c "SET sync.forzar_rollback = 'si'" -f sync-15d-rollback.sql      (pooler de Supabase: ignora PGOPTIONS; misma sesión)
-- Va ANTES que sync-15c-rollback.sql.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE n int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'perfiles' AND column_name = 'eliminado_en') THEN
    EXECUTE 'SELECT count(*) FROM public.perfiles WHERE eliminado_en IS NOT NULL' INTO n;
  END IF;
  IF n > 0 AND COALESCE(current_setting('sync.forzar_rollback', true), '') <> 'si' THEN
    RAISE EXCEPTION 'ROLLBACK STOP: hay % usuario(s) eliminado(s); volver a 3.14 quitaría la protección de su historial', n;
  END IF;
END
$pre$;

DROP TRIGGER IF EXISTS perfiles_proteger_historial ON public.perfiles;
DROP TRIGGER IF EXISTS zz_rt_cuenta ON public.perfiles;
DROP FUNCTION IF EXISTS public.eliminar_usuario(uuid,uuid,uuid,text,boolean);
DROP FUNCTION IF EXISTS public.usuario_impacto(uuid);
DROP FUNCTION IF EXISTS public.revocar_sesiones_usuario(uuid);
DROP FUNCTION IF EXISTS public.pin_quitar(uuid,uuid);
DROP FUNCTION IF EXISTS public.perfiles_proteger_historial();
DROP FUNCTION IF EXISTS public.perfil_tiene_historial(uuid);
DROP FUNCTION IF EXISTS public.sync_rt_perfiles();

CREATE OR REPLACE FUNCTION public.sync_autorizar(p_auth uuid, p_accion text, p_entidad text, p_registro uuid,
    p_op uuid, p_monto numeric, p_device text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_aut uuid;
BEGIN
  IF public.es_admin() THEN RETURN jsonb_build_object('o_autorizado', NULL, 'o_admin', true); END IF;
  IF NOT public.puede_cobrar() THEN
    RAISE EXCEPTION 'Este usuario no puede realizar esta acción' USING ERRCODE = '42501';
  END IF;
  IF p_auth IS NULL THEN
    RAISE EXCEPTION 'AUTORIZACION_REQUERIDA: esta acción necesita la autorización del administrador' USING ERRCODE = '42501';
  END IF;
  UPDATE public.autorizaciones_admin a
     SET consumida_en = clock_timestamp(), consumida_op = p_op
   WHERE a.id = p_auth AND a.solicitante_id = auth.uid() AND a.accion = p_accion AND a.entidad = p_entidad
     AND a.registro_id = p_registro AND a.consumida_en IS NULL AND a.expira_en > clock_timestamp()
     AND a.device_id IS NOT DISTINCT FROM p_device
     AND a.pin_version = (SELECT p.version FROM public.admin_pin p WHERE p.perfil_id = a.autorizado_por)
     AND (a.payload_hash IS NULL OR a.payload_hash = public.sync_hash_critico(p_accion, p_registro, p_monto))
  RETURNING a.autorizado_por INTO v_aut;
  IF v_aut IS NULL THEN
    RAISE EXCEPTION 'AUTORIZACION_INVALIDA: la autorización no existe, caducó, ya se usó o no corresponde a esta acción' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('o_autorizado', v_aut, 'o_admin', false);
END
$function$;

DROP FUNCTION IF EXISTS public.sync_sesion_viva(uuid);
DROP FUNCTION IF EXISTS public.sync_sesion_actual();
DROP FUNCTION IF EXISTS public.sync_accion_destructiva(text);

DROP FUNCTION IF EXISTS public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer,uuid);
CREATE OR REPLACE FUNCTION public.pin_emitir_autorizacion(p_solicitante uuid, p_rol text, p_admin uuid, p_accion text, p_entidad text,
    p_registro uuid, p_device text, p_pin_version integer, p_payload_hash text, p_ttl_seg integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_exp timestamptz;
BEGIN
  IF p_ttl_seg IS NULL OR p_ttl_seg < 10 OR p_ttl_seg > 300 THEN RAISE EXCEPTION 'TTL fuera de rango' USING ERRCODE = '22023'; END IF;
  -- el PIN pudo cambiar (o el admin darse de baja) mientras se verificaba: la autorización nace solo con la versión vigente
  IF NOT EXISTS (SELECT 1 FROM public.admin_pin ap JOIN public.perfiles p ON p.id = ap.perfil_id
                  WHERE ap.perfil_id = p_admin AND ap.version = p_pin_version AND p.activo AND p.rol = 'admin') THEN
    RAISE EXCEPTION 'PIN_CAMBIADO: el PIN cambió mientras se verificaba' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.autorizaciones_admin (solicitante_id, rol_solicitante, autorizado_por, accion, entidad, registro_id, device_id, pin_version, payload_hash, expira_en)
  VALUES (p_solicitante, p_rol, p_admin, p_accion, p_entidad, p_registro, p_device, p_pin_version, p_payload_hash,
          clock_timestamp() + make_interval(secs => p_ttl_seg))
  RETURNING id, expira_en INTO v_id, v_exp;
  INSERT INTO public.auditoria (usuario_id, usuario, rol, accion, entidad, entidad_id, detalle, device_id, autorizado_por, resultado)
  VALUES (p_solicitante, COALESCE((SELECT nombre FROM public.perfiles WHERE id = p_solicitante), '—'), p_rol, 'autorizacion', p_entidad, p_registro::text,
          p_accion, p_device, p_admin, 'emitida');
  RETURN jsonb_build_object('autorizacion_id', v_id, 'expira_en', v_exp);
END
$function$;

DROP FUNCTION IF EXISTS public.pin_guardar(uuid,text,uuid,text);
CREATE OR REPLACE FUNCTION public.pin_guardar(p_admin uuid, p_hash text, p_por uuid)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_ver integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.perfiles p WHERE p.id = p_admin AND p.rol = 'admin' AND p.activo) THEN
    RAISE EXCEPTION 'Solo un administrador activo puede tener PIN' USING ERRCODE = '42501';
  END IF;
  IF p_hash IS NULL OR p_hash !~ '^scrypt\$' THEN RAISE EXCEPTION 'Formato de hash inválido' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.admin_pin (perfil_id, hash, version, actualizado_por, actualizado_en, bloqueado_hasta)
  VALUES (p_admin, p_hash, 1, p_por, clock_timestamp(), NULL)
  ON CONFLICT (perfil_id) DO UPDATE SET hash = EXCLUDED.hash, version = public.admin_pin.version + 1,
      actualizado_por = EXCLUDED.actualizado_por, actualizado_en = clock_timestamp(), bloqueado_hasta = NULL
  RETURNING version INTO v_ver;
  RETURN v_ver;
END
$function$;

DROP FUNCTION IF EXISTS public.pin_desbloquear(uuid);
CREATE OR REPLACE FUNCTION public.pin_desbloquear(p_admin uuid)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  UPDATE public.admin_pin SET bloqueado_hasta = NULL, actualizado_en = clock_timestamp() WHERE perfil_id = p_admin
$function$;

REVOKE EXECUTE ON FUNCTION public.sync_autorizar(uuid,text,text,uuid,uuid,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_autorizar(uuid,text,text,uuid,uuid,numeric,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.pin_guardar(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_guardar(uuid,text,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.pin_desbloquear(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_desbloquear(uuid) TO service_role;

ALTER TABLE public.admin_pin_intentos DROP CONSTRAINT IF EXISTS admin_pin_intentos_resultado_check;
DELETE FROM public.admin_pin_intentos WHERE resultado = 'sesion_invalida';
ALTER TABLE public.admin_pin_intentos ADD CONSTRAINT admin_pin_intentos_resultado_check CHECK (resultado IN ('reservado','ok','pin_incorrecto','bloqueado_solicitante',
                    'bloqueado_global','bloqueado_admin','sin_pin','no_permitido','cuenta_inactiva'));
ALTER TABLE public.perfiles DROP CONSTRAINT IF EXISTS perfiles_eliminado_inactivo;
ALTER TABLE public.autorizaciones_admin DROP COLUMN IF EXISTS session_id;
ALTER TABLE public.perfiles DROP COLUMN IF EXISTS eliminado_por;
ALTER TABLE public.perfiles DROP COLUMN IF EXISTS eliminado_en;

DELETE FROM public.sync_fases WHERE fase = '15d';

DO $post$
BEGIN
  IF to_regprocedure('public.eliminar_usuario(uuid,uuid,uuid,text,boolean)') IS NOT NULL OR to_regprocedure('public.pin_guardar(uuid,text,uuid)') IS NULL
     OR to_regprocedure('public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer)') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK 15D STOP: estado inesperado';
  END IF;
  RAISE NOTICE 'SYNC-15D: rollback completo.';
END
$post$;
COMMIT;
