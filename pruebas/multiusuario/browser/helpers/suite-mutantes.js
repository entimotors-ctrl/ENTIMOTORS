// MUTANTES EN NAVEGADOR REAL: prueba de que la suite de navegador PUEDE fallar. Este origen sirve el runtime real con SIETE
// reversiones aplicadas EN MEMORIA por el servidor local (nunca en disco): F-SEC-2 (app.js sin esc() en el rol), F-SEC-1
// (usuarios.js: aviso() sin esc()), F-FUNC-1 (auth.js sin conservar sin-conexion/tiempo-agotado), OBS-3 (eliminar cita con exigeGestion),
// OBS-4 (auth.js sin validar la forma del 200), OBS-5 (supabase-client.js con la extraccion anterior) y ROL DESCONOCIDO (portero sin lista blanca).
// Aqui el resultado esperado esta INVERTIDO: cada caso pasa solo si el defecto se DETECTA (el canario se ejecuta o la
// estructura del DOM se rompe / el aviso deja de ser el correcto). Si algun mutante «sobreviviera», la suite normal no protegeria nada.
import { crearBanco, esperarHasta, pausa, ok, igual } from "/__h/helpers/pagina.js";
import { P_ERROR, P_ROL, AVISO_RED, abrirUsuarios, observarToast, juzgarToast, observarAjustesInyectando, juzgarAjustes, sesionLocal, abrirRecuperacion, enviarClave, ESC_RED, eliminarCita, put, resp, json } from "/__h/helpers/suite-app.js";

export async function correr(ctx) {
  const B = crearBanco(ctx); const { caso } = B;
  const opciones = { grupo: "MUTANTE", errorCritico: false };   // un mutante puede provocar errores: no es lo que se mide

  await caso("MUTANTE · el servidor de mutantes SÍ entrega las tres reversiones (control del control)", async () => {
    const u = await (await fetch("/usuarios.js")).text(), a = await (await fetch("/app.js")).text(), t = await (await fetch("/auth.js")).text();
    ok(u.includes('toast(msg, "off")') && !u.includes('toast(esc(msg), "off")'), "usuarios.js no esta revertido");
    ok(a.includes('(${NOMBRE_ROL[currentUser?.rol] || currentUser?.rol || "—"})'), "app.js no esta revertido");
    ok(!t.includes('return mal(r.motivo, r.detalle);'), "auth.js (F-FUNC-1) no esta revertido"); ok(!t.includes('"respuesta-invalida"'), "auth.js (OBS-4) no esta revertido");
    ok(a.includes('exigeGestion("Solo el administrador elimina una cita")'), "app.js (OBS-3) no esta revertido"); ok(!a.includes("!ROLES_DEL_TALLER.includes(session.rol)"), "app.js (rol desconocido) no esta revertido");
    ok((await (await fetch("/supabase-client.js")).text()).includes("(cuerpo.message || cuerpo.error_description || cuerpo.error)"), "supabase-client.js (OBS-5) no esta revertido");
  }, opciones);

  await caso("MUTANTE F-SEC-2 revertido · un rol hostil SÍ inyecta marcado en #ajustesInfo y el canario img/onerror SE EJECUTA (defecto detectado)", async () => {
    const r = {};
    for (const [n, p] of P_ROL.slice(0, 4)) {
      const o = await observarAjustesInyectando(B, p); const f = juzgarAjustes(n, p, o);
      r[n] = { detectado: f.length > 0, canarioEjecutado: o.xss !== 0, hijos: o.hijos }; o.app.cerrar();
      ok(f.length > 0, `${n}: el mutante SOBREVIVE (la suite normal no lo detectaria)`);
    }
    ok(r["img/onerror"].canarioEjecutado, "el canario img/onerror debia ejecutarse en el mutante");
    return { detectadoPorPayload: r };
  }, opciones);

  await caso("MUTANTE F-SEC-1 revertido · el mensaje del servidor SÍ llega como marcado al toast y el canario img/onerror SE EJECUTA (defecto detectado)", async () => {
    const { app, estado } = await abrirUsuarios(B); const r = {};
    for (const [n, p] of P_ERROR) {
      const o = await observarToast(B, app, estado, "baja", p); const f = juzgarToast(n, p, o);
      r[n] = { detectado: f.length > 0, canarioEjecutado: o.xss !== 0 };
      ok(f.length > 0, `${n}: el mutante SOBREVIVE (la suite normal no lo detectaria)`);
    }
    ok(r["img/onerror"].canarioEjecutado, "el canario img/onerror debia ejecutarse en el mutante");
    return { detectadoPorPayload: r };
  }, opciones);

  for (const sc of ESC_RED.filter((s) => s.id === "net-real" || s.id === "to-real")) {
    await caso(`MUTANTE F-FUNC-1 revertido · ${sc.nombre}: el aviso DEJA de ser «Sin conexión…» y se ve el texto crudo del motor (defecto detectado)`, async () => {
      const app = await abrirRecuperacion(B); sc.preparar(B); const e = await enviarClave(B, app);
      ok(e.error !== AVISO_RED, "el mutante SOBREVIVE: el aviso correcto sigue apareciendo");
      return { avisoVisibleEnElMutante: e.error };
    }, opciones);
  }

  await caso("MUTANTE ROL DESCONOCIDO revertido · el portero SIN lista blanca deja entrar a una sesión guardada con rol «superadmin»: se abre el taller (defecto detectado)", async () => {
    const app = await B.abrirApp({ almacen: { enti_session: sesionLocal("superadmin") } }); const est = await B.esperarArranque(app);
    ok(est === "shell", "el mutante SOBREVIVE: el rol desconocido sigue sin entrar"); return { estadoEnElMutante: est, rolVisible: app.$("#loggedUserRole")?.textContent };
  }, opciones);

  await caso("MUTANTE OBS-3 revertido · con exigeGestion() el CAJERO borra la cita (defecto detectado)", async () => {
    const r = await eliminarCita(B, { cuenta: B.M.CUENTAS.cajeroActivo }); ok(r.quedan === 0 && /^Cita eliminada/.test(r.aviso), "el mutante SOBREVIVE: el cajero no pudo borrar"); return { avisoEnElMutante: r.aviso };
  }, opciones);

  await caso("MUTANTE OBS-4 revertido · un HTTP 200 con HTML VUELVE a contar como éxito («Contraseña establecida correctamente») (defecto detectado)", async () => {
    const app = await abrirRecuperacion(B); put(B, resp("<html>portal cautivo</html>", 200)); const e = await enviarClave(B, app);
    ok(/Contraseña establecida correctamente\./.test(e.cuerpo), "el mutante SOBREVIVE: el 200 basura ya no cuenta como exito"); return { pantallaEnElMutante: e.cuerpo.slice(0, 60) };
  }, opciones);

  await caso("MUTANTE OBS-5 revertido · un error con objeto anidado VUELVE a verse como «[object Object]» (defecto detectado)", async () => {
    const app = await abrirRecuperacion(B); put(B, json({ error: { mensaje: "fallo" } }, 500)); const e = await enviarClave(B, app);
    ok(e.error === "[object Object]", `el mutante SOBREVIVE: se ve «${e.error}»`); return { avisoVisibleEnElMutante: e.error };
  }, opciones);
}
