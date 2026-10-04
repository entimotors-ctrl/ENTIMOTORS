-- ENTIMOTORS OS 3.15.0 · BLOQUE 3 · MENSAJES ADMIN → MECÁNICO + AVISOS EN TIEMPO REAL · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere la cadena SYNC 1..10 + sync-15a + sync-15b. Idempotente.
-- No toca datos existentes: crea una tabla nueva, funciones, triggers de AVISO y políticas de lectura de canales.
--
-- MENSAJES (comunicación dirigida; NO son notas de la orden)
--  · public.mensajes: remitente (admin), destinatario (UN mecánico activo), texto, creado_en, leido_en, orden_id/cita_id opcionales
--    (relación explícita: nunca se copia texto a la orden ni de la orden). Un solo taller (D-1): el ámbito es el negocio completo.
--  · Solo se escribe por RPC: enviar_mensaje (solo admin; idempotente por p_op y por el id que genera el cliente) y
--    marcar_mensaje_leido (solo el destinatario; idempotente por naturaleza: leido_en se fija una vez). Sin INSERT/UPDATE/DELETE
--    directos (sin GRANT); el contenido es inmutable (trigger), no se borra.
--  · Lectura (RLS): el destinatario si sigue siendo mecánico activo (rol_actual() ya exige activo) o el administrador.
--    Cajero, otro mecánico, usuario desactivado o sin sesión: 0 filas.
--
-- AVISOS EN TIEMPO REAL (Supabase Realtime · Broadcast PRIVADO desde la base)
--  · NO se añade ninguna tabla a la publicación supabase_realtime (postgres_changes queda sin usar): nada de filas viaja por Realtime.
--  · Los triggers mandan con realtime.send(..., private => true) un AVISO mínimo {e: entidad, id: uuid, rev?} — sin nombres,
--    textos, montos ni teléfonos. El cliente, al recibirlo, vuelve a pedir SOLO ese registro por REST, con su token y bajo RLS:
--    si ya no le corresponde (reasignado, cerrado), el servidor no se lo devuelve y el cliente lo retira de su caché.
--  · Temas: «mt:<perfil_id>» (cada mecánico, su canal), «taller» (admin y cajero), «admin» (solo admin: estado de mensajes).
--    Quién puede ESCUCHAR cada tema lo decide RLS sobre realtime.messages (políticas entimotors_rt_*). Ninguna política de
--    INSERT: ningún cliente puede emitir por esos canales; solo la base (SECURITY DEFINER).
--  · realtime.send atrapa sus propios errores (WARNING): un fallo de Realtime JAMÁS aborta la operación de negocio. Si el esquema
--    realtime no existe (base de pruebas sin Realtime), los avisos se omiten.
--  · Deduplicación por transacción (entimotors.rt_enviados): una RPC que toca varias filas de la misma entidad manda un aviso.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('public.sync_fases') IS NULL OR NOT EXISTS (SELECT 1 FROM public.sync_fases WHERE fase = '15b') THEN
    RAISE EXCEPTION 'SYNC-15C STOP: falta sync-15b';
  END IF;
  IF to_regprocedure('public.es_admin()') IS NULL OR to_regprocedure('public.es_mecanico_activo()') IS NULL
     OR to_regprocedure('public.ve_todo_el_taller()') IS NULL OR to_regprocedure('public.sync_sellar()') IS NULL
     OR to_regprocedure('public.sync_op_iniciar(uuid,text,text)') IS NULL OR to_regprocedure('public.sync_auditar(text,text,text,text,uuid,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'SYNC-15C STOP: faltan funciones base (fase4d/SYNC-1/SYNC-3)';
  END IF;
END
$pre$;

-- ═════════════════════════ 1. TABLA ═════════════════════════
CREATE TABLE IF NOT EXISTS public.mensajes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remitente_id uuid REFERENCES public.perfiles (id) ON DELETE SET NULL,
  remitente_nombre text NOT NULL,
  destinatario_id uuid REFERENCES public.perfiles (id) ON DELETE SET NULL,
  texto text NOT NULL CONSTRAINT mensajes_texto_valido CHECK (char_length(btrim(texto)) BETWEEN 1 AND 2000),
  orden_id uuid REFERENCES public.ordenes (id) ON DELETE SET NULL,
  cita_id uuid REFERENCES public.citas (id) ON DELETE SET NULL,
  creado_en timestamptz NOT NULL DEFAULT clock_timestamp(),
  leido_en timestamptz,
  op_id uuid NOT NULL CONSTRAINT mensajes_op_unico UNIQUE,
  dispositivo text,
  -- sello de sincronización (mismo contrato que SYNC-1: lo escribe el servidor)
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rev integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.perfiles (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.perfiles (id) ON DELETE SET NULL,
  last_op_id uuid,
  deleted_at timestamptz,   -- nunca se fija en 3.15 (no se borran mensajes); existe para el contrato de descarga
  CONSTRAINT mensajes_leido_despues CHECK (leido_en IS NULL OR leido_en >= creado_en)
);
CREATE INDEX IF NOT EXISTS idx_mensajes_sync ON public.mensajes (updated_at, id);
CREATE INDEX IF NOT EXISTS idx_mensajes_destinatario ON public.mensajes (destinatario_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_mensajes_orden ON public.mensajes (orden_id) WHERE orden_id IS NOT NULL;

ALTER TABLE public.mensajes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mensajes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mensajes TO authenticated;
GRANT ALL ON public.mensajes TO service_role;

DROP POLICY IF EXISTS mensajes_lee ON public.mensajes;
CREATE POLICY mensajes_lee ON public.mensajes AS PERMISSIVE FOR SELECT TO authenticated
  USING ((destinatario_id = auth.uid() AND public.es_mecanico_activo()) OR public.es_admin());

-- Contenido inmutable: solo leido_en puede pasar de NULL a una fecha (lo hace marcar_mensaje_leido). Nunca se borra.
CREATE OR REPLACE FUNCTION public.mensajes_inmutable()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Los mensajes no se borran' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.remitente_id, NEW.remitente_nombre, NEW.destinatario_id, NEW.texto, NEW.orden_id, NEW.cita_id, NEW.creado_en, NEW.op_id, NEW.dispositivo, NEW.deleted_at)
     IS DISTINCT FROM (OLD.id, OLD.remitente_id, OLD.remitente_nombre, OLD.destinatario_id, OLD.texto, OLD.orden_id, OLD.cita_id, OLD.creado_en, OLD.op_id, OLD.dispositivo, OLD.deleted_at) THEN
    -- ON DELETE SET NULL de perfiles/ordenes/citas sí puede anular una referencia (el mensaje queda, sin destino)
    IF (NEW.id, NEW.remitente_nombre, NEW.texto, NEW.creado_en, NEW.op_id, NEW.dispositivo, NEW.deleted_at)
         IS DISTINCT FROM (OLD.id, OLD.remitente_nombre, OLD.texto, OLD.creado_en, OLD.op_id, OLD.dispositivo, OLD.deleted_at)
       OR (NEW.remitente_id IS NOT NULL AND NEW.remitente_id IS DISTINCT FROM OLD.remitente_id)
       OR (NEW.destinatario_id IS NOT NULL AND NEW.destinatario_id IS DISTINCT FROM OLD.destinatario_id)
       OR (NEW.orden_id IS NOT NULL AND NEW.orden_id IS DISTINCT FROM OLD.orden_id)
       OR (NEW.cita_id IS NOT NULL AND NEW.cita_id IS DISTINCT FROM OLD.cita_id) THEN
      RAISE EXCEPTION 'El contenido de un mensaje no se modifica' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF OLD.leido_en IS NOT NULL AND NEW.leido_en IS DISTINCT FROM OLD.leido_en THEN
    RAISE EXCEPTION 'La lectura de un mensaje ya quedó registrada' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS mensajes_inmutable ON public.mensajes;
CREATE TRIGGER mensajes_inmutable BEFORE UPDATE OR DELETE ON public.mensajes FOR EACH ROW EXECUTE FUNCTION public.mensajes_inmutable();
-- nombre propio (no zz_sync_sello): la poscondición de SYNC-1 cuenta exactamente 12 tablas con ese trigger
DROP TRIGGER IF EXISTS zz_mensajes_sello ON public.mensajes;
CREATE TRIGGER zz_mensajes_sello BEFORE INSERT OR UPDATE ON public.mensajes FOR EACH ROW EXECUTE FUNCTION public.sync_sellar();

-- ═════════════════════════ 2. AVISOS (Realtime Broadcast privado) ═════════════════════════
-- Único punto que llama a realtime.send. SECURITY DEFINER (dueño postgres, BYPASSRLS en Supabase): el usuario que dispara el
-- trigger no necesita ni debe tener permiso de escribir en realtime.messages. Nunca lanza.
CREATE OR REPLACE FUNCTION public.sync_rt_aviso(p_topic text, p_payload jsonb)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_clave text; v_prev text;
BEGIN
  IF p_topic IS NULL OR to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL THEN RETURN; END IF;
  v_clave := p_topic || '|' || COALESCE(p_payload->>'e', '') || '|' || COALESCE(p_payload->>'id', '');
  v_prev := COALESCE(current_setting('entimotors.rt_enviados', true), '');
  IF position(('«' || v_clave || '»') IN v_prev) > 0 THEN RETURN; END IF;       -- ya avisado en esta transacción
  PERFORM set_config('entimotors.rt_enviados', right(v_prev || '«' || v_clave || '»', 8000), true);
  EXECUTE 'SELECT realtime.send($1, $2, $3, true)' USING p_payload || jsonb_build_object('v', 1), 'cambio', p_topic;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ENTIMOTORS aviso realtime omitido: %', SQLERRM;
END
$function$;

-- Órdenes → el mecánico asignado (y el anterior, si cambió). Solo cuando cambia algo que Mi Trabajo muestra.
CREATE OR REPLACE FUNCTION public.sync_rt_ordenes()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_aviso jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.estado, NEW.falla, NEW.diagnostico, NEW.reparacion_notas, NEW.calidad_checklist, NEW.fotos, NEW.km_salida,
        NEW.garantia_dias, NEW.mecanico, NEW.mecanico_id, NEW.finalizada, NEW.finalizado_en, NEW.entregado_en, NEW.origen_trabajo,
        NEW.cliente_id, NEW.moto_id, NEW.deleted_at)
     IS NOT DISTINCT FROM (OLD.estado, OLD.falla, OLD.diagnostico, OLD.reparacion_notas, OLD.calidad_checklist, OLD.fotos, OLD.km_salida,
        OLD.garantia_dias, OLD.mecanico, OLD.mecanico_id, OLD.finalizada, OLD.finalizado_en, OLD.entregado_en, OLD.origen_trabajo,
        OLD.cliente_id, OLD.moto_id, OLD.deleted_at) THEN
    RETURN NULL;
  END IF;
  v_aviso := jsonb_build_object('e', 'ordenes', 'id', NEW.id, 'rev', NEW.rev);
  IF NEW.mecanico_id IS NOT NULL THEN PERFORM public.sync_rt_aviso('mt:' || NEW.mecanico_id::text, v_aviso); END IF;
  IF TG_OP = 'UPDATE' AND OLD.mecanico_id IS NOT NULL AND OLD.mecanico_id IS DISTINCT FROM NEW.mecanico_id THEN
    PERFORM public.sync_rt_aviso('mt:' || OLD.mecanico_id::text, v_aviso);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ENTIMOTORS aviso realtime (ordenes) omitido: %', SQLERRM;
  RETURN NULL;
END
$function$;

-- Renglones de una orden → su mecánico (Mi Trabajo muestra nombre y cantidad). La revisión de la orden no cambia: el cliente
-- vuelve a pedir la orden forzando la aplicación (sync-engine.js, pullUno).
CREATE OR REPLACE FUNCTION public.sync_rt_orden_items()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_orden uuid; v_mec uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.nombre, NEW.cantidad, NEW.orden_id) IS NOT DISTINCT FROM (OLD.nombre, OLD.cantidad, OLD.orden_id) THEN RETURN NULL; END IF;
  v_orden := CASE WHEN TG_OP = 'DELETE' THEN OLD.orden_id ELSE NEW.orden_id END;
  SELECT o.mecanico_id INTO v_mec FROM public.ordenes o WHERE o.id = v_orden;
  IF v_mec IS NOT NULL THEN PERFORM public.sync_rt_aviso('mt:' || v_mec::text, jsonb_build_object('e', 'ordenes', 'id', v_orden)); END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ENTIMOTORS aviso realtime (orden_items) omitido: %', SQLERRM;
  RETURN NULL;
