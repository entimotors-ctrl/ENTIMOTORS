-- SYNC-10 · importación ATÓMICA del respaldo 3.13 (import_aplicar_paquete) + P0002 → 23503.
-- Requiere 00-prelude.sql y la cadena 1, 2, 3, 3b, 3p, 5, 6, 7a, 9 + 10, sobre una base SIN datos operativos.
-- Datos 100 % sintéticos. «Nombre Secreto 555» sirve para comprobar que un error NUNCA devuelve datos personales.

-- 1. AUTORIZACIÓN: solo el administrador ACTIVO; ni cajero, ni mecánico, ni anónimo, ni inactivo --------------------
DO $$
DECLARE l uuid := pg_temp.id(600); h text := repeat('e', 64);
BEGIN
  PERFORM pg_temp.como(1);
  PERFORM public.import_iniciar(l, 'legado-313', h, 'ENTI-SYNC10', '3.13.0', 6, '{}');
  PERFORM public.import_dry_run_ok(l, '{"validado_en_cliente":true}');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('el cajero NO importa', format('SELECT public.import_aplicar_paquete(%L, ''{"clientes":[]}'')', l), 'Solo el administrador');
  PERFORM pg_temp.falla('el cajero NO consulta el estado del lote', format('SELECT public.import_estado(%L)', l), 'Solo el administrador');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(3);
  PERFORM pg_temp.falla('el mecánico NO importa', format('SELECT public.import_aplicar_paquete(%L, ''{"clientes":[]}'')', l), 'Solo el administrador');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(0);
  PERFORM pg_temp.falla('anónimo NO ejecuta la función', format('SELECT public.import_aplicar_paquete(%L, ''{"clientes":[]}'')', l), 'permission denied');
  PERFORM pg_temp.falla('anónimo NO consulta el estado', format('SELECT public.import_estado(%L)', l), 'permission denied');
  PERFORM pg_temp.fin();
  UPDATE public.perfiles SET activo = false WHERE id = pg_temp.uid(1);
  PERFORM pg_temp.como(1);
  PERFORM pg_temp.falla('un administrador DESACTIVADO no importa', format('SELECT public.import_aplicar_paquete(%L, ''{"clientes":[]}'')', l), 'Solo el administrador');
  PERFORM pg_temp.fin();
  UPDATE public.perfiles SET activo = true WHERE id = pg_temp.uid(1);
END $$;

