// 3.15.0 · BLOQUE 4 · APP REAL (Taller + Mi Trabajo de verdad, Chromium y Firefox) contra GoTrue + api-server + PostgREST + Realtime REALES
// de la pila local. Cuentas sintéticas; nada de producción.
//   sin PIN → lo destructivo bloqueado y explicado · configurar PIN en Ajustes (con la contraseña) · el admin revierte caja con el modal del
//   PIN (incorrecto → genérico; correcto → hecho) · sin red no se ejecuta ni se pide el PIN · «Eliminar usuario» con impacto (3 órdenes),
//   confirmación y PIN → sus DOS dispositivos de Mi Trabajo se cierran solos (aviso realtime) · el PIN no queda en localStorage,
//   sessionStorage, IndexedDB, URL ni campos · restaurar un respaldo en modo nube está bloqueado.
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b4-owner-pin-app-real.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { iniciarPila, REST_URL } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { iniciarApi, API_URL } from "./lib/api-local.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
let pila; const RES = {};
before(async () => { pila = await iniciarPila({ gotrue: true, realtime: true, fasesExtra: ["sec-1c-clave-intentos"] }); });
after(async () => { await pila?.detener(); console.log("RENDIMIENTO_B4_UI " + JSON.stringify(RES)); });

const SRV = () => pila.jwt(undefined, { role: "service_role" });
async function gt(ruta, { m = "GET", tok, body, srv } = {}) {
  const r = await fetch(REST_URL + ruta, { method: m, headers: { apikey: "anon-sintetica", Authorization: `Bearer ${srv ? SRV() : tok}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* no JSON */ } return { s: r.status, j };
}
async function cuenta(tag, rol, nombre) {
  const c = { correo: `b4ui-${tag}-${crypto.randomBytes(3).toString("hex")}@example.test`, pass: `frase ${crypto.randomBytes(8).toString("base64url")} larga`, rol, nombre };
  const r = await gt("/auth/v1/admin/users", { m: "POST", srv: true, body: { email: c.correo, password: c.pass, email_confirm: true } }); c.id = r.j.id;
  pila.sql(`set session_replication_role = replica; update public.perfiles set nombre = '${nombre}', rol = '${rol}', activo = true where id = '${c.id}'; reset session_replication_role;`);
  return c;
}
const entrar = async (c) => (await gt("/auth/v1/token?grant_type=password", { m: "POST", body: { email: c.correo, password: c.pass } })).j;

/* Sesión REAL de GoTrue inyectada en la página (sin la UI de login): el token de verdad, el perfil de verdad. */
const sesionEnPagina = (d, c, ses, producto) => d.eval(async (a) => {
  window.__toasts = []; window.toast = (m) => window.__toasts.push(String(m));
  window.__ses = { access_token: a.tok, refresh_token: a.ref };
  window.SupabaseCliente.sesion = () => window.__ses; window.SupabaseCliente.estado = () => ({ activo: true, conSesion: true, usuario: a.correo });
  window.SupabaseCliente.refrescarSesion = async () => ({ ok: true });
  window.Auth.estado = () => ({ activo: true, conSesion: true, origen: "supabase" }); window.Auth.esAdmin = () => a.rol === "admin";
  window.Auth.cerrarSesion = async () => { window.__cerro = true; };
  const mec = a.rol === "mecanico";
  currentUser = { uid: a.id, nombre: a.nombre, rol: a.rol, origen: "supabase", activo: true, perfilId: mec ? a.id : null, user: a.correo };
  await prepararModoNube({ rol: a.rol, origen: "supabase", activo: true, uid: a.id, perfilId: currentUser.perfilId });
  document.getElementById("shell").classList.add("active");
  if (mec) { showView("mi-trabajo"); await renderMiTrabajo(); }
  const h = Date.now() + 15000; while (Date.now() < h && rtEstado !== "conectado") await new Promise((r) => setTimeout(r, 50));
  return rtEstado;
}, { tok: ses.access_token, ref: ses.refresh_token, id: c.id, rol: c.rol, nombre: c.nombre, correo: c.correo }, { plazoMs: 30000 });
/** Escribe el PIN en el modal REAL cuando aparece y confirma. */
const teclearPinCuandoAparezca = (d, pin) => d.eval(async (p) => {
  const inicio = performance.now(); const h = Date.now() + 10000;
  while (Date.now() < h && !document.getElementById("modalPinAutorizar").classList.contains("active")) await new Promise((r) => setTimeout(r, 20));
  if (!document.getElementById("modalPinAutorizar").classList.contains("active")) return { modal: false };
  const msg = document.getElementById("pinAutorizarMsg").textContent; const esperaModalMs = Math.round(performance.now() - inicio);
  document.getElementById("pinAutorizarInput").value = p; document.getElementById("btnPinAutorizarOk").click();
  return { modal: true, msg, esperaModalMs, campoTras: document.getElementById("pinAutorizarInput").value };
}, pin, { plazoMs: 20000 });
/** Todo lo que el navegador guarda (localStorage, sessionStorage, TODAS las bases IndexedDB) + URL, para buscar un secreto. */
const volcado = (d) => d.eval(async () => {
  const out = [location.href, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
  const bases = indexedDB.databases ? await indexedDB.databases() : [{ name: "entimotors_os_demo" }];
  for (const b of bases) {
    await new Promise((ok) => { const r = indexedDB.open(b.name); r.onerror = () => ok(); r.onsuccess = () => { const db = r.result; const st = [...db.objectStoreNames];
      if (!st.length) { db.close(); return ok(); }
      const t = db.transaction(st, "readonly"); let n = st.length; st.forEach((s) => { const g = t.objectStore(s).getAll(); g.onsuccess = () => { out.push(JSON.stringify(g.result)); if (--n === 0) { db.close(); ok(); } }; g.onerror = () => { if (--n === 0) { db.close(); ok(); } }; }); }; });
  }
  out.push(...[...document.querySelectorAll("input")].map((i) => i.value));
  return out.join("\n");
}, null, { plazoMs: 30000 });

for (const nav of NAVS) {
  describe(`3.15 · Bloque 4 · OWNER-PIN + eliminar usuario · app real · ${nav}`, () => {
    let api, adm, mec, A, M1, M2;
    const PIN = "739205";
    before(async () => {
      pila.limpiar(); pila.sql("set session_replication_role = replica; truncate public.admin_pin, public.admin_pin_intentos, public.admin_clave_intentos; reset session_replication_role;");
      adm = await cuenta("adm", "admin", "Dueña UI"); mec = await cuenta("mec", "mecanico", "Mecánico UI");
      pila.sql(`insert into public.ordenes (id, estado, falla, mecanico, mecanico_id) values
        (gen_random_uuid(), 'recibido', 'act 1 ${nav}', 'Mecánico UI', '${mec.id}'), (gen_random_uuid(), 'diagnostico', 'act 2 ${nav}', 'Mecánico UI', '${mec.id}'),
        (gen_random_uuid(), 'reparacion', 'act 3 ${nav}', 'Mecánico UI', '${mec.id}');`);
      A = await abrirDispositivo({ navegador: nav, nombre: `b4-adm-${nav}`, pagina: "index.html", real: true, apiUrl: API_URL });
      M1 = await abrirDispositivo({ navegador: nav, nombre: `b4-m1-${nav}`, pagina: "index.html", real: true, producto: "mecanico", apiUrl: API_URL });
      M2 = await abrirDispositivo({ navegador: nav, nombre: `b4-m2-${nav}`, pagina: "index.html", real: true, producto: "mecanico", apiUrl: API_URL });
      api = await iniciarApi(pila, { origen: A.origen, origenes: [A.origen, M1.origen, M2.origen], entorno: { ENTIMOTORS_MECHANIC_ORIGIN: M1.origen } });
      assert.equal(await sesionEnPagina(A, adm, await entrar(adm)), "conectado");
      assert.equal(await sesionEnPagina(M1, mec, await entrar(mec)), "conectado");
      assert.equal(await sesionEnPagina(M2, mec, await entrar(mec)), "conectado");
      assert.equal(Number(pila.sql(`select count(*) from auth.sessions where user_id = '${mec.id}'`)), 2, "el mecánico con DOS dispositivos");
    });
    after(async () => { await api?.detener(); for (const d of [A, M1, M2]) await d?.cerrar(); });

    const movimiento = (desc) => A.eval(async (dsc) => { const r = await registrarMovimientoCajaNube({ tipo: "egreso", categoria: "Otros", monto: 25, metodoPago: "efectivo", descripcion: dsc }); await syncMotor.pull("caja_movimientos"); return r.estado; }, desc);
    const clicRevertir = (desc) => A.eval(async (dsc) => {
      window.showPrompt = async () => "motivo de prueba";
      showView("finanzas"); document.getElementById("finDesde").value = "2000-01-01"; document.getElementById("finHasta").value = "2100-01-01"; await renderFinanzas();
      const fila = [...document.querySelectorAll("#movimientosBody tr")].find((tr) => tr.textContent.includes(dsc));
      const b = fila && fila.querySelector("[data-revertir-movi]"); if (!b) return false; b.click(); return true;
    }, desc);

    test("sin PIN del propietario: lo destructivo no se hace y la pantalla lo explica; Ajustes dice que falta configurarlo", async () => {
      assert.equal(await movimiento(`sinpin ${nav}`), "ok");
      assert.equal(await clicRevertir(`sinpin ${nav}`), true);
      const t = await teclearPinCuandoAparezca(A, PIN);
      assert.equal(t.modal, true); assert.match(t.msg, /destructiva: escribe el PIN del propietario/); assert.match(t.msg, /Revertir un movimiento de caja/);
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok((await A.eval(() => window.__toasts)).some((x) => /Todavía no hay PIN del propietario/.test(x)));
      assert.equal(pila.sql(`select count(*) from public.caja_movimientos where descripcion like 'Reverso%' or reverso_de is not null`), "0", "nada se revirtió");
      const est = await A.eval(async () => { showView("ajustes"); prepararSeguridad(); await new Promise((r) => setTimeout(r, 1200)); return { card: document.getElementById("cardPinPropietario").style.display, estado: document.getElementById("pinPropEstado").textContent, boton: document.getElementById("btnPinPropGuardar").textContent }; });
      assert.equal(est.card, ""); assert.match(est.estado, /Todavía NO hay PIN/); assert.equal(est.boton, "Configurar PIN");
    });

    test("A/B · configurar el PIN en Ajustes (con la contraseña de la cuenta); los campos quedan vacíos", async () => {
      const r = await A.eval(async (a) => {
        const f = (id, v) => { document.getElementById(id).value = v; };
        f("pinPropClave", a.pass); f("pinPropNuevo", a.pin); f("pinPropConfirmar", a.pin);
        document.getElementById("btnPinPropGuardar").click();
        const h = Date.now() + 15000; while (Date.now() < h && !/configurado|Configurado/.test(document.getElementById("pinPropMsg").textContent + document.getElementById("pinPropEstado").textContent.replace("Todavía NO", ""))) await new Promise((x) => setTimeout(x, 50));
        return { msg: document.getElementById("pinPropMsg").textContent, estado: document.getElementById("pinPropEstado").textContent, campos: ["pinPropClave", "pinPropNuevo", "pinPropConfirmar", "pinPropActual"].map((id) => document.getElementById(id).value) };
      }, { pass: adm.pass, pin: PIN }, { plazoMs: 30000 });
      assert.match(r.estado, /^Configurado/); assert.deepEqual(r.campos, ["", "", "", ""], "ni el PIN ni la contraseña quedan escritos");
      assert.match(pila.sql(`select hash from public.admin_pin where perfil_id = '${adm.id}'`), /^scrypt\$/);
    });

    test("E/F · el ADMIN revierte caja: PIN incorrecto → mensaje genérico; correcto → hecho y auditado con quién autorizó", async () => {
      const t00 = Date.now();
      assert.equal(await movimiento(`conpin ${nav}`), "ok");
      RES[`${nav}:operacion_normal_sin_pin_ms`] = Date.now() - t00;   // movimiento de caja: NORMAL, no pide PIN
      await clicRevertir(`conpin ${nav}`); await teclearPinCuandoAparezca(A, "582047");
      await new Promise((r) => setTimeout(r, 1500));
      const tx = await A.eval(() => window.__toasts.slice(-2));
      assert.ok(tx.some((x) => /^PIN incorrecto\./.test(x)), JSON.stringify(tx)); assert.ok(!tx.some((x) => /d[ií]gito/.test(x)), "no dice qué parte estaba bien");
      await clicRevertir(`conpin ${nav}`);
      const t0 = Date.now();
      const t = await teclearPinCuandoAparezca(A, PIN); assert.equal(t.campoTras, "", "el campo del PIN se vacía al confirmar");
      RES[`${nav}:abrir_modal_pin_ms`] = t.esperaModalMs;   // desde que clicRevertir termina (motivo aceptado) hasta el modal visible
      const h = Date.now() + 10000; let ok = false;
      while (Date.now() < h && !(ok = (await A.eval(() => window.__toasts.some((x) => /Movimiento revertido/.test(x)))))) await new Promise((r) => setTimeout(r, 100));
      RES[`${nav}:revertir_con_pin_ms`] = Date.now() - t0;
      assert.ok(ok, "revertido");
      assert.equal(pila.sql(`select count(*) || '|' || bool_and(autorizado_por = '${adm.id}') from public.reversos where tipo = 'caja'`), "1|true");
    });

    test("M · SIN RED: la acción destructiva no se ejecuta ni se pide el PIN; se explica", async () => {
      assert.equal(await movimiento(`offline ${nav}`), "ok");
      const antes = pila.sql("select count(*) from public.autorizaciones_admin");
      await A.eval(() => { forcedOffline = true; return true; });
      await clicRevertir(`offline ${nav}`);
      await new Promise((r) => setTimeout(r, 1200));
      const r = await A.eval(() => ({ modal: document.getElementById("modalPinAutorizar").classList.contains("active"), t: window.__toasts.slice(-1)[0] }));
      await A.eval(() => { forcedOffline = false; return true; });
      assert.equal(r.modal, false); assert.match(r.t, /conexión/i);
      assert.equal(pila.sql("select count(*) from public.autorizaciones_admin"), antes, "ni se pidió autorización");
    });

    test("O/Z/T/Y · «Eliminar usuario»: impacto (3 órdenes activas) → confirmar → PIN → sus DOS Mi Trabajo se cierran solos", async () => {
      const r = await A.eval(async (id) => {
        showView("usuarios"); await window.PantallaUsuarios.render();
        const b = [...document.querySelectorAll(".u-eliminar")].find((x) => x.dataset.id === id); if (!b) return { boton: false };
        b.click();
        const h = Date.now() + 10000; while (Date.now() < h && !document.getElementById("modalConfirm").classList.contains("active")) await new Promise((x) => setTimeout(x, 20));
        const texto = document.getElementById("confirmMensaje").textContent, ok = document.getElementById("btnConfirmAceptar").textContent;
        document.getElementById("btnConfirmAceptar").click();
        return { boton: true, texto, ok, textoBaja: document.body.innerHTML.includes("Dar de baja") };
      }, mec.id);
      assert.equal(r.boton, true); assert.equal(r.textoBaja, false, "ya no existe «Dar de baja»");
      assert.match(r.texto, /perderá el acceso/); assert.match(r.texto, /3 orden\(es\) abierta\(s\)/); assert.match(r.texto, /NO se borra/); assert.equal(r.ok, "Desasignar 3 y eliminar");
      const t0 = Date.now();
      const p = await teclearPinCuandoAparezca(A, PIN); assert.equal(p.modal, true); assert.match(p.msg, /Eliminar un usuario/);
      let hecho = false; const h = Date.now() + 15000;
      while (Date.now() < h && !(hecho = await A.eval(() => window.__toasts.some((x) => /ya no puede entrar/.test(x))))) await new Promise((x) => setTimeout(x, 100));
      RES[`${nav}:eliminar_desde_ui_ms`] = Date.now() - t0;
      assert.ok(hecho, JSON.stringify(await A.eval(() => window.__toasts)));
      for (const [n, d] of [["M1", M1], ["M2", M2]]) {
        const fuera = await d.eval(async () => { const h = Date.now() + 10000; while (Date.now() < h && !document.getElementById("gateLogin").classList.contains("active")) await new Promise((x) => setTimeout(x, 50));
          return { login: document.getElementById("gateLogin").classList.contains("active"), msg: document.getElementById("loginError").textContent, rt: typeof syncRt === "undefined" ? "x" : syncRt, shell: document.getElementById("shell").classList.contains("active"), cola: syncBd ? (await syncBd.outbox.todos()).length : -1 }; }, null, { plazoMs: 20000 });
        RES[`${nav}:revocado_${n}_ms`] = Date.now() - t0;
        assert.equal(fuera.login, true, `${n}: vuelve al login`); assert.match(fuera.msg, /eliminada o desactivada/); assert.equal(fuera.rt, null, `${n}: realtime detenido`); assert.equal(fuera.shell, false);
      }
      assert.equal(pila.sql(`select count(*) from auth.sessions where user_id = '${mec.id}'`), "0");
      assert.equal(pila.sql(`select count(*) from public.ordenes where mecanico_id is null and falla like 'act % ${nav}'`), "3", "trabajo activo «sin asignar», no pasado a otra persona");
      const lista = await A.eval(async () => { await window.PantallaUsuarios.render(); return document.getElementById("usuariosCuerpo").textContent; });
      assert.match(lista, /Usuario eliminado/);
    });

    test("N · el PIN y la contraseña no quedan en ningún almacenamiento, URL ni campo (admin y mecánico)", async () => {
      for (const d of [A, M1]) { const v = await volcado(d); assert.ok(!v.includes(PIN), `${d.nombre}: PIN encontrado`); assert.ok(!v.includes(adm.pass), `${d.nombre}: contraseña encontrada`); }
    });

    test("restaurar un respaldo del teléfono en modo nube: bloqueado y explicado (no se abre la confirmación)", async () => {
      const r = await A.eval(async () => {
        const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify({ data: { clientes: [{ id: 1, nombre: "viejo" }] }, exportadoEn: "2026-01-01T00:00:00Z" })], "respaldo.json", { type: "application/json" }));
        const inp = document.getElementById("inputRestaurar"); inp.files = dt.files; inp.dispatchEvent(new Event("change"));
        await new Promise((x) => setTimeout(x, 500));
        return { modal: document.getElementById("modalRestaurar").classList.contains("active"), t: window.__toasts.slice(-1)[0] };
      });
      assert.equal(r.modal, false); assert.match(r.t, /no se restaura un respaldo del teléfono/);
      assert.equal(pila.sql(`select count(*) from public.clientes where nombre = 'viejo'`), "0");
    });

    // OWNER_PIN_POLICY: eliminar una orden SIN dinero es operación del admin con su sesión (anular_orden modo «eliminar» no pide
    // autorización en el servidor): la UI no debe abrir el modal del PIN ahí (no poner PIN a lo normal).
    test("eliminar una orden SIN cobrar (admin): sin modal de PIN; queda eliminada (suave) en la nube", async () => {
      const uid = pila.sql(`insert into public.ordenes (id, estado, falla) values (gen_random_uuid(), 'recibido', 'sin cobrar ${nav}') returning id`).trim();
      const r = await A.eval(async (u) => {
        window.__toasts = []; window.showPrompt = async () => "orden duplicada";
        await syncMotor.pull("ordenes");
        const o = (await DB.getAll("ordenes")).find((x) => x.uid === u); if (!o) return { local: false };
        let pinVisto = false; const vigia = setInterval(() => { if (document.getElementById("modalPinAutorizar").classList.contains("active")) pinVisto = true; }, 20);
        await anularOrdenNube(o.id); clearInterval(vigia);
        return { local: true, pinVisto, t: window.__toasts.slice() };
      }, uid, { plazoMs: 30000 });
      assert.equal(r.local, true, "la orden bajó a la caché");
      assert.equal(r.pinVisto, false, "no se pidió el PIN");
      assert.ok(r.t.some((x) => /Orden eliminada/.test(x)), JSON.stringify(r.t));
      assert.equal(pila.sql(`select deleted_at is not null from public.ordenes where id = '${uid}'`), "t");
    });
  });
}
