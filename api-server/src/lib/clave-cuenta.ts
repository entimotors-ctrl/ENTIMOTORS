/* VERIFICAR LA CONTRASEÑA DE LA CUENTA (Supabase Auth) para re-autenticar al administrador (cambiar o quitar el PIN).
   Lógica pura: sin Express ni supabase-js; `fetch` y el log se inyectan (así la prueba con GoTrue real ejerce este mismo código).

   Supabase Auth no tiene un «comprobar contraseña» sin más: la única forma es el login (grant_type=password), que CREA una sesión.
   Antes esa sesión se abandonaba (quedaba viva en auth.sessions con su refresh token, para siempre). Ahora:
   · se exige que el usuario devuelto sea EXACTAMENTE el admin autenticado (id y correo); si no, se rechaza;
   · la sesión temporal se cierra SIEMPRE que exista access_token (también si la identidad no coincide: primero cerrar, luego rechazar),
     con POST /auth/v1/logout?scope=local y el token TEMPORAL. `local` revoca solo la sesión de ese token. Nunca `global` (cerraría las
     sesiones reales del admin), nunca `others` (cerraría las reales y dejaría viva la temporal), nunca sin scope (GoTrue asume global);
   · si el cierre falla por red/tiempo/5xx/429 se reintenta una vez; si aun así no se cierra, se registra solo el id de la sesión (no es
     un secreto) para limpiarla después. La contraseña ya quedó verificada y los tokens nunca salieron de la memoria del servidor.
   Nada de esto registra ni devuelve contraseñas ni tokens. */

export interface AdminAVerificar { id: string; correo: string }
export interface LogVerificador { warn(obj: Record<string, unknown>, msg: string): void }
export interface OpcionesVerificador {
  url: string;
  anon: string | undefined;
  log: LogVerificador;
  fetch?: typeof fetch;
  timeoutMs?: number;
  esperaReintentoMs?: number;
}

export const RUTA_CIERRE_TEMPORAL = "/auth/v1/logout?scope=local";
export type ResultadoComprobacion = "ok" | "incorrecta" | "no_disponible" | "identidad_distinta";

/** El `session_id` del JWT (sin verificar la firma: solo para diagnóstico en el log). Nunca el token. */
export function sesionDelToken(token: string): string | null {
  try {
    const parte = token.split(".")[1];
    if (!parte) return null;
    const datos = JSON.parse(Buffer.from(parte.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { session_id?: unknown };
    return typeof datos.session_id === "string" && /^[0-9a-f-]{36}$/i.test(datos.session_id) ? datos.session_id : null;
  } catch { return null; }
}

export function crearVerificadorClaveCuenta(o: OpcionesVerificador) {
  const f = o.fetch ?? globalThis.fetch;
  const base = o.url.replace(/\/+$/, "");
  const TIMEOUT = o.timeoutMs ?? 8000;
  const ESPERA = o.esperaReintentoMs ?? 300;

  async function pedir(ruta: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT);
    try { return await f(base + ruta, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
  }

  /** Cierra la sesión del token temporal. Un reintento ante red/tiempo/5xx/429; un 4xx no se reintenta (GoTrue ya contestó). */
  async function cerrarSesionTemporal(token: string): Promise<boolean> {
    let estado: number | "sin-respuesta" = "sin-respuesta";
    for (let intento = 1; intento <= 2; intento++) {
      try {
        const r = await pedir(RUTA_CIERRE_TEMPORAL, { method: "POST", headers: { apikey: o.anon as string, Authorization: `Bearer ${token}` } });
        if (r.ok) return true;
        estado = r.status;
        if (r.status < 500 && r.status !== 429) break;
      } catch { estado = "sin-respuesta"; }
      if (intento === 1) await new Promise((res) => setTimeout(res, ESPERA));
    }
    o.log.warn({ evento: "pin-sesion-temporal-no-cerrada", sesion: sesionDelToken(token), estado }, "no se pudo cerrar la sesión temporal de la verificación");
    return false;
  }

  /** Comprueba la contraseña y CLASIFICA el resultado (SECURITY-1D). La sesión temporal se cierra siempre que exista (scope=local).
      · ok                  → la contraseña es de ESTA cuenta (id y correo del admin autenticado)
      · incorrecta          → GoTrue respondió de forma concluyente que no (4xx distinto de 429)
      · no_disponible       → sin respuesta concluyente: red, timeout, 5xx, 429 o un 200 sin token (no se sabe si era correcta)
      · identidad_distinta  → la contraseña abrió OTRA cuenta (se cierra primero la temporal, luego se rechaza) */
  async function comprobarClaveCuenta(admin: AdminAVerificar, clave: string): Promise<ResultadoComprobacion> {
    if (!o.anon || !admin || typeof admin.id !== "string" || !admin.id || typeof admin.correo !== "string" || !admin.correo) return "no_disponible";
    if (typeof clave !== "string" || clave.length === 0) return "incorrecta";
    let token: string | null = null;
    try {
      let r: Response;
      try {
        r = await pedir("/auth/v1/token?grant_type=password", {
          method: "POST",
          headers: { apikey: o.anon, "Content-Type": "application/json" },
          body: JSON.stringify({ email: admin.correo, password: clave }),
        });
      } catch { return "no_disponible"; }                       // red / timeout
      if (!r.ok) return r.status === 429 || r.status >= 500 ? "no_disponible" : "incorrecta";   // GoTrue no creó sesión
      const j = (await r.json().catch(() => null)) as { access_token?: unknown; user?: { id?: unknown; email?: unknown } } | null;
      token = typeof j?.access_token === "string" && j.access_token.length > 0 ? j.access_token : null;
      if (!token) return "no_disponible";
      const u = j?.user;
      const mismo = !!u && u.id === admin.id && typeof u.email === "string" && u.email.toLowerCase() === admin.correo.toLowerCase();
      await cerrarSesionTemporal(token);                         // SIEMPRE, antes de decidir
      token = null;
      if (!mismo) { o.log.warn({ evento: "pin-clave-identidad-distinta" }, "la cuenta verificada no es la del administrador autenticado"); return "identidad_distinta"; }
      return "ok";
    } catch {
      if (token) await cerrarSesionTemporal(token);
      return "no_disponible";
    } finally {
      token = null;
    }
  }

  /** La de siempre (PIN): true solo si la contraseña es de esta cuenta. */
  async function verificarClaveCuenta(admin: AdminAVerificar, clave: string): Promise<boolean> {
    return (await comprobarClaveCuenta(admin, clave)) === "ok";
  }
  return Object.assign(verificarClaveCuenta, { comprobar: comprobarClaveCuenta });
}
