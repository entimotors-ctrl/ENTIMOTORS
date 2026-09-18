BEGIN TRANSACTION READ ONLY;

-- RCV-35 - 03-verificacion-post-fix-readonly.sql - PREPARADO / NO EJECUTADO
-- VERIFICACION DE public.rol_actual(), EXCLUSIVAMENTE LECTURA DE CATALOGOS.
--
-- Que hace: una sola sentencia SELECT sobre pg_catalog que devuelve UNA fila con la metadata de
-- public.rol_actual() y la comprobacion de que public.perfiles.activo existe y es boolean. Sirve para
-- (a) capturar el estado real ANTES de aplicar 01 y (b) capturar el estado real DESPUES de aplicarlo.
-- Que NO hace: no lee ninguna fila de public.perfiles ni de ninguna otra tabla, no crea objetos, no
-- modifica nada. La transaccion es READ ONLY y termina en ROLLBACK; "transaccion_solo_lectura" debe
-- decir "on".
--
-- Donde: Supabase -> SQL Editor del proyecto de produccion -> pegar completo -> Run.
-- Devolver: la fila completa (copiar el resultado o exportarlo a CSV). definicion_b64 y prosrc_b64 van en
-- base64 sin saltos de linea: transportan los bytes exactos (incluidos CR) sin depender de como el editor
-- muestre los saltos de linea. Si el editor mostrara solo el resultado de la ultima sentencia (ROLLBACK) y
-- ningun dato, seleccionar unicamente desde "WITH f AS" hasta su ";" y ejecutar la seleccion: esa
-- sentencia es un SELECT de catalogos y es solo lectura por si misma.

SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, public;

WITH f AS (
  SELECT p.oid, p.proowner, p.prosrc, p.proconfig, p.proacl, p.prosecdef, p.provolatile,
         l.lanname::text AS lenguaje
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = to_regprocedure('public.rol_actual()')
),
col AS (
  SELECT (a.atttypid = 'boolean'::regtype) AS es_boolean
    FROM pg_attribute a
   WHERE a.attrelid = to_regclass('public.perfiles')
     AND a.attname = 'activo' AND a.attnum > 0 AND NOT a.attisdropped
),
calc AS (
  SELECT f.*,
         regexp_replace(lower(f.prosrc), '\s+', '', 'g') AS cuerpo_norm,
         EXISTS (SELECT 1 FROM aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
    FROM f
)
SELECT current_setting('transaction_read_only') AS transaccion_solo_lectura,
       (SELECT count(*) FROM pg_proc x
         WHERE x.pronamespace = 'public'::regnamespace AND x.proname = 'rol_actual') AS cantidad_rol_actual_en_public,
       c.oid::regprocedure::text AS firma,
       md5(c.prosrc) AS md5_prosrc,
       octet_length(c.prosrc) AS octet_length_prosrc,
       length(c.prosrc) - length(replace(c.prosrc, chr(13), '')) AS cantidad_cr,
       length(c.prosrc) - length(replace(c.prosrc, chr(10), '')) AS cantidad_lf,
       replace(encode(convert_to(pg_get_functiondef(c.oid), 'UTF8'), 'base64'), chr(10), '') AS definicion_b64,
       replace(encode(convert_to(c.prosrc, 'UTF8'), 'base64'), chr(10), '') AS prosrc_b64,
       pg_get_userbyid(c.proowner) AS owner,
       pg_get_function_result(c.oid) AS retorno,
       c.lenguaje AS lenguaje,
       CASE c.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' WHEN 'v' THEN 'VOLATILE' END AS volatilidad,
       c.prosecdef AS security_definer,
       to_jsonb(c.proconfig) AS proconfig,
       c.proacl::text AS proacl_cruda,
       (SELECT jsonb_agg(i::text ORDER BY i::text)
          FROM unnest(COALESCE(c.proacl, acldefault('f', c.proowner))) i) AS acl_efectiva,
       c.public_execute AS public_execute,
       has_function_privilege('anon', c.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', c.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role', c.oid, 'EXECUTE') AS service_role_execute,
       position('andp.activo' in c.cuerpo_norm) > 0 AS contiene_filtro_activo,
       (c.cuerpo_norm = $esp$selectcoalesce((selectp.rolfrompublic.perfilespwherep.id=auth.uid()andp.activolimit1),'');$esp$) AS cuerpo_es_la_logica_esperada,
       (col.es_boolean IS NOT NULL) AS perfiles_activo_existe,
       COALESCE(col.es_boolean, false) AS perfiles_activo_es_boolean,
       (    pg_get_userbyid(c.proowner) = 'postgres'
        AND c.prosecdef
        AND c.proconfig = ARRAY['search_path=public']::text[]
        AND c.lenguaje = 'sql'
        AND c.provolatile = 's'
        AND NOT c.public_execute
        AND NOT has_function_privilege('anon', c.oid, 'EXECUTE')
        AND has_function_privilege('authenticated', c.oid, 'EXECUTE')
        AND has_function_privilege('service_role', c.oid, 'EXECUTE')
        AND c.cuerpo_norm = $esp$selectcoalesce((selectp.rolfrompublic.perfilespwherep.id=auth.uid()andp.activolimit1),'');$esp$
        AND COALESCE(col.es_boolean, false)) AS cumple_estado_post_fix
  FROM (SELECT 1) AS uno
  LEFT JOIN calc c ON true
  LEFT JOIN col ON true;

ROLLBACK;
