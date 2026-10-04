-- ENTIMOTORS OS 3.15.0 · BLOQUE 7 · RENDIMIENTO DE LAS POLÍTICAS DE LECTURA (RLS) · NO EJECUTADO EN PRODUCCIÓN
-- NO EJECUTAR EN PRODUCCIÓN SIN AUTORIZACIÓN EXPLÍCITA. Requiere la cadena SYNC 1..10 + 15a..15f. Idempotente. Sin datos ni tablas nuevas.
--
-- Qué se midió (laboratorio, 100 000 movimientos de caja): una página de 500 filas de la descarga incremental tardaba ~75 ms y recorrer la
-- caja de un mes como usuario autenticado ~13,5 s. Causa: las políticas de lectura llaman a funciones como ve_todo_el_taller() o
-- puede_cobrar() — STABLE SECURITY DEFINER con SET search_path, que Postgres NO puede incrustar — UNA VEZ POR FILA.
-- Qué cambia: la MISMA expresión, envuelta en (SELECT …): Postgres la evalúa UNA vez por consulta (InitPlan). Es la recomendación de
-- Supabase para RLS y no cambia QUIÉN ve QUÉ: las funciones no reciben nada de la fila y son STABLE (mismo resultado durante toda la
-- sentencia); lo único por fila que queda es la comparación con la columna (destinatario_id = …).
-- (Las expresiones «antes/después» son como las escribe Postgres con el search_path de esta migración: pg_catalog, public.)
-- Seguridad: solo se tocan políticas de LECTURA cuya expresión actual es EXACTAMENTE la esperada; si alguna difiere (otra versión, un
-- cambio a mano), se DETIENE sin tocar nada. Las políticas de escritura, de perfiles y de Storage no se tocan.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sync_fases WHERE fase = '15f') THEN RAISE EXCEPTION 'SYNC-15G STOP: falta sync-15f'; END IF;
END
$pre$;

CREATE TEMP TABLE b7_politicas (tabla text, politica text, antes text, despues text, nueva text) ON COMMIT DROP;
INSERT INTO b7_politicas VALUES
  ('abonos',           'abonos_lee',           've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('auditoria',        'auditoria_admin_lee',  'es_admin()',          '( SELECT es_admin() AS es_admin)',                   '(SELECT public.es_admin())'),
  ('caja_movimientos', 'caja_lee',             'puede_cobrar()',      '( SELECT puede_cobrar() AS puede_cobrar)',           '(SELECT public.puede_cobrar())'),
  ('categorias_inv',   'categorias_lee',       've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('citas',            'citas_lee',            've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('clientes',         'clientes_lee',         've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('cotizacion_items', 'cotizacion_items_lee', 've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('cotizaciones',     'cotizaciones_lee',     've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('credito_items',    'credito_items_lee',    've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('creditos',         'creditos_lee',         've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('inventario',       'inventario_lee',       've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('mensajes',         'mensajes_lee',
     '(((destinatario_id = auth.uid()) AND es_mecanico_activo()) OR es_admin())',
     '(((destinatario_id = ( SELECT auth.uid() AS uid)) AND ( SELECT es_mecanico_activo() AS es_mecanico_activo)) OR ( SELECT es_admin() AS es_admin))',
     '((destinatario_id = (SELECT auth.uid()) AND (SELECT public.es_mecanico_activo())) OR (SELECT public.es_admin()))'),
  ('motos',            'motos_lee',            've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('orden_items',      'orden_items_lee',      've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('ordenes',          'ordenes_lee',          've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('venta_items',      'venta_items_lee',      've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('ventas',           'ventas_lee',           've_todo_el_taller()', '( SELECT ve_todo_el_taller() AS ve_todo_el_taller)', '(SELECT public.ve_todo_el_taller())'),
  ('web_cms',          'cms_lee',              'es_equipo()',         '( SELECT es_equipo() AS es_equipo)',                 '(SELECT public.es_equipo())');

DO $cambio$
DECLARE p record; actual text; hechas int := 0; ya int := 0;
BEGIN
  FOR p IN SELECT * FROM b7_politicas LOOP
    SELECT qual INTO actual FROM pg_policies WHERE schemaname = 'public' AND tablename = p.tabla AND policyname = p.politica AND cmd = 'SELECT';
    IF actual IS NULL THEN RAISE EXCEPTION 'SYNC-15G STOP: no existe la política de lectura %.%', p.tabla, p.politica; END IF;
    IF actual = p.despues THEN ya := ya + 1; CONTINUE; END IF;
    IF actual <> p.antes THEN RAISE EXCEPTION 'SYNC-15G STOP: %.% tiene «%» (se esperaba «%»): revisar a mano, no se cambió nada', p.tabla, p.politica, actual, p.antes; END IF;
    EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)', p.politica, p.tabla, p.nueva);
    hechas := hechas + 1;
  END LOOP;
  -- verificación: todas quedaron en la forma nueva
  IF EXISTS (SELECT 1 FROM b7_politicas b JOIN pg_policies q ON q.schemaname = 'public' AND q.tablename = b.tabla AND q.policyname = b.politica WHERE q.qual <> b.despues) THEN
    RAISE EXCEPTION 'SYNC-15G STOP: alguna política no quedó en la forma esperada';
  END IF;
  RAISE NOTICE 'SYNC-15G: % política(s) de lectura optimizadas (% ya lo estaban).', hechas, ya;
END
$cambio$;

INSERT INTO public.sync_fases (fase) VALUES ('15g') ON CONFLICT (fase) DO NOTHING;
COMMIT;
