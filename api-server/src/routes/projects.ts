import { Router } from "express";
import multer from "multer";
import path from "path";
import { supabase, BUCKET } from "../lib/supabase.js";
import { requireAdmin } from "./admin-auth.js";

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

// Sube un archivo al storage y devuelve la URL pública
async function uploadImage(buffer: Buffer, originalname: string, mimetype: string): Promise<string> {
  const ext = path.extname(originalname);
  const filename = `projects/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filename, buffer, { contentType: mimetype });
  if (error) throw new Error("Error al subir imagen: " + error.message);
  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(filename);
  return publicUrl;
}

// Elimina una imagen del storage por su URL pública
async function deleteImageByUrl(url: string): Promise<void> {
  try {
    const urlPath = new URL(url).pathname;
    const storagePath = urlPath.split(`/public/${BUCKET}/`)[1];
    if (storagePath) await supabase.storage.from(BUCKET).remove([storagePath]);
  } catch {}
}

// GET /projects — devuelve proyectos con todas sus fotos
router.get("/projects", async (_req, res) => {
  const { data, error } = await supabase
    .from("projects")
    .select("*, project_images(id, image_url, created_at)")
    .order("created_at", { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// POST /projects — crea proyecto con una o más fotos
router.post("/projects", requireAdmin, upload.array("images", 10), async (req, res) => {
  const { title, status } = req.body as { title: string; status: string };
  const files = req.files as Express.Multer.File[];

  if (!title || !status) {
    res.status(400).json({ error: "Título y estado son requeridos" });
    return;
  }
  if (!["en_curso", "terminado"].includes(status)) {
    res.status(400).json({ error: "Estado inválido" });
    return;
  }

  // Crear el proyecto primero
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .insert({ title, status, image: null })
    .select()
    .single();
  if (projectError) { res.status(500).json({ error: projectError.message }); return; }

  // Subir las fotos si se enviaron
  if (files && files.length > 0) {
    const uploadPromises = files.map(f => uploadImage(f.buffer, f.originalname, f.mimetype));
    let urls: string[];
    try {
      urls = await Promise.all(uploadPromises);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
      return;
    }

    const rows = urls.map(url => ({ project_id: project.id, image_url: url }));
    const { error: imgError } = await supabase.from("project_images").insert(rows);
    if (imgError) { res.status(500).json({ error: imgError.message }); return; }

    // Guardar la primera foto como imagen principal (compatibilidad)
    await supabase.from("projects").update({ image: urls[0] }).eq("id", project.id);
    project.image = urls[0];
  }

  res.status(201).json(project);
});

// PATCH /projects/:id/status — actualiza el estado del proyecto
router.patch("/projects/:id/status", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body as { status: string };
  if (!["en_curso", "terminado"].includes(status)) {
    res.status(400).json({ error: "Estado inválido" });
    return;
  }
  const { data, error } = await supabase
    .from("projects")
    .update({ status })
    .eq("id", id)
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// POST /projects/:id/images — agrega más fotos a un proyecto existente
router.post("/projects/:id/images", requireAdmin, upload.array("images", 10), async (req, res) => {
  const { id } = req.params;
  const files = req.files as Express.Multer.File[];

  if (!files || files.length === 0) {
    res.status(400).json({ error: "Se requiere al menos una imagen" });
    return;
  }

  // Verificar que el proyecto existe
  const { data: project, error: fetchError } = await supabase
    .from("projects")
    .select("id, image")
    .eq("id", id)
    .single();
  if (fetchError || !project) { res.status(404).json({ error: "Proyecto no encontrado" }); return; }

  const uploadPromises = files.map(f => uploadImage(f.buffer, f.originalname, f.mimetype));
  let urls: string[];
  try {
    urls = await Promise.all(uploadPromises);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }

  const rows = urls.map(url => ({ project_id: Number(id), image_url: url }));
  const { data: newImages, error: imgError } = await supabase
    .from("project_images")
    .insert(rows)
    .select();
  if (imgError) { res.status(500).json({ error: imgError.message }); return; }

  // Si el proyecto no tenía imagen principal, asignar la primera
  if (!project.image) {
    await supabase.from("projects").update({ image: urls[0] }).eq("id", id);
  }

  res.status(201).json(newImages);
});

// DELETE /projects/:id/images/:imageId — elimina una foto individual
router.delete("/projects/:id/images/:imageId", requireAdmin, async (req, res) => {
  const { id, imageId } = req.params;

  const { data: img, error: fetchError } = await supabase
    .from("project_images")
    .select("image_url")
    .eq("id", imageId)
    .eq("project_id", id)
    .single();
  if (fetchError || !img) { res.status(404).json({ error: "Imagen no encontrada" }); return; }

  await deleteImageByUrl(img.image_url);

  const { error } = await supabase.from("project_images").delete().eq("id", imageId);
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Si era la imagen principal, actualizar con la siguiente disponible
  const { data: project } = await supabase.from("projects").select("image").eq("id", id).single();
  if (project?.image === img.image_url) {
    const { data: remaining } = await supabase
      .from("project_images")
      .select("image_url")
      .eq("project_id", id)
      .order("created_at", { ascending: true })
      .limit(1);
    const newMain = remaining?.[0]?.image_url ?? null;
    await supabase.from("projects").update({ image: newMain }).eq("id", id);
  }

  res.json({ success: true });
});

// DELETE /projects/:id — elimina el proyecto y todas sus fotos
router.delete("/projects/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  // Obtener todas las imágenes del proyecto
  const { data: images } = await supabase
    .from("project_images")
    .select("image_url")
    .eq("project_id", id);

  // Eliminar archivos del storage
  if (images && images.length > 0) {
    await Promise.all(images.map(img => deleteImageByUrl(img.image_url)));
  }

  // Eliminar el proyecto (las imágenes en la tabla se eliminan por CASCADE)
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

export default router;
