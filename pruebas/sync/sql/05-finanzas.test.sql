-- SYNC-7B · dinero y stock contra Postgres real. Requiere 00-prelude.sql y sync-1, 2, 3, 3p aplicados.
-- Cuentas: 1 admin · 2 cajero · 3 mecánico A · 6 mecánico INACTIVO. Ids de datos: pg_temp.id(5xx..6xx).
-- Complementa 03-rpc.test.sql (que sigue corriendo como regresión): aquí lo que SYNC-7B agrega o conecta —
-- autorización ligada al DISPOSITIVO, ERRCODE terminal 23503, venta offline con sobreventa → requiere_revision,
-- reversos con PIN de punta a punta, borrado físico prohibido e INVARIANTES EXACTAS tras cada bloque.

-- Autorización como la emite el backend del PIN (pin_emitir_autorizacion), con dispositivo y hash crítico.
CREATE FUNCTION pg_temp.aut(p_sol int, p_accion text, p_entidad text, p_registro uuid, p_device text, p_monto numeric DEFAULT NULL,
    p_ttl interval DEFAULT '90 seconds') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.autorizaciones_admin (id, solicitante_id, rol_solicitante, autorizado_por, accion, entidad, registro_id, device_id, pin_version, payload_hash, expira_en, creado_en)
  VALUES (v, pg_temp.uid(p_sol), 'cajero', pg_temp.uid(1), p_accion, p_entidad, p_registro, p_device, 1,
          CASE WHEN p_monto IS NULL THEN NULL ELSE public.sync_hash_critico(p_accion, p_registro, p_monto) END, now() + p_ttl, now() - interval '10 minutes');
  RETURN v;
END $$;
-- SQLSTATE con que falla una sentencia ('OK' si no falla): la clasificación HTTP del cliente depende de él.
CREATE FUNCTION pg_temp.estado(sentencia text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE sentencia; RETURN 'OK';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE;
END $$;
-- Invariantes financieras EXACTAS (como superusuario). Vacío = todo cuadra.
CREATE FUNCTION pg_temp.invariantes() RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text := '';
BEGIN
  IF EXISTS (SELECT 1 FROM public.inventario i WHERE i.cantidad <> COALESCE((SELECT sum(m.cantidad) FROM public.inventario_movimientos m WHERE m.inventario_id = i.id), 0)) THEN v := v || 'stock<>ledger; '; END IF;
  IF EXISTS (SELECT 1 FROM public.inventario WHERE cantidad < 0 AND NOT requiere_revision) THEN v := v || 'negativo_sin_revision; '; END IF;
  IF EXISTS (SELECT 1 FROM public.creditos c WHERE abs(c.abonado - COALESCE((SELECT sum(a.monto) FROM public.abonos a WHERE a.credito_id = c.id AND NOT a.anulado), 0)) > 0.001
             OR abs(c.saldo - (c.total - c.abonado)) > 0.001) THEN v := v || 'saldo_credito; '; END IF;
  IF EXISTS (SELECT 1 FROM public.ventas ve WHERE abs(ve.total - COALESCE((SELECT sum(round(vi.cantidad * vi.precio, 2)) FROM public.venta_items vi WHERE vi.venta_id = ve.id), 0)) > 0.011) THEN v := v || 'venta<>renglones; '; END IF;
  IF EXISTS (SELECT 1 FROM public.venta_items vi LEFT JOIN public.ventas ve ON ve.id = vi.venta_id WHERE ve.id IS NULL) THEN v := v || 'venta_items_huerfanos; '; END IF;
  IF EXISTS (SELECT 1 FROM public.credito_items ci LEFT JOIN public.creditos c ON c.id = ci.credito_id WHERE c.id IS NULL) THEN v := v || 'credito_items_huerfanos; '; END IF;
  IF EXISTS (SELECT 1 FROM public.caja_movimientos m WHERE m.reverso_de IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.caja_movimientos o WHERE o.id = m.reverso_de)) THEN v := v || 'reverso_huerfano; '; END IF;
  IF EXISTS (SELECT 1 FROM public.caja_movimientos m WHERE m.reverso_de IS NOT NULL GROUP BY m.reverso_de HAVING count(*) > 1) THEN v := v || 'doble_compensacion; '; END IF;
  IF EXISTS (SELECT op_id FROM public.ventas WHERE op_id IS NOT NULL GROUP BY op_id HAVING count(*) > 1)
     OR EXISTS (SELECT op_id FROM public.creditos WHERE op_id IS NOT NULL GROUP BY op_id HAVING count(*) > 1)
     OR EXISTS (SELECT op_id FROM public.abonos WHERE op_id IS NOT NULL GROUP BY op_id HAVING count(*) > 1)
     OR EXISTS (SELECT op_id FROM public.caja_movimientos WHERE op_id IS NOT NULL GROUP BY op_id HAVING count(*) > 1)
     OR EXISTS (SELECT operation_id FROM public.reversos GROUP BY operation_id HAVING count(*) > 1) THEN v := v || 'operation_id_duplicado; '; END IF;
  IF EXISTS (SELECT 1 FROM public.inventario_movimientos m WHERE m.venta_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ventas ve WHERE ve.id = m.venta_id))
     OR EXISTS (SELECT 1 FROM public.inventario_movimientos m WHERE m.credito_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.creditos c WHERE c.id = m.credito_id)) THEN v := v || 'ledger_huerfano; '; END IF;
  RETURN v;
