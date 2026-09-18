-- RCV-34 FASE 1C · BLAST RADIUS GLOBAL POSTGRES, SOLO LECTURA.
-- Inventario de funciones fuera de "public" propiedad de postgres/supabase_admin, incluyendo
-- schemas gestionados por Supabase (auth, storage, realtime, graphql, extensions, vault, ...).
-- Solo metadata: firma, owner, ACL directa y efectiva. Nunca cuerpo de funcion (prosrc).
-- Donde: Supabase -> SQL Editor del proyecto de produccion -> pegar -> Run.
begin transaction read only;

set local search_path = pg_catalog, public;

with objetivo_schemas as (
  select n.oid, n.nspname
    from pg_namespace n
   where n.nspname <> 'public'
     and n.nspname not in ('pg_catalog', 'information_schema')
     and n.nspname not like 'pg\_temp\_%'
     and n.nspname not like 'pg\_toast%'
),
funciones as (
  select p.oid,
         n.nspname as schema,
         p.oid::regprocedure::text as firma,
         pg_get_userbyid(p.proowner) as owner,
         pg_get_function_result(p.oid) as retorna,
         p.prokind::text as prokind,
         (p.prorettype = 'trigger'::regtype) as es_trigger,
         p.prosecdef as security_definer,
         coalesce(p.proacl, acldefault('f', p.proowner)) as acl,
         (select e.extname
            from pg_depend d
            join pg_extension e on e.oid = d.refobjid
           where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
           limit 1) as extension_nombre
    from pg_proc p
    join objetivo_schemas n on n.oid = p.pronamespace
   where pg_get_userbyid(p.proowner) in ('postgres', 'supabase_admin')
),
enriquecidas as (
  select f.*,
         (f.extension_nombre is not null) as extension_owned,
         -- OJO: estos 4 reflejan la ACL EFECTIVA del objeto (proacl, o acldefault() de fabrica si
         -- proacl es NULL) para saber si HOY concede EXECUTE. No confundir con un grant almacenado
         -- explicitamente: si proacl es NULL, PUBLIC=true aqui puede venir solo del default de
         -- fabrica de Postgres, no de una fila real. Por eso se llaman "_en_acl_objeto", no "_directo".
         exists(select 1 from unnest(f.acl) i where split_part(i::text, '=', 1) = ''
                  and position('X' in split_part(split_part(i::text, '=', 2), '/', 1)) > 0) as public_en_acl_objeto,
         exists(select 1 from unnest(f.acl) i where trim(both '"' from split_part(i::text, '=', 1)) = 'anon'
                  and position('X' in split_part(split_part(i::text, '=', 2), '/', 1)) > 0) as anon_en_acl_objeto,
         exists(select 1 from unnest(f.acl) i where trim(both '"' from split_part(i::text, '=', 1)) = 'authenticated'
                  and position('X' in split_part(split_part(i::text, '=', 2), '/', 1)) > 0) as authenticated_en_acl_objeto,
         exists(select 1 from unnest(f.acl) i where trim(both '"' from split_part(i::text, '=', 1)) = 'service_role'
                  and position('X' in split_part(split_part(i::text, '=', 2), '/', 1)) > 0) as service_role_en_acl_objeto,
         has_function_privilege('anon', f.oid, 'EXECUTE') as anon_efectivo,
         has_function_privilege('authenticated', f.oid, 'EXECUTE') as authenticated_efectivo,
         has_function_privilege('service_role', f.oid, 'EXECUTE') as service_role_efectivo,
         -- excluye PUBLIC, el propio owner de ESTA funcion (dinamico, no hardcodeado a 'postgres'),
         -- y los 3 roles de PostgREST ya reportados aparte; lo que quede es realmente "adicional".
         (select coalesce(jsonb_agg(distinct g order by g), '[]'::jsonb)
            from (select trim(both '"' from split_part(i::text, '=', 1)) as g
                    from unnest(f.acl) i) s
           where s.g not in ('', f.owner, 'anon', 'authenticated', 'service_role')) as roles_adicionales
    from funciones f
)
select jsonb_pretty(jsonb_build_object(
  'formato', 'rcv34-blast-radius/1',
  'generado', now(),

  'funciones', (
    select coalesce(jsonb_agg(jsonb_build_object(
              'schema', e.schema,
              'firma', e.firma,
              'owner', e.owner,
              'retorna', e.retorna,
              'prokind', e.prokind,
              'es_trigger', e.es_trigger,
              'security_definer', e.security_definer,
              'extension_owned', e.extension_owned,
              'extension_nombre', e.extension_nombre,
              'acl_objeto', jsonb_build_object(
                'PUBLIC_en_acl_objeto', e.public_en_acl_objeto, 'anon_en_acl_objeto', e.anon_en_acl_objeto,
                'authenticated_en_acl_objeto', e.authenticated_en_acl_objeto,
                'service_role_en_acl_objeto', e.service_role_en_acl_objeto),
              'efectivo', jsonb_build_object(
                'anon', e.anon_efectivo, 'authenticated', e.authenticated_efectivo,
                'service_role', e.service_role_efectivo),
              'roles_adicionales_en_acl', e.roles_adicionales,
              'clasificacion',
                case when e.extension_owned then 'D'
                     when not e.public_en_acl_objeto then 'C'
                     when e.authenticated_en_acl_objeto or e.service_role_en_acl_objeto then 'B'
                     else 'A' end)
              order by e.schema, e.firma), '[]'::jsonb)
      from enriquecidas e
  ),

  'resumen_por_schema_owner', (
    select coalesce(jsonb_agg(jsonb_build_object(
              'schema', x.schema, 'owner', x.owner, 'total', x.total,
              'public_en_acl_objeto', x.pub, 'anon_efectivo', x.anon_ef,
              'authenticated_efectivo', x.auth_ef, 'service_role_efectivo', x.svc_ef,
              'extension_owned', x.ext)
              order by x.schema, x.owner), '[]'::jsonb)
      from (select schema, owner, count(*) as total,
                   count(*) filter (where public_en_acl_objeto) as pub,
                   count(*) filter (where anon_efectivo) as anon_ef,
                   count(*) filter (where authenticated_efectivo) as auth_ef,
                   count(*) filter (where service_role_efectivo) as svc_ef,
                   count(*) filter (where extension_owned) as ext
              from enriquecidas
             group by schema, owner) x
  ),

  -- "efectivo_sin_grant_propio_*": el rol SI tiene EXECUTE efectivo pero NO tiene una entrada
  -- propia en la ACL del objeto. No afirma que la via sea PUBLIC especificamente (podria ser
  -- membresia de rol); solo que el privilegio no vino de un grant nominal a ese rol.
  'resumen_postgres_fuera_public', jsonb_build_object(
    'con_public_en_acl_objeto', (select count(*) from enriquecidas where owner = 'postgres' and public_en_acl_objeto),
    'efectivo_sin_grant_propio_anon', (select count(*) from enriquecidas
        where owner = 'postgres' and anon_efectivo and not anon_en_acl_objeto),
    'efectivo_sin_grant_propio_authenticated', (select count(*) from enriquecidas
        where owner = 'postgres' and authenticated_efectivo and not authenticated_en_acl_objeto),
    'efectivo_sin_grant_propio_service_role', (select count(*) from enriquecidas
        where owner = 'postgres' and service_role_efectivo and not service_role_en_acl_objeto)
  ),

  'resumen_supabase_admin_fuera_public', jsonb_build_object(
    'total', (select count(*) from enriquecidas where owner = 'supabase_admin'),
    'schemas', (select coalesce(jsonb_agg(distinct schema order by schema), '[]'::jsonb)
                  from enriquecidas where owner = 'supabase_admin')
  ),

  -- default ACL de postgres/supabase_admin en CUALQUIER schema con fila propia, correlacionado
  -- SOLO con funciones del MISMO owner de esa fila (nunca mezclando los dos roles).
  -- Fila GLOBAL (defaclnamespace=0, schema='(global)'): no hay un schema puntual que contar,
  -- por eso ese campo queda null y se agrega aparte el total de ese owner fuera de public.
  'default_acl_relacionado', (
    select coalesce(jsonb_agg(jsonb_build_object(
              'rol', pg_get_userbyid(d.defaclrole),
              'schema', coalesce(n.nspname, '(global)'),
              'tipo_objeto', case d.defaclobjtype
                               when 'r' then 'tablas' when 'S' then 'secuencias'
                               when 'f' then 'funciones' when 'T' then 'tipos'
                               else d.defaclobjtype::text end,
              'acl', (select jsonb_agg(i::text order by i::text) from unnest(d.defaclacl) i),
              'funciones_del_mismo_owner_en_ese_schema',
                case when n.nspname is null then null
                     else (select count(*) from enriquecidas e
                            where e.schema = n.nspname and e.owner = pg_get_userbyid(d.defaclrole)) end,
              'funciones_totales_de_ese_owner_fuera_de_public',
                (select count(*) from enriquecidas e where e.owner = pg_get_userbyid(d.defaclrole)))
              order by pg_get_userbyid(d.defaclrole),
                       case when d.defaclnamespace = 0 then '' else n.nspname end,
                       d.defaclobjtype::text), '[]'::jsonb)
      from pg_default_acl d
      left join pg_namespace n on n.oid = d.defaclnamespace
     where pg_get_userbyid(d.defaclrole) in ('postgres', 'supabase_admin')
  )
)) as blast_radius_rcv34;

rollback;
