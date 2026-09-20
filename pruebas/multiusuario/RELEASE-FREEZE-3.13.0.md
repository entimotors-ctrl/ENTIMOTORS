# RELEASE FREEZE · ENTIMOTORS OS 3.13.0 (release candidate)

> **HOTFIX PRE-TAG 4E-C11 (`apiUrl`).** El Taller publicado con los bytes de `8eea52c…` mostró «Falta indicar la dirección del servidor» en «Usuarios y equipo» porque `supabase-config.js` llevaba `apiUrl: ""`. La corrección, su causa y por qué el QA no la vio están en «Recongelado 4E-C9 → 4E-C11» más abajo. **No hay etiqueta `v3.13.0`; 3.13.0 no se declara estable hasta el QA manual de producción sobre el commit del hotfix.**

**Estado:** CONGELADO TÉCNICAMENTE · **QA AUTOMÁTICO: PASS** · **QA VISUAL FINAL: PASS** (`MANUAL_VISUAL_RECHECK_FINAL`: PASS; OBS-7, OBS-8, OBS-9 y OBS-10 **CLOSED + MANUAL PASS**; OBS-6 **BACKLOG**; 0 hallazgos visuales bloqueantes) · **BACKEND BUILD: PASS** · **DIST POLICY: VERSIONED** · **RENDER BUILD COMMAND: NEEDS MANUAL CONFIRMATION** (hace falta antes del deploy, no del commit) · **RELEASE STATUS: `READY_FOR_COMMIT`** · **NO PUBLICADO** · sin commit.
Fecha del freeze: 19 de septiembre de 2026 (fase 4E-C5); **recongelado en la fase 4E-C5.1** (limpieza de los tres textos heredados de sincronización) **otra vez en la fase 4E-C7-FIX-A** (19 de septiembre de 2026: correcciones post-QA OBS-7, OBS-8 y OBS-10) **en la fase 4E-C7-FIX-B** (OBS-9: recuperación de contraseña mediada por el administrador, que toca también el backend) y **en la fase 4E-C9** (cierre del QA visual manual, build oficial del backend y regeneración de `api-server/dist/`; sin cambios en el runtime del frontend ni en `api-server/src/`). Este documento y los **dos** manifests son los definitivos: el del frontend y, aparte, el del backend.

| | |
|---|---|
| Versión | **3.13.0** (`VERSION_APP`), caché `entimotors-v3.13.0`; Mi Trabajo `entimotors-mitrabajo-v3.13.0` |
| Rama | `release/multiuser-3.13.0` |
| Commit base | `544d1bea177f1c5eb1175f4ffcf390f932c9d19d` (el candidato es el árbol de trabajo sobre ese commit) |
| Manifest del **frontend** | [`release-3.13.0-manifest.json`](release-3.13.0-manifest.json): ruta, SHA-256 y tamaño de cada archivo de `taller-demo/`, documentación, pruebas y scripts SQL; referencia al del backend |
| Manifest del **backend** | [`release-3.13.0-backend-manifest.json`](release-3.13.0-backend-manifest.json): lo mismo para `api-server/` (la ruta modificada y sus dependencias directas), sus pruebas y —desde 4E-C9— los 10 archivos compilados de `api-server/dist/` (grupo `generated_build_artifacts`); se verifica con `node pruebas/multiusuario/verificar-backend-manifest.mjs` |

## Alcance oficial

**3.13.0 = identidad + acceso + roles multiusuario:** cuentas (Supabase Auth), roles (administrador, cajero, mecánico,
desarrollador), administración de usuarios, producto separado «ENTIMOTORS Mi Trabajo», acceso de mecánicos, recuperación de
cuenta, `activo=false` que falla cerrado, PWA 3.13.0 con actualización controlada.

**NO incluye:** asignación real de trabajo a cuentas de mecánico · transporte de órdenes o citas hacia Mi Trabajo ·
sincronización entre dispositivos · datos operativos compartidos por Supabase. Los datos del taller siguen siendo locales
(IndexedDB) a cada dispositivo. README, CHANGELOG, la pantalla de Mi Trabajo y su manifest lo dicen expresamente.

## QA automatizado (resultado del freeze)

