"""Cambio 8 · «＋ Entrada»: sumar mercancía a un repuesto que ya existe sin pedir motivo (copia SIN NUBE, teléfono de 390 px).

El modo nube se prueba simulando finanzasNube y accionAutorizada: aquí se prueba qué manda la pantalla, no el servidor.
  ~/.venvs/playwright/bin/python -I pruebas/ui-telefono/t10_entrada.py
"""
import os, sys, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revisar import preparar_copia, servir, entrar, abrir_navegador, MINIMO
from playwright.sync_api import sync_playwright

fallas = []
def comprobar(cond, texto):
    print(("OK   " if cond else "FALLA ") + texto)
    if not cond: fallas.append(texto)

ACEITE = "Aceite 20W-50 (litro)"
LEER = """async (n) => (await DB.getAll('inventario')).find((r) => r.nombre === n) || null"""

def abrir_inventario(pg):
    pg.evaluate("document.querySelector(\".nav-item[data-view='inventario']\").click()"); pg.wait_for_timeout(900)

def alto(pg, sel):
    caja = pg.locator(sel).first.bounding_box()
    return caja["height"] if caja else 0

def prompt_abierto(pg):
    return pg.locator("#modalPrompt.active").count() > 0

tmp, app = preparar_copia()
srv, base = servir(app)
try:
    with sync_playwright() as p:
        b, pg = abrir_navegador(p, 390)
        entrar(pg, base)
        abrir_inventario(pg)
        r = pg.evaluate(LEER, ACEITE)
        comprobar(r is not None and r["cantidad"] == 30, "los datos de ejemplo traen el aceite con 30")
        antes = len(pg.evaluate("async () => DB.getAll('inventario')"))

        # 1 · desde la tarjeta del teléfono, sin abrir el detalle
        fila = pg.locator(f'#inventarioBody tr[data-id="{r["id"]}"] .btn-entrada')
        comprobar(fila.count() == 1 and alto(pg, f'#inventarioBody tr[data-id="{r["id"]}"] .btn-entrada') >= MINIMO, "la tarjeta trae «＋ Entrada» grande")
        if fila.count(): fila.click(); pg.wait_for_timeout(500)
        comprobar(pg.locator("#modalEntrada.active").count() == 1, "«＋ Entrada» abre su ventana")
        comprobar(pg.locator("#modalRepuestoDetalle.active").count() == 0, "tocar «＋ Entrada» no abre el detalle")
        comprobar("30" in pg.inner_text("#entradaResultado") and "31" in pg.inner_text("#entradaResultado"), "muestra «Hay 30 → quedarán 31»")
        comprobar(alto(pg, "#btnEntradaMas") >= MINIMO and alto(pg, "#btnEntradaMenos") >= MINIMO, "los botones − / + miden al menos 44 px")
        pg.click("#btnEntradaMas"); pg.wait_for_timeout(150)
        comprobar("32" in pg.inner_text("#entradaResultado"), "con + queda «→ 32»")
        comprobar(pg.input_value("#entradaCosto") == "110", "el costo viene lleno con el actual")
        pg.fill("#entradaCosto", "120"); pg.fill("#entradaNota", "Factura 55")
        pg.click("#btnGuardarEntrada"); pg.wait_for_timeout(900)
        comprobar(not prompt_abierto(pg), "no pide motivo")
        r2 = pg.evaluate(LEER, ACEITE)
        comprobar(r2["cantidad"] == 32 and r2["costoCompra"] == 120, f"quedan 32 con costo 120 ({r2['cantidad']}, {r2['costoCompra']})")
        aud = pg.evaluate("async () => (await DB.getAll('auditoria')).filter((a) => a.accion === 'entrada_stock')")
        comprobar(len(aud) == 1 and "Factura 55" in aud[0]["detalle"] and "30" in aud[0]["detalle"] and "32" in aud[0]["detalle"], "la auditoría guarda la entrada como «entrada_stock» con la nota")
        comprobar(pg.locator("#modalEntrada.active").count() == 0, "la ventana se cierra al registrar")

        # 2 · cantidad inválida: no guarda y lo dice a la vista
        pg.locator(f'#inventarioBody tr[data-id="{r["id"]}"] .btn-entrada').click(); pg.wait_for_timeout(400)
        pg.fill("#entradaCantidad", "0"); pg.click("#btnGuardarEntrada"); pg.wait_for_timeout(500)
        comprobar(pg.evaluate(LEER, ACEITE)["cantidad"] == 32, "con 0 no cambia el stock")
        comprobar(pg.locator("#modalEntrada.active").count() == 1 and pg.inner_text("#entradaError").strip() != "", "con 0 avisa dentro de la ventana")
        pg.click("#btnCancelarEntrada"); pg.wait_for_timeout(300)

        # 3 · desde el detalle también
        pg.evaluate(f"openRepuestoDetalle({r['id']})"); pg.wait_for_timeout(400)
        comprobar(pg.locator("#btnEntradaStock").is_visible() and alto(pg, "#btnEntradaStock") >= MINIMO, "el detalle trae «＋ Entrada»")
        pg.click("#btnEntradaStock"); pg.wait_for_timeout(400)
        comprobar(pg.locator("#modalEntrada.active").count() == 1 and pg.locator("#modalRepuestoDetalle.active").count() == 0, "desde el detalle abre la entrada")
        pg.click("#btnCancelarEntrada"); pg.wait_for_timeout(300)

        # 4 · nuevo repuesto que ya existe: ofrece sumar y no crea un duplicado
        pg.click("#btnNuevoRepuesto"); pg.wait_for_timeout(400)
        pg.fill("#repuestoNombre", "  aceite 20w-50   (litro) "); pg.fill("#repuestoModelo", "todos"); pg.fill("#repuestoCantidad", "5"); pg.fill("#repuestoPrecio", "180")
        pg.click("#btnGuardarRepuesto"); pg.wait_for_timeout(500)
        comprobar(pg.locator("#modalConfirm.active").count() == 1 and "32" in pg.inner_text("#confirmMensaje"), "avisa que ya existe y cuántos hay")
        if pg.locator("#modalConfirm.active").count(): pg.click("#modalConfirm.active #btnConfirmAceptar"); pg.wait_for_timeout(500)
        comprobar(pg.locator("#modalEntrada.active").count() == 1 and pg.input_value("#entradaCantidad") == "5", "lleva a la entrada con la cantidad escrita")
        comprobar(len(pg.evaluate("async () => DB.getAll('inventario')")) == antes, "no se creó un duplicado")
        pg.click("#btnCancelarEntrada"); pg.wait_for_timeout(300)

        # 5 · modo nube simulado: viaja como ajuste con motivo automático, sin pedirlo; la cantidad en Editar no se escribe
        pg.evaluate("""() => { window.__acciones = [];
          window.finanzasNube = () => true;
          window.accionAutorizada = async (fn, datos) => { window.__acciones.push(datos); return true; }; }""")
        pg.locator(f'#inventarioBody tr[data-id="{r["id"]}"] .btn-entrada').click(); pg.wait_for_timeout(400)
        pg.click("#btnEntradaMas"); pg.click("#btnGuardarEntrada"); pg.wait_for_timeout(900)
        acc = pg.evaluate("window.__acciones")
        comprobar(not prompt_abierto(pg), "nube: no pide motivo")
        comprobar(len(acc) == 1 and acc[0].get("delta") == 2 and acc[0].get("motivo", "").startswith("Entrada de mercancía") and "conteo" not in acc[0],
                  f"nube: manda delta +2 con motivo automático ({acc})")
        pg.evaluate(f"openRepuestoDetalle({r['id']})"); pg.wait_for_timeout(400)
        pg.click("#btnEditarRepuesto"); pg.wait_for_timeout(400)
        comprobar(pg.evaluate("document.getElementById('repuestoCantidad').readOnly"), "nube: en Editar la cantidad no se escribe")
        comprobar(pg.locator("#repuestoCantidadNota").is_visible() and "Entrada" in pg.inner_text("#repuestoCantidadNota"), "nube: Editar explica cómo sumar")
        pg.click("#btnCancelarRepuesto"); pg.wait_for_timeout(300)
        pg.click("#btnNuevoRepuesto"); pg.wait_for_timeout(300)
        comprobar(not pg.evaluate("document.getElementById('repuestoCantidad').readOnly") and not pg.locator("#repuestoCantidadNota").is_visible(), "nube: al crear uno nuevo la cantidad sí se escribe")
        b.close()
finally:
    srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
print(f"{len(fallas)} falla(s)")
sys.exit(1 if fallas else 0)
