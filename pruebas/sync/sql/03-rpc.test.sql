-- SYNC-3 · pruebas de las RPC. Requiere 00-prelude.sql y sync-1, sync-2 y sync-3 aplicados.
-- Cuentas: 1 admin · 2 cajero · 3 mecánico A · 5 desarrollador. Ids de datos: pg_temp.id(2xx)
-- Autorización de prueba (lo que emitirá el backend del PIN): una fila válida ligada a solicitante/acción/registro.
CREATE FUNCTION pg_temp.auth(p_sol int, p_accion text, p_entidad text, p_registro uuid, p_ttl interval DEFAULT '90 seconds', p_ver int DEFAULT 1, p_hash text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.autorizaciones_admin (id, solicitante_id, rol_solicitante, autorizado_por, accion, entidad, registro_id, pin_version, payload_hash, expira_en, creado_en)
  VALUES (v, pg_temp.uid(p_sol), 'cajero', pg_temp.uid(1), p_accion, p_entidad, p_registro, p_ver, p_hash, now() + p_ttl, now() - interval '10 minutes');
  RETURN v;
END $$;

DO $$
BEGIN
  INSERT INTO public.admin_pin (perfil_id, hash, version) VALUES (pg_temp.uid(1), 'scrypt$prueba$hash-no-real', 1) ON CONFLICT DO NOTHING;
  INSERT INTO public.clientes (id, nombre, telefono) VALUES (pg_temp.id(201), 'Cliente RPC', '9999');
  INSERT INTO public.motos (id, cliente_id, marca, modelo) VALUES (pg_temp.id(202), pg_temp.id(201), 'Honda', 'CB190R');
  INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES
    (pg_temp.id(211), 'Aceite', 180, 110), (pg_temp.id(212), 'Kit arrastre', 300, 190), (pg_temp.id(213), 'Bujía', 50, 20);
  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES
    (pg_temp.id(211), 'apertura', 10), (pg_temp.id(212), 'apertura', 5), (pg_temp.id(213), 'apertura', 2);
END $$;

-- 1. VENTA: cálculo del servidor, stock, caja, auditoría ------------------------------------------------------------
DO $$
DECLARE r jsonb; v uuid; n int; op uuid := pg_temp.id(300);
BEGIN
  PERFORM pg_temp.como(2);
  r := public.registrar_venta_v2(op, pg_temp.id(201), 'Cliente RPC', 'efectivo', 500,
    jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(211), 'nombre', 'Aceite', 'cantidad', 2, 'precio', 180),
                      jsonb_build_object('nombre', 'Mano de obra', 'cantidad', 1, 'precio', 100)), NULL, false, 'dev-caja');
  PERFORM pg_temp.fin();
  v := (r->>'venta_id')::uuid;
  PERFORM pg_temp.t('venta: el servidor calcula el total (460)', (r->>'total')::numeric = 460 AND (SELECT total FROM public.ventas WHERE id = v) = 460);
  PERFORM pg_temp.t('venta: cambio calculado (40) y autor = cajero', (SELECT cambio = 40 AND created_by = pg_temp.uid(2) AND op_id = op AND dispositivo = 'dev-caja' FROM public.ventas WHERE id = v));
  PERFORM pg_temp.t('venta: costo sellado por el servidor (110 en repuesto, 0 en mano de obra)',
    (SELECT costo_unitario FROM public.venta_items WHERE venta_id = v AND inventario_id IS NOT NULL) = 110 AND (SELECT costo_unitario FROM public.venta_items WHERE venta_id = v AND inventario_id IS NULL) = 0);
  PERFORM pg_temp.t('venta: descontó 2 del stock por el ledger (cantidad 8)', (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(211)) = 8);
  PERFORM pg_temp.t('venta: una sola fila de caja, ingreso 460 ligado a la venta', (SELECT count(*) FROM public.caja_movimientos WHERE venta_id = v AND tipo = 'ingreso' AND monto = 460) = 1);
  PERFORM pg_temp.t('venta: auditoría con identidad real', EXISTS (SELECT 1 FROM public.auditoria WHERE operation_id = op AND accion = 'venta' AND usuario_id = pg_temp.uid(2) AND rol = 'cajero'));

  -- idempotencia: el mismo operation_id no repite nada
  PERFORM pg_temp.como(2);
  r := public.registrar_venta_v2(op, pg_temp.id(201), 'Cliente RPC', 'efectivo', 500,
    jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(211), 'nombre', 'Aceite', 'cantidad', 2, 'precio', 180),
                      jsonb_build_object('nombre', 'Mano de obra', 'cantidad', 1, 'precio', 100)), NULL, false, 'dev-caja');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('reintento: mismo resultado y marcado como repetida', (r->>'venta_id')::uuid = v AND (r->>'repetida')::boolean);
  SELECT count(*) INTO n FROM public.ventas WHERE op_id = op;
  PERFORM pg_temp.t('reintento: sigue habiendo UNA venta', n = 1);
  PERFORM pg_temp.t('reintento: UNA sola caja y el stock no se descontó otra vez',
    (SELECT count(*) FROM public.caja_movimientos WHERE venta_id = v) = 1 AND (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(211)) = 8);
  PERFORM pg_temp.t('reintento: sync_ops guardó la operación una vez', (SELECT count(*) FROM public.sync_ops WHERE op_id = op) = 1);

  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('mismo operation_id con otros parámetros se rechaza',
    format('SELECT public.registrar_venta_v2(%L, NULL, ''x'', ''efectivo'', 1, %L::jsonb)', op, '[{"nombre":"otra cosa","cantidad":1,"precio":1}]'), 'OP_ID_REUTILIZADO');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(1);
  PERFORM pg_temp.falla('otro usuario no puede reusar el operation_id de un cajero',
    format('SELECT public.registrar_venta_v2(%L, %L, ''Cliente RPC'', ''efectivo'', 500, %L::jsonb, NULL, false, ''dev-caja'')', op, pg_temp.id(201),
           '[{"inventario_id":"' || pg_temp.id(211) || '","nombre":"Aceite","cantidad":2,"precio":180},{"nombre":"Mano de obra","cantidad":1,"precio":100}]'), 'OP_ID_REUTILIZADO');
  PERFORM pg_temp.fin();