END $$;
CREATE FUNCTION pg_temp.neta() RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(sum(CASE tipo WHEN 'ingreso' THEN monto ELSE -monto END), 0) FROM public.caja_movimientos $$;
CREATE FUNCTION pg_temp.stock(n int) RETURNS numeric LANGUAGE sql AS $$ SELECT cantidad FROM public.inventario WHERE id = pg_temp.id(n) $$;
CREATE FUNCTION pg_temp.it(n int, cant numeric, precio numeric) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('inventario_id', pg_temp.id(n), 'nombre', 'rep ' || n, 'cantidad', cant, 'precio', precio) $$;

DO $$
BEGIN
  INSERT INTO public.admin_pin (perfil_id, hash, version) VALUES (pg_temp.uid(1), 'scrypt$prueba$hash-no-real', 1) ON CONFLICT DO NOTHING;
  INSERT INTO public.clientes (id, nombre, telefono) VALUES (pg_temp.id(501), 'Cliente 7B', '9999');
  INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES
    (pg_temp.id(511), 'Aceite 7B', 180, 110), (pg_temp.id(512), 'Kit 7B', 300, 190), (pg_temp.id(513), 'Bujía 7B', 50, 20), (pg_temp.id(514), 'Cadena 7B', 400, 250);
  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES
    (pg_temp.id(511), 'apertura', 10), (pg_temp.id(512), 'apertura', 2), (pg_temp.id(513), 'apertura', 1), (pg_temp.id(514), 'apertura', 3);
END $$;

-- 1-2. VENTA normal + retry (misma operación = mismo resultado, un solo efecto) --------------------------------------
DO $$
DECLARE r jsonb; r2 jsonb; n0 numeric := pg_temp.neta(); v uuid := pg_temp.id(601);
BEGIN
  PERFORM pg_temp.como(2);
  r := public.registrar_venta_v2(p_op => pg_temp.id(600), p_cliente_id => pg_temp.id(501), p_cliente_nombre => 'Cliente 7B', p_metodo_pago => 'efectivo',
         p_efectivo => 1000, p_items => jsonb_build_array(pg_temp.it(511, 2, 180), pg_temp.it(512, 1, 300)), p_device => 'dev-A', p_venta_id => v);
  r2 := public.registrar_venta_v2(p_op => pg_temp.id(600), p_cliente_id => pg_temp.id(501), p_cliente_nombre => 'Cliente 7B', p_metodo_pago => 'efectivo',
         p_efectivo => 1000, p_items => jsonb_build_array(pg_temp.it(511, 2, 180), pg_temp.it(512, 1, 300)), p_device => 'dev-A', p_venta_id => v);
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('venta: el id lo fija el cliente (p_venta_id) y el total lo calcula el servidor', (r->>'venta_id')::uuid = v AND (r->>'total')::numeric = 660);
  PERFORM pg_temp.t('venta retry: repetida=true con el MISMO resultado', (r2->>'repetida')::boolean AND r2->>'venta_id' = r->>'venta_id');
  PERFORM pg_temp.t('venta: UNA venta, 2 renglones, stock por ledger (10→8, 2→1)',
    (SELECT count(*) FROM public.ventas WHERE op_id = pg_temp.id(600)) = 1 AND (SELECT count(*) FROM public.venta_items WHERE venta_id = v) = 2
    AND pg_temp.stock(511) = 8 AND pg_temp.stock(512) = 1);
  PERFORM pg_temp.t('venta: UN movimiento de caja por el total, ligado a la venta', pg_temp.neta() - n0 = 660 AND (SELECT count(*) FROM public.caja_movimientos WHERE venta_id = v) = 1);
  PERFORM pg_temp.t('venta: 2 movimientos de ledger tipo venta (uno por producto), sin duplicar por el retry',
    (SELECT count(*) FROM public.inventario_movimientos WHERE venta_id = v AND tipo = 'venta') = 2);
  PERFORM pg_temp.t('venta: auditoría con dispositivo y operation_id', EXISTS (SELECT 1 FROM public.auditoria WHERE accion = 'venta' AND entidad_id = v::text AND device_id = 'dev-A' AND operation_id = pg_temp.id(600)));
  PERFORM pg_temp.t('INVARIANTES tras venta+retry: exactas', pg_temp.invariantes() = '');
