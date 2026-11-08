// INSTANTÁNEA INMUTABLE DE 3.15.1 (commit 746744c: TOAST-XSS + LOGIN-ESTADO + OBS-E1a + arnés, la 3.15.1 terminada) para su contrato. 3.15.1
// NO se publicó por separado: entra completa en 3.16.0, que cambia el árbol de trabajo a propósito. El tag v3.15.1 (d2b31e6) quedó antes de
// LOGIN-ESTADO y OBS-E1a, por eso la instantánea es 746744c. Se exporta ese commit (`git archive`, solo lectura, no toca el árbol ni el
// índice) a un directorio temporal y las pruebas se ejecutan contra ESA copia. Mismo diseño que congelado-3.15.0.mjs.
// Falla CERRADO: si el commit no existe en este clon, o si su manifest no es el de 3.15.1, es un error (no un «se omite»).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMMIT_3151 = "746744c52cdae8fefa762e835fcb24907e7a6ee0";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GRANDE = 512 * 1024 * 1024;

let cache = null;
export function raiz3151() {
  if (cache) return cache;
  const git = (...a) => spawnSync("git", ["-C", REPO, ...a], { maxBuffer: GRANDE });
  const r = git("rev-parse", "--verify", "--quiet", `${COMMIT_3151}^{commit}`);
  if (r.status !== 0 || r.stdout.toString().trim() !== COMMIT_3151) throw new Error(`Falta el commit ${COMMIT_3151} (release 3.15.1) en este clon: sin él no se puede comprobar la integridad de 3.15.1.`);
  const a = git("archive", "--format=tar", COMMIT_3151);
  if (a.status !== 0) throw new Error(`git archive falló: ${a.stderr.toString().trim()}`);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-v3.15.1-"));
  const t = spawnSync("tar", ["-x", "-C", d], { input: a.stdout, maxBuffer: GRANDE });
  if (t.status !== 0) throw new Error(`tar falló: ${t.stderr.toString().trim()}`);
  process.on("exit", () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ya no está */ } });
  const version = JSON.parse(fs.readFileSync(path.join(d, "pruebas/multiusuario/release-3.15.1-manifest.json"), "utf8")).version;
  if (version !== "3.15.1") throw new Error(`El commit ${COMMIT_3151} no trae el manifest de 3.15.1 (version ${version}).`);
  return (cache = d);
}

/** Rutas versionadas en el commit del release (equivale a `git ls-files` sobre ese commit). */
export function archivosDe3151(prefijo) {
  const r = spawnSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", COMMIT_3151, "--", prefijo], { encoding: "utf8", maxBuffer: GRANDE });
  if (r.status !== 0) throw new Error(`git ls-tree falló: ${r.stderr.trim()}`);
  return r.stdout.split("\n").filter(Boolean);
}
