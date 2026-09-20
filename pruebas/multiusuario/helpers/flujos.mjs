// Atajos de escenario para las pruebas: entornos con sesion guardada, login por formulario, etc.
// Todo sintetico; nada toca red ni datos reales.
import { crearEntorno } from "./entorno.mjs";
import { crearServidor, CUENTAS } from "./supabase-mock.mjs";

/**
 * Entorno con el runtime real cargado. Opciones:
 *  cuenta          → se emite una sesion valida del servidor sintetico y se guarda (entimotors_sb_sesion)
 *  sesionGuardada  → contenido de enti_session (la sesion de la app)
 *  perfilCacheado  → contenido de enti_perfil_supabase (copia del perfil para arrancar sin red)
 *  espiarStartApp  → reemplaza startApp por un espia que NO abre IndexedDB (por defecto true)
 */
export function nuevoEntorno(o = {}) {
  const { producto = "admin", cuenta = null, sesionGuardada = null, perfilCacheado = null, expiraEnS = 3600,
    servidor = crearServidor(), online = true, local, apiUrl = "", espiarStartApp = true, scripts, storageExtra = {}, mutar, hash, search, standalone, pathname, preparar } = o;
  const storage = { ...storageExtra };
  if (cuenta) storage.entimotors_sb_sesion = JSON.stringify(servidor.emitirSesion(cuenta, { expiraEnS }));
  if (sesionGuardada) storage.enti_session = JSON.stringify(sesionGuardada);
  if (perfilCacheado) storage.enti_perfil_supabase = JSON.stringify(perfilCacheado);
  const env = crearEntorno({ producto, servidor, storage, online, local, apiUrl, ...(scripts ? { scripts } : {}), ...(mutar ? { mutar } : {}),
    ...(hash !== undefined ? { hash } : {}), ...(search !== undefined ? { search } : {}), ...(standalone !== undefined ? { standalone } : {}), ...(pathname ? { pathname } : {}), ...(preparar ? { preparar } : {}) });
  env.startApp = [];
  if (espiarStartApp && typeof env.win.startApp === "function") env.startApp = env.espiar("startApp", () => Promise.resolve());
  return env;
}

export const perfilDe = (c) => ({ uid: c.uid, nombre: c.perfil.nombre, rol: c.perfil.rol, activo: c.perfil.activo });
/** La sesion de app (enti_session) que app.js guardaria para una cuenta de Supabase. */
export const sesionAppDe = (c, extra = {}) => ({ user: c.correo, uid: c.uid, perfilId: c.uid, nombre: c.perfil.nombre, telefono: "", rol: c.perfil.rol, origen: "supabase", activo: c.perfil.activo !== false, ...extra });

/** Rellena el formulario de login y lo envia como lo haria el navegador. */
export async function enviarLogin(env, usuario, clave) {
  env.doc.getElementById("loginUser").value = usuario;
  env.doc.getElementById("loginPass").value = clave;
  const form = env.doc.getElementById("loginForm");
  await form.disparar("submit");
  await env.asentar();
  return { error: env.doc.getElementById("loginError").textContent, claveEnDom: env.doc.getElementById("loginPass").value };
}

export const activo = (env, id) => env.doc.getElementById(id).classList.contains("active");
export { CUENTAS, crearServidor };

// ── observacion de la interfaz ──
/** Textos de los toast mostrados (toast() de app.js asigna innerHTML con `<span class="dot …"></span>` + mensaje). */
export const toasts = (env) => env.doc.sumideros.filter((s) => /^<span class="dot /.test(s.html)).map((s) => s.html.replace(/^<span class="dot [^"]*"><\/span>/, ""));
export const como = (env, usuario) => env.evaluar(`currentUser = ${JSON.stringify(usuario)}`);
/** Reemplaza el acceso a IndexedDB de app.js por un almacen en memoria y registra lo que se guarda. */
export function dbFalsa(env, datos = {}) {
  env.win.__datos = datos; env.win.__guardados = [];
  env.evaluar(`DB.getAll = async (s) => (window.__datos[s] || []).map(x => x);
               DB.get = async (s, id) => { const a = (window.__datos[s] || []).find(x => x.id === id); return a ? { ...a } : undefined; };
               DB.save = async (s, v) => { window.__guardados.push([s, JSON.parse(JSON.stringify(v))]); const l = (window.__datos[s] ||= []); const i = l.findIndex(x => x.id === v.id); if (i >= 0) l[i] = v; else l.push(v); return v.id; };`);
  return { guardados: () => env.win.__guardados };
}
