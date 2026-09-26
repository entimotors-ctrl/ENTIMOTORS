-- SECURITY-1C · límite de intentos del cambio de contraseña del admin. Requiere la cadena SYNC + sec-1c. Solo copias locales.
-- Usuarios del preludio: 1 admin · 2 cajero · 3 mecánico · 5 desarrollador · 6 mecánico INACTIVO. Política de prueba: 5 / 15 min / 15 min, TTL 60 s.
CREATE FUNCTION pg_temp.envejecer(p_min int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN   -- solo pruebas: la tabla es de solo agregar, así que se suspenden sus triggers un instante para mover el reloj hacia atrás
  SET LOCAL session_replication_role = replica;
  UPDATE public.admin_clave_intentos SET creado_en = creado_en - make_interval(mins => p_min);
  SET LOCAL session_replication_role = origin;
END $$;
CREATE FUNCTION pg_temp.res(p uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.clave_reservar_intento(p, 5, 15, 15, 60) $$;
CREATE FUNCTION pg_temp.fin_(p uuid, i bigint, r text) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.clave_resolver_intento(p, i, r, 5, 15, 15) $$;
CREATE FUNCTION pg_temp.n(r text) RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM public.admin_clave_intentos WHERE resultado = r $$;

-- ── esquema y ausencia de secretos ──
DO $$
BEGIN
  PERFORM pg_temp.t('columnas EXACTAS: id, perfil_id, resultado, intento_id, creado_en (nada más)',
    (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_clave_intentos')
      = ARRAY['id', 'perfil_id', 'resultado', 'intento_id', 'creado_en']);
  PERFORM pg_temp.t('ninguna columna sensible (clave/password/hash/token/pin/correo/email/ip)',
    NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_clave_intentos'
                AND column_name ~* '(clave|pass|hash|token|pin|correo|mail|ip|device|agente|user_agent)'));
  PERFORM pg_temp.t('las funciones no reciben ningún parámetro de contraseña/token',
    NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proargnames) a WHERE p.proname IN ('clave_reservar_intento', 'clave_resolver_intento') AND a ~* '(clave|pass|hash|token|pin|correo|mail|ip)'));
  PERFORM pg_temp.t('las funciones son SECURITY DEFINER con search_path fijo',
    (SELECT bool_and(prosecdef AND proconfig @> ARRAY['search_path=public']) FROM pg_proc WHERE proname IN ('clave_reservar_intento', 'clave_resolver_intento')));
END $$;

-- ── solo un administrador activo tiene contador ──
DO $$
DECLARE r jsonb; p uuid;
BEGIN
  FOREACH p IN ARRAY ARRAY[pg_temp.uid(2), pg_temp.uid(3), pg_temp.uid(5), pg_temp.uid(6), '00000000-0000-4000-8000-00000000abcd'::uuid] LOOP
    r := pg_temp.res(p);
    PERFORM pg_temp.t('perfil no admin / inactivo / inexistente ' || p || ' → no_admin', r = '{"permitido": false, "motivo": "no_admin"}'::jsonb);
  END LOOP;
  PERFORM pg_temp.t('…y no deja NINGUNA fila (cajero/mecánico no pueden gastar ni bloquear el contador del admin)', (SELECT count(*) FROM public.admin_clave_intentos) = 0);
END $$;
SELECT pg_temp.falla('parámetros fuera de rango se rechazan (max 0)', $q$SELECT public.clave_reservar_intento(pg_temp.uid(1), 0, 15, 15, 60)$q$, 'fuera de rango');
SELECT pg_temp.falla('parámetros fuera de rango se rechazan (ttl 5 s)', $q$SELECT public.clave_reservar_intento(pg_temp.uid(1), 5, 15, 15, 5)$q$, 'fuera de rango');
SELECT pg_temp.falla('parámetros nulos se rechazan', $q$SELECT public.clave_reservar_intento(NULL, 5, 15, 15, 60)$q$, 'fuera de rango');
SELECT pg_temp.falla('resultado inválido al resolver se rechaza', $q$SELECT public.clave_resolver_intento(pg_temp.uid(1), 1, 'quizas', 5, 15, 15)$q$, 'fuera de rango');

