"""Hallazgos de la revisión final (3.16 parte A): botones que no son <button>, cotización aceptada en otro teléfono, franja de mensaje.

  ~/.venvs/playwright/bin/python -I pruebas/ui-telefono/t9_revision.py
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

PARECE_BOTON = """(sel) => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e);
  return { borde: c.borderTopStyle !== 'none' && parseFloat(c.borderTopWidth) > 0, negrita: Number(c.fontWeight) >= 600, alto: e.getBoundingClientRect().height }; }"""

tmp, app = preparar_copia()
srv, base = servir(app)
try:
    with sync_playwright() as p:
        b, pg = abrir_navegador(p, 390)
        entrar(pg, base)

        # 1 · «Tomar o elegir fotos» y los desplegables se ven como botones
        pg.evaluate("openOrder(1)"); pg.wait_for_timeout(900)
        f = pg.evaluate(PARECE_BOTON, "label.btn-fotos")
        comprobar(bool(f) and f["borde"] and f["negrita"], f"«Tomar o elegir fotos» parece un botón ({f})")
        pg.evaluate(SIMULAR)
        pg.evaluate("window.__msgs.push({ id: 9, uid: 'u9', destinatarioId: 'perfil-mec-1', remitenteNombre: 'Wilkin', texto: 'viejo', creadoEn: Date.now() - 50 * 3600e3, leidoEn: Date.now() - 49 * 3600e3 })")
        pg.evaluate("showView('mi-trabajo')"); pg.evaluate("renderMensajesMiTrabajo()"); pg.wait_for_timeout(700)
        s = pg.evaluate(PARECE_BOTON, "#miTrabajoMensajes details > summary")
        comprobar(bool(s) and s["borde"] and s["negrita"], f"«Mensajes anteriores» parece un botón ({s})")
        marca = pg.evaluate("() => { const e = document.querySelector('#miTrabajoMensajes details > summary'); return e ? getComputedStyle(e, '::before').content : null; }")
        comprobar(marca not in (None, "none", "normal", '""'), f"el desplegable muestra su indicador ({marca})")

        # 6 · la franja no tapa las ventanas y se va cuando ya no hay mensajes sin leer
        pg.evaluate("avisarMensajeNuevo()"); pg.wait_for_timeout(400)
        zf = pg.evaluate("Number(getComputedStyle(document.getElementById('avisoMensajeNuevo')).zIndex)")
        zm = pg.evaluate("Number(getComputedStyle(document.getElementById('modalConfirm')).zIndex)")
        comprobar(zf < zm, f"la franja queda debajo de las ventanas (franja {zf}, ventana {zm})")
        pg.evaluate("window.__msgs.forEach(m => { m.leidoEn = Date.now(); })"); pg.evaluate("renderMensajesMiTrabajo()"); pg.wait_for_timeout(500)
        comprobar(not pg.locator("#avisoMensajeNuevo").is_visible(), "sin mensajes sin leer la franja se cierra sola")
        h = pg.evaluate("() => { const t = [...document.querySelectorAll('#view-mi-trabajo h3')].find(x => x.textContent.includes('Historial')); return t ? getComputedStyle(t).display : 'sin titulo'; }")
        comprobar(h != "none", "con historial, el título «Historial de mensajes» se ve")

        # 2 · borrar una cotización que la nube ya aceptó (esta copia no lo sabía): primero se pone al día y no se borra
        pg.evaluate("esMecanicoCuenta = () => false")
        pg.evaluate("document.querySelector(\".nav-item[data-view='cotizaciones']\").click()"); pg.wait_for_timeout(600)
        pg.click("text=+ Nueva cotización"); pg.wait_for_timeout(600)
        pg.fill("#cotNombre", "Cliente Tres"); pg.fill("#cotTelefono", "99998888")
        pg.click("#btnAgregarItemCot"); pg.wait_for_timeout(400)
        pg.select_option("#cotItemTipo", "mano_obra"); pg.fill("#cotItemNombre", "Revisión"); pg.fill("#cotItemPrecio", "200")
        pg.click("#btnGuardarItemCot"); pg.wait_for_timeout(400); pg.click("#btnGuardarCotizacion"); pg.wait_for_timeout(900)
        cid = pg.evaluate("(async () => (await DB.getAll('cotizaciones'))[0].id)()")
        pg.evaluate(f"abrirCotizacionDetalle({cid})"); pg.wait_for_timeout(600)
        # la «puesta al día» trae que otro teléfono ya la aceptó
        # (envuelta en una función que no devuelve nada: si evaluate recibe una función, Playwright la EJECUTA en el acto)
        pg.evaluate(f"() => {{ alDiaParaDecidir = async () => {{ const c = await DB.get('cotizaciones', {cid}); c.estado = 'aceptada'; c.ordenId = 99; await DB.save('cotizaciones', c); }}; }}")
        pg.click("#btnCotEliminar"); pg.wait_for_timeout(800)
        comprobar(pg.locator("#modalConfirm.active").count() == 0, "ya aceptada en la nube: no ofrece borrarla")
        if pg.locator("#modalConfirm.active").count(): pg.click("#btnConfirmAceptar"); pg.wait_for_timeout(600)
        comprobar(pg.evaluate(f"(async () => !!(await DB.get('cotizaciones', {cid})))()"), "la cotización aceptada sigue existiendo")
        b.close()
finally:
    srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
print(f"{len(fallas)} falla(s)")
sys.exit(1 if fallas else 0)
