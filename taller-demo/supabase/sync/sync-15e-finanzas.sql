-- ENTIMOTORS OS 3.15.0 · BLOQUE 5 · FINANZAS CORRECTAS · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere la cadena SYNC 1..10 + SEC-1C + 15a..15d. Idempotente. Sin cambios de datos.
--
-- PRINCIPIO (indicadores de efectivo)
--  · COBRADO = dinero que realmente entró en caja, por el DÍA EMPRESARIAL (America/Tegucigalpa) del movimiento, menos lo devuelto.
--    Una orden entregada sin cobrar NO es cobrado; un crédito cuenta como cobrado SOLO por sus abonos; el total del crédito nunca se suma
--    además de sus abonos. Apertura/cierre de caja (fondo) no es cobro ni gasto.
--  · POR COBRAR = saldo vivo de los créditos no anulados. ENTREGADO SIN COBRAR = órdenes entregadas, sin finalizar, sin anular y sin
--    crédito: trabajo hecho que todavía no es ni dinero ni deuda registrada.
--  · FACTURADO (devengado) = ventas de TPV + órdenes finalizadas (contado o crédito) + créditos que no nacen de una orden, sin anuladas,
--    menos devoluciones. COSTO DE REPUESTOS = cantidad × costo_unitario SELLADO en cada renglón de inventario el día de la operación
--    (nunca el costo_compra actual del inventario). UTILIDAD BRUTA = facturado − costo de repuestos. La mano de obra no tiene costo
--    porque ENTIMOTORS no tiene todavía un modelo de costo de mano de obra: su precio entero cuenta como utilidad bruta, y lo que no tiene
--    costo conocido (repuesto manual, renglón legado en 0) se informa aparte, nunca se inventa.
--
-- NO DUPLICAR DINERO (garantías de base, además del op_id de cada RPC)
--  · Un solo ingreso de caja por venta, por orden y por abono; una sola compensación por movimiento; un solo crédito vivo por orden.
--  · registrar_venta / registrar_abono (v1, sin op_id ni cerrojo): ya nadie las llama (el cliente usa las v2 desde SYNC-3); se les quita
--    EXECUTE a authenticated para que un reintento de un cliente viejo no pueda duplicar dinero. service_role conserva EXECUTE.
--
-- PANEL TÉCNICO · estadisticas_tecnicas().ventas_hoy: el día empresarial de Honduras (antes current_date = día UTC del servidor).
--    Es una evolución DECLARADA de una función canónica RCV-34: solo cambia esa línea (lo verifica pruebas/rcv34/guard-evolucion-canonicas.mjs).
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sync_fases WHERE fase = '15d') THEN RAISE EXCEPTION 'SYNC-15E STOP: falta sync-15d'; END IF;
  IF to_regprocedure('public.finalizar_orden(uuid,uuid,text,text,numeric,text,date,timestamptz,text,uuid)') IS NULL
     OR to_regprocedure('public.sync_compensar_caja(text,uuid,text,timestamptz,text,numeric)') IS NULL THEN
    RAISE EXCEPTION 'SYNC-15E STOP: faltan SYNC-3/7B/15b';
  END IF;
END
$pre$;

