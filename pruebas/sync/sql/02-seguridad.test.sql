-- SYNC-2 · pruebas de seguridad por rol. Requiere 00-prelude.sql, sync-1 y sync-2 aplicados.
-- Cuentas: 1 admin · 2 cajero · 3 mecánico A · 4 mecánico B · 5 desarrollador · 6 mecánico INACTIVO
-- Datos: 101 cliente · 102 moto · 103 orden de A · 104 orden de B · 110 orden del inactivo · 105 repuesto · 106 venta · 107 crédito · 108 abono · 109 caja

-- SEMILLA (como superusuario, con los triggers activos) ---------------------------------------------------------
DO $$
BEGIN
  INSERT INTO public.clientes (id, nombre, telefono) VALUES (pg_temp.id(101), 'Cliente Uno', '9999');
  INSERT INTO public.motos (id, cliente_id, marca, modelo) VALUES (pg_temp.id(102), pg_temp.id(101), 'Honda', 'CB190R');
  INSERT INTO public.ordenes (id, cliente_id, moto_id, mecanico_id, mecanico, falla, margen, tipo_cobro, metodo_pago)
  VALUES (pg_temp.id(103), pg_temp.id(101), pg_temp.id(102), pg_temp.uid(3), 'Usuario 3', 'ruido', 42.5, 'contado', 'efectivo'),
         (pg_temp.id(104), pg_temp.id(101), pg_temp.id(102), pg_temp.uid(4), 'Usuario 4', 'frenos', 10, 'credito', NULL),
         (pg_temp.id(110), pg_temp.id(101), pg_temp.id(102), pg_temp.uid(6), 'Usuario 6', 'luces', NULL, NULL, NULL);
  INSERT INTO public.citas (id, cliente_id, fecha, hora, mecanico_id) VALUES (pg_temp.id(112), pg_temp.id(101), current_date, '10:00', pg_temp.uid(3));
  INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES (pg_temp.id(105), 'Aceite', 180, 110);
  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES (pg_temp.id(105), 'apertura', 10);
  INSERT INTO public.ventas (id, cliente_id, metodo_pago, total) VALUES (pg_temp.id(106), pg_temp.id(101), 'efectivo', 360);
  INSERT INTO public.venta_items (venta_id, inventario_id, nombre, cantidad, precio) VALUES (pg_temp.id(106), pg_temp.id(105), 'Aceite', 2, 180);
  INSERT INTO public.caja_movimientos (id, tipo, categoria, monto, venta_id) VALUES (pg_temp.id(109), 'ingreso', 'Venta mostrador', 360, pg_temp.id(106));
  INSERT INTO public.creditos (id, cliente_id, cliente_nombre, total, abonado, saldo) VALUES (pg_temp.id(107), pg_temp.id(101), 'Cliente Uno', 100, 0, 100);
  INSERT INTO public.abonos (id, id_abono, credito_id, monto, metodo_pago) VALUES (pg_temp.id(108), 'AB-1', pg_temp.id(107), 10, 'efectivo');
  INSERT INTO storage.objects (bucket_id, name) VALUES
    ('entimotors-taller', 'ordenes/' || pg_temp.id(103) || '/a.jpg'), ('entimotors-taller', 'ordenes/' || pg_temp.id(104) || '/b.jpg'),
    ('entimotors-taller', 'motos/' || pg_temp.id(102) || '/c.jpg');
END $$;

-- A. LECTURA DE DINERO POR ROL ------------------------------------------------------------------------------------
DO $$
DECLARE n int; t text; r int;
BEGIN
  FOREACH t IN ARRAY ARRAY['ventas','venta_items','creditos','credito_items','abonos','caja_movimientos'] LOOP
    FOREACH r IN ARRAY ARRAY[1, 2] LOOP
      PERFORM pg_temp.como(r); EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n; PERFORM pg_temp.fin();
      IF t IN ('ventas','creditos','abonos','caja_movimientos','venta_items') THEN
        PERFORM pg_temp.t(format('%s: el %s lee el dinero', t, CASE r WHEN 1 THEN 'admin' ELSE 'cajero' END), n >= 1 OR t = 'credito_items');
      END IF;
    END LOOP;
    FOREACH r IN ARRAY ARRAY[3, 4, 5, 6] LOOP
      PERFORM pg_temp.como(r); EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n; PERFORM pg_temp.fin();
      PERFORM pg_temp.t(format('%s: usuario %s (mecánico/desarrollador/inactivo) ve 0 filas', t, r), n = 0);
    END LOOP;
    PERFORM pg_temp.como(0);
    PERFORM pg_temp.falla('anon no lee ' || t, format('SELECT count(*) FROM public.%I', t), 'permission denied');
    PERFORM pg_temp.fin();
  END LOOP;
