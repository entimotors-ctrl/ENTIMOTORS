// Importar PRIMERO en una prueba del contrato de 3.15.1: desde aquí, helpers/entorno.mjs (RUNTIME, leer, existe, el vm) apunta a la
// instantánea inmutable de 3.15.1 (commit 746744c, helpers/congelado-3.15.1.mjs: git archive a un temporal, falla cerrado si el commit no
// está o no es el de 3.15.1). El contrato vigente de 3.16.0 está en los archivos hermanos (01-pwa-3.16.0, 16f, 26e).
import { raiz3151 } from "./congelado-3.15.1.mjs";
process.env.ENTIMOTORS_RUNTIME_RAIZ = raiz3151();
process.env.ENTIMOTORS_RUNTIME_RELEASE = "3.15.1";
