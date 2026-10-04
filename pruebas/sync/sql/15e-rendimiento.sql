-- 3.15.0 · Bloque 5 · RENDIMIENTO de finanzas_resumen con volumen (laboratorio; nunca producción).
-- Siembra ~100 000 movimientos de caja en 2 años, 20 000 ventas (40 000 renglones), 10 000 órdenes (30 000 renglones), 5 000 créditos
-- con 10 000 abonos, y mide: finanzas_resumen del MES y de un AÑO (mediana de 5), y EXPLAIN (ANALYZE, BUFFERS) de la pasada de caja.
-- Uso: psql -d <copia con la cadena + 15e> -f 15e-rendimiento.sql      (correr-sql.sh no lo usa: es una medición, no una prueba)
\timing off
SET session_replication_role = replica;
INSERT INTO public.caja_movimientos (tipo, categoria, monto, metodo_pago, occurred_at)
SELECT CASE WHEN g % 5 = 0 THEN 'egreso' ELSE 'ingreso' END, CASE WHEN g % 5 = 0 THEN 'Planilla' ELSE 'Venta mostrador' END, (g % 900) + 10, 'efectivo',
       now() - (g % 730) * interval '1 day' - (g % 1440) * interval '1 minute'
  FROM generate_series(1, 100000) g;
INSERT INTO public.ventas (id, metodo_pago, total, occurred_at)
SELECT ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, 'efectivo', 300, now() - (g % 730) * interval '1 day' FROM generate_series(1, 20000) g;
INSERT INTO public.venta_items (venta_id, nombre, cantidad, precio, costo_unitario, inventario_id)
SELECT ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, 'r', 1, 150, 90, NULL FROM generate_series(1, 20000) g
UNION ALL SELECT ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, 'r2', 1, 150, 90, NULL FROM generate_series(1, 20000) g;
INSERT INTO public.ordenes (id, estado, falla, finalizada, finalizado_en, tipo_cobro)
SELECT ('00000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid, 'entregado', 'x', g % 10 <> 0, CASE WHEN g % 10 <> 0 THEN now() - (g % 730) * interval '1 day' END, 'contado'
  FROM generate_series(1, 10000) g;
INSERT INTO public.orden_items (orden_id, nombre, cantidad, precio, costo_unitario, tipo)
SELECT ('00000000-0000-4000-c000-' || lpad((g % 10000 + 1)::text, 12, '0'))::uuid, 'mo', 1, 200, 0, 'mano_obra' FROM generate_series(1, 30000) g;
INSERT INTO public.creditos (id, cliente_nombre, total, abonado, saldo, estado, origen, occurred_at)
SELECT ('00000000-0000-4000-d000-' || lpad(g::text, 12, '0'))::uuid, 'c', 1000, 400, 600, 'parcial', 'pos', now() - (g % 730) * interval '1 day' FROM generate_series(1, 5000) g;
INSERT INTO public.credito_items (credito_id, nombre, cantidad, precio) SELECT ('00000000-0000-4000-d000-' || lpad(g::text, 12, '0'))::uuid, 'x', 1, 1000 FROM generate_series(1, 5000) g;
INSERT INTO public.abonos (id_abono, credito_id, monto, metodo_pago, occurred_at)
SELECT 'P' || g, ('00000000-0000-4000-d000-' || lpad((g % 5000 + 1)::text, 12, '0'))::uuid, 200, 'efectivo', now() - (g % 730) * interval '1 day' FROM generate_series(1, 10000) g;
RESET session_replication_role;
ANALYZE;

CREATE FUNCTION pg_temp.mediana(desde date, hasta date) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE t0 timestamptz; v numeric[] := '{}'; i int;
BEGIN
  FOR i IN 1..5 LOOP t0 := clock_timestamp(); PERFORM public.finanzas_resumen(desde, hasta); v := v || extract(epoch FROM clock_timestamp() - t0) * 1000; END LOOP;
  RETURN (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY x)::numeric, 1) FROM unnest(v) x);
END $$;
SELECT 'finanzas_resumen_mes_ms', pg_temp.mediana(date_trunc('month', now() AT TIME ZONE 'America/Tegucigalpa')::date, (now() AT TIME ZONE 'America/Tegucigalpa')::date);
SELECT 'finanzas_resumen_anio_ms', pg_temp.mediana(((now() AT TIME ZONE 'America/Tegucigalpa') - interval '365 days')::date, (now() AT TIME ZONE 'America/Tegucigalpa')::date);
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING ON)
SELECT count(*), sum(x.monto) FROM public.caja_movimientos x LEFT JOIN public.caja_movimientos o ON o.id = x.reverso_de
 WHERE COALESCE(x.occurred_at, x.creado_en) >= date_trunc('month', now()) AND COALESCE(x.occurred_at, x.creado_en) < now() + interval '1 day';
-- sin los índices de 15e (en una transacción que se deshace): cuánto aportan
BEGIN;
DROP INDEX public.idx_caja_momento; DROP INDEX public.idx_ventas_momento; DROP INDEX public.idx_creditos_momento; DROP INDEX public.idx_ordenes_finalizado_en;
DROP INDEX public.idx_ordenes_entregadas_abiertas; DROP INDEX public.idx_creditos_orden;
SELECT 'sin_indices_15e_mes_ms', pg_temp.mediana(date_trunc('month', now() AT TIME ZONE 'America/Tegucigalpa')::date, (now() AT TIME ZONE 'America/Tegucigalpa')::date);
ROLLBACK;
SELECT 'filas', (SELECT count(*) FROM public.caja_movimientos), (SELECT count(*) FROM public.ventas), (SELECT count(*) FROM public.ordenes), (SELECT count(*) FROM public.creditos);