END $$;

-- B. ESCRITURA DIRECTA DE DINERO: NADIE (ni admin ni cajero ni service_role) ---------------------------------------
DO $$
DECLARE r int;
BEGIN
  FOREACH r IN ARRAY ARRAY[1, 2] LOOP
    PERFORM pg_temp.como(r);
    PERFORM pg_temp.falla(format('usuario %s no inserta ventas directo', r), 'INSERT INTO public.ventas (metodo_pago, total) VALUES (''efectivo'', 1)', 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no inserta venta_items directo', r), format('INSERT INTO public.venta_items (venta_id, nombre, cantidad, precio) VALUES (%L, ''x'', 1, 1)', pg_temp.id(106)), 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no inserta créditos directo', r), 'INSERT INTO public.creditos (cliente_nombre, total, saldo) VALUES (''x'', 1, 1)', 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no inserta abonos directo', r), format('INSERT INTO public.abonos (id_abono, credito_id, monto, metodo_pago) VALUES (''X'', %L, 1, ''efectivo'')', pg_temp.id(107)), 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no inserta caja directo', r), 'INSERT INTO public.caja_movimientos (tipo, monto) VALUES (''ingreso'', 1)', 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no actualiza créditos directo (antes el cajero podía)', r), format('UPDATE public.creditos SET abonado = 100, saldo = 0 WHERE id = %L', pg_temp.id(107)), 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no edita ventas', r), format('UPDATE public.ventas SET total = 1 WHERE id = %L', pg_temp.id(106)), 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no edita caja', r), format('UPDATE public.caja_movimientos SET monto = 1 WHERE id = %L', pg_temp.id(109)), 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no borra ventas', r), format('DELETE FROM public.ventas WHERE id = %L', pg_temp.id(106)), 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no borra créditos', r), format('DELETE FROM public.creditos WHERE id = %L', pg_temp.id(107)), 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no borra caja', r), format('DELETE FROM public.caja_movimientos WHERE id = %L', pg_temp.id(109)), 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no borra abonos', r), format('DELETE FROM public.abonos WHERE id = %L', pg_temp.id(108)), 'permission denied');
    PERFORM pg_temp.falla(format('usuario %s no vacía ventas (TRUNCATE)', r), 'TRUNCATE public.ventas', 'permission denied');
    PERFORM pg_temp.fin();
  END LOOP;
  -- service_role: tampoco escribe dinero directo
  PERFORM set_config('role', 'service_role', true);
  PERFORM pg_temp.falla('service_role no borra ventas', format('DELETE FROM public.ventas WHERE id = %L', pg_temp.id(106)), 'permission denied');
  PERFORM pg_temp.falla('service_role no borra caja', format('DELETE FROM public.caja_movimientos WHERE id = %L', pg_temp.id(109)), 'permission denied');
  PERFORM pg_temp.falla('service_role no edita créditos', format('UPDATE public.creditos SET saldo = 0, abonado = 100 WHERE id = %L', pg_temp.id(107)), 'permission denied');
  PERFORM pg_temp.falla('service_role no inserta ventas', 'INSERT INTO public.ventas (metodo_pago, total) VALUES (''efectivo'', 1)', 'permission denied');
  PERFORM pg_temp.fin();
END $$;

