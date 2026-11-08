"""Tarea 4 · cotización: se elimina SIN el código local (que en producción no existe) y una aceptada lleva a su orden.

  ~/.venvs/playwright/bin/python -I pruebas/ui-telefono/t4_cotizacion.py
"""
import os, sys, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revisar import preparar_copia, servir, entrar, abrir_navegador
from playwright.sync_api import sync_playwright

fallas = []
def comprobar(cond, texto):
    print(("OK   " if cond else "FALLA ") + texto)
    if not cond: fallas.append(texto)

def nueva_cotizacion(pg, nombre):
    pg.evaluate("document.querySelector(\".nav-item[data-view='cotizaciones']\").click()"); pg.wait_for_timeout(600)
    pg.click("text=+ Nueva cotización"); pg.wait_for_timeout(600)
    pg.fill("#cotNombre", nombre); pg.fill("#cotTelefono", "99998888")
    pg.click("#btnAgregarItemCot"); pg.wait_for_timeout(400)
    pg.select_option("#cotItemTipo", "mano_obra"); pg.fill("#cotItemNombre", "Revisión"); pg.fill("#cotItemPrecio", "200")
    pg.click("#btnGuardarItemCot"); pg.wait_for_timeout(400)
    pg.click("#btnGuardarCotizacion"); pg.wait_for_timeout(1000)

def aceptar_modal(pg):
    for _ in range(3):
        ok = pg.locator("#modalConfirm.active #btnConfirmAceptar").first
        if ok.is_visible(): ok.click(); pg.wait_for_timeout(900)

CUANTAS = "(async () => (await DB.getAll('cotizaciones')).length)()"

tmp, app = preparar_copia(con_codigo_admin=False)
srv, base = servir(app)
try:
    with sync_playwright() as p:
        b, pg = abrir_navegador(p, 390)
        entrar(pg, base)
        nueva_cotizacion(pg, "Cliente Uno")
        pg.evaluate("abrirCotizacionDetalle(1)"); pg.wait_for_timeout(700)
        btn = pg.locator("#btnCotEliminar")
        comprobar(btn.is_visible() and "Eliminar cotización" in btn.inner_text(), "el botón dice «Eliminar cotización»")
        btn.click(); pg.wait_for_timeout(600)
        comprobar(not pg.locator("#modalAdminCode.active").count(), "no pide el código de administrador")
        aceptar_modal(pg)
        comprobar(pg.evaluate(CUANTAS) == 0, "la cotización se eliminó")

        nueva_cotizacion(pg, "Cliente Dos")
        cid = pg.evaluate("(async () => (await DB.getAll('cotizaciones'))[0].id)()")
        pg.evaluate(f"abrirCotizacionDetalle({cid})"); pg.wait_for_timeout(700)
        pg.click("#btnCotAceptar"); pg.wait_for_timeout(900); aceptar_modal(pg)
        orden = pg.evaluate(f"(async () => (await DB.get('cotizaciones', {cid})).ordenId)()")
        comprobar(bool(orden), f"aceptada: se creó la orden #{orden}")
        pg.evaluate("document.querySelector(\".nav-item[data-view='cotizaciones']\").click()"); pg.wait_for_timeout(600)
        pg.evaluate(f"abrirCotizacionDetalle({cid})"); pg.wait_for_timeout(700)
        comprobar(not pg.locator("#btnCotEliminar").is_visible(), "aceptada: no se ofrece eliminar")
        ir = pg.locator("#btnCotAbrirOrden")
        comprobar(ir.is_visible() and f"#{orden}" in ir.inner_text(), "aceptada: botón «Abrir la orden #N para corregir»")
        if ir.is_visible():
            ir.click(); pg.wait_for_timeout(1000)
            comprobar(pg.evaluate("currentOrderId") == orden and pg.locator("#view-orden.active, #view-detalle.active, .view.active #btnAvanzar").count() > 0, "abre esa orden")
        b.close()
finally:
    srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
print(f"{len(fallas)} falla(s)")
sys.exit(1 if fallas else 0)
