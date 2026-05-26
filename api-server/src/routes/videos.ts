import { Router } from "express";
import { supabase } from "../lib/supabase.js";

const router = Router();

async function parseVideoUrl(rawUrl: string): Promise<string | null> {
  const url = rawUrl.trim();

  // Already an embed URL — return as-is
  if (
    url.includes("youtube.com/embed/") ||
    url.includes("tiktok.com/embed/") ||
    url.includes("facebook.com/plugins/video.php")
  ) {
    return url;
  }

  // YouTube – all standard formats
  const youtubeMatch = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  if (youtubeMatch) {
    return `https://www.youtube.com/embed/${youtubeMatch[1]}`;
  }

  // TikTok – full URL with numeric video ID
  const tiktokFullMatch = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  if (tiktokFullMatch) {
    return `https://www.tiktok.com/embed/v2/${tiktokFullMatch[1]}`;
  }

  // TikTok – short URLs (vt.tiktok.com, vm.tiktok.com, tiktok.com/t/)
  if (/(?:vt|vm)\.tiktok\.com\/|tiktok\.com\/t\//.test(url)) {
    // Try oEmbed API first
    try {
      const oembed = await fetch(
        `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (oembed.ok) {
        const json = await oembed.json() as { embed_product_id?: string; author_url?: string };
        if (json.embed_product_id) {
          return `https://www.tiktok.com/embed/v2/${json.embed_product_id}`;
        }
        if (json.author_url) {
          const m = json.author_url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
          if (m) return `https://www.tiktok.com/embed/v2/${m[1]}`;
        }
      }
    } catch { /* continúa al fallback */ }

    // Fallback: seguir el redirect HTTP
    try {
      const redir = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const m = redir.url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
      if (m) return `https://www.tiktok.com/embed/v2/${m[1]}`;
    } catch { /* no se pudo resolver */ }

    return null;
  }

  // Facebook videos
  if (url.includes("facebook.com") || url.includes("fb.watch")) {
    return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false&autoplay=false`;
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
  const embedUrl = await parseVideoUrl(url);
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
