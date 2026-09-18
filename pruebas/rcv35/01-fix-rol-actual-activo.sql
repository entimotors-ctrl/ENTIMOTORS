-- RCV-35 - 01-fix-rol-actual-activo.sql - PREPARADO / NO EJECUTADO
-- NO EJECUTAR SIN AUTORIZACION EXPLICITA DE WILKIN.
--
-- Hallazgo: SECURITY_REGRESSION_CONFIRMED. La public.rol_actual() de produccion dejo de comprobar
-- public.perfiles.activo, asi que una sesion/JWT todavia valido conserva autorizacion por rol despues
-- de una baja (es_admin, puede_cobrar, es_equipo, es_desarrollador, ve_todo_el_taller,
-- es_mecanico_activo y, por ellas, RPC SECURITY DEFINER y politicas RLS).
--
-- UNICO cambio funcional: rol_actual() vuelve a exigir "AND p.activo". Se conservan del estado actual de
-- produccion el COALESCE(..., '') (null-safe) y el LIMIT 1. Resultado esperado:
--   perfil activo    -> su rol          perfil inactivo -> ''
--   sin perfil       -> ''              auth.uid() NULL -> ''
--
-- Lo que este archivo puede modificar: public.rol_actual() y su ACL. Nada mas: ninguna tabla, fila,
-- trigger, politica, otra funcion, owner ni default privilege.
--
-- Diseno: una sola transaccion. PRECONDICIONES exactas contra pg_catalog (si algo no coincide, RAISE
-- EXCEPTION antes de tocar nada) -> CREATE OR REPLACE -> ACL explicito -> POSTCONDICIONES (si algo no
-- queda como se espera, RAISE EXCEPTION y se revierte todo) -> resultado JSON -> COMMIT.
-- No es re-ejecutable: tras aplicarse, el md5 del cuerpo ya no es el esperado y las precondiciones
-- fallan cerradas. El md5 POSTERIOR no se fija aqui: lo autoritativo es la logica, los atributos y la
-- ACL. El md5 real se captura despues con 03-verificacion-post-fix-readonly.sql.
-- Donde: Supabase -> SQL Editor del proyecto de produccion -> pegar completo -> Run.
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

-- PRECONDICIONES ------------------------------------------------------------------------------
DO $pre$
DECLARE
  -- md5(prosrc) medido en produccion el 2026-09-18 (cuerpo con saltos CRLF): es el estado que se reemplaza.
  c_md5_esperado constant text := '527f940b66f3c7b88b746dc3a676bdb9';
  v_n int;
  v_oid oid;
  r record;
  v_activo_bool boolean;
  v_fail text := '';
