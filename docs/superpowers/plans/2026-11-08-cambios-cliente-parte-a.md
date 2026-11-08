# Cambios del cliente 3.16 · Parte A (solo frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Programar los cambios 1, 2, 3, 6 y 7 del cliente (los que no tocan la base de datos) en la rama `feat/3.16-cambios-cliente`, sin publicar nada.

**Architecture:** Todo vive en `taller-demo/` (PWA de un solo `app.js` + `index.html` + `usuarios.js`). La lógica nueva que se puede probar sin navegador va en dos archivos pequeños y puros (`fotos-avance.js`, `mensajes-fijos.js`) cargados como los demás `*.js` y probados con `node --test` vía `vm`, igual que `finanzas-calc.js`. La parte visual se verifica con un script de Playwright que sirve una copia **sin nube** de la app y mide a 360/390 px.

**Tech Stack:** JavaScript sin bundler, IndexedDB, Web Share API, `node:test` + `vm`, Playwright para Python (`~/.venvs/playwright/bin/python`, `channel="chrome"`).

**Spec:** `/home/wilkin/Escritorio/Sistema-emos/CAMBIOS-CLIENTE-pendientes.md` (cambios 1, 2, 3, 6, 7 y «Decisiones tomadas»).

**Fuera de esta parte (Parte B, plan aparte, necesita migración `sync-16a` + backend):** cambio 4 (citas del mecánico), cambio 5 (trabajo rápido por mecánico), sincronizar en la nube la marca de «foto enviada», corregir una orden **ya cobrada** con PIN.

## Global Constraints

- Nada se publica: ni Netlify, ni GitHub Pages, ni push a `main` (push a `main` = redeploy de Render).
- Ningún cambio de base de datos ni de `api-server/` en esta parte.
- Todo texto visible en español, tono del resto de la app.
- Todo nombre de cliente/repuesto que se pinte con `innerHTML` pasa por `esc()` (la 3.15.1 fue justo un XSS en avisos).
- Objetivo táctil: todo lo que se toca mide **≥ 44 px** de alto en `@media (pointer: coarse)`; en PC no cambia el tamaño.
- En el teléfono (`max-width: 600px`) ninguna acción queda fuera de la pantalla horizontalmente.
- Archivo nuevo en `taller-demo/` ⇒ registrarlo en `index.html` (`<script src="X.js?v=3.15.1">`), en `SHELL` de `sw.js`, en la lista de `hacer-build-taller.sh` (línea 24) y comprobar que `hacer-build-mecanicos.sh` lo copia (copia todo con `cp -r`).
- No subir la versión (sigue `3.15.1` en caché/`?v=`); la versión se sube al preparar la publicación.
- Commits pequeños, uno por tarea, terminando con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Orden cobrada (`finalizada`)**: no debe ofrecer editar/quitar renglones (el servidor lo rechaza: «La orden ya está cerrada»). Prueba en Task 3.
- **Compartir cancelado o no soportado** (PC, Firefox): ninguna foto queda marcada como enviada. Prueba en Task 6.
- **Mensaje de hace 35 h vs 37 h y mensaje sin leer de hace 3 días**: el primero y el tercero quedan fijos arriba, el segundo baja al historial. Prueba en Task 5.
- **Nombre con marcado** (`<img src=x onerror=…>`) en renglón, cliente o usuario mostrado como tarjeta: se ve como texto. Prueba en Task 2 y Task 7.
- **Usuario eliminado** ya no aparece en la lista principal, pero sí en «Ver eliminados (N)». Prueba en Task 7.

---

### Task 1: Herramienta de revisión en teléfono (línea base)

**Files:**
- Create: `pruebas/ui-telefono/revisar.py`
- Create: `pruebas/ui-telefono/README.md`

**Interfaces:**
- Produces: `python -I pruebas/ui-telefono/revisar.py [--ancho 360] [--salida DIR]` → imprime una línea JSON por pantalla `{vista, chicos:[...], fuera:[...], tablasCortadas:[...]}` y sale con código 1 si alguna lista no está vacía. Lo usan las tareas 2, 3, 4, 7 como verificación.