END
$function$;

-- Citas → el mecánico asignado (y el anterior).
CREATE OR REPLACE FUNCTION public.sync_rt_citas()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_aviso jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.fecha, NEW.hora, NEW.motivo, NEW.estado, NEW.mecanico, NEW.mecanico_id, NEW.cliente_id, NEW.nombre_tmp,
        NEW.telefono_tmp, NEW.orden_id, NEW.confirmada, NEW.deleted_at)
     IS NOT DISTINCT FROM (OLD.fecha, OLD.hora, OLD.motivo, OLD.estado, OLD.mecanico, OLD.mecanico_id, OLD.cliente_id, OLD.nombre_tmp,
        OLD.telefono_tmp, OLD.orden_id, OLD.confirmada, OLD.deleted_at) THEN
    RETURN NULL;
  END IF;
  v_aviso := jsonb_build_object('e', 'citas', 'id', NEW.id, 'rev', NEW.rev);
  IF NEW.mecanico_id IS NOT NULL THEN PERFORM public.sync_rt_aviso('mt:' || NEW.mecanico_id::text, v_aviso); END IF;
  IF TG_OP = 'UPDATE' AND OLD.mecanico_id IS NOT NULL AND OLD.mecanico_id IS DISTINCT FROM NEW.mecanico_id THEN
    PERFORM public.sync_rt_aviso('mt:' || OLD.mecanico_id::text, v_aviso);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ENTIMOTORS aviso realtime (citas) omitido: %', SQLERRM;
  RETURN NULL;
