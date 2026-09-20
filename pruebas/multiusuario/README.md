# QA funcional propio del candidato multiusuario 3.13.0 (FASE 4E-C3 · correcciones 4E-C3-FIX1 y FIX2)

Pruebas **locales, offline y sin producción** del runtime `taller-demo/` del candidato multiusuario 3.13.0.
No usan red, ni Supabase real, ni Render, ni WhatsApp, ni cuentas ni datos reales. **No modifican el runtime.**

```bash
# desde la raiz del repositorio (Node >= 20; sin npm install, sin dependencias)
node --test pruebas/multiusuario/*.test.mjs
node --test --test-reporter=spec pruebas/multiusuario/04-app-multiusuario.test.mjs   # un archivo
```

`08-build-mecanicos.test.mjs` ejecuta `hacer-build-mecanicos.sh` (necesita `bash` y `sed` de GNU) **solo en un directorio
temporal** de `os.tmpdir()` que se borra al terminar, y comprueba que `taller-demo/` queda byte a byte igual.

> **Estado esperado hoy (tras 4E-C9): 1051 pruebas · 1051 pasan · 0 FALLAN · 0 omitidas (135 suites, 26 archivos).** `24` (17) arranca el **bundle compilado** `api-server/dist/index.mjs` como proceso real
> (`node --enable-source-maps ./dist/index.mjs`, entorno sintético) contra un Supabase falso y ejerce `POST /api/admin/usuarios/:id/enlace` por la red; `23` pasa a 23 (+5) y verifica también los 10 archivos de `dist/`.
> Estado anterior (tras 4E-C7-FIX-B): 1029 pruebas · 1029 pasan · 0 FALLAN · 0 omitidas (131 suites, 25 archivos). `21` (56) prueba el **api-server real**
> (`POST /api/admin/usuarios/:id/enlace`, recuperación mediada por el administrador) contra un Supabase falso; `22` (10) el recorrido completo y la ayuda del login; `23` (18) el manifest del backend y su
> verificador; `05` (+29) y `06` (+8) amplían «Generar enlace» y el texto de recovery. Estado anterior (tras 4E-C7-FIX-A): 899 pruebas · 899 pasan · 0 FALLAN · 0 omitidas (108 suites). Las 815 de 4E-C5.1 siguen presentes; `18`–`20` (84 pruebas) cubren OBS-7
> (chip del usuario, CSS real + mutantes), OBS-8 (formulario «Nuevo usuario» antes de la lista) y OBS-10 («Buscar actualización ahora» no destructivo: ACTIVE, WAITING, INSTALLING, OFFLINE, sin SW, «Ahora no»,
> «Solo crear copia», «Crear copia y actualizar», con espías sobre unregister / caches.delete / activar-ya / recarga y mutantes). Estado anterior (tras 4E-C5.1): 815 pruebas · 815 pasan · 0 FALLAN. Los tres hallazgos de C3 estan **CERRADOS**
> (`09`–`12`), 4E-C4-FIX cerro ademas OBS-3, OBS-4, OBS-5 y el rol desconocido, y fijo el alcance honesto de 3.13.0 (`13`–`16`), y 4E-C5.1
> retiro del simulador de conexion los tres textos heredados que sugerian sincronizacion (`17`).
> No hay pruebas omitidas (`skipped 0`, `todo 0`). Las 607 pruebas anteriores siguen presentes: las que caracterizaban el comportamiento
> ANTERIOR (portero que admitia roles desconocidos, «eliminar cita» abierta al cajero, «[object Object]», 200 no-JSON como exito, panel 3.12.0,
> «lo que tienes asignado») se CONVIRTIERON a la afirmacion nueva; ninguna se borro ni se salto.

> **QA en navegador real:** `pruebas/multiusuario/browser/` ejecuta el runtime real en **Chrome y Firefox** (headless, perfil temporal, red cerrada):
> `node pruebas/multiusuario/browser/browser-runner.mjs` (≈ 7 min; **274 casos** en la ultima corrida (tras 4E-C7-FIX-B), 137 por motor, 0 fallos en ambos; antes 252 / 126). Ver `browser/README.md`.
> No forma parte de `node --test pruebas/multiusuario/*.test.mjs`.

## Como funciona (y hasta donde llega)

