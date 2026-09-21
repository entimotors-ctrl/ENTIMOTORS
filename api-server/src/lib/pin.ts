/* PIN ADMINISTRATIVO (D-7) — lógica pura, sin Express ni Supabase: se inyecta el acceso a datos.

   SEGURIDAD
   · El PIN se valida SOLO aquí (servidor). Nunca se guarda, ni en texto plano ni parcial, y no se escribe en logs.
   · Se guarda únicamente scrypt(HMAC-SHA256(pin, ADMIN_PIN_PEPPER), sal). El pepper vive solo en una variable secreta de
     Render: si se filtra la base de datos, el hash solo no basta para probar los 10^6 PIN posibles.
   · El límite de intentos es persistente y lo decide la base (candado + reserva ANTES de verificar): ver sync-3p-pin.sql.
   · La autorización que se emite es de un solo uso, dura TTL segundos (hora de la base) y va ligada a
     solicitante + acción + entidad + registro + dispositivo + versión del PIN (+ hash del monto cuando aplica). */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Acciones que un cajero puede pedir con PIN. Ninguna es elevable para un mecánico ni para el desarrollador (Q-2). */
export const ACCIONES_CON_PIN: Record<string, { entidad: string; roles: string[] }> = {
  ajustar_stock: { entidad: "inventario", roles: ["cajero"] },
  reversar_venta: { entidad: "ventas", roles: ["cajero"] },
  registrar_devolucion: { entidad: "ventas", roles: ["cajero"] },
  reversar_abono: { entidad: "abonos", roles: ["cajero"] },
  reversar_credito: { entidad: "creditos", roles: ["cajero"] },
  reversar_caja: { entidad: "caja_movimientos", roles: ["cajero"] },
  anular_orden: { entidad: "ordenes", roles: ["cajero"] },
};

export interface ConfigPin {
  ttlSegundos: number;
  maxFallosSolicitante: number;
  maxFallosGlobal: number;
  ventanaMin: number;
  bloqueoMin: number;
  maxBloqueos24h: number;
  N: number;
  r: number;
  p: number;
}

function numero(env: Record<string, string | undefined>, nombre: string, defecto: number, min: number, max: number): number {
  const v = Number(env[nombre]);
  return Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : defecto;
}

/** Valores por defecto de Q-6. Se pueden ajustar por variable de entorno del servidor; nunca viajan al navegador. */
export function configPin(env: Record<string, string | undefined> = process.env): ConfigPin {
  return {
    ttlSegundos: numero(env, "PIN_TTL_SEGUNDOS", 90, 10, 300),
    maxFallosSolicitante: numero(env, "PIN_MAX_FALLOS_SOLICITANTE", 5, 1, 20),
    maxFallosGlobal: numero(env, "PIN_MAX_FALLOS_GLOBAL", 10, 1, 100),
    ventanaMin: numero(env, "PIN_VENTANA_MIN", 15, 1, 1440),
    bloqueoMin: numero(env, "PIN_BLOQUEO_MIN", 15, 1, 1440),
    maxBloqueos24h: numero(env, "PIN_MAX_BLOQUEOS_24H", 3, 1, 20),
    N: numero(env, "PIN_SCRYPT_N", 32768, 1024, 1048576),
    r: 8,
    p: 1,
  };
}

/** Exactamente 6 dígitos. */
export function pinConFormato(pin: unknown): pin is string {
  return typeof pin === "string" && /^[0-9]{6}$/.test(pin);
}

const PROHIBIDOS = new Set(["000000", "123456", "654321", "121212", "112233", "123123", "159753", "696969", "111222", "123321", "000001", "010101"]);

