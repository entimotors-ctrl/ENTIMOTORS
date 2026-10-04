#!/usr/bin/env bash
# 3.15.0 · BLOQUE 8 · CADENA 15a–15g SOBRE UN SNAPSHOT EQUIVALENTE A PRODUCCIÓN — SOLO EN AISLAMIENTO.
#   b8-migraciones-snapshot.sh DUMP SALIDA
# Contenedor PostgreSQL NUEVO y desechable, SIN RED (--network none), con el dump montado de solo lectura. Restaura, aplica 15a→15g en
# orden, reaplica (idempotencia) y mide: invariantes de stock y de dinero con los datos REALES, estado de migración 3.13, conteos por tabla
# antes/después (las migraciones no pueden perder ni cambiar filas) y visibilidad por rol antes/después de 15g. Solo conteos: NINGÚN dato
# personal sale del contenedor. El contenedor se borra al terminar. No acepta ningún destino: no hay forma de apuntarlo a producción.
set -euo pipefail
DUMP=${1:?uso: DUMP SALIDA}; OUT=${2:?uso: DUMP SALIDA}; mkdir -p "$OUT"
case "$DUMP" in *supabase.co*|*pooler*|postgres://*|postgresql://*) echo "destino/origen remoto prohibido" >&2; exit 3;; esac
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; SQLDIR="$(cd "$AQUI/../../../taller-demo/supabase/sync" && pwd)"
IMG=public.ecr.aws/supabase/postgres:17.6.1.134
C=entimotors-b8-snapshot-$(date +%s)
docker run -d --rm --name "$C" --network none -e POSTGRES_PASSWORD=desechable -v "$(dirname "$DUMP"):/in:ro" -v "$SQLDIR:/sql:ro" -v "$AQUI:/pr:ro" "$IMG" >/dev/null
trap 'docker rm -f "$C" >/dev/null 2>&1 || true' EXIT
[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$C")" = "none" ] || { echo "el contenedor tiene red: abortado"; exit 1; }
for i in $(seq 1 120); do docker logs "$C" 2>&1 | grep -q 'PostgreSQL init process complete' && break; sleep 2; done
for i in $(seq 1 60); do docker exec "$C" psql -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1 && break; sleep 2; done
Q() { docker exec -i "$C" psql -X -U supabase_admin -d snap -v ON_ERROR_STOP=1 -At "$@"; }
docker exec "$C" psql -U supabase_admin -d postgres -q -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_realtime_admin') THEN CREATE ROLE supabase_realtime_admin NOLOGIN; END IF; END \$\$;" -c "CREATE DATABASE snap"
docker exec "$C" pg_restore -U supabase_admin -d snap --no-comments "/in/$(basename "$DUMP")" > "$OUT/restore.log" 2>&1 || true
echo "errores de pg_restore (esperables: objetos que la imagen ya trae): $(grep -c 'error:' "$OUT/restore.log")" | tee "$OUT/resumen.txt"
CONTEO="SELECT string_agg(t || '=' || n, ' ' ORDER BY t) FROM (SELECT 'clientes' t, count(*) n FROM public.clientes UNION ALL SELECT 'motos', count(*) FROM public.motos UNION ALL SELECT 'ordenes', count(*) FROM public.ordenes UNION ALL SELECT 'orden_items', count(*) FROM public.orden_items UNION ALL SELECT 'inventario', count(*) FROM public.inventario UNION ALL SELECT 'caja', count(*) FROM public.caja_movimientos UNION ALL SELECT 'creditos', count(*) FROM public.creditos UNION ALL SELECT 'abonos', count(*) FROM public.abonos UNION ALL SELECT 'ventas', count(*) FROM public.ventas UNION ALL SELECT 'citas', count(*) FROM public.citas UNION ALL SELECT 'cotizaciones', count(*) FROM public.cotizaciones UNION ALL SELECT 'perfiles', count(*) FROM public.perfiles UNION ALL SELECT 'auditoria', count(*) FROM public.auditoria) x"
echo "conteos ANTES: $(Q -c "$CONTEO")" | tee -a "$OUT/resumen.txt"
echo "invariantes ANTES (3.14.1): stock $(Q -c 'select public.verificar_invariantes()::text' | cut -c1-200)" | tee -a "$OUT/resumen.txt"
Q < "$AQUI/b8-catalogo.sql" > "$OUT/catalogo-antes.txt"
# visibilidad por rol ANTES (admin real y un mecánico real si hay; solo cuántas filas ve)
VIS="DO \$v\$ DECLARE r record; t text; n bigint; BEGIN FOR r IN SELECT id, rol FROM public.perfiles WHERE activo AND rol IN ('admin','cajero','mecanico') ORDER BY rol, id LIMIT 6 LOOP FOREACH t IN ARRAY ARRAY['clientes','motos','ordenes','caja_movimientos','creditos','ventas','inventario','citas','cotizaciones','auditoria'] LOOP PERFORM set_config('request.jwt.claim.sub', r.id::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', r.id, 'role','authenticated')::text, true); SET LOCAL ROLE authenticated; EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n; RESET ROLE; RAISE NOTICE 'VIS|%|%|%', r.rol || '#' || left(md5(r.id::text), 6), t, n; END LOOP; END LOOP; END \$v\$;"
Q -c "$VIS" 2>&1 | grep -o 'VIS|.*' | sort > "$OUT/visibilidad-antes.txt" || true
for f in 15a-cotizacion-inventario 15b-presupuestos-stock 15c-mensajes-realtime 15d-owner-pin-usuarios 15e-finanzas 15f-legado-313 15g-rendimiento-rls; do
  if Q -f "/sql/sync-$f.sql" > "$OUT/aplicar-$f.log" 2>&1; then echo "aplica $f: OK" | tee -a "$OUT/resumen.txt"; else echo "aplica $f: FALLÓ — $(grep -m1 ERROR "$OUT/aplicar-$f.log")" | tee -a "$OUT/resumen.txt"; fi
