-- =====================================================================
-- ENTIMOTORS OS 3.14.0 - SYNC-0 - CATALOGO DE ESQUEMA (SOLO LECTURA)
-- ---------------------------------------------------------------------
-- QUE ES
--   Una sola consulta que devuelve el esquema REAL de esta base:
--   tablas, columnas, restricciones, indices, RLS, politicas, triggers,
--   funciones, publicaciones de Realtime y configuracion de buckets.
--
-- QUE NO HACE
--   No modifica nada. No lee filas de negocio: solo consulta el catalogo del
--   sistema (pg_catalog) y la configuracion de los buckets. No toca
--   auth.users ni los archivos guardados en Storage. No devuelve claves,
--   contrasenas ni tokens. Los conteos de filas son ESTIMACIONES de las
--   estadisticas del motor (no se recorre ninguna tabla).
--
-- COMO SE USA
--   Supabase > SQL Editor > New query > pegar TODO este archivo > Run.
--
-- RESULTADO
--   Una tabla con tres columnas: seccion, objeto, detalle (JSON).
--   Unas 150-250 filas. La ultima fila (99_resumen) dice cuantas filas trae
--   cada seccion, para comprobar que se exporto completa.
--   Exportar todo el resultado (descargar CSV, o copiar todas las filas) y
--   entregarlo.
--
-- SI FALLA
--   Si el error menciona storage.buckets, borrar el bloque marcado
--   "INICIO 20" .. "FIN 20" (incluida su linea de union) y volver a ejecutar.
-- =====================================================================