| Pieza | Que es |
|---|---|
| `helpers/entorno.mjs` | Carga los **scripts reales** (`build-target`, `supabase-client`, `auth`, `recovery`, `app`, `usuarios`) en un contexto `node:vm`, con reloj falso, `localStorage` en memoria y `fetch` = servidor sintetico. La opcion `mutar` altera un script **en memoria** (nunca en disco) para las pruebas de mutacion. |
| `helpers/dom.mjs` | DOM **sintetico**, no un navegador. Registra cada asignacion a `innerHTML` (`doc.sumideros`) y distingue `textContent` (texto) de `innerHTML` (marcado). `marcadoPeligroso()` detecta etiquetas/manejadores que ninguna plantilla legitima lleva. **Detecta marcado inyectado, no ejecuta JS.** |
| `helpers/supabase-mock.mjs` | Servidor sintetico que **falla cerrado**: solo admite `synthetic-test.supabase.co` y `api.synthetic.test`; cualquier otro host o ruta imprevista queda registrado y revienta. Nunca guarda contraseñas ni tokens en su registro (solo categoria y longitud). Cuentas: `*@example.test`, UUID `0000…-000N`, JWT con firma invalida. |
| `helpers/flujos.mjs` | Atajos de escenario (`nuevoEntorno`, `enviarLogin`, `como`, `dbFalsa`, `toasts`). |
| `helpers/pwa.mjs` | Verificador estatico de version/cache + ejecucion real de `sw.js` en `vm`. |
| `helpers/ts-a-js.mjs` | TypeScript → JavaScript **sin dependencias**: quita los TIPOS del subconjunto que usa `admin-usuarios.ts` y **falla cerrado** ante sintaxis que no reconoce (no es un compilador ni comprueba tipos). Validado contra esbuild: mismas respuestas. |
| `helpers/backend-admin-usuarios.mjs` | Ejecuta el **api-server real** (`api-server/src/routes/admin-usuarios.ts`) sin red y sin `npm install`: `express`, `@supabase/supabase-js`, `ws` y el logger son **falsos**, en un directorio temporal que se borra; cada escenario importa una copia nueva del módulo. |
| `verificar-backend-manifest.mjs` | Verificador **determinista** de `release-3.13.0-backend-manifest.json` (`api-server/` no lo cubre el manifest del frontend): `MATCH N archivos` o `MANIFEST_MISMATCH <archivo>`. |
| `helpers/idb-falsa.mjs` | IndexedDB en memoria **minima** (add/put/get/getAll/openCursor). No modela versiones, indices ni cuota. |

Tecnica de honestidad: casi cada garantia de seguridad tiene una **prueba de mutacion**: se quita en memoria la linea que la
sostiene y la prueba debe romperse. Si un mutante sobreviviera, se ajusta la propiedad o se declara el hueco (≈ 90 pruebas de
mutacion/verificacion; los mutantes «equivalentes» descubiertos —p. ej. el portero como segunda barrera— se documentan en la propiedad).

## Archivos

