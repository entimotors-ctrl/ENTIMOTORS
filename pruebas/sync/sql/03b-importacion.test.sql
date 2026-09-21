-- SYNC-3b · pruebas de la importación por lote. Requiere 00-prelude.sql y sync-1, 2, 3 y 3b, sobre una base SIN datos operativos.
DO $$
DECLARE r jsonb; l uuid := pg_temp.id(500); h text := repeat('c', 64);
BEGIN
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.falla('el cajero no importa', format('SELECT public.import_iniciar(%L, ''origen'', %L, ''ENTI-1'', ''3.13.0'', 6, ''{}'')', l, h), 'Solo el administrador');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(3);
  PERFORM pg_temp.falla('el mecánico no importa', format('SELECT public.import_iniciar(%L, ''origen'', %L, ''ENTI-1'', ''3.13.0'', 6, ''{}'')', l, h), 'Solo el administrador');
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(1);
  r := public.import_iniciar(l, 'cliente-real', h, 'ENTI-2026-1', '3.13.0', 6, '{"clientes":2}');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('el admin inicia el lote (dry_run) y la nube está vacía', (r->>'nube_vacia')::boolean AND (SELECT estado = 'dry_run' FROM public.import_lotes WHERE id = l));
  PERFORM pg_temp.adm();
  PERFORM pg_temp.falla('sin dry-run aprobado el servidor NO deja aplicar', format('SELECT public.import_aplicar_lote(%L, ''clientes'', ''[]''::jsonb)', l), 'dry-run es obligatorio');
  PERFORM pg_temp.falla('un nombre legado sin decisión se rechaza (no se adivina por nombre)', format('SELECT public.import_guardar_mapeo(%L, %L::jsonb)', l, '[{"nombre":"Mecánico 1"}]'), 'no se adivina por nombre');
  PERFORM pg_temp.falla('un perfil inexistente se rechaza', format('SELECT public.import_guardar_mapeo(%L, %L::jsonb)', l, format('[{"nombre":"Wilkin","perfil_id":"%s"}]', gen_random_uuid())), 'no existe');
  r := public.import_guardar_mapeo(l, format('[{"nombre":"Wilkin","perfil_id":"%s"},{"nombre":"Mecánico 1","sin_asignar":true}]', pg_temp.uid(3))::jsonb);
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('D-5: el mapeo explícito (perfil real / sin asignar) queda guardado', (SELECT count(*) FROM public.import_mapeo_mecanicos WHERE lote_id = l) = 2
     AND (SELECT sin_asignar FROM public.import_mapeo_mecanicos WHERE lote_id = l AND nombre_legado = 'Mecánico 1') AND (SELECT perfil_id = pg_temp.uid(3) FROM public.import_mapeo_mecanicos WHERE lote_id = l AND nombre_legado = 'Wilkin'));
  PERFORM pg_temp.adm();
  r := public.import_dry_run_ok(l, '{"validaciones":"ok","referencias_colgantes":0}');
  PERFORM pg_temp.fin();
END $$;

DO $$
DECLARE l uuid := pg_temp.id(500); r jsonb; c uuid := pg_temp.id(510); c2 uuid := pg_temp.id(511); m uuid := pg_temp.id(512); i1 uuid := pg_temp.id(513); i2 uuid := pg_temp.id(514);
        o uuid := pg_temp.id(515); v uuid := pg_temp.id(516); cr uuid := pg_temp.id(517); f jsonb;
