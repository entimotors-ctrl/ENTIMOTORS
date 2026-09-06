import { Router, type Request, type Response, type NextFunction } from "express";

const router = Router();

// Sin fallback: si ADMIN_PASSWORD no está configurada en el entorno, no existe
// ninguna credencial válida — el login y requireAdmin rechazan todo en vez de
// autenticar contra un valor por defecto conocido.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

router.post("/admin/login", (req: Request, res: Response) => {
  const { password } = req.body as { password: string };
  if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
    res.json({ success: true, token: Buffer.from(ADMIN_PASSWORD).toString("base64") });
  } else {
    res.status(401).json({ error: "Contraseña incorrecta" });
  }
});

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  const token = auth?.replace("Bearer ", "");
  const expected = ADMIN_PASSWORD ? Buffer.from(ADMIN_PASSWORD).toString("base64") : null;
  if (!expected || token !== expected) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }
  next();
}

export default router;