| Archivo | Cubre | Pruebas |
|---|---|---:|
| `01-pwa-3.13.0.test.mjs` | Version/cache 3.13.0 coherentes (VERSION_APP, CACHE_NAME, `?v=`, SHELL), politica de actualizacion del SW ejecutado, mutantes | 28 |
| `02-build-target.test.mjs` | `build-target.js`: taller vs Mi Trabajo, defaults, valores invalidos, login local | 27 |
| `03-auth.test.mjs` | `auth.js` + `supabase-client.js`: sesion, perfil, RCV-35 en el cliente, rol desconocido, errores, offline, eventos | 62 |
| `04-app-multiusuario.test.mjs` | Portero (`sesionAdmitida`), separacion de productos, vistas por rol, guardas, `updateOrder`, login Supabase, arranque con sesion guardada, caida de sesion | 109 |
| `04b-app-mutantes.test.mjs` | Mutantes sobre `app.js`/`auth.js` (portero, `updateOrder`, vistas, login local, ownership, atribucion por uuid…) | 31 |
| `04c-app-regresion-comun.test.mjs` | Funciones nuevas/cambiadas fuera del portero: login local TEAM, identidad, produccion, UI del mecanico, ventas/creditos, citas | 61 |
| `05-usuarios.test.mjs` | `usuarios.js` (lado cliente): gating de admin, token, tabla, acciones, alta sin contraseña, XSS, mutantes | 58 |
| `06-recovery.test.mjs` | `recovery.js` + arranque: tipos de enlace, un solo uso, contraseña suelta, URL limpia, XSS, mutantes | 60 |
| `07-panel-tecnico.test.mjs` | `panel-tecnico.html` (script en linea real): sin sumideros, respuestas hostiles/malformadas, sesion, mutantes | 30 |
| `08-build-mecanicos.test.mjs` | `hacer-build-mecanicos.sh` en `/tmp`: contenido, SW del build, guardas del script, verificador con mutantes | 38 |
| `09-hallazgos.test.mjs` | Pruebas **originales de C3** de F-SEC-2 y F-FUNC-1, ahora **CERRADOS** (verdes) + contrastes + verificacion de que la prueba sigue mordiendo si se quita el arreglo | 7 |
| `10-fsec1-mensajes-error.test.mjs` | **F-SEC-1 CERRADO**: el error del api-server no llega como marcado al toast (6 payloads × 3 caminos, estructura exacta del sumidero), no regresion de mensajes, paridad toast/caja, guarda estatica y mutantes | 20 |
| `11-fsec2-rol-en-ajustes.test.mjs` | **F-SEC-2 CERRADO**: el rol de la sesion no llega como marcado a `#ajustesInfo` (estructura exacta del sumidero, comillas/ampersand, arreglo JSON, claves heredadas), roles normales con HTML **identico** al de antes, cadena `enti_session` → `startApp` → Ajustes, guarda estatica y mutantes | 20 |
| `12-ffunc1-establecer-clave.test.mjs` | **F-FUNC-1 CERRADO**: contrato de `Auth.establecerClave` por escenario (exito, 401/403, HTTP 400–503, red caida, timeout, rechazos de fetch, sin red), respuestas malformadas, pantalla real de `recovery.js`, boton en vuelo/restaurado, contraseña sin fugas, reintento manual y mutantes (restaurar la clasificacion anterior rompe SOLO las pruebas de red) | 56 |
| `13-obs3-eliminar-cita.test.mjs` | **OBS-3 CERRADO**: eliminar una cita es SOLO del administrador (admin permitido; cajero, mecanico, desarrollador, rol desconocido y sin sesion denegados; las demas guardas de gestion intactas), guarda estatica y mutantes | 18 |
| `14-obs4-obs5-respuestas.test.mjs` | **OBS-4 y OBS-5 CERRADOS**: un 200 que no trae un usuario (HTML, texto, vacio, null, arreglo, escalar, truncado) se rechaza como «respuesta-invalida»; el mensaje de error es la primera CADENA de message/msg/error_description/error (nunca «[object Object]»), en `supabase-client.js` y en `usuarios.js`; mutantes | 66 |
| `15-rol-desconocido-portero.test.mjs` | **ROL DESCONOCIDO CERRADO**: el portero del taller tiene lista blanca [admin, cajero, mecanico local]; Mi Trabajo solo mecanico con cuenta; formas raras del rol; login, sesion guardada y startApp; roles validos sin regresion; mutantes | 86 |
| `16-alcance-honesto.test.mjs` | **Alcance de 3.13.0**: Mi Trabajo (nota visible, subtitulo, listas vacias, manifest, build en /tmp) no promete trabajo asignado; copy de «Usuarios y equipo»; `apiUrl` sin rellenar; README y CHANGELOG (version, enlaces existentes, cifras de versionado, limitaciones) | 23 |
| `17-copy-sin-sincronizacion.test.mjs` | **La interfaz NO afirma sincronizacion operativa** (4E-C5.1): chip inicial «En línea · datos locales», avisos del boton «Simular sin conexión» («…procesando cambios locales…» / «Cambios guardados localmente») con el runtime real (misma logica y temporizacion), unica mencion visible = la nota honesta de Mi Trabajo, unica cadena de codigo restante = rama inalcanzable de `HAY_SERVIDOR = true`; build de Mi Trabajo en /tmp; mutantes | 12 |

## Hallazgos

