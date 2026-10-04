-- STUB MÍNIMO de Supabase Realtime (solo pruebas SQL locales; nunca producción). Reproduce lo que 15c usa de producción
-- (verificado en el volcado pre-3.15: realtime.messages con RLS activa y sin políticas, realtime.topic(), realtime.send(jsonb,text,text,boolean)):
--   · realtime.messages (topic, extension, payload, event, private) con RLS activa y SELECT/INSERT para authenticated, como en Supabase;
--   · realtime.topic() lee el ajuste realtime.topic (es lo que fija el servidor Realtime al comprobar quién puede unirse a un canal);
--   · realtime.send inserta el aviso y, como el original, atrapa sus errores (WARNING). realtime.fallar = 'si' simula que falla.
-- Lo que el servidor Realtime REAL hace con esto se prueba aparte (pruebas/sync/browser/b3-*.test.mjs, contenedor realtime v2.106.0).
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE IF NOT EXISTS realtime.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), topic text NOT NULL, extension text NOT NULL, payload jsonb, event text,
  private boolean DEFAULT false, inserted_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA realtime TO anon, authenticated, service_role;
GRANT SELECT, INSERT ON realtime.messages TO anon, authenticated;
CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('realtime.topic', true), '') $$;
CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF current_setting('realtime.fallar', true) = 'si' THEN RAISE EXCEPTION 'realtime caído (simulado)'; END IF;
    -- como el original (volcado pre-3.15, verificado en B8): si el payload NO trae la clave 'id', le pone el uuid del mensaje
    INSERT INTO realtime.messages (topic, extension, payload, event, private)
    VALUES (topic, 'broadcast', CASE WHEN payload ? 'id' THEN payload ELSE jsonb_set(payload, '{id}', to_jsonb(gen_random_uuid())) END, event, private);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'WarnSendingBroadcastMessage: %', SQLERRM;
  END;
END $$;
-- mismo dueño que en producción (supabase_realtime_admin, del que postgres es miembro): 15c se aplica como postgres, como allá
DO $d$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    ALTER TABLE realtime.messages OWNER TO supabase_realtime_admin;
    ALTER FUNCTION realtime.topic() OWNER TO supabase_realtime_admin;
    ALTER FUNCTION realtime.send(jsonb,text,text,boolean) OWNER TO supabase_realtime_admin;
  END IF;
END $d$;
