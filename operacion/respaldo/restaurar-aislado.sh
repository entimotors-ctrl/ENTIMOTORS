#!/usr/bin/env bash
# ENTIMOTORS 3.15 · Bloque 5 · RESTAURACIÓN DE PRUEBA, SOLO EN AISLAMIENTO.
#
#   restaurar-aislado.sh DIR_RESPALDO [--conservar]
#
# No acepta destino: crea SIEMPRE un contenedor PostgreSQL nuevo y desechable, SIN RED (--network none), restaura ahí y lo borra.
# No hay forma de apuntarlo a producción ni a otra base (cualquier argumento de conexión se rechaza antes de hacer nada).
# Pasos: verificar respaldo (hashes/manifiesto/formato/versión) → contenedor nuevo → pre-data → data → usuarios saneados → post-data
#        → foto lógica + foto financiera de la restaurada → comparar con el origen → Storage a una carpeta aislada y verificar.
# Sale 0 solo si TODO coincide. Deja el informe en DIR_RESPALDO/../restauracion-<ts>/ (fuera del respaldo, que es de solo lectura).
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMG=public.ecr.aws/supabase/postgres:17.6.1.134
for a in "$@"; do
  case "$a" in
    --conservar) ;;
    --destino*|*service=*|postgres://*|postgresql://*|*host=*|*supabase.co*|*pooler*|--db*|--url*)
      echo "RESTAURACIÓN A UN DESTINO EXTERNO PROHIBIDA: esta herramienta solo restaura en un contenedor desechable sin red. ($a)" >&2; exit 3 ;;
    -*) echo "argumento desconocido: $a" >&2; exit 2 ;;
  esac
done
DIR=${1:?uso: restaurar-aislado.sh DIR_RESPALDO [--conservar]}; DIR="$(cd "$DIR" && pwd)"
CONSERVAR=false; [ "${2:-}" = "--conservar" ] && CONSERVAR=true
VER=$(grep -o 'const VERSION_APP = "[^"]*"' "$AQUI/../../taller-demo/app.js" | cut -d'"' -f2)
OUT="$(dirname "$DIR")/restauracion-$(basename "$DIR")-$(date -u +%Y%m%dT%H%M%SZ)"; umask 077; mkdir -p -m 700 "$OUT"

echo "1/6 verificar el respaldo ANTES de tocar nada"
node "$AQUI/respaldo.mjs" verificar --dir "$DIR" --restaurador-version "$VER" | tee "$OUT/verificacion.txt" || { echo "RESTAURACIÓN NO INICIADA: respaldo rechazado"; exit 1; }

RESTO=entimotors-restore-$(date -u +%s)-$$
echo "2/6 contenedor desechable SIN RED ($RESTO)"
docker run -d --rm --name "$RESTO" --network none -e POSTGRES_PASSWORD=desechable -v "$DIR:/in:ro" "$IMG" >/dev/null
$CONSERVAR || trap 'docker rm -f "$RESTO" >/dev/null 2>&1 || true' EXIT
[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$RESTO")" = "none" ] || { echo "el contenedor tiene red: abortado"; exit 1; }
for i in $(seq 1 120); do docker logs "$RESTO" 2>&1 | grep -q 'PostgreSQL init process complete' && break; sleep 2; done
for i in $(seq 1 60); do docker exec "$RESTO" psql -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1 && break; sleep 2; done
docker exec "$RESTO" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_realtime_admin') THEN CREATE ROLE supabase_realtime_admin NOLOGIN; END IF; END \$\$;" \
  -c "CREATE DATABASE restaurada"

