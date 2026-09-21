-- SYNC-1 · pruebas del esquema cloud. Requiere sql/00-prelude.sql y sync-1-esquema.sql ya aplicados.
-- 1. Estructura y cierre de tablas nuevas
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sync_ops','inventario_movimientos','reversos','import_lotes','import_registros',
                           'import_mapeo_mecanicos','admin_pin','admin_pin_intentos','autorizaciones_admin'] LOOP
    PERFORM pg_temp.t('tabla nueva ' || t || ' existe con RLS activo',
      EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.' || t) AND relrowsecurity));
    PERFORM pg_temp.t('tabla nueva ' || t || ' cerrada a authenticated y anon',
      NOT has_table_privilege('authenticated', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'));
    PERFORM pg_temp.t('tabla nueva ' || t || ' sin ninguna política (deniega todo)',
      NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t));
  END LOOP;
  FOREACH t IN ARRAY ARRAY['clientes','motos','citas','ordenes','cotizaciones','categorias_inv','inventario',
                           'web_cms','ventas','creditos','abonos','caja_movimientos'] LOOP
    PERFORM pg_temp.t('sello zz_sync_sello en ' || t,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.' || t) AND tgname = 'zz_sync_sello' AND NOT tgisinternal));
  END LOOP;
  PERFORM pg_temp.t('D-1: no existe taller_id/tenant_id ni talleres',
    NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('taller_id','tenant_id'))
    AND to_regclass('public.talleres') IS NULL);
  PERFORM pg_temp.t('D-3: el CHECK inventario_cantidad_check se eliminó (stock puede ser negativo)',
    NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventario_cantidad_check'));
  PERFORM pg_temp.t('un solo lote de importación aplicado: índice único parcial existe',
    EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'import_lotes_un_aplicado_uidx'));
END $$;

-- 2. Las 17 funciones fijadas por RCV-34 siguen idénticas (md5)
DO $$
DECLARE k record; n int := 0;
BEGIN
  FOR k IN SELECT * FROM (VALUES
    ('rol_actual','e66ee46e01d3df511ee5bd4d0f2a178a'),('es_admin','35aa9a08ef4e9960cb333eea4939d15e'),
    ('puede_cobrar','2c95d9a820de4ae25ec59d25cbbd1a91'),('es_equipo','635c8361317be3293aee3778a0de048d'),
    ('es_desarrollador','25a3787ce375a9a89a58266b96b732a3'),('es_mecanico_activo','1b786deb21df29b40f89dca23ab776fd'),
    ('ve_todo_el_taller','80b7f166927d6559301d8507c397a243'),('mi_cliente','aeee991cda291df054c2924d1e9f3cdf'),
    ('mi_moto','235499aeafbd8379d6333b7e51edb6c2'),('crear_perfil_al_registrarse','f3873b6473a2831c8046a29b97947ea3'),
    ('proteger_caja_ligada','4b1a0e352c4eae22efcbb139ae72a725'),('proteger_rol_perfil','5bcd1237d7e6714293cf4fc332e08667'),
    ('mecanico_solo_avance_tecnico','5c9d8db5084b0a4e881948d9a920462b'),('registrar_venta','ae8ee6c6d7c066d4d544ff4e9ab5147b'),
    ('registrar_abono','6dee1802d5cf45cd4d8d91b140e2cadd'),('estadisticas_tecnicas','86948fdcaf03939a1d0929004cd9c730'),
    ('estado_tecnico','8cab17a837ec35d46c8575befd53e85a')) AS v(f, m) LOOP
    IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = k.f AND md5(prosrc) = k.m) THEN n := n + 1; END IF;
  END LOOP;
  PERFORM pg_temp.t('las 17 funciones de RCV-34 conservan su md5', n = 17);
END $$;

-- 3. Sello: el servidor manda (rev, created_by, updated_by, updated_at)
DO $$
DECLARE v_id uuid; v_id2 uuid; r record; v_t0 timestamptz;
BEGIN
  INSERT INTO public.clientes (nombre) VALUES ('Cliente sello') RETURNING id INTO v_id;
  SELECT rev, created_by, updated_at INTO r FROM public.clientes WHERE id = v_id;
  PERFORM pg_temp.t('insert (sin sesión): rev=1 y created_by nulo', r.rev = 1 AND r.created_by IS NULL);
  v_t0 := r.updated_at;
  UPDATE public.clientes SET telefono = '1' WHERE id = v_id;
  SELECT rev, updated_at INTO r FROM public.clientes WHERE id = v_id;
  PERFORM pg_temp.t('update: rev sube a 2 y updated_at avanza', r.rev = 2 AND r.updated_at > v_t0);

  -- cajero (uid 2): intenta falsear autor, rev y sello
  PERFORM pg_temp.como(2);
  INSERT INTO public.clientes (nombre, created_by, updated_by, rev, updated_at)
  VALUES ('Cliente del cajero', pg_temp.uid(1), pg_temp.uid(1), 99, '2000-01-01') RETURNING id INTO v_id2;
  PERFORM pg_temp.fin();
  SELECT rev, created_by, updated_by, updated_at INTO r FROM public.clientes WHERE id = v_id2;
  PERFORM pg_temp.t('cajero no puede falsear created_by (queda su uid)', r.created_by = pg_temp.uid(2));
  PERFORM pg_temp.t('cajero no puede falsear updated_by ni rev', r.updated_by = pg_temp.uid(2) AND r.rev = 1);
  PERFORM pg_temp.t('cajero no puede fijar updated_at en el pasado', r.updated_at > '2020-01-01');

  PERFORM pg_temp.como(2);
  UPDATE public.clientes SET nombre = 'Renombrado', rev = 50, created_by = pg_temp.uid(1) WHERE id = v_id2;
  PERFORM pg_temp.fin();
  SELECT rev, created_by, updated_by INTO r FROM public.clientes WHERE id = v_id2;
  PERFORM pg_temp.t('update: rev = 2 (no 50) y created_by inmutable', r.rev = 2 AND r.created_by = pg_temp.uid(2));
END $$;

-- 4. El sello NO rompe al mecánico: el trigger de 4D corre antes (orden alfabético) y el sello después
DO $$
DECLARE v_c uuid; v_m uuid; v_o uuid; r record;
BEGIN
  INSERT INTO public.clientes (nombre) VALUES ('Cliente del taller') RETURNING id INTO v_c;
  INSERT INTO public.motos (cliente_id, marca, modelo) VALUES (v_c, 'Honda', 'CB190R') RETURNING id INTO v_m;
  INSERT INTO public.ordenes (cliente_id, moto_id, mecanico_id, mecanico, falla)
  VALUES (v_c, v_m, pg_temp.uid(3), 'Usuario 3', 'ruido') RETURNING id INTO v_o;

  PERFORM pg_temp.como(3);
  UPDATE public.ordenes SET estado = 'diagnostico', diagnostico = '{"notas":"ok"}' WHERE id = v_o;
  PERFORM pg_temp.fin();
  SELECT estado, rev, updated_by INTO r FROM public.ordenes WHERE id = v_o;
  PERFORM pg_temp.t('mecánico avanza su orden un peldaño (el sello no lo bloquea)', r.estado = 'diagnostico' AND r.rev = 2);
  PERFORM pg_temp.t('el sello registra al mecánico como updated_by', r.updated_by = pg_temp.uid(3));

  PERFORM pg_temp.como(3);
  PERFORM pg_temp.falla('mecánico NO puede finalizar/cobrar (trigger 4D intacto)', 'UPDATE public.ordenes SET finalizada = true WHERE id = ''' || v_o || '''', 'solo puede actualizar el avance');
  PERFORM pg_temp.falla('mecánico NO puede falsear rev', 'UPDATE public.ordenes SET rev = 99 WHERE id = ''' || v_o || '''', 'solo puede actualizar el avance');
  PERFORM pg_temp.falla('mecánico NO puede saltar etapas', 'UPDATE public.ordenes SET estado = ''calidad'' WHERE id = ''' || v_o || '''', 'una etapa a la vez');
  PERFORM pg_temp.fin();
END $$;

-- 5. Ledger de inventario
DO $$
DECLARE v_i uuid; r record; v_op uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.inventario (nombre, precio_venta, costo_compra) VALUES ('Aceite 20W-50', 180, 110) RETURNING id INTO v_i;
  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad, motivo) VALUES (v_i, 'apertura', 10, 'stock inicial');
  SELECT cantidad, requiere_revision INTO r FROM public.inventario WHERE id = v_i;
  PERFORM pg_temp.t('apertura +10 → cantidad 10 sin revisión', r.cantidad = 10 AND NOT r.requiere_revision);

  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad, op_id) VALUES (v_i, 'venta', -4, v_op);
  SELECT cantidad INTO r FROM public.inventario WHERE id = v_i;
  PERFORM pg_temp.t('venta −4 → cantidad 6', r.cantidad = 6);
  PERFORM pg_temp.t('saldo_despues queda registrado en el movimiento',
    (SELECT saldo_despues FROM public.inventario_movimientos WHERE op_id = v_op AND inventario_id = v_i) = 6);

  PERFORM pg_temp.falla('mismo op_id + producto + tipo NO se aplica dos veces',
    format('INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad, op_id) VALUES (%L, ''venta'', -4, %L)', v_i, v_op),
    'duplicate key');
  SELECT cantidad INTO r FROM public.inventario WHERE id = v_i;
  PERFORM pg_temp.t('el intento repetido no descontó stock', r.cantidad = 6);

  -- D-3: venta offline que deja el stock negativo: se conserva y se marca para revisión, sin recortar a cero
  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad, capturada_offline) VALUES (v_i, 'venta', -10, true);
  SELECT cantidad, requiere_revision, revision_motivo, revision_desde INTO r FROM public.inventario WHERE id = v_i;
  PERFORM pg_temp.t('D-3: stock −4 conservado (no se recorta a cero)', r.cantidad = -4);
  PERFORM pg_temp.t('D-3: inventario marcado requiere_revision con motivo y fecha', r.requiere_revision AND r.revision_motivo LIKE 'Stock negativo%' AND r.revision_desde IS NOT NULL);
  PERFORM pg_temp.t('D-3: el movimiento también queda marcado', (SELECT requiere_revision FROM public.inventario_movimientos WHERE capturada_offline AND inventario_id = v_i));
  PERFORM pg_temp.t('invariante: cantidad = suma del ledger',
    (SELECT cantidad FROM public.inventario WHERE id = v_i) = (SELECT sum(cantidad) FROM public.inventario_movimientos WHERE inventario_id = v_i));

  PERFORM pg_temp.falla('un movimiento de cantidad 0 se rechaza', format('INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES (%L, ''ajuste'', 0)', v_i), 'check');
  PERFORM pg_temp.falla('movimiento de un repuesto inexistente se rechaza', 'INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES (gen_random_uuid(), ''ajuste'', 1)', 'foreign key|no existe');
END $$;

-- 6. Fotos: nada de base64 en tablas
DO $$
DECLARE v_c uuid; v_m uuid;
BEGIN
  INSERT INTO public.clientes (nombre) VALUES ('Cliente fotos') RETURNING id INTO v_c;
  INSERT INTO public.motos (cliente_id, marca) VALUES (v_c, 'Suzuki') RETURNING id INTO v_m;
  PERFORM pg_temp.falla('ordenes.fotos rechaza un data:URL base64',
    format('INSERT INTO public.ordenes (cliente_id, moto_id, fotos) VALUES (%L, %L, %L::jsonb)', v_c, v_m, '["data:image/jpeg;base64,/9j/4AAQ"]'), 'fotos_sin_base64');
  INSERT INTO public.ordenes (cliente_id, moto_id, fotos) VALUES (v_c, v_m, '["ordenes/abc/1.jpg"]');
  PERFORM pg_temp.t('ordenes.fotos acepta rutas de Storage', EXISTS (SELECT 1 FROM public.ordenes WHERE moto_id = v_m AND fotos->>0 = 'ordenes/abc/1.jpg'));
  PERFORM pg_temp.falla('motos.foto_path rechaza base64', format('UPDATE public.motos SET foto_path = ''data:image/png;base64,AAA'' WHERE id = %L', v_m), 'foto_path_sin_base64');
  PERFORM pg_temp.falla('inventario.foto_url rechaza base64', 'INSERT INTO public.inventario (nombre, foto_url) VALUES (''x'', ''data:image/png;base64,AAA'')', 'foto_sin_base64');
END $$;

-- 7. Importación: un solo lote aplicado
DO $$
DECLARE v_h text := repeat('a', 64); v_l uuid;
BEGIN
  INSERT INTO public.import_lotes (legacy_device_id, backup_sha256, estado, creado_por) VALUES ('origen-cliente', v_h, 'aplicado', pg_temp.uid(1)) RETURNING id INTO v_l;
  PERFORM pg_temp.falla('un segundo lote aplicado se rechaza en la base',
    format('INSERT INTO public.import_lotes (legacy_device_id, backup_sha256, estado, creado_por) VALUES (''otro'', %L, ''aplicado'', %L)', v_h, pg_temp.uid(1)), 'un_aplicado');
  PERFORM pg_temp.falla('un lote confirmado tampoco convive con uno aplicado',
    format('INSERT INTO public.import_lotes (legacy_device_id, backup_sha256, estado, creado_por) VALUES (''otro'', %L, ''confirmado'', %L)', v_h, pg_temp.uid(1)), 'un_aplicado');
  UPDATE public.import_lotes SET estado = 'revertido', revertido_en = now() WHERE id = v_l;
  INSERT INTO public.import_lotes (legacy_device_id, backup_sha256, estado, creado_por) VALUES ('origen-cliente', v_h, 'aplicado', pg_temp.uid(1));
  PERFORM pg_temp.t('tras revertir, se puede aplicar un nuevo lote', true);
  PERFORM pg_temp.falla('backup_sha256 debe ser un SHA-256 hexadecimal',
    format('INSERT INTO public.import_lotes (legacy_device_id, backup_sha256, creado_por) VALUES (''x'', ''zzz'', %L)', pg_temp.uid(1)), 'check');
  PERFORM pg_temp.falla('D-5: un nombre legado sin perfil ni «sin asignar» se rechaza',
    format('INSERT INTO public.import_mapeo_mecanicos (lote_id, nombre_legado, decidido_por) VALUES (%L, ''Mecánico 1'', %L)', v_l, pg_temp.uid(1)), 'check');
  INSERT INTO public.import_mapeo_mecanicos (lote_id, nombre_legado, sin_asignar, decidido_por) VALUES (v_l, 'Mecánico 1', true, pg_temp.uid(1));
  INSERT INTO public.import_mapeo_mecanicos (lote_id, nombre_legado, perfil_id, decidido_por) VALUES (v_l, 'Wilkin', pg_temp.uid(1), pg_temp.uid(1));
  PERFORM pg_temp.t('D-5: mapeo explícito (perfil real o sin asignar) se guarda', (SELECT count(*) FROM public.import_mapeo_mecanicos WHERE lote_id = v_l) = 2);
END $$;

-- 8. Reversos: el original se conserva; una anulación total por registro
DO $$
DECLARE v_r uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.reversos (tipo, entidad, registro_id, motivo, solicitado_por, actuo_como_admin, operation_id)
  VALUES ('venta', 'ventas', v_r, 'error de precio', pg_temp.uid(1), true, gen_random_uuid());
  PERFORM pg_temp.falla('una venta no se anula dos veces (índice parcial)',
    format('INSERT INTO public.reversos (tipo, entidad, registro_id, motivo, solicitado_por, actuo_como_admin, operation_id) VALUES (''venta'', ''ventas'', %L, ''otra vez'', %L, true, gen_random_uuid())', v_r, pg_temp.uid(1)), 'unico_total');
  INSERT INTO public.reversos (tipo, entidad, registro_id, motivo, solicitado_por, actuo_como_admin, operation_id) VALUES ('devolucion', 'ventas', v_r, 'devuelve 1', pg_temp.uid(1), true, gen_random_uuid());
  INSERT INTO public.reversos (tipo, entidad, registro_id, motivo, solicitado_por, actuo_como_admin, operation_id) VALUES ('devolucion', 'ventas', v_r, 'devuelve otra', pg_temp.uid(1), true, gen_random_uuid());
  PERFORM pg_temp.t('devoluciones parciales múltiples sí se permiten', (SELECT count(*) FROM public.reversos WHERE registro_id = v_r AND tipo = 'devolucion') = 2);
  PERFORM pg_temp.falla('un motivo vacío se rechaza',
    format('INSERT INTO public.reversos (tipo, entidad, registro_id, motivo, solicitado_por, actuo_como_admin, operation_id) VALUES (''caja'', ''caja_movimientos'', gen_random_uuid(), '' '', %L, true, gen_random_uuid())', pg_temp.uid(1)), 'check');
  PERFORM pg_temp.falla('un reverso sin autorizador ni acción propia del admin se rechaza',
    format('INSERT INTO public.reversos (tipo, entidad, registro_id, motivo, solicitado_por, operation_id) VALUES (''caja'', ''caja_movimientos'', gen_random_uuid(), ''motivo'', %L, gen_random_uuid())', pg_temp.uid(2)), 'check');
  PERFORM pg_temp.falla('operation_id repetido en reversos se rechaza',
    format('INSERT INTO public.reversos (tipo, entidad, registro_id, motivo, solicitado_por, actuo_como_admin, operation_id) SELECT ''caja'', ''caja_movimientos'', gen_random_uuid(), ''motivo'', %L, true, operation_id FROM public.reversos LIMIT 1', pg_temp.uid(1)), 'duplicate key');
END $$;

-- 9. Los roles de la app no ven las tablas sensibles nuevas (ni con RLS: no tienen ni el privilegio)
DO $$
BEGIN
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('el cajero no puede leer admin_pin', 'SELECT * FROM public.admin_pin', 'permission denied');
  PERFORM pg_temp.falla('el cajero no puede leer sync_ops', 'SELECT * FROM public.sync_ops', 'permission denied');
  PERFORM pg_temp.falla('el cajero no puede insertar en el ledger', 'INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES (gen_random_uuid(), ''ajuste'', 1)', 'permission denied');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(3);
  PERFORM pg_temp.falla('el mecánico no puede leer autorizaciones_admin', 'SELECT * FROM public.autorizaciones_admin', 'permission denied');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(0);
  PERFORM pg_temp.falla('anon no puede leer reversos', 'SELECT * FROM public.reversos', 'permission denied');
  PERFORM pg_temp.fin();
END $$;
