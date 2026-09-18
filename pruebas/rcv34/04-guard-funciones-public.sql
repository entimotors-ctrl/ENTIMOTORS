-- RCV-34 · GUARD DE FUNCIONES DE PUBLIC, SOLO LECTURA.
-- Falla si CUALQUIER funcion de public (normal o trigger) concede EXECUTE efectivo a anon o a
-- PUBLIC, o si una SECURITY DEFINER no tiene search_path fijado. Pensado para correr despues de
-- cada deploy que toque funciones, y como chequeo periodico. Nunca cuerpo de funcion (prosrc).
-- Donde: Supabase -> SQL Editor -> pegar -> Run.
begin transaction read only;

set local search_path = pg_catalog, public;

with base as (
  select p.oid,
         p.oid::regprocedure::text as firma,
         pg_get_userbyid(p.proowner) as owner,
         (p.prorettype = 'trigger'::regtype) as es_trigger,
         p.prosecdef as security_definer,
         (p.proconfig is not null
            and exists(select 1 from unnest(p.proconfig) c where c like 'search_path=%')) as search_path_fijado,
         md5(p.prosrc) as md5_cuerpo,
         coalesce(p.proacl, acldefault('f', p.proowner)) as acl,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
),
evaluadas as (
  select b.*,
         exists(select 1 from unnest(b.acl) i where split_part(i::text, '=', 1) = ''
                  and position('X' in split_part(split_part(i::text, '=', 2), '/', 1)) > 0) as public_execute,
         -- una funcion falla si concede a anon o a PUBLIC, sea normal o trigger; y si es
         -- SECURITY DEFINER sin search_path fijado (riesgo de search_path hijacking).
         (b.anon or exists(select 1 from unnest(b.acl) i where split_part(i::text, '=', 1) = ''
                              and position('X' in split_part(split_part(i::text, '=', 2), '/', 1)) > 0)) as falla_acl,
         (b.security_definer and not b.search_path_fijado) as falla_search_path
    from base b
),
fallos as (
  select e.firma,
         array_remove(array[
           case when e.anon then 'anon_execute' end,
           case when e.public_execute then 'public_execute' end,
           case when e.falla_search_path then 'security_definer_sin_search_path' end
         ], null) as motivos
    from evaluadas e
   where e.falla_acl or e.falla_search_path
)
select jsonb_pretty(jsonb_build_object(
  'formato', 'rcv34-guard-public/1',
  'generado', now(),
  'todo_ok', not exists(select 1 from fallos),
  'fallos', (select coalesce(jsonb_agg(jsonb_build_object('firma', f.firma, 'motivos', to_jsonb(f.motivos))
                              order by f.firma), '[]'::jsonb)
               from fallos f),
  'resumen', jsonb_build_object(
    'total_funciones', (select count(*) from evaluadas),
    'normales', (select count(*) from evaluadas where not es_trigger),
    'trigger', (select count(*) from evaluadas where es_trigger),
    'con_fallo_acl', (select count(*) from evaluadas where falla_acl),
    'con_fallo_search_path', (select count(*) from evaluadas where falla_search_path),
    'security_definer_total', (select count(*) from evaluadas where security_definer)
  ),
  'funciones', (
    select coalesce(jsonb_agg(jsonb_build_object(
              'firma', e.firma,
              'owner', e.owner,
              'tipo', case when e.es_trigger then 'trigger' else 'normal' end,
              'PUBLIC', e.public_execute,
              'anon', e.anon,
              'authenticated', e.authenticated,
              'service_role', e.service_role,
              'security_definer', e.security_definer,
              'search_path_fijado', e.search_path_fijado,
              'md5_cuerpo', e.md5_cuerpo,
              'ok', not (e.falla_acl or e.falla_search_path))
              order by e.firma), '[]'::jsonb)
      from evaluadas e
  )
)) as guard_funciones_public;

rollback;
