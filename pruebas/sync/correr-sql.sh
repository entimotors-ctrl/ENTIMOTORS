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
fase15b() {
  echo "== 3.15.0 · BLOQUE 2 · presupuestos + inventario + stock (tipos, aprobación exactamente una vez, ajustes, compatibilidad) =="
  local s q r
  local CADENA="1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario 9-fotos 10-importacion sec-1c-clave-intentos 15a-cotizacion-inventario"
  base_con t_15b_ref $CADENA || { mal "no se pudo crear la referencia (cadena + 15a)"; return; }
  base_con t_15b_a $CADENA || { mal "no se pudo crear la copia A"; return; }
  q() { "${PSQL[@]}" -U supabase_admin -d t_15b_a -At -c "$1"; }
  s=$(correr t_15b_a "$SQLDIR/sync-15b-presupuestos-stock.sql") && ok "sync-15b aplica sobre la cadena + 15a" || { mal "sync-15b falló: $(tail -6 <<<"$s")"; return; }
  s=$(correr t_15b_a "$SQLDIR/sync-15b-presupuestos-stock.sql") && ok "sync-15b re-aplica (idempotente, el backfill no se repite)" || mal "sync-15b no es idempotente: $(tail -4 <<<"$s")"
  [ "$(q "SELECT count(*) FROM pg_proc WHERE proname='agregar_item_orden' AND pronamespace='public'::regnamespace")" = "1" ] && ok "agregar_item_orden tiene UNA sola firma (sin sobrecarga ambigua)" || mal "agregar_item_orden quedó sobrecargada"
  [ "$(q "SELECT has_function_privilege('authenticated','public.sync_reconciliar_renglon(uuid,numeric,uuid,uuid,text)','EXECUTE')")" = "f" ] && ok "el núcleo de reconciliación NO es invocable por authenticated" || mal "authenticated invoca sync_reconciliar_renglon"
  [ "$(q "SELECT has_column_privilege('authenticated','public.ordenes','presupuesto_estado','UPDATE')")" = "f" ] && ok "el estado del presupuesto NO se escribe por el CRUD (solo por la RPC)" || mal "authenticated puede escribir presupuesto_estado"
  pruebas t_15b_a "$AQUI/sql/15b-presupuestos.test.sql"
  "$AQUI/entorno-local.sh" borra t_15b_a >/dev/null

  echo "  -- compatibilidad 3.14.1 (fixtures creados con las funciones viejas, ANTES de la migración) --"
  base_con t_15b_l $CADENA || { mal "no se pudo crear la copia L"; return; }
  s=$(cat "$AQUI/sql/00-prelude.sql" "$AQUI/sql/15b-legado-antes.sql" | "${PSQL[@]}" -U supabase_admin -d t_15b_l -v ON_ERROR_STOP=1 2>&1) && ok "fixtures #4 #6 #9 #10 ab4277b6 creados con la 3.14.1" || { mal "fixtures: $(tail -4 <<<"$s")"; return; }
  s=$(correr t_15b_l "$SQLDIR/sync-15b-presupuestos-stock.sql") && ok "sync-15b aplica sobre datos 3.14.1 (backfill)" || { mal "sync-15b sobre legado falló: $(tail -6 <<<"$s")"; return; }
  pruebas t_15b_l "$AQUI/sql/15b-legado-despues.test.sql"
  "$AQUI/entorno-local.sh" borra t_15b_l >/dev/null

  echo "  -- concurrencia y caída (sesiones reales) --"
  local INV=00000000-0000-4000-9000-000000002901 BD
  q() { "${PSQL[@]}" -U supabase_admin -d "$BD" -At -c "$1"; }
  preparar() { BD=$1; base_con "$BD" $CADENA 15b-presupuestos-stock || return 1; "${PSQL[@]}" -U supabase_admin -d "$BD" -q -f "$AQUI/sql/00-prelude.sql" >/dev/null 2>&1
    q "INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES ('$INV','Pieza',10,5); INSERT INTO public.inventario_movimientos (inventario_id, tipo, cantidad) VALUES ('$INV','apertura',100);" >/dev/null; }
  orden() { # orden <n>: orden pendiente con 2 del producto INV
    q "INSERT INTO public.ordenes (id, estado, falla) VALUES ('00000000-0000-4000-9000-00000000291$1','presupuesto','c');" >/dev/null
    sql_como "$BD" 2 "SELECT public.agregar_item_orden('00000000-0000-4000-9000-00000000292$1'::uuid, '00000000-0000-4000-9000-00000000291$1'::uuid, '$INV'::uuid, NULL, 2, 10, '00000000-0000-4000-9000-00000000293$1'::uuid, false, NULL, 'dev', 'repuesto_inventario')" >/dev/null; }
  stock() { q "SELECT cantidad::int FROM public.inventario WHERE id='$INV'"; }
  aprobar() { sql_como "$BD" "$1" "SELECT (public.decidir_presupuesto_orden('00000000-0000-4000-9000-0000000029$2'::uuid, '00000000-0000-4000-9000-00000000291$3'::uuid, 'aprobar'))->>'stock_movido'"; }
  carrera() { # carrera <opA> <opB> <orden>: A aprueba y retiene 2 s; B (otro usuario, otro op) aprueba a la vez
    ( "${PSQL[@]}" -U supabase_admin -d "$BD" -q -c "BEGIN; SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true), set_config('role','authenticated',true); SELECT public.decidir_presupuesto_orden('00000000-0000-4000-9000-0000000029$1'::uuid, '00000000-0000-4000-9000-00000000291$3'::uuid, 'aprobar'); SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 & )
    sleep 0.7; local rb; rb=$(aprobar 1 "$2" "$3"); sleep 2; echo "$rb"; }
  preparar t_15b_c || { mal "no se pudo crear la copia C"; return; }
  orden 1
  for k in 1 2 3 4 5 6 7 8; do aprobar 2 41 1 >/dev/null & done; wait
  [ "$(stock)" = "98" ] && ok "L/M · 8 aprobaciones simultáneas del MISMO op → se descuenta 2 una sola vez (100→98)" || mal "mismo op simultáneo: stock $(stock)"
  orden 2
  r=$(carrera 51 52 2)
  { [ "$r" = "0" ] || [ "$r" = "0.00" ]; } && ok "N · el 2.º dispositivo/usuario (otro op) ESPERA y aprueba sin mover nada" || mal "N · el 2.º movió: $r"
  [ "$(stock)" = "96" ] && ok "N · dos dispositivos simultáneos → 2 unidades una sola vez (98→96)" || mal "N · stock $(stock)"
  # O · caída a mitad de la aprobación → nada; reintento (mismo op) → 1 vez
  orden 3
  "${PSQL[@]}" -U supabase_admin -d "$BD" -q -c "BEGIN; SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true), set_config('role','authenticated',true); SELECT public.decidir_presupuesto_orden('00000000-0000-4000-9000-000000002971'::uuid, '00000000-0000-4000-9000-000000002913'::uuid, 'aprobar'); ROLLBACK;" >/dev/null 2>&1
  [ "$(stock)" = "96" ] && [ "$(q "SELECT presupuesto_estado FROM public.ordenes WHERE id='00000000-0000-4000-9000-000000002913'")" = "pendiente" ] && ok "O · caída durante la aprobación → stock y presupuesto intactos" || mal "O · quedó estado parcial"
  aprobar 2 71 3 >/dev/null; aprobar 2 71 3 >/dev/null
  [ "$(stock)" = "94" ] && ok "O · reintento tras la caída (mismo op, dos veces) → descuenta 2 una sola vez (96→94)" || mal "O · stock $(stock)"
  [ "$(q "SELECT public.verificar_invariantes()::text")" = "[]" ] && ok "invariantes [] tras las carreras" || mal "invariantes rotos tras las carreras"
  "$AQUI/entorno-local.sh" borra t_15b_c >/dev/null

  echo "  -- defensas y mutantes (copia aparte: los mutantes dejan datos inconsistentes a propósito) --"
  preparar t_15b_m || { mal "no se pudo crear la copia M"; return; }
  q "SELECT pg_get_functiondef('public.decidir_presupuesto_orden(uuid,uuid,text,text,text)'::regprocedure)" | sed 's/WHERE id = p_orden_id FOR UPDATE;/WHERE id = p_orden_id;/' > /tmp/entimotors-15b-sinlock1.sql
  q "SELECT pg_get_functiondef('public.sync_reconciliar_renglon(uuid,numeric,uuid,uuid,text)'::regprocedure)" | sed 's/WHERE i.id = p_item FOR UPDATE;/WHERE i.id = p_item;/' > /tmp/entimotors-15b-sinlock2.sql
  q "SELECT pg_get_functiondef('public.sync_verificar_existencias(uuid,text)'::regprocedure)" | sed 's/ORDER BY id FOR UPDATE;/ORDER BY id;/' > /tmp/entimotors-15b-sinlock3.sql
  "${PSQL[@]}" -U supabase_admin -d "$BD" -q -f /tmp/entimotors-15b-sinlock1.sql -f /tmp/entimotors-15b-sinlock2.sql -f /tmp/entimotors-15b-sinlock3.sql >/dev/null 2>&1
  orden 4
  carrera 61 62 4 >/dev/null
  [ "$(stock)" = "98" ] && ok "DEFENSA EN PROFUNDIDAD · aun SIN los candados explícitos (orden, renglón, producto), escribir la fila de la orden serializa: un solo descuento (100→98)" || mal "sin candados: stock $(stock)"
  correr "$BD" "$SQLDIR/sync-15b-presupuestos-stock.sql" >/dev/null
  # M1: reconciliar IGNORANDO lo ya aplicado → la 2.ª aprobación (otro op) descuenta otra vez: la prueba y las invariantes lo delatan
  q "SELECT pg_get_functiondef('public.sync_reconciliar_renglon(uuid,numeric,uuid,uuid,text)'::regprocedure)" | sed 's/v_delta := COALESCE(p_objetivo, 0) - it.cantidad_aplicada;/v_delta := COALESCE(p_objetivo, 0);/' > /tmp/entimotors-15b-m1.sql
  "${PSQL[@]}" -U supabase_admin -d "$BD" -q -f /tmp/entimotors-15b-m1.sql >/dev/null 2>&1
  orden 5
  aprobar 2 81 5 >/dev/null; r=$(aprobar 1 82 5)
  { [ "$r" != "0" ] && [ "$r" != "0.00" ]; } && ok "MUTANTE M1 (ignora lo aplicado) → la 2.ª aprobación movió $r: la prueba N lo detecta" || mal "M1 no se detectó ($r)"
  [ "$(q "SELECT public.verificar_invariantes()::text")" != "[]" ] && ok "MUTANTE M1 · verificar_invariantes delata el doble descuento" || mal "invariantes no delatan M1"
  # M2: además reconciliar DOS veces en la MISMA operación → el índice único (op, renglón, producto) aborta la operación entera
  q "SELECT pg_get_functiondef('public.decidir_presupuesto_orden(uuid,uuid,text,text,text)'::regprocedure)" | sed "s/  PERFORM public.sync_auditar('presupuesto-/  PERFORM public.sync_reconciliar_orden(p_orden_id, p_op, NULL, NULL);\n  PERFORM public.sync_auditar('presupuesto-/" > /tmp/entimotors-15b-m2.sql
  "${PSQL[@]}" -U supabase_admin -d "$BD" -q -f /tmp/entimotors-15b-m2.sql >/dev/null 2>&1
  orden 6
  local antes; antes=$(stock)
  r=$(aprobar 2 91 6)
  grep -q "inventario_movimientos_op_renglon_uq" <<<"$r" && [ "$(stock)" = "$antes" ] && ok "MUTANTE M2 (doble aplicación en una operación) → el índice único la aborta entera: stock intacto" || mal "M2: el índice no frenó la doble aplicación: $(head -2 <<<"$r")"
  "$AQUI/entorno-local.sh" borra t_15b_m >/dev/null

  echo "  -- rollback --"
  base_con t_15b_d $CADENA 15b-presupuestos-stock || { mal "no se pudo crear la copia D"; return; }
  s=$(correr t_15b_d "$SQLDIR/sync-15b-rollback.sql") && ok "rollback sin actividad 3.15 aplica" || { mal "rollback falló: $(tail -4 <<<"$s")"; return; }
  comparar t_15b_ref t_15b_d "tras el rollback el esquema es IDÉNTICO a la cadena + 15a" "el rollback de 15b no restauró el estado anterior"
  s=$(correr t_15b_d "$SQLDIR/sync-15b-presupuestos-stock.sql") && ok "forward → rollback → forward" || mal "no re-aplica tras rollback: $(tail -4 <<<"$s")"
  "${PSQL[@]}" -U supabase_admin -d t_15b_d -q -f "$AQUI/sql/00-prelude.sql" >/dev/null 2>&1
  "${PSQL[@]}" -U supabase_admin -d t_15b_d -q -c "INSERT INTO public.ordenes (id, estado, falla) VALUES ('00000000-0000-4000-9000-000000002981','presupuesto','x')" >/dev/null
  sql_como t_15b_d 2 "SELECT public.agregar_item_orden('00000000-0000-4000-9000-000000002982'::uuid, '00000000-0000-4000-9000-000000002981'::uuid, NULL, 'Servicio', 1, 10, NULL, false, NULL, 'dev', 'mano_obra')" >/dev/null
  s=$(correr t_15b_d "$SQLDIR/sync-15b-rollback.sql")
  grep -q "ROLLBACK STOP" <<<"$s" && ok "con actividad 3.15 el rollback se NIEGA (no descuadra el stock)" || mal "el rollback no se negó con actividad 3.15: $(tail -2 <<<"$s")"
  # forzado como en el pooler de Supabase (ignora PGOPTIONS): SET en la MISMA sesión y luego el archivo
  s=$("${PSQL[@]}" -U supabase_admin -d t_15b_d -v ON_ERROR_STOP=1 -q -c "SET sync.forzar_rollback = 'si'" -f "$SQLDIR/sync-15b-rollback.sql" 2>&1) \
    && [ -z "$("${PSQL[@]}" -U supabase_admin -d t_15b_d -At -c "SELECT 1 FROM information_schema.columns WHERE table_name='orden_items' AND column_name='cantidad_aplicada'")" ] \
    && ok "forzado con SET de sesión (método del pooler) aplica el rollback" || mal "el forzado por SET de sesión no funcionó: $(tail -2 <<<"$s")"
  "$AQUI/entorno-local.sh" borra t_15b_d >/dev/null; "$AQUI/entorno-local.sh" borra t_15b_ref >/dev/null
}
fase15a() {
  echo "== 3.15.0 · BLOQUE 1A · cotización ↔ inventario + conversión atómica e idempotente (sin stock) =="
  local s q r
  local CADENA="1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario 9-fotos 10-importacion sec-1c-clave-intentos"
  base_con t_15a_ref $CADENA || { mal "no se pudo crear la referencia (cadena 3.14.1)"; return; }
  base_con t_15a_a $CADENA || { mal "no se pudo crear la copia A"; return; }
  q() { "${PSQL[@]}" -U supabase_admin -d t_15a_a -At -c "$1"; }
  s=$(correr t_15a_a "$SQLDIR/sync-15a-cotizacion-inventario.sql") && ok "sync-15a aplica sobre la cadena 3.14.1" || { mal "sync-15a falló: $(tail -4 <<<"$s")"; return; }
  s=$(correr t_15a_a "$SQLDIR/sync-15a-cotizacion-inventario.sql") && ok "sync-15a re-aplica (idempotente)" || mal "sync-15a no es idempotente: $(tail -4 <<<"$s")"
  [ "$(q "SELECT has_function_privilege('anon','public.convertir_cotizacion(uuid,uuid,uuid,uuid,text)','EXECUTE')")" = "f" ] && ok "anon NO ejecuta convertir_cotizacion" || mal "anon ejecuta convertir_cotizacion"
  [ "$(q "SELECT has_function_privilege('authenticated','public.cotizacion_aceptada_inmutable()','EXECUTE')")" = "f" ] && ok "la función de la guarda no es invocable por authenticated" || mal "authenticated invoca la guarda"
  pruebas t_15a_a "$AQUI/sql/15a-cotizacion.test.sql"
  "$AQUI/entorno-local.sh" borra t_15a_a >/dev/null

  echo "  -- concurrencia y caída (sesiones reales) --"
  base_con t_15a_c $CADENA 15a-cotizacion-inventario || { mal "no se pudo crear la copia C"; return; }
  "${PSQL[@]}" -U supabase_admin -d t_15a_c -q -f "$AQUI/sql/00-prelude.sql" >/dev/null 2>&1   # siembra las 6 cuentas de prueba (perfiles)
  q() { "${PSQL[@]}" -U supabase_admin -d t_15a_c -At -c "$1"; }
  local COT=00000000-0000-4000-9000-000000001701
  sembrar() { # sembrar <db> <n>: cotización pendiente <n> con 1 repuesto y 1 manual
    "${PSQL[@]}" -U supabase_admin -d "$1" -q -c "INSERT INTO public.inventario (id, nombre, precio_venta, costo_compra) VALUES ('00000000-0000-4000-9000-000000001790','Pieza',10,5) ON CONFLICT DO NOTHING;
      INSERT INTO public.cotizaciones (id, cliente_nombre, vence_en, estado) VALUES ('00000000-0000-4000-9000-00000000170$2','Carrera',now()+interval '9 days','pendiente');
      INSERT INTO public.cotizacion_items (cotizacion_id, inventario_id, nombre, cantidad, precio) VALUES ('00000000-0000-4000-9000-00000000170$2','00000000-0000-4000-9000-000000001790','Pieza',1,10),('00000000-0000-4000-9000-00000000170$2',NULL,'Mano',1,5);" >/dev/null
  }
  sembrar t_15a_c 1
  # 8 reintentos SIMULTÁNEOS de la MISMA operación (doble clic, reintentos por red) → 1 orden
  for k in 1 2 3 4 5 6 7 8; do sql_como t_15a_c 2 "SELECT public.convertir_cotizacion('00000000-0000-4000-9000-000000001711'::uuid, '$COT'::uuid, '00000000-0000-4000-9000-000000001712'::uuid)" >/dev/null & done; wait
  r=$(q "SELECT count(*) FROM public.ordenes")
  [ "$r" = "1" ] && ok "D/E · 8 envíos simultáneos del MISMO op → 1 orden" || mal "mismo op simultáneo: $r órdenes"
  # dos dispositivos: OTRO op cada uno, a la vez, con carrera DETERMINISTA (A convierte y retiene la transacción 2 s)
  sembrar t_15a_c 2
  ( "${PSQL[@]}" -U supabase_admin -d t_15a_c -q -c "BEGIN; SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true), set_config('role','authenticated',true); SELECT public.convertir_cotizacion('00000000-0000-4000-9000-000000001721'::uuid, '00000000-0000-4000-9000-000000001702'::uuid, '00000000-0000-4000-9000-000000001722'::uuid); SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 & )
  sleep 0.7
  r=$(sql_como t_15a_c 1 "SELECT public.convertir_cotizacion('00000000-0000-4000-9000-000000001723'::uuid, '00000000-0000-4000-9000-000000001702'::uuid, '00000000-0000-4000-9000-000000001724'::uuid)")
  sleep 2
  grep -q "COTIZACION_YA_ACEPTADA" <<<"$r" && ok "F · el 2.º dispositivo (otro op) ESPERA al 1.º y recibe COTIZACION_YA_ACEPTADA" || mal "F · el 2.º dispositivo no fue rechazado: $r"
  r=$(q "SELECT count(*) FROM public.ordenes WHERE id IN ('00000000-0000-4000-9000-000000001722','00000000-0000-4000-9000-000000001724')")
  [ "$r" = "1" ] && ok "F · dos dispositivos simultáneos → exactamente 1 orden" || mal "F · $r órdenes"
  # MUTANTE: la misma función SIN el FOR UPDATE → la carrera debe crear 2 órdenes (prueba que el test detecta la falta del candado)
  sembrar t_15a_c 3
  q "SELECT pg_get_functiondef('public.convertir_cotizacion(uuid,uuid,uuid,uuid,text)'::regprocedure)" | sed 's/WHERE id = p_cotizacion_id FOR UPDATE/WHERE id = p_cotizacion_id/' > /tmp/entimotors-15a-mutante.sql
  "${PSQL[@]}" -U supabase_admin -d t_15a_c -q -f /tmp/entimotors-15a-mutante.sql >/dev/null 2>&1
  ( "${PSQL[@]}" -U supabase_admin -d t_15a_c -q -c "BEGIN; SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true), set_config('role','authenticated',true); SELECT public.convertir_cotizacion('00000000-0000-4000-9000-000000001731'::uuid, '00000000-0000-4000-9000-000000001703'::uuid, '00000000-0000-4000-9000-000000001732'::uuid); SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 & )
  sleep 0.7
  sql_como t_15a_c 1 "SELECT public.convertir_cotizacion('00000000-0000-4000-9000-000000001733'::uuid, '00000000-0000-4000-9000-000000001703'::uuid, '00000000-0000-4000-9000-000000001734'::uuid)" >/dev/null
  sleep 2
  r=$(q "SELECT count(*) FROM public.ordenes WHERE id IN ('00000000-0000-4000-9000-000000001732','00000000-0000-4000-9000-000000001734')")
  [ "$r" = "1" ] && ok "DEFENSA DOBLE · sin FOR UPDATE pero con la guarda de aceptada, la carrera sigue dejando 1 orden (la guarda aborta al 2.º)" || mal "sin FOR UPDATE y con guarda: $r órdenes"
  # MUTANTE completo: sin FOR UPDATE y SIN la guarda → la carrera debe crear 2 órdenes (la prueba F detecta que faltan ambas defensas)
  sembrar t_15a_c 5
  q "ALTER TABLE public.cotizaciones DISABLE TRIGGER cotizacion_aceptada_inmutable" >/dev/null
  ( "${PSQL[@]}" -U supabase_admin -d t_15a_c -q -c "BEGIN; SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true), set_config('role','authenticated',true); SELECT public.convertir_cotizacion('00000000-0000-4000-9000-000000001751'::uuid, '00000000-0000-4000-9000-000000001705'::uuid, '00000000-0000-4000-9000-000000001752'::uuid); SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 & )
  sleep 0.7
  sql_como t_15a_c 1 "SELECT public.convertir_cotizacion('00000000-0000-4000-9000-000000001753'::uuid, '00000000-0000-4000-9000-000000001705'::uuid, '00000000-0000-4000-9000-000000001754'::uuid)" >/dev/null
  sleep 2
  r=$(q "SELECT count(*) FROM public.ordenes WHERE id IN ('00000000-0000-4000-9000-000000001752','00000000-0000-4000-9000-000000001754')")
  [ "$r" = "2" ] && ok "MUTANTE sin FOR UPDATE y sin guarda → la carrera crea 2 órdenes: la prueba F SÍ detecta la falta de defensas" || mal "el mutante completo no se detectó ($r órdenes)"
  q "ALTER TABLE public.cotizaciones ENABLE TRIGGER cotizacion_aceptada_inmutable" >/dev/null
  q "DELETE FROM public.orden_items WHERE orden_id IN ('00000000-0000-4000-9000-000000001752','00000000-0000-4000-9000-000000001754')" >/dev/null 2>&1
  correr t_15a_c "$SQLDIR/sync-15a-cotizacion-inventario.sql" >/dev/null && ok "función real restaurada tras el mutante" || mal "no se pudo restaurar la función real"
  # G · caída a mitad: la transacción que convierte se corta (ROLLBACK = conexión muerta) → nada queda; el reintento con el MISMO op crea 1
  sembrar t_15a_c 4
  local cli0; cli0=$(q "SELECT count(*) FROM public.clientes")
  "${PSQL[@]}" -U supabase_admin -d t_15a_c -q -c "BEGIN; SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true), set_config('role','authenticated',true); SELECT public.convertir_cotizacion('00000000-0000-4000-9000-000000001741'::uuid, '00000000-0000-4000-9000-000000001704'::uuid, '00000000-0000-4000-9000-000000001742'::uuid); ROLLBACK;" >/dev/null 2>&1
  r=$(q "SELECT (SELECT count(*) FROM public.ordenes WHERE id='00000000-0000-4000-9000-000000001742')||'|'||(SELECT count(*) FROM public.sync_ops WHERE op_id='00000000-0000-4000-9000-000000001741')||'|'||(SELECT estado FROM public.cotizaciones WHERE id='00000000-0000-4000-9000-000000001704')||'|'||((SELECT count(*) FROM public.clientes) - $cli0)")
  [ "$r" = "0|0|pendiente|0" ] && ok "G · caída durante la conversión → sin orden, sin op guardado, cotización pendiente, sin cliente suelto" || mal "G · quedó estado parcial: $r"
  sql_como t_15a_c 2 "SELECT public.convertir_cotizacion('00000000-0000-4000-9000-000000001741'::uuid, '00000000-0000-4000-9000-000000001704'::uuid, '00000000-0000-4000-9000-000000001742'::uuid)" >/dev/null
  sql_como t_15a_c 2 "SELECT public.convertir_cotizacion('00000000-0000-4000-9000-000000001741'::uuid, '00000000-0000-4000-9000-000000001704'::uuid, '00000000-0000-4000-9000-000000001742'::uuid)" >/dev/null
  r=$(q "SELECT count(*) FROM public.ordenes WHERE id='00000000-0000-4000-9000-000000001742'")
  [ "$r" = "1" ] && ok "G · reintento tras la caída (mismo op, dos veces) → exactamente 1 orden" || mal "G · $r órdenes tras el reintento"
  r=$(q "SELECT count(*) FROM public.inventario_movimientos")
  [ "$r" = "0" ] && ok "ninguna de las conversiones (ni el mutante) movió stock" || mal "hubo $r movimientos de stock"
  [ "$(q "SELECT public.verificar_invariantes()::text")" = "[]" ] && ok "invariantes [] tras las carreras" || mal "invariantes rotos"
  "$AQUI/entorno-local.sh" borra t_15a_c >/dev/null

  # rollback: vuelve EXACTAMENTE al esquema de la cadena 3.14.1; forward → rollback → forward
  base_con t_15a_d $CADENA 15a-cotizacion-inventario || { mal "no se pudo crear la copia D"; return; }
  s=$(correr t_15a_d "$SQLDIR/sync-15a-rollback.sql") && ok "rollback aplica" || { mal "rollback falló: $(tail -4 <<<"$s")"; return; }
  comparar t_15a_ref t_15a_d "tras el rollback el esquema es IDÉNTICO a la cadena 3.14.1" "el rollback de 15a no restauró el estado anterior"
  s=$(correr t_15a_d "$SQLDIR/sync-15a-cotizacion-inventario.sql") && ok "forward → rollback → forward" || mal "no re-aplica tras rollback: $(tail -4 <<<"$s")"
  "$AQUI/entorno-local.sh" borra t_15a_d >/dev/null; "$AQUI/entorno-local.sh" borra t_15a_ref >/dev/null
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
# 3.15.0 · Bloque 3: mensajes + avisos en tiempo real. A = con Realtime (stub con el dueño de producción; 15c aplicada como postgres,
# como en Supabase), B = base sin Realtime (los avisos se omiten, nada falla). Rollback: se niega con mensajes; forzado → idéntico.
fase15c() {
  echo "== 3.15 · Bloque 3 · mensajes + avisos en tiempo real (sync-15c) =="
  local CADENA="1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario 9-fotos 10-importacion sec-1c-clave-intentos 15a-cotizacion-inventario 15b-presupuestos-stock"
  local STUB="$AQUI/sql/15c-realtime-stub.sql" s r
  base_con t_15c_ref $CADENA || { mal "no se pudo crear la referencia (cadena + 15b)"; return; }
  correr t_15c_ref "$STUB" >/dev/null || { mal "stub de realtime (ref)"; return; }
  base_con t_15c_a $CADENA || { mal "no se pudo crear la copia A"; return; }
  correr t_15c_a "$STUB" >/dev/null || { mal "stub de realtime (A)"; return; }
  q() { "${PSQL[@]}" -U supabase_admin -d t_15c_a -At -c "$1"; }
  # en producción migra `postgres` (dueño de public, miembro de supabase_realtime_admin); aquí el esquema de la copia es de supabase_admin,
  # así que la migración corre como en las demás fases y el bloque de políticas de canal se prueba ADEMÁS como postgres.
  local RTBLOQUE; RTBLOQUE=$(mktemp /tmp/entimotors-15c-rt-XXXX.sql)
  { echo "BEGIN;"; sed -n '/^DO \$rt\$/,/^\$rt\$;/p' "$SQLDIR/sync-15c-mensajes-realtime.sql"; echo "ROLLBACK;"; } > "$RTBLOQUE"
  s=$(correr t_15c_a "$RTBLOQUE" postgres) && ok "las políticas de canal se crean como postgres (sobre realtime.messages de supabase_realtime_admin)" || mal "postgres no crea las políticas de canal: $(tail -3 <<<"$s")"
  rm -f "$RTBLOQUE"
  s=$(correr t_15c_a "$SQLDIR/sync-15c-mensajes-realtime.sql") && ok "sync-15c aplica sobre la cadena + 15b" || { mal "sync-15c falló: $(tail -6 <<<"$s")"; return; }
  s=$(correr t_15c_a "$SQLDIR/sync-15c-mensajes-realtime.sql") && ok "sync-15c re-aplica (idempotente)" || mal "sync-15c no es idempotente: $(tail -4 <<<"$s")"
  r=$(q "SELECT count(*) FROM pg_policies WHERE schemaname='realtime' AND tablename='messages' AND policyname LIKE 'entimotors_rt_%' AND cmd='SELECT'")
  [ "$r" = "3" ] && ok "3 políticas de canal, todas de solo lectura" || mal "políticas de canal: $r"
  r=$(q "SELECT count(*) FROM pg_trigger WHERE tgname='zz_rt_taller' AND NOT tgisinternal")
  [ "$r" = "13" ] && ok "aviso «taller» por sentencia en 13 tablas" || mal "zz_rt_taller en $r tablas"
  r=$(q "SELECT count(*) FROM pg_trigger WHERE tgname='zz_sync_sello' AND NOT tgisinternal")
  [ "$r" = "12" ] && ok "zz_sync_sello sigue en 12 tablas (la poscondición de SYNC-1 no cambia)" || mal "zz_sync_sello en $r tablas"
  pruebas t_15c_a "$AQUI/sql/15c-mensajes.test.sql"
  s=$(correr t_15c_a "$SQLDIR/sync-15c-rollback.sql")
  if grep -q "ROLLBACK STOP" <<<"$s"; then ok "rollback sin permiso se NIEGA si hay mensajes"; else mal "el rollback no se negó con mensajes"; fi
  [ "$(q "SELECT count(*) FROM public.mensajes")" -gt 0 ] && ok "el rollback negado no borró nada" || mal "el rollback negado dejó cambios"
  s=$(PGOPTIONS="-c sync.forzar_rollback=si" correr t_15c_a "$SQLDIR/sync-15c-rollback.sql") && ok "rollback forzado aplica" || { mal "rollback forzado falló: $(tail -3 <<<"$s")"; return; }
  "${PSQL[@]}" -U supabase_admin -d t_15c_a -q -c "DELETE FROM realtime.messages" >/dev/null
  comparar t_15c_ref t_15c_a "tras el rollback el esquema es IDÉNTICO a la cadena + 15b" "el rollback de 15c no restauró el estado anterior"
  s=$(correr t_15c_a "$SQLDIR/sync-15c-mensajes-realtime.sql") && ok "migración → pruebas → rollback → migración otra vez" || mal "no re-aplica tras rollback: $(tail -3 <<<"$s")"
  s=$(correr t_15c_a "$SQLDIR/sync-15c-rollback.sql") && ok "rollback LIMPIO (sin mensajes) aplica sin permiso especial" || mal "rollback limpio falló: $(tail -3 <<<"$s")"
  comparar t_15c_ref t_15c_a "rollback limpio → esquema IDÉNTICO" "rollback limpio no restauró el estado"
  "$AQUI/entorno-local.sh" borra t_15c_a >/dev/null; "$AQUI/entorno-local.sh" borra t_15c_ref >/dev/null

  base_con t_15c_b $CADENA || { mal "no se pudo crear la copia B"; return; }
  "${PSQL[@]}" -U supabase_admin -d t_15c_b -q -c "DROP SCHEMA IF EXISTS realtime CASCADE" >/dev/null 2>&1
  s=$(correr t_15c_b "$SQLDIR/sync-15c-mensajes-realtime.sql") && ok "sin Realtime en la base: 15c aplica igual" || { mal "sin Realtime falló: $(tail -4 <<<"$s")"; return; }
  grep -q "políticas de canal omitidas" <<<"$s" && ok "…y avisa que omitió las políticas de canal" || mal "no avisó de las políticas omitidas"
  r=$("${PSQL[@]}" -U supabase_admin -d t_15c_b -At -f "$AQUI/sql/00-prelude.sql" -c "DO \$\$ BEGIN PERFORM pg_temp.como(1); PERFORM public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), pg_temp.uid(3), 'sin realtime'); PERFORM pg_temp.fin(); UPDATE public.ordenes SET falla = falla; END \$\$;" -c "SELECT count(*) FROM public.mensajes" 2>&1 | tail -1)
  [ "$r" = "1" ] && ok "sin Realtime: enviar y editar órdenes funcionan (los avisos se omiten)" || mal "sin Realtime: $r"
  "$AQUI/entorno-local.sh" borra t_15c_b >/dev/null
}

# 3.15.0 · Bloque 4: OWNER-PIN-GUARD + eliminar usuario. Con stub de auth.sessions y de realtime (la base de referencia no trae GoTrue ni Realtime).
fase15d() {
  echo "== 3.15 · Bloque 4 · OWNER-PIN-GUARD + eliminar usuario (sync-15d) =="
  local CADENA="1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario 9-fotos 10-importacion sec-1c-clave-intentos 15a-cotizacion-inventario 15b-presupuestos-stock"
  local s r
  for d in t_15d_ref t_15d_a; do
    "$AQUI/entorno-local.sh" copia $d >/dev/null || { mal "copia $d"; return; }
    correr $d "$AQUI/sql/15c-realtime-stub.sql" >/dev/null; correr $d "$AQUI/sql/15d-auth-stub.sql" >/dev/null
    for f in $CADENA 15c-mensajes-realtime; do local arch="$SQLDIR/sync-$f.sql"; [[ "$f" == sec-* ]] && arch="$SQLDIR/$f.sql"; correr $d "$arch" >/dev/null || { mal "no se pudo aplicar $f en $d"; return; }; done
  done
  q() { "${PSQL[@]}" -U supabase_admin -d t_15d_a -At -c "$1"; }
  s=$(correr t_15d_a "$SQLDIR/sync-15d-owner-pin-usuarios.sql") && ok "sync-15d aplica sobre la cadena + 15c" || { mal "sync-15d falló: $(tail -6 <<<"$s")"; return; }
  s=$(correr t_15d_a "$SQLDIR/sync-15d-owner-pin-usuarios.sql") && ok "sync-15d re-aplica (idempotente)" || mal "sync-15d no es idempotente: $(tail -4 <<<"$s")"
  pruebas t_15d_a "$AQUI/sql/15d-owner-pin.test.sql"
  s=$(correr t_15d_a "$SQLDIR/sync-15d-rollback.sql")
  if grep -q "ROLLBACK STOP" <<<"$s"; then ok "rollback sin permiso se NIEGA si hay usuarios eliminados"; else mal "el rollback no se negó con usuarios eliminados"; fi
  s=$(PGOPTIONS="-c sync.forzar_rollback=si" correr t_15d_a "$SQLDIR/sync-15d-rollback.sql") && ok "rollback forzado aplica" || { mal "rollback forzado falló: $(tail -3 <<<"$s")"; return; }
  "$AQUI/entorno-local.sh" borra t_15d_a >/dev/null
  "$AQUI/entorno-local.sh" copia t_15d_b >/dev/null
  correr t_15d_b "$AQUI/sql/15c-realtime-stub.sql" >/dev/null; correr t_15d_b "$AQUI/sql/15d-auth-stub.sql" >/dev/null
  for f in $CADENA 15c-mensajes-realtime 15d-owner-pin-usuarios; do local arch="$SQLDIR/sync-$f.sql"; [[ "$f" == sec-* ]] && arch="$SQLDIR/$f.sql"; correr t_15d_b "$arch" >/dev/null || { mal "no se pudo aplicar $f en B"; return; }; done
  s=$(correr t_15d_b "$SQLDIR/sync-15d-rollback.sql") && ok "rollback LIMPIO (sin eliminados) aplica sin permiso" || mal "rollback limpio falló: $(tail -3 <<<"$s")"
  comparar t_15d_ref t_15d_b "tras el rollback el esquema es IDÉNTICO a la cadena + 15c" "el rollback de 15d no restauró el estado anterior"
  s=$(correr t_15d_b "$SQLDIR/sync-15d-owner-pin-usuarios.sql") && ok "forward otra vez tras el rollback" || mal "no re-aplica tras rollback: $(tail -3 <<<"$s")"
  "$AQUI/entorno-local.sh" borra t_15d_b >/dev/null; "$AQUI/entorno-local.sh" borra t_15d_ref >/dev/null
}

# F09 con DOS sesiones de verdad al mismo tiempo (no secuencial): la primera cobra y espera 2 s antes de confirmar; la segunda llega
# mientras tanto. Mismo op_id → espera el cerrojo y devuelve «repetida». Otro op_id (otro dispositivo) → espera la fila y se rechaza.
concurrencia15e() {
  local db="$1" r a b
  local SES="SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', false), set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-4000-8000-000000000002\",\"role\":\"authenticated\"}', false), set_config('role', 'authenticated', false);"
  "${PSQL[@]}" -U supabase_admin -d "$db" -q -c "INSERT INTO public.ordenes (id, estado, falla) VALUES ('00000000-0000-4000-9000-000000098001', 'entregado', 'c1'), ('00000000-0000-4000-9000-000000098002', 'entregado', 'c2');
    INSERT INTO public.orden_items (orden_id, nombre, cantidad, precio, tipo) VALUES ('00000000-0000-4000-9000-000000098001', 'MO', 1, 700, 'mano_obra'), ('00000000-0000-4000-9000-000000098002', 'MO', 1, 900, 'mano_obra');" >/dev/null
  local CO1="SELECT public.finalizar_orden('00000000-0000-4000-9000-000000098101', '00000000-0000-4000-9000-000000098001', 'contado', 'efectivo')"
  { echo "$SES"; echo "BEGIN; $CO1; SELECT pg_sleep(2); COMMIT;"; } | "${PSQL[@]}" -U supabase_admin -d "$db" -At > /tmp/entimotors-c15e-1.txt 2>&1 &
  local p1=$!; sleep 0.6
  { echo "$SES"; echo "$CO1;"; } | "${PSQL[@]}" -U supabase_admin -d "$db" -At > /tmp/entimotors-c15e-2.txt 2>&1
  wait $p1
  r=$("${PSQL[@]}" -U supabase_admin -d "$db" -At -c "SELECT count(*) FROM public.caja_movimientos WHERE orden_id = '00000000-0000-4000-9000-000000098001'")
  if [ "$r" = "1" ] && grep -q '"repetida": true' /tmp/entimotors-c15e-2.txt; then ok "F09 concurrencia real, mismo op_id en dos sesiones: un solo ingreso y la segunda recibe «repetida»"; else mal "F09 mismo op_id concurrente: caja=$r $(tr '\n' ' ' < /tmp/entimotors-c15e-2.txt | cut -c1-200)"; fi
  local CO2A="SELECT public.finalizar_orden('00000000-0000-4000-9000-000000098201', '00000000-0000-4000-9000-000000098002', 'contado', 'efectivo', 0, NULL, NULL, NULL, 'dev-A')"
  local CO2B="SELECT public.finalizar_orden('00000000-0000-4000-9000-000000098202', '00000000-0000-4000-9000-000000098002', 'contado', 'efectivo', 0, NULL, NULL, NULL, 'dev-B')"
  { echo "$SES"; echo "BEGIN; $CO2A; SELECT pg_sleep(2); COMMIT;"; } | "${PSQL[@]}" -U supabase_admin -d "$db" -At > /tmp/entimotors-c15e-3.txt 2>&1 &
  p1=$!; sleep 0.6
  { echo "$SES"; echo "$CO2B;"; } | "${PSQL[@]}" -U supabase_admin -d "$db" -At > /tmp/entimotors-c15e-4.txt 2>&1
  wait $p1
  r=$("${PSQL[@]}" -U supabase_admin -d "$db" -At -c "SELECT count(*) || '|' || sum(monto) FROM public.caja_movimientos WHERE orden_id = '00000000-0000-4000-9000-000000098002'")
  if [ "$r" = "1|900.00" ] && grep -q "ya estaba finalizada" /tmp/entimotors-c15e-4.txt; then ok "F09 dos dispositivos cobran la MISMA orden a la vez (op_id distintos): exactamente un ingreso de 900; el segundo se rechaza"; else mal "F09 dos dispositivos: caja=$r $(tr '\n' ' ' < /tmp/entimotors-c15e-4.txt | cut -c1-200)"; fi
  r=$("${PSQL[@]}" -U supabase_admin -d "$db" -At -c "SELECT public.finanzas_invariantes()")
  [ "$r" = "[]" ] && ok "F09 invariantes financieras vacías tras la concurrencia" || mal "F09 invariantes: $r"
  rm -f /tmp/entimotors-c15e-[1-4].txt
}

# 3.15.0 · Bloque 6: estado de migración 3.13 en el servidor (sync-15f, solo lectura).
fase15f() {
  echo "== 3.15 · Bloque 6 · estado de migración 3.13 en el servidor (sync-15f) =="
  local CADENA="1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario 9-fotos 10-importacion sec-1c-clave-intentos 15a-cotizacion-inventario 15b-presupuestos-stock"
  local s d
  for d in t_15f_ref t_15f_a; do
    "$AQUI/entorno-local.sh" copia $d >/dev/null || { mal "copia $d"; return; }
    correr $d "$AQUI/sql/15c-realtime-stub.sql" >/dev/null; correr $d "$AQUI/sql/15d-auth-stub.sql" >/dev/null
    for f in $CADENA 15c-mensajes-realtime 15d-owner-pin-usuarios 15e-finanzas; do local arch="$SQLDIR/sync-$f.sql"; [[ "$f" == sec-* ]] && arch="$SQLDIR/$f.sql"; correr $d "$arch" >/dev/null || { mal "no se pudo aplicar $f en $d"; return; }; done
  done
  s=$(correr t_15f_a "$SQLDIR/sync-15f-legado-313.sql") && ok "sync-15f aplica sobre la cadena + 15e" || { mal "sync-15f falló: $(tail -6 <<<"$s")"; return; }
  s=$(correr t_15f_a "$SQLDIR/sync-15f-legado-313.sql") && ok "sync-15f re-aplica (idempotente)" || mal "sync-15f no es idempotente: $(tail -4 <<<"$s")"
  pruebas t_15f_a "$AQUI/sql/15f-legado.test.sql"
  s=$(correr t_15f_a "$SQLDIR/sync-15f-rollback.sql") && ok "rollback aplica" || { mal "rollback falló: $(tail -3 <<<"$s")"; return; }
  "${PSQL[@]}" -U supabase_admin -d t_15f_a -q -c "SET session_replication_role = replica; DELETE FROM public.import_lotes; DELETE FROM public.clientes; DELETE FROM public.categorias_inv;" >/dev/null
  comparar t_15f_ref t_15f_a "tras el rollback el esquema es IDÉNTICO a la cadena + 15e" "el rollback de 15f no restauró el estado anterior"
  s=$(correr t_15f_a "$SQLDIR/sync-15f-legado-313.sql") && ok "forward otra vez tras el rollback" || mal "no re-aplica tras rollback: $(tail -3 <<<"$s")"
  "$AQUI/entorno-local.sh" borra t_15f_a >/dev/null; "$AQUI/entorno-local.sh" borra t_15f_ref >/dev/null
}

# 3.15.0 · Bloque 5: FINANZAS CORRECTAS (sync-15e). Sin datos propios: el rollback es siempre seguro y devuelve el esquema idéntico.
fase15e() {
  echo "== 3.15 · Bloque 5 · finanzas: cobrado / por cobrar / costo histórico / no duplicar dinero (sync-15e) =="
  local CADENA="1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario 9-fotos 10-importacion sec-1c-clave-intentos 15a-cotizacion-inventario 15b-presupuestos-stock"
  local s r d
  for d in t_15e_ref t_15e_a; do
    "$AQUI/entorno-local.sh" copia $d >/dev/null || { mal "copia $d"; return; }
    correr $d "$AQUI/sql/15c-realtime-stub.sql" >/dev/null; correr $d "$AQUI/sql/15d-auth-stub.sql" >/dev/null
    for f in $CADENA 15c-mensajes-realtime 15d-owner-pin-usuarios; do local arch="$SQLDIR/sync-$f.sql"; [[ "$f" == sec-* ]] && arch="$SQLDIR/$f.sql"; correr $d "$arch" >/dev/null || { mal "no se pudo aplicar $f en $d"; return; }; done
  done
  q() { "${PSQL[@]}" -U supabase_admin -d t_15e_a -At -c "$1"; }
  s=$(correr t_15e_a "$SQLDIR/sync-15e-finanzas.sql") && ok "sync-15e aplica sobre la cadena + 15d" || { mal "sync-15e falló: $(tail -6 <<<"$s")"; return; }
  s=$(correr t_15e_a "$SQLDIR/sync-15e-finanzas.sql") && ok "sync-15e re-aplica (idempotente)" || mal "sync-15e no es idempotente: $(tail -4 <<<"$s")"
  r=$(q "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.estadisticas_tecnicas()'::regprocedure")
  [ "$r" != "86948fdcaf03939a1d0929004cd9c730" ] && ok "estadisticas_tecnicas evolucionó (ya no es la canónica UTC)" || mal "estadisticas_tecnicas sigue canónica"
  pruebas t_15e_a "$AQUI/sql/15e-finanzas.test.sql"
  concurrencia15e t_15e_a
  s=$(correr t_15e_a "$SQLDIR/sync-15e-rollback.sql") && ok "rollback aplica (15e no tiene datos propios)" || { mal "rollback falló: $(tail -3 <<<"$s")"; return; }
  r=$(q "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.estadisticas_tecnicas()'::regprocedure")
  [ "$r" = "86948fdcaf03939a1d0929004cd9c730" ] && ok "rollback: estadisticas_tecnicas vuelve a la canónica RCV-34 byte a byte" || mal "rollback: estadisticas_tecnicas md5 $r"
  "$AQUI/entorno-local.sh" borra t_15e_a >/dev/null
  "$AQUI/entorno-local.sh" copia t_15e_b >/dev/null
  correr t_15e_b "$AQUI/sql/15c-realtime-stub.sql" >/dev/null; correr t_15e_b "$AQUI/sql/15d-auth-stub.sql" >/dev/null
  for f in $CADENA 15c-mensajes-realtime 15d-owner-pin-usuarios 15e-finanzas; do local arch="$SQLDIR/sync-$f.sql"; [[ "$f" == sec-* ]] && arch="$SQLDIR/$f.sql"; correr t_15e_b "$arch" >/dev/null || { mal "no se pudo aplicar $f en B"; return; }; done
  s=$(correr t_15e_b "$SQLDIR/sync-15e-rollback.sql") && ok "rollback sobre base recién migrada" || mal "rollback falló: $(tail -3 <<<"$s")"
  comparar t_15e_ref t_15e_b "tras el rollback el esquema es IDÉNTICO a la cadena + 15d" "el rollback de 15e no restauró el estado anterior"
  s=$(correr t_15e_b "$SQLDIR/sync-15e-finanzas.sql") && ok "forward otra vez tras el rollback" || mal "no re-aplica tras rollback: $(tail -3 <<<"$s")"
  # con dinero DUPLICADO la migración se detiene (no crea índices a medias ni toca datos)
  "${PSQL[@]}" -U supabase_admin -d t_15e_b -q -c "SELECT 1" >/dev/null
  correr t_15e_b "$SQLDIR/sync-15e-rollback.sql" >/dev/null
  "${PSQL[@]}" -U supabase_admin -d t_15e_b -q -c "INSERT INTO public.ordenes (id, estado, falla) VALUES ('00000000-0000-4000-9000-000000099001', 'entregado', 'dup');
     INSERT INTO public.caja_movimientos (tipo, categoria, monto, orden_id) VALUES ('ingreso', 'Servicio taller', 10, '00000000-0000-4000-9000-000000099001'), ('ingreso', 'Servicio taller', 10, '00000000-0000-4000-9000-000000099001');" >/dev/null
  s=$(correr t_15e_b "$SQLDIR/sync-15e-finanzas.sql")
  if grep -q "SYNC-15E STOP: hay dinero duplicado" <<<"$s"; then ok "con un cobro duplicado en caja la migración se DETIENE y lo informa"; else mal "no se detuvo ante dinero duplicado: $(tail -2 <<<"$s")"; fi
  r=$("${PSQL[@]}" -U supabase_admin -d t_15e_b -At -c "SELECT count(*) FROM pg_indexes WHERE indexname LIKE 'caja_un_%' OR indexname = 'idx_caja_momento'; SELECT count(*) FROM public.caja_movimientos WHERE orden_id = '00000000-0000-4000-9000-000000099001'")
  [ "$r" = $'0\n2' ] && ok "…sin índices a medias y sin tocar los datos" || mal "tras la parada: $r"
  "$AQUI/entorno-local.sh" borra t_15e_b >/dev/null; "$AQUI/entorno-local.sh" borra t_15e_ref >/dev/null
}

# 3.15.0 · Bloque 7: políticas de lectura con su función evaluada UNA vez por consulta (sync-15g). La visibilidad por rol (7 roles ×
# 18 tablas: cuántas filas y CUÁLES) debe ser IDÉNTICA antes y después; el rollback deja el esquema idéntico a la cadena + 15f.
fase15g() {
  echo "== 3.15 · Bloque 7 · rendimiento de las políticas de lectura (sync-15g) =="
  local CADENA="1-esquema 2-seguridad 3-rpc 3b-importacion 3p-pin 5-cotizacion-items 6-mecanicos-ordenes 7a-inventario 9-fotos 10-importacion sec-1c-clave-intentos 15a-cotizacion-inventario 15b-presupuestos-stock"
  local s d antes despues
  for d in t_15g_ref t_15g_a; do
    "$AQUI/entorno-local.sh" copia $d >/dev/null || { mal "copia $d"; return; }
    correr $d "$AQUI/sql/15c-realtime-stub.sql" >/dev/null; correr $d "$AQUI/sql/15d-auth-stub.sql" >/dev/null
    for f in $CADENA 15c-mensajes-realtime 15d-owner-pin-usuarios 15e-finanzas 15f-legado-313; do local arch="$SQLDIR/sync-$f.sql"; [[ "$f" == sec-* ]] && arch="$SQLDIR/$f.sql"; correr $d "$arch" >/dev/null || { mal "no se pudo aplicar $f en $d"; return; }; done
  done
  antes=$(cat "$AQUI/sql/00-prelude.sql" "$AQUI/sql/15g-visibilidad.sql" | "${PSQL[@]}" -U supabase_admin -d t_15g_a 2>&1 | grep -o 'VIS|.*' | sort)
  [ "$(wc -l <<<"$antes")" -eq 126 ] && ok "visibilidad ANTES: 7 roles × 18 tablas" || mal "visibilidad antes incompleta: $(wc -l <<<"$antes") líneas"
  s=$(correr t_15g_a "$SQLDIR/sync-15g-rendimiento-rls.sql") && ok "sync-15g aplica sobre la cadena + 15f" || { mal "sync-15g falló: $(tail -6 <<<"$s")"; return; }
  s=$(correr t_15g_a "$SQLDIR/sync-15g-rendimiento-rls.sql") && grep -q "0 política(s) de lectura optimizadas (18 ya lo estaban)" <<<"$s" && ok "sync-15g re-aplica (idempotente: 18 ya estaban)" || mal "sync-15g no es idempotente: $(tail -4 <<<"$s")"
  despues=$(cat "$AQUI/sql/00-prelude.sql" "$AQUI/sql/15g-visibilidad.sql" | "${PSQL[@]}" -U supabase_admin -d t_15g_a 2>&1 | grep -o 'VIS|.*' | sort)
  [ "$antes" == "$despues" ] && ok "visibilidad IDÉNTICA después (mismas filas por rol y tabla)" || { mal "la visibilidad CAMBIÓ con 15g"; diff <(echo "$antes") <(echo "$despues") | head -10; }
  pruebas t_15g_a "$AQUI/sql/15g-rendimiento.test.sql"
  # parada segura: si una política no tiene la expresión esperada, 15g se detiene y NO cambia ninguna
  s=$(correr t_15g_ref "$SQLDIR/sync-15f-legado-313.sql" >/dev/null; "${PSQL[@]}" -U supabase_admin -d t_15g_ref -v ON_ERROR_STOP=1 -c "ALTER POLICY ventas_lee ON public.ventas USING (public.es_equipo())" 2>&1; correr t_15g_ref "$SQLDIR/sync-15g-rendimiento-rls.sql")
  r=$("${PSQL[@]}" -U supabase_admin -d t_15g_ref -At -c "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND qual ~ 'SELECT'")
  grep -q "SYNC-15G STOP: ventas.ventas_lee" <<<"$s" && [ "$r" = "0" ] && ok "política distinta a la esperada → se DETIENE y no cambia ninguna" || mal "parada: $r · $(tail -3 <<<"$s")"
  "${PSQL[@]}" -U supabase_admin -d t_15g_ref -q -c "ALTER POLICY ventas_lee ON public.ventas USING (public.ve_todo_el_taller())" >/dev/null
  s=$(correr t_15g_a "$SQLDIR/sync-15g-rollback.sql") && ok "rollback aplica" || { mal "rollback falló: $(tail -3 <<<"$s")"; return; }
  despues=$(cat "$AQUI/sql/00-prelude.sql" "$AQUI/sql/15g-visibilidad.sql" | "${PSQL[@]}" -U supabase_admin -d t_15g_a 2>&1 | grep -o 'VIS|.*' | sort)
  [ "$antes" == "$despues" ] && ok "visibilidad idéntica tras el rollback" || mal "la visibilidad cambió tras el rollback"
  "${PSQL[@]}" -U supabase_admin -d t_15g_a -q -c "SET session_replication_role = replica; TRUNCATE public.clientes, public.motos, public.citas, public.categorias_inv, public.cotizaciones, public.cotizacion_items, public.ordenes, public.orden_items, public.inventario, public.ventas, public.venta_items, public.creditos, public.credito_items, public.abonos, public.caja_movimientos, public.mensajes, public.web_cms CASCADE; DELETE FROM public.auditoria WHERE accion = 'b7';" >/dev/null
  comparar t_15g_ref t_15g_a "tras el rollback el esquema es IDÉNTICO a la cadena + 15f" "el rollback de 15g no restauró el estado anterior"
  s=$(correr t_15g_a "$SQLDIR/sync-15g-rendimiento-rls.sql") && ok "forward otra vez tras el rollback" || mal "no re-aplica tras rollback: $(tail -3 <<<"$s")"
  "$AQUI/entorno-local.sh" borra t_15g_a >/dev/null; "$AQUI/entorno-local.sh" borra t_15g_ref >/dev/null
}

case "${1:-}" in
  15g) fase15g ;;
  15f) fase15f ;;
  15e) fase15e ;;
  15d) fase15d ;;
  15c) fase15c ;;
  15a) fase15a ;;
  15b) fase15b ;;
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
