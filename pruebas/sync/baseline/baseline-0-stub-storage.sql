-- SOLO PRUEBAS LOCALES. La imagen supabase/postgres trae el esquema `storage` vacío: aquí se crean las
-- tablas mínimas que necesitan las políticas de Storage para poder probarlas en SQL. NUNCA va a producción.
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[],
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets (id), name text, owner uuid, metadata jsonb,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- misma semántica que la función real: todos los segmentos de la ruta menos el último
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;

INSERT INTO storage.buckets (id, name, public)
VALUES ('entimotors-media', 'entimotors-media', true), ('entimotors-taller', 'entimotors-taller', false)
ON CONFLICT (id) DO NOTHING;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects, storage.buckets TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION storage.foldername(text) TO authenticated, service_role;

-- como en producción, `postgres` es el dueño: así puede crear las políticas de storage.objects
ALTER TABLE storage.buckets OWNER TO postgres;
ALTER TABLE storage.objects OWNER TO postgres;
ALTER FUNCTION storage.foldername(text) OWNER TO postgres;
