-- ENTIMOTORS 3.15 · BLOQUE 5 · FOTO FINANCIERA (SOLO LECTURA): origen y restauración deben dar lo mismo (salvo VOLATIL).
-- BEGIN READ ONLY explícito (el pooler ignora PGOPTIONS). Solo conteos y sumas: ni nombres, ni teléfonos, ni descripciones.
-- Día empresarial = America/Tegucigalpa. Se puede correr igual sobre una restauración aislada.
BEGIN READ ONLY;
SET LOCAL TimeZone = 'UTC';
SET LOCAL search_path = pg_catalog, public;
SELECT 'VOLATIL|ro', current_setting('transaction_read_only');
SELECT 'VOLATIL|ahora_utc', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
SELECT 'VOLATIL|dia_negocio', (now() AT TIME ZONE 'America/Tegucigalpa')::date, 'mes_negocio', to_char(now() AT TIME ZONE 'America/Tegucigalpa', 'YYYY-MM');
SELECT 'version', current_setting('server_version');
SELECT 'sync_fases_tabla', to_regclass('public.sync_fases') IS NOT NULL;

-- ── CAJA ─────────────────────────────────────────────────────────────
SELECT 'caja|' || coalesce(categoria, '-') || '|' || tipo || '|compensacion=' || (reverso_de IS NOT NULL) || '|' || count(*) || '|' || sum(monto)
  FROM caja_movimientos GROUP BY categoria, tipo, reverso_de IS NOT NULL ORDER BY 1;
SELECT 'caja_neto', coalesce(sum(CASE WHEN tipo = 'ingreso' THEN monto ELSE -monto END), 0), 'movimientos', count(*) FROM caja_movimientos;
SELECT 'caja_ligada|venta=' || count(*) FILTER (WHERE venta_id IS NOT NULL) || '|credito=' || count(*) FILTER (WHERE credito_id IS NOT NULL)
       || '|orden=' || count(*) FILTER (WHERE orden_id IS NOT NULL) || '|abono=' || count(*) FILTER (WHERE id_abono IS NOT NULL)
       || '|manual=' || count(*) FILTER (WHERE venta_id IS NULL AND credito_id IS NULL AND orden_id IS NULL AND id_abono IS NULL AND reverso_de IS NULL)
       || '|con_op=' || count(*) FILTER (WHERE op_id IS NOT NULL) || '|local_3_13=' || count(*) FILTER (WHERE local_id IS NOT NULL)
  FROM caja_movimientos;
-- por día empresarial (últimos 40) — ingresos brutos, egresos, compensaciones
SELECT 'caja_dia|' || d || '|ing=' || coalesce(ing, 0) || '|egr=' || coalesce(egr, 0) || '|comp=' || coalesce(comp, 0) FROM (
  SELECT (coalesce(occurred_at, creado_en) AT TIME ZONE 'America/Tegucigalpa')::date d,
         sum(monto) FILTER (WHERE tipo = 'ingreso' AND reverso_de IS NULL) ing,
         sum(monto) FILTER (WHERE tipo = 'egreso' AND reverso_de IS NULL) egr,
         sum(monto) FILTER (WHERE reverso_de IS NOT NULL) comp
    FROM caja_movimientos GROUP BY 1 ORDER BY 1 DESC LIMIT 40) x ORDER BY 1;
SELECT 'caja_mes|' || m || '|ing=' || coalesce(ing, 0) || '|egr=' || coalesce(egr, 0) || '|comp=' || coalesce(comp, 0) FROM (
  SELECT to_char(coalesce(occurred_at, creado_en) AT TIME ZONE 'America/Tegucigalpa', 'YYYY-MM') m,
         sum(monto) FILTER (WHERE tipo = 'ingreso' AND reverso_de IS NULL) ing,
         sum(monto) FILTER (WHERE tipo = 'egreso' AND reverso_de IS NULL) egr,
         sum(monto) FILTER (WHERE reverso_de IS NOT NULL) comp
    FROM caja_movimientos GROUP BY 1) x ORDER BY 1;
-- día UTC ≠ día empresarial (movimientos entre 18:00 y 24:00 de Honduras)
SELECT 'caja_utc_distinto_dia_negocio', count(*) FROM caja_movimientos
 WHERE (coalesce(occurred_at, creado_en) AT TIME ZONE 'UTC')::date <> (coalesce(occurred_at, creado_en) AT TIME ZONE 'America/Tegucigalpa')::date;
SELECT 'caja_occurred_vs_creado_distinto_dia', count(*) FROM caja_movimientos
 WHERE occurred_at IS NOT NULL AND (occurred_at AT TIME ZONE 'America/Tegucigalpa')::date <> (creado_en AT TIME ZONE 'America/Tegucigalpa')::date;

