"""Tarea 7 · Usuarios y equipo en el teléfono: el eliminado sale de la lista, errores visibles, PIN comprobado antes y rol con confirmación.

El servidor de cuentas se SIMULA con page.route (nunca se llama al backend real) y PinUI.autorizarAccion devuelve una autorización
de prueba: aquí se prueba la pantalla, no el PIN (eso ya lo prueban pin-ui.test.mjs y b4-owner-pin-app-real).
  ~/.venvs/playwright/bin/python -I pruebas/ui-telefono/t7_usuarios.py
"""
import json, os, sys, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revisar import preparar_copia, servir, entrar, abrir_navegador, MINIMO
from playwright.sync_api import sync_playwright

fallas = []
def comprobar(cond, texto):
    print(("OK   " if cond else "FALLA ") + texto)
    if not cond: fallas.append(texto)

DUENO, MEC1, MEC2 = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"
XSS = '<img src=x onerror="window.__xss=1">'

class Servidor:
    def __init__(self):
        self.usuarios = [
            {"id": DUENO, "nombre": "Wilkin", "correo": "dueno@ejemplo.hn", "telefono": "9704-0000", "rol": "admin", "activo": True, "esUsted": True},
            {"id": MEC1, "nombre": "Mecánico 1", "correo": "m1@ejemplo.hn", "telefono": "9988-1111", "rol": "mecanico", "activo": True},
            {"id": MEC2, "nombre": "Mecánico 2 " + XSS, "correo": "m2@ejemplo.hn", "telefono": "", "rol": "mecanico", "activo": True, "eliminado": True},
        ]
        self.pin_configurado, self.eliminar_responde, self.llamadas = True, 200, []

    def atender(self, route):
        req, url = route.request, route.request.url
        self.llamadas.append(f"{req.method} {url.split('/api/admin')[1]}")
        if url.endswith("/api/admin/pin/estado"):
            return route.fulfill(json={"configurado": self.pin_configurado, "bloqueado": False})
        if url.endswith("/api/admin/usuarios") and req.method == "GET":
            return route.fulfill(json={"usuarios": self.usuarios})
        if url.endswith("/impacto"):
            return route.fulfill(json={"impacto": {"ordenes_activas": [], "citas_abiertas": [], "historial": {"ordenes": 4, "ventas": 0, "caja": 0, "mensajes": 2}}})
        if url.endswith("/eliminar"):
            if self.eliminar_responde != 200:
                return route.fulfill(status=403, json={"error": "no", "codigo": "AUTORIZACION_INVALIDA"})
            uid = url.split("/usuarios/")[1].split("/")[0]
            for u in self.usuarios:
                if u["id"] == uid: u["eliminado"] = True
            return route.fulfill(json={"ok": True, "eliminado": True, "sesiones_revocadas": 1, "ordenes_desasignadas": [], "citas_desasignadas": []})
        if req.method == "PATCH":
            return route.fulfill(json={"usuario": {}})
        return route.fulfill(status=404, json={"error": "no simulado"})

PREPARAR = """() => {
  window.ENTIMOTORS_SUPABASE.apiUrl = location.origin + '/simulado';
  Auth.esAdmin = () => true; const e = Auth.estado; Auth.estado = () => ({ ...e(), conSesion: true });
  window.SupabaseCliente = window.SupabaseCliente || {}; SupabaseCliente.sesion = () => ({ access_token: 'token-de-prueba' });
  window.__pinPedido = 0;
  PinUI.autorizarAccion = async () => { window.__pinPedido++; return { ok: true, autorizacion_id: '44444444-4444-4444-8444-444444444444' }; };
}"""

def abrir_usuarios(pg):
    pg.evaluate("document.querySelector(\".nav-item[data-view='usuarios']\").click()"); pg.wait_for_timeout(1200)

def eliminar_mec1(pg):
    pg.locator(f'.u-eliminar[data-id="{MEC1}"]').click(); pg.wait_for_timeout(700)
    if pg.locator("#modalConfirm.active").count(): pg.click("#btnConfirmAceptar"); pg.wait_for_timeout(1200)

