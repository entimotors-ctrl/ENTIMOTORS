// ENTIMOTORS 3.15 · Bloque 5 · RESPALDO DE NEGOCIO: manifiesto, verificación, formatos, Storage y escaneo de secretos.
// Node puro (sin dependencias). Lo usan respaldar.sh, restaurar-aislado.sh y puerta-pre-release.sh, y sus pruebas.
//
// Qué es (y qué NO es) este respaldo:
//   · SÍ: todos los datos del negocio de la base (public), los metadatos de Storage (buckets/objetos), el directorio de usuarios
//     SANEADO (id, correo, estado; sin contraseña ni tokens) y los ARCHIVOS de Storage con su inventario verificado.
//   · NO: contraseñas, sesiones, refresh tokens, PIN, pepper, llaves (service_role/anon/JWT), secretos del vault, configuración de Auth
//     ni del proyecto. Eso es RECUPERACIÓN DE INFRAESTRUCTURA: procedimiento aparte (ver RESPALDO.md).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, readdirSync, createReadStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FORMATO = "entimotors-respaldo-negocio";
export const VERSION_FORMATO = 1;
export const ZONA = "America/Tegucigalpa";
// tablas cuyos datos NO viajan (secretos o efímeros). La foto las marca EXCLUIDO; la restauración las deja en 0.
export const DATOS_EXCLUIDOS = [
  "auth.*", "vault.*", "realtime.*", "net.*", "cron.*", "supabase_functions.*", "pgsodium.*", "graphql.*",
  "storage.s3_multipart_uploads", "storage.s3_multipart_uploads_parts",
  "public.admin_pin", "public.admin_pin_intentos", "public.admin_clave_intentos",
];
export const CAMPOS_OBLIGATORIOS = ["formato", "version_formato", "entimotors_version", "creado_utc", "zona", "creado_local", "postgres_version",
  "pg_dump_version", "fases", "catalogo", "tablas", "datos_excluidos", "storage", "artefactos", "huellas", "verificacion", "secretos"];

