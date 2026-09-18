-- RCV-34 FASE 2B · metadata EXACTA de los triggers de public.proteger_rol_perfil(), SOLO LECTURA.
-- No lee filas de negocio, no DDL, no DML. Una sola transaccion READ ONLY, termina en ROLLBACK.
-- Donde: Supabase -> SQL Editor del proyecto de produccion -> pegar -> Run.
begin transaction read only;

set local search_path = pg_catalog, public;

select jsonb_pretty(jsonb_build_object(
  'formato', 'rcv34-triggers-proteger_rol_perfil/1',
  'generado', now(),
  'existe_la_funcion', (to_regprocedure('public.proteger_rol_perfil()') is not null),
  'triggers', (
    select coalesce(jsonb_agg(jsonb_build_object(
              'schema_tabla', n.nspname,
              'tabla', c.relname,
              'trigger', t.tgname,
              'timing', case (t.tgtype::int & 66)
                          when 2 then 'BEFORE' when 64 then 'INSTEAD OF' else 'AFTER' end,
              'eventos', concat_ws(',',
                           case when t.tgtype::int & 4  <> 0 then 'INSERT' end,
                           case when t.tgtype::int & 8  <> 0 then 'DELETE' end,
                           case when t.tgtype::int & 16 <> 0 then 'UPDATE' end,
                           case when t.tgtype::int & 32 <> 0 then 'TRUNCATE' end),
              'tgisinternal', t.tgisinternal,
              'tgenabled', t.tgenabled)
              order by n.nspname, c.relname, t.tgname), '[]'::jsonb)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where t.tgfoid = to_regprocedure('public.proteger_rol_perfil()')
  )
)) as triggers_proteger_rol_perfil;

rollback;
