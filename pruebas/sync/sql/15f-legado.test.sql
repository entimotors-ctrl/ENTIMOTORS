-- 3.15.0 · Bloque 6 · estado de migración 3.13 en el servidor (sync-15f). Con 00-prelude.sql y la cadena hasta 15f.
-- Usuarios: 1 admin · 2 cajero · 3 mecánico. Ids 6xxx. Todo de solo lectura: las funciones no escriben nada.
\set ON_ERROR_STOP 0
CREATE FUNCTION pg_temp.ser(n int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', CASE WHEN n = 0 THEN '' ELSE pg_temp.uid(n)::text END, false);
  PERFORM set_config('request.jwt.claims', CASE WHEN n = 0 THEN '{"role":"anon"}' ELSE json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text END, false);
  PERFORM set_config('role', CASE WHEN n = 0 THEN 'anon' ELSE 'authenticated' END, false);
END $$;
CREATE FUNCTION pg_temp.nadie() RETURNS void LANGUAGE plpgsql AS $$
BEGIN RESET ROLE; PERFORM set_config('request.jwt.claim.sub', '', false); PERFORM set_config('request.jwt.claims', '', false); END $$;
INSERT INTO public.clientes (id, nombre, telefono) VALUES (pg_temp.id(6001), 'Migrado 1', '1'), (pg_temp.id(6002), 'Migrado 2', '2');
INSERT INTO public.categorias_inv (id, nombre) VALUES (pg_temp.id(6003), 'Cat migrada');

SELECT pg_temp.ser(1);
SELECT pg_temp.t('L05a sin lotes: el negocio NO figura como migrado', (public.migracion_313_estado())->>'migrado' = 'false');
SELECT pg_temp.nadie();
INSERT INTO public.import_lotes (legacy_device_id, backup_sha256, estado, creado_por, aplicado_en) VALUES ('tel', repeat('a', 64), 'aplicado', pg_temp.uid(1), now());
SELECT pg_temp.ser(1);
SELECT pg_temp.t('L05b lote APLICADO sin confirmar: todavía no es «migrado» y se informa sin confirmar',
  (public.migracion_313_estado())->>'migrado' = 'false' AND ((public.migracion_313_estado())->>'sin_confirmar')::int = 1);
SELECT pg_temp.nadie();
UPDATE public.import_lotes SET estado = 'confirmado', confirmado_en = now(), conteos_insertados = '{"clientes":2}' WHERE legacy_device_id = 'tel';
SELECT pg_temp.ser(2);
SELECT pg_temp.t('L05c lote CONFIRMADO: el negocio figura migrado (lo ve también la caja); sin datos personales en la respuesta',
  (public.migracion_313_estado())->>'migrado' = 'true' AND (public.migracion_313_estado())->>'ultimo_respaldo' = repeat('a', 12)
  AND (public.migracion_313_estado())::text NOT LIKE '%Migrado 1%');
SELECT pg_temp.nadie();

SELECT pg_temp.ser(1);
SELECT pg_temp.t('L06a presentes: de 3 uuid de clientes, solo los 2 que existen; la categoría migrada también',
  (SELECT count(*) FROM jsonb_array_elements_text(public.migracion_313_presentes(jsonb_build_object('clientes', jsonb_build_array(pg_temp.id(6001), pg_temp.id(6002), pg_temp.id(6099)), 'categorias_inv', jsonb_build_array(pg_temp.id(6003))))->'clientes')) = 2
  AND jsonb_array_length(public.migracion_313_presentes(jsonb_build_object('categorias_inv', jsonb_build_array(pg_temp.id(6003))))->'categorias_inv') = 1);
SELECT pg_temp.t('L06b el uuid que NO está (el «119») no aparece como presente',
  NOT (public.migracion_313_presentes(jsonb_build_object('clientes', jsonb_build_array(pg_temp.id(6099))))->'clientes') ? pg_temp.id(6099)::text);
SELECT pg_temp.falla('tabla fuera del legado → rechazada (no sirve para sondear otras tablas)', $$SELECT public.migracion_313_presentes('{"perfiles": []}'::jsonb)$$, 'no permitida');
SELECT pg_temp.falla('uuid inválido → error', $$SELECT public.migracion_313_presentes('{"clientes": ["x"]}'::jsonb)$$, 'uuid');
SELECT pg_temp.falla('más de 30000 identificadores → rechazado', $$SELECT public.migracion_313_presentes(jsonb_build_object('clientes', (SELECT jsonb_agg(gen_random_uuid()) FROM generate_series(1, 30001))))$$, 'Demasiados');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(3);
SELECT pg_temp.falla('el mecánico no consulta el estado de migración', $$SELECT public.migracion_313_estado()$$, 'administrador o caja');
SELECT pg_temp.falla('el mecánico no consulta presentes', $$SELECT public.migracion_313_presentes('{}'::jsonb)$$, 'administrador o caja');
SELECT pg_temp.nadie();
SELECT pg_temp.ser(0);
SELECT pg_temp.falla('anon no ejecuta', $$SELECT public.migracion_313_estado()$$, 'permission denied');
SELECT pg_temp.nadie();
SELECT pg_temp.t('solo lectura: ninguna de las dos funciones es VOLATILE', (SELECT bool_and(provolatile = 's') FROM pg_proc WHERE proname IN ('migracion_313_estado', 'migracion_313_presentes')));