END
$function$;

-- Mensajes → el destinatario (nuevo, y leído: sus OTROS dispositivos bajan el contador) y el administrador (nuevo / leído).
CREATE OR REPLACE FUNCTION public.sync_rt_mensajes()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_aviso jsonb;
BEGIN
  v_aviso := jsonb_build_object('e', 'mensajes', 'id', NEW.id, 'rev', NEW.rev);
  IF NEW.destinatario_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.leido_en IS DISTINCT FROM OLD.leido_en) THEN
    PERFORM public.sync_rt_aviso('mt:' || NEW.destinatario_id::text, v_aviso);
  END IF;
  IF TG_OP = 'INSERT' OR NEW.leido_en IS DISTINCT FROM OLD.leido_en THEN PERFORM public.sync_rt_aviso('admin', v_aviso); END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ENTIMOTORS aviso realtime (mensajes) omitido: %', SQLERRM;
  RETURN NULL;
END
$function$;

-- Taller (admin/cajero): «la tabla X cambió» UNA vez por sentencia (sin ids, sin datos). El Taller baja lo nuevo de esa entidad
-- con su cursor incremental (lo mismo que hacía cada 30 s, ahora solo cuando hay algo).
CREATE OR REPLACE FUNCTION public.sync_rt_taller()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  -- 3.15 · B8: aviso de TABLA ('todo'), no de un registro. 'id' va PRESENTE y nulo a propósito: realtime.send le pone un uuid ALEATORIO
  -- a todo payload sin clave 'id' (así viene en producción), y el cliente lo tomaba por el id de un registro → pedía uno que no existe
  -- y el Taller no se enteraba de nada en vivo.
  PERFORM public.sync_rt_aviso('taller', jsonb_build_object('e', TG_TABLE_NAME, 'todo', true, 'id', NULL));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ENTIMOTORS aviso realtime (taller) omitido: %', SQLERRM;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS zz_rt_mecanico ON public.ordenes;