| Batería | Resultado |
|---|---|
| Node (`node --test pruebas/multiusuario/*.test.mjs`) | **1051 / 1051** · fail 0 · skipped 0 · 135 suites · 26 archivos (1029 de 4E-C7-FIX-B + 22 de 4E-C9: `24` = 17 y `23` +5; **96 de backend**: `21` = 56, `23` = 23, `24` = 17) |
| Chrome 153.0.8010.36 (headless, perfil temporal, red cerrada) | **137 / 137** (app 81 · mt 33 · mut 9 · pwa-taller 6 · pwa-mt 6 · pwa-upg 2); repetido en 4E-C9 antes de regenerar `dist/` (el runtime del frontend no cambió) |
| Firefox 155.0.1 (ídem) | **137 / 137** (ídem) |
| Navegador: errores de aplicación · peticiones externas inesperadas | 0 · 0 (0 peticiones externas de la página) |
| Navegador: integridad del runtime servido vs. disco | 32 / 32 idénticos |
| PWA REAL (Chrome, Service Worker y CacheStorage reales, entorno QA 4813: activo sin novedad, offline, waiting 3.12.2 → 3.13.0, «Ahora no», «Solo crear copia», «Crear copia y actualizar») | **12 / 12** en C7-FIX-A y **otra vez 12 / 12 tras C7-FIX-B** (sin regresión); offline: la app sigue abriendo sin red tras pulsar el botón. En 4E-C9, las suites `pwa-taller`, `pwa-mt` y `pwa-upg` de Chrome y Firefox (Service Worker y CacheStorage reales): **14 / 14** por motor |
| Backend (`api-server/`): tipos con `tsc --noEmit` en copia temporal | 0 errores nuevos (2 preexistentes del tipado de `ws`, idénticos a la base); conversor de pruebas validado contra esbuild (16 escenarios idénticos) |
| **Build oficial del backend** (`pnpm install --frozen-lockfile` y `pnpm run build` en `api-server/`) | **PASS** (salida 0; esbuild 0.27.7, pnpm 10.34.3, Node 20.20.1; un aviso ya presente de `tsconfig.json`); `package.json`, lockfile, `pnpm-workspace.yaml` y `build.mjs` intactos; `node_modules` no queda en el árbol |
| **`api-server/dist/` regenerado** | 6 de 10 archivos modificados (`index.mjs` y su mapa con la ruta nueva; `pino-file`/`pino-worker` y sus mapas, solo la ruta de compilación); `node --check` de los 5 módulos OK; **el `dist/` de HEAD se reconstruye byte a byte** (10/10, normalizando la ruta) y el nuevo sale idéntico compilando en dos directorios |
| **Bundle compilado arrancado como proceso real** (`24-backend-dist-enlace`) | **17 / 17** contra un Supabase falso local (autorización, destino por rol, entradas del cliente ignoradas, rechazos, fallos de `generateLink`, sin fugas); contra el `dist/` anterior (sin la ruta) **fallan 10 de 17** |
| Las pruebas nuevas DETECTAN el defecto | contra el runtime/backend anterior a C7-FIX-B: **86 fallos** en Node y **11 / 11** casos OBS-9 de Chrome fallan, sin que falle ningún otro |
| Source/security (`npm run verify:rcv34`, en `pruebas/`) | REV8 **77/77** · coverage **72/72** · coverage real **PASS** |
| SHA-256 del source-sync (sin cambios) | `6530b27cb7d339338a78a3300b4e62d6c73d23c33aa7e53b1d64ceeddb63ab73` |
| Escaneo de secretos y de referencias a producción | PASS (0 secretos reales; la clave `anon` pública de `supabase-config.js` no cambió; 0 referencias al proyecto real fuera de ese archivo). Re-escaneo en C7-FIX-B sobre 22 archivos tocados: 0 JWT, 0 `sb_secret_`, 0 host de producción, 0 enlaces reales persistidos; `service_role` solo como mención en texto. Re-escaneo en 4E-C9 sobre 65 archivos cambiados o nuevos y los 10 de `dist/` (comparado con HEAD): 0 JWT, 0 `sb_secret_`, 0 host de producción, 0 enlaces reales, **0 coincidencias nuevas en `dist/`**; la única ruta de usuario nueva es la de compilación de `dist/` (no es un secreto) |
| Build de Mi Trabajo en `/tmp` | PASS (3.13.0, caché propia, sin promesa de asignación, 0 residuos 3.12.x) |

## Correcciones incluidas

| Id | Dónde | Qué |
|---|---|---|
| F-SEC-1 | `usuarios.js` | El texto de error del api-server ya no llega como HTML a los avisos. |
| F-SEC-2 | `app.js` | El rol de la sesión se escapa en Ajustes. |
| F-FUNC-1 | `auth.js` | Fallo de red o tiempo agotado se muestra como «Sin conexión…», no como rechazo del servidor. |
| OBS-3 | `app.js` | Eliminar una cita es solo del administrador. |
| OBS-4 | `auth.js` | Un 200 que no trae un usuario ya no cuenta como éxito al poner la contraseña. |
| OBS-5 | `supabase-client.js`, `usuarios.js` | Mensaje de error = primera cadena (message, msg, error_description, error); nunca «[object Object]». |
| UNKNOWN ROLE | `app.js` | El portero del taller usa lista blanca (admin, cajero, mecánico local); un rol desconocido falla cerrado. |
| Copy del simulador de conexión (4E-C5.1) | `index.html`, `app.js` | Solo tres cadenas visibles: chip inicial «En línea · sincronizado» → «En línea · datos locales»; aviso «Conexión restaurada — sincronizando cambios pendientes» → «Conexión restaurada — procesando cambios locales…»; aviso «Todo sincronizado» → «Cambios guardados localmente». Sin cambio de lógica, condiciones ni temporizadores. |
| OBS-7 (4E-C7-FIX-A) | `index.html` (solo CSS) | Chip del usuario del topbar: compacto (radio y padding chicos, `line-height` 1.25), tope de ancho `14rem` con elipsis en escritorio; en móvil se conserva el nombre completo, en varias líneas. |
| OBS-8 (4E-C7-FIX-A) | `usuarios.js` | «+ Nuevo usuario»: la tarjeta del formulario (y el recuadro del enlace generado) se pinta ANTES de la lista de «Equipo», no después. Mismos ids, handlers, `display:none` inicial, textos, roles y POST/PATCH. |
| OBS-10 (4E-C7-FIX-A) | `app.js` (+ 1 línea de copy en `index.html`) | «Buscar actualización ahora» ya NO desregistra el Service Worker, ni borra cachés, ni recarga: solo comprueba (`registration.update()`, con `waiting`/`installing` y plazo de 20 s). Si hay versión nueva abre el MISMO aviso (copia y actualizar / solo copia / ahora no); sin red o sin Service Worker avisa sin destruir nada. Solo «Crear copia y actualizar» envía «activar-ya». |
| OBS-9 (4E-C7-FIX-B) | `api-server/src/routes/admin-usuarios.ts`, `usuarios.js`, `index.html`, `recovery.js` | **Recuperación de contraseña mediada por el administrador**: «Usuarios y equipo» → «Generar enlace» → copiar → pasárselo a la persona; ella lo abre y `recovery.js` la deja elegir contraseña. Ruta nueva `POST /api/admin/usuarios/:id/enlace` (reutiliza la generación del alta; el servidor decide el destino por rol; ignora todo lo que mande el cliente; solo personas activas que no son administrador). Ayuda en el login. `recovery.js` distingue `recovery` de `invite`. No hay correo, ni SMTP, ni ruta pública. |
| Build del backend (4E-C9) | `api-server/dist/` | `dist/` regenerado con el build oficial (`pnpm run build`): el bundle que arranca `pnpm start` ya trae `POST /api/admin/usuarios/:id/enlace`. Sin cambios en `api-server/src/` ni en el runtime del frontend. |
| Copy / versión | `index.html`, `build-mecanicos/manifest.json`, `panel-tecnico.html`, `sw.js` | Mi Trabajo no promete trabajo asignado (nota visible), texto de «Usuarios y equipo» preciso, panel muestra 3.13.0, versión y caché 3.13.0. |