| Id | Severidad | Donde | Flujo | Prueba |
|---|---|---|---|---|
| **F-SEC-1 — CERRADO en 4E-C3-FIX1** | Media (sumidero confirmado; explotacion requeria texto controlado en un error del api-server) | `usuarios.js` → `app.js:899` | `aviso(quitarHtml(textoDeFallo(r)))`: `textoDeFallo` **escapa** el mensaje del servidor, `quitarHtml` lo **des-escapa** (`d.innerHTML = s; return d.textContent`) y `toast()` lo asigna a `innerHTML`. Con `<img src=x onerror=alert(1)>` o `"'><svg onload=alert(1)>` el marcado renacia (en un navegador real ejecutan JS). **Correccion (solo `usuarios.js`):** `aviso()` escapa UNA vez justo antes de entregar a `toast()`, los tres caminos reciben texto plano (`textoPlanoDeFallo`) y `quitarHtml` se elimino; `toast()`/`app.js` no se tocaron. | `10` (regresion + mutantes) |
| **F-SEC-2 — CERRADO en 4E-C3-FIX2** | Baja (latente; endurecimiento) | `app.js:6002` (`renderAjustes`) | `${NOMBRE_ROL[rol] \|\| currentUser.rol \|\| "—"}` iba **sin `esc()`**. Con sesion de servidor el rol esta acotado por `perfiles_rol_check` (4 valores), asi que solo era alcanzable con una `enti_session` manipulada en el dispositivo (el portero del taller admite roles desconocidos). **Correccion (solo `app.js`, 1 linea):** la expresion del rol va dentro de `esc(...)`, igual que ya iba el nombre; los cuatro roles conocidos producen el mismo HTML de antes, un rol desconocido inocuo se sigue mostrando literal y no se restringen valores. | `09`, `11` |
| **F-FUNC-1 — CERRADO en 4E-C3-FIX2** | Baja (UX; sin impacto de seguridad) | `auth.js` `Auth.establecerClave` ↔ `recovery.js:192` | `establecerClave` solo distinguia `sin-permiso`; todo lo demas —**incluidos** `sin-conexion` y `tiempo-agotado`, que `supabase-client.js` si clasifica— salia como `rechazada-por-el-servidor` con el texto crudo del navegador, asi que la rama de red de `recovery.js` era **codigo muerto**: sin red se veia «Failed to fetch». **Correccion (solo `auth.js`, +5 lineas):** `sin-conexion` y `tiempo-agotado` se conservan con su motivo (como ya hacia `entrarEnRecuperacion`); 401/403 → `enlace-caducado` y el resto de HTTP → `rechazada-por-el-servidor` **sin cambios**; `recovery.js` no se toco. | `09`, `12` |

Observaciones (comportamiento **caracterizado** por pruebas que pasan; no son fallos):

* **OBS-4 — CERRADO en 4E-C4-FIX** (`14`) `Auth.establecerClave` ya no toma por exito un HTTP 200 sin usuario: exige un objeto (no null, no arreglo) o responde «respuesta-invalida».
* **OBS-5 — CERRADO en 4E-C4-FIX** (`14`) los errores con objeto anidado ya no se muestran como «[object Object]»: se usa la primera cadena de message, msg, error_description o error, o un mensaje generico.
* **H-1** `usuarios.js` concatena `"/" + dataset.id` sin `encodeURIComponent`; un id con `../` cambiaria de endpoint. El id lo genera Postgres (UUID) y llega del propio api-server: no es alcanzable desde entrada de usuario.
* **OBS-3 — CERRADO en 4E-C4-FIX** (`13`) eliminar una cita es solo del administrador (antes `exigeGestion` dejaba pasar tambien al cajero).
* **PANEL_VERSION — CERRADO en 4E-C4-FIX** (`07`) `panel-tecnico.html` muestra 3.13.0 (COSMETIC_VERSION_ONLY: literal fijo que ninguna logica lee).
* **GAP-PROD-1 — KNOWN_LIMITATION de 3.13.0** `TEAM` es una lista estatica **sin `perfilId`**: el admin no puede asignar trabajo a una **cuenta** de mecanico. 3.13.0 ya no lo promete (Mi Trabajo dice que es acceso para mecanicos y que la asignacion llegara despues; `16`). No esta cerrado.
* **GAP-PROD-2 — KNOWN_LIMITATION de 3.13.0** Ningun archivo del runtime lee ni escribe tablas de negocio en Supabase (solo `perfiles`): los datos operativos son locales a cada dispositivo y no hay sincronizacion. Documentado en README y CHANGELOG. No esta cerrado.
* **Diseño offline-first** (caracterizado, no es defecto): una sesion guardada de origen supabase arranca **sin re-validar** si no hay token, el token caduco o el servidor responde 5xx/sin red; solo `cuenta-desactivada`/`sin-perfil`/`sin-permiso` la descartan. El portero del taller admite roles desconocidos y no mira `activo` (lo cubre `Auth` aguas arriba); un perfil sin campo `activo` cuenta como activo (solo `=== false` es baja); un rol desconocido cae en el fallback de vistas operativas (nunca ve las de administrador).

## Funciones cambiadas por los commits multiusuario (vs `4ef632a`)