-- ═════════════════════════ 1. NO DUPLICAR DINERO: GARANTÍAS ÚNICAS ═════════════════════════
-- Antes de crear cada índice se cuentan los duplicados: si los hubiera, la migración se DETIENE (nunca borra ni corrige datos sola).
DO $dup$
DECLARE n int; v text := '';
BEGIN
  SELECT count(*) INTO n FROM (SELECT venta_id FROM public.caja_movimientos WHERE venta_id IS NOT NULL AND reverso_de IS NULL AND tipo = 'ingreso' GROUP BY venta_id HAVING count(*) > 1) x;
  IF n > 0 THEN v := v || ' ventas con 2+ ingresos=' || n; END IF;
  SELECT count(*) INTO n FROM (SELECT orden_id FROM public.caja_movimientos WHERE orden_id IS NOT NULL AND reverso_de IS NULL AND tipo = 'ingreso' GROUP BY orden_id HAVING count(*) > 1) x;
  IF n > 0 THEN v := v || ' órdenes con 2+ ingresos=' || n; END IF;
  SELECT count(*) INTO n FROM (SELECT id_abono FROM public.caja_movimientos WHERE id_abono IS NOT NULL AND reverso_de IS NULL GROUP BY id_abono HAVING count(*) > 1) x;
  IF n > 0 THEN v := v || ' abonos con 2+ movimientos=' || n; END IF;
  SELECT count(*) INTO n FROM (SELECT reverso_de FROM public.caja_movimientos WHERE reverso_de IS NOT NULL GROUP BY reverso_de HAVING count(*) > 1) x;
  IF n > 0 THEN v := v || ' movimientos compensados 2+ veces=' || n; END IF;
  SELECT count(*) INTO n FROM (SELECT orden_id FROM public.creditos WHERE orden_id IS NOT NULL AND NOT anulado GROUP BY orden_id HAVING count(*) > 1) x;
  IF n > 0 THEN v := v || ' órdenes con 2+ créditos vivos=' || n; END IF;
  IF v <> '' THEN RAISE EXCEPTION 'SYNC-15E STOP: hay dinero duplicado que revisar a mano antes de migrar:%', v; END IF;
END
$dup$;
CREATE UNIQUE INDEX IF NOT EXISTS caja_un_ingreso_por_venta ON public.caja_movimientos (venta_id) WHERE venta_id IS NOT NULL AND reverso_de IS NULL AND tipo = 'ingreso';
CREATE UNIQUE INDEX IF NOT EXISTS caja_un_ingreso_por_orden ON public.caja_movimientos (orden_id) WHERE orden_id IS NOT NULL AND reverso_de IS NULL AND tipo = 'ingreso';
CREATE UNIQUE INDEX IF NOT EXISTS caja_un_movimiento_por_abono ON public.caja_movimientos (id_abono) WHERE id_abono IS NOT NULL AND reverso_de IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS caja_una_compensacion ON public.caja_movimientos (reverso_de) WHERE reverso_de IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS creditos_uno_vivo_por_orden ON public.creditos (orden_id) WHERE orden_id IS NOT NULL AND NOT anulado;

-- rangos por día empresarial: las consultas comparan el INSTANTE (coalesce(occurred_at, creado_en)) contra los límites del día de
-- Honduras ya convertidos a timestamptz, así que un índice de expresión sirve (sin convertir cada fila de zona).
CREATE INDEX IF NOT EXISTS idx_caja_momento ON public.caja_movimientos ((COALESCE(occurred_at, creado_en)));
CREATE INDEX IF NOT EXISTS idx_ventas_momento ON public.ventas ((COALESCE(occurred_at, creado_en)));
CREATE INDEX IF NOT EXISTS idx_creditos_momento ON public.creditos ((COALESCE(occurred_at, creado_en)));
CREATE INDEX IF NOT EXISTS idx_ordenes_finalizado_en ON public.ordenes (finalizado_en) WHERE finalizada;
CREATE INDEX IF NOT EXISTS idx_ordenes_entregadas_abiertas ON public.ordenes (id) WHERE estado = 'entregado' AND NOT finalizada AND NOT anulada AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_creditos_orden ON public.creditos (orden_id) WHERE orden_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_caja_orden ON public.caja_movimientos (orden_id) WHERE orden_id IS NOT NULL;

