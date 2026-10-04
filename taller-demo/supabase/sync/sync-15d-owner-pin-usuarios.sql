-- ENTIMOTORS OS 3.15.0 · BLOQUE 4 · OWNER-PIN-GUARD + ELIMINAR USUARIO SEGURO · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere la cadena SYNC 1..10 + 15a + 15b + 15c. Idempotente.
--
-- OWNER-PIN-GUARD (autorización REAL en la base, no un modal)
--  · Acciones DESTRUCTIVAS (sync_accion_destructiva): reversar_venta, reversar_credito, reversar_abono, reversar_caja, anular_orden
--    (con dinero) y eliminar_usuario. Exigen una autorización emitida con el PIN del propietario A TODOS, incluido el administrador
--    (hasta 3.14.1 el admin pasaba sin nada). SENSIBLES (ajustar_stock, registrar_devolucion): el cajero con PIN, el admin con su
--    sesión (sin cambios). Sin PIN configurado → las destructivas quedan bloqueadas (fail closed; no hay PIN por defecto).
--  · La autorización es de UN solo uso, dura segundos (TTL del backend, 10–300 s; 90 por defecto), va ligada a solicitante + acción +
--    entidad + registro + dispositivo + versión del PIN (+ monto) y, desde 3.15, a la SESIÓN de Auth (claim session_id): cerrar sesión,
--    cambiar de usuario o revocar la sesión la inutiliza aunque el access token siga vivo.
--  · Cambiar, recuperar, quitar el PIN y desbloquearlo quedan AUDITADOS (sin el PIN, jamás).
--
-- ELIMINAR USUARIO ≠ BORRAR HISTORIAL
--  · eliminar_usuario: perfil activo = false + eliminado_en/por (definitivo: no se reactiva ni cambia de rol), trabajo ACTIVO resuelto
--    (o se niega con el conteo, o se DESASIGNA explícitamente — nunca se reasigna a otra persona), auditoría, aviso realtime «cuenta».
--    La historia (órdenes, ventas, caja, créditos, citas, mensajes, ledger, fotos, auditoría) no se toca: el perfil sigue existiendo con
--    su nombre, así que ninguna referencia queda en NULL.
--  · Borrado FÍSICO de un perfil con historial: PROHIBIDO (trigger). Las 39 FK a perfiles son ON DELETE SET NULL/CASCADE: borrar la cuenta
--    desde el panel de Auth dejaría la autoría en NULL; ahora ese borrado falla y hay que usar «Eliminar usuario». Un perfil SIN historial
--    (p. ej. un alta que falló) se puede seguir borrando.
--  · revocar_sesiones_usuario: borra las sesiones de Auth de un usuario YA eliminado (los refresh tokens caen en cascada). El backend
--    además lo banea en Auth (login, refresh, /user y enlaces previos quedan rechazados).
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sync_fases WHERE fase = '15c') THEN RAISE EXCEPTION 'SYNC-15D STOP: falta sync-15c'; END IF;
  IF to_regprocedure('public.sync_autorizar(uuid,text,text,uuid,uuid,numeric,text)') IS NULL
     OR (to_regprocedure('public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer)') IS NULL
         AND to_regprocedure('public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer,uuid)') IS NULL)
     OR (to_regprocedure('public.pin_guardar(uuid,text,uuid)') IS NULL AND to_regprocedure('public.pin_guardar(uuid,text,uuid,text)') IS NULL) THEN
    RAISE EXCEPTION 'SYNC-15D STOP: faltan SYNC-3/3P/7B';
  END IF;
END
$pre$;

-- ═════════════════════════ 1. COLUMNAS ═════════════════════════
ALTER TABLE public.perfiles ADD COLUMN IF NOT EXISTS eliminado_en timestamptz;
ALTER TABLE public.perfiles ADD COLUMN IF NOT EXISTS eliminado_por uuid;
ALTER TABLE public.autorizaciones_admin ADD COLUMN IF NOT EXISTS session_id uuid;
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perfiles_eliminado_inactivo') THEN
    ALTER TABLE public.perfiles ADD CONSTRAINT perfiles_eliminado_inactivo CHECK (eliminado_en IS NULL OR activo = false);
  END IF;
