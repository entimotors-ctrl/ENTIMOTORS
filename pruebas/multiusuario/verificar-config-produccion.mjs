#!/usr/bin/env node
// VERIFICADOR de la configuracion de PRODUCCION del frontend: taller-demo/supabase-config.js tal como se PUBLICA (HOTFIX PRE-TAG 4E-C11).
//
// Por que existe: 3.13.0 se publico con `apiUrl: ""` y «Usuarios y equipo» mostro «Falta indicar la dirección del servidor». Ninguna prueba miraba el
// archivo REAL: todas inyectaban un apiUrl sintetico y el servidor de navegador lo sustituye por una configuracion sintetica. Este verificador es la
// UNICA fuente de verdad de «que es una config de produccion valida»; la usan la prueba 25 (sobre el archivo versionado) y, a mano, el paso de publicacion
// (sobre el archivo que se sube al repo del Taller o sobre la URL ya publicada).
//
//   node pruebas/multiusuario/verificar-config-produccion.mjs                      → el archivo versionado (taller-demo/supabase-config.js)
//   node pruebas/multiusuario/verificar-config-produccion.mjs <ruta>               → otro archivo (p. ej. el que se va a subir)
//   node pruebas/multiusuario/verificar-config-produccion.mjs https://…/supabase-config.js   → el publicado (solo lectura: un GET)
//
// Salida 0 = «CONFIG_PRODUCCION_OK …»; salida 1 = una linea por problema + «FAIL n problemas». NUNCA imprime la clave anon: solo su rol.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Backend de produccion aprobado. Si el backend se mueve, se cambia AQUI y en supabase-config.js a proposito. */
export const BACKEND_ESPERADO = "https://entimotors-1.onrender.com";

export function evaluarConfig(texto) {
  const w = {};
  try { vm.runInNewContext(String(texto), { window: w }, { timeout: 1000 }); } catch (e) { return { error: `no se pudo evaluar: ${e && e.message}` }; }
  return { cfg: w.ENTIMOTORS_SUPABASE };
}

export function rolDeJwt(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString()).role ?? null; } catch { return null; }
}

/** Devuelve la lista de problemas («CODIGO detalle»); vacia = valida. */
export function validarConfig(texto) {
  const problemas = []; const marca = (c, d = "") => problemas.push(d ? `${c} ${d}` : c);
  const { cfg, error } = evaluarConfig(texto);
  if (error) { marca("CONFIG_ILEGIBLE", error); return problemas; }
  if (!cfg || typeof cfg !== "object") { marca("CONFIG_AUSENTE", "window.ENTIMOTORS_SUPABASE no existe"); return problemas; }

  // ── apiUrl: lo que faltaba ──
  const api = cfg.apiUrl;
  if (typeof api !== "string" || api.trim() === "") marca("APIURL_AUSENTE", "«Usuarios y equipo» mostraria «Falta indicar la dirección del servidor»");
  else {
    let u = null; try { u = new URL(api); } catch { /* mal formada */ }
    if (!u) marca("APIURL_MAL_FORMADA", "no es una URL");
    else {
      if (u.protocol !== "https:") marca("APIURL_NO_HTTPS", u.protocol);
      if (u.origin !== api) marca("APIURL_MAL_FORMADA", "debe ser solo el origen: sin barra final, ruta, parametros ni credenciales");
      if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(u.hostname) || /\.(test|example|invalid|localhost)$/i.test(u.hostname) || /synthetic|sintetic|<|>/i.test(api)) marca("APIURL_LOCAL", u.hostname);
      else if (u.origin === api && api !== BACKEND_ESPERADO) marca("APIURL_BACKEND_INESPERADO", `${api} ≠ ${BACKEND_ESPERADO}`);
    }
  }

  // ── el resto de la configuracion publica ──
  if (typeof cfg.url !== "string" || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cfg.url)) marca("SUPABASE_URL_INVALIDA", "debe ser https://<proyecto>.supabase.co");
  if (typeof cfg.anonKey !== "string" || cfg.anonKey === "") marca("ANON_KEY_AUSENTE");
  else if (rolDeJwt(cfg.anonKey) !== "anon") marca("ANON_KEY_NO_ANON", `rol=${rolDeJwt(cfg.anonKey)}`);
  if (cfg.habilitado !== true) marca("HABILITADO_NO_TRUE", String(cfg.habilitado));
  const prohibidas = Object.keys(cfg).filter((k) => /service|secret|password|passwd|token|private/i.test(k));
  if (prohibidas.length) marca("CLAVE_SOSPECHOSA", prohibidas.join(","));
  if (/service_role/i.test(String(cfg.anonKey)) || rolDeJwt(cfg.anonKey) === "service_role") marca("SERVICE_ROLE_EN_EL_FRONTEND");
  return problemas;
}

// ─────────────────────────── CLI ───────────────────────────
const esCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esCli) {
  const AQUI = path.dirname(fileURLToPath(import.meta.url));
  const destino = process.argv[2] ?? path.join(AQUI, "..", "..", "taller-demo", "supabase-config.js");
  let texto;
  try {
    if (/^https?:\/\//i.test(destino)) { const r = await fetch(destino, { headers: { "Cache-Control": "no-cache" } }); if (!r.ok) { console.log(`CONFIG_INACCESIBLE HTTP ${r.status} ${destino}`); console.log("FAIL 1 problemas"); process.exit(1); } texto = await r.text(); }
    else texto = fs.readFileSync(destino, "utf8");
  } catch (e) { console.log(`CONFIG_INACCESIBLE ${e && e.message}`); console.log("FAIL 1 problemas"); process.exit(1); }
  const problemas = validarConfig(texto);
  for (const p of problemas) console.log(p);
  if (problemas.length) { console.log(`FAIL ${problemas.length} problemas`); process.exit(1); }
  console.log(`CONFIG_PRODUCCION_OK apiUrl=${evaluarConfig(texto).cfg.apiUrl} (${destino.startsWith("http") ? "publicado" : path.relative(process.cwd(), path.resolve(destino)) || destino})`);
}
