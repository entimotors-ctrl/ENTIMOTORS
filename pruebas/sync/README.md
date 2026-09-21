# Pruebas de SYNC (3.14.0)

Todo corre contra un **Postgres local** (contenedor `entimotors-sync-pg`, 127.0.0.1:54432, misma imagen y versión que producción). **Nunca toca producción.**
La contraseña `postgres` es la clave de desarrollo de la imagen: la base solo existe en esta máquina.

```bash
pruebas/sync/entorno-local.sh up      # recrea el contenedor y carga la base de referencia (= producción 2026-09-21)
pruebas/sync/correr-sql.sh 1          # SYNC-1: forward x2, pruebas, rollback seguro, ciclo forward/rollback/forward
pruebas/sync/entorno-local.sh down
```

- `baseline/generar-baseline.mjs` genera la base de referencia **desde el catálogo real de producción** (`catalogo/entimotors-sync0-catalogo.sql`, resultado en CSV fuera del repo).
- `baseline/verificar-fidelidad.mjs` compara el esquema local con el CSV de producción (o con otra base local: `db:NOMBRE`). El rollback de cada fase debe devolver un esquema **idéntico** al de referencia.
- Las fases SQL se ejecutan sobre **copias aisladas** de la base de referencia; cada fase aplica su forward dos veces (idempotencia) y su rollback.
- Las migraciones están en `taller-demo/supabase/sync/` (forward + rollback). Pasan el guard REV8 (`npm run verify:rcv34`).