END $c$;
-- nuevos resultados del registro de intentos (solo agregar): cambios de PIN y re-autenticaciones con la contraseña
ALTER TABLE public.admin_pin_intentos DROP CONSTRAINT IF EXISTS admin_pin_intentos_resultado_check;
ALTER TABLE public.admin_pin_intentos ADD CONSTRAINT admin_pin_intentos_resultado_check CHECK (resultado IN ('reservado','ok','pin_incorrecto','bloqueado_solicitante',
  'bloqueado_global','bloqueado_admin','sin_pin','no_permitido','cuenta_inactiva','sesion_invalida'));

-- ═════════════════════════ 2. PERFIL ELIMINADO: DEFINITIVO Y SIN BORRADO FÍSICO ═════════════════════════
CREATE OR REPLACE FUNCTION public.perfil_tiene_historial(p_perfil uuid)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record; v boolean;
BEGIN
  -- toda columna que apunta a perfiles por FK (39 en producción), más las referencias sin FK que guardan autoría
  FOR r IN SELECT c.conrelid::regclass AS tabla, a.attname AS col FROM pg_constraint c
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f' AND c.confrelid = 'public.perfiles'::regclass AND c.conrelid <> 'public.perfiles'::regclass
              AND c.conrelid <> 'public.admin_pin'::regclass LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', r.tabla, r.col) INTO v USING p_perfil;
    IF v THEN RETURN true; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.auditoria WHERE usuario_id = p_perfil OR autorizado_por = p_perfil) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.ventas WHERE mecanico_id = p_perfil) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.autorizaciones_admin WHERE solicitante_id = p_perfil OR autorizado_por = p_perfil) THEN RETURN true; END IF;
  RETURN false;
END
$function$;

CREATE OR REPLACE FUNCTION public.perfiles_proteger_historial()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.eliminado_en IS NOT NULL OR public.perfil_tiene_historial(OLD.id) THEN
      RAISE EXCEPTION 'PERFIL_CON_HISTORIAL: esta persona tiene historial en ENTIMOTORS; usa «Eliminar usuario» (bloquea el acceso y conserva la historia)'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE: una cuenta eliminada no vuelve (ni se reactiva, ni cambia de rol, ni se «des-elimina»)
  IF OLD.eliminado_en IS NOT NULL AND (NEW.activo OR NEW.eliminado_en IS DISTINCT FROM OLD.eliminado_en OR NEW.rol IS DISTINCT FROM OLD.rol
       OR NEW.eliminado_por IS DISTINCT FROM OLD.eliminado_por) THEN
    RAISE EXCEPTION 'USUARIO_ELIMINADO: una cuenta eliminada no se reactiva ni cambia de rol' USING ERRCODE = '42501';
  END IF;
  -- eliminado_en solo lo pone eliminar_usuario (marca de transacción); nadie lo fija a mano por la tabla
  IF OLD.eliminado_en IS NULL AND NEW.eliminado_en IS NOT NULL AND COALESCE(current_setting('entimotors.eliminando_usuario', true), '') <> NEW.id::text THEN
    RAISE EXCEPTION 'Solo «Eliminar usuario» marca una cuenta como eliminada' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS perfiles_proteger_historial ON public.perfiles;
CREATE TRIGGER perfiles_proteger_historial BEFORE UPDATE OR DELETE ON public.perfiles FOR EACH ROW EXECUTE FUNCTION public.perfiles_proteger_historial();

-- aviso realtime «tu cuenta cambió» (sin datos): el cliente comprueba su perfil y, si ya no está activo, cierra la sesión en TODOS sus
-- dispositivos conectados; los que estaban cerrados lo descubren al abrir (perfil inactivo / Auth rechaza).
CREATE OR REPLACE FUNCTION public.sync_rt_perfiles()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.activo AND NOT NEW.activo THEN
    PERFORM public.sync_rt_aviso('mt:' || NEW.id::text, jsonb_build_object('e', 'cuenta', 'id', NEW.id));
    PERFORM public.sync_rt_aviso('taller', jsonb_build_object('e', 'cuenta', 'id', NEW.id));
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ENTIMOTORS aviso realtime (perfiles) omitido: %', SQLERRM;
  RETURN NULL;
