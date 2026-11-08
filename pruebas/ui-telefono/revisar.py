"""Revisión del Taller en tamaño de teléfono, sobre una copia SIN NUBE de taller-demo/.

Nunca habla con Supabase ni con el backend: copia la app a un directorio temporal, apaga la nube en
supabase-config.js, entra con una cuenta local y carga «Ver un ejemplo». Por cada pantalla dice:
  · chicos: lo que se toca y mide menos de 44 px (alto o ancho) con puntero táctil
  · fuera: lo que se toca y queda fuera de la pantalla a lo ancho
  · tablasCortadas: tablas más anchas que su caja (hay que deslizarlas para ver todo)
Sale con código 1 si alguna pantalla tiene algo en esas listas.

  ~/.venvs/playwright/bin/python -I pruebas/ui-telefono/revisar.py [--ancho 360] [--salida DIR]
"""
import argparse, functools, http.server, json, os, shutil, socketserver, sys, tempfile, threading
from playwright.sync_api import sync_playwright

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
VISTAS = ["dashboard", "pos", "ordenes", "cotizaciones", "citas", "clientes", "inventario", "finanzas", "creditos", "ajustes"]
ORDENES = [1, 2, 3]
MINIMO = 44

MEDIR = """([nombre, minimo]) => {
  const visible = (e) => { const r = e.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const raiz = document.querySelector('.modal.active') || document.querySelector('.view.active') || document.body;
  const W = document.documentElement.clientWidth;
  const res = { vista: nombre, chicos: [], fuera: [], tablasCortadas: [] };
  const sel = 'button, a[href], select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), [role=button]';
  raiz.querySelectorAll(sel).forEach((e) => {
    if (!visible(e)) return;
    const r = e.getBoundingClientRect();
    const t = (e.getAttribute('aria-label') || e.title || e.textContent || e.id || e.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40);
    if (r.right > W + 1 || r.left < -1) res.fuera.push(t + (e.closest('.table-scroll') ? ' (dentro de tabla desplazable)' : ''));
    else if (r.height < minimo || r.width < minimo) res.chicos.push(`${t} ${Math.round(r.width)}x${Math.round(r.height)}`);
  });
  raiz.querySelectorAll('.table-scroll, table').forEach((s) => {
    if (visible(s) && s.scrollWidth > s.clientWidth + 2) res.tablasCortadas.push(`${s.id || s.querySelector('table')?.id || 'tabla'} ${s.scrollWidth}>${s.clientWidth}`);
  });
  for (const k of ['chicos', 'fuera', 'tablasCortadas']) res[k] = [...new Set(res[k])];
  return res;
}"""


def preparar_copia(con_codigo_admin=True):
    """con_codigo_admin=False reproduce producción: allí config-local.js no existe y no hay adminCode."""
    destino = tempfile.mkdtemp(prefix="entimotors-telefono-")
    app = os.path.join(destino, "app")
    shutil.copytree(os.path.join(RAIZ, "taller-demo"), app, ignore=shutil.ignore_patterns("supabase", "build-mecanicos", "config-local.js"))
    with open(os.path.join(app, "supabase-config.js"), "w") as f:
        f.write('window.ENTIMOTORS_SUPABASE = { url: "http://127.0.0.1:9", anonKey: "x", habilitado: false, apiUrl: "" };\n')
    with open(os.path.join(app, "config-local.js"), "w") as f:
        codigo = ', adminCode: "0000"' if con_codigo_admin else ""
        f.write('window.ENTIMOTORS_LOCAL = { teamPasswords: { wilkin: "prueba123" }' + codigo + ' };\n')
    return destino, app


def servir(carpeta):
    class Silencioso(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    manejador = functools.partial(Silencioso, directory=carpeta)
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), manejador)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def entrar(pg, base):
    """Pasa la pantalla de instalar, entra con la cuenta local y carga los datos de ejemplo."""
    pg.goto(base + "/index.html")
    pg.wait_for_timeout(1500)
    for _ in range(6):
        if pg.locator("#devBypassLink").is_visible(): pg.click("#devBypassLink")
        elif pg.locator("#loginUser").is_visible():
            pg.fill("#loginUser", "wilkin"); pg.fill("#loginPass", "prueba123"); pg.press("#loginPass", "Enter")
        elif pg.locator("#btnModoDemo").is_visible(): pg.click("#btnModoDemo")
        else: break
        pg.wait_for_timeout(1800)


def abrir_navegador(p, ancho, alto=800):
    b = p.chromium.launch(channel="chrome", headless=True)
    ctx = b.new_context(viewport={"width": ancho, "height": alto}, has_touch=True, is_mobile=True)
    return b, ctx.new_page()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ancho", type=int, default=360)
    ap.add_argument("--salida", default=None, help="carpeta para una captura por pantalla")
    a = ap.parse_args()
    tmp, app = preparar_copia()
    srv, base = servir(app)
    fallas, errores = 0, []
    try:
        with sync_playwright() as p:
            b, pg = abrir_navegador(p, a.ancho)
            pg.on("pageerror", lambda e: errores.append(str(e)))
            entrar(pg, base)
            pantallas = [(v, f"document.querySelector(\".nav-item[data-view='{v}']\")?.click()") for v in VISTAS]
            pantallas += [(f"orden{n}", f"openOrder({n})") for n in ORDENES]
            for nombre, js in pantallas:
                pg.evaluate(js); pg.wait_for_timeout(900)
                r = pg.evaluate(MEDIR, [nombre, MINIMO])
                if r["chicos"] or r["fuera"] or r["tablasCortadas"]: fallas += 1
                print(json.dumps(r, ensure_ascii=False))
                if a.salida:
                    os.makedirs(a.salida, exist_ok=True)
                    pg.screenshot(path=os.path.join(a.salida, f"{nombre}-{a.ancho}.png"), full_page=True)
            b.close()
    finally:
        srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
    if errores: print("ERRORES DE PÁGINA:", json.dumps(errores[:5], ensure_ascii=False))
    print(f"pantallas con problemas: {fallas}")
    sys.exit(1 if fallas or errores else 0)


if __name__ == "__main__":
    main()
