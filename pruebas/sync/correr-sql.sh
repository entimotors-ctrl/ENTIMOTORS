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

base_con() { # base_con <db> <fase...>  -> copia de la base de referencia con las fases indicadas ya aplicadas
  local db="$1"; shift
  "$AQUI/entorno-local.sh" copia "$db" >/dev/null || return 1
  local f
  for f in "$@"; do correr "$db" "$SQLDIR/sync-$f.sql" >/dev/null || { echo "  no se pudo aplicar sync-$f en $db"; return 1; }; done
}
comparar() { # comparar <ref-db> <db> <mensaje-ok> <mensaje-mal>
  if node "$AQUI/baseline/verificar-fidelidad.mjs" "db:$1" --db "$2" >/dev/null; then ok "$3"; else mal "$4"; node "$AQUI/baseline/verificar-fidelidad.mjs" "db:$1" --db "$2" | tail -14; fi
}

fase2() {
  echo "== SYNC-2 · RLS y seguridad por rol =="
  base_con t_sync2_ref 1-esquema || { mal "no se pudo crear la referencia (baseline + SYNC-1)"; return; }
  base_con t_sync2_a 1-esquema || { mal "no se pudo crear la copia A"; return; }
  local s
  s=$(correr t_sync2_a "$SQLDIR/sync-2-seguridad.sql") && ok "forward aplica sobre producción + SYNC-1" || { mal "forward falló: $(tail -4 <<<"$s")"; return; }
  s=$(correr t_sync2_a "$SQLDIR/sync-2-seguridad.sql") && ok "forward es idempotente (segunda ejecución)" || mal "forward NO es idempotente: $(tail -3 <<<"$s")"
  pruebas t_sync2_a "$AQUI/sql/02-seguridad.test.sql"

  # con datos protegidos (ledger), el rollback se niega salvo permiso explícito
  s=$(correr t_sync2_a "$SQLDIR/sync-2-rollback.sql")
  if grep -q "ROLLBACK STOP" <<<"$s"; then ok "rollback sin permiso se niega si hay ledger/reversos"; else mal "rollback no se negó con datos protegidos"; fi
  comparar t_sync2_a t_sync2_a "un rollback rechazado no cambia nada" "rollback rechazado dejó cambios"
  s=$(PGOPTIONS="-c sync.forzar_rollback=si" correr t_sync2_a "$SQLDIR/sync-2-rollback.sql") && ok "rollback forzado aplica" || mal "rollback forzado falló: $(tail -3 <<<"$s")"
  comparar t_sync2_ref t_sync2_a "tras el rollback forzado, políticas/privilegios/triggers son IDÉNTICOS a producción+SYNC-1" "el rollback forzado no restauró el estado anterior"
  "$AQUI/entorno-local.sh" borra t_sync2_a >/dev/null

  base_con t_sync2_b 1-esquema 2-seguridad || { mal "no se pudo crear la copia B"; return; }
  s=$(correr t_sync2_b "$SQLDIR/sync-2-rollback.sql") && ok "rollback limpio aplica" || { mal "rollback limpio falló: $(tail -3 <<<"$s")"; return; }
  comparar t_sync2_ref t_sync2_b "tras el rollback limpio el esquema es IDÉNTICO a producción+SYNC-1" "el rollback limpio no restauró el estado anterior"
  correr t_sync2_b "$SQLDIR/sync-2-seguridad.sql" >/dev/null && ok "forward vuelve a aplicar tras el rollback" || mal "forward tras rollback falló"
  "$AQUI/entorno-local.sh" borra t_sync2_b >/dev/null; "$AQUI/entorno-local.sh" borra t_sync2_ref >/dev/null
}