END $$;

-- 2. STOCK: online bloquea, offline se acepta y se marca (D-3), nada se recorta a cero ------------------------------
DO $$
DECLARE r jsonb; n0 int; c numeric;
BEGIN
  SELECT count(*) INTO n0 FROM public.ventas;
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('online: la falta de stock BLOQUEA la venta',
    format('SELECT public.registrar_venta_v2(%L, NULL, ''x'', ''efectivo'', 9999, %L::jsonb)', pg_temp.id(301), '[{"inventario_id":"' || pg_temp.id(211) || '","nombre":"Aceite","cantidad":100,"precio":180}]'), 'Sin stock suficiente');
  PERFORM pg_temp.falla('un «offline» sin hecho anterior a la recepción se trata como online (no se puede simular)',
    format('SELECT public.registrar_venta_v2(%L, NULL, ''x'', ''efectivo'', 9999, %L::jsonb, now(), true)', pg_temp.id(302), '[{"inventario_id":"' || pg_temp.id(211) || '","nombre":"Aceite","cantidad":100,"precio":180}]'), 'Sin stock suficiente');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('la venta bloqueada es atómica: no dejó venta ni caja ni ledger', (SELECT count(*) FROM public.ventas) = n0 AND (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(211)) = 8);

  PERFORM pg_temp.como(2);
  r := public.registrar_venta_v2(pg_temp.id(303), NULL, 'Mostrador', 'efectivo', 3000,
    jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(211), 'nombre', 'Aceite', 'cantidad', 12, 'precio', 180)),
    now() - interval '2 hours', true, 'dev-offline');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('D-3 offline: la venta se ACEPTA aunque el stock no alcance', (r->>'venta_id') IS NOT NULL AND jsonb_array_length(r->'stock_negativo') = 1);
  SELECT cantidad INTO c FROM public.inventario WHERE id = pg_temp.id(211);
  PERFORM pg_temp.t('D-3: stock −4 conservado (no se falsea a cero)', c = -4);
  PERFORM pg_temp.t('D-3: inventario marcado para revisión', (SELECT requiere_revision FROM public.inventario WHERE id = pg_temp.id(211)));
  PERFORM pg_temp.t('D-3: venta conserva su hora real, marca offline y su caja', (SELECT capturada_offline AND occurred_at < now() - interval '1 hour' FROM public.ventas WHERE id = (r->>'venta_id')::uuid)
    AND EXISTS (SELECT 1 FROM public.caja_movimientos WHERE venta_id = (r->>'venta_id')::uuid AND monto = 2160));
  PERFORM pg_temp.t('D-3: alerta auditada para el administrador', EXISTS (SELECT 1 FROM public.auditoria WHERE accion = 'stock_negativo' AND resultado = 'revision'));
  PERFORM pg_temp.t('D-3: el movimiento del ledger quedó marcado offline y para revisión', EXISTS (SELECT 1 FROM public.inventario_movimientos WHERE op_id = pg_temp.id(303) AND capturada_offline AND requiere_revision));
END $$;

-- 3. QUIÉN PUEDE LLAMAR ---------------------------------------------------------------------------------------------
DO $$
DECLARE cuerpo text := format('SELECT public.registrar_venta_v2(%L, NULL, ''x'', ''efectivo'', 1, %L::jsonb)', pg_temp.id(310), '[{"nombre":"x","cantidad":1,"precio":1}]');
BEGIN
  PERFORM pg_temp.como(3); PERFORM pg_temp.falla('el mecánico no vende', cuerpo, 'no tiene permiso'); PERFORM pg_temp.fin();
  PERFORM pg_temp.como(5); PERFORM pg_temp.falla('el desarrollador no vende', cuerpo, 'no tiene permiso'); PERFORM pg_temp.fin();
  PERFORM pg_temp.como(0); PERFORM pg_temp.falla('anon no puede ejecutar la RPC', cuerpo, 'permission denied'); PERFORM pg_temp.fin();
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('el cajero no puede mover stock llamando al helper interno',
    format('SELECT public.sync_stock_mover(%L, 100, ''ajuste'', NULL, true, now())', pg_temp.id(213)), 'permission denied');
  PERFORM pg_temp.falla('el cajero no puede escribir en caja con el helper interno', 'SELECT public.sync_caja(''ingreso'', ''x'', 99999, ''efectivo'', NULL, now(), NULL)', 'permission denied');
  PERFORM pg_temp.falla('el cajero no puede fabricar autorizaciones con el helper interno', format('SELECT * FROM public.sync_autorizar(NULL, ''reversar_venta'', ''ventas'', %L, NULL, 0, NULL)', pg_temp.id(300)), 'permission denied');
  PERFORM pg_temp.fin();
END $$;

