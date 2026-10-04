# ENTIMOTORS · Respaldo de negocio y restauración (3.15 · Bloque 5)

Herramientas de OPERACIÓN (no se publican con la app). Todo lo que tocan en el origen es de **solo lectura**; la restauración de
prueba ocurre **únicamente** en un contenedor PostgreSQL desechable y **sin red**.

| Archivo | Qué hace |
|---|---|
| `respaldar.sh` | Respaldo de negocio verificable: `pg_dump` (esquema completo, sin datos secretos) + usuarios saneados + Storage + fotos lógica y financiera + manifiesto sellado + escaneo de secretos |
| `restaurar-aislado.sh` | Verifica el respaldo y lo restaura en un contenedor nuevo `--network none`; compara negocio, finanzas y Storage con el origen. **No acepta destino** |
| `puerta-pre-release.sh` | Respaldo → verificación independiente → restauración aislada → PASS/FAIL. Cualquier fallo = `RELEASE BLOQUEADO` (código ≠ 0) |
| `respaldo.mjs` + `lib/respaldo.mjs` | Manifiesto, verificación de hashes, clasificación de formatos, Storage (inventario/descarga/verificación), escaneo de secretos, comparación de fotos |
| `sql/foto-negocio.sql`, `sql/foto-financiera.sql` | Fotos lógicas de solo lectura (`BEGIN READ ONLY`) que se comparan origen ↔ restaurada |
| `pruebas/respaldo.test.mjs` | B01–B21 contra un origen de laboratorio |

## 1. Respaldo de DATOS DEL NEGOCIO ≠ recuperación de INFRAESTRUCTURA

**Sí incluye (respaldo de negocio):**
- Todas las tablas de `public` con sus datos (órdenes, caja, créditos, abonos, ventas, inventario y su ledger, cotizaciones, citas,
  clientes, motos, mensajes, auditoría, reversos, perfiles, importaciones, `sync_ops`, autorizaciones consumidas…).
- El **esquema completo** (public, auth, storage, realtime… solo DDL) para poder restaurar en un PostgreSQL de Supabase vacío.
- Metadatos de Storage (`storage.buckets`, `storage.objects`) y los **archivos** de cada objeto, con su ruta, tamaño, MD5 (= eTag) y SHA-256.
- Directorio de usuarios **saneado** (`auth-usuarios.csv`): id, correo, confirmación, baneo, fechas, `raw_app_meta_data`.
  Sirve para que las FK `perfiles → auth.users` se restauren y para saber quién es quién.

**No incluye, a propósito (secretos o efímeros):** hashes de contraseñas, sesiones, refresh tokens, tokens de un solo uso, MFA/OAuth/SSO,
`vault.secrets`, colas (`net`, `cron`, `supabase_functions`), `realtime`, el **PIN del propietario** (hash) y sus contadores de intentos,
el **pepper** del PIN, llaves `service_role`/`anon`/JWT, la configuración de Auth (SMTP, URLs, proveedores) y las variables del api-server.
El escaneo de secretos (`PATRONES_SECRETOS`) revisa el SQL completo del volcado, el CSV y el manifiesto: un hallazgo = respaldo FALLIDO.

> El volcado completo que se hizo en el Bloque 0 (`pg_dump` de toda la base) **sí contiene** hashes de contraseñas, sesiones, refresh
> tokens, secretos OAuth y el vault (el escaneo lo demuestra). Es una copia de **infraestructura**: privada (carpeta 700, archivos 400),
> nunca se comparte ni se entrega.

**RECUPERACIÓN COMPLETA DE INFRAESTRUCTURA** (procedimiento aparte, no lo cubre este kit):
1. Proyecto Supabase: respaldos/PITR de la plataforma según el plan contratado; o un proyecto nuevo.
2. Auth: GoTrue **no permite importar sesiones** y las contraseñas no viajan en el respaldo de negocio. Tras restaurar datos en un
   proyecto nuevo, cada usuario entra con **«restablecer contraseña»** (enlace de recuperación que genera el administrador); los ids se
   conservan porque `auth-usuarios.csv` los trae. Si se restaura el proyecto completo desde la plataforma (PITR), Auth vuelve tal cual.
3. PIN del propietario: se **vuelve a configurar** en Ajustes → PIN del propietario (el hash no viaja).
4. api-server: variables (pepper del PIN, llaves) desde el gestor de secretos del operador; nunca desde un respaldo.
5. App (GitHub Pages): desde git (tag del release).

