#!/usr/bin/env bash
# 3.15 · Bloque 8 · base de laboratorio para la PARIDAD de b5-finanzas-calc (dispositivo = servidor): la misma cadena que fase15e de
# correr-sql.sh + 15e + los datos de sus pruebas SQL. Antes había que prepararla a mano; sin ella la prueba se OMITÍA (y «0 pruebas» no vale).
#   b8-paridad-base.sh crea [t_15e_x] · b8-paridad-base.sh borra [t_15e_x]      (solo el Postgres LOCAL de pruebas)
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; SQLDIR="$(cd "$AQUI/../../taller-demo/supabase/sync" && pwd)"
DB=${2:-t_15e_x}; PSQL=(psql -X -q -h 127.0.0.1 -p 54432 -U supabase_admin); export PGPASSWORD=postgres
if [ "${1:-}" = borra ]; then "$AQUI/entorno-local.sh" borra "$DB" >/dev/null; echo "borrada $DB"; exit 0; fi
"$AQUI/entorno-local.sh" borra "$DB" >/dev/null 2>&1; "$AQUI/entorno-local.sh" copia "$DB" >/dev/null || { echo "copia $DB falló"; exit 1; }
"${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$AQUI/sql/15c-realtime-stub.sql" >/dev/null; "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$AQUI/sql/15d-auth-stub.sql" >/dev/null
for f in 1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario 9-fotos 10-importacion sec-1c-clave-intentos 15a-cotizacion-inventario 15b-presupuestos-stock 15c-mensajes-realtime 15d-owner-pin-usuarios 15e-finanzas; do
  arch="$SQLDIR/sync-$f.sql"; [[ "$f" == sec-* ]] && arch="$SQLDIR/$f.sql"
  "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$arch" >/dev/null 2>&1 || { echo "no se pudo aplicar $f"; exit 1; }
done
cat "$AQUI/sql/00-prelude.sql" "$AQUI/sql/15e-finanzas.test.sql" | "${PSQL[@]}" -d "$DB" > /tmp/b8-paridad-datos.log 2>&1
echo "$DB lista: $(grep -c 'PASS' /tmp/b8-paridad-datos.log) PASS / $(grep -c 'FAIL' /tmp/b8-paridad-datos.log) FAIL al sembrar · caja=$("${PSQL[@]}" -d "$DB" -Atc 'select count(*) from public.caja_movimientos')"
