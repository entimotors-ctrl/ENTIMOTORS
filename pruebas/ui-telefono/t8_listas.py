"""Tarea 8 · listas largas como tarjetas en el teléfono (y como tabla en PC) + botón grande para las fotos (copia SIN NUBE).

  ~/.venvs/playwright/bin/python -I pruebas/ui-telefono/t8_listas.py
"""
import os, sys, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revisar import preparar_copia, servir, entrar, abrir_navegador, MINIMO
from playwright.sync_api import sync_playwright

fallas = []
def comprobar(cond, texto):
    print(("OK   " if cond else "FALLA ") + texto)
    if not cond: fallas.append(texto)

TABLAS = {"clientes": "#clientesBody", "inventario": "#inventarioBody", "finanzas": "#movimientosBody", "creditos": "#creditosBody"}
# la forma se mide en la FILA: una celda puede ser flex por su propio contenido (la del repuesto en Inventario lo es también en PC)
FORMA = """(sel) => { const tb = document.querySelector(sel), t = tb && tb.closest('table'); const tr = tb && tb.querySelector('tr');
  return { marcada: !!t && t.classList.contains('tabla-tarjetas') && t.dataset.etiquetas === 'auto',
           fila: tr ? getComputedStyle(tr).display : null, etiqueta: tr ? (tr.querySelector('[data-label]')?.dataset.label || null) : null }; }"""

tmp, app = preparar_copia()
srv, base = servir(app)
try:
    with sync_playwright() as p:
        for ancho, esperado in ((360, "flex"), (1280, "table-cell")):
            b, pg = abrir_navegador(p, ancho)
            entrar(pg, base)
            for vista, sel in TABLAS.items():
                pg.evaluate(f"document.querySelector(\".nav-item[data-view='{vista}']\").click()"); pg.wait_for_timeout(900)
                f = pg.evaluate(FORMA, sel)
                comprobar(f["marcada"], f"{vista} @{ancho}: la tabla está marcada para verse como tarjetas")
                if f["fila"] is None: print(f"     ({vista}: los datos de ejemplo no traen filas)"); continue
                comprobar(f["fila"] == ("flex" if ancho < 600 else "table-row"), f"{vista} @{ancho}: filas como {'tarjeta' if ancho < 600 else 'tabla'} ({f['fila']})")
                if ancho < 600: comprobar(bool(f["etiqueta"]), f"{vista} @{ancho}: las celdas llevan su etiqueta ({f['etiqueta']})")
            if ancho < 600:
                pg.evaluate("openOrder(1)"); pg.wait_for_timeout(900)
                boton = pg.locator("label[for=inputFotos]")
                caja = boton.bounding_box() if boton.count() else None
                comprobar(bool(caja) and caja["height"] >= MINIMO and "fotos" in boton.inner_text().lower(), "botón grande «Tomar o elegir fotos»")
                if caja:
                    with pg.expect_file_chooser() as fc: boton.click()
                    comprobar(fc.value.is_multiple(), "abre el selector de fotos (varias)")
            b.close()
finally:
    srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
print(f"{len(fallas)} falla(s)")
sys.exit(1 if fallas else 0)
