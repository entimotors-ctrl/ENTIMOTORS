import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import productsRouter from "./products.js";
import projectsRouter from "./projects.js";
import videosRouter from "./videos.js";
import adminAuthRouter from "./admin-auth.js";
import adminUsuariosRouter from "./admin-usuarios.js";

const router: IRouter = Router();

// Gestión del equipo del taller. Autoriza por token de Supabase, no por
// contraseña compartida: ver admin-usuarios.ts.
router.use(adminUsuariosRouter);

router.use(healthRouter);
router.use(adminAuthRouter);
router.use(productsRouter);
router.use(projectsRouter);
router.use(videosRouter);

export default router;
