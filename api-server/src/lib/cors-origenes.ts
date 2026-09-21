/* CORS SELECTIVO. Las rutas sensibles (PIN, autorizaciones, usuarios) solo aceptan a las dos apps de ENTIMOTORS (el
   Taller y «Mi Trabajo», que el servidor ya conoce por ENTIMOTORS_ADMIN_ORIGIN / ENTIMOTORS_MECHANIC_ORIGIN) y al propio
   servidor (mismo origen). El resto de la API (sitio web público) conserva su CORS abierto de siempre: no se rompe nada.
   Esto NO es la defensa principal —cada ruta exige un token Bearer—, sino reducir superficie y ruido. */
import cors from "cors";
import type { Request, Response, NextFunction } from "express";

export const RUTAS_SENSIBLES = /^\/api\/(admin\/(pin|usuarios)|autorizaciones)(\/|$|\?)/;

/** Origins aprobados: los de las dos apps + los de CORS_ORIGINS_EXTRA (separados por comas). Solo https (http en localhost). */
export function origenesAprobados(env: Record<string, string | undefined> = process.env): string[] {
  const crudos = [env["ENTIMOTORS_ADMIN_ORIGIN"], env["ENTIMOTORS_MECHANIC_ORIGIN"], ...(env["CORS_ORIGINS_EXTRA"] ?? "").split(",")];
  const salida: string[] = [];
  for (const c of crudos) {
    const t = (c ?? "").trim();
    if (!t) continue;
    try {
      const u = new URL(t);
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol === "https:" || (u.protocol === "http:" && local)) salida.push(u.origin);
    } catch { /* una dirección mala no abre nada */ }
  }
  return [...new Set(salida)];
}

export function crearCorsSelectivo(env: Record<string, string | undefined> = process.env) {
  const abierto = cors();
  const aprobados = new Set(origenesAprobados(env));
  return function corsSelectivo(req: Request, res: Response, next: NextFunction): void {
    if (!RUTAS_SENSIBLES.test(req.originalUrl ?? req.url ?? "")) { abierto(req, res, next); return; }
    const origin = req.get("origin");
    if (origin === undefined) { next(); return; }                       // sin navegador (curl, servidor a servidor)
    const host = req.get("host");
    const mismoOrigen = !!host && (origin === `https://${host}` || origin === `http://${host}`);
    if (!aprobados.has(origin) && !mismoOrigen) {
      res.status(403).json({ error: "Origen no permitido.", codigo: "ORIGEN_NO_PERMITIDO" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  };
}
