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
  assert.equal(c.pin, "[Redacted]", "SECURITY-1B: el límite conocido desaparece — un `pin` en la RAÍZ del log también se redacta");
});

test("SECURITY-1B · pino redacta contraseñas y tokens en la raíz, en req.body, a uno y a dos niveles, y el cuerpo que body-parser guarda en err.body", () => {
  const CAMPOS = ["pin", "pin_nuevo", "pin_actual", "clave_cuenta", "password", "clave_actual", "clave_nueva", "clave_confirmacion", "access_token", "refresh_token", "token"];
  const codigo = `
    import { compilar } from ${JSON.stringify(path.join(RAIZ, "pruebas/sync/node/helpers/compilar.mjs"))};
    const { logger, SECRETOS } = await import(await compilar("api-server/src/lib/logger.ts", { falsos: [], nombre: "logger-real-1b" }));
    const valores = (pref) => Object.fromEntries(${JSON.stringify(CAMPOS)}.map((k, i) => [k, pref + "-" + i + "-SECRETO"]));
    logger.info(valores("RAIZ"), "raiz");
    logger.info({ req: { body: valores("BODY"), method: "PUT", url: "/api/admin/pin" } }, "req");
    logger.info({ datos: valores("UNO"), ok: 1 }, "uno");
    logger.info({ a: { b: valores("DOS") }, visible: "se-ve" }, "dos");
    const err = Object.assign(new SyntaxError("mensaje"), { type: "entity.parse.failed", status: 400, body: '{"clave_cuenta":"ERRBODY-SECRETO"' });
    logger.error({ err }, "error con cuerpo");
    logger.error({ contexto: { err } }, "error anidado");
    process.stdout.write("SECRETOS=" + JSON.stringify(SECRETOS) + "\\n");
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", codigo], { cwd: RAIZ, encoding: "utf8", env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "info" } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /-SECRETO/, "ningún valor secreto sale en el log");
  const todas = r.stdout.trim().split("\n"); const secretos = JSON.parse(todas.find((l) => l.startsWith("SECRETOS=")).slice("SECRETOS=".length));
  assert.deepEqual(secretos, CAMPOS, "la lista exportada es la esperada");
  const porMsg = Object.fromEntries(todas.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).map((o) => [o.msg, o]));
  const [raiz, req, uno, dos, e1, e2] = ["raiz", "req", "uno", "dos", "error con cuerpo", "error anidado"].map((m) => porMsg[m]);
  for (const k of CAMPOS) { assert.equal(raiz[k], "[Redacted]", `raíz ${k}`); assert.equal(req.req.body[k], "[Redacted]", `req.body ${k}`); assert.equal(uno.datos[k], "[Redacted]", `1 nivel ${k}`); assert.equal(dos.a.b[k], "[Redacted]", `2 niveles ${k}`); }
  assert.equal(req.req.url, "/api/admin/pin"); assert.equal(dos.visible, "se-ve"); assert.equal(uno.ok, 1);
  assert.equal(e1.err.body, "[Redacted]"); assert.equal(e1.err.status, 400, "lo no secreto del error sigue legible"); assert.equal(e1.err.type, "SyntaxError", "(el serializador de pino pone en `type` el nombre de la clase)");
  assert.equal(e2.contexto.err.body, "[Redacted]");
});