## 2. Manifiesto (`manifiesto.json` + `manifiesto.json.sha256`)
Formato `entimotors-respaldo-negocio` v1. Campos: versión de ENTIMOTORS, fecha/hora UTC y local (America/Tegucigalpa), origen (sin
host ni credenciales), versión de PostgreSQL y de `pg_dump`, fases 3.15 aplicadas, huellas del catálogo (funciones, políticas, triggers,
restricciones, índices, columnas, grants), conteo por tabla, tablas excluidas y su conteo en el origen, Storage (buckets, objetos,
bytes, faltantes/sobrantes/diferentes), cada artefacto con bytes y SHA-256, huellas de negocio/usuarios/Storage, invariantes,
resultado de la verificación y del escaneo de secretos, y `manifiesto_sha256` (JSON canónico de todo lo anterior).
**Integridad, no autenticidad:** detecta truncado, bytes cambiados y ediciones del manifiesto; quien pudiera reescribir TODOS los hashes
podría falsificarlo. Guardar el `.sha256` también fuera del respaldo (p. ej. en el STATE) cierra ese hueco.

## 3. Restauración (solo aislada en 3.15)
`restaurar-aislado.sh DIR`: verifica → contenedor nuevo sin red → `pg_restore` pre-data → data → usuarios saneados (sin triggers) →
post-data → fotos → comparación → Storage a una carpeta aislada. No hay forma de dirigirlo a otra base: rechaza (código 3) cualquier
argumento de conexión (`service=`, `postgres://`, `host=`, `--destino`, `*.supabase.co`, pooler) antes de hacer nada.

### Contrato de una FUTURA restauración en la nube (no implementada; DESTRUCTIVA)
Reemplaza los datos del taller, así que cuando exista deberá cumplir TODO esto, en el servidor:
1. Acción `restaurar_respaldo` del catálogo OWNER-PIN (ya declarada en `api-server/src/lib/pin.ts`, `taller-demo/pin-ui.js` y
   `public.sync_accion_destructiva`): **PIN del propietario también para el administrador**, solo rol admin, autorización de un solo uso
   ligada a la sesión y al dispositivo; `registro_id` = uuid derivado del `manifiesto_sha256`.
2. Con conexión (sin red no se intenta ni se pide el PIN), confirmación explícita escribiendo el nombre del destino.
3. **Respaldo previo** del destino con `puerta-pre-release.sh` en PASS inmediatamente antes.
4. Manifiesto válido (`verificar` sin errores), formato y versión compatibles (nunca un respaldo de una versión más nueva ni de otra
   familia: copia de dispositivo, 3.13), y destino identificado (proyecto y entorno) igual al declarado.
5. Auditoría del reemplazo y verificación posterior (foto del destino == foto del respaldo).
El bloqueo de «Restaurar» en la app en modo nube (Bloque 4) se mantiene; en 3.15 la restauración de la EMPRESA solo existe aislada.

## 4. Storage
Automatizado: inventario desde `storage.objects` (solo lectura) → archivos con su ruta `bucket/ruta` → verificación de tamaño + MD5
(= eTag) → SHA-256 al manifiesto → **faltantes, sobrantes y diferentes** hacen fallar el respaldo. Los archivos se toman de una copia
local ya verificada (`--storage-copia`, p. ej. la del Bloque 0: 13/13) o se descargan con `ENTIMOTORS_STORAGE_URL` +
`ENTIMOTORS_STORAGE_LLAVE` (la llave solo en el entorno del operador; nunca en disco, manifiesto ni log). Nunca sube, mueve ni borra.
Pendiente de la limpieza controlada (NO se tocó): 3 imágenes QA huérfanas y 2 fotos reales de la orden `0f4002fe…`.

## 5. PUERTA PRE-RELEASE (antes de cada cambio en producción)
```
operacion/respaldo/puerta-pre-release.sh --salida <carpeta-nueva> --origen-servicio entimotors_prod --storage-copia <copia verificada>
```
Respaldo (solo lectura) → manifiesto → hashes → secretos → restauración aislada → invariantes y finanzas iguales → **PASS**, o
`RELEASE BLOQUEADO` y código 1. No aplica migraciones, no publica y no hace nada destructivo en producción. Si el origen cambia durante
el respaldo (foto antes ≠ después), falla y hay que repetirlo en un momento sin actividad.
