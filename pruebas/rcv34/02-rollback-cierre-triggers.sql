-- RCV-34 FASE 2C · 02-rollback-cierre-triggers.sql REV2 FINAL
-- NO EJECUTAR SIN AUTORIZACION EXPLICITA DE WILKIN, y solo si 01-cierre-triggers-public.sql REV3
-- ya se ejecuto en produccion y causo una regresion que exige revertir.
--
-- Restaura EXACTAMENTE, aclitem por aclitem, el EXECUTE ACL que tenian las mismas 3 funciones
-- ANTES de que corriera 01 REV3 (mecanico_solo_avance_tecnico, proteger_caja_ligada,
-- proteger_rol_perfil). No toca cuerpos, owners, search_path de las funciones, triggers, tablas,
-- filas, politicas RLS, secuencias, ni ninguna otra funcion. No toca el owner "postgres".
--
-- Formato de entrada: pega en el BLOQUE 0, UNA SOLA VEZ, el valor JSONB exacto que devolvio
-- 01 REV3 como "estado_previo_para_rollback" (columna de la ultima fila que imprime 01, antes
-- del commit). Ese valor usa las claves: owner, retorna_trigger, security_definer, md5_cuerpo,
-- search_path_fijado, proconfig_raw, proacl_es_null, proacl_raw, triggers. NO uses el formato
-- antiguo (clave "proacl"); ese formato ya no es compatible con este script.
--
-- Firmas resueltas con to_regprocedure(), nunca por proname ni por texto de p.oid::regprocedure.
-- Antes de tocar cualquier ACL: (1) valida que lo pegado tiene forma valida y las 3 firmas
-- exactas: STOP si no; (2) valida que lo pegado coincide con el baseline PRE conocido de
-- produccion (mismo owner/cuerpo/atributos/triggers/ACL que uso 01 REV3 para autorizarse): STOP
-- si no, porque no se revierte a ciegas un snapshot que no se reconoce; (3) valida que el estado
-- ACTUAL de las 3 funciones sigue siendo identico al snapshot pegado en todo excepto el ACL: STOP
-- si algo cambio desde 01; (4) valida que el ACL ACTUAL es exactamente el POST-01 esperado (ni ya
-- revertido, ni alterado a mano, ni por otra migracion): STOP si no. Solo si las 4 pasan se
-- ejecutan las 3 unicas sentencias GRANT/REVOKE de restauracion, hardcodeadas (nunca construidas
-- con nombres de rol tomados del JSON pegado). Despues, vuelve a verificar TODO (ACL exacta +
-- resto de atributos identicos): si algo quedo mal, revierte toda la transaccion.
begin;
set local search_path = pg_catalog, public;

-- ── BLOQUE 0: pegar aqui, UNA SOLA VEZ, el estado_previo_para_rollback devuelto por 01 REV3 ────
do $$
begin
  perform set_config('rcv34.estado_previo_02',
    ('__PEGAR_AQUI_ESTADO_PREVIO_DE_01__'::jsonb)::text, true);
end $$;

-- ── BLOQUE 1: validaciones. Nada de esto modifica ACL; si algo falla, STOP antes del GRANT/REVOKE ──
do $$
declare
  v_previo jsonb := current_setting('rcv34.estado_previo_02')::jsonb;

  -- baseline PRE conocido de produccion (el mismo que valida 01 REV3 antes de cerrar el ACL;
  -- ver 01-cierre-triggers-public.sql). Sirve para comprobar que lo pegado en el BLOQUE 0 es
  -- realmente el snapshot de ESTAS 3 funciones y no un JSON arbitrario o de otra corrida.
  v_baseline_conocido jsonb := $B$
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

  v_key_mec text; v_key_caja text; v_key_rol text;
  v_stop text := '';
  v_cardinalidad int;
  r record;
  v_prev jsonb;
