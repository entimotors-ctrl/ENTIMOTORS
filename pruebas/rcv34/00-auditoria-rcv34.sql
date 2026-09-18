-- RCV-34 FASE 1B · AUDITORIA DE PERMISOS Y FUNCIONES, SOLO LECTURA.
-- Una celda JSON, sin filas de negocio, sin cuerpos de funcion (solo md5 del cuerpo para comparar).
-- Donde: Supabase -> SQL Editor del proyecto de produccion -> pegar -> Run.
begin transaction read only;

set local search_path = pg_catalog, public;

select jsonb_pretty(jsonb_build_object(
  'formato', 'rcv34-auditoria/1',
  'generado', now(),

  'version_postgresql', version(),
  'current_user', current_user,
  'session_user', session_user,

  'atributos_roles', (
    select coalesce(jsonb_object_agg(r.rolname, jsonb_build_object(
              'rolsuper', r.rolsuper,
              'rolinherit', r.rolinherit,
              'rolcreaterole', r.rolcreaterole,
              'rolcreatedb', r.rolcreatedb,
              'rolcanlogin', r.rolcanlogin,
              'rolbypassrls', r.rolbypassrls)), '{}'::jsonb)
      from pg_roles r
     where r.rolname in ('postgres', 'supabase_admin', 'anon', 'authenticated', 'service_role')
  ),

  'membresias', (
    select coalesce(jsonb_agg(jsonb_build_object(
              'miembro', m.rolname, 'de_rol', g.rolname, 'con_admin_option', am.admin_option)
              order by m.rolname, g.rolname), '[]'::jsonb)
      from pg_auth_members am
      join pg_roles m on m.oid = am.member
      join pg_roles g on g.oid = am.roleid
     where m.rolname in ('postgres', 'supabase_admin', 'anon', 'authenticated', 'service_role')
        or g.rolname in ('postgres', 'supabase_admin', 'anon', 'authenticated', 'service_role')
  ),

  -- pg_default_acl completo de postgres y supabase_admin: global (defaclnamespace=0),
  -- schema public, y cualquier otro esquema donde tengan default configurado.
  'default_acl', (
    select coalesce(jsonb_agg(jsonb_build_object(
              'rol', pg_get_userbyid(d.defaclrole),
              'alcance', case when d.defaclnamespace = 0 then 'global'
                              else 'schema_' || n.nspname end,
              'tipo_objeto', case d.defaclobjtype
                               when 'r' then 'tablas' when 'S' then 'secuencias'
                               when 'f' then 'funciones' when 'T' then 'tipos'
                               else d.defaclobjtype::text end,
              'acl', (select jsonb_agg(i::text order by i::text) from unnest(d.defaclacl) i))
              order by pg_get_userbyid(d.defaclrole),
                       case when d.defaclnamespace = 0 then '' else n.nspname end,
                       d.defaclobjtype::text), '[]'::jsonb)
      from pg_default_acl d
      left join pg_namespace n on n.oid = d.defaclnamespace
     where pg_get_userbyid(d.defaclrole) in ('postgres', 'supabase_admin')
  ),

  'funciones_public', (
    select coalesce(jsonb_agg(jsonb_build_object(
              'firma', p.oid::regprocedure::text,
              'owner', pg_get_userbyid(p.proowner),
              'retorna', pg_get_function_result(p.oid),
              'prokind', p.prokind::text,
              'volatilidad', p.provolatile::text,
              'security_definer', p.prosecdef,
              'search_path_fijado', (p.proconfig is not null
                  and exists(select 1 from unnest(p.proconfig) c where c like 'search_path=%')),
              'md5_cuerpo', md5(p.prosrc),
              'es_trigger', (p.prorettype = 'trigger'::regtype),
              'proacl', (select jsonb_agg(i::text order by i::text)
                           from unnest(coalesce(p.proacl, acldefault('f', p.proowner))) i),
              'execute', jsonb_build_object(
                'PUBLIC_directo', exists(select 1 from unnest(coalesce(p.proacl, acldefault('f', p.proowner))) i
                                           where split_part(i::text, '=', 1) = ''
                                             and position('X' in split_part(split_part(i::text, '=', 2), '/', 1)) > 0),
                'anon_efectivo', has_function_privilege('anon', p.oid, 'EXECUTE'),
                'authenticated_efectivo', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                'service_role_efectivo', has_function_privilege('service_role', p.oid, 'EXECUTE')))
              order by p.oid::regprocedure::text), '[]'::jsonb)
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
  ),

  -- excluye catalogo interno de Postgres y los esquemas propios de la plataforma Supabase
  -- (auth, storage, realtime, graphql*, extensions, vault, pgsodium*, supabase_*, cron, net,
  -- pgbouncer, pgtle): esos se resumen aparte en 'otros_schemas_reservados_resumen' para no
  -- inflar el resultado con miles de funciones de extensiones que no son del dominio del taller.
  'funciones_fuera_de_public_app', (
    select coalesce(jsonb_agg(jsonb_build_object(
              'schema', n.nspname,
              'firma', p.oid::regprocedure::text,
              'owner', pg_get_userbyid(p.proowner),
              'retorna', pg_get_function_result(p.oid),
              'PUBLIC_directo', exists(select 1 from unnest(coalesce(p.proacl, acldefault('f', p.proowner))) i
                                         where split_part(i::text, '=', 1) = ''
                                           and position('X' in split_part(split_part(i::text, '=', 2), '/', 1)) > 0),
              'anon_efectivo', has_function_privilege('anon', p.oid, 'EXECUTE'))
              order by n.nspname, p.oid::regprocedure::text), '[]'::jsonb)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where pg_get_userbyid(p.proowner) in ('postgres', 'supabase_admin')
       and n.nspname <> 'public'
       and n.nspname not in ('pg_catalog', 'information_schema',
             'auth', 'storage', 'realtime', 'graphql', 'graphql_public', 'extensions',
             'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions', 'supabase_migrations',
             'cron', 'net', 'pgbouncer', 'pgtle', 'pgmq', '_realtime')
       and n.nspname not like 'pg\_%'
  ),

  'otros_schemas_reservados_resumen', (
    select coalesce(jsonb_object_agg(x.nspname, x.n), '{}'::jsonb)
      from (select n.nspname, count(*) as n
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where pg_get_userbyid(p.proowner) in ('postgres', 'supabase_admin')
               and n.nspname <> 'public'
               and (n.nspname in ('pg_catalog', 'information_schema',
                     'auth', 'storage', 'realtime', 'graphql', 'graphql_public', 'extensions',
                     'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions', 'supabase_migrations',
                     'cron', 'net', 'pgbouncer', 'pgtle', 'pgmq', '_realtime')
                    or n.nspname like 'pg\_%')
             group by n.nspname) x
  ),

  'triggers_relevantes', (
    select coalesce(jsonb_agg(jsonb_build_object(
              'trigger', t.tgname, 'tabla', c.relname, 'funcion', pr.proname,
              'timing', case (t.tgtype::int & 66)
                          when 2 then 'BEFORE' when 64 then 'INSTEAD OF' else 'AFTER' end,
              'evento', concat_ws(',',
                          case when t.tgtype::int & 4  <> 0 then 'INSERT' end,
                          case when t.tgtype::int & 8  <> 0 then 'DELETE' end,
                          case when t.tgtype::int & 16 <> 0 then 'UPDATE' end))
              order by c.relname, t.tgname), '[]'::jsonb)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc pr on pr.oid = t.tgfoid
     where pr.proname in ('mecanico_solo_avance_tecnico', 'proteger_caja_ligada')
       and not t.tgisinternal
  ),

  'resumen', (
    select jsonb_build_object(
      'total_funciones_public', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace),
      'normales', (select count(*) from pg_proc
                    where pronamespace = 'public'::regnamespace and prorettype <> 'trigger'::regtype),
      'trigger', (select count(*) from pg_proc
                   where pronamespace = 'public'::regnamespace and prorettype = 'trigger'::regtype),
      'normales_ejecutables_por_anon', (
        select count(*) from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.prorettype <> 'trigger'::regtype
           and has_function_privilege('anon', p.oid, 'EXECUTE')),
      'normales_con_public_directo', (
        select count(*) from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.prorettype <> 'trigger'::regtype
           and exists(select 1 from unnest(coalesce(p.proacl, acldefault('f', p.proowner))) i
                       where split_part(i::text, '=', 1) = ''
                         and position('X' in split_part(split_part(i::text, '=', 2), '/', 1)) > 0)),
      'funciones_fuera_public_app_de_postgres_o_supabase_admin', (
        select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where pg_get_userbyid(p.proowner) in ('postgres', 'supabase_admin')
           and n.nspname <> 'public'
           and n.nspname not in ('pg_catalog', 'information_schema',
                 'auth', 'storage', 'realtime', 'graphql', 'graphql_public', 'extensions',
                 'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions', 'supabase_migrations',
                 'cron', 'net', 'pgbouncer', 'pgtle', 'pgmq', '_realtime')
           and n.nspname not like 'pg\_%')
    )
  )
)) as auditoria_rcv34;

rollback;