Diferencia a nivel de funcion de nivel superior: **28 nuevas, 24 modificadas, 0 eliminadas** (182 → 210 funciones). Tambien cambian constantes
(`VERSION_APP`, `VISTAS_*`, `AVANCE_MECANICO`, `NOMBRE_ROL`…) y se añaden `auth.js`, `supabase-client.js`, `usuarios.js`, `recovery.js`, `panel-tecnico.html`, `build-mecanicos/`.

| Estado | Funciones | Probadas en |
|---|---|---|
| Nuevas — portero/sesion | `sesionAdmitida`, `denegarSesion`, `entrarConSesion`, `arrancarConSesion`, `sesionDesdePerfil`, `pareceCorreo`, `pintarModoLogin`, `nombreBaseParaSesion`, `global_RecuperarClave` | 04, 04c, 06 |
| Nuevas — roles/guardas | `esAdmin`, `esCajero`, `tieneIdentidadMecanico`, `esMecanicoCuenta`, `puedeGestionarTaller`, `puedeAsignarMecanico`, `bloquear`, `exigeGestion`, `esTrabajoPropio`, `puedeEditarTecnico`, `vistasOcultasParaSesion`, `vistaInicial`, `puedeVerVista` | 04, 04c |
| Nuevas — Mi Trabajo | `renderMiTrabajo`, `etiquetaEtapa`, `bloquearCamposSiEntregada`, `identidadMecanico`, `asignacionDesdeSelect`, `asignacionDelUsuarioActual` | 04, 04c |
| Modificadas — probadas | `openDb`/`startApp`, `updateOrder`, `showView`, `wireLoginGate`, `poblarSelectMecanico`, `openClienteDetalle`, `aplicarPermisosPorRol`, `renderAjustes`, `registrarVentaRapida`, `registrarCredito`, `calcularProduccion`, `renderWidgetRow`, `openOrder`, `renderDetalleMecanico`, `updateActionBar`, `renderStageTracker`, `renderStageContent` (ramas del mecanico), `continuarArranque`, `renderCitasList` (guardas de los botones) | 04, 04c, 09 |
| Modificadas — **NO probadas directamente** | `abrirOrdenDesdeCita`, `abrirModalMoverCita`, `abrirModalEditarCita`, `refreshCitaClienteSelect`. Su cambio se reduce a llamar a `poblarSelectMecanico(id, nombre, perfilId)` (que **si** esta probada, incluida su rama por uuid) en lugar de armar el `<select>` con `TEAM.map`; el resto de cada modal (DOM y flujos de citas) no se ejercita | — (GAP acotado) |

## Inventario de testabilidad (seccion B)

| Clase | Que |
|---|---|
| `TESTABLE_NODE_VM` | `app.js` (portero, roles, guardas, login, arranque, Mi Trabajo, ordenes, ventas, creditos, citas), `auth.js`, `supabase-client.js`, `usuarios.js`, `recovery.js`, `build-target.js`, `<script>` de `panel-tecnico.html`, `sw.js` (`ejecutarServiceWorker`) |
| `TESTABLE_STATIC` | `index.html` (`?v=`), `sw.js` (CACHE_NAME/SHELL), `manifest.json`, `_headers`, coherencia de versiones |
| `TEMP_BUILD` | `hacer-build-mecanicos.sh` (solo en directorio temporal) |
| `REQUIRES_REAL_BROWSER` | render/CSS/responsive, IndexedDB real (upgrade, cuota), Service Worker real (instalacion, control, `clients.claim`, recarga), instalabilidad PWA, **ejecucion real** de XSS, teclado/foco/doble envio por Enter, portapapeles y `location` reales, eventos `online/offline` reales, varias pestañas |
| Fuera de alcance | api-server (`/api/admin/usuarios`), Supabase Auth/PostgREST/RLS reales (el SQL se cubrio en fases anteriores), publicacion/CDN (Render/Netlify) |

En este equipo hay Google Chrome 153 y Firefox 155 instalados y caches de Playwright/Puppeteer, pero **no** los modulos npm; C3 solo los inspecciona (no se instala ni se lanza nada).

## Tabla de GAPS (seccion V)