-- 2. VALIDACIONES Y TODO-O-NADA -------------------------------------------------------------------------------------
DO $$
DECLARE l uuid := pg_temp.id(600); p jsonb; msg text; det text; st text; c uuid := pg_temp.id(610); m uuid := pg_temp.id(611); v uuid := pg_temp.id(613);
BEGIN
  PERFORM pg_temp.como(1);
  PERFORM pg_temp.falla('un lote inexistente se rechaza', format('SELECT public.import_aplicar_paquete(%L, ''{"clientes":[]}'')', pg_temp.id(699)), 'no existe');
  PERFORM pg_temp.falla('un paquete sin datos se rechaza', format('SELECT public.import_aplicar_paquete(%L, ''{}'')', l), 'ningún dato');
  PERFORM pg_temp.falla('una tabla con formato inválido se rechaza', format('SELECT public.import_aplicar_paquete(%L, ''{"clientes":{"x":1}}'')', l), 'formato inválido');

  -- (a) venta que NO cuadra con sus renglones: clientes ya insertados en la misma llamada → se cancela TODO
  p := jsonb_build_object(
    'clientes', jsonb_build_array(jsonb_build_object('id', c, 'nombre', 'Nombre Secreto 555', 'telefono', '555-0000', 'dispositivo', 'legado-313', 'local_id', 1)),
    'ventas', jsonb_build_array(jsonb_build_object('id', v, 'cliente_id', c, 'metodo_pago', 'efectivo', 'total', 999, 'dispositivo', 'legado-313', 'local_id', 1)),
    'venta_items', jsonb_build_array(jsonb_build_object('id', pg_temp.id(630), 'venta_id', v, 'nombre', 'X', 'cantidad', 1, 'precio', 100)));
  PERFORM pg_temp.falla('dinero que no cuadra (venta ≠ renglones) → se rechaza entero', format('SELECT public.import_aplicar_paquete(%L, %L)', l, p), 'rompe invariantes');

  -- (b) fallo a MITAD (orden con etapa inválida después de clientes y motos): nada queda, y el error no trae datos personales
  p := jsonb_build_object(
    'clientes', jsonb_build_array(jsonb_build_object('id', c, 'nombre', 'Nombre Secreto 555', 'telefono', '555-0000', 'dispositivo', 'legado-313', 'local_id', 1)),
    'motos', jsonb_build_array(jsonb_build_object('id', m, 'cliente_id', c, 'marca', 'Honda', 'placa', 'SEC-555', 'dispositivo', 'legado-313', 'local_id', 1)),
    'ordenes', jsonb_build_array(jsonb_build_object('id', pg_temp.id(615), 'cliente_id', c, 'moto_id', m, 'estado', 'inventado', 'falla', 'Nombre Secreto 555', 'dispositivo', 'legado-313', 'local_id', 1)));
  BEGIN
    PERFORM public.import_aplicar_paquete(l, p);
    msg := NULL;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, det = PG_EXCEPTION_DETAIL, st = RETURNED_SQLSTATE;
  END;
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('fallo a mitad → error de clase 22 (HTTP 400, terminal) que nombra la tabla', st = '22000' AND msg ~ 'ordenes');
  PERFORM pg_temp.t('el error NO devuelve datos personales (ni en el mensaje ni en el DETAIL)', msg !~ 'Secreto' AND COALESCE(det, '') !~ 'Secreto' AND COALESCE(det, '') !~ '555');
  PERFORM pg_temp.t('TODO O NADA: tras los fallos no quedó ni un cliente, moto, venta ni registro del lote',
    (SELECT count(*) FROM public.clientes) + (SELECT count(*) FROM public.motos) + (SELECT count(*) FROM public.ventas) + (SELECT count(*) FROM public.import_registros) = 0
    AND (SELECT estado FROM public.import_lotes WHERE id = l) = 'dry_run_ok');

  -- (c) la nube dejó de estar vacía entre el dry-run y la importación (otro dispositivo creó algo) → NO se importa encima
  INSERT INTO public.clientes (id, nombre) VALUES (pg_temp.id(698), 'Creado en otro dispositivo');
  PERFORM pg_temp.adm();
  p := jsonb_build_object('clientes', jsonb_build_array(jsonb_build_object('id', c, 'nombre', 'Nombre Secreto 555', 'dispositivo', 'legado-313', 'local_id', 1)));
  PERFORM pg_temp.falla('nube NO vacía al aplicar → se niega (sin merge)', format('SELECT public.import_aplicar_paquete(%L, %L)', l, p), 'ya tiene datos');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('el dato ajeno sigue intacto y no entró nada del respaldo', (SELECT count(*) FROM public.clientes) = 1 AND NOT EXISTS (SELECT 1 FROM public.clientes WHERE id = c));
  PERFORM set_config('session_replication_role', 'replica', true);   -- el guard de borrado físico: solo aquí, en la base de pruebas
  DELETE FROM public.clientes WHERE id = pg_temp.id(698);
  PERFORM set_config('session_replication_role', 'origin', true);
  PERFORM pg_temp.fin();
END $$;

-- 3. IMPORTACIÓN COMPLETA: relaciones, dinero histórico, stock exacto (0, 1, alto, negativo), invariantes -----------
DO $$
DECLARE l uuid := pg_temp.id(600); p jsonb; r jsonb; r2 jsonb; f jsonb;
  cat uuid := pg_temp.id(640); c1 uuid := pg_temp.id(641); c2 uuid := pg_temp.id(642); mo uuid := pg_temp.id(643);
  i0 uuid := pg_temp.id(644); i1 uuid := pg_temp.id(645); ia uuid := pg_temp.id(646); ineg uuid := pg_temp.id(647);
  o uuid := pg_temp.id(648); v uuid := pg_temp.id(649); cr uuid := pg_temp.id(650); co uuid := pg_temp.id(651); ci uuid := pg_temp.id(652);
