// Importar PRIMERO en una prueba del contrato de 3.14.1: desde aquí, helpers/entorno.mjs (RUNTIME, leer, existe, el vm) apunta a la
// instantánea inmutable del release 3.14.1 (commit e807f65, helpers/congelado-3.14.1.mjs: git archive a un temporal, falla cerrado si
// el commit no está o no es el de 3.14.1). El contrato vigente de 3.15.0 está en los archivos hermanos (01-pwa-3.15.0, 16d).
import { raiz3141 } from "./congelado-3.14.1.mjs";
process.env.ENTIMOTORS_RUNTIME_RAIZ = raiz3141();
process.env.ENTIMOTORS_RUNTIME_RELEASE = "3.14.1";