BEGIN
  PERFORM pg_temp.como(1);
  r := public.import_aplicar_lote(l, 'categorias_inv', ('[{"id":"' || pg_temp.id(509) || '","nombre":"Frenos","dispositivo":"cliente-real","local_id":1}]')::jsonb);
  r := public.import_aplicar_lote(l, 'clientes', jsonb_build_array(jsonb_build_object('id', c, 'nombre', 'Carlos Reyes', 'telefono', '9704', 'dispositivo', 'cliente-real', 'local_id', 1, 'creado_en', '2026-05-01T10:00:00Z'),
                                                                     jsonb_build_object('id', c2, 'nombre', 'Marlon', 'telefono', '9988', 'dispositivo', 'cliente-real', 'local_id', 2, 'creado_en', '2026-05-02T10:00:00Z')));
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('clientes: 2 insertados', (r->>'insertadas')::int = 2);
  PERFORM pg_temp.adm();
  r := public.import_aplicar_lote(l, 'clientes', jsonb_build_array(jsonb_build_object('id', c, 'nombre', 'Carlos Reyes', 'telefono', '9704', 'dispositivo', 'cliente-real', 'local_id', 1)));
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('reimportar el mismo trozo NO duplica (0 insertados, 1 omitido)', (r->>'insertadas')::int = 0 AND (r->>'omitidas')::int = 1 AND (SELECT count(*) FROM public.clientes) = 2);
  PERFORM pg_temp.adm();
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('se conserva la fecha original (creado_en de mayo), no la de la importación', (SELECT creado_en < '2026-06-01' FROM public.clientes WHERE id = c));
  PERFORM pg_temp.adm();
  r := public.import_aplicar_lote(l, 'motos', jsonb_build_array(jsonb_build_object('id', m, 'cliente_id', c, 'marca', 'Honda', 'modelo', 'CB190R', 'placa', 'HAX-4471', 'km', 8200, 'cilindraje', '190cc', 'dispositivo', 'cliente-real', 'local_id', 1)));
  r := public.import_aplicar_lote(l, 'inventario', jsonb_build_array(
      jsonb_build_object('id', i1, 'nombre', 'Kit de arrastre', 'cantidad', 4, 'costo_compra', 950, 'precio_venta', 1450, 'stock_minimo', 2, 'categoria_id', pg_temp.id(509), 'dispositivo', 'cliente-real', 'local_id', 1, 'updated_at', '2000-01-01', 'rev', 99, 'requiere_revision', true),
      jsonb_build_object('id', i2, 'nombre', 'Aceite', 'cantidad', 30, 'costo_compra', 110, 'precio_venta', 180, 'dispositivo', 'cliente-real', 'local_id', 2)));
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('inventario importado: cantidad = saldo del respaldo por movimientos de apertura del ledger',
    (SELECT cantidad FROM public.inventario WHERE id = i1) = 4 AND (SELECT cantidad FROM public.inventario WHERE id = i2) = 30 AND (SELECT count(*) FROM public.inventario_movimientos WHERE tipo = 'importacion') = 2);
  PERFORM pg_temp.adm();
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('el respaldo no puede imponer columnas del servidor (rev, updated_at, requiere_revision)', (SELECT rev <> 99 AND updated_at > '2020-01-01' AND NOT requiere_revision FROM public.inventario WHERE id = i1));
  PERFORM pg_temp.adm();
  r := public.import_aplicar_lote(l, 'ordenes', jsonb_build_array(jsonb_build_object('id', o, 'cliente_id', c, 'moto_id', m, 'estado', 'entregado', 'falla', 'ruido', 'mecanico', 'Wilkin', 'mecanico_id', pg_temp.uid(3),
      'finalizada', true, 'tipo_cobro', 'credito', 'margen', 30.5, 'credito_id', cr, 'dispositivo', 'cliente-real', 'local_id', 1)));
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('ordenes: el credito_id se ignora al insertar (va en enlaces) y el mecánico mapeado se conserva', (SELECT credito_id IS NULL AND mecanico_id = pg_temp.uid(3) AND finalizada FROM public.ordenes WHERE id = o));
  PERFORM pg_temp.adm();
  r := public.import_aplicar_lote(l, 'orden_items', jsonb_build_array(jsonb_build_object('id', pg_temp.id(518), 'orden_id', o, 'inventario_id', i1, 'nombre', 'Kit de arrastre', 'cantidad', 1, 'precio', 1450, 'costo_unitario', 950)));
  r := public.import_aplicar_lote(l, 'ventas', jsonb_build_array(jsonb_build_object('id', v, 'cliente_id', c2, 'metodo_pago', 'efectivo', 'total', 360, 'efectivo_recibido', 400, 'cambio', 40,
      'creado_en', '2026-05-03T15:00:00Z', 'occurred_at', '2026-05-03T15:00:00Z', 'dispositivo', 'cliente-real', 'local_id', 1)));
  r := public.import_aplicar_lote(l, 'venta_items', jsonb_build_array(jsonb_build_object('id', pg_temp.id(519), 'venta_id', v, 'inventario_id', i2, 'nombre', 'Aceite', 'cantidad', 2, 'precio', 180, 'costo_unitario', 110)));
  r := public.import_aplicar_lote(l, 'creditos', jsonb_build_array(jsonb_build_object('id', cr, 'cliente_id', c, 'cliente_nombre', 'Carlos Reyes', 'total', 100, 'abonado', 30, 'saldo', 70, 'estado', 'parcial', 'orden_id', o, 'dispositivo', 'cliente-real', 'local_id', 1)));
  r := public.import_aplicar_lote(l, 'credito_items', jsonb_build_array(jsonb_build_object('id', pg_temp.id(520), 'credito_id', cr, 'nombre', 'Servicio', 'cantidad', 1, 'precio', 100)));
  r := public.import_aplicar_lote(l, 'abonos', jsonb_build_array(jsonb_build_object('id', pg_temp.id(521), 'id_abono', 'legacy:cliente-real:1:1', 'credito_id', cr, 'monto', 30, 'metodo_pago', 'efectivo', 'creado_en', '2026-05-10T09:00:00Z')));
  r := public.import_aplicar_lote(l, 'caja_movimientos', jsonb_build_array(
      jsonb_build_object('id', pg_temp.id(522), 'tipo', 'ingreso', 'categoria', 'Venta mostrador', 'monto', 360, 'metodo_pago', 'efectivo', 'venta_id', v, 'creado_en', '2026-05-03T15:00:00Z', 'dispositivo', 'cliente-real', 'local_id', 1),
      jsonb_build_object('id', pg_temp.id(523), 'tipo', 'ingreso', 'categoria', 'Cobro de crédito', 'monto', 30, 'credito_id', cr, 'id_abono', 'legacy:cliente-real:1:1', 'creado_en', '2026-05-10T09:00:00Z', 'dispositivo', 'cliente-real', 'local_id', 2)));
  r := public.import_aplicar_lote(l, 'enlaces', jsonb_build_array(jsonb_build_object('id', o, 'credito_id', cr)));
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('enlaces: la orden queda ligada a su crédito', (SELECT credito_id = cr FROM public.ordenes WHERE id = o));
  PERFORM pg_temp.adm();
  PERFORM pg_temp.falla('auditoria NO se importa (la del servidor sella identidad real)', format('SELECT public.import_aplicar_lote(%L, ''auditoria'', ''[]''::jsonb)', l), 'Tabla no importable');
  PERFORM pg_temp.falla('perfiles NO se importan', format('SELECT public.import_aplicar_lote(%L, ''perfiles'', ''[]''::jsonb)', l), 'Tabla no importable');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('una venta histórica NO tocó el stock (aceite sigue en 30) ni creó ledger de venta',
    (SELECT cantidad FROM public.inventario WHERE id = i2) = 30 AND NOT EXISTS (SELECT 1 FROM public.inventario_movimientos WHERE tipo = 'venta'));
  PERFORM pg_temp.adm();
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('la caja histórica conserva su fecha original', (SELECT creado_en < '2026-06-01' FROM public.caja_movimientos WHERE id = pg_temp.id(522)));
  PERFORM pg_temp.adm();
  r := public.import_cerrar_carga(l);
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('el lote queda aplicado con conteos por tabla', (SELECT estado = 'aplicado' AND (conteos_insertados->>'clientes')::int = 2 AND (conteos_insertados->>'caja_movimientos')::int = 2 FROM public.import_lotes WHERE id = l));
  PERFORM pg_temp.adm();
  PERFORM pg_temp.falla('un segundo lote aplicado se rechaza', format('SELECT public.import_iniciar(NULL, ''otro-dispositivo'', %L, ''ENTI-9'', ''3.13.0'', 6, ''{}'')', repeat('d', 64)), 'solo se permite uno');
  f := public.verificar_invariantes();
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('invariantes tras importar (' || f::text || ')', jsonb_array_length(f) = 0);
  PERFORM pg_temp.adm();
  r := public.import_totales();
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('totales para verificar: 2 clientes, 1 venta de 360, crédito saldo 70, caja 390',
    (r->>'clientes')::int = 2 AND (r->'ventas'->>'total')::numeric = 360 AND (r->'creditos'->>'saldo')::numeric = 70 AND (r->'caja'->>'ingresos')::numeric = 390 AND (r->'inventario'->>'unidades')::numeric = 34);
  PERFORM pg_temp.adm();
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(2); PERFORM pg_temp.falla('el cajero no lee los totales de importación', 'SELECT public.import_totales()', 'Solo el administrador'); PERFORM pg_temp.fin();
END $$;

-- ROLLBACK POR LOTE: solo antes de confirmar y sin actividad posterior ------------------------------------------------
DO $$
DECLARE l uuid := pg_temp.id(500); r jsonb; n bigint;
BEGIN
  -- actividad real posterior (una venta) impide revertir sin perder trabajo
  PERFORM pg_temp.como(2);
  PERFORM public.registrar_venta_v2(pg_temp.id(530), NULL, 'Mostrador', 'efectivo', 200, jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(514), 'nombre', 'Aceite', 'cantidad', 1, 'precio', 180)));
  PERFORM pg_temp.fin();
  PERFORM pg_temp.como(1);
  PERFORM pg_temp.falla('con actividad posterior no se puede revertir', format('SELECT public.revertir_lote_importacion(%L)', l), 'actividad posterior');
  PERFORM pg_temp.fin();
END $$;
