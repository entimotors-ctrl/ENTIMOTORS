import { Router, type Request, type Response, type NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";
import { logger } from "../lib/logger.js";
import { crearServicioPin, configPin, type AccesoPin, type Solicitante } from "../lib/pin.js";
import { crearVerificadorClaveCuenta } from "../lib/clave-cuenta.js";

/* ============================================================================
 * PIN ADMINISTRATIVO (D-7). Ver lib/pin.ts para el diseño y taller-demo/supabase/sync/sync-3p-pin.sql para los límites.
 *
 *   GET    /api/admin/pin/estado        admin   ¿hay PIN? versión, bloqueo. Nunca el hash.
 *   PUT    /api/admin/pin               admin   establecer/cambiar (re-autenticación con PIN actual o contraseña de la cuenta)
 *   DELETE /api/admin/pin               admin   desactivar (fail-closed: sin PIN ninguna acción con PIN es posible)
 *   POST   /api/admin/pin/desbloquear   admin   levantar un bloqueo y reiniciar contadores
 *   POST   /api/autorizaciones          cajero  el admin teclea el PIN; se emite una autorización de un solo uso
 *
 * Todas usan token Bearer (no cookies). Nada del cuerpo se registra en logs. Sin ADMIN_PIN_PEPPER responden 503.
 * ==========================================================================*/

const SUPABASE_URL = process.env["SUPABASE_URL"];
const SERVICE_KEY = process.env["SUPABASE_SERVICE_KEY"];
const ANON_KEY = process.env["SUPABASE_ANON_KEY"];

if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY");

const servidor: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws },
});

const router = Router();

function pepper(): string | null {
  const p = process.env["ADMIN_PIN_PEPPER"];
  return typeof p === "string" && p.length >= 32 ? p : null;
}

/** Contraseña de la cuenta (Supabase Auth). Se usa solo para re-autenticar al admin; nunca se guarda ni se registra.
    Comprueba que la cuenta verificada sea la del admin y cierra la sesión temporal que crea el login (SECURITY-1B): ver lib/clave-cuenta.ts.
    `fetch` se lee en cada llamada (no se fija al cargar el módulo). */
const verificarClaveCuenta = crearVerificadorClaveCuenta({
  url: SUPABASE_URL, anon: ANON_KEY, log: logger,
  fetch: ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)) as typeof fetch,
});

const acceso: AccesoPin = {
  async estado() {
    const { data, error } = await servidor.from("admin_pin").select("perfil_id, version, actualizado_en, bloqueado_hasta").order("actualizado_en", { ascending: false }).limit(1);
    if (error) throw new Error("estado: " + error.message);
    const f = data?.[0];
    return { configurado: !!f, version: f?.version ?? null, actualizado_en: f?.actualizado_en ?? null, bloqueado_hasta: f?.bloqueado_hasta ?? null, admin_id: f?.perfil_id ?? null };
  },
  async leerHash(adminId) {
    const { data, error } = await servidor.from("admin_pin").select("hash").eq("perfil_id", adminId).maybeSingle();
    if (error) throw new Error("leerHash: " + error.message);
    return data?.hash ?? null;
  },
  async guardar(adminId, hash, por) {
    const { data, error } = await servidor.rpc("pin_guardar", { p_admin: adminId, p_hash: hash, p_por: por });
    if (error) throw new Error("guardar: " + error.message);
    return Number(data);
  },
  async borrar(adminId) {
    const { error } = await servidor.from("admin_pin").delete().eq("perfil_id", adminId);
    if (error) throw new Error("borrar: " + error.message);
  },
  async desbloquear(adminId) {
    const { error } = await servidor.rpc("pin_desbloquear", { p_admin: adminId });
    if (error) throw new Error("desbloquear: " + error.message);
  },
  async reservar(sol, device, accion, entidad, registro, cfg) {
    const { data, error } = await servidor.rpc("pin_reservar_intento", {
      p_solicitante: sol, p_device: device, p_accion: accion, p_entidad: entidad, p_registro: registro,
      p_max_solicitante: cfg.maxFallosSolicitante, p_max_global: cfg.maxFallosGlobal, p_ventana_min: cfg.ventanaMin,
      p_bloqueo_min: cfg.bloqueoMin, p_max_bloqueos_24h: cfg.maxBloqueos24h,
    });
    if (error) throw new Error("reservar: " + error.message);
    return data as Record<string, unknown>;
  },
  async resultado(sol, device, accion, entidad, registro, res) {
    const { error } = await servidor.from("admin_pin_intentos").insert({ solicitante_id: sol, device_id: device, accion, entidad, registro_id: registro, resultado: res });
    if (error) throw new Error("resultado: " + error.message);
  },
  async emitir(sol, admin, accion, entidad, registro, device, version, payloadHash, ttl) {
    const { data, error } = await servidor.rpc("pin_emitir_autorizacion", {
      p_solicitante: sol.id, p_rol: sol.rol, p_admin: admin, p_accion: accion, p_entidad: entidad, p_registro: registro,
      p_device: device, p_pin_version: version, p_payload_hash: payloadHash, p_ttl_seg: ttl,
    });
    if (error) throw new Error(error.message);
    return data as { autorizacion_id: string; expira_en: string };
  },
};

