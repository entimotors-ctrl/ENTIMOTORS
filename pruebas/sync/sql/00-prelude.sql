-- Prelude común de las pruebas SQL de SYNC. Se ejecuta como supabase_admin en una COPIA local (nunca producción).
-- Helpers solo en pg_temp. Resultado: líneas "PASS: nombre" / "FAIL: nombre" por NOTICE.
CREATE FUNCTION pg_temp.t(nombre text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '%: %', CASE WHEN cond IS TRUE THEN 'PASS' ELSE 'FAIL' END, nombre; END $$;

-- La sentencia debe FALLAR; si se da patrón, el mensaje debe casar con él.
CREATE FUNCTION pg_temp.falla(nombre text, sentencia text, patron text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE msg text;
BEGIN
  BEGIN
    EXECUTE sentencia;
    RAISE NOTICE 'FAIL: % (no falló)', nombre; RETURN;
  EXCEPTION WHEN OTHERS THEN msg := SQLERRM;
  END;
  IF patron IS NULL OR msg ~* patron THEN RAISE NOTICE 'PASS: %', nombre;
  ELSE RAISE NOTICE 'FAIL: % (mensaje: %)', nombre, msg; END IF;
END $$;

CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-00000000000' || n)::uuid $$;

-- ids de datos de prueba (n >= 100), distintos de los de usuarios
CREATE FUNCTION pg_temp.id(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-9000-' || lpad(n::text, 12, '0'))::uuid $$;

-- n = 0: anon sin sesión; n > 0: usuario autenticado n. Vale hasta el final de la transacción o hasta pg_temp.fin().
CREATE FUNCTION pg_temp.como(n int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', CASE WHEN n = 0 THEN '' ELSE pg_temp.uid(n)::text END, true);
  PERFORM set_config('request.jwt.claim.role', CASE WHEN n = 0 THEN 'anon' ELSE 'authenticated' END, true);
  PERFORM set_config('request.jwt.claims', CASE WHEN n = 0 THEN '{"role":"anon"}' ELSE json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text END, true);
  PERFORM set_config('role', CASE WHEN n = 0 THEN 'anon' ELSE 'authenticated' END, true);
END $$;
CREATE FUNCTION pg_temp.fin() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

-- su(): vuelve a superusuario para comprobar datos; adm(): vuelve a actuar como el administrador (usuario 1)
CREATE FUNCTION pg_temp.su() RETURNS void LANGUAGE sql AS $$ SELECT pg_temp.fin() $$;
CREATE FUNCTION pg_temp.adm() RETURNS void LANGUAGE sql AS $$ SELECT pg_temp.como(1) $$;

-- Cuentas de prueba: 1 admin · 2 cajero · 3 mecánico A · 4 mecánico B · 5 desarrollador · 6 mecánico INACTIVO
DO $seed$
DECLARE i int; r text[] := ARRAY['admin','cajero','mecanico','mecanico','desarrollador','mecanico'];
BEGIN
  SET LOCAL session_replication_role = replica;          -- sin triggers mientras se siembra
  FOR i IN 1..6 LOOP
    INSERT INTO auth.users (id, email) VALUES (pg_temp.uid(i), 'u' || i || '@example.test') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.perfiles (id, nombre, rol, activo)
    VALUES (pg_temp.uid(i), 'Usuario ' || i, r[i], i <> 6) ON CONFLICT (id) DO NOTHING;
  END LOOP;
END $seed$;