begin
  -- D: firmas exactas por OID; ninguna depende de comparar texto contra p.oid::regprocedure ────
  if v_oid_mec is null then v_stop := v_stop || 'public.mecanico_solo_avance_tecnico() no existe con esa firma exacta; '; end if;
  if v_oid_caja is null then v_stop := v_stop || 'public.proteger_caja_ligada() no existe con esa firma exacta; '; end if;
  if v_oid_rol is null then v_stop := v_stop || 'public.proteger_rol_perfil() no existe con esa firma exacta; '; end if;
  if v_stop <> '' then
    raise exception 'RCV-34 02 REV2 STOP (firmas exactas, nada modificado): %', v_stop;
  end if;

  select count(*) into v_cardinalidad from pg_proc p where p.oid in (v_oid_mec, v_oid_caja, v_oid_rol);
  if v_cardinalidad <> 3 then
    raise exception 'RCV-34 02 REV2 STOP (cardinalidad): se esperaban 3 funciones y pg_proc devolvio %; nada modificado', v_cardinalidad;
  end if;

  v_key_mec  := v_oid_mec::text;
  v_key_caja := v_oid_caja::text;
  v_key_rol  := v_oid_rol::text;

  -- C: forma estricta del snapshot pegado: object, EXACTAMENTE 3 claves, las 3 firmas exactas ──
  if v_previo is null or jsonb_typeof(v_previo) <> 'object' then
    raise exception 'RCV-34 02 REV2 STOP: el estado_previo pegado no es un objeto JSON valido; nada modificado';
  end if;
  if (select count(*) from jsonb_object_keys(v_previo)) <> 3 then
    raise exception 'RCV-34 02 REV2 STOP: el estado_previo pegado debe tener EXACTAMENTE 3 claves (tiene %); nada modificado',
      (select count(*) from jsonb_object_keys(v_previo));
  end if;
  if not (v_previo ? v_key_mec and v_previo ? v_key_caja and v_previo ? v_key_rol) then
    raise exception 'RCV-34 02 REV2 STOP: el estado_previo pegado no contiene las 3 firmas exactas esperadas (%, %, %); nada modificado',
      v_key_mec, v_key_caja, v_key_rol;
  end if;

  for r in select unnest(array[v_key_mec, v_key_caja, v_key_rol]) as firma loop
    v_prev := v_previo -> r.firma;
    if jsonb_typeof(v_prev) <> 'object' then
      v_stop := v_stop || format('%s: el valor pegado no es un objeto; ', r.firma);
      continue;
    end if;
    if not (v_prev ? 'owner' and v_prev ? 'retorna_trigger' and v_prev ? 'security_definer'
            and v_prev ? 'md5_cuerpo' and v_prev ? 'search_path_fijado' and v_prev ? 'proconfig_raw'
            and v_prev ? 'proacl_es_null' and v_prev ? 'proacl_raw' and v_prev ? 'triggers') then
      v_stop := v_stop || format('%s: faltan campos obligatorios en el snapshot pegado (formato antiguo o incompleto); ', r.firma);
      continue;
    end if;
    if (v_prev ->> 'proacl_es_null')::boolean then
      v_stop := v_stop || format('%s: proacl_es_null=true en el snapshot pegado (se esperaba ACL explicita, no el default de fabrica); ', r.firma);
    end if;
    if jsonb_typeof(v_prev -> 'proacl_raw') <> 'array' then
      v_stop := v_stop || format('%s: proacl_raw pegado no es un array; ', r.firma);
    end if;
    if jsonb_typeof(v_prev -> 'triggers') <> 'array' then
      v_stop := v_stop || format('%s: triggers pegado no es un array; ', r.firma);
    end if;
  end loop;
  if v_stop <> '' then
    raise exception 'RCV-34 02 REV2 STOP (formato del snapshot pegado, nada modificado): %', v_stop;
  end if;

  -- G: lo pegado debe corresponder EXACTAMENTE al baseline PRE conocido de produccion ──────────
  for r in select key as firma, value as base from jsonb_each(v_baseline_conocido) loop
    v_prev := v_previo -> r.firma;
    if (v_prev ->> 'owner') is distinct from (r.base ->> 'owner') then
      v_stop := v_stop || format('%s: owner pegado=%s, baseline conocido=%s; ', r.firma, v_prev ->> 'owner', r.base ->> 'owner');
    end if;
    if (v_prev ->> 'security_definer')::boolean is distinct from (r.base ->> 'security_definer')::boolean then
      v_stop := v_stop || format('%s: security_definer pegado distinto del baseline conocido; ', r.firma);
    end if;
    if (v_prev ->> 'md5_cuerpo') is distinct from (r.base ->> 'md5_cuerpo') then
      v_stop := v_stop || format('%s: md5_cuerpo pegado distinto del baseline conocido; ', r.firma);
    end if;
    if (v_prev ->> 'search_path_fijado')::boolean is distinct from (r.base ->> 'search_path_fijado')::boolean then
      v_stop := v_stop || format('%s: search_path_fijado pegado distinto del baseline conocido; ', r.firma);
    end if;
    if (v_prev -> 'proacl_raw') is distinct from (r.base -> 'acl_canonica') then
      v_stop := v_stop || format('%s: proacl_raw pegado (%s) no es el ACL PRE conocido de produccion (%s); ',
                   r.firma, v_prev -> 'proacl_raw', r.base -> 'acl_canonica');
    end if;
    if (v_prev -> 'triggers') is distinct from (r.base -> 'triggers') then
      v_stop := v_stop || format('%s: triggers pegados (%s) distintos del baseline conocido (%s); ',
                   r.firma, v_prev -> 'triggers', r.base -> 'triggers');
    end if;
  end loop;
  if v_stop <> '' then
    raise exception 'RCV-34 02 REV2 STOP (el snapshot pegado no corresponde al baseline PRE conocido de 01, nada modificado): %', v_stop;
  end if;

  -- E + F: estado ACTUAL de las 3 funciones: todo debe seguir igual al snapshot pegado salvo el
  -- ACL, y el ACL actual debe ser exactamente el POST-01 esperado (no ya revertido, no alterado) ─
  for r in
    select p.oid, p.oid::regprocedure::text as firma,
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

    -- E: todo salvo el ACL debe seguir identico al snapshot pegado
    if r.owner is distinct from (v_prev ->> 'owner') then
      v_stop := v_stop || format('%s: owner cambio desde 01 (actual=%s, snapshot=%s); ', r.firma, r.owner, v_prev ->> 'owner');
    end if;
    if r.retorna_trigger is distinct from (v_prev ->> 'retorna_trigger')::boolean then
      v_stop := v_stop || format('%s: dejo de retornar trigger desde 01; ', r.firma);
    end if;
    if r.security_definer is distinct from (v_prev ->> 'security_definer')::boolean then
      v_stop := v_stop || format('%s: security_definer cambio desde 01; ', r.firma);
    end if;
    if r.md5_cuerpo is distinct from (v_prev ->> 'md5_cuerpo') then
      v_stop := v_stop || format('%s: el cuerpo cambio desde 01 (actual=%s, snapshot=%s); ', r.firma, r.md5_cuerpo, v_prev ->> 'md5_cuerpo');
    end if;
    if r.search_path_fijado is distinct from (v_prev ->> 'search_path_fijado')::boolean then
      v_stop := v_stop || format('%s: search_path_fijado cambio desde 01; ', r.firma);
    end if;
    if r.proconfig_raw is distinct from (v_prev -> 'proconfig_raw') then
      v_stop := v_stop || format('%s: proconfig cambio desde 01 (actual=%s, snapshot=%s); ', r.firma, r.proconfig_raw, v_prev -> 'proconfig_raw');
    end if;
    if r.triggers is distinct from (v_prev -> 'triggers') then
      v_stop := v_stop || format('%s: el conjunto de triggers cambio desde 01 (actual=%s, snapshot=%s); ', r.firma, r.triggers, v_prev -> 'triggers');
    end if;

    -- F: el ACL ACTUAL debe ser exactamente el POST-01 esperado (PUBLIC y anon revocados por 01,
    -- authenticated y service_role concedidos); si no, no se revierte a ciegas
    if r.public_execute or r.anon or not r.authenticated or not r.service_role then
      v_stop := v_stop || format('%s: el ACL efectivo actual no es el POST-01 esperado (PUBLIC=%s anon=%s authenticated=%s service_role=%s); ',
                    r.firma, r.public_execute, r.anon, r.authenticated, r.service_role);
    end if;
    if r.proacl_es_null then
      v_stop := v_stop || format('%s: proacl actual es NULL; ', r.firma);
    elsif r.proacl_raw is distinct from v_acl_post_esperada then
      v_stop := v_stop || format('%s: el ACL RAW actual (%s) no es exactamente el POST-01 esperado (%s); ',
                   r.firma, r.proacl_raw, v_acl_post_esperada);
    end if;
  end loop;

  if v_stop <> '' then
    raise exception 'RCV-34 02 REV2 STOP (guard antes de restaurar, nada modificado): %', v_stop;
  end if;

  -- snapshot validado, disponible para la verificacion posterior (transaction-local)
  perform set_config('rcv34.estado_previo_validado', v_previo::text, true);
  raise notice 'RCV-34 02 REV2: guard OK (snapshot valido, coincide con baseline conocido, estado actual es exactamente el POST-01 esperado). Procediendo a restaurar ACL.';
