#!/usr/bin/env bash
# ENTIMOTORS 3.15 · Bloque 5 · RESPALDO DE NEGOCIO verificable (base + Storage + manifiesto + hashes + escaneo de secretos).
#
#   respaldar.sh --salida DIR --origen-servicio entimotors_prod [--storage-copia DIR]   producción, SOLO LECTURA (servicio libpq)
#   respaldar.sh --salida DIR --origen-contenedor NOMBRE --db DB [--storage-copia DIR]   laboratorio (contenedor Docker local)
#
# Storage: los archivos se toman de una copia local YA VERIFICADA (--storage-copia, p. ej. la del Bloque 0) o se descargan si el
# operador exporta ENTIMOTORS_STORAGE_URL y ENTIMOTORS_STORAGE_LLAVE (la llave nunca se escribe en disco ni en el manifiesto).
# Nunca escribe en el origen: sesiones BEGIN READ ONLY, pg_dump con default_transaction_read_only, COPY ... TO STDOUT.
# Sale con 0 solo si el manifiesto quedó VERIFICADO y el escaneo de secretos LIMPIO.
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
IMG=public.ecr.aws/supabase/postgres:17.6.1.134
CFG=$HOME/.config/entimotors
SAL="" SERV="" CONT="" DB="" COPIA=""
while [ $# -gt 0 ]; do case "$1" in
  --salida) SAL=$2; shift 2 ;; --origen-servicio) SERV=$2; shift 2 ;; --origen-contenedor) CONT=$2; shift 2 ;;
  --db) DB=$2; shift 2 ;; --storage-copia) COPIA=$2; shift 2 ;;
  *) echo "argumento desconocido: $1" >&2; exit 2 ;; esac; done
[ -n "$SAL" ] && { [ -n "$SERV" ] || { [ -n "$CONT" ] && [ -n "$DB" ]; }; } || { echo "uso: respaldar.sh --salida DIR (--origen-servicio S | --origen-contenedor C --db D) [--storage-copia DIR]" >&2; exit 2; }
[ -e "$SAL" ] && { echo "la salida $SAL ya existe: un respaldo nunca se sobrescribe" >&2; exit 2; }
umask 077; mkdir -p -m 700 "$SAL"; SAL="$(cd "$SAL" && pwd)"; mkdir -m 700 "$SAL/.tmp"
trap 'rm -rf "$SAL/.tmp"' EXIT
EXCL=(--exclude-table-data='auth.*' --exclude-table-data='vault.*' --exclude-table-data='realtime.*' --exclude-table-data='net.*'
      --exclude-table-data='cron.*' --exclude-table-data='supabase_functions.*' --exclude-table-data='pgsodium.*' --exclude-table-data='graphql.*'
      --exclude-table-data='storage.s3_multipart_uploads' --exclude-table-data='storage.s3_multipart_uploads_parts'
      --exclude-table-data='public.admin_pin' --exclude-table-data='public.admin_pin_intentos' --exclude-table-data='public.admin_clave_intentos')
AUTH_SQL="COPY (SELECT id, aud, role, email, email_confirmed_at, banned_until, created_at, updated_at, is_sso_user, is_anonymous, deleted_at, raw_app_meta_data FROM auth.users ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER)"

sql_origen() {   # sql_origen <archivo.sql>  -> salida -A -F'|' -t
  if [ -n "$SERV" ]; then PGSERVICEFILE=$CFG/pg_service.conf PGPASSFILE=$CFG/pgpass psql "service=$SERV" -X -q -v ON_ERROR_STOP=1 -A -F'|' -t -f "$1"
  else docker exec -i "$CONT" psql -U supabase_admin -d "$DB" -X -q -v ON_ERROR_STOP=1 -A -F'|' -t < "$1"; fi
}
auth_origen() {
  if [ -n "$SERV" ]; then PGSERVICEFILE=$CFG/pg_service.conf PGPASSFILE=$CFG/pgpass psql "service=$SERV" -X -q -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY" -c "$AUTH_SQL" -c "ROLLBACK"
  else docker exec "$CONT" psql -U supabase_admin -d "$DB" -X -q -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY" -c "$AUTH_SQL" -c "ROLLBACK"; fi
}
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "1/7 foto lógica previa del origen";      sql_origen "$AQUI/sql/foto-negocio.sql" > "$SAL/.tmp/foto-antes.txt"
echo "2/7 pg_dump (esquema completo; sin datos secretos/efímeros)"
if [ -n "$SERV" ]; then
  docker run --rm --network host -u "$(id -u):$(id -g)" -v "$CFG:/cfg:ro" -v "$SAL:/out" -e PGSERVICEFILE=/cfg/pg_service.conf -e PGPASSFILE=/cfg/pgpass \
    -e PGOPTIONS="-c default_transaction_read_only=on" --entrypoint pg_dump "$IMG" "service=$SERV" -Fc "${EXCL[@]}" -f /out/base.dump
  ORIGEN="servicio $SERV (solo lectura)"
