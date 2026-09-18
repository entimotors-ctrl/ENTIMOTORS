BEGIN TRANSACTION READ ONLY;

-- RCV-34 FASE 4E-B2 · 05-reconciliacion-source-produccion-readonly.sql
-- AUDITORIA DE RECONCILIACION SOURCE <-> PRODUCCION. EXCLUSIVAMENTE LECTURA DE CATALOGOS.
--
-- Que hace: una sola sentencia SELECT sobre pg_catalog que devuelve UNA celda JSON con la
-- metadata de las funciones del schema public (que no son de una extension), sus triggers de
-- usuario, los privilegios por defecto (pg_default_acl) y un espejo de los criterios del guard 04.
-- Que NO hace: no lee ninguna fila de negocio (ni de clientes, motos, citas, ordenes, ventas,
-- caja, perfiles ni de ninguna otra tabla), no imprime cuerpos de funcion (solo md5), no crea
-- objetos, no modifica ACL, no usa extensiones nuevas. La transaccion es READ ONLY y termina en
-- ROLLBACK; el dato "transaccion_solo_lectura" del resultado debe decir "on".
--
-- Donde: Supabase -> SQL Editor del proyecto de PRODUCCION -> pegar completo -> Run.
-- Devolver: el contenido COMPLETO de la unica celda "reconciliacion_produccion" (JSON). Sus
-- bloques son: resumen, funciones_public, funciones_de_extension_en_public, triggers,
-- objetivos_trigger, default_acl.
-- Si el editor mostrara solo el resultado de la ultima sentencia (ROLLBACK) y ningun dato,
-- seleccionar unicamente desde "SELECT jsonb_pretty" hasta su ";" y ejecutar la seleccion:
-- esa sentencia es un SELECT de catalogos y es solo lectura por si misma.

SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, public;