-- ═════════════════════════ 2. RESUMEN FINANCIERO ═════════════════════════
CREATE OR REPLACE FUNCTION public.finanzas_resumen(p_desde date DEFAULT NULL, p_hasta date DEFAULT NULL, p_ahora timestamptz DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  z CONSTANT text := 'America/Tegucigalpa';
  -- p_ahora solo existe para probar las fronteras del día (17:59/18:00/23:59/00:00): cambia qué día es «hoy», nada más
  v_hoy date := (COALESCE(p_ahora, clock_timestamp()) AT TIME ZONE 'America/Tegucigalpa')::date;
  v_mes date; v_desde date; v_hasta date;
  i_hoy timestamptz; f_hoy timestamptz; i_mes timestamptz; f_mes timestamptz; i_r timestamptz; f_r timestamptz;
  c record; f record; cr record; ep record; dv record; r jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador ve las finanzas' USING ERRCODE = '42501'; END IF;
  v_mes := date_trunc('month', v_hoy)::date;
  v_desde := COALESCE(p_desde, v_mes);
  v_hasta := COALESCE(p_hasta, v_hoy);
  IF v_hasta < v_desde THEN RAISE EXCEPTION 'El rango está al revés' USING ERRCODE = '22023'; END IF;
  IF v_hasta - v_desde > 3660 THEN RAISE EXCEPTION 'Rango demasiado largo (máximo 10 años)' USING ERRCODE = '22023'; END IF;
  -- límites de cada día empresarial como instantes (la zona IANA resuelve cualquier cambio de horario)
  i_hoy := v_hoy::timestamp AT TIME ZONE z;             f_hoy := (v_hoy + 1)::timestamp AT TIME ZONE z;
  i_mes := v_mes::timestamp AT TIME ZONE z;             f_mes := ((v_mes + interval '1 month')::date)::timestamp AT TIME ZONE z;
  i_r := v_desde::timestamp AT TIME ZONE z;             f_r := (v_hasta + 1)::timestamp AT TIME ZONE z;

  -- CAJA: una pasada. Cada movimiento se clasifica por su naturaleza; una compensación hereda la naturaleza del movimiento que revierte.
  WITH m AS (
    SELECT x.monto, COALESCE(x.occurred_at, x.creado_en) AS t,
           CASE
             WHEN x.reverso_de IS NULL AND x.categoria IN ('Apertura de caja', 'Cierre de caja') THEN 'fondo'
             -- el original se busca por su clave SOLO si la fila es una compensación (no un cruce con toda la caja)
             WHEN x.reverso_de IS NOT NULL AND (SELECT o.categoria FROM public.caja_movimientos o WHERE o.id = x.reverso_de) IN ('Apertura de caja', 'Cierre de caja') THEN 'fondo'
             WHEN x.reverso_de IS NULL AND x.tipo = 'ingreso' THEN 'cobro'
             WHEN x.reverso_de IS NULL AND x.categoria = 'Devolución' THEN 'devolucion'
             WHEN x.reverso_de IS NULL THEN 'gasto'
             WHEN x.tipo = 'egreso' THEN 'cobro_revertido'      -- compensa un ingreso: dinero que se devolvió
             ELSE 'gasto_revertido'                             -- compensa un egreso
           END AS clase
      FROM public.caja_movimientos x
     WHERE COALESCE(x.occurred_at, x.creado_en) >= LEAST(i_mes, i_r) AND COALESCE(x.occurred_at, x.creado_en) < GREATEST(f_hoy, f_mes, f_r)
  )
  SELECT
    COALESCE(sum(monto) FILTER (WHERE clase = 'cobro' AND t >= i_hoy AND t < f_hoy), 0) AS bruto_hoy,
    COALESCE(sum(monto) FILTER (WHERE clase IN ('devolucion', 'cobro_revertido') AND t >= i_hoy AND t < f_hoy), 0) AS dev_hoy,
    COALESCE(sum(monto) FILTER (WHERE clase = 'cobro' AND t >= i_mes AND t < f_mes), 0) AS bruto_mes,
    COALESCE(sum(monto) FILTER (WHERE clase IN ('devolucion', 'cobro_revertido') AND t >= i_mes AND t < f_mes), 0) AS dev_mes,
    COALESCE(sum(monto) FILTER (WHERE clase = 'cobro' AND t >= i_r AND t < f_r), 0) AS bruto_r,
    COALESCE(sum(monto) FILTER (WHERE clase IN ('devolucion', 'cobro_revertido') AND t >= i_r AND t < f_r), 0) AS dev_r,
    COALESCE(sum(monto) FILTER (WHERE clase = 'gasto' AND t >= i_r AND t < f_r), 0)
      - COALESCE(sum(monto) FILTER (WHERE clase = 'gasto_revertido' AND t >= i_r AND t < f_r), 0) AS gastos_r,
    count(*) FILTER (WHERE clase = 'fondo' AND t >= i_r AND t < f_r) AS fondos_r
  INTO c FROM m;

  -- FACTURADO y COSTO HISTÓRICO del rango (por el día empresarial de la venta, del cierre de la orden o del crédito)
  WITH ren AS (
    SELECT vi.cantidad * vi.precio AS venta, CASE WHEN vi.inventario_id IS NOT NULL THEN vi.cantidad * vi.costo_unitario ELSE 0 END AS costo,
           CASE WHEN vi.inventario_id IS NOT NULL THEN 'repuesto' ELSE 'otro' END AS clase,
           (vi.inventario_id IS NOT NULL AND (vi.costo_unitario = 0 OR vi.costo_estimado)) AS sin_costo, 'tpv' AS origen
      FROM public.ventas v JOIN public.venta_items vi ON vi.venta_id = v.id
     WHERE NOT v.anulada AND COALESCE(v.occurred_at, v.creado_en) >= i_r AND COALESCE(v.occurred_at, v.creado_en) < f_r
    UNION ALL
    SELECT oi.cantidad * oi.precio, CASE WHEN oi.inventario_id IS NOT NULL THEN oi.cantidad * oi.costo_unitario ELSE 0 END,
           CASE WHEN oi.inventario_id IS NOT NULL THEN 'repuesto' WHEN oi.tipo = 'repuesto_manual' THEN 'repuesto_manual'
                WHEN oi.tipo = 'mano_obra' THEN 'mano_obra' ELSE 'otro' END,
           (oi.inventario_id IS NOT NULL AND (oi.costo_unitario = 0 OR oi.costo_estimado)) OR oi.tipo = 'repuesto_manual', 'orden'
      FROM public.ordenes o JOIN public.orden_items oi ON oi.orden_id = o.id
     WHERE o.finalizada AND NOT o.anulada AND o.deleted_at IS NULL AND o.finalizado_en >= i_r AND o.finalizado_en < f_r
    UNION ALL
    SELECT ci.cantidad * ci.precio, CASE WHEN ci.inventario_id IS NOT NULL THEN ci.cantidad * ci.costo_unitario ELSE 0 END,
           CASE WHEN ci.inventario_id IS NOT NULL THEN 'repuesto' ELSE 'otro' END,
           (ci.inventario_id IS NOT NULL AND ci.costo_unitario = 0), 'credito'
      FROM public.creditos k JOIN public.credito_items ci ON ci.credito_id = k.id
     WHERE NOT k.anulado AND k.orden_id IS NULL AND k.origen IS DISTINCT FROM 'orden'
       AND COALESCE(k.occurred_at, k.creado_en) >= i_r AND COALESCE(k.occurred_at, k.creado_en) < f_r
  )
  SELECT COALESCE(sum(venta), 0) AS facturado, COALESCE(sum(costo), 0) AS costo,
         COALESCE(sum(venta) FILTER (WHERE origen = 'tpv'), 0) AS f_tpv, COALESCE(sum(venta) FILTER (WHERE origen = 'orden'), 0) AS f_orden,
         COALESCE(sum(venta) FILTER (WHERE origen = 'credito'), 0) AS f_credito,
         COALESCE(sum(venta) FILTER (WHERE clase = 'repuesto'), 0) AS v_rep, COALESCE(sum(venta) FILTER (WHERE clase = 'repuesto_manual'), 0) AS v_man,
         COALESCE(sum(venta) FILTER (WHERE clase IN ('mano_obra', 'otro')), 0) AS v_mo,
         count(*) FILTER (WHERE clase = 'repuesto') AS n_rep, count(*) FILTER (WHERE sin_costo) AS n_sin_costo
    INTO f FROM ren;

  -- devoluciones de TPV del rango (de ventas que siguen vivas): restan lo facturado y el costo de lo que volvió
  SELECT COALESCE(sum((r2.detalle->>'monto')::numeric), 0) AS monto,
         COALESCE(sum((SELECT sum(z.cantidad * vi.costo_unitario) FROM jsonb_to_recordset(r2.detalle->'items') AS z(venta_item_id uuid, cantidad numeric)
                         JOIN public.venta_items vi ON vi.id = z.venta_item_id WHERE vi.inventario_id IS NOT NULL)), 0) AS costo
    INTO dv FROM public.reversos r2 JOIN public.ventas v ON v.id = r2.registro_id
   WHERE r2.tipo = 'devolucion' AND r2.entidad = 'ventas' AND NOT v.anulada AND r2.creado_en >= i_r AND r2.creado_en < f_r;

  SELECT COALESCE(sum(saldo), 0) AS saldo, count(*) AS n INTO cr FROM public.creditos WHERE NOT anulado AND saldo > 0.001;
  SELECT COALESCE(sum((SELECT sum(oi.cantidad * oi.precio) FROM public.orden_items oi WHERE oi.orden_id = o.id)), 0) AS total, count(*) AS n INTO ep
    FROM public.ordenes o
   WHERE o.estado = 'entregado' AND NOT o.finalizada AND NOT o.anulada AND o.deleted_at IS NULL AND o.credito_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.creditos k WHERE k.orden_id = o.id AND NOT k.anulado);

  r := jsonb_build_object(
    'zona', z, 'hoy', v_hoy, 'mes', to_char(v_mes, 'YYYY-MM'), 'desde', v_desde, 'hasta', v_hasta,
    'cobrado_hoy', c.bruto_hoy - c.dev_hoy, 'cobrado_mes', c.bruto_mes - c.dev_mes, 'cobrado', c.bruto_r - c.dev_r,
    'cobrado_bruto', c.bruto_r, 'devuelto', c.dev_r, 'gastos', c.gastos_r, 'movimientos_fondo', c.fondos_r,
    'por_cobrar', cr.saldo, 'creditos_con_saldo', cr.n,
    'entregado_sin_cobrar', ep.total, 'ordenes_entregadas_sin_cobrar', ep.n,
    'facturado', f.facturado - dv.monto, 'facturado_tpv', f.f_tpv - dv.monto, 'facturado_ordenes', f.f_orden, 'facturado_creditos', f.f_credito,
    'devoluciones', dv.monto,
    'venta_repuestos', f.v_rep, 'venta_repuestos_manuales', f.v_man, 'venta_mano_obra', f.v_mo,
    'costo_repuestos', f.costo - dv.costo, 'renglones_repuesto', f.n_rep, 'renglones_sin_costo', f.n_sin_costo,
    'utilidad_bruta', (f.facturado - dv.monto) - (f.costo - dv.costo),
    'margen_bruto_pct', CASE WHEN f.facturado - dv.monto > 0 THEN round((((f.facturado - dv.monto) - (f.costo - dv.costo)) / (f.facturado - dv.monto)) * 100, 1) END
  );
  RETURN r;