- [ ] **Step 1:** Escribir `revisar.py`: copia `taller-demo/` a un directorio temporal, sobrescribe `supabase-config.js` con `habilitado:false` y crea `config-local.js` con `teamPasswords:{wilkin:"prueba123"}, adminCode:"0000"`; sirve la copia con `http.server` en `127.0.0.1` (puerto libre); entra con «Usar en esta pestaña sin instalar» → login `wilkin` → «Ver un ejemplo»; recorre las vistas `dashboard,pos,ordenes,cotizaciones,citas,clientes,inventario,finanzas,creditos,ajustes` y el detalle de las órdenes 1, 2 y 3 (`openOrder(n)`); mide con el mismo criterio que la auditoría del 2026-11-08 (botón visible fuera de `innerWidth`, o con alto/ancho < 44 px en `pointer: coarse`; `.table-scroll`/`table` con `scrollWidth > clientWidth + 2`). Guarda una captura por vista en `--salida`.
- [ ] **Step 2:** Correrlo sobre el código actual. Esperado: FALLA (código 1) y lista, entre otros, `tablaItems` cortada y «Editar renglón (dentro de tabla desplazable)» en `orden1`. Guardar la salida como línea base en el README.
- [ ] **Step 3:** Commit `test(ui): revisión en teléfono de pantallas del Taller (línea base)`.

---

### Task 2: Base táctil y renglones como tarjetas (cambios 2 y 3)

**Files:**
- Modify: `taller-demo/index.html` (bloque `<style>`; reglas de `.btn.small`, `.seg-opt`, filtros, `.tabla-renglones`, botón flotante de inicio)
- Modify: `taller-demo/app.js` — `filasTablaRenglones` y sus usos en `renderPresupuestoStage` (~3882), formulario de cotización (~4923) y detalle de cotización (`cotDetItems`)
- Test: `pruebas/ui-telefono/revisar.py`

**Interfaces:**
- Produces: clase CSS `tabla-tarjetas` para cualquier `<table>`: en `max-width:600px` cada `<tr>` es una tarjeta y cada `<td data-label="…">` muestra su etiqueta con `::before`. Clase `acciones-renglon` para el contenedor de botones de una fila. Las tareas 4 y 7 la reutilizan.

- [ ] **Step 1:** CSS táctil: dentro de `@media (pointer: coarse)` → `min-height:44px` para `.btn`, `.btn.small`, `.seg-opt`, los chips de categoría del TPV, `select` e `input` (excepto `checkbox/radio`); los botones de solo ícono (`.acciones button`) `min-width:44px`.
- [ ] **Step 2:** CSS `tabla-tarjetas` + `acciones-renglon` (botones con texto «✎ Editar» / «🗑 Quitar», a lo ancho en el teléfono). La fila de encabezado de sección («Sin clasificar (anteriores a 3.15)») ocupa la tarjeta completa.
- [ ] **Step 3:** Aplicar a los tres sitios de renglones: añadir `class="tabla-tarjetas"` a la tabla, `data-label` a cada celda (Ítem, Cant., Precio, Subtotal) y texto a los botones de acción conservando `data-editar`/`data-quitar`, `title` y `aria-label`.
- [ ] **Step 4:** Botón flotante de inicio: añadir `padding-bottom` a `.view` igual a su alto + 16 px en el teléfono, para que no tape el final de las listas ni el carrito.
- [ ] **Step 5:** Prueba de XSS: con Playwright, crear un renglón llamado `<img src=x onerror="window.__xss=1">` en la orden 1 y comprobar `window.__xss === undefined` y que el texto se ve literal.
- [ ] **Step 6:** `revisar.py --ancho 360` y `--ancho 390`. Esperado: `orden1` ya **sin** `tablasCortadas` ni `fuera`; lo de Clientes/Inventario/Finanzas/Créditos sigue (Task 4). Revisar a ojo las capturas de `orden1` y del detalle de cotización.
- [ ] **Step 7:** Commit `feat(ui): renglones como tarjetas y tamaño táctil en el teléfono`.