/** PIN evidente: repetido, escalera, periodo corto repetido o de la lista negra. */
export function pinDebil(pin: string): boolean {
  if (PROHIBIDOS.has(pin)) return true;
  if (/^(\d)\1{5}$/.test(pin)) return true;                       // 777777
  const d = pin.split("").map(Number);
  const paso = d[1] - d[0];
  if ((paso === 1 || paso === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === paso)) return true;   // 234567 / 987654
  if (/^(\d\d)\1\1$/.test(pin) || /^(\d\d\d)\1$/.test(pin)) return true;                                  // 121212 / 123123
  if (/^(\d)\1(\d)\2(\d)\3$/.test(pin)) return true;                                                      // 112233
  return false;
}

function derivar(clave: Buffer, sal: Buffer, cfg: ConfigPin): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(clave, sal, 32, { N: cfg.N, r: cfg.r, p: cfg.p, maxmem: 256 * 1024 * 1024 }, (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}
const prefirma = (pin: string, pepper: string): Buffer => createHmac("sha256", pepper).update(pin, "utf8").digest();

/** scrypt$N$r$p$sal$hash (base64). Los parámetros van dentro para poder endurecerlos sin invalidar PIN existentes. */
export async function hashearPin(pin: string, pepper: string, cfg: ConfigPin = configPin()): Promise<string> {
  const sal = randomBytes(16);
  const dk = await derivar(prefirma(pin, pepper), sal, cfg);
  return `scrypt$${cfg.N}$${cfg.r}$${cfg.p}$${sal.toString("base64")}$${dk.toString("base64")}`;
}

/** Comparación en tiempo constante. Un hash mal formado o un PIN sin formato dan false, nunca una excepción. */
export async function verificarPin(pin: unknown, pepper: string, almacenado: unknown): Promise<boolean> {
  if (!pinConFormato(pin) || typeof almacenado !== "string") return false;
  const partes = almacenado.split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return false;
  const N = Number(partes[1]), r = Number(partes[2]), p = Number(partes[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 1024 || N > 1048576 || r < 1 || r > 32 || p < 1 || p > 4) return false;
  try {
    const sal = Buffer.from(partes[4], "base64");
    const esperado = Buffer.from(partes[5], "base64");
    if (sal.length < 8 || esperado.length !== 32) return false;
    const dk = await derivar(prefirma(pin, pepper), sal, { ...configPin({}), N, r, p });
    return timingSafeEqual(dk, esperado);
  } catch {
    return false;
  }
}

/** Idéntico a public.sync_hash_critico(accion, registro, monto) de SQL: md5(accion|registro|monto con 2 decimales). */
export function hashCritico(accion: string, registro: string, monto?: number | null): string {
  let m = Math.round((Number(monto ?? 0) + Number.EPSILON) * 100) / 100;
  if (Object.is(m, -0)) m = 0;
  return createHash("md5").update(`${accion}|${registro.toLowerCase()}|${m.toFixed(2)}`, "utf8").digest("hex");
}

/* ───────────────────────── servicio ───────────────────────── */
export interface Solicitante { id: string; rol: string; nombre: string; activo: boolean; correo: string }
export interface AccesoPin {
  estado(): Promise<{ configurado: boolean; version: number | null; actualizado_en: string | null; bloqueado_hasta: string | null; admin_id: string | null }>;
  leerHash(adminId: string): Promise<string | null>;
  guardar(adminId: string, hash: string, actualizadoPor: string): Promise<number>;
  borrar(adminId: string): Promise<void>;
  desbloquear(adminId: string): Promise<void>;
  reservar(sol: string, device: string | null, accion: string, entidad: string, registro: string | null, cfg: ConfigPin): Promise<Record<string, unknown>>;
  resultado(sol: string | null, device: string | null, accion: string | null, entidad: string | null, registro: string | null, res: string): Promise<void>;
  emitir(sol: Solicitante, admin: string, accion: string, entidad: string, registro: string, device: string | null, version: number, payloadHash: string | null, ttl: number): Promise<{ autorizacion_id: string; expira_en: string }>;
}
export interface Salida { status: number; cuerpo: Record<string, unknown>; cabeceras?: Record<string, string> }

const err = (status: number, codigo: string, mensaje: string, extra: Record<string, unknown> = {}, cabeceras?: Record<string, string>): Salida => ({ status, cuerpo: { error: mensaje, codigo, ...extra }, cabeceras });

export function crearServicioPin(dep: { acceso: AccesoPin; pepper: string; cfg?: ConfigPin; verificarClaveCuenta: (correo: string, clave: string) => Promise<boolean> }) {
  const { acceso, pepper } = dep;
  const cfg = dep.cfg ?? configPin();

  /** Reserva un intento (con límites) y verifica el PIN. Devuelve null si el PIN es correcto o la respuesta de rechazo. */
  async function comprobar(sol: Solicitante, pin: string, device: string | null, accion: string, entidad: string, registro: string | null): Promise<{ salida: Salida | null; adminId?: string; version?: number }> {
    const r = await acceso.reservar(sol.id, device, accion, entidad, registro, cfg);
    if (r.permitido !== true) {
      const motivo = String(r.motivo ?? "");
      if (motivo === "sin_pin") return { salida: err(409, "SIN_PIN", "El administrador todavía no configuró el PIN de autorización.") };
      if (motivo === "cuenta_inactiva") return { salida: err(403, "CUENTA_INACTIVA", "La cuenta del administrador no está activa.") };
      if (motivo === "bloqueado_admin") return { salida: err(423, "BLOQUEADO_ADMIN", "Las autorizaciones están bloqueadas. El administrador debe desbloquearlas desde Ajustes.") };
      const seg = Number(r.reintentar_en_s ?? cfg.bloqueoMin * 60);
      return { salida: err(429, motivo === "bloqueado_global" ? "BLOQUEADO_GLOBAL" : "BLOQUEADO_SOLICITANTE", "Demasiados intentos. Espera unos minutos.", { reintentar_en_s: seg }, { "Retry-After": String(seg) }) };
    }
    const correcto = await verificarPin(pin, pepper, r.hash);
    await acceso.resultado(sol.id, device, accion, entidad, registro, correcto ? "ok" : "pin_incorrecto");
    if (!correcto) return { salida: err(401, "PIN_INCORRECTO", "PIN incorrecto.", { intentos_restantes: Number(r.intentos_restantes ?? 0) }) };
    return { salida: null, adminId: String(r.admin_id), version: Number(r.pin_version) };
  }

  return {
    /** POST /api/autorizaciones — un trabajador (cajero) pide autorización; el admin teclea el PIN. */
    async autorizar(sol: Solicitante, body: Record<string, unknown>): Promise<Salida> {
      if (!sol.activo) return err(403, "CUENTA_INACTIVA", "Tu cuenta está dada de baja.");
      const accion = typeof body.accion === "string" ? body.accion : "";
      const def = Object.prototype.hasOwnProperty.call(ACCIONES_CON_PIN, accion) ? ACCIONES_CON_PIN[accion] : undefined;
      if (!def) return err(400, "ACCION_DESCONOCIDA", "Acción no reconocida.");
      if (body.entidad !== def.entidad) return err(400, "ENTIDAD_INVALIDA", "La entidad no corresponde a la acción.");
      if (typeof body.registro_id !== "string" || !UUID.test(body.registro_id)) return err(400, "REGISTRO_INVALIDO", "Falta el registro afectado.");
      if (body.device_id !== undefined && (typeof body.device_id !== "string" || body.device_id.length > 100)) return err(400, "DISPOSITIVO_INVALIDO", "device_id inválido.");
      if (body.monto !== undefined && body.monto !== null && (typeof body.monto !== "number" || !Number.isFinite(body.monto) || Math.abs(body.monto) > 1e9)) return err(400, "MONTO_INVALIDO", "monto inválido.");
      if (!pinConFormato(body.pin)) return err(400, "PIN_INVALIDO", "El PIN son 6 dígitos.");
      const device = typeof body.device_id === "string" ? body.device_id : null;
      const registro = body.registro_id.toLowerCase();
      if (sol.rol === "admin") return err(400, "ADMIN_NO_NECESITA_PIN", "El administrador no necesita autorización.");
      if (!def.roles.includes(sol.rol)) {
        await acceso.resultado(sol.id, device, accion, def.entidad, registro, "no_permitido");
        return err(403, "NO_PERMITIDO", "Tu rol no puede pedir esta autorización.");
      }
      const c = await comprobar(sol, body.pin, device, accion, def.entidad, registro);
      if (c.salida) return c.salida;
      const hash = body.monto === undefined || body.monto === null ? null : hashCritico(accion, registro, body.monto as number);
      try {
        const a = await acceso.emitir(sol, c.adminId as string, accion, def.entidad, registro, device, c.version as number, hash, cfg.ttlSegundos);
        return { status: 201, cuerpo: { autorizacion_id: a.autorizacion_id, expira_en: a.expira_en, ttl_segundos: cfg.ttlSegundos } };
      } catch (e) {
        if (String((e as Error)?.message ?? "").includes("PIN_CAMBIADO")) return err(409, "PIN_CAMBIADO", "El PIN cambió mientras se verificaba. Inténtalo de nuevo.");
        throw e;
      }
    },

    async estado(): Promise<Salida> {
      const e = await acceso.estado();
      const bloqueado = e.bloqueado_hasta !== null && (e.bloqueado_hasta === "infinity" || new Date(e.bloqueado_hasta).getTime() > Date.now());
      return { status: 200, cuerpo: { configurado: e.configurado, version: e.version, actualizado_en: e.actualizado_en, bloqueado, bloqueado_hasta: e.bloqueado_hasta } };
    },

    /** Re-autenticación del admin para cambiar/quitar el PIN: el PIN actual (con límite de intentos) o la contraseña de su cuenta. */
    async reautenticar(admin: Solicitante, body: Record<string, unknown>, existe: boolean): Promise<Salida | null> {
      if (typeof body.clave_cuenta === "string" && body.clave_cuenta.length > 0 && body.clave_cuenta.length <= 200) {
        return (await dep.verificarClaveCuenta(admin.correo, body.clave_cuenta)) ? null : err(401, "CLAVE_INCORRECTA", "La contraseña de la cuenta no es correcta.");
      }
      if (existe && pinConFormato(body.pin_actual)) {
        const c = await comprobar(admin, body.pin_actual, null, "cambiar_pin", "admin_pin", null);
        return c.salida;
      }
      return err(400, "REAUTENTICACION_REQUERIDA", existe ? "Confirma con tu PIN actual o con la contraseña de tu cuenta." : "Confirma con la contraseña de tu cuenta.");
    },

    async establecer(admin: Solicitante, body: Record<string, unknown>): Promise<Salida> {
      if (!pinConFormato(body.pin_nuevo)) return err(400, "PIN_INVALIDO", "El PIN son 6 dígitos.");
      if (pinDebil(body.pin_nuevo)) return err(400, "PIN_DEBIL", "Ese PIN es demasiado fácil de adivinar. Elige otro.");
      const e = await acceso.estado();
      const rechazo = await this.reautenticar(admin, body, e.configurado);
      if (rechazo) return rechazo;
      const hash = await hashearPin(body.pin_nuevo, pepper, cfg);
      const version = await acceso.guardar(admin.id, hash, admin.id);
      return { status: 200, cuerpo: { ok: true, version } };
    },

    async eliminar(admin: Solicitante, body: Record<string, unknown>): Promise<Salida> {
      const e = await acceso.estado();
      if (!e.configurado) return { status: 200, cuerpo: { ok: true, configurado: false } };
      const rechazo = await this.reautenticar(admin, body, true);
      if (rechazo) return rechazo;
      await acceso.borrar(admin.id);
      return { status: 200, cuerpo: { ok: true, configurado: false } };
    },

    async desbloquear(admin: Solicitante): Promise<Salida> {
      await acceso.desbloquear(admin.id);
      return { status: 200, cuerpo: { ok: true } };
    },
  };
}