end $$;

-- ── H: unica restauracion de esta migracion, hardcodeada; nunca se ejecutan roles del JSON ─────
revoke execute on function public.mecanico_solo_avance_tecnico() from public, anon, authenticated, service_role;
grant  execute on function public.mecanico_solo_avance_tecnico() to public, anon, authenticated, service_role;

revoke execute on function public.proteger_caja_ligada() from public, anon, authenticated, service_role;
grant  execute on function public.proteger_caja_ligada() to public, anon, authenticated, service_role;

revoke execute on function public.proteger_rol_perfil() from public, anon, authenticated, service_role;
grant  execute on function public.proteger_rol_perfil() to anon, authenticated, service_role;

-- ── I + J: verificacion final; si algo no volvio exactamente al PRE, revierte toda la migracion ──
do $$
declare
  v_previo jsonb := current_setting('rcv34.estado_previo_validado')::jsonb;
  v_oid_mec  regprocedure := to_regprocedure('public.mecanico_solo_avance_tecnico()');
  v_oid_caja regprocedure := to_regprocedure('public.proteger_caja_ligada()');
  v_oid_rol  regprocedure := to_regprocedure('public.proteger_rol_perfil()');
  v_fail text := '';
  v_cardinalidad int;
  v_public_esperado boolean;
  r record;
  v_prev jsonb;
