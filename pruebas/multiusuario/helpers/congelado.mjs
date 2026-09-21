// INSTANTÁNEA INMUTABLE DE 3.13.0 para las pruebas de INTEGRIDAD del freeze.
// Desde 3.14.0 el árbol de trabajo cambia a propósito (backend con PIN, cliente de sincronización…), así que «el repositorio real coincide con el
// manifest de 3.13.0» ya no se puede comprobar contra el árbol de trabajo. Lo que sí se comprueba —y es lo que importa— es que el release publicado
// sigue intacto: se exporta el tag v3.13.0 (`git archive`, solo lectura, no toca el árbol ni el índice) a un directorio temporal y las pruebas de
// integridad se ejecutan contra ESA copia. Falla CERRADO: sin el tag, o si el tag apunta a otro commit, es un error (no un «se omite»).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TAG_313 = "v3.13.0";
export const COMMIT_313 = "7c46f1b0e8f30ec6d4cd82092a421773d8ebdf25";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GRANDE = 512 * 1024 * 1024;

let cache = null;
export function raiz313() {
  if (cache) return cache;
  const git = (...a) => spawnSync("git", ["-C", REPO, ...a], { maxBuffer: GRANDE });
  const r = git("rev-parse", "--verify", "--quiet", `${TAG_313}^{commit}`);
  if (r.status !== 0) throw new Error(`Falta el tag ${TAG_313} en este clon: sin él no se puede comprobar la integridad de 3.13.0 (git fetch --tags).`);
  const commit = r.stdout.toString().trim();
  if (commit !== COMMIT_313) throw new Error(`El tag ${TAG_313} apunta a ${commit} y debería apuntar a ${COMMIT_313}: 3.13.0 fue modificado.`);
  const a = git("archive", "--format=tar", COMMIT_313);
  if (a.status !== 0) throw new Error(`git archive falló: ${a.stderr.toString().trim()}`);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-v3.13.0-"));
  const t = spawnSync("tar", ["-x", "-C", d], { input: a.stdout, maxBuffer: GRANDE });
  if (t.status !== 0) throw new Error(`tar falló: ${t.stderr.toString().trim()}`);
  process.on("exit", () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ya no está */ } });
  return (cache = d);
}
export const RAIZ_313 = raiz313();