# Concurrencia real: varias sesiones psql a la vez contra la misma base (cada una como cajero con su propio JWT simulado)
sql_como() { # sql_como <db> <n_usuario> <sentencias...>  -> ejecuta como authenticated con el usuario N
  local db="$1" n="$2"; shift 2
  "${PSQL[@]}" -U supabase_admin -d "$db" -At -v ON_ERROR_STOP=0 \
    -c "SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000$n',false), set_config('request.jwt.claim.role','authenticated',false), set_config('role','authenticated',false)" \
    -c "$*" 2>&1 | tail -n +2
}
fase3() {
  echo "== SYNC-3 · RPC transaccionales e importación =="
  local s
  # --- A: aplicar (idempotente) y probar las RPC ---
  base_con t_sync3_ref 1-esquema 2-seguridad || { mal "no se pudo crear la referencia (SYNC-1+2)"; return; }
  base_con t_sync3_a 1-esquema 2-seguridad || { mal "no se pudo crear la copia A"; return; }
  s=$(correr t_sync3_a "$SQLDIR/sync-3-rpc.sql") && ok "sync-3-rpc aplica sobre SYNC-1+2" || { mal "sync-3-rpc falló: $(tail -4 <<<"$s")"; return; }
  s=$(correr t_sync3_a "$SQLDIR/sync-3b-importacion.sql") && ok "sync-3b-importacion aplica" || { mal "sync-3b falló: $(tail -4 <<<"$s")"; return; }
  correr t_sync3_a "$SQLDIR/sync-3-rpc.sql" >/dev/null && correr t_sync3_a "$SQLDIR/sync-3b-importacion.sql" >/dev/null && ok "ambos son idempotentes (segunda ejecución)" || mal "no son idempotentes"
  pruebas t_sync3_a "$AQUI/sql/03-rpc.test.sql"

  # --- B: concurrencia ---
  echo "  -- concurrencia --"
  cat "$AQUI/sql/00-prelude.sql" - <<'SQL' | "${PSQL[@]}" -U supabase_admin -d t_sync3_a >/dev/null 2>&1
INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES ('00000000-0000-4000-9000-000000000901', 'Concurrente', 10, 5) ON CONFLICT DO NOTHING;
INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES ('00000000-0000-4000-9000-000000000901', 'apertura', 5);
SQL
  local item='[{"inventario_id":"00000000-0000-4000-9000-000000000901","nombre":"Concurrente","cantidad":1,"precio":10}]'
  # 8 reintentos SIMULTÁNEOS de la MISMA operación
  local op='00000000-0000-4000-9000-000000000a01'
  local ventas caja stock
  for k in 1 2 3 4 5 6 7 8; do sql_como t_sync3_a 2 "SELECT public.registrar_venta_v2('$op'::uuid, NULL, 'x', 'efectivo', 10, '$item'::jsonb)" >/dev/null & done; wait
  ventas=$("${PSQL[@]}" -U supabase_admin -d t_sync3_a -At -c "SELECT count(*) FROM public.ventas WHERE op_id = '$op'")
  caja=$("${PSQL[@]}" -U supabase_admin -d t_sync3_a -At -c "SELECT count(*) FROM public.caja_movimientos WHERE op_id = '$op'")
  stock=$("${PSQL[@]}" -U supabase_admin -d t_sync3_a -At -c "SELECT cantidad::int FROM public.inventario WHERE id = '00000000-0000-4000-9000-000000000901'")
  [ "$ventas" = "1" ] && ok "8 reintentos simultáneos del mismo operation_id → UNA venta" || mal "reintentos concurrentes: $ventas ventas (esperaba 1)"
  [ "$caja" = "1" ] && ok "8 reintentos simultáneos → UNA fila de caja" || mal "reintentos concurrentes: $caja filas de caja (esperaba 1)"
  [ "$stock" = "4" ] && ok "8 reintentos simultáneos → stock descontado UNA vez (5 → 4)" || mal "reintentos concurrentes: stock $stock (esperaba 4)"
  # 12 ventas DISTINTAS a la vez sobre 4 unidades restantes: exactamente 4 deben entrar, el resto se bloquea por falta de stock
  for k in $(seq 1 12); do
    sql_como t_sync3_a 2 "SELECT public.registrar_venta_v2('00000000-0000-4000-9000-0000000b$(printf %04d $k)'::uuid, NULL, 'x', 'efectivo', 10, '$item'::jsonb)" >/dev/null &
  done; wait
  ventas=$("${PSQL[@]}" -U supabase_admin -d t_sync3_a -At -c "SELECT count(*) FROM public.ventas WHERE op_id::text LIKE '00000000-0000-4000-9000-0000000b%'")
  stock=$("${PSQL[@]}" -U supabase_admin -d t_sync3_a -At -c "SELECT cantidad::int FROM public.inventario WHERE id = '00000000-0000-4000-9000-000000000901'")
  [ "$ventas" = "4" ] && [ "$stock" = "0" ] && ok "12 ventas simultáneas con 4 en stock → exactamente 4 entran y el stock queda en 0 (nunca negativo online)" || mal "concurrencia de stock: $ventas ventas, stock $stock (esperaba 4 y 0)"
  # 6 abonos simultáneos de la MISMA operación sobre un crédito
  sql_como t_sync3_a 2 "SELECT public.registrar_credito('00000000-0000-4000-9000-000000000c01'::uuid, NULL, 'Cliente', NULL, '[{\"nombre\":\"Servicio\",\"cantidad\":1,\"precio\":100}]'::jsonb)" >/dev/null
  local cid; cid=$("${PSQL[@]}" -U supabase_admin -d t_sync3_a -At -c "SELECT id FROM public.creditos WHERE op_id = '00000000-0000-4000-9000-000000000c01'")
  for k in 1 2 3 4 5 6; do sql_como t_sync3_a 2 "SELECT public.registrar_abono_v2('00000000-0000-4000-9000-000000000c02'::uuid, '$cid'::uuid, 40, 'efectivo')" >/dev/null & done; wait
  local ab; ab=$("${PSQL[@]}" -U supabase_admin -d t_sync3_a -At -c "SELECT count(*) || '/' || (SELECT saldo FROM public.creditos WHERE id = '$cid') FROM public.abonos WHERE credito_id = '$cid'")
  [ "$ab" = "1/60.00" ] && ok "6 abonos simultáneos de la misma operación → UN abono (saldo 60)" || mal "abonos concurrentes: $ab (esperaba 1/60.00)"
  s=$("${PSQL[@]}" -U supabase_admin -d t_sync3_a -At -c "SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false), set_config('role','authenticated',false)" -c "SELECT public.verificar_invariantes()::text" | tail -1)
  [ "$s" = "[]" ] && ok "invariantes tras la concurrencia: stock=ledger, saldos y ventas cuadran" || mal "invariantes rotas tras la concurrencia: $s"
  "$AQUI/entorno-local.sh" borra t_sync3_a >/dev/null

  # --- C: importación (base sin datos operativos) ---
  base_con t_sync3_i 1-esquema 2-seguridad 3-rpc 3b-importacion || { mal "no se pudo crear la copia de importación"; return; }
  pruebas t_sync3_i "$AQUI/sql/03b-importacion.test.sql"
  "$AQUI/entorno-local.sh" borra t_sync3_i >/dev/null
  base_con t_sync3_r 1-esquema 2-seguridad 3-rpc 3b-importacion || { mal "no se pudo crear la copia de revertir"; return; }
  pruebas t_sync3_r "$AQUI/sql/03c-revertir.test.sql"
  "$AQUI/entorno-local.sh" borra t_sync3_r >/dev/null
  base_con t_sync3_n 1-esquema 2-seguridad 3-rpc 3b-importacion || { mal "no se pudo crear la copia no vacía"; return; }
  s=$(cat "$AQUI/sql/00-prelude.sql" - <<'SQL' | "${PSQL[@]}" -U supabase_admin -d t_sync3_n 2>&1
INSERT INTO public.clientes (nombre) VALUES ('ya existe');
DO $$ BEGIN PERFORM pg_temp.como(1); PERFORM pg_temp.falla('con datos operativos en la nube, la importación inicial se rechaza', format('SELECT public.import_iniciar(NULL, ''x'', %L, ''b'', ''3.13.0'', 6, ''{}'')', repeat('a', 64)), 'exige una base vacía'); PERFORM pg_temp.fin(); END $$;
SQL
)
  cuenta "$s"
  "$AQUI/entorno-local.sh" borra t_sync3_n >/dev/null

  # --- D: rollback limpio e idéntico ---
  base_con t_sync3_b 1-esquema 2-seguridad 3-rpc 3b-importacion || { mal "no se pudo crear la copia B"; return; }
  s=$(correr t_sync3_b "$SQLDIR/sync-3-rollback.sql") && ok "rollback de SYNC-3 aplica" || { mal "rollback falló: $(tail -3 <<<"$s")"; return; }
  comparar t_sync3_ref t_sync3_b "tras el rollback el esquema es IDÉNTICO a producción+SYNC-1+SYNC-2" "el rollback de SYNC-3 no restauró el estado anterior"
  correr t_sync3_b "$SQLDIR/sync-3-rpc.sql" >/dev/null && correr t_sync3_b "$SQLDIR/sync-3b-importacion.sql" >/dev/null && ok "forward vuelve a aplicar tras el rollback" || mal "forward tras rollback falló"
  "$AQUI/entorno-local.sh" borra t_sync3_b >/dev/null; "$AQUI/entorno-local.sh" borra t_sync3_ref >/dev/null
}