END $$;

-- 3-5. online sin stock → terminal; mismo op con otros datos → conflicto; offline de verdad → acepta y marca revisión ------
DO $$
DECLARE r jsonb; n0 numeric := pg_temp.neta(); s text;
BEGIN
  PERFORM pg_temp.como(2);
  s := pg_temp.estado(format('SELECT public.registrar_venta_v2(%L, NULL, ''x'', ''efectivo'', 0, %L::jsonb)', pg_temp.id(602), jsonb_build_array(pg_temp.it(513, 5, 50))));
  PERFORM pg_temp.t('venta ONLINE sin stock: rechazo terminal 23514 (HTTP 400 → validacion, no se reintenta)', s = '23514');
  s := pg_temp.estado(format('SELECT public.registrar_venta_v2(%L, NULL, ''x'', ''tarjeta'', 0, %L::jsonb)', pg_temp.id(600), jsonb_build_array(pg_temp.it(511, 1, 1))));
  PERFORM pg_temp.t('mismo operation_id con otros parámetros: 23505 (409 → conflicto, terminal)', s = '23505');
  s := pg_temp.estado(format('SELECT public.registrar_venta_v2(%L, NULL, ''x'', ''efectivo'', 0, %L::jsonb, now(), true)', pg_temp.id(603), jsonb_build_array(pg_temp.it(513, 5, 50))));
  PERFORM pg_temp.t('"offline" con hora de AHORA no engaña al servidor: sigue bloqueando (23514)', s = '23514');
  r := public.registrar_venta_v2(p_op => pg_temp.id(604), p_cliente_id => NULL, p_cliente_nombre => 'Offline', p_metodo_pago => 'efectivo', p_efectivo => 250,
         p_items => jsonb_build_array(pg_temp.it(513, 5, 50)), p_occurred_at => now() - interval '10 minutes', p_offline => true, p_device => 'dev-B', p_venta_id => pg_temp.id(605));
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('sobreventa rechazada online no dejó NADA escrito (ni venta ni caja)', NOT EXISTS (SELECT 1 FROM public.ventas WHERE op_id IN (pg_temp.id(602), pg_temp.id(603))) AND pg_temp.neta() - n0 = 250);
  PERFORM pg_temp.t('venta OFFLINE real: se conserva completa (cantidad 5, nunca recortada) y deja stock negativo (1→-4)',
    (SELECT cantidad FROM public.venta_items WHERE venta_id = pg_temp.id(605)) = 5 AND pg_temp.stock(513) = -4);
  PERFORM pg_temp.t('venta OFFLINE: requiere_revision + auditoría stock_negativo + capturada_offline + fecha real conservada',
    (SELECT requiere_revision FROM public.inventario WHERE id = pg_temp.id(513)) AND jsonb_array_length(r->'stock_negativo') = 1
    AND EXISTS (SELECT 1 FROM public.auditoria WHERE accion = 'stock_negativo' AND resultado = 'revision' AND entidad_id = pg_temp.id(605)::text)
    AND (SELECT capturada_offline AND occurred_at < now() - interval '5 minutes' FROM public.ventas WHERE id = pg_temp.id(605)));
  PERFORM pg_temp.t('ledger offline: el movimiento queda marcado capturada_offline y requiere_revision',
    EXISTS (SELECT 1 FROM public.inventario_movimientos WHERE venta_id = pg_temp.id(605) AND capturada_offline AND requiere_revision));
  PERFORM pg_temp.t('INVARIANTES tras sobreventa offline: exactas (negativo CON revisión no es violación)', pg_temp.invariantes() = '');
END $$;