BEGIN
  -- exactamente UNA funcion con ese nombre en public, y con la firma exacta rol_actual()
  SELECT count(*) INTO v_n
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rol_actual';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'RCV-35 01 STOP (precondiciones, nada modificado): se esperaba exactamente 1 funcion public.rol_actual y hay %', v_n;
  END IF;
  v_oid := to_regprocedure('public.rol_actual()');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'RCV-35 01 STOP (precondiciones, nada modificado): la unica public.rol_actual no tiene la firma exacta rol_actual()';
  END IF;

  SELECT pg_get_userbyid(p.proowner) AS propietario,
         p.prorettype::regtype::text AS retorno,
         l.lanname::text AS lenguaje,
         p.provolatile::text AS volatilidad,
         p.prosecdef AS secdef,
         p.proconfig AS config,
         p.prokind::text AS prokind,
         p.pronargs AS nargs,
         p.proretset AS retset,
         p.proisstrict AS estricta,
         p.proleakproof AS leakproof,
         p.proparallel::text AS paralelo,
         p.procost AS costo,
         p.prorows AS filas,
         md5(p.prosrc) AS md5_cuerpo,
         EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_execute,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_execute,
         pg_has_role(current_user, p.proowner, 'MEMBER') AS puedo_alterar
    INTO r
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = v_oid;

  IF r.propietario IS DISTINCT FROM 'postgres' THEN v_fail := v_fail || format('owner=%s (se esperaba postgres); ', r.propietario); END IF;
  IF r.retorno IS DISTINCT FROM 'text' THEN v_fail := v_fail || format('retorno=%s (se esperaba text); ', r.retorno); END IF;
  IF r.lenguaje IS DISTINCT FROM 'sql' THEN v_fail := v_fail || format('lenguaje=%s (se esperaba sql); ', r.lenguaje); END IF;
  IF r.volatilidad IS DISTINCT FROM 's' THEN v_fail := v_fail || format('volatilidad=%s (se esperaba s = STABLE); ', r.volatilidad); END IF;
  IF r.secdef IS DISTINCT FROM true THEN v_fail := v_fail || 'no es SECURITY DEFINER; '; END IF;
  IF r.config IS DISTINCT FROM ARRAY['search_path=public']::text[] THEN
    v_fail := v_fail || format('proconfig=%s (se esperaba {search_path=public}); ', r.config);
  END IF;
  -- atributos que CREATE OR REPLACE restablece si no se indican: deben estar ya en su valor por defecto
  IF r.prokind IS DISTINCT FROM 'f' OR r.nargs <> 0 OR r.retset OR r.estricta OR r.leakproof
     OR r.paralelo IS DISTINCT FROM 'u' OR r.costo <> 100 OR r.filas <> 0 THEN
    v_fail := v_fail || format('atributos secundarios distintos de los esperados (prokind=%s nargs=%s retset=%s strict=%s leakproof=%s parallel=%s cost=%s rows=%s); ',
                r.prokind, r.nargs, r.retset, r.estricta, r.leakproof, r.paralelo, r.costo, r.filas);
  END IF;
  IF r.md5_cuerpo IS DISTINCT FROM c_md5_esperado THEN
    v_fail := v_fail || format('md5(prosrc)=%s (se esperaba %s: el cuerpo actual no es el medido); ', r.md5_cuerpo, c_md5_esperado);
  END IF;
  IF r.public_execute THEN v_fail := v_fail || 'PUBLIC tiene EXECUTE (se esperaba false); '; END IF;
  IF r.anon_execute THEN v_fail := v_fail || 'anon tiene EXECUTE (se esperaba false); '; END IF;
  IF NOT r.auth_execute THEN v_fail := v_fail || 'authenticated NO tiene EXECUTE (se esperaba true); '; END IF;
  IF NOT r.svc_execute THEN v_fail := v_fail || 'service_role NO tiene EXECUTE (se esperaba true); '; END IF;
  IF NOT r.puedo_alterar THEN v_fail := v_fail || format('la sesion (%s) no es miembro del owner de la funcion; ', current_user); END IF;

  -- la tabla y la columna que el nuevo cuerpo lee: solo catalogo, ninguna fila
  IF to_regclass('public.perfiles') IS NULL THEN
    v_fail := v_fail || 'public.perfiles no existe; ';
  ELSE
    SELECT (a.atttypid = 'boolean'::regtype) INTO v_activo_bool
      FROM pg_attribute a
     WHERE a.attrelid = 'public.perfiles'::regclass
       AND a.attname = 'activo' AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_activo_bool IS NULL THEN
      v_fail := v_fail || 'no existe la columna public.perfiles.activo; ';
    ELSIF NOT v_activo_bool THEN
      v_fail := v_fail || 'public.perfiles.activo no es boolean; ';
    END IF;
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'RCV-35 01 STOP (precondiciones, nada modificado): %', v_fail;
  END IF;

  -- estado previo para el resultado final y para comprobar que NINGUNA otra funcion de public cambia
  PERFORM set_config('rcv35.md5_pre', r.md5_cuerpo, true);
  PERFORM set_config('rcv35.otras_pre',
    (SELECT md5(COALESCE(string_agg(x.p_firma || ':' || x.p_owner || ':' || x.p_md5 || ':' || x.p_acl, '|' ORDER BY x.p_firma), ''))
       FROM (SELECT p.oid::regprocedure::text AS p_firma,
                    pg_get_userbyid(p.proowner) AS p_owner,
                    md5(p.prosrc) AS p_md5,
                    COALESCE(p.proacl::text, '-') AS p_acl
               FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> v_oid) x),
    true);

  RAISE NOTICE 'RCV-35 01: precondiciones OK (firma unica, owner postgres, text/sql/STABLE/SECURITY DEFINER, search_path=public, md5 actual esperado, ACL PUBLIC=f anon=f authenticated=t service_role=t, perfiles.activo boolean). 0 filas leidas.';
