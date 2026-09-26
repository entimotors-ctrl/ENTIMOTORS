// INSTANTÁNEA INMUTABLE DE 3.14.0 para las pruebas de INTEGRIDAD del freeze (mismo método que congelado.mjs para 3.13.0).
// Desde 3.14.1 el árbol de trabajo cambia a propósito (UI-1B en adelante), así que «el repositorio coincide con el manifest de 3.14.0» ya no
// se puede comprobar contra el árbol de trabajo. Lo que importa es que el release PUBLICADO sigue intacto: se exporta su commit (`git archive`,
// solo lectura, no toca el árbol ni el índice) a un directorio temporal y las pruebas se ejecutan contra ESA copia.
// 3.14.0 no tiene tag: el release es el commit effbfa1 («release: prepara ENTIMOTORS OS 3.14.0»), el que se publicó en main.
// Falla CERRADO: si el commit no existe en este clon, o si su manifest no es el de 3.14.0, es un error (no un «se omite»).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMMIT_3140 = "effbfa186d6f1e0db3bc8261e1c413f5f26077fc";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GRANDE = 512 * 1024 * 1024;

let cache = null;
export function raiz3140() {
  if (cache) return cache;
  const git = (...a) => spawnSync("git", ["-C", REPO, ...a], { maxBuffer: GRANDE });
  const r = git("rev-parse", "--verify", "--quiet", `${COMMIT_3140}^{commit}`);
  if (r.status !== 0 || r.stdout.toString().trim() !== COMMIT_3140) throw new Error(`Falta el commit ${COMMIT_3140} (release 3.14.0) en este clon: sin él no se puede comprobar la integridad de 3.14.0.`);
  const a = git("archive", "--format=tar", COMMIT_3140);
  if (a.status !== 0) throw new Error(`git archive falló: ${a.stderr.toString().trim()}`);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-v3.14.0-"));
  const t = spawnSync("tar", ["-x", "-C", d], { input: a.stdout, maxBuffer: GRANDE });
  if (t.status !== 0) throw new Error(`tar falló: ${t.stderr.toString().trim()}`);
  process.on("exit", () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ya no está */ } });
  const version = JSON.parse(fs.readFileSync(path.join(d, "pruebas/multiusuario/release-3.14.0-manifest.json"), "utf8")).version;
  if (version !== "3.14.0") throw new Error(`El commit ${COMMIT_3140} no trae el manifest de 3.14.0 (version ${version}).`);
  return (cache = d);
}

/** Rutas versionadas en el commit del release (equivale a `git ls-files` sobre ese commit). */
export function archivosDe3140(prefijo) {
  const r = spawnSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", COMMIT_3140, "--", prefijo], { encoding: "utf8", maxBuffer: GRANDE });
  if (r.status !== 0) throw new Error(`git ls-tree falló: ${r.stderr.trim()}`);
  return r.stdout.split("\n").filter(Boolean);
}
