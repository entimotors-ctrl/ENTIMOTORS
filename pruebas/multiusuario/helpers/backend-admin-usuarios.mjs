// EJECUTA el api-server REAL (api-server/src/routes/admin-usuarios.ts) en las pruebas, SIN red, SIN Supabase real y SIN `npm install`:
//   · el TypeScript se convierte a JS con helpers/ts-a-js.mjs (solo quita tipos; el JS se conserva tal cual);
//   · `express`, `@supabase/supabase-js`, `ws` y el logger se sustituyen por FALSOS que viven en un directorio temporal de os.tmpdir() y se borra al terminar;
//   · cada escenario importa una COPIA NUEVA del modulo (lee sus variables de entorno al cargarse), asi se prueban distintas configuraciones de origenes;
//   · el «Supabase» falso sabe lo justo para esta ruta (getUser, perfiles, getUserById, generateLink, createUser…) y anota cada llamada.
// Todo dato es SINTETICO. Ninguna clave, token o enlace de este archivo existe fuera de las pruebas.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RAIZ } from "./entorno.mjs";
import { tsAJs } from "./ts-a-js.mjs";

export const FUENTE_TS = path.join(RAIZ, "api-server/src/routes/admin-usuarios.ts");
export const SERVICE_KEY = "SERVICIO-SINTETICO-NO-ES-UNA-CLAVE";
export const ANON_KEY = "ANONIMA-SINTETICA-NO-ES-UNA-CLAVE";
export const SUPABASE_URL = "https://proyecto-sintetico.example.test";
export const ORIGEN_TALLER = "https://taller.example.test/entimotors-os/";
export const ORIGEN_MITRABAJO = "https://mitrabajo.example.test";
export const TOKEN_ADMIN = "token-sintetico-del-admin";
export const ID_ADMIN = "00000000-0000-4000-8000-000000000001";
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let dir = null, contador = 0, moduloEscrito = null;
const DEPS = {
  "express.mjs": `export function Router() { return globalThis.__BACKEND.nuevoRouter(); }\n`,
  "supabase.mjs": `export function createClient(url, key, opts) { return globalThis.__BACKEND.crearCliente(url, key, opts); }\n`,
  "ws.mjs": `export default class WebSocketFalso {}\n`,
  "logger.mjs": `export const logger = new Proxy({}, { get: (_, nivel) => (...a) => globalThis.__BACKEND.registrar(String(nivel), a) });\n`,
};
const REEMPLAZOS = { '"express"': '"./express.mjs"', '"@supabase/supabase-js"': '"./supabase.mjs"', '"ws"': '"./ws.mjs"', '"../lib/logger.js"': '"./logger.mjs"' };

/** Escribe (una vez por proceso) el modulo real convertido a JS junto a sus dependencias falsas. `transpilar` permite cambiar el conversor (uso interno de verificacion). */
function preparar(transpilar = tsAJs) {
  if (dir && moduloEscrito && moduloEscrito.transpilar === transpilar) return moduloEscrito;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-backend-"));
  for (const [n, c] of Object.entries(DEPS)) fs.writeFileSync(path.join(dir, n), c);
  let js = transpilar(fs.readFileSync(FUENTE_TS, "utf8"));
  for (const [de, a] of Object.entries(REEMPLAZOS)) { if (!js.includes(`from ${de}`)) throw new Error(`el modulo ya no importa ${de}: actualiza el cargador de pruebas`); js = js.split(`from ${de}`).join(`from ${a}`); }
  const sobrantes = [...js.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]).filter((s) => !s.startsWith("./"));
  if (sobrantes.length) throw new Error(`importaciones sin sustituir: ${sobrantes.join(", ")}`);
  const archivo = path.join(dir, "admin-usuarios.mjs"); fs.writeFileSync(archivo, js);
  moduloEscrito = { archivo, transpilar, js };
  return moduloEscrito;
}
export function limpiarBackend() { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; moduloEscrito = null; }
process.on("exit", () => { try { limpiarBackend(); } catch { /* ya no esta */ } });