def fila_principal(pg, nombre):
    return pg.evaluate("""(n) => [...document.querySelectorAll('#usuariosCuerpo .lista-equipo tr, #usuariosCuerpo .lista-equipo .u-tarjeta')]
      .some((f) => f.textContent.includes(n))""", nombre)

tmp, app = preparar_copia()
srv, base = servir(app)
try:
    with sync_playwright() as p:
        b, pg = abrir_navegador(p, 390)
        entrar(pg, base)
        s = Servidor()
        pg.route("**/simulado/**", s.atender)
        pg.evaluate(PREPARAR)
        abrir_usuarios(pg)

        comprobar(pg.evaluate("window.__xss") is None, "el nombre con marcado no se ejecuta")
        comprobar(not fila_principal(pg, "Mecánico 2"), "el eliminado no está en la lista principal")
        comprobar(pg.locator("#usuariosCuerpo details", has_text="Ver eliminados (1)").count() == 1, "está en «Ver eliminados (1)»")
        r = pg.locator(f'.u-eliminar[data-id="{MEC1}"]').bounding_box()
        comprobar(bool(r) and r["x"] >= 0 and r["x"] + r["width"] <= 390 and r["height"] >= MINIMO, "«Eliminar usuario» se ve completo y mide 44 px")

        # rol: cancelar la confirmación no guarda nada
        antes = len([l for l in s.llamadas if l.startswith("PATCH")])
        pg.select_option(f'.u-rol[data-id="{MEC1}"]', "cajero"); pg.wait_for_timeout(500)
        comprobar(pg.locator("#modalConfirm.active", has_text="Mecánico 1").count() == 1, "cambiar el rol pide confirmación")
        pg.click("#btnConfirmCancelar"); pg.wait_for_timeout(500)
        comprobar(len([l for l in s.llamadas if l.startswith("PATCH")]) == antes, "cancelado: no se envía el cambio de rol")
        comprobar(pg.locator(f'.u-rol[data-id="{MEC1}"]').input_value() == "mecanico", "cancelado: el selector vuelve a Mecánico")

        # sin PIN configurado: no se pide el PIN y se explica qué hacer
        s.pin_configurado = False
        eliminar_mec1(pg)
        aviso = pg.locator("#usuariosAvisoFijo")
        comprobar(pg.evaluate("window.__pinPedido") == 0, "sin PIN configurado no se pide el PIN")
        comprobar(aviso.is_visible() and "Primero configura el PIN del propietario en Ajustes." in aviso.inner_text(), "explica que falta configurar el PIN")
        comprobar(pg.locator("#usuariosAvisoFijo button", has_text="Ir a Ajustes").count() == 1, "con botón «Ir a Ajustes»")

        # el servidor rechaza: el motivo queda a la vista
        s.pin_configurado, s.eliminar_responde = True, 403
        eliminar_mec1(pg); pg.wait_for_timeout(5000)
        comprobar(aviso.is_visible() and "La autorización con PIN no es válida o caducó" in aviso.inner_text(), "rechazo: el motivo sigue visible a los 5 s")

        # eliminado bien: desaparece de la lista principal y queda la confirmación
        s.eliminar_responde = 200
        eliminar_mec1(pg); pg.wait_for_timeout(1500)
        comprobar(not fila_principal(pg, "Mecánico 1"), "Mecánico 1 ya no está en la lista principal")
        comprobar(pg.locator("#usuariosCuerpo details", has_text="Ver eliminados (2)").count() == 1, "ahora hay 2 en «Ver eliminados»")
        comprobar("Mecánico 1 eliminado" in aviso.inner_text() and "su historial se conserva" in aviso.inner_text(), "confirmación fija de que se eliminó")
        if os.environ.get("CAPTURA"): pg.locator("#view-usuarios").screenshot(path=os.environ["CAPTURA"])
        b.close()
finally:
    srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
print(f"{len(fallas)} falla(s)")
sys.exit(1 if fallas else 0)
