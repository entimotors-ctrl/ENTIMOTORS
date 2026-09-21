import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    // PIN administrativo y contraseñas de re-autenticación: NUNCA en logs (además el cuerpo de las peticiones no se registra)
    "req.body.pin", "req.body.pin_nuevo", "req.body.pin_actual", "req.body.clave_cuenta",
    "*.pin", "*.pin_nuevo", "*.pin_actual", "*.clave_cuenta",
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
