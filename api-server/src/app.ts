import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { createClient } from "@supabase/supabase-js"; // <-- Importamos Supabase para la rifa

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

// --- INICIALIZAMOS SUPABASE CON TUS CREDENCIALES DE RENDER ---
const supabaseUrl = process.env.SUPABASE_URL as string;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY as string;
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  })
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(path.resolve(__dirname, "../uploads")));
app.use(express.static(path.resolve(__dirname, "../public")));


// ==========================================
// RUTA NUEVA: REGISTRO DE LA GRAN RIFA
// ==========================================
app.post("/api/rifa/registrar", async (req, res) => {
  const { codigo, nombre, telefono } = req.body;

  if (!codigo || !nombre || !telefono) {
    res.status(400).json({ error: "Todos los campos son obligatorios" });
    return;
  }

  try {
    const { data, error } = await supabase
      .from("rifa")
      .insert([{ codigo, nombre, telefono }]);

    if (error) {
      // 23505 es el código SQL oficial para "Llave Primaria duplicada" (código ya usado)
      if (error.code === "23505") {
        res.status(400).json({ error: "Alguien más ya registró este código." });
        return;
      }
      throw error;
    }

    res.status(200).json({ success: true, message: "Código registrado correctamente" });
  } catch (error) {
    logger.error({ error }, "Error al registrar en la rifa");
    res.status(500).json({ error: "Error interno del servidor." });
  }
});
// ==========================================


app.use("/api", router);

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});

export default app;
