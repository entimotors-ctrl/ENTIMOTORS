# Pruebas de SYNC (3.14.0 → 3.15.0)

Todo corre contra un **Postgres local** (contenedor `entimotors-sync-pg`, 127.0.0.1:54432, misma imagen y versión que producción). **Nunca toca producción.**
La contraseña `postgres` es la clave de desarrollo de la imagen: la base solo existe en esta máquina.

```bash
pruebas/sync/entorno-local.sh up      # recrea el contenedor y carga la base de referencia (= producción 2026-09-21)
pruebas/sync/correr-sql.sh 1          # SYNC-1: forward x2, pruebas, rollback seguro, ciclo forward/rollback/forward
pruebas/sync/entorno-local.sh down
```

## SYNC-4 · núcleo del cliente (`taller-demo/sync-db.js`, `sync-rest.js`, `sync-engine.js`) y Service Worker

```bash
node --test pruebas/sync/node/sync-cliente.test.mjs     # piezas puras: clasificación de errores, consultas, paginación, refresco 401, fusión 3 vías, esperas, guardas (sin Docker)
node --test pruebas/sync/node/sw-cache.test.mjs         # sw.js REAL en vm: el shell se cachea; Authorization, API, Supabase REST/Auth y Storage NO (sin Docker)
pruebas/sync/entorno-local.sh up                        # una vez (necesita Docker)
node --test pruebas/sync/browser/sync-core.test.mjs     # Chrome y Firefox REALES contra Postgres + PostgREST reales; SYNC_NAVEGADORES=chromium (o firefox) para uno solo
```

- La prueba de navegador levanta su propia pila (base `t_e2e` con SYNC-1..3P + PostgREST + un JWT con secreto sintético) y la borra al terminar. Cada «dispositivo» es un navegador con perfil temporal y origen propio.
- En equipos con poca RAM: **una suite a la vez** (Docker + navegadores en paralelo congelaron la máquina el 2026-09-21). `sync-core` tarda ≈ 70 s por navegador.

- `baseline/generar-baseline.mjs` genera la base de referencia **desde el catálogo real de producción** (`catalogo/entimotors-sync0-catalogo.sql`, resultado en CSV fuera del repo).
- `baseline/verificar-fidelidad.mjs` compara el esquema local con el CSV de producción (o con otra base local: `db:NOMBRE`). El rollback de cada fase debe devolver un esquema **idéntico** al de referencia.
- Las fases SQL se ejecutan sobre **copias aisladas** de la base de referencia; cada fase aplica su forward dos veces (idempotencia) y su rollback.
- Las migraciones están en `taller-demo/supabase/sync/` (forward + rollback). Pasan el guard REV8 (`cd pruebas && npm run verify:rcv34`: el `package.json` de los guardas está en `pruebas/`).

## 3.15.0 · Bloque 1A · cotización ↔ inventario + conversión atómica (`taller-demo/supabase/sync/sync-15a-cotizacion-inventario.sql`)

```bash
pruebas/sync/correr-sql.sh 15a                                   # SQL: 36 pruebas + carreras reales (mismo op ×8, dos dispositivos, mutantes), caída a mitad, rollback idéntico
node --test pruebas/sync/node/b1a-cotizacion.test.mjs           # mapper real: el renglón conserva su repuesto al bajar y la orden resultante se resuelve
SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b1a-cotizacion-app-real.test.mjs   # app real A–L (y Firefox)
B1A_N=5 node --test pruebas/sync/browser/b1a-rendimiento.test.mjs   # medianas por paso; B1A_BASE=<árbol e807f65> mide 3.14.1
```
- La pila de navegador aplica ya la cadena de 3.15 (`15a` y `15b`); `iniciarPila({ excluir: FASES_315 })` vuelve a la de 3.14.1.
- `B1A_BASE=<carpeta con taller-demo/ de e807f65>` corre las mismas pruebas contra la app 3.14.1 (deben fallar: vínculo perdido, 2 órdenes con dos dispositivos).
- Desde el Bloque 2, aceptar = aprobar: la conversión descuenta los repuestos del negocio exactamente una vez (la prueba C/D/H/I lo verifica).

## 3.15.0 · Bloque 2 · presupuestos + inventario + stock (`taller-demo/supabase/sync/sync-15b-presupuestos-stock.sql`)

