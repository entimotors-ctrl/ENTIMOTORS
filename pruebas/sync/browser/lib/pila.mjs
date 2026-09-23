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
/* SYNC-9 · STORAGE REAL (opcional: iniciarPila({ storage: true })). La MISMA imagen de Storage de Supabase que ya estaba
   descargada en la máquina (storage-api v1.60.15), en un contenedor PROPIO de esta pila (no el del laboratorio 4d),
   escuchando solo en 127.0.0.1, con backend de archivos DENTRO del contenedor (se pierde al borrarlo), contra la base de
   pruebas t_e2e y el mismo secreto JWT sintético. Nunca toca producción ni el laboratorio. */
const IMAGEN_STORAGE = "public.ecr.aws/supabase/storage-api:v1.60.15";
const CONT_STORAGE = "entimotors-sync-storage";
const STORAGE_INTERNO = 54435;
export const DB = "t_e2e";
const FASES = ["1-esquema", "2-seguridad", "3-rpc", "3b-importacion", "3p-pin", "5-cotizacion-items", "6-mecanicos-ordenes", "7a-inventario", "9-fotos"];

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
/* ═══ SHIM DE AUTH — SOLO PRUEBAS LOCALES (SYNC-7B) ═══
   La pila local no tiene GoTrue, y el api-server real valida la sesión con `auth.getUser(token)` (GET /auth/v1/user)
   y re-autentica al admin con /auth/v1/token?grant_type=password. Este shim responde SOLO esas dos rutas, SOLO dentro
   de este gateway de pruebas (127.0.0.1, vive y muere con iniciarPila()/detener()), y SOLO para tokens firmados con el
   secreto sintético de ESTA pila (cualquier otro → 401). No hay bandera ni variable que lo active en producción: el
   código no existe fuera de pruebas/sync (guarda estática en pruebas/sync/node/sync7b.test.mjs). La identidad sale del
   `sub` del JWT (UUIDs deterministas de PERFILES); el rol y `activo` los decide `perfiles` en la base, como en producción. */
export const CLAVE_CUENTA_PRUEBA = "clave-sintetica-solo-pruebas";   // no es un secreto: solo la acepta este shim local
function verificarJwtLocal(token) {
  const [h, p, f] = String(token || "").split(".");
  if (!h || !p || !f) return null;
  const esperado = crypto.createHmac("sha256", SECRETO_JWT).update(`${h}.${p}`).digest("base64url");
  if (f.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(f), Buffer.from(esperado))) return null;
  let c; try { c = JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch { return null; }
  if (!c.sub || typeof c.exp !== "number" || c.exp * 1000 < Date.now()) return null;
  return c;
}
function correoDe(sub) { const e = Object.entries(PERFILES).find(([, v]) => v === sub); return e ? `${e[0]}@example.test` : `${sub}@example.test`; }
function shimAuth(req, res, cors) {
  const u = new URL(req.url, "http://x");
  const responder = (st, cuerpo) => { res.writeHead(st, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(cuerpo)); };
  if (u.pathname === "/auth/v1/user" && req.method === "GET") {
    const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const c = verificarJwtLocal(tok);
    if (!c || c.role !== "authenticated") return responder(401, { code: 401, msg: "invalid JWT" });
    return responder(200, { id: c.sub, aud: "authenticated", role: "authenticated", email: correoDe(c.sub) });
  }
  if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "password" && req.method === "POST") {
    let cuerpo = ""; req.on("data", (d) => { cuerpo += d; });
    req.on("end", () => {
      let b = {}; try { b = JSON.parse(cuerpo); } catch { /* vacío */ }
      const e = Object.entries(PERFILES).find(([k]) => `${k}@example.test` === b.email);
      if (!e || b.password !== CLAVE_CUENTA_PRUEBA) return responder(400, { error: "invalid_grant" });
      responder(200, { access_token: jwt(e[1]), token_type: "bearer" });
    });
    return true;
  }
  return responder(404, { msg: "ruta de auth no simulada" });
}

