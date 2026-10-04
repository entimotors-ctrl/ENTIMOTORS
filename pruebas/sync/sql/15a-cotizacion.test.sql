-- 3.15.0 · BLOQUE 1A · cotización ↔ inventario + conversión atómica. Requiere 00-prelude.sql, la cadena SYNC 1..10 y sync-15a.
-- Cuentas: 1 admin · 2 cajero · 3 mecánico A · 6 mecánico INACTIVO. Ids de datos: pg_temp.id(15xx).
DO $$
BEGIN
  INSERT INTO public.clientes (id, nombre, telefono) VALUES (pg_temp.id(1501), 'Cliente 15A', '9999');
  INSERT INTO public.motos (id, cliente_id, marca, modelo) VALUES (pg_temp.id(1502), pg_temp.id(1501), 'Honda', 'CB190R');
  INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES
    (pg_temp.id(1511), 'Neumático', 100, 60), (pg_temp.id(1512), 'Bujía', 50, 20);
  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES (pg_temp.id(1511), 'apertura', 5), (pg_temp.id(1512), 'apertura', 1);
END $$;
CREATE FUNCTION pg_temp.huella_stock() RETURNS text LANGUAGE sql AS $$
  SELECT (SELECT count(*) FROM public.inventario_movimientos)::text || '|' || (SELECT string_agg(id::text || '=' || cantidad, ',' ORDER BY id) FROM public.inventario) $$;