END
$function$;

-- ═════════════════════════ 3. INVARIANTES FINANCIERAS ═════════════════════════
-- Sumas que tienen que cuadrar entre la caja y las operaciones que la originan. Devuelve [] si todo cuadra.
CREATE OR REPLACE FUNCTION public.finanzas_invariantes()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '[]'::jsonb; a numeric; b numeric; n int;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.es_admin() THEN RAISE EXCEPTION 'Solo el administrador' USING ERRCODE = '42501'; END IF;
  -- (1) abonos vigentes = cobros de crédito en caja, netos de sus compensaciones
  SELECT COALESCE(sum(monto), 0) INTO a FROM public.abonos WHERE NOT anulado;
  SELECT COALESCE(sum(x.monto) FILTER (WHERE x.reverso_de IS NULL), 0) - COALESCE(sum(x.monto) FILTER (WHERE x.reverso_de IS NOT NULL), 0) INTO b
    FROM public.caja_movimientos x LEFT JOIN public.caja_movimientos o ON o.id = x.reverso_de
   WHERE (x.reverso_de IS NULL AND x.categoria = 'Cobro de crédito' AND x.tipo = 'ingreso') OR (o.categoria = 'Cobro de crédito' AND o.tipo = 'ingreso');
  IF abs(a - b) > 0.01 THEN v := v || jsonb_build_object('invariante', 'abonos=caja_cobro_credito', 'abonos', a, 'caja', b); END IF;
  -- (2) ventas vivas − devoluciones = cobros de mostrador en caja − devoluciones en caja (las anuladas quedan compensadas)
  SELECT COALESCE(sum(total), 0) INTO a FROM public.ventas WHERE NOT anulada;
  SELECT COALESCE(sum(x.monto) FILTER (WHERE x.reverso_de IS NULL AND x.tipo = 'ingreso'), 0)
       - COALESCE(sum(x.monto) FILTER (WHERE x.reverso_de IS NOT NULL AND x.tipo = 'egreso'), 0) INTO b
    FROM public.caja_movimientos x LEFT JOIN public.caja_movimientos o ON o.id = x.reverso_de
   WHERE (x.reverso_de IS NULL AND x.venta_id IS NOT NULL) OR o.venta_id IS NOT NULL;
  IF abs(a - b) > 0.01 THEN v := v || jsonb_build_object('invariante', 'ventas_vivas=caja_mostrador', 'ventas', a, 'caja', b); END IF;
  -- (3) órdenes finalizadas de contado (no anuladas) = cobros de taller en caja netos
  SELECT COALESCE(sum((SELECT sum(oi.cantidad * oi.precio) FROM public.orden_items oi WHERE oi.orden_id = o.id)), 0) INTO a
    FROM public.ordenes o WHERE o.finalizada AND o.tipo_cobro = 'contado' AND NOT o.anulada AND o.deleted_at IS NULL;
  SELECT COALESCE(sum(x.monto) FILTER (WHERE x.reverso_de IS NULL), 0) - COALESCE(sum(x.monto) FILTER (WHERE x.reverso_de IS NOT NULL), 0) INTO b
    FROM public.caja_movimientos x LEFT JOIN public.caja_movimientos o ON o.id = x.reverso_de
   WHERE (x.reverso_de IS NULL AND x.orden_id IS NOT NULL AND x.tipo = 'ingreso') OR (o.orden_id IS NOT NULL AND o.tipo = 'ingreso');
  IF abs(round(a, 2) - b) > 0.01 THEN v := v || jsonb_build_object('invariante', 'ordenes_contado=caja_taller', 'ordenes', round(a, 2), 'caja', b); END IF;
  -- (4) el crédito de una orden vale exactamente lo que la orden
  SELECT count(*) INTO n FROM public.creditos k JOIN public.ordenes o ON o.id = k.orden_id
   WHERE NOT k.anulado AND abs(k.total - round((SELECT COALESCE(sum(oi.cantidad * oi.precio), 0) FROM public.orden_items oi WHERE oi.orden_id = o.id), 2)) > 0.01;
  IF n > 0 THEN v := v || jsonb_build_object('invariante', 'credito_de_orden=total_orden', 'creditos', n); END IF;
  -- (5) por cobrar = Σ (total − abonos vigentes) de los créditos vivos
  SELECT COALESCE(sum(k.saldo), 0), COALESCE(sum(k.total - COALESCE((SELECT sum(ab.monto) FROM public.abonos ab WHERE ab.credito_id = k.id AND NOT ab.anulado), 0)), 0)
    INTO a, b FROM public.creditos k WHERE NOT k.anulado;
  IF abs(a - b) > 0.01 THEN v := v || jsonb_build_object('invariante', 'por_cobrar=total-abonos', 'saldos', a, 'calculado', b); END IF;
  -- (6) una orden finalizada tiene su dinero: caja (contado) o crédito vivo (crédito), salvo total 0
  SELECT count(*) INTO n FROM public.ordenes o
   WHERE o.finalizada AND NOT o.anulada AND o.deleted_at IS NULL AND o.local_id IS NULL
     AND (SELECT COALESCE(sum(oi.cantidad * oi.precio), 0) FROM public.orden_items oi WHERE oi.orden_id = o.id) > 0
     AND NOT EXISTS (SELECT 1 FROM public.caja_movimientos x WHERE x.orden_id = o.id AND x.tipo = 'ingreso')
     AND NOT EXISTS (SELECT 1 FROM public.creditos k WHERE k.orden_id = o.id);
  IF n > 0 THEN v := v || jsonb_build_object('invariante', 'orden_finalizada_con_dinero', 'ordenes', n); END IF;
  RETURN v;
