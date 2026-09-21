import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import productsRouter from "./products.js";
import projectsRouter from "./projects.js";
import videosRouter from "./videos.js";
import adminAuthRouter from "./admin-auth.js";
import adminUsuariosRouter from "./admin-usuarios.js";
import pinRouter from "./pin.js";

const router: IRouter = Router();

// Gestión del equipo del taller. Autoriza por token de Supabase, no por
// contraseña compartida: ver admin-usuarios.ts.
router.use(adminUsuariosRouter);

// PIN administrativo (D-7) y autorizaciones de un solo uso: token Bearer, límites de intentos en la base.
router.use(pinRouter);

router.use(healthRouter);
router.use(adminAuthRouter);
router.use(productsRouter);
router.use(projectsRouter);
router.use(videosRouter);

export default router;