-- ── ciclo: reservado → en curso → fallido ×5 → bloqueo → expira → éxito/reset ──
DO $$
DECLARE r jsonb; f jsonb; i int; id1 bigint;
BEGIN
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('primer intento PERMITIDO (reservado, quedan 4)', (r->>'permitido')::boolean AND (r->>'intentos_restantes')::int = 4 AND (r->>'intento_id') IS NOT NULL);
  id1 := (r->>'intento_id')::bigint;
  f := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('reserva sin resolver = cambio EN CURSO: la 2.ª simultánea se rechaza, con tiempo restante 1..60 s y sin fila nueva',
    f->>'motivo' = 'en_curso' AND NOT (f->>'permitido')::boolean AND (f->>'reintentar_en_s')::int BETWEEN 1 AND 60 AND pg_temp.n('reservado') = 1);
  f := pg_temp.fin_(pg_temp.uid(1), id1, 'fallido');
  PERFORM pg_temp.t('1.er fallo: quedan 4, sin bloqueo', f = '{"resultado": "fallido", "bloqueado": false, "intentos_restantes": 4}'::jsonb);
  FOR i IN 2..4 LOOP
    r := pg_temp.res(pg_temp.uid(1));
    PERFORM pg_temp.t('intento ' || i || ' permitido (quedan ' || (5 - i) || ')', (r->>'permitido')::boolean AND (r->>'intentos_restantes')::int = 5 - i);
    f := pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'fallido');
    PERFORM pg_temp.t('fallo ' || i || ': quedan ' || (5 - i), NOT (f->>'bloqueado')::boolean AND (f->>'intentos_restantes')::int = 5 - i);
  END LOOP;
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('5.º intento todavía permitido (quedan 0)', (r->>'permitido')::boolean AND (r->>'intentos_restantes')::int = 0);
  f := pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'fallido');
  PERFORM pg_temp.t('5.º FALLO → bloqueo que empieza YA: 15 min (900 s)', f = '{"resultado": "fallido", "bloqueado": true, "intentos_restantes": 0, "reintentar_en_s": 900}'::jsonb);
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('el siguiente intento está BLOQUEADO y el tiempo restante es calculable (890–900 s) para Retry-After',
    r->>'motivo' = 'bloqueado' AND NOT (r->>'permitido')::boolean AND (r->>'reintentar_en_s')::int BETWEEN 890 AND 900);
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('insistir mientras dura el bloqueo no agrega filas (un solo evento de bloqueo, 5 reservas)', r->>'motivo' = 'bloqueado' AND pg_temp.n('bloqueado') = 1 AND pg_temp.n('reservado') = 5);
  PERFORM pg_temp.envejecer(10);
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('a los 10 min sigue bloqueado (~300 s restantes)', r->>'motivo' = 'bloqueado' AND (r->>'reintentar_en_s')::int BETWEEN 290 AND 300);
  PERFORM pg_temp.envejecer(6);
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('al VENCER el bloqueo la cuenta arranca de cero (quedan 4)', (r->>'permitido')::boolean AND (r->>'intentos_restantes')::int = 4);
  f := pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'ok');
  PERFORM pg_temp.t('ÉXITO: la cuenta vuelve a 5', f = '{"resultado": "ok", "bloqueado": false, "intentos_restantes": 5}'::jsonb);
  PERFORM pg_temp.t('el éxito NO borra evidencia: 6 reservas, 5 fallidos, 1 bloqueo, 1 ok siguen ahí', pg_temp.n('reservado') = 6 AND pg_temp.n('fallido') = 5 AND pg_temp.n('bloqueado') = 1 AND pg_temp.n('ok') = 1);
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('tras el éxito, el siguiente intento empieza con la cuenta en cero (quedan 4)', (r->>'intentos_restantes')::int = 4);
  PERFORM pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'ok');
END $$;

