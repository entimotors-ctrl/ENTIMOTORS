-- RCV-34 - entimotors-rcv34-source-sync.sql - SOURCE-SYNC CANONICO (incorpora RCV-35) - PREPARADO / NO EJECUTADO
-- NO EJECUTAR SIN AUTORIZACION EXPLICITA DE WILKIN.
--
-- QUE ES. La representacion en codigo de las 17 funciones ACTIVAS de "public" en produccion y de los 5
-- triggers que las usan, tal como estan el 2026-09-18 DESPUES de aplicar RCV-35. El nombre del archivo se
-- mantiene por continuidad de la reconciliacion RCV-34; su rol_actual() ya incorpora RCV-35.
--
-- DE DONDE SALE CADA DEFINICION (nada se reconstruyo ni se normalizo: LF, CRLF, espacios, comentarios y
-- mayusculas tal cual).
--   * 16 funciones: definicion completa (pg_get_functiondef) capturada byte a byte de produccion el
--     2026-09-18 y validada en 4E-B3R (md5(prosrc) 16/16 = pruebas/rcv34/produccion-funciones-20260918.json).
--   * rol_actual(): definicion POST-RCV-35 verificada en produccion con RCV-35 03 (md5(prosrc)
--     e66ee46e01d3df511ee5bd4d0f2a178a, 158 bytes, CR 0, LF 11). NO es el cuerpo anterior (md5 527f940b...):
--     ese estado perdio "AND p.activo" (regresion de seguridad confirmada) y este archivo no puede
--     reinstalarlo: las POSTCONDICIONES exigen el md5 POST-RCV-35 y el filtro "AND p.activo".
--
-- ADVERTENCIA DE FINES DE LINEA. 6 cuerpos (es_admin, es_desarrollador, es_equipo, estado_tecnico,
-- proteger_rol_perfil, puede_cobrar) tienen saltos CRLF reales en produccion, por eso este archivo mezcla LF
-- y CRLF a proposito. No lo normalices: git con text=auto/autocrlf, un editor o el portapapeles del SQL Editor
-- pueden convertirlos. Cualquier conversion no rompe la logica, pero cambia el md5 de esas funciones; el
-- resultado final informa cuantos md5 coinciden con produccion ("md5_coinciden") sin bloquear la ejecucion.
-- El unico md5 que bloquea es el de rol_actual() (no tiene CR).
--
-- QUE PUEDE MODIFICAR. Las 17 funciones (CREATE OR REPLACE, mismos atributos que produccion), su ACL de
-- EXECUTE y, solo si faltan, los 5 triggers. NADA MAS: ninguna tabla, fila, politica RLS, owner ni default
-- privilege, y ningun DROP. Contra produccion, si todo esta ya como aqui: las funciones se reemplazan por
-- cuerpos identicos (rol_actual() ya esta en su estado POST-RCV-35) y los triggers solo se validan. Lo unico
-- que puede cambiar es la ACL: crear_perfil_al_registrarse() queda solo para service_role (se le revoca
-- authenticated si lo tuviera; el trigger no lo necesita, PostgreSQL solo comprueba EXECUTE al crearlo).
--
-- QUE NO INCLUYE. Las 2 funciones del source historico que NO existen en produccion
-- (SOURCE_ONLY_NOT_DEPLOYED; su destino se decide en otra fase) ni ninguna funcion extra.
--
-- ACL FINAL. PUBLIC y anon: sin EXECUTE (17/17). authenticated: si (16/17), salvo
-- crear_perfil_al_registrarse(). service_role: si (17/17). Sin GRANT ALL, sin cambiar owner.
--
-- TRIGGERS (no se hace DROP: si existen se validan tabla, timing, evento, nivel de fila, funcion, activo y
-- sin WHEN ni lista de columnas; si existe uno incompatible, RAISE EXCEPTION y se revierte todo):
--   auth.users              al_crear_usuario              AFTER  INSERT (fila) -> crear_perfil_al_registrarse()
--   public.caja_movimientos no_borrar_caja_ligada         BEFORE DELETE (fila) -> proteger_caja_ligada()
--   public.citas            citas_mecanico_avance         BEFORE UPDATE (fila) -> mecanico_solo_avance_tecnico()
--   public.ordenes          ordenes_mecanico_avance       BEFORE UPDATE (fila) -> mecanico_solo_avance_tecnico()
--   public.perfiles         proteger_rol_perfil_trigger   BEFORE UPDATE (fila) -> proteger_rol_perfil()
-- Timing y evento de los 4 ultimos: medidos en produccion (baseline RCV-34 01/02). El de al_crear_usuario NO
-- consta en ninguna evidencia del repositorio: AFTER INSERT es la forma que exige su funcion (inserta en
-- perfiles con new.id) y se debe confirmar en produccion antes de ejecutar.
--
-- DISENO: una sola transaccion. PRECONDICIONES -> funciones -> ACL -> triggers -> POSTCONDICIONES ->
-- resultado -> COMMIT. Cualquier RAISE EXCEPTION revierte todo. Es idempotente: una segunda ejecucion deja
-- el mismo estado.
-- Donde: psql -f (conserva los bytes) o Supabase -> SQL Editor -> pegar completo -> Run.
--
-- FINGERPRINTS md5(prosrc) EN PRODUCCION (2026-09-18; rol_actual() = POST-RCV-35):
--   rol_actual()                                                   e66ee46e01d3df511ee5bd4d0f2a178a
--   es_admin()                                                     35aa9a08ef4e9960cb333eea4939d15e
--   puede_cobrar()                                                 2c95d9a820de4ae25ec59d25cbbd1a91
--   es_equipo()                                                    635c8361317be3293aee3778a0de048d
--   es_desarrollador()                                             25a3787ce375a9a89a58266b96b732a3
--   es_mecanico_activo()                                           1b786deb21df29b40f89dca23ab776fd
--   ve_todo_el_taller()                                            80b7f166927d6559301d8507c397a243
--   mi_cliente(uuid)                                               aeee991cda291df054c2924d1e9f3cdf
--   mi_moto(uuid)                                                  235499aeafbd8379d6333b7e51edb6c2
--   crear_perfil_al_registrarse()                                  f3873b6473a2831c8046a29b97947ea3
--   proteger_caja_ligada()                                         4b1a0e352c4eae22efcbb139ae72a725
--   proteger_rol_perfil()                                          5bcd1237d7e6714293cf4fc332e08667
--   mecanico_solo_avance_tecnico()                                 5c9d8db5084b0a4e881948d9a920462b
--   registrar_venta(uuid,text,text,numeric,jsonb,integer,text)     ae8ee6c6d7c066d4d544ff4e9ab5147b
--   registrar_abono(uuid,numeric,text,text)                        6dee1802d5cf45cd4d8d91b140e2cadd
--   estadisticas_tecnicas()                                        86948fdcaf03939a1d0929004cd9c730
--   estado_tecnico()                                               8cab17a837ec35d46c8575befd53e85a
BEGIN;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

