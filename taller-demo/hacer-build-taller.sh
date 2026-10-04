#!/usr/bin/env bash
# ============================================================================
# ENTIMOTORS OS · build PÚBLICO del Taller (GitHub Pages, repo B)  · 3.15 (Bloque 6)
# ----------------------------------------------------------------------------
# Hasta 3.14 el Taller se publicaba copiando a mano «solo el runtime». Este script
# lo deja escrito: una LISTA EXPLÍCITA de lo que se publica (lo que no está aquí no
# sale), y comprobaciones que detienen el build si falta algo que la app carga o si
# se cuela algo técnico:
#   · se publican los scripts que carga index.html, el SHELL del service worker,
#     manifest e íconos. NADA más.
#   · NO se publican: panel-tecnico.html, config-local.js (ni el .example),
#     hacer-build-*.sh, build-mecanicos/, supabase/ (SQL), README.md, CHANGELOG.md.
#   · se quita de index.html la etiqueta opcional de config-local.js (como Mi Trabajo).
# La carpeta se llama taller-demo por historia (builds, pruebas, manifiestos); el
# nombre no llega al producto.
# Uso: hacer-build-taller.sh <directorio-destino>
# ============================================================================
set -euo pipefail
DESTINO="${1:-}"
if [ -z "$DESTINO" ]; then echo "uso: $0 <directorio-destino>" >&2; exit 1; fi
ORIGEN="$(cd "$(dirname "$0")" && pwd)"

PUBLICAR=(index.html manifest.json sw.js build-target.js supabase-config.js supabase-client.js auth.js recovery.js
  fecha-negocio.js finanzas-calc.js sync-rest.js sync-db.js sync-engine.js sync-realtime.js sync-mappers.js sync-fotos.js
  sync-finanzas.js pin-ui.js import-313.js app.js usuarios.js
  icons/icon-192.png icons/icon-192-maskable.png icons/icon-512.png icons/icon-512-maskable.png icons/logo-watermark.png icons/logo-watermark-doc.png)

rm -rf "$DESTINO"; mkdir -p "$DESTINO/icons"
for f in "${PUBLICAR[@]}"; do cp -p "$ORIGEN/$f" "$DESTINO/$f"; done

# la etiqueta opcional de config-local.js (solo desarrollo) no viaja
sed -i '/<!-- config-local\.js es opcional/,/Ver config-local\.example\.js\. -->/d' "$DESTINO/index.html"
sed -i '/^<script src="config-local\.js/d' "$DESTINO/index.html"

falla() { echo "build del Taller: $*" >&2; exit 1; }
# todo script que carga index.html existe en el build
for s in $(grep -o '<script src="[^"?]*' "$DESTINO/index.html" | cut -d'"' -f2 | grep -v '^https://'); do [ -f "$DESTINO/$s" ] || falla "index.html carga $s y no está"; done
# todo el SHELL del service worker existe en el build
for s in $(sed -n '/^const SHELL = \[/,/\];/p' "$DESTINO/sw.js" | grep -o '"\./[^"?]*' | cut -c4-); do [ -z "$s" ] || [ -f "$DESTINO/$s" ] || falla "el SHELL precachea $s y no está"; done
# nada técnico ni de desarrollo
for x in panel-tecnico.html config-local.js config-local.example.js hacer-build-mecanicos.sh hacer-build-taller.sh README.md CHANGELOG.md supabase build-mecanicos; do
  [ ! -e "$DESTINO/$x" ] || falla "se coló $x"; done
! grep -rqE '(src=|import |import\(|fetch\()[^\n]*config-local' "$DESTINO" --include=*.html --include=*.js || falla "queda una referencia EJECUTABLE a config-local.js"
[ "$(find "$DESTINO" -type f | wc -l)" -eq "${#PUBLICAR[@]}" ] || falla "hay archivos fuera de la lista"
echo "build del Taller listo en $DESTINO ($(find "$DESTINO" -type f | wc -l) archivos)"
