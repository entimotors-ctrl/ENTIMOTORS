-- ENTIMOTORS OS 3.14.0 · SYNC-3P · PIN ADMINISTRATIVO: límite de intentos persistente y emisión de autorizaciones
-- NO EJECUTADO EN PRODUCCIÓN. NO EJECUTAR SIN AUTORIZACIÓN EXPLÍCITA. Requiere sync-1, sync-2 y sync-3-rpc.
--
-- El PIN NUNCA pasa por estas funciones: el backend (Node) lo verifica con scrypt(HMAC(pin, pepper), sal) y solo consulta aquí
-- (a) si PUEDE intentarlo (límites) y (b) que se emita la autorización, con la hora de la base. Solo service_role las ejecuta.
--
-- LÍMITES (Q-6; los valores los pasa el backend, configurables en código de servidor):
--   · 5 intentos por solicitante → bloqueo de 15 min; luego el contador arranca de cero.
--   · 10 intentos globales → bloqueo global de 15 min.
--   · 3 bloqueos en 24 h → bloqueado hasta que el ADMINISTRADOR lo desbloquee (o cambie el PIN).
-- Cada intento se RESERVA antes de verificar el PIN, bajo un candado: 100 intentos en paralelo no evaden el contador.
-- Todo intento, bloqueo y éxito queda en admin_pin_intentos (solo agregar). Jamás se guarda el PIN, ni parcial.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('public.admin_pin_intentos') IS NULL OR to_regprocedure('public.sync_op_iniciar(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'SYNC-3P STOP: faltan SYNC-1/2/3';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.pin_reservar_intento(p_solicitante uuid, p_device text, p_accion text, p_entidad text, p_registro uuid,
    p_max_solicitante integer, p_max_global integer, p_ventana_min integer, p_bloqueo_min integer, p_max_bloqueos_24h integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  a record; v_ahora timestamptz := clock_timestamp(); v_ev_s timestamptz; v_ev_g timestamptz;
  v_base timestamptz; v_n integer; v_bloqueos integer; v_id bigint; v_ok_s timestamptz; v_ok_g timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_pin', 0));
  SELECT ap.perfil_id, ap.hash, ap.version, ap.bloqueado_hasta, ap.actualizado_en, p.activo INTO a
    FROM public.admin_pin ap JOIN public.perfiles p ON p.id = ap.perfil_id WHERE p.rol = 'admin' ORDER BY ap.actualizado_en DESC LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.admin_pin_intentos (solicitante_id, device_id, accion, entidad, registro_id, resultado) VALUES (p_solicitante, p_device, p_accion, p_entidad, p_registro, 'sin_pin');
    RETURN jsonb_build_object('permitido', false, 'motivo', 'sin_pin');
  END IF;
  IF NOT a.activo THEN
    INSERT INTO public.admin_pin_intentos (solicitante_id, device_id, accion, entidad, registro_id, resultado) VALUES (p_solicitante, p_device, p_accion, p_entidad, p_registro, 'cuenta_inactiva');
    RETURN jsonb_build_object('permitido', false, 'motivo', 'cuenta_inactiva');
  END IF;
  IF a.bloqueado_hasta IS NOT NULL AND a.bloqueado_hasta > v_ahora THEN
    INSERT INTO public.admin_pin_intentos (solicitante_id, device_id, accion, entidad, registro_id, resultado) VALUES (p_solicitante, p_device, p_accion, p_entidad, p_registro, 'bloqueado_admin');
    RETURN jsonb_build_object('permitido', false, 'motivo', 'bloqueado_admin');
  END IF;

  -- ¿sigue vigente un bloqueo del solicitante o global? (los eventos de bloqueo son filas de solo agregar)
  SELECT max(creado_en) INTO v_ev_s FROM public.admin_pin_intentos WHERE solicitante_id = p_solicitante AND resultado = 'bloqueado_solicitante' AND creado_en > a.actualizado_en;
  IF v_ev_s IS NOT NULL AND v_ahora < v_ev_s + make_interval(mins => p_bloqueo_min) THEN
    RETURN jsonb_build_object('permitido', false, 'motivo', 'bloqueado_solicitante', 'reintentar_en_s', ceil(extract(epoch FROM (v_ev_s + make_interval(mins => p_bloqueo_min) - v_ahora)))::int);
  END IF;
  SELECT max(creado_en) INTO v_ev_g FROM public.admin_pin_intentos WHERE resultado = 'bloqueado_global' AND creado_en > a.actualizado_en;
  IF v_ev_g IS NOT NULL AND v_ahora < v_ev_g + make_interval(mins => p_bloqueo_min) THEN
    RETURN jsonb_build_object('permitido', false, 'motivo', 'bloqueado_global', 'reintentar_en_s', ceil(extract(epoch FROM (v_ev_g + make_interval(mins => p_bloqueo_min) - v_ahora)))::int);
  END IF;

  -- intentos reservados desde el último bloqueo propio, el último éxito, el último cambio/desbloqueo y dentro de la ventana
  SELECT max(creado_en) INTO v_ok_s FROM public.admin_pin_intentos WHERE solicitante_id = p_solicitante AND resultado = 'ok';
  v_base := GREATEST(a.actualizado_en, v_ahora - make_interval(mins => p_ventana_min), COALESCE(v_ev_s, '-infinity'), COALESCE(v_ok_s, '-infinity'));
  SELECT count(*) INTO v_n FROM public.admin_pin_intentos WHERE solicitante_id = p_solicitante AND resultado = 'reservado' AND creado_en > v_base;
  IF v_n >= p_max_solicitante THEN
    INSERT INTO public.admin_pin_intentos (solicitante_id, device_id, accion, entidad, registro_id, resultado) VALUES (p_solicitante, p_device, p_accion, p_entidad, p_registro, 'bloqueado_solicitante');
    SELECT count(*) INTO v_bloqueos FROM public.admin_pin_intentos WHERE resultado IN ('bloqueado_solicitante', 'bloqueado_global') AND creado_en > GREATEST(a.actualizado_en, v_ahora - interval '24 hours');
    IF v_bloqueos >= p_max_bloqueos_24h THEN
      UPDATE public.admin_pin SET bloqueado_hasta = 'infinity' WHERE perfil_id = a.perfil_id;
      INSERT INTO public.admin_pin_intentos (solicitante_id, device_id, accion, entidad, registro_id, resultado) VALUES (p_solicitante, p_device, p_accion, p_entidad, p_registro, 'bloqueado_admin');
      RETURN jsonb_build_object('permitido', false, 'motivo', 'bloqueado_admin');
    END IF;
    RETURN jsonb_build_object('permitido', false, 'motivo', 'bloqueado_solicitante', 'reintentar_en_s', p_bloqueo_min * 60);
  END IF;
  SELECT max(creado_en) INTO v_ok_g FROM public.admin_pin_intentos WHERE resultado = 'ok';
  v_base := GREATEST(a.actualizado_en, v_ahora - make_interval(mins => p_ventana_min), COALESCE(v_ev_g, '-infinity'), COALESCE(v_ok_g, '-infinity'));
  SELECT count(*) INTO v_n FROM public.admin_pin_intentos WHERE resultado = 'reservado' AND creado_en > v_base;
  IF v_n >= p_max_global THEN
    INSERT INTO public.admin_pin_intentos (solicitante_id, device_id, accion, entidad, registro_id, resultado) VALUES (NULL, p_device, p_accion, p_entidad, p_registro, 'bloqueado_global');
    SELECT count(*) INTO v_bloqueos FROM public.admin_pin_intentos WHERE resultado IN ('bloqueado_solicitante', 'bloqueado_global') AND creado_en > GREATEST(a.actualizado_en, v_ahora - interval '24 hours');
    IF v_bloqueos >= p_max_bloqueos_24h THEN
      UPDATE public.admin_pin SET bloqueado_hasta = 'infinity' WHERE perfil_id = a.perfil_id;
      INSERT INTO public.admin_pin_intentos (solicitante_id, device_id, accion, entidad, registro_id, resultado) VALUES (NULL, p_device, p_accion, p_entidad, p_registro, 'bloqueado_admin');
      RETURN jsonb_build_object('permitido', false, 'motivo', 'bloqueado_admin');
    END IF;
    RETURN jsonb_build_object('permitido', false, 'motivo', 'bloqueado_global', 'reintentar_en_s', p_bloqueo_min * 60);
  END IF;

  INSERT INTO public.admin_pin_intentos (solicitante_id, device_id, accion, entidad, registro_id, resultado)
  VALUES (p_solicitante, p_device, p_accion, p_entidad, p_registro, 'reservado') RETURNING id INTO v_id;
  RETURN jsonb_build_object('permitido', true, 'intento_id', v_id, 'admin_id', a.perfil_id, 'pin_version', a.version, 'hash', a.hash,
                            'intentos_restantes', GREATEST(0, p_max_solicitante - v_n - 1));
END
$function$;

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

-- Guardar (o cambiar) el PIN: sube la versión (invalida al instante las autorizaciones sin consumir) y reinicia los contadores.
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

-- Desbloqueo del administrador: levanta el bloqueo y los contadores vuelven a cero.
CREATE OR REPLACE FUNCTION public.pin_desbloquear(p_admin uuid)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  UPDATE public.admin_pin SET bloqueado_hasta = NULL, actualizado_en = clock_timestamp() WHERE perfil_id = p_admin
$function$;

REVOKE EXECUTE ON FUNCTION public.pin_reservar_intento(uuid,text,text,text,uuid,integer,integer,integer,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_reservar_intento(uuid,text,text,text,uuid,integer,integer,integer,integer,integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_emitir_autorizacion(uuid,text,uuid,text,text,uuid,text,integer,text,integer) TO service_role;

REVOKE EXECUTE ON FUNCTION public.pin_guardar(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_guardar(uuid,text,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.pin_desbloquear(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_desbloquear(uuid) TO service_role;

COMMIT;