BEGIN
  p := jsonb_build_object(
    'categorias_inv', jsonb_build_array(jsonb_build_object('id', cat, 'nombre', 'Frenos', 'dispositivo', 'legado-313', 'local_id', 1)),
    'clientes', jsonb_build_array(
       jsonb_build_object('id', c1, 'nombre', 'Cliente Uno', 'telefono', '9000-0001', 'dispositivo', 'legado-313', 'local_id', 1),
       jsonb_build_object('id', c2, 'nombre', 'Cliente Dos', 'dispositivo', 'legado-313', 'local_id', 2)),
    'motos', jsonb_build_array(jsonb_build_object('id', mo, 'cliente_id', c1, 'marca', 'Honda', 'modelo', 'XR', 'placa', 'SIN-1', 'km', 1200, 'dispositivo', 'legado-313', 'local_id', 1)),
    'inventario', jsonb_build_array(
       jsonb_build_object('id', i0, 'nombre', 'Cero', 'cantidad', 0, 'costo_compra', 10, 'precio_venta', 20, 'categoria_id', cat, 'dispositivo', 'legado-313', 'local_id', 1),
       jsonb_build_object('id', i1, 'nombre', 'Uno', 'cantidad', 1, 'costo_compra', 10, 'precio_venta', 20, 'dispositivo', 'legado-313', 'local_id', 2),
       jsonb_build_object('id', ia, 'nombre', 'Alto', 'cantidad', 25000, 'costo_compra', 1, 'precio_venta', 2, 'dispositivo', 'legado-313', 'local_id', 3),
       jsonb_build_object('id', ineg, 'nombre', 'Negativo', 'cantidad', -2, 'costo_compra', 1, 'precio_venta', 2, 'dispositivo', 'legado-313', 'local_id', 4)),
    'ordenes', jsonb_build_array(jsonb_build_object('id', o, 'cliente_id', c1, 'moto_id', mo, 'estado', 'entregado', 'falla', 'Frenos', 'mecanico', 'Juan Legado',
       'finalizada', true, 'tipo_cobro', 'credito', 'creado_en', '2026-03-01T10:00:00Z', 'dispositivo', 'legado-313', 'local_id', 1)),
    'orden_items', jsonb_build_array(jsonb_build_object('id', pg_temp.id(653), 'orden_id', o, 'inventario_id', i1, 'nombre', 'Uno', 'cantidad', 1, 'precio', 300)),
    'cotizaciones', jsonb_build_array(jsonb_build_object('id', co, 'cliente_id', c2, 'cliente_nombre', 'Cliente Dos', 'vence_en', '2026-04-01T00:00:00Z', 'estado', 'aceptada', 'orden_id', o, 'dispositivo', 'legado-313', 'local_id', 1)),
    'cotizacion_items', jsonb_build_array(jsonb_build_object('id', pg_temp.id(654), 'cotizacion_id', co, 'nombre', 'Uno', 'cantidad', 1, 'precio', 300)),
    'citas', jsonb_build_array(jsonb_build_object('id', ci, 'cliente_id', c1, 'fecha', '2026-03-01', 'hora', '09:00', 'estado', 'atendida', 'orden_id', o, 'dispositivo', 'legado-313', 'local_id', 1)),
    'ventas', jsonb_build_array(jsonb_build_object('id', v, 'cliente_id', c2, 'metodo_pago', 'efectivo', 'total', 60, 'creado_en', '2026-03-02T10:00:00Z', 'occurred_at', '2026-03-02T10:00:00Z', 'dispositivo', 'legado-313', 'local_id', 1)),
    'venta_items', jsonb_build_array(jsonb_build_object('id', pg_temp.id(655), 'venta_id', v, 'inventario_id', ia, 'nombre', 'Alto', 'cantidad', 30, 'precio', 2)),
    'creditos', jsonb_build_array(jsonb_build_object('id', cr, 'cliente_id', c1, 'cliente_nombre', 'Cliente Uno', 'total', 300, 'abonado', 100, 'saldo', 200, 'estado', 'parcial', 'orden_id', o, 'dispositivo', 'legado-313', 'local_id', 1)),
    'credito_items', jsonb_build_array(jsonb_build_object('id', pg_temp.id(656), 'credito_id', cr, 'nombre', 'Frenos', 'cantidad', 1, 'precio', 300)),
    'abonos', jsonb_build_array(jsonb_build_object('id', pg_temp.id(657), 'id_abono', 'legado-313:1:a1', 'credito_id', cr, 'monto', 100, 'metodo_pago', 'efectivo', 'creado_en', '2026-03-03T10:00:00Z')),
    'caja_movimientos', jsonb_build_array(
       jsonb_build_object('id', pg_temp.id(658), 'tipo', 'ingreso', 'categoria', 'Venta mostrador', 'monto', 60, 'venta_id', v, 'creado_en', '2026-03-02T10:00:00Z', 'dispositivo', 'legado-313', 'local_id', 1),
       jsonb_build_object('id', pg_temp.id(659), 'tipo', 'ingreso', 'categoria', 'Cobro de crédito', 'monto', 100, 'credito_id', cr, 'id_abono', 'legado-313:1:a1', 'creado_en', '2026-03-03T10:00:00Z', 'dispositivo', 'legado-313', 'local_id', 2),
       jsonb_build_object('id', pg_temp.id(660), 'tipo', 'egreso', 'categoria', 'Luz', 'monto', 45.5, 'creado_en', '2026-03-04T10:00:00Z', 'dispositivo', 'legado-313', 'local_id', 3)),
    'enlaces', jsonb_build_array(jsonb_build_object('id', o, 'credito_id', cr)));

  PERFORM pg_temp.como(1);
  r := public.import_aplicar_paquete(l, p);
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('se aplica en UNA llamada: lote aplicado, repetida=false', r->>'estado' = 'aplicado' AND NOT (r->>'repetida')::boolean
     AND (SELECT estado FROM public.import_lotes WHERE id = l) = 'aplicado');
  PERFORM pg_temp.t('relaciones: moto→cliente, orden→moto/cliente, ítems→orden, cotización→orden, cita→orden, orden→crédito (enlace)',
    (SELECT cliente_id = c1 FROM public.motos WHERE id = mo) AND (SELECT moto_id = mo AND cliente_id = c1 AND credito_id = cr FROM public.ordenes WHERE id = o)
    AND (SELECT count(*) FROM public.orden_items WHERE orden_id = o) = 1 AND (SELECT orden_id = o FROM public.cotizaciones WHERE id = co)
    AND (SELECT orden_id = o FROM public.citas WHERE id = ci) AND (SELECT categoria_id = cat FROM public.inventario WHERE id = i0));
  PERFORM pg_temp.t('ids conservados: el UUID determinista del cliente y su local_id/dispositivo',
    (SELECT local_id = 1 AND dispositivo = 'legado-313' FROM public.clientes WHERE id = c1));
  PERFORM pg_temp.t('STOCK EXACTO: 0, 1, 25000 y −2 (la venta y la orden históricas NO descontaron nada)',
    (SELECT cantidad FROM public.inventario WHERE id = i0) = 0 AND (SELECT cantidad FROM public.inventario WHERE id = i1) = 1
    AND (SELECT cantidad FROM public.inventario WHERE id = ia) = 25000 AND (SELECT cantidad FROM public.inventario WHERE id = ineg) = -2);
  PERFORM pg_temp.t('una sola apertura de ledger por producto con existencia ≠ 0; ningún movimiento de venta/orden',
    (SELECT count(*) FROM public.inventario_movimientos WHERE tipo = 'importacion') = 3 AND (SELECT count(*) FROM public.inventario_movimientos WHERE tipo <> 'importacion') = 0);
  PERFORM pg_temp.t('stock negativo legítimo del respaldo → marcado «requiere revisión», no corregido', (SELECT requiere_revision FROM public.inventario WHERE id = ineg));
  PERFORM pg_temp.t('DINERO: caja = exactamente la del respaldo (ni una fila de más), crédito 300/100/200, abono 100',
    (SELECT count(*) FROM public.caja_movimientos) = 3 AND (SELECT sum(monto) FILTER (WHERE tipo = 'ingreso') FROM public.caja_movimientos) = 160
    AND (SELECT sum(monto) FILTER (WHERE tipo = 'egreso') FROM public.caja_movimientos) = 45.5
    AND (SELECT total = 300 AND abonado = 100 AND saldo = 200 FROM public.creditos WHERE id = cr) AND (SELECT count(*) FROM public.abonos) = 1);
  PERFORM pg_temp.t('fechas históricas conservadas (no la de hoy)', (SELECT creado_en < '2026-04-01' FROM public.ordenes WHERE id = o) AND (SELECT occurred_at < '2026-04-01' FROM public.ventas WHERE id = v));
  PERFORM pg_temp.t('el mecánico legado queda como TEXTO y sin cuenta asignada', (SELECT mecanico = 'Juan Legado' AND mecanico_id IS NULL FROM public.ordenes WHERE id = o));
  f := public.verificar_invariantes();
  PERFORM pg_temp.t('verificar_invariantes() = [] (' || f::text || ')', f = '[]'::jsonb);

  -- 4. IDEMPOTENCIA: respuesta perdida → el cliente reintenta el MISMO lote ---------------------------------------
  PERFORM pg_temp.como(1);
  r2 := public.import_aplicar_paquete(l, p);
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('reintento tras respuesta perdida: repetida=true y NADA duplicado (clientes, caja, abonos, ledger)',
    (r2->>'repetida')::boolean AND (SELECT count(*) FROM public.clientes) = 2 AND (SELECT count(*) FROM public.caja_movimientos) = 3
    AND (SELECT count(*) FROM public.abonos) = 1 AND (SELECT count(*) FROM public.inventario_movimientos) = 3 AND (SELECT cantidad FROM public.inventario WHERE id = ia) = 25000);
  PERFORM pg_temp.como(1);
  r2 := public.import_estado(l);
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('import_estado: la app se recupera tras un cierre (estado aplicado + conteos)', r2->>'estado' = 'aplicado' AND (r2->'insertadas'->>'clientes')::int = 2);
  PERFORM pg_temp.como(1);
  r2 := public.import_estado(pg_temp.id(697));
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('import_estado de un lote que nunca llegó al servidor: «inexistente» (sin error)', r2->>'estado' = 'inexistente');

  -- 5. DOBLE IMPORTACIÓN: otro lote (el mismo respaldo re-exportado, u otro) → rechazado --------------------------
  PERFORM pg_temp.como(1);
  PERFORM pg_temp.falla('un SEGUNDO lote se rechaza (solo se permite una importación)', format('SELECT public.import_iniciar(%L, ''legado-313'', %L, ''ENTI-2'', ''3.13.0'', 6, ''{}'')', pg_temp.id(601), repeat('f', 64)), 'solo se permite uno');
  PERFORM public.import_confirmar_lote(l);
  r2 := public.import_aplicar_paquete(l, p);
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('lote confirmado: reintentar sigue devolviendo repetida (nunca reimporta)', (r2->>'repetida')::boolean AND r2->>'estado' = 'confirmado' AND (SELECT count(*) FROM public.clientes) = 2);
  PERFORM pg_temp.fin();
