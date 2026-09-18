# RCV-34 — Source-sync canónico post RCV-35

**Estado:** el source-sync está construido y protegido por un coverage gate. **No se ha ejecutado en producción.**
RCV-34 permanece congelado (guard REV8, excepciones, `01`, `02`, `04` no se han tocado). RCV-35 `01` **sí** se ejecutó
en producción el 2026-09-18 y RCV-35 `03` confirmó el estado POST. **Este gate NO VERIFICA PRODUCCIÓN:** compara
archivos del repositorio con evidencia ya capturada.

## Qué es

`taller-demo/supabase/entimotors-rcv34-source-sync.sql` es la representación en código de lo que hay en producción el
2026-09-18: **17 funciones** de `public` y **5 triggers** confirmados, con su ACL canónica. El nombre se mantiene por
continuidad de la reconciliación RCV-34; su `rol_actual()` ya incorpora RCV-35.

## Cadena de evidencia

1. **Recuperación byte-exact (B3R).** Las 17 definiciones se capturaron de producción en base64, se validaron
   (md5, bytes, CR y LF de cada cuerpo, y cuerpo de la definición idéntico al `prosrc`) y se guardaron como huellas en
   `pruebas/rcv34/produccion-funciones-20260918.json`, sin cuerpos.
2. **RCV-35 corrigió `rol_actual()`.** La versión PRE (md5 `527f940b66f3c7b88b746dc3a676bdb9`) había perdido
   `AND p.activo`: regresión de autorización confirmada. `01` la reemplazó y `03` confirmó el POST (md5
   `e66ee46e01d3df511ee5bd4d0f2a178a`, 158 bytes, CR 0, LF 11), guardado en
   `pruebas/rcv35/produccion-post-fix-20260918.json`.
3. **El source-sync representa el POST.** Usa las 16 definiciones de B3R sin cambios y la de `rol_actual()` del estado
   POST-RCV35. El PRE y el POST **coexisten** como evidencia (el PRE explica el hallazgo, el POST es el estado vigente),
   pero solo el POST puede estar en el source-sync.

## Contenido

- **Funciones (17):** `rol_actual`, `es_admin`, `puede_cobrar`, `es_equipo`, `es_desarrollador`, `es_mecanico_activo`,
  `ve_todo_el_taller`, `mi_cliente(uuid)`, `mi_moto(uuid)`, `crear_perfil_al_registrarse`, `proteger_caja_ligada`,
  `proteger_rol_perfil`, `mecanico_solo_avance_tecnico`, `registrar_venta(uuid,text,text,numeric,jsonb,integer,text)`,
  `registrar_abono(uuid,numeric,text,text)`, `estadisticas_tecnicas`, `estado_tecnico`. Ninguna extra. Definiciones
  `CREATE OR REPLACE` copiadas tal cual de la captura, con los atributos de producción (15 `SECURITY DEFINER`).
- **Triggers (5), confirmados en producción:**

  | Tabla | Trigger | Momento | Función |
  |---|---|---|---|
  | `auth.users` | `al_crear_usuario` | AFTER INSERT, por fila | `crear_perfil_al_registrarse()` |
  | `public.caja_movimientos` | `no_borrar_caja_ligada` | BEFORE DELETE, por fila | `proteger_caja_ligada()` |
  | `public.citas` | `citas_mecanico_avance` | BEFORE UPDATE, por fila | `mecanico_solo_avance_tecnico()` |
  | `public.ordenes` | `ordenes_mecanico_avance` | BEFORE UPDATE, por fila | `mecanico_solo_avance_tecnico()` |
  | `public.perfiles` | `proteger_rol_perfil_trigger` | BEFORE UPDATE, por fila | `proteger_rol_perfil()` |

  Sin `DROP TRIGGER`: si un trigger existe se valida (tabla, función, momento, evento, nivel de fila, habilitado, sin
  `WHEN` ni lista de columnas); si falta se crea; si existe y no coincide, se aborta y se revierte todo. El comentario de
  cabecera del source-sync que califica de no medido el momento de `al_crear_usuario` es anterior a la confirmación de
  Wilkin y no se corrige para no alterar el SHA fijado. **Este documento prevalece.**
