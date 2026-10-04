-- 3.15.0 · Bloque 4 · OWNER-PIN-GUARD + eliminar usuario (sync-15d). Con 00-prelude.sql + 15d-auth-stub.sql + 15c-realtime-stub.sql aplicados.
-- Usuarios: 1 admin · 2 cajero · 3 mecánico A · 4 mecánico B · 5 desarrollador · 6 mecánico INACTIVO. Sesiones (auth.sessions stub): S1 (admin),
-- S2 (cajero), S1b (otra sesión del admin). El PIN no pasa por la base: aquí se prueban la emisión/consumo y los datos.
\set ON_ERROR_STOP 0
CREATE FUNCTION pg_temp.ser(n int, sid uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', CASE WHEN n = 0 THEN '' ELSE pg_temp.uid(n)::text END, false);
  PERFORM set_config('request.jwt.claim.role', CASE WHEN n = 0 THEN 'anon' ELSE 'authenticated' END, false);
  PERFORM set_config('request.jwt.claims', CASE WHEN n = 0 THEN '{"role":"anon"}' ELSE json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated', 'session_id', sid)::text END, false);
  PERFORM set_config('role', CASE WHEN n = 0 THEN 'anon' ELSE 'authenticated' END, false);
END $$;
CREATE FUNCTION pg_temp.nadie() RETURNS void LANGUAGE plpgsql AS $$
BEGIN RESET ROLE; PERFORM set_config('request.jwt.claim.sub', '', false); PERFORM set_config('request.jwt.claims', '', false); END $$;
CREATE FUNCTION pg_temp.S(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid $$;
INSERT INTO auth.sessions (id, user_id) VALUES (pg_temp.S(1), pg_temp.uid(1)), (pg_temp.S(2), pg_temp.uid(2)), (pg_temp.S(11), pg_temp.uid(1)), (pg_temp.S(3), pg_temp.uid(3)), (pg_temp.S(33), pg_temp.uid(3));
/* emite una autorización como lo hace el api-server (service_role) tras verificar el PIN */
CREATE FUNCTION pg_temp.emitir(sol int, accion text, entidad text, registro uuid, sid uuid, ttl int DEFAULT 90, dev text DEFAULT 'dev-1') RETURNS uuid LANGUAGE sql AS $$
  SELECT ((public.pin_emitir_autorizacion(pg_temp.uid(sol), (SELECT rol FROM public.perfiles WHERE id = pg_temp.uid(sol)), pg_temp.uid(1), accion, entidad, registro, dev,
          (SELECT version FROM public.admin_pin WHERE perfil_id = pg_temp.uid(1)), NULL, ttl, sid))->>'autorizacion_id')::uuid $$;

-- ── A/B/C/D · PIN: configurar, nunca en claro, cambiar, auditoría ──────────────────
SELECT pg_temp.t('A1 sin PIN no hay de dónde emitir (una destructiva queda bloqueada)', NOT EXISTS (SELECT 1 FROM public.admin_pin));
SELECT pg_temp.falla('A2 hash sin formato scrypt → rechazado (nunca se guarda un PIN en claro)', $$SELECT public.pin_guardar('00000000-0000-4000-8000-000000000001', '482915', '00000000-0000-4000-8000-000000000001', 'inicial')$$, 'Formato de hash');
SELECT pg_temp.t('A3 configurar → versión 1', public.pin_guardar(pg_temp.uid(1), 'scrypt$32768$8$1$c2FsLXNhbC1zYWw=$aGFzaA==', pg_temp.uid(1), 'inicial') = 1);
SELECT pg_temp.t('B1 en la base solo hay un hash scrypt (ni el PIN ni partes)', (SELECT hash ~ '^scrypt\$' FROM public.admin_pin));
SELECT pg_temp.t('C1 cambiar → versión 2', public.pin_guardar(pg_temp.uid(1), 'scrypt$32768$8$1$c2FsLXNhbC1zYWx4$aGFzaDI=', pg_temp.uid(1), 'pin') = 2);
SELECT pg_temp.t('AF1 recuperar con la contraseña → versión 3', public.pin_guardar(pg_temp.uid(1), 'scrypt$32768$8$1$c2FsLXNhbC1zYWx5$aGFzaDM=', pg_temp.uid(1), 'clave') = 3);
SELECT pg_temp.t('C2 auditoría: configurar, cambiar, recuperar (sin PIN ni hash)',
  (SELECT string_agg(accion, ',' ORDER BY creado_en) FROM public.auditoria WHERE entidad = 'admin_pin') = 'pin-configurar,pin-cambiar,pin-recuperar'
  AND NOT EXISTS (SELECT 1 FROM public.auditoria WHERE entidad = 'admin_pin' AND (detalle ~ 'scrypt' OR detalle ~ '[0-9]{6}')));
SELECT pg_temp.falla('C3 un cajero no puede tener PIN de propietario', $$SELECT public.pin_guardar('00000000-0000-4000-8000-000000000002', 'scrypt$1$1$1$a$b', '00000000-0000-4000-8000-000000000002')$$, 'Solo un administrador');
SELECT pg_temp.falla('C4 authenticated no ejecuta pin_guardar', $$SELECT pg_temp.ser(1); SELECT public.pin_guardar('00000000-0000-4000-8000-000000000001', 'scrypt$1$1$1$a$b', '00000000-0000-4000-8000-000000000001')$$, 'permission denied');
SELECT pg_temp.nadie();

-- datos: un movimiento de caja del admin, a revertir
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT (public.registrar_movimiento_caja(pg_temp.id(4001), 'egreso', 'Otros', 55, 'efectivo', 'para revertir'))->>'movimiento_id' AS m1 \gset
SELECT (public.registrar_movimiento_caja(pg_temp.id(4002), 'egreso', 'Otros', 66, 'efectivo', 'para revertir 2'))->>'movimiento_id' AS m2 \gset
SELECT pg_temp.nadie();

-- ── OWNER-PIN-GUARD: el admin ya no pasa sin PIN en lo destructivo ─────────────────
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.falla('O1 admin revierte caja SIN autorización → AUTORIZACION_REQUERIDA', format($$SELECT public.reversar_caja(%L, %L, 'motivo x', NULL, 'dev-1')$$, pg_temp.id(4101), :'m1'), 'AUTORIZACION_REQUERIDA');
SELECT pg_temp.nadie();
SELECT pg_temp.emitir(1, 'reversar_caja', 'caja_movimientos', :'m1'::uuid, pg_temp.S(1)) AS a1 \gset
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.nadie();
SELECT pg_temp.emitir(1, 'eliminar_usuario', 'perfiles', pg_temp.uid(3), pg_temp.S(1)) AS a_otra \gset
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.falla('I1 una autorización de ELIMINAR USUARIO no sirve para revertir caja', format($$SELECT public.reversar_caja(%L, %L, 'motivo x', %L, 'dev-1')$$, pg_temp.id(4102), :'m1', :'a_otra'), 'AUTORIZACION_INVALIDA');
SELECT pg_temp.falla('I2 ni para OTRO movimiento', format($$SELECT public.reversar_caja(%L, %L, 'motivo x', %L, 'dev-1')$$, pg_temp.id(4103), :'m2', :'a1'), 'AUTORIZACION_INVALIDA');
SELECT pg_temp.falla('I3 ni desde otro dispositivo', format($$SELECT public.reversar_caja(%L, %L, 'motivo x', %L, 'dev-otro')$$, pg_temp.id(4104), :'m1', :'a1'), 'AUTORIZACION_INVALIDA');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(1, pg_temp.S(11));
SELECT pg_temp.falla('L1 ni desde OTRA sesión del mismo admin', format($$SELECT public.reversar_caja(%L, %L, 'motivo x', %L, 'dev-1')$$, pg_temp.id(4105), :'m1', :'a1'), 'AUTORIZACION_INVALIDA');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.t('O2 con SU autorización, en su sesión y dispositivo → revierte', (public.reversar_caja(pg_temp.id(4106), :'m1', 'motivo x', :'a1', 'dev-1')) IS NOT NULL);
SELECT pg_temp.t('AC1 el mismo operation_id repetido → «repetida», un solo reverso', (public.reversar_caja(pg_temp.id(4106), :'m1', 'motivo x', :'a1', 'dev-1'))->>'repetida' = 'true');
SELECT pg_temp.falla('J1 REPLAY: la misma autorización con otro operation_id → rechazada (un solo uso)', format($$SELECT public.reversar_caja(%L, %L, 'motivo x', %L, 'dev-1')$$, pg_temp.id(4107), :'m2', :'a1'), 'AUTORIZACION_INVALIDA');
SELECT pg_temp.nadie();
SELECT pg_temp.t('AC2 exactamente un reverso del movimiento', (SELECT count(*) FROM public.caja_movimientos WHERE reverso_de = :'m1'::uuid) = 1);
SELECT pg_temp.t('O3 queda auditado quién autorizó', (SELECT autorizado_por FROM public.reversos WHERE registro_id = :'m1'::uuid LIMIT 1) = pg_temp.uid(1));

-- H · caducidad
SELECT pg_temp.emitir(1, 'reversar_caja', 'caja_movimientos', :'m2'::uuid, pg_temp.S(1), 10) AS a_corta \gset
SET session_replication_role = replica;   -- la tabla es de solo-agregar (guarda de SYNC-2): así se simula que pasó el tiempo
UPDATE public.autorizaciones_admin SET expira_en = creado_en + interval '1 millisecond', creado_en = creado_en - interval '1 second' WHERE id = :'a_corta'::uuid;
RESET session_replication_role;
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.falla('H1 autorización CADUCADA → rechazada', format($$SELECT public.reversar_caja(%L, %L, 'motivo x', %L, 'dev-1')$$, pg_temp.id(4108), :'m2', :'a_corta'), 'AUTORIZACION_INVALIDA');
SELECT pg_temp.nadie();
-- D · cambiar el PIN invalida lo emitido sin usar
SELECT pg_temp.emitir(1, 'reversar_caja', 'caja_movimientos', :'m2'::uuid, pg_temp.S(1)) AS a_vieja \gset
SELECT public.pin_guardar(pg_temp.uid(1), 'scrypt$32768$8$1$c2FsLXNhbC1zYWx6$aGFzaDQ=', pg_temp.uid(1), 'pin');
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.falla('D1 tras CAMBIAR el PIN, la autorización emitida con el anterior no vale', format($$SELECT public.reversar_caja(%L, %L, 'motivo x', %L, 'dev-1')$$, pg_temp.id(4109), :'m2', :'a_vieja'), 'AUTORIZACION_INVALIDA');
SELECT pg_temp.nadie();
-- K · logout (la sesión desaparece de Auth) invalida la autorización aunque el token siga vivo
SELECT pg_temp.emitir(1, 'reversar_caja', 'caja_movimientos', :'m2'::uuid, pg_temp.S(1)) AS a_k \gset
DELETE FROM auth.sessions WHERE id = pg_temp.S(1);
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.falla('K1 sesión cerrada → la autorización no se puede usar', format($$SELECT public.reversar_caja(%L, %L, 'motivo x', %L, 'dev-1')$$, pg_temp.id(4110), :'m2', :'a_k'), 'AUTORIZACION_INVALIDA');
SELECT pg_temp.nadie();
SELECT pg_temp.falla('K2 y no se emite una autorización para una sesión que ya no existe', $$SELECT pg_temp.emitir(1, 'reversar_caja', 'caja_movimientos', gen_random_uuid(), '00000000-0000-4000-a000-000000000001')$$, 'SESION_INVALIDA');
INSERT INTO auth.sessions (id, user_id) VALUES (pg_temp.S(1), pg_temp.uid(1));
-- L · cambio de usuario: la autorización del admin no la usa el cajero
SELECT pg_temp.emitir(1, 'reversar_caja', 'caja_movimientos', :'m2'::uuid, pg_temp.S(1)) AS a_l \gset
SELECT pg_temp.ser(2, pg_temp.S(2));
SELECT pg_temp.falla('L2 otro usuario (cajero) con la autorización del admin → rechazada', format($$SELECT public.reversar_caja(%L, %L, 'motivo x', %L, 'dev-1')$$, pg_temp.id(4111), :'m2', :'a_l'), 'AUTORIZACION_INVALIDA');
SELECT pg_temp.nadie();
-- sensible sigue igual: admin sin PIN, cajero con PIN
INSERT INTO public.inventario (id, nombre, precio_venta) VALUES (pg_temp.id(4200), 'Filtro 15d', 10);
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.t('SENS1 ajustar stock (SENSIBLE): el admin sigue sin necesitar PIN', (public.ajustar_stock(pg_temp.id(4201), pg_temp.id(4200), 'conteo', 5)) IS NOT NULL);
SELECT pg_temp.nadie();
SELECT pg_temp.ser(2, pg_temp.S(2));
SELECT pg_temp.falla('SENS2 el cajero sí necesita PIN para ajustar stock', format($$SELECT public.ajustar_stock(%L, %L, 'conteo', 5)$$, pg_temp.id(4202), pg_temp.id(4200)), 'AUTORIZACION_REQUERIDA');
SELECT pg_temp.nadie();
SELECT pg_temp.t('POL1 matriz: destructivas exactas', public.sync_accion_destructiva('eliminar_usuario') AND public.sync_accion_destructiva('reversar_venta') AND public.sync_accion_destructiva('anular_orden')
  AND NOT public.sync_accion_destructiva('ajustar_stock') AND NOT public.sync_accion_destructiva('registrar_devolucion') AND NOT public.sync_accion_destructiva('registrar_venta_v2'));

-- ── ELIMINAR USUARIO ──────────────────────────────────────────────────────────────
-- historial del mecánico B: una orden entregada, una activa, una cita abierta, un mensaje, auditoría
INSERT INTO public.clientes (id, nombre) VALUES (pg_temp.id(4300), 'Cliente 15d');
INSERT INTO public.ordenes (id, cliente_id, estado, falla, mecanico, mecanico_id, finalizada) VALUES
  (pg_temp.id(4301), pg_temp.id(4300), 'entregado', 'cerrada', 'Usuario 4', pg_temp.uid(4), true),
  (pg_temp.id(4302), pg_temp.id(4300), 'reparacion', 'activa', 'Usuario 4', pg_temp.uid(4), false);
INSERT INTO public.citas (id, cliente_id, fecha, hora, motivo, mecanico, mecanico_id) VALUES (pg_temp.id(4303), pg_temp.id(4300), current_date + 2, '09:00', 'cita abierta', 'Usuario 4', pg_temp.uid(4));
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT public.enviar_mensaje(pg_temp.id(4304), pg_temp.id(4305), pg_temp.uid(4), 'mensaje histórico');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(4);
SELECT public.marcar_mensaje_leido(pg_temp.id(4306), pg_temp.id(4305));
SELECT pg_temp.nadie();
UPDATE public.orden_items SET nombre = nombre;   -- nada
CREATE TEMP TABLE antes AS SELECT (SELECT count(*) FROM public.ordenes) ord, (SELECT count(*) FROM public.citas) cit, (SELECT count(*) FROM public.mensajes) msg,
  (SELECT count(*) FROM public.auditoria) aud, (SELECT count(*) FROM public.ordenes WHERE mecanico_id = pg_temp.uid(4) AND id = pg_temp.id(4301)) cerrada_de_b;

SELECT pg_temp.emitir(1, 'eliminar_usuario', 'perfiles', pg_temp.uid(4), pg_temp.S(1)) AS a_elim \gset
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.t('Z1 impacto: 1 orden activa y 1 cita abierta; historial 2 órdenes y 1 mensaje',
  (SELECT jsonb_array_length(x->'ordenes_activas') = 1 AND jsonb_array_length(x->'citas_abiertas') = 1 AND (x->'historial'->>'ordenes')::int = 2 AND (x->'historial'->>'mensajes')::int = 1
     FROM (SELECT public.usuario_impacto(pg_temp.uid(4)) x) q));
SELECT pg_temp.falla('Z2 con trabajo activo y SIN decidir → se niega con el conteo (y no consume la autorización)',
  format($$SELECT public.eliminar_usuario(%L, %L, %L, 'dev-1', false)$$, pg_temp.id(4400), pg_temp.uid(4), :'a_elim'), 'TRABAJO_ACTIVO: tiene 1 orden');
SELECT pg_temp.falla('O4 sin autorización (PIN) → no elimina', format($$SELECT public.eliminar_usuario(%L, %L, NULL, 'dev-1', true)$$, pg_temp.id(4401), pg_temp.uid(4)), 'AUTORIZACION_REQUERIDA');
SELECT pg_temp.falla('AA1 no se elimina a sí mismo', format($$SELECT public.eliminar_usuario(%L, %L, NULL, 'dev-1', true)$$, pg_temp.id(4402), pg_temp.uid(1)), 'propia cuenta');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(2, pg_temp.S(2));
SELECT pg_temp.falla('P1 el CAJERO no elimina usuarios', format($$SELECT public.eliminar_usuario(%L, %L, NULL, 'dev-1', true)$$, pg_temp.id(4403), pg_temp.uid(4)), 'Solo el administrador');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(3, pg_temp.S(3));
SELECT pg_temp.falla('Q1 el MECÁNICO no elimina usuarios', format($$SELECT public.eliminar_usuario(%L, %L, NULL, 'dev-1', true)$$, pg_temp.id(4404), pg_temp.uid(4)), 'Solo el administrador');
SELECT pg_temp.falla('Q2 ni consulta el impacto', format($$SELECT public.usuario_impacto(%L)$$, pg_temp.uid(4)), 'Solo el administrador');
SELECT pg_temp.nadie();
DELETE FROM realtime.messages;
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.t('O5 con PIN y desasignando: eliminado', (public.eliminar_usuario(pg_temp.id(4405), pg_temp.uid(4), :'a_elim', 'dev-1', true))->>'eliminado' = 'true');
SELECT pg_temp.t('AC3 retry con el MISMO op (respuesta perdida) → «repetida», nada más', (public.eliminar_usuario(pg_temp.id(4405), pg_temp.uid(4), :'a_elim', 'dev-1', true))->>'repetida' = 'true');
SELECT pg_temp.t('AB1 doble clic / otra pestaña (otro op, SIN autorización) → «ya_eliminado», sin consumir otra', (public.eliminar_usuario(pg_temp.id(4406), pg_temp.uid(4), NULL, 'dev-1', true))->>'ya_eliminado' = 'true');
SELECT pg_temp.nadie();
SELECT pg_temp.t('ACC1 perfil: inactivo, eliminado_en/por, nombre y rol conservados', (SELECT NOT activo AND eliminado_en IS NOT NULL AND eliminado_por = pg_temp.uid(1) AND nombre = 'Usuario 4' AND rol = 'mecanico' FROM public.perfiles WHERE id = pg_temp.uid(4)));
SELECT pg_temp.t('U1 historia intacta: mismas filas en órdenes, citas, mensajes; la entregada sigue siendo de B',
  (SELECT a.ord = (SELECT count(*) FROM public.ordenes) AND a.cit = (SELECT count(*) FROM public.citas) AND a.msg = (SELECT count(*) FROM public.mensajes) FROM antes a)
  AND (SELECT mecanico_id = pg_temp.uid(4) AND mecanico = 'Usuario 4' FROM public.ordenes WHERE id = pg_temp.id(4301)));
SELECT pg_temp.t('Z3 trabajo ACTIVO: desasignado («sin asignar»), no pasado a otra persona', (SELECT mecanico_id IS NULL AND mecanico IS NULL FROM public.ordenes WHERE id = pg_temp.id(4302))
  AND (SELECT mecanico_id IS NULL FROM public.citas WHERE id = pg_temp.id(4303)));
SELECT pg_temp.t('W1 auditoría: eliminado + ids desasignados + quién autorizó; la auditoría previa sigue',
  (SELECT count(*) = 1 AND bool_and(detalle ~ pg_temp.id(4302)::text AND autorizado_por = pg_temp.uid(1)) FROM public.auditoria WHERE accion = 'usuario-eliminar')
  AND (SELECT count(*) FROM public.auditoria) > (SELECT aud FROM antes));
SELECT pg_temp.t('X1 mensaje histórico y su lectura siguen ahí', (SELECT destinatario_id = pg_temp.uid(4) AND leido_en IS NOT NULL FROM public.mensajes WHERE id = pg_temp.id(4305)));
SELECT pg_temp.t('V1 ninguna FK huérfana ni en NULL por la eliminación', (SELECT count(*) FROM public.ordenes WHERE id = pg_temp.id(4301) AND mecanico_id IS NOT NULL) = 1
  AND EXISTS (SELECT 1 FROM public.perfiles WHERE id = pg_temp.uid(4)));
SELECT pg_temp.t('Y1 aviso realtime «cuenta» a su canal y al del taller', (SELECT count(*) FROM realtime.messages WHERE payload->>'e' = 'cuenta' AND topic IN ('mt:' || pg_temp.uid(4), 'taller')) = 2);
SELECT pg_temp.ser(4);
SELECT pg_temp.t('R1 el eliminado ya no lee nada: ni mensajes ni sus órdenes', (SELECT count(*) FROM public.mensajes) = 0 AND (SELECT count(*) FROM public.ordenes_tecnico_mias()) = 0);
SELECT pg_temp.nadie();
CREATE FUNCTION pg_temp.ve(n int, topico text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE c int;
BEGIN
  PERFORM pg_temp.como(n); PERFORM set_config('realtime.topic', topico, true);
  SELECT count(*) INTO c FROM realtime.messages WHERE topic = topico;
  PERFORM pg_temp.fin(); PERFORM set_config('realtime.topic', '', true);
  RETURN c;
END $$;
SELECT pg_temp.t('R2 ni escucha su canal realtime (aunque haya avisos en él)', (SELECT count(*) FROM realtime.messages WHERE topic = 'mt:' || pg_temp.uid(4)) >= 1 AND pg_temp.ve(4, 'mt:' || pg_temp.uid(4)) = 0);
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.falla('N1 no se le pueden mandar mensajes nuevos', format($$SELECT public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), %L, 'hola')$$, pg_temp.uid(4)), 'no es un mecánico activo');
SELECT pg_temp.nadie();

-- definitivo: ni reactivar, ni cambiar de rol, ni «des-eliminar», ni borrar físico
SELECT pg_temp.falla('AE1 reactivar una cuenta eliminada → prohibido (también para el dueño de la base)', $$UPDATE public.perfiles SET activo = true WHERE id = '00000000-0000-4000-8000-000000000004'$$, 'USUARIO_ELIMINADO');
SELECT pg_temp.falla('AE2 cambiarle el rol → prohibido', $$UPDATE public.perfiles SET rol = 'cajero' WHERE id = '00000000-0000-4000-8000-000000000004'$$, 'USUARIO_ELIMINADO|cambiar roles');
SELECT pg_temp.falla('AE3 quitarle la marca → prohibido', $$UPDATE public.perfiles SET eliminado_en = NULL WHERE id = '00000000-0000-4000-8000-000000000004'$$, 'USUARIO_ELIMINADO');
SELECT pg_temp.falla('AE4 marcar «eliminado» a mano (sin el flujo) → prohibido', $$UPDATE public.perfiles SET activo = false, eliminado_en = now() WHERE id = '00000000-0000-4000-8000-000000000006'$$, 'Eliminar usuario');
SELECT pg_temp.falla('V2 borrado FÍSICO de un perfil con historial (p. ej. desde el panel de Auth) → prohibido', $$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-000000000004'$$, 'PERFIL_CON_HISTORIAL');
SELECT pg_temp.falla('V3 tampoco el del administrador (tiene caja y auditoría)', $$DELETE FROM public.perfiles WHERE id = '00000000-0000-4000-8000-000000000001'$$, 'PERFIL_CON_HISTORIAL');
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-000000000099', 'sin-historial@example.test');
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-000000000099';
SELECT pg_temp.t('V4 una cuenta SIN historial (alta fallida) sí se puede borrar', NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '00000000-0000-4000-8000-000000000099')
  AND NOT EXISTS (SELECT 1 FROM public.perfiles WHERE id = '00000000-0000-4000-8000-000000000099'));

-- S/T · sesiones: revocar solo de cuentas eliminadas
INSERT INTO auth.sessions (id, user_id) VALUES (pg_temp.S(41), pg_temp.uid(4)), (pg_temp.S(42), pg_temp.uid(4));
SELECT public.revocar_sesiones_usuario(pg_temp.uid(4)) AS revocadas \gset
SELECT pg_temp.t('T1 revocar sesiones del eliminado: sus DOS sesiones fuera; las del resto intactas',
  :revocadas = 2 AND NOT EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = pg_temp.uid(4))
  AND (SELECT count(*) FROM auth.sessions WHERE user_id = pg_temp.uid(3)) = 2);
SELECT pg_temp.falla('T2 nunca las de una cuenta activa', $$SELECT public.revocar_sesiones_usuario('00000000-0000-4000-8000-000000000003')$$, 'cuenta eliminada');
SELECT pg_temp.t('T3 revocar/impacto/eliminar: internas no invocables por anon; revocar tampoco por authenticated',
  NOT has_function_privilege('anon', 'public.eliminar_usuario(uuid,uuid,uuid,text,boolean)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.revocar_sesiones_usuario(uuid)', 'EXECUTE'));

-- AA · último administrador
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT pg_temp.falla('AA2 la cuenta del administrador no se elimina (quedaría sin administrador)', format($$SELECT public.eliminar_usuario(%L, %L, NULL)$$, pg_temp.id(4407), pg_temp.uid(1)), 'propia cuenta');
SELECT pg_temp.nadie();
SELECT pg_temp.t('INV invariantes de negocio intactos', (SELECT count(*) FROM public.verificar_invariantes() x WHERE jsonb_array_length(x) > 0) = 0);
