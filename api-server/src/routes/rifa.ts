import { Router } from "express";
import { createClient } from "@supabase/supabase-js";

// Conexión a Supabase
const supabaseUrl = process.env.SUPABASE_URL as string;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY as string;
const supabase = createClient(supabaseUrl, supabaseKey);

const router = Router();

// Lógica para registrar el código
router.post("/rifa/registrar", async (req, res) => {
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
      // 23505 = Llave Primaria Duplicada
      if (error.code === "23505") {
        res.status(400).json({ error: "Alguien más ya registró este código." });
        return;
      }
      throw error;
    }

    res.status(200).json({ success: true, message: "Código registrado correctamente" });
  } catch (error) {
    console.error("Error al registrar en la rifa:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

export default router;