## Limitaciones conocidas aceptadas para 3.13.0

1. **GAP-PROD-1:** no hay asignación real administrador → cuenta de mecánico (el selector «Mecánico asignado» usa la lista local `TEAM`).
2. **GAP-PROD-2:** no hay sincronización entre dispositivos.
3. **MULTI-TAB:** cerrar sesión en una pestaña no actualiza visualmente otra abierta de inmediato (el servidor sí revalida cada acción de administración).
5. **ADMIN-SIN-AUTOSERVICIO (OBS-9):** la cuenta administradora **no** se recupera desde la aplicación (ni «Generar enlace» se le ofrece, ni el servidor lo acepta): se recupera desde el panel de Supabase (Authentication → Users → *Reset password*). No hay recuperación por correo ni autoservicio: la persona le pide el enlace al administrador. Procedimiento en el README.
4. **TOPBAR-ANGOSTO (OBS-7, residual):** en escritorio con la ventana de ~1000 px o menos, un nombre de cuenta de más de ~30 letras (el api-server admite 60) sigue desbordando la barra superior por unos px; con nombres normales y a partir de ~1100 px no pasa. En móvil no aplica (el nombre completo va en el panel de cuenta).

**Observación residual — CORREGIDA en 4E-C5.1:** la interfaz ya no afirma sincronización operativa. El chip de conexión, el botón «Simular sin conexión» y sus avisos
dicen solo lo que pasa (datos guardados en este dispositivo). La única mención visible de «sincroniz…» es la nota honesta de Mi Trabajo («…estará disponible en una versión
posterior»). Queda una única cadena de código con «sincronizado» (`renderSyncChip()`, rama de `HAY_SERVIDOR = true`): es **inalcanzable** hoy (`const HAY_SERVIDOR = false` y
retorno previo) y una prueba (`17-copy-sin-sincronizacion`) obliga a revisarla si alguien activa esa bandera.

## Recongelado 4E-C5 → 4E-C5.1

Cambiaron solo dos archivos del runtime (tres cadenas visibles) y los archivos de prueba/documentación de `pruebas/multiusuario/**` (test `17`, suite `COPY` del navegador, READMEs).

| Archivo | SHA-256 anterior (4E-C5) | SHA-256 definitivo (4E-C5.1) |
|---|---|---|
| `taller-demo/app.js` | `a27699eb6bd27b363b9a6f7b49738977cca38be5c33b8d3f8420b28193e23be3` | `d99ddfc98ab5ea7d94695939cafec776c0d7bfebd9542a45a2d80b550c99cfbd` |
| `taller-demo/index.html` | `8a0b50b1364cb3b03f0d3c7d29f3228541e8120d26cc831927ab2876275ea976` | `45d4ea9575b330cc17a8426abd7fe9d0629d1b5777937d43280aa4ae24440bea` |

El manifest de 4E-C5 (`da0c2f60…8edc`) y su freeze doc (`de203098…39c3`) quedan **obsoletos**; los vigentes son los que comprueba el comando de abajo.

## Recongelado 4E-C5.1 → 4E-C7-FIX-A

Cambiaron tres archivos del runtime (uno por hallazgo) y los archivos de prueba/documentación de `pruebas/multiusuario/**` (tests `18`–`20`, `browser/helpers/suite-c7fixa.js`, `suite-app.js`, READMEs). **No cambió la versión** (`VERSION_APP` 3.13.0; cachés `entimotors-v3.13.0` y `entimotors-mitrabajo-v3.13.0`; 0 residuos 3.12.x): el candidato no está publicado. `sw.js`, `auth.js`, `recovery.js`, `supabase-client.js`, `panel-tecnico.html` y el resto del runtime son byte a byte los de 4E-C5.1.

| Archivo | Alcance | SHA-256 anterior (4E-C5.1) | SHA-256 definitivo (4E-C7-FIX-A) |
|---|---|---|---|
| `taller-demo/index.html` | OBS-7 (solo CSS) + **una línea de copy** de OBS-10 (la nota bajo el botón decía «borra la copia guardada y vuelve a bajar todo de cero»; autorizada expresamente por el usuario como excepción a «index.html: OBS-7 solo») | `45d4ea9575b330cc17a8426abd7fe9d0629d1b5777937d43280aa4ae24440bea` | `633f2e136dc47ef9c8a3d60bafd4c42b0742cf639a7a81c028b97f997d7be392` |
| `taller-demo/usuarios.js` | OBS-8 (solo orden de las cadenas de `render()` + `margin-bottom`) | `1406b7aca972fe874bb596c3d8fc4baa67644ac883ed7ad094cd3a787519552a` | `74877ddbdd5b53b5841ac339607ec27a5f5bc7ebf6ca52b7e79fa4050ba68b41` |
| `taller-demo/app.js` | OBS-10 (handler de `btnForzarActualizacion` + `abrirAvisoVersionNueva({ forzar })`) | `d99ddfc98ab5ea7d94695939cafec776c0d7bfebd9542a45a2d80b550c99cfbd` | `67349b918c1ee0f8070532819876b6bc35efb2096d980fadafd1cdc2c073b121` |

