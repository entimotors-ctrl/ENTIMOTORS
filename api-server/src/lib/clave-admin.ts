/* CAMBIO DE CONTRASEÑA DEL ADMINISTRADOR (SECURITY-1D) — lógica pura: sin Express ni supabase-js (todo se inyecta).
   La contraseña vive SOLO en Supabase Auth (GoTrue). Aquí no se guarda, no se registra, no se devuelve y no se transforma.

   COMPORTAMIENTO REAL de GoTrue v2.189.0 (medido en el laboratorio, no supuesto):
   · PUT /auth/v1/user {password} con el token de una sesión revoca TODAS las demás sesiones del usuario y conserva ESA.
     Por eso el cambio se hace con S1 (el Bearer de la petición) y NUNCA con la sesión temporal T de la verificación
     (con T, GoTrue conservaría T y cerraría la del admin).
   · Después, POST /auth/v1/logout?scope=others con S1 → 204: confirmación explícita (ya no queda ninguna otra).
   · 422 weak_password · 422 same_password · 400 validation_failed (más de 72 bytes) · con secure_password_change activo y una
     sesión de más de 24 h: 400 reauthentication_needed.

   ORDEN (el de la especificación, con UN cambio documentado: la política local de la contraseña nueva se valida ANTES de reservar;
   no depende de ningún secreto verificado, así un error local no gasta intento, no crea sesión temporal y no llama a GoTrue):
     body → política local → reservar (SECURITY-1C) → verificar actual con T (identidad + cierre de T) → cambiar con S1 →
     scope=others con S1 → resolver 'ok' → auditoría → 200.
   Resolución de la reserva: contraseña actual incorrecta (o de otra cuenta) → 'fallido'; sin respuesta concluyente del proveedor
   (red, timeout, 5xx, 429, reautenticación exigida, S1 caducada) → 'anulado' (no cuenta); actual correcta → 'ok' (aunque GoTrue
   rechace la nueva por débil/igual: la actual quedó demostrada).
   DESPUÉS de que GoTrue confirmó el cambio nada se reintenta ni se convierte en error de contraseña: un fallo de scope=others, del
   resolver o de la auditoría se registra (sin secretos) y la respuesta sigue siendo éxito. Si el PUT termina SIN respuesta clara
   (red/timeout/5xx) el cambio pudo ocurrir: 503 con estado_cambio «desconocido», reserva 'anulado', auditoría 'incierto'. */

export interface AdminClave { id: string; correo: string; nombre: string }
export interface LogClave { info(o: Record<string, unknown>, m: string): void; warn(o: Record<string, unknown>, m: string): void; error(o: Record<string, unknown>, m: string): void }
export interface Salida { status: number; cuerpo: Record<string, unknown>; cabeceras?: Record<string, string> }
export type ResultadoComprobacion = "ok" | "incorrecta" | "no_disponible" | "identidad_distinta";
export type ResultadoCambio = "ok" | "debil" | "igual" | "reautenticar" | "sesion_invalida" | "no_aplicado" | "desconocido";
export interface ConfigClave { max: number; ventanaMin: number; bloqueoMin: number; ttlSeg: number }

function numero(env: Record<string, string | undefined>, n: string, def: number, min: number, max: number): number {
  const v = Number(env[n]); return Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : def;
}
/** Política de SECURITY-1C (5 / 15 min / 15 min). TTL de la reserva: más que el peor caso del flujo (≈ 3 llamadas de 8 s + reintentos). */
export function configClave(env: Record<string, string | undefined> = process.env): ConfigClave {
  return { max: numero(env, "CLAVE_MAX_INTENTOS", 5, 1, 20), ventanaMin: numero(env, "CLAVE_VENTANA_MIN", 15, 1, 1440),
           bloqueoMin: numero(env, "CLAVE_BLOQUEO_MIN", 15, 1, 1440), ttlSeg: numero(env, "CLAVE_TTL_SEG", 90, 10, 600) };
}

