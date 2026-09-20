// Carga en el NAVEGADOR el mismo servidor sintetico que usa la suite de node (helpers/supabase-mock.mjs), sin copiarlo:
// solo se le da el unico simbolo de Node que necesita (Buffer.from(...).toString("base64url")) para inventar JWT sinteticos.
if (!globalThis.Buffer) {
  globalThis.Buffer = {
    from(s) {
      const bytes = new TextEncoder().encode(String(s));
      return { toString() { let b = ""; bytes.forEach((x) => { b += String.fromCharCode(x); }); return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); } };
    },
  };
}
export const M = await import("/__m/supabase-mock.mjs");
