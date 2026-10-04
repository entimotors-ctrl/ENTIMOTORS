-- STUB MÍNIMO de auth.sessions (solo pruebas SQL locales): la base de referencia no trae GoTrue. Lo que hace GoTrue real con las sesiones
-- (logout, baneo, refresh) se prueba aparte en pruebas/sync/gotrue/b4-eliminar-usuario.test.mjs.
CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL, created_at timestamptz DEFAULT now());
