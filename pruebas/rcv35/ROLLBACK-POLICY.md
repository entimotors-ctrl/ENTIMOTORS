# RCV-35 — Política de rollback de `rol_actual()`

**Estado (2026-09-18):** RCV-35 fue aplicado y verificado en producción. La evidencia, sin cuerpos ni base64, está en
`produccion-post-fix-20260918.json` (origen: verificación de solo lectura con `03`).

**Decisión: no existe `02-rollback-rol-actual.sql` y no se va a crear.**

## Por qué

- El estado anterior (PRE, `md5(prosrc)` `527f940b66f3c7b88b746dc3a676bdb9`) es conocido, pero contiene una regresión
  de autorización confirmada (`SECURITY_REGRESSION_CONFIRMED`): esa `rol_actual()` no filtraba `perfiles.activo`.
- Revertirlo reintroduciría esa regresión. Una cuenta dada de baja (`activo = false`) con un JWT todavía válido volvería
  a obtener autorización por rol a través de `es_admin`, `puede_cobrar`, `es_equipo`, `es_desarrollador`,
  `ve_todo_el_taller` y `es_mecanico_activo`, y con ellas de las RPC `SECURITY DEFINER` y de las políticas RLS que
  dependen de esos helpers.

## Reglas

1. El estado PRE **no se restaura automáticamente**, ni como respuesta rutinaria a un incidente.
2. Ante un problema operativo con `rol_actual()` se aplica **FIX-FORWARD**: una corrección hacia adelante que
   **conserve `AND p.activo`** y el `COALESCE(..., '')` null-safe, con el mismo rigor que `01`: precondiciones exactas,
   postcondiciones que fallan cerradas, una sola transacción y prueba local previa. Un problema de datos (por ejemplo,
   una cuenta legítima con `activo = false`) se corrige en el dato, con autorización explícita de Wilkin, no relajando
   la función.
3. Cualquier reversión insegura futura requiere **autorización explícita de Wilkin** y una **mitigación compensatoria**
   que cubra el hueco mientras dure (por ejemplo, bloquear o expirar en Auth las sesiones de las cuentas dadas de baja),
   con plazo acotado y verificación con `03` al volver a un estado con `AND p.activo`. Las medidas concretas se
   definen en ese momento.

## Qué lo protege en el código

- `01-fix-rol-actual-activo.sql` no es re-ejecutable: su precondición exige el md5 PRE y falla cerrada si ya se aplicó.
- `taller-demo/supabase/entimotors-rcv34-source-sync.sql` embebe la definición POST-RCV-35 y su postcondición exige
  `md5(prosrc)` `e66ee46e01d3df511ee5bd4d0f2a178a` y `AND p.activo`. No puede reinstalar el estado PRE.

## Verificar el estado actual

Ejecutar `03-verificacion-post-fix-readonly.sql` (solo lectura). Esperado: `md5_prosrc = e66ee46e…`,
`contiene_filtro_activo = true`, `cumple_estado_post_fix = true`.

## Ver también

`LEEME.md` (estado aplicado y verificado, comportamiento y advertencias) y `pruebas/rcv34/RCV34-SOURCE-SYNC.md` (el
source-sync canónico que representa el estado POST y el coverage gate que lo protege).
