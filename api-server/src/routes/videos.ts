import { Router } from "express";
import { supabase } from "../lib/supabase.js";

const router = Router();

function parseVideoUrl(url: string): string | null {
  const youtubeMatch = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  if (youtubeMatch) {
    return `https://www.youtube.com/embed/${youtubeMatch[1]}`;
  }

  const tiktokMatch = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  if (tiktokMatch) {
    return `https://www.tiktok.com/embed/v2/${tiktokMatch[1]}`;
  }

  if (url.includes("youtube.com/embed/") || url.includes("tiktok.com/embed/")) {
    return url;
  }

  return null;
}

router.get("/videos", async (_req, res) => {
  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.post("/videos", async (req, res) => {
  const { title, url } = req.body as { title: string; url: string };
  if (!title || !url) {
    res.status(400).json({ error: "Título y URL son requeridos" });
    return;
  }
  const embedUrl = parseVideoUrl(url);
  if (!embedUrl) {
    res.status(400).json({ error: "URL de YouTube o TikTok inválida" });
    return;
  }

  const { data, error } = await supabase
    .from("videos")
    .insert({ title, url: embedUrl })
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.delete("/videos/:id", async (req, res) => {
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