END $$;

-- 6. P0002 → 23503: una operación pendiente contra algo que el administrador ya borró es un rechazo TERMINAL ----------
DO $$
DECLARE o uuid := pg_temp.id(670); st text;
BEGIN
  INSERT INTO public.ordenes (id, cliente_id, estado, falla, mecanico, mecanico_id, origen_trabajo, deleted_at)
  VALUES (o, pg_temp.id(641), 'recibido', 'x', 'Mec', pg_temp.uid(3), 'taller', now());
  PERFORM pg_temp.como(3);
  BEGIN PERFORM public.avanzar_orden_tecnico(gen_random_uuid(), o, '{"estado":"diagnostico"}'::jsonb, 'dev');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; END;
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('avanzar_orden_tecnico sobre una orden BORRADA → 23503 (antes P0002 → HTTP 500 → reintento infinito)', st = '23503');
  st := NULL;
  PERFORM pg_temp.como(3);
  BEGIN PERFORM public.avanzar_orden_tecnico(gen_random_uuid(), pg_temp.id(671), '{"estado":"diagnostico"}'::jsonb, 'dev');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; END;
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('avanzar_orden_tecnico sobre una orden INEXISTENTE → 23503', st = '23503');
  st := NULL;
  PERFORM pg_temp.como(2);
  BEGIN PERFORM public.sync_guardar_items_cotizacion(gen_random_uuid(), pg_temp.id(672), '[]'::jsonb, 'dev');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; END;
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('sync_guardar_items_cotizacion sobre una cotización inexistente → 23503', st = '23503');
  PERFORM pg_temp.t('ninguna RPC del outbox conserva P0002', NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('avanzar_orden_tecnico', 'sync_guardar_items_cotizacion') AND prosrc ~ 'ERRCODE = ''P0002'''));
  PERFORM pg_temp.t('import_aplicar_paquete declara su statement_timeout (PostgREST lo aplica; authenticated tiene 8 s)',
    EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'import_aplicar_paquete' AND 'statement_timeout=120s' = ANY (proconfig)));
END $$;
