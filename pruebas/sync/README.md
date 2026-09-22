# Pruebas de SYNC (3.14.0)

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
- Las migraciones están en `taller-demo/supabase/sync/` (forward + rollback). Pasan el guard REV8 (`npm run verify:rcv34`).