El manifest de 4E-C5.1 (`bc33301c…5ae6`) y su freeze doc (`1f862827…0749`) quedan **obsoletos**; los vigentes son los que comprueba el comando de abajo.

**Estado de los hallazgos del QA visual manual (C6):**

| Id | Estado | Nota |
|---|---|---|
| OBS-7 · chip «Admin Activo» apretado | **CERRADO** | Medido en Chrome y Firefox (escritorio 1280 y móvil 390); ver la limitación TOPBAR-ANGOSTO. |
| OBS-8 · «Nuevo usuario» abajo | **CERRADO** | Formulario y enlace a la vista en 1280×900, 1024×640 y 390×844 con 7 personas en el equipo. |
| OBS-10 · «Buscar actualización ahora» | **CERRADO** | Probado con Service Worker falso (Node y navegador) y con el REAL (entorno 4813). El defecto adicional medido en C7A —sin red el botón dejaba la app sin caché— ya no ocurre. |
| OBS-9 · sin «¿Olvidaste tu contraseña?» | **PENDIENTE — PLAN B** (recuperación mediada por el administrador; fase C7-FIX-B) | Fuera de esta fase. |
| OBS-6 · «Falla reportada» de solo lectura | **BACKLOG** (`UX_IMPROVEMENT`) | Decisión de producto: no se modifica. |

**QA visual manual:** PASS con hallazgos corregidos parcialmente (0 bloqueadores críticos). Tras C7-FIX-A no hubo una nueva revisión visual humana de OBS-7/8/10: la verificación fue automática, en navegador real (Chrome y Firefox) y con el Service Worker real.

## Recongelado 4E-C7-FIX-A → 4E-C7-FIX-B

Cambiaron **tres archivos del runtime del frontend**, **uno del backend** (`api-server/`, que el manifest del frontend no cubre) y los archivos de prueba/documentación. **No cambió la versión** (`VERSION_APP` 3.13.0; cachés `entimotors-v3.13.0` y `entimotors-mitrabajo-v3.13.0`; 0 residuos 3.12.x): el candidato no está publicado. `app.js`, `sw.js`, `auth.js`, `supabase-client.js` y el resto del runtime son byte a byte los de 4E-C7-FIX-A.

| Archivo | Alcance | SHA-256 anterior (C7-FIX-A) | SHA-256 definitivo (C7-FIX-B) |
|---|---|---|---|
| `api-server/src/routes/admin-usuarios.ts` | OBS-9 backend: helper `generarEnlaceDeRecuperacion` (compartido con el alta) + ruta `POST /admin/usuarios/:id/enlace` | `13e2300219f751af6a1f5944fd15685401c2e49a5c0db9338208ac1f6b31a597` | `98921e771f367ce6728fadc1767d552f0684b1004f8695d5d8bb18f3cb02b957` |
| `taller-demo/usuarios.js` | OBS-9 interfaz: botón «Generar enlace», confirmación, caja de resultado (nodos DOM, sin `innerHTML` con datos del servidor), copiar sin alterar, limpieza del enlace | `74877ddbdd5b53b5841ac339607ec27a5f5bc7ebf6ca52b7e79fa4050ba68b41` | `c60286306ffe492452ce458be45086902a74523c7619789119069ec348ff5553` |
| `taller-demo/index.html` | OBS-9: ayuda del login («¿Olvidaste tu contraseña? Pide al administrador…») y texto neutro de partida de «Establecer contraseña» (`id="rcvIntro"`) | `633f2e136dc47ef9c8a3d60bafd4c42b0742cf639a7a81c028b97f997d7be392` | `3024a4d8548e9ee59da6ad69964cf0080d23dd5d49aab384f3380b26dfd26f77` |
| `taller-demo/recovery.js` | OBS-9 copy: `recovery` → «Elige tu contraseña…», `invite` → «Has sido invitado…» (la lógica de seguridad no cambió) | `d65efc884e074f705bd6d038e890ba62885f841da4a0fe333cfe4cf002b7988b` | `ea74ae97d4c282bebc9e0e3372c3c4d233db6ef06f12df43a2b7cb145218beef` |

El manifest y el freeze doc de 4E-C7-FIX-A (`85e60ef1…2650` y `b38f8609…106c`) quedan **obsoletos**; los vigentes son los que comprueban los comandos de abajo. El manifest del backend tiene SHA-256 `e9d05b97170cdcf6aaa03e90d607b08757ee15d63c7d256ca1a61b4b42f2b774` y el del frontend lo referencia (`backend_manifest`).

**Estado de los hallazgos del QA visual manual (C6):**

