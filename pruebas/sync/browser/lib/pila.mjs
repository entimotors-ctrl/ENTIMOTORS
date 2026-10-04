// PILA LOCAL PARA QA DEL CLIENTE DE SINCRONIZACIÓN: Postgres local (Docker, con SYNC-1..3P aplicados) + PostgREST REAL (misma imagen
// que usa Supabase) + JWT firmados con un secreto SINTÉTICO. Todo en 127.0.0.1. Nunca toca producción ni el laboratorio 4d.
//   Requiere: pruebas/sync/entorno-local.sh up   (contenedor entimotors-sync-pg en 127.0.0.1:54432)
import http from "node:http";
import net from "node:net";
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
// SYNC-10: la cadena completa de la 3.14 (+ importación atómica). Todas las suites corren sobre ella.
export const FASES = ["1-esquema", "2-seguridad", "3-rpc", "3b-importacion", "3p-pin", "5-cotizacion-items", "6-mecanicos-ordenes", "7a-inventario", "9-fotos", "10-importacion",
  // 3.15.0 · Bloque 1A: la cadena de 3.15 (conversión atómica + guarda de cotización aceptada). iniciarPila({ excluir: [...] })
  // la quita para medir/probar contra la cadena 3.14.1.
  "15a-cotizacion-inventario",
  // 3.15.0 · Bloque 2: tipos de renglón, presupuesto pendiente/aprobado/rechazado y stock exactamente una vez al aprobar.
  "15b-presupuestos-stock",
  // 3.15.0 · Bloque 3: mensajes admin → mecánico + avisos en tiempo real (sin Realtime en la pila, los avisos se omiten)
  "15c-mensajes-realtime",
  // 3.15.0 · Bloque 4: OWNER-PIN-GUARD (destructivas con PIN también para el admin, ligadas a la sesión) + eliminar usuario seguro
  "15d-owner-pin-usuarios", "15e-finanzas",
  // 3.15.0 · Bloque 6: estado de migración 3.13 en el servidor (solo lectura)
  "15f-legado-313",
  // 3.15.0 · Bloque 7: políticas de lectura con su función evaluada una vez por consulta (misma visibilidad, ver correr-sql.sh 15g)
  "15g-rendimiento-rls"];
export const FASES_315 = ["15a-cotizacion-inventario", "15b-presupuestos-stock", "15c-mensajes-realtime", "15d-owner-pin-usuarios", "15e-finanzas", "15f-legado-313", "15g-rendimiento-rls"];
/* 3.15.0 · Bloque 3 · REALTIME REAL (opcional: iniciarPila({ realtime: true })). La MISMA imagen de Supabase Realtime que ya estaba
   descargada (v2.106.0), contenedor PROPIO de esta pila, solo en 127.0.0.1, contra la base de pruebas t_e2e y el mismo secreto JWT
   sintético. El gateway hace lo que Kong en Supabase: /realtime/v1/* (WebSocket) → realtime:/socket/* con el Host del inquilino
   «realtime-dev» (SEED_SELF_HOST), exigiendo apikey. Nunca toca producción. */
const IMAGEN_RT = "public.ecr.aws/supabase/realtime:v2.106.0";
const CONT_RT = "entimotors-sync-rt";
const RT_INTERNO = 54436;
const gatewayRt = { activo: false, caido: false, sockets: new Set(), conexiones: 0, bytesAlCliente: 0, bytesDelCliente: 0 };
/* 3.15.0 · Bloque 4 · GoTrue REAL (opcional: iniciarPila({ gotrue: true })). La misma imagen de Auth que el laboratorio del Bloque 0
   (supabase/gotrue v2.197.0), contenedor propio, solo en 127.0.0.1, contra la base de pruebas t_e2e y el MISMO secreto JWT: sus tokens los
   acepta PostgREST y Realtime como en Supabase. El gateway reenvía /auth/v1/* (proxyAuthReal). Nunca toca producción. */
