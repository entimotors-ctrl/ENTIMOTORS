/* MANEJADOR FINAL DE ERRORES (SECURITY-1B). Sustituye al de Express, que hacía console.error(err.stack) — y el mensaje de un JSON mal
   formado lleva un TROZO del cuerpo (V8: `Unexpected token 'x', ..."clave_cuenta":…"... is not valid JSON`), o sea, fragmentos de
   contraseñas y PIN en los logs de Render; en desarrollo además devolvía ese stack en la respuesta. body-parser guarda también el
   cuerpo COMPLETO en err.body.

   Reglas: jamás se registra ni se devuelve err.message, err.body, err.stack con su primera línea, el cuerpo ni la query.
   Respuesta siempre genérica en JSON, con Cache-Control: no-store y el código HTTP que corresponde. Del error solo se registra
   lo que no puede contener datos del cliente: el tipo de body-parser, el nombre/código del error y los marcos «at …» de la pila. */
import type { ErrorRequestHandler } from "express";

export interface LogErrores {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

type Respuesta = { status: number; codigo: string; error: string };

/** Errores de body-parser (express.json / express.urlencoded), por su `type`. */
export const ERRORES_DE_CUERPO: Record<string, Respuesta> = {
  "entity.parse.failed": { status: 400, codigo: "CUERPO_INVALIDO", error: "Cuerpo inválido." },
  "entity.verify.failed": { status: 403, codigo: "CUERPO_RECHAZADO", error: "Cuerpo rechazado." },
  "request.aborted": { status: 400, codigo: "PETICION_ABORTADA", error: "La petición se interrumpió." },
  "request.size.invalid": { status: 400, codigo: "CUERPO_INVALIDO", error: "Cuerpo inválido." },
  "entity.too.large": { status: 413, codigo: "CUERPO_DEMASIADO_GRANDE", error: "El cuerpo de la petición es demasiado grande." },
  "parameters.too.many": { status: 413, codigo: "CUERPO_DEMASIADO_GRANDE", error: "El cuerpo de la petición es demasiado grande." },
  "charset.unsupported": { status: 415, codigo: "CUERPO_NO_ADMITIDO", error: "Formato del cuerpo no admitido." },
  "encoding.unsupported": { status: 415, codigo: "CUERPO_NO_ADMITIDO", error: "Formato del cuerpo no admitido." },
};

const PETICION_INVALIDA: Respuesta = { status: 400, codigo: "PETICION_INVALIDA", error: "Petición no válida." };
const ERROR_INTERNO: Respuesta = { status: 500, codigo: "ERROR_INTERNO", error: "No se pudo completar la operación." };

const texto = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

/** Solo los marcos «at …» de la pila; la cabecera «Nombre: MENSAJE» nunca sale, aunque el mensaje tenga varias líneas (se quita
    entera, con su longitud exacta). Si la pila no empieza por esa cabecera (formato desconocido), no sale NINGÚN marco: falla cerrado. */
export function pilaSinMensaje(err: unknown): string[] {
  const e = err as { stack?: unknown; name?: unknown; message?: unknown } | null;
  if (!e || typeof e.stack !== "string") return [];
  const nombre = typeof e.name === "string" ? e.name : "Error";
  const mensaje = typeof e.message === "string" ? e.message : "";
  const cabecera = mensaje ? `${nombre}: ${mensaje}` : nombre;
  if (!e.stack.startsWith(cabecera)) return [];
  return e.stack.slice(cabecera.length).split("\n").filter((l) => /^\s+at\s/.test(l)).slice(0, 8).map((l) => l.trim().slice(0, 200));
}

export function crearManejadorErrores(log: LogErrores): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const e = (err ?? {}) as { type?: unknown; name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
    const tipo = typeof e.type === "string" && Object.prototype.hasOwnProperty.call(ERRORES_DE_CUERPO, e.type) ? e.type : null;
    const ruta = String(req.originalUrl ?? req.url ?? "").split("?")[0].slice(0, 200);
    let r: Respuesta;
    if (tipo) {
      r = ERRORES_DE_CUERPO[tipo];
      const bytes = Number(req.headers["content-length"]);
      log.warn({ evento: "cuerpo-rechazado", tipo, status: r.status, metodo: req.method, ruta, bytes: Number.isFinite(bytes) ? bytes : null }, "petición con un cuerpo no válido");
    } else {
      const st = Number(e.status ?? e.statusCode);
      r = Number.isInteger(st) && st >= 400 && st < 500 ? { ...PETICION_INVALIDA, status: st } : ERROR_INTERNO;
      log.error({ evento: "error-no-controlado", nombre: texto(e.name, 60), codigo: texto(e.code, 60), status: r.status, metodo: req.method, ruta, pila: pilaSinMensaje(err) }, "error no controlado");
    }
    if (res.headersSent) { req.socket?.destroy(); return; }   // como Express: ya no se puede responder; se corta la conexión
    res.status(r.status).set("Cache-Control", "no-store").json({ error: r.error, codigo: r.codigo });
  };
}