/** Estado de un escenario: la «base» sintetica (Auth + perfiles) y el registro de todo lo que el servidor hizo. */
export function nuevoEstado(extra = {}) {
  const e = {
    sesiones: new Map([[TOKEN_ADMIN, { id: ID_ADMIN, email: "admin@example.test" }]]),
    perfiles: new Map([
      [ID_ADMIN, { id: ID_ADMIN, nombre: "Admin Sintetico", rol: "admin", activo: true }],
      [uuid(3), { id: uuid(3), nombre: "Mecanico Sintetico", rol: "mecanico", activo: true }],
      [uuid(4), { id: uuid(4), nombre: "Cajero Sintetico", rol: "cajero", activo: true }],
      [uuid(5), { id: uuid(5), nombre: "Dev Sintetico", rol: "desarrollador", activo: true }],
      [uuid(6), { id: uuid(6), nombre: "Mecanico De Baja", rol: "mecanico", activo: false }],
      [uuid(7), { id: uuid(7), nombre: "Otro Admin", rol: "admin", activo: false }],
      [uuid(8), { id: uuid(8), nombre: "Rol Raro", rol: "superadmin", activo: true }],
      [uuid(9), { id: uuid(9), nombre: "Sin Correo", rol: "cajero", activo: true }],
      [uuid(10), { id: uuid(10), nombre: "Cajero Sesion", rol: "cajero", activo: true }],
    ]),
    correos: new Map([[ID_ADMIN, "admin@example.test"], [uuid(3), "mecanico@example.test"], [uuid(4), "cajero@example.test"], [uuid(5), "dev@example.test"],
      [uuid(6), "baja@example.test"], [uuid(7), "otroadmin@example.test"], [uuid(8), "raro@example.test"], [uuid(10), "cajero2@example.test"]]),
    generateLink: null,       // (args) => resultado; por defecto un enlace sintetico con un token unico
    getUserById: null,        // (id) => resultado
    errorPerfiles: null,      // fuerza un error al leer `perfiles`
    llamadas: { generateLink: [], getUserById: [], getUser: [], leerPerfil: [], createUser: [], deleteUser: [], actualizarPerfil: [] },
    logs: [], enlacesEmitidos: [], respuestas: [],
    ...extra,
  };
  return e;
}