-- 7-10. CRÉDITO con entrada, retry, ABONO, retry, abono > saldo, referencia inexistente ----------------------------------
DO $$
DECLARE r jsonb; r2 jsonb; a jsonb; a2 jsonb; c uuid := pg_temp.id(611); n0 numeric := pg_temp.neta(); s text;
BEGIN
  PERFORM pg_temp.como(2);
  r := public.registrar_credito(p_op => pg_temp.id(610), p_cliente_id => pg_temp.id(501), p_cliente_nombre => 'Cliente 7B', p_cliente_telefono => '9999',
         p_items => jsonb_build_array(pg_temp.it(514, 1, 400), jsonb_build_object('nombre', 'Mano de obra', 'cantidad', 1, 'precio', 100)),
         p_abono_inicial => 150, p_abono_metodo => 'efectivo', p_device => 'dev-A', p_credito_id => c, p_origen => 'pos');
  r2 := public.registrar_credito(p_op => pg_temp.id(610), p_cliente_id => pg_temp.id(501), p_cliente_nombre => 'Cliente 7B', p_cliente_telefono => '9999',
         p_items => jsonb_build_array(pg_temp.it(514, 1, 400), jsonb_build_object('nombre', 'Mano de obra', 'cantidad', 1, 'precio', 100)),
         p_abono_inicial => 150, p_abono_metodo => 'efectivo', p_device => 'dev-A', p_credito_id => c, p_origen => 'pos');
  a := public.registrar_abono_v2(pg_temp.id(612), c, 100, 'transferencia', NULL, 'dev-A');
  a2 := public.registrar_abono_v2(pg_temp.id(612), c, 100, 'transferencia', NULL, 'dev-A');
  s := pg_temp.estado(format('SELECT public.registrar_abono_v2(%L, %L, 999, ''efectivo'')', pg_temp.id(613), c));
  PERFORM pg_temp.t('abono mayor al saldo: rechazo terminal 23514', s = '23514');
  s := pg_temp.estado(format('SELECT public.registrar_abono_v2(%L, %L, 10, ''efectivo'')', pg_temp.id(614), pg_temp.id(699)));
  PERFORM pg_temp.t('abono a un crédito inexistente: 23503 (409 → terminal; antes P0002 → 500 → reintento infinito)', s = '23503');
  s := pg_temp.estado(format('SELECT public.registrar_venta_v2(%L, NULL, ''x'', ''efectivo'', 0, %L::jsonb)', pg_temp.id(615), jsonb_build_array(pg_temp.it(698, 1, 1))));
  PERFORM pg_temp.t('venta de un repuesto inexistente: 23503 (terminal)', s = '23503');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('crédito: total 500, entrada 150 atómica, saldo 350; retry repetido sin duplicar',
    (r->>'total')::numeric = 500 AND (r->>'saldo')::numeric = 350 AND (r2->>'repetida')::boolean AND (SELECT count(*) FROM public.creditos WHERE op_id = pg_temp.id(610)) = 1);
  PERFORM pg_temp.t('crédito: stock del repuesto sale por ledger UNA vez (3→2)', pg_temp.stock(514) = 2 AND (SELECT count(*) FROM public.inventario_movimientos WHERE credito_id = c AND tipo = 'credito') = 1);
  PERFORM pg_temp.t('abono + retry: UN abono, saldo 250 decidido por el servidor', (a2->>'repetida')::boolean AND (SELECT count(*) FROM public.abonos WHERE credito_id = c) = 2 AND (SELECT saldo FROM public.creditos WHERE id = c) = 250);
  PERFORM pg_temp.t('caja: entrada 150 + abono 100, una fila cada uno (neta +250)', pg_temp.neta() - n0 = 250 AND (SELECT count(*) FROM public.caja_movimientos WHERE credito_id = c) = 2);
  PERFORM pg_temp.t('INVARIANTES tras crédito/abonos: exactas', pg_temp.invariantes() = '');
END $$;