| Area | ¿Probada? | Metodo | GAP |
|---|---|---|---|
| Auth cliente (sesion, perfil, RCV-35 lado cliente) | Si | `vm` + Supabase sintetico + mutantes | Servidor real; comparacion estricta `=== false`; copia local con `activo:false` aceptada sin red |
| Portero taller / Mi Trabajo | Si | 04, 04b, 15 | Lista blanca de roles (rol desconocido y desarrollador se rechazan); el taller no mira `activo` (lo cubre Auth aguas arriba); arranque con token caducado no re-valida |
| Vistas, guardas, `updateOrder` | Si | 04, 04b, 04c, 13 | El fallback operativo para roles desconocidos sigue en `vistasOcultasParaSesion`, pero el portero ya no deja llegar a ninguno |
| `usuarios.js` | Si (cliente) | 05 | **Backend api-server no probado**; H-1 |
| Recuperacion de contraseña | Si | 06, 12, 14 | Doble envio por Enter no reproducible sin navegador (la proteccion es el boton deshabilitado, probada) |
| Panel tecnico | Si | 07 | Politica real de los RPC (SQL) |
| Build de Mi Trabajo | Si | 08 (temporal) | Publicacion/CDN real |
| PWA 3.13.0 (version/cache/SW) | Si | 01, 08 | SW real en navegador (instalacion/actualizacion) |
| Separacion de productos / target | Si | 02, 04, 04c | GAP-PROD-1, GAP-PROD-2 |
| XSS / DOM | **Parcial** | Detecta marcado inyectado (no ejecucion) | F-SEC-1 cerrado (barrido completo de `usuarios.js` en 4E-C3-FIX1); F-SEC-2 cerrado (`currentUser.rol`, 4E-C3-FIX2); barrido de sumideros limitado a codigo nuevo/cambiado + `usuarios`/`recovery`/`auth`/panel; **codigo comun preexistente no auditado en su totalidad** (p. ej. `toast()` con nombres locales, `detalleFotos` en `app.js:2158`) |
| UI de citas (modales) | Parcial | Guardas de los botones de `renderCitasList` | Cuatro funciones sin prueba directa; su cambio es solo la llamada a `poblarSelectMecanico` (probada) |
| Aspecto visual / responsive | No | — | Requiere revision visual manual (el QA de `browser/` es headless y funcional) |
| IndexedDB real | Si (parcial) | `browser/`: la app abre y usa su base real en Chrome y Firefox | Upgrade de versiones antiguas y cuota |
| WhatsApp real | No | Excluido por diseño | — |
| Varias pestañas / dispositivos | No | — | Requiere navegador real |

## Reglas

* Datos **sinteticos**: correos `*@example.test`, UUID `00000000-0000-4000-8000-00000000000N`, contraseñas `clave-sintetica-*`, JWT con firma invalida. Nada real.
* Si una funcion no se puede probar en serio sin navegador real, se documenta el GAP; **nunca** se fabrica un PASS.
* Estas pruebas **no verifican produccion**. No sustituyen la QA en navegador real ni las pruebas del backend.
* No se modifica `pruebas/package.json` ni el runtime; el diff de `taller-demo/` sigue siendo solo el versionado 3.13.0.

## Backend (api-server): qué se prueba y qué no

`21-backend-enlace-recuperacion` ejecuta `admin-usuarios.ts` REAL (convertido de TS a JS por `helpers/ts-a-js.mjs`) con Supabase, Express y el logger **falsos**: cubre la autorización, el destino por rol,
que el cuerpo/correo/rol/redirect del cliente se ignoran, los rechazos (propio admin, inactivo, inexistente…), los fallos de Supabase y que ningún secreto aparezca en respuestas ni registros, con pruebas de mutación.
`23-backend-manifest` prueba el manifest del backend y su verificador sobre una **copia temporal alterada** (nunca los archivos reales); desde 4E-C9 su grupo `generated_build_artifacts` cubre los 10 archivos de `api-server/dist/` (artefacto generado y versionado).
`24-backend-dist-enlace` ejecuta el **artefacto compilado** (`api-server/dist/index.mjs`, lo que arranca `pnpm start`) como proceso real, con un entorno mínimo y sintético y un Supabase falso local por HTTP: comprueba `node --check` de los 5 módulos, que la ruta está
en el bundle, la autorización, el destino por rol, que correo/rol/redirect/query del cliente se ignoran, los rechazos, los fallos de `generateLink` y que ningún secreto sale en respuestas ni registros. Falla contra un `dist/` anterior a la ruta (10 de sus 17 casos).

**No prueban:** Supabase/Auth reales, el envío de correo (no existe) ni **Render** (su Build Command, su Start Command y su versión de Node no están en el repositorio: hay que confirmarlos en el panel antes de desplegar). Los **tipos** de TypeScript no los
comprueba ninguna prueba (el api-server no tiene `node_modules` en el árbol); en 4E-C7-FIX-B se comprobaron con `tsc --noEmit` sobre una copia temporal: 0 errores nuevos.