/* ───────────────────────── política de la contraseña nueva (pura) ───────────────────────── */
export const MIN_CARACTERES = 12;
export const MAX_BYTES = 72;                   // límite de bcrypt en GoTrue (73 bytes → 400 validation_failed, medido)
/** Lista corta local de contraseñas comunes (comparación exacta tras normalizar). */
const normalizar = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export const COMUNES = new Set([
  "123456789012", "1234567890123", "12345678901234", "123456123456", "111111111111", "000000000000", "qwertyuiopas", "qwerty123456",
  "asdfghjklñzx", "password1234", "password12345", "passw0rd1234", "contraseña123", "contraseña1234", "contrasena123", "contrasena1234",
  "administrador", "administrador1", "admin1234567", "adminadmin12", "iloveyou1234", "welcome12345", "bienvenido123", "honduras1234",
  "motocicleta1", "motocicleta12", "tallermotos1", "taller123456", "letmein12345", "abcdefghijkl", "abc123abc123", "1q2w3e4r5t6y",
].map(normalizar));

function esTrivial(s: string): boolean {
  const c = [...normalizar(s).replace(/\s+/g, "")];
  if (c.length === 0) return true;
  if (new Set(c).size <= 2) return true;                                         // «aaaaaaaaaaaa», «abababababab»
  if (/^(.{1,4})\1+$/.test(c.join(""))) return true;                             // patrón corto repetido
  let pasos = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i].codePointAt(0)! - c[i - 1].codePointAt(0)!;
    const envuelve = /\d/.test(c[i]) && /\d/.test(c[i - 1]) && Math.abs(d) === 9;  // 9→0 / 0→9
    if (Math.abs(d) === 1 || envuelve) pasos++;
  }
  return pasos / (c.length - 1) >= 0.8;                                          // secuencias «123456789012», «abcdefghijkl»
}

export type ResultadoPolitica = { ok: true } | { ok: false; codigo: "CLAVE_DEBIL" | "CLAVE_IGUAL_A_LA_ACTUAL" };
/** Solo dice SI vale y por qué no; jamás devuelve ni registra la contraseña. */
export function politicaClave(nueva: string, ctx: { actual: string; nombre: string; correo: string }): ResultadoPolitica {
  if (typeof nueva !== "string") return { ok: false, codigo: "CLAVE_DEBIL" };
  if (nueva === ctx.actual) return { ok: false, codigo: "CLAVE_IGUAL_A_LA_ACTUAL" };
  if ([...nueva].length < MIN_CARACTERES || Buffer.byteLength(nueva, "utf8") > MAX_BYTES) return { ok: false, codigo: "CLAVE_DEBIL" };
  const n = normalizar(nueva), compacta = n.replace(/\s+/g, "");
  if (compacta.includes("entimotors")) return { ok: false, codigo: "CLAVE_DEBIL" };
  // el nombre completo se busca con los espacios quitados; cada PARTE del nombre, dentro de UNA palabra (si no, «pájaros azules»
  // contendría «rosa» al juntarse y una frase legítima saldría débil)
  const palabras = n.split(/[^a-z0-9]+/).filter(Boolean), alfanum = palabras.join("");
  const nombre = normalizar(ctx.nombre || "").replace(/[^a-z0-9]/g, "");
  if (nombre.length >= 3 && alfanum.includes(nombre)) return { ok: false, codigo: "CLAVE_DEBIL" };
  for (const parte of normalizar(ctx.nombre || "").split(/[^a-z0-9]+/)) if (parte.length >= 4 && palabras.some((w) => w.includes(parte))) return { ok: false, codigo: "CLAVE_DEBIL" };
  const usuario = normalizar((ctx.correo || "").split("@")[0] || "").replace(/[^a-z0-9]/g, "");
  if (usuario.length >= 5 && alfanum.includes(usuario)) return { ok: false, codigo: "CLAVE_DEBIL" };
  if (usuario.length >= 3 && usuario.length < 5 && palabras.some((w) => w.includes(usuario))) return { ok: false, codigo: "CLAVE_DEBIL" };
  if (COMUNES.has(compacta) || esTrivial(nueva)) return { ok: false, codigo: "CLAVE_DEBIL" };
  return { ok: true };
}

