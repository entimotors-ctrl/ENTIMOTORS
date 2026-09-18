# RCV-35 — Hotfix de autorización `rol_actual()` / `perfiles.activo`

**Estado: APLICADO Y VERIFICADO EN PRODUCCIÓN — 2026-09-18.**

| Dato | Valor |
|---|---|
| md5(prosrc) PRE | `527f940b66f3c7b88b746dc3a676bdb9` |
| md5(prosrc) POST | `e66ee46e01d3df511ee5bd4d0f2a178a` |
| Bytes POST | 158 |
| CR POST | 0 |
| LF POST | 11 |
| `contiene_filtro_activo` | `true` |
| `cumple_estado_post_fix` | `true` |
| ACL efectiva | PUBLIC = false, anon = false, authenticated = true, service_role = true |

- **`01` NO debe volver a ejecutarse.** Ya se aplicó. Su precondición exige el md5 PRE, así que una segunda ejecución falla
  cerrada sin cambiar nada; aun así, no hay motivo para lanzarlo de nuevo.
- **`03` es de solo lectura** (`BEGIN TRANSACTION READ ONLY` … `ROLLBACK`): es la forma segura de volver a comprobar el estado.
- **No existe rollback automático al PRE.** Volver a ese estado reintroduciría una regresión de autorización confirmada.
  La política es **FIX-FORWARD**: ver [ROLLBACK-POLICY.md](ROLLBACK-POLICY.md).

## Hallazgo

`SECURITY_REGRESSION_CONFIRMED`.

- **Causa.** La `public.rol_actual()` de producción dejó de comprobar `public.perfiles.activo`. El diseño del source
  (`entimotors-completo.sql`, `entimotors-fase4d-rls.sql`) hacía de ese filtro la **única** comprobación de baja en la
  base de datos: «rol_actual() ya filtra por activo, así que todo lo que se apoye en él deja fuera automáticamente a un
  usuario dado de baja aunque su JWT siga vivo».
- **Impacto (mientras estuvo el PRE).** Una sesión/JWT todavía válido de un usuario dado de baja (`activo = false`) podía
  seguir obteniendo autorización por rol a través de `es_admin`, `puede_cobrar`, `es_equipo`, `es_desarrollador`,
  `ve_todo_el_taller` y `es_mecanico_activo`; y, por ellas, de las RPC `SECURITY DEFINER` y de las políticas RLS que
  dependen de esos helpers. Ninguna política ni función comprueba `activo` directamente.
- **Solución aplicada.** Se mantuvo el comportamiento null-safe de producción (`COALESCE(..., '')`, `LIMIT 1`) y se
  restauró `AND p.activo`. **No** se restauró el texto antiguo del source: devolvería `NULL` y, con los helpers actuales
  de producción (que ya no llevan `coalesce`), `NOT es_admin()` sería `NULL` y `proteger_rol_perfil()` dejaría de rechazar
  cambios de rol (fail-open).

## Relación con RCV-34

RCV-35 **no modifica RCV-34**. RCV-34 permanece cerrado y congelado (guard REV8, excepciones, `01`, `02`, `04`). Este
hotfix solo tocó `public.rol_actual()` y su ACL. El estado POST está representado en el source-sync canónico
(`taller-demo/supabase/entimotors-rcv34-source-sync.sql`, **no ejecutado**), documentado en
`pruebas/rcv34/RCV34-SOURCE-SYNC.md`.

## Archivos

| Archivo | Qué es |
|---|---|
| `01-fix-rol-actual-activo.sql` | El hotfix, **ya aplicado**: una transacción con precondiciones exactas, `CREATE OR REPLACE`, ACL explícito, postcondiciones y resultado JSON. No volver a ejecutar. |
| `03-verificacion-post-fix-readonly.sql` | Auditoría `READ ONLY` de una fila: estado real de `rol_actual()` (con `prosrc` y definición en base64) y de `perfiles.activo`. |
| `produccion-post-fix-20260918.json` | Evidencia del estado POST verificado con `03`. Sin cuerpos ni base64. |
| `ROLLBACK-POLICY.md` | Por qué no hay rollback al PRE y qué se hace en su lugar (FIX-FORWARD). |

## Comportamiento

| Situación | `rol_actual()` |
|---|---|
| perfil activo | su rol |
| perfil inactivo | `''` |
| sin perfil | `''` |
| `auth.uid()` NULL (service_role, anon) | `''` |

Con `''`, `es_admin`, `puede_cobrar`, `es_equipo`, `es_desarrollador`, `ve_todo_el_taller` y `es_mecanico_activo` valen
`false` (no `NULL`), y `proteger_rol_perfil()` rechaza el cambio de rol (`NOT es_admin()` = `true`). Para cuentas activas
el comportamiento es idéntico al anterior.

## Cómo se validó antes de aplicarlo

- **Análisis estático** (lógica trivaluada de SQL sobre los cuerpos de producción verificados por md5): 13/13.
- **Laboratorio local** (PostgreSQL 16 desechable, sin TCP y separado del stack Supabase local, sin producción): `01` se
  ejecutó de extremo a extremo con una suite de 87/87 comprobaciones. Cubrió la reproducción del PRE, 6 helpers con
  cuerpos byte-exactos, `proteger_rol_perfil()` fail-closed, `03`, 7 pruebas negativas de precondición y que solo cambian
  `rol_actual()` y su ACL. Ese laboratorio no reproduce RLS reales, hooks de Auth ni el editor de SQL de Supabase.
- **Producción:** aplicado y verificado el 2026-09-18 (tabla de arriba).

## Cómo se protegió `01`

- **Precondiciones (fallan antes de tocar nada):** exactamente una `public.rol_actual` con firma `rol_actual()`; owner
  `postgres`; `text`; `sql`; `STABLE`; `SECURITY DEFINER`; `search_path=public`; atributos secundarios en su valor por
  defecto; `md5(prosrc)` PRE; ACL PUBLIC = false, anon = false, authenticated = true, service_role = true; existe
  `public.perfiles.activo` y es `boolean` (solo catálogo, ninguna fila leída).
- **Postcondiciones (revierten todo):** mismos atributos y ACL; el cuerpo, normalizado (minúsculas y sin espacios ni
  saltos), es exactamente la lógica esperada y contiene `AND p.activo`; ninguna otra función de `public` cambió (cuerpo,
  owner o ACL).
- **No fijó un md5 posterior:** lo autoritativo era la lógica, los atributos y la ACL. El md5 real se capturó con `03`.

## Advertencias vigentes

- **Efecto inmediato.** Toda cuenta con `activo = false` no tiene autorización por rol (RLS y RPC). Es la intención.
  Una cuenta legítima bloqueada por este motivo se corrige en el dato con autorización explícita, no relajando la
  función (ver `ROLLBACK-POLICY.md`).
- **Alcance.** Corrige la autorización en la base de datos. No revoca sesiones ni bloquea el login en Auth: el flujo de
  baja (`admin-usuarios.ts`) solo escribe `perfiles.activo`. Revocar tokens o banear en Auth queda fuera de este hotfix.
- **Fuera de alcance:** ejecutar el source-sync, `estado_tecnico()`, medir las políticas RLS reales y
  `ALTER DEFAULT PRIVILEGES`.
