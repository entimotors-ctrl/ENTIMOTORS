#!/usr/bin/env bash
# ============================================================================
# ENTIMOTORS OS · genera el build de «Mi Trabajo» (origin de mecánicos)
# ----------------------------------------------------------------------------
# Copia taller-demo tal cual y le superpone lo que distingue al producto de
# mecánicos. Se genera en cada publicación, así que no hay dos index.html ni
# dos app.js que mantener sincronizados: la fuente sigue siendo una sola.
#
#   uso:  ./hacer-build-mecanicos.sh <directorio-destino>
#
# Lo que hace, y por qué cada cosa:
#   · build-target.js  → declara producto "mecanico" (ver build-target.js).
#   · manifest.json    → otro nombre e icono en la pantalla de inicio, para que
#                        nadie confunda las dos PWAs instaladas.
#   · config-local.js  → se borra el archivo Y la etiqueta que lo carga. Que dé
#                        404 no basta: no debe quedar ni la referencia.
#   · CACHE_NAME       → renombrado. Los Cache Storage ya están separados por
#                        origin, pero con el mismo nombre en los dos es
#                        imposible saber cuál estás mirando al depurar.
# ============================================================================
set -euo pipefail

DESTINO="${1:-}"
if [ -z "$DESTINO" ]; then echo "uso: $0 <directorio-destino>" >&2; exit 1; fi
ORIGEN="$(cd "$(dirname "$0")" && pwd)"

rm -rf "$DESTINO"
mkdir -p "$DESTINO"
cp -r "$ORIGEN"/. "$DESTINO"/

# lo que no es parte de este producto
rm -rf "$DESTINO/build-mecanicos" "$DESTINO/hacer-build-mecanicos.sh" "$DESTINO/hacer-build-taller.sh" \
       "$DESTINO/config-local.js" "$DESTINO/config-local.example.js" \
       "$DESTINO/panel-tecnico.html" "$DESTINO/supabase" \
       "$DESTINO/README.md" "$DESTINO/CHANGELOG.md"

# lo que sí lo distingue
cp "$ORIGEN/build-mecanicos/build-target.js" "$DESTINO/build-target.js"
# 3.15 (Bloque 6): ningún archivo técnico puede colarse aunque alguien lo agregue a la carpeta sin tocar la lista de arriba
if find "$DESTINO" -type f \( -name '*.sh' -o -name '*.md' -o -name '*.sql' -o -name 'panel-tecnico.html' -o -name 'config-local*' \) | grep -q .; then
  echo "build: se coló un archivo técnico:" >&2; find "$DESTINO" -type f \( -name '*.sh' -o -name '*.md' -o -name '*.sql' -o -name 'panel-tecnico.html' -o -name 'config-local*' \) >&2; exit 1
fi
cp "$ORIGEN/build-mecanicos/manifest.json"   "$DESTINO/manifest.json"
cp "$ORIGEN/build-mecanicos/_headers"        "$DESTINO/_headers"

# Sin _redirects a propósito: la app es un único index.html y la recuperación
# vuelve a la raíz con el token en el hash, así que no hace falta reescribir
# nada. Y un "/* /index.html 200" sería peor que inútil: si build-target.js
# faltara, Netlify devolvería index.html con código 200, el navegador
# intentaría ejecutar HTML como JavaScript y el producto caería a "admin" en
# el origin de los mecánicos. Mejor un 404 franco.

# fuera la etiqueta de config-local.js (y su comentario)
# Ojo: el comentario de config-local está por encima de TODO el bloque de
# scripts, no pegado a su etiqueta. Se borran por separado, o se lleva por
# delante la capa de Supabase entera.
sed -i '/<!-- config-local\.js es opcional/,/Ver config-local\.example\.js\. -->/d' "$DESTINO/index.html"
sed -i '/^<script src="config-local\.js/d' "$DESTINO/index.html"
sed -i 's/<title>ENTIMOTORS OS<\/title>/<title>ENTIMOTORS · Mi Trabajo<\/title>/' "$DESTINO/index.html"
# 3.15 (Bloque 6): un reemplazo que no encuentra su texto falla en silencio con sed; aquí se exige que haya quedado aplicado
grep -q '<title>ENTIMOTORS · Mi Trabajo</title>' "$DESTINO/index.html" || { echo "build: no se pudo poner el título de Mi Trabajo" >&2; exit 1; }
sed -i 's/<h1>Instala ENTIMOTORS OS<\/h1>/<h1>Instala ENTIMOTORS Mi Trabajo<\/h1>/' "$DESTINO/index.html"
sed -i 's/Abre ENTIMOTORS OS desde su propio ícono/Abre Mi Trabajo desde su propio ícono/' "$DESTINO/index.html"

# caché distinguible de un vistazo
sed -i 's/^const CACHE_NAME = "entimotors-/const CACHE_NAME = "entimotors-mitrabajo-/' "$DESTINO/sw.js"

# Comprobación: ninguna referencia EJECUTABLE a config-local.js (una etiqueta
# <script src>, un import, un fetch). Los comentarios que lo mencionan quedan y
# no son referencias: explican por qué el archivo no está.
if grep -rnE '(src=|import |import\(|fetch\()[^\n]*config-local' "$DESTINO" --include=*.html --include=*.js >/dev/null 2>&1; then
  echo "ABORTADO: quedan referencias ejecutables a config-local en el build de mecánicos" >&2
  grep -rnE '(src=|import |import\(|fetch\()[^\n]*config-local' "$DESTINO" --include=*.html --include=*.js >&2
  exit 1
fi
if [ -e "$DESTINO/config-local.js" ] || [ -e "$DESTINO/config-local.example.js" ]; then
  echo "ABORTADO: config-local quedó dentro del build de mecánicos" >&2; exit 1
fi
if ! grep -q 'producto: "mecanico"' "$DESTINO/build-target.js"; then
  echo "ABORTADO: el build no quedó marcado como producto mecánico" >&2; exit 1
fi

echo "build de mecánicos generado en: $DESTINO"