WITH todo (seccion, objeto, detalle) AS (

  -- 01 servidor y sesion de consulta
  SELECT '01_meta'::text, 'servidor'::text,
         jsonb_build_object(
           'version', version(),
           'server_version_num', current_setting('server_version_num'),
           'base', current_database(),
           'rol_de_consulta', current_user::text,
           'zona_horaria', current_setting('TimeZone'),
           'generado_en', now(),
           'transaccion_solo_lectura', current_setting('transaction_read_only'))

  -- 02 extensiones instaladas
  UNION ALL
  SELECT '02_extensiones'::text, e.extname::text,
         jsonb_build_object('version', e.extversion, 'esquema', n.nspname::text)
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace

  -- 03 roles (sin contrasenas: pg_roles no las expone)
  UNION ALL
  SELECT '03_roles'::text, r.rolname::text,
         jsonb_build_object(
           'superusuario', r.rolsuper,
           'omite_rls', r.rolbypassrls,
           'puede_entrar', r.rolcanlogin,
           'hereda', r.rolinherit)
  FROM pg_roles r
  WHERE r.rolname !~ '^pg_'

  -- 04 esquemas no del sistema
  UNION ALL
  SELECT '04_esquemas'::text, n.nspname::text,
         jsonb_build_object(
           'propietario', pg_get_userbyid(n.nspowner)::text,
           'tablas', (SELECT count(*) FROM pg_class c
                       WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p')),
           'funciones', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = n.oid))
  FROM pg_namespace n
  WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'

  -- 05 tablas y vistas de public: RLS, propietario, estimacion de filas
  UNION ALL
  SELECT '05_tablas'::text, c.relname::text,
         jsonb_build_object(
           'tipo', c.relkind::text,
           'propietario', pg_get_userbyid(c.relowner)::text,
           'rls_activo', c.relrowsecurity,
           'rls_forzado', c.relforcerowsecurity,
           'opciones', c.reloptions,
           'filas_estimadas_reltuples', c.reltuples::bigint,
           'n_live_tup', s.n_live_tup,
           'n_tup_ins', s.n_tup_ins,
           'n_tup_upd', s.n_tup_upd,
           'n_tup_del', s.n_tup_del,
           'ultimo_analyze', GREATEST(s.last_analyze, s.last_autoanalyze),
           'tamano_bytes', pg_total_relation_size(c.oid),
           'comentario', obj_description(c.oid, 'pg_class'))
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')

  -- 06 columnas (una fila por tabla)
  UNION ALL
  SELECT '06_columnas'::text, c.relname::text,
         jsonb_agg(jsonb_build_object(
           'n', a.attnum,
           'columna', a.attname::text,
           'tipo', format_type(a.atttypid, a.atttypmod),
           'not_null', a.attnotnull,
           'default', pg_get_expr(d.adbin, d.adrelid),
           'identidad', NULLIF(btrim(a.attidentity::text), ''),
           'generada', NULLIF(btrim(a.attgenerated::text), ''),
           'comentario', col_description(c.oid, a.attnum)) ORDER BY a.attnum)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
  GROUP BY c.relname

  -- 07 restricciones: PK, FK, UNIQUE, CHECK (una fila por tabla)
  UNION ALL
  SELECT '07_restricciones'::text, c.relname::text,
         jsonb_agg(jsonb_build_object(
           'nombre', k.conname::text,
           'tipo', CASE k.contype
                     WHEN 'p' THEN 'PRIMARY KEY'
                     WHEN 'f' THEN 'FOREIGN KEY'
                     WHEN 'u' THEN 'UNIQUE'
                     WHEN 'c' THEN 'CHECK'
                     WHEN 'x' THEN 'EXCLUDE'
                     ELSE k.contype::text END,
           'definicion', pg_get_constraintdef(k.oid, true),
           'validada', k.convalidated,
           'diferible', k.condeferrable,
           'referencia', CASE WHEN k.confrelid <> 0 THEN k.confrelid::regclass::text END,
           'al_borrar', CASE WHEN k.contype = 'f' THEN k.confdeltype::text END,
           'al_actualizar', CASE WHEN k.contype = 'f' THEN k.confupdtype::text END)
           ORDER BY k.contype, k.conname)
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
  GROUP BY c.relname

  -- 08 indices (una fila por tabla)
  UNION ALL
  SELECT '08_indices'::text, tc.relname::text,
         jsonb_agg(jsonb_build_object(
           'nombre', ic.relname::text,
           'definicion', pg_get_indexdef(x.indexrelid),
           'unico', x.indisunique,
           'primario', x.indisprimary,
           'valido', x.indisvalid,
           'parcial', x.indpred IS NOT NULL) ORDER BY ic.relname)
  FROM pg_index x
  JOIN pg_class ic ON ic.oid = x.indexrelid
  JOIN pg_class tc ON tc.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = tc.relnamespace
  WHERE n.nspname = 'public'
  GROUP BY tc.relname

  -- 09 politicas RLS completas de public, storage y realtime (una fila por tabla)
  UNION ALL
  SELECT '09_politicas'::text, (p.schemaname || '.' || p.tablename)::text,
         jsonb_agg(jsonb_build_object(
           'nombre', p.policyname::text,
           'permisiva', p.permissive,
           'roles', p.roles,
           'comando', p.cmd,
           'usa', p.qual,
           'con_check', p.with_check) ORDER BY p.policyname)
  FROM pg_policies p
  WHERE p.schemaname IN ('public', 'storage', 'realtime')
  GROUP BY p.schemaname, p.tablename

  -- 10 triggers no internos: public, auth.users, storage.objects y storage.buckets
  UNION ALL
  SELECT '10_triggers'::text, (ns.nspname || '.' || c.relname)::text,
         jsonb_agg(jsonb_build_object(
           'nombre', t.tgname::text,
           'habilitado', t.tgenabled::text,
           'funcion', t.tgfoid::regproc::text,
           'definicion', pg_get_triggerdef(t.oid, true)) ORDER BY t.tgname)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE NOT t.tgisinternal
    AND (ns.nspname = 'public'
         OR (ns.nspname = 'auth' AND c.relname = 'users')
         OR (ns.nspname = 'storage' AND c.relname IN ('objects', 'buckets')))
  GROUP BY ns.nspname, c.relname

  -- 11 funciones de public (sin las de extensiones). El cuerpo solo se incluye
  --    si la funcion NO es una de las 17 ya conocidas por RCV-34; de las
  --    conocidas basta el md5 para compararlo con las huellas fijadas.
  UNION ALL
  SELECT '11_funciones'::text, p.oid::regprocedure::text,
         jsonb_build_object(
           'esquema', n.nspname::text,
           'nombre', p.proname::text,
           'tipo', p.prokind::text,
           'retorna', pg_get_function_result(p.oid),
           'lenguaje', l.lanname::text,
           'security_definer', p.prosecdef,
           'volatilidad', p.provolatile::text,
           'config', p.proconfig,
           'propietario', pg_get_userbyid(p.proowner)::text,
           'md5_cuerpo', md5(p.prosrc),
           'bytes_cuerpo', octet_length(p.prosrc),
           'acl', p.proacl::text,
           'public_ejecuta_efectivo', EXISTS (
              SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
           'por_rol', (SELECT jsonb_object_agg(r.rolname::text,
                              has_function_privilege(r.oid, p.oid, 'EXECUTE'))
                         FROM pg_roles r
                        WHERE r.rolname IN ('anon', 'authenticated', 'service_role')),
           'cuerpo_si_no_conocida', CASE WHEN p.proname IN (
              'rol_actual', 'es_admin', 'puede_cobrar', 'es_equipo', 'es_desarrollador',
              'es_mecanico_activo', 've_todo_el_taller', 'mi_cliente', 'mi_moto',
              'crear_perfil_al_registrarse', 'proteger_caja_ligada', 'proteger_rol_perfil',
              'mecanico_solo_avance_tecnico', 'registrar_venta', 'registrar_abono',
              'estadisticas_tecnicas', 'estado_tecnico')
              THEN NULL ELSE p.prosrc END)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                     WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')

  -- 12 vistas (normales y materializadas) de public
  UNION ALL
  SELECT '12_vistas'::text, v.viewname::text,
         jsonb_build_object('materializada', false,
                            'propietario', v.viewowner::text,
                            'definicion', v.definition)
  FROM pg_views v
  WHERE v.schemaname = 'public'
  UNION ALL
  SELECT '12_vistas'::text, m.matviewname::text,
         jsonb_build_object('materializada', true,
                            'propietario', m.matviewowner::text,
                            'definicion', m.definition)
  FROM pg_matviews m
  WHERE m.schemaname = 'public'

  -- 13 privilegios de tabla tal como los guarda el motor (relacl).
  --    Letras: r=lectura a=alta w=cambio d=borrado D=vaciado x=referencia t=trigger.
  --    relacl vacio = solo el propietario.
  UNION ALL
  SELECT '13_privilegios_tablas'::text, c.relname::text,
         jsonb_build_object(
           'propietario', pg_get_userbyid(c.relowner)::text,
           'acl', c.relacl::text)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')

  -- 14 privilegios por defecto para objetos futuros
  UNION ALL
  SELECT '14_privilegios_por_defecto'::text,
         (d.defaclrole::regrole::text || ' | esquema ' || d.defaclnamespace::regnamespace::text
            || ' | tipo ' || d.defaclobjtype::text)::text,
         jsonb_build_object('acl', d.defaclacl::text)
  FROM pg_default_acl d

  -- 15 event triggers
  UNION ALL
  SELECT '15_event_triggers'::text, e.evtname::text,
         jsonb_build_object(
           'evento', e.evtevent::text,
           'funcion', e.evtfoid::regproc::text,
           'habilitado', e.evtenabled::text,
           'etiquetas', e.evttags)
  FROM pg_event_trigger e

  -- 16 publicaciones (Realtime usa supabase_realtime)
  UNION ALL
  SELECT '16_publicaciones'::text, p.pubname::text, to_jsonb(p) - 'pubowner'
  FROM pg_publication p

  -- 17 tablas incluidas en cada publicacion
  UNION ALL
  SELECT '17_publicaciones_tablas'::text,
         (pt.pubname || ' | ' || pt.schemaname || '.' || pt.tablename)::text,
         to_jsonb(pt)
  FROM pg_publication_tables pt

  -- 18 existencia de objetos concretos que necesita el plan de 3.14.0
  UNION ALL
  SELECT '18_verificaciones'::text, k.nombre::text, jsonb_build_object('existe', k.existe)
  FROM (
    SELECT 'tabla ' || t.nombre AS nombre, to_regclass('public.' || t.nombre) IS NOT NULL AS existe
      FROM unnest(ARRAY[
        'perfiles', 'categorias_inv', 'clientes', 'motos', 'inventario', 'ordenes',
        'orden_items', 'cotizaciones', 'cotizacion_items', 'citas', 'ventas', 'venta_items',
        'creditos', 'credito_items', 'abonos', 'caja_movimientos', 'web_cms', 'auditoria',
        'products', 'projects', 'project_images', 'videos', 'rifa', 'talleres']) AS t(nombre)
    UNION ALL
    SELECT 'columna ' || v.tabla || '.' || v.columna,
           EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = to_regclass('public.' || v.tabla)
                      AND a.attname = v.columna AND a.attnum > 0 AND NOT a.attisdropped)
      FROM (VALUES
        ('ordenes', 'origen_trabajo'), ('citas', 'aviso_cliente_wa'),
        ('citas', 'mecanico_id'), ('ordenes', 'mecanico_id'),
        ('ordenes', 'tipo_cobro'), ('ordenes', 'km_salida'),
        ('perfiles', 'taller_id')) AS v(tabla, columna)
    UNION ALL
    SELECT 'alguna columna taller_id o tenant_id en public',
           EXISTS (SELECT 1 FROM information_schema.columns c2
                    WHERE c2.table_schema = 'public'
                      AND c2.column_name IN ('taller_id', 'tenant_id'))
    UNION ALL
    SELECT 'funcion public.' || f.nombre,
           EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f.nombre)
      FROM unnest(ARRAY[
        'proteger_admin_unico', 'proteger_borrado_admin', 'registrar_venta',
        'registrar_abono', 'mi_taller']) AS f(nombre)
    UNION ALL
    SELECT 'trigger ' || g.nombre,
           EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = g.nombre AND NOT t.tgisinternal)
      FROM unnest(ARRAY[
        'perfiles_admin_unico', 'perfiles_borrado_admin', 'al_crear_usuario',
        'no_borrar_caja_ligada', 'citas_mecanico_avance', 'ordenes_mecanico_avance',
        'proteger_rol_perfil_trigger']) AS g(nombre)
    UNION ALL
    SELECT 'bucket-metadata legible (storage.buckets)', to_regclass('storage.buckets') IS NOT NULL
  ) k

  -- 19 tablas con UNIQUE exacto sobre (dispositivo, local_id): la llave de importacion
  UNION ALL
  SELECT '19_unique_dispositivo_local_id'::text, c.relname::text,
         jsonb_build_object(
           'tiene_dispositivo', EXISTS (SELECT 1 FROM pg_attribute a
                                         WHERE a.attrelid = c.oid AND a.attname = 'dispositivo'
                                           AND a.attnum > 0 AND NOT a.attisdropped),
           'tiene_local_id', EXISTS (SELECT 1 FROM pg_attribute a
                                      WHERE a.attrelid = c.oid AND a.attname = 'local_id'
                                        AND a.attnum > 0 AND NOT a.attisdropped),
           'unique_exacto', EXISTS (
              SELECT 1 FROM pg_index x
               WHERE x.indrelid = c.oid AND x.indisunique AND x.indisvalid
                 AND x.indpred IS NULL AND x.indnkeyatts = 2
                 AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                        FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attnum = ANY (x.indkey::int2[]))
                     = ARRAY['dispositivo', 'local_id']::text[]))
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')

  -- INICIO 20 (bloque opcional: configuracion de buckets, NO los archivos)
  UNION ALL
  SELECT '20_storage_buckets'::text, b.id::text, to_jsonb(b) - 'owner' - 'owner_id'
  FROM storage.buckets b
  -- FIN 20

)
SELECT seccion, objeto, detalle
FROM todo
UNION ALL
SELECT '99_resumen'::text, 'filas_por_seccion'::text,
       (SELECT jsonb_object_agg(s.seccion, s.n)
          FROM (SELECT seccion, count(*) AS n FROM todo GROUP BY seccion) s)
ORDER BY 1, 2;