const IMAGEN_AUTH = "supabase/gotrue:v2.197.0";
const CONT_AUTH = "entimotors-sync-auth";
export const AUTH_INTERNO = 54438;
async function arrancarGotrue() {
  sql("alter role supabase_auth_admin with password 'postgres'", { db: "postgres" });
  sh("docker", ["rm", "-f", CONT_AUTH]);
  const r = sh("docker", ["run", "-d", "--name", CONT_AUTH, "--network", "host",
    "-e", "GOTRUE_API_HOST=127.0.0.1", "-e", `PORT=${AUTH_INTERNO}`, "-e", `API_EXTERNAL_URL=${REST_URL}/auth/v1`,
    "-e", "GOTRUE_DB_DRIVER=postgres", "-e", `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:postgres@${PG.host}:${PG.port}/${DB}`,
    "-e", "GOTRUE_SITE_URL=https://taller.lab.test", "-e", "GOTRUE_URI_ALLOW_LIST=https://taller.lab.test/**,https://mt.lab.test/**",
    "-e", "GOTRUE_DISABLE_SIGNUP=true", "-e", `GOTRUE_JWT_SECRET=${SECRETO_JWT}`, "-e", "GOTRUE_JWT_EXP=3600", "-e", "GOTRUE_JWT_AUD=authenticated",
    "-e", "GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated", "-e", "GOTRUE_JWT_ADMIN_ROLES=service_role", "-e", "GOTRUE_EXTERNAL_EMAIL_ENABLED=true",
    "-e", "GOTRUE_EXTERNAL_PHONE_ENABLED=false", "-e", "GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false", "-e", "GOTRUE_MAILER_AUTOCONFIRM=true",
    "-e", "GOTRUE_SMTP_HOST=127.0.0.1", "-e", "GOTRUE_SMTP_PORT=1", "-e", "GOTRUE_SMTP_ADMIN_EMAIL=admin@lab.test",
    "-e", "GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify", "-e", "GOTRUE_RATE_LIMIT_EMAIL_SENT=1000", "-e", "GOTRUE_PASSWORD_MIN_LENGTH=6",
    "-e", "GOTRUE_RATE_LIMIT_TOKEN_REFRESH=10000", "-e", "GOTRUE_RATE_LIMIT_VERIFY=10000", IMAGEN_AUTH]);
  if (r.status !== 0) throw new Error("no se pudo arrancar gotrue: " + r.stderr);
  for (let i = 0; i < 120; i++) {
    try { const x = await fetch(`http://127.0.0.1:${AUTH_INTERNO}/health`, { signal: AbortSignal.timeout(1000) }); if (x.status === 200) break; } catch { /* aún no */ }
    if (i === 119) throw new Error("gotrue no respondió: " + (sh("docker", ["logs", "--tail", "15", CONT_AUTH]).stdout + sh("docker", ["logs", "--tail", "15", CONT_AUTH]).stderr).slice(-2000));
    await new Promise((ok) => setTimeout(ok, 500));
  }
}

/** Registro de lo que pide el navegador al gateway (medición de peticiones en reposo). */
export const PETICIONES = [];
/* 3.15 (Bloque 7) · perfil de RED del gateway (lo que ve el navegador): latencia por petición y ancho de banda de bajada. Por defecto
   0/0 = idéntico a antes. Solo afecta a /rest, /auth y /storage (no al Realtime ni al puente de control de las pruebas). */
export const RED = { latenciaMs: 0, kbps: 0 };
const retrasar = () => new Promise((r) => (RED.latenciaMs > 0 ? setTimeout(r, RED.latenciaMs) : r()));
/** Copia r → res respetando RED.kbps y anotando los bytes en la petición `p` (sin perfil: pipe directo, como antes). */
function entregar(r, res, p) {
  r.on("data", (d) => { p.bytes = (p.bytes || 0) + d.length; });
  if (!(RED.kbps > 0)) return r.pipe(res);
  const bytesPorMs = (RED.kbps * 1024) / 8 / 1000;
  let listoEn = Date.now();
  r.on("data", (d) => { r.pause(); listoEn = Math.max(listoEn, Date.now()) + d.length / bytesPorMs; setTimeout(() => { res.write(d); r.resume(); }, Math.max(0, listoEn - Date.now())); });
  r.on("end", () => setTimeout(() => res.end(), Math.max(0, listoEn - Date.now()) + 1));
}
export { entregar as entregarConRed, retrasar as retrasarRed };

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
   La pila local no tiene GoTrue, y el api-server real valida la sesión con `auth.getUser(token)` (GET /auth/v1/user),
   re-autentica al admin con /auth/v1/token?grant_type=password y (SECURITY-1B) cierra esa sesión temporal con
   POST /auth/v1/logout?scope=local. Como GoTrue, el login devuelve también `user` (id, email) y el cierre exige un JWT
   válido de esta pila; `global`, `others` o sin scope se rechazan aquí (el api-server nunca debe usarlos; se registran
   en `pila.cierres`). Este shim responde SOLO esas tres rutas, SOLO dentro
   de este gateway de pruebas (127.0.0.1, vive y muere con iniciarPila()/detener()), y SOLO para tokens firmados con el
   secreto sintético de ESTA pila (cualquier otro → 401). No hay bandera ni variable que lo active en producción: el
   código no existe fuera de pruebas/sync (guarda estática en pruebas/sync/node/sync7b.test.mjs). La identidad sale del
   `sub` del JWT (UUIDs deterministas de PERFILES); el rol y `activo` los decide `perfiles` en la base, como en producción. */