echo "3/6 pg_restore por secciones + usuarios saneados"
set +e
{ docker exec "$RESTO" pg_restore -U supabase_admin -d restaurada --section=pre-data /in/base.dump
  docker exec "$RESTO" pg_restore -U supabase_admin -d restaurada --section=data /in/base.dump
  docker exec -i "$RESTO" psql -U supabase_admin -d restaurada -v ON_ERROR_STOP=1 -q -c "SET session_replication_role = replica" \
    -c "\copy auth.users (id, aud, role, email, email_confirmed_at, banned_until, created_at, updated_at, is_sso_user, is_anonymous, deleted_at, raw_app_meta_data) FROM '/in/auth-usuarios.csv' WITH (FORMAT csv, HEADER)"
  echo "auth_rc=$?"
  docker exec "$RESTO" pg_restore -U supabase_admin -d restaurada --section=post-data /in/base.dump; } > "$OUT/restore.log" 2>&1
set -e
ERR=$(grep -c '^pg_restore: error:' "$OUT/restore.log" || true)
DESC=$(grep '^pg_restore: error:' "$OUT/restore.log" | grep -vc 'graphql_public.graphql' || true)
AUTH_OK=$(grep -c '^auth_rc=0$' "$OUT/restore.log" || true)
echo "pg_restore: errores=$ERR desconocidos=$DESC (conocido e inocuo: GRANT sobre graphql_public.graphql, de la plataforma) · usuarios=$([ "$AUTH_OK" = 1 ] && echo cargados || echo FALLO)"

echo "4/6 fotos de la restaurada"
docker exec -i "$RESTO" psql -U supabase_admin -d restaurada -X -q -v ON_ERROR_STOP=1 -A -F'|' -t < "$AQUI/sql/foto-negocio.sql" > "$OUT/foto-restaurada.txt"
docker exec -i "$RESTO" psql -U supabase_admin -d restaurada -X -q -v ON_ERROR_STOP=1 -A -F'|' -t < "$AQUI/sql/foto-financiera.sql" > "$OUT/finanzas-restaurada.txt"

echo "5/6 comparar origen ↔ restaurada"
R1=0; node "$AQUI/respaldo.mjs" comparar --origen "$DIR/foto-origen.txt" --restaurada "$OUT/foto-restaurada.txt" | tee "$OUT/comparar-negocio.txt" || R1=1
R2=0; node "$AQUI/respaldo.mjs" comparar --origen "$DIR/finanzas-origen.txt" --restaurada "$OUT/finanzas-restaurada.txt" | tee "$OUT/comparar-finanzas.txt" || R2=1

echo "6/6 Storage a una carpeta AISLADA y verificación contra la base restaurada"
mkdir -p "$OUT/storage-restaurado"; [ -d "$DIR/storage" ] && cp -rp "$DIR/storage/." "$OUT/storage-restaurado/"
R3=0; node "$AQUI/respaldo.mjs" storage-verificar --foto "$OUT/foto-restaurada.txt" --raiz "$OUT/storage-restaurado" | tee "$OUT/storage.txt" || R3=1
chmod -R u+w "$OUT/storage-restaurado"

OK=true; { [ "$DESC" = 0 ] && [ "$AUTH_OK" = 1 ] && [ $R1 = 0 ] && [ $R2 = 0 ] && [ $R3 = 0 ]; } || OK=false
{ echo "respaldo=$DIR"; echo "manifiesto=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DIR/manifiesto.json','utf8')).manifiesto_sha256)")"
  echo "contenedor=$RESTO red=none"; echo "pg_restore_errores=$ERR desconocidos=$DESC usuarios_cargados=$AUTH_OK"
  echo "negocio=$([ $R1 = 0 ] && echo IGUAL || echo DIFERENTE) finanzas=$([ $R2 = 0 ] && echo IGUAL || echo DIFERENTE) storage=$([ $R3 = 0 ] && echo IGUAL || echo DIFERENTE)"
  grep -E '^(huella_negocio|huella_auth_usuarios|huella_storage_objetos|invariantes|invariantes_finanzas)\|' "$OUT/foto-restaurada.txt"
  echo "RESULTADO=$($OK && echo PASS || echo FAIL)"; } | tee "$OUT/RESUMEN.txt"
$OK
