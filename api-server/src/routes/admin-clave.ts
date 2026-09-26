import { Router, type Request, type Response, type NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";
import { logger } from "../lib/logger.js";
import { crearVerificadorClaveCuenta } from "../lib/clave-cuenta.js";
import { crearServicioClaveAdmin, crearGotrueClave, configClave, type AdminClave } from "../lib/clave-admin.js";

/* ============================================================================
 * PUT /api/admin/clave — el ADMINISTRADOR cambia la contraseña de SU cuenta del Taller (Supabase Auth). SECURITY-1D.
 *   Cuerpo: { clave_actual, clave_nueva, clave_confirmacion } (exactamente esos tres; la identidad sale SOLO del Bearer)
 *   Orden y fallos parciales: lib/clave-admin.ts. Límite de intentos: SECURITY-1C (clave_reservar_intento / clave_resolver_intento).
 *   CORS restringido (RUTAS_SENSIBLES), Content-Type application/json, cuerpo ≤ 2 KB, Cache-Control: no-store.
 *   Nada del cuerpo se registra (y logger.ts redacta clave_actual/clave_nueva/clave_confirmacion por si acaso).
 * ==========================================================================*/

const SUPABASE_URL = process.env["SUPABASE_URL"];
const SERVICE_KEY = process.env["SUPABASE_SERVICE_KEY"];
const ANON_KEY = process.env["SUPABASE_ANON_KEY"];
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY");

const servidor: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws },
});
const fetchVivo = ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)) as typeof fetch;   // se lee en cada llamada
const MAX_CUERPO = 2048;

const comprobador = crearVerificadorClaveCuenta({ url: SUPABASE_URL, anon: ANON_KEY, log: logger, fetch: fetchVivo });
const gotrue = crearGotrueClave({ url: SUPABASE_URL, anon: ANON_KEY, log: logger, fetch: fetchVivo });
const cfg = configClave();

const servicio = crearServicioClaveAdmin({
  comprobar: (admin, clave) => comprobador.comprobar(admin, clave),
  cambiar: (t, nueva) => gotrue.cambiar(t, nueva),
  cerrarOtras: (t) => gotrue.cerrarOtras(t),
  async reservar(adminId, c) {
    const { data, error } = await servidor.rpc("clave_reservar_intento", { p_perfil: adminId, p_max: c.max, p_ventana_min: c.ventanaMin, p_bloqueo_min: c.bloqueoMin, p_ttl_seg: c.ttlSeg });
    if (error) throw new Error("reservar");
    return data as Record<string, unknown>;
  },
  async resolver(adminId, intentoId, resultado, c) {
    const { data, error } = await servidor.rpc("clave_resolver_intento", { p_perfil: adminId, p_intento: intentoId, p_resultado: resultado, p_max: c.max, p_ventana_min: c.ventanaMin, p_bloqueo_min: c.bloqueoMin });
    if (error) throw new Error("resolver");
    return data as Record<string, unknown>;
  },
  async auditar(fila) {
    const { error } = await servidor.from("auditoria").insert(fila);
    if (error) throw new Error("auditar");
  },
  log: logger,
  cfg,
});

interface PeticionClave extends Request { admin?: AdminClave; tokenS1?: string }

function cabecerasSeguras(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

/** Content-Type JSON y tamaño razonable, ANTES de mirar la sesión (el cuerpo ya lo parseó express.json). */
function cuerpoAdmitido(req: Request, res: Response, next: NextFunction): void {
  const largo = Number(req.headers["content-length"]);
  if (!req.is("application/json") || (Number.isFinite(largo) && largo > MAX_CUERPO)) {
    res.status(400).json({ error: "Cuerpo inválido.", codigo: "CUERPO_INVALIDO" });
    return;
  }
  next();
}

/** Identidad SOLO del Bearer (GoTrue getUser) y perfil activo de rol admin (de la base). Nada del cuerpo. Todo antes de reservar. */
async function soloAdmin(req: PeticionClave, res: Response, next: NextFunction): Promise<void> {
  try {
    const cab = req.headers.authorization ?? "";
    const token = cab.startsWith("Bearer ") ? cab.slice(7).trim() : "";
    if (!token) { res.status(401).json({ error: "Hace falta iniciar sesión.", codigo: "SIN_SESION" }); return; }
    const { data, error } = await servidor.auth.getUser(token);
    if (error || !data?.user) {
      // GoTrue caído (sin estado, 5xx, 429) no es «sesión inválida»: 503 y ni se llega a reservar (no se castiga a nadie)
      const st = Number((error as { status?: unknown } | null)?.status);
      if (error && (!Number.isFinite(st) || st === 0 || st >= 500 || st === 429)) {
        res.status(503).json({ error: "El servicio de cuentas no respondió. Inténtalo de nuevo en unos minutos.", codigo: "AUTH_NO_DISPONIBLE" }); return;
      }
      res.status(401).json({ error: "La sesión no es válida o ha caducado.", codigo: "SESION_INVALIDA" }); return;
    }
    const { data: perfil, error: errPerfil } = await servidor.from("perfiles").select("id, nombre, rol, activo").eq("id", data.user.id).maybeSingle();
    if (errPerfil) throw new Error("perfil");
    if (!perfil || perfil.activo !== true) { res.status(403).json({ error: "Tu cuenta no está activa.", codigo: "CUENTA_INACTIVA" }); return; }
    if (perfil.rol !== "admin") { res.status(403).json({ error: "Solo el administrador.", codigo: "SOLO_ADMIN" }); return; }
    req.admin = { id: perfil.id, nombre: perfil.nombre ?? "", correo: data.user.email ?? "" };
    req.tokenS1 = token;
    next();
  } catch {
    logger.error({ evento: "clave-identificar-fallo" }, "no se pudo comprobar la sesión");
    res.status(500).json({ error: "No se pudo completar la operación.", codigo: "ERROR_INTERNO" });
  }
}

const router = Router();
router.put("/admin/clave", cabecerasSeguras, cuerpoAdmitido, soloAdmin, async (req: PeticionClave, res: Response): Promise<void> => {
  try {
    const r = await servicio.cambiar(req.admin as AdminClave, req.tokenS1 as string, req.body);
    for (const [k, v] of Object.entries(r.cabeceras ?? {})) res.setHeader(k, v);
    res.status(r.status).json(r.cuerpo);
  } catch {
    logger.error({ evento: "clave-error" }, "fallo en el cambio de contraseña");
    res.status(500).json({ error: "No se pudo completar la operación.", codigo: "ERROR_INTERNO" });
  }
});

export default router;
