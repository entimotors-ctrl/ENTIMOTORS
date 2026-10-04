-- 3.15.0 · Bloque 3 · mensajes admin → mecánico + avisos en tiempo real (sync-15c). Corre con 00-prelude.sql + 15c-realtime-stub.sql
-- ya aplicados en la copia (usuarios: 1 admin · 2 cajero · 3 mecánico A · 4 mecánico B · 5 desarrollador · 6 mecánico INACTIVO).
\set ON_ERROR_STOP 0

-- como()/su() del prelude valen por TRANSACCIÓN (se usan dentro de DO); aquí cada sentencia es la suya: mismo efecto por SESIÓN.
CREATE FUNCTION pg_temp.ser(n int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', CASE WHEN n = 0 THEN '' ELSE pg_temp.uid(n)::text END, false);
  PERFORM set_config('request.jwt.claim.role', CASE WHEN n = 0 THEN 'anon' ELSE 'authenticated' END, false);
  PERFORM set_config('request.jwt.claims', CASE WHEN n = 0 THEN '{"role":"anon"}' ELSE json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text END, false);
  PERFORM set_config('role', CASE WHEN n = 0 THEN 'anon' ELSE 'authenticated' END, false);
END $$;
CREATE FUNCTION pg_temp.nadie() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', false);
  PERFORM set_config('request.jwt.claims', '', false);
END $$;

-- ── datos base ────────────────────────────────────────────────────────────────
INSERT INTO public.clientes (id, nombre, telefono) VALUES (pg_temp.id(100), 'Cliente Mensajes', '9999-0000');
INSERT INTO public.ordenes (id, cliente_id, estado, falla, reparacion_notas, mecanico, mecanico_id)
  VALUES (pg_temp.id(200), pg_temp.id(100), 'recibido', 'No enciende', 'nota técnica original', 'Usuario 3', pg_temp.uid(3));
INSERT INTO public.citas (id, cliente_id, fecha, hora, motivo, estado, mecanico, mecanico_id)
  VALUES (pg_temp.id(300), pg_temp.id(100), current_date + 1, '10:00', 'Revisión', 'pendiente', 'Usuario 3', pg_temp.uid(3));
DELETE FROM realtime.messages;

-- ── 1. envío: solo el administrador ───────────────────────────────────────────
SELECT pg_temp.ser(1);
SELECT pg_temp.t('A1 admin envía un mensaje a un mecánico activo',
  (public.enviar_mensaje(pg_temp.id(1001), pg_temp.id(501), pg_temp.uid(3), '  Revisa los frenos de la orden  ', pg_temp.id(200)))->>'id' = pg_temp.id(501)::text);
SELECT pg_temp.t('A2 reintento con el MISMO operation_id → «repetida», sin segundo mensaje',
  (public.enviar_mensaje(pg_temp.id(1001), pg_temp.id(501), pg_temp.uid(3), '  Revisa los frenos de la orden  ', pg_temp.id(200)))->>'repetida' = 'true');
SELECT pg_temp.falla('A3 otro operation_id con el mismo id de mensaje → rechazado (no se duplica)',
  $$SELECT public.enviar_mensaje('00000000-0000-4000-9000-000000001002', '00000000-0000-4000-9000-000000000501', '00000000-0000-4000-8000-000000000003', 'otro')$$, 'duplicate|mensajes_pkey');
SELECT pg_temp.falla('A4 el mismo operation_id con OTRO contenido → OP_ID_REUTILIZADO',
  $$SELECT public.enviar_mensaje('00000000-0000-4000-9000-000000001001', '00000000-0000-4000-9000-000000000501', '00000000-0000-4000-8000-000000000003', 'cambiado', '00000000-0000-4000-9000-000000000200')$$, 'OP_ID_REUTILIZADO');
SELECT pg_temp.falla('A5 destinatario cajero → rechazado',
  $$SELECT public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000002', 'hola')$$, 'no es un mecánico activo');
SELECT pg_temp.falla('A6 destinatario mecánico INACTIVO → rechazado',
  $$SELECT public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000006', 'hola')$$, 'no es un mecánico activo');
SELECT pg_temp.falla('A7 destinatario el propio admin → rechazado',
  $$SELECT public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000001', 'hola')$$, 'no es un mecánico activo');
SELECT pg_temp.falla('A8 texto vacío → rechazado', $$SELECT public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000003', '   ')$$, 'vacío');
SELECT pg_temp.falla('A9 texto de 2001 caracteres → rechazado', $$SELECT public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000003', repeat('x', 2001))$$, 'largo');
SELECT pg_temp.falla('A10 orden relacionada inexistente → rechazado',
  $$SELECT public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000003', 'hola', gen_random_uuid())$$, 'orden relacionada no existe');
SELECT pg_temp.t('A11 mensaje a B relacionado con una cita',
  (public.enviar_mensaje(pg_temp.id(1003), pg_temp.id(502), pg_temp.uid(4), 'Mañana llega la moto', NULL, pg_temp.id(300)))->>'id' = pg_temp.id(502)::text);
SELECT pg_temp.nadie();

SELECT pg_temp.ser(2);
SELECT pg_temp.falla('A12 el CAJERO no envía como administrador', $$SELECT public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000003', 'hola')$$, 'Solo el administrador');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(3);
SELECT pg_temp.falla('A13 un MECÁNICO no envía', $$SELECT public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000004', 'hola')$$, 'Solo el administrador');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(5);
SELECT pg_temp.falla('A14 el desarrollador no envía', $$SELECT public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000003', 'hola')$$, 'Solo el administrador');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(0);
SELECT pg_temp.falla('A15 anon no puede ni ejecutar enviar_mensaje', $$SELECT public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), '00000000-0000-4000-8000-000000000003', 'hola')$$, 'permission denied');
SELECT pg_temp.nadie();

-- ── 2. contenido, orden relacionada y auditoría ───────────────────────────────
SELECT pg_temp.t('B1 se guarda el texto recortado, remitente, destinatario, fecha y la ORDEN como relación explícita',
  (SELECT texto = 'Revisa los frenos de la orden' AND remitente_id = pg_temp.uid(1) AND remitente_nombre = 'Usuario 1' AND destinatario_id = pg_temp.uid(3)
      AND orden_id = pg_temp.id(200) AND creado_en IS NOT NULL AND leido_en IS NULL AND op_id = pg_temp.id(1001) AND rev = 1 AND created_by = pg_temp.uid(1)
     FROM public.mensajes WHERE id = pg_temp.id(501)));
SELECT pg_temp.t('B2 exactamente 2 mensajes (los reintentos y rechazos no dejaron filas)', (SELECT count(*) FROM public.mensajes) = 2);
SELECT pg_temp.t('B3 la nota técnica de la orden NO cambió (no se copia texto entre entidades)',
  (SELECT reparacion_notas = 'nota técnica original' FROM public.ordenes WHERE id = pg_temp.id(200)));
SELECT pg_temp.t('B4 auditoría del envío (sin el texto del mensaje)',
  (SELECT count(*) = 2 AND bool_and(detalle NOT LIKE '%frenos%') FROM public.auditoria WHERE accion = 'mensaje-enviar'));

-- ── 3. lectura (RLS) ──────────────────────────────────────────────────────────
SELECT pg_temp.ser(3);
SELECT pg_temp.t('C1 mecánico A ve SOLO su mensaje', (SELECT array_agg(id) = ARRAY[pg_temp.id(501)] FROM public.mensajes));
SELECT pg_temp.nadie();
SELECT pg_temp.ser(4);
SELECT pg_temp.t('C2 mecánico B ve SOLO el suyo (no el de A)', (SELECT array_agg(id) = ARRAY[pg_temp.id(502)] FROM public.mensajes));
SELECT pg_temp.nadie();
SELECT pg_temp.ser(2);
SELECT pg_temp.t('C3 el cajero no ve mensajes', (SELECT count(*) FROM public.mensajes) = 0);
SELECT pg_temp.nadie();
SELECT pg_temp.ser(5);
SELECT pg_temp.t('C4 el desarrollador no ve mensajes', (SELECT count(*) FROM public.mensajes) = 0);
SELECT pg_temp.nadie();
SELECT pg_temp.ser(1);
SELECT pg_temp.t('C5 el administrador ve el estado de todos', (SELECT count(*) FROM public.mensajes) = 2);
SELECT pg_temp.nadie();
SELECT pg_temp.ser(0);
SELECT pg_temp.falla('C6 anon no lee la tabla', $$SELECT count(*) FROM public.mensajes$$, 'permission denied');
SELECT pg_temp.nadie();

-- ── 4. nada de escritura directa ──────────────────────────────────────────────
SELECT pg_temp.ser(1);
SELECT pg_temp.falla('D1 admin no inserta directo', $$INSERT INTO public.mensajes (remitente_nombre, texto, op_id) VALUES ('x', 'x', gen_random_uuid())$$, 'permission denied');
SELECT pg_temp.falla('D2 admin no edita directo', $$UPDATE public.mensajes SET texto = 'x'$$, 'permission denied');
SELECT pg_temp.falla('D3 admin no borra', $$DELETE FROM public.mensajes$$, 'permission denied');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(3);
SELECT pg_temp.falla('D4 el mecánico no marca leído por UPDATE directo', $$UPDATE public.mensajes SET leido_en = now()$$, 'permission denied');
SELECT pg_temp.nadie();
SELECT pg_temp.falla('D5 ni el dueño de la base cambia el texto (inmutable)', $$UPDATE public.mensajes SET texto = 'otro' WHERE id = '00000000-0000-4000-9000-000000000501'$$, 'no se modifica');
SELECT pg_temp.falla('D6 ni el dueño de la base borra un mensaje', $$DELETE FROM public.mensajes WHERE id = '00000000-0000-4000-9000-000000000501'$$, 'no se borran');

-- ── 5. leído / no leído ───────────────────────────────────────────────────────
SELECT pg_temp.ser(4);
SELECT pg_temp.falla('E1 mecánico B no marca el mensaje de A (mismo error que «no existe»)',
  $$SELECT public.marcar_mensaje_leido(gen_random_uuid(), '00000000-0000-4000-9000-000000000501')$$, 'no está disponible');
SELECT pg_temp.falla('E2 un id inexistente da el MISMO error', $$SELECT public.marcar_mensaje_leido(gen_random_uuid(), gen_random_uuid())$$, 'no está disponible');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(1);
SELECT pg_temp.falla('E3 el admin no marca como leído por el mecánico', $$SELECT public.marcar_mensaje_leido(gen_random_uuid(), '00000000-0000-4000-9000-000000000501')$$, 'Solo el mecánico');
SELECT pg_temp.nadie();
SELECT pg_temp.t('E4 sigue sin leer', (SELECT leido_en IS NULL FROM public.mensajes WHERE id = pg_temp.id(501)));
DELETE FROM realtime.messages;
SELECT pg_temp.ser(3);
SELECT pg_temp.t('E5 A marca su mensaje como leído', (public.marcar_mensaje_leido(pg_temp.id(1101), pg_temp.id(501)))->>'leido_en' IS NOT NULL);
SELECT pg_temp.nadie();
CREATE TEMP TABLE leido1 AS SELECT leido_en FROM public.mensajes WHERE id = pg_temp.id(501);
GRANT SELECT ON leido1 TO authenticated;
SELECT pg_temp.ser(3);
SELECT pg_temp.t('E6 marcar otra vez (reintento, otro dispositivo) devuelve la MISMA fecha',
  (public.marcar_mensaje_leido(pg_temp.id(1102), pg_temp.id(501)))->>'leido_en' = (SELECT to_jsonb(leido_en)->>0 FROM leido1));
SELECT pg_temp.nadie();
SELECT pg_temp.t('E7 leido_en no cambió y rev subió una sola vez', (SELECT m.leido_en = l.leido_en AND m.rev = 2 FROM public.mensajes m, leido1 l WHERE m.id = pg_temp.id(501)));
SELECT pg_temp.falla('E8 la lectura registrada no se puede borrar', $$UPDATE public.mensajes SET leido_en = NULL WHERE id = '00000000-0000-4000-9000-000000000501'$$, 'ya quedó registrada');
SELECT pg_temp.t('E9 aviso del cambio de lectura al administrador («admin») y a los otros dispositivos de A («mt:A»), una vez cada uno',
  (SELECT count(*) FROM realtime.messages WHERE topic = 'admin' AND payload->>'id' = pg_temp.id(501)::text) = 1
  AND (SELECT count(*) FROM realtime.messages WHERE topic = 'mt:' || pg_temp.uid(3) AND payload->>'id' = pg_temp.id(501)::text) = 1
  AND (SELECT count(*) FROM realtime.messages WHERE topic = 'mt:' || pg_temp.uid(4)) = 0);

-- ── 6. usuario desactivado ────────────────────────────────────────────────────
UPDATE public.perfiles SET activo = false WHERE id = pg_temp.uid(4);
SELECT pg_temp.ser(4);
SELECT pg_temp.t('F1 mecánico B DESACTIVADO ya no ve su mensaje', (SELECT count(*) FROM public.mensajes) = 0);
SELECT pg_temp.falla('F2 ni puede marcarlo leído', $$SELECT public.marcar_mensaje_leido(gen_random_uuid(), '00000000-0000-4000-9000-000000000502')$$, 'Solo el mecánico');
SELECT pg_temp.t('F3 ni ve citas asignadas', (SELECT count(*) FROM public.citas_tecnico_mias()) = 0);
SELECT pg_temp.nadie();
UPDATE public.perfiles SET activo = true WHERE id = pg_temp.uid(4);

-- ── 7. avisos: asignación, reasignación, duplicados ───────────────────────────
DELETE FROM realtime.messages;
SELECT pg_temp.ser(1);
SELECT public.enviar_mensaje(pg_temp.id(1004), pg_temp.id(503), pg_temp.uid(3), 'Otro');
SELECT pg_temp.nadie();
SELECT pg_temp.t('G1 mensaje nuevo → aviso en «mt:A» y en «admin»',
  (SELECT count(*) FROM realtime.messages WHERE topic = 'mt:' || pg_temp.uid(3) AND payload->>'e' = 'mensajes' AND payload->>'id' = pg_temp.id(503)::text) = 1
  AND (SELECT count(*) FROM realtime.messages WHERE topic = 'admin' AND payload->>'id' = pg_temp.id(503)::text) = 1);
SELECT pg_temp.t('G2 el aviso NO lleva el texto, ni nombres, ni teléfonos (solo e/id/rev/v) y es PRIVADO',
  (SELECT bool_and((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(payload) k) <@ ARRAY['e','id','rev','v']) AND bool_and(private) AND bool_and(payload::text NOT LIKE '%Otro%')
     FROM realtime.messages));
SELECT pg_temp.t('G3 B no recibe aviso del mensaje de A', (SELECT count(*) FROM realtime.messages WHERE topic = 'mt:' || pg_temp.uid(4)) = 0);

DELETE FROM realtime.messages;
INSERT INTO public.ordenes (id, cliente_id, estado, falla) VALUES (pg_temp.id(201), pg_temp.id(100), 'recibido', 'Ruido');
SELECT pg_temp.t('G4 orden sin mecánico → ningún aviso a mecánicos; aviso «taller» (tabla ordenes)',
  (SELECT count(*) FROM realtime.messages WHERE topic LIKE 'mt:%') = 0 AND (SELECT count(*) FROM realtime.messages WHERE topic = 'taller' AND payload->>'e' = 'ordenes') = 1);
-- B8 · regresión: realtime.send rellena 'id' con un uuid aleatorio si falta → el aviso de tabla lleva «todo» y 'id' nulo (nunca un id falso)
SELECT pg_temp.t('G4b aviso «taller» = de TABLA: todo=true e id nulo (no un uuid inventado por realtime.send)',
  (SELECT bool_and(payload->'todo' = 'true'::jsonb AND payload->'id' = 'null'::jsonb) FROM realtime.messages WHERE topic = 'taller' AND payload->>'e' = 'ordenes'));
DELETE FROM realtime.messages;
UPDATE public.ordenes SET mecanico_id = pg_temp.uid(3), mecanico = 'Usuario 3' WHERE id = pg_temp.id(201);
SELECT pg_temp.t('G5 admin ASIGNA → aviso a mt:A con el id de la orden', (SELECT count(*) FROM realtime.messages WHERE topic = 'mt:' || pg_temp.uid(3) AND payload->>'id' = pg_temp.id(201)::text AND payload->>'e' = 'ordenes') = 1);
DELETE FROM realtime.messages;
UPDATE public.ordenes SET mecanico_id = pg_temp.uid(4), mecanico = 'Usuario 4' WHERE id = pg_temp.id(201);
SELECT pg_temp.t('G6 REASIGNA A→B → aviso a A (para que la retire) y a B (para que la reciba)',
  (SELECT count(*) FROM realtime.messages WHERE topic = 'mt:' || pg_temp.uid(3) AND payload->>'id' = pg_temp.id(201)::text) = 1
  AND (SELECT count(*) FROM realtime.messages WHERE topic = 'mt:' || pg_temp.uid(4) AND payload->>'id' = pg_temp.id(201)::text) = 1);
DELETE FROM realtime.messages;
UPDATE public.ordenes SET margen = 10 WHERE id = pg_temp.id(201);
SELECT pg_temp.t('G7 cambio que Mi Trabajo no muestra (margen) → sin aviso a mecánicos', (SELECT count(*) FROM realtime.messages WHERE topic LIKE 'mt:%') = 0);
DELETE FROM realtime.messages;
BEGIN;
UPDATE public.ordenes SET falla = 'Ruido fuerte' WHERE id = pg_temp.id(201);
UPDATE public.ordenes SET estado = 'diagnostico' WHERE id = pg_temp.id(201);
COMMIT;
SELECT pg_temp.t('G8 dos cambios en UNA transacción → UN aviso a B (deduplicado)', (SELECT count(*) FROM realtime.messages WHERE topic = 'mt:' || pg_temp.uid(4)) = 1);
DELETE FROM realtime.messages;
BEGIN;
UPDATE public.ordenes SET falla = 'Ruido fuerte 2' WHERE id = pg_temp.id(201);
ROLLBACK;
SELECT pg_temp.t('G9 transacción revertida → ningún aviso', (SELECT count(*) FROM realtime.messages) = 0);
INSERT INTO public.orden_items (orden_id, nombre, cantidad, precio, tipo) VALUES (pg_temp.id(201), 'Mano de obra frenos', 1, 150, 'mano_obra');
SELECT pg_temp.t('G10 renglón nuevo → aviso a B con el id de la ORDEN', (SELECT count(*) FROM realtime.messages WHERE topic = 'mt:' || pg_temp.uid(4) AND payload->>'id' = pg_temp.id(201)::text) = 1);
DELETE FROM realtime.messages;
UPDATE public.citas SET mecanico_id = pg_temp.uid(4), mecanico = 'Usuario 4' WHERE id = pg_temp.id(300);
SELECT pg_temp.t('G11 cita reasignada A→B → aviso de «citas» a los dos',
  (SELECT count(*) FROM realtime.messages WHERE payload->>'e' = 'citas' AND topic IN ('mt:' || pg_temp.uid(3), 'mt:' || pg_temp.uid(4))) = 2);

-- ── 8. un fallo de Realtime nunca rompe la operación de negocio ────────────────
SET realtime.fallar = 'si';
UPDATE public.ordenes SET falla = 'con realtime caído' WHERE id = pg_temp.id(201);
SELECT pg_temp.t('H1 con realtime.send fallando, la orden se actualizó igual', (SELECT falla = 'con realtime caído' FROM public.ordenes WHERE id = pg_temp.id(201)));
SELECT pg_temp.ser(1);
SELECT pg_temp.t('H2 y un mensaje se envía igual', (public.enviar_mensaje(pg_temp.id(1005), pg_temp.id(504), pg_temp.uid(3), 'sin realtime'))->>'id' IS NOT NULL);
SELECT pg_temp.nadie();
RESET realtime.fallar;

-- ── 9. citas de Mi Trabajo ────────────────────────────────────────────────────
UPDATE public.citas SET mecanico_id = pg_temp.uid(3), mecanico = 'Usuario 3' WHERE id = pg_temp.id(300);
SELECT pg_temp.ser(3);
SELECT pg_temp.t('I1 A ve su cita abierta (con el nombre del cliente aplanado)', (SELECT count(*) = 1 AND bool_and(cliente_nombre = 'Cliente Mensajes') FROM public.citas_tecnico_mias()));
SELECT pg_temp.nadie();
SELECT pg_temp.ser(4);
SELECT pg_temp.t('I2 B no ve la cita de A', (SELECT count(*) FROM public.citas_tecnico_mias()) = 0);
SELECT pg_temp.nadie();
SELECT pg_temp.ser(2);
SELECT pg_temp.t('I3 el cajero no obtiene citas por la función del mecánico', (SELECT count(*) FROM public.citas_tecnico_mias()) = 0);
SELECT pg_temp.nadie();
UPDATE public.citas SET estado = 'atendida', cerrada_en = now() WHERE id = pg_temp.id(300);
SELECT pg_temp.ser(3);
SELECT pg_temp.t('I4 al atenderla (se convierte en orden) la cita sale de Mi Trabajo: un solo trabajo', (SELECT count(*) FROM public.citas_tecnico_mias()) = 0);
SELECT pg_temp.nadie();

-- ── 10. quién escucha cada canal (RLS de realtime.messages) ────────────────────
DELETE FROM realtime.messages;
INSERT INTO realtime.messages (topic, extension, payload) VALUES
  ('mt:' || pg_temp.uid(3), 'broadcast', '{}'), ('mt:' || pg_temp.uid(4), 'broadcast', '{}'), ('mt:' || pg_temp.uid(6), 'broadcast', '{}'),
  ('taller', 'broadcast', '{}'), ('admin', 'broadcast', '{}'), ('mt:' || pg_temp.uid(3), 'presence', '{}');
CREATE FUNCTION pg_temp.ve(n int, topico text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE c int;
BEGIN
  PERFORM pg_temp.como(n); PERFORM set_config('realtime.topic', topico, true);
  SELECT count(*) INTO c FROM realtime.messages WHERE topic = topico;
  PERFORM pg_temp.fin(); PERFORM set_config('realtime.topic', '', true);
  RETURN c;
END $$;
SELECT pg_temp.t('J1 A escucha su canal (solo broadcast, no presence)', pg_temp.ve(3, 'mt:' || pg_temp.uid(3)) = 1);
SELECT pg_temp.t('J2 A NO escucha el canal de B', pg_temp.ve(3, 'mt:' || pg_temp.uid(4)) = 0);
SELECT pg_temp.t('J3 B NO escucha el canal de A', pg_temp.ve(4, 'mt:' || pg_temp.uid(3)) = 0);
SELECT pg_temp.t('J4 mecánico INACTIVO no escucha ni su propio canal', pg_temp.ve(6, 'mt:' || pg_temp.uid(6)) = 0);
SELECT pg_temp.t('J5 el cajero escucha «taller»', pg_temp.ve(2, 'taller') = 1);
SELECT pg_temp.t('J6 el cajero NO escucha «admin»', pg_temp.ve(2, 'admin') = 0);
SELECT pg_temp.t('J7 el cajero NO escucha el canal de un mecánico', pg_temp.ve(2, 'mt:' || pg_temp.uid(3)) = 0);
SELECT pg_temp.t('J8 el admin escucha «admin» y «taller»', pg_temp.ve(1, 'admin') = 1 AND pg_temp.ve(1, 'taller') = 1);
SELECT pg_temp.t('J9 el admin NO escucha el canal privado de un mecánico', pg_temp.ve(1, 'mt:' || pg_temp.uid(3)) = 0);
SELECT pg_temp.t('J10 un mecánico NO escucha «taller» ni «admin»', pg_temp.ve(3, 'taller') = 0 AND pg_temp.ve(3, 'admin') = 0);
SELECT pg_temp.t('J11 anon no escucha nada', pg_temp.ve(0, 'taller') = 0 AND pg_temp.ve(0, 'mt:' || pg_temp.uid(3)) = 0);
SELECT pg_temp.ser(3);
SELECT pg_temp.falla('J12 un cliente NO puede emitir en un canal (sin política de INSERT)',
  $$INSERT INTO realtime.messages (topic, extension, payload) VALUES ('mt:00000000-0000-4000-8000-000000000004', 'broadcast', '{}')$$, 'row-level security');
SELECT pg_temp.nadie();
SELECT pg_temp.t('J13 ninguna tabla de negocio en la publicación supabase_realtime', (SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public') = 0);
SELECT pg_temp.t('J14 funciones internas de aviso NO invocables por authenticated',
  NOT has_function_privilege('authenticated', 'public.sync_rt_aviso(text,jsonb)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.sync_rt_taller()', 'EXECUTE'));
SELECT pg_temp.t('J15 invariantes de negocio intactos', (SELECT count(*) FROM public.verificar_invariantes() x WHERE jsonb_array_length(x) > 0) = 0);