-- PRECONDICIONES ------------------------------------------------------------------------------
-- Solo catalogo: ninguna fila leida ni escrita.
DO $pre$
DECLARE
  -- fuente unica de las 17 funciones canonicas y de su md5(prosrc) en produccion. Las POSTCONDICIONES
  -- leen esta misma lista.
  v_esperado constant jsonb := $md5$
  {
    "rol_actual()": "e66ee46e01d3df511ee5bd4d0f2a178a",
    "es_admin()": "35aa9a08ef4e9960cb333eea4939d15e",
    "puede_cobrar()": "2c95d9a820de4ae25ec59d25cbbd1a91",
    "es_equipo()": "635c8361317be3293aee3778a0de048d",
    "es_desarrollador()": "25a3787ce375a9a89a58266b96b732a3",
    "es_mecanico_activo()": "1b786deb21df29b40f89dca23ab776fd",
    "ve_todo_el_taller()": "80b7f166927d6559301d8507c397a243",
    "mi_cliente(uuid)": "aeee991cda291df054c2924d1e9f3cdf",
    "mi_moto(uuid)": "235499aeafbd8379d6333b7e51edb6c2",
    "crear_perfil_al_registrarse()": "f3873b6473a2831c8046a29b97947ea3",
    "proteger_caja_ligada()": "4b1a0e352c4eae22efcbb139ae72a725",
    "proteger_rol_perfil()": "5bcd1237d7e6714293cf4fc332e08667",
    "mecanico_solo_avance_tecnico()": "5c9d8db5084b0a4e881948d9a920462b",
    "registrar_venta(uuid,text,text,numeric,jsonb,integer,text)": "ae8ee6c6d7c066d4d544ff4e9ab5147b",
    "registrar_abono(uuid,numeric,text,text)": "6dee1802d5cf45cd4d8d91b140e2cadd",
    "estadisticas_tecnicas()": "86948fdcaf03939a1d0929004cd9c730",
    "estado_tecnico()": "8cab17a837ec35d46c8575befd53e85a"
  }
  $md5$::jsonb;
  v_fail text := '';
  v_tab text;
  v_relkind text;
  v_activo_bool boolean;
  r record;
BEGIN
  FOREACH v_tab IN ARRAY ARRAY['auth.users', 'public.perfiles', 'public.caja_movimientos', 'public.citas', 'public.ordenes'] LOOP
    SELECT c.relkind::text INTO v_relkind FROM pg_class c WHERE c.oid = to_regclass(v_tab);
    IF v_relkind IS NULL THEN
      v_fail := v_fail || format('no existe %s; ', v_tab);
    ELSIF v_relkind NOT IN ('r', 'p') THEN
      v_fail := v_fail || format('%s no es una tabla (relkind=%s); ', v_tab, v_relkind);
    END IF;
  END LOOP;

  -- public.perfiles.activo: existe y es boolean (lo lee rol_actual())
  IF to_regclass('public.perfiles') IS NOT NULL THEN
    SELECT (a.atttypid = 'boolean'::regtype) INTO v_activo_bool
      FROM pg_attribute a
     WHERE a.attrelid = to_regclass('public.perfiles')
       AND a.attname = 'activo' AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_activo_bool IS NULL THEN
      v_fail := v_fail || 'no existe la columna public.perfiles.activo; ';
    ELSIF NOT v_activo_bool THEN
      v_fail := v_fail || 'public.perfiles.activo no es boolean; ';
    END IF;
  END IF;

  -- sobrecargas inesperadas: una funcion de public con el nombre de una de las 17 pero otra firma
  -- (su ACL no la cerraria este archivo)
  FOR r IN
    SELECT p.oid::regprocedure::text AS firma
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = ANY (ARRAY(SELECT split_part(k, '(', 1) FROM jsonb_object_keys(v_esperado) AS k))
       AND NOT (p.oid::regprocedure::text = ANY (ARRAY(SELECT jsonb_object_keys(v_esperado))))
  LOOP
    v_fail := v_fail || format('sobrecarga inesperada public.%s; ', r.firma);
  END LOOP;

  -- las que ya existen: la sesion debe poder reemplazarlas (miembro del owner)
  FOR r IN
    SELECT p.oid::regprocedure::text AS firma,
           pg_get_userbyid(p.proowner) AS propietario,
           pg_has_role(current_user, p.proowner, 'MEMBER') AS puedo
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.oid::regprocedure::text = ANY (ARRAY(SELECT jsonb_object_keys(v_esperado)))
  LOOP
    IF NOT r.puedo THEN
      v_fail := v_fail || format('la sesion (%s) no es miembro del owner (%s) de public.%s; ', current_user, r.propietario, r.firma);
    END IF;
  END LOOP;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'RCV-34 SYNC STOP (precondiciones, nada modificado): %', v_fail;
  END IF;

  -- estado previo para comprobar despues que NADA mas cambio: default privileges y las demas funciones de public
  PERFORM set_config('rcv34sync.esperado', v_esperado::text, true);
  PERFORM set_config('rcv34sync.defacl_pre',
    (SELECT md5(COALESCE(string_agg(d.defaclrole::regrole::text || ':' || d.defaclnamespace::regnamespace::text || ':' || d.defaclobjtype::text || ':' || d.defaclacl::text, '|' ORDER BY d.oid), ''))
       FROM pg_default_acl d),
    true);
  PERFORM set_config('rcv34sync.otras_pre',
    (SELECT md5(COALESCE(string_agg(x.p_firma || ':' || x.p_owner || ':' || x.p_md5 || ':' || x.p_acl, '|' ORDER BY x.p_firma), ''))
       FROM (SELECT p.oid::regprocedure::text AS p_firma,
                    pg_get_userbyid(p.proowner) AS p_owner,
                    md5(p.prosrc) AS p_md5,
                    COALESCE(p.proacl::text, '-') AS p_acl
               FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace
                AND NOT (p.oid::regprocedure::text = ANY (ARRAY(SELECT jsonb_object_keys(v_esperado))))) x),
    true);

  RAISE NOTICE 'RCV-34 SYNC: precondiciones OK (auth.users, public.perfiles, caja_movimientos, citas, ordenes; perfiles.activo boolean; sin sobrecargas; owners reemplazables). 0 filas leidas.';