---

### Task 3: Corregir renglones de la orden en cualquier etapa hasta cobrarla (cambio 2)

**Files:**
- Modify: `taller-demo/app.js` — bloque de etapas de `openOrder` (~3697 `presupuesto`, ~3717 `reparacion`, la rama `calidad` y la de `entregado`)

**Interfaces:**
- Consumes: `renderPresupuestoStage(o, { anexar: true })` existente.
- Produces: `puedeCorregirRenglones(o) -> boolean` en `app.js` = `!esMecanicoCuenta() && !o.finalizada && !o.anulada`.

- [ ] **Step 1:** Prueba (Playwright, copia sin nube): en la orden 3 de ejemplo (Entregado, sin finalizar) debe existir `#itemsBody [data-editar]`; tras «Finalizar trabajo y guardar registro» ya **no** existe y se ve el texto «La orden ya se cobró: para corregirla hay que anularla (PIN del propietario).». En `calidad` también existe.
- [ ] **Step 2:** Correrla. Esperado: FALLA (hoy no hay tabla en calidad/entregado).
- [ ] **Step 3:** Implementar `puedeCorregirRenglones` y anexar `renderPresupuestoStage(o, { anexar: true })` en `calidad` y `entregado` cuando sea `true`; cuando la orden está finalizada, pintar la tabla en solo lectura (sin columna de acciones) con el texto de arriba.
- [ ] **Step 4:** Correr la prueba y `revisar.py`. Esperado: PASA, sin regresiones en `orden1`–`orden3`.
- [ ] **Step 5:** Commit `feat(ordenes): corregir renglones en cualquier etapa hasta cobrar`.

---

### Task 4: Cotización — borrar sin el código local y «abrir la orden» si ya se aceptó (cambio 2)

**Files:**
- Modify: `taller-demo/app.js` — listener de `btnCotEliminar` (~5162) y `abrirCotizacionDetalle` (~5099)
- Modify: `taller-demo/index.html` — botón `btnCotEliminar` (~1978) y nuevo botón `btnCotAbrirOrden`

**Interfaces:**
- Consumes: `showConfirm(mensaje, { titulo, textoOk })`, `openOrder(id)`, `cerrarCotDetalle()`.

