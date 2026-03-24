import { Router, type Request, type Response, type NextFunction } from "express";

const router = Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "entimotors2024";

router.post("/admin/login", (req: Request, res: Response) => {
  const { password } = req.body as { password: string };
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: Buffer.from(ADMIN_PASSWORD).toString("base64") });
  } else {
    res.status(401).json({ error: "Contraseña incorrecta" });
  }
});

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  const token = auth?.replace("Bearer ", "");
  const expected = Buffer.from(ADMIN_PASSWORD).toString("base64");
  if (token !== expected) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }
  next();
}

export default router;
