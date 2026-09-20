import { Router, type Request, type Response, type NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";
import { logger } from "../lib/logger.js";

/* ============================================================================
 * Gestión de usuarios de ENTIMOTORS OS.
 *
 * DOS CLIENTES, A PROPÓSITO:
 *
 *   servidor  → clave de servicio. SOLO para Auth (crear la cuenta, listar
 *               correos). Nunca escribe en `perfiles`.
 *
 *   comoElAdmin(token) → clave pública + el token de quien llama. TODAS las
 *               escrituras en `perfiles` van por aquí.
 *
 * ¿Por qué? Porque la base tiene `proteger_rol_perfil_trigger`, que solo deja
 * cambiar roles a un administrador CON SESIÓN. Con la clave de servicio
 * `auth.uid()` es nulo y el disparador rechaza — como debe ser. En vez de
 * saltárselo, el backend actúa en nombre del admin: así este servidor no puede
 * hacer sobre `perfiles` nada que el propio admin no pudiera hacer.
 * ==========================================================================*/

const SUPABASE_URL = process.env["SUPABASE_URL"];
const SERVICE_KEY = process.env["SUPABASE_SERVICE_KEY"];
const ANON_KEY = process.env["SUPABASE_ANON_KEY"];

/* ── A DÓNDE VUELVE UN ENLACE DE RECUPERACIÓN ───────────────────────────────
   ENTIMOTORS son dos aplicaciones en dos origins distintos: el taller y «Mi
   Trabajo». Un enlace de alta tiene que aterrizar en el que le corresponde a
   la persona, o la recibirá una app que va a rechazarla.

   El destino lo decide el SERVIDOR a partir del rol guardado en `perfiles`.
   Nunca se lee un redirect de la petición: si el cliente pudiera elegirlo,
   bastaría con pedir un alta apuntando a un sitio propio para quedarse con el
   token de recuperación de la cuenta recién creada.

   Ninguna de las dos variables tiene valor por defecto, y eso es deliberado:
   sin la del producto que toca, la recuperación FALLA. Mandar a un mecánico al
   taller «mientras tanto» sería devolverle un enlace que no puede usar. */
const ADMIN_ORIGIN = process.env["ENTIMOTORS_ADMIN_ORIGIN"];
const MECHANIC_ORIGIN = process.env["ENTIMOTORS_MECHANIC_ORIGIN"];

/* La recuperación no tiene página propia: recovery.js corre dentro del
   index.html de la app y lee el hash que deja Supabase. Ver taller-demo/recovery.js.

   La URL se construye sobre el objeto YA PARSEADO, nunca sobre la cadena cruda.
   El parser de WHATWG tolera espacios y saltos de línea —que es justo lo que
   trae un valor pegado a mano en el panel de Render—, así que validar con `u`
   y concatenar con `base` dejaba pasar basura hasta dentro del enlace. */
const PAGINA = "index.html";

function urlDeRegreso(base: string): string | null {
  let u: URL;
  try { u = new URL(base.trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  /* Ni la query ni el fragmento forman parte del contrato: la variable declara
     DÓNDE vive la app, no con qué parámetros se abre. El fragmento además es
     exactamente donde Supabase deja el token de recuperación, y conservar uno
     puesto a mano lo pisaría. */
  u.search = "";
  u.hash = "";

  /* El pathname sí se respeta: el taller vive en /entimotors-os/, no en la
     raíz de su dominio. Y si la variable ya apunta al index, no se duplica. */
  const ruta = u.pathname.replace(/\/+$/, "");
  u.pathname = ruta.endsWith(`/${PAGINA}`) ? ruta : `${ruta}/${PAGINA}`;
  return u.toString();
}

/** Por qué no hubo destino. Viaja hasta la respuesta para poder distinguir un
    despiste de configuración de un rechazo de Supabase sin abrir los logs. */
export type FalloDestino = "rol-desconocido" | "sin-origin" | "origin-invalido";

/** Qué app le toca a cada rol. Allowlist fija: lo que no está, no pasa. */
export function destinoDeRecuperacion(rol: string):
  { ok: true; url: string } | { ok: false; motivo: FalloDestino; error: string } {
  let base: string | undefined;
  if (rol === "mecanico") base = MECHANIC_ORIGIN;
  // El desarrollador vuelve al taller porque es donde vive panel-tecnico.html;
  // entrar al taller sigue sin poder, eso lo decide la propia app.
  else if (rol === "admin" || rol === "cajero" || rol === "desarrollador") base = ADMIN_ORIGIN;
  else return { ok: false, motivo: "rol-desconocido", error: `Rol sin destino de recuperación: "${rol}".` };

  // una variable puesta pero vacía (o a espacios) es un olvido, no una dirección mala
  if (!base || !base.trim()) {
    const falta = rol === "mecanico" ? "ENTIMOTORS_MECHANIC_ORIGIN" : "ENTIMOTORS_ADMIN_ORIGIN";
    return { ok: false, motivo: "sin-origin", error: `Falta ${falta} en el servidor: no se puede generar el enlace.` };
  }
  const url = urlDeRegreso(base);
  if (!url) {
    return { ok: false, motivo: "origin-invalido",
             error: "La dirección configurada para esta app no es válida: tiene que empezar por https://" };
  }
  return { ok: true, url };
}

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error("Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY");
}

// realtime.transport: en Node 20 no hay WebSocket nativo y createClient falla
// al construirse. El resto del servidor ya lo hace así (ver lib/supabase.ts).
const servidor: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws },
});