/** Crea una copia NUEVA del modulo real con el entorno dado y devuelve una API para invocar sus rutas como lo haria Express. */
export async function crearBackend({ env = {}, estado = nuevoEstado(), transpilar } = {}) {
  const { archivo } = preparar(transpilar);
  const entorno = { SUPABASE_URL, SUPABASE_SERVICE_KEY: SERVICE_KEY, SUPABASE_ANON_KEY: ANON_KEY, ENTIMOTORS_ADMIN_ORIGIN: ORIGEN_TALLER, ENTIMOTORS_MECHANIC_ORIGIN: ORIGEN_MITRABAJO, ...env };
  const rutas = []; let seqEnlace = 0;
  const nuevoRouter = () => {
    const r = { rutas };
    for (const m of ["get", "post", "patch", "put", "delete"]) r[m] = (ruta, ...handlers) => { rutas.push({ metodo: m.toUpperCase(), ruta, handlers }); return r; };
    r.use = () => r;
    return r;
  };
  const crearCliente = (url, key, opts) => {
    const enNombreDelAdmin = key === ANON_KEY;
    const auth = String((opts && opts.global && opts.global.headers && opts.global.headers.Authorization) || "");
    const consulta = (tabla) => {
      const q = { op: "select", filtros: [], cambios: null };
      const filas = () => (tabla === "perfiles" ? [...estado.perfiles.values()] : []).filter((f) => q.filtros.every(([c, v]) => f[c] === v));
      const resolver = async (modo) => {
        if (tabla !== "perfiles") return { data: null, error: { message: `tabla no simulada: ${tabla}` } };
        if (q.op === "update") {
          estado.llamadas.actualizarPerfil.push({ enNombreDelAdmin, auth, cambios: q.cambios, filtros: q.filtros });
          const fs2 = filas(); for (const f of fs2) Object.assign(f, q.cambios);
          return modo === "lista" ? { data: fs2, error: null } : { data: fs2[0] ?? null, error: fs2[0] ? null : { message: "sin filas" } };
        }
        estado.llamadas.leerPerfil.push({ enNombreDelAdmin, filtros: q.filtros });
        if (estado.errorPerfiles) return { data: null, error: { message: String(estado.errorPerfiles) } };
        const fs2 = filas().map((f) => ({ ...f }));
        return modo === "lista" ? { data: fs2, error: null } : { data: fs2[0] ?? null, error: null };
      };
      const api = {
        select() { return api; }, eq(c, v) { q.filtros.push([c, v]); return api; }, order() { return api; },
        update(obj) { q.op = "update"; q.cambios = obj; return api; },
        maybeSingle: () => resolver("maybe"), single: () => resolver("single"), then: (ok, ko) => resolver("lista").then(ok, ko),
      };
      return api;
    };
    return {
      auth: {
        getUser: async (tk) => { estado.llamadas.getUser.push({ conServicio: !enNombreDelAdmin }); const u = estado.sesiones.get(tk); return u ? { data: { user: { id: u.id, email: u.email } }, error: null } : { data: { user: null }, error: { message: "invalid JWT", status: 401 } }; },
        admin: {
          getUserById: async (id) => { estado.llamadas.getUserById.push(id); if (estado.getUserById) return estado.getUserById(id); const c = estado.correos.get(id); return c === undefined ? { data: { user: { id } }, error: null } : { data: { user: { id, email: c } }, error: null }; },
          listUsers: async () => ({ data: { users: [...estado.correos].map(([id, email]) => ({ id, email })) }, error: null }),
          createUser: async (a) => { estado.llamadas.createUser.push({ email: a.email, conClave: typeof a.password === "string" }); const id = uuid(100 + estado.llamadas.createUser.length); estado.correos.set(id, a.email); estado.perfiles.set(id, { id, nombre: "", rol: "mecanico", activo: true }); return { data: { user: { id, email: a.email } }, error: null }; },
          deleteUser: async (id) => { estado.llamadas.deleteUser.push(id); estado.correos.delete(id); estado.perfiles.delete(id); return { data: null, error: null }; },
          generateLink: async (a) => {
            estado.llamadas.generateLink.push({ type: a.type, email: a.email, redirectTo: a.options && a.options.redirectTo });
            if (estado.generateLink) return estado.generateLink(a);
            const token = `TOKEN-ENLACE-SINTETICO-${++seqEnlace}`; const enlace = `https://enlaces.example.test/auth/v1/verify?token=${token}&type=recovery&redirect_to=${encodeURIComponent(a.options.redirectTo)}`;
            estado.enlacesEmitidos.push({ enlace, token });
            return { data: { properties: { action_link: enlace }, user: { email: a.email } }, error: null };
          },
        },
      },
      from: (tabla) => consulta(tabla),
    };
  };
  const registrar = (nivel, args) => { estado.logs.push({ nivel, args }); };
  const previo = {}; for (const k of Object.keys(entorno)) previo[k] = process.env[k];
  for (const [k, v] of Object.entries(entorno)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const controlador = { nuevoRouter, crearCliente, registrar };
  /** El modulo consulta `globalThis.__BACKEND` al cargarse (createClient, Router) Y en cada peticion (logger, comoElAdmin): se fija durante ambas cosas. */
  const conControlador = async (fn) => { const anterior = globalThis.__BACKEND; globalThis.__BACKEND = controlador; try { return await fn(); } finally { globalThis.__BACKEND = anterior; } };
  let modulo;
  try { modulo = await conControlador(() => import(`${pathToFileURL(archivo).href}?n=${++contador}`)); }
  finally { for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }

  /** Invoca una ruta como Express: recorre su cadena de handlers (middlewares incluidos) y devuelve la respuesta. */
  async function ejecutar(metodo, ruta, { params = {}, headers = {}, body, token = TOKEN_ADMIN, cuerpoProhibido = false, query } = {}) {
    const r = rutas.find((x) => x.metodo === metodo && x.ruta === ruta); if (!r) throw new Error(`ruta no registrada: ${metodo} ${ruta}`);
    const res = { codigo: 200, cuerpo: undefined, cabeceras: {}, terminada: false,
      status(c) { this.codigo = c; return this; }, json(o) { this.cuerpo = o; this.terminada = true; return this; }, setHeader(k, v) { this.cabeceras[String(k).toLowerCase()] = v; return this; } };
    const cabeceras = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    const req = { params, headers: cabeceras, body, query, method: metodo };
    // `cuerpoProhibido`: si el handler LEE req.body (aunque sea sin usarlo) la prueba revienta: asi se demuestra que esa ruta ignora por completo lo que mande el cliente
    if (cuerpoProhibido) Object.defineProperty(req, "body", { get() { throw new Error("el handler leyo req.body"); } });
    const trabajos = []; const correr = (i) => { if (i >= r.handlers.length) return; trabajos.push(Promise.resolve(r.handlers[i](req, res, () => correr(i + 1)))); };
    await conControlador(async () => { correr(0); for (let k = 0; k < trabajos.length; k++) await trabajos[k]; });
    const salida = { status: res.codigo, cuerpo: res.cuerpo, cabeceras: res.cabeceras, terminada: res.terminada };
    estado.respuestas.push(salida); return salida;
  }
  return { modulo, rutas, estado, ejecutar, destino: modulo.destinoDeRecuperacion };
}

/** Todo texto que el servidor escribio en sus registros o devolvio, como una sola cadena (para buscar fugas). */
export const volcado = (estado) => JSON.stringify({ logs: estado.logs, respuestas: estado.respuestas });
