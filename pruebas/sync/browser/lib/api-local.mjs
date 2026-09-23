// SYNC-7B · api-server REAL (src/ de verdad, sin tocar su dist/ versionado) contra la pila local de pruebas.
// Se compila con el mismo build.mjs del repo a un directorio temporal, se arranca en 127.0.0.1 con variables
// SINTÉTICAS (pepper aleatorio por corrida, service key firmada con el secreto local) y se destruye al terminar.
// La sesión la valida el shim de auth del gateway de pila.mjs (solo existe dentro de las pruebas).
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RAIZ } from "./pila.mjs";

export const API_PUERTO = 54440;
export const API_URL = `http://127.0.0.1:${API_PUERTO}`;
// Un pepper por PROCESO de prueba (aleatorio, nunca se guarda): si el api-server se reinicia dentro de la misma corrida
// (p. ej. para aprobar el origen CORS de otro dispositivo) el PIN ya guardado tiene que seguir verificando — igual
// que en producción, donde el pepper es fijo por despliegue.
const PEPPER_CORRIDA = crypto.randomBytes(36).toString("base64url");

function compilar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-api-prueba-"));
  const api = path.join(RAIZ, "api-server");
  const script = fs.readFileSync(path.join(api, "build.mjs"), "utf8")
    .replace('path.resolve(artifactDir, "dist")', JSON.stringify(dir))
    .replace('path.resolve(artifactDir, "src/index.ts")', JSON.stringify(path.join(api, "src/index.ts")));
  if (script.includes('path.resolve(artifactDir, "dist")')) throw new Error("build.mjs cambió: no se pudo redirigir la salida");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: api, encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(path.join(dir, "index.mjs"))) throw new Error("no se pudo compilar el api-server: " + (r.stderr || r.stdout).slice(-600));
  return dir;
}

/** pila: la de iniciarPila(). origen: el origin del navegador que llamará (CORS selectivo de las rutas sensibles). */
export async function iniciarApi(pila, { origen = null, origenes = [] } = {}) {
  const dir = compilar();
  const env = {
    PATH: process.env.PATH, NODE_ENV: "development", PORT: String(API_PUERTO), LOG_LEVEL: "warn",
    SUPABASE_URL: pila.REST_URL, SUPABASE_ANON_KEY: "anon-sintetica",
    // como la service key real de Supabase: rol service_role y SIN `sub` (con sub, auth.uid() lo tomaría por un usuario)
    SUPABASE_SERVICE_KEY: pila.jwt(undefined, { role: "service_role" }),
    ADMIN_PIN_PEPPER: PEPPER_CORRIDA,
    ADMIN_PASSWORD: crypto.randomBytes(24).toString("base64url"),
  };
  if (origen) env.ENTIMOTORS_ADMIN_ORIGIN = origen;
  if (origenes.length) env.CORS_ORIGINS_EXTRA = origenes.join(",");
  const proc = spawn(process.execPath, [path.join(dir, "index.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let salida = "";
  proc.stdout.on("data", (d) => { salida += d; }); proc.stderr.on("data", (d) => { salida += d; });
  const termino = new Promise((r) => proc.on("exit", r));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${API_URL}/api/healthz`, { signal: AbortSignal.timeout(1000) }); if (r.status < 500) break; } catch { /* aún no */ }
    if (proc.exitCode !== null) throw new Error("el api-server terminó al arrancar: " + salida.slice(-800));
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    url: API_URL,
    salida: () => salida,
    async detener() { proc.kill("SIGTERM"); await termino; fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Llamada JSON al api-server con el token de `sub` (firmado por la pila local). */
export async function llamar(pila, api, metodo, ruta, { sub, cuerpo, token } = {}) {
  const r = await fetch(api.url + ruta, {
    method: metodo,
    headers: { "Content-Type": "application/json", ...(token || sub ? { Authorization: "Bearer " + (token || pila.jwt(sub)) } : {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const txt = await r.text();
  let datos = null; try { datos = txt ? JSON.parse(txt) : null; } catch { datos = txt; }
  return { status: r.status, datos, cabeceras: r.headers };
}