END
$pre$;

-- CAMBIO UNICO --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rol_actual()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (
      SELECT p.rol
      FROM public.perfiles p
      WHERE p.id = auth.uid()
        AND p.activo
      LIMIT 1
    ),
    ''
  );
$function$;

-- ACL EXPLICITO (sin GRANT ALL, sin cambiar owner) --------------------------------------------
REVOKE EXECUTE ON FUNCTION public.rol_actual() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rol_actual() TO authenticated, service_role;

-- POSTCONDICIONES (fallan cerradas: RAISE EXCEPTION revierte todo) ----------------------------
DO $post$
DECLARE
  -- forma normalizada del cuerpo esperado: minusculas y sin ningun espacio ni salto de linea. Asi la
  -- comprobacion demuestra la LOGICA y no depende de como el SQL Editor represente los saltos.
  c_cuerpo_norm constant text := $esp$selectcoalesce((selectp.rolfrompublic.perfilespwherep.id=auth.uid()andp.activolimit1),'');$esp$;
  v_n int;
  v_oid oid;
  v_norm text;
  v_otras_post text;
  r record;
  v_fail text := '';
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rol_actual';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'RCV-35 01 STOP (postcondiciones, se revierte todo): tras el cambio hay % funciones public.rol_actual', v_n;
  END IF;
  v_oid := to_regprocedure('public.rol_actual()');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'RCV-35 01 STOP (postcondiciones, se revierte todo): public.rol_actual() ya no existe con la firma exacta';
  END IF;

  SELECT pg_get_userbyid(p.proowner) AS propietario,
         p.prorettype::regtype::text AS retorno,
         l.lanname::text AS lenguaje,
         p.provolatile::text AS volatilidad,
         p.prosecdef AS secdef,
         p.proconfig AS config,
         p.prokind::text AS prokind,
         p.pronargs AS nargs,
         p.proretset AS retset,
         p.proisstrict AS estricta,
         p.proleakproof AS leakproof,
         p.proparallel::text AS paralelo,
         p.procost AS costo,
         p.prorows AS filas,
         regexp_replace(lower(p.prosrc), '\s+', '', 'g') AS cuerpo_norm,
         EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_execute,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_execute
    INTO r
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = v_oid;

  IF r.propietario IS DISTINCT FROM 'postgres' THEN v_fail := v_fail || format('owner=%s; ', r.propietario); END IF;
  IF r.retorno IS DISTINCT FROM 'text' THEN v_fail := v_fail || format('retorno=%s; ', r.retorno); END IF;
  IF r.lenguaje IS DISTINCT FROM 'sql' THEN v_fail := v_fail || format('lenguaje=%s; ', r.lenguaje); END IF;
  IF r.volatilidad IS DISTINCT FROM 's' THEN v_fail := v_fail || format('volatilidad=%s; ', r.volatilidad); END IF;
  IF r.secdef IS DISTINCT FROM true THEN v_fail := v_fail || 'ya no es SECURITY DEFINER; '; END IF;
  IF r.config IS DISTINCT FROM ARRAY['search_path=public']::text[] THEN v_fail := v_fail || format('proconfig=%s; ', r.config); END IF;
  IF r.prokind IS DISTINCT FROM 'f' OR r.nargs <> 0 OR r.retset OR r.estricta OR r.leakproof
     OR r.paralelo IS DISTINCT FROM 'u' OR r.costo <> 100 OR r.filas <> 0 THEN
    v_fail := v_fail || 'atributos secundarios cambiaron; ';
  END IF;
  IF r.public_execute THEN v_fail := v_fail || 'PUBLIC tiene EXECUTE; '; END IF;
  IF r.anon_execute THEN v_fail := v_fail || 'anon tiene EXECUTE; '; END IF;
  IF NOT r.auth_execute THEN v_fail := v_fail || 'authenticated no tiene EXECUTE; '; END IF;
  IF NOT r.svc_execute THEN v_fail := v_fail || 'service_role no tiene EXECUTE; '; END IF;

  -- logica del cuerpo: debe contener el filtro y ser EXACTAMENTE la logica esperada (falla cerrado si
  -- falta AND p.activo o si aparece cualquier otra logica)
  v_norm := r.cuerpo_norm;
  IF position('andp.activo' in v_norm) = 0 THEN
    v_fail := v_fail || 'el cuerpo NO contiene el filtro AND p.activo; ';
  END IF;
  IF position('wherep.id=auth.uid()andp.activolimit1' in v_norm) = 0 THEN
    v_fail := v_fail || 'el cuerpo no contiene WHERE p.id = auth.uid() AND p.activo LIMIT 1; ';
  END IF;
  IF right(v_norm, 4) IS DISTINCT FROM $q$'');$q$ THEN
    v_fail := v_fail || 'el cuerpo no termina en el fallback vacio; ';
  END IF;
  IF v_norm IS DISTINCT FROM c_cuerpo_norm THEN
    v_fail := v_fail || format('logica inesperada en el cuerpo (normalizado=%s); ', v_norm);
  END IF;

  -- ninguna otra funcion de public cambio (cuerpo, owner o ACL)
  SELECT md5(COALESCE(string_agg(x.p_firma || ':' || x.p_owner || ':' || x.p_md5 || ':' || x.p_acl, '|' ORDER BY x.p_firma), ''))
    INTO v_otras_post
    FROM (SELECT p.oid::regprocedure::text AS p_firma,
                 pg_get_userbyid(p.proowner) AS p_owner,
                 md5(p.prosrc) AS p_md5,
                 COALESCE(p.proacl::text, '-') AS p_acl
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> v_oid) x;
  IF v_otras_post IS DISTINCT FROM current_setting('rcv35.otras_pre') THEN
    v_fail := v_fail || 'otra funcion de public cambio durante la migracion; ';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'RCV-35 01 STOP (postcondiciones, se revierte todo): %', v_fail;
  END IF;
  RAISE NOTICE 'RCV-35 01: postcondiciones OK (atributos y ACL exactos, logica con AND p.activo, ninguna otra funcion de public cambio). 0 filas de negocio tocadas.';