-- ── la ventana expira; una reserva abandonada cuenta como fallo y libera el «en curso» al vencer su TTL ──
DO $$
DECLARE r jsonb; i int;
BEGIN
  FOR i IN 1..3 LOOP r := pg_temp.res(pg_temp.uid(1)); PERFORM pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'fallido'); END LOOP;
  r := pg_temp.res(pg_temp.uid(1)); PERFORM pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'fallido');
  PERFORM pg_temp.envejecer(16);
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('los fallos de hace más de 15 min ya no cuentan (VENTANA vencida: quedan 4)', (r->>'intentos_restantes')::int = 4);
  -- la reserva anterior queda SIN resolver (backend caído): mientras dura su TTL bloquea; al vencer, cuenta como intento
  PERFORM pg_temp.envejecer(2);
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('reserva abandonada: vencido su TTL deja de estar «en curso» y CUENTA como intento (quedan 3)', (r->>'permitido')::boolean AND (r->>'intentos_restantes')::int = 3);
  PERFORM pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'ok');
END $$;
DO $$
DECLARE r jsonb; i int;
BEGIN
  FOR i IN 1..5 LOOP r := pg_temp.res(pg_temp.uid(1)); PERFORM pg_temp.envejecer(2); END LOOP;   -- 5 reservas abandonadas seguidas
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('5 reservas abandonadas → el siguiente intento se BLOQUEA (falla cerrado aunque nadie resuelva)', r->>'motivo' = 'bloqueado' AND (r->>'reintentar_en_s')::int = 900);
  PERFORM pg_temp.envejecer(16);
END $$;

