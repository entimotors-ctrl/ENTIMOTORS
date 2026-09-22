// Puente Node ↔ página: pide comandos al servidor de la prueba, los ejecuta aquí y devuelve el resultado.
(async function bucle() {
  for (;;) {
    let c;
    try { c = await (await fetch("/__cmd", { cache: "no-store" })).json(); } catch (e) { await new Promise((r) => setTimeout(r, 300)); continue; }
    if (!c || !c.id) continue;
    let salida;
    try { const f = (0, eval)("(" + c.fn + ")"); const v = await f(c.arg); salida = { id: c.id, ok: true, valor: v === undefined ? null : v }; }
    catch (e) { salida = { id: c.id, ok: false, error: String((e && e.stack) || e) }; }
    try { await fetch("/__res", { method: "POST", body: JSON.stringify(salida) }); } catch (e) { /* el servidor se cerró */ }
  }
})();