| Id | Estado | Nota |
|---|---|---|
| OBS-6 · «Falla reportada» de solo lectura | **BACKLOG** (`UX_IMPROVEMENT`) | Decisión de producto: no se modifica. |
| OBS-7 · chip «Admin Activo» apretado | **CERRADO** (C7-FIX-A) | Ver la limitación TOPBAR-ANGOSTO. |
| OBS-8 · «Nuevo usuario» abajo | **CERRADO** (C7-FIX-A) | |
| OBS-9 · sin «¿Olvidaste tu contraseña?» | **CERRADO** (C7-FIX-B, plan B) | Recuperación mediada por el administrador; la cuenta administradora se recupera desde el panel de Supabase. |
| OBS-10 · «Buscar actualización ahora» | **CERRADO** (C7-FIX-A) | |

**Entonces quedaba pendiente `MANUAL_VISUAL_RECHECK_FINAL`** (ni C7-FIX-A ni C7-FIX-B tuvieron una revisión visual humana posterior; la verificación fue automática). **Resuelto en 4E-C9: PASS** (ver la sección siguiente).

## Recongelado 4E-C7-FIX-B → 4E-C9

Fase de cierre: **QA visual manual final registrado**, **build oficial del backend** y **`api-server/dist/` regenerado**. **No cambió ningún archivo del runtime del frontend** (los 22 de `runtime_files` son byte a byte los de 4E-C7-FIX-B; `VERSION_APP` sigue en 3.13.0, cachés `entimotors-v3.13.0` y `entimotors-mitrabajo-v3.13.0`) **ni `api-server/src/`** (`admin-usuarios.ts` sigue siendo `98921e77…b957`). El candidato no está publicado.

### QA visual manual final — PASS

Registrado según lo confirmado por la persona que hizo la revisión humana (entorno QA local con datos sintéticos, fase C8). El repositorio no puede verificar ese resultado: lo registra.

| Id | Estado final |
|---|---|
| OBS-6 · «Falla reportada» de solo lectura | **BACKLOG** (`UX_IMPROVEMENT`); decisión de producto: no se modifica |
| OBS-7 · chip «Admin Activo» apretado | **CLOSED + MANUAL PASS** (ver la limitación TOPBAR-ANGOSTO) |
| OBS-8 · «Nuevo usuario» abajo | **CLOSED + MANUAL PASS** |
| OBS-9 · sin «¿Olvidaste tu contraseña?» | **CLOSED + MANUAL PASS** (plan B: recuperación mediada por el administrador) |
| OBS-10 · «Buscar actualización ahora» | **CLOSED + MANUAL PASS** |

`MANUAL_VISUAL_RECHECK_FINAL`: **PASS** · QA visual final: **PASS** · sin hallazgos visuales bloqueantes.

### Política de `api-server/dist/` · VERSIONED

**Decisión, con la evidencia del repositorio** (no por suposición): `dist/` es un **artefacto generado (`GENERATED_BUILD_ARTIFACT`) que este repositorio versiona**, y para esta release se regenera con el build oficial.

1. **Está versionado y es lo que arranca `start`:** 10 archivos en `HEAD`; `"start": "node --enable-source-maps ./dist/index.mjs"` y `"build": "node ./build.mjs"` (esbuild).
2. **El flujo histórico lo commitea junto con el fuente:** 6 de los 7 últimos commits que cambian `api-server/src/` también cambian `dist/` (`4d56c64`, `501f1d6`, `f8bfb8d`, `6a3337f`, `b016dbc`, `efd9cbb`); la excepción es `66ed64d` («chore: preserve multiuser auth implementation»).
3. **Es reproducible:** reconstruido desde el `src/` de `HEAD` con el lockfile, el `dist/` versionado sale **byte a byte idéntico** (10/10) salvo la ruta absoluta de compilación (ver abajo).
4. **Indicio de que Render compila, sin configuración que lo pruebe:** el mensaje del commit `ac5ceb8` (2026-09-11) dice que Render instala pnpm con `npm install -g pnpm` y que el build de producción moría con `ERR_PNPM_IGNORED_BUILDS` por el script de instalación de esbuild («sin él no hay dist»). Es un mensaje de commit: **no es configuración versionada ni prueba el Build Command exacto**.

Con el `dist/` regenerado el despliegue es correcto **en los dos casos**: si Render compila, sobrescribe estos archivos; si solo ejecutara `start`, ejecuta este `dist/`, que ya trae la ruta (lo prueba `24-backend-dist-enlace` arrancando el bundle real).

**Ruta absoluta embebida.** `esbuild-plugin-pino` incrusta la ruta absoluta del directorio `dist/` donde se compila (`<raíz del repositorio>/api-server/dist`) en `index.mjs`, `pino-file.mjs`, `pino-worker.mjs` y sus mapas: por eso esos 6 archivos cambian cuando cambia el directorio de compilación. **No es un secreto ni un host.** Con `NODE_ENV=production` pino no usa `transport` y esa ruta no se lee; en desarrollo, `pnpm dev` recompila antes de arrancar. Para comparar dos compilaciones hechas en directorios distintos hay que normalizar esa cadena.

**Cómo se generó** (en el propio `api-server/`, sin tocar `package.json` ni el lockfile; el gestor del proyecto es pnpm): `pnpm install --frozen-lockfile` y `pnpm run build`; después se borró el `node_modules` que la instalación creó (ignorado por Git). Para repetirlo: los mismos dos comandos y `node pruebas/multiusuario/verificar-backend-manifest.mjs --regenerar`.

### Qué cambió

