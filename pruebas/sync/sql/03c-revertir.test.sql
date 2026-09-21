-- SYNC-3b · rollback por lote y cierre tras confirmar. Base sin datos operativos; requiere sync-1, 2, 3 y 3b.
DO $$
DECLARE l uuid := pg_temp.id(600); r jsonb; n bigint; h text := repeat('e', 64);
        c uuid := pg_temp.id(610); i uuid := pg_temp.id(611); v uuid := pg_temp.id(612); cr uuid := pg_temp.id(613);
BEGIN
  PERFORM pg_temp.como(1);
  PERFORM public.import_iniciar(l, 'cliente-real', h, 'ENTI-R', '3.13.0', 6, '{}');
  PERFORM public.import_dry_run_ok(l, '{}');
  PERFORM public.import_aplicar_lote(l, 'clientes', jsonb_build_array(jsonb_build_object('id', c, 'nombre', 'Cliente R')));
  PERFORM public.import_aplicar_lote(l, 'inventario', jsonb_build_array(jsonb_build_object('id', i, 'nombre', 'Aceite', 'cantidad', 12, 'costo_compra', 10, 'precio_venta', 20)));
  PERFORM public.import_aplicar_lote(l, 'ventas', jsonb_build_array(jsonb_build_object('id', v, 'metodo_pago', 'efectivo', 'total', 40)));
  PERFORM public.import_aplicar_lote(l, 'venta_items', jsonb_build_array(jsonb_build_object('id', pg_temp.id(614), 'venta_id', v, 'inventario_id', i, 'nombre', 'Aceite', 'cantidad', 2, 'precio', 20)));
  PERFORM public.import_aplicar_lote(l, 'caja_movimientos', jsonb_build_array(jsonb_build_object('id', pg_temp.id(615), 'tipo', 'ingreso', 'categoria', 'Venta mostrador', 'monto', 40, 'venta_id', v)));
  PERFORM public.import_aplicar_lote(l, 'creditos', jsonb_build_array(jsonb_build_object('id', cr, 'cliente_id', c, 'cliente_nombre', 'Cliente R', 'total', 50, 'abonado', 10, 'saldo', 40, 'estado', 'parcial')));
  PERFORM public.import_aplicar_lote(l, 'abonos', jsonb_build_array(jsonb_build_object('id', pg_temp.id(616), 'id_abono', 'legacy:r:1', 'credito_id', cr, 'monto', 10, 'metodo_pago', 'efectivo')));
  PERFORM public.import_aplicar_lote(l, 'caja_movimientos', jsonb_build_array(jsonb_build_object('id', pg_temp.id(617), 'tipo', 'ingreso', 'categoria', 'Cobro de crédito', 'monto', 10, 'credito_id', cr, 'id_abono', 'legacy:r:1')));
  PERFORM public.import_cerrar_carga(l);
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('lote aplicado con datos financieros y ledger de apertura', (SELECT count(*) FROM public.ventas) = 1 AND (SELECT count(*) FROM public.caja_movimientos) = 2 AND (SELECT count(*) FROM public.inventario_movimientos) = 1);
  PERFORM pg_temp.adm();
  PERFORM pg_temp.fin();

  -- sin el mecanismo, ni siquiera un lote «aplicado» permite borrar a mano
  PERFORM pg_temp.falla('fuera del rollback la venta importada no se borra', format('DELETE FROM public.ventas WHERE id = %L', v), 'No se puede borrar físicamente');

  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('el cajero no revierte un lote', format('SELECT public.revertir_lote_importacion(%L)', l), 'Solo el administrador');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(1);
  r := public.revertir_lote_importacion(l);
  PERFORM pg_temp.fin();
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('rollback antes de confirmar: se van clientes, ventas, caja, créditos, abonos, inventario y ledger',
    (SELECT count(*) FROM public.clientes) = 0 AND (SELECT count(*) FROM public.ventas) = 0 AND (SELECT count(*) FROM public.caja_movimientos) = 0
    AND (SELECT count(*) FROM public.creditos) = 0 AND (SELECT count(*) FROM public.abonos) = 0 AND (SELECT count(*) FROM public.inventario) = 0
    AND (SELECT count(*) FROM public.inventario_movimientos) = 0);
  PERFORM pg_temp.adm();
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('el lote queda «revertido» y su evidencia (import_registros) se conserva', (SELECT estado = 'revertido' FROM public.import_lotes WHERE id = l) AND (SELECT count(*) FROM public.import_registros WHERE lote_id = l) > 0);
  PERFORM pg_temp.adm();
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('el trigger de RCV-34 sobre caja quedó HABILITADO otra vez', (SELECT tgenabled = 'O' FROM pg_trigger WHERE tgname = 'no_borrar_caja_ligada' AND tgrelid = 'public.caja_movimientos'::regclass));
  PERFORM pg_temp.adm();
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('la puerta de borrado quedó cerrada (sin lote activo)', COALESCE(current_setting('entimotors.rollback_lote', true), '') = '');
  PERFORM pg_temp.adm();
  PERFORM pg_temp.su();
  PERFORM pg_temp.falla('tras revertir, un delete sigue bloqueado', 'DELETE FROM public.import_registros', 'No se puede borrar físicamente');

  -- se puede volver a importar (el lote revertido no cuenta), y al CONFIRMAR todo se cierra
  l := pg_temp.id(601);
  PERFORM pg_temp.como(1);
  PERFORM public.import_iniciar(l, 'cliente-real', h, 'ENTI-R', '3.13.0', 6, '{}');
  PERFORM public.import_dry_run_ok(l, '{}');
  PERFORM public.import_aplicar_lote(l, 'clientes', jsonb_build_array(jsonb_build_object('id', c, 'nombre', 'Cliente R')));
  PERFORM public.import_aplicar_lote(l, 'ventas', jsonb_build_array(jsonb_build_object('id', v, 'metodo_pago', 'efectivo', 'total', 40)));
  PERFORM public.import_cerrar_carga(l);
  PERFORM public.import_confirmar_lote(l);
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('reimportar tras revertir funciona y se confirma', (SELECT estado = 'confirmado' FROM public.import_lotes WHERE id = l));
  PERFORM pg_temp.adm();
  PERFORM pg_temp.falla('confirmado: ya no se puede revertir', format('SELECT public.revertir_lote_importacion(%L)', l), 'CONFIRMADO');
  PERFORM pg_temp.falla('confirmado: un segundo import se rechaza', format('SELECT public.import_iniciar(NULL, ''otro'', %L, ''x'', ''3.13.0'', 6, ''{}'')', repeat('f', 64)), 'solo se permite uno');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.falla('confirmado: la venta importada no se borra ni por el superusuario', format('DELETE FROM public.ventas WHERE id = %L', v), 'No se puede borrar físicamente');
  PERFORM set_config('entimotors.rollback_lote', l::text, true);
  PERFORM pg_temp.falla('confirmado: ni con el permiso de rollback activado a mano', format('DELETE FROM public.ventas WHERE id = %L', v), 'No se puede borrar físicamente');
  PERFORM set_config('entimotors.rollback_lote', '', true);
END $$;