END
$function$;
DROP TRIGGER IF EXISTS zz_rt_cuenta ON public.perfiles;
CREATE TRIGGER zz_rt_cuenta AFTER UPDATE ON public.perfiles FOR EACH ROW EXECUTE FUNCTION public.sync_rt_perfiles();

-- ═════════════════════════ 3. OWNER-PIN-GUARD ═════════════════════════
CREATE OR REPLACE FUNCTION public.sync_accion_destructiva(p_accion text)
 RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT p_accion = ANY (ARRAY['reversar_venta', 'reversar_credito', 'reversar_abono', 'reversar_caja', 'anular_orden', 'eliminar_usuario'])
$function$;

-- sesión de Auth de quien llama (claim session_id del JWT que valida PostgREST), o NULL
CREATE OR REPLACE FUNCTION public.sync_sesion_actual()
 RETURNS uuid LANGUAGE plpgsql STABLE SET search_path TO 'public'
AS $function$
DECLARE v text;
BEGIN
  v := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id';
  IF v IS NULL OR v !~* '^[0-9a-f-]{36}$' THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END
$function$;

-- ¿esa sesión sigue viva en Auth? (logout/revocación la borran). Sin tabla de sesiones (base sin Auth), no se puede comprobar: false.
CREATE OR REPLACE FUNCTION public.sync_sesion_viva(p_sesion uuid)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v boolean;
BEGIN
  IF p_sesion IS NULL OR to_regclass('auth.sessions') IS NULL THEN RETURN false; END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM auth.sessions WHERE id = $1)' INTO v USING p_sesion;
  RETURN v;
END
$function$;

