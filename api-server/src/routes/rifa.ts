import { Router } from "express";
import ws from "ws";
import { createClient } from "@supabase/supabase-js";

// Usamos las variables de entorno que ya tienes en Render
const supabaseUrl = process.env.SUPABASE_URL as string;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY as string;
const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: { transport: ws },
});

const router = Router();

router.post("/registrar", async (req, res) => {
  const { codigo, nombre, telefono } = req.body;

  if (!codigo || !nombre || !telefono) {
    return res.status(400).json({ error: "Todos los campos son obligatorios." });
  }

  try {
    const { error } = await supabase
      .from("rifa")
      .insert([{ 
        codigo: codigo.toUpperCase(), 
        nombre, 
        telefono,
        fecha_registro: new Date().toISOString() 
      }]);

    if (error) {
      // Error de código duplicado en base de datos
      if (error.code === "23505") {
        return res.status(400).json({ error: "Este código ya fue registrado anteriormente." });
      }
      throw error;
    }

    return res.status(200).json({ success: true, message: "¡Registro exitoso!" });
  } catch (err) {
    console.error("Error en módulo rifa:", err);
    return res.status(500).json({ error: "Error interno al procesar la rifa." });
  }
});

export default router;