export const sha256Buf = (b) => createHash("sha256").update(b).digest("hex");
export async function sha256Archivo(ruta) {
  return new Promise((ok, mal) => { const h = createHash("sha256"); createReadStream(ruta).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", mal); });
}
export async function md5Archivo(ruta) {
  return new Promise((ok, mal) => { const h = createHash("md5"); createReadStream(ruta).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", mal); });
}
/** JSON canónico (claves ordenadas) para que el hash no dependa del orden. */
export function canonico(v) {
  if (Array.isArray(v)) return "[" + v.map(canonico).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonico(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
/** Hash del manifiesto: sobre todo MENOS su propio campo manifiesto_sha256. */
export function hashManifiesto(m) { const c = { ...m }; delete c.manifiesto_sha256; return sha256Buf(canonico(c)); }
export function sellarManifiesto(m) { const c = { ...m }; delete c.manifiesto_sha256; c.manifiesto_sha256 = hashManifiesto(c); return c; }

/** «¿Qué es este archivo?», por su CONTENIDO — la MISMA regla que taller-demo/import-313.js (clasificarArchivo), probada igual en
    pruebas/sync/node/b6-legado-313.test.mjs. «legado-v6» = datos de la base local v6 de la 3.13 (la exporta la 3.13 y también la 3.14.x al
    leer esa base: el respaldo real JEIEKQ dice versionApp 3.14.0). Nunca se decide por el nombre, la extensión ni la versión que lo exportó. */
const ALMACENES_313 = ["clientes", "motos", "ordenes", "inventario", "citas", "cotizaciones", "ventas_rapidas", "caja_movimientos", "creditos",
  "web_cms", "categorias_inv", "auditoria"];
const CAMPOS_CACHE = ["uid", "_rev", "_base", "_pend"];
export function clasificarArchivo(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "desconocido";
  if (obj.formato === FORMATO) return "negocio-3.15";
  if (obj.formato === "entimotors-copia-dispositivo" && obj.alcance === "cache-nube") return "cache-nube";
  if (!obj.data || typeof obj.data !== "object" || Array.isArray(obj.data)) return "desconocido";
  const conCache = Object.values(obj.data).some((v) => Array.isArray(v) && v.some((x) => x && typeof x === "object" && CAMPOS_CACHE.some((c) => x[c] !== undefined)));
  if (conCache) return "cache-nube";
  const marcaOk = obj.formato === undefined || (obj.formato === "entimotors-copia-dispositivo" && obj.alcance === "datos-locales");
  const soloSus = Object.keys(obj.data).every((k) => ALMACENES_313.includes(k));
  return obj.version === 2 && obj.esquemaDB === 6 && marcaOk && soloSus ? "legado-v6" : "desconocido";
}

/** Compara versiones "3.14.1" → -1/0/1. */
export function cmpVersion(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1; }
  return 0;
}

/**
 * Verifica un respaldo YA ESCRITO en `dir`. No confía en nada: relee el manifiesto, su sello, cada artefacto (bytes + SHA-256),
 * el formato, la versión y el resultado del escaneo de secretos. Devuelve { ok, errores: [{codigo, detalle}], manifiesto }.
 * opciones.restauradorVersion: versión del restaurador (se rechaza un respaldo de formato más nuevo o de otra familia).
 */
export async function verificarRespaldo(dir, opciones = {}) {
  const errores = []; const mal = (codigo, detalle) => errores.push({ codigo, detalle });
  const rutaMan = path.join(dir, "manifiesto.json");
  if (!existsSync(rutaMan)) { mal("SIN_MANIFIESTO", "no hay manifiesto.json"); return { ok: false, errores }; }
  const texto = readFileSync(rutaMan, "utf8");
  let m;
  try { m = JSON.parse(texto); } catch (e) { mal("MANIFIESTO_ILEGIBLE", "manifiesto.json no es JSON válido (¿truncado?): " + e.message); return { ok: false, errores }; }
  const clase = clasificarArchivo(m);
  if (clase !== "negocio-3.15") {
    mal("FORMATO_INCOMPATIBLE", clase === "legado-v6" ? "es una copia de TELÉFONO con datos de la 3.13 (base local v6): va por «Pasar los datos de la versión 3.13 a la nube», no por el restaurador"
      : clase === "cache-nube" ? "es una copia de la caché de un DISPOSITIVO, no un respaldo de negocio" : "no es un respaldo de negocio de ENTIMOTORS");
    return { ok: false, errores, manifiesto: m };
  }
  if (m.version_formato !== VERSION_FORMATO) mal("VERSION_INCOMPATIBLE", `formato ${m.version_formato}; este restaurador entiende el ${VERSION_FORMATO}`);
  if (opciones.restauradorVersion && m.entimotors_version && cmpVersion(m.entimotors_version, opciones.restauradorVersion) > 0)
    mal("VERSION_INCOMPATIBLE", `respaldo de ENTIMOTORS ${m.entimotors_version}, más nuevo que este restaurador (${opciones.restauradorVersion})`);
  for (const c of CAMPOS_OBLIGATORIOS) if (!(c in m)) mal("MANIFIESTO_INCOMPLETO", `falta «${c}»`);
  if (m.manifiesto_sha256 !== hashManifiesto(m)) mal("MANIFIESTO_ALTERADO", "el sello del manifiesto no corresponde a su contenido");
  const sello = path.join(dir, "manifiesto.json.sha256");
  if (!existsSync(sello)) mal("SIN_SELLO", "falta manifiesto.json.sha256");
  else if (readFileSync(sello, "utf8").trim().split(/\s+/)[0] !== sha256Buf(Buffer.from(texto))) mal("MANIFIESTO_ALTERADO", "manifiesto.json no coincide con manifiesto.json.sha256");
  for (const a of m.artefactos || []) {
    const r = path.join(dir, a.ruta);
    if (a.ruta.includes("..") || path.isAbsolute(a.ruta)) { mal("RUTA_INVALIDA", a.ruta); continue; }
    if (!existsSync(r)) { mal("ARTEFACTO_FALTA", a.ruta); continue; }
    const bytes = statSync(r).size;
    if (bytes !== a.bytes) { mal("ARTEFACTO_TRUNCADO", `${a.ruta}: ${bytes} bytes, el manifiesto dice ${a.bytes}`); continue; }
    if ((await sha256Archivo(r)) !== a.sha256) mal("HASH_INCORRECTO", `${a.ruta}: SHA-256 distinto`);
  }
  if (!(m.artefactos || []).some((a) => a.tipo === "pg_dump")) mal("MANIFIESTO_INCOMPLETO", "no declara el volcado de la base");
  if (m.secretos?.resultado !== "LIMPIO") mal("SECRETOS", "el escaneo de secretos no dio LIMPIO");
  if (m.verificacion?.resultado !== "VERIFICADO") mal("NO_VERIFICADO", "el respaldo no llegó a verificarse al crearse");
  return { ok: errores.length === 0, errores, manifiesto: m };
}

// ───────────────────────────────────────────── Storage ─────────────────────────────────────────────
/** Inventario desde las líneas «storage|bucket|ruta|bytes|etag» de la foto (o de una consulta equivalente). */
export function inventarioDesdeFoto(texto) {
  return texto.split("\n").filter((l) => l.startsWith("storage|")).map((l) => {
    const [, bucket, ...resto] = l.split("|");
    const etag = resto.pop(), bytes = Number(resto.pop());
    return { bucket, ruta: resto.join("|"), bytes, md5: String(etag).replace(/"/g, "").toLowerCase() };
  });
}
function listarArchivos(raiz) {
  const out = [];
  (function walk(d) { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(p); } })(raiz);
  return out;
}
/**
 * Compara el inventario (lo que la base dice que existe) contra una carpeta <raiz>/<bucket>/<ruta>: tamaño y MD5 (= eTag de Supabase
 * para subidas simples) de cada objeto; detecta FALTANTES, DIFERENTES y EXTRAS. Devuelve también el SHA-256 de cada archivo.
 */
export async function verificarStorage(inventario, raiz) {
  const faltan = [], diferentes = [], ok = [];
  const esperados = new Set();
  for (const o of inventario) {
    const f = path.join(raiz, o.bucket, o.ruta);
    esperados.add(path.resolve(f));
    if (!existsSync(f)) { faltan.push(`${o.bucket}/${o.ruta}`); continue; }
    const bytes = statSync(f).size, md5 = await md5Archivo(f);
    if (bytes !== o.bytes || md5 !== o.md5) { diferentes.push(`${o.bucket}/${o.ruta} (bytes ${bytes}/${o.bytes}, md5 ${md5}/${o.md5})`); continue; }
    ok.push({ ...o, sha256: await sha256Archivo(f) });
  }
  const sobran = listarArchivos(raiz).filter((f) => !esperados.has(path.resolve(f))).map((f) => path.relative(raiz, f));
  return { ok: faltan.length === 0 && diferentes.length === 0 && sobran.length === 0, verificados: ok, faltan, diferentes, sobran };
}
/**
 * Descarga los objetos del inventario desde la API de Storage (GET <base>/storage/v1/object/<bucket>/<ruta>) conservando la ruta.
 * La llave llega por parámetro (variable de entorno del operador): nunca se escribe en disco ni en el manifiesto ni en un log.
 * Solo descarga; nunca sube, mueve ni borra nada.
 */
export async function descargarStorage(inventario, base, llave, destino, opciones = {}) {
  const hechos = [], errores = [];
  for (const o of inventario) {
    const url = `${base.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(o.bucket)}/${o.ruta.split("/").map(encodeURIComponent).join("/")}`;
    try {
      const r = await (opciones.fetch || fetch)(url, { headers: llave ? { Authorization: `Bearer ${llave}`, apikey: llave } : {} });
      if (!r.ok) { errores.push(`${o.bucket}/${o.ruta}: HTTP ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const f = path.join(destino, o.bucket, o.ruta);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, buf);
      hechos.push(`${o.bucket}/${o.ruta}`);
    } catch (e) { errores.push(`${o.bucket}/${o.ruta}: ${String(e.message || e).replace(llave || "\u0000", "***")}`); }
  }
  return { hechos, errores };
}

// ───────────────────────────────────────────── Secretos ─────────────────────────────────────────────
// Patrones de cosas que NUNCA deben ir en un respaldo entregable. Se buscan en el SQL completo del volcado (pg_restore -f -), en el CSV
// de usuarios y en el manifiesto. Un hallazgo = FAIL: el respaldo no se entrega.
export const PATRONES_SECRETOS = [
  { id: "bcrypt", re: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/ },
  { id: "scrypt_pin", re: /scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+/ },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: "supabase_secret_key", re: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  { id: "pepper", re: /PIN_PEPPER\s*[=:]\s*\S+/i },
  { id: "datos_auth_secretos", re: /^COPY auth\.(refresh_tokens|sessions|one_time_tokens|flow_state|mfa_factors|mfa_challenges|oauth_clients|webauthn_credentials|scim_tokens)\b[^\n]*\n(?!\\\.)/m },
  { id: "datos_vault", re: /^COPY vault\.secrets\b[^\n]*\n(?!\\\.)/m },
  { id: "datos_pin", re: /^COPY public\.(admin_pin|admin_pin_intentos|admin_clave_intentos)\b[^\n]*\n(?!\\\.)/m },
  { id: "password_en_texto", re: /\b(password|contrase(?:ñ|n)a)\s*[=:]\s*['"][^'"\s]{6,}['"]/i },
];
/** Busca patrones de secretos en uno o varios textos. Devuelve [{archivo, patron, muestra}] (la muestra, recortada y enmascarada). */
export function escanearSecretos(textos) {
  const hallazgos = [];
  for (const [archivo, t] of Object.entries(textos)) {
    for (const p of PATRONES_SECRETOS) {
      const m = p.re.exec(t);
      if (m) hallazgos.push({ archivo, patron: p.id, muestra: m[0].slice(0, 12).replace(/[A-Za-z0-9]/g, (c, i) => (i < 4 ? c : "*")) });
    }
  }
  return hallazgos;
}

// ───────────────────────────────────────────── Fotos ─────────────────────────────────────────────
/**
 * Compara la foto del origen con la de la restauración: toda línea igual, salvo VOLATIL (se ignoran) y EXCLUIDO (en la restauración
 * deben valer 0 por diseño). Devuelve { ok, diferencias: [...], excluidas: [...] }.
 */
export function compararFotos(origen, restaurada) {
  const lineas = (t) => t.split("\n").map((l) => l.trimEnd()).filter((l) => l && !l.startsWith("VOLATIL"));
  const a = lineas(origen), b = lineas(restaurada);
  const excl = (l) => l.startsWith("EXCLUIDO|");
  const exA = a.filter(excl), exB = b.filter(excl);
  const difs = [];
  const na = a.filter((l) => !excl(l)), nb = b.filter((l) => !excl(l));
  const sa = new Set(na), sb = new Set(nb);
  for (const l of na) if (!sb.has(l)) difs.push("solo en origen: " + l);
  for (const l of nb) if (!sa.has(l)) difs.push("solo en restaurada: " + l);
  const excluidas = exA.map((l) => l.split("|")[1]);
  for (const l of exB) if (!/\|0$/.test(l)) difs.push("tabla excluida con datos en la restauración: " + l);
  if (JSON.stringify(exA.map((l) => l.split("|")[1])) !== JSON.stringify(exB.map((l) => l.split("|")[1]))) difs.push("la lista de tablas excluidas difiere");
  return { ok: difs.length === 0 && na.length > 0, diferencias: difs, excluidas, lineas: na.length };
}