begin
  select count(*) into v_cardinalidad from pg_proc p where p.oid in (v_oid_mec, v_oid_caja, v_oid_rol);
  if v_cardinalidad <> 3 then
    raise exception 'RCV-34 02 REV2 STOP (cardinalidad tras restaurar): se esperaban 3 funciones y pg_proc devolvio %', v_cardinalidad;
  end if;

  for r in
    select p.oid, p.oid::regprocedure::text as firma,
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
    v_public_esperado := (r.oid = v_oid_mec or r.oid = v_oid_caja);

    -- I: ACL efectiva y RAW deben ser EXACTAMENTE la PRE original (contra proacl_raw, no proacl)
    if r.public_execute is distinct from v_public_esperado or not r.anon or not r.authenticated or not r.service_role then
      v_fail := v_fail || format('%s: ACL efectiva tras restaurar no es la PRE esperada (PUBLIC=%s[se esperaba %s] anon=%s authenticated=%s service_role=%s); ',
                    r.firma, r.public_execute, v_public_esperado, r.anon, r.authenticated, r.service_role);
    end if;
    if r.proacl_es_null then
      v_fail := v_fail || format('%s: proacl quedo NULL tras restaurar; ', r.firma);
    elsif r.proacl_raw is distinct from (v_prev -> 'proacl_raw') then
      v_fail := v_fail || format('%s: ACL RAW restaurada (%s) no coincide aclitem por aclitem con la previa (%s); ',
                   r.firma, r.proacl_raw, v_prev -> 'proacl_raw');
    end if;

    -- J: todo lo demas debe seguir identico al snapshot pegado
    if r.owner is distinct from (v_prev ->> 'owner') then
      v_fail := v_fail || format('%s: owner cambio (actual=%s, snapshot=%s); ', r.firma, r.owner, v_prev ->> 'owner');
    end if;
    if r.retorna_trigger is distinct from (v_prev ->> 'retorna_trigger')::boolean then
      v_fail := v_fail || format('%s: dejo de retornar trigger; ', r.firma);
    end if;
    if r.security_definer is distinct from (v_prev ->> 'security_definer')::boolean then
      v_fail := v_fail || format('%s: security_definer cambio; ', r.firma);
    end if;
    if r.md5_cuerpo is distinct from (v_prev ->> 'md5_cuerpo') then
      v_fail := v_fail || format('%s: el cuerpo cambio durante el rollback; ', r.firma);
    end if;
    if r.search_path_fijado is distinct from (v_prev ->> 'search_path_fijado')::boolean then
      v_fail := v_fail || format('%s: search_path_fijado cambio; ', r.firma);
    end if;
    if r.proconfig_raw is distinct from (v_prev -> 'proconfig_raw') then
      v_fail := v_fail || format('%s: proconfig cambio (actual=%s, snapshot=%s); ', r.firma, r.proconfig_raw, v_prev -> 'proconfig_raw');
    end if;
    if r.triggers is distinct from (v_prev -> 'triggers') then
      v_fail := v_fail || format('%s: el conjunto de triggers cambio (actual=%s, snapshot=%s); ', r.firma, r.triggers, v_prev -> 'triggers');
    end if;
  end loop;

  if v_fail <> '' then
    raise exception 'RCV-34 02 REV2 STOP (postcondiciones tras restaurar, se revierte toda la migracion): %', v_fail;
  end if;
  raise notice 'RCV-34 02 REV2: ACL restaurada exactamente al estado PRE-01 en las 3 funciones (aclitem por aclitem), resto de atributos identico. 0 filas de negocio tocadas.';
end $$;

select 'RCV-34 02 REV2: rollback completado y verificado.' as resultado;

commit;