/* Sin ANON_KEY no hay forma de escribir en `perfiles` en nombre del admin, y
   la alternativa —usar la clave de servicio— es justo lo que no se hace aquí.
   Se corta ANTES de tocar nada: si se dejara reventar dentro del POST, la
   cuenta de Auth ya estaría creada y quedaría huérfana, con rol de mecánico
   por el disparador y sin contraseña que nadie conozca. Medido. */
function exigirConfiguracion(_req: Request, res: Response, next: NextFunction): void {
  if (!ANON_KEY) {
    logger.error("falta SUPABASE_ANON_KEY: la gestión de usuarios queda apagada");
    res.status(503).json({
      error: "El servidor no tiene configurada SUPABASE_ANON_KEY. " +
             "Hay que añadirla en las variables de entorno (es la clave pública, la misma del frontend).",
    });
    return;
  }
  next();
}

function comoElAdmin(token: string): SupabaseClient {
  if (!ANON_KEY) throw new Error("Falta SUPABASE_ANON_KEY en el entorno del servidor");
  return createClient(SUPABASE_URL as string, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/* El rol `admin` no se reparte desde aquí: el sistema admite uno solo y ya
   existe. La lista es blanca a propósito — lo que no esté, se rechaza. */
const ROLES_ASIGNABLES = ["mecanico", "cajero", "desarrollador"] as const;
type RolAsignable = (typeof ROLES_ASIGNABLES)[number];

interface PeticionAdmin extends Request {
  quien?: { id: string; correo: string; nombre: string; token: string };
}

/* ───────────────────────── autorización ─────────────────────────
   No se mira nada de lo que diga el navegador: la identidad sale del token,
   y el rol, de la tabla `perfiles`. */
async function exigirAdmin(req: PeticionAdmin, res: Response, next: NextFunction): Promise<void> {
  const cabecera = req.headers.authorization ?? "";
  const token = cabecera.startsWith("Bearer ") ? cabecera.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "Hace falta iniciar sesión." });
    return;
  }

  const { data, error } = await servidor.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: "La sesión no es válida o ha caducado." });
    return;
  }

  const { data: perfil, error: errPerfil } = await servidor
    .from("perfiles").select("id, nombre, rol, activo").eq("id", data.user.id).maybeSingle();

  if (errPerfil) {
    logger.error({ err: errPerfil }, "no se pudo leer el perfil de quien llama");
    res.status(500).json({ error: "No se pudo comprobar el perfil." });
    return;
  }
  if (!perfil || perfil.activo !== true || perfil.rol !== "admin") {
    res.status(403).json({ error: "Solo el administrador puede gestionar usuarios." });
    return;
  }

  req.quien = { id: perfil.id, correo: data.user.email ?? "", nombre: perfil.nombre, token };
  next();
}

