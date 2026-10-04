// 3.15.0 · Bloque 6 · frases de demo/desarrollo PROHIBIDAS en lo que ve el usuario del producto publicado (Taller y Mi Trabajo).
// La palabra «ejemplo» sola NO se prohíbe: «por ejemplo» y los «Ej.» de los placeholders son legítimos (PERMITIDAS, allowlist explícita).
// La usan b6-artefacto-publico (HTML publicado) y b6-producto-app-real (texto en pantalla, navegador real).
export const PROHIBIDAS = [/\bdemo\b/i, /datos de ejemplo/i, /simular sin conexi/i, /solo aqu[ií]/i, /visitas (hoy|este mes)/i, /contenido local/i,
  /gestor de la web/i, /arranc[óo] con datos/i, /pruebas de desarrollo/i, /\blocalhost\b|127\.0\.0\.1/i, /config-local/i, /panel-tecnico/i];
export const PERMITIDAS = [/por ejemplo/i, /\bEj\.\s/];
export const prohibidasEn = (texto) => PROHIBIDAS.filter((re) => re.test(texto)).map(String);