const gatewayStorage = { activo: false };
async function esperarStorage() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`http://127.0.0.1:${STORAGE_INTERNO}/status`, { signal: AbortSignal.timeout(1500) }); if (r.status === 200) return; } catch { /* aún no */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("storage-api no respondió: " + sh("docker", ["logs", "--tail", "8", CONT_STORAGE]).stdout.slice(0, 800));
}
/* La copia de producción trae `storage` como STUB (tablas reducidas, dueño postgres): la migración real de storage-api no
   puede adoptarlo. Solo en ESTA base de pruebas: se quita el stub (0 objetos), storage-api crea su esquema real y se
   restauran EXACTAMENTE los buckets y la política de producción (entimotors-taller privado, entimotors-media público,
   taller_borra_media). Las políticas de SYNC-2 (taller_lee_media/taller_sube_media) las crea luego la fase 2, como en
   producción. */
async function arrancarStorage() {
  sql(`drop schema storage cascade; grant create on database ${DB} to supabase_storage_admin; create schema storage authorization supabase_storage_admin;`);
  sql("alter role supabase_storage_admin with password 'postgres'", { db: "postgres" });
  sh("docker", ["rm", "-f", CONT_STORAGE]);
  const r = sh("docker", ["run", "-d", "--name", CONT_STORAGE, "--network", "host",
    "-e", "ANON_KEY=" + jwt(null, { role: "anon" }), "-e", "SERVICE_KEY=" + jwt(null, { role: "service_role" }), "-e", `AUTH_JWT_SECRET=${SECRETO_JWT}`, "-e", "AUTH_JWT_ALGORITHM=HS256",
    "-e", `DATABASE_URL=postgres://supabase_storage_admin:postgres@${PG.host}:${PG.port}/${DB}`, "-e", "STORAGE_BACKEND=file", "-e", "FILE_STORAGE_BACKEND_PATH=/tmp/entimotors-storage",
    "-e", "TENANT_ID=stub", "-e", "STORAGE_S3_REGION=local", "-e", "GLOBAL_S3_BUCKET=stub", "-e", `SERVER_PORT=${STORAGE_INTERNO}`, "-e", "SERVER_HOST=127.0.0.1",
    "-e", `PORT=${STORAGE_INTERNO}`, "-e", "HOST=127.0.0.1", "-e", "FILE_SIZE_LIMIT=52428800", "-e", "ENABLE_IMAGE_TRANSFORMATION=false", "-e", "VECTOR_ENABLED=false", "-e", "S3_PROTOCOL_ENABLED=false", IMAGEN_STORAGE]);
  if (r.status !== 0) throw new Error("no se pudo arrancar storage-api: " + r.stderr);
  await esperarStorage();
  // mismos privilegios que la copia de producción (USAGE en el esquema; arwd en buckets/objects para anon/authenticated/
  // service_role, con RLS activa: la que decide es la política, igual que en Supabase)
  sql(`grant usage on schema storage to anon, authenticated, service_role, postgres;
       grant select, insert, update, delete on storage.buckets, storage.objects to anon, authenticated, service_role;
       alter table storage.objects enable row level security; alter table storage.buckets enable row level security;`);
  sql(`insert into storage.buckets (id, name, public) values ('entimotors-taller', 'entimotors-taller', false), ('entimotors-media', 'entimotors-media', true) on conflict (id) do nothing;
       drop policy if exists taller_borra_media on storage.objects;
       create policy taller_borra_media on storage.objects for delete to public using ((bucket_id = 'entimotors-taller'::text) AND public.es_admin());`);
}