/* ───────────────────────── validaciones ───────────────────────── */
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validarAlta(cuerpo: Record<string, unknown>): { ok: true; datos: { correo: string; nombre: string; telefono: string; rol: RolAsignable } } | { ok: false; error: string } {
  const correo = String(cuerpo["correo"] ?? "").trim().toLowerCase();
  const nombre = String(cuerpo["nombre"] ?? "").trim();
  const telefono = String(cuerpo["telefono"] ?? "").trim();
  const rol = String(cuerpo["rol"] ?? "").trim();

  if (!CORREO.test(correo) || correo.length > 254) return { ok: false, error: "El correo no tiene una forma válida." };
  if (nombre.length < 2 || nombre.length > 60) return { ok: false, error: "El nombre debe tener entre 2 y 60 letras." };
  if (telefono && !/^[0-9+\-\s()]{6,20}$/.test(telefono)) return { ok: false, error: "El teléfono no tiene una forma válida." };
  if (rol === "admin") return { ok: false, error: "No se puede crear otro administrador. El sistema admite uno solo." };
  if (!ROLES_ASIGNABLES.includes(rol as RolAsignable)) return { ok: false, error: `El rol debe ser uno de: ${ROLES_ASIGNABLES.join(", ")}.` };

  return { ok: true, datos: { correo, nombre, telefono, rol: rol as RolAsignable } };
}

/* Contraseña de un solo uso, generada en el servidor. NO se devuelve, NO se
   guarda y NO se escribe en ningún registro: existe solo el instante que tarda
   Supabase en recibirla. Quien entre lo hará por el enlace de acceso. */