- [ ] **Step 1:** Prueba (Playwright, copia **sin** `adminCode` en `config-local.js`, que es como está producción): crear cotización → detalle → «🗑 Eliminar cotización» → confirmar → la lista queda en 0. Con una cotización aceptada: no hay botón de eliminar y «Abrir la orden #N para corregir» abre `view-orden` de la orden N.
- [ ] **Step 2:** Correrla. Esperado: FALLA en «Código incorrecto».
- [ ] **Step 3:** Implementar:
  - **Eliminar:** `btnCotEliminar` con texto «🗑 Eliminar cotización». Confirma con `showConfirm("Se borra la cotización #N de Cliente. No movió inventario ni caja.", { titulo: "Eliminar cotización", textoOk: "Eliminar" })` en lugar de `requestAdminCode`. Se oculta si `estado === "aceptada"` o `cot.ordenId`.
  - **Abrir la orden:** `btnCotAbrirOrden` («Abrir la orden #N para corregir») es visible solo si hay `cot.ordenId`; cierra el detalle y llama a `openOrder(cot.ordenId)`.
- [ ] **Step 4:** Correr la prueba. Esperado: PASA. Comprobar a mano en modo nube (código, no ejecución) que `DB.delete("cotizaciones", id)` sigue el camino de `syncMotor.escribir(..., { borrar: true })` (~línea 753).
- [ ] **Step 5:** Revisar los otros `requestAdminCode` (eliminar crédito ~7656, movimiento de caja ~7273, orden en modo local ~3427). Para cada uno, anotar en el commit si en modo nube llega a mostrarse (si se muestra, cambiarlo al mismo patrón que ya usa la orden en nube: PIN del propietario vía `PinUI.autorizarAccion` cuando mueve dinero, `showConfirm` cuando no).
- [ ] **Step 6:** Commit `fix(cotizaciones): eliminar sin el código local (no existe en producción) y abrir la orden aceptada`.

---

### Task 5: Mensajes fijos 36 horas en Mi Trabajo (cambio 6)

**Files:**
- Create: `taller-demo/mensajes-fijos.js`
- Modify: `taller-demo/app.js` — `renderMensajesMiTrabajo` (~1203) y el aviso de mensaje nuevo (~1144)
- Modify: `taller-demo/index.html` (script + estilo `.mensaje-fijo`), `taller-demo/sw.js` (SHELL), `taller-demo/hacer-build-taller.sh`
- Test: `pruebas/sync/node/c6-mensajes-fijos.test.mjs`

**Interfaces:**
- Produces: `window.MensajesFijos = { HORAS_FIJO: 36, separar(mensajes, ahoraMs, esNoLeido) -> { fijos: Mensaje[], historial: Mensaje[] } }`. `fijos` = no leídos (cualquier edad) + los de `creadoEn >= ahora - 36h`, ordenados por `creadoEn` descendente; `historial` = el resto, mismo orden.

- [ ] **Step 1:** Escribir la prueba con mensajes de 1 h, 35 h, 37 h (leído), 72 h (sin leer) y `creadoEn: null`: `fijos` = [1h, 35h, 72h-sin-leer], `historial` = [37h, null al final]; `HORAS_FIJO === 36`.
- [ ] **Step 2:** `node --test pruebas/sync/node/c6-mensajes-fijos.test.mjs`. Esperado: FALLA (no existe el archivo).
- [ ] **Step 3:** Implementar `mensajes-fijos.js` (IIFE sobre `window`/`this`, como `finanzas-calc.js`) y registrarlo en `index.html`, `sw.js` y `hacer-build-taller.sh`.
- [ ] **Step 4:** Correr la prueba. Esperado: PASA.
- [ ] **Step 5:** En `renderMensajesMiTrabajo`, pintar `fijos` arriba de Mi Trabajo (antes de `#miTrabajoAlcance`) en tarjetas `.mensaje-fijo` con el texto completo, y `historial` debajo, plegado en «Mensajes anteriores (N)». El aviso de mensaje nuevo pasa a ser una tarjeta fija con las primeras 120 letras del texto y un botón «Ver», sin cerrarse sola. Comprobarlo con Playwright y el mismo arnés de la auditoría, sembrando mensajes en el almacén `auditoria` de la caché de sync.
- [ ] **Step 6:** Commit `feat(mi-trabajo): mensajes del administrador fijos 36 horas`.

---

### Task 6: Fotos del avance por WhatsApp sin repetir las ya enviadas (cambio 1)

**Files:**
- Create: `taller-demo/fotos-avance.js`
- Modify: `taller-demo/app.js` — listener de `btnEnviarProgresoWA` (~4708)
- Modify: `taller-demo/index.html` (modal `modalProgresoFotos`, script), `taller-demo/sw.js`, `taller-demo/hacer-build-taller.sh`
- Test: `pruebas/sync/node/c1-fotos-avance.test.mjs`

**Interfaces:**
- Produces: `window.FotosAvance`:
  - `claveFoto(src: string) -> string`: para rutas de Storage, la ruta; para `data:` URL, `"d:" + longitud + ":" + hash` FNV-1a de 32 bits en hex de toda la cadena.
  - `pendientes(fotos: string[], enviadas: string[]) -> string[]`: las de `fotos` cuya clave no está en `enviadas`, en el mismo orden.
  - `marcar(enviadas: string[], fotos: string[]) -> string[]`: unión sin duplicados de las claves.
  - Almacén local (Parte A): `localStorage["enti_fotos_enviadas"]` = `{ [ordenUid || "local:" + ordenId]: string[] }`, envuelto en try/catch; en la Parte B pasa a la nube.

- [ ] **Step 1:** Prueba: misma foto data URL → misma clave; dos distintas del mismo largo → claves distintas; `pendientes(["a","b","c"], [claveFoto("a")])` = `["b","c"]`; `marcar` sin duplicados; ruta `ordenes/u1/f.jpg` → clave igual a la ruta.
- [ ] **Step 2:** Correrla. Esperado: FALLA.
- [ ] **Step 3:** Implementar y registrar el archivo (`index.html`, `sw.js`, `hacer-build-taller.sh`). Correr la prueba. Esperado: PASA.
- [ ] **Step 4:** UI en `app.js`:
  - **Sin fotos pendientes:** «📲 Progreso por WhatsApp» sigue igual (texto por `wa.me`, `abrirVentanaWA` antes de cualquier `await`).
  - **Con fotos (`o.fotos` + `o.fotosNube` firmadas con `obtenerUrlFotoFirmada`):** abre `modalProgresoFotos` con el texto de la etapa, miniaturas con casilla (las pendientes marcadas, las enviadas con la etiqueta «Ya enviada») y los botones «Enviar por WhatsApp» y «Solo el texto».
  - **Preparación:** los `File` se arman al abrir el modal (data URL → Blob síncrono; nube → `fetch` del URL firmado), y «Enviar» se deshabilita hasta que estén listos.
  - **Al enviar:** «Enviar» llama a `navigator.share({ files, text })` sin `await` previo y, antes, `navigator.clipboard?.writeText(texto)` sin esperar. Solo en el `.then` marca las fotos con `marcar` y muestra «Avance enviado · N fotos». Con `AbortError` no marca nada.
  - **Sin `canShare({ files })`:** descarga las fotos, avisa «Este navegador no comparte fotos: se descargaron para adjuntarlas» y **no** las marca.
- [ ] **Step 5:** Prueba Playwright (copia sin nube): la orden 1 con 2 fotos y `navigator.share` simulado que resuelve → la segunda vez solo hay 1 pendiente si se agregó una nueva; con `share` simulado que rechaza `AbortError` → siguen 2 pendientes.
- [ ] **Step 6:** Commit `feat(ordenes): mandar las fotos del avance sin repetir las ya enviadas`.

---

### Task 7: Usuarios y equipo — tarjetas, eliminados aparte, errores visibles (cambio 7)

**Files:**
- Modify: `taller-demo/usuarios.js` — `render` (~102), `enganchar` (`.u-rol`), `eliminarUsuario` (~291), `aviso`/`bien`
- Modify: `taller-demo/index.html` (estilos de tarjeta de usuario si no basta `tabla-tarjetas`)
- Test: `pruebas/ui-telefono/usuarios.py` (servidor simulado con `page.route`, como en la auditoría)

**Interfaces:**
- Consumes: `tabla-tarjetas` (Task 2); `GET {apiUrl}/api/admin/pin/estado` → `{ configurado: boolean, bloqueado: boolean }` (ya existe en `api-server/src/routes/pin.ts:176`).
- Produces: `#usuariosAvisoFijo` (recuadro que no se cierra solo, con botón «Entendido») usado por `aviso()` y `bien()` de esta pantalla.

- [ ] **Step 1:** Prueba `usuarios.py` a 390 px con 3 usuarios simulados (dueño, Mecánico 1 activo, Mecánico 2 `eliminado`):
  - **Lista:** «Mecánico 2» no está en la lista principal y sí dentro de «Ver eliminados (1)»; «Eliminar usuario» de Mecánico 1 está dentro de la pantalla y mide ≥ 44 px.
  - **Eliminar:** simular `impacto` + `pin/estado {configurado:true}` + PIN aceptado + `eliminar` 200 → Mecánico 1 desaparece de la lista principal y `#usuariosAvisoFijo` dice «Mecánico 1 eliminado · ya no puede entrar · su historial se conserva».
  - **Rechazo:** `eliminar` 403 `AUTORIZACION_INVALIDA` → el recuadro muestra el texto de `textoPlanoDeFallo` y sigue visible a los 5 s.
  - **Sin PIN:** `pin/estado {configurado:false}` → no se pide el PIN y el recuadro dice «Primero configura el PIN del propietario en Ajustes.» con un botón «Ir a Ajustes».
  - **XSS:** nombre `<img src=x onerror=window.__xss=1>` → `window.__xss` indefinido.
- [ ] **Step 2:** Correrla. Esperado: FALLA.
- [ ] **Step 3:** Implementar:
  - **Lista:** `tabla-tarjetas` con `data-label`; los eliminados se filtran a un `<details>` «Ver eliminados (N)».
  - **Avisos:** `aviso`/`bien` escriben en `#usuariosAvisoFijo` (con `textContent`) además del `toast`.
  - **PIN:** comprobar `pin/estado` antes de `PinUI.autorizarAccion`.
  - **Rol:** `.u-rol` confirma con `showConfirm("¿Pasar a {nombre} de {rol actual} a {rol nuevo}?")`; si se cancela, vuelve al valor anterior sin `PATCH`.
- [ ] **Step 4:** Correr la prueba y `revisar.py`. Esperado: PASA.
- [ ] **Step 5:** Commit `fix(usuarios): el eliminado sale de la lista, errores visibles y rol con confirmación`.

---

### Task 8: Tablas largas como tarjetas en Clientes, Inventario, Finanzas y Créditos (cambio 3)

**Files:**
- Modify: `taller-demo/app.js` — funciones que pintan las tablas de Clientes (~6090), Inventario, movimientos de Finanzas (~7266) y Créditos
- Modify: `taller-demo/index.html` — `class="tabla-tarjetas"` en esas tablas; «Agregar fotos» como botón grande «📷 Tomar o elegir fotos» (el `input#inputFotos` queda oculto y lo abre un `<label for>`)

**Interfaces:**
- Consumes: `tabla-tarjetas` (Task 2).

- [ ] **Step 1:** Añadir `data-label` a cada `<td>` que pintan esas funciones y la clase a cada tabla; las acciones van en `acciones-renglon` con texto.
- [ ] **Step 2:** `revisar.py --ancho 360`. Esperado: sale con código 0 (sin `fuera`, `chicos` ni `tablasCortadas` en ninguna vista). Revisar las capturas a ojo.
- [ ] **Step 3:** Comprobar a 1280 px que en PC las tablas se ven como antes (captura de Clientes y Finanzas).
- [ ] **Step 4:** Commit `feat(ui): listas como tarjetas en el teléfono`.

---

### Task 9: Cierre de la Parte A

**Files:**
- Modify: `taller-demo/CHANGELOG.md` (sección «3.16.0 · sin publicar»), `/home/wilkin/Escritorio/Sistema-emos/CAMBIOS-CLIENTE-pendientes.md` (marcar qué quedó hecho)

- [ ] **Step 1:** Correr todo lo que no necesita Docker: `node --test pruebas/sync/node/` y `cd pruebas && npm run verify:rcv34`. Esperado: todo PASA (si algo de `pruebas/multiusuario/01-pwa-3.15.1` falla por los archivos nuevos del SHELL, actualizar su lista esperada).
- [ ] **Step 2:** `revisar.py --ancho 360` y `--ancho 390`: código 0.
- [ ] **Step 3:** Escribir el CHANGELOG en lenguaje del dueño y marcar los cambios hechos en la lista del cliente.
- [ ] **Step 4:** Commit `docs: 3.16.0 parte A (sin publicar)`.
- [ ] **Step 5:** Actualizar «Mis proyectos» (pendiente e11) y avisar al usuario: qué se hizo, cómo probarlo y que la Parte B (cambios 4 y 5) necesita su propio plan con migración de base.