-- ── VENTAS (TPV) ─────────────────────────────────────────────────────
SELECT 'ventas|anulada=' || anulada || '|' || count(*) || '|' || sum(total) || '|sin_op=' || count(*) FILTER (WHERE op_id IS NULL)
       || '|local_3_13=' || count(*) FILTER (WHERE local_id IS NOT NULL) FROM ventas GROUP BY anulada ORDER BY 1;
SELECT 'venta_items|inv=' || (inventario_id IS NOT NULL) || '|' || count(*) || '|venta=' || sum(cantidad * precio) || '|costo=' || sum(cantidad * costo_unitario)
       || '|costo_cero=' || count(*) FILTER (WHERE costo_unitario = 0) || '|estimado=' || count(*) FILTER (WHERE costo_estimado)
  FROM venta_items GROUP BY inventario_id IS NOT NULL ORDER BY 1;
SELECT 'ventas_vs_caja|ventas_vivas=' || (SELECT coalesce(sum(total), 0) FROM ventas WHERE NOT anulada)
       || '|caja_venta_ing=' || (SELECT coalesce(sum(monto), 0) FROM caja_movimientos WHERE venta_id IS NOT NULL AND tipo = 'ingreso' AND reverso_de IS NULL)
       || '|ventas_sin_caja=' || (SELECT count(*) FROM ventas v WHERE NOT v.anulada AND v.total > 0 AND NOT EXISTS (SELECT 1 FROM caja_movimientos c WHERE c.venta_id = v.id));

-- ── CRÉDITOS / ABONOS ────────────────────────────────────────────────
SELECT 'creditos|' || estado || '|origen=' || coalesce(origen, '-') || '|anulado=' || anulado || '|' || count(*) || '|total=' || sum(total)
       || '|abonado=' || sum(abonado) || '|saldo=' || sum(saldo) FROM creditos GROUP BY estado, origen, anulado ORDER BY 1;
SELECT 'por_cobrar', coalesce(sum(saldo), 0), 'creditos_con_saldo', count(*) FROM creditos WHERE NOT anulado AND saldo > 0.001;
SELECT 'abonos|anulado=' || anulado || '|' || count(*) || '|' || sum(monto) || '|sin_op=' || count(*) FILTER (WHERE op_id IS NULL) FROM abonos GROUP BY anulado ORDER BY 1;
SELECT 'abonos_vs_caja|abonos_vigentes=' || (SELECT coalesce(sum(monto), 0) FROM abonos WHERE NOT anulado)
       || '|caja_abono_ing_neta=' || (SELECT coalesce(sum(CASE WHEN c.tipo = 'ingreso' THEN c.monto ELSE -c.monto END), 0) FROM caja_movimientos c
                                        WHERE c.id_abono IS NOT NULL OR c.reverso_de IN (SELECT id FROM caja_movimientos WHERE id_abono IS NOT NULL))
       || '|abonos_sin_caja=' || (SELECT count(*) FROM abonos a WHERE NOT EXISTS (SELECT 1 FROM caja_movimientos c WHERE c.id_abono = a.id_abono));
SELECT 'credito_items|inv=' || (inventario_id IS NOT NULL) || '|' || count(*) || '|venta=' || sum(cantidad * precio) || '|costo=' || sum(cantidad * costo_unitario)
  FROM credito_items GROUP BY inventario_id IS NOT NULL ORDER BY 1;

-- ── ÓRDENES ──────────────────────────────────────────────────────────
SELECT 'ordenes|' || estado || '|fin=' || finalizada || '|anul=' || anulada || '|borr=' || (deleted_at IS NOT NULL) || '|cobro=' || coalesce(tipo_cobro, '-')
       || '|' || count(*) || '|total=' || coalesce(sum((SELECT sum(cantidad * precio) FROM orden_items oi WHERE oi.orden_id = o.id)), 0)
  FROM ordenes o GROUP BY estado, finalizada, anulada, deleted_at IS NOT NULL, tipo_cobro ORDER BY 1;
SELECT 'entregado_sin_cobrar', count(*), coalesce(sum((SELECT sum(cantidad * precio) FROM orden_items oi WHERE oi.orden_id = o.id)), 0)
  FROM ordenes o WHERE estado = 'entregado' AND NOT finalizada AND NOT anulada AND deleted_at IS NULL;
SELECT 'orden_items|inv=' || (inventario_id IS NOT NULL) || '|' || count(*) || '|venta=' || sum(cantidad * precio) || '|costo=' || sum(cantidad * costo_unitario)
       || '|costo_cero=' || count(*) FILTER (WHERE costo_unitario = 0) || '|estimado=' || count(*) FILTER (WHERE costo_estimado)
  FROM orden_items GROUP BY inventario_id IS NOT NULL ORDER BY 1;