else
  docker exec -e PGOPTIONS="-c default_transaction_read_only=on" "$CONT" pg_dump -U supabase_admin -d "$DB" -Fc "${EXCL[@]}" > "$SAL/base.dump"
  ORIGEN="contenedor de laboratorio $CONT/$DB"
fi
echo "3/7 directorio de usuarios SANEADO (sin contraseña ni tokens)"; auth_origen > "$SAL/auth-usuarios.csv"
echo "4/7 foto lógica posterior + foto financiera"
sql_origen "$AQUI/sql/foto-negocio.sql" > "$SAL/foto-origen.txt"
sql_origen "$AQUI/sql/foto-financiera.sql" > "$SAL/finanzas-origen.txt"
ESTABLE=false; diff <(grep -v '^VOLATIL' "$SAL/.tmp/foto-antes.txt") <(grep -v '^VOLATIL' "$SAL/foto-origen.txt") > "$SAL/.tmp/diff-estabilidad.txt" && ESTABLE=true
echo "5/7 Storage: inventario de la base → archivos"
mkdir -p "$SAL/storage"
if [ -n "${ENTIMOTORS_STORAGE_URL:-}" ]; then
  node "$AQUI/respaldo.mjs" storage-descargar --foto "$SAL/foto-origen.txt" --destino "$SAL/storage" || true
elif [ -n "$COPIA" ]; then
  # solo lo que la base dice que existe, con su ruta (bucket/ruta); nada más
  grep '^storage|' "$SAL/foto-origen.txt" | while IFS='|' read -r _ b resto; do
    r=${resto%|*}; r=${r%|*}; [ -f "$COPIA/$b/$r" ] && { mkdir -p "$SAL/storage/$b/$(dirname "$r")"; cp -p "$COPIA/$b/$r" "$SAL/storage/$b/$r"; }; done
fi
node "$AQUI/respaldo.mjs" storage-verificar --foto "$SAL/foto-origen.txt" --raiz "$SAL/storage" | tee "$SAL/.tmp/storage.txt" || true
echo "6/7 TOC + SQL plano (solo para el escaneo de secretos; no queda en el respaldo)"
docker run --rm -u "$(id -u):$(id -g)" -v "$SAL:/out" --entrypoint pg_restore "$IMG" --list /out/base.dump > "$SAL/toc.txt"
docker run --rm -u "$(id -u):$(id -g)" -v "$SAL:/out" --entrypoint pg_restore "$IMG" -f /out/.tmp/base.sql /out/base.dump
PGD=$(docker run --rm --entrypoint pg_dump "$IMG" --version | awk '{print $NF}')
VER=$(grep -o 'const VERSION_APP = "[^"]*"' "$RAIZ/taller-demo/app.js" | cut -d'"' -f2)
cat > "$SAL/meta.json" <<EOF
{"entimotors_version": "$VER", "creado_utc": "$TS", "origen": "$ORIGEN", "pg_dump_version": "$PGD", "origen_estable": $ESTABLE,
 "toc_entradas": $(grep -vc '^;' "$SAL/toc.txt")}
EOF
echo "7/7 manifiesto + sello + verificación + escaneo de secretos"
RC=0; node "$AQUI/respaldo.mjs" manifiesto --dir "$SAL" --meta "$SAL/meta.json" --sql-plano "$SAL/.tmp/base.sql" || RC=$?
rm -f "$SAL/meta.json"
[ "$ESTABLE" = true ] || { echo "el origen CAMBIÓ durante el respaldo (ver abajo): repetirlo en un momento sin actividad"; cat "$SAL/.tmp/diff-estabilidad.txt"; RC=1; }
find "$SAL" -type f ! -path "*/.tmp/*" -exec chmod 400 {} +
[ $RC -eq 0 ] && echo "RESPALDO VERIFICADO → $SAL" || echo "RESPALDO FALLIDO → $SAL (no entregar)"
exit $RC
