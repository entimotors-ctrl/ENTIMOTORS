import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { logger } from "../lib/logger.js";

/* Sesión del panel admin (admin.html → products, projects, videos).

   La contraseña solo sirve para ENTRAR. Al acertar, el servidor crea un
   identificador aleatorio de 256 bits que no tiene ninguna relación con la
   contraseña y lo entrega en una cookie HttpOnly: el JavaScript de la página no
   puede leerlo y no se guarda en localStorage. En memoria solo se guarda su hash,
   así que ni un volcado del proceso permite reutilizar una sesión.

   Antes el "token" era base64(ADMIN_PASSWORD): cualquiera que lo viera tenía la
   contraseña, no caducaba y "Salir" no lo invalidaba. Ese esquema ya no se acepta
   de ninguna forma: requireAdmin ignora la cabecera Authorization.

   Las sesiones viven en memoria: un reinicio o un deploy de Render las cierra
   todas (hay que volver a entrar) y el servicio debe correr en UNA instancia. */

/* En producción la cookie lleva el prefijo __Host-: el navegador solo la acepta si
   es Secure, con Path=/ y SIN Domain, así que queda atada al host que la emitió y
   ningún subdominio de entimotors.com puede fijarla ni pisarla. En desarrollo por
   http (sin Secure) el prefijo no se admite y se usa el nombre sin él. */
const COOKIE_PRODUCCION = "__Host-enti_admin";
const COOKIE_DESARROLLO = "enti_admin";

/* Host tal como lo escribe un navegador: nombre[:puerto] o [IPv6][:puerto], nada más. */
const HOST_VALIDO = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type OpcionesAuthAdmin = {
  password?: string;
  ahora?: () => number;
  sesionMs?: number;
  ventanaMs?: number;
  maxFallos?: number;
  cookieSegura?: boolean;
};

const sha256 = (texto: string) => createHash("sha256").update(texto, "utf8").digest();