END
$function$;

-- ═════════════════════════ 3b. OWNER-PIN: la restauración en la nube es DESTRUCTIVA ═════════════════════════
-- Contrato para una FUTURA restauración en la nube (no existe ninguna RPC que restaure): reemplaza datos del taller, así que exige una
-- autorización del PIN del propietario A TODOS (admin incluido), como las demás destructivas de 15d.
CREATE OR REPLACE FUNCTION public.sync_accion_destructiva(p_accion text)
 RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT p_accion = ANY (ARRAY['reversar_venta', 'reversar_credito', 'reversar_abono', 'reversar_caja', 'anular_orden', 'eliminar_usuario', 'restaurar_respaldo'])
$function$;

-- ═════════════════════════ 4. PANEL TÉCNICO: «ventas de hoy» en el día de Honduras ═════════════════════════
-- EVOLUCION-CANONICA estadisticas_tecnicas(): idéntica a la canónica RCV-34 salvo la línea 'ventas_hoy'.
CREATE OR REPLACE FUNCTION public.estadisticas_tecnicas()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_rol text;
begin
  v_rol := public.rol_actual();
  -- rol_actual() ya filtra por activo = true, así que un usuario dado de baja
  -- recibe null y no pasa de aquí.
  if not (public.es_admin() or public.es_desarrollador()) then
    raise exception 'Solo el administrador y el desarrollador pueden consultar las estadísticas técnicas';
  end if;
  -- SOLO count(*). Ni un nombre, ni un teléfono, ni un importe, ni un UUID.
  return jsonb_build_object(
    'clientes',          (select count(*) from public.clientes),
    'motos',             (select count(*) from public.motos),
    'ordenes',           (select count(*) from public.ordenes),
    'ordenes_abiertas',  (select count(*) from public.ordenes where not finalizada),
    'cotizaciones',      (select count(*) from public.cotizaciones),
    'citas',             (select count(*) from public.citas),
    'inventario',        (select count(*) from public.inventario),
    'ventas',            (select count(*) from public.ventas),
    'ventas_hoy',        (select count(*) from public.ventas where (creado_en at time zone 'America/Tegucigalpa')::date = (now() at time zone 'America/Tegucigalpa')::date),
    'creditos',          (select count(*) from public.creditos),
    'creditos_abiertos', (select count(*) from public.creditos where estado <> 'pagado'),
    'abonos',            (select count(*) from public.abonos),
    'movimientos_caja',  (select count(*) from public.caja_movimientos),
    'auditoria',         (select count(*) from public.auditoria)
  );
