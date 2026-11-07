// Importar PRIMERO en una prueba del contrato de 3.15.0: desde aquí, helpers/entorno.mjs (RUNTIME, leer, existe, el vm) apunta a la
// instantánea inmutable del release 3.15.0 (tag v3.15.0 → commit f2a6598, helpers/congelado-3.15.0.mjs: git archive a un temporal, falla
// cerrado si el commit no está o no es el de 3.15.0). El contrato vigente de 3.15.1 está en los archivos hermanos (01-pwa-3.15.1, 16e, 26d).
import { raiz3150 } from "./congelado-3.15.0.mjs";
process.env.ENTIMOTORS_RUNTIME_RAIZ = raiz3150();
process.env.ENTIMOTORS_RUNTIME_RELEASE = "3.15.0";