done
for f in 15a-cotizacion-inventario 15b-presupuestos-stock 15c-mensajes-realtime 15d-owner-pin-usuarios 15e-finanzas 15f-legado-313 15g-rendimiento-rls; do
  Q -f "/sql/sync-$f.sql" > /dev/null 2>&1 && echo "reaplica $f: OK" >> "$OUT/resumen.txt" || echo "reaplica $f: FALLÓ" | tee -a "$OUT/resumen.txt"
done
Q < "$AQUI/b8-catalogo.sql" > "$OUT/catalogo-despues.txt"
Q -c "$VIS" 2>&1 | grep -o 'VIS|.*' | sort > "$OUT/visibilidad-despues.txt" || true
echo "conteos DESPUÉS: $(Q -c "$CONTEO")" | tee -a "$OUT/resumen.txt"
echo "invariantes DESPUÉS: stock $(Q -c 'select public.verificar_invariantes()::text' | cut -c1-300) · dinero $(Q -c 'select public.finanzas_invariantes()::text' | cut -c1-600)" | tee -a "$OUT/resumen.txt"
echo "fases: $(Q -c "select string_agg(fase, ',' order by fase) from public.sync_fases")" | tee -a "$OUT/resumen.txt"
echo "migracion_313 (como servicio): $(Q -c "select public.migracion_313_estado()::text" 2>&1 | cut -c1-200)" | tee -a "$OUT/resumen.txt"
echo "visibilidad por rol idéntica antes/después: $(diff -q "$OUT/visibilidad-antes.txt" "$OUT/visibilidad-despues.txt" >/dev/null && echo SÍ || echo NO) ($(wc -l < "$OUT/visibilidad-antes.txt") mediciones)" | tee -a "$OUT/resumen.txt"
echo FIN >> "$OUT/resumen.txt"
