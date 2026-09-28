// Importar PRIMERO en una prueba del contrato de 3.14.0: desde aquí, helpers/entorno.mjs (RUNTIME, leer, existe, el vm) apunta a la
// instantánea inmutable del release 3.14.0 (commit effbfa1, helpers/congelado-3.14.0.mjs: git archive a un temporal, falla cerrado si
// el commit no está o no es el de 3.14.0). El contrato vigente de 3.14.1 está en los archivos hermanos (01-pwa-3.14.1, 16c).
import { raiz3140 } from "./congelado-3.14.0.mjs";
process.env.ENTIMOTORS_RUNTIME_RAIZ = raiz3140();
process.env.ENTIMOTORS_RUNTIME_RELEASE = "3.14.0";