/* ───────────────────────── adaptador de GoTrue (fetch inyectado) ───────────────────────── */
export function crearGotrueClave(o: { url: string; anon: string | undefined; fetch?: typeof fetch; timeoutMs?: number; esperaReintentoMs?: number; log: LogClave }) {
  const f = o.fetch ?? globalThis.fetch;
  const base = o.url.replace(/\/+$/, "");
  const TIMEOUT = o.timeoutMs ?? 8000, ESPERA = o.esperaReintentoMs ?? 300;
  async function pedir(ruta: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT);
    try { return await f(base + ruta, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
  }
  return {
    /** PUT /auth/v1/user con el token de la sesión que llama (S1). Una sola vez: NUNCA se reintenta un cambio de contraseña. */
    async cambiar(tokenS1: string, nueva: string): Promise<ResultadoCambio> {
      let r: Response;
      try { r = await pedir("/auth/v1/user", { method: "PUT", headers: { apikey: o.anon as string, Authorization: `Bearer ${tokenS1}`, "Content-Type": "application/json" }, body: JSON.stringify({ password: nueva }) }); }
      catch { return "desconocido"; }                                            // red/timeout: pudo aplicarse
      if (r.ok) return "ok";
      const j = (await r.json().catch(() => null)) as { error_code?: unknown; code?: unknown } | null;
      const codigo = typeof j?.error_code === "string" ? j.error_code : typeof j?.code === "string" ? j.code : "";
      if (codigo === "weak_password" || codigo === "validation_failed") return "debil";
      if (codigo === "same_password") return "igual";
      if (codigo === "reauthentication_needed" || codigo === "reauthentication_not_valid") return "reautenticar";
      if (r.status === 401 || r.status === 403 || codigo === "session_not_found" || codigo === "bad_jwt") return "sesion_invalida";
      if (r.status === 429) return "no_aplicado";                                // rechazado antes de tocar nada
      if (r.status >= 500) return "desconocido";
      return r.status === 422 ? "debil" : "no_aplicado";
    },
    /** POST /auth/v1/logout?scope=others con S1: confirma que no queda ninguna otra sesión del admin. Un reintento ante red/5xx/429. */
    async cerrarOtras(tokenS1: string): Promise<boolean> {
      for (let intento = 1; intento <= 2; intento++) {
        try {
          const r = await pedir("/auth/v1/logout?scope=others", { method: "POST", headers: { apikey: o.anon as string, Authorization: `Bearer ${tokenS1}` } });
          if (r.ok) return true;
          if (r.status < 500 && r.status !== 429) return false;
        } catch { /* red: se reintenta una vez */ }
        if (intento === 1) await new Promise((res) => setTimeout(res, ESPERA));
      }
      return false;
    },
  };
}

/* ───────────────────────── servicio ───────────────────────── */
export interface DepClave {
  comprobar(admin: { id: string; correo: string }, clave: string): Promise<ResultadoComprobacion>;
  cambiar(tokenS1: string, nueva: string): Promise<ResultadoCambio>;
  cerrarOtras(tokenS1: string): Promise<boolean>;
  reservar(adminId: string, cfg: ConfigClave): Promise<Record<string, unknown>>;
  resolver(adminId: string, intentoId: number, resultado: "ok" | "fallido" | "anulado", cfg: ConfigClave): Promise<Record<string, unknown>>;
  auditar(fila: { usuario_id: string; usuario: string; rol: "admin"; accion: "cambio-clave-admin"; entidad: "cuenta"; entidad_id: string; detalle: string; resultado: "ok" | "incierto" }): Promise<void>;
  log: LogClave;
  cfg?: ConfigClave;
}

const err = (status: number, codigo: string, error: string, extra: Record<string, unknown> = {}, cabeceras?: Record<string, string>): Salida =>
  ({ status, cuerpo: { error, codigo, ...extra }, cabeceras });
const CAMPOS = ["clave_actual", "clave_nueva", "clave_confirmacion"];
const REINICIA = "Vuelve a iniciar sesión e inténtalo de nuevo.";
const NO_DISPONIBLE = "El servicio de cuentas no respondió. Inténtalo de nuevo en unos minutos.";

export function crearServicioClaveAdmin(dep: DepClave) {
  const cfg = dep.cfg ?? configClave();

  /** Resolver sin romper la respuesta: si falla, queda en el log (solo ids) y la reserva vence por TTL. Un reintento. */
  async function resolverSeguro(adminId: string, intentoId: number, r: "ok" | "fallido" | "anulado"): Promise<boolean> {
    for (let i = 0; i < 2; i++) { try { await dep.resolver(adminId, intentoId, r, cfg); return true; } catch { /* reintento */ } }
    dep.log.error({ evento: "clave-reserva-no-resuelta", intento_id: intentoId, resultado: r }, "no se pudo resolver la reserva del cambio de contraseña");
    return false;
  }
  async function auditarSeguro(admin: AdminClave, resultado: "ok" | "incierto", detalle: Record<string, unknown>, intentoId: number): Promise<boolean> {
    try {
      await dep.auditar({ usuario_id: admin.id, usuario: admin.nombre || "—", rol: "admin", accion: "cambio-clave-admin", entidad: "cuenta", entidad_id: admin.id, detalle: JSON.stringify(detalle), resultado });
      return true;
    } catch {
      dep.log.error({ evento: "auditoria-cambio-clave-no-registrada", intento_id: intentoId, resultado }, "no se pudo registrar la auditoría del cambio de contraseña");
      return false;
    }
  }

  return {
    async cambiar(admin: AdminClave, tokenS1: string, body: unknown): Promise<Salida> {
      // 6 · cuerpo: exactamente los tres campos, texto, sin extras (la identidad NUNCA sale del cuerpo)
      if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "CUERPO_INVALIDO", "Cuerpo inválido.");
      const b = body as Record<string, unknown>;
      const claves = Object.keys(b);
      if (claves.length !== CAMPOS.length || !CAMPOS.every((k) => claves.includes(k)) || !CAMPOS.every((k) => typeof b[k] === "string" && (b[k] as string).length > 0 && (b[k] as string).length <= 256)) {
        return err(400, "CUERPO_INVALIDO", "Cuerpo inválido.");
      }
      const actual = b.clave_actual as string, nueva = b.clave_nueva as string;
      if (nueva !== b.clave_confirmacion) return err(400, "CLAVES_NO_COINCIDEN", "La confirmación no coincide con la contraseña nueva.");
      // política local ANTES de reservar (ver cabecera): no gasta intento ni llama a GoTrue
      const pol = politicaClave(nueva, { actual, nombre: admin.nombre, correo: admin.correo });
      if (!pol.ok) return pol.codigo === "CLAVE_IGUAL_A_LA_ACTUAL"
        ? err(400, "CLAVE_IGUAL_A_LA_ACTUAL", "La contraseña nueva debe ser distinta de la actual.")
        : err(400, "CLAVE_DEBIL", "Esa contraseña es demasiado fácil de adivinar. Usa al menos 12 caracteres (una frase sirve) que no incluyan tu nombre, tu usuario ni «entimotors».");

      // 7 · reserva (SECURITY-1C)
      let res: Record<string, unknown>;
      try { res = await dep.reservar(admin.id, cfg); }
      catch { dep.log.error({ evento: "clave-reserva-fallo" }, "no se pudo reservar el intento"); return err(500, "ERROR_INTERNO", "No se pudo completar la operación."); }
      if (res.permitido !== true) {
        const seg = Math.max(1, Number(res.reintentar_en_s) || 60);
        if (res.motivo === "bloqueado") return err(429, "DEMASIADOS_INTENTOS", "Demasiados intentos. Espera unos minutos.", { reintentar_en_s: seg }, { "Retry-After": String(seg) });
        if (res.motivo === "en_curso") return err(409, "CAMBIO_EN_CURSO", "Ya hay un cambio de contraseña en curso. Espera un momento.", {}, { "Retry-After": String(seg) });
        if (res.motivo === "no_admin") return err(403, "SOLO_ADMIN", "Solo el administrador.");
        return err(500, "ERROR_INTERNO", "No se pudo completar la operación.");
      }
      const intentoId = Number(res.intento_id);

      // 8–10 · verificar la actual con T (identidad exacta; T se cierra con scope=local dentro de comprobar)
      const v = await dep.comprobar({ id: admin.id, correo: admin.correo }, actual);
      if (v === "no_disponible") { await resolverSeguro(admin.id, intentoId, "anulado"); return err(503, "AUTH_NO_DISPONIBLE", NO_DISPONIBLE); }
      if (v !== "ok") { await resolverSeguro(admin.id, intentoId, "fallido"); return err(401, "CLAVE_INCORRECTA", "La contraseña actual no es correcta."); }

      // 12 · cambiar con S1 (nunca con T). Una sola vez.
      const c = await dep.cambiar(tokenS1, nueva);
      if (c === "debil") { await resolverSeguro(admin.id, intentoId, "ok"); return err(400, "CLAVE_DEBIL", "El servicio de cuentas rechazó la contraseña nueva por débil. Elige otra."); }
      if (c === "igual") { await resolverSeguro(admin.id, intentoId, "ok"); return err(400, "CLAVE_IGUAL_A_LA_ACTUAL", "La contraseña nueva debe ser distinta de la actual."); }
      if (c === "reautenticar" || c === "sesion_invalida") { await resolverSeguro(admin.id, intentoId, "anulado"); return err(401, "SESION_INVALIDA", REINICIA); }
      if (c === "no_aplicado") { await resolverSeguro(admin.id, intentoId, "anulado"); return err(503, "AUTH_NO_DISPONIBLE", NO_DISPONIBLE); }
      if (c === "desconocido") {
        // pudo aplicarse: no se reintenta; queda evidencia sin secretos para recuperar (el admin prueba a entrar con la nueva)
        await resolverSeguro(admin.id, intentoId, "anulado");
        await auditarSeguro(admin, "incierto", { estado_cambio: "desconocido" }, intentoId);
        dep.log.error({ evento: "cambio-clave-resultado-desconocido", intento_id: intentoId }, "el cambio de contraseña terminó sin respuesta clara");
        return err(503, "AUTH_NO_DISPONIBLE", "No se pudo confirmar el cambio. Prueba a entrar con la contraseña nueva; si no funciona, sigue siendo la anterior.", { estado_cambio: "desconocido" });
      }

      // 13–14 · YA CAMBIADA. A partir de aquí nada se deshace ni se reintenta el cambio.
      const otras = await dep.cerrarOtras(tokenS1);
      if (!otras) dep.log.warn({ evento: "clave-otras-sesiones-sin-confirmar", intento_id: intentoId }, "no se pudo confirmar el cierre de las demás sesiones");
      await resolverSeguro(admin.id, intentoId, "ok");
      await auditarSeguro(admin, "ok", { otras_sesiones_cerradas: otras }, intentoId);
      dep.log.info({ evento: "cambio-clave-admin", otras_sesiones_cerradas: otras }, "contraseña del administrador cambiada");
      return { status: 200, cuerpo: { ok: true, otras_sesiones_cerradas: otras } };
    },
  };
}
