-- 3.15.0 · Bloque 7 · sync-15g: las políticas de lectura evalúan su función UNA vez por consulta (InitPlan), no por fila.
-- Con 00-prelude.sql y 15g-visibilidad.sql ya corrido (datos sembrados). La igualdad de visibilidad la compara correr-sql.sh.
CREATE FUNCTION pg_temp.plan(n int, q text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE l text; p text := '';
BEGIN
  PERFORM pg_temp.como(n);
  FOR l IN EXECUTE 'EXPLAIN (COSTS OFF) ' || q LOOP p := p || l || E'\n'; END LOOP;
  PERFORM pg_temp.fin();
  RETURN p;
END $$;
SELECT pg_temp.t('R01 caja (admin): la función de la política va en un InitPlan, ya no como filtro por fila',
  pg_temp.plan(1, 'SELECT * FROM public.caja_movimientos') ~ 'InitPlan' AND pg_temp.plan(1, 'SELECT * FROM public.caja_movimientos') !~ 'Filter: puede_cobrar\(\)');
SELECT pg_temp.t('R02 órdenes (cajero): InitPlan de ve_todo_el_taller', pg_temp.plan(2, 'SELECT * FROM public.ordenes') ~ 'InitPlan' AND pg_temp.plan(2, 'SELECT * FROM public.ordenes') !~ 'Filter: ve_todo_el_taller\(\)');
SELECT pg_temp.t('R03 mensajes (mecánico): uid() y es_mecanico_activo() en InitPlan; la comparación con destinatario_id sigue por fila',
  pg_temp.plan(3, 'SELECT * FROM public.mensajes') ~ 'InitPlan' AND pg_temp.plan(3, 'SELECT * FROM public.mensajes') ~ 'destinatario_id');
SELECT pg_temp.t('R04 las políticas de ESCRITURA no cambian (ordenes_edita sigue igual)',
  (SELECT qual FROM pg_policies WHERE tablename = 'ordenes' AND policyname = 'ordenes_edita') = 've_todo_el_taller()');
SELECT pg_temp.t('R05 perfiles no se toca', (SELECT count(*) FROM pg_policies WHERE tablename = 'perfiles' AND qual ~ 'SELECT') = 0);
SELECT pg_temp.t('R06 fase registrada', EXISTS (SELECT 1 FROM public.sync_fases WHERE fase = '15g'));
-- el mecánico sigue sin ver caja ni clientes, y el inactivo no ve sus mensajes (visibilidad concreta, además de la huella)
BEGIN;
SELECT pg_temp.como(3);
SELECT pg_temp.t('R07 mecánico: 0 filas de caja y de clientes; ve SOLO su mensaje', (SELECT count(*) FROM public.caja_movimientos) = 0 AND (SELECT count(*) FROM public.clientes) = 0
  AND (SELECT count(*) FROM public.mensajes) = 1);
SELECT pg_temp.fin();
COMMIT;
BEGIN;
SELECT pg_temp.como(6);
SELECT pg_temp.t('R08 mecánico INACTIVO: no ve ni su mensaje', (SELECT count(*) FROM public.mensajes) = 0);
SELECT pg_temp.fin();
COMMIT;
-- anon: lo cubre la huella de visibilidad (sin permiso de lectura, igual antes y después)
