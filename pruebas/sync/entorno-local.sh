#!/usr/bin/env bash
# Entorno PostgreSQL LOCAL para las fases SYNC-1..3 (esquema, RLS y RPC). Nunca toca producción.
#
#   entorno-local.sh up        recrea el contenedor y carga la base de referencia (= producción 2026-09-21)
#   entorno-local.sh down      borra el contenedor
#   entorno-local.sh psql ...  psql contra la base de referencia
#   entorno-local.sh copia N   crea la base aislada "N" como copia de la de referencia
#   entorno-local.sh borra N   elimina la base "N"
#
# Solo actúa sobre el contenedor local "entimotors-sync-pg" en 127.0.0.1:54432, con la clave de
# desarrollo de la imagen (no es un secreto: la base solo existe en esta máquina).
set -euo pipefail

CONT=entimotors-sync-pg
PUERTO=54432
IMAGEN=public.ecr.aws/supabase/postgres:17.6.1.134
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
export PGPASSWORD=postgres PGHOST=127.0.0.1 PGPORT=$PUERTO PGUSER=postgres

psql_() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

esperar() {
  for _ in $(seq 1 60); do
    pg_isready -q -h 127.0.0.1 -p $PUERTO && return 0
    sleep 1
  done
  echo "el Postgres local no respondió" >&2; exit 1
}

cargar_baseline() {
  local d="$AQUI/baseline"
  # el esquema storage pertenece a supabase_admin en la imagen; el stub cede después la propiedad a postgres
  psql_ -U supabase_admin -d postgres -f "$d/baseline-0-stub-storage.sql"
  # producción no da nada a `anon` por defecto en public (verificado en el catálogo, sección 14); la imagen sí.
  psql_ -d postgres -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon" \
                    -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon" \
                    -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon"
  psql_ -d postgres -f "$d/baseline-a-tablas.sql"
  psql_ -d postgres -f "$RAIZ/taller-demo/supabase/entimotors-rcv34-source-sync.sql" > /dev/null
  psql_ -d postgres -f "$d/baseline-c-politicas.sql"
}

case "${1:-}" in
  up)
    docker rm -f $CONT >/dev/null 2>&1 || true
    docker run -d --name $CONT -p 127.0.0.1:$PUERTO:5432 -e POSTGRES_PASSWORD=postgres --shm-size=256m "$IMAGEN" >/dev/null
    esperar
    sleep 3; esperar
    cargar_baseline
    echo "base de referencia cargada en 127.0.0.1:$PUERTO (db postgres)"
    ;;
  down)   docker rm -f $CONT >/dev/null 2>&1 || true; echo "contenedor eliminado" ;;
  psql)   shift; exec psql -X -v ON_ERROR_STOP=1 -d postgres "$@" ;;
  copia)
    # postgres tiene 2 workers internos (pg_net, pg_cron) que impiden usarla como plantilla: se cierran justo antes de copiar
    psql_ -U supabase_admin -d template1 -c "DROP DATABASE IF EXISTS \"$2\" WITH (FORCE)"
    for intento in 1 2 3 4 5 6; do
      if psql_ -U supabase_admin -d template1 \
           -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid()" >/dev/null \
           -c "CREATE DATABASE \"$2\" TEMPLATE postgres" 2>/dev/null; then
        exit 0
      fi
      sleep 1
    done
    echo "no se pudo copiar la base de referencia" >&2; exit 1 ;;
  borra)  psql_ -U supabase_admin -d template1 -c "DROP DATABASE IF EXISTS \"$2\" WITH (FORCE)" ;;
  *) echo "uso: $0 {up|down|psql|copia N|borra N}" >&2; exit 2 ;;
esac