-- C. EL TRIGGER PROTECTOR FRENA INCLUSO AL DUEÑO Y AL SUPERUSUARIO ---------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  PERFORM pg_temp.falla('superusuario no borra ventas', format('DELETE FROM public.ventas WHERE id = %L', pg_temp.id(106)), 'No se puede borrar físicamente en ventas');
  PERFORM pg_temp.falla('superusuario no borra venta_items', format('DELETE FROM public.venta_items WHERE venta_id = %L', pg_temp.id(106)), 'No se puede borrar físicamente');
  PERFORM pg_temp.falla('superusuario no borra caja', format('DELETE FROM public.caja_movimientos WHERE id = %L', pg_temp.id(109)), 'No se puede borrar');   -- frena antes el trigger de RCV-34 (caja ligada) o el nuestro: ambos empiezan igual
  PERFORM pg_temp.falla('superusuario no borra créditos', format('DELETE FROM public.creditos WHERE id = %L', pg_temp.id(107)), 'No se puede borrar físicamente');
  PERFORM pg_temp.falla('superusuario no borra abonos', format('DELETE FROM public.abonos WHERE id = %L', pg_temp.id(108)), 'No se puede borrar físicamente');
  PERFORM pg_temp.falla('superusuario no vacía ventas (TRUNCATE)', 'TRUNCATE public.ventas CASCADE', 'No se puede borrar físicamente');
  PERFORM pg_temp.falla('superusuario no vacía caja (TRUNCATE)', 'TRUNCATE public.caja_movimientos', 'No se puede borrar físicamente');
  PERFORM pg_temp.falla('superusuario no vacía el ledger', 'TRUNCATE public.inventario_movimientos', 'No se puede borrar físicamente');
  PERFORM set_config('role', 'postgres', true);
  PERFORM pg_temp.falla('el dueño de la tabla (postgres) no borra ventas', format('DELETE FROM public.ventas WHERE id = %L', pg_temp.id(106)), 'No se puede borrar físicamente');
  PERFORM pg_temp.falla('el dueño (postgres) no edita el total de una venta', format('UPDATE public.ventas SET total = 1 WHERE id = %L', pg_temp.id(106)), 'solo pueden cambiar');
  PERFORM pg_temp.falla('el dueño (postgres) no edita el monto de un abono', format('UPDATE public.abonos SET monto = 1 WHERE id = %L', pg_temp.id(108)), 'solo pueden cambiar');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.falla('caja es de solo agregar: no se edita', format('UPDATE public.caja_movimientos SET monto = 1 WHERE id = %L', pg_temp.id(109)), 'solo agregar');
  PERFORM pg_temp.falla('venta_items no se edita', format('UPDATE public.venta_items SET precio = 1 WHERE venta_id = %L', pg_temp.id(106)), 'solo agregar');
  PERFORM pg_temp.falla('el ledger no se edita', 'UPDATE public.inventario_movimientos SET cantidad = 99', 'solo agregar');
  PERFORM pg_temp.falla('el ledger no se borra', 'DELETE FROM public.inventario_movimientos', 'No se puede borrar físicamente');
  INSERT INTO public.sync_ops (op_id, kind, resultado) VALUES (pg_temp.id(130), 'prueba', '{}');
  INSERT INTO public.reversos (tipo, entidad, registro_id, motivo, solicitado_por, actuo_como_admin, operation_id)
  VALUES ('caja', 'caja_movimientos', pg_temp.id(109), 'motivo de prueba', pg_temp.uid(1), true, pg_temp.id(131));
  PERFORM pg_temp.falla('sync_ops no se borra', 'DELETE FROM public.sync_ops', 'No se puede borrar físicamente');
  PERFORM pg_temp.falla('sync_ops no se edita', 'UPDATE public.sync_ops SET kind = ''x''', 'solo agregar');
  PERFORM pg_temp.falla('los reversos no se editan', 'UPDATE public.reversos SET motivo = ''otro motivo''', 'solo agregar');
  PERFORM pg_temp.falla('los reversos no se borran', 'DELETE FROM public.reversos', 'No se puede borrar físicamente');
  -- lo que las RPC SÍ pueden cambiar (estado derivado) pasa la guardia
  UPDATE public.ventas SET anulada = true, anulada_en = now() WHERE id = pg_temp.id(106);
  UPDATE public.creditos SET abonado = 10, saldo = 90, estado = 'parcial' WHERE id = pg_temp.id(107);
  UPDATE public.abonos SET anulado = true, anulado_en = now() WHERE id = pg_temp.id(108);
  PERFORM pg_temp.t('la guardia deja pasar el estado derivado (anulada, saldo, anulado)',
    (SELECT anulada FROM public.ventas WHERE id = pg_temp.id(106)) AND (SELECT saldo FROM public.creditos WHERE id = pg_temp.id(107)) = 90);
  PERFORM pg_temp.t('el original se conserva tras anular', (SELECT total FROM public.ventas WHERE id = pg_temp.id(106)) = 360);
END $$;