export const CLAVE_CUENTA_PRUEBA = "clave-sintetica-solo-pruebas";
/** Cada POST /auth/v1/logout que recibe el shim: { scope, sub } (SECURITY-1B). */
export const CIERRES = [];   // no es un secreto: solo la acepta este shim local
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
      responder(200, { access_token: jwt(e[1]), token_type: "bearer", user: { id: e[1], email: `${e[0]}@example.test` } });
    });
    return true;
  }
  if (u.pathname === "/auth/v1/logout" && req.method === "POST") {
    const c = verificarJwtLocal((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    CIERRES.push({ scope: u.searchParams.get("scope"), sub: c?.sub ?? null });
    if (!c) return responder(401, { code: 401, msg: "invalid JWT" });
    if (u.searchParams.get("scope") !== "local") return responder(400, { msg: "el api-server solo debe cerrar con scope=local" });
    res.writeHead(204, cors); res.end(); return true;
  }
  return responder(404, { msg: "ruta de auth no simulada" });
}

const gatewayStorage = { activo: false };
/* SECURITY-1D · GoTrue REAL (opcional: iniciarPila({ authReal: { url, anon } })): /auth/v1/* se reenvía al Auth LOCAL del laboratorio
   (nunca producción; solo http://127.0.0.1) en vez del shim. El `apikey` que manda el api-server (sintético) se sustituye por la clave
   anon LOCAL del laboratorio; el Authorization (token del usuario emitido por ese GoTrue) viaja tal cual. */
const authReal = { url: null, anon: null, quitarPrefijo: false };   // quitarPrefijo: GoTrue directo (sin Kong delante)
function proxyAuthReal(req, res, cors) {
  const u = new URL(authReal.url);
  const cab = { ...req.headers, host: u.host, apikey: authReal.anon }; delete cab.origin; delete cab.referer;
  const ruta = authReal.quitarPrefijo ? req.url.replace(/^\/auth\/v1/, "") || "/" : req.url;
  const p = http.request({ host: u.hostname, port: u.port, path: ruta, method: req.method, headers: cab }, (r) => { res.writeHead(r.statusCode, { ...r.headers, ...cors }); r.pipe(res); });
  p.on("error", (e) => { res.writeHead(502, cors); res.end(String(e.message)); });
  req.pipe(p);
  return true;
}
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

async function esperarRealtime() {
  for (let i = 0; i < 120; i++) {
    const r = sql("select to_regclass('realtime.messages') is not null and to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null", { tolerar: true });
    if (r === "t") return;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  throw new Error("Realtime no migró su esquema: " + sh("docker", ["logs", "--tail", "12", CONT_RT]).stdout.slice(0, 1500));
}
async function esperarPuertoRealtime() {
  // no basta el TCP: el endpoint abre, se cierra mientras prepara el inquilino y vuelve a abrir. Listo = handshake WebSocket 101
  // real con el Host del inquilino, dos veces seguidas.
  const handshake = () => new Promise((r) => {
    const c = net.connect(RT_INTERNO, "127.0.0.1", () => c.write(`GET /socket/websocket?apikey=${jwt(null, { role: "anon" })}&vsn=1.0.0 HTTP/1.1\r\nHost: realtime-dev.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    let b = ""; c.on("data", (d) => { b += d; if (b.includes("\r\n")) { c.destroy(); r(/^HTTP\/1\.1 101/.test(b)); } });
    c.on("error", () => r(false)); setTimeout(() => { c.destroy(); r(false); }, 3000);
  });
  let seguidos = 0;
  for (let i = 0; i < 180; i++) {
    seguidos = (await handshake()) ? seguidos + 1 : 0;
    if (seguidos >= 2) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Realtime no acepta conexiones: " + (sh("docker", ["logs", "--tail", "20", CONT_RT]).stdout + sh("docker", ["logs", "--tail", "20", CONT_RT]).stderr).slice(-2500));
}
async function arrancarRealtime() {
  sql("create schema if not exists _realtime; alter schema _realtime owner to supabase_admin;");
  sh("docker", ["rm", "-f", CONT_RT]);
  const r = sh("docker", ["run", "-d", "--name", CONT_RT, "--network", "host",
    "-e", `PORT=${RT_INTERNO}`, "-e", `DB_HOST=${PG.host}`, "-e", `DB_PORT=${PG.port}`, "-e", "DB_USER=supabase_admin", "-e", "DB_PASSWORD=postgres", "-e", `DB_NAME=${DB}`,
    "-e", "DB_AFTER_CONNECT_QUERY=SET search_path TO _realtime", "-e", "DB_ENC_KEY=supabaserealtime", "-e", `API_JWT_SECRET=${SECRETO_JWT}`, "-e", `METRICS_JWT_SECRET=${SECRETO_JWT}`,
    "-e", "APP_NAME=realtime", "-e", "SECRET_KEY_BASE=" + crypto.randomBytes(48).toString("base64url"), "-e", "ERL_AFLAGS=-proto_dist inet_tcp", "-e", "DNS_NODES=''",
    "-e", "RLIMIT_NOFILE=", "-e", "SEED_SELF_HOST=true", "-e", "RUN_JANITOR=true", "-e", "MAX_HEADER_LENGTH=4096", "-e", "ECTO_IPV6=false", IMAGEN_RT]);
  if (r.status !== 0) throw new Error("no se pudo arrancar realtime: " + r.stderr);
  await esperarRealtime();
  await esperarPuertoRealtime();
  // 15c ya corrió sin Realtime (omitió las políticas de canal): se re-aplica (idempotente) ahora que realtime.messages existe
  sql(`\\i ${path.join(SQL, "sync-15c-mensajes-realtime.sql")}`);
  if (sql("select count(*) from pg_policies where schemaname='realtime' and tablename='messages' and policyname like 'entimotors_rt_%'") !== "3") throw new Error("faltan las políticas de canal de 15c");
}
/* WebSocket /realtime/v1/* → realtime (como Kong): exige apikey; reescribe el Host al inquilino; cuenta conexiones y bytes. */
function proxyRealtime(req, sock, head) {
  const u = new URL(req.url, "http://x");
  // sin Realtime (o cortado): se rechaza y se CIERRA el socket (un end() a medias dejaba vivo el gateway al terminar la suite)
  if (!gatewayRt.activo || gatewayRt.caido || !u.pathname.startsWith("/realtime/v1/") || !u.searchParams.get("apikey")) { try { sock.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); } catch { /* ya */ } sock.destroy(); return; }
  PETICIONES.push({ t: Date.now(), metodo: "WS", ruta: u.pathname });
  const up = net.connect(RT_INTERNO, "127.0.0.1", () => {
    // como Kong con una clave publicable: el apikey público se traduce al JWT anónimo del proyecto (el de esta pila)
    u.searchParams.set("apikey", jwt(null, { role: "anon" }));
    let h = `${req.method} ${u.pathname.replace(/^\/realtime\/v1\//, "/socket/")}${u.search} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) { if (!/^(host|origin)$/i.test(req.rawHeaders[i])) h += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`; }
    up.write(h + "Host: realtime-dev.localhost\r\n\r\n"); if (head?.length) up.write(head);
    gatewayRt.conexiones++; gatewayRt.sockets.add(sock);
    up.on("data", (d) => { gatewayRt.bytesAlCliente += d.length; }); sock.on("data", (d) => { gatewayRt.bytesDelCliente += d.length; });
    sock.pipe(up).pipe(sock);
  });
  const fin = () => { gatewayRt.sockets.delete(sock); up.destroy(); sock.destroy(); };
  up.on("error", fin); sock.on("error", fin); up.on("close", fin); sock.on("close", fin);
}

function arrancarGateway() {
  const srv = http.createServer(async (req, res) => {
    const pet = { t: Date.now(), metodo: req.method, ruta: req.url.split("?")[0], bytes: 0 };
    PETICIONES.push(pet);
    // también el preflight: en la red real también cuesta un viaje. SIN resume(): el cuerpo (POST de las RPC) queda en espera hasta el
    // pipe() de más abajo; reanudarlo aquí lo tiraba y PostgREST se quedaba esperando un cuerpo que nunca llegaba.
    if (RED.latenciaMs > 0) await retrasar();
    const cors = { "Access-Control-Allow-Origin": req.headers.origin || "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*", "Access-Control-Expose-Headers": "Content-Range,Content-Location,Location,Retry-After", "Access-Control-Max-Age": "600", Vary: "Origin" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    // como Kong de Supabase: /storage/v1 NO exige apikey (una URL firmada en un <img> no lleva cabeceras; storage-api
    // valida el token firmado o el JWT por su cuenta). El resto sí.
    if (!req.headers.apikey && !req.url.startsWith("/storage/v1/")) { res.writeHead(401, { ...cors, "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "No API key found in request" })); }
    if (req.url.startsWith("/auth/v1/")) return authReal.url ? proxyAuthReal(req, res, cors) : shimAuth(req, res, cors);
    // como Kong: /storage/v1/* → storage-api (sin el prefijo). Sin pila de Storage, 404 como siempre.
    if (req.url.startsWith("/storage/v1/")) {
      if (!gatewayStorage.activo) { res.writeHead(404, { ...cors, "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "sin storage en esta pila" })); }
      const cabS = { ...req.headers, host: `127.0.0.1:${STORAGE_INTERNO}` }; delete cabS.origin; delete cabS.referer;
      const ps = http.request({ host: "127.0.0.1", port: STORAGE_INTERNO, path: req.url.replace(/^\/storage\/v1/, ""), method: req.method, headers: cabS }, (r) => { res.writeHead(r.statusCode, { ...r.headers, ...cors }); entregar(r, res, pet); });
      ps.on("error", (e) => { res.writeHead(502, cors); res.end(String(e.message)); });
      return req.pipe(ps);
    }
    const cab = { ...req.headers, host: `127.0.0.1:${REST_INTERNO}` }; delete cab.origin; delete cab.referer;
    const p = http.request({ host: "127.0.0.1", port: REST_INTERNO, path: req.url.replace(/^\/rest\/v1/, ""), method: req.method, headers: cab }, (r) => { res.writeHead(r.statusCode, { ...r.headers, ...cors }); entregar(r, res, pet); });
    p.on("error", (e) => { res.writeHead(502, cors); res.end(String(e.message)); });
    req.pipe(p);
  });
  srv.on("upgrade", proxyRealtime);
  return new Promise((ok) => srv.listen(REST_PUERTO, "127.0.0.1", () => ok(srv)));
}

/** Crea la base t_e2e desde cero (producción + SYNC-1..3P), siembra perfiles y arranca PostgREST. */
export async function iniciarPila({ storage = false, fasesExtra = [], authReal: real = null, excluir = [], realtime = false, gotrue = false } = {}) {
  if (real && !/^http:\/\/127\.0\.0\.1:\d+$/.test(real.url)) throw new Error("authReal debe ser el laboratorio LOCAL (http://127.0.0.1:puerto)");
  authReal.url = real?.url ?? null; authReal.anon = real?.anon ?? null; authReal.quitarPrefijo = false;
  if (sh("pg_isready", ["-q", "-h", PG.host, "-p", String(PG.port)]).status !== 0) throw new Error("El Postgres local no responde: ejecuta pruebas/sync/entorno-local.sh up");
  sh("docker", ["rm", "-f", CONT_REST]);
  sh("bash", [ENTORNO, "borra", DB]);
  const c = sh("bash", [ENTORNO, "copia", DB]);
  if (c.status !== 0) throw new Error("no se pudo crear la base: " + c.stderr);
  if (storage) await arrancarStorage();
  for (const f of FASES.filter((x) => !excluir.includes(x))) sql(`\\i ${path.join(SQL, `sync-${f}.sql`)}`);
  // 3.15.0 · Bloque 4: producción ya tiene SEC-1C (aplicada una vez, ver STATE); la ruta del PIN la usa para limitar la
  // reautenticación del admin (configurar/cambiar/recuperar/desbloquear). Va en la cadena base salvo que se excluya.
  const extras = excluir.includes("sec-1c-clave-intentos") ? fasesExtra : ["sec-1c-clave-intentos", ...fasesExtra.filter((x) => x !== "sec-1c-clave-intentos")];
  for (const f of extras) sql(`\\i ${path.join(SQL, `${f}.sql`)}`);   // p. ej. «sec-1c-clave-intentos» (3.14.1)
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
  if (gotrue) {
    await arrancarGotrue();
    authReal.url = `http://127.0.0.1:${AUTH_INTERNO}`; authReal.anon = jwt(null, { role: "anon" }); authReal.quitarPrefijo = true;
    // las migraciones de GoTrue reescriben auth.uid(): se vuelve a igualar a producción (lee también request.jwt.claims)
    sql(`create or replace function auth.uid() returns uuid language sql stable as $f$
           select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;`);
  }
  if (realtime) await arrancarRealtime();
  const gateway = await arrancarGateway();
  gatewayStorage.activo = storage;
  gatewayRt.activo = realtime; gatewayRt.caido = false;
  return {
    jwt, sql, uid, PERFILES, REST_URL,
    /** SECURITY-1D: simular la caída del Auth real (url a un puerto cerrado de 127.0.0.1) y restaurarlo. */
    authRealUrl(u) { if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(u)) throw new Error("solo 127.0.0.1"); authReal.url = u; },
    /** Vacía los datos operativos (la protección de las tablas de dinero se salta con replica solo aquí, en la base de pruebas) y
        restaura los 4 perfiles sembrados a activo=true — SYNC-6 introdujo pruebas que desactivan un perfil a propósito
        (perfiles NO se trunca: es la identidad fija que usan TODAS las pruebas), así que sin este reset una prueba que
        corra después de esa quedaría con un mecánico inactivo por accidente, sin que su propio código lo pida. */
    limpiar() {
      sql(`set session_replication_role = replica;
           truncate public.clientes, public.motos, public.citas, public.categorias_inv, public.cotizaciones, public.cotizacion_items,
             public.web_cms, public.ordenes, public.orden_items, public.inventario, public.inventario_movimientos,
             public.ventas, public.venta_items, public.creditos, public.credito_items, public.abonos, public.caja_movimientos,
             public.reversos, public.sync_ops, public.autorizaciones_admin,
             public.import_lotes, public.import_registros, public.import_mapeo_mecanicos cascade;
           do $t$ begin if to_regclass('public.mensajes') is not null then truncate public.mensajes; end if; end $t$;
           -- 3.15 (Bloque 4): un perfil ELIMINADO no se reactiva (trigger) salvo aquí, en la base de pruebas, con los triggers apagados
           do $e$ begin if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'perfiles' and column_name = 'eliminado_en') then
             update public.perfiles set activo = true, eliminado_en = null, eliminado_por = null where id in (${Object.values(PERFILES).map((v) => `'${v}'`).join(",")});
           end if; end $e$;
           reset session_replication_role;
           update public.perfiles set activo = true where id in (${Object.values(PERFILES).map((v) => `'${v}'`).join(",")});`);
    },
    /** 3.15 (Bloque 3): cortar el Realtime (corta los sockets vivos y rechaza los nuevos) y volver a darlo. */
    realtimeCaido(v) { gatewayRt.caido = !!v; if (v) for (const x of gatewayRt.sockets) x.destroy(); },
    realtimeMetricas() { return { conexiones: gatewayRt.conexiones, abiertas: gatewayRt.sockets.size, bytesAlCliente: gatewayRt.bytesAlCliente, bytesDelCliente: gatewayRt.bytesDelCliente }; },
    peticiones: PETICIONES,
    async detener() { gateway.closeAllConnections?.(); gateway.close(); for (const x of gatewayRt.sockets) x.destroy(); gatewayRt.activo = false; if (realtime) sh("docker", ["rm", "-f", CONT_RT]);
      sh("docker", ["rm", "-f", CONT_REST]); if (storage) sh("docker", ["rm", "-f", CONT_STORAGE]); if (gotrue) sh("docker", ["rm", "-f", CONT_AUTH]); gatewayStorage.activo = false; sh("bash", [ENTORNO, "borra", DB]); },
  };
}