- **ACL canónica:** `PUBLIC` y `anon` sin EXECUTE (17/17); `authenticated` con EXECUTE en 16/17 (no en
  `crear_perfil_al_registrarse`); `service_role` con EXECUTE en 17/17. Sin `GRANT ALL`, sin cambiar owner y sin
  `ALTER DEFAULT PRIVILEGES` (una postcondición exige que los default privileges no cambien).
- **Transacción única:** `BEGIN` → precondiciones → funciones → ACL → triggers → postcondiciones → resultado JSON →
  `COMMIT`. Cualquier fallo revierte todo. Es idempotente.
- **Nunca reinstala el PRE inseguro:** su postcondición exige el md5 POST de `rol_actual()` y el filtro `AND p.activo`.

## Fingerprints canónicos

md5 de `prosrc` (sin cuerpos). Son los que verifica el gate, junto con bytes, CR y LF.

| Función | md5(prosrc) | Bytes | CR | LF | Origen |
|---|---|---|---|---|---|
| `rol_actual()` | `e66ee46e01d3df511ee5bd4d0f2a178a` | 158 | 0 | 11 | POST-RCV35 |
| `es_admin()` | `35aa9a08ef4e9960cb333eea4939d15e` | 43 | 2 | 2 | B3R |
| `puede_cobrar()` | `2c95d9a820de4ae25ec59d25cbbd1a91` | 71 | 5 | 5 | B3R |
| `es_equipo()` | `635c8361317be3293aee3778a0de048d` | 88 | 6 | 6 | B3R |
| `es_desarrollador()` | `25a3787ce375a9a89a58266b96b732a3` | 51 | 2 | 2 | B3R |
| `es_mecanico_activo()` | `1b786deb21df29b40f89dca23ab776fd` | 60 | 0 | 2 | B3R |
| `ve_todo_el_taller()` | `80b7f166927d6559301d8507c397a243` | 69 | 0 | 2 | B3R |
| `mi_cliente(uuid)` | `aeee991cda291df054c2924d1e9f3cdf` | 299 | 0 | 6 | B3R |
| `mi_moto(uuid)` | `235499aeafbd8379d6333b7e51edb6c2` | 161 | 0 | 4 | B3R |
| `crear_perfil_al_registrarse()` | `f3873b6473a2831c8046a29b97947ea3` | 257 | 0 | 17 | B3R |
| `proteger_caja_ligada()` | `4b1a0e352c4eae22efcbb139ae72a725` | 299 | 0 | 16 | B3R |
| `proteger_rol_perfil()` | `5bcd1237d7e6714293cf4fc332e08667` | 272 | 16 | 16 | B3R |
| `mecanico_solo_avance_tecnico()` | `5c9d8db5084b0a4e881948d9a920462b` | 4298 | 0 | 89 | B3R |
| `registrar_venta(uuid,text,text,numeric,jsonb,integer,text)` | `ae8ee6c6d7c066d4d544ff4e9ab5147b` | 2853 | 0 | 177 | B3R |
| `registrar_abono(uuid,numeric,text,text)` | `6dee1802d5cf45cd4d8d91b140e2cadd` | 2117 | 0 | 145 | B3R |
| `estadisticas_tecnicas()` | `86948fdcaf03939a1d0929004cd9c730` | 1467 | 0 | 26 | B3R |
| `estado_tecnico()` | `8cab17a837ec35d46c8575befd53e85a` | 1764 | 82 | 82 | B3R |

## Byte-exact estático frente a normalización en ejecución

- **El gate mide bytes.** El archivo mezcla LF y CRLF a propósito: 6 cuerpos (`es_admin`, `es_desarrollador`,
  `es_equipo`, `estado_tecnico`, `proteger_rol_perfil`, `puede_cobrar`) tienen CRLF reales en producción. Cualquier
  normalización cambia su huella y el gate falla.
- **La ejecución tolera la normalización.** Si un editor convierte CRLF en LF, el source-sync se ejecuta igual (la lógica
  no cambia): el JSON final informa `md5_coinciden` (11/17 en ese caso) sin bloquear. Solo el md5 de `rol_actual()` bloquea,
  porque ese cuerpo no tiene CR. Para conservar los bytes conviene ejecutarlo con `psql -f`, no pegarlo en un editor.