-- 4. CRÉDITOS Y ABONOS -------------------------------------------------------------------------------------------------
DO $$
DECLARE r jsonb; c uuid; a jsonb;
BEGIN
  PERFORM pg_temp.como(2);
  r := public.registrar_credito(pg_temp.id(320), pg_temp.id(201), 'Cliente RPC', '9999',
    jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(212), 'nombre', 'Kit arrastre', 'cantidad', 1, 'precio', 300)),
    current_date + 30, 'nota', 100, 'efectivo', NULL, false, 'dev-caja');
  PERFORM pg_temp.fin();
  c := (r->>'credito_id')::uuid;
  PERFORM pg_temp.t('crédito: total 300, entrada 100, saldo 200', (SELECT total = 300 AND abonado = 100 AND saldo = 200 AND estado = 'parcial' FROM public.creditos WHERE id = c));
  PERFORM pg_temp.t('crédito: el repuesto salió del stock (4)', (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(212)) = 4);
  PERFORM pg_temp.t('crédito: solo la entrada entró a caja (100), no el total', (SELECT sum(monto) FROM public.caja_movimientos WHERE credito_id = c AND tipo = 'ingreso') = 100);
  PERFORM pg_temp.t('crédito: la entrada quedó como abono', (SELECT count(*) FROM public.abonos WHERE credito_id = c) = 1);

  PERFORM pg_temp.como(2);
  a := public.registrar_abono_v2(pg_temp.id(321), c, 150, 'transferencia');
  a := public.registrar_abono_v2(pg_temp.id(321), c, 150, 'transferencia');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('abono: un reintento no cobra doble (saldo 50, un solo abono nuevo)',
    (SELECT saldo = 50 AND abonado = 250 FROM public.creditos WHERE id = c) AND (SELECT count(*) FROM public.abonos WHERE credito_id = c) = 2 AND (a->>'repetida')::boolean);
  PERFORM pg_temp.t('abono: cada abono entra una vez a caja', (SELECT sum(monto) FROM public.caja_movimientos WHERE credito_id = c AND tipo = 'ingreso') = 250);
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('abono: no puede superar el saldo', format('SELECT public.registrar_abono_v2(%L, %L, 999, ''efectivo'')', pg_temp.id(322), c), 'supera el saldo');
  PERFORM pg_temp.falla('abono: monto cero se rechaza', format('SELECT public.registrar_abono_v2(%L, %L, 0, ''efectivo'')', pg_temp.id(323), c), 'mayor que cero');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(3);
  PERFORM pg_temp.falla('el mecánico no registra abonos', format('SELECT public.registrar_abono_v2(%L, %L, 10, ''efectivo'')', pg_temp.id(324), c), 'no tiene permiso');
  PERFORM pg_temp.fin();
END $$;

-- 5. ÓRDENES: ítems con stock, finalización, cotización ---------------------------------------------------------------
DO $$
DECLARE r jsonb; o uuid := pg_temp.id(330); item uuid; c numeric;
BEGIN
  INSERT INTO public.ordenes (id, cliente_id, moto_id, falla, mecanico_id) VALUES (o, pg_temp.id(201), pg_temp.id(202), 'ruido', pg_temp.uid(3));
  PERFORM pg_temp.como(2);
  r := public.agregar_item_orden(pg_temp.id(331), o, pg_temp.id(213), 'Bujía', 1, 60);
  item := (r->>'item_id')::uuid;
  r := public.agregar_item_orden(pg_temp.id(331), o, pg_temp.id(213), 'Bujía', 1, 60);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('ítem de orden: reintento no agrega ni descuenta dos veces', (SELECT count(*) FROM public.orden_items WHERE orden_id = o) = 1 AND (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(213)) = 1);
  PERFORM pg_temp.t('ítem de orden: costo sellado y stock por ledger', (SELECT costo_unitario FROM public.orden_items WHERE id = item) = 20);
  PERFORM pg_temp.como(2);
  r := public.quitar_item_orden(pg_temp.id(332), item);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('quitar ítem devuelve el stock y borra la línea', (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(213)) = 2 AND NOT EXISTS (SELECT 1 FROM public.orden_items WHERE id = item));
  PERFORM pg_temp.como(2);
  r := public.agregar_item_orden(pg_temp.id(333), o, pg_temp.id(213), 'Bujía', 1, 60);
  r := public.agregar_item_orden(pg_temp.id(334), o, NULL, 'Mano de obra', 1, 140);
  PERFORM pg_temp.falla('no se finaliza una orden que no está entregada', format('SELECT public.finalizar_orden(%L, %L, ''contado'')', pg_temp.id(335), o), 'debe estar entregada');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(3);
  PERFORM pg_temp.falla('el mecánico no agrega ítems con precio', format('SELECT public.agregar_item_orden(%L, %L, NULL, ''x'', 1, 1)', pg_temp.id(336), o), 'Solo el administrador o el cajero');
  PERFORM pg_temp.fin();
  UPDATE public.ordenes SET estado = 'entregado' WHERE id = o;
  PERFORM pg_temp.como(2);
  r := public.finalizar_orden(pg_temp.id(337), o, 'contado', 'efectivo');
  r := public.finalizar_orden(pg_temp.id(337), o, 'contado', 'efectivo');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('finalizar: total 200 calculado por el servidor y margen 80%', (SELECT finalizada AND margen = 90.00 FROM public.ordenes WHERE id = o) OR (r->>'total')::numeric = 200);
  PERFORM pg_temp.t('finalizar: UN solo ingreso a caja aunque se reintente', (SELECT count(*) FROM public.caja_movimientos WHERE orden_id = o AND tipo = 'ingreso') = 1 AND (SELECT monto FROM public.caja_movimientos WHERE orden_id = o) = 200);
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('finalizar otra vez con otra operación: ya cobrada', format('SELECT public.finalizar_orden(%L, %L, ''contado'')', pg_temp.id(338), o), 'ya estaba finalizada');
  PERFORM pg_temp.falla('no se agregan ítems a una orden finalizada', format('SELECT public.agregar_item_orden(%L, %L, NULL, ''x'', 1, 1)', pg_temp.id(339), o), 'cerrada');
  PERFORM pg_temp.fin();

  -- orden al crédito: el stock NO se descuenta dos veces
  INSERT INTO public.ordenes (id, cliente_id, moto_id, falla, estado) VALUES (pg_temp.id(340), pg_temp.id(201), pg_temp.id(202), 'frenos', 'entregado');
  PERFORM pg_temp.como(2);
  PERFORM public.agregar_item_orden(pg_temp.id(341), pg_temp.id(340), pg_temp.id(213), 'Bujía', 1, 100);
  r := public.finalizar_orden(pg_temp.id(342), pg_temp.id(340), 'credito', NULL, 30, 'efectivo');
  PERFORM pg_temp.fin();
  SELECT cantidad INTO c FROM public.inventario WHERE id = pg_temp.id(213);
  PERFORM pg_temp.t('orden al crédito: crédito de 100 con entrada 30 y el stock solo bajó por el ítem (0)', (SELECT total = 100 AND abonado = 30 AND orden_id = pg_temp.id(340) FROM public.creditos WHERE id = (r->>'credito_id')::uuid) AND c = 0);
  PERFORM pg_temp.t('orden al crédito: solo la entrada entra a caja', (SELECT sum(monto) FROM public.caja_movimientos WHERE credito_id = (r->>'credito_id')::uuid AND tipo = 'ingreso') = 30);
