#!/usr/bin/env bash
# ENTIMOTORS 3.15 · Bloque 5 · PUERTA PRE-RELEASE: respaldo de negocio → manifiesto → hashes → restauración aislada → invariantes → PASS/FAIL.
#
#   puerta-pre-release.sh --salida DIR (--origen-servicio entimotors_prod | --origen-contenedor C --db D) [--storage-copia DIR]
#   puerta-pre-release.sh --respaldo-existente DIR          solo re-verifica y re-restaura un respaldo ya hecho
#
# Sale 0 = «se puede seguir con el release»; cualquier otro código = RELEASE BLOQUEADO (y lo dice). No hace NADA destructivo contra el
# origen: el respaldo es de solo lectura y la restauración ocurre en un contenedor desechable sin red. No aplica migraciones, no publica.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bloquear() { echo; echo "════ RELEASE BLOQUEADO: $1 ════"; exit 1; }
if [ "${1:-}" = "--respaldo-existente" ]; then DIR=${2:?falta DIR}
else
  SAL=""; ARGS=("$@")
  for ((i = 0; i < ${#ARGS[@]}; i++)); do [ "${ARGS[$i]}" = "--salida" ] && SAL=${ARGS[$((i + 1))]}; done
  [ -n "$SAL" ] || { echo "uso: puerta-pre-release.sh --salida DIR (--origen-servicio S | --origen-contenedor C --db D) [--storage-copia DIR]" >&2; exit 2; }
  echo "══ 1. RESPALDO ══"
  bash "$AQUI/respaldar.sh" "$@" || bloquear "el respaldo no quedó VERIFICADO (o el escaneo de secretos encontró algo)"
  DIR=$SAL
fi
echo "══ 2. VERIFICACIÓN INDEPENDIENTE (relee hashes y manifiesto) ══"
node "$AQUI/respaldo.mjs" verificar --dir "$DIR" || bloquear "el respaldo no pasa la verificación de hashes/manifiesto"
echo "══ 3. RESTAURACIÓN AISLADA + COMPARACIÓN ══"
bash "$AQUI/restaurar-aislado.sh" "$DIR" || bloquear "la restauración aislada no reproduce el origen (negocio, finanzas o Storage)"
echo; echo "════ PUERTA PRE-RELEASE: PASS · respaldo $DIR ════"