SELECT 'ordenes_contado_vs_caja|total_fin_contado=' || coalesce((SELECT sum((SELECT sum(cantidad * precio) FROM orden_items oi WHERE oi.orden_id = o.id)) FROM ordenes o
                                                               WHERE finalizada AND tipo_cobro = 'contado' AND NOT anulada), 0)
       || '|caja_orden_ing=' || (SELECT coalesce(sum(monto), 0) FROM caja_movimientos WHERE orden_id IS NOT NULL AND tipo = 'ingreso' AND reverso_de IS NULL);

-- ── DOBLE CONTEO / FACTIBILIDAD DE GARANTÍAS ÚNICAS ──────────────────
SELECT 'dup_caja_por_orden', count(*) FROM (SELECT orden_id FROM caja_movimientos WHERE orden_id IS NOT NULL AND reverso_de IS NULL AND tipo = 'ingreso' GROUP BY orden_id HAVING count(*) > 1) x;
SELECT 'dup_caja_por_abono', count(*) FROM (SELECT id_abono FROM caja_movimientos WHERE id_abono IS NOT NULL AND reverso_de IS NULL GROUP BY id_abono HAVING count(*) > 1) x;
SELECT 'dup_caja_por_venta', count(*) FROM (SELECT venta_id FROM caja_movimientos WHERE venta_id IS NOT NULL AND reverso_de IS NULL AND tipo = 'ingreso' AND categoria IS DISTINCT FROM 'Devolución' GROUP BY venta_id HAVING count(*) > 1) x;
SELECT 'dup_credito_por_orden', count(*) FROM (SELECT orden_id FROM creditos WHERE orden_id IS NOT NULL AND NOT anulado GROUP BY orden_id HAVING count(*) > 1) x;
SELECT 'dup_compensacion', count(*) FROM (SELECT reverso_de FROM caja_movimientos WHERE reverso_de IS NOT NULL GROUP BY reverso_de HAVING count(*) > 1) x;

-- ── INVENTARIO ───────────────────────────────────────────────────────
SELECT 'inv_mov|' || tipo || '|' || count(*) || '|' || sum(cantidad) FROM inventario_movimientos GROUP BY tipo ORDER BY tipo;
SELECT 'inventario|vivos=' || count(*) FILTER (WHERE deleted_at IS NULL) || '|unidades=' || sum(cantidad) FILTER (WHERE deleted_at IS NULL)
       || '|valor_costo=' || sum(cantidad * costo_compra) FILTER (WHERE deleted_at IS NULL AND cantidad > 0) || '|revision=' || count(*) FILTER (WHERE requiere_revision)
  FROM inventario;
SELECT 'invariantes', public.verificar_invariantes()::text;
SELECT 'reversos|' || tipo || '|' || count(*) FROM reversos GROUP BY tipo ORDER BY tipo;
SELECT 'sync_ops|' || kind || '|' || count(*) FROM sync_ops GROUP BY kind ORDER BY kind;
-- órdenes entregadas SIN finalizar: ¿ya tienen un crédito (entonces son «por cobrar», no «entregado pendiente»)?
SELECT 'entregada_sin_fin|cobro=' || coalesce(o.tipo_cobro, '-') || '|credito_ligado=' || (o.credito_id IS NOT NULL OR EXISTS (SELECT 1 FROM creditos c WHERE c.orden_id = o.id AND NOT c.anulado))
       || '|caja_ligada=' || EXISTS (SELECT 1 FROM caja_movimientos c WHERE c.orden_id = o.id) || '|local_3_13=' || (o.local_id IS NOT NULL)
       || '|mes_entrega=' || coalesce(to_char(o.entregado_en AT TIME ZONE 'America/Tegucigalpa', 'YYYY-MM'), '-')
       || '|total=' || coalesce((SELECT sum(cantidad * precio) FROM orden_items oi WHERE oi.orden_id = o.id), 0)
  FROM ordenes o WHERE o.estado = 'entregado' AND NOT o.finalizada AND NOT o.anulada AND o.deleted_at IS NULL ORDER BY o.creado_en;
-- «Ingresos del mes» del dashboard 3.14.1 = Σ renglones de órdenes con estado entregado y entregado_en en el mes (reproducción exacta)
SELECT 'dashboard_3141_ingresos_mes|' || m || '|' || n || '|' || t FROM (
  SELECT to_char(o.entregado_en AT TIME ZONE 'America/Tegucigalpa', 'YYYY-MM') m, count(*) n,
         coalesce(sum((SELECT sum(cantidad * precio) FROM orden_items oi WHERE oi.orden_id = o.id)), 0) t
    FROM ordenes o WHERE o.estado = 'entregado' AND o.entregado_en IS NOT NULL GROUP BY 1) x ORDER BY 1;
-- créditos de la 3.13 que nacieron de una orden (origen vacío pero con orden ligada)
SELECT 'creditos_con_orden|origen=' || coalesce(origen, '-') || '|' || count(*) FROM creditos WHERE orden_id IS NOT NULL GROUP BY origen;
ROLLBACK;
