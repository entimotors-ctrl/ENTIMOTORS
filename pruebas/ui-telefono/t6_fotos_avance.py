"""Tarea 6 · «Progreso por WhatsApp» manda las fotos nuevas y no repite las ya enviadas (copia SIN NUBE, 390 px).

El menú de compartir del teléfono se simula (navigator.share / canShare): no sale nada a WhatsApp.
  ~/.venvs/playwright/bin/python -I pruebas/ui-telefono/t6_fotos_avance.py
"""
import os, sys, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revisar import preparar_copia, servir, entrar, abrir_navegador
from playwright.sync_api import sync_playwright

fallas = []
def comprobar(cond, texto):
    print(("OK   " if cond else "FALLA ") + texto)
    if not cond: fallas.append(texto)

SIMULAR_SHARE = """(modo) => {
  navigator.canShare = () => true;
  navigator.share = (d) => { window.__compartido = (d.files || []).length; window.__texto = d.text;
    return modo === 'cancela' ? Promise.reject(new DOMException('cancelado', 'AbortError')) : Promise.resolve(); };
}"""
ENVIADAS = "(async () => FotosAvance.enviadasDe(llaveFotosAvance(await DB.get('ordenes', 1))).length)()"
MARCADAS = "() => document.querySelectorAll('#progFotosLista input[type=checkbox]:checked').length"
TOTAL = "() => document.querySelectorAll('#progFotosLista input[type=checkbox]').length"

def agregar_foto(pg, n):
    """Una foto JPEG válida y distinta cada vez (un cuadro de color), agregada a la orden 1 como las fotos del Taller."""
    pg.evaluate("""async (n) => { const c = document.createElement('canvas'); c.width = c.height = 40;
      const g = c.getContext('2d'); g.fillStyle = `hsl(${n * 97 % 360} 70% 50%)`; g.fillRect(0, 0, 40, 40);
      const url = c.toDataURL('image/jpeg', 0.9); await updateOrder(1, o => { o.fotos = (o.fotos || []).concat([url]); }); }""", n)


tmp, app = preparar_copia()
srv, base = servir(app)
try:
    with sync_playwright() as p:
        b, pg = abrir_navegador(p, 390)
        entrar(pg, base)
        for n in (1, 2): agregar_foto(pg, n)
        pg.evaluate("openOrder(1)"); pg.wait_for_timeout(1000)
        pg.evaluate(SIMULAR_SHARE, "ok")

        pg.click("#btnEnviarProgresoWA"); pg.wait_for_timeout(1500)
        comprobar(pg.locator("#modalProgresoFotos.active").count() == 1, "con fotos abre la ventana de avance")
        comprobar(pg.evaluate(TOTAL) == 2 and pg.evaluate(MARCADAS) == 2, "las 2 fotos nuevas vienen marcadas")
        pg.wait_for_function("() => !document.getElementById('btnProgFotosEnviar').disabled", timeout=10000)
        pg.click("#btnProgFotosEnviar"); pg.wait_for_timeout(800)
        comprobar(pg.evaluate("window.__compartido") == 2, "se compartieron 2 fotos")
        comprobar("Hola" in (pg.evaluate("window.__texto") or ""), "con el texto del avance")
        comprobar(pg.evaluate(ENVIADAS) == 2, "quedaron marcadas como enviadas")
        comprobar(pg.locator("#modalProgresoFotos.active").count() == 0, "la ventana se cierra al compartir")

        agregar_foto(pg, 3)
        pg.evaluate("openOrder(1)"); pg.wait_for_timeout(1000)
        pg.evaluate(SIMULAR_SHARE, "cancela")
        pg.click("#btnEnviarProgresoWA"); pg.wait_for_timeout(1500)
        comprobar(pg.evaluate(TOTAL) == 3 and pg.evaluate(MARCADAS) == 1, "paso 2: de 3 fotos solo viene marcada la nueva")
        comprobar(pg.locator("#progFotosLista", has_text="Ya enviada").count() == 1, "las anteriores dicen «Ya enviada»")
        pg.wait_for_function("() => !document.getElementById('btnProgFotosEnviar').disabled", timeout=10000)
        pg.click("#btnProgFotosEnviar"); pg.wait_for_timeout(800)
        comprobar(pg.evaluate(ENVIADAS) == 2, "si se cancela el menú de compartir, la nueva NO se marca")

        # navegador que no comparte archivos (PC): se descargan y NO se marcan
        pg.evaluate("navigator.canShare = undefined")
        with pg.expect_download() as descarga:
            pg.click("#btnProgFotosEnviar")
        comprobar(descarga.value.suggested_filename.startswith("avance-orden-1-"), "sin menú de compartir: la foto se descarga")
        pg.wait_for_timeout(400)
        comprobar(pg.evaluate(ENVIADAS) == 2, "sin menú de compartir: tampoco se marca como enviada")
        b.close()
finally:
    srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
print(f"{len(fallas)} falla(s)")
sys.exit(1 if fallas else 0)
