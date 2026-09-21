#!/usr/bin/env bash
# Corre una fase SQL de SYNC contra COPIAS aisladas de la base local de referencia (nunca producción).
#   correr-sql.sh 1      SYNC-1: forward x2 (idempotencia), pruebas, rollback seguro y ciclo forward/rollback/forward
# Requiere: pruebas/sync/entorno-local.sh up  (base de referencia cargada)
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
SQLDIR="$RAIZ/taller-demo/supabase/sync"
export PGPASSWORD=postgres
PSQL=(psql -X -q -h 127.0.0.1 -p 54432)
FALLOS=0; PASS=0

ok()  { PASS=$((PASS+1)); echo "  PASS  $1"; }
mal() { FALLOS=$((FALLOS+1)); echo "  FAIL  $1"; }
cuenta() { # cuenta líneas PASS/FAIL/ERROR de una salida de pruebas SQL
  local salida="$1"
  local p f e
  p=$(grep -c "NOTICE:  PASS: " <<<"$salida"); f=$(grep -c "NOTICE:  FAIL: " <<<"$salida"); e=$(grep -cE "^(psql:.*)?ERROR:" <<<"$salida")
  PASS=$((PASS+p)); FALLOS=$((FALLOS+f+e))
  echo "  pruebas SQL: $p PASS, $f FAIL, $e ERROR"
  grep -E "NOTICE:  FAIL: |^(psql:.*)?ERROR:" <<<"$salida" | sed 's/^/    /'
}
correr() { # correr <db> <archivo.sql> [usuario]  -> aplica un archivo y devuelve su salida completa
  "${PSQL[@]}" -U "${3:-supabase_admin}" -d "$1" -v ON_ERROR_STOP=1 -f "$2" 2>&1
}
pruebas() { # pruebas <db> <archivo.test.sql>...
  local db="$1"; shift
  local salida
  salida=$(cat "$AQUI/sql/00-prelude.sql" "$@" | "${PSQL[@]}" -U supabase_admin -d "$db" 2>&1)
  cuenta "$salida"
}

fase1() {
  echo "== SYNC-1 · esquema cloud =="
  "$AQUI/entorno-local.sh" copia t_sync1_a >/dev/null || { mal "no se pudo crear la copia A"; return; }
  local s
  s=$(correr t_sync1_a "$SQLDIR/sync-1-esquema.sql") && ok "forward aplica sobre la base de producción" || { mal "forward falló: $(tail -3 <<<"$s")"; return; }
  s=$(correr t_sync1_a "$SQLDIR/sync-1-esquema.sql") && ok "forward es idempotente (segunda ejecución)" || mal "forward NO es idempotente: $(tail -3 <<<"$s")"
  pruebas t_sync1_a "$AQUI/sql/01-esquema.test.sql"

  # con datos de prueba en las tablas nuevas, el rollback debe NEGARSE (nunca destruye información por defecto)
  s=$(correr t_sync1_a "$SQLDIR/sync-1-rollback.sql")
  if grep -q "ROLLBACK STOP" <<<"$s"; then ok "rollback sin permiso se niega si hay datos"; else mal "rollback no se negó con datos"; fi
  s=$(PGOPTIONS="-c sync.forzar_rollback=si" correr t_sync1_a "$SQLDIR/sync-1-rollback.sql")
  if grep -q "inventario_cantidad_check" <<<"$s" && grep -qi "violated" <<<"$s"; then ok "aun forzado, no restaura el CHECK falseando stock negativo"; else mal "el rollback forzado debía negarse por el stock negativo: $(tail -2 <<<"$s")"; fi
  node "$AQUI/baseline/verificar-fidelidad.mjs" db:t_sync1_a --db t_sync1_a >/dev/null && ok "tras los rollbacks rechazados el esquema no cambió" || mal "un rollback rechazado dejó cambios"
  "$AQUI/entorno-local.sh" borra t_sync1_a >/dev/null

  # ciclo limpio: forward -> rollback -> esquema idéntico al de producción -> forward otra vez
  "$AQUI/entorno-local.sh" copia t_sync1_b >/dev/null || { mal "no se pudo crear la copia B"; return; }
  correr t_sync1_b "$SQLDIR/sync-1-esquema.sql" >/dev/null || { mal "forward B falló"; return; }
  s=$(correr t_sync1_b "$SQLDIR/sync-1-rollback.sql") && ok "rollback limpio aplica" || { mal "rollback limpio falló: $(tail -3 <<<"$s")"; return; }
  if node "$AQUI/baseline/verificar-fidelidad.mjs" db:postgres --db t_sync1_b >/dev/null; then ok "tras el rollback el esquema es IDÉNTICO al de producción"; else mal "el rollback no devolvió el esquema de producción"; node "$AQUI/baseline/verificar-fidelidad.mjs" db:postgres --db t_sync1_b | tail -12; fi
  correr t_sync1_b "$SQLDIR/sync-1-esquema.sql" >/dev/null && ok "forward vuelve a aplicar tras el rollback" || mal "forward tras rollback falló"
  "$AQUI/entorno-local.sh" borra t_sync1_b >/dev/null
}

case "${1:-}" in
  1) fase1 ;;
  *) echo "uso: $0 {1}" >&2; exit 2 ;;
esac
echo "----"; echo "TOTAL: $PASS PASS, $FALLOS FAIL"
[ "$FALLOS" -eq 0 ]
