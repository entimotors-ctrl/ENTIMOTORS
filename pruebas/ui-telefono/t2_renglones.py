"""Tarea 2 · renglones de presupuesto y cotización en el teléfono (390 px, táctil), copia SIN NUBE.

  ~/.venvs/playwright/bin/python -I pruebas/ui-telefono/t2_renglones.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revisar import preparar_copia, servir, entrar, abrir_navegador, MINIMO
import shutil
from playwright.sync_api import sync_playwright

XSS = '<img src=x onerror="window.__xss=1">'
fallas = []


def comprobar(cond, texto):
    print(("OK   " if cond else "FALLA ") + texto)
    if not cond: fallas.append(texto)


BOTONES_DENTRO = """([sel, minimo]) => [...document.querySelectorAll(sel)].filter(b => b.offsetParent).map(b => {
  const r = b.getBoundingClientRect(); return { dentro: r.left >= 0 && r.right <= document.documentElement.clientWidth, alto: r.height, ancho: r.width, texto: b.textContent.trim() };
})"""
CORTADA = "(sel) => { const t = document.querySelector(sel); const s = t && (t.closest('.table-scroll') || t); return !!s && s.scrollWidth > s.clientWidth + 2; }"

tmp, app = preparar_copia()
srv, base = servir(app)
try:
    with sync_playwright() as p:
        b, pg = abrir_navegador(p, 390)
        entrar(pg, base)

        # orden 1 (Presupuesto): agregar un renglón con marcado en el nombre
        pg.evaluate("openOrder(1)"); pg.wait_for_timeout(1000)
        pg.click("#btnAgregarItem"); pg.wait_for_timeout(500)
        pg.select_option("#itemTipo", "mano_obra")
        pg.fill("#itemNombre", XSS); pg.fill("#itemCantidad", "1"); pg.fill("#itemPrecio", "100")
        pg.click("#btnGuardarItem"); pg.wait_for_timeout(1200)
        comprobar(pg.evaluate("window.__xss") is None, "el nombre con marcado no se ejecuta")
        comprobar(pg.locator("#itemsBody", has_text=XSS).count() == 1, "el nombre con marcado se ve como texto")
        comprobar(not pg.evaluate(CORTADA, "#tablaItems"), "la tabla del presupuesto no queda cortada")
        bs = pg.evaluate(BOTONES_DENTRO, ["#itemsBody [data-editar], #itemsBody [data-quitar]", MINIMO])
        comprobar(len(bs) >= 6, f"hay botones Editar/Quitar por renglón ({len(bs)})")
        comprobar(all(x["dentro"] for x in bs), "Editar/Quitar quedan dentro de la pantalla")
        comprobar(all(x["alto"] >= MINIMO and x["ancho"] >= MINIMO for x in bs), "Editar/Quitar miden al menos 44 px")
        comprobar(all(("Editar" in x["texto"]) or ("Quitar" in x["texto"]) for x in bs), "Editar/Quitar tienen texto")

        # formulario de cotización con un renglón
        pg.evaluate("document.querySelector(\".nav-item[data-view='cotizaciones']\").click()"); pg.wait_for_timeout(600)
        pg.click("text=+ Nueva cotización"); pg.wait_for_timeout(600)
        pg.fill("#cotNombre", "Cliente Prueba"); pg.fill("#cotTelefono", "99998888")
        pg.click("#btnAgregarItemCot"); pg.wait_for_timeout(500)
        pg.select_option("#cotItemTipo", "mano_obra")
        pg.fill("#cotItemNombre", "Cambio de aceite"); pg.fill("#cotItemPrecio", "250")
        pg.click("#btnGuardarItemCot"); pg.wait_for_timeout(500)
        bs = pg.evaluate(BOTONES_DENTRO, ["#cotItemsEdit [data-editar], #cotItemsEdit [data-quitar]", MINIMO])
        comprobar(len(bs) == 2 and all(x["alto"] >= MINIMO and x["ancho"] >= MINIMO for x in bs), "renglón del formulario de cotización: botones de 44 px")
        pg.click("#btnGuardarCotizacion"); pg.wait_for_timeout(1000)
        pg.evaluate("abrirCotizacionDetalle(1)"); pg.wait_for_timeout(800)
        comprobar(not pg.evaluate(CORTADA, "#cotDetItems"), "la tabla del detalle de cotización no queda cortada")

        # el botón de inicio no tapa el final de la lista de órdenes
        pg.evaluate("cerrarCotDetalle(); document.querySelector(\".nav-item[data-view='ordenes']\").click()"); pg.wait_for_timeout(800)
        pg.evaluate("(() => { const m = document.getElementById('main'); m.scrollTop = m.scrollHeight; })()"); pg.wait_for_timeout(400)
        tapa = pg.evaluate("""() => { const f = document.getElementById('fabHome').getBoundingClientRect();
          const filas = [...document.querySelectorAll('#view-ordenes .order-row, #view-ordenes [data-id]')].filter(e => e.offsetParent);
          const u = filas[filas.length - 1]?.getBoundingClientRect(); return !!u && u.bottom > f.top && u.top < f.bottom && u.left < f.right; }""")
        comprobar(not tapa, "el botón de inicio no tapa la última orden")
        b.close()
finally:
    srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
print(f"{len(fallas)} falla(s)")
sys.exit(1 if fallas else 0)