-- 11-15. REVERSOS con autorización ligada al DISPOSITIVO, al monto, de un solo uso ---------------------------------------
DO $$
DECLARE v uuid := pg_temp.id(601); a uuid; r jsonb; n0 numeric := pg_temp.neta(); s text; st511 numeric := pg_temp.stock(511);
BEGIN
  PERFORM pg_temp.como(2);
  s := pg_temp.estado(format('SELECT public.reversar_venta(%L, %L, ''sin autorización'', NULL, ''dev-A'')', pg_temp.id(620), v));
  PERFORM pg_temp.t('cajero sin PIN: 42501 AUTORIZACION_REQUERIDA', s = '42501');
  a := pg_temp.aut(2, 'reversar_venta', 'ventas', v, 'dev-OTRO', 660);
  PERFORM pg_temp.falla('autorización emitida para OTRO dispositivo: no transferible', format('SELECT public.reversar_venta(%L, %L, ''otro equipo'', %L, ''dev-A'')', pg_temp.id(621), v, a), 'AUTORIZACION_INVALIDA');
  a := pg_temp.aut(2, 'reversar_venta', 'ventas', v, 'dev-A', 1);
  PERFORM pg_temp.falla('autorización con OTRO monto (hash crítico): se rechaza', format('SELECT public.reversar_venta(%L, %L, ''monto cambiado'', %L, ''dev-A'')', pg_temp.id(622), v, a), 'AUTORIZACION_INVALIDA');
  a := pg_temp.aut(2, 'reversar_abono', 'ventas', v, 'dev-A', 660);
  PERFORM pg_temp.falla('autorización para OTRA acción: se rechaza', format('SELECT public.reversar_venta(%L, %L, ''acción distinta'', %L, ''dev-A'')', pg_temp.id(623), v, a), 'AUTORIZACION_INVALIDA');
  a := pg_temp.aut(2, 'reversar_venta', 'ventas', pg_temp.id(605), 'dev-A', 660);
  PERFORM pg_temp.falla('autorización para OTRO registro: se rechaza', format('SELECT public.reversar_venta(%L, %L, ''registro distinto'', %L, ''dev-A'')', pg_temp.id(624), v, a), 'AUTORIZACION_INVALIDA');
  a := pg_temp.aut(2, 'reversar_venta', 'ventas', v, 'dev-A', 660, '-1 second');
  PERFORM pg_temp.falla('autorización caducada: se rechaza', format('SELECT public.reversar_venta(%L, %L, ''caducada'', %L, ''dev-A'')', pg_temp.id(625), v, a), 'AUTORIZACION_INVALIDA');
  a := pg_temp.aut(2, 'reversar_venta', 'ventas', v, 'dev-A', 660);
  r := public.reversar_venta(pg_temp.id(626), v, 'cliente devolvió todo', a, 'dev-A');
  PERFORM pg_temp.falla('la MISMA autorización no se reutiliza (otra operación)', format('SELECT public.reversar_venta(%L, %L, ''reuso'', %L, ''dev-A'')', pg_temp.id(627), v, a), 'ya está anulada|AUTORIZACION_INVALIDA');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('reverso de venta: original CONSERVADO (anulada), stock devuelto por ledger, caja compensada por el total',
    (SELECT anulada FROM public.ventas WHERE id = v) AND (SELECT count(*) FROM public.venta_items WHERE venta_id = v) = 2
    AND pg_temp.stock(511) = st511 + 2 AND pg_temp.neta() - n0 = -660);
  PERFORM pg_temp.t('reverso: fila en reversos con motivo, solicitante, autorizador, autorizacion_id, device y operation_id',
    EXISTS (SELECT 1 FROM public.reversos WHERE registro_id = v AND tipo = 'venta' AND solicitado_por = pg_temp.uid(2) AND autorizado_por = pg_temp.uid(1)
            AND autorizacion_id = a AND device_id = 'dev-A' AND operation_id = pg_temp.id(626) AND motivo = 'cliente devolvió todo'));
  PERFORM pg_temp.t('la autorización quedó consumida por ESA operación', (SELECT consumida_op = pg_temp.id(626) FROM public.autorizaciones_admin WHERE id = a));
  PERFORM pg_temp.t('INVARIANTES tras reverso de venta: exactas', pg_temp.invariantes() = '');
END $$;