export function crearAuthAdmin(opciones: OpcionesAuthAdmin = {}) {
  const password = opciones.password;
  const ahora = opciones.ahora ?? Date.now;
  const SESION_MS = opciones.sesionMs ?? 8 * 60 * 60 * 1000;   // una jornada; luego hay que volver a entrar
  const VENTANA_MS = opciones.ventanaMs ?? 15 * 60 * 1000;
  const MAX_FALLOS = opciones.maxFallos ?? 5;
  // Secure salvo en desarrollo explícito: si NODE_ENV falta en el servidor, la cookie sigue siendo Secure
  const COOKIE_SEGURA = opciones.cookieSegura ?? process.env.NODE_ENV !== "development";
  const COOKIE = COOKIE_SEGURA ? COOKIE_PRODUCCION : COOKIE_DESARROLLO;
  const MAX_SESIONES = 20;
  const MAX_IPS = 10_000;

  const sesiones = new Map<string, number>();                               // sha256(id) → expira en
  const fallos = new Map<string, { cuenta: number; desde: number }>();      // ip → intentos fallidos

  // Sin Domain a propósito: cookie host-only. logout la borra con estos mismos atributos.
  const atributos = () => ({ httpOnly: true, secure: COOKIE_SEGURA, sameSite: "strict" as const, path: "/" });

  /* Se comparan los hash de ambos lados: misma longitud siempre (timingSafeEqual
     lanza con longitudes distintas) y el tiempo no depende de cuánto coincide. */
  function claveCorrecta(intento: unknown): boolean {
    if (typeof intento !== "string" || intento.length === 0 || intento.length > 1024) return false;
    if (!password) return false;
    return timingSafeEqual(sha256(intento), sha256(password));
  }

  function limpiar() {
    const t = ahora();
    for (const [h, expira] of sesiones) if (expira <= t) sesiones.delete(h);
    for (const [ip, f] of fallos) if (t - f.desde >= VENTANA_MS) fallos.delete(ip);
    if (fallos.size > MAX_IPS) fallos.clear();
  }

  function bloqueada(ip: string): number {
    const f = fallos.get(ip);
    if (!f) return 0;
    const restante = f.desde + VENTANA_MS - ahora();
    if (restante <= 0) { fallos.delete(ip); return 0; }
    return f.cuenta >= MAX_FALLOS ? restante : 0;
  }

  function anotarFallo(ip: string) {
    const f = fallos.get(ip);
    if (!f || ahora() - f.desde >= VENTANA_MS) fallos.set(ip, { cuenta: 1, desde: ahora() });
    else f.cuenta++;
  }

  function sesionValida(req: Request): string | null {
    const id = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE];
    if (typeof id !== "string" || id.length < 40 || id.length > 100) return null;
    const h = sha256(id).toString("hex");
    const expira = sesiones.get(h);
    if (expira === undefined) return null;
    if (expira <= ahora()) { sesiones.delete(h); return null; }
    return h;
  }

  /* Las escrituras del panel solo pueden salir del propio sitio. SameSite=Strict ya
     impide que otro sitio mande la cookie, pero www.entimotors.com y los subdominios
     de entimotors.com son el MISMO sitio para SameSite: por eso además se exige que
     el Origin sea exactamente https://<este host>. Sin Origin (curl) no hay navegador
     que falsificar.

     Se usa la cabecera Host literal, NUNCA req.host/req.hostname: con trust proxy,
     Express 5 los toma de X-Forwarded-Host, que cualquiera puede escribir. Tampoco
     se mira X-Forwarded-Proto: el esquema se exige al propio Origin (https, salvo
     loopback o desarrollo por http). Un Host ausente, raro o distinto del Origin
     cierra la puerta (403). */
  function origenPermitido(req: Request): boolean {
    const host = req.get("host")?.toLowerCase();
    if (!host || !HOST_VALIDO.test(host)) return false;
    const sitio = req.get("sec-fetch-site");
    if (sitio && sitio !== "same-origin" && sitio !== "none") return false;
    const origin = req.get("origin");
    if (origin === undefined) return true;
    let url: URL;
    try { url = new URL(origin); } catch { return false; }             // "null" y basura no son URL
    if (url.origin !== origin) return false;                           // con ruta, puerto por defecto, mayúsculas…
    if (url.host !== host) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && (!COOKIE_SEGURA || LOOPBACK.has(url.hostname)));
  }

  const router = Router();

  router.post("/admin/login", (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    limpiar();
    const ip = req.ip ?? "desconocida";
    const espera = bloqueada(ip);
    if (espera > 0) {
      logger.warn({ evento: "login-admin-bloqueado", ip }, "demasiados intentos de login admin");
      res.set("Retry-After", String(Math.ceil(espera / 1000)));
      res.status(429).json({ error: "Demasiados intentos. Espera unos minutos y vuelve a probar." });
      return;
    }
    if (!claveCorrecta((req.body as { password?: unknown } | undefined)?.password)) {
      anotarFallo(ip);
      logger.warn({ evento: "login-admin-fallido", ip }, "login admin rechazado");
      res.status(401).json({ error: "No se pudo iniciar sesión." });
      return;
    }
    fallos.delete(ip);
    if (sesiones.size >= MAX_SESIONES) {
      const masVieja = [...sesiones.entries()].sort((a, b) => a[1] - b[1])[0];
      if (masVieja) sesiones.delete(masVieja[0]);
    }
    const id = randomBytes(32).toString("base64url");
    const expiraEn = ahora() + SESION_MS;
    sesiones.set(sha256(id).toString("hex"), expiraEn);
    res.cookie(COOKIE, id, { ...atributos(), maxAge: SESION_MS });
    logger.info({ evento: "login-admin" }, "sesión admin iniciada");
    res.json({ success: true, expiraEn: new Date(expiraEn).toISOString() });
  });

  router.post("/admin/logout", (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const h = sesionValida(req);
    if (h) sesiones.delete(h);
    res.clearCookie(COOKIE, atributos());
    res.json({ success: true });
  });

  router.get("/admin/sesion", (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const h = sesionValida(req);
    if (!h) { res.status(401).json({ error: "No autorizado" }); return; }
    res.json({ autenticado: true, expiraEn: new Date(sesiones.get(h)!).toISOString() });
  });

  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    res.set("Cache-Control", "no-store");
    if (!sesionValida(req)) {
      res.status(401).json({ error: "No autorizado" });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !origenPermitido(req)) {
      res.status(403).json({ error: "Origen no permitido" });
      return;
    }
    next();
  }

  return { router, requireAdmin };
}

// Sin fallback: si ADMIN_PASSWORD no está configurada en el entorno, no existe
// ninguna credencial válida — el login y requireAdmin rechazan todo en vez de
// autenticar contra un valor por defecto conocido.
const auth = crearAuthAdmin({ password: process.env.ADMIN_PASSWORD });

export const requireAdmin = auth.requireAdmin;
export default auth.router;
