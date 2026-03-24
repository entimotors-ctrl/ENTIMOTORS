import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Faltan variables de entorno: SUPABASE_URL y SUPABASE_SERVICE_KEY");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
export const BUCKET = "entimotors-media";
