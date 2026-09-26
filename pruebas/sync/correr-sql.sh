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
  for f in "$@"; do   # «sec-*» (3.14.1) es el nombre del archivo tal cual; el resto, sync-<fase>.sql
    local arch="$SQLDIR/sync-$f.sql"; [[ "$f" == sec-* ]] && arch="$SQLDIR/$f.sql"
    correr "$db" "$arch" >/dev/null || { echo "  no se pudo aplicar $(basename "$arch") en $db"; return 1; }
  done
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

fase7b() {
  echo "== SYNC-7B · dinero, stock, reversos con PIN, invariantes exactas =="
  local s
  base_con t_sync7b_a 1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario || { mal "no se pudo crear la copia con SYNC-1..7A"; return; }
  # las hojas que SYNC-7B cambió se re-aplican encima (idempotentes): ERRCODE 23503 + sync_autorizar con dispositivo
  s=$(correr t_sync7b_a "$SQLDIR/sync-3-rpc.sql") && ok "sync-3-rpc (7B) re-aplica sobre SYNC-1..7A" || { mal "sync-3-rpc falló: $(tail -4 <<<"$s")"; return; }
  s=$(correr t_sync7b_a "$SQLDIR/sync-7a-inventario.sql") && ok "sync-7a (7B) re-aplica" || { mal "sync-7a falló: $(tail -4 <<<"$s")"; return; }
  s=$("${PSQL[@]}" -U supabase_admin -d t_sync7b_a -At -c "SELECT count(*) FROM pg_proc WHERE proname = 'sync_autorizar' AND pronamespace = 'public'::regnamespace")
  [ "$s" = "1" ] && ok "una sola firma de sync_autorizar (la de 6 argumentos se retiró)" || mal "sync_autorizar tiene $s firmas"
  pruebas t_sync7b_a "$AQUI/sql/05-finanzas.test.sql"
  "$AQUI/entorno-local.sh" borra t_sync7b_a >/dev/null
  # regresión: las pruebas de SYNC-3 y SYNC-3P siguen en verde con los cambios de 7B
  fase3
  fase3p
}
# SYNC-9: agregar_foto_orden + límites del bucket privado. Aquí: forward x2 (idempotente), guardas estáticas, rollback
# y forward de nuevo. El comportamiento en runtime (Storage REAL + RLS + RPC) lo prueban browser/sync9-core y sync9-app-real.
fase9() {
  echo "== SYNC-9 · fotos: ligado solo-agregar + límites del bucket (SQL) =="
  local s q
  base_con t_sync9_a 1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario || { mal "no se pudo crear la copia con SYNC-1..7A"; return; }
  q() { "${PSQL[@]}" -U supabase_admin -d t_sync9_a -At -c "$1"; }
  s=$(correr t_sync9_a "$SQLDIR/sync-9-fotos.sql") && ok "sync-9 aplica" || { mal "sync-9 falló: $(tail -4 <<<"$s")"; return; }
  s=$(correr t_sync9_a "$SQLDIR/sync-9-fotos.sql") && ok "sync-9 re-aplica (idempotente)" || mal "sync-9 no es idempotente: $(tail -4 <<<"$s")"
  [ "$(q "SELECT has_function_privilege('anon','public.agregar_foto_orden(uuid,uuid,text,text)','EXECUTE')")" = "f" ] && ok "anon NO ejecuta agregar_foto_orden" || mal "anon ejecuta agregar_foto_orden"
  [ "$(q "SELECT has_function_privilege('authenticated','public.agregar_foto_orden(uuid,uuid,text,text)','EXECUTE')")" = "t" ] && ok "authenticated ejecuta agregar_foto_orden (la función decide: solo mecánico activo asignado)" || mal "authenticated sin EXECUTE"
  [ "$(q "SELECT prosecdef FROM pg_proc WHERE proname='agregar_foto_orden'")" = "t" ] && ok "SECURITY DEFINER con search_path fijo" || mal "no es SECURITY DEFINER"
  [ "$(q "SELECT allowed_mime_types::text || '|' || file_size_limit || '|' || public FROM storage.buckets WHERE id='entimotors-taller'")" = "{image/jpeg}|10485760|false" ] && ok "bucket privado: solo image/jpeg, 10 MiB" || mal "límites del bucket incorrectos"
  [ "$(q "SELECT count(*) FROM storage.buckets WHERE id='entimotors-media' AND public AND allowed_mime_types IS NULL")" = "1" ] && ok "el bucket público de la web (entimotors-media) no se tocó" || mal "entimotors-media cambió"
  [ "$(q "SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname IN ('taller_lee_media','taller_sube_media','taller_borra_media')")" = "3" ] && ok "políticas de Storage intactas (SYNC-2 + producción)" || mal "políticas de Storage cambiaron"
  [ "$(q "SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND cmd='UPDATE'")" = "0" ] && ok "sin política UPDATE en storage.objects (nadie reemplaza fotos)" || mal "apareció una política UPDATE"
  [ "$(q "SELECT position('v_permitidos' in prosrc) > 0 FROM pg_proc WHERE proname='avanzar_orden_tecnico'")" = "t" ] && ok "avanzar_orden_tecnico (SYNC-6) sin cambios" || mal "avanzar_orden_tecnico cambió"
  s=$(correr t_sync9_a "$SQLDIR/sync-9-rollback.sql") && ok "rollback aplica" || mal "rollback falló: $(tail -4 <<<"$s")"
  [ "$(q "SELECT count(*) FROM pg_proc WHERE proname='agregar_foto_orden'")" = "0" ] && ok "rollback: función retirada" || mal "rollback: la función sigue"
  [ "$(q "SELECT coalesce(allowed_mime_types::text,'null') || '|' || coalesce(file_size_limit::text,'null') FROM storage.buckets WHERE id='entimotors-taller'")" = "null|null" ] && ok "rollback: bucket como estaba (sin límites)" || mal "rollback: bucket no restaurado"
  s=$(correr t_sync9_a "$SQLDIR/sync-9-fotos.sql") && ok "forward → rollback → forward" || mal "no re-aplica tras rollback: $(tail -4 <<<"$s")"
  "$AQUI/entorno-local.sh" borra t_sync9_a >/dev/null
}
# SYNC-10: importación atómica del respaldo 3.13 + P0002 → 23503 en sync-5/sync-6. Cadena COMPLETA sobre la base de
# referencia (1, 2, 3, 3b, 3p, 5, 6, 7a, 9) + 10; forward x2; pruebas; rollback; forward de nuevo. Además: la cadena
# entera aplicada DOS veces (idempotencia) y las fases que cambiaron (5 y 6) re-aplicadas encima.
fase10() {
  echo "== SYNC-10 · importación 3.13 → nube (atómica, idempotente, solo admin) + P0002 → 23503 =="
  local s q f
  local CADENA="1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario 9-fotos"
  base_con t_sync10_ref $CADENA || { mal "no se pudo crear la referencia (cadena 1..9)"; return; }
  base_con t_sync10_a $CADENA || { mal "no se pudo crear la copia con la cadena 1..9"; return; }
  q() { "${PSQL[@]}" -U supabase_admin -d t_sync10_a -At -c "$1"; }
  ok "cadena 1 → 2 → 3 → 3b → 3p → 5 → 6 → 7a → 9 aplica sobre la base de producción"
  s=$(correr t_sync10_a "$SQLDIR/sync-10-importacion.sql") && ok "sync-10 aplica" || { mal "sync-10 falló: $(tail -4 <<<"$s")"; return; }
  s=$(correr t_sync10_a "$SQLDIR/sync-10-importacion.sql") && ok "sync-10 re-aplica (idempotente)" || mal "sync-10 no es idempotente: $(tail -4 <<<"$s")"
  for f in $CADENA; do correr t_sync10_a "$SQLDIR/sync-$f.sql" >/dev/null || { mal "re-aplicar sync-$f sobre la cadena completa falló"; }; done
  ok "la cadena completa re-aplica encima (idempotente, incluidas 5 y 6 con 23503)"
  [ "$(q "SELECT has_function_privilege('anon','public.import_aplicar_paquete(uuid,jsonb)','EXECUTE')")" = "f" ] && ok "anon NO ejecuta import_aplicar_paquete" || mal "anon ejecuta import_aplicar_paquete"
  [ "$(q "SELECT prosecdef FROM pg_proc WHERE proname='import_aplicar_paquete'")" = "t" ] && ok "SECURITY DEFINER con search_path fijo" || mal "no es SECURITY DEFINER"
  pruebas t_sync10_a "$AQUI/sql/10-importacion.test.sql"
  "$AQUI/entorno-local.sh" borra t_sync10_a >/dev/null
  # regresión: las pruebas SQL de la importación por lote de SYNC-3b siguen en verde con la cadena completa + 10
  base_con t_sync10_b $CADENA 10-importacion || { mal "no se pudo crear la copia B"; return; }
  pruebas t_sync10_b "$AQUI/sql/03b-importacion.test.sql"
  "$AQUI/entorno-local.sh" borra t_sync10_b >/dev/null
  # rollback: quita SOLO las funciones nuevas; el esquema vuelve a ser idéntico al de la cadena 1..9 (con 5/6 de SYNC-10)
  base_con t_sync10_c $CADENA 10-importacion || { mal "no se pudo crear la copia C"; return; }
  s=$(correr t_sync10_c "$SQLDIR/sync-10-rollback.sql") && ok "rollback aplica" || { mal "rollback falló: $(tail -4 <<<"$s")"; return; }
  comparar t_sync10_ref t_sync10_c "tras el rollback el esquema es IDÉNTICO a la cadena 1..9" "el rollback de SYNC-10 no restauró el estado anterior"
  s=$(correr t_sync10_c "$SQLDIR/sync-10-importacion.sql") && ok "forward → rollback → forward" || mal "no re-aplica tras rollback: $(tail -4 <<<"$s")"
  "$AQUI/entorno-local.sh" borra t_sync10_c >/dev/null; "$AQUI/entorno-local.sh" borra t_sync10_ref >/dev/null
}
fasesec1c() {
  echo "== SECURITY-1C · límite persistente de intentos del cambio de contraseña del admin (SQL) =="
  local s r t0 t1 ms
  local CADENA="1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario 9-fotos 10-importacion"
  local A1=00000000-0000-4000-8000-000000000001 A2=00000000-0000-4000-8000-000000000007
  base_con t_sec1c_ref $CADENA || { mal "no se pudo crear la referencia (cadena SYNC 1..10 = producción)"; return; }
  base_con t_sec1c_a $CADENA || { mal "no se pudo crear la copia A"; return; }
  ok "cadena SYNC 1 → 10 (estado de producción) aplica"
  s=$(correr t_sec1c_a "$SQLDIR/sec-1c-clave-intentos.sql") && ok "sec-1c aplica" || { mal "sec-1c falló: $(tail -4 <<<"$s")"; return; }
  s=$(correr t_sec1c_a "$SQLDIR/sec-1c-clave-intentos.sql") && ok "sec-1c re-aplica (idempotente)" || mal "sec-1c no es idempotente: $(tail -4 <<<"$s")"
  pruebas t_sec1c_a "$AQUI/sql/sec1c-clave-intentos.test.sql"

  # ── concurrencia REAL: sesiones psql en paralelo (copia C con un 2.º admin sembrado SOLO aquí, saltando el trigger de admin único) ──
  base_con t_sec1c_c $CADENA sec-1c-clave-intentos || { mal "no se pudo crear la copia C"; return; }
  cat "$AQUI/sql/00-prelude.sql" - <<SQL | "${PSQL[@]}" -U supabase_admin -d t_sec1c_c >/dev/null 2>&1
SET session_replication_role = replica;
INSERT INTO auth.users (id, email) VALUES ('$A2', 'u7@example.test') ON CONFLICT DO NOTHING;
INSERT INTO public.perfiles (id, nombre, rol, activo) VALUES ('$A2', 'Admin 2 (solo prueba)', 'admin', true) ON CONFLICT (id) DO UPDATE SET rol = 'admin', activo = true;
SQL
  q() { "${PSQL[@]}" -U supabase_admin -d t_sec1c_c -At -c "$1"; }
  for k in $(seq 1 20); do q "SELECT public.clave_reservar_intento('$A1',5,15,15,60)->>'motivo'" > "/tmp/sec1c-r-$k" 2>&1 & done; wait
  r=$(q "SELECT count(*) FROM public.admin_clave_intentos WHERE perfil_id='$A1' AND resultado='reservado'")
  local encurso; encurso=$(cat /tmp/sec1c-r-* | grep -c '^en_curso$'); rm -f /tmp/sec1c-r-*
  [ "$r" = "1" ] && [ "$encurso" = "19" ] && ok "MISMO admin: 20 reservas simultáneas → 1 reservada y 19 «en_curso» (humo: la prueba que DISTINGUE el candado es la carrera determinista de abajo)" || mal "mismo perfil: $r reservadas, $encurso en_curso (esperaba 1 y 19)"
  r=$(q "SELECT count(*) FROM pg_locks WHERE locktype='advisory'")
  [ "$r" = "0" ] && ok "al terminar no queda NINGÚN candado advisory (es de transacción: se libera solo)" || mal "quedaron $r candados advisory"
  r=$(q "SELECT public.clave_resolver_intento('$A1',(SELECT max(id) FROM public.admin_clave_intentos WHERE perfil_id='$A1' AND resultado='reservado'),'ok',5,15,15)->>'resultado'")
  r=$(q "SELECT public.clave_reservar_intento('$A1',5,15,15,60)->>'permitido'")
  [ "$r" = "true" ] && ok "resuelta la reserva, el siguiente cambio del mismo admin se permite al instante" || mal "tras resolver no se pudo reservar: $r"
  q "SELECT public.clave_resolver_intento('$A1',(SELECT max(id) FROM public.admin_clave_intentos WHERE perfil_id='$A1' AND resultado='reservado'),'ok',5,15,15)" >/dev/null
  for k in $(seq 1 10); do q "SELECT public.clave_reservar_intento('$A1',5,15,15,60)->>'permitido'" > "/tmp/sec1c-a-$k" 2>&1 & q "SELECT public.clave_reservar_intento('$A2',5,15,15,60)->>'permitido'" > "/tmp/sec1c-b-$k" 2>&1 & done; wait
  local pa pb; pa=$(cat /tmp/sec1c-a-* | grep -c '^true$'); pb=$(cat /tmp/sec1c-b-* | grep -c '^true$'); rm -f /tmp/sec1c-a-* /tmp/sec1c-b-*
  [ "$pa" = "1" ] && [ "$pb" = "1" ] && ok "DOS admins a la vez (10+10 simultáneas): exactamente 1 reserva cada uno — uno no bloquea al otro" || mal "perfiles distintos: A=$pa B=$pb (esperaba 1 y 1)"
  # el candado es POR perfil: mientras otra sesión retiene el de A1 (2 s), A1 espera y A2 no
  ( "${PSQL[@]}" -U supabase_admin -d t_sec1c_c -q -c "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('admin_clave:$A1', 0)); SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 & )
  sleep 0.4
  t0=$(date +%s%3N); q "SELECT public.clave_reservar_intento('$A2',5,15,15,60)" >/dev/null; t1=$(date +%s%3N); ms=$((t1-t0))
  [ "$ms" -lt 1000 ] && ok "con el candado de A1 tomado, A2 NO espera (${ms} ms)" || mal "A2 esperó ${ms} ms por el candado de A1"
  t0=$(date +%s%3N); q "SELECT public.clave_reservar_intento('$A1',5,15,15,60)" >/dev/null; t1=$(date +%s%3N); ms=$((t1-t0))
  [ "$ms" -ge 1200 ] && ok "A1 SÍ espera a que se libere su candado (${ms} ms): la decisión está serializada" || mal "A1 no esperó al candado (${ms} ms)"
  sleep 2
  r=$(q "SELECT count(*) FROM pg_locks WHERE locktype='advisory'")
  [ "$r" = "0" ] && ok "tras el COMMIT el candado se liberó" || mal "candado sin liberar: $r"
  r=$(q "SELECT count(*) FROM public.admin_pin_intentos")
  [ "$r" = "0" ] && ok "nada de esto toca el PIN (admin_pin_intentos vacío)" || mal "admin_pin_intentos tiene $r filas"
  "$AQUI/entorno-local.sh" borra t_sec1c_c >/dev/null

  # ── carrera DETERMINISTA (la de arriba no distingue: abrir cada psql tarda más que la función, así que se serializan solas).
  #    A reserva DENTRO de una transacción abierta 2 s (su fila aún no es visible); B reserva mientras tanto.
  #    Con candado: B espera a A y ve su reserva → «en_curso» (1 reserva). Sin candado (MUTANTE): B no ve nada → 2 reservas.
  carrera() { # carrera <db> → "<reservas sin resolver de A1> <respuesta de B>"
    local db="$1" mb
    "${PSQL[@]}" -U supabase_admin -d "$db" -At -c "BEGIN; SELECT public.clave_reservar_intento('$A1',5,15,15,60)->>'permitido'; SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 &
    sleep 0.5
    mb=$("${PSQL[@]}" -U supabase_admin -d "$db" -At -c "SELECT coalesce(public.clave_reservar_intento('$A1',5,15,15,60)->>'motivo','permitido')")
    wait
    echo "$("${PSQL[@]}" -U supabase_admin -d "$db" -At -c "SELECT count(*) FROM public.admin_clave_intentos r WHERE r.perfil_id='$A1' AND r.resultado='reservado' AND NOT EXISTS (SELECT 1 FROM public.admin_clave_intentos x WHERE x.intento_id = r.id)") $mb"
  }
  base_con t_sec1c_d $CADENA sec-1c-clave-intentos || { mal "no se pudo crear la copia D"; return; }
  "${PSQL[@]}" -U supabase_admin -d t_sec1c_d -f "$AQUI/sql/00-prelude.sql" >/dev/null 2>&1
  r=$(carrera t_sec1c_d)
  [ "$r" = "1 en_curso" ] && ok "carrera determinista: con el candado B espera a A y recibe «en_curso» (1 sola reserva)" || mal "carrera con candado: «$r» (esperaba «1 en_curso»)"
  "$AQUI/entorno-local.sh" borra t_sec1c_d >/dev/null
  local MUT; MUT=$(mktemp /tmp/sec1c-mutante-XXXX.sql); grep -v "PERFORM pg_advisory_xact_lock" "$SQLDIR/sec-1c-clave-intentos.sql" > "$MUT"
  base_con t_sec1c_mut $CADENA || { mal "no se pudo crear la copia del mutante"; return; }
  correr t_sec1c_mut "$MUT" >/dev/null; rm -f "$MUT"
  "${PSQL[@]}" -U supabase_admin -d t_sec1c_mut -f "$AQUI/sql/00-prelude.sql" >/dev/null 2>&1
  r=$(carrera t_sec1c_mut)
  [ "$r" = "2 permitido" ] && ok "MUTANTE sin candado DETECTADO: la misma carrera deja 2 reservas simultáneas (por eso el candado es necesario)" || mal "el mutante sin candado no se detectó: «$r»"
  "$AQUI/entorno-local.sh" borra t_sec1c_mut >/dev/null

  # ── regresión del PIN con sec-1c aplicado ──
  base_con t_sec1c_pin 1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin sec-1c-clave-intentos || { mal "no se pudo crear la copia PIN"; return; }
  pruebas t_sec1c_pin "$AQUI/sql/04-pin.test.sql"
  "$AQUI/entorno-local.sh" borra t_sec1c_pin >/dev/null

  # ── rollback: con evidencia se NIEGA; forzado restaura EXACTAMENTE el estado previo; y se puede volver a aplicar ──
  s=$(correr t_sec1c_a "$SQLDIR/sec-1c-rollback.sql")
  if grep -q "ROLLBACK STOP" <<<"$s"; then ok "rollback sin permiso se NIEGA si hay intentos registrados (evidencia)"; else mal "el rollback no se negó con datos"; fi
  r=$("${PSQL[@]}" -U supabase_admin -d t_sec1c_a -At -c "SELECT (to_regclass('public.admin_clave_intentos') IS NOT NULL) AND (to_regprocedure('public.clave_reservar_intento(uuid,integer,integer,integer,integer)') IS NOT NULL)")
  [ "$r" = "t" ] && ok "el rollback negado no cambió nada" || mal "el rollback negado dejó cambios"
  s=$(PGOPTIONS="-c sec.forzar_rollback=si" correr t_sec1c_a "$SQLDIR/sec-1c-rollback.sql") && ok "rollback forzado aplica" || { mal "rollback forzado falló: $(tail -3 <<<"$s")"; return; }
  comparar t_sec1c_ref t_sec1c_a "tras el rollback el esquema es IDÉNTICO al de producción (cadena SYNC 1..10)" "el rollback no restauró el estado previo"
  s=$(correr t_sec1c_a "$SQLDIR/sec-1c-clave-intentos.sql") && ok "migración → pruebas → rollback → migración otra vez" || mal "no re-aplica tras rollback: $(tail -3 <<<"$s")"
  pruebas t_sec1c_a "$AQUI/sql/sec1c-clave-intentos.test.sql"
  "$AQUI/entorno-local.sh" borra t_sec1c_a >/dev/null
  base_con t_sec1c_b $CADENA sec-1c-clave-intentos || { mal "no se pudo crear la copia B"; return; }
  s=$(correr t_sec1c_b "$SQLDIR/sec-1c-rollback.sql") && ok "rollback LIMPIO (tabla vacía) aplica sin permiso especial" || mal "rollback limpio falló: $(tail -3 <<<"$s")"
  comparar t_sec1c_ref t_sec1c_b "rollback limpio → esquema IDÉNTICO al de producción" "rollback limpio no restauró el estado previo"
  s=$(correr t_sec1c_b "$SQLDIR/sec-1c-rollback.sql") && ok "rollback repetido no falla (idempotente)" || mal "rollback repetido falló"
  s=$(correr t_sec1c_b "$SQLDIR/sec-1c-clave-intentos.sql") && ok "forward tras rollback limpio" || mal "forward tras rollback limpio falló"
  "$AQUI/entorno-local.sh" borra t_sec1c_b >/dev/null; "$AQUI/entorno-local.sh" borra t_sec1c_ref >/dev/null
}
case "${1:-}" in
  sec1c) fasesec1c ;;
  10) fase10 ;;
  1) fase1 ;;
  9) fase9 ;;
  7b) fase7b ;;
  3p) fase3p ;;
  2) fase2 ;;
  3) fase3 ;;
  *) echo "uso: $0 {1|2|3|3p|7b|9|10|sec1c}" >&2; exit 2 ;;
esac
echo "----"; echo "TOTAL: $PASS PASS, $FALLOS FAIL"
[ "$FALLOS" -eq 0 ]