```bash
pruebas/sync/correr-sql.sh 15b                                   # SQL: modelo (tipos, aprobar/rechazar/reabrir, ajustes por diferencia, A→B, quitar, cobrar, anular),
                                                                 # compatibilidad 3.14.1 (#4 #6 #9 #10 ab4277b6 creados con las funciones viejas), carreras reales,
                                                                 # caída + reintento, defensas/mutantes en copia aparte, rollback idéntico y rollback que se niega con actividad
node --test pruebas/sync/node/b2-presupuestos.test.mjs          # constructores de la cola y mappers reales (tipo, precio vacío ≠ 0, estado solo del servidor)
SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b2-presupuestos-app-real.test.mjs   # app real A–AD (y Firefox)
B2_N=5 node --test pruebas/sync/browser/b2-rendimiento.test.mjs      # medianas por paso; B2_BASE=<árbol e807f65> mide 3.14.1
```
- `sync-15b-rollback.sql` se niega si ya hubo actividad 3.15 (renglones/movimientos/decisiones posteriores): forzar solo tras revisar
  el stock a mano, con el ajuste de sesión `sync.forzar_rollback = si` (en local `PGOPTIONS="-c sync.forzar_rollback=si"`; el pooler
  de Supabase ignora PGOPTIONS: ahí `psql -c "SET sync.forzar_rollback = 'si'" -f sync-15b-rollback.sql`, misma sesión).

## 3.15.0 · Bloque 3 · mensajes + avisos en tiempo real + fail closed del almacenamiento + día empresarial (`sync-15c-mensajes-realtime.sql`)

```bash
pruebas/sync/correr-sql.sh 15c                                   # SQL: mensajes (envío solo admin, RLS por destinatario, leído idempotente, inmutable), avisos
                                                                 # (asignación, reasignación A→B, dedupe por transacción, sin datos), políticas de canal con un
                                                                 # stub de realtime (dueño de producción; bloque aplicado como postgres), base SIN Realtime, rollback
node --test pruebas/sync/node/b3-fecha-negocio.test.mjs         # día empresarial America/Tegucigalpa (17:59/18:00/23:59/00:00/00:01, TZ del dispositivo ajena)
node --test pruebas/sync/node/b3-realtime-cliente.test.mjs      # sync-realtime.js con WebSocket falso + SyncDB.abrirSeguro con IndexedDB falso
node --experimental-websocket --test pruebas/sync/browser/b3-realtime-seguridad.test.mjs            # canales contra Realtime REAL (sin navegador)
SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b3-realtime-app-real.test.mjs      # app real + Realtime real: E–Z y latencias
SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b3-almacen-offline-app-real.test.mjs # base dañada/cerrada, offline completo, una vez
SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b3-fecha-app-real.test.mjs          # citas/caja/dashboard/filtros por hora local
B3_BASE=<árbol e807f65> SYNC_NAVEGADORES=chromium node --test pruebas/sync/browser/b3-rendimiento.test.mjs         # peticiones/CPU/bytes en reposo vs 3.14.1
```
- `iniciarPila({ realtime: true })` levanta además Supabase Realtime v2.106.0 (contenedor propio, 127.0.0.1) contra `t_e2e`; el gateway hace de Kong
  (`/realtime/v1/*` → `/socket/*`, Host del inquilino `realtime-dev`, `apikey` → JWT anónimo local). `pila.realtimeCaido(true|false)` corta y devuelve el servicio.
- `B3_BASE=<carpeta>` en `b3-fecha-app-real` corre lo mismo contra la app 3.14.1: debe FALLAR (movimiento de las 18:30 en el día siguiente, filtro «Hoy» corrido).
- `sync-15c-rollback.sql` se niega si hay mensajes; forzar con `sync.forzar_rollback = si` (igual que 15b). Va ANTES que el rollback de 15b.

## 3.15.0 · Bloques 4–7 (resumen de comandos)

```bash
pruebas/sync/correr-sql.sh 15d        # PIN del propietario + eliminar usuario (y 15e finanzas, 15f legado 3.13, 15g rendimiento RLS: correr-sql.sh 15e|15f|15g)
node --test pruebas/sync/node/        # todas las piezas puras (PIN, errores HTTP sin fugas, finanzas, legado, artefacto público, service worker)
SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b4-owner-pin-app-real.test.mjs   # PIN y eliminar usuario, app real
node --experimental-websocket --test --test-concurrency=1 pruebas/sync/gotrue/b4-eliminar-usuario.test.mjs         # con GoTrue real
SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b5-finanzas-app-real.test.mjs
SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b6-producto-app-real.test.mjs      # recorre TODAS las pantallas sobre los artefactos
node --test operacion/respaldo/pruebas/                                                                            # kit de respaldo (B01–B21)
node --test pruebas/multiusuario/                                                                                  # PWA, manifiestos, instalación (incluye 30-pwa-instalada-reabrir)
B7_COLA=1,10,100,500,1000 node --test --test-concurrency=1 pruebas/sync/browser/b7-sync.test.mjs                  # cola sin red → reconexión, exactamente una vez
node --test --test-concurrency=1 pruebas/sync/browser/b7-umbrales.test.mjs                                          # umbrales de rendimiento (incl. dashboard ≤ 300 ms @3 000)
```

## 3.15.0 · Bloque 8 · cierre técnico (release readiness)