-- D. ROLLBACK CONTROLADO DE IMPORTACIÓN: única puerta, solo antes de confirmar --------------------------------------
DO $$
DECLARE l uuid := gen_random_uuid(); v uuid := gen_random_uuid(); n int;
BEGIN
  INSERT INTO public.ventas (id, metodo_pago, total) VALUES (v, 'efectivo', 5);
  PERFORM pg_temp.falla('sin el permiso de rollback, no se borra', format('DELETE FROM public.ventas WHERE id = %L', v), 'No se puede borrar físicamente');
  INSERT INTO public.import_lotes (id, legacy_device_id, backup_sha256, estado, creado_por) VALUES (l, 'cliente', repeat('b', 64), 'aplicado', pg_temp.uid(1));
  PERFORM set_config('entimotors.rollback_lote', gen_random_uuid()::text, true);
  PERFORM pg_temp.falla('un lote inexistente no habilita el borrado', format('DELETE FROM public.ventas WHERE id = %L', v), 'No se puede borrar físicamente');
  PERFORM set_config('entimotors.rollback_lote', l::text, true);
  DELETE FROM public.ventas WHERE id = v;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.t('con lote APLICADO (no confirmado) el rollback puede borrar', n = 1);
  INSERT INTO public.ventas (id, metodo_pago, total) VALUES (v, 'efectivo', 5);
  UPDATE public.import_lotes SET estado = 'confirmado', confirmado_en = now() WHERE id = l;
  PERFORM pg_temp.falla('con el lote CONFIRMADO el rollback ya no puede borrar', format('DELETE FROM public.ventas WHERE id = %L', v), 'No se puede borrar físicamente');
  PERFORM set_config('entimotors.rollback_lote', '', true);
  PERFORM pg_temp.falla('TRUNCATE no tiene excepción ni con lote válido', 'TRUNCATE public.ventas CASCADE', 'No se puede borrar físicamente');
END $$;

-- E. MAESTROS: sin borrado físico; borrado suave solo admin y con autor real ------------------------------------------
DO $$
DECLARE r record; n int;
BEGIN
  PERFORM pg_temp.como(1);
  PERFORM pg_temp.falla('admin no borra clientes (permiso)', format('DELETE FROM public.clientes WHERE id = %L', pg_temp.id(101)), 'permission denied');
  PERFORM pg_temp.falla('admin no borra órdenes (permiso)', format('DELETE FROM public.ordenes WHERE id = %L', pg_temp.id(103)), 'permission denied');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.falla('superusuario no borra clientes: usa borrado suave', format('DELETE FROM public.clientes WHERE id = %L', pg_temp.id(101)), 'borrado suave');
  PERFORM pg_temp.falla('superusuario no borra inventario: usa borrado suave', format('DELETE FROM public.inventario WHERE id = %L', pg_temp.id(105)), 'borrado suave');

  INSERT INTO public.clientes (id, nombre) VALUES (pg_temp.id(120), 'Para borrar');
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('el cajero no puede borrar (suave) un cliente', format('UPDATE public.clientes SET deleted_at = now() WHERE id = %L', pg_temp.id(120)), 'Solo el administrador');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(1);
  UPDATE public.clientes SET deleted_at = now(), deleted_by = pg_temp.uid(2) WHERE id = pg_temp.id(120);
  PERFORM pg_temp.fin();
  SELECT deleted_at, deleted_by INTO r FROM public.clientes WHERE id = pg_temp.id(120);
  PERFORM pg_temp.t('el admin borra (suave) y deleted_by lo pone el servidor (no el que envió el cliente)', r.deleted_at IS NOT NULL AND r.deleted_by = pg_temp.uid(1));
  PERFORM pg_temp.como(1);
  UPDATE public.clientes SET deleted_at = NULL WHERE id = pg_temp.id(120);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('el admin restaura y se limpia deleted_by', (SELECT deleted_by IS NULL AND deleted_at IS NULL FROM public.clientes WHERE id = pg_temp.id(120)));

  -- órdenes: finalización, margen, crédito, anulación y borrado NO son escribibles por ningún cliente
  PERFORM pg_temp.como(1);
  PERFORM pg_temp.falla('admin no marca finalizada directo (es de la RPC)', format('UPDATE public.ordenes SET finalizada = true WHERE id = %L', pg_temp.id(103)), 'permission denied');
  PERFORM pg_temp.falla('admin no fija margen directo', format('UPDATE public.ordenes SET margen = 99 WHERE id = %L', pg_temp.id(103)), 'permission denied');
  PERFORM pg_temp.falla('admin no anula una orden directo', format('UPDATE public.ordenes SET anulada = true WHERE id = %L', pg_temp.id(103)), 'permission denied');
  PERFORM pg_temp.falla('admin no borra (suave) una orden directo: va por RPC', format('UPDATE public.ordenes SET deleted_at = now() WHERE id = %L', pg_temp.id(103)), 'permission denied');
  UPDATE public.ordenes SET falla = 'ruido en la cadena' WHERE id = pg_temp.id(103);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.t('admin sí edita los datos de la orden', n = 1);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(2);
  UPDATE public.ordenes SET falla = 'editada por caja' WHERE id = pg_temp.id(104);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.t('cajero sí edita los datos de la orden', n = 1);
  PERFORM pg_temp.falla('cajero no puede escribir en orden_items directo', format('INSERT INTO public.orden_items (orden_id, nombre, cantidad, precio) VALUES (%L, ''x'', 1, 1)', pg_temp.id(103)), 'permission denied');
  PERFORM pg_temp.fin();
