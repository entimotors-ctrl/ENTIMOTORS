-- 3.15 · BLOQUE 2 · FIXTURES DE COMPATIBILIDAD creados con las funciones de 3.14.1 (cadena 1..10 + 15a, ANTES de sync-15b).
-- Equivalentes a producción: #4 (entregada, importada: renglón ligado ya descontado SIN ledger), #6 (presupuesto: renglón agregado por la
-- 3.14.1 en la nube → ledger −1; más un renglón agregado y quitado → ledger neto 0), #9 (8 manuales), #10 (vacía), cotización ab4277b6
-- (2 manuales sin producto), y una orden eliminada en 3.14 que devolvió su stock. Se guarda una foto del stock para comparar después.
DO $$
DECLARE r jsonb;
BEGIN
  INSERT INTO public.clientes (id, nombre, telefono) VALUES (pg_temp.id(2701), 'Legado', '');
  INSERT INTO public.motos (id, cliente_id, marca, modelo) VALUES (pg_temp.id(2702), pg_temp.id(2701), 'Bajaj', 'Boxer');
  INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES (pg_temp.id(2711), 'neumático 4.60 -17', 120, 50), (pg_temp.id(2712), 'sello de barra', 50, 25);
  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES (pg_temp.id(2711), 'importacion', 24), (pg_temp.id(2712), 'importacion', 10);
  -- #4: entregada sin cobrar, con aprobación registrada; el renglón viene de la importación (su stock ya salió en la 3.13)
  INSERT INTO public.ordenes (id, cliente_id, moto_id, estado, falla, aprobacion) VALUES (pg_temp.id(2704), pg_temp.id(2701), pg_temp.id(2702), 'entregado', 'legado #4', '{"via":"local","en":1724131330000}');
  INSERT INTO public.orden_items (id, orden_id, inventario_id, nombre, cantidad, precio, costo_unitario) VALUES
    (pg_temp.id(2741), pg_temp.id(2704), pg_temp.id(2711), 'neumático 4.60 -17', 1, 120, 50), (pg_temp.id(2742), pg_temp.id(2704), NULL, 'mano de obra', 1, 500, 0);
  -- #6: presupuesto; en la 3.14.1 (nube) se agregó el neumático (sale 1 por el ledger) y se agregó y quitó el sello (neto 0)
  INSERT INTO public.ordenes (id, cliente_id, moto_id, estado, falla) VALUES (pg_temp.id(2706), pg_temp.id(2701), pg_temp.id(2702), 'presupuesto', 'legado #6');
  PERFORM pg_temp.como(2);
  r := public.agregar_item_orden(pg_temp.id(2761), pg_temp.id(2706), pg_temp.id(2712), NULL, 1, 50, pg_temp.id(2762), false, NULL, 'dev');
  r := public.quitar_item_orden(pg_temp.id(2763), pg_temp.id(2762), 'dev');
  r := public.agregar_item_orden(pg_temp.id(2764), pg_temp.id(2706), pg_temp.id(2711), NULL, 1, 120, pg_temp.id(2765), false, NULL, 'dev');
  r := public.agregar_item_orden(pg_temp.id(2766), pg_temp.id(2706), NULL, 'revisión', 1, 100, pg_temp.id(2767), false, NULL, 'dev');
  PERFORM pg_temp.fin();
  -- #9: 8 renglones manuales importados; #10: vacía
  INSERT INTO public.ordenes (id, cliente_id, moto_id, estado, falla) VALUES (pg_temp.id(2709), pg_temp.id(2701), pg_temp.id(2702), 'presupuesto', 'legado #9'), (pg_temp.id(2710), pg_temp.id(2701), pg_temp.id(2702), 'presupuesto', 'legado #10');
  INSERT INTO public.orden_items (orden_id, nombre, cantidad, precio) SELECT pg_temp.id(2709), 'manual ' || g, 1, 10 * g FROM generate_series(1, 8) g;
  -- cotización tipo ab4277b6: pendiente, sin cliente/moto, 2 renglones manuales que NO coinciden con ningún producto
  INSERT INTO public.cotizaciones (id, cliente_nombre, moto_desc, vence_en, estado) VALUES (pg_temp.id(2790), 'Walk-in legado', 'Bajaj Pulsar', now() - interval '18 days', 'pendiente');
  INSERT INTO public.cotizacion_items (cotizacion_id, inventario_id, nombre, cantidad, precio) VALUES (pg_temp.id(2790), NULL, 'aceite bajaj', 1, 250), (pg_temp.id(2790), NULL, 'bujía de motor', 1, 120);
  -- orden eliminada en la 3.14 (sin cobro): su renglón salió (−1) y volvió al eliminarla (+1)
  INSERT INTO public.ordenes (id, cliente_id, moto_id, estado, falla) VALUES (pg_temp.id(2780), pg_temp.id(2701), pg_temp.id(2702), 'recibido', 'eliminada 3.14');
  PERFORM pg_temp.como(2); r := public.agregar_item_orden(pg_temp.id(2781), pg_temp.id(2780), pg_temp.id(2712), NULL, 1, 50, pg_temp.id(2782), false, NULL, 'dev'); PERFORM pg_temp.fin();
  PERFORM pg_temp.como(1); r := public.anular_orden(pg_temp.id(2783), pg_temp.id(2780), 'eliminada en 3.14', false, NULL, 'dev'); PERFORM pg_temp.fin();
  CREATE TABLE public._t15b_antes AS SELECT id, cantidad FROM public.inventario;
  CREATE TABLE public._t15b_ledger AS SELECT count(*) AS n, COALESCE(sum(cantidad), 0) AS s FROM public.inventario_movimientos;
END $$;