end $function$;

-- ═════════════════════════ 5. PERMISOS ═════════════════════════
REVOKE EXECUTE ON FUNCTION public.finanzas_resumen(date,date,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finanzas_resumen(date,date,timestamptz) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.finanzas_invariantes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finanzas_invariantes() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.sync_accion_destructiva(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_accion_destructiva(text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.estadisticas_tecnicas() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estadisticas_tecnicas() TO authenticated, service_role;
-- EVOLUCION-CANONICA ACL: las v1 sin op_id dejan de ser ejecutables por las sesiones de la app
REVOKE EXECUTE ON FUNCTION public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.registrar_abono(uuid,numeric,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_abono(uuid,numeric,text,text) TO service_role;

INSERT INTO public.sync_fases (fase) VALUES ('15e') ON CONFLICT (fase) DO NOTHING;

DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('caja_un_ingreso_por_venta', 'caja_un_ingreso_por_orden',
         'caja_un_movimiento_por_abono', 'caja_una_compensacion', 'creditos_uno_vivo_por_orden');
  IF n <> 5 THEN RAISE EXCEPTION 'SYNC-15E STOP: faltan garantías únicas (%/5)', n; END IF;
  IF has_function_privilege('authenticated', 'public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.registrar_abono(uuid,numeric,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SYNC-15E STOP: las v1 sin op_id siguen abiertas a authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.finanzas_resumen(date,date,timestamptz)', 'EXECUTE') OR has_function_privilege('anon', 'public.estadisticas_tecnicas()', 'EXECUTE') THEN
    RAISE EXCEPTION 'SYNC-15E STOP: anon ejecuta funciones financieras';
  END IF;
  IF position('America/Tegucigalpa' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.estadisticas_tecnicas()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'SYNC-15E STOP: estadisticas_tecnicas sigue en UTC';
  END IF;
  RAISE NOTICE 'SYNC-15E: finanzas (cobrado/por cobrar/utilidad bruta) y garantías de no duplicar dinero listas.';
END
$post$;
COMMIT;