function arrancarGateway() {
  const srv = http.createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": req.headers.origin || "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*", "Access-Control-Expose-Headers": "Content-Range,Content-Location,Location,Retry-After", "Access-Control-Max-Age": "600", Vary: "Origin" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    // como Kong de Supabase: /storage/v1 NO exige apikey (una URL firmada en un <img> no lleva cabeceras; storage-api
    // valida el token firmado o el JWT por su cuenta). El resto sí.
    if (!req.headers.apikey && !req.url.startsWith("/storage/v1/")) { res.writeHead(401, { ...cors, "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "No API key found in request" })); }
    if (req.url.startsWith("/auth/v1/")) return shimAuth(req, res, cors);
    // como Kong: /storage/v1/* → storage-api (sin el prefijo). Sin pila de Storage, 404 como siempre.
    if (req.url.startsWith("/storage/v1/")) {
      if (!gatewayStorage.activo) { res.writeHead(404, { ...cors, "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "sin storage en esta pila" })); }
      const cabS = { ...req.headers, host: `127.0.0.1:${STORAGE_INTERNO}` }; delete cabS.origin; delete cabS.referer;
      const ps = http.request({ host: "127.0.0.1", port: STORAGE_INTERNO, path: req.url.replace(/^\/storage\/v1/, ""), method: req.method, headers: cabS }, (r) => { res.writeHead(r.statusCode, { ...r.headers, ...cors }); r.pipe(res); });
      ps.on("error", (e) => { res.writeHead(502, cors); res.end(String(e.message)); });
      return req.pipe(ps);
    }
    const cab = { ...req.headers, host: `127.0.0.1:${REST_INTERNO}` }; delete cab.origin; delete cab.referer;
    const p = http.request({ host: "127.0.0.1", port: REST_INTERNO, path: req.url.replace(/^\/rest\/v1/, ""), method: req.method, headers: cab }, (r) => { res.writeHead(r.statusCode, { ...r.headers, ...cors }); r.pipe(res); });
    p.on("error", (e) => { res.writeHead(502, cors); res.end(String(e.message)); });
    req.pipe(p);
  });
  return new Promise((ok) => srv.listen(REST_PUERTO, "127.0.0.1", () => ok(srv)));
}

/** Crea la base t_e2e desde cero (producción + SYNC-1..3P), siembra perfiles y arranca PostgREST. */
export async function iniciarPila({ storage = false } = {}) {
  if (sh("pg_isready", ["-q", "-h", PG.host, "-p", String(PG.port)]).status !== 0) throw new Error("El Postgres local no responde: ejecuta pruebas/sync/entorno-local.sh up");
  sh("docker", ["rm", "-f", CONT_REST]);
  sh("bash", [ENTORNO, "borra", DB]);
  const c = sh("bash", [ENTORNO, "copia", DB]);
  if (c.status !== 0) throw new Error("no se pudo crear la base: " + c.stderr);
  if (storage) await arrancarStorage();
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
  gatewayStorage.activo = storage;
  return {
    jwt, sql, uid, PERFILES, REST_URL,
    /** Vacía los datos operativos (la protección de las tablas de dinero se salta con replica solo aquí, en la base de pruebas) y
        restaura los 4 perfiles sembrados a activo=true — SYNC-6 introdujo pruebas que desactivan un perfil a propósito
        (perfiles NO se trunca: es la identidad fija que usan TODAS las pruebas), así que sin este reset una prueba que
        corra después de esa quedaría con un mecánico inactivo por accidente, sin que su propio código lo pida. */
    limpiar() {
      sql(`set session_replication_role = replica;
           truncate public.clientes, public.motos, public.citas, public.categorias_inv, public.cotizaciones, public.cotizacion_items,
             public.web_cms, public.ordenes, public.orden_items, public.inventario, public.inventario_movimientos,
             public.ventas, public.venta_items, public.creditos, public.credito_items, public.abonos, public.caja_movimientos,
             public.reversos, public.sync_ops, public.autorizaciones_admin cascade;
           reset session_replication_role;
           update public.perfiles set activo = true where id in (${Object.values(PERFILES).map((v) => `'${v}'`).join(",")});`);
    },
    async detener() { gateway.closeAllConnections?.(); gateway.close(); sh("docker", ["rm", "-f", CONT_REST]); if (storage) sh("docker", ["rm", "-f", CONT_STORAGE]); gatewayStorage.activo = false; sh("bash", [ENTORNO, "borra", DB]); },
  };
}