DO $$
DECLARE c uuid := pg_temp.id(611); ab uuid; a uuid; mv uuid; n0 numeric; r jsonb; st514 numeric := pg_temp.stock(514); v uuid := pg_temp.id(631); vi uuid; st511 numeric;
BEGIN
  -- devolución parcial de una venta nueva (admin: sin PIN, pero auditado)
  PERFORM pg_temp.como(1);
  r := public.registrar_venta_v2(p_op => pg_temp.id(630), p_cliente_id => NULL, p_cliente_nombre => 'x', p_metodo_pago => 'efectivo', p_efectivo => 540,
         p_items => jsonb_build_array(pg_temp.it(511, 3, 180)), p_venta_id => v);
  PERFORM pg_temp.su(); SELECT id INTO vi FROM public.venta_items WHERE venta_id = v; st511 := pg_temp.stock(511); n0 := pg_temp.neta();
  PERFORM pg_temp.como(2);
  a := pg_temp.aut(2, 'registrar_devolucion', 'ventas', v, 'dev-A', 180);
  r := public.registrar_devolucion(pg_temp.id(632), v, jsonb_build_array(jsonb_build_object('venta_item_id', vi, 'cantidad', 1)), 'una salió mala', true, a, 'dev-A');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('devolución parcial (cajero con PIN): 1 unidad vuelve, reembolso 180 como egreso, venta conservada',
    pg_temp.stock(511) = st511 + 1 AND pg_temp.neta() - n0 = -180 AND NOT (SELECT anulada FROM public.ventas WHERE id = v));

  -- reverso de abono y de crédito
  SELECT id INTO ab FROM public.abonos WHERE credito_id = c AND op_id = pg_temp.id(612);
  n0 := pg_temp.neta();
  PERFORM pg_temp.como(2);
  a := pg_temp.aut(2, 'reversar_abono', 'abonos', ab, 'dev-A', 100);
  r := public.reversar_abono(pg_temp.id(633), ab, 'abono mal digitado', a, 'dev-A');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('reverso de abono: abono conservado (anulado), saldo vuelve a 350, caja -100',
    (SELECT anulado FROM public.abonos WHERE id = ab) AND (SELECT saldo FROM public.creditos WHERE id = c) = 350 AND pg_temp.neta() - n0 = -100);
  n0 := pg_temp.neta();
  PERFORM pg_temp.como(2);
  a := pg_temp.aut(2, 'reversar_credito', 'creditos', c, 'dev-A', 500);
  r := public.reversar_credito(pg_temp.id(634), c, 'crédito mal registrado', a, 'dev-A');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('reverso de crédito: crédito conservado (anulado), la entrada vigente (150) se compensa, el repuesto vuelve',
    (SELECT anulado FROM public.creditos WHERE id = c) AND pg_temp.neta() - n0 = -150 AND pg_temp.stock(514) = st514 + 1
    AND (SELECT count(*) FROM public.credito_items WHERE credito_id = c) = 2);

  -- reverso de un movimiento manual de caja
  PERFORM pg_temp.como(2);
  r := public.registrar_movimiento_caja(pg_temp.id(635), 'egreso', 'Compra de repuestos', 900, 'efectivo', 'reposición');
  mv := (r->>'movimiento_id')::uuid;
  PERFORM pg_temp.su(); n0 := pg_temp.neta();
  PERFORM pg_temp.como(2);
  a := pg_temp.aut(2, 'reversar_caja', 'caja_movimientos', mv, 'dev-A', 900);
  r := public.reversar_caja(pg_temp.id(636), mv, 'egreso duplicado', a, 'dev-A');
  PERFORM pg_temp.falla('un movimiento no se revierte dos veces', format('SELECT public.reversar_caja(%L, %L, ''otra vez'', %L, ''dev-A'')', pg_temp.id(637), mv, pg_temp.aut(2, 'reversar_caja', 'caja_movimientos', mv, 'dev-A', 900)), 'ya está revertido');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('reverso de caja: original conservado + UN ingreso compensatorio (+900) con reverso_de',
    pg_temp.neta() - n0 = 900 AND (SELECT count(*) FROM public.caja_movimientos WHERE reverso_de = mv) = 1 AND EXISTS (SELECT 1 FROM public.caja_movimientos WHERE id = mv));
  PERFORM pg_temp.t('INVARIANTES tras devolución y reversos de abono/crédito/caja: exactas', pg_temp.invariantes() = '');
END $$;

-- REUSO ESTRICTO: la misma autorización, mismo registro NO anulado (devolución parcial), segunda operación → inválida
DO $$
DECLARE v uuid := pg_temp.id(631); vi uuid; a uuid; items jsonb;
BEGIN
  PERFORM pg_temp.su(); SELECT id INTO vi FROM public.venta_items WHERE venta_id = v;
  items := jsonb_build_array(jsonb_build_object('venta_item_id', vi, 'cantidad', 1));
  PERFORM pg_temp.como(2);
  a := pg_temp.aut(2, 'registrar_devolucion', 'ventas', v, 'dev-A', 180);
  PERFORM public.registrar_devolucion(pg_temp.id(638), v, items, 'segunda unidad mala', true, a, 'dev-A');
  PERFORM pg_temp.falla('autorización ya consumida: una SEGUNDA operación sobre el mismo registro se rechaza (AUTORIZACION_INVALIDA)',
    format('SELECT public.registrar_devolucion(%L, %L, %L::jsonb, ''reuso'', true, %L, ''dev-A'')', pg_temp.id(639), v, items, a), 'AUTORIZACION_INVALIDA');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('INVARIANTES tras reuso rechazado: exactas', pg_temp.invariantes() = '');
END $$;

