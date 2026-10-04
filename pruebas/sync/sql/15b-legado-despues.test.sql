-- 3.15 · BLOQUE 2 · COMPATIBILIDAD: tras aplicar sync-15b sobre los fixtures de 15b-legado-antes.sql.
DO $$
BEGIN
  PERFORM pg_temp.t('la migración NO movió stock: existencias idénticas a la foto previa', NOT EXISTS (SELECT 1 FROM public.inventario i JOIN public._t15b_antes a USING (id) WHERE i.cantidad <> a.cantidad));
  PERFORM pg_temp.t('la migración NO tocó el ledger (mismas filas y suma)', (SELECT count(*) FROM public.inventario_movimientos) = (SELECT n FROM public._t15b_ledger)
    AND (SELECT sum(cantidad) FROM public.inventario_movimientos) = (SELECT s FROM public._t15b_ledger));
  PERFORM pg_temp.t('ORDER_4 · renglón ligado: repuesto_inventario, aplicada 1, legado 1 (consumido en la 3.13 sin ledger)',
    (SELECT tipo = 'repuesto_inventario' AND cantidad_aplicada = 1 AND aplicada_legado = 1 FROM public.orden_items WHERE id = pg_temp.id(2741)));
  PERFORM pg_temp.t('ORDER_4 · presupuesto aprobado (tenía aprobación registrada) y su mano de obra queda «sin clasificar»',
    (SELECT presupuesto_estado = 'aprobado' AND aprobacion_via = 'local' FROM public.ordenes WHERE id = pg_temp.id(2704)) AND (SELECT tipo IS NULL FROM public.orden_items WHERE id = pg_temp.id(2742)));
  PERFORM pg_temp.t('ORDER_6 · renglón ligado: aplicada 1, legado 0 (su ledger −1 lo explica); presupuesto PENDIENTE',
    (SELECT cantidad_aplicada = 1 AND aplicada_legado = 0 FROM public.orden_items WHERE id = pg_temp.id(2765)) AND (SELECT presupuesto_estado FROM public.ordenes WHERE id = pg_temp.id(2706)) = 'pendiente');
  PERFORM pg_temp.t('ORDER_9 · sus 8 renglones siguen manuales («sin clasificar», sin producto)', (SELECT count(*) FILTER (WHERE tipo IS NULL AND inventario_id IS NULL) FROM public.orden_items WHERE orden_id = pg_temp.id(2709)) = 8);
  PERFORM pg_temp.t('ORDER_10 · vacía y pendiente', (SELECT count(*) FROM public.orden_items WHERE orden_id = pg_temp.id(2710)) = 0 AND (SELECT presupuesto_estado FROM public.ordenes WHERE id = pg_temp.id(2710)) = 'pendiente');
  PERFORM pg_temp.t('QUOTE ab4277b6 · sus 2 renglones siguen manuales (nunca se infiere por el nombre)', (SELECT count(*) FROM public.cotizacion_items WHERE cotizacion_id = pg_temp.id(2790) AND tipo IS NULL AND inventario_id IS NULL) = 2);
  PERFORM pg_temp.t('orden eliminada en 3.14 que devolvió su stock: aplicada 0, legado 0', (SELECT cantidad_aplicada = 0 AND aplicada_legado = 0 FROM public.orden_items WHERE id = pg_temp.id(2782)));
  PERFORM pg_temp.t('invariantes = [] tras el backfill', public.verificar_invariantes() = '[]'::jsonb);
END $$;

-- W · #6: aprobar NO vuelve a descontar su neumático; X · #4: re-aprobar / cobrar NO lo vuelve a descontar
DO $$
DECLARE s numeric; m bigint; r jsonb;
BEGIN
  s := (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(2711)); m := (SELECT count(*) FROM public.inventario_movimientos);
  PERFORM pg_temp.como(2); r := public.decidir_presupuesto_orden(pg_temp.id(2800), pg_temp.id(2706), 'aprobar', 'local', 'dev'); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('W · aprobar #6: el neumático ya aplicado NO se descuenta otra vez', (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(2711)) = s
    AND (SELECT count(*) FROM public.inventario_movimientos) = m AND (r->>'stock_movido')::numeric = 0);
  PERFORM pg_temp.como(2); r := public.decidir_presupuesto_orden(pg_temp.id(2801), pg_temp.id(2704), 'aprobar', 'local', 'dev'); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('X · re-aprobar #4 no descuenta (ya_estaba, 0 movido)', (r->>'ya_estaba')::boolean AND (r->>'stock_movido')::numeric = 0);
  PERFORM pg_temp.como(2); r := public.finalizar_orden(pg_temp.id(2802), pg_temp.id(2704), 'contado', 'efectivo'); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('X · cobrar #4 no descuenta su neumático legado; total 620 con su costo histórico 50', (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(2711)) = s
    AND (SELECT count(*) FROM public.inventario_movimientos) = m AND (r->>'total')::numeric = 620);
  PERFORM pg_temp.t('invariantes = []', public.verificar_invariantes() = '[]'::jsonb);
END $$;

-- #6: quitar su neumático (sí salió) lo devuelve; la cotización legado se acepta con renglones manuales, sin stock
DO $$
DECLARE s numeric; r jsonb;
BEGIN
  s := (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(2711));
  PERFORM pg_temp.como(2); r := public.quitar_item_orden(pg_temp.id(2803), pg_temp.id(2765), 'dev'); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('#6 · quitar el neumático aplicado lo devuelve (1) con movimiento compensatorio', (SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(2711)) = s + 1 AND (r->>'devuelto')::numeric = 1);
  s := (SELECT sum(cantidad) FROM public.inventario);
  PERFORM pg_temp.como(2); r := public.convertir_cotizacion(pg_temp.id(2804), pg_temp.id(2790), pg_temp.id(2805)); PERFORM pg_temp.fin();
  PERFORM pg_temp.t('Z · la cotización legado se convierte con sus 2 renglones SIN producto y sin tocar stock', (SELECT sum(cantidad) FROM public.inventario) = s
    AND (SELECT count(*) FROM public.orden_items WHERE orden_id = pg_temp.id(2805) AND inventario_id IS NULL AND tipo IS NULL) = 2);
  PERFORM pg_temp.t('invariantes = [] al final', public.verificar_invariantes() = '[]'::jsonb);
END $$;