-- 3.15 (Bloque 4): el admin ya NO pasa sin autorización en lo DESTRUCTIVO; toda autorización queda ligada a la sesión que la pidió.
CREATE OR REPLACE FUNCTION public.sync_autorizar(p_auth uuid, p_accion text, p_entidad text, p_registro uuid,
    p_op uuid, p_monto numeric, p_device text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_aut uuid; v_sid uuid := public.sync_sesion_actual(); v_admin boolean := public.es_admin();
BEGIN
  IF v_admin AND NOT public.sync_accion_destructiva(p_accion) THEN RETURN jsonb_build_object('o_autorizado', NULL, 'o_admin', true); END IF;
  IF NOT v_admin AND NOT public.puede_cobrar() THEN
    RAISE EXCEPTION 'Este usuario no puede realizar esta acción' USING ERRCODE = '42501';
  END IF;
  IF p_auth IS NULL THEN
    RAISE EXCEPTION 'AUTORIZACION_REQUERIDA: esta acción necesita el PIN del propietario' USING ERRCODE = '42501';
  END IF;
  UPDATE public.autorizaciones_admin a
     SET consumida_en = clock_timestamp(), consumida_op = p_op
   WHERE a.id = p_auth AND a.solicitante_id = auth.uid() AND a.accion = p_accion AND a.entidad = p_entidad
     AND a.registro_id = p_registro AND a.consumida_en IS NULL AND a.expira_en > clock_timestamp()
     AND a.device_id IS NOT DISTINCT FROM p_device
     AND a.session_id IS NOT DISTINCT FROM v_sid
     AND (a.session_id IS NULL OR public.sync_sesion_viva(a.session_id))
     AND a.pin_version = (SELECT p.version FROM public.admin_pin p WHERE p.perfil_id = a.autorizado_por)
     AND (a.payload_hash IS NULL OR a.payload_hash = public.sync_hash_critico(p_accion, p_registro, p_monto))
  RETURNING a.autorizado_por INTO v_aut;
  IF v_aut IS NULL THEN
    RAISE EXCEPTION 'AUTORIZACION_INVALIDA: la autorización no existe, caducó, ya se usó, es de otra sesión o no corresponde a esta acción' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('o_autorizado', v_aut, 'o_admin', v_admin);
END
$function$;

-- emisión: + sesión (DEFAULT NULL: el api-server 3.14.1 sigue llamando igual)
DROP FUNCTION IF EXISTS public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer);
CREATE OR REPLACE FUNCTION public.pin_emitir_autorizacion(p_solicitante uuid, p_rol text, p_admin uuid, p_accion text, p_entidad text,
    p_registro uuid, p_device text, p_pin_version integer, p_payload_hash text, p_ttl_seg integer, p_session uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_exp timestamptz;
BEGIN
  IF p_ttl_seg IS NULL OR p_ttl_seg < 10 OR p_ttl_seg > 300 THEN RAISE EXCEPTION 'TTL fuera de rango' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admin_pin ap JOIN public.perfiles p ON p.id = ap.perfil_id
                  WHERE ap.perfil_id = p_admin AND ap.version = p_pin_version AND p.activo AND p.rol = 'admin') THEN
    RAISE EXCEPTION 'PIN_CAMBIADO: el PIN cambió mientras se verificaba' USING ERRCODE = '55000';
  END IF;
  -- el solicitante tiene que seguir activo y, si trae sesión, esa sesión tiene que existir
  IF NOT EXISTS (SELECT 1 FROM public.perfiles p WHERE p.id = p_solicitante AND p.activo) THEN
    RAISE EXCEPTION 'CUENTA_INACTIVA' USING ERRCODE = '42501';
  END IF;
  IF p_session IS NOT NULL AND NOT public.sync_sesion_viva(p_session) THEN RAISE EXCEPTION 'SESION_INVALIDA' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.autorizaciones_admin (solicitante_id, rol_solicitante, autorizado_por, accion, entidad, registro_id, device_id, pin_version, payload_hash, expira_en, session_id)
  VALUES (p_solicitante, p_rol, p_admin, p_accion, p_entidad, p_registro, p_device, p_pin_version, p_payload_hash,
          clock_timestamp() + make_interval(secs => p_ttl_seg), p_session)
  RETURNING id, expira_en INTO v_id, v_exp;
  INSERT INTO public.auditoria (usuario_id, usuario, rol, accion, entidad, entidad_id, detalle, device_id, autorizado_por, resultado)
  VALUES (p_solicitante, COALESCE((SELECT nombre FROM public.perfiles WHERE id = p_solicitante), '—'), p_rol, 'autorizacion', p_entidad, p_registro::text,
          p_accion, p_device, p_admin, 'emitida');
  RETURN jsonb_build_object('autorizacion_id', v_id, 'expira_en', v_exp);
END
$function$;

-- guardar/cambiar/recuperar el PIN: + vía y AUDITORÍA (sin el PIN). La versión sube: toda autorización sin consumir muere al instante.
DROP FUNCTION IF EXISTS public.pin_guardar(uuid,text,uuid);
CREATE OR REPLACE FUNCTION public.pin_guardar(p_admin uuid, p_hash text, p_por uuid, p_via text DEFAULT NULL)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_ver integer; v_accion text;
BEGIN
  p_via := COALESCE(p_via, 'pin');   -- DEFAULT NULL (no un literal): la guarda estática RCV-34 analiza la firma
  IF NOT EXISTS (SELECT 1 FROM public.perfiles p WHERE p.id = p_admin AND p.rol = 'admin' AND p.activo) THEN
    RAISE EXCEPTION 'Solo un administrador activo puede tener PIN' USING ERRCODE = '42501';
  END IF;
  IF p_hash IS NULL OR p_hash !~ '^scrypt\$' THEN RAISE EXCEPTION 'Formato de hash inválido' USING ERRCODE = '22023'; END IF;
  IF p_via NOT IN ('pin', 'clave', 'inicial') THEN RAISE EXCEPTION 'Vía inválida' USING ERRCODE = '22023'; END IF;
  v_accion := CASE WHEN NOT EXISTS (SELECT 1 FROM public.admin_pin WHERE perfil_id = p_admin) THEN 'pin-configurar'
                   WHEN p_via = 'clave' THEN 'pin-recuperar' ELSE 'pin-cambiar' END;
  INSERT INTO public.admin_pin (perfil_id, hash, version, actualizado_por, actualizado_en, bloqueado_hasta)
  VALUES (p_admin, p_hash, 1, p_por, clock_timestamp(), NULL)
  ON CONFLICT (perfil_id) DO UPDATE SET hash = EXCLUDED.hash, version = public.admin_pin.version + 1,
      actualizado_por = EXCLUDED.actualizado_por, actualizado_en = clock_timestamp(), bloqueado_hasta = NULL
  RETURNING version INTO v_ver;
  INSERT INTO public.auditoria (usuario_id, usuario, rol, accion, entidad, entidad_id, detalle, resultado)
  VALUES (p_por, COALESCE((SELECT nombre FROM public.perfiles WHERE id = p_por), '—'), 'admin', v_accion, 'admin_pin', p_admin::text,
          'versión ' || v_ver || CASE WHEN p_via = 'clave' THEN ' (confirmado con la contraseña de la cuenta)' ELSE '' END, 'ok');
  RETURN v_ver;
