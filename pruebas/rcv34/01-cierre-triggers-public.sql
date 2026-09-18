-- RCV-34 FASE 2B · 01-cierre-triggers-public.sql REV3 FINAL
-- NO EJECUTAR SIN AUTORIZACION EXPLICITA DE WILKIN.
--
-- Cierra EXECUTE de PUBLIC/anon en 3 funciones trigger de "public", conservando authenticated y
-- service_role con GRANT explicito (ver RCV-34 Fase 2A: si esos roles solo tenian EXECUTE por
-- herencia de PUBLIC, revocar PUBLIC tambien se lo quita, aunque el trigger siga funcionando
-- igual). El baseline de abajo es el confirmado en produccion por 00b/00-auditoria-rcv34/
-- 00d-triggers-proteger-rol-perfil (RCV-34 Fase 1/1B/2B). Firmas resueltas con to_regprocedure(),
-- nunca por proname. Comparacion campo a campo contra ese baseline exacto: si CUALQUIER cosa
-- difiere -aunque sea un solo trigger de mas o de menos, interno o no, un tgenabled distinto, un
-- md5 distinto, un proconfig distinto- se aborta con RAISE EXCEPTION antes de tocar ningun ACL
-- (o, si aparece post-cambio, revierte todo). NO toca: cuerpos, owners, search_path de las
-- funciones, triggers, tablas, filas, politicas RLS, secuencias, defaults de
-- postgres/supabase_admin, ni crear_perfil_al_registrarse() ni ninguna otra funcion. El
-- "SET LOCAL search_path" de abajo es solo el de la transaccion que ejecuta esta migracion, para
-- que las comparaciones de esta corrida no dependan del search_path que traiga la sesion del
-- SQL Editor; no cambia el search_path de ninguna funcion.
begin;
set local search_path = pg_catalog, public;

do $$
declare
  -- ── baseline exacto confirmado en produccion (no se toca en esta corrida) ──────────────────
  v_esperado jsonb := $B$
  {
    "mecanico_solo_avance_tecnico()": {
      "owner": "postgres", "security_definer": false,
      "md5_cuerpo": "5c9d8db5084b0a4e881948d9a920462b",
      "search_path_fijado": true,
      "acl_canonica": ["=X/postgres", "anon=X/postgres", "authenticated=X/postgres", "postgres=X/postgres", "service_role=X/postgres"],
      "triggers": [
        {"schema": "public", "tabla": "citas", "trigger": "citas_mecanico_avance", "timing": "BEFORE", "eventos": "UPDATE", "tgenabled": "O", "tgisinternal": false},
        {"schema": "public", "tabla": "ordenes", "trigger": "ordenes_mecanico_avance", "timing": "BEFORE", "eventos": "UPDATE", "tgenabled": "O", "tgisinternal": false}
      ]
    },
    "proteger_caja_ligada()": {
      "owner": "postgres", "security_definer": false,
      "md5_cuerpo": "4b1a0e352c4eae22efcbb139ae72a725",
      "search_path_fijado": false,
      "acl_canonica": ["=X/postgres", "anon=X/postgres", "authenticated=X/postgres", "postgres=X/postgres", "service_role=X/postgres"],
      "triggers": [
        {"schema": "public", "tabla": "caja_movimientos", "trigger": "no_borrar_caja_ligada", "timing": "BEFORE", "eventos": "DELETE", "tgenabled": "O", "tgisinternal": false}
      ]
    },
    "proteger_rol_perfil()": {
      "owner": "postgres", "security_definer": true,
      "md5_cuerpo": "5bcd1237d7e6714293cf4fc332e08667",
      "search_path_fijado": true,
      "acl_canonica": ["anon=X/postgres", "authenticated=X/postgres", "postgres=X/postgres", "service_role=X/postgres"],
      "triggers": [
        {"schema": "public", "tabla": "perfiles", "trigger": "proteger_rol_perfil_trigger", "timing": "BEFORE", "eventos": "UPDATE", "tgenabled": "O", "tgisinternal": false}
      ]
    }
  }
  $B$::jsonb;

  v_acl_post_esperada jsonb := '["authenticated=X/postgres", "postgres=X/postgres", "service_role=X/postgres"]'::jsonb;

  v_oid_mec  regprocedure := to_regprocedure('public.mecanico_solo_avance_tecnico()');
  v_oid_caja regprocedure := to_regprocedure('public.proteger_caja_ligada()');
  v_oid_rol  regprocedure := to_regprocedure('public.proteger_rol_perfil()');

  v_estado_previo jsonb;
  v_stop text := '';
  v_cardinalidad int;
  r record;
  v_act jsonb;
