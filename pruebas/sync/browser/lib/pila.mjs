// PILA LOCAL PARA QA DEL CLIENTE DE SINCRONIZACIÓN: Postgres local (Docker, con SYNC-1..3P aplicados) + PostgREST REAL (misma imagen
// que usa Supabase) + JWT firmados con un secreto SINTÉTICO. Todo en 127.0.0.1. Nunca toca producción ni el laboratorio 4d.
//   Requiere: pruebas/sync/entorno-local.sh up   (contenedor entimotors-sync-pg en 127.0.0.1:54432)
import http from "node:http";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ = path.resolve(AQUI, "../../../..");
const SQL = path.join(RAIZ, "taller-demo/supabase/sync");
const ENTORNO = path.join(RAIZ, "pruebas/sync/entorno-local.sh");
export const PG = { host: "127.0.0.1", port: 54432 };
export const REST_PUERTO = 54433;          // «gateway» (lo que ve el navegador, como el Kong de Supabase)
const REST_INTERNO = 54434;                // PostgREST real
export const REST_URL = `http://127.0.0.1:${REST_PUERTO}`;
const SECRETO_JWT = "secreto-sintetico-solo-pruebas-locales-0123456789";   // no es un secreto: la pila solo existe en esta máquina
const IMAGEN_REST = "public.ecr.aws/supabase/postgrest:v14.13";
const CONT_REST = "entimotors-sync-rest";
export const DB = "t_e2e";
const FASES = ["1-esquema", "2-seguridad", "3-rpc", "3b-importacion", "3p-pin", "5-cotizacion-items", "6-mecanicos-ordenes"];

export const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const PERFILES = { admin: uid(1), cajero: uid(2), mecanico: uid(3), mecanico2: uid(4) };

const env = { ...process.env, PGPASSWORD: "postgres" };
export function sql(texto, { db = DB, usuario = "supabase_admin", tolerar = false } = {}) {
  const r = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-h", PG.host, "-p", String(PG.port), "-U", usuario, "-d", db], { input: texto, encoding: "utf8", env });
  if (r.status !== 0 && !tolerar) throw new Error(`psql falló: ${(r.stderr || "").trim().slice(0, 600)}`);
  return (r.stdout || "").trim();
}
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", env, ...opts });

export function jwt(sub, { role = "authenticated", segundos = 3600 } = {}) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b({ alg: "HS256", typ: "JWT" }), p = b({ role, aud: "authenticated", sub, exp: Math.floor(Date.now() / 1000) + segundos });
  return `${h}.${p}.${crypto.createHmac("sha256", SECRETO_JWT).update(`${h}.${p}`).digest("base64url")}`;
}

