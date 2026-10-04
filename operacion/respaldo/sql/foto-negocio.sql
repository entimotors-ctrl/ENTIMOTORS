-- ENTIMOTORS 3.15 · FOTO LÓGICA DEL NEGOCIO (solo lectura). Se corre IGUAL en el origen y en la restauración aislada; las líneas
-- deben coincidir salvo las VOLATIL (sesiones/tiempo) y las EXCLUIDO (tablas cuyos datos no viajan en el respaldo de negocio por ser
-- secretos o efímeros: en la restauración valen 0 por diseño). Basada en la foto del Bloque 0 (backup pre-3.15), con dos cambios:
--  · auth.users se compara SIN hash de contraseña (el respaldo de negocio no lo lleva);
--  · se agregan mensajes (3.15 Bloque 3), finanzas (Bloque 5) y las fases 3.15 aplicadas.
SET default_transaction_read_only = on;
BEGIN READ ONLY;
SET LOCAL TimeZone = 'UTC';
SET LOCAL search_path = pg_catalog, public;
SET LOCAL extra_float_digits = 0;
SELECT 'VOLATIL|ro', current_setting('transaction_read_only'), now();
SELECT 'version', current_setting('server_version');
SELECT 'fases', CASE WHEN to_regclass('public.sync_fases') IS NULL THEN '-' ELSE coalesce((xpath('/row/v/text()', query_to_xml($q$select string_agg(fase, ',' order by fase) as v from public.sync_fases$q$, false, true, '')))[1]::text, '-') END;

-- tablas cuyos DATOS no viajan (lista cerrada; la misma que excluye respaldar.sh)

SELECT CASE WHEN NOT (n.nspname || '.' || c.relname = ANY (ARRAY['public.admin_pin', 'public.admin_pin_intentos', 'public.admin_clave_intentos'])) THEN 'conteo|' ELSE 'EXCLUIDO|' END || n.nspname || '.' || c.relname || '|' ||
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public') ORDER BY n.nspname, c.relname;
SELECT 'conteo|storage.buckets|' || count(*) FROM storage.buckets;
SELECT 'conteo|storage.objects|' || count(*) FROM storage.objects;
SELECT 'conteo|auth.users|' || count(*) FROM auth.users;

-- huella por tabla de TODO public (excepto las excluidas)
SELECT 'huella_tabla|' || c.relname || '|' ||
       (xpath('/row/h/text()', query_to_xml(format('select coalesce(md5(string_agg(to_jsonb(x)::text, chr(10) order by to_jsonb(x)::text)), ''vacia'') as h from public.%I x', c.relname), false, true, '')))[1]::text
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
   AND NOT ('public.' || c.relname = ANY (ARRAY['public.admin_pin', 'public.admin_pin_intentos', 'public.admin_clave_intentos'])) ORDER BY c.relname;
-- huella de negocio: todas las tablas de public con datos del negocio en UN hash
SELECT 'huella_negocio', md5(string_agg(h, chr(10) ORDER BY h)) FROM (
  SELECT c.relname || ':' || (xpath('/row/h/text()', query_to_xml(format('select coalesce(md5(string_agg(to_jsonb(x)::text, chr(10) order by to_jsonb(x)::text)), ''vacia'') as h from public.%I x', c.relname), false, true, '')))[1]::text AS h
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND NOT ('public.' || c.relname = ANY (ARRAY['public.admin_pin', 'public.admin_pin_intentos', 'public.admin_clave_intentos']))) q;
-- usuarios: identidad y estado, SIN contraseña ni tokens
SELECT 'huella_auth_usuarios', md5(string_agg(id::text || '|' || coalesce(email, '') || '|' || coalesce(email_confirmed_at::text, '') || '|' || coalesce(banned_until::text, ''), chr(10) ORDER BY id)) FROM auth.users;
SELECT 'huella_storage_objetos', md5(string_agg(bucket_id || '/' || name || '|' || coalesce(metadata->>'size', '') || '|' || coalesce(metadata->>'eTag', ''), chr(10) ORDER BY bucket_id, name)) FROM storage.objects;
SELECT 'huella_storage_buckets', md5(string_agg(id || '|' || public::text, chr(10) ORDER BY id)) FROM storage.buckets;

SELECT 'invariantes', public.verificar_invariantes()::text;
SELECT 'invariantes_finanzas', CASE WHEN to_regprocedure('public.finanzas_invariantes()') IS NULL THEN '-' ELSE (xpath('/row/v/text()', query_to_xml('select public.finanzas_invariantes()::text as v', false, true, '')))[1]::text END;

