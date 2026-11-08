"""Tarea 3 · los renglones de la orden se corrigen en cualquier etapa hasta cobrarla (copia SIN NUBE, 390 px).

  ~/.venvs/playwright/bin/python -I pruebas/ui-telefono/t3_corregir_orden.py
"""
import os, sys, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revisar import preparar_copia, servir, entrar, abrir_navegador
from playwright.sync_api import sync_playwright

fallas = []
def comprobar(cond, texto):
    print(("OK   " if cond else "FALLA ") + texto)
    if not cond: fallas.append(texto)

AVISO_COBRADA = "La orden ya se cobró: para corregirla hay que anularla (PIN del propietario)."
EDITABLE = "() => document.querySelectorAll('#itemsBody [data-editar]').length"

tmp, app = preparar_copia()
srv, base = servir(app)
try:
    with sync_playwright() as p:
        b, pg = abrir_navegador(p, 390)
        entrar(pg, base)
        pg.on("dialog", lambda d: d.accept())

        # orden 2 pasada a Calidad
        pg.evaluate("updateOrder(2, o => { o.estado = 'calidad'; })"); pg.wait_for_timeout(500)
        pg.evaluate("openOrder(2)"); pg.wait_for_timeout(1000)
        comprobar(pg.locator("#btnAgregarItem").count() == 1, "en Calidad se puede agregar un renglón")

        # orden 3: Entregado y sin cobrar
        pg.evaluate("openOrder(3)"); pg.wait_for_timeout(1000)
        comprobar(pg.evaluate(EDITABLE) > 0, "en Entregado (sin cobrar) los renglones tienen Editar")

        # cobrarla
        pg.click("#btnAvanzar"); pg.wait_for_timeout(800)
        for _ in range(3):
            ok = pg.locator("#modalConfirm.active #btnConfirmAceptar").first
            if ok.is_visible(): ok.click(); pg.wait_for_timeout(1000)
        finalizada = pg.evaluate("(async () => (await DB.get('ordenes', 3)).finalizada === true)()")
        comprobar(finalizada, "la orden 3 quedó cobrada (finalizada)")
        pg.evaluate("openOrder(3)"); pg.wait_for_timeout(1000)
        comprobar(pg.evaluate(EDITABLE) == 0, "ya cobrada: sin Editar/Quitar")
        comprobar(pg.locator("#btnAgregarItem").count() == 0, "ya cobrada: sin Agregar")
        comprobar(pg.locator("#stageContent", has_text=AVISO_COBRADA).count() == 1, "ya cobrada: explica cómo corregirla")
        comprobar(pg.locator("#itemsBody", has_text="Kit").count() + pg.locator("#itemsBody tr").count() > 0, "ya cobrada: los renglones se ven (solo lectura)")
        b.close()
finally:
    srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
print(f"{len(fallas)} falla(s)")
sys.exit(1 if fallas else 0)