END
$pre$;

-- FUNCIONES (17) -------------------------------------------------------------------------------
-- Orden por dependencias: las de LANGUAGE sql se validan al crearlas (rol_actual() primero).
-- 01/17 public.rol_actual() [POST-RCV-35] md5(prosrc)=e66ee46e01d3df511ee5bd4d0f2a178a bytes=158 CR=0 LF=11
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

-- 02/17 public.es_admin() [produccion 2026-09-18] md5(prosrc)=35aa9a08ef4e9960cb333eea4939d15e bytes=43 CR=2 LF=2
CREATE OR REPLACE FUNCTION public.es_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.rol_actual() = 'admin';
$function$;

-- 03/17 public.puede_cobrar() [produccion 2026-09-18] md5(prosrc)=2c95d9a820de4ae25ec59d25cbbd1a91 bytes=71 CR=5 LF=5
CREATE OR REPLACE FUNCTION public.puede_cobrar()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.rol_actual() IN (
    'admin',
    'cajero'
  );
$function$;

-- 04/17 public.es_equipo() [produccion 2026-09-18] md5(prosrc)=635c8361317be3293aee3778a0de048d bytes=88 CR=6 LF=6
CREATE OR REPLACE FUNCTION public.es_equipo()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.rol_actual() IN (
    'admin',
    'mecanico',
    'cajero'
  );
$function$;

-- 05/17 public.es_desarrollador() [produccion 2026-09-18] md5(prosrc)=25a3787ce375a9a89a58266b96b732a3 bytes=51 CR=2 LF=2
CREATE OR REPLACE FUNCTION public.es_desarrollador()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.rol_actual() = 'desarrollador';
$function$;

-- 06/17 public.es_mecanico_activo() [produccion 2026-09-18] md5(prosrc)=1b786deb21df29b40f89dca23ab776fd bytes=60 CR=0 LF=2
CREATE OR REPLACE FUNCTION public.es_mecanico_activo()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(public.rol_actual() = 'mecanico', false)
$function$;

-- 07/17 public.ve_todo_el_taller() [produccion 2026-09-18] md5(prosrc)=80b7f166927d6559301d8507c397a243 bytes=69 CR=0 LF=2
CREATE OR REPLACE FUNCTION public.ve_todo_el_taller()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(public.rol_actual() in ('admin','cajero'), false)
$function$;

-- 08/17 public.mi_cliente(uuid) [produccion 2026-09-18] md5(prosrc)=aeee991cda291df054c2924d1e9f3cdf bytes=299 CR=0 LF=6
CREATE OR REPLACE FUNCTION public.mi_cliente(p_cliente uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.es_mecanico_activo()
     and (exists (select 1 from public.ordenes o
                   where o.cliente_id = p_cliente and o.mecanico_id = auth.uid())
       or exists (select 1 from public.citas c
                   where c.cliente_id = p_cliente and c.mecanico_id = auth.uid()))
$function$;

-- 09/17 public.mi_moto(uuid) [produccion 2026-09-18] md5(prosrc)=235499aeafbd8379d6333b7e51edb6c2 bytes=161 CR=0 LF=4
CREATE OR REPLACE FUNCTION public.mi_moto(p_moto uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.es_mecanico_activo()
     and exists (select 1 from public.ordenes o
                  where o.moto_id = p_moto and o.mecanico_id = auth.uid())
$function$;

-- 10/17 public.crear_perfil_al_registrarse() [produccion 2026-09-18] md5(prosrc)=f3873b6473a2831c8046a29b97947ea3 bytes=257 CR=0 LF=17
CREATE OR REPLACE FUNCTION public.crear_perfil_al_registrarse()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.perfiles (
    id,
    nombre
  )
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'nombre',
      split_part(coalesce(new.email, 'usuario'), '@', 1)
    )
  )
  on conflict (id) do nothing;

  return new;
end
$function$;

-- 11/17 public.proteger_caja_ligada() [produccion 2026-09-18] md5(prosrc)=4b1a0e352c4eae22efcbb139ae72a725 bytes=299 CR=0 LF=16
CREATE OR REPLACE FUNCTION public.proteger_caja_ligada()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin

  if old.venta_id is not null
     or old.credito_id is not null
     or old.orden_id is not null
     or old.id_abono is not null then

    raise exception
      'No se puede borrar este movimiento: respalda otra operación. Deshaz la operación de origen.';

  end if;

  return old;

end
$function$;

-- 12/17 public.proteger_rol_perfil() [produccion 2026-09-18] md5(prosrc)=5bcd1237d7e6714293cf4fc332e08667 bytes=272 CR=16 LF=16
CREATE OR REPLACE FUNCTION public.proteger_rol_perfil()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN

  IF TG_OP = 'UPDATE' THEN

    IF NEW.rol IS DISTINCT FROM OLD.rol
       AND NOT public.es_admin()
    THEN
      RAISE EXCEPTION
        'No autorizado: solamente un administrador puede cambiar roles';
    END IF;

  END IF;

  RETURN NEW;