-- ORDEN: ítem con stock + retry, quitar (compensatorio), finalizar al crédito, sin doble cobro ------------------------
DO $$
DECLARE o uuid := pg_temp.id(660); r jsonb; it uuid := pg_temp.id(662); st numeric; n0 numeric;
BEGIN
  PERFORM pg_temp.su();
  INSERT INTO public.ordenes (id, cliente_id, estado) VALUES (o, pg_temp.id(501), 'recibido');
  st := pg_temp.stock(514); n0 := pg_temp.neta();
  PERFORM pg_temp.como(2);
  r := public.agregar_item_orden(pg_temp.id(661), o, pg_temp.id(514), 'Cadena', 1, 400, it, false, NULL, 'dev-A');
  r := public.agregar_item_orden(pg_temp.id(661), o, pg_temp.id(514), 'Cadena', 1, 400, it, false, NULL, 'dev-A');
  PERFORM public.agregar_item_orden(pg_temp.id(663), o, NULL, 'Mano de obra', 1, 150, pg_temp.id(664), false, NULL, 'dev-A');
  PERFORM public.agregar_item_orden(pg_temp.id(665), o, pg_temp.id(511), 'Aceite', 1, 180, pg_temp.id(666), false, NULL, 'dev-A');
  PERFORM public.quitar_item_orden(pg_temp.id(667), pg_temp.id(666), 'dev-A');
  PERFORM public.quitar_item_orden(pg_temp.id(667), pg_temp.id(666), 'dev-A');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('orden: ítem con repuesto + retry = UN renglón y UN movimiento (stock −1)', (SELECT count(*) FROM public.orden_items WHERE id = it) = 1
    AND pg_temp.stock(514) = st - 1 AND (SELECT count(*) FROM public.inventario_movimientos WHERE orden_item_id = it AND tipo = 'orden_item') = 1);
  PERFORM pg_temp.t('orden: quitar ítem + retry = UN movimiento compensatorio', (SELECT count(*) FROM public.inventario_movimientos WHERE orden_item_id = pg_temp.id(666) AND tipo = 'reverso_item_orden') = 1);
  UPDATE public.ordenes SET estado = 'entregado' WHERE id = o;
  PERFORM pg_temp.como(2);
  r := public.finalizar_orden(pg_temp.id(668), o, 'credito', NULL, 100, 'efectivo', NULL, NULL, 'dev-A', pg_temp.id(669));
  PERFORM pg_temp.falla('finalizar dos veces (otra operación): 22000 terminal', format('SELECT public.finalizar_orden(%L, %L, ''contado'')', pg_temp.id(670), o), 'ya estaba finalizada');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('finalizar al crédito: total del SERVIDOR 550 (orden_items), crédito ligado, entrada 100 a caja, el stock NO vuelve a bajar',
    (r->>'total')::numeric = 550 AND (SELECT total = 550 AND abonado = 100 AND orden_id = o FROM public.creditos WHERE id = pg_temp.id(669))
    AND pg_temp.neta() - n0 = 100 AND pg_temp.stock(514) = st - 1 AND (SELECT finalizada FROM public.ordenes WHERE id = o));
  PERFORM pg_temp.t('INVARIANTES tras orden: exactas', pg_temp.invariantes() = '');
END $$;

-- 16-18. AJUSTE DE STOCK: admin directo · cajero sin PIN negado · cajero con PIN permitido · motivo obligatorio -----------
DO $$
DECLARE r jsonb; a uuid; s text; st numeric;
BEGIN
  PERFORM pg_temp.como(1);
  r := public.ajustar_stock(pg_temp.id(640), pg_temp.id(512), 'conteo físico', NULL, 7, NULL, 'dev-ADM');
  PERFORM pg_temp.su(); st := pg_temp.stock(512);
  PERFORM pg_temp.t('ajuste admin por conteo: sin PIN, stock = conteo, por ledger (tipo ajuste)', st = 7 AND EXISTS (SELECT 1 FROM public.inventario_movimientos WHERE op_id = pg_temp.id(640) AND tipo = 'ajuste'));
  PERFORM pg_temp.como(2);
  s := pg_temp.estado(format('SELECT public.ajustar_stock(%L, %L, ''rotura'', -1, NULL, NULL, ''dev-A'')', pg_temp.id(641), pg_temp.id(512)));
  PERFORM pg_temp.t('ajuste cajero SIN PIN: negado (42501)', s = '42501');
  s := pg_temp.estado(format('SELECT public.ajustar_stock(%L, %L, ''x'', -1)', pg_temp.id(642), pg_temp.id(512)));
  PERFORM pg_temp.t('ajuste sin motivo: 22023 (terminal)', s = '22023');
  a := pg_temp.aut(2, 'ajustar_stock', 'inventario', pg_temp.id(512), 'dev-A', -1);
  r := public.ajustar_stock(pg_temp.id(643), pg_temp.id(512), 'rotura en bodega', -1, NULL, a, 'dev-A');
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('ajuste cajero CON PIN (hash = delta): permitido, stock 7→6, auditoría con autorizador', pg_temp.stock(512) = 6
    AND EXISTS (SELECT 1 FROM public.auditoria WHERE accion = 'ajuste-stock' AND operation_id = pg_temp.id(643) AND autorizado_por = pg_temp.uid(1)));
  -- el ajuste que deja en orden un repuesto en revisión (tras la venta offline) limpia la marca
  PERFORM pg_temp.como(1);
  r := public.ajustar_stock(pg_temp.id(644), pg_temp.id(513), 'conteo tras venta offline', NULL, 0);
  PERFORM pg_temp.su();
  PERFORM pg_temp.t('ajuste que deja el stock ≥0 resuelve requiere_revision', pg_temp.stock(513) = 0 AND NOT (SELECT requiere_revision FROM public.inventario WHERE id = pg_temp.id(513)));
  PERFORM pg_temp.t('INVARIANTES tras ajustes: exactas', pg_temp.invariantes() = '');