-- catálogo (con search_path fijo: se imprime igual en origen y restauración)
SELECT 'catalogo|funciones', count(*), md5(string_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')='||md5(p.prosrc)||':'||p.prosecdef, chr(10) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
SELECT 'catalogo|politicas', count(*), md5(string_agg(tablename||'.'||policyname||'|'||cmd||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), chr(10) ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname IN ('public', 'storage');
SELECT 'catalogo|triggers', count(*), md5(string_agg(c.relname||'.'||t.tgname||'|'||pg_get_triggerdef(t.oid), chr(10) ORDER BY c.relname, t.tgname))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace IN ('public'::regnamespace, 'auth'::regnamespace);
SELECT 'catalogo|restricciones', count(*), md5(string_agg(conrelid::regclass::text||'.'||conname||'|'||pg_get_constraintdef(oid), chr(10) ORDER BY conrelid::regclass::text, conname)) FROM pg_constraint WHERE connamespace = 'public'::regnamespace;
SELECT 'catalogo|indices', count(*), md5(string_agg(indexname||'|'||indexdef, chr(10) ORDER BY indexname)) FROM pg_indexes WHERE schemaname = 'public';
SELECT 'catalogo|columnas', count(*), md5(string_agg(table_name||'.'||column_name||'|'||data_type||'|'||is_nullable||'|'||coalesce(column_default,''), chr(10) ORDER BY table_name, ordinal_position)) FROM information_schema.columns WHERE table_schema = 'public';
SELECT 'catalogo|grants', count(*), md5(string_agg(table_name||'|'||grantee||'|'||privilege_type, chr(10) ORDER BY table_name, grantee, privilege_type)) FROM information_schema.role_table_grants WHERE table_schema = 'public';
SELECT 'catalogo|rls_off', coalesce(string_agg(relname, ','), '-') FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity;

-- datos críticos legibles (para localizar cualquier diferencia)
SELECT 'inventario|' || coalesce(local_id::text, left(id::text, 8)) || '|cant=' || cantidad || '|ledger=' || (SELECT coalesce(sum(m.cantidad), 0) FROM inventario_movimientos m WHERE m.inventario_id = i.id)
       || '|costo=' || costo_compra || '|borrado=' || (deleted_at IS NOT NULL) FROM inventario i ORDER BY local_id NULLS LAST, id;
SELECT 'ledger_por_tipo|' || tipo || '|' || count(*) || '|' || sum(cantidad) FROM inventario_movimientos GROUP BY tipo ORDER BY tipo;
SELECT 'orden|' || coalesce(local_id::text, left(id::text, 8)) || '|' || estado || '|fin=' || finalizada || '|anul=' || anulada || '|borr=' || (deleted_at IS NOT NULL)
       || '|items=' || (SELECT count(*) FROM orden_items oi WHERE oi.orden_id = o.id) || '|total=' || (SELECT coalesce(sum(cantidad * precio), 0) FROM orden_items oi WHERE oi.orden_id = o.id)
       || '|costo=' || (SELECT coalesce(sum(cantidad * costo_unitario), 0) FROM orden_items oi WHERE oi.orden_id = o.id AND oi.inventario_id IS NOT NULL)
  FROM ordenes o ORDER BY creado_en, id;
SELECT 'ventas', count(*), coalesce(sum(total), 0), count(*) FILTER (WHERE anulada) FROM ventas;
SELECT 'caja|' || coalesce(categoria, '-') || '|' || tipo || '|' || (reverso_de IS NOT NULL) || '|' || count(*) || '|' || sum(monto) FROM caja_movimientos GROUP BY categoria, tipo, reverso_de IS NOT NULL ORDER BY 1;
SELECT 'caja_neto', coalesce(sum(CASE WHEN tipo = 'ingreso' THEN monto ELSE -monto END), 0) FROM caja_movimientos;
SELECT 'creditos|' || estado || '|' || anulado || '|' || count(*) || '|total=' || sum(total) || '|abonado=' || sum(abonado) || '|saldo=' || sum(saldo) FROM creditos GROUP BY estado, anulado ORDER BY 1;
SELECT 'abonos', count(*), sum(monto), count(*) FILTER (WHERE anulado) FROM abonos;
SELECT 'mensajes', CASE WHEN to_regclass('public.mensajes') IS NULL THEN '-' ELSE (xpath('/row/v/text()', query_to_xml('select count(*)::text as v from public.mensajes', false, true, '')))[1]::text END;
SELECT 'perfiles|' || rol || '|' || activo || '|' || count(*) FROM perfiles GROUP BY rol, activo ORDER BY 1;
SELECT 'auditoria', count(*), md5(string_agg(to_jsonb(a)::text, chr(10) ORDER BY to_jsonb(a)::text)) FROM auditoria a;
SELECT 'reversos|' || tipo || '|' || count(*) FROM reversos GROUP BY tipo ORDER BY 1;
SELECT 'storage|' || bucket_id || '|' || name || '|' || coalesce(metadata->>'size', '?') || '|' || coalesce(metadata->>'eTag', '?') FROM storage.objects ORDER BY bucket_id, name;
SELECT 'VOLATIL|sesiones', (SELECT count(*) FROM auth.sessions), (SELECT count(*) FROM auth.refresh_tokens);
ROLLBACK;
