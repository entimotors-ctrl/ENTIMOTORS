// 3.15 (Bloque 8): «apikey» hace que CUALQUIER service worker de la app (también el 3.14.1 publicado) deje pasar el puente sin
// atenderlo: su espera larga (/__cmd, hasta 15 s, siempre abierta) contaba como petición en curso del worker viejo y Chromium no
// activaba nunca el nuevo (lo que se prueba en b8-pwa-actualizacion). No es una credencial: el servidor del arnés la ignora.
const PUENTE = { apikey: "arnes-puente", "x-pagina": Math.random().toString(36).slice(2, 8) };
// Puente Node ↔ página: pide comandos al servidor de la prueba, los ejecuta aquí y devuelve el resultado.
(async function bucle() {
  // 3.15 (Bloque 7): dentro de un iframe (la app dentro de un marco de ancho de teléfono) NO: la página principal lo maneja; si no, dos
  // puentes se repartirían los comandos
  if (window.top !== window) return;
  for (;;) {
    // 3.15 (Bloque 8): solo una página VISIBLE atiende al arnés (Firefox puede renderizar la misma URL en una pestaña oculta propia)
    if (document.visibilityState === "hidden") { await new Promise((r) => setTimeout(r, 300)); continue; }
    let c;
    try { c = await (await fetch("/__cmd", { cache: "no-store", headers: PUENTE })).json(); } catch (e) { await new Promise((r) => setTimeout(r, 300)); continue; }
    if (!c || !c.id) continue;
    let salida;
    try { const f = (0, eval)("(" + c.fn + ")"); const v = await f(c.arg); salida = { id: c.id, ok: true, valor: v === undefined ? null : v }; }
    catch (e) { salida = { id: c.id, ok: false, error: String((e && e.stack) || e) }; }
    try { await fetch("/__res", { method: "POST", body: JSON.stringify(salida), headers: PUENTE }); } catch (e) { /* el servidor se cerró */ }
  }
})();