function claveDeUnUso(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*";
  const bytes = new Uint8Array(32);
  (globalThis.crypto as Crypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

/* ── ENLACE DE RECUPERACIÓN ────────────────────────────────────────────────
   Única puerta por la que este servidor le pide a Supabase un enlace de un solo
   uso: la usan el ALTA (POST /admin/usuarios) y «generar enlace» de un usuario
   que ya existe (POST /admin/usuarios/:id/enlace). Así el destino (por rol) y el
   tratamiento de los fallos no se duplican.

   Recibe el correo y el rol que YA están guardados en el servidor; nunca lo que
   diga quien llama. El enlace devuelto es un secreto: no se registra, no se
   guarda y no sale en ningún mensaje de error. */
export type MotivoSinEnlace = FalloDestino | "supabase-rechazo" | "sin-action-link" | "error-de-red";
export type ResultadoEnlace =
  | { ok: true; enlace: string }
  | { ok: false; motivo: MotivoSinEnlace; aviso: string };

async function generarEnlaceDeRecuperacion(correo: string, rol: string): Promise<ResultadoEnlace> {
  const destino = destinoDeRecuperacion(rol);
  if (!destino.ok) {
    logger.error({ rol, motivo: destino.motivo }, "sin destino de recuperación: no se genera enlace");
    return { ok: false, motivo: destino.motivo, aviso: destino.error };
  }
  /* generateLink NO lanza cuando la API contesta con un error de Auth: devuelve
     { data: { properties: null, user: null }, error } y solo relanza lo que no
     es de Auth. Desestructurar únicamente `data` tiraba ese `error` a la basura
     y el enlace salía null sin que nada quedara registrado — exactamente lo que
     pasó en GATE 7A-1. Por eso aquí se miran las dos cosas, y el try/catch se
     queda para lo otro: red, DNS, timeout. */
  try {
    const { data: link, error: errEnlace } = await servidor.auth.admin.generateLink({
      type: "recovery", email: correo,
      options: { redirectTo: destino.url },
    });
    if (errEnlace) {
      /* Del error solo lo que sirve para diagnosticar. El enlace y el token
         no pasan por aquí: no están en `error`, y no se registran nunca. */
      logger.error({
        motivo: "supabase-rechazo",
        destino: destino.url,           // lo fija el servidor, no es un secreto
        estado: errEnlace.status ?? null,
        codigo: (errEnlace as { code?: string }).code ?? null,
        mensaje: errEnlace.message,
      }, "generateLink falló: no se genera enlace");
      return { ok: false, motivo: "supabase-rechazo",
               aviso: "Supabase no aceptó generar el enlace. Revisa que la dirección de vuelta esté en Authentication → URL Configuration → Redirect URLs." };
    }
    /* Solo vale una cadena que sea una dirección http(s): un objeto, un número o
       algo sin esquema es una respuesta malformada, no un enlace. */
    const accion: unknown = link?.properties?.action_link;
    if (typeof accion !== "string" || !/^https?:\/\/\S+$/i.test(accion)) {
      logger.error({ motivo: "sin-action-link" }, "generateLink no devolvió action_link");
      return { ok: false, motivo: "sin-action-link", aviso: "Supabase respondió sin enlace utilizable." };
    }
    return { ok: true, enlace: accion };
  } catch (e) {
    logger.error({ motivo: "error-de-red", mensaje: e instanceof Error ? e.message : String(e) },
                 "generateLink lanzó una excepción");
    return { ok: false, motivo: "error-de-red", aviso: "No se pudo contactar con Supabase para generar el enlace." };
  }
}

const router = Router();

/* ───────────────────── GET /api/admin/usuarios ───────────────────── */
router.get("/admin/usuarios", exigirConfiguracion, exigirAdmin, async (req: PeticionAdmin, res: Response) => {
  const { data: perfiles, error } = await comoElAdmin(req.quien!.token)
    .from("perfiles").select("id, nombre, rol, telefono, activo, creado_en").order("nombre");

  if (error) {
    logger.error({ err: error }, "no se pudieron listar los perfiles");
    res.status(500).json({ error: "No se pudo leer la lista del equipo." });
    return;
  }

  // los correos viven en Auth, no en `perfiles`
  const correos = new Map<string, string>();
  const { data: cuentas } = await servidor.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const u of cuentas?.users ?? []) if (u.email) correos.set(u.id, u.email);

  res.json({
    usuarios: (perfiles ?? []).map((p) => ({
      id: p.id, nombre: p.nombre, correo: correos.get(p.id) ?? "",
      telefono: p.telefono ?? "", rol: p.rol, activo: p.activo,
      creadoEn: p.creado_en, esUsted: p.id === req.quien!.id,
    })),
  });
});

/* ───────────────────── POST /api/admin/usuarios ───────────────────── */
router.post("/admin/usuarios", exigirConfiguracion, exigirAdmin, async (req: PeticionAdmin, res: Response) => {
  const v = validarAlta((req.body ?? {}) as Record<string, unknown>);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  const { correo, nombre, telefono, rol } = v.datos;

  const { data: creado, error: errAlta } = await servidor.auth.admin.createUser({
    email: correo,
    password: claveDeUnUso(),          // se descarta al instante; nadie la conoce
    email_confirm: true,
    user_metadata: { nombre },
  });

  if (errAlta || !creado?.user) {
    const msg = errAlta?.message ?? "";
    logger.warn({ correo }, "alta de usuario rechazada");   // el correo sí, la clave nunca
    res.status(/already|registered|exists/i.test(msg) ? 409 : 400)
       .json({ error: /already|registered|exists/i.test(msg) ? "Ya existe una cuenta con ese correo." : "No se pudo crear la cuenta." });
    return;
  }

  const nuevoId = creado.user.id;

  // el disparador `al_crear_usuario` ya hizo el perfil como mecánico;
  // aquí se le pone el nombre, el teléfono y el rol — en nombre del admin
  const { data: perfilGuardado, error: errPerfil } = await comoElAdmin(req.quien!.token)
    .from("perfiles").update({ nombre, telefono: telefono || null, rol }).eq("id", nuevoId)
    .select("rol").single();

  if (errPerfil) {
    // sin perfil correcto la cuenta no sirve: se deshace el alta
    await servidor.auth.admin.deleteUser(nuevoId).catch(() => undefined);
    logger.error({ err: errPerfil }, "no se pudo fijar el perfil; alta deshecha");
    res.status(400).json({ error: `No se pudo asignar el rol: ${errPerfil.message}` });
    return;
  }

  /* Enlace de un solo uso para que la persona ponga su propia contraseña. El
     destino sale del rol REAL que quedó en `perfiles`, no del que venía en la
     petición: si el disparador o una política lo hubieran cambiado, manda lo
     que hay en la base. (La generación vive en generarEnlaceDeRecuperacion, que
     comparte con la ruta «generar enlace» de un usuario ya existente.) */
  const generado = await generarEnlaceDeRecuperacion(correo, String(perfilGuardado?.rol ?? rol));
  const enlace: string | null = generado.ok ? generado.enlace : null;
  const avisoEnlace: string | null = generado.ok ? null : generado.aviso;
  const motivoSinEnlace: string | null = generado.ok ? null : generado.motivo;

  /* 201 aunque no haya enlace, a propósito: la cuenta EXISTE. Devolver un error
     haría creer al administrador que no se creó nada y le llevaría a repetir el
     alta contra un correo ya registrado. Lo que falta es el enlace, y eso lo
     dicen `nota` y `motivoSinEnlace`. */
  res.status(201).json({
    usuario: { id: nuevoId, correo, nombre, telefono, rol, activo: true },
    enlaceParaEstablecerClave: enlace,
    motivoSinEnlace,
    nota: enlace
      ? "Pásale este enlace a la persona. Es de un solo uso: ahí elige su contraseña."
      : (avisoEnlace ?? "") +
        (avisoEnlace ? " " : "") +
        "La cuenta está creada. Para darle contraseña: panel de Supabase → Authentication → el usuario → Reset password.",
  });
});

/* ─────────────── POST /api/admin/usuarios/:id/enlace ───────────────
   RECUPERACIÓN MEDIADA POR EL ADMINISTRADOR (OBS-9, plan B). Una persona del
   equipo perdió su contraseña: el administrador le genera un enlace de un solo
   uso, lo copia y se lo pasa. Ella lo abre y `recovery.js` la deja elegir una
   contraseña nueva. No se envía correo, no hay SMTP y no hay ninguna ruta pública.

   QUIÉN MANDA EN QUÉ
     · Autorización: la misma de todo /admin/usuarios (token de un admin activo).
     · El CUERPO NO SE LEE. El correo sale de Auth, el rol de `perfiles` y el
       destino (Taller o Mi Trabajo) lo decide destinoDeRecuperacion() con las
       variables del servidor. Si alguien manda correo, rol o redirect_to, se
       ignoran: no hay dónde ponerlos.
     · Solo cuentas ACTIVAS de rol no administrador. Una cuenta dada de baja no
       puede entrar aunque tenga contraseña nueva (auth.js la rechaza), así que
       generar el enlace solo daría una falsa sensación de acceso; generar el
       enlace NUNCA reactiva una cuenta: el perfil no se toca.
     · La cuenta del propio administrador queda fuera a propósito: este camino
       no resuelve que el admin pierda su acceso y no debe parecer autoservicio.
       Se recupera desde el panel de Supabase (Authentication).

   El enlace es un secreto: viaja SOLO en el cuerpo de esta respuesta (con
   Cache-Control: no-store) y no se escribe en ningún registro. */
router.post("/admin/usuarios/:id/enlace", exigirConfiguracion, exigirAdmin, async (req: PeticionAdmin, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  const id = String(req.params["id"] ?? "");

  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "Identificador no válido." }); return; }
  if (id === req.quien!.id) {
    res.status(400).json({ error: "No se genera un enlace para tu propia cuenta desde aquí. La cuenta del administrador se recupera desde el panel de Supabase (Authentication)." });
    return;
  }

  // quién es el objetivo, según la base (no según quien llama)
  const { data: perfil, error: errPerfil } = await servidor
    .from("perfiles").select("id, rol, activo").eq("id", id).maybeSingle();
  if (errPerfil) {
    logger.error({ err: errPerfil }, "no se pudo leer el perfil del usuario objetivo");
    res.status(500).json({ error: "No se pudo comprobar el usuario." });
    return;
  }
  if (!perfil) { res.status(404).json({ error: "Ese usuario no existe." }); return; }
  if (perfil.rol === "admin") {
    res.status(400).json({ error: "La cuenta del administrador no se gestiona desde esta pantalla. Se recupera desde el panel de Supabase (Authentication)." });
    return;
  }
  if (!ROLES_ASIGNABLES.includes(perfil.rol as RolAsignable)) {
    res.status(409).json({ error: "El rol de esa cuenta no permite generar un enlace." });
    return;
  }
  if (perfil.activo !== true) {
    res.status(409).json({ error: "Esa cuenta está dada de baja. Reactívala antes de generar un enlace de recuperación." });
    return;
  }

  // el correo vive en Auth, no en `perfiles`
  let correo = "";
  try {
    const { data: cuenta, error: errCuenta } = await servidor.auth.admin.getUserById(id);
    if (errCuenta) {
      logger.error({ estado: errCuenta.status ?? null, mensaje: errCuenta.message }, "no se pudo leer la cuenta de Auth del usuario objetivo");
      res.status(502).json({ error: "No se pudo leer la cuenta en Supabase. Inténtalo de nuevo." });
      return;
    }
    correo = typeof cuenta?.user?.email === "string" ? cuenta.user.email.trim() : "";
  } catch (e) {
    logger.error({ mensaje: e instanceof Error ? e.message : String(e) }, "getUserById lanzó una excepción");
    res.status(502).json({ error: "No se pudo contactar con Supabase. Inténtalo de nuevo." });
    return;
  }
  if (!correo) { res.status(409).json({ error: "Esa cuenta no tiene un correo asociado: no se puede generar el enlace." }); return; }

  const generado = await generarEnlaceDeRecuperacion(correo, perfil.rol);
  if (!generado.ok) {
    // configuración del servidor (origen sin definir o mal escrito) = 503; lo que falla en Supabase o en la red = 502
    const estado = generado.motivo === "sin-origin" || generado.motivo === "origin-invalido" ? 503
      : generado.motivo === "rol-desconocido" ? 409 : 502;
    res.status(estado).json({ error: generado.aviso, motivoSinEnlace: generado.motivo });
    return;
  }

  // se registra QUIÉN lo pidió y PARA QUIÉN (ids), nunca el enlace ni el correo
  logger.info({ evento: "enlace-recuperacion-generado", por: req.quien!.id, para: id, rol: perfil.rol }, "enlace de recuperación generado");
  res.json({
    enlaceParaEstablecerClave: generado.enlace,
    nota: "Pásale este enlace a la persona. Es de un solo uso y reemplaza cualquier enlace anterior: ahí elige su nueva contraseña.",
  });
});

