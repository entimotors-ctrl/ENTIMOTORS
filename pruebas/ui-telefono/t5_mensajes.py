"""Tarea 5 · Mi Trabajo: mensajes del administrador fijos 36 h y aviso de mensaje nuevo que no se va solo (copia SIN NUBE, 390 px).

Simula una cuenta de mecánico de la nube (esMecanicoCuenta, currentUser.perfilId) y su caché de mensajes (syncBd): no hay servidor.
  ~/.venvs/playwright/bin/python -I pruebas/ui-telefono/t5_mensajes.py
"""
import os, sys, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revisar import preparar_copia, servir, entrar, abrir_navegador
from playwright.sync_api import sync_playwright

fallas = []
def comprobar(cond, texto):
    print(("OK   " if cond else "FALLA ") + texto)
    if not cond: fallas.append(texto)

SIMULAR = """() => {
  const H = 3600e3, ahora = Date.now(), yo = 'perfil-mec-1';
  const msg = (id, horas, leido, texto) => ({ id, uid: 'u' + id, destinatarioId: yo, remitenteNombre: 'Wilkin', texto,
    creadoEn: ahora - horas * H, leidoEn: leido ? ahora - horas * H + 60e3 : null });
  window.__msgs = [msg(1, 2, true, 'Revisa la moto de Carlos'), msg(2, 40, true, 'Mensaje viejo ya leído'),
    msg(3, 80, false, 'Mensaje viejo SIN leer'), msg(4, 30, false, '<img src=x onerror="window.__xss=1"> traer pastillas')];
  esMecanicoCuenta = () => true;
  currentUser.perfilId = yo;
  syncBd = { datos: { todos: async () => window.__msgs.slice(), get: async () => null }, outbox: { todos: async () => [] },
    mapa: { localDe: async () => null }, deviceId: async () => 'dev' };
}"""

tmp, app = preparar_copia()
srv, base = servir(app)
try:
    with sync_playwright() as p:
        b, pg = abrir_navegador(p, 390)
        entrar(pg, base)
        pg.evaluate(SIMULAR)
        pg.evaluate("showView('mi-trabajo')"); pg.evaluate("renderMensajesMiTrabajo()"); pg.wait_for_timeout(800)
        fijos = pg.locator("#miTrabajoMensajesFijos .mensaje-fijo")
        textos = fijos.all_inner_texts()
        comprobar(fijos.count() == 3, f"3 mensajes fijos arriba (hay {fijos.count()})")
        comprobar(any("Revisa la moto" in t for t in textos) and any("SIN leer" in t for t in textos), "fijos: el reciente y el viejo sin leer")
        comprobar(not any("ya leído" in t for t in textos), "el leído de hace 40 h no está fijo")
        orden = pg.evaluate("""() => { const f = document.getElementById('miTrabajoMensajesFijos'), a = document.getElementById('miTrabajoAlcance');
          return !!f && !!a && (f.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) > 0; }""")
        comprobar(orden, "los fijos van antes del texto de bienvenida")
        hist = pg.locator("#miTrabajoMensajes details")
        comprobar(hist.count() == 1 and "Mensajes anteriores (1)" in hist.inner_text(), "el viejo leído queda en «Mensajes anteriores (1)»")
        comprobar(pg.evaluate("window.__xss") is None, "el texto con marcado no se ejecuta")

        # aviso de mensaje nuevo: muestra el texto y no se cierra solo
        pg.evaluate("avisarMensajeNuevo()"); pg.wait_for_timeout(5000)
        aviso = pg.locator("#avisoMensajeNuevo")
        comprobar(aviso.is_visible(), "el aviso de mensaje nuevo sigue visible a los 5 s")
        comprobar("traer pastillas" in aviso.inner_text(), "el aviso muestra el texto del último sin leer")
        pg.click("#avisoMensajeNuevo [data-cerrar-aviso]"); pg.wait_for_timeout(300)
        comprobar(not aviso.is_visible(), "se cierra al tocar «Cerrar»")
        b.close()
finally:
    srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
print(f"{len(fallas)} falla(s)")
sys.exit(1 if fallas else 0)