END $$;

-- F. INVENTARIO: maestro solo admin; cantidad solo por ledger --------------------------------------------------------
DO $$
DECLARE n int; c numeric;
BEGIN
  PERFORM pg_temp.como(1);
  INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES (pg_temp.id(121), 'Bujía', 50, 30);
  PERFORM pg_temp.t('admin crea productos del maestro', EXISTS (SELECT 1 FROM public.inventario WHERE id = pg_temp.id(121)));
  PERFORM pg_temp.falla('admin no fija cantidad al crear (D-4: solo ledger)', 'INSERT INTO public.inventario (nombre, cantidad) VALUES (''x'', 50)', 'permission denied');
  PERFORM pg_temp.falla('admin no cambia cantidad directo', format('UPDATE public.inventario SET cantidad = 999 WHERE id = %L', pg_temp.id(105)), 'permission denied');
  PERFORM pg_temp.falla('admin no limpia requiere_revision directo', format('UPDATE public.inventario SET requiere_revision = false WHERE id = %L', pg_temp.id(105)), 'permission denied');
  UPDATE public.inventario SET precio_venta = 200, costo_compra = 120 WHERE id = pg_temp.id(105);
  PERFORM pg_temp.t('admin edita precio y costo', (SELECT precio_venta FROM public.inventario WHERE id = pg_temp.id(105)) = 200);
  PERFORM pg_temp.fin();
  SELECT cantidad INTO c FROM public.inventario WHERE id = pg_temp.id(105);
  PERFORM pg_temp.t('la cantidad sigue siendo la del ledger', c = 10);

  PERFORM pg_temp.como(2);
  SELECT count(*) INTO n FROM public.inventario;
  PERFORM pg_temp.t('cajero consulta el inventario', n >= 2);
  PERFORM pg_temp.falla('cajero no crea productos (D-4)', 'INSERT INTO public.inventario (nombre, precio_venta) VALUES (''x'', 1)', 'row-level security');
  UPDATE public.inventario SET precio_venta = 1, costo_compra = 0 WHERE id = pg_temp.id(105);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.t('cajero no modifica precios ni costos (0 filas)', n = 0);
  PERFORM pg_temp.falla('cajero no cambia cantidad (D-4)', format('UPDATE public.inventario SET cantidad = 999 WHERE id = %L', pg_temp.id(105)), 'permission denied');
  PERFORM pg_temp.falla('cajero no crea categorías', 'INSERT INTO public.categorias_inv (nombre) VALUES (''x'')', 'row-level security');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(1);
  INSERT INTO public.categorias_inv (nombre) VALUES ('Frenos');
  PERFORM pg_temp.t('admin crea categorías', EXISTS (SELECT 1 FROM public.categorias_inv WHERE nombre = 'Frenos'));
  PERFORM pg_temp.fin();
END $$;