| Archivo | Alcance | SHA-256 anterior (HEAD) | SHA-256 definitivo (4E-C9) |
|---|---|---|---|
| `api-server/dist/index.mjs` | regenerado: trae `POST /admin/usuarios/:id/enlace` (3 bloques del módulo `admin-usuarios`) y la ruta de compilación | `b972239d3df2c9c07864c197712cf6c7974746ba48ae0f7c28ab620cc705d6b2` | `17562fbad9f2afef51bf39159cfcba9443aee6b8e14585a0afd7948f1833169c` |
| `api-server/dist/index.mjs.map` | regenerado (mapa del anterior) | `423e6f4ec725fbe1bc288240767d0fed64fa5730c2af7e3d1a1963cf7a683d35` | `54d50e67280c0a787abec37d46c4577e35d331b7efc79de1258f1b83ed3c7ef8` |
| `api-server/dist/pino-file.mjs` | solo la ruta absoluta de compilación | `b920e3b4db82277e1ef235821f9277ef55313c7960c2dd543f667ce29c9b9bb4` | `bf31ab01323cc0659d4f9ba5c6e8616cef088f9d2f1198463153105a16d2cd7b` |
| `api-server/dist/pino-file.mjs.map` | solo la ruta absoluta de compilación | `00d419d239592067b040e74c4dd44276170968c3942fe7685f590e3ce998c189` | `ee2cf49dc3c693ea899aa6dd49b27b858c616f22d51a96760130210325d76c7f` |
| `api-server/dist/pino-worker.mjs` | solo la ruta absoluta de compilación | `a5da9cbb68e25c6721afdbe14ff889bafde2112d85a7f00341ee98dccd77e76d` | `47544f3c5b391f58bd37735de2cef81c561783b561fbd00dce9fa560a8eaa4c4` |
| `api-server/dist/pino-worker.mjs.map` | solo la ruta absoluta de compilación | `fe085866637846689b96d62e49fafcada046309538f7b528291fcf0241bd3372` | `5a9763ecbf3940bf55c32b14524809e57784be4042d0c9bad4bcc2f0ab6b2a25` |

Sin cambios: `pino-pretty.mjs`, `thread-stream-worker.mjs` y sus mapas. Además cambiaron solo archivos de pruebas y documentación: `24-backend-dist-enlace.test.mjs` (nuevo), `23-backend-manifest.test.mjs`, `verificar-backend-manifest.mjs` (grupo `generated_build_artifacts`), el `README.md` de pruebas, los dos manifests y este documento.

El manifest del frontend de 4E-C7-FIX-B (`95dede13…3c13`), el del backend (`7974cc1f…013b`) y su freeze doc (`b21c05ba…fdc6`) quedan **obsoletos**; los vigentes son los que comprueban los comandos de abajo. El manifest del backend tiene SHA-256 `e9d05b97170cdcf6aaa03e90d607b08757ee15d63c7d256ca1a61b4b42f2b774` y el del frontend lo referencia (`backend_manifest`). *(4E-C11: aquí quedó sin sustituir el marcador `@@SHA_BACKEND@@`; se pone el valor real, que no cambió.)*

### Requisitos de despliegue del backend (no ejecutados)

- **Render — `RENDER_BUILD_COMMAND_NEEDS_MANUAL_CONFIRMATION`.** No hay `render.yaml`, `Dockerfile`, `Procfile`, `.node-version`, `.nvmrc` ni `engines` en el repositorio: **el Build Command y el Start Command reales no se pueden probar desde aquí**. Antes de desplegar hay que confirmar en el panel de Render: Root Directory (`api-server/`), Build Command (debe compilar con `pnpm install` y `pnpm run build`, o bien dejar que se ejecute el `dist/` versionado), Start Command (`pnpm start`, es decir `node --enable-source-maps ./dist/index.mjs`) y la versión de Node (20 o superior). Esto bloquea el **deploy**, no el commit.
- Variables en el api-server: `ENTIMOTORS_ADMIN_ORIGIN` y `ENTIMOTORS_MECHANIC_ORIGIN` (`https://…`, sin `/index.html`) y `SUPABASE_ANON_KEY`, además de las de siempre.
- Las direcciones de vuelta de **ambos** productos en Supabase → Authentication → URL Configuration → Redirect URLs (ya necesarias para el alta), y `apiUrl` en `supabase-config.js` apuntando al api-server desplegado. **Este último paso NO se ejecutó al publicar el Taller y por eso hubo que hacer el hotfix 4E-C11**: ahora el archivo versionado ya lleva el backend de producción y `verificar-config-produccion.mjs` lo comprueba antes de publicar.

## Recongelado 4E-C9 → 4E-C11 (HOTFIX PRE-TAG: `apiUrl` del Taller)

**Estado:** hotfix aplicado sobre `8eea52c30e25a1678c63b70d012a8af212255460` como commit NUEVO (sin `--amend`). Versión, cachés, `sw.js` y todo el JavaScript de la aplicación **sin cambios** (3.13.0, `entimotors-v3.13.0`). **NO existe la etiqueta `v3.13.0`** y 3.13.0 **no** se declara estable hasta el QA manual de producción sobre el commit del hotfix. El manifest del frontend de 4E-C9 (`b8162b88…2621`) y su freeze doc (`a8c473ad…3689`) quedan **obsoletos**; el del backend (`e9d05b97…f2b774`) **no cambió**.

**Qué pasó.** En el QA manual del Taller publicado (repo `entimotors-ctrl/entimotors-os`, commit `0a215a1`, con los bytes de `8eea52c`) el administrador entraba bien, pero «Usuarios y equipo» mostraba «Falta indicar la dirección del servidor. Se configura en supabase-config.js, campo apiUrl».