- **`.gitattributes`.** La regla `taller-demo/supabase/entimotors-rcv34-source-sync.sql -text` impide que Git normalice
  esos CRLF al confirmar o extraer. El gate exige que el estado final del atributo `text` de ese archivo sea `unset`
  (una regla posterior como `* text=auto` lo anularía y hace fallar el gate).

## Las 13 definiciones históricas

REV8 exime como deuda histórica (baseline) las definiciones de los SQL antiguos que no cierran su ACL. El baseline se
regeneró con la función real `--dump-hashes` del guard sobre todos los `.sql` del repositorio: **13 entradas**, de
`entimotors-fase4d-rls.sql` (6), `entimotors-usuarios.sql` (6) y `entimotors-fase4d-rollback.sql` (1). El baseline
anterior tenía 7 entradas de una ruta histórica que ya no existe. El source-sync **no** se baselina: sus 17 funciones
son seguras por sí mismas.

| Clase | Cantidad | Qué son |
|---|---|---|
| `ACTIVE_SOURCE_MATCHES_CANONICAL` | 6 | `ve_todo_el_taller`, `es_mecanico_activo`, `mi_cliente`, `mi_moto`, `mecanico_solo_avance_tecnico` y `estadisticas_tecnicas` de `fase4d-rls`: su cuerpo es idéntico al de producción. |
| `ACTIVE_SOURCE_DIVERGED_SUPERSEDED_BY_CANONICAL` | 3 | `es_equipo`, `es_desarrollador`, `estado_tecnico` de `usuarios`: siguen en el source, pero su cuerpo difiere del de producción y el source-sync los sustituye. |
| `SUPERSEDED_HISTORICAL` | 1 | `estadisticas_tecnicas` de `usuarios`: reemplazada por la de `fase4d-rls`. |
| `ROLLBACK_ONLY` | 1 | `estadisticas_tecnicas` de `fase4d-rollback`: solo se usaría al deshacer `fase4d-rls`. |
| `SOURCE_ONLY_NOT_DEPLOYED` | 2 | `proteger_admin_unico` y `proteger_borrado_admin` de `usuarios`: no existen en producción. Su destino se decide en otra fase. |

El gate no se fía de la etiqueta: recalcula el md5 del cuerpo de cada una en el SQL histórico real y lo compara con el
canónico (igual para las 6 que coinciden; distinto para las divergentes, la reemplazada y la de rollback; ausente en
producción para las 2 SOURCE_ONLY). La clasificación completa está en `guard-estatico-cobertura-sync.json`.

## Coverage gate

Ejecutar desde `pruebas/` (no requiere `npm install`):

```
npm run verify:rcv34
```

| Script | Qué hace |
|---|---|
| `test:guard` | Fixtures de REV8 (77 casos). |
| `security:sql` | REV8 sobre todos los `.sql` del repositorio (`--repo`). |
| `test:sync` | Fixtures del coverage gate (mutantes sobre copias en memoria; no tocan ningún archivo real). |
| `security:sync` | El coverage gate sobre el repositorio real. |

El gate falla cerrado si: el baseline no tiene exactamente 13 entradas o hay huérfanas; la clasificación no es 13/13 con
conteos 6/3/1/1/2; el source-sync no tiene el SHA-256 fijado, no define exactamente las 17 funciones o alguna huella
(md5, bytes, CR, LF) difiere; `rol_actual()` no es el POST, no contiene `AND p.activo` o reproduce el PRE; la ACL no es la
canónica; los 5 triggers no son exactos; hay `DROP TRIGGER`, `ALTER DEFAULT PRIVILEGES` o DDL fuera de alcance;
`.gitattributes` no deja el archivo en `-text`; la evidencia PRE o POST cambió o lleva cuerpos; aparece alguna función
SOURCE_ONLY; o algún archivo protegido cambió de SHA-256. Los invariantes clave están fijados en el código del gate y
repetidos en el manifest: relajarlos exige tocar ambos.

## Política de rollback

No hay rollback automático al PRE: reintroduciría una regresión de autorización confirmada. Ante un problema operativo se
aplica FIX-FORWARD. Ver `pruebas/rcv35/ROLLBACK-POLICY.md`.

## Pendiente

Ejecutar el source-sync en producción es una fase aparte (4E-B4) que requiere autorización explícita. Ningún archivo de
esta carpeta se ha ejecutado contra Supabase en esta fase.