-- G. MECÁNICO: ninguna lectura directa de datos del taller ni de dinero; sin escalación ---------------------------
DO $$
DECLARE n int; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ordenes','orden_items','citas','clientes','motos','cotizaciones','cotizacion_items','inventario','categorias_inv','auditoria'] LOOP
    PERFORM pg_temp.como(3); EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n; PERFORM pg_temp.fin();
    PERFORM pg_temp.t(format('mecánico A ve 0 filas en %s (acceso solo por RPC)', t), n = 0);
  END LOOP;
  PERFORM pg_temp.como(3);
  SELECT count(*) INTO n FROM public.ordenes WHERE id = pg_temp.id(103);
  PERFORM pg_temp.t('mecánico A no lee ni su propia orden (margen/cobro no expuestos)', n = 0);
  UPDATE public.ordenes SET estado = 'diagnostico' WHERE id = pg_temp.id(103);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.t('mecánico A no actualiza órdenes directo (0 filas; ira por RPC)', n = 0);
  PERFORM pg_temp.falla('mecánico no crea órdenes', 'INSERT INTO public.ordenes (mecanico_id) VALUES (NULL)', 'row-level security|permission denied');
  PERFORM pg_temp.falla('mecánico no crea clientes', 'INSERT INTO public.clientes (nombre) VALUES (''x'')', 'row-level security');
  UPDATE public.perfiles SET rol = 'admin' WHERE id = pg_temp.uid(3);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.t('mecánico no se eleva a admin (RLS: 0 filas)', n = 0);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(2);
  UPDATE public.perfiles SET rol = 'admin' WHERE id = pg_temp.uid(2);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.t('cajero no se eleva a admin (RLS: 0 filas)', n = 0);
  UPDATE public.perfiles SET nombre = 'hack', activo = true WHERE id = pg_temp.uid(3);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.t('cajero no edita ni reactiva perfiles ajenos (RLS: 0 filas)', n = 0);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('ningún perfil cambió de rol', (SELECT rol FROM public.perfiles WHERE id = pg_temp.uid(3)) = 'mecanico' AND (SELECT rol FROM public.perfiles WHERE id = pg_temp.uid(2)) = 'cajero');
  PERFORM pg_temp.como(5);
  SELECT count(*) INTO n FROM public.clientes;
  PERFORM pg_temp.t('desarrollador ve 0 clientes (privacidad)', n = 0);
  PERFORM pg_temp.fin();
  -- admin y cajero sí ven las órdenes completas
  PERFORM pg_temp.como(1); SELECT count(*) INTO n FROM public.ordenes; PERFORM pg_temp.fin();
  PERFORM pg_temp.t('admin ve todas las órdenes', n >= 3);
  PERFORM pg_temp.como(2); SELECT count(*) INTO n FROM public.ordenes; PERFORM pg_temp.fin();
  PERFORM pg_temp.t('cajero ve todas las órdenes', n >= 3);
END $$;

-- H. AUDITORÍA: solo agregar, identidad real ------------------------------------------------------------------------
DO $$
DECLARE r record; n int;
BEGIN
  PERFORM pg_temp.como(2);
  INSERT INTO public.auditoria (accion, entidad, entidad_id, detalle, device_id) VALUES ('venta', 'ventas', 'x', 'prueba', 'dev-1');
  PERFORM pg_temp.falla('cajero no firma como otro usuario', format('INSERT INTO public.auditoria (usuario_id, accion, entidad) VALUES (%L, ''a'', ''b'')', pg_temp.uid(1)), 'permission denied');
  PERFORM pg_temp.falla('cajero no se atribuye otro rol', 'INSERT INTO public.auditoria (rol, accion, entidad) VALUES (''admin'', ''a'', ''b'')', 'permission denied');
  PERFORM pg_temp.falla('cajero no escribe autorizado_por', format('INSERT INTO public.auditoria (autorizado_por, accion, entidad) VALUES (%L, ''a'', ''b'')', pg_temp.uid(1)), 'permission denied');
  SELECT count(*) INTO n FROM public.auditoria;
  PERFORM pg_temp.t('cajero no lee la auditoría', n = 0);
  PERFORM pg_temp.falla('cajero no edita la auditoría', 'UPDATE public.auditoria SET detalle = ''x''', 'permission denied');
  PERFORM pg_temp.falla('cajero no borra la auditoría', 'DELETE FROM public.auditoria', 'permission denied');
  PERFORM pg_temp.fin();
  SELECT usuario_id, rol, usuario, device_id INTO r FROM public.auditoria WHERE detalle = 'prueba';
  PERFORM pg_temp.t('la auditoría sella usuario, rol y nombre reales', r.usuario_id = pg_temp.uid(2) AND r.rol = 'cajero' AND r.usuario = 'Usuario 2' AND r.device_id = 'dev-1');
  PERFORM pg_temp.como(1); SELECT count(*) INTO n FROM public.auditoria; PERFORM pg_temp.fin();
  PERFORM pg_temp.t('el admin sí lee la auditoría', n >= 1);
  PERFORM pg_temp.como(5);
  PERFORM pg_temp.falla('el desarrollador no escribe auditoría', 'INSERT INTO public.auditoria (accion, entidad) VALUES (''a'', ''b'')', 'row-level security');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(6);
  PERFORM pg_temp.falla('un mecánico INACTIVO no escribe auditoría', 'INSERT INTO public.auditoria (accion, entidad) VALUES (''a'', ''b'')', 'row-level security');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.falla('ni el superusuario edita la auditoría', 'UPDATE public.auditoria SET detalle = ''x''', 'solo agregar');
  PERFORM pg_temp.falla('ni el superusuario borra la auditoría', 'DELETE FROM public.auditoria', 'No se puede borrar físicamente');