**Causa — `DEPLOYMENT_CONFIGURATION_GAP`.**
- `usuarios.js` (`baseApi()`) lee `window.ENTIMOTORS_SUPABASE.apiUrl`, le recorta las barras finales y llama a `apiUrl + "/api/admin/usuarios" + ruta`. Con `apiUrl` vacío pinta ese aviso.
- `taller-demo/supabase-config.js` llevaba `apiUrl: ""` **a propósito** (la prueba `16` lo exigía; el README, el CHANGELOG y este freeze lo trataban como requisito de despliegue). Es el **mismo archivo, byte a byte** (`9db2483e…`, 1465 bytes) en 3.12.3, en el source `8eea52c`, en el repo del Taller (`f7f7eec` y `0a215a1`), en la URL pública del Taller y en el Mi Trabajo publicado. No cambió con 3.13.0: hasta 3.12.3 no existía la pantalla que lo usa.
- «ENTIMOTORS OS — Demo local» es solo el `<title>` estático de `index.html` (idéntico en 3.12.3): **no** tiene relación con `apiUrl`.
- El paso «`apiUrl` apuntando al api-server desplegado» figuraba en «Requisitos de despliegue (no ejecutados)» y **no se ejecutó al publicar**: la publicación copió los bytes del commit tal cual.

**Por qué el QA no lo detectó.**
1. Las suites Node inyectan un `apiUrl` **sintético** (`helpers/entorno.mjs`, `URL_API`); ninguna leía el `supabase-config.js` real salvo para comprobar que su clave es `anon`.
2. El servidor del navegador (`browser/server.mjs`) **sustituye** `supabase-config.js` por una configuración sintética que sí trae `apiUrl` (la suite de integridad lo declara: «solo `index.html` y `supabase-config.js` se sustituyen en memoria»).
3. La prueba `16` **fijaba lo contrario**: `apiUrl` vacío y sin URL de producción.
4. El entorno de QA visual local (fuera del repo) servía una configuración propia apuntando a un backend local, según consta en el registro del proyecto; ese directorio temporal ya no existe y no se pudo volver a inspeccionar.
5. El primer punto donde se leyó el archivo real fue el QA manual sobre el sitio ya publicado.

**Qué cambió (mínimo).**
- `taller-demo/supabase-config.js`: `apiUrl: "https://entimotors-1.onrender.com"` (URL pública, solo el origen, sin barra final; el código la tolera pero no la exige) y su comentario. **Nada más** en el archivo: `url`, `anonKey` y `habilitado` idénticos.
- `pruebas/multiusuario/verificar-config-produccion.mjs` (nuevo): única fuente de verdad de «config de producción válida»; CLI `node pruebas/multiusuario/verificar-config-produccion.mjs [archivo-o-URL]` (salida 0/1, nunca imprime la clave anon). Es la puerta del paso de publicación: se corre sobre el archivo a subir y sobre la URL ya publicada.
- `pruebas/multiusuario/25-config-produccion-apiurl.test.mjs` (nuevo, 30 pruebas): mira el archivo **real**, 17 mutantes que el verificador debe detectar, el CLI, la pantalla real con ese `apiUrl` (sin el aviso; pide a `<backend>/api/admin/usuarios`), el control con `apiUrl` vacío, cajero y mecánico rechazados, y que el build de Mi Trabajo lleva la misma configuración. **Contra `8eea52c` FALLA (7 casos) y el CLI da salida 1 con `APIURL_AUSENTE`**: habría bloqueado la publicación.
- `pruebas/multiusuario/16-alcance-honesto.test.mjs`: la prueba que exigía `apiUrl` vacío ahora exige la URL de producción y la ausencia de secretos.
- Documentación: `README.md`, `CHANGELOG.md`, el README de pruebas y este documento; y se sustituyó el marcador `@@SHA_BACKEND@@` que había quedado sin resolver por el valor real (sin cambio).

**Sin cambios.** `index.html`, `sw.js`, `app.js`, `usuarios.js`, `auth.js`, `recovery.js`, `supabase-client.js`, `build-target.js`, todo `api-server/` (fuente y `dist/`), Supabase (esquema, RLS, SQL) y el manifest del backend.

**Mi Trabajo.** Comparte `supabase-config.js`: el publicado (deploy de Netlify del 19 de septiembre, 23:01) sigue con `apiUrl` vacío. Es inocuo: un mecánico no abre «Usuarios y equipo» (rechazo «solo para el administrador», sin llamadas) y no se republica por esto; cualquier reconstrucción futura del bundle ya lo lleva relleno (lo comprueba la prueba `25`).

**Resultados tras el hotfix.**

| Batería | Resultado |
|---|---|
| Node (`node --test pruebas/multiusuario/*.test.mjs`) | **1081 / 1081** · fail 0 · cancelled 0 · skipped 0 · 140 suites · 27 archivos (1051 anteriores + 30 de `25`) |
| Chrome 153.0.8010.36 (headless, perfil temporal, red cerrada) | **137 / 137** (app 81 · mt 33 · mut 9 · pwa-taller 6 · pwa-mt 6 · pwa-upg 2) |
| Firefox 155.0.1 (ídem) | **137 / 137** (ídem) |
| Navegador: peticiones externas inesperadas · de la página | 0 · 0 |
| Backend (`verificar-backend-manifest.mjs`) | MATCH 23/23 (sin cambios) |
| Secret scan de los archivos del hotfix | PASS: la única clave que aparece es la `anon` pública ya existente (`role=anon`) |

*El runner del navegador exige que el `sw.js` de `HEAD` sea el 3.12.2 (lo lee con `git show HEAD:…` como versión anterior); tras el commit de release ya no lo es, así que esta ejecución se hizo en una copia temporal fuera del repo con un `HEAD` propio con ese `sw.js` y el árbol del hotfix en disco, sin modificar el repositorio.*

## Lo que NO se hizo