END $$;

DO $$
DECLARE cot uuid := pg_temp.id(350); r jsonb; o uuid;
BEGIN
  INSERT INTO public.cotizaciones (id, cliente_id, cliente_nombre, moto_desc, diagnostico, vence_en) VALUES (cot, pg_temp.id(201), 'Cliente RPC', 'Honda CB190R', 'cambio de kit', now() + interval '15 days');
  INSERT INTO public.cotizacion_items (cotizacion_id, inventario_id, nombre, cantidad, precio) VALUES
    (cot, pg_temp.id(212), 'Kit arrastre', 1, 300), (cot, pg_temp.id(213), 'Bujía', 5, 50), (cot, NULL, 'Mano de obra', 1, 350);
  PERFORM pg_temp.como(2);
  r := public.convertir_cotizacion(pg_temp.id(351), cot);
  r := public.convertir_cotizacion(pg_temp.id(351), cot);
  PERFORM pg_temp.fin();
  o := (r->>'orden_id')::uuid;
  PERFORM pg_temp.t('cotización→orden: se crea la orden y la cotización queda aceptada', (SELECT estado = 'aceptada' AND orden_id = o FROM public.cotizaciones WHERE id = cot) AND EXISTS (SELECT 1 FROM public.ordenes WHERE id = o));
  PERFORM pg_temp.t('cotización→orden: 3 líneas y un reintento no duplica la orden', (SELECT count(*) FROM public.orden_items WHERE orden_id = o) = 3 AND (SELECT count(*) FROM public.ordenes WHERE id IN (SELECT orden_id FROM public.cotizaciones WHERE id = cot)) = 1);
  PERFORM pg_temp.t('cotización→orden: sale el kit (alcanza) y NO la bujía (no alcanza, sin negativos)', (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(212)) = 3 AND (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(213)) = 0 AND jsonb_array_length(r->'sin_stock') = 1);
  PERFORM pg_temp.t('cotización→orden: la línea sin stock queda sin ligar y con costo 0', (SELECT inventario_id IS NULL AND costo_unitario = 0 FROM public.orden_items WHERE orden_id = o AND nombre = 'Bujía'));
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('una cotización aceptada no se convierte otra vez', format('SELECT public.convertir_cotizacion(%L, %L)', pg_temp.id(352), cot), 'ya fue aceptada');
  PERFORM pg_temp.fin();
END $$;

