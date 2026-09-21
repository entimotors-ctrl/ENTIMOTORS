// Compila el api-server REAL (TypeScript) con el esbuild del propio api-server y lo carga en un directorio temporal con
// dependencias FALSAS (express, supabase-js, ws, logger). Sin red ni Supabase. Requiere: `pnpm install --frozen-lockfile` en api-server/.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ = path.resolve(AQUI, "../../../..");
const require = createRequire(import.meta.url);
let esbuild;
try { esbuild = require(path.join(RAIZ, "api-server/node_modules/esbuild")); }
catch { throw new Error("Falta esbuild: ejecuta `pnpm install --frozen-lockfile` en api-server/ (es lo mismo que exige el build oficial del backend)."); }

// El .mjs generado vive DENTRO de api-server/node_modules (git-ignorado) para que las dependencias reales (pino…) se resuelvan como en producción.
let dir = null;
const tmp = () => {
  if (dir) return dir;
  const base = path.join(RAIZ, "api-server", "node_modules", ".cache");
  fs.mkdirSync(base, { recursive: true });
  return (dir = fs.mkdtempSync(path.join(base, "entimotors-sync-node-")));
};
process.on("exit", () => { try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ya no está */ } });

const FALSOS = {
  express: `export function Router() { return globalThis.__PIN.nuevoRouter(); }\nexport default { Router };\n`,
  supabase: `export function createClient(url, key, opts) { return globalThis.__PIN.crearCliente(url, key, opts); }\n`,
  ws: `export default class WebSocketFalso {}\n`,
  cors: `export default function cors() { return (req, res, next) => { res.setHeader("access-control-allow-origin", "*"); next(); }; }\n`,
  logger: `export const logger = new Proxy({}, { get: (_, nivel) => (...a) => globalThis.__PIN.registrar(String(nivel), a) });\n`,
};

/** Bundle de una entrada TS. `falsos` decide qué dependencias se sustituyen. Devuelve la URL del .mjs generado. */
export async function compilar(entrada, { falsos = ["express", "supabase", "ws", "logger", "cors"], nombre } = {}) {
  const salida = path.join(tmp(), `${nombre ?? path.basename(entrada, ".ts")}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  for (const [k, c] of Object.entries(FALSOS)) fs.writeFileSync(path.join(tmp(), `falso-${k}.mjs`), c);
  const plugin = {
    name: "falsos",
    setup(b) {
      const f = (k) => path.join(tmp(), `falso-${k}.mjs`);
      if (falsos.includes("express")) b.onResolve({ filter: /^express$/ }, () => ({ path: f("express") }));
      if (falsos.includes("supabase")) b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: f("supabase") }));
      if (falsos.includes("cors")) b.onResolve({ filter: /^cors$/ }, () => ({ path: f("cors") }));
      if (falsos.includes("ws")) b.onResolve({ filter: /^ws$/ }, () => ({ path: f("ws") }));
      if (falsos.includes("logger")) b.onResolve({ filter: /lib\/logger(\.js)?$/ }, () => ({ path: f("logger") }));
    },
  };
  await esbuild.build({ entryPoints: [path.join(RAIZ, entrada)], outfile: salida, bundle: true, platform: "node", format: "esm", packages: "external",
    plugins: [plugin], logLevel: "silent", tsconfigRaw: "{}" });
  return pathToFileURL(salida).href;
}