END
$post$;

-- RESULTADO ESTRUCTURADO (copiar y devolver) --------------------------------------------------
SELECT jsonb_pretty(jsonb_build_object(
  'formato', 'rcv35-01-resultado/1',
  'firma', p.oid::regprocedure::text,
  'md5_pre', current_setting('rcv35.md5_pre'),
  'md5_post', md5(p.prosrc),
  'owner', pg_get_userbyid(p.proowner),
  'security_definer', p.prosecdef,
  'search_path_fijado', (p.proconfig IS NOT NULL AND 'search_path=public' = ANY (p.proconfig)),
  'PUBLIC_execute', EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                             WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
  'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
  'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
  'service_role_execute', has_function_privilege('service_role', p.oid, 'EXECUTE'),
  'contiene_filtro_activo', position('andp.activo' in regexp_replace(lower(p.prosrc), '\s+', '', 'g')) > 0,
  'todo_ok', (
        pg_get_userbyid(p.proowner) = 'postgres'
    AND p.prosecdef
    AND p.proconfig = ARRAY['search_path=public']::text[]
    AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    AND regexp_replace(lower(p.prosrc), '\s+', '', 'g') = $esp$selectcoalesce((selectp.rolfrompublic.perfilespwherep.id=auth.uid()andp.activolimit1),'');$esp$
  )
)) AS rcv35_01_resultado
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.rol_actual()');

COMMIT;
