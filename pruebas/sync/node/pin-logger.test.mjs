// SYNC-3P · el logger REAL (pino) redacta PIN y contraseñas de re-autenticación aunque alguien los registre por error.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { RAIZ } from "./helpers/compilar.mjs";

test("pino redacta pin, pin_nuevo, pin_actual y clave_cuenta (en req.body y a un nivel de profundidad); authorization también", () => {
  const codigo = `
    import { compilar } from ${JSON.stringify(path.join(RAIZ, "pruebas/sync/node/helpers/compilar.mjs"))};
    const url = await compilar("api-server/src/lib/logger.ts", { falsos: [], nombre: "logger-real" });
    const { logger } = await import(url);
    logger.info({ req: { body: { pin: "482913", pin_nuevo: "739205", pin_actual: "111112", clave_cuenta: "CLAVE-X", accion: "ajustar_stock" }, headers: { authorization: "Bearer TOKEN-X" } } }, "req");
    logger.info({ datos: { pin: "482913", clave_cuenta: "CLAVE-X", pin_nuevo: "739205", pin_actual: "111112" }, ok: 1 }, "datos");
    logger.info({ pin: "482913" }, "raiz"); // la raíz sin comodín: documentamos el límite abajo
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", codigo], { cwd: RAIZ, encoding: "utf8", env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "info" } });
  assert.equal(r.status, 0, r.stderr);
  const lineas = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  const [a, b, c] = lineas;
  assert.equal(a.req.body.pin, "[Redacted]"); assert.equal(a.req.body.pin_nuevo, "[Redacted]"); assert.equal(a.req.body.pin_actual, "[Redacted]"); assert.equal(a.req.body.clave_cuenta, "[Redacted]");
  assert.equal(a.req.headers.authorization, "[Redacted]"); assert.equal(a.req.body.accion, "ajustar_stock", "lo demás sigue legible");
  for (const k of ["pin", "clave_cuenta", "pin_nuevo", "pin_actual"]) assert.equal(b.datos[k], "[Redacted]", k);
  const bruto = r.stdout;
  for (const secreto of ["739205", "111112", "CLAVE-X", "TOKEN-X"]) assert.ok(!bruto.includes(secreto), `no debe aparecer ${secreto}`);
  assert.equal(c.pin, "482913", "LÍMITE CONOCIDO: un campo `pin` en la RAÍZ del log no se redacta; el código nunca lo registra (lo vigila la prueba de rutas)");
});
