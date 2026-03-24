import { Router } from "express";
import multer from "multer";
import path from "path";
import { supabase, BUCKET } from "../lib/supabase.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|gif/;
    const ok = allowed.test(file.mimetype) && allowed.test(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  },
});

const router = Router();

router.get("/products", async (_req, res) => {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.post("/products", upload.single("image"), async (req, res) => {
  const { name, price, category } = req.body as { name: string; price: string; category: string };
  if (!name || !price) {
    res.status(400).json({ error: "Nombre y precio son requeridos" });
    return;
  }

  const validCategories = ["repuesto", "accesorio"];
  const cat = validCategories.includes(category) ? category : "repuesto";

  let imageUrl: string | null = null;
  if (req.file) {
    const ext = path.extname(req.file.originalname);
    const filename = `products/${Date.now()}${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype });
    if (uploadError) {
      res.status(500).json({ error: "Error al subir imagen: " + uploadError.message });
      return;
    }
    const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(filename);
    imageUrl = publicUrl;
  }

  const { data, error } = await supabase
    .from("products")
    .insert({ name, price: parseFloat(price), image: imageUrl, category: cat })
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.delete("/products/:id", async (req, res) => {
  const { id } = req.params;
  const { data: row, error: fetchError } = await supabase
    .from("products")
    .select("image")
    .eq("id", id)
    .single();
  if (fetchError || !row) { res.status(404).json({ error: "Producto no encontrado" }); return; }

  if (row.image) {
    try {
      const urlPath = new URL(row.image).pathname;
      const storagePath = urlPath.split(`/public/${BUCKET}/`)[1];
      if (storagePath) await supabase.storage.from(BUCKET).remove([storagePath]);
    } catch {}
  }

  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

export default router;