/* ───────────────── PATCH /api/admin/usuarios/:id ───────────────── */
router.patch("/admin/usuarios/:id", exigirConfiguracion, exigirAdmin, async (req: PeticionAdmin, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const cuerpo = (req.body ?? {}) as Record<string, unknown>;

  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "Identificador no válido." }); return; }

  // el administrador no se toca a sí mismo desde aquí: un descuido lo dejaría
  // fuera de su propio sistema, y no habría forma de volver a entrar
  if (id === req.quien!.id) {
    res.status(400).json({ error: "No puedes modificar tu propia cuenta administrativa desde esta pantalla." });
    return;
  }

  const cambios: Record<string, unknown> = {};

  if ("rol" in cuerpo) {
    const rol = String(cuerpo["rol"] ?? "").trim();
    if (rol === "admin") { res.status(400).json({ error: "No se puede nombrar otro administrador. El sistema admite uno solo." }); return; }
    if (!ROLES_ASIGNABLES.includes(rol as RolAsignable)) { res.status(400).json({ error: `El rol debe ser uno de: ${ROLES_ASIGNABLES.join(", ")}.` }); return; }
    cambios["rol"] = rol;
  }
  if ("activo" in cuerpo) {
    if (typeof cuerpo["activo"] !== "boolean") { res.status(400).json({ error: "«activo» tiene que ser verdadero o falso." }); return; }
    cambios["activo"] = cuerpo["activo"];
  }
  if ("nombre" in cuerpo) {
    const nombre = String(cuerpo["nombre"] ?? "").trim();
    if (nombre.length < 2 || nombre.length > 60) { res.status(400).json({ error: "El nombre debe tener entre 2 y 60 letras." }); return; }
    cambios["nombre"] = nombre;
  }
  if ("telefono" in cuerpo) {
    const tel = String(cuerpo["telefono"] ?? "").trim();
    if (tel && !/^[0-9+\-\s()]{6,20}$/.test(tel)) { res.status(400).json({ error: "El teléfono no tiene una forma válida." }); return; }
    cambios["telefono"] = tel || null;
  }
  if (Object.keys(cambios).length === 0) { res.status(400).json({ error: "No has pedido ningún cambio." }); return; }

  // que el objetivo exista, y que no sea el administrador
  const { data: destino } = await servidor.from("perfiles").select("id, rol").eq("id", id).maybeSingle();
  if (!destino) { res.status(404).json({ error: "Ese usuario no existe." }); return; }
  if (destino.rol === "admin") { res.status(400).json({ error: "La cuenta del administrador no se modifica desde esta pantalla." }); return; }

  // la escritura va EN NOMBRE DEL ADMIN: RLS y el disparador deciden
  const { data: actualizado, error } = await comoElAdmin(req.quien!.token)
    .from("perfiles").update(cambios).eq("id", id).select("id, nombre, rol, telefono, activo").maybeSingle();

  if (error) {
    logger.warn({ err: error, id }, "la base rechazó el cambio de perfil");
    res.status(400).json({ error: error.message });   // el mensaje de la base, tal cual
    return;
  }
  if (!actualizado) { res.status(403).json({ error: "La base no permitió el cambio." }); return; }

  res.json({ usuario: actualizado });
});

export default router;