END $$;

-- 24-25. usuario inactivo y mecánico: nunca tocan dinero ni stock ------------------------------------------------------
DO $$
DECLARE s text;
BEGIN
  PERFORM pg_temp.como(3);
  PERFORM pg_temp.t('mecánico: registrar venta → 42501', pg_temp.estado(format('SELECT public.registrar_venta_v2(%L, NULL, ''x'', ''efectivo'', 0, %L::jsonb)', pg_temp.id(650), jsonb_build_array(pg_temp.it(511, 1, 1)))) = '42501');
  PERFORM pg_temp.t('mecánico: abono → 42501', pg_temp.estado(format('SELECT public.registrar_abono_v2(%L, %L, 1, ''efectivo'')', pg_temp.id(651), pg_temp.id(611))) = '42501');
  PERFORM pg_temp.t('mecánico: movimiento de caja → 42501', pg_temp.estado(format('SELECT public.registrar_movimiento_caja(%L, ''ingreso'', ''Otro'', 1, ''efectivo'')', pg_temp.id(652))) = '42501');
  PERFORM pg_temp.t('mecánico: reversar venta (aun con "autorización") → 42501', pg_temp.estado(format('SELECT public.reversar_venta(%L, %L, ''intento'', %L)', pg_temp.id(653), pg_temp.id(631), pg_temp.aut(3, 'reversar_venta', 'ventas', pg_temp.id(631), NULL))) = '42501');
  PERFORM pg_temp.t('mecánico: ajustar stock → 42501', pg_temp.estado(format('SELECT public.ajustar_stock(%L, %L, ''intento'', 5)', pg_temp.id(654), pg_temp.id(511))) = '42501');
  PERFORM pg_temp.t('mecánico: no LEE ventas ni caja (RLS)', (SELECT count(*) FROM public.ventas) = 0 AND (SELECT count(*) FROM public.caja_movimientos) = 0);
  PERFORM pg_temp.su();
  UPDATE public.perfiles SET activo = false WHERE id = pg_temp.uid(2);
  PERFORM pg_temp.como(2);
  PERFORM pg_temp.t('cajero INACTIVO: venta → 42501 (fail-closed)', pg_temp.estado(format('SELECT public.registrar_venta_v2(%L, NULL, ''x'', ''efectivo'', 0, %L::jsonb)', pg_temp.id(655), jsonb_build_array(pg_temp.it(511, 1, 1)))) = '42501');
  PERFORM pg_temp.t('cajero INACTIVO: aun con autorización válida, el reverso se niega', pg_temp.estado(format('SELECT public.reversar_caja(%L, %L, ''inactivo'', %L)', pg_temp.id(656), pg_temp.id(699), pg_temp.aut(2, 'reversar_caja', 'caja_movimientos', pg_temp.id(699), NULL))) IN ('42501', '23503'));
  PERFORM pg_temp.su();
  UPDATE public.perfiles SET activo = true WHERE id = pg_temp.uid(2);
END $$;

-- 30. HARD DELETE financiero prohibido, para authenticated y aun para el dueño de la base ---------------------------------
DO $$
DECLARE t text;
BEGIN
  PERFORM pg_temp.como(1);
  FOREACH t IN ARRAY ARRAY['ventas','venta_items','creditos','credito_items','abonos','caja_movimientos'] LOOP
    PERFORM pg_temp.falla('admin autenticado no borra ' || t, format('DELETE FROM public.%I', t), 'permission denied|no se borra|REVERSAL|borrar');
  END LOOP;
  PERFORM pg_temp.su();
  FOREACH t IN ARRAY ARRAY['ventas','venta_items','creditos','credito_items','abonos','caja_movimientos','inventario_movimientos','reversos'] LOOP
    PERFORM pg_temp.falla('ni el superusuario borra físicamente ' || t || ' (trigger sync_guardia)', format('DELETE FROM public.%I', t));
  END LOOP;
  PERFORM pg_temp.falla('ni el superusuario edita un movimiento de caja cerrado', 'UPDATE public.caja_movimientos SET monto = monto + 1');
  PERFORM pg_temp.t('INVARIANTES FINALES: exactas', pg_temp.invariantes() = '');
  PERFORM pg_temp.t('verificar_invariantes() del servidor coincide: vacío', public.verificar_invariantes() = '[]'::jsonb);
END $$;
