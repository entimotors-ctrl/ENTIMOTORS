// Importar PRIMERO en una prueba del contrato de 3.13.0: desde aquí, helpers/entorno.mjs (RUNTIME, leer, existe, el vm) apunta
// a la instantánea inmutable del tag v3.13.0 (helpers/congelado.mjs: git archive a un temporal, falla cerrado si el tag cambió).
import { RAIZ_313 } from "./congelado.mjs";
process.env.ENTIMOTORS_RUNTIME_RAIZ = RAIZ_313;