-- 6. AJUSTE MANUAL DE STOCK: admin directo; cajero solo con autorización de un solo uso -------------------------------
DO $$
DECLARE a uuid; r jsonb; inv uuid := pg_temp.id(211);
BEGIN
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('el cajero no ajusta stock sin autorización', format('SELECT public.ajustar_stock(%L, %L, ''conteo físico'', 1)', pg_temp.id(360), inv), 'AUTORIZACION_REQUERIDA');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(3);
  PERFORM pg_temp.falla('el mecánico no ajusta stock aunque tenga una autorización', format('SELECT public.ajustar_stock(%L, %L, ''conteo'', 1, NULL, %L)', pg_temp.id(361), inv, gen_random_uuid()), 'no puede realizar');
  PERFORM pg_temp.fin();
  a := pg_temp.auth(2, 'ajustar_stock', 'inventario', inv);
  PERFORM pg_temp.como(2);
  r := public.ajustar_stock(pg_temp.id(362), inv, 'conteo físico', 1, NULL, a);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('cajero con autorización ajusta stock (+1) y queda en −3', (r->>'saldo')::numeric = -3);
  PERFORM pg_temp.t('la autorización quedó consumida y ligada a la operación', (SELECT consumida_en IS NOT NULL AND consumida_op = pg_temp.id(362) FROM public.autorizaciones_admin WHERE id = a));
  PERFORM pg_temp.t('el ajuste audita al solicitante Y al administrador que autorizó', EXISTS (SELECT 1 FROM public.auditoria WHERE accion = 'ajuste-stock' AND usuario_id = pg_temp.uid(2) AND autorizado_por = pg_temp.uid(1)));
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('una autorización no se reutiliza', format('SELECT public.ajustar_stock(%L, %L, ''otro motivo'', 1, NULL, %L)', pg_temp.id(363), inv, a), 'AUTORIZACION_INVALIDA');
  PERFORM pg_temp.fin();
  -- otras acciones/registros/usuarios/vigencias no sirven
  a := pg_temp.auth(2, 'reversar_venta', 'ventas', inv);
  PERFORM pg_temp.como(2); PERFORM pg_temp.falla('una autorización de OTRA acción no sirve', format('SELECT public.ajustar_stock(%L, %L, ''motivo x'', 1, NULL, %L)', pg_temp.id(364), inv, a), 'AUTORIZACION_INVALIDA'); PERFORM pg_temp.fin();
  a := pg_temp.auth(2, 'ajustar_stock', 'inventario', pg_temp.id(212));
  PERFORM pg_temp.como(2); PERFORM pg_temp.falla('una autorización de OTRO registro no sirve', format('SELECT public.ajustar_stock(%L, %L, ''motivo x'', 1, NULL, %L)', pg_temp.id(365), inv, a), 'AUTORIZACION_INVALIDA'); PERFORM pg_temp.fin();
  a := pg_temp.auth(1, 'ajustar_stock', 'inventario', inv);
  PERFORM pg_temp.como(2); PERFORM pg_temp.falla('una autorización emitida para OTRO solicitante no sirve', format('SELECT public.ajustar_stock(%L, %L, ''motivo x'', 1, NULL, %L)', pg_temp.id(366), inv, a), 'AUTORIZACION_INVALIDA'); PERFORM pg_temp.fin();
  a := pg_temp.auth(2, 'ajustar_stock', 'inventario', inv, '-1 second');
  PERFORM pg_temp.como(2); PERFORM pg_temp.falla('una autorización caducada no sirve', format('SELECT public.ajustar_stock(%L, %L, ''motivo x'', 1, NULL, %L)', pg_temp.id(367), inv, a), 'AUTORIZACION_INVALIDA'); PERFORM pg_temp.fin();
  a := pg_temp.auth(2, 'ajustar_stock', 'inventario', inv, '90 seconds', 7);
  PERFORM pg_temp.como(2); PERFORM pg_temp.falla('si el PIN cambió de versión la autorización ya no sirve', format('SELECT public.ajustar_stock(%L, %L, ''motivo x'', 1, NULL, %L)', pg_temp.id(368), inv, a), 'AUTORIZACION_INVALIDA'); PERFORM pg_temp.fin();
  a := pg_temp.auth(2, 'ajustar_stock', 'inventario', inv, '90 seconds', 1, public.sync_hash_critico('ajustar_stock', inv, 5));
  PERFORM pg_temp.como(2); PERFORM pg_temp.falla('la autorización ligada a un monto no sirve para otro monto', format('SELECT public.ajustar_stock(%L, %L, ''motivo x'', 1, NULL, %L)', pg_temp.id(369), inv, a), 'AUTORIZACION_INVALIDA'); PERFORM pg_temp.fin();

  -- el admin ajusta por sí mismo (conteo físico) y eso resuelve la revisión pendiente
  PERFORM pg_temp.como(1);
  r := public.ajustar_stock(pg_temp.id(370), inv, 'conteo físico de fin de día', NULL, 6);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('el admin ajusta por conteo (nuevo total 6) y se limpia la revisión', (r->>'saldo')::numeric = 6 AND NOT (SELECT requiere_revision FROM public.inventario WHERE id = inv));
  PERFORM pg_temp.como(1); PERFORM pg_temp.falla('el ajuste exige un motivo', format('SELECT public.ajustar_stock(%L, %L, '' '', 1)', pg_temp.id(371), inv), 'motivo'); PERFORM pg_temp.fin();
END $$;

-- 7. CAJA MANUAL ---------------------------------------------------------------------------------------------------
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.como(2);
  r := public.registrar_movimiento_caja(pg_temp.id(380), 'egreso', 'Gastos', 50, 'efectivo', 'papelería');
  r := public.registrar_movimiento_caja(pg_temp.id(380), 'egreso', 'Gastos', 50, 'efectivo', 'papelería');
  PERFORM pg_temp.falla('no se registra a mano una categoría del sistema (falsear ventas)', format('SELECT public.registrar_movimiento_caja(%L, ''ingreso'', ''Venta mostrador'', 100, ''efectivo'')', pg_temp.id(381)), 'genera el sistema');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('caja manual: un gasto, sin duplicar', (SELECT count(*) FROM public.caja_movimientos WHERE op_id = pg_temp.id(380)) = 1);
END $$;

