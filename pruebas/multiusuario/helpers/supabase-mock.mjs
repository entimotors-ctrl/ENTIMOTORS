// SERVIDOR SINTETICO (Supabase Auth + REST + api-server) para el QA multiusuario. Es un `fetch` falso:
// no abre ningun socket. FALLA CERRADO: cualquier host, ruta o forma no prevista se anota en
// `inesperadas`/`ajenas` y lanza un error, y cada prueba comprueba que ambas listas quedan vacias.
//
// DATOS 100% SINTETICOS: correos @example.test, uuid de la forma 00000000-0000-4000-8000-…, claves y
// tokens inventados. El registro de llamadas NUNCA guarda contrasenas ni tokens: solo su categoria.

export const HOST_SB = "synthetic-test.supabase.co";
export const URL_SB = `https://${HOST_SB}`;
export const HOST_API = "api.synthetic.test";
export const URL_API = `https://${HOST_API}`;
export const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const jwtSintetico = (role) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ iss: "supabase-sintetico", role })}.firma-sintetica-no-valida`;
export const ANON = jwtSintetico("anon");
export const SERVICE_ROLE = jwtSintetico("service_role");

const cuenta = (n, correo, rol, activo, nombre) => ({ correo, clave: `clave-sintetica-${n}A`, uid: UUID(n), perfil: rol === null ? null : { nombre, rol, activo } });
export const CUENTAS = {
  adminActivo: cuenta(1, "admin-activo@example.test", "admin", true, "Admin Activo"),
  adminInactivo: cuenta(2, "admin-inactivo@example.test", "admin", false, "Admin Inactivo"),
  mecanicoActivo: cuenta(3, "mecanico@example.test", "mecanico", true, "Mecanico Activo"),
  mecanicoInactivo: cuenta(4, "mecanico-inactivo@example.test", "mecanico", false, "Mecanico Inactivo"),
  cajeroActivo: cuenta(5, "cajero@example.test", "cajero", true, "Cajero Activo"),
  cajeroInactivo: cuenta(6, "cajero-inactivo@example.test", "cajero", false, "Cajero Inactivo"),
  desarrollador: cuenta(7, "dev@example.test", "desarrollador", true, "Desarrollador"),
  sinPerfil: cuenta(8, "sin-perfil@example.test", null, null, ""),
  rolDesconocido: cuenta(9, "rol-raro@example.test", "superadmin", true, "Rol Desconocido"),
};

function respuesta(status, cuerpo, extra = {}) {
  const txt = cuerpo === undefined || cuerpo === "" ? "" : (typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo));
  return {
    ok: status >= 200 && status < 300, status, statusText: `HTTP ${status}`,
    headers: { get: (n) => (String(n).toLowerCase() === "content-range" ? (extra.rango || null) : null) },
    text: async () => txt, json: async () => JSON.parse(txt),
  };
}
const RAW = (txt, status = 200) => respuesta(status, txt);

export function crearServidor(cuentas = Object.values(CUENTAS)) {
  const porUid = new Map(cuentas.map((c) => [c.uid, c]));
  const porCorreo = new Map(cuentas.map((c) => [c.correo, c]));
  let seq = 0, tokSeq = 0;
  const s = {
    llamadas: [], inesperadas: [], ajenas: [],
    red: "ok",                  // "ok" | "caida" (TypeError) | "timeout" (AbortError)
    perfilesHttp: null,         // fuerza un codigo HTTP en GET /rest/v1/perfiles
    perfilesRed: null,          // "caida" | "timeout": falla SOLO la lectura del perfil (el login ya funciono)
    perfilesCuerpo: undefined,  // fuerza el cuerpo (cualquier JSON, o {raw:"texto"})
    refrescoFalla: false,
    rpc: {},                    // nombre -> { status, body } para sobreescribir un RPC
    api: null,                  // (metodo, ruta, cuerpo, auth) => { status, body } del api-server
    cierres: 0,
    clavesEstablecidas: [],     // longitudes, nunca el valor
    _clavesNuevas: new Map(),   // correo -> contraseña elegida por un enlace de recuperacion (solo en ESTE servidor; NO toca las constantes compartidas CUENTAS)
    _tokens: new Map(),         // access_token -> { uid, refresh }
    _refrescos: new Map(),      // refresh_token -> uid
    _recuperacion: new Map(),   // token -> { correo, vigente }
    _hashes: new Map(),         // token_hash -> token de recuperacion (o null = gastado)
    cuentas: porUid,
  };

  /** Crea una sesion valida y devuelve el objeto que supabase-client guarda en localStorage. */
  s.emitirSesion = (c, { expiraEnS = 3600 } = {}) => {
    const access = `acceso-sintetico-${++tokSeq}`, refresh = `refresco-sintetico-${tokSeq}`;
    s._tokens.set(access, { uid: c.uid, refresh }); s._refrescos.set(refresh, c.uid);
    return { access_token: access, refresh_token: refresh, expires_at: Math.floor(Date.now() / 1000) + expiraEnS, user: { id: c.uid, email: c.correo } };
  };
  s.emitirRecuperacion = (correo, { hash } = {}) => {
    const token = `recuperacion-sintetica-${++tokSeq}`;
    s._recuperacion.set(token, { correo, vigente: true });
    if (hash) s._hashes.set(hash, token);
    return token;
  };
  s.gastarHash = (hash) => s._hashes.set(hash, null);
  s.tokensEmitidos = () => [...s._tokens.keys(), ...s._refrescos.keys(), ...s._recuperacion.keys()];

  const categoria = (h) => {
    if (!h) return "ninguno";
    const t = String(h).replace(/^Bearer\s+/i, "");
    if (t === ANON) return "anon";
    if (s._tokens.has(t)) return "sesion";
    if (s._recuperacion.has(t)) return "recuperacion";
    return "invalido";
  };
  const tokenDe = (h) => String(h || "").replace(/^Bearer\s+/i, "");
  const limpiar = (c) => {
    if (!c || typeof c !== "object") return c;
    const o = { ...c };
    for (const k of ["password", "clave", "token_hash", "refresh_token"]) if (k in o) o[k] = `«len:${String(o[k]).length}»`;
    return o;
  };

  s.fetch = async function fetch(url, init = {}) {
    const u = new URL(String(url));
    const metodo = String(init.method || "GET").toUpperCase();
    const cab = init.headers || {};
    const authH = cab.Authorization || cab.authorization;
    let cuerpo;
    try { cuerpo = init.body ? JSON.parse(init.body) : undefined; } catch { cuerpo = init.body; }
    const host = u.host === HOST_SB ? "supabase" : u.host === HOST_API ? "api" : u.host;
    const entrada = { n: ++seq, host, metodo, ruta: u.pathname + u.search, auth: categoria(authH), apikey: cab.apikey ? (cab.apikey === ANON ? "anon" : "otra") : "ninguna", cuerpo: limpiar(cuerpo) };
    s.llamadas.push(entrada);
    if (host !== "supabase" && host !== "api") { s.ajenas.push(entrada); throw new TypeError("fail-closed: host no permitido en el QA"); }
    if (s.red === "caida") throw new TypeError("Failed to fetch");
    if (s.red === "timeout") { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; }
    const inesperada = (motivo) => { s.inesperadas.push({ ...entrada, motivo }); throw new Error(`fail-closed: llamada inesperada (${motivo}) ${metodo} ${u.pathname}`); };

    // ── api-server de ENTIMOTORS ──
    if (host === "api") {
      if (typeof s.api !== "function") return inesperada("api-server sin manejador");
      const r = await s.api(metodo, u.pathname, cuerpo, entrada.auth);
      return respuesta(r.status, r.body);
    }

    // ── Supabase ──
    const p = u.pathname;
    if (p === "/auth/v1/health") return respuesta(200, { status: "ok" });

    if (p === "/auth/v1/token" && metodo === "POST") {
      const gt = u.searchParams.get("grant_type");
      if (gt === "password") {
        const c = porCorreo.get(cuerpo?.email);
        const clave = c && s._clavesNuevas.has(c.correo) ? s._clavesNuevas.get(c.correo) : c && c.clave;   // la contraseña elegida por el enlace manda sobre la de ejemplo
        if (!c || clave !== cuerpo?.password) return respuesta(400, { error: "invalid_grant", error_description: "Invalid login credentials" });
        const ses = s.emitirSesion(c);
        return respuesta(200, { access_token: ses.access_token, token_type: "bearer", expires_in: 3600, refresh_token: ses.refresh_token, user: { id: c.uid, email: c.correo } });
      }
      if (gt === "refresh_token") {
        const uid = s._refrescos.get(cuerpo?.refresh_token);
        if (s.refrescoFalla || !uid) return respuesta(400, { error: "invalid_grant", error_description: "Invalid Refresh Token" });
        const c = porUid.get(uid), ses = s.emitirSesion(c);
        return respuesta(200, { access_token: ses.access_token, token_type: "bearer", expires_in: 3600, refresh_token: ses.refresh_token, user: { id: c.uid, email: c.correo } });
      }
      return inesperada("grant_type desconocido");
    }

    if (p === "/auth/v1/logout" && metodo === "POST") {
      s.cierres++; s._tokens.delete(tokenDe(authH));
      return respuesta(204, "");
    }

    if (p === "/auth/v1/user" && metodo === "GET") {
      const t = tokenDe(authH), rec = s._recuperacion.get(t);
      if (rec && rec.vigente) return respuesta(200, { id: UUID(99), email: rec.correo });
      if (s._tokens.has(t)) { const c = porUid.get(s._tokens.get(t).uid); return respuesta(200, { id: c.uid, email: c.correo }); }
      return respuesta(401, { message: "invalid JWT: unable to parse or verify signature" });
    }

    if (p === "/auth/v1/user" && metodo === "PUT") {
      const t = tokenDe(authH), rec = s._recuperacion.get(t);
      if (!rec || !rec.vigente) return respuesta(401, { message: "invalid JWT" });
      const pw = cuerpo?.password;
      if (typeof pw !== "string" || pw.length < 8) return respuesta(422, { error_code: "weak_password", msg: "Password should be at least 8 characters." });
      rec.vigente = false;                       // enlace de un solo uso
      s.clavesEstablecidas.push(pw.length);
      s._clavesNuevas.set(rec.correo, pw);       // la cuenta ahora entra con esta contraseña (el valor nunca se registra: solo su longitud)
      return respuesta(200, { id: UUID(99), email: rec.correo });
    }

    if (p === "/auth/v1/verify" && metodo === "POST") {
      if (!s._hashes.has(cuerpo?.token_hash)) return respuesta(401, { error_code: "otp_expired", msg: "Token has expired or is invalid" });
      const tok = s._hashes.get(cuerpo.token_hash);
      if (!tok) return respuesta(403, { error_code: "otp_expired", msg: "Email link is invalid or has expired" });
      return respuesta(200, { access_token: tok, token_type: "bearer", expires_in: 3600, user: { id: UUID(99), email: s._recuperacion.get(tok).correo } });
    }

    if (p === "/rest/v1/perfiles" && metodo === "GET") {
      if (u.searchParams.get("select") !== "id,nombre,rol,activo") return inesperada("select de perfiles distinto del esperado");
      if (entrada.auth === "invalido") return respuesta(401, { message: "JWT expired" });
      if (s.perfilesRed === "caida") throw new TypeError("Failed to fetch");
      if (s.perfilesRed === "timeout") { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; }
      if (s.perfilesHttp) return respuesta(s.perfilesHttp, { message: "error sintetico de servidor" });
      if (s.perfilesCuerpo !== undefined) return s.perfilesCuerpo && s.perfilesCuerpo.raw !== undefined ? RAW(s.perfilesCuerpo.raw) : respuesta(200, s.perfilesCuerpo);
      const uid = String(u.searchParams.get("id") || "").replace(/^eq\./, "");
      // RLS: con la clave anon no se ve nada; con sesion solo el propio perfil
      if (entrada.auth !== "sesion" || s._tokens.get(tokenDe(authH)).uid !== uid) return respuesta(200, []);
      const c = porUid.get(uid);
      if (!c || !c.perfil) return respuesta(200, []);
      const fila = { id: c.uid, nombre: c.perfil.nombre, rol: c.perfil.rol };
      if (c.perfil.activo !== undefined) fila.activo = c.perfil.activo;
      return respuesta(200, [fila]);
    }

    if (p.startsWith("/rest/v1/rpc/") && metodo === "POST") {
      const nombre = decodeURIComponent(p.slice("/rest/v1/rpc/".length));
      if (s.rpc[nombre]) return respuesta(s.rpc[nombre].status ?? 200, s.rpc[nombre].body);
      if (entrada.auth !== "sesion") return nombre === "rol_actual" ? respuesta(200, JSON.stringify("")) : respuesta(401, { message: "No autorizado" });
      const c = porUid.get(s._tokens.get(tokenDe(authH)).uid);
      const rolEfectivo = c.perfil && c.perfil.activo === true ? c.perfil.rol : "";      // como rol_actual() tras RCV-35: AND p.activo
      if (nombre === "rol_actual") return respuesta(200, JSON.stringify(rolEfectivo));   // PostgREST devuelve un escalar text como JSON
      if (nombre === "estadisticas_tecnicas") return ["admin", "desarrollador"].includes(rolEfectivo) ? respuesta(200, { clientes: 3, motos: 2, ordenes: 5, ventas: 1 }) : respuesta(403, { message: "No autorizado" });
      if (nombre === "estado_tecnico") return ["admin", "desarrollador"].includes(rolEfectivo) ? respuesta(200, { tablas: [{ tabla: "clientes", rls: true, politicas: 2 }, { tabla: "ordenes", rls: true, politicas: 3 }] }) : respuesta(403, { message: "No autorizado" });
      return inesperada(`rpc desconocido ${nombre}`);
    }

    return inesperada("ruta de Supabase no prevista");
  };

  s.reiniciarRegistro = () => { s.llamadas.length = 0; s.inesperadas.length = 0; s.ajenas.length = 0; };
  return s;
}
