import { Router } from "express";
import multer from "multer";
import path from "path";
import { supabase, BUCKET } from "../lib/supabase.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|gif/;
    const ok = allowed.test(file.mimetype) && allowed.test(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  },
});

const router = Router();

router.get("/projects", async (_req, res) => {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.post("/projects", upload.single("image"), async (req, res) => {
  const { title, status } = req.body as { title: string; status: string };
  if (!title || !status || !req.file) {
    res.status(400).json({ error: "Título, estado e imagen son requeridos" });
    return;
  }
  if (!["en_curso", "terminado"].includes(status)) {
    res.status(400).json({ error: "Estado inválido" });
    return;
  }

  const ext = path.extname(req.file.originalname);
  const filename = `projects/${Date.now()}${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(filename, req.file.buffer, { contentType: req.file.mimetype });
  if (uploadError) {
    res.status(500).json({ error: "Error al subir imagen: " + uploadError.message });
    return;
  }
  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(filename);

  const { data, error } = await supabase
    .from("projects")
    .insert({ title, image: publicUrl, status })
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.delete("/projects/:id", async (req, res) => {
  const { id } = req.params;
  const { data: row, error: fetchError } = await supabase
    .from("projects")
    .select("image")
    .eq("id", id)
    .single();
  if (fetchError || !row) { res.status(404).json({ error: "Proyecto no encontrado" }); return; }

  if (row.image) {
    try {
      const urlPath = new URL(row.image).pathname;
      const storagePath = urlPath.split(`/public/${BUCKET}/`)[1];
      if (storagePath) await supabase.storage.from(BUCKET).remove([storagePath]);
    } catch {}
  }

  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

export default router;