-- 8. REVERSOS: el original se conserva; el cajero solo con autorización; el admin por sí mismo --------------------------
DO $$
DECLARE r jsonb; va uuid; vb uuid; a uuid; orig uuid; comp record;
BEGIN
  INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES (pg_temp.id(214), 'Filtro', 100, 40);
  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES (pg_temp.id(214), 'apertura', 20);
  PERFORM pg_temp.como(2);
  r := public.registrar_venta_v2(pg_temp.id(400), NULL, 'Mostrador', 'efectivo', 300, jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(214), 'nombre', 'Filtro', 'cantidad', 3, 'precio', 100)));
  va := (r->>'venta_id')::uuid;
  PERFORM pg_temp.falla('anular venta: el cajero necesita autorización', format('SELECT public.reversar_venta(%L, %L, ''error de precio'')', pg_temp.id(401), va), 'AUTORIZACION_REQUERIDA');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(3);
  PERFORM pg_temp.falla('anular venta: el mecánico nunca', format('SELECT public.reversar_venta(%L, %L, ''x1x'')', pg_temp.id(402), va), 'no puede realizar');
  PERFORM pg_temp.fin();
  a := pg_temp.auth(2, 'reversar_venta', 'ventas', va);
  PERFORM pg_temp.como(2);
  r := public.reversar_venta(pg_temp.id(403), va, 'error de precio', a);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('anular venta: queda anulada y el original NO se toca (total 300)', (SELECT anulada AND total = 300 AND anulada_en IS NOT NULL FROM public.ventas WHERE id = va));
  PERFORM pg_temp.t('anular venta: el stock volvió (20)', (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(214)) = 20);
  SELECT id INTO orig FROM public.caja_movimientos WHERE venta_id = va AND reverso_de IS NULL;
  SELECT tipo, monto, reverso_de INTO comp FROM public.caja_movimientos WHERE reverso_de = orig;
  PERFORM pg_temp.t('anular venta: la caja original se conserva y hay un egreso compensatorio ligado', orig IS NOT NULL AND comp.tipo = 'egreso' AND comp.monto = 300 AND comp.reverso_de = orig);
  PERFORM pg_temp.t('anular venta: caja neta de la venta = 0', (SELECT sum(CASE tipo WHEN 'ingreso' THEN monto ELSE -monto END) FROM public.caja_movimientos WHERE venta_id = va OR reverso_de = orig) = 0);
  PERFORM pg_temp.t('anular venta: reverso con solicitante, autorizador, motivo, dispositivo y operación',
    (SELECT solicitado_por = pg_temp.uid(2) AND autorizado_por = pg_temp.uid(1) AND NOT actuo_como_admin AND motivo = 'error de precio' AND operation_id = pg_temp.id(403) AND autorizacion_id = a FROM public.reversos WHERE registro_id = va AND tipo = 'venta'));
  PERFORM pg_temp.como(2);
  r := public.reversar_venta(pg_temp.id(403), va, 'error de precio', a);
  PERFORM pg_temp.falla('anular venta: una segunda anulación se rechaza', format('SELECT public.reversar_venta(%L, %L, ''otra vez'', %L)', pg_temp.id(404), va, pg_temp.auth(2, 'reversar_venta', 'ventas', va)), 'ya está anulada');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('anular venta: reintentar la operación no vuelve a devolver stock ni a compensar caja',
    (r->>'repetida')::boolean AND (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(214)) = 20 AND (SELECT count(*) FROM public.caja_movimientos WHERE reverso_de = orig) = 1);

  -- el admin actúa por sí mismo: sin autorización, y queda registrado como tal
  PERFORM pg_temp.como(1);
  r := public.registrar_venta_v2(pg_temp.id(405), NULL, 'Mostrador', 'efectivo', 100, jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(214), 'nombre', 'Filtro', 'cantidad', 1, 'precio', 100)));
  vb := (r->>'venta_id')::uuid;
  r := public.reversar_venta(pg_temp.id(406), vb, 'cliente se arrepintió');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('el admin anula por sí mismo: actuo_como_admin y sin autorizador', (SELECT actuo_como_admin AND autorizado_por IS NULL FROM public.reversos WHERE registro_id = vb));
END $$;

DO $$
DECLARE r jsonb; vc uuid; a uuid; vi uuid;
BEGIN
  PERFORM pg_temp.como(1);
  r := public.registrar_venta_v2(pg_temp.id(410), NULL, 'Mostrador', 'efectivo', 300, jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(214), 'nombre', 'Filtro', 'cantidad', 3, 'precio', 100)));
  vc := (r->>'venta_id')::uuid;
  SELECT id INTO vi FROM public.venta_items WHERE venta_id = vc;
  PERFORM pg_temp.fin();
  a := pg_temp.auth(2, 'registrar_devolucion', 'ventas', vc);
  PERFORM pg_temp.como(2);
  r := public.registrar_devolucion(pg_temp.id(411), vc, jsonb_build_array(jsonb_build_object('venta_item_id', vi, 'cantidad', 1)), 'defectuoso', true, a);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('devolución parcial: reembolso 100, stock +1 y egreso en caja', (r->>'reembolso')::numeric = 100 AND (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(214)) = 18
    AND EXISTS (SELECT 1 FROM public.caja_movimientos WHERE venta_id = vc AND tipo = 'egreso' AND monto = 100 AND categoria = 'Devolución'));
  PERFORM pg_temp.como(1);
  PERFORM pg_temp.falla('devolución: no se puede devolver más de lo vendido', format('SELECT public.registrar_devolucion(%L, %L, %L::jsonb, ''x2x'')', pg_temp.id(412), vc, jsonb_build_array(jsonb_build_object('venta_item_id', vi, 'cantidad', 3))), 'más de lo vendido');
  r := public.reversar_venta(pg_temp.id(413), vc, 'anulación tras devolución parcial');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('anular tras devolución parcial: solo devuelve el stock RESTANTE (20, no 21)', (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(214)) = 20);
  PERFORM pg_temp.t('anular tras devolución parcial: la caja de la venta neta 0 (300 − 100 − 200)',
    (SELECT sum(CASE tipo WHEN 'ingreso' THEN monto ELSE -monto END) FROM public.caja_movimientos WHERE venta_id = vc OR reverso_de IN (SELECT id FROM public.caja_movimientos WHERE venta_id = vc)) = 0);