CREATE TRIGGER zz_rt_mecanico AFTER INSERT OR UPDATE ON public.ordenes FOR EACH ROW EXECUTE FUNCTION public.sync_rt_ordenes();
DROP TRIGGER IF EXISTS zz_rt_mecanico ON public.orden_items;
CREATE TRIGGER zz_rt_mecanico AFTER INSERT OR UPDATE OR DELETE ON public.orden_items FOR EACH ROW EXECUTE FUNCTION public.sync_rt_orden_items();
DROP TRIGGER IF EXISTS zz_rt_mecanico ON public.citas;
CREATE TRIGGER zz_rt_mecanico AFTER INSERT OR UPDATE ON public.citas FOR EACH ROW EXECUTE FUNCTION public.sync_rt_citas();
DROP TRIGGER IF EXISTS zz_rt_mensajes ON public.mensajes;
CREATE TRIGGER zz_rt_mensajes AFTER INSERT OR UPDATE ON public.mensajes FOR EACH ROW EXECUTE FUNCTION public.sync_rt_mensajes();

DO $taller$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','categorias_inv','inventario','cotizaciones','cotizacion_items','ordenes','orden_items',
                           'ventas','creditos','abonos','caja_movimientos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zz_rt_taller ON public.%I', t);
    EXECUTE format('CREATE TRIGGER zz_rt_taller AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.sync_rt_taller()', t);
  END LOOP;