END;
$function$;

-- 13/17 public.mecanico_solo_avance_tecnico() [produccion 2026-09-18] md5(prosrc)=5c9d8db5084b0a4e881948d9a920462b bytes=4298 CR=0 LF=89
CREATE OR REPLACE FUNCTION public.mecanico_solo_avance_tecnico()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  -- Lo único que un mecánico puede mover en SU orden. Todo lo que no esté
  -- aquí queda bloqueado, incluidas las columnas que aún no existen.
  k_permitidos text[] := array[
    'estado', 'diagnostico', 'reparacion_notas', 'calidad_checklist',
    'fotos', 'km_salida', 'falla'
  ];
  -- Las 6 etapas reales de app.js (const STAGES), en su orden. No se inventa
  -- ninguna: es literalmente ese array.
  k_etapas text[] := array[
    'recibido', 'diagnostico', 'presupuesto', 'reparacion', 'calidad', 'entregado'
  ];
  v_i_old int;
  v_i_new int;
begin
  -- Solo se restringe a un mecánico REAL y de alta. Se pregunta por
  -- es_mecanico_activo() y no por `rol_actual() <> 'mecanico'` a propósito: si
  -- el actor no tiene sesión de perfil —service_role, el propietario de la
  -- tabla, una tarea de mantenimiento— rol_actual() devuelve null, y comparar
  -- null con texto da null, no false. La función coalesce a false, así que un
  -- actor sin perfil nunca se confunde con un mecánico ni queda a medio
  -- camino entre las dos ramas.
  --
  -- Esto NO amplía el acceso de nadie: quien no es mecánico sigue sujeto a
  -- RLS, que es donde están sus límites.
  if not public.es_mecanico_activo() then
    return new;
  end if;

  -- ── 0. Un trabajo entregado está cerrado.
  -- Los 7 campos técnicos son libres mientras el trabajo está en curso, y las
  -- comprobaciones de etapa solo saltan cuando `estado` cambia — así que sin
  -- esto un mecánico podría seguir reescribiendo el diagnóstico, las notas o
  -- las fotos de una orden ya entregada y cobrada, sin tocar la etapa. Una vez
  -- entregada, para él es historia.
  if old.estado = 'entregado' then
    raise exception 'Este trabajo ya fue entregado: un mecánico no puede modificarlo';
  end if;

  -- En citas el mecánico no tiene UPDATE en absoluto. La política ya lo
  -- impide; esto es el cinturón por si alguien añade una política mañana.
  if TG_TABLE_NAME = 'citas' then
    raise exception 'Un mecánico no modifica citas';
  end if;

  -- ── 1. La asignación es intocable en las dos columnas y las dos direcciones.
  -- Explícito además del fail-closed, para que el mensaje diga qué pasó y para
  -- que siga cerrado aunque alguien añada estos campos a k_permitidos.
  -- `is distinct from` y no `<>`: con `<>`, un cambio desde o hacia NULL da
  -- NULL, el if no entra y el cambio pasaría. Justo el caso de lo sin asignar.
  if new.mecanico_id is distinct from old.mecanico_id then
    raise exception 'Un mecánico no puede cambiar la asignación de un trabajo';
  end if;
  if new.mecanico is distinct from old.mecanico then
    raise exception 'Un mecánico no puede cambiar el nombre asignado al trabajo';
  end if;

  -- ── 2. Solo avance técnico, y de una etapa en una.
  -- app.js permite hoy tres movimientos: avanzar uno (btnAvanzar), retroceder
  -- uno (btnRetroceder) y saltar a cualquier etapa tocándola en el tracker
  -- (renderStageTracker). Para el mecánico solo sobrevive el primero.
  if new.estado is distinct from old.estado then
    v_i_old := array_position(k_etapas, old.estado);
    v_i_new := array_position(k_etapas, new.estado);

    -- Una etapa que no está en STAGES no la pone un mecánico, sea lo que sea.
    if v_i_old is null or v_i_new is null then
      raise exception 'Etapa desconocida: "%"', coalesce(new.estado, '(nula)');
    end if;

    -- Ni saltos ni marcha atrás: exactamente el siguiente peldaño.
    if v_i_new <> v_i_old + 1 then
      raise exception 'Un mecánico solo avanza una etapa a la vez: de "%" solo puede pasar a "%"',
        old.estado, coalesce(k_etapas[v_i_old + 1], '(ninguna)');
    end if;

    -- Y el último peldaño no es suyo: entregar y cobrar es administrativo.
    if new.estado = 'entregado' then
      raise exception 'Un mecánico no entrega ni cobra: el trabajo técnico termina en "calidad"';
    end if;
  end if;

  -- ── 3. Fail-closed: si algo fuera de la lista permitida cambió, se acabó.
  if (to_jsonb(new) - k_permitidos) is distinct from (to_jsonb(old) - k_permitidos) then
    raise exception 'Un mecánico solo puede actualizar el avance técnico (etapa, diagnóstico, notas, checklist, fotos, kilometraje y falla)';
  end if;

  return new;
end $function$;