begin
  -- ── A: firmas exactas por OID, no por proname; overloads distintos no cuentan ──────────────
  if v_oid_mec is null then v_stop := v_stop || 'public.mecanico_solo_avance_tecnico() no existe con esa firma exacta; '; end if;
  if v_oid_caja is null then v_stop := v_stop || 'public.proteger_caja_ligada() no existe con esa firma exacta; '; end if;
  if v_oid_rol is null then v_stop := v_stop || 'public.proteger_rol_perfil() no existe con esa firma exacta; '; end if;
  if v_stop <> '' then
    raise exception 'RCV-34 01 REV3 STOP (firmas exactas, nada modificado): %', v_stop;
  end if;

  -- ── cardinalidad: deben ser EXACTAMENTE 3, ni una fusionada/duplicada ni una perdida ────────
  select count(*) into v_cardinalidad from pg_proc p where p.oid in (v_oid_mec, v_oid_caja, v_oid_rol);
  if v_cardinalidad <> 3 then
    raise exception 'RCV-34 01 REV3 STOP (cardinalidad PRE): se esperaban 3 funciones y pg_proc devolvio %; nada modificado', v_cardinalidad;
  end if;

  -- ── snapshot real de las 3, por OID (nunca por proname). Triggers SIN filtrar tgisinternal:
  --    el baseline ya declara tgisinternal=false para los 4 conocidos, asi que cualquier
  --    trigger interno adicional queda expuesto igual que uno normal y hace fallar la comparacion.
  select jsonb_object_agg(x.firma, x.datos) into v_estado_previo
    from (
      select p.oid::regprocedure::text as firma,
             jsonb_build_object(
               'owner', pg_get_userbyid(p.proowner),
               'retorna_trigger', (p.prorettype = 'trigger'::regtype),
               'security_definer', p.prosecdef,
               'md5_cuerpo', md5(p.prosrc),
               'search_path_fijado', (p.proconfig is not null
                   and exists(select 1 from unnest(p.proconfig) c where c like 'search_path=%')),
               'proconfig_raw', coalesce(to_jsonb(p.proconfig), 'null'::jsonb),
               'proacl_es_null', (p.proacl is null),
               'proacl_raw', (select jsonb_agg(i::text order by i::text) from unnest(p.proacl) i),
               'triggers', (select coalesce(jsonb_agg(jsonb_build_object(
                                'schema', n.nspname, 'tabla', c.relname, 'trigger', t.tgname,
                                'timing', case (t.tgtype::int & 66)
                                            when 2 then 'BEFORE' when 64 then 'INSTEAD OF' else 'AFTER' end,
                                'eventos', concat_ws(',',
                                  case when t.tgtype::int & 4  <> 0 then 'INSERT' end,
                                  case when t.tgtype::int & 8  <> 0 then 'DELETE' end,
                                  case when t.tgtype::int & 16 <> 0 then 'UPDATE' end,
                                  case when t.tgtype::int & 32 <> 0 then 'TRUNCATE' end),
                                'tgenabled', t.tgenabled::text,
                                'tgisinternal', t.tgisinternal)
                                order by n.nspname, c.relname, t.tgname), '[]'::jsonb)
                              from pg_trigger t
                              join pg_class c on c.oid = t.tgrelid
                              join pg_namespace n on n.oid = c.relnamespace
                             where t.tgfoid = p.oid)
             ) as datos
        from pg_proc p
       where p.oid in (v_oid_mec, v_oid_caja, v_oid_rol)
    ) x;

  -- ── B/C/D/E: comparar cada funcion contra el baseline, campo por campo ─────────────────────
  for r in select key as firma, value as esp from jsonb_each(v_esperado) loop
    v_act := v_estado_previo -> r.firma;
    if v_act is null then
      v_stop := v_stop || format('%s: no aparecio en el snapshot (inesperado); ', r.firma); continue;
    end if;
    if not (v_act ->> 'retorna_trigger')::boolean then
      v_stop := v_stop || format('%s: ya no retorna trigger; ', r.firma);
    end if;
    if (v_act ->> 'owner') is distinct from (r.esp ->> 'owner') then
      v_stop := v_stop || format('%s: owner=%s, esperado %s; ', r.firma, v_act ->> 'owner', r.esp ->> 'owner');
    end if;
    if (v_act ->> 'security_definer')::boolean is distinct from (r.esp ->> 'security_definer')::boolean then
      v_stop := v_stop || format('%s: security_definer=%s, esperado %s; ', r.firma, v_act ->> 'security_definer', r.esp ->> 'security_definer');
    end if;
    if (v_act ->> 'md5_cuerpo') is distinct from (r.esp ->> 'md5_cuerpo') then
      v_stop := v_stop || format('%s: el cuerpo cambio (md5 %s, esperado %s); ', r.firma, v_act ->> 'md5_cuerpo', r.esp ->> 'md5_cuerpo');
    end if;
    if (v_act ->> 'search_path_fijado')::boolean is distinct from (r.esp ->> 'search_path_fijado')::boolean then
      v_stop := v_stop || format('%s: search_path_fijado=%s, esperado %s; ', r.firma, v_act ->> 'search_path_fijado', r.esp ->> 'search_path_fijado');
    end if;
    if (v_act ->> 'proacl_es_null')::boolean then
      v_stop := v_stop || format('%s: proacl es NULL (se esperaba ACL explicita, no el default de fabrica); ', r.firma);
    else
      if (v_act -> 'proacl_raw') is distinct from (r.esp -> 'acl_canonica') then
        v_stop := v_stop || format('%s: ACL PRE distinta de la esperada (actual=%s, esperada=%s); ',
                     r.firma, v_act -> 'proacl_raw', r.esp -> 'acl_canonica');
      end if;
    end if;
    if (v_act -> 'triggers') is distinct from (r.esp -> 'triggers') then
      v_stop := v_stop || format('%s: el conjunto de triggers no coincide exactamente, incluidos internos si los hubiera (actual=%s, esperado=%s); ',
                   r.firma, v_act -> 'triggers', r.esp -> 'triggers');
    end if;
  end loop;

  if v_stop <> '' then
    raise exception 'RCV-34 01 REV3 STOP (baseline no coincide, nada modificado): %', v_stop;
  end if;

  -- ── F: transaction-local; visible durante esta transaccion, desaparece al terminar ─────────
  perform set_config('rcv34.estado_previo', v_estado_previo::text, true);
  perform set_config('rcv34.acl_post_esperada', v_acl_post_esperada::text, true);
