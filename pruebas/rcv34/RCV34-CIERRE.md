# RCV-34 — Cierre documental

Estado: **producción cerrada, verificada. Sin cambios pendientes de ejecutar salvo el rollback de emergencia (no ejecutado).**

## 1. Objetivo

Revisar y cerrar la exposición de `EXECUTE` sobre funciones de PostgreSQL en el schema `public`
del proyecto Supabase de producción de ENTIMOTORS, con foco en las funciones usadas como
disparadores (`trigger`), y dejar en el repositorio un guard automático que impida que vuelva a
introducirse ese mismo problema en funciones nuevas.

## 2. Riesgo inicial

Postgres concede `EXECUTE` a `PUBLIC` de forma implícita en toda función nueva, salvo que se
revoque explícitamente. Eso significa que cualquier función de `public` — incluidas las que solo
existen para ser invocadas por un disparador, nunca directamente por la aplicación — podía ser
ejecutada manualmente por el rol `anon` (sin sesión) o por `PUBLIC` en general, siempre que el
llamador conociera su nombre y firma exacta. El riesgo concreto no era que rompiera el disparador
(la invocación vía trigger no depende del ACL de `EXECUTE`), sino que un tercero pudiera invocar
la lógica de esas funciones fuera de su contexto previsto.

## 3. Decisión arquitectónica

**No se usó**, ni se usará, en producción:

```
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC
```

**Motivo:** ese cambio es GLOBAL para el rol `postgres` en cualquier schema, no solo `public`. La
auditoría de Fase 1C encontró que `postgres` (vía `supabase_admin`) posee funciones fuera de
`public`, en particular en `extensions`, y que una entrada `ALTER DEFAULT PRIVILEGES` sin
`IN SCHEMA` reemplaza — no complementa — el baseline compilado de Postgres para **toda** función
futura que ese rol cree en **cualquier** schema, incluyendo actualizaciones de extensiones o
futuras instalaciones. El riesgo de un efecto colateral no acotado en el tiempo ni en el schema
superaba el beneficio, frente a la alternativa de cerrar el `EXECUTE` función por función con
verificación exacta antes y después de cada cambio.

En su lugar se cerraron individualmente, por nombre y firma exacta, las 3 funciones concretas que
representaban el riesgo real.

## 4. Funciones cerradas

- `public.mecanico_solo_avance_tecnico()`
- `public.proteger_caja_ligada()`
- `public.proteger_rol_perfil()`

## 5. Resultado final (las 3 funciones)

| Rol | EXECUTE |
|---|---|
| `PUBLIC` | `false` |
| `anon` | `false` |
| `authenticated` | `true` |
| `service_role` | `true` |

Verificado en producción, antes y después del cambio, con comparación campo a campo (owner,
`security_definer`, cuerpo, `search_path`, `proconfig`, conjunto exacto de disparadores incluidos
los internos, y ACL exacta) — ver `01-cierre-triggers-public.sql`.

## 6. Guard global final (estado de producción, Fase 3A)

- 17 funciones de `public` evaluadas.
- 0 con `EXECUTE` para `PUBLIC`.
- 0 con `EXECUTE` para `anon`.
- 0 funciones `SECURITY DEFINER` sin `search_path` fijado.

(`proteger_caja_ligada()` no es `SECURITY DEFINER` y no fija `search_path`; no aplica esa regla y
no cuenta como fallo — ver `04-guard-funciones-public.sql`.)

## 7. Hashes finales

| Archivo | SHA-256 |
|---|---|
| `01-cierre-triggers-public.sql` | `af4788240fe84f7299f24d7d44b4b67e74dffec2463a71b9b3ddb25defb206b3` |
| `02-rollback-cierre-triggers.sql` | `dd373ee768f1f2ed67e5b4fb1e79e4bc93f32126854d7a59ebf7e18767c4a76e` |
| `04-guard-funciones-public.sql` | `f37bf718b2072f5b8f6eb0bc4d5b4078c2090b1c242f2bb2c0e3c518cd190ccf` |

## 8. Sobre el rollback

`02-rollback-cierre-triggers.sql` **NO fue ejecutado** contra producción. Está aprobado y
verificado de extremo a extremo en laboratorio (Docker/Supabase local), y se conserva únicamente
como procedimiento de recuperación ante una regresión causada por el cierre de ACL — no como parte
del despliegue normal.

## 9. Conservación del snapshot de rollback

El valor `estado_previo_para_rollback` que imprimió `01-cierre-triggers-public.sql` al ejecutarse
en producción (JSON con owner, cuerpo, `security_definer`, `search_path`, `proconfig`, ACL previa
exacta y disparadores de las 3 funciones, capturado ANTES del cambio) **debe conservarse en un
lugar seguro mientras esta versión del cierre siga desplegada**. Es el único insumo que permite
ejecutar `02-rollback-cierre-triggers.sql` con la certeza de que restaura exactamente el estado
previo, aclitem por aclitem. No contiene secretos ni datos de negocio: solo metadata de catálogo
de Postgres sobre las 3 funciones.

## Deuda histórica de ACL (guard estático)

El guard estático de repositorio (`guard-estatico-funciones.mjs`) exige, para toda función nueva o
modificada en `public`, cierre explícito de ACL en el mismo archivo (`REVOKE ... FROM PUBLIC`,
`REVOKE ... FROM anon`, y al menos un `GRANT` explícito). Las 7 funciones de aplicación que ya
existían antes de esta política (`rol_actual`, `es_admin`, `puede_cobrar`,
`crear_perfil_al_registrarse`, `registrar_venta`, `registrar_abono`, `proteger_caja_ligada`, todas
en `codigo/taller-demo/supabase/entimotors-completo.sql`) quedan registradas como deuda histórica
conocida en `guard-estatico-baseline.json` (archivo + firma exacta + hash del fragmento), y por
tanto no hacen fallar el guard mientras no cambien. Si cualquiera de ellas se modifica, el guard
vuelve a exigir su cierre de ACL o que el baseline se actualice a propósito. Esto es deuda
**documental/de repositorio**, no un hallazgo de producción: `proteger_caja_ligada()` ya está
cerrada en producción (ver punto 4); las otras 6 no son disparadores y su exposición a `PUBLIC`
queda fuera del alcance específico de RCV-34 (que se limitó a funciones-trigger).