```bash
node --test pruebas/sync/node/b8-sw-plazo.test.mjs                 # SW: red con plazo (4 s navegación / 8 s archivos), copia sin mezclar, nunca la caché de OTRA versión
node pruebas/sync/sql/b8-migraciones.mjs <salida>                   # 3.14.1 limpia → 15a…15g → diff de catálogo (RLS, dueños, definer, permisos) → invariantes → orden incorrecto
pruebas/sync/sql/b8-migraciones-snapshot.sh <dump pre-3.15> <salida> # lo mismo sobre un respaldo de producción, en contenedor SIN RED que se borra al terminar
node --test --test-concurrency=1 pruebas/sync/browser/b8-pwa-actualizacion.test.mjs   # 3.14.1 → 3.15.0 REAL (Taller y Mi Trabajo): en línea / sin red / cerrar y reabrir
node --test --test-concurrency=1 pruebas/sync/browser/b8-fotos-taller.test.mjs        # foto del mecánico → Taller en vivo (URL firmada), sin pisar la evidencia
node --test --test-concurrency=1 pruebas/sync/browser/b8-finanzas-iguales.test.mjs    # mismos números antes/después del Bloque 7 (B8_FIN_MUTANTE=1 = control que DEBE fallar)
node --test --test-concurrency=1 pruebas/sync/browser/b8-realtime-estres.test.mjs     # Realtime: 50 uniones, tokens de 2–15 s, caducidad, reconexión, cambio de usuario, 2 dispositivos
```
- `b8-pwa-actualizacion` necesita los candidatos de `ENTIMOTORS-3.15-bloque8/candidatos/preparar-candidatos.sh` (o `B8_CANDIDATOS=<carpeta>`):
  la 3.14.1 sale del commit e807f65 y la 3.15.0 es un build de STAGING (no publicado).
- Arnés (`lib/dispositivo.mjs`): `d.servir(raiz)` cambia lo publicado en el MISMO origen, `d.redApp(false)` corta los archivos de la app sin
  cortar el puente, `d.reabrir()` cierra y reabre el navegador con el mismo perfil. El puente lleva `apikey` (ningún service worker lo
  atiende) y solo responde desde una página visible.

## 3.15.0 · Checkpoint 8A y cierre del Bloque 8 (sesión, logout, crédito, Venta rápida, Realtime)

```bash
node --test pruebas/multiusuario/31b-b8a-sesion-contrato.test.mjs          # la sesión no se pierde por la red; solo un rechazo de Auth la cierra
node --test --test-concurrency=1 pruebas/sync/gotrue/b8a-sesion-gotrue.test.mjs   # lo mismo contra GoTrue REAL (dos dispositivos, ban, borrado)
node --test --test-concurrency=1 pruebas/sync/gotrue/b8-logout-gotrue.test.mjs    # L01–L12: «Cerrar sesión» = /auth/v1/logout?scope=local (solo este dispositivo)
node --test --test-concurrency=1 pruebas/sync/gotrue/b8a-gotrue-respuestas.test.mjs  # qué contesta GoTrue real en cada caso (base de la clasificación)
node --test --test-concurrency=1 pruebas/sync/browser/b8a-credito-ventarapida.test.mjs   # selector de cliente, duplicados, Venta rápida, CREDIT/QUICKSALE-01…06
node --test --test-concurrency=1 pruebas/sync/browser/b8-credito-lento.test.mjs   # crédito confirmado → UI → descargas en segundo plano (B8_RAIZ=<antes> mide ANTES)
B8A_VERSION=3.14.1 node --test --test-concurrency=1 pruebas/sync/browser/b8a-arranque-red.test.mjs   # STARTUP-01…06 (sin la variable: 3.15)
node --test --test-concurrency=1 pruebas/sync/browser/b8-realtime-activacion.test.mjs   # caso Y en la app: lo avisado en la ventana de activación llega igual
B8Y_CICLOS=4 B8Y_INTENTOS=8 node --experimental-websocket --test pruebas/sync/gotrue/b8-realtime-y.test.mjs   # investigación del caso Y SIN la app
```
- Las pruebas GoTrue de la pila (`b4-eliminar-usuario`, `b8a-*`, `b8-logout-gotrue`) levantan su propio GoTrue. SEC-1B/SEC-1D necesitan el
  laboratorio 4d: `cd ENTIMOTORS-4d-lab && supabase start`, exportar `SEC1B_*`/`SEC1D_*` desde `supabase status -o env`, y al terminar
  `supabase stop` (conserva los volúmenes). El kit de respaldo necesita `docker start entimotors-b5-origen` (sin eso, sus 13 pruebas se
  OMITEN y lo dicen).
- Regresión completa del Bloque 8: `ENTIMOTORS-3.15-bloque8/regresion/regresion-b8-final.sh` (levanta y vuelve a detener esos laboratorios;
  «0 pruebas» cuenta como FALLO).