Source-sync **no ejecutado** · producción **no modificada** · Supabase remoto y SQL **no consultados** · **ningún enlace, token o cuenta reales** (todo sintético) · **no se envía ni existe envío de correo** · **Render no consultado** (su configuración no está en el repositorio) · `api-server/dist/` **regenerado en 4E-C9, sin desplegar** · sin `git add`, commit, push ni deploy · repo B
(`entimotors-os`, 3.12.2 estable) y checkout principal intactos.

## Cómo comprobar que el candidato sigue siendo este

Desde la raíz del repositorio (debe imprimir `MATCH` y salir con 0; si algo cambió, imprime `MANIFEST_MISMATCH <archivo>`):

```bash
node -e 'const fs=require("fs"),c=require("crypto");const m=JSON.parse(fs.readFileSync("pruebas/multiusuario/release-3.13.0-manifest.json"));let mal=0,n=0;for(const k of ["runtime_files","documentation_files","test_files","database_scripts_unchanged"])for(const f of m[k]){n++;const b=fs.readFileSync(f.path);if(c.createHash("sha256").update(b).digest("hex")!==f.sha256||b.length!==f.bytes){mal++;console.log("MANIFEST_MISMATCH",f.path)}}const d=m.freeze_document,b=fs.readFileSync(d.path);if(c.createHash("sha256").update(b).digest("hex")!==d.sha256){mal++;console.log("MANIFEST_MISMATCH",d.path)}const bm=m.backend_manifest,bx=fs.readFileSync(bm.path);if(c.createHash("sha256").update(bx).digest("hex")!==bm.sha256||bx.length!==bm.bytes){mal++;console.log("MANIFEST_MISMATCH",bm.path)}console.log(mal?"FAIL":"MATCH",n+2,"archivos");process.exit(mal?1:0)'
```

Y el del **backend** (`api-server/`), aparte (debe imprimir `MATCH N archivos` y salir con 0; si algo cambió, `MANIFEST_MISMATCH <archivo>`):

```bash
node pruebas/multiusuario/verificar-backend-manifest.mjs
```

El primer comando ya comprueba también que el manifest del backend es el que el del frontend referencia (`backend_manifest`); el segundo comprueba cada archivo de `api-server/` listado, sus pruebas y los 10 archivos compilados de `api-server/dist/`.

## Checklist de QA visual manual (EJECUTADO: resultado consolidado PASS)

Lo ejecutó una persona sobre una copia local con datos sintéticos (nunca producción): revisión completa en C6 y revisión final de OBS-7, OBS-8, OBS-9 y OBS-10 en C8. El resultado consolidado es **PASS**; este documento **no marca casilla por casilla** porque el detalle por punto lo tiene quien hizo la revisión. Se conserva la lista como referencia de lo que se revisó.

1. **Login Taller** — [ ] PASS  [ ] FAIL
   Correo y contraseña de administrador y de cajero; mensaje claro con una cuenta de mecánico («debe ingresar desde Mi Trabajo») y con una dada de baja.
2. **Login Mi Trabajo** — [ ] PASS  [ ] FAIL
   Mecánico activo entra; administrador/cajero se rechazan con mensaje legible; no hay login local.
3. **Inicio** — [ ] PASS  [ ] FAIL
   Página principal sin errores ni vistas rotas tras entrar.
4. **Menús por rol** — [ ] PASS  [ ] FAIL
   Administrador, cajero y mecánico local ven solo lo que corresponde; el chip de conexión dice «Solo en este dispositivo · respalda seguido» (nunca «sincronizado»); «Simular sin conexión» muestra «Modo sin conexión activado» → «Conexión restaurada — procesando cambios locales…» → «Cambios guardados localmente».
5. **Usuarios** — [ ] PASS  [ ] FAIL
   Lista, alta con enlace de un solo uso, cambio de rol, baja/reactivar y edición. Con el `apiUrl` de producción **no** debe salir «Falta indicar la dirección del servidor» (ese aviso es lo que apareció en el Taller publicado con `apiUrl` vacío y motivó el hotfix 4E-C11). *Este checklist se ejecutó en local con un `apiUrl` sintético; el paso equivalente sobre el Taller PUBLICADO es el QA manual de producción.*
6. **Ajustes** — [ ] PASS  [ ] FAIL
   Usuario y rol correctos; respaldo y restauración; versión 3.13.0.
7. **Recuperación de contraseña** — [ ] PASS  [ ] FAIL
   Formulario, sin conexión, enlace caducado, contraseña establecida; el botón se restaura y el campo se vacía.
8. **Mi Trabajo vacío + mensaje de limitación** — [ ] PASS  [ ] FAIL
   Se ve «Acceso para mecánicos.» y la nota de que la asignación y la sincronización llegarán en una versión posterior; nada dice «asignado».
9. **Panel técnico + responsive** — [ ] PASS  [ ] FAIL
   Panel con sesión de desarrollador (3.13.0 visible); taller y Mi Trabajo en móvil y escritorio, sin desbordes, y el menú de cuenta/estado de conexión legible.
10. **Actualización PWA 3.12.2 → 3.13.0** — [ ] PASS  [ ] FAIL
    Con 3.12.2 instalada, aparece el aviso de versión nueva, se ofrece la copia de seguridad, «actualizar» activa 3.13.0 y desaparece la caché `entimotors-v3.12.2`.

**Después:** con el QA visual final en PASS, el candidato queda `READY_FOR_COMMIT` (los archivos de los dos manifests). El **deploy** sigue pendiente de la confirmación manual del Build Command de Render (ver «Requisitos de despliegue del backend»).