END
$function$;

CREATE OR REPLACE FUNCTION public.pin_quitar(p_admin uuid, p_por uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.admin_pin WHERE perfil_id = p_admin;
  IF FOUND THEN
    INSERT INTO public.auditoria (usuario_id, usuario, rol, accion, entidad, entidad_id, detalle, resultado)
    VALUES (p_por, COALESCE((SELECT nombre FROM public.perfiles WHERE id = p_por), '—'), 'admin', 'pin-quitar', 'admin_pin', p_admin::text,
            'sin PIN: las acciones destructivas quedan bloqueadas', 'ok');
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.pin_desbloquear(p_admin uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.admin_pin SET bloqueado_hasta = NULL, actualizado_en = clock_timestamp() WHERE perfil_id = p_admin;
  INSERT INTO public.auditoria (usuario_id, usuario, rol, accion, entidad, entidad_id, detalle, resultado)
  VALUES (p_admin, COALESCE((SELECT nombre FROM public.perfiles WHERE id = p_admin), '—'), 'admin', 'pin-desbloquear', 'admin_pin', p_admin::text,
          'contadores de intentos reiniciados', 'ok');
END
$function$;

-- ═════════════════════════ 4. ELIMINAR USUARIO ═════════════════════════
-- Qué tiene la persona: trabajo ACTIVO (se resuelve antes) e historial (se conserva). Solo el admin.
CREATE OR REPLACE FUNCTION public.usuario_impacto(p_perfil uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE p record;
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador' USING ERRCODE = '42501'; END IF;
  SELECT id, nombre, rol, activo, eliminado_en INTO p FROM public.perfiles WHERE id = p_perfil;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ese usuario no existe' USING ERRCODE = '23503'; END IF;
  RETURN jsonb_build_object(
    'id', p.id, 'nombre', p.nombre, 'rol', p.rol, 'activo', p.activo, 'eliminado_en', p.eliminado_en,
    'es_usted', p.id = auth.uid(),
    'ordenes_activas', (SELECT COALESCE(jsonb_agg(o.id ORDER BY o.creado_en), '[]'::jsonb) FROM public.ordenes o
                         WHERE o.mecanico_id = p_perfil AND o.deleted_at IS NULL AND NOT o.anulada AND NOT o.finalizada AND o.estado <> 'entregado'),
    'citas_abiertas', (SELECT COALESCE(jsonb_agg(c.id ORDER BY c.fecha, c.hora), '[]'::jsonb) FROM public.citas c
                        WHERE c.mecanico_id = p_perfil AND c.deleted_at IS NULL AND c.orden_id IS NULL AND COALESCE(c.estado, '') NOT IN ('atendida', 'ausente', 'cancelada')),
    'historial', jsonb_build_object(
      'ordenes', (SELECT count(*) FROM public.ordenes o WHERE o.mecanico_id = p_perfil),
      'ventas', (SELECT count(*) FROM public.ventas v WHERE v.created_by = p_perfil OR v.mecanico_id = p_perfil),
      'caja', (SELECT count(*) FROM public.caja_movimientos m WHERE m.created_by = p_perfil),
      'mensajes', (SELECT count(*) FROM public.mensajes m WHERE m.destinatario_id = p_perfil OR m.remitente_id = p_perfil),
      'auditoria', (SELECT count(*) FROM public.auditoria a WHERE a.usuario_id = p_perfil)));
END
$function$;

CREATE OR REPLACE FUNCTION public.eliminar_usuario(p_op uuid, p_perfil uuid, p_autorizacion uuid, p_device text DEFAULT NULL, p_desasignar boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; p record; a record; v_ord uuid[]; v_cit uuid[]; v_res jsonb; v_admins int;
BEGIN
  IF NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador elimina usuarios' USING ERRCODE = '42501'; END IF;
  v_hash := md5(jsonb_build_array(p_perfil, COALESCE(p_desasignar, false))::text);
  v_prev := public.sync_op_iniciar(p_op, 'eliminar_usuario', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  SELECT id, nombre, rol, activo, eliminado_en INTO p FROM public.perfiles WHERE id = p_perfil FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ese usuario no existe' USING ERRCODE = '23503'; END IF;
  IF p.id = auth.uid() THEN RAISE EXCEPTION 'No puedes eliminar tu propia cuenta' USING ERRCODE = '42501'; END IF;
  IF p.rol = 'admin' THEN
    SELECT count(*) INTO v_admins FROM public.perfiles WHERE rol = 'admin' AND activo AND id <> p_perfil;
    RAISE EXCEPTION 'La cuenta del administrador no se elimina desde aquí (quedarían % administrador(es) activos)', v_admins USING ERRCODE = '42501';
  END IF;
  -- ya eliminado (doble clic, otra pestaña, otro dispositivo): mismo resultado, sin consumir otra autorización
  IF p.eliminado_en IS NOT NULL THEN
    RETURN jsonb_build_object('perfil_id', p_perfil, 'ya_eliminado', true, 'eliminado_en', p.eliminado_en);
  END IF;

  SELECT COALESCE(array_agg(o.id), '{}') INTO v_ord FROM public.ordenes o
   WHERE o.mecanico_id = p_perfil AND o.deleted_at IS NULL AND NOT o.anulada AND NOT o.finalizada AND o.estado <> 'entregado';
  SELECT COALESCE(array_agg(c.id), '{}') INTO v_cit FROM public.citas c
   WHERE c.mecanico_id = p_perfil AND c.deleted_at IS NULL AND c.orden_id IS NULL AND COALESCE(c.estado, '') NOT IN ('atendida', 'ausente', 'cancelada');
  IF (cardinality(v_ord) + cardinality(v_cit)) > 0 AND NOT COALESCE(p_desasignar, false) THEN
    RAISE EXCEPTION 'TRABAJO_ACTIVO: tiene % orden(es) activa(s) y % cita(s) abierta(s); desasígnalas (o reasígnalas) antes de eliminar',
      cardinality(v_ord), cardinality(v_cit) USING ERRCODE = '23514';
  END IF;

  -- el PIN del propietario: autorización de un solo uso para ESTA persona (se consume aquí; si algo falla después, se revierte todo)
  SELECT * INTO a FROM jsonb_to_record(public.sync_autorizar(p_autorizacion, 'eliminar_usuario', 'perfiles', p_perfil, p_op, NULL, p_device))
    AS x(o_autorizado uuid, o_admin boolean);

  -- trabajo ACTIVO: queda «sin asignar» para que un humano lo reasigne. Nunca se pasa a otra persona. La historia cerrada no se toca.
  IF cardinality(v_ord) > 0 THEN UPDATE public.ordenes SET mecanico_id = NULL, mecanico = NULL, last_op_id = p_op WHERE id = ANY (v_ord); END IF;
  IF cardinality(v_cit) > 0 THEN UPDATE public.citas SET mecanico_id = NULL, mecanico = NULL, last_op_id = p_op WHERE id = ANY (v_cit); END IF;

  PERFORM set_config('entimotors.eliminando_usuario', p_perfil::text, true);
  UPDATE public.perfiles SET activo = false, eliminado_en = clock_timestamp(), eliminado_por = auth.uid() WHERE id = p_perfil;
  PERFORM set_config('entimotors.eliminando_usuario', '', true);

  PERFORM public.sync_auditar('usuario-eliminar', 'perfiles', p_perfil::text,
    'Eliminado ' || p.nombre || ' (' || p.rol || '); historial conservado; desasignadas ' || cardinality(v_ord) || ' orden(es) y ' || cardinality(v_cit) || ' cita(s)'
      || CASE WHEN cardinality(v_ord) + cardinality(v_cit) > 0 THEN ': ' || array_to_string(v_ord || v_cit, ',') ELSE '' END,
    p_op, p_device, a.o_autorizado, 'ok');
  v_res := jsonb_build_object('perfil_id', p_perfil, 'eliminado', true, 'ordenes_desasignadas', to_jsonb(v_ord), 'citas_desasignadas', to_jsonb(v_cit));
  RETURN public.sync_op_guardar(p_op, 'eliminar_usuario', v_hash, p_device, v_res);
END
$function$;

-- Sesiones de Auth de una cuenta YA eliminada (el backend lo llama tras eliminar; además la banea en Auth). Los refresh tokens van
-- en cascada con la sesión. Nunca sobre una cuenta activa.
CREATE OR REPLACE FUNCTION public.revocar_sesiones_usuario(p_perfil uuid)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE n integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.perfiles WHERE id = p_perfil AND eliminado_en IS NOT NULL) THEN
    RAISE EXCEPTION 'Solo se revocan las sesiones de una cuenta eliminada' USING ERRCODE = '42501';
  END IF;
  IF to_regclass('auth.sessions') IS NULL THEN RETURN 0; END IF;
  EXECUTE 'WITH b AS (DELETE FROM auth.sessions WHERE user_id = $1 RETURNING 1) SELECT count(*) FROM b' INTO n USING p_perfil;
  IF to_regclass('auth.refresh_tokens') IS NOT NULL THEN
    EXECUTE 'UPDATE auth.refresh_tokens SET revoked = true WHERE user_id = $1::text AND NOT revoked' USING p_perfil;
  END IF;
  RETURN n;
END
$function$;

-- ═════════════════════════ ACL ═════════════════════════
REVOKE EXECUTE ON FUNCTION public.perfil_tiene_historial(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perfil_tiene_historial(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.perfiles_proteger_historial() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perfiles_proteger_historial() TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_rt_perfiles() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_rt_perfiles() TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_accion_destructiva(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_accion_destructiva(text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.sync_sesion_actual() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_sesion_actual() TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_sesion_viva(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_sesion_viva(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_autorizar(uuid,text,text,uuid,uuid,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_autorizar(uuid,text,text,uuid,uuid,numeric,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.pin_guardar(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_guardar(uuid,text,uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.pin_quitar(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_quitar(uuid,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.pin_desbloquear(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_desbloquear(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.usuario_impacto(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.usuario_impacto(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.eliminar_usuario(uuid,uuid,uuid,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.eliminar_usuario(uuid,uuid,uuid,text,boolean) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.revocar_sesiones_usuario(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revocar_sesiones_usuario(uuid) TO service_role;

INSERT INTO public.sync_fases (fase) VALUES ('15d') ON CONFLICT (fase) DO NOTHING;

DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('perfil_tiene_historial','perfiles_proteger_historial','sync_rt_perfiles','sync_sesion_actual','sync_sesion_viva','sync_autorizar',
                       'pin_emitir_autorizacion','pin_guardar','pin_quitar','pin_desbloquear','revocar_sesiones_usuario')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF n <> 0 THEN RAISE EXCEPTION 'SYNC-15D STOP: % funciones internas ejecutables por anon/authenticated', n; END IF;
  IF to_regprocedure('public.pin_guardar(uuid,text,uuid)') IS NOT NULL OR to_regprocedure('public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'SYNC-15D STOP: quedaron firmas viejas (sobrecarga ambigua)';
  END IF;
  RAISE NOTICE 'SYNC-15D: OWNER-PIN-GUARD + eliminar usuario listos.';
END
$post$;
COMMIT;