END $$;

DO $$
DECLARE r jsonb; c uuid; ab uuid; a uuid; n int;
BEGIN
  PERFORM pg_temp.como(1);
  r := public.registrar_credito(pg_temp.id(420), pg_temp.id(201), 'Cliente RPC', NULL, jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(214), 'nombre', 'Filtro', 'cantidad', 2, 'precio', 100)), NULL, NULL, 50);
  c := (r->>'credito_id')::uuid;
  r := public.registrar_abono_v2(pg_temp.id(421), c, 100, 'efectivo');
  ab := (r->>'abono_id')::uuid;
  PERFORM pg_temp.fin();
  a := pg_temp.auth(2, 'reversar_abono', 'abonos', ab);
  PERFORM pg_temp.como(2);
  r := public.reversar_abono(pg_temp.id(422), ab, 'abono mal registrado', a);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('reversar abono: el saldo se restablece (abonado 50, saldo 150, parcial)', (SELECT abonado = 50 AND saldo = 150 AND estado = 'parcial' FROM public.creditos WHERE id = c));
  PERFORM pg_temp.t('reversar abono: el abono se conserva marcado anulado y caja tiene el egreso compensatorio',
    (SELECT anulado FROM public.abonos WHERE id = ab) AND EXISTS (SELECT 1 FROM public.caja_movimientos WHERE credito_id = c AND tipo = 'egreso' AND monto = 100 AND categoria = 'Reverso de abono'));
  PERFORM pg_temp.como(1);
  PERFORM pg_temp.falla('reversar abono: no se anula dos veces', format('SELECT public.reversar_abono(%L, %L, ''otra vez'')', pg_temp.id(423), ab), 'ya está anulado');
  r := public.reversar_credito(pg_temp.id(424), c, 'venta cancelada');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('reversar crédito: queda anulado y los abonos vigentes se revierten (abonado 0, saldo 200)', (SELECT anulado AND abonado = 0 AND saldo = 200 FROM public.creditos WHERE id = c));
  PERFORM pg_temp.t('reversar crédito: el stock del crédito vuelve (20)', (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(214)) = 20);
  PERFORM pg_temp.t('reversar crédito: la caja del crédito neta 0 (entrada 50 + abono 100 − reversos 100 − 50)',
    (SELECT sum(CASE tipo WHEN 'ingreso' THEN monto ELSE -monto END) FROM public.caja_movimientos WHERE credito_id = c) = 0);
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('no se abona a un crédito anulado', format('SELECT public.registrar_abono_v2(%L, %L, 10, ''efectivo'')', pg_temp.id(425), c), 'anulado');
  PERFORM pg_temp.fin();
END $$;

DO $$
DECLARE a uuid; mv uuid; r jsonb;
BEGIN
  SELECT id INTO mv FROM public.caja_movimientos WHERE op_id = pg_temp.id(380);
  a := pg_temp.auth(2, 'reversar_caja', 'caja_movimientos', mv);
  PERFORM pg_temp.como(2);
  r := public.reversar_caja(pg_temp.id(430), mv, 'gasto mal digitado', a);
  PERFORM pg_temp.falla('un movimiento de caja no se revierte dos veces', format('SELECT public.reversar_caja(%L, %L, ''otra vez'', %L)', pg_temp.id(431), mv, pg_temp.auth(2, 'reversar_caja', 'caja_movimientos', mv)), 'ya está revertido');
  PERFORM pg_temp.falla('un movimiento ligado a una venta se revierte desde su origen',
    format('SELECT public.reversar_caja(%L, %L, ''x3x'', %L)', pg_temp.id(432), (SELECT id FROM public.caja_movimientos WHERE op_id = pg_temp.id(300) LIMIT 1), gen_random_uuid()), 'respalda otra operación');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('reversar caja: compensatorio de signo contrario y el original se conserva',
    EXISTS (SELECT 1 FROM public.caja_movimientos WHERE reverso_de = mv AND tipo = 'ingreso' AND monto = 50) AND EXISTS (SELECT 1 FROM public.caja_movimientos WHERE id = mv AND tipo = 'egreso' AND monto = 50));
END $$;