end $$;

-- ── G: unicos cambios de esta migracion ────────────────────────────────────────────────────
revoke execute on function public.mecanico_solo_avance_tecnico() from public, anon;
grant  execute on function public.mecanico_solo_avance_tecnico() to authenticated, service_role;

revoke execute on function public.proteger_caja_ligada() from public, anon;
grant  execute on function public.proteger_caja_ligada() to authenticated, service_role;

revoke execute on function public.proteger_rol_perfil() from anon;
grant  execute on function public.proteger_rol_perfil() to authenticated, service_role;

-- ── H/I: postcondiciones de ACL e integridad; si algo mas que proacl cambio, aborta todo ───
do $$
declare
  v_previo jsonb := current_setting('rcv34.estado_previo')::jsonb;
  v_acl_post_esperada jsonb := current_setting('rcv34.acl_post_esperada')::jsonb;
  v_oid_mec  regprocedure := to_regprocedure('public.mecanico_solo_avance_tecnico()');
  v_oid_caja regprocedure := to_regprocedure('public.proteger_caja_ligada()');
  v_oid_rol  regprocedure := to_regprocedure('public.proteger_rol_perfil()');
  v_fail text := '';
  v_cardinalidad int;
  r record;
  v_prev jsonb;
begin
  -- cardinalidad POST: exactamente 3 filas, nunca menos (un LOOP sobre 2 no debe colarse como PASS)
  select count(*) into v_cardinalidad from pg_proc p where p.oid in (v_oid_mec, v_oid_caja, v_oid_rol);
  if v_cardinalidad <> 3 then
    raise exception 'RCV-34 01 REV3 STOP (cardinalidad POST): se esperaban 3 funciones y pg_proc devolvio % tras el cambio', v_cardinalidad;
  end if;

  for r in
    select p.oid::regprocedure::text as firma, p.oid,
           pg_get_userbyid(p.proowner) as owner,
           (p.prorettype = 'trigger'::regtype) as retorna_trigger,
           p.prosecdef as security_definer,
           md5(p.prosrc) as md5_cuerpo,
           (p.proconfig is not null and exists(select 1 from unnest(p.proconfig) c where c like 'search_path=%')) as search_path_fijado,
           coalesce(to_jsonb(p.proconfig), 'null'::jsonb) as proconfig_raw,
           p.proacl is null as proacl_es_null,
           (select jsonb_agg(i::text order by i::text) from unnest(p.proacl) i) as proacl_raw,
           exists(select 1 from unnest(coalesce(p.proacl, acldefault('f', p.proowner))) i
                    where split_part(i::text, '=', 1) = ''
                      and position('X' in split_part(split_part(i::text, '=', 2), '/', 1)) > 0) as public_execute,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
           (select coalesce(jsonb_agg(jsonb_build_object(
                      'schema', n.nspname, 'tabla', c.relname, 'trigger', t.tgname,
                      'timing', case (t.tgtype::int & 66) when 2 then 'BEFORE' when 64 then 'INSTEAD OF' else 'AFTER' end,
                      'eventos', concat_ws(',',
                        case when t.tgtype::int & 4  <> 0 then 'INSERT' end,
                        case when t.tgtype::int & 8  <> 0 then 'DELETE' end,
                        case when t.tgtype::int & 16 <> 0 then 'UPDATE' end,
                        case when t.tgtype::int & 32 <> 0 then 'TRUNCATE' end),
                      'tgenabled', t.tgenabled::text, 'tgisinternal', t.tgisinternal)
                      order by n.nspname, c.relname, t.tgname), '[]'::jsonb)
              from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
             where t.tgfoid = p.oid) as triggers
      from pg_proc p
     where p.oid in (v_oid_mec, v_oid_caja, v_oid_rol)
  loop
    v_prev := v_previo -> r.firma;

    -- H: postcondicion de ACL, efectiva Y raw exacta
    if r.public_execute or r.anon or not r.authenticated or not r.service_role then
      v_fail := v_fail || format('%s no cumple postcondicion ACL efectiva (PUBLIC=%s anon=%s authenticated=%s service_role=%s); ',
                  r.firma, r.public_execute, r.anon, r.authenticated, r.service_role);
    end if;
    if r.proacl_es_null then
      v_fail := v_fail || format('%s: proacl quedo NULL tras el cambio (se esperaba ACL explicita); ', r.firma);
    elsif r.proacl_raw is distinct from v_acl_post_esperada then
      v_fail := v_fail || format('%s: ACL POST distinta de la exacta esperada (actual=%s, esperada=%s); ',
                   r.firma, r.proacl_raw, v_acl_post_esperada);
    end if;

    -- I: todo lo demas debe seguir IDENTICO al PRE; solo proacl puede cambiar
    if r.owner is distinct from (v_prev ->> 'owner') then
      v_fail := v_fail || format('%s: owner cambio de %s a %s; ', r.firma, v_prev ->> 'owner', r.owner);
    end if;
    if r.retorna_trigger is distinct from (v_prev ->> 'retorna_trigger')::boolean then
      v_fail := v_fail || format('%s: dejo de retornar trigger; ', r.firma);
    end if;
    if r.security_definer is distinct from (v_prev ->> 'security_definer')::boolean then
      v_fail := v_fail || format('%s: security_definer cambio; ', r.firma);
    end if;
    if r.md5_cuerpo is distinct from (v_prev ->> 'md5_cuerpo') then
      v_fail := v_fail || format('%s: el cuerpo cambio durante la migracion; ', r.firma);
    end if;
    if r.search_path_fijado is distinct from (v_prev ->> 'search_path_fijado')::boolean then
      v_fail := v_fail || format('%s: search_path_fijado cambio; ', r.firma);
    end if;
    if r.proconfig_raw is distinct from (v_prev -> 'proconfig_raw') then
      v_fail := v_fail || format('%s: proconfig cambio (actual=%s, previo=%s); ', r.firma, r.proconfig_raw, v_prev -> 'proconfig_raw');
    end if;
    if r.triggers is distinct from (v_prev -> 'triggers') then
      v_fail := v_fail || format('%s: el conjunto de triggers cambio (actual=%s, previo=%s); ', r.firma, r.triggers, v_prev -> 'triggers');
    end if;
  end loop;

  if v_fail <> '' then
    raise exception 'RCV-34 01 REV3 STOP (postcondiciones, se revierte todo): %', v_fail;
  end if;
  raise notice 'RCV-34 01 REV3: postcondiciones OK en las 3 funciones (ACL POST exacta, proconfig identico, triggers identicos incluidos internos). 0 filas de negocio tocadas.';
end $$;

-- copiar este valor exacto para pegarlo como :estado_previo en 02-rollback-cierre-triggers.sql
select current_setting('rcv34.estado_previo')::jsonb as estado_previo_para_rollback;

commit;