async function esperarRest() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${REST_INTERNO}/`, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return; } catch { /* aún no */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("PostgREST no respondió: " + sh("docker", ["logs", "--tail", "8", CONT_REST]).stdout);
}


/* GATEWAY: en Supabase, Kong va delante de PostgREST: exige `apikey`, contesta el CORS del navegador (permite apikey/prefer/…) y expone
   Content-Range. PostgREST suelto no hace nada de eso, así que aquí se reproduce lo mínimo. Reenvía el resto tal cual. */
function arrancarGateway() {
  const srv = http.createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": req.headers.origin || "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*", "Access-Control-Expose-Headers": "Content-Range,Content-Location,Location,Retry-After", "Access-Control-Max-Age": "600", Vary: "Origin" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    if (!req.headers.apikey) { res.writeHead(401, { ...cors, "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "No API key found in request" })); }
    const cab = { ...req.headers, host: `127.0.0.1:${REST_INTERNO}` }; delete cab.origin; delete cab.referer;
    const p = http.request({ host: "127.0.0.1", port: REST_INTERNO, path: req.url.replace(/^\/rest\/v1/, ""), method: req.method, headers: cab }, (r) => { res.writeHead(r.statusCode, { ...r.headers, ...cors }); r.pipe(res); });
    p.on("error", (e) => { res.writeHead(502, cors); res.end(String(e.message)); });
    req.pipe(p);
  });
  return new Promise((ok) => srv.listen(REST_PUERTO, "127.0.0.1", () => ok(srv)));
}

/** Crea la base t_e2e desde cero (producción + SYNC-1..3P), siembra perfiles y arranca PostgREST. */
export async function iniciarPila() {
  if (sh("pg_isready", ["-q", "-h", PG.host, "-p", String(PG.port)]).status !== 0) throw new Error("El Postgres local no responde: ejecuta pruebas/sync/entorno-local.sh up");
  sh("docker", ["rm", "-f", CONT_REST]);
  sh("bash", [ENTORNO, "borra", DB]);
  const c = sh("bash", [ENTORNO, "copia", DB]);
  if (c.status !== 0) throw new Error("no se pudo crear la base: " + c.stderr);
  for (const f of FASES) sql(`\\i ${path.join(SQL, `sync-${f}.sql`)}`);
  sql("alter role authenticator with password 'postgres'", { db: "postgres" });
  // Supabase real: auth.uid() lee el claim del JWT tanto de la variable antigua como de request.jwt.claims (lo único que fija PostgREST moderno).
  // La imagen local solo lee la antigua; se iguala aquí (solo en esta base de pruebas) para que el token viaje como en producción.
  sql(`create or replace function auth.uid() returns uuid language sql stable as $f$
         select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;`);
  sql(`set session_replication_role = replica;   -- el trigger de roles exige un admin con JWT: aquí se siembra la base de pruebas
       insert into auth.users (id, email) values ${Object.entries(PERFILES).map(([k, v]) => `('${v}', '${k}@example.test')`).join(",")};
       insert into public.perfiles (id, nombre, rol, activo) values ('${PERFILES.admin}','Admin','admin',true),('${PERFILES.cajero}','Caja','cajero',true),('${PERFILES.mecanico}','Mec Uno','mecanico',true),('${PERFILES.mecanico2}','Mec Dos','mecanico',true)
       on conflict (id) do update set nombre = excluded.nombre, rol = excluded.rol, activo = true;`);   // un trigger de auth.users ya crea el perfil base
  const r = sh("docker", ["run", "-d", "--name", CONT_REST, "--network", "host",
    "-e", `PGRST_DB_URI=postgres://authenticator:postgres@${PG.host}:${PG.port}/${DB}`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon",
    "-e", `PGRST_JWT_SECRET=${SECRETO_JWT}`, "-e", "PGRST_DB_MAX_ROWS=1000", "-e", "PGRST_SERVER_HOST=127.0.0.1", "-e", `PGRST_SERVER_PORT=${REST_INTERNO}`, IMAGEN_REST]);
  if (r.status !== 0) throw new Error("no se pudo arrancar PostgREST: " + r.stderr);
  await esperarRest();
  const gateway = await arrancarGateway();
  return {
    jwt, sql, uid, PERFILES, REST_URL,
    /** Vacía los datos operativos (la protección de las tablas de dinero se salta con replica solo aquí, en la base de pruebas) y
        restaura los 4 perfiles sembrados a activo=true — SYNC-6 introdujo pruebas que desactivan un perfil a propósito
        (perfiles NO se trunca: es la identidad fija que usan TODAS las pruebas), así que sin este reset una prueba que
        corra después de esa quedaría con un mecánico inactivo por accidente, sin que su propio código lo pida. */
    limpiar() {
      sql(`set session_replication_role = replica;
           truncate public.clientes, public.motos, public.citas, public.categorias_inv, public.cotizaciones, public.cotizacion_items,
             public.web_cms, public.ordenes, public.orden_items cascade;
           reset session_replication_role;
           update public.perfiles set activo = true where id in (${Object.values(PERFILES).map((v) => `'${v}'`).join(",")});`);
    },
    async detener() { gateway.closeAllConnections?.(); gateway.close(); sh("docker", ["rm", "-f", CONT_REST]); sh("bash", [ENTORNO, "borra", DB]); },
  };
}
