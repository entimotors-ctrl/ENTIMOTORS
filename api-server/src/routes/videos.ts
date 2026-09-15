import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAdmin } from "./admin-auth.js";
import { resolverVideo } from "../lib/video-url.js";

const router = Router();

router.get("/videos", async (_req, res) => {
  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.post("/videos", requireAdmin, async (req, res) => {
  const { title, url } = (req.body ?? {}) as { title?: unknown; url?: unknown };
  if (!title || !url || typeof title !== "string" || typeof url !== "string") {
    res.status(400).json({ error: "Título y URL son requeridos" });
    return;
  }
  // Solo se guarda el embed reconstruido desde el id del video, nunca la URL recibida
  // (ver lib/video-url.ts). El mensaje de error no repite lo que se envió.
  const video = await resolverVideo(url);
  if (!video) {
    res.status(400).json({ error: "URL de video no válida. Usa un enlace de YouTube, TikTok o Facebook." });
    return;
  }

  const { data, error } = await supabase
    .from("videos")
    .insert({ title, url: video.embed })
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.delete("/videos/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { data: row, error: fetchError } = await supabase
    .from("videos")
    .select("id")
    .eq("id", id)
    .single();
  if (fetchError || !row) { res.status(404).json({ error: "Video no encontrado" }); return; }

  const { error } = await supabase.from("videos").delete().eq("id", id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

export default router;
