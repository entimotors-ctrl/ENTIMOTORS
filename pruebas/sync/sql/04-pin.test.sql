-- SYNC-3P · límites del PIN y emisión de autorizaciones. Requiere sync-1, 2, 3 y 3p. Usuarios: 1 admin · 2 cajero · 3 mecánico · 5 desarrollador
-- Envejece todos los intentos N minutos (solo pruebas: la tabla es de solo agregar, así que se suspenden sus triggers un instante)
CREATE FUNCTION pg_temp.envejecer(p_min int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL session_replication_role = replica;
  UPDATE public.admin_pin_intentos SET creado_en = creado_en - make_interval(mins => p_min);
  UPDATE public.admin_pin SET actualizado_en = actualizado_en - make_interval(mins => p_min);   -- todo el reloj retrocede junto
  SET LOCAL session_replication_role = origin;
END $$;
CREATE FUNCTION pg_temp.res(p_sol uuid, p_ms int DEFAULT 5, p_mg int DEFAULT 10) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.pin_reservar_intento(p_sol, 'dev-test', 'ajustar_stock', 'inventario', gen_random_uuid(), p_ms, p_mg, 15, 15, 3) $$;
CREATE FUNCTION pg_temp.reiniciar() RETURNS void LANGUAGE plpgsql AS $$
BEGIN UPDATE public.admin_pin SET bloqueado_hasta = NULL, actualizado_en = clock_timestamp(); END $$;

DO $$
DECLARE r jsonb; i int; n int;
BEGIN
  r := pg_temp.res(pg_temp.uid(2));
  PERFORM pg_temp.t('sin PIN configurado: el intento se rechaza y se registra', r->>'motivo' = 'sin_pin' AND EXISTS (SELECT 1 FROM public.admin_pin_intentos WHERE resultado = 'sin_pin'));
  INSERT INTO public.admin_pin (perfil_id, hash, version, actualizado_en) VALUES (pg_temp.uid(1), 'scrypt$32768$8$1$c2FsdA$aGFzaA', 1, clock_timestamp() - interval '1 hour');

  -- 5 intentos por solicitante; el 6.º ya está bloqueado 15 minutos
  FOR i IN 1..5 LOOP
    r := pg_temp.res(pg_temp.uid(2));
    PERFORM pg_temp.t('solicitante: intento ' || i || ' permitido (quedan ' || (5 - i) || ')', (r->>'permitido')::boolean AND (r->>'intentos_restantes')::int = 5 - i AND r->>'hash' IS NOT NULL);
  END LOOP;
  r := pg_temp.res(pg_temp.uid(2));
  PERFORM pg_temp.t('solicitante: el 6.º intento se BLOQUEA 15 min', NOT (r->>'permitido')::boolean AND r->>'motivo' = 'bloqueado_solicitante' AND (r->>'reintentar_en_s')::int BETWEEN 890 AND 900);
  PERFORM pg_temp.t('un bloqueado no recibe el hash del PIN', r->>'hash' IS NULL);
  r := pg_temp.res(pg_temp.uid(2));
  PERFORM pg_temp.t('sigue bloqueado y no se acumulan eventos', r->>'motivo' = 'bloqueado_solicitante' AND (SELECT count(*) FROM public.admin_pin_intentos WHERE resultado = 'bloqueado_solicitante') = 1 AND (SELECT count(*) FROM public.admin_pin_intentos WHERE resultado = 'reservado') = 5);
  r := pg_temp.res(pg_temp.uid(3));
  PERFORM pg_temp.t('el bloqueo es POR solicitante: otro usuario sigue pudiendo intentar', (r->>'permitido')::boolean);

  -- el bloqueo se levanta a los 15 min y el contador arranca de cero
  PERFORM pg_temp.envejecer(16);
  r := pg_temp.res(pg_temp.uid(2));
  PERFORM pg_temp.t('tras 16 min el solicitante puede intentar de nuevo con el contador en cero', (r->>'permitido')::boolean AND (r->>'intentos_restantes')::int = 4);

  -- un éxito reinicia el contador del solicitante
  PERFORM pg_temp.reiniciar();
  FOR i IN 1..3 LOOP PERFORM pg_temp.res(pg_temp.uid(2)); END LOOP;
  INSERT INTO public.admin_pin_intentos (solicitante_id, resultado) VALUES (pg_temp.uid(2), 'ok');
  r := pg_temp.res(pg_temp.uid(2));
  PERFORM pg_temp.t('un éxito reinicia los fallos: vuelve a tener los 5 intentos', (r->>'permitido')::boolean AND (r->>'intentos_restantes')::int = 4);

  -- configurable: con un límite de 2 el tercer intento se bloquea
  PERFORM pg_temp.reiniciar();
  PERFORM pg_temp.res(pg_temp.uid(2), 2); PERFORM pg_temp.res(pg_temp.uid(2), 2);
  r := pg_temp.res(pg_temp.uid(2), 2);
  PERFORM pg_temp.t('los umbrales son parámetros (límite 2 → bloqueo al tercero)', r->>'motivo' = 'bloqueado_solicitante');
END $$;

-- BLOQUEO GLOBAL: 10 fallos entre cualquiera en la ventana --------------------------------------------------------------
DO $$
DECLARE r jsonb; i int;
BEGIN
  PERFORM pg_temp.reiniciar();
  FOR i IN 1..10 LOOP r := pg_temp.res(gen_random_uuid()); END LOOP;
  PERFORM pg_temp.t('global: 10 intentos de 10 usuarios distintos siguen permitidos individualmente', (r->>'permitido')::boolean);
  r := pg_temp.res(gen_random_uuid());
  PERFORM pg_temp.t('global: el 11.º intento de cualquiera se BLOQUEA 15 min', NOT (r->>'permitido')::boolean AND r->>'motivo' = 'bloqueado_global' AND (r->>'reintentar_en_s')::int = 900);
  r := pg_temp.res(pg_temp.uid(2));
  PERFORM pg_temp.t('global: bloquea también a un usuario que no había fallado', r->>'motivo' = 'bloqueado_global');
  PERFORM pg_temp.envejecer(16);
  r := pg_temp.res(pg_temp.uid(2));
  PERFORM pg_temp.t('global: pasado el bloqueo se puede intentar', (r->>'permitido')::boolean);
END $$;

-- 3 BLOQUEOS EN 24 H → bloqueado hasta que el admin lo desbloquee ---------------------------------------------------------
DO $$
DECLARE r jsonb; i int; v_ver int;
BEGIN
  PERFORM pg_temp.reiniciar();
  FOR k IN 1..3 LOOP
    FOR i IN 1..5 LOOP r := pg_temp.res(pg_temp.uid(2)); END LOOP;
    r := pg_temp.res(pg_temp.uid(2));
    IF k < 3 THEN
      PERFORM pg_temp.t('bloqueo ' || k || ' de 3 (15 min)', r->>'motivo' = 'bloqueado_solicitante');
      PERFORM pg_temp.envejecer(16);
    ELSE
      PERFORM pg_temp.t('el 3.er bloqueo en 24 h deja el PIN bloqueado hasta intervención del admin', r->>'motivo' = 'bloqueado_admin');
    END IF;
  END LOOP;
  PERFORM pg_temp.t('admin_pin.bloqueado_hasta = infinity', (SELECT bloqueado_hasta = 'infinity' FROM public.admin_pin));
  PERFORM pg_temp.envejecer(60);
  r := pg_temp.res(pg_temp.uid(3));
  PERFORM pg_temp.t('bloqueado por el admin: nadie puede intentar, ni pasado el tiempo', r->>'motivo' = 'bloqueado_admin' AND r->>'hash' IS NULL);
  PERFORM pg_temp.reiniciar();
  r := pg_temp.res(pg_temp.uid(2));
  PERFORM pg_temp.t('el desbloqueo del admin restablece los contadores', (r->>'permitido')::boolean AND (r->>'intentos_restantes')::int = 4);
END $$;

-- ADMIN INACTIVO ------------------------------------------------------------------------------------------------------
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL session_replication_role = replica; UPDATE public.perfiles SET activo = false WHERE id = pg_temp.uid(1); SET LOCAL session_replication_role = origin;
  r := pg_temp.res(pg_temp.uid(2));
  PERFORM pg_temp.t('si la cuenta del admin está dada de baja, no se aprueba nada', r->>'motivo' = 'cuenta_inactiva');
  SET LOCAL session_replication_role = replica; UPDATE public.perfiles SET activo = true WHERE id = pg_temp.uid(1); SET LOCAL session_replication_role = origin;
END $$;

-- EMISIÓN DE LA AUTORIZACIÓN --------------------------------------------------------------------------------------------
DO $$
DECLARE r jsonb; reg uuid := pg_temp.id(700); v_seg numeric;
BEGIN
  PERFORM pg_temp.reiniciar();
  r := public.pin_emitir_autorizacion(pg_temp.uid(2), 'cajero', pg_temp.uid(1), 'ajustar_stock', 'inventario', reg, 'dev-test', 1, public.sync_hash_critico('ajustar_stock', reg, 5), 90);
  SELECT extract(epoch FROM (expira_en - clock_timestamp())) INTO v_seg FROM public.autorizaciones_admin WHERE id = (r->>'autorizacion_id')::uuid;
  PERFORM pg_temp.t('la autorización caduca a los 90 s (hora de la base)', v_seg BETWEEN 85 AND 90);
  PERFORM pg_temp.t('queda ligada a solicitante, admin, acción, entidad, registro, dispositivo y versión del PIN',
    (SELECT solicitante_id = pg_temp.uid(2) AND autorizado_por = pg_temp.uid(1) AND accion = 'ajustar_stock' AND entidad = 'inventario' AND registro_id = reg AND device_id = 'dev-test' AND pin_version = 1 AND consumida_en IS NULL
       FROM public.autorizaciones_admin WHERE id = (r->>'autorizacion_id')::uuid));
  PERFORM pg_temp.t('emitirla deja auditoría con solicitante, rol y administrador que autorizó (sin PIN)',
    EXISTS (SELECT 1 FROM public.auditoria WHERE accion = 'autorizacion' AND usuario_id = pg_temp.uid(2) AND rol = 'cajero' AND autorizado_por = pg_temp.uid(1) AND resultado = 'emitida' AND entidad_id = reg::text));
  PERFORM pg_temp.falla('si el PIN cambió de versión no se emite', format('SELECT public.pin_emitir_autorizacion(%L, ''cajero'', %L, ''ajustar_stock'', ''inventario'', %L, ''d'', 2, NULL, 90)', pg_temp.uid(2), pg_temp.uid(1), reg), 'PIN_CAMBIADO');
  PERFORM pg_temp.falla('un TTL absurdo se rechaza', format('SELECT public.pin_emitir_autorizacion(%L, ''cajero'', %L, ''ajustar_stock'', ''inventario'', %L, ''d'', 1, NULL, 100000)', pg_temp.uid(2), pg_temp.uid(1), reg), 'TTL');
  PERFORM pg_temp.falla('una cuenta que no es admin no puede figurar como autorizador', format('SELECT public.pin_emitir_autorizacion(%L, ''cajero'', %L, ''ajustar_stock'', ''inventario'', %L, ''d'', 1, NULL, 90)', pg_temp.uid(2), pg_temp.uid(3), reg), 'PIN_CAMBIADO');
END $$;

-- ACL: solo service_role -------------------------------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('el cajero no puede reservar intentos ni consultar el hash', format('SELECT public.pin_reservar_intento(%L, ''d'', ''a'', ''e'', NULL, 5, 10, 15, 15, 3)', pg_temp.uid(2)), 'permission denied');
  PERFORM pg_temp.falla('el cajero no puede emitir autorizaciones', format('SELECT public.pin_emitir_autorizacion(%L, ''cajero'', %L, ''a'', ''e'', %L, ''d'', 1, NULL, 90)', pg_temp.uid(2), pg_temp.uid(1), pg_temp.id(701)), 'permission denied');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(0);
  PERFORM pg_temp.falla('anon no puede ejecutar el límite de intentos', 'SELECT public.pin_reservar_intento(NULL, ''d'', ''a'', ''e'', NULL, 5, 10, 15, 15, 3)', 'permission denied');
  PERFORM pg_temp.fin();
  PERFORM set_config('role', 'service_role', true);
  PERFORM pg_temp.t('service_role sí puede (es lo que usa el backend)', (public.pin_reservar_intento(pg_temp.uid(2), 'd', 'a', 'e', NULL, 5, 10, 15, 15, 3)->>'permitido') IS NOT NULL);
  PERFORM pg_temp.falla('service_role no puede leer intentos para borrarlos ni editarlos', 'UPDATE public.admin_pin_intentos SET resultado = ''ok''', 'permission denied');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('ningún registro de intentos contiene un PIN (solo motivos y ids)', NOT EXISTS (SELECT 1 FROM public.admin_pin_intentos WHERE resultado !~ '^[a-z_]+$'));
END $$;

-- GUARDAR / DESBLOQUEAR con la hora de la base ------------------------------------------------------------------------
DO $$
DECLARE v int; t0 timestamptz;
BEGIN
  v := public.pin_guardar(pg_temp.uid(1), 'scrypt$32768$8$1$c2FsdA$aGFzaA', pg_temp.uid(1));
  PERFORM pg_temp.t('cambiar el PIN sube la versión (invalida las autorizaciones sin consumir)', v = 2);
  PERFORM pg_temp.t('guardar reinicia los contadores y levanta bloqueos', (SELECT bloqueado_hasta IS NULL AND actualizado_en > clock_timestamp() - interval '5 seconds' FROM public.admin_pin));
  PERFORM pg_temp.falla('solo un admin activo puede tener PIN', format('SELECT public.pin_guardar(%L, ''scrypt$1'', %L)', pg_temp.uid(2), pg_temp.uid(1)), 'Solo un administrador');
  PERFORM pg_temp.falla('un hash que no es scrypt se rechaza (nunca un PIN en claro)', format('SELECT public.pin_guardar(%L, ''123456'', %L)', pg_temp.uid(1), pg_temp.uid(1)), 'Formato de hash');
  UPDATE public.admin_pin SET bloqueado_hasta = 'infinity';
  PERFORM public.pin_desbloquear(pg_temp.uid(1));
  PERFORM pg_temp.t('desbloquear quita el bloqueo y reinicia', (SELECT bloqueado_hasta IS NULL FROM public.admin_pin));
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('el cajero no puede guardar ni desbloquear', format('SELECT public.pin_guardar(%L, ''scrypt$x'', %L)', pg_temp.uid(1), pg_temp.uid(2)), 'permission denied');
  PERFORM pg_temp.falla('el cajero no puede desbloquear', format('SELECT public.pin_desbloquear(%L)', pg_temp.uid(1)), 'permission denied');
  PERFORM pg_temp.fin();
END $$;
