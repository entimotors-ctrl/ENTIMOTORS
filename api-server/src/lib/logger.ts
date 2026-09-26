import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/** Nombres de campo que jamás deben aparecer con su valor en un log (SECURITY-1B amplía la lista del PIN). */
export const SECRETOS = [
  "pin", "pin_nuevo", "pin_actual", "clave_cuenta",
  "password", "clave_actual", "clave_nueva", "clave_confirmacion",
  "access_token", "refresh_token", "token",
] as const;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    // PIN, contraseñas y tokens: NUNCA en logs (además el cuerpo de las peticiones no se registra). Segunda línea de defensa: el código
    // no debe registrarlos; si alguien lo hace por error, salen como [Redacted] en la raíz, a uno y a dos niveles, y en req.body.
    ...SECRETOS.flatMap((k) => [k, `req.body.${k}`, `*.${k}`, `*.*.${k}`]),
    // body-parser guarda el cuerpo COMPLETO en err.body: si un error llega a registrarse entero, el cuerpo no sale
    "err.body", "*.err.body", "error.body", "*.error.body",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