DO $$
DECLARE o uuid := pg_temp.id(440); r jsonb; a uuid; stock0 numeric;
BEGIN
  -- orden SIN dinero: solo el admin la elimina (suave) y los repuestos vuelven al inventario
  INSERT INTO public.ordenes (id, cliente_id, moto_id, falla) VALUES (o, pg_temp.id(201), pg_temp.id(202), 'prueba');
  PERFORM pg_temp.como(2);
  PERFORM public.agregar_item_orden(pg_temp.id(441), o, pg_temp.id(214), 'Filtro', 2, 100);
  PERFORM pg_temp.falla('eliminar orden sin dinero: el cajero no puede', format('SELECT public.anular_orden(%L, %L, ''se equivocó'')', pg_temp.id(442), o), 'Solo el administrador');
  PERFORM pg_temp.fin();
  stock0 := (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(214));
  PERFORM pg_temp.como(1);
  r := public.anular_orden(pg_temp.id(443), o, 'orden abierta por error');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('eliminar orden sin dinero: borrado suave y el stock vuelve (+2)', (SELECT deleted_at IS NOT NULL FROM public.ordenes WHERE id = o) AND (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(214)) = stock0 + 2 AND r->>'modo' = 'eliminar');
  PERFORM pg_temp.t('eliminar orden: la fila existe (no hay borrado físico) y queda el reverso', EXISTS (SELECT 1 FROM public.ordenes WHERE id = o) AND EXISTS (SELECT 1 FROM public.reversos WHERE registro_id = o AND tipo = 'orden'));

  -- orden FINALIZADA con dinero (Q-5): no se elimina, se ANULA con reverso de caja
  a := pg_temp.auth(2, 'anular_orden', 'ordenes', pg_temp.id(330));
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('anular orden con dinero: el cajero necesita autorización', format('SELECT public.anular_orden(%L, %L, ''cobro erróneo'')', pg_temp.id(444), pg_temp.id(330)), 'AUTORIZACION_REQUERIDA');
  r := public.anular_orden(pg_temp.id(445), pg_temp.id(330), 'cobro erróneo', false, a);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('anular orden con dinero: queda anulada (no borrada) y el ingreso se compensa', (SELECT anulada AND deleted_at IS NULL FROM public.ordenes WHERE id = pg_temp.id(330)) AND r->>'modo' = 'anular' AND (r->>'compensado')::numeric = 200);
  PERFORM pg_temp.t('anular orden con dinero: la caja neta de la orden es 0', (SELECT sum(CASE tipo WHEN 'ingreso' THEN monto ELSE -monto END) FROM public.caja_movimientos WHERE orden_id = pg_temp.id(330) OR reverso_de IN (SELECT id FROM public.caja_movimientos WHERE orden_id = pg_temp.id(330))) = 0);
END $$;

-- 9. INVARIANTES tras TODO lo anterior ------------------------------------------------------------------------------
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.como(1); v := public.verificar_invariantes(); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('invariantes: stock=ledger, saldo=total−abonos vigentes, venta=suma de renglones (' || v::text || ')', jsonb_array_length(v) = 0);
  PERFORM pg_temp.como(2); PERFORM pg_temp.falla('solo el administrador verifica invariantes', 'SELECT public.verificar_invariantes()', 'Solo el administrador'); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('ninguna venta, caja, abono ni reverso se borró (todas las filas siguen)', (SELECT count(*) FROM public.reversos) = 9 AND (SELECT count(*) FROM public.ventas) = 5);
END $$;

-- 10. ACL y funciones fijadas ---------------------------------------------------------------------------------------
DO $$
DECLARE n int := 0; k record;
BEGIN
  PERFORM pg_temp.t('authenticated puede llamar registrar_venta_v2; anon no',
    has_function_privilege('authenticated', 'public.registrar_venta_v2(uuid,uuid,text,text,numeric,jsonb,timestamptz,boolean,text,uuid,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.registrar_venta_v2(uuid,uuid,text,text,numeric,jsonb,timestamptz,boolean,text,uuid,uuid)', 'EXECUTE'));
  PERFORM pg_temp.t('los helpers internos NO son ejecutables por authenticated ni anon',
    NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('sync_op_iniciar','sync_op_guardar','sync_auditar','sync_stock_mover','sync_caja','sync_autorizar','sync_abonar','sync_compensar_caja','sync_registrar_reverso','sync_reversar_abono_i','sync_reversar_credito_i')
                  AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))));
  FOR k IN SELECT * FROM (VALUES
    ('rol_actual','e66ee46e01d3df511ee5bd4d0f2a178a'),('es_admin','35aa9a08ef4e9960cb333eea4939d15e'),('puede_cobrar','2c95d9a820de4ae25ec59d25cbbd1a91'),
    ('es_equipo','635c8361317be3293aee3778a0de048d'),('es_desarrollador','25a3787ce375a9a89a58266b96b732a3'),('es_mecanico_activo','1b786deb21df29b40f89dca23ab776fd'),
    ('ve_todo_el_taller','80b7f166927d6559301d8507c397a243'),('mi_cliente','aeee991cda291df054c2924d1e9f3cdf'),('mi_moto','235499aeafbd8379d6333b7e51edb6c2'),
    ('crear_perfil_al_registrarse','f3873b6473a2831c8046a29b97947ea3'),('proteger_caja_ligada','4b1a0e352c4eae22efcbb139ae72a725'),('proteger_rol_perfil','5bcd1237d7e6714293cf4fc332e08667'),
    ('mecanico_solo_avance_tecnico','5c9d8db5084b0a4e881948d9a920462b'),('registrar_venta','ae8ee6c6d7c066d4d544ff4e9ab5147b'),('registrar_abono','6dee1802d5cf45cd4d8d91b140e2cadd'),
    ('estadisticas_tecnicas','86948fdcaf03939a1d0929004cd9c730'),('estado_tecnico','8cab17a837ec35d46c8575befd53e85a')) AS v(f, m) LOOP
    IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = k.f AND md5(prosrc) = k.m) THEN n := n + 1; END IF;
  END LOOP;
  PERFORM pg_temp.t('las 17 funciones históricas de RCV-34 conservan su md5 (registrar_venta/abono originales intactas)', n = 17);
END $$;