END $$;

-- I. STORAGE: rutas <entidad>/<registro_uuid>/<archivo>; mecánico solo órdenes asignadas y activas ---------------------
DO $$
DECLARE n int;
  o3 text := pg_temp.id(103)::text; o4 text := pg_temp.id(104)::text; o10 text := pg_temp.id(110)::text; m2 text := pg_temp.id(102)::text;
BEGIN
  PERFORM pg_temp.como(1);
  INSERT INTO storage.objects (bucket_id, name) VALUES ('entimotors-taller', 'motos/' || gen_random_uuid() || '/a.jpg');
  INSERT INTO storage.objects (bucket_id, name) VALUES ('entimotors-taller', 'inventario/' || gen_random_uuid() || '/a.jpg');
  INSERT INTO storage.objects (bucket_id, name) VALUES ('entimotors-taller', 'ordenes/' || o3 || '/adm.jpg');
  PERFORM pg_temp.t('admin sube fotos de motos, inventario y órdenes', true);
  PERFORM pg_temp.falla('admin: entidad no permitida', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''entimotors-taller'', ''perfiles/'' || gen_random_uuid() || ''/a.jpg'')', 'row-level security');
  PERFORM pg_temp.falla('admin: ruta sin registro (profundidad 1)', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''entimotors-taller'', ''a.jpg'')', 'row-level security');
  PERFORM pg_temp.falla('admin: ruta demasiado profunda', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''entimotors-taller'', ''motos/'' || gen_random_uuid() || ''/x/a.jpg'')', 'row-level security');
  PERFORM pg_temp.falla('admin: otro bucket sin política', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''entimotors-media'', ''motos/'' || gen_random_uuid() || ''/a.jpg'')', 'row-level security');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(2);
  INSERT INTO storage.objects (bucket_id, name) VALUES ('entimotors-taller', 'motos/' || m2 || '/caja.jpg');
  PERFORM pg_temp.t('cajero sube fotos del taller', true);
  PERFORM pg_temp.fin();

  PERFORM pg_temp.como(3);
  INSERT INTO storage.objects (bucket_id, name) VALUES ('entimotors-taller', 'ordenes/' || o3 || '/mecA.jpg');
  PERFORM pg_temp.t('mecánico A sube foto de SU orden asignada', true);
  PERFORM pg_temp.falla('mecánico A no sube foto de la orden de B', format('INSERT INTO storage.objects (bucket_id, name) VALUES (''entimotors-taller'', %L)', 'ordenes/' || o4 || '/x.jpg'), 'row-level security');
  PERFORM pg_temp.falla('mecánico A no sube fotos de motos', format('INSERT INTO storage.objects (bucket_id, name) VALUES (''entimotors-taller'', %L)', 'motos/' || m2 || '/x.jpg'), 'row-level security');
  PERFORM pg_temp.falla('mecánico A no sube con id que no es uuid', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''entimotors-taller'', ''ordenes/no-es-uuid/x.jpg'')', 'row-level security');
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'entimotors-taller';
  PERFORM pg_temp.t('mecánico A solo ve las fotos de su orden (a.jpg, adm.jpg, mecA.jpg = 3)', n = 3);
  SELECT count(*) INTO n FROM storage.objects WHERE name LIKE 'ordenes/' || o4 || '%' OR name LIKE 'motos/%';
  PERFORM pg_temp.t('mecánico A no ve fotos de otra orden ni de motos', n = 0);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(4);
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'entimotors-taller';
  PERFORM pg_temp.t('mecánico B solo ve las fotos de su orden (b.jpg = 1)', n = 1);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(6);
  PERFORM pg_temp.falla('mecánico INACTIVO no sube fotos aunque tenga la orden asignada', format('INSERT INTO storage.objects (bucket_id, name) VALUES (''entimotors-taller'', %L)', 'ordenes/' || o10 || '/x.jpg'), 'row-level security');
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'entimotors-taller';
  PERFORM pg_temp.t('mecánico INACTIVO no ve ninguna foto', n = 0);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(5);
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'entimotors-taller';
  PERFORM pg_temp.t('el desarrollador no ve fotos', n = 0);
  PERFORM pg_temp.falla('el desarrollador no sube fotos', format('INSERT INTO storage.objects (bucket_id, name) VALUES (''entimotors-taller'', %L)', 'motos/' || m2 || '/x.jpg'), 'row-level security');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(0);
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'entimotors-taller';
  PERFORM pg_temp.t('anon no ve fotos', n = 0);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(1); SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'entimotors-taller'; PERFORM pg_temp.fin();
  PERFORM pg_temp.t('admin ve todas las fotos', n >= 6);
  -- la orden se entrega: el mecánico pierde el acceso a sus fotos y no puede subir más
  UPDATE public.ordenes SET estado = 'entregado' WHERE id = pg_temp.id(103);
  PERFORM pg_temp.como(3);
  PERFORM pg_temp.falla('mecánico no sube fotos de una orden ya entregada', format('INSERT INTO storage.objects (bucket_id, name) VALUES (''entimotors-taller'', %L)', 'ordenes/' || o3 || '/tarde.jpg'), 'row-level security');
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'entimotors-taller';
  PERFORM pg_temp.t('mecánico no ve fotos de una orden entregada', n = 0);
  PERFORM pg_temp.fin();