interface PeticionPin extends Request { quien?: Solicitante }

function cabecerasSeguras(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

function exigirConfiguracion(_req: Request, res: Response, next: NextFunction): void {
  if (!pepper()) {
    logger.error("falta ADMIN_PIN_PEPPER (32+ caracteres): las autorizaciones con PIN quedan apagadas");
    res.status(503).json({ error: "Las autorizaciones con PIN no están configuradas en el servidor.", codigo: "PIN_NO_CONFIGURADO_EN_SERVIDOR" });
    return;
  }
  next();
}

/** La identidad sale del token y el rol de `perfiles`; jamás de lo que diga el navegador. */
async function identificar(req: PeticionPin, res: Response, next: NextFunction): Promise<void> {
  try {
    const cab = req.headers.authorization ?? "";
    const token = cab.startsWith("Bearer ") ? cab.slice(7).trim() : "";
    if (!token) { res.status(401).json({ error: "Hace falta iniciar sesión.", codigo: "SIN_SESION" }); return; }
    const { data, error } = await servidor.auth.getUser(token);
    if (error || !data?.user) { res.status(401).json({ error: "La sesión no es válida o ha caducado.", codigo: "SESION_INVALIDA" }); return; }
    const { data: perfil, error: errPerfil } = await servidor.from("perfiles").select("id, nombre, rol, activo").eq("id", data.user.id).maybeSingle();
    if (errPerfil) throw new Error("perfil: " + errPerfil.message);
    if (!perfil || perfil.activo !== true) { res.status(403).json({ error: "Tu cuenta no está activa.", codigo: "CUENTA_INACTIVA" }); return; }
    req.quien = { id: perfil.id, rol: perfil.rol, nombre: perfil.nombre, activo: true, correo: data.user.email ?? "" };
    next();
  } catch (e) {
    logger.error({ codigo: "pin-identificar", mensaje: e instanceof Error ? e.message : "error" }, "no se pudo identificar");
    res.status(500).json({ error: "No se pudo comprobar la sesión.", codigo: "ERROR_INTERNO" });
  }
}

function exigirAdmin(req: PeticionPin, res: Response, next: NextFunction): void {
  if (req.quien?.rol !== "admin") { res.status(403).json({ error: "Solo el administrador.", codigo: "SOLO_ADMIN" }); return; }
  next();
}

function cuerpoRazonable(req: Request, res: Response, next: NextFunction): void {
  const b = req.body;
  if (b !== undefined && b !== null && (typeof b !== "object" || Array.isArray(b) || JSON.stringify(b).length > 4096)) {
    res.status(400).json({ error: "Cuerpo inválido.", codigo: "CUERPO_INVALIDO" });
    return;
  }
  next();
}

/** Ejecuta un caso del servicio y traduce su resultado; un fallo interno no filtra detalles (ni el cuerpo). */
function servir(caso: (q: Solicitante, body: Record<string, unknown>) => Promise<{ status: number; cuerpo: Record<string, unknown>; cabeceras?: Record<string, string> }>) {
  return async (req: PeticionPin, res: Response): Promise<void> => {
    try {
      const r = await caso(req.quien as Solicitante, (req.body ?? {}) as Record<string, unknown>);
      for (const [k, v] of Object.entries(r.cabeceras ?? {})) res.setHeader(k, v);
      res.status(r.status).json(r.cuerpo);
    } catch (e) {
      logger.error({ codigo: "pin-error", mensaje: e instanceof Error ? e.message : "error" }, "fallo en una ruta del PIN");
      res.status(500).json({ error: "No se pudo completar la operación.", codigo: "ERROR_INTERNO" });
    }
  };
}

const svc = () => crearServicioPin({ acceso, pepper: pepper() as string, cfg: configPin(), verificarClaveCuenta });

const base = [cabecerasSeguras, exigirConfiguracion, cuerpoRazonable, identificar];
router.get("/admin/pin/estado", ...base, exigirAdmin, servir(() => svc().estado()));
router.put("/admin/pin", ...base, exigirAdmin, servir((q, b) => svc().establecer(q, b)));
router.delete("/admin/pin", ...base, exigirAdmin, servir((q, b) => svc().eliminar(q, b)));
router.post("/admin/pin/desbloquear", ...base, exigirAdmin, servir((q) => svc().desbloquear(q)));
router.post("/autorizaciones", ...base, servir((q, b) => svc().autorizar(q, b)));

export default router;
