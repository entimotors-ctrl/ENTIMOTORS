-- 3.15.0 · Bloque 8 · FOTO DEL CATÁLOGO (esquemas public y realtime) para comparar antes/después de 15a–15g. Solo lectura.
-- F|función|security definer|volatilidad|config|dueño|md5 del cuerpo|permisos     T|tabla|rls|force rls|dueño|permisos
-- P|tabla|política|cmd|roles|using|with check     G|tabla|trigger|habilitado|función
SELECT line FROM (
  SELECT 'F|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || p.prosecdef::text || '|' || p.provolatile::text || '|' ||
         coalesce(array_to_string(p.proconfig, ','), '') || '|' || pg_get_userbyid(p.proowner) || '|' || md5(p.prosrc) || '|' || coalesce(array_to_string(p.proacl, ','), '') AS line
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public') AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'T|' || n.nspname || '.' || c.relname || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(array_to_string(c.relacl, ','), '')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'p')
  UNION ALL
  SELECT 'P|' || schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
    FROM pg_policies WHERE schemaname IN ('public', 'realtime', 'storage')
  UNION ALL
  SELECT 'G|' || n.nspname || '.' || c.relname || '|' || t.tgname || '|' || t.tgenabled::text || '|' || t.tgfoid::regproc::text
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = 'public'
) x ORDER BY line;