-- 14/17 public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) [produccion 2026-09-18] md5(prosrc)=ae8ee6c6d7c066d4d544ff4e9ab5147b bytes=2853 CR=0 LF=177
CREATE OR REPLACE FUNCTION public.registrar_venta(p_cliente_id uuid, p_cliente_nombre text, p_metodo_pago text, p_efectivo numeric, p_items jsonb, p_local_id integer, p_dispositivo text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_total numeric := 0;
  it jsonb;
  v_costo numeric;
  v_stock numeric;
begin

  if not public.puede_cobrar() then
    raise exception 'Este usuario no tiene permiso para cobrar';
  end if;


  select id
  into v_id
  from public.ventas
  where dispositivo = p_dispositivo
    and local_id = p_local_id;

  if found then
    return v_id;
  end if;


  for it in
    select *
    from jsonb_array_elements(p_items)
  loop

    v_total :=
      v_total
      + (it->>'cantidad')::numeric
      * (it->>'precio')::numeric;

  end loop;


  insert into public.ventas (
    local_id,
    dispositivo,
    cliente_id,
    cliente_nombre,
    metodo_pago,
    total,
    efectivo_recibido,
    cambio
  )
  values (
    p_local_id,
    p_dispositivo,
    p_cliente_id,
    p_cliente_nombre,
    p_metodo_pago,
    v_total,
    p_efectivo,
    greatest(
      0,
      coalesce(p_efectivo,0) - v_total
    )
  )
  returning id into v_id;


  for it in
    select *
    from jsonb_array_elements(p_items)
  loop

    v_costo := 0;


    if nullif(it->>'inventario_id','') is not null then

      select
        cantidad,
        costo_compra
      into
        v_stock,
        v_costo
      from public.inventario
      where id = (it->>'inventario_id')::uuid
      for update;


      if not found then
        raise exception
          'El repuesto % ya no existe en el inventario',
          it->>'nombre';
      end if;


      if v_stock < (it->>'cantidad')::numeric then
        raise exception
          'Sin stock suficiente de % (hay %, se piden %)',
          it->>'nombre',
          v_stock,
          it->>'cantidad';
      end if;


      update public.inventario
      set cantidad =
        cantidad - (it->>'cantidad')::numeric
      where id = (it->>'inventario_id')::uuid;

    end if;


    insert into public.venta_items (
      venta_id,
      inventario_id,
      nombre,
      cantidad,
      precio,
      costo_unitario
    )
    values (
      v_id,
      nullif(it->>'inventario_id','')::uuid,
      it->>'nombre',
      (it->>'cantidad')::numeric,
      (it->>'precio')::numeric,
      coalesce(v_costo,0)
    );

  end loop;


  insert into public.caja_movimientos (
    tipo,
    categoria,
    monto,
    metodo_pago,
    descripcion,
    venta_id
  )
  values (
    'ingreso',
    'Venta mostrador',
    v_total,
    p_metodo_pago,
    'Venta #' || coalesce(p_local_id::text,'—'),
    v_id
  );


  insert into public.auditoria (
    usuario_id,
    usuario,
    rol,
    accion,
    entidad,
    entidad_id,
    detalle
  )
  values (
    auth.uid(),
    coalesce(
      (
        select nombre
        from public.perfiles
        where id = auth.uid()
      ),
      '—'
    ),
    public.rol_actual(),
    'venta',
    'ventas',
    v_id::text,
    'Total ' || v_total
  );


  return v_id;

end
$function$;

-- 15/17 public.registrar_abono(uuid,numeric,text,text) [produccion 2026-09-18] md5(prosrc)=6dee1802d5cf45cd4d8d91b140e2cadd bytes=2117 CR=0 LF=145
CREATE OR REPLACE FUNCTION public.registrar_abono(p_credito_id uuid, p_monto numeric, p_metodo text, p_id_abono text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_total numeric;
  v_abonado numeric;
  v_saldo numeric;
begin

  if not public.puede_cobrar() then
    raise exception
      'Este usuario no tiene permiso para registrar abonos';
  end if;


  if exists (
    select 1
    from public.abonos
    where id_abono = p_id_abono
  ) then

    select saldo
    into v_saldo
    from public.creditos
    where id = p_credito_id;

    return v_saldo;

  end if;


  select
    total,
    abonado
  into
    v_total,
    v_abonado
  from public.creditos
  where id = p_credito_id
  for update;


  if not found then
    raise exception 'Crédito no encontrado';
  end if;


  if p_monto <= 0 then
    raise exception
      'El abono debe ser mayor que cero';
  end if;


  if p_monto > (v_total - v_abonado) + 0.01 then
    raise exception
      'El abono (%) supera el saldo pendiente (%)',
      p_monto,
      v_total - v_abonado;
  end if;


  v_abonado := v_abonado + p_monto;

  v_saldo :=
    greatest(
      0,
      v_total - v_abonado
    );


  update public.creditos
  set
    abonado = v_abonado,
    saldo = v_saldo,
    estado =
      case
        when v_saldo <= 0.001 then 'pagado'
        else 'parcial'
      end
  where id = p_credito_id;


  insert into public.abonos (
    id_abono,
    credito_id,
    monto,
    metodo_pago
  )
  values (
    p_id_abono,
    p_credito_id,
    p_monto,
    p_metodo
  );


  insert into public.caja_movimientos (
    tipo,
    categoria,
    monto,
    metodo_pago,
    descripcion,
    credito_id,
    id_abono
  )
  values (
    'ingreso',
    'Cobro de crédito',
    p_monto,
    p_metodo,
    'Abono a crédito',
    p_credito_id,
    p_id_abono
  );


  insert into public.auditoria (
    usuario_id,
    usuario,
    rol,
    accion,
    entidad,
    entidad_id,
    detalle
  )
  values (
    auth.uid(),
    coalesce(
      (
        select nombre
        from public.perfiles
        where id = auth.uid()
      ),
      '—'
    ),
    public.rol_actual(),
    'abono',
    'creditos',
    p_credito_id::text,
    'Abono ' || p_monto ||
    ' · saldo ' || v_saldo
  );


  return v_saldo;

end
$function$;

-- 16/17 public.estadisticas_tecnicas() [produccion 2026-09-18] md5(prosrc)=86948fdcaf03939a1d0929004cd9c730 bytes=1467 CR=0 LF=26
CREATE OR REPLACE FUNCTION public.estadisticas_tecnicas()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_rol text;
begin
  v_rol := public.rol_actual();
  -- rol_actual() ya filtra por activo = true, así que un usuario dado de baja
  -- recibe null y no pasa de aquí.
  if not (public.es_admin() or public.es_desarrollador()) then
    raise exception 'Solo el administrador y el desarrollador pueden consultar las estadísticas técnicas';
  end if;
  -- SOLO count(*). Ni un nombre, ni un teléfono, ni un importe, ni un UUID.
  return jsonb_build_object(
    'clientes',          (select count(*) from public.clientes),
    'motos',             (select count(*) from public.motos),
    'ordenes',           (select count(*) from public.ordenes),
    'ordenes_abiertas',  (select count(*) from public.ordenes where not finalizada),
    'cotizaciones',      (select count(*) from public.cotizaciones),
    'citas',             (select count(*) from public.citas),
    'inventario',        (select count(*) from public.inventario),
    'ventas',            (select count(*) from public.ventas),
    'ventas_hoy',        (select count(*) from public.ventas where creado_en::date = current_date),
    'creditos',          (select count(*) from public.creditos),
    'creditos_abiertos', (select count(*) from public.creditos where estado <> 'pagado'),
    'abonos',            (select count(*) from public.abonos),
    'movimientos_caja',  (select count(*) from public.caja_movimientos),
    'auditoria',         (select count(*) from public.auditoria)
  );
end $function$;

-- 17/17 public.estado_tecnico() [produccion 2026-09-18] md5(prosrc)=8cab17a837ec35d46c8575befd53e85a bytes=1764 CR=82 LF=82
CREATE OR REPLACE FUNCTION public.estado_tecnico()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  resultado jsonb;
  total_tablas integer := 0;
  tablas_rls integer := 0;
  politicas_abiertas integer := 0;
  funciones_seguridad integer := 0;
  bucket_privado boolean := false;
BEGIN

  IF NOT (
    public.es_admin()
    OR public.es_desarrollador()
  ) THEN
    RAISE EXCEPTION
      'No autorizado para consultar estado técnico';
  END IF;


  SELECT COUNT(*)
  INTO total_tablas
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE';


  SELECT COUNT(*)
  INTO tablas_rls
  FROM pg_tables
  WHERE schemaname = 'public'
    AND rowsecurity = true;


  SELECT COUNT(*)
  INTO politicas_abiertas
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (
      COALESCE(qual, '') ILIKE '%auth.uid()%is%not%null%'
      OR
      COALESCE(with_check, '') ILIKE '%auth.uid()%is%not%null%'
    );


  SELECT COUNT(*)
  INTO funciones_seguridad
  FROM information_schema.routines
  WHERE routine_schema = 'public'
    AND routine_name IN (
      'rol_actual',
      'es_admin',
      'es_equipo',
      'es_desarrollador',
      'puede_cobrar',
      'registrar_venta',
      'registrar_abono',
      'estadisticas_tecnicas',
      'estado_tecnico'
    );


  SELECT EXISTS (
    SELECT 1
    FROM storage.buckets
    WHERE id = 'entimotors-taller'
      AND public = false
  )
  INTO bucket_privado;


  resultado := jsonb_build_object(
    'ok', true,
    'rol', public.rol_actual(),
    'rls_correcto', tablas_rls >= total_tablas,
    'politicas_abiertas', politicas_abiertas,
    'storage_taller_privado', bucket_privado,
    'funciones_seguridad', funciones_seguridad,
    'timestamp', now()
  );

  RETURN resultado;
END;
$function$;


-- ACL EXPLICITO (sin GRANT ALL, sin cambiar owner) ---------------------------------------------
REVOKE EXECUTE ON FUNCTION public.rol_actual() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rol_actual() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.es_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_admin() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.puede_cobrar() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.puede_cobrar() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.es_equipo() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_equipo() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.es_desarrollador() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_desarrollador() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.es_mecanico_activo() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_mecanico_activo() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.ve_todo_el_taller() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ve_todo_el_taller() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.mi_cliente(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_cliente(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.mi_moto(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_moto(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.crear_perfil_al_registrarse() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_perfil_al_registrarse() TO service_role;
REVOKE EXECUTE ON FUNCTION public.proteger_caja_ligada() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.proteger_caja_ligada() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.proteger_rol_perfil() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.proteger_rol_perfil() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.mecanico_solo_avance_tecnico() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mecanico_solo_avance_tecnico() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.registrar_abono(uuid,numeric,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_abono(uuid,numeric,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.estadisticas_tecnicas() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estadisticas_tecnicas() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.estado_tecnico() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estado_tecnico() TO authenticated, service_role;

-- TRIGGERS (5) ---------------------------------------------------------------------------------
-- Sin DROP. Si falta: se crea. Si existe: se valida tabla, funcion, timing/evento/nivel de fila
-- (tgtype: fila=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16), activo ('O'), no interno, sin WHEN
-- ni lista de columnas, sin argumentos y no de restriccion. Si existe y no coincide: RAISE EXCEPTION.
DO $trg$
DECLARE
  t record;
  r record;
  v_fail text;
  v_creados int := 0;
  v_validados int := 0;
BEGIN
  FOR t IN
    SELECT *
      FROM (VALUES
        ('auth.users',              'al_crear_usuario',            'crear_perfil_al_registrarse()',  5, 'AFTER INSERT'),
        ('public.caja_movimientos', 'no_borrar_caja_ligada',       'proteger_caja_ligada()',        11, 'BEFORE DELETE'),
        ('public.citas',            'citas_mecanico_avance',       'mecanico_solo_avance_tecnico()', 19, 'BEFORE UPDATE'),
        ('public.ordenes',          'ordenes_mecanico_avance',     'mecanico_solo_avance_tecnico()', 19, 'BEFORE UPDATE'),
        ('public.perfiles',         'proteger_rol_perfil_trigger', 'proteger_rol_perfil()',         19, 'BEFORE UPDATE')
      ) AS x(tabla, nombre, funcion, tgtype_esperado, descripcion)
  LOOP
    SELECT tg.tgfoid, tg.tgtype, tg.tgenabled::text AS habilitado, tg.tgisinternal,
           (tg.tgqual IS NOT NULL) AS tiene_when, tg.tgattr::text AS columnas,
           tg.tgnargs, tg.tgconstraint
      INTO r
      FROM pg_trigger tg
     WHERE tg.tgrelid = to_regclass(t.tabla) AND tg.tgname = t.nombre;

    IF NOT FOUND THEN
      EXECUTE format('CREATE TRIGGER %I %s ON %s FOR EACH ROW EXECUTE FUNCTION public.%s',
                     t.nombre, t.descripcion, t.tabla, t.funcion);
      v_creados := v_creados + 1;
    ELSE
      v_fail := '';
      IF r.tgfoid IS DISTINCT FROM to_regprocedure('public.' || t.funcion)::oid THEN v_fail := v_fail || 'ejecuta otra funcion; '; END IF;
      IF r.tgtype IS DISTINCT FROM t.tgtype_esperado THEN v_fail := v_fail || format('tgtype=%s (se esperaba %s = %s por fila); ', r.tgtype, t.tgtype_esperado, t.descripcion); END IF;
      IF r.habilitado IS DISTINCT FROM 'O' THEN v_fail := v_fail || format('tgenabled=%s (se esperaba O); ', r.habilitado); END IF;
      IF r.tgisinternal THEN v_fail := v_fail || 'es un trigger interno; '; END IF;
      IF r.tiene_when THEN v_fail := v_fail || 'tiene clausula WHEN; '; END IF;
      IF r.columnas IS DISTINCT FROM '' THEN v_fail := v_fail || 'tiene lista de columnas (UPDATE OF); '; END IF;
      IF r.tgnargs <> 0 THEN v_fail := v_fail || 'tiene argumentos; '; END IF;
      IF r.tgconstraint <> 0 THEN v_fail := v_fail || 'es un trigger de restriccion; '; END IF;
      IF v_fail <> '' THEN
        RAISE EXCEPTION 'RCV-34 SYNC STOP (trigger incompatible, se revierte todo): % ON % : %', t.nombre, t.tabla, v_fail;
      END IF;
      v_validados := v_validados + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'RCV-34 SYNC: triggers creados=%, validados=% (de 5).', v_creados, v_validados;
END
$trg$;

-- POSTCONDICIONES (fallan cerradas: RAISE EXCEPTION revierte todo) -----------------------------
DO $post$
DECLARE
  c_md5_rol_actual constant text := 'e66ee46e01d3df511ee5bd4d0f2a178a';
  v_esperado jsonb := current_setting('rcv34sync.esperado')::jsonb;
  v_firma text;
  v_oid oid;
  v_trg_funcs oid[] := '{}';
  r record;
  t record;
  v_n int;
  v_presentes int := 0;
  v_public_n int := 0;
  v_anon_n int := 0;
  v_auth_n int := 0;
  v_svc_n int := 0;
  v_secdef_n int := 0;
  v_md5_ok int := 0;
  v_md5_mal text[] := '{}';
  v_crear_auth boolean;
  v_md5_rol text;
  v_norm_rol text;
  v_rol_secdef boolean;
  v_rol_config text[];
  v_trg_ok int := 0;
  v_trg_total int;
  v_public_total int;
  v_defacl_post text;
  v_otras_post text;
  v_fail text := '';
BEGIN
  -- 17 funciones presentes con firma exacta; EXECUTE efectivo por rol; md5 informativo
  FOR v_firma IN SELECT jsonb_object_keys(v_esperado) ORDER BY 1 LOOP
    v_oid := to_regprocedure('public.' || v_firma)::oid;
    IF v_oid IS NULL THEN
      v_fail := v_fail || format('falta public.%s; ', v_firma);
      CONTINUE;
    END IF;
    v_presentes := v_presentes + 1;
    IF v_firma IN ('crear_perfil_al_registrarse()', 'proteger_caja_ligada()', 'mecanico_solo_avance_tecnico()', 'proteger_rol_perfil()') THEN
      v_trg_funcs := v_trg_funcs || v_oid;
    END IF;

    SELECT md5(p.prosrc) AS md5_cuerpo,
           p.prosecdef AS secdef,
           EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_execute,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_execute
      INTO r
      FROM pg_proc p
     WHERE p.oid = v_oid;

    IF r.public_execute THEN v_public_n := v_public_n + 1; END IF;
    IF r.anon_execute THEN v_anon_n := v_anon_n + 1; END IF;
    IF r.auth_execute THEN v_auth_n := v_auth_n + 1; END IF;
    IF r.svc_execute THEN v_svc_n := v_svc_n + 1; END IF;
    IF r.secdef THEN v_secdef_n := v_secdef_n + 1; END IF;
    IF v_firma = 'crear_perfil_al_registrarse()' THEN v_crear_auth := r.auth_execute; END IF;
    IF r.md5_cuerpo = v_esperado ->> v_firma THEN
      v_md5_ok := v_md5_ok + 1;
    ELSE
      v_md5_mal := v_md5_mal || v_firma;
    END IF;
  END LOOP;

  IF v_presentes <> 17 THEN v_fail := v_fail || format('funciones presentes=%s (se esperaban 17); ', v_presentes); END IF;
  IF v_public_n <> 0 THEN v_fail := v_fail || format('PUBLIC tiene EXECUTE en %s funciones (se esperaba 0); ', v_public_n); END IF;
  IF v_anon_n <> 0 THEN v_fail := v_fail || format('anon tiene EXECUTE en %s funciones (se esperaba 0); ', v_anon_n); END IF;
  IF v_auth_n <> 16 THEN v_fail := v_fail || format('authenticated con EXECUTE en %s funciones (se esperaban 16); ', v_auth_n); END IF;
  IF v_crear_auth IS DISTINCT FROM false THEN v_fail := v_fail || 'authenticated conserva EXECUTE en crear_perfil_al_registrarse(); '; END IF;
  IF v_svc_n <> 17 THEN v_fail := v_fail || format('service_role con EXECUTE en %s funciones (se esperaban 17); ', v_svc_n); END IF;

  -- rol_actual(): fingerprint POST-RCV-35 exacto y filtro AND p.activo (nunca se reinstala la version insegura)
  SELECT md5(p.prosrc), regexp_replace(lower(p.prosrc), '\s+', '', 'g'), p.prosecdef, p.proconfig
    INTO v_md5_rol, v_norm_rol, v_rol_secdef, v_rol_config
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.rol_actual()');
  IF v_md5_rol IS DISTINCT FROM c_md5_rol_actual THEN
    v_fail := v_fail || format('md5(prosrc) de rol_actual()=%s (se esperaba %s, POST-RCV-35); ', v_md5_rol, c_md5_rol_actual);
  END IF;
  IF position('andp.activo' in COALESCE(v_norm_rol, '')) = 0 THEN
    v_fail := v_fail || 'rol_actual() NO contiene el filtro AND p.activo; ';
  END IF;
  IF v_rol_secdef IS DISTINCT FROM true OR v_rol_config IS DISTINCT FROM ARRAY['search_path=public']::text[] THEN
    v_fail := v_fail || 'rol_actual() dejo de ser SECURITY DEFINER con search_path=public; ';
  END IF;

  -- triggers: los 5 con la forma esperada y ninguno de mas sobre estas 4 funciones
  FOR t IN
    SELECT *
      FROM (VALUES
        ('auth.users',              'al_crear_usuario',            'crear_perfil_al_registrarse()',  5),
        ('public.caja_movimientos', 'no_borrar_caja_ligada',       'proteger_caja_ligada()',        11),
        ('public.citas',            'citas_mecanico_avance',       'mecanico_solo_avance_tecnico()', 19),
        ('public.ordenes',          'ordenes_mecanico_avance',     'mecanico_solo_avance_tecnico()', 19),
        ('public.perfiles',         'proteger_rol_perfil_trigger', 'proteger_rol_perfil()',         19)
      ) AS x(tabla, nombre, funcion, tgtype_esperado)
  LOOP
    SELECT count(*) INTO v_n
      FROM pg_trigger tg
     WHERE tg.tgrelid = to_regclass(t.tabla) AND tg.tgname = t.nombre AND NOT tg.tgisinternal
       AND tg.tgfoid = to_regprocedure('public.' || t.funcion)::oid
       AND tg.tgtype = t.tgtype_esperado AND tg.tgenabled = 'O'
       AND tg.tgqual IS NULL AND tg.tgattr::text = '' AND tg.tgnargs = 0 AND tg.tgconstraint = 0;
    IF v_n = 1 THEN
      v_trg_ok := v_trg_ok + 1;
    ELSE
      v_fail := v_fail || format('trigger %s ON %s no esta como se espera; ', t.nombre, t.tabla);
    END IF;
  END LOOP;
  SELECT count(*) INTO v_trg_total FROM pg_trigger tg WHERE NOT tg.tgisinternal AND tg.tgfoid = ANY (v_trg_funcs);
  IF v_trg_total <> 5 THEN
    v_fail := v_fail || format('las 4 funciones trigger tienen %s triggers (se esperaban exactamente 5); ', v_trg_total);
  END IF;

  -- nada mas cambio: default privileges y las demas funciones de public
  SELECT md5(COALESCE(string_agg(d.defaclrole::regrole::text || ':' || d.defaclnamespace::regnamespace::text || ':' || d.defaclobjtype::text || ':' || d.defaclacl::text, '|' ORDER BY d.oid), ''))
    INTO v_defacl_post FROM pg_default_acl d;
  IF v_defacl_post IS DISTINCT FROM current_setting('rcv34sync.defacl_pre') THEN
    v_fail := v_fail || 'cambiaron los default privileges (pg_default_acl); ';
  END IF;
  SELECT md5(COALESCE(string_agg(x.p_firma || ':' || x.p_owner || ':' || x.p_md5 || ':' || x.p_acl, '|' ORDER BY x.p_firma), ''))
    INTO v_otras_post
    FROM (SELECT p.oid::regprocedure::text AS p_firma,
                 pg_get_userbyid(p.proowner) AS p_owner,
                 md5(p.prosrc) AS p_md5,
                 COALESCE(p.proacl::text, '-') AS p_acl
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND NOT (p.oid::regprocedure::text = ANY (ARRAY(SELECT jsonb_object_keys(v_esperado))))) x;
  IF v_otras_post IS DISTINCT FROM current_setting('rcv34sync.otras_pre') THEN
    v_fail := v_fail || 'otra funcion de public cambio durante la migracion; ';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'RCV-34 SYNC STOP (postcondiciones, se revierte todo): %', v_fail;
  END IF;

  SELECT count(*) INTO v_public_total
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');

  PERFORM set_config('rcv34sync.resumen', jsonb_build_object(
    'formato', 'rcv34-source-sync-resultado/1',
    'funciones_presentes', v_presentes,
    'PUBLIC_execute_true', v_public_n,
    'anon_execute_true', v_anon_n,
    'authenticated_execute_true', v_auth_n,
    'crear_perfil_authenticated_execute', v_crear_auth,
    'service_role_execute_true', v_svc_n,
    'security_definer_total', v_secdef_n,
    'triggers_correctos', v_trg_ok,
    'triggers_sobre_las_4_funciones', v_trg_total,
    'rol_actual_md5', v_md5_rol,
    'rol_actual_contiene_filtro_activo', true,
    'md5_coinciden', v_md5_ok,
    'md5_distintos', to_jsonb(v_md5_mal),
    'funciones_public_no_extension', v_public_total,
    'todo_ok', true)::text, true);
  RAISE NOTICE 'RCV-34 SYNC: postcondiciones OK (17 funciones; PUBLIC/anon cerrados; authenticated 16; service_role 17; 5 triggers; rol_actual POST-RCV-35; nada mas cambio). md5 coinciden con produccion: %/17.', v_md5_ok;
END
$post$;

-- RESULTADO ESTRUCTURADO (copiar y devolver) --------------------------------------------------
SELECT jsonb_pretty(current_setting('rcv34sync.resumen')::jsonb) AS rcv34_source_sync_resultado;

COMMIT;
