-- 3.15.0 · Bloque 7 · sync-15g: QUIÉN VE QUÉ, antes y después. Con 00-prelude.sql (usuarios 1 admin · 2 cajero · 3/4 mecánico ·
-- 5 desarrollador · 6 mecánico INACTIVO; 0 = anon). Siembra (idempotente) una fila o más en cada una de las 18 tablas cuya política de
-- lectura cambia 15g y escribe, por rol y tabla, cuántas filas ve y la huella de CUÁLES (md5 de sus id). correr-sql.sh lo corre ANTES y
-- DESPUÉS de 15g y exige salidas IDÉNTICAS (la optimización no puede cambiar la visibilidad de nadie).
DO $sem$
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.clientes (id, nombre) VALUES (pg_temp.id(7001), 'Cli 15g'), (pg_temp.id(7002), 'Cli 15g b') ON CONFLICT DO NOTHING;
  INSERT INTO public.motos (id, cliente_id, marca, placa) VALUES (pg_temp.id(7003), pg_temp.id(7001), 'M', 'P15G') ON CONFLICT DO NOTHING;
  INSERT INTO public.categorias_inv (id, nombre) VALUES (pg_temp.id(7004), 'Cat 15g') ON CONFLICT DO NOTHING;
  INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES (pg_temp.id(7005), 'Rep 15g', 100, 50) ON CONFLICT DO NOTHING;
  INSERT INTO public.citas (id, nombre_tmp, telefono_tmp, fecha, hora, motivo, mecanico_id) VALUES (pg_temp.id(7006), 'C', '1', current_date, '09:00', 'x', pg_temp.uid(3)) ON CONFLICT DO NOTHING;
  INSERT INTO public.cotizaciones (id, cliente_nombre, estado, validez_dias, vence_en) VALUES (pg_temp.id(7007), 'Cot 15g', 'pendiente', 15, now() + interval '10 days') ON CONFLICT DO NOTHING;
  INSERT INTO public.cotizacion_items (id, cotizacion_id, nombre, cantidad, precio) VALUES (pg_temp.id(7008), pg_temp.id(7007), 'r', 1, 10) ON CONFLICT DO NOTHING;
  INSERT INTO public.ordenes (id, cliente_id, estado, falla, mecanico, mecanico_id) VALUES (pg_temp.id(7009), pg_temp.id(7001), 'reparacion', 'f', 'Usuario 3', pg_temp.uid(3)),
    (pg_temp.id(7010), pg_temp.id(7002), 'recibido', 'g', NULL, NULL) ON CONFLICT DO NOTHING;
  INSERT INTO public.orden_items (id, orden_id, nombre, cantidad, precio) VALUES (pg_temp.id(7011), pg_temp.id(7009), 'mo', 1, 200) ON CONFLICT DO NOTHING;
  INSERT INTO public.ventas (id, metodo_pago, total) VALUES (pg_temp.id(7012), 'efectivo', 150) ON CONFLICT DO NOTHING;
  INSERT INTO public.venta_items (id, venta_id, nombre, cantidad, precio) VALUES (pg_temp.id(7013), pg_temp.id(7012), 'r', 1, 150) ON CONFLICT DO NOTHING;
  INSERT INTO public.creditos (id, cliente_nombre, total, abonado, saldo) VALUES (pg_temp.id(7014), 'Cre 15g', 1000, 0, 1000) ON CONFLICT DO NOTHING;
  INSERT INTO public.credito_items (id, credito_id, nombre, cantidad, precio) VALUES (pg_temp.id(7015), pg_temp.id(7014), 'x', 1, 1000) ON CONFLICT DO NOTHING;
  INSERT INTO public.abonos (id, id_abono, credito_id, monto, metodo_pago) VALUES (pg_temp.id(7016), 'A15G', pg_temp.id(7014), 100, 'efectivo') ON CONFLICT DO NOTHING;
  INSERT INTO public.caja_movimientos (id, tipo, categoria, monto, metodo_pago) VALUES (pg_temp.id(7017), 'ingreso', 'Venta mostrador', 150, 'efectivo'),
    (pg_temp.id(7018), 'egreso', 'Planilla', 50, 'efectivo') ON CONFLICT DO NOTHING;
  INSERT INTO public.mensajes (id, remitente_id, remitente_nombre, destinatario_id, texto, op_id) VALUES
    (pg_temp.id(7019), pg_temp.uid(1), 'Admin', pg_temp.uid(3), 'para 3', pg_temp.id(7119)),
    (pg_temp.id(7020), pg_temp.uid(1), 'Admin', pg_temp.uid(4), 'para 4', pg_temp.id(7120)),
    (pg_temp.id(7021), pg_temp.uid(1), 'Admin', pg_temp.uid(6), 'para 6 (inactivo)', pg_temp.id(7121)) ON CONFLICT DO NOTHING;
  INSERT INTO public.auditoria (accion, entidad, detalle) SELECT 'b7', 'visibilidad', '15g' WHERE NOT EXISTS (SELECT 1 FROM public.auditoria WHERE accion = 'b7');
  INSERT INTO public.web_cms (clave, valor) VALUES ('b7-15g', '{}'::jsonb) ON CONFLICT DO NOTHING;
END $sem$;

DO $vis$
DECLARE n int; t text; c bigint; h text;
  tablas text[] := ARRAY['abonos','auditoria','caja_movimientos','categorias_inv','citas','clientes','cotizacion_items','cotizaciones','credito_items',
    'creditos','inventario','mensajes','motos','orden_items','ordenes','venta_items','ventas','web_cms'];
BEGIN
  FOREACH n IN ARRAY ARRAY[0,1,2,3,4,5,6] LOOP
    FOREACH t IN ARRAY tablas LOOP
      PERFORM pg_temp.como(n);
      BEGIN
        EXECUTE format('SELECT count(*), md5(coalesce(string_agg(%s::text, '','' ORDER BY %s::text), '''')) FROM public.%I', CASE WHEN t = 'web_cms' THEN 'clave' ELSE 'id' END, CASE WHEN t = 'web_cms' THEN 'clave' ELSE 'id' END, t) INTO c, h;
        RAISE NOTICE 'VIS|%|%|%|%', n, t, c, h;
      EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'VIS|%|%|ERROR|%', n, t, SQLSTATE;
      END;
      PERFORM pg_temp.fin();
    END LOOP;
  END LOOP;
END $vis$;