END
$taller$;

-- ═════════════════════════ 3. LECTURA DE MI TRABAJO: CITAS ═════════════════════════
-- Mismo patrón que ordenes_tecnico_mias (SYNC-6): el mecánico no tiene acceso directo a citas/clientes (SYNC-2). Solo sus citas
-- ABIERTAS que todavía no son una orden: al atenderla (se crea la orden) la cita sale de aquí y el trabajo sigue en la orden — el
-- mecánico nunca ve dos trabajos para el mismo flujo.
CREATE OR REPLACE FUNCTION public.citas_tecnico_mias()
 RETURNS TABLE (id uuid, fecha date, hora text, motivo text, estado text, mecanico text, mecanico_id uuid, confirmada boolean,
   cliente_nombre text, cliente_telefono text, updated_at timestamptz, rev integer, deleted_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT c.id, c.fecha, c.hora, c.motivo, c.estado, c.mecanico, c.mecanico_id, c.confirmada,
         COALESCE(cl.nombre, NULLIF(c.nombre_tmp, '')), COALESCE(cl.telefono, NULLIF(c.telefono_tmp, '')),
         c.updated_at, c.rev, c.deleted_at
    FROM public.citas c
    LEFT JOIN public.clientes cl ON cl.id = c.cliente_id
   WHERE public.es_mecanico_activo() AND c.mecanico_id = auth.uid() AND c.deleted_at IS NULL AND c.orden_id IS NULL
     AND COALESCE(c.estado, '') NOT IN ('atendida', 'ausente', 'cancelada')
$function$;

-- ═════════════════════════ 4. RPC DE MENSAJES ═════════════════════════
CREATE OR REPLACE FUNCTION public.enviar_mensaje(p_op uuid, p_mensaje_id uuid, p_destinatario uuid, p_texto text,
    p_orden_id uuid DEFAULT NULL, p_cita_id uuid DEFAULT NULL, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev jsonb; v_hash text; v_texto text; v_rem text; v_dest text; v_id uuid; v_en timestamptz; v_res jsonb;
BEGIN
  IF NOT public.es_admin() THEN
    RAISE EXCEPTION 'Solo el administrador envía mensajes a los trabajadores' USING ERRCODE = '42501';
  END IF;
  v_texto := btrim(COALESCE(p_texto, ''));
  IF char_length(v_texto) = 0 THEN RAISE EXCEPTION 'El mensaje está vacío' USING ERRCODE = '22023'; END IF;
  IF char_length(v_texto) > 2000 THEN RAISE EXCEPTION 'El mensaje es demasiado largo (máximo 2000 caracteres)' USING ERRCODE = '22023'; END IF;
  IF p_mensaje_id IS NULL THEN RAISE EXCEPTION 'Falta el identificador del mensaje' USING ERRCODE = '22023'; END IF;

  v_hash := md5(jsonb_build_array(p_mensaje_id, p_destinatario, v_texto, p_orden_id, p_cita_id)::text);
  v_prev := public.sync_op_iniciar(p_op, 'enviar_mensaje', v_hash);
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repetida', true); END IF;

  SELECT p.nombre INTO v_dest FROM public.perfiles p WHERE p.id = p_destinatario AND p.rol = 'mecanico' AND p.activo;
  IF NOT FOUND THEN RAISE EXCEPTION 'El destinatario no es un mecánico activo' USING ERRCODE = '23503'; END IF;
  IF p_orden_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ordenes o WHERE o.id = p_orden_id AND o.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'La orden relacionada no existe' USING ERRCODE = '23503';
  END IF;
  IF p_cita_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.citas c WHERE c.id = p_cita_id AND c.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'La cita relacionada no existe' USING ERRCODE = '23503';
  END IF;
  SELECT p.nombre INTO v_rem FROM public.perfiles p WHERE p.id = auth.uid();

  INSERT INTO public.mensajes (id, remitente_id, remitente_nombre, destinatario_id, texto, orden_id, cita_id, op_id, dispositivo, last_op_id)
  VALUES (p_mensaje_id, auth.uid(), COALESCE(v_rem, 'Administrador'), p_destinatario, v_texto, p_orden_id, p_cita_id, p_op, p_device, p_op)
  RETURNING id, creado_en INTO v_id, v_en;

  PERFORM public.sync_auditar('mensaje-enviar', 'mensajes', v_id::text, 'Mensaje a ' || v_dest || CASE WHEN p_orden_id IS NOT NULL THEN ' (orden relacionada)' ELSE '' END,
                              p_op, p_device, NULL, 'ok');
  v_res := jsonb_build_object('id', v_id, 'creado_en', v_en);
  RETURN public.sync_op_guardar(p_op, 'enviar_mensaje', v_hash, p_device, v_res);
END
$function$;

CREATE OR REPLACE FUNCTION public.marcar_mensaje_leido(p_op uuid, p_mensaje_id uuid, p_device text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE m record;
BEGIN
  IF NOT public.es_mecanico_activo() THEN
    RAISE EXCEPTION 'Solo el mecánico destinatario marca un mensaje como leído' USING ERRCODE = '42501';
  END IF;
  SELECT x.id, x.destinatario_id, x.leido_en INTO m FROM public.mensajes x WHERE x.id = p_mensaje_id FOR UPDATE;
  -- mismo error para «no existe» y «no es tuyo»: no se revela si existe un mensaje de otra persona
  IF NOT FOUND OR m.destinatario_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Ese mensaje no está disponible' USING ERRCODE = '42501';
  END IF;
  IF m.leido_en IS NULL THEN
    UPDATE public.mensajes SET leido_en = clock_timestamp(), last_op_id = p_op WHERE id = p_mensaje_id RETURNING leido_en INTO m.leido_en;
  END IF;
  RETURN jsonb_build_object('id', p_mensaje_id, 'leido_en', m.leido_en);
END
$function$;

-- ═════════════════════════ 5. QUIÉN ESCUCHA CADA CANAL (RLS de realtime.messages) ═════════════════════════
DO $rt$
BEGIN
  IF to_regclass('realtime.messages') IS NULL OR to_regprocedure('realtime.topic()') IS NULL THEN
    RAISE NOTICE 'SYNC-15C: esta base no tiene Realtime (realtime.messages): políticas de canal omitidas';
    RETURN;
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS entimotors_rt_mecanico ON realtime.messages';
  EXECUTE $p$CREATE POLICY entimotors_rt_mecanico ON realtime.messages AS PERMISSIVE FOR SELECT TO authenticated
    USING (realtime.messages.extension = 'broadcast' AND realtime.topic() = 'mt:' || auth.uid()::text AND public.es_mecanico_activo())$p$;
  EXECUTE 'DROP POLICY IF EXISTS entimotors_rt_taller ON realtime.messages';
  EXECUTE $p$CREATE POLICY entimotors_rt_taller ON realtime.messages AS PERMISSIVE FOR SELECT TO authenticated
    USING (realtime.messages.extension = 'broadcast' AND realtime.topic() = 'taller' AND public.ve_todo_el_taller())$p$;
  EXECUTE 'DROP POLICY IF EXISTS entimotors_rt_admin ON realtime.messages';
  EXECUTE $p$CREATE POLICY entimotors_rt_admin ON realtime.messages AS PERMISSIVE FOR SELECT TO authenticated
    USING (realtime.messages.extension = 'broadcast' AND realtime.topic() = 'admin' AND public.es_admin())$p$;
END
$rt$;

-- ═════════════════════════ ACL (literales, uno por función) ═════════════════════════
REVOKE EXECUTE ON FUNCTION public.mensajes_inmutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mensajes_inmutable() TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_rt_aviso(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_rt_aviso(text,jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_rt_ordenes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_rt_ordenes() TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_rt_orden_items() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_rt_orden_items() TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_rt_citas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_rt_citas() TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_rt_mensajes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_rt_mensajes() TO service_role;
REVOKE EXECUTE ON FUNCTION public.sync_rt_taller() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_rt_taller() TO service_role;
REVOKE EXECUTE ON FUNCTION public.citas_tecnico_mias() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.citas_tecnico_mias() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.enviar_mensaje(uuid,uuid,uuid,text,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enviar_mensaje(uuid,uuid,uuid,text,uuid,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.marcar_mensaje_leido(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_mensaje_leido(uuid,uuid,text) TO authenticated, service_role;

INSERT INTO public.sync_fases (fase) VALUES ('15c') ON CONFLICT (fase) DO NOTHING;

DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('mensajes_inmutable','sync_rt_aviso','sync_rt_ordenes','sync_rt_orden_items','sync_rt_citas','sync_rt_mensajes','sync_rt_taller',
                       'citas_tecnico_mias','enviar_mensaje','marcar_mensaje_leido')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF n <> 0 THEN RAISE EXCEPTION 'SYNC-15C STOP: % funciones ejecutables por anon', n; END IF;
  SELECT count(*) INTO n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('sync_rt_aviso','sync_rt_ordenes','sync_rt_orden_items','sync_rt_citas','sync_rt_mensajes','sync_rt_taller','mensajes_inmutable')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF n <> 0 THEN RAISE EXCEPTION 'SYNC-15C STOP: % funciones internas ejecutables por authenticated', n; END IF;
  IF has_table_privilege('authenticated', 'public.mensajes', 'INSERT') OR has_table_privilege('authenticated', 'public.mensajes', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.mensajes', 'DELETE') OR has_table_privilege('anon', 'public.mensajes', 'SELECT') THEN
    RAISE EXCEPTION 'SYNC-15C STOP: mensajes admite escritura directa o lectura anónima';
  END IF;
  -- ninguna tabla de negocio en la publicación de Realtime (nada de filas viaja por postgres_changes)
  SELECT count(*) INTO n FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public';
  IF n <> 0 THEN RAISE EXCEPTION 'SYNC-15C STOP: % tablas de public en la publicación supabase_realtime', n; END IF;
  IF to_regclass('realtime.messages') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages'
       AND policyname LIKE 'entimotors_rt_%' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'SYNC-15C STOP: política de canal que no es de solo lectura';
  END IF;
  RAISE NOTICE 'SYNC-15C: mensajes + avisos en tiempo real listos.';
END
$post$;
COMMIT;