CREATE FUNCTION pg_temp.guardar(p_cajero int, p_op uuid, p_cot uuid, p_items jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN PERFORM pg_temp.como(p_cajero); r := public.sync_guardar_items_cotizacion(p_op, p_cot, p_items, 'dev'); PERFORM pg_temp.fin(); RETURN r; END $$;

-- K/A/B · cotización PENDIENTE con 2 repuestos del inventario (precio editado: 90 en vez de 100) + 1 renglón manual ---------------
DO $$
DECLARE cot uuid := pg_temp.id(1520); antes text;
BEGIN
  INSERT INTO public.cotizaciones (id, cliente_id, moto_id, cliente_nombre, moto_desc, diagnostico, vence_en, estado)
  VALUES (cot, pg_temp.id(1501), pg_temp.id(1502), 'Cliente 15A', 'Honda CB190R', 'cambio de llanta', now() + interval '15 days', 'pendiente');
  antes := pg_temp.huella_stock();
  PERFORM pg_temp.guardar(2, pg_temp.id(1521), cot, jsonb_build_array(
    jsonb_build_object('nombre', 'Neumático', 'cantidad', 2, 'precio', 90, 'inventario_id', pg_temp.id(1511)),
    jsonb_build_object('nombre', 'Bujía', 'cantidad', 3, 'precio', 50, 'inventario_id', pg_temp.id(1512)),
    jsonb_build_object('nombre', 'Mano de obra', 'cantidad', 1, 'precio', 250, 'inventario_id', NULL)));
  PERFORM pg_temp.t('A · el repuesto conserva inventario_id en la nube', (SELECT inventario_id FROM public.cotizacion_items WHERE cotizacion_id = cot AND nombre = 'Neumático') = pg_temp.id(1511));
  PERFORM pg_temp.t('B · el renglón manual queda con inventario_id NULL', (SELECT inventario_id IS NULL FROM public.cotizacion_items WHERE cotizacion_id = cot AND nombre = 'Mano de obra'));
  PERFORM pg_temp.t('K · guardar una cotización PENDIENTE (incluso pidiendo más de lo que hay: 3 bujías, hay 1) no mueve stock', pg_temp.huella_stock() = antes);
END $$;

-- L · cotización RECHAZADA no mueve stock -------------------------------------------------------------------------------------
DO $$
DECLARE cot uuid := pg_temp.id(1530); antes text;
BEGIN
  INSERT INTO public.cotizaciones (id, cliente_nombre, moto_desc, vence_en, estado) VALUES (cot, 'Walk-in 15A', 'Yamaha YBR125 · placa HAA-1234', now() + interval '15 days', 'pendiente');
  PERFORM pg_temp.guardar(2, pg_temp.id(1531), cot, jsonb_build_array(jsonb_build_object('nombre', 'Neumático', 'cantidad', 1, 'precio', 100, 'inventario_id', pg_temp.id(1511))));
  antes := pg_temp.huella_stock();
  PERFORM pg_temp.como(2); UPDATE public.cotizaciones SET estado = 'rechazada' WHERE id = cot; PERFORM pg_temp.fin();
  PERFORM pg_temp.t('L · marcar RECHAZADA no mueve stock', pg_temp.huella_stock() = antes AND (SELECT estado FROM public.cotizaciones WHERE id = cot) = 'rechazada');
END $$;

-- C/D/E/H/I · convertir: 1 orden, reintento con el MISMO op = mismo resultado, sin stock, vínculos y precios conservados ------------
DO $$
DECLARE cot uuid := pg_temp.id(1520); r1 jsonb; r2 jsonb; o uuid; antes text;
BEGIN
  antes := pg_temp.huella_stock();
  PERFORM pg_temp.como(2);
  r1 := public.convertir_cotizacion(pg_temp.id(1540), cot, pg_temp.id(1541), NULL, 'dev-a');
  r2 := public.convertir_cotizacion(pg_temp.id(1540), cot, pg_temp.id(1541), NULL, 'dev-a');   -- doble clic / reintento: mismo op
  PERFORM pg_temp.fin();
  o := (r1->>'orden_id')::uuid;
  PERFORM pg_temp.t('C · la conversión devuelve la orden pedida por el cliente (p_orden_id)', o = pg_temp.id(1541));
  PERFORM pg_temp.t('C · exactamente 1 orden para la cotización', (SELECT count(*) FROM public.ordenes WHERE id = o) = 1 AND (SELECT orden_id FROM public.cotizaciones WHERE id = cot) = o);
  PERFORM pg_temp.t('D/E · el reintento con el mismo op devuelve el MISMO resultado (repetida) sin crear otra orden', (r2->>'orden_id')::uuid = o AND (r2->>'repetida')::boolean
      AND (SELECT count(*) FROM public.ordenes WHERE cliente_id = pg_temp.id(1501)) = 1);
  PERFORM pg_temp.t('C · la cotización queda aceptada con fecha', (SELECT estado = 'aceptada' AND aceptada_en IS NOT NULL FROM public.cotizaciones WHERE id = cot));
  PERFORM pg_temp.t('H · la orden conserva inventario_id de CADA repuesto (aunque no alcance el stock) y el manual queda sin vínculo',
      (SELECT count(*) FROM public.orden_items WHERE orden_id = o AND inventario_id = pg_temp.id(1511)) = 1
      AND (SELECT count(*) FROM public.orden_items WHERE orden_id = o AND inventario_id = pg_temp.id(1512)) = 1
      AND (SELECT count(*) FROM public.orden_items WHERE orden_id = o AND inventario_id IS NULL AND nombre = 'Mano de obra') = 1);
  PERFORM pg_temp.t('I · precio histórico: el renglón de la orden usa el precio de la cotización (90), no el del producto (100)',
      (SELECT precio FROM public.orden_items WHERE orden_id = o AND inventario_id = pg_temp.id(1511)) = 90);
  PERFORM pg_temp.t('costo sellado al convertir (60 y 20) y 0 en el manual',
      (SELECT string_agg(costo_unitario::text, ',' ORDER BY creado_en) FROM public.orden_items WHERE orden_id = o) = '60.00,20.00,0.00');
  PERFORM pg_temp.t('orden de los renglones = orden de la cotización', (SELECT string_agg(nombre, ',' ORDER BY creado_en, id) FROM public.orden_items WHERE orden_id = o) = 'Neumático,Bujía,Mano de obra');
  PERFORM pg_temp.t('Bloque 2 · convertir NO mueve stock (ledger y cantidades idénticos; resultado stock_movido=false)',
      pg_temp.huella_stock() = antes AND (r1->>'stock_movido')::boolean = false AND (r1->>'items_inventario')::int = 2);
  PERFORM pg_temp.t('orden nueva sin mecánico (nunca por nombre) y en «recibido»', (SELECT mecanico_id IS NULL AND mecanico = '' AND estado = 'recibido' AND NOT finalizada FROM public.ordenes WHERE id = o));
  PERFORM pg_temp.t('auditoría de la conversión con el cajero', EXISTS (SELECT 1 FROM public.auditoria WHERE operation_id = pg_temp.id(1540) AND accion = 'convertir' AND usuario_id = pg_temp.uid(2)));
END $$;

-- J · cambiar después el precio/costo del producto NO cambia la cotización ni la orden históricas --------------------------------
DO $$
DECLARE o uuid := pg_temp.id(1541);
BEGIN
  PERFORM pg_temp.adm(); UPDATE public.inventario SET precio_venta = 175, costo_compra = 99 WHERE id = pg_temp.id(1511); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('J · la cotización sigue a 90', (SELECT precio FROM public.cotizacion_items WHERE cotizacion_id = pg_temp.id(1520) AND nombre = 'Neumático') = 90);
  PERFORM pg_temp.t('J · la orden sigue a 90 con costo 60', (SELECT precio = 90 AND costo_unitario = 60 FROM public.orden_items WHERE orden_id = o AND inventario_id = pg_temp.id(1511)));
END $$;

-- F (secuencial) · otro dispositivo, OTRO op, sobre la cotización ya convertida → rechazo terminal, sin segunda orden --------------
DO $$
BEGIN
  PERFORM pg_temp.como(1);
  PERFORM pg_temp.falla('F · otro op (otro dispositivo) sobre una cotización ya aceptada → COTIZACION_YA_ACEPTADA',
    format('SELECT public.convertir_cotizacion(%L, %L, %L)', pg_temp.id(1542), pg_temp.id(1520), pg_temp.id(1543)), 'COTIZACION_YA_ACEPTADA');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('F · sigue habiendo UNA sola orden y la segunda no existe', (SELECT count(*) FROM public.ordenes WHERE id IN (pg_temp.id(1541), pg_temp.id(1543))) = 1);
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('mismo op con otros parámetros → OP_ID_REUTILIZADO', format('SELECT public.convertir_cotizacion(%L, %L, %L)', pg_temp.id(1540), pg_temp.id(1520), pg_temp.id(1599)), 'OP_ID_REUTILIZADO');
  PERFORM pg_temp.fin();
END $$;

-- guarda de aceptada: ni el CRUD ni un cliente viejo la «des-aceptan», cambian su orden o reemplazan sus renglones ----------------
DO $$
DECLARE cot uuid := pg_temp.id(1520);
BEGIN
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('aceptada → pendiente por el CRUD: rechazado', format('UPDATE public.cotizaciones SET estado = %L WHERE id = %L', 'pendiente', cot), 'COTIZACION_YA_ACEPTADA');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.falla('cambiar orden_id de una aceptada (aun como superusuario): rechazado', format('UPDATE public.cotizaciones SET orden_id = %L WHERE id = %L', pg_temp.id(1599), cot), 'COTIZACION_YA_ACEPTADA');
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('reemplazar renglones de una aceptada: rechazado', format('SELECT public.sync_guardar_items_cotizacion(%L, %L, %L::jsonb)', pg_temp.id(1544), cot, '[]'), 'COTIZACION_YA_ACEPTADA');
  UPDATE public.cotizaciones SET notas = 'nota posterior' WHERE id = cot;   -- editar otros campos sí se permite
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('editar notas de una aceptada sigue permitido', (SELECT notas FROM public.cotizaciones WHERE id = cot) = 'nota posterior');
  PERFORM pg_temp.t('los renglones de la aceptada siguen intactos', (SELECT count(*) FROM public.cotizacion_items WHERE cotizacion_id = cot) = 3);
END $$;

-- rechazada → se puede convertir; cliente/moto se crean con placa bien separada; mecánico real por uuid --------------------------
DO $$
DECLARE cot uuid := pg_temp.id(1530); r jsonb; o uuid; m record;
BEGIN
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('mecánico inválido (es un cajero) → rechazo', format('SELECT public.convertir_cotizacion(%L, %L, NULL, %L)', pg_temp.id(1550), cot, pg_temp.uid(2)), 'no existe o no está activo');
  PERFORM pg_temp.falla('mecánico INACTIVO → rechazo', format('SELECT public.convertir_cotizacion(%L, %L, NULL, %L)', pg_temp.id(1551), cot, pg_temp.uid(6)), 'no existe o no está activo');
  r := public.convertir_cotizacion(pg_temp.id(1552), cot, pg_temp.id(1553), pg_temp.uid(3), 'dev-b');
  PERFORM pg_temp.fin();
  o := (r->>'orden_id')::uuid;
  SELECT mo.marca, mo.modelo, mo.placa, cl.nombre INTO m FROM public.ordenes od JOIN public.motos mo ON mo.id = od.moto_id JOIN public.clientes cl ON cl.id = od.cliente_id WHERE od.id = o;
  PERFORM pg_temp.t('una cotización RECHAZADA se puede convertir (el cliente cambió de opinión)', o = pg_temp.id(1553));
  PERFORM pg_temp.t('cliente y moto nuevos: Yamaha / YBR125 / placa HAA-1234 (la placa no queda en el modelo)', m.marca = 'Yamaha' AND m.modelo = 'YBR125' AND m.placa = 'HAA-1234' AND m.nombre = 'Walk-in 15A');
  PERFORM pg_temp.t('mecánico asignado por uuid y su nombre sale de su perfil', (SELECT mecanico_id = pg_temp.uid(3) AND mecanico = 'Usuario 3' FROM public.ordenes WHERE id = o));
END $$;

-- permisos y errores terminales ------------------------------------------------------------------------------------------------
DO $$
DECLARE cot uuid := pg_temp.id(1560);
BEGIN
  INSERT INTO public.cotizaciones (id, cliente_nombre, vence_en, estado) VALUES (cot, 'Sin renglones', now() + interval '15 days', 'pendiente');
  PERFORM pg_temp.como(3);
  PERFORM pg_temp.falla('un mecánico no convierte cotizaciones', format('SELECT public.convertir_cotizacion(%L, %L)', pg_temp.id(1561), cot), 'Solo el administrador o el cajero');
  PERFORM pg_temp.como(0);
  PERFORM pg_temp.falla('anon no ejecuta convertir_cotizacion', format('SELECT public.convertir_cotizacion(%L, %L)', pg_temp.id(1562), cot), 'permission denied');
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('sin renglones → rechazo', format('SELECT public.convertir_cotizacion(%L, %L)', pg_temp.id(1563), cot), 'no tiene renglones');
  PERFORM pg_temp.falla('cotización inexistente → 23503', format('SELECT public.convertir_cotizacion(%L, %L)', pg_temp.id(1564), pg_temp.id(1569)), 'no existe');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.t('ningún intento fallido dejó orden, cliente o moto sueltos', (SELECT count(*) FROM public.ordenes) = 2 AND (SELECT count(*) FROM public.sync_ops WHERE op_id IN (pg_temp.id(1561), pg_temp.id(1563), pg_temp.id(1564))) = 0);
  PERFORM pg_temp.t('invariantes del servidor = []', public.verificar_invariantes() = '[]'::jsonb);
END $$;