WITH roles_api AS (
  SELECT r.oid, r.rolname
    FROM pg_roles r
   WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
),
base AS (
  SELECT p.oid,
         p.oid::regprocedure::text AS firma,
         p.proname,
         pg_get_function_identity_arguments(p.oid) AS args_identidad,
         pg_get_function_result(p.oid) AS retorno,
         l.lanname AS lenguaje,
         p.prokind::text AS prokind,
         (p.prorettype = 'trigger'::regtype) AS es_trigger,
         pg_get_userbyid(p.proowner) AS owner,
         p.prosecdef AS security_definer,
         p.proconfig AS config,
         (p.proconfig IS NOT NULL
            AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')) AS search_path_fijado,
         p.proacl AS acl_cruda,
         (p.proacl IS NULL) AS acl_por_defecto,
         COALESCE(p.proacl, acldefault('f', p.proowner)) AS acl,
         -- pg_get_functiondef no admite agregadas: solo se calcula para funciones y procedimientos.
         CASE WHEN p.prokind IN ('f', 'p') THEN md5(pg_get_functiondef(p.oid)) END AS md5_definicion,
         md5(p.prosrc) AS md5_cuerpo,
         (SELECT e.extname
            FROM pg_depend d
            JOIN pg_extension e ON e.oid = d.refobjid
           WHERE d.classid = 'pg_proc'::regclass
             AND d.objid = p.oid
             AND d.refclassid = 'pg_extension'::regclass
             AND d.deptype = 'e'
           LIMIT 1) AS extension
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
   WHERE p.pronamespace = 'public'::regnamespace
),
evaluadas AS (
  SELECT b.*,
         (b.extension IS NOT NULL) AS de_extension,
         -- PUBLIC no es un rol consultable con has_function_privilege: se lee del ACL, igual que el 04.
         EXISTS (SELECT 1 FROM unnest(b.acl) i
                  WHERE split_part(i::text, '=', 1) = ''
                    AND position('X' IN split_part(split_part(i::text, '=', 2), '/', 1)) > 0) AS public_execute,
         EXISTS (SELECT 1 FROM unnest(b.acl) i
                  WHERE split_part(i::text, '=', 1) = 'anon'
                    AND position('X' IN split_part(split_part(i::text, '=', 2), '/', 1)) > 0) AS anon_directo,
         (SELECT has_function_privilege(r.oid, b.oid, 'EXECUTE') FROM roles_api r WHERE r.rolname = 'anon') AS anon_efectivo,
         (SELECT has_function_privilege(r.oid, b.oid, 'EXECUTE') FROM roles_api r WHERE r.rolname = 'authenticated') AS authenticated_efectivo,
         (SELECT has_function_privilege(r.oid, b.oid, 'EXECUTE') FROM roles_api r WHERE r.rolname = 'service_role') AS service_role_efectivo,
         (b.security_definer AND NOT b.search_path_fijado) AS falla_search_path
    FROM base b
),
evaluadas2 AS (
  -- misma regla del guard 04: falla si anon (efectivo) o PUBLIC pueden ejecutar.
  SELECT e.*,
         (COALESCE(e.anon_efectivo, false) OR e.public_execute) AS falla_acl
    FROM evaluadas e
),
proyecto AS (
  SELECT * FROM evaluadas2 WHERE NOT de_extension
),
objetivos AS (
  SELECT unnest(ARRAY[
           'mecanico_solo_avance_tecnico',
           'proteger_caja_ligada',
           'proteger_rol_perfil',
           'crear_perfil_al_registrarse',
           'proteger_admin_unico',
           'proteger_borrado_admin']) AS nombre
)
SELECT jsonb_pretty(jsonb_build_object(
  'formato', 'rcv34-reconciliacion/1',
  'generado', now(),

  'transaccion_solo_lectura', current_setting('transaction_read_only'),
  'version_postgresql', version(),
  'current_user', current_user,
  'roles_api_presentes', (
    SELECT COALESCE(jsonb_agg(r.rolname ORDER BY r.rolname), '[]'::jsonb) FROM roles_api r
  ),

  'resumen', jsonb_build_object(
    -- conteos del proyecto: funciones de public que NO pertenecen a una extension.
    'total_funciones', (SELECT count(*) FROM proyecto),
    'normales', (SELECT count(*) FROM proyecto WHERE NOT es_trigger),
    'trigger', (SELECT count(*) FROM proyecto WHERE es_trigger),
    'prokind_distinto_de_funcion', (SELECT count(*) FROM proyecto WHERE prokind <> 'f'),
    'excluidas_por_ser_de_extension', (SELECT count(*) FROM evaluadas2 WHERE de_extension),
    'con_public_execute', (SELECT count(*) FROM proyecto WHERE public_execute),
    'con_anon_execute_efectivo', (SELECT count(*) FROM proyecto WHERE COALESCE(anon_efectivo, false)),
    'con_anon_execute_directo', (SELECT count(*) FROM proyecto WHERE anon_directo),
    'con_authenticated_execute', (SELECT count(*) FROM proyecto WHERE COALESCE(authenticated_efectivo, false)),
    'con_service_role_execute', (SELECT count(*) FROM proyecto WHERE COALESCE(service_role_efectivo, false)),
    'sin_acl_explicita_usan_default', (SELECT count(*) FROM proyecto WHERE acl_por_defecto),
    'security_definer_total', (SELECT count(*) FROM proyecto WHERE security_definer),
    'security_definer_sin_search_path', (SELECT count(*) FROM proyecto WHERE falla_search_path),
    'triggers_de_usuario', (
      SELECT count(*)
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc pr ON pr.oid = t.tgfoid
       WHERE NOT t.tgisinternal
         AND (c.relnamespace = 'public'::regnamespace OR pr.pronamespace = 'public'::regnamespace)),
    'triggers_internos_con_funcion_en_public', (
      SELECT count(*)
        FROM pg_trigger t
        JOIN pg_proc pr ON pr.oid = t.tgfoid
       WHERE t.tgisinternal AND pr.pronamespace = 'public'::regnamespace),
    'default_acl_filas_totales', (SELECT count(*) FROM pg_default_acl),

    -- espejo exacto del guard 04: evalua TODAS las funciones de public, incluidas las de extension.
    'espejo_guard_04', jsonb_build_object(
      'total_funciones', (SELECT count(*) FROM evaluadas2),
      'normales', (SELECT count(*) FROM evaluadas2 WHERE NOT es_trigger),
      'trigger', (SELECT count(*) FROM evaluadas2 WHERE es_trigger),
      'con_fallo_acl', (SELECT count(*) FROM evaluadas2 WHERE falla_acl),
      'con_fallo_search_path', (SELECT count(*) FROM evaluadas2 WHERE falla_search_path),
      'todo_ok', NOT EXISTS (SELECT 1 FROM evaluadas2 WHERE falla_acl OR falla_search_path)
    ),
    'referencia_cierre_rcv34', jsonb_build_object(
      'total_funciones', 17, 'normales', 13, 'trigger', 4,
      'coincide_base_04', (
        (SELECT count(*) FROM evaluadas2) = 17
        AND (SELECT count(*) FROM evaluadas2 WHERE NOT es_trigger) = 13
        AND (SELECT count(*) FROM evaluadas2 WHERE es_trigger) = 4)
    )
  ),

  'funciones_public', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'firma', f.firma,
              'nombre', f.proname,
              'args_identidad', f.args_identidad,
              'retorno', f.retorno,
              'lenguaje', f.lenguaje,
              'prokind', f.prokind,
              'tipo', CASE WHEN f.es_trigger THEN 'trigger' ELSE 'normal' END,
              'owner', f.owner,
              'security_definer', f.security_definer,
              'config', to_jsonb(f.config),
              'search_path_fijado', f.search_path_fijado,
              'proacl_cruda', CASE WHEN f.acl_cruda IS NULL THEN NULL
                                   ELSE (SELECT jsonb_agg(i::text ORDER BY i::text) FROM unnest(f.acl_cruda) i) END,
              'acl_por_defecto', f.acl_por_defecto,
              'acl_efectiva_canonica', (SELECT jsonb_agg(i::text ORDER BY i::text) FROM unnest(f.acl) i),
              'md5_definicion', f.md5_definicion,
              'md5_cuerpo', f.md5_cuerpo,
              'execute', jsonb_build_object(
                'PUBLIC', f.public_execute,
                'anon_efectivo', f.anon_efectivo,
                'anon_directo', f.anon_directo,
                'authenticated', f.authenticated_efectivo,
                'service_role', f.service_role_efectivo),
              'falla_guard_04', (f.falla_acl OR f.falla_search_path))
              ORDER BY f.firma), '[]'::jsonb)
      FROM proyecto f
  ),

  'funciones_de_extension_en_public', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'firma', f.firma,
              'extension', f.extension,
              'PUBLIC', f.public_execute,
              'anon_efectivo', f.anon_efectivo)
              ORDER BY f.firma), '[]'::jsonb)
      FROM evaluadas2 f
     WHERE f.de_extension
  ),

  'triggers', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'schema_tabla', n.nspname,
              'tabla', c.relname,
              'trigger', t.tgname,
              'funcion', t.tgfoid::regprocedure::text,
              'schema_funcion', fn.nspname,
              'timing', CASE (t.tgtype::int & 66)
                          WHEN 2 THEN 'BEFORE' WHEN 64 THEN 'INSTEAD OF' ELSE 'AFTER' END,
              'nivel', CASE WHEN t.tgtype::int & 1 <> 0 THEN 'ROW' ELSE 'STATEMENT' END,
              'eventos', concat_ws(',',
                           CASE WHEN t.tgtype::int & 4  <> 0 THEN 'INSERT' END,
                           CASE WHEN t.tgtype::int & 8  <> 0 THEN 'DELETE' END,
                           CASE WHEN t.tgtype::int & 16 <> 0 THEN 'UPDATE' END,
                           CASE WHEN t.tgtype::int & 32 <> 0 THEN 'TRUNCATE' END),
              'tgenabled', t.tgenabled::text,
              'tgisinternal', t.tgisinternal,
              'definicion', pg_get_triggerdef(t.oid))
              ORDER BY n.nspname, c.relname, t.tgname), '[]'::jsonb)
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc pr ON pr.oid = t.tgfoid
      JOIN pg_namespace fn ON fn.oid = pr.pronamespace
     WHERE NOT t.tgisinternal
       AND (n.nspname = 'public' OR fn.nspname = 'public')
  ),

  'objetivos_trigger', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'nombre', o.nombre,
              'firmas_en_public', (
                SELECT COALESCE(jsonb_agg(f.firma ORDER BY f.firma), '[]'::jsonb)
                  FROM proyecto f WHERE f.proname = o.nombre),
              'triggers_de_usuario_que_la_usan', (
                SELECT count(*)
                  FROM pg_trigger t
                  JOIN pg_proc pr ON pr.oid = t.tgfoid
                 WHERE NOT t.tgisinternal
                   AND pr.pronamespace = 'public'::regnamespace
                   AND pr.proname = o.nombre))
              ORDER BY o.nombre), '[]'::jsonb)
      FROM objetivos o
  ),

  -- pg_default_acl completo (todos los roles y alcances), sin filtrar por rol propietario.
  'default_acl', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'rol_propietario', pg_get_userbyid(d.defaclrole),
              'alcance', CASE WHEN d.defaclnamespace = 0 THEN 'global'
                              ELSE 'schema_' || dn.nspname END,
              'tipo_objeto', CASE d.defaclobjtype
                               WHEN 'r' THEN 'tablas' WHEN 'S' THEN 'secuencias'
                               WHEN 'f' THEN 'funciones' WHEN 'T' THEN 'tipos'
                               WHEN 'n' THEN 'schemas' ELSE d.defaclobjtype::text END,
              'acl', (SELECT jsonb_agg(i::text ORDER BY i::text) FROM unnest(d.defaclacl) i),
              'grantees_con_execute', CASE WHEN d.defaclobjtype = 'f' THEN (
                  SELECT COALESCE(jsonb_agg(CASE WHEN split_part(i::text, '=', 1) = '' THEN 'PUBLIC'
                                                 ELSE split_part(i::text, '=', 1) END
                                            ORDER BY split_part(i::text, '=', 1)), '[]'::jsonb)
                    FROM unnest(d.defaclacl) i
                   WHERE position('X' IN split_part(split_part(i::text, '=', 2), '/', 1)) > 0)
                END)
              ORDER BY pg_get_userbyid(d.defaclrole),
                       CASE WHEN d.defaclnamespace = 0 THEN '' ELSE dn.nspname END,
                       d.defaclobjtype::text), '[]'::jsonb)
      FROM pg_default_acl d
      LEFT JOIN pg_namespace dn ON dn.oid = d.defaclnamespace
  )
)) AS reconciliacion_produccion;

ROLLBACK;