-- ── resolver: solo reservas propias, sin resolver ──
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.falla('resolver un intento que no existe', 'SELECT public.clave_resolver_intento(''' || pg_temp.uid(1) || ''', 999999, ''ok'', 5, 15, 15)', 'no existe');
  PERFORM pg_temp.falla('resolver el intento de OTRO perfil', 'SELECT public.clave_resolver_intento(''' || pg_temp.uid(2) || ''', ' || (r->>'intento_id') || ', ''ok'', 5, 15, 15)', 'no existe');
  PERFORM pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'ok');
  PERFORM pg_temp.falla('resolver DOS veces la misma reserva', 'SELECT public.clave_resolver_intento(''' || pg_temp.uid(1) || ''', ' || (r->>'intento_id') || ', ''fallido'', 5, 15, 15)', 'ya se resolvió');
  PERFORM pg_temp.falla('resolver una fila que no es una reserva (un «ok»)', 'SELECT public.clave_resolver_intento(''' || pg_temp.uid(1) || ''', ' || (SELECT max(id) FROM public.admin_clave_intentos WHERE resultado = 'ok') || ', ''ok'', 5, 15, 15)', 'no existe');
END $$;

-- ── ENMIENDA · «anulado»: el proveedor no respondió de forma concluyente ──
DO $$
DECLARE r jsonb; f jsonb; i int; v_ab bigint;
BEGIN
  PERFORM pg_temp.envejecer(20);
  r := pg_temp.res(pg_temp.uid(1));
  f := pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'anulado');
  PERFORM pg_temp.t('anulado: respuesta estable y NO consume intento (quedan 5)', f = '{"resultado": "anulado", "bloqueado": false, "intentos_restantes": 5}'::jsonb);
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('tras un anulado el siguiente intento se permite al instante (no queda «en curso») y sigue quedando 4', (r->>'permitido')::boolean AND (r->>'intentos_restantes')::int = 4);
  PERFORM pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'fallido');
  FOR i IN 2..4 LOOP r := pg_temp.res(pg_temp.uid(1)); PERFORM pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'fallido'); END LOOP;
  r := pg_temp.res(pg_temp.uid(1));
  f := pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'anulado');
  PERFORM pg_temp.t('anulado NO reinicia la cuenta: con 4 fallos sigue quedando 1 (no 5)', f = '{"resultado": "anulado", "bloqueado": false, "intentos_restantes": 1}'::jsonb);
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('…y el 5.º intento real sigue siendo el último (quedan 0)', (r->>'permitido')::boolean AND (r->>'intentos_restantes')::int = 0);
  f := pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'fallido');
  PERFORM pg_temp.t('el 5.º FALLO real bloquea aunque hubo anulados en medio', (f->>'bloqueado')::boolean);
  PERFORM pg_temp.t('mientras dura el bloqueo no se puede reservar (ni, por tanto, anular nada nuevo)', pg_temp.res(pg_temp.uid(1))->>'motivo' = 'bloqueado');
  -- una reserva ABANDONADA (TTL vencido) NO se convierte sola en anulada: sigue contando
  PERFORM pg_temp.envejecer(20);
  FOR i IN 1..5 LOOP r := pg_temp.res(pg_temp.uid(1)); PERFORM pg_temp.envejecer(2); END LOOP;
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('5 reservas abandonadas siguen bloqueando (el vencimiento NO equivale a anulado)', r->>'motivo' = 'bloqueado');
  SELECT max(id) INTO v_ab FROM public.admin_clave_intentos x WHERE x.resultado = 'reservado' AND NOT EXISTS (SELECT 1 FROM public.admin_clave_intentos y WHERE y.intento_id = x.id);
  f := pg_temp.fin_(pg_temp.uid(1), v_ab, 'anulado');
  r := pg_temp.res(pg_temp.uid(1));
  PERFORM pg_temp.t('anular una reserva DESPUÉS del bloqueo NO lo levanta (sigue bloqueado, ~900 s)', r->>'motivo' = 'bloqueado' AND (r->>'reintentar_en_s')::int BETWEEN 880 AND 900 AND (f->>'bloqueado')::boolean);
  -- una reserva resuelta no cambia nunca de resultado
  PERFORM pg_temp.envejecer(20);
  r := pg_temp.res(pg_temp.uid(1)); PERFORM pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'anulado');
  PERFORM pg_temp.falla('anulado → ok: prohibido', format('SELECT public.clave_resolver_intento(%L, %s, %L, 5, 15, 15)', pg_temp.uid(1), r->>'intento_id', 'ok'), 'ya se resolvió');
  r := pg_temp.res(pg_temp.uid(1)); PERFORM pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'ok');
  PERFORM pg_temp.falla('ok → anulado: prohibido', format('SELECT public.clave_resolver_intento(%L, %s, %L, 5, 15, 15)', pg_temp.uid(1), r->>'intento_id', 'anulado'), 'ya se resolvió');
  r := pg_temp.res(pg_temp.uid(1)); PERFORM pg_temp.fin_(pg_temp.uid(1), (r->>'intento_id')::bigint, 'fallido');
  PERFORM pg_temp.falla('fallido → anulado: prohibido', format('SELECT public.clave_resolver_intento(%L, %s, %L, 5, 15, 15)', pg_temp.uid(1), r->>'intento_id', 'anulado'), 'ya se resolvió');
  PERFORM pg_temp.t('queda EVIDENCIA de cada anulado (4 filas «anulado», cada una enlazada a su reserva)', pg_temp.n('anulado') = 4 AND NOT EXISTS (SELECT 1 FROM public.admin_clave_intentos WHERE resultado = 'anulado' AND intento_id IS NULL));
  PERFORM pg_temp.falla('CHECK: un «anulado» sin reserva no se puede insertar', format('INSERT INTO public.admin_clave_intentos (perfil_id, resultado) VALUES (%L, %L)', pg_temp.uid(1), 'anulado'), 'check');
  PERFORM pg_temp.envejecer(20);
END $$;

-- ── solo agregar ──
SELECT pg_temp.falla('UPDATE prohibido (solo agregar)', $q$UPDATE public.admin_clave_intentos SET resultado = 'ok'$q$);
SELECT pg_temp.falla('DELETE prohibido (solo agregar)', $q$DELETE FROM public.admin_clave_intentos$q$);
SELECT pg_temp.falla('TRUNCATE prohibido', $q$TRUNCATE public.admin_clave_intentos$q$);
SELECT pg_temp.falla('CHECK: un «ok» sin reserva no se puede insertar', $q$INSERT INTO public.admin_clave_intentos (perfil_id, resultado) VALUES (pg_temp.uid(1), 'ok')$q$, 'check');
SELECT pg_temp.falla('CHECK: resultado desconocido', $q$INSERT INTO public.admin_clave_intentos (perfil_id, resultado) VALUES (pg_temp.uid(1), 'otra')$q$, 'check');

-- ── RLS y permisos: cerrado al cliente; service_role solo por las funciones ──
DO $$
BEGIN
  PERFORM pg_temp.t('RLS activo y SIN políticas', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_clave_intentos'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'admin_clave_intentos'));
  PERFORM pg_temp.t('anon: sin SELECT/INSERT/UPDATE/DELETE/TRUNCATE', NOT has_table_privilege('anon', 'public.admin_clave_intentos', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'));
  PERFORM pg_temp.t('authenticated: sin SELECT/INSERT/UPDATE/DELETE/TRUNCATE', NOT has_table_privilege('authenticated', 'public.admin_clave_intentos', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'));
  PERFORM pg_temp.t('anon/authenticated: sin EXECUTE en ninguna de las dos funciones',
    NOT has_function_privilege('anon', 'public.clave_reservar_intento(uuid,integer,integer,integer,integer)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.clave_reservar_intento(uuid,integer,integer,integer,integer)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.clave_resolver_intento(uuid,bigint,text,integer,integer,integer)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.clave_resolver_intento(uuid,bigint,text,integer,integer,integer)', 'EXECUTE'));
  PERFORM pg_temp.t('secuencia cerrada a anon/authenticated', NOT has_sequence_privilege('anon', 'public.admin_clave_intentos_id_seq', 'USAGE,SELECT,UPDATE') AND NOT has_sequence_privilege('authenticated', 'public.admin_clave_intentos_id_seq', 'USAGE,SELECT,UPDATE'));
  PERFORM pg_temp.t('service_role: puede LEER y EJECUTAR, pero no escribir directo',
    has_table_privilege('service_role', 'public.admin_clave_intentos', 'SELECT') AND NOT has_table_privilege('service_role', 'public.admin_clave_intentos', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND has_function_privilege('service_role', 'public.clave_reservar_intento(uuid,integer,integer,integer,integer)', 'EXECUTE'));
END $$;
-- como usuarios reales (roles de PostgREST): el admin autenticado, el cajero y anon NO pueden leer ni llamar
DO $$ BEGIN PERFORM pg_temp.como(1); PERFORM pg_temp.falla('admin AUTENTICADO (authenticated) no lee la tabla', 'SELECT count(*) FROM public.admin_clave_intentos', 'permission denied'); PERFORM pg_temp.fin(); END $$;
DO $$ BEGIN PERFORM pg_temp.como(2); PERFORM pg_temp.falla('cajero no puede reservar (ni gastar el cupo del admin)', 'SELECT public.clave_reservar_intento(''' || pg_temp.uid(1) || ''', 5, 15, 15, 60)', 'permission denied'); PERFORM pg_temp.fin(); END $$;
DO $$ BEGIN PERFORM pg_temp.como(3); PERFORM pg_temp.falla('mecánico no puede resolver', 'SELECT public.clave_resolver_intento(''' || pg_temp.uid(1) || ''', 1, ''ok'', 5, 15, 15)', 'permission denied'); PERFORM pg_temp.fin(); END $$;
DO $$ BEGIN PERFORM pg_temp.como(0); PERFORM pg_temp.falla('anon no puede reservar', 'SELECT public.clave_reservar_intento(''' || pg_temp.uid(1) || ''', 5, 15, 15, 60)', 'permission denied'); PERFORM pg_temp.falla('anon no lee la tabla', 'SELECT 1 FROM public.admin_clave_intentos', 'permission denied'); PERFORM pg_temp.fin(); END $$;
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE service_role;
  r := public.clave_reservar_intento(pg_temp.uid(1), 5, 15, 15, 60);
  PERFORM pg_temp.t('service_role reserva y resuelve por las funciones', (r->>'permitido')::boolean AND (public.clave_resolver_intento(pg_temp.uid(1), (r->>'intento_id')::bigint, 'ok', 5, 15, 15))->>'resultado' = 'ok');
  PERFORM pg_temp.falla('service_role NO inserta directo', $q$INSERT INTO public.admin_clave_intentos (perfil_id, resultado) VALUES ('00000000-0000-4000-8000-000000000001', 'reservado')$q$, 'permission denied');
  RESET ROLE;
END $$;

-- ── no afecta a nada más ──
DO $$
BEGIN
  PERFORM pg_temp.t('el PIN no se toca: admin_pin_intentos sigue vacío', (SELECT count(*) FROM public.admin_pin_intentos) = 0);
  PERFORM pg_temp.t('invariantes del sistema = []', public.verificar_invariantes()::text = '[]');
END $$;