fase3p() {
  echo "== SYNC-3P · límites del PIN (SQL) =="
  local s
  base_con t_sync3p_ref 1-esquema 2-seguridad 3-rpc 3b-importacion || { mal "no se pudo crear la referencia"; return; }
  base_con t_sync3p_a 1-esquema 2-seguridad 3-rpc 3b-importacion || { mal "no se pudo crear la copia A"; return; }
  s=$(correr t_sync3p_a "$SQLDIR/sync-3p-pin.sql") && ok "sync-3p-pin aplica" || { mal "sync-3p falló: $(tail -4 <<<"$s")"; return; }
  correr t_sync3p_a "$SQLDIR/sync-3p-pin.sql" >/dev/null && ok "es idempotente (segunda ejecución)" || mal "no es idempotente"
  pruebas t_sync3p_a "$AQUI/sql/04-pin.test.sql"
  # carreras: 20 intentos SIMULTÁNEOS del mismo solicitante → exactamente 5 pasan
  cat "$AQUI/sql/00-prelude.sql" - <<'SQL' | "${PSQL[@]}" -U supabase_admin -d t_sync3p_a >/dev/null 2>&1
INSERT INTO public.admin_pin (perfil_id, hash, version) VALUES (pg_temp.uid(1), 'hash-de-prueba', 1) ON CONFLICT (perfil_id) DO UPDATE SET bloqueado_hasta = NULL, actualizado_en = clock_timestamp();
SQL
  for k in $(seq 1 20); do "${PSQL[@]}" -U supabase_admin -d t_sync3p_a -At -c "SELECT public.pin_reservar_intento('00000000-0000-4000-8000-000000000002'::uuid,'dev','ajustar_stock','inventario',NULL,5,10,15,15,3)->>'permitido'" >/dev/null 2>&1 & done; wait
  local res; res=$("${PSQL[@]}" -U supabase_admin -d t_sync3p_a -At -c "SELECT count(*) FROM public.admin_pin_intentos WHERE resultado='reservado' AND solicitante_id='00000000-0000-4000-8000-000000000002' AND creado_en > (SELECT actualizado_en FROM public.admin_pin)")
  [ "$res" = "5" ] && ok "20 intentos simultáneos → exactamente 5 reservados (el candado impide evadir el contador)" || mal "carrera: $res reservados (esperaba 5)"
  "$AQUI/entorno-local.sh" borra t_sync3p_a >/dev/null
  base_con t_sync3p_b 1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin || { mal "no se pudo crear la copia B"; return; }
  s=$(correr t_sync3p_b "$SQLDIR/sync-3p-rollback.sql") && ok "rollback aplica" || { mal "rollback falló: $(tail -3 <<<"$s")"; return; }
  comparar t_sync3p_ref t_sync3p_b "tras el rollback el esquema es IDÉNTICO al anterior" "el rollback de SYNC-3P no restauró el estado anterior"
  correr t_sync3p_b "$SQLDIR/sync-3p-pin.sql" >/dev/null && ok "forward vuelve a aplicar tras el rollback" || mal "forward tras rollback falló"
  "$AQUI/entorno-local.sh" borra t_sync3p_b >/dev/null; "$AQUI/entorno-local.sh" borra t_sync3p_ref >/dev/null
}

case "${1:-}" in
  1) fase1 ;;
  3p) fase3p ;;
  2) fase2 ;;
  3) fase3 ;;
  *) echo "uso: $0 {1|2|3|3p}" >&2; exit 2 ;;
esac
echo "----"; echo "TOTAL: $PASS PASS, $FALLOS FAIL"
[ "$FALLOS" -eq 0 ]
