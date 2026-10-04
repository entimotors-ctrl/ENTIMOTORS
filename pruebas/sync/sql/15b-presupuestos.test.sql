-- 3.15.0 · BLOQUE 2 · presupuestos + inventario + stock. Requiere 00-prelude.sql, la cadena SYNC 1..10, sync-15a y sync-15b.
-- Cuentas: 1 admin · 2 cajero · 3 mecánico. Ids de datos: pg_temp.id(25xx). Todas las operaciones pasan por las RPC (como la app).
DO $$
BEGIN
  INSERT INTO public.clientes (id, nombre, telefono) VALUES (pg_temp.id(2501), 'Cliente B2', '9999');
  INSERT INTO public.motos (id, cliente_id, marca, modelo) VALUES (pg_temp.id(2502), pg_temp.id(2501), 'Honda', 'CB190R');
  INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES
    (pg_temp.id(2511), 'Neumático', 100, 60), (pg_temp.id(2512), 'Bujía', 50, 20), (pg_temp.id(2513), 'Aceite', 180, 110);
  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES (pg_temp.id(2511), 'apertura', 5), (pg_temp.id(2512), 'apertura', 1), (pg_temp.id(2513), 'apertura', 10);
END $$;
CREATE FUNCTION pg_temp.stock(n int) RETURNS numeric LANGUAGE sql AS $$ SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(n) $$;
CREATE FUNCTION pg_temp.movs() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM public.inventario_movimientos $$;
CREATE FUNCTION pg_temp.nueva_orden(n int) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.ordenes (id, cliente_id, moto_id, estado, falla) VALUES (pg_temp.id(n), pg_temp.id(2501), pg_temp.id(2502), 'presupuesto', 'b2'); RETURN pg_temp.id(n); END $$;
CREATE FUNCTION pg_temp.agregar(op int, orden uuid, item int, inv int, nombre text, cant numeric, precio numeric, tipo text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN PERFORM pg_temp.como(2);
  r := public.agregar_item_orden(pg_temp.id(op), orden, CASE WHEN inv IS NULL THEN NULL ELSE pg_temp.id(inv) END, nombre, cant, precio, pg_temp.id(item), false, NULL, 'dev', tipo);
  PERFORM pg_temp.fin(); RETURN r; END $$;
CREATE FUNCTION pg_temp.editar(op int, item int, cant numeric, precio numeric, inv int, tipo text, nombre text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN PERFORM pg_temp.como(2);
  r := public.actualizar_item_orden(pg_temp.id(op), pg_temp.id(item), cant, precio, nombre, CASE WHEN inv IS NULL THEN NULL ELSE pg_temp.id(inv) END, tipo, 'dev');
  PERFORM pg_temp.fin(); RETURN r; END $$;
CREATE FUNCTION pg_temp.decidir(op int, orden uuid, d text, quien int DEFAULT 2) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN PERFORM pg_temp.como(quien); r := public.decidir_presupuesto_orden(pg_temp.id(op), orden, d, 'local', 'dev'); PERFORM pg_temp.fin(); RETURN r; END $$;
CREATE FUNCTION pg_temp.aplicada(item int) RETURNS numeric LANGUAGE sql AS $$ SELECT cantidad_aplicada FROM public.orden_items WHERE id = pg_temp.id(item) $$;

-- G/H/I · pendiente: mano de obra, repuesto manual y repuesto del inventario NO tocan stock ------------------------------------------
DO $$
DECLARE o uuid := pg_temp.nueva_orden(2520); m0 bigint := pg_temp.movs(); r jsonb;
BEGIN
  PERFORM pg_temp.agregar(2521, o, 2522, NULL, 'Cambio de llanta', 1, 150, 'mano_obra');
  PERFORM pg_temp.agregar(2523, o, 2524, NULL, 'Válvula genérica', 2, 30, 'repuesto_manual');
  r := pg_temp.agregar(2525, o, 2526, 2511, NULL, 2, 90, 'repuesto_inventario');           -- precio editado (el producto vale 100)
  PERFORM pg_temp.t('I · pendiente: agregar mano de obra, manual y repuesto no mueve stock', pg_temp.movs() = m0 AND pg_temp.stock(2511) = 5 AND (r->>'stock_movido')::numeric = 0);
  PERFORM pg_temp.t('tipos guardados tal cual', (SELECT string_agg(tipo, ',' ORDER BY creado_en) FROM public.orden_items WHERE orden_id = o) = 'mano_obra,repuesto_manual,repuesto_inventario');
  PERFORM pg_temp.t('descripción histórica del repuesto = nombre del producto', (SELECT nombre FROM public.orden_items WHERE id = pg_temp.id(2526)) = 'Neumático');
  PERFORM pg_temp.t('B · precio editado solo en el renglón (90) y el maestro sigue a 100', (SELECT precio FROM public.orden_items WHERE id = pg_temp.id(2526)) = 90 AND (SELECT precio_venta FROM public.inventario WHERE id = pg_temp.id(2511)) = 100);
  PERFORM pg_temp.falla('mano de obra con producto → rechazo', format('SELECT pg_temp.agregar(2527, %L, 2528, 2512, %L, 1, 10, %L)', o, 'x', 'mano_obra'), 'no llevan producto');
  PERFORM pg_temp.falla('repuesto del inventario sin producto → rechazo', format('SELECT pg_temp.agregar(2529, %L, 2530, NULL, %L, 1, 10, %L)', o, 'x', 'repuesto_inventario'), 'necesita su producto');
  PERFORM pg_temp.falla('F · precio vacío (NULL) → rechazo', format('SELECT pg_temp.agregar(2531, %L, 2532, 2512, NULL, 1, NULL, %L)', o, 'repuesto_inventario'), 'Cantidad y precio');
END $$;

-- K · aprobar descuenta exactamente una vez (solo el repuesto del inventario); G/H: mano de obra y manual no -----------------------------
DO $$
DECLARE o uuid := pg_temp.id(2520); r1 jsonb; r2 jsonb; r3 jsonb;
BEGIN
  r1 := pg_temp.decidir(2540, o, 'aprobar');
  PERFORM pg_temp.t('K · aprobar saca 2 neumáticos (5→3) y nada más', pg_temp.stock(2511) = 3 AND (r1->>'stock_movido')::numeric = 2 AND pg_temp.aplicada(2526) = 2);
  PERFORM pg_temp.t('G/H · mano de obra y repuesto manual siguen sin aplicar nada', pg_temp.aplicada(2522) = 0 AND pg_temp.aplicada(2524) = 0);
  r2 := pg_temp.decidir(2540, o, 'aprobar');                -- M · reintento con el MISMO op
  r3 := pg_temp.decidir(2541, o, 'aprobar', 1);             -- L/N · otra pestaña/dispositivo/usuario, OTRO op
  PERFORM pg_temp.t('M · reintento mismo op = mismo resultado, sin nuevo movimiento', (r2->>'repetida')::boolean AND pg_temp.stock(2511) = 3);
  PERFORM pg_temp.t('L/N · otro op/usuario aprueba otra vez: ya_estaba y 0 movido', (r3->>'ya_estaba')::boolean AND (r3->>'stock_movido')::numeric = 0 AND pg_temp.stock(2511) = 3);
  PERFORM pg_temp.t('AC · el movimiento es auditable: ledger con orden, renglón, op y motivo + auditoría',
    EXISTS (SELECT 1 FROM public.inventario_movimientos WHERE orden_item_id = pg_temp.id(2526) AND orden_id = o AND op_id = pg_temp.id(2540) AND tipo = 'orden_item' AND cantidad = -2 AND motivo = 'Presupuesto aprobado')
    AND EXISTS (SELECT 1 FROM public.auditoria WHERE operation_id = pg_temp.id(2540) AND accion = 'presupuesto-aprobar' AND usuario_id = pg_temp.uid(2)));
  PERFORM pg_temp.t('costo histórico sellado al aplicar (60)', (SELECT costo_unitario FROM public.orden_items WHERE id = pg_temp.id(2526)) = 60);
  PERFORM pg_temp.t('estado y quién/cómo aprobó', (SELECT presupuesto_estado = 'aprobado' AND aprobado_por = pg_temp.uid(2) AND aprobacion_via = 'local' AND aprobado_en IS NOT NULL FROM public.ordenes WHERE id = o));
END $$;

-- R/S/U/T/V · ajustes después de aprobar: solo la diferencia, con movimientos compensatorios ----------------------------------------
DO $$
DECLARE r jsonb; m bigint;
BEGIN
  r := pg_temp.editar(2550, 2526, 3, 90, 2511, 'repuesto_inventario');
  PERFORM pg_temp.t('R · 2→3 descuenta solo 1 (3→2)', pg_temp.stock(2511) = 2 AND pg_temp.aplicada(2526) = 3 AND (r->>'stock_movido')::numeric = 1);
  r := pg_temp.editar(2551, 2526, 1, 90, 2511, 'repuesto_inventario');
  PERFORM pg_temp.t('S · 3→1 devuelve solo 2 (2→4) con movimiento reverso', pg_temp.stock(2511) = 4 AND pg_temp.aplicada(2526) = 1
    AND EXISTS (SELECT 1 FROM public.inventario_movimientos WHERE orden_item_id = pg_temp.id(2526) AND op_id = pg_temp.id(2551) AND tipo = 'reverso_item_orden' AND cantidad = 2));
  m := pg_temp.movs();
  r := pg_temp.editar(2552, 2526, 1, 120, 2511, 'repuesto_inventario');
  PERFORM pg_temp.t('U · cambiar solo el precio no mueve stock', pg_temp.movs() = m AND pg_temp.stock(2511) = 4 AND (SELECT precio FROM public.orden_items WHERE id = pg_temp.id(2526)) = 120);
  r := pg_temp.editar(2553, 2522, 2, 175, NULL, 'mano_obra');
  PERFORM pg_temp.t('cambiar la mano de obra no mueve stock', pg_temp.movs() = m);
  r := pg_temp.editar(2554, 2526, 1, 180, 2513, 'repuesto_inventario');        -- V · Neumático → Aceite en UNA operación
  PERFORM pg_temp.t('V · A→B: vuelve el neumático (4→5) y sale el aceite (10→9) en la misma operación',
    pg_temp.stock(2511) = 5 AND pg_temp.stock(2513) = 9 AND pg_temp.aplicada(2526) = 1
    AND (SELECT count(*) FROM public.inventario_movimientos WHERE op_id = pg_temp.id(2554)) = 2
    AND (SELECT inventario_id FROM public.orden_items WHERE id = pg_temp.id(2526)) = pg_temp.id(2513));
  PERFORM pg_temp.t('V · el costo se vuelve a sellar con el del producto nuevo (110)', (SELECT costo_unitario FROM public.orden_items WHERE id = pg_temp.id(2526)) = 110);
  r := pg_temp.agregar(2555, pg_temp.id(2520), 2556, 2512, NULL, 1, 50, 'repuesto_inventario');
  PERFORM pg_temp.t('agregar a un presupuesto APROBADO descuenta en el acto (bujía 1→0)', pg_temp.stock(2512) = 0 AND pg_temp.aplicada(2556) = 1);
  PERFORM pg_temp.como(2); r := public.quitar_item_orden(pg_temp.id(2557), pg_temp.id(2556), 'dev'); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('T · quitar un repuesto aplicado devuelve exactamente lo aplicado (bujía 0→1)', pg_temp.stock(2512) = 1 AND (r->>'devuelto')::numeric = 1
    AND EXISTS (SELECT 1 FROM public.inventario_movimientos WHERE orden_item_id = pg_temp.id(2556) AND tipo = 'reverso_item_orden' AND cantidad = 1));
  PERFORM pg_temp.t('AC · el historial del renglón quitado se conserva (sus 2 movimientos siguen)', (SELECT count(*) FROM public.inventario_movimientos WHERE orden_item_id = pg_temp.id(2556)) = 2);
END $$;

-- P/Q · sin existencia: aborta TODO, nunca negativo -------------------------------------------------------------------------------
DO $$
DECLARE o uuid := pg_temp.nueva_orden(2560); m bigint;
BEGIN
  PERFORM pg_temp.agregar(2561, o, 2562, 2513, NULL, 2, 180, 'repuesto_inventario');       -- aceite: hay 9
  PERFORM pg_temp.agregar(2563, o, 2564, 2512, NULL, 5, 50, 'repuesto_inventario');        -- bujía: hay 1, se piden 5
  m := pg_temp.movs();
  PERFORM pg_temp.falla('P · aprobar sin existencia suficiente → error con el producto', format('SELECT pg_temp.decidir(2565, %L, %L)', o, 'aprobar'), 'SIN_EXISTENCIA.*Bujía \(hay 1');
  PERFORM pg_temp.t('P · no quedó NADA: sin movimientos (ni del aceite que sí alcanzaba), presupuesto sigue pendiente', pg_temp.movs() = m AND pg_temp.stock(2513) = 9
    AND (SELECT presupuesto_estado FROM public.ordenes WHERE id = o) = 'pendiente' AND pg_temp.aplicada(2562) = 0);
  PERFORM pg_temp.decidir(2566, pg_temp.id(2520), 'aprobar');
  PERFORM pg_temp.falla('Q · subir cantidad en un aprobado por encima de la existencia → rechazo', format('SELECT pg_temp.editar(2567, 2526, 50, 180, 2513, %L)', 'repuesto_inventario'), 'Sin stock suficiente|SIN_EXISTENCIA');
  PERFORM pg_temp.t('Q · ningún producto quedó negativo', NOT EXISTS (SELECT 1 FROM public.inventario WHERE cantidad < 0));
END $$;

-- J · rechazar: pendiente no mueve nada; aprobado→rechazado devuelve lo aplicado. Reabrir no mueve. No se «desaprueba» -------------
DO $$
DECLARE o uuid := pg_temp.nueva_orden(2570); m bigint; r jsonb;
BEGIN
  PERFORM pg_temp.agregar(2571, o, 2572, 2511, NULL, 1, 100, 'repuesto_inventario');
  m := pg_temp.movs();
  r := pg_temp.decidir(2573, o, 'rechazar');
  PERFORM pg_temp.t('J · rechazar un pendiente no toca stock', pg_temp.movs() = m AND (SELECT presupuesto_estado FROM public.ordenes WHERE id = o) = 'rechazado');
  r := pg_temp.decidir(2574, o, 'reabrir');
  PERFORM pg_temp.t('reabrir un rechazado vuelve a pendiente sin mover stock', pg_temp.movs() = m AND (SELECT presupuesto_estado FROM public.ordenes WHERE id = o) = 'pendiente');
  r := pg_temp.decidir(2575, o, 'aprobar');
  PERFORM pg_temp.t('aprobar después saca 1 (5→4)', pg_temp.stock(2511) = 4);
  PERFORM pg_temp.falla('no se «desaprueba» (reabrir un aprobado) → rechazo', format('SELECT pg_temp.decidir(2576, %L, %L)', o, 'reabrir'), 'Solo un presupuesto rechazado');
  r := pg_temp.decidir(2577, o, 'rechazar');
  PERFORM pg_temp.t('aprobado → rechazado devuelve lo aplicado (4→5)', pg_temp.stock(2511) = 5 AND pg_temp.aplicada(2572) = 0);
END $$;

-- cobro: un presupuesto nunca aprobado se aprueba al entregar/cobrar (sale el stock una vez); rechazado no se cobra -------------------
DO $$
DECLARE o uuid := pg_temp.nueva_orden(2580); r jsonb;
BEGIN
  PERFORM pg_temp.agregar(2581, o, 2582, 2513, NULL, 1, 180, 'repuesto_inventario');
  PERFORM pg_temp.agregar(2583, o, 2584, NULL, 'Mano de obra', 1, 200, 'mano_obra');
  UPDATE public.ordenes SET estado = 'entregado' WHERE id = o;
  PERFORM pg_temp.como(2); r := public.finalizar_orden(pg_temp.id(2585), o, 'contado', 'efectivo'); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('cobrar un presupuesto pendiente lo aprueba (vía entrega) y saca el aceite una vez', (SELECT presupuesto_estado = 'aprobado' AND aprobacion_via = 'entrega' AND finalizada FROM public.ordenes WHERE id = o) AND pg_temp.aplicada(2582) = 1);
  PERFORM pg_temp.t('ingreso 380 y margen con el costo histórico (110)', (r->>'total')::numeric = 380 AND (r->>'margen')::numeric = round((380 - 110) / 380.0 * 100, 2));
  PERFORM pg_temp.falla('una orden cobrada no cambia su presupuesto', format('SELECT pg_temp.decidir(2586, %L, %L)', o, 'rechazar'), 'ya se cobró');
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('no se editan renglones de una orden cobrada', format('SELECT public.actualizar_item_orden(%L, %L, 2, 180)', pg_temp.id(2587), pg_temp.id(2582)), 'ya está cerrada');
  PERFORM pg_temp.fin();
END $$;

-- anular/eliminar: vuelve EXACTAMENTE lo aplicado (un pendiente nuevo no devuelve nada que no salió) --------------------------------
DO $$
DECLARE o uuid := pg_temp.nueva_orden(2590); s0 numeric;
BEGIN
  PERFORM pg_temp.agregar(2591, o, 2592, 2511, NULL, 2, 100, 'repuesto_inventario');
  s0 := pg_temp.stock(2511);
  PERFORM pg_temp.como(1); PERFORM public.anular_orden(pg_temp.id(2593), o, 'cliente se fue', false, NULL, 'dev'); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('eliminar una orden con presupuesto PENDIENTE no infla el stock (antes devolvía la cantidad completa)', pg_temp.stock(2511) = s0);
END $$;

-- AD · el precio y el costo del renglón sobreviven a cambios del producto ------------------------------------------------------------
DO $$
BEGIN
  PERFORM pg_temp.adm(); UPDATE public.inventario SET precio_venta = 999, costo_compra = 555 WHERE id = pg_temp.id(2513); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('D/AD · precio 180 y costo 110 del renglón intactos tras cambiar el producto', (SELECT precio = 180 AND costo_unitario = 110 FROM public.orden_items WHERE id = pg_temp.id(2582)));
  PERFORM pg_temp.t('invariantes = [] (stock=ledger, renglon=ledger, aprobado=aplicado)', public.verificar_invariantes() = '[]'::jsonb);
END $$;

-- cotización: tipos validados; aceptar = aprobar (descuenta una vez); sin existencia aborta TODO --------------------------------------
DO $$
DECLARE cot uuid := pg_temp.id(2601); cot2 uuid := pg_temp.id(2610); r jsonb; m bigint; s numeric;
BEGIN
  INSERT INTO public.cotizaciones (id, cliente_id, moto_id, cliente_nombre, vence_en, estado) VALUES (cot, pg_temp.id(2501), pg_temp.id(2502), 'Cliente B2', now() + interval '9 days', 'pendiente');
  PERFORM pg_temp.como(2);
  PERFORM public.sync_guardar_items_cotizacion(pg_temp.id(2602), cot, jsonb_build_array(
    jsonb_build_object('tipo', 'mano_obra', 'nombre', 'Servicio', 'cantidad', 1, 'precio', 300),
    jsonb_build_object('tipo', 'repuesto_manual', 'nombre', 'Pieza especial', 'cantidad', 1, 'precio', 40),
    jsonb_build_object('tipo', 'repuesto_inventario', 'inventario_id', pg_temp.id(2511), 'nombre', 'Neumático', 'cantidad', 2, 'precio', 95)), 'dev');
  PERFORM pg_temp.falla('cotización: precio null → rechazo', format('SELECT public.sync_guardar_items_cotizacion(%L, %L, %L::jsonb)', pg_temp.id(2603), cot,
    jsonb_build_array(jsonb_build_object('tipo', 'mano_obra', 'nombre', 'x', 'cantidad', 1, 'precio', NULL))), 'falta o es negativo');
  PERFORM pg_temp.fin();
  s := pg_temp.stock(2511); m := pg_temp.movs();
  PERFORM pg_temp.como(2); r := public.convertir_cotizacion(pg_temp.id(2604), cot, pg_temp.id(2605)); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('aceptar la cotización = presupuesto APROBADO y los 2 neumáticos salen una vez', pg_temp.stock(2511) = s - 2
    AND (SELECT presupuesto_estado = 'aprobado' AND aprobacion_via = 'cotizacion' FROM public.ordenes WHERE id = pg_temp.id(2605)) AND (r->>'stock_movido')::numeric = 2);
  PERFORM pg_temp.t('la orden conserva tipos y precios de la cotización', (SELECT string_agg(tipo || ':' || precio::int, ',' ORDER BY creado_en) FROM public.orden_items WHERE orden_id = pg_temp.id(2605))
    = 'mano_obra:300,repuesto_manual:40,repuesto_inventario:95');
  -- sin existencia: 7 bujías (hay 1) → nada se crea ni se mueve, la cotización sigue pendiente
  INSERT INTO public.cotizaciones (id, cliente_nombre, vence_en, estado) VALUES (cot2, 'Sin stock', now() + interval '9 days', 'pendiente');
  INSERT INTO public.cotizacion_items (cotizacion_id, inventario_id, tipo, nombre, cantidad, precio) VALUES (cot2, pg_temp.id(2513), 'repuesto_inventario', 'Aceite', 1, 180), (cot2, pg_temp.id(2512), 'repuesto_inventario', 'Bujía', 7, 50);
  m := pg_temp.movs();
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('P · convertir sin existencia → SIN_EXISTENCIA con el producto', format('SELECT public.convertir_cotizacion(%L, %L, %L)', pg_temp.id(2611), cot2, pg_temp.id(2612)), 'SIN_EXISTENCIA.*Bujía');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('P · nada quedó: ni orden, ni cliente, ni movimientos, cotización pendiente', pg_temp.movs() = m AND NOT EXISTS (SELECT 1 FROM public.ordenes WHERE id = pg_temp.id(2612))
    AND (SELECT estado FROM public.cotizaciones WHERE id = cot2) = 'pendiente' AND NOT EXISTS (SELECT 1 FROM public.clientes WHERE nombre = 'Sin stock'));
  PERFORM pg_temp.t('invariantes = [] al final', public.verificar_invariantes() = '[]'::jsonb);
END $$;

-- dos renglones del MISMO producto en una orden: aprobar, rechazar y convertir funcionan (una operación mueve ambos renglones)
DO $$
DECLARE o uuid := pg_temp.nueva_orden(2620); s0 numeric := pg_temp.stock(2513); cot uuid := pg_temp.id(2630); r jsonb;
BEGIN
  PERFORM pg_temp.agregar(2621, o, 2622, 2513, 'Aceite motor', 1, 180, 'repuesto_inventario');
  PERFORM pg_temp.agregar(2623, o, 2624, 2513, 'Aceite caja', 2, 180, 'repuesto_inventario');
  PERFORM pg_temp.decidir(2625, o, 'aprobar');
  PERFORM pg_temp.t('dos renglones del mismo producto: aprobar descuenta 1 + 2 en una operación', pg_temp.stock(2513) = s0 - 3 AND pg_temp.aplicada(2622) = 1 AND pg_temp.aplicada(2624) = 2);
  PERFORM pg_temp.decidir(2626, o, 'rechazar');
  PERFORM pg_temp.t('…y rechazar devuelve ambos en una operación', pg_temp.stock(2513) = s0);
  INSERT INTO public.cotizaciones (id, cliente_nombre, vence_en, estado) VALUES (cot, 'Doble', now() + interval '9 days', 'pendiente');
  INSERT INTO public.cotizacion_items (cotizacion_id, inventario_id, tipo, nombre, cantidad, precio) VALUES (cot, pg_temp.id(2513), 'repuesto_inventario', 'A', 1, 180), (cot, pg_temp.id(2513), 'repuesto_inventario', 'B', 1, 180);
  PERFORM pg_temp.como(2); r := public.convertir_cotizacion(pg_temp.id(2631), cot, pg_temp.id(2632)); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('…y convertir una cotización con el mismo producto dos veces descuenta 2', pg_temp.stock(2513) = s0 - 2);
  PERFORM pg_temp.t('invariantes = []', public.verificar_invariantes() = '[]'::jsonb);
END $$;
