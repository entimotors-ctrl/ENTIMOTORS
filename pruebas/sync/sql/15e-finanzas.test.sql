-- 3.15.0 · Bloque 5 · FINANZAS (sync-15e). Con 00-prelude.sql + 15c-realtime-stub.sql + 15d-auth-stub.sql y la cadena hasta 15e.
-- Cuentas: 1 admin · 2 cajero · 3 mecánico. Ids de datos: pg_temp.id(50xx..59xx). Todo el dinero pasa por las RPC, como en la app.
-- Día D = 2026-08-10 (Honduras). Las operaciones se fechan con p_occurred_at (instante absoluto); el resumen se pide por día empresarial.
\set ON_ERROR_STOP 0
CREATE FUNCTION pg_temp.ser(n int, sid uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', CASE WHEN n = 0 THEN '' ELSE pg_temp.uid(n)::text END, false);
  PERFORM set_config('request.jwt.claim.role', CASE WHEN n = 0 THEN 'anon' ELSE 'authenticated' END, false);
  PERFORM set_config('request.jwt.claims', CASE WHEN n = 0 THEN '{"role":"anon"}' ELSE json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated', 'session_id', sid)::text END, false);
  PERFORM set_config('role', CASE WHEN n = 0 THEN 'anon' ELSE 'authenticated' END, false);
END $$;
CREATE FUNCTION pg_temp.nadie() RETURNS void LANGUAGE plpgsql AS $$
BEGIN RESET ROLE; PERFORM set_config('request.jwt.claim.sub', '', false); PERFORM set_config('request.jwt.claims', '', false); END $$;
CREATE FUNCTION pg_temp.S(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid $$;
INSERT INTO auth.sessions (id, user_id) VALUES (pg_temp.S(1), pg_temp.uid(1)), (pg_temp.S(2), pg_temp.uid(2));
CREATE FUNCTION pg_temp.emitir(sol int, accion text, entidad text, registro uuid, sid uuid, monto numeric DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
  SELECT ((public.pin_emitir_autorizacion(pg_temp.uid(sol), (SELECT rol FROM public.perfiles WHERE id = pg_temp.uid(sol)), pg_temp.uid(1), accion, entidad, registro, 'dev-1',
          (SELECT version FROM public.admin_pin WHERE perfil_id = pg_temp.uid(1)),
          CASE WHEN monto IS NULL THEN NULL ELSE public.sync_hash_critico(accion, registro, monto) END, 90, sid))->>'autorizacion_id')::uuid $$;
SELECT public.pin_guardar(pg_temp.uid(1), 'scrypt$32768$8$1$c2FsLWZpbg==$aGFzaA==', pg_temp.uid(1), 'inicial');

-- instantes: HN = UTC−6 → «D a las HH:MM de Honduras»
CREATE FUNCTION pg_temp.hn(d date, hhmm text) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$ SELECT (d::text || ' ' || hhmm)::timestamp AT TIME ZONE 'America/Tegucigalpa' $$;
CREATE FUNCTION pg_temp.res(desde date, hasta date, ahora timestamptz DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.finanzas_resumen(desde, hasta, ahora) $$;
CREATE FUNCTION pg_temp.n(j jsonb, k text) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT (j->>k)::numeric $$;
CREATE FUNCTION pg_temp.cajas_orden(o uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM public.caja_movimientos WHERE orden_id = o $$;

DO $$
BEGIN
  INSERT INTO public.clientes (id, nombre, telefono) VALUES (pg_temp.id(5001), 'Cliente F', '9999');
  INSERT INTO public.motos (id, cliente_id, marca, modelo) VALUES (pg_temp.id(5002), pg_temp.id(5001), 'Honda', 'XR150');
  INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES (pg_temp.id(5011), 'Filtro F', 150, 100), (pg_temp.id(5012), 'Pastillas F', 300, 180);
  INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES (pg_temp.id(5011), 'apertura', 20), (pg_temp.id(5012), 'apertura', 10);
END $$;
CREATE FUNCTION pg_temp.orden(n int) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.ordenes (id, cliente_id, moto_id, estado, falla) VALUES (pg_temp.id(n), pg_temp.id(5001), pg_temp.id(5002), 'presupuesto', 'f'); RETURN pg_temp.id(n); END $$;
CREATE FUNCTION pg_temp.renglon(op int, o uuid, item int, inv int, nombre text, cant numeric, precio numeric, tipo text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.como(2);
  PERFORM public.agregar_item_orden(pg_temp.id(op), o, CASE WHEN inv IS NULL THEN NULL ELSE pg_temp.id(inv) END, nombre, cant, precio, pg_temp.id(item), false, NULL, 'dev', tipo);
  PERFORM pg_temp.fin(); END $$;
CREATE FUNCTION pg_temp.entregar(o uuid) RETURNS void LANGUAGE sql AS $$ UPDATE public.ordenes SET estado = 'entregado' WHERE id = o $$;
CREATE FUNCTION pg_temp.cobrar(op int, o uuid, tipo text, t timestamptz, abono numeric DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN PERFORM pg_temp.como(2);
  r := public.finalizar_orden(pg_temp.id(op), o, tipo, 'efectivo', abono, 'efectivo', NULL, t, 'dev-A');
  PERFORM pg_temp.fin(); RETURN r; END $$;
CREATE FUNCTION pg_temp.abonar(op int, c uuid, monto numeric, t timestamptz, dev text DEFAULT 'dev-A') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN PERFORM pg_temp.como(2); r := public.registrar_abono_v2(pg_temp.id(op), c, monto, 'efectivo', t, dev); PERFORM pg_temp.fin(); RETURN r; END $$;
CREATE FUNCTION pg_temp.vender(op int, items jsonb, t timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN PERFORM pg_temp.como(2); r := public.registrar_venta_v2(pg_temp.id(op), NULL, 'Mostrador', 'efectivo', 0, items, t, false, 'dev-A'); PERFORM pg_temp.fin(); RETURN r; END $$;

-- ── F01 · F13 · F11 · orden cobrada completa: repuesto + mano de obra ───────────────────────────────
DO $$
DECLARE o uuid := pg_temp.orden(5100); r jsonb; x jsonb;
BEGIN
  PERFORM pg_temp.renglon(5101, o, 5102, NULL, 'Mano de obra F', 1, 200, 'mano_obra');
  PERFORM pg_temp.renglon(5103, o, 5104, 5011, NULL, 1, 150, 'repuesto_inventario');
  PERFORM pg_temp.entregar(o);
  r := pg_temp.cobrar(5105, o, 'contado', pg_temp.hn('2026-08-10', '10:00'));
  x := pg_temp.res('2026-08-10', '2026-08-10');
  PERFORM pg_temp.t('F01 cobro completo: caja +350 el día D, un solo ingreso', pg_temp.n(x, 'cobrado') = 350 AND pg_temp.cajas_orden(o) = 1);
  PERFORM pg_temp.t('F13 repuesto + mano de obra: facturado 350, costo 100 (solo el repuesto), utilidad bruta 250',
    pg_temp.n(x, 'facturado') = 350 AND pg_temp.n(x, 'costo_repuestos') = 100 AND pg_temp.n(x, 'utilidad_bruta') = 250
    AND pg_temp.n(x, 'venta_mano_obra') = 200 AND pg_temp.n(x, 'venta_repuestos') = 150);
  PERFORM pg_temp.t('F11 costo histórico sellado en el renglón (100)', (SELECT costo_unitario FROM public.orden_items WHERE id = pg_temp.id(5104)) = 100);
  PERFORM pg_temp.t('F01 por cobrar sin cambio (contado)', pg_temp.n(x, 'por_cobrar') = 0);
END $$;

-- ── F02 · F23 · entregada SIN pago: no es cobrado, sí «entregado sin cobrar» ───────────────────────
DO $$
DECLARE o uuid := pg_temp.orden(5200); x jsonb;
BEGIN
  PERFORM pg_temp.renglon(5201, o, 5202, NULL, 'Reparación motor', 1, 500, 'mano_obra');
  PERFORM pg_temp.entregar(o);
  UPDATE public.ordenes SET entregado_en = pg_temp.hn('2026-08-10', '15:00') WHERE id = o;
  x := pg_temp.res('2026-08-10', '2026-08-10');
  PERFORM pg_temp.t('F02 entregada sin pago: aparece en «entregado sin cobrar» (500, 1 orden)', pg_temp.n(x, 'entregado_sin_cobrar') = 500 AND pg_temp.n(x, 'ordenes_entregadas_sin_cobrar') = 1);
  PERFORM pg_temp.t('F23 …y NO suma a cobrado ni a facturado (sigue 350)', pg_temp.n(x, 'cobrado') = 350 AND pg_temp.n(x, 'facturado') = 350 AND pg_temp.cajas_orden(o) = 0);
END $$;

-- ── F03 · F04 · F05 · F06 · crédito, abonos y liquidación sin doble conteo ───────────────────────────
DO $$
DECLARE o uuid := pg_temp.orden(5300); r jsonb; c uuid; x jsonb; y jsonb; z jsonb;
BEGIN
  PERFORM pg_temp.renglon(5301, o, 5302, 5012, NULL, 2, 300, 'repuesto_inventario');
  PERFORM pg_temp.entregar(o);
  r := pg_temp.cobrar(5303, o, 'credito', pg_temp.hn('2026-08-10', '11:00'));
  c := (r->>'credito_id')::uuid;
  x := pg_temp.res('2026-08-10', '2026-08-10');
  PERFORM pg_temp.t('F03 orden a crédito: por cobrar 600, cobrado sin cambio (350), caja 0 para la orden',
    pg_temp.n(x, 'por_cobrar') = 600 AND pg_temp.n(x, 'cobrado') = 350 AND pg_temp.cajas_orden(o) = 0);
  PERFORM pg_temp.t('F03 facturado +600 y costo histórico 2×180', pg_temp.n(x, 'facturado') = 950 AND pg_temp.n(x, 'costo_repuestos') = 460);
  PERFORM pg_temp.t('F03 la orden a crédito ya no es «entregado sin cobrar» (sigue solo la de 500)', pg_temp.n(x, 'entregado_sin_cobrar') = 500);
  PERFORM pg_temp.abonar(5304, c, 200, pg_temp.hn('2026-08-10', '12:00'));
  x := pg_temp.res('2026-08-10', '2026-08-10');
  PERFORM pg_temp.t('F04 abono parcial: cobrado +200 (550), por cobrar 400', pg_temp.n(x, 'cobrado') = 550 AND pg_temp.n(x, 'por_cobrar') = 400);
  PERFORM pg_temp.abonar(5305, c, 150, pg_temp.hn('2026-08-11', '09:00'));
  y := pg_temp.res('2026-08-11', '2026-08-11');
  PERFORM pg_temp.t('F05 segundo abono otro día: cobrado de ese día 150, por cobrar 250', pg_temp.n(y, 'cobrado') = 150 AND pg_temp.n(y, 'por_cobrar') = 250);
  PERFORM pg_temp.abonar(5306, c, 250, pg_temp.hn('2026-08-11', '16:00'));
  z := pg_temp.res('2026-08-10', '2026-08-11');
  PERFORM pg_temp.t('F06 liquidación: saldo 0, crédito pagado, por cobrar 0',
    pg_temp.n(z, 'por_cobrar') = 0 AND (SELECT estado = 'pagado' AND saldo = 0 FROM public.creditos WHERE id = c));
  PERFORM pg_temp.t('F06 sin doble conteo: lo cobrado del crédito es 600 = su total (no total + abonos); facturado 950',
    pg_temp.n(z, 'cobrado') = 350 + 600 AND pg_temp.n(z, 'facturado') = 950);
  -- F07 · reintento del MISMO abono (mismo op_id): mismo resultado, un solo ingreso
  r := pg_temp.abonar(5306, c, 250, pg_temp.hn('2026-08-11', '16:00'));
  PERFORM pg_temp.t('F07 retry de pago (mismo op_id): «repetida», sin segundo ingreso',
    (r->>'repetida')::boolean AND (SELECT count(*) FROM public.caja_movimientos WHERE credito_id = c) = 3
    AND pg_temp.n(pg_temp.res('2026-08-10', '2026-08-11'), 'cobrado') = 950);
  -- F09 · otro dispositivo, otro op_id, abona sobre un crédito ya pagado → se rechaza (no hay saldo)
  PERFORM pg_temp.falla('F09 dos dispositivos: un abono de más desde otro dispositivo se rechaza', format($f$SELECT pg_temp.abonar(5307, %L, 50, now(), 'dev-B')$f$, c), 'supera el saldo');
END $$;

-- ── F08 · F10 · doble clic y respuesta perdida ─────────────────────────────────────────────────────
DO $$
DECLARE o uuid := pg_temp.orden(5400); r jsonb; r2 jsonb; v jsonb; v2 jsonb;
BEGIN
  PERFORM pg_temp.renglon(5401, o, 5402, NULL, 'Servicio', 1, 300, 'mano_obra');
  PERFORM pg_temp.entregar(o);
  r := pg_temp.cobrar(5403, o, 'contado', pg_temp.hn('2026-08-12', '10:00'));
  PERFORM pg_temp.falla('F08 doble clic (segundo cobro con OTRO op_id) se rechaza: la orden ya estaba finalizada',
    format($f$SELECT pg_temp.cobrar(5404, %L, 'contado', now())$f$, o), 'ya estaba finalizada');
  r2 := pg_temp.cobrar(5403, o, 'contado', pg_temp.hn('2026-08-12', '10:00'));
  PERFORM pg_temp.t('F10 respuesta perdida (se repite el MISMO op_id): «repetida», un solo ingreso de 300',
    (r2->>'repetida')::boolean AND pg_temp.cajas_orden(o) = 1 AND pg_temp.n(pg_temp.res('2026-08-12', '2026-08-12'), 'cobrado') = 300);
  -- TPV: la misma venta reintentada tras un corte
  v := pg_temp.vender(5410, jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(5011), 'nombre', 'Filtro F', 'cantidad', 2, 'precio', 150)), pg_temp.hn('2026-08-12', '11:00'));
  v2 := pg_temp.vender(5410, jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(5011), 'nombre', 'Filtro F', 'cantidad', 2, 'precio', 150)), pg_temp.hn('2026-08-12', '11:00'));
  PERFORM pg_temp.t('F10 venta con respuesta perdida: el reintento no crea otra venta ni otro ingreso',
    (v2->>'repetida')::boolean AND (SELECT count(*) FROM public.ventas WHERE op_id = pg_temp.id(5410)) = 1
    AND (SELECT count(*) FROM public.caja_movimientos WHERE venta_id = (v->>'venta_id')::uuid) = 1);
END $$;

-- ── F15 · F14 · solo repuesto (TPV) y solo mano de obra ────────────────────────────────────────────
DO $$
DECLARE o uuid := pg_temp.orden(5500); x jsonb;
BEGIN
  x := pg_temp.res('2026-08-12', '2026-08-12');
  PERFORM pg_temp.t('F15 solo repuesto (TPV 2 filtros): facturado 300, costo 2×100, utilidad 100 (+ orden de 300 sin costo)',
    pg_temp.n(x, 'facturado_tpv') = 300 AND pg_temp.n(x, 'costo_repuestos') = 200 AND pg_temp.n(x, 'utilidad_bruta') = 600 - 200);
  PERFORM pg_temp.renglon(5501, o, 5502, NULL, 'Afinado', 1, 400, 'mano_obra');
  PERFORM pg_temp.entregar(o);
  PERFORM pg_temp.cobrar(5503, o, 'contado', pg_temp.hn('2026-08-13', '10:00'));
  x := pg_temp.res('2026-08-13', '2026-08-13');
  PERFORM pg_temp.t('F14 solo mano de obra: costo 0 y utilidad bruta = precio (sin inventar costo de mano de obra)',
    pg_temp.n(x, 'facturado') = 400 AND pg_temp.n(x, 'costo_repuestos') = 0 AND pg_temp.n(x, 'utilidad_bruta') = 400 AND pg_temp.n(x, 'margen_bruto_pct') = 100);
END $$;

-- ── F12 · F24 · el costo maestro cambia DESPUÉS: la historia no se recalcula ────────────────────────
DO $$
DECLARE antes jsonb; despues jsonb; o uuid := pg_temp.orden(5600); x jsonb; ingenua numeric;
BEGIN
  antes := pg_temp.res('2026-08-10', '2026-08-12');
  UPDATE public.inventario SET costo_compra = 120 WHERE id = pg_temp.id(5011);
  UPDATE public.inventario SET costo_compra = 999 WHERE id = pg_temp.id(5012);
  despues := pg_temp.res('2026-08-10', '2026-08-12');
  PERFORM pg_temp.t('F12 costo maestro 100→120 y 180→999: costo y utilidad del período YA vendido no cambian',
    pg_temp.n(antes, 'costo_repuestos') = pg_temp.n(despues, 'costo_repuestos') AND pg_temp.n(antes, 'utilidad_bruta') = pg_temp.n(despues, 'utilidad_bruta'));
  -- lo que daría usar el costo maestro ACTUAL (el error que se evita)
  SELECT sum(q.cantidad * i.costo_compra) INTO ingenua FROM (
      SELECT oi.inventario_id, oi.cantidad FROM public.orden_items oi JOIN public.ordenes o2 ON o2.id = oi.orden_id WHERE o2.finalizada AND oi.inventario_id IS NOT NULL
      UNION ALL SELECT vi.inventario_id, vi.cantidad FROM public.venta_items vi WHERE vi.inventario_id IS NOT NULL) q JOIN public.inventario i ON i.id = q.inventario_id;
  PERFORM pg_temp.t('F24 la utilidad NO usa el costo maestro actual (ingenuo ' || ingenua || ' ≠ histórico ' || pg_temp.n(despues, 'costo_repuestos') || ')',
    ingenua <> pg_temp.n(despues, 'costo_repuestos') AND pg_temp.n(despues, 'costo_repuestos') = 100 + 360 + 200);
  PERFORM pg_temp.renglon(5601, o, 5602, 5011, NULL, 1, 150, 'repuesto_inventario');
  PERFORM pg_temp.entregar(o);
  PERFORM pg_temp.cobrar(5603, o, 'contado', pg_temp.hn('2026-08-14', '10:00'));
  x := pg_temp.res('2026-08-14', '2026-08-14');
  PERFORM pg_temp.t('F12 una venta NUEVA sí sella el costo nuevo (120)', pg_temp.n(x, 'costo_repuestos') = 120 AND (SELECT costo_unitario FROM public.orden_items WHERE id = pg_temp.id(5602)) = 120);
END $$;

-- ── I · reversión permitida (con PIN del propietario) y devolución ────────────────────────────────
SELECT pg_temp.ser(2, pg_temp.S(2));
SELECT (public.registrar_venta_v2(pg_temp.id(5700), NULL, 'Mostrador', 'efectivo', 0,
          jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(5012), 'nombre', 'Pastillas F', 'cantidad', 1, 'precio', 300)), NULL, false, 'dev-1'))->>'venta_id' AS v_anular \gset
SELECT (public.registrar_venta_v2(pg_temp.id(5701), NULL, 'Mostrador', 'efectivo', 0,
          jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(5011), 'nombre', 'Filtro F', 'cantidad', 2, 'precio', 150),
                            jsonb_build_object('nombre', 'Lavado', 'cantidad', 1, 'precio', 50)), NULL, false, 'dev-1'))->>'venta_id' AS v_dev \gset
SELECT pg_temp.nadie();
SELECT public.finanzas_resumen(NULL, NULL) AS hoy0 \gset
SELECT pg_temp.emitir(1, 'reversar_venta', 'ventas', :'v_anular'::uuid, pg_temp.S(1), 300) AS aut \gset
SELECT pg_temp.ser(1, pg_temp.S(1));
SELECT public.reversar_venta(pg_temp.id(5702), :'v_anular', 'cliente devolvió todo', :'aut', 'dev-1') IS NOT NULL AS revertida \gset
SELECT (public.registrar_devolucion(pg_temp.id(5703), :'v_dev',
          jsonb_build_array(jsonb_build_object('venta_item_id', (SELECT id FROM public.venta_items WHERE venta_id = :'v_dev'::uuid AND inventario_id IS NOT NULL), 'cantidad', 1)),
          'un filtro de más', true, NULL, 'dev-1'))->>'reembolso' AS reembolso \gset
SELECT pg_temp.nadie();
SELECT public.finanzas_resumen(NULL, NULL) AS hoy1 \gset
SELECT pg_temp.t('I anulación: la venta anulada sale de lo facturado y su dinero se compensa en caja (cobrado hoy: +300 −300)',
  :'revertida'::boolean AND (:'hoy1'::jsonb->>'facturado_tpv')::numeric = (:'hoy0'::jsonb->>'facturado_tpv')::numeric - 300 - 150
  AND (SELECT count(*) FROM public.caja_movimientos WHERE reverso_de IN (SELECT id FROM public.caja_movimientos WHERE venta_id = :'v_anular'::uuid)) = 1);
SELECT pg_temp.t('I devolución parcial: reembolso 150 resta de cobrado y de facturado, y el costo SELLADO del filtro devuelto sale del costo',
  :'reembolso'::numeric = 150 AND (:'hoy1'::jsonb->>'cobrado')::numeric = (:'hoy0'::jsonb->>'cobrado')::numeric - 300 - 150
  AND (:'hoy1'::jsonb->>'devoluciones')::numeric = 150
  AND (:'hoy1'::jsonb->>'costo_repuestos')::numeric = (:'hoy0'::jsonb->>'costo_repuestos')::numeric
      - (SELECT sum(cantidad * costo_unitario) FROM public.venta_items WHERE venta_id = :'v_anular'::uuid)
      - (SELECT costo_unitario FROM public.venta_items WHERE venta_id = :'v_dev'::uuid AND inventario_id IS NOT NULL));
SELECT pg_temp.falla('I la misma venta no se compensa dos veces (garantía única de compensación)',
  format($f$INSERT INTO public.caja_movimientos (tipo, categoria, monto, reverso_de) VALUES ('egreso', 'Reverso', 300, (SELECT reverso_de FROM public.caja_movimientos WHERE reverso_de IN (SELECT id FROM public.caja_movimientos WHERE venta_id = %L) LIMIT 1))$f$, :'v_anular'), 'caja_una_compensacion');

-- ── F16..F20 · día empresarial de Honduras (UTC−6) ────────────────────────────────────────────────
INSERT INTO public.caja_movimientos (tipo, categoria, monto, metodo_pago, occurred_at) VALUES
  ('ingreso', 'Otro', 1, 'efectivo', '2030-09-01 23:59:00Z'),    -- 17:59 del 1-sep en Honduras
  ('ingreso', 'Otro', 2, 'efectivo', '2030-09-02 00:00:00Z'),    -- 18:00 del 1-sep (en UTC ya es 2-sep)
  ('ingreso', 'Otro', 4, 'efectivo', '2030-09-02 05:59:00Z'),    -- 23:59 del 1-sep
  ('ingreso', 'Otro', 8, 'efectivo', '2030-09-02 06:00:00Z'),    -- 00:00 del 2-sep
  ('ingreso', 'Otro', 16, 'efectivo', '2030-10-01 05:59:00Z'),   -- 23:59 del 30-sep (en UTC ya es octubre)
  ('ingreso', 'Otro', 32, 'efectivo', '2030-10-01 06:00:00Z'),   -- 00:00 del 1-oct
  ('ingreso', 'Apertura de caja', 1000, 'efectivo', '2030-09-03 14:00:00Z'),   -- fondo: no es cobro
  ('egreso', 'Cierre de caja', 500, 'efectivo', '2030-09-03 23:00:00Z'),       -- fondo: no es gasto
  ('egreso', 'Planilla', 70, 'efectivo', '2030-09-03 20:00:00Z');
SELECT pg_temp.t('F16 17:59 de Honduras cuenta en ese día', pg_temp.n(pg_temp.res('2030-09-01', '2030-09-01'), 'cobrado') >= 1
  AND pg_temp.n(pg_temp.res('2030-09-01', '2030-09-01', '2030-09-01 23:59:00Z'), 'cobrado_hoy') = 7);
SELECT pg_temp.t('F17 18:00 de Honduras (UTC ya es el día siguiente) sigue siendo HOY', pg_temp.n(pg_temp.res('2030-09-01', '2030-09-01', '2030-09-02 00:00:00Z'), 'cobrado_hoy') = 7
  AND (pg_temp.res('2030-09-01', '2030-09-01', '2030-09-02 00:00:00Z'))->>'hoy' = '2030-09-01');
SELECT pg_temp.t('F18 23:59 de Honduras: todavía hoy (1+2+4 = 7)', pg_temp.n(pg_temp.res('2030-09-01', '2030-09-01'), 'cobrado') = 7
  AND pg_temp.n(pg_temp.res('2030-09-01', '2030-09-01', '2030-09-02 05:59:00Z'), 'cobrado_hoy') = 7);
SELECT pg_temp.t('F19 00:00 de Honduras: ya es el día siguiente (solo 8)', pg_temp.n(pg_temp.res('2030-09-02', '2030-09-02', '2030-09-02 06:00:00Z'), 'cobrado_hoy') = 8
  AND (pg_temp.res('2030-09-02', '2030-09-02', '2030-09-02 06:00:00Z'))->>'hoy' = '2030-09-02');
SELECT pg_temp.t('F20 cambio de mes: 23:59 del 30-sep es septiembre (1+2+4+8+16 = 31); 00:00 del 1-oct es octubre (32)',
  pg_temp.n(pg_temp.res('2030-09-01', '2030-09-30', '2030-09-30 18:00:00Z'), 'cobrado_mes') = 31
  AND pg_temp.n(pg_temp.res('2030-10-01', '2030-10-01', '2030-10-01 06:00:00Z'), 'cobrado_mes') = 32
  AND (pg_temp.res('2030-10-01', '2030-10-01', '2030-10-01 05:59:00Z'))->>'mes' = '2030-09');
SELECT pg_temp.t('fondo de caja (apertura/cierre) no es cobro ni gasto; la planilla sí es gasto (70)',
  pg_temp.n(pg_temp.res('2030-09-03', '2030-09-03'), 'cobrado') = 0 AND pg_temp.n(pg_temp.res('2030-09-03', '2030-09-03'), 'gastos') = 70
  AND pg_temp.n(pg_temp.res('2030-09-03', '2030-09-03'), 'movimientos_fondo') = 2);

-- ── F21 · F22 · la caja cuadra con las operaciones; por cobrar = saldo real ───────────────────────
SELECT pg_temp.t('F21 finanzas_invariantes() = [] (abonos, mostrador, taller, crédito de orden, por cobrar, orden finalizada con dinero)',
  public.finanzas_invariantes() = '[]'::jsonb);
SELECT pg_temp.t('F21 cobrado de TODO el período = Σ ingresos reales − devoluciones − compensaciones (recalculado aparte)',
  pg_temp.n(pg_temp.res('2026-01-01', '2026-12-31'), 'cobrado') =
  (SELECT sum(CASE WHEN reverso_de IS NULL AND tipo = 'ingreso' AND categoria NOT IN ('Apertura de caja', 'Cierre de caja') THEN monto
                   WHEN reverso_de IS NULL AND categoria = 'Devolución' THEN -monto
                   WHEN reverso_de IS NOT NULL AND tipo = 'egreso' THEN -monto ELSE 0 END) FROM public.caja_movimientos
    WHERE COALESCE(occurred_at, creado_en) >= '2026-01-01 06:00Z' AND COALESCE(occurred_at, creado_en) < '2027-01-01 06:00Z'));
SELECT pg_temp.t('F22 por cobrar = Σ (total − abonos vigentes) de los créditos vivos',
  pg_temp.n(pg_temp.res(NULL, NULL), 'por_cobrar') = (SELECT COALESCE(sum(k.total - COALESCE((SELECT sum(a.monto) FROM public.abonos a WHERE a.credito_id = k.id AND NOT a.anulado), 0)), 0) FROM public.creditos k WHERE NOT k.anulado));
DO $$
DECLARE c uuid; x jsonb;
BEGIN
  PERFORM pg_temp.como(2);
  c := ((public.registrar_credito(p_op => pg_temp.id(5800), p_cliente_id => pg_temp.id(5001), p_cliente_nombre => 'Cliente F', p_cliente_telefono => '9999',
         p_items => jsonb_build_array(jsonb_build_object('inventario_id', pg_temp.id(5012), 'nombre', 'Pastillas F', 'cantidad', 1, 'precio', 300)),
         p_abono_inicial => 100, p_abono_metodo => 'efectivo', p_occurred_at => pg_temp.hn('2026-08-20', '10:00'), p_device => 'dev-A', p_origen => 'pos'))->>'credito_id')::uuid;
  PERFORM pg_temp.fin();
  x := pg_temp.res('2026-08-20', '2026-08-20');
  PERFORM pg_temp.t('F22 crédito de TPV con entrada 100: cobrado 100, por cobrar +200, facturado 300 (no 300 + 100)',
    pg_temp.n(x, 'cobrado') = 100 AND pg_temp.n(x, 'facturado') = 300 AND pg_temp.n(x, 'facturado_creditos') = 300
    AND (SELECT saldo FROM public.creditos WHERE id = c) = 200);
  PERFORM pg_temp.t('F22 costo histórico del crédito de TPV = el del día (999: el maestro ya había cambiado)', pg_temp.n(x, 'costo_repuestos') = 999);
END $$;
SELECT pg_temp.t('F21 invariantes siguen vacías tras crédito de TPV, anulación y devolución', public.finanzas_invariantes() = '[]'::jsonb);

-- ── garantías únicas: el dinero no puede aparecer dos veces aunque alguien salte las RPC ────────────
SELECT pg_temp.falla('U1 un segundo ingreso para la MISMA orden se rechaza en la base',
  format($f$INSERT INTO public.caja_movimientos (tipo, categoria, monto, orden_id) VALUES ('ingreso', 'Servicio taller', 350, %L)$f$, pg_temp.id(5100)), 'caja_un_ingreso_por_orden');
SELECT pg_temp.falla('U2 un segundo movimiento para el MISMO abono se rechaza',
  format($f$INSERT INTO public.caja_movimientos (tipo, categoria, monto, id_abono) VALUES ('ingreso', 'Cobro de crédito', 200, %L)$f$,
         (SELECT a.id_abono FROM public.abonos a JOIN public.creditos k ON k.id = a.credito_id WHERE k.orden_id = pg_temp.id(5300) ORDER BY a.creado_en LIMIT 1)), 'caja_un_movimiento_por_abono');
SELECT pg_temp.falla('U3 un segundo ingreso para la MISMA venta se rechaza',
  format($f$INSERT INTO public.caja_movimientos (tipo, categoria, monto, venta_id) VALUES ('ingreso', 'Venta mostrador', 300, %L)$f$, :'v_dev'), 'caja_un_ingreso_por_venta');
SELECT pg_temp.falla('U4 un segundo crédito VIVO para la misma orden se rechaza',
  format($f$INSERT INTO public.creditos (cliente_nombre, total, saldo, orden_id, origen) VALUES ('x', 600, 600, %L, 'orden')$f$, pg_temp.id(5300)), 'creditos_uno_vivo_por_orden');

-- ── v1 sin op_id: ya no las ejecuta la app ─────────────────────────────────────────────────────────
SELECT pg_temp.falla('V1 registrar_venta (v1, sin op_id) ya no es ejecutable por una sesión de la app',
  $$SELECT pg_temp.como(2); SELECT public.registrar_venta(NULL, 'x', 'efectivo', 0, '[]'::jsonb, NULL, NULL)$$, 'permission denied');
SELECT pg_temp.fin();
SELECT pg_temp.falla('V2 registrar_abono (v1, sin op_id) ya no es ejecutable por una sesión de la app',
  $$SELECT pg_temp.como(2); SELECT public.registrar_abono('00000000-0000-4000-9000-000000000001', 1, 'efectivo', 'x')$$, 'permission denied');
SELECT pg_temp.fin();
SELECT pg_temp.t('V3 service_role conserva EXECUTE sobre las v1 (rollback/soporte)', has_function_privilege('service_role', 'public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text)', 'EXECUTE'));

-- ── acceso ──────────────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.falla('A1 el cajero no ve el resumen financiero', $$SELECT pg_temp.como(2); SELECT public.finanzas_resumen(NULL, NULL)$$, 'Solo el administrador');
SELECT pg_temp.fin();
SELECT pg_temp.falla('A2 anon no ejecuta finanzas_resumen', $$SELECT pg_temp.como(0); SELECT public.finanzas_resumen(NULL, NULL)$$, 'permission denied');
SELECT pg_temp.fin();
DO $$ BEGIN PERFORM pg_temp.como(1);
  PERFORM pg_temp.t('A3 el administrador sí (y el resultado trae la zona de Honduras)', (public.finanzas_resumen(NULL, NULL))->>'zona' = 'America/Tegucigalpa');
  PERFORM pg_temp.fin(); END $$;
SELECT pg_temp.falla('A4 rango al revés → error claro', $$SELECT public.finanzas_resumen('2026-09-02', '2026-09-01')$$, 'al revés');

-- ── panel técnico: «ventas de hoy» en el día de Honduras ────────────────────────────────────────────
DO $$
DECLARE i timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Tegucigalpa') AT TIME ZONE 'America/Tegucigalpa'; antes int; despues int;
BEGIN
  PERFORM pg_temp.como(1); antes := (public.estadisticas_tecnicas()->>'ventas_hoy')::int; PERFORM pg_temp.fin();
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.ventas (metodo_pago, total, creado_en) VALUES ('efectivo', 0, i + interval '1 minute'), ('efectivo', 0, i - interval '1 minute');
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.como(1); despues := (public.estadisticas_tecnicas()->>'ventas_hoy')::int; PERFORM pg_temp.fin();
  PERFORM pg_temp.t('T1 panel técnico: una venta a las 00:01 de HOY en Honduras cuenta; una a las 23:59 de AYER no (+1 exacto)', despues - antes = 1);
  PERFORM pg_temp.como(1);
  PERFORM pg_temp.t('T2 el resto de estadisticas_tecnicas sigue siendo solo count(*) (14 claves, sin importes)',
    (SELECT count(*) FROM jsonb_object_keys((SELECT public.estadisticas_tecnicas()))) = 14);
  PERFORM pg_temp.fin();
END $$;
SELECT pg_temp.falla('T3 el cajero sigue sin ver estadisticas_tecnicas', $$SELECT pg_temp.como(2); SELECT public.estadisticas_tecnicas()$$, 'Solo el administrador y el desarrollador');
SELECT pg_temp.fin();

-- ── B20 · restaurar un respaldo en la nube = DESTRUCTIVA (contrato; no existe ninguna RPC que restaure) ─────────────
SELECT pg_temp.t('B20 restaurar_respaldo es destructiva (PIN del propietario para todos) y las demás siguen igual',
  public.sync_accion_destructiva('restaurar_respaldo') AND public.sync_accion_destructiva('eliminar_usuario') AND NOT public.sync_accion_destructiva('ajustar_stock'));
SELECT pg_temp.falla('B20 sin autorización del PIN, sync_autorizar niega restaurar (también al admin)',
  $$SELECT pg_temp.ser(1, pg_temp.S(1)); SELECT public.sync_autorizar(NULL, 'restaurar_respaldo', 'respaldos', gen_random_uuid(), gen_random_uuid(), NULL, 'dev-1')$$, 'AUTORIZACION_REQUERIDA|permission denied');
SELECT pg_temp.nadie();
SELECT pg_temp.t('B19 ninguna función de la base restaura respaldos (la restauración en la nube no existe en 3.15)',
  NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname ~* 'restaur'));