END $$;

-- J. PRIVILEGIOS GENERALES Y FUNCIONES -----------------------------------------------------------------------------
DO $$
DECLARE t text; k record; n int := 0; malos text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['perfiles','categorias_inv','clientes','motos','inventario','ordenes','orden_items','cotizaciones','cotizacion_items','citas','ventas','venta_items','creditos','credito_items','abonos','caja_movimientos','web_cms','auditoria'] LOOP
    IF has_table_privilege('authenticated', 'public.' || t, 'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') THEN malos := malos || t || ' '; END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN malos := malos || 'anon:' || t || ' '; END IF;
  END LOOP;
  PERFORM pg_temp.t('authenticated sin TRUNCATE/REFERENCES/TRIGGER/MAINTAIN y anon sin nada en las 18 tablas (' || malos || ')', malos = '');
  FOR k IN SELECT * FROM (VALUES
    ('rol_actual','e66ee46e01d3df511ee5bd4d0f2a178a'),('es_admin','35aa9a08ef4e9960cb333eea4939d15e'),('puede_cobrar','2c95d9a820de4ae25ec59d25cbbd1a91'),
    ('es_equipo','635c8361317be3293aee3778a0de048d'),('es_desarrollador','25a3787ce375a9a89a58266b96b732a3'),('es_mecanico_activo','1b786deb21df29b40f89dca23ab776fd'),
    ('ve_todo_el_taller','80b7f166927d6559301d8507c397a243'),('mi_cliente','aeee991cda291df054c2924d1e9f3cdf'),('mi_moto','235499aeafbd8379d6333b7e51edb6c2'),
    ('crear_perfil_al_registrarse','f3873b6473a2831c8046a29b97947ea3'),('proteger_caja_ligada','4b1a0e352c4eae22efcbb139ae72a725'),('proteger_rol_perfil','5bcd1237d7e6714293cf4fc332e08667'),
    ('mecanico_solo_avance_tecnico','5c9d8db5084b0a4e881948d9a920462b'),('registrar_venta','ae8ee6c6d7c066d4d544ff4e9ab5147b'),('registrar_abono','6dee1802d5cf45cd4d8d91b140e2cadd'),
    ('estadisticas_tecnicas','86948fdcaf03939a1d0929004cd9c730'),('estado_tecnico','8cab17a837ec35d46c8575befd53e85a')) AS v(f, m) LOOP
    IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = k.f AND md5(prosrc) = k.m) THEN n := n + 1; END IF;
  END LOOP;
  PERFORM pg_temp.t('las 17 funciones de RCV-34 conservan su md5', n = 17);
  PERFORM pg_temp.t('las funciones nuevas no son ejecutables por PUBLIC ni anon',
    NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('sync_guardia','sync_sellar_borrado','sync_auditoria_sellar','mecanico_asignado_a_orden','sync_sellar','sync_ledger_aplicar')
                  AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))));
END $$;
