// 3.15.0 · BLOQUE 3 · APP REAL (index.html + app.js de verdad, Taller y «Mi Trabajo») contra Postgres + PostgREST + SUPABASE REALTIME
// reales (contenedor v2.106.0 de esta pila). La verdad se comprueba en la NUBE (SQL) y en lo que ve la pantalla.
//   E admin asigna → mecánico · F otro mecánico no lo recibe · G reasignación A→B · H dos dispositivos · I aviso duplicado ·
//   J fuera de orden · K reconexión · L sesión caducada · M cambio de usuario · N mensaje admin→mecánico · O leído · P aislamiento ·
//   Q mensaje con orden · R mensaje offline/reconexión (y respuesta perdida) · Z Mi Trabajo reabierto recibe lo que pasó cerrado.
//   Latencias medidas (admin → pantalla del mecánico) en ms.
//   SYNC_NAVEGADORES=chromium node --test --test-concurrency=1 pruebas/sync/browser/b3-realtime-app-real.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const OBJETIVO_MS = 2000;
let pila;
before(async () => { pila = await iniciarPila({ realtime: true }); });
after(async () => { await pila?.detener(); });

const uno = (q) => pila.sql(q);
const nube = (q) => JSON.parse(pila.sql(`select coalesce(json_agg(t), '[]') from (${q}) t`));
export const LATENCIAS = {};
const mediana = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

let n = 0;
async function abrir(nav, rol, o = {}) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b3-${rol}-${nav}-${++n}`, pagina: "index.html", real: true, producto: o.producto || null });
  await entrar(d, rol, o);
  return d;
}
/* Sesión de nube simulada (como sync8-app-real): sin login UI ni GoTrue. Toasts capturados; corte de red por fetch (window.__sinRed). */
function entrar(d, rol, o = {}) {
  return d.eval(async (a) => {
    window.__toasts = window.__toasts || [];
    window.toast = function (m) { window.__toasts.push(String(m)); };
    if (!window.__fetchReal) {
      window.__fetchReal = window.fetch.bind(window);
      window.__rpcVistas = [];
      window.fetch = function (url, init) {
        const u = String(url && url.url ? url.url : url);
        const nube = u.indexOf(window.ENTIMOTORS_SUPABASE.url) === 0;
        if (nube) window.__rpcVistas.push(u.slice(window.ENTIMOTORS_SUPABASE.url.length));
        if (nube && window.__sinRed) return Promise.reject(new TypeError("Failed to fetch"));
        if (nube && window.__perderRespuestaDe && u.indexOf("/rpc/" + window.__perderRespuestaDe) > 0) {
          window.__perderRespuestaDe = null;
          return window.__fetchReal(url, init).then(function () { throw new TypeError("Failed to fetch"); });
        }
        return window.__fetchReal(url, init);
      };
    }
    window.__sinRed = !!a.sinRed;
    window.__token = a.token;
    window.SupabaseCliente.sesion = function () { return window.__token ? { access_token: window.__token } : null; };
    window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true, usuario: a.rol + "@example.test" }; };
    window.SupabaseCliente.refrescarSesion = async function () { return window.__token ? { ok: true } : { ok: false, motivo: "sin-sesion", clase: "rechazada" }; };   // como el cliente real (3.15 · 8A)
    const mec = a.rol === "mecanico" || a.rol === "mecanico2";
    currentUser = { uid: a.id, nombre: a.nombre, rol: mec ? "mecanico" : a.rol, origen: "supabase", activo: true, perfilId: mec ? a.id : null, user: null };
    await prepararModoNube({ rol: currentUser.rol, origen: "supabase", activo: true, uid: a.id, perfilId: currentUser.perfilId });
    document.getElementById("shell").classList.add("active");
    if (mec) { showView("mi-trabajo"); await renderMiTrabajo(); }
    window.__esperarCola = async function (ms) {
      const hasta = Date.now() + (ms || 15000);
      while (Date.now() < hasta) {
        const p = (await syncBd.outbox.todos()).filter((x) => x.estado === "pending" || x.estado === "syncing");
        if (!p.length) return true;
        for (const x of p) if (x.siguiente_en > Date.now()) await syncBd.outbox.actualizar(x.seq, { siguiente_en: 0 });
        await syncMotor.sincronizar();
        await new Promise((r) => setTimeout(r, 150));
      }
      return false;
    };
    return true;
  }, { token: o.token || pila.jwt(PERFILES[rol]), id: PERFILES[rol], rol, nombre: o.nombre || { admin: "Admin", mecanico: "Mec Uno", mecanico2: "Mec Dos", cajero: "Caja" }[rol], sinRed: !!o.sinRed });
}
const enVivo = (d, ms = 15000) => d.eval(async (ms) => { const h = Date.now() + ms; while (Date.now() < h) { if (rtEstado === "conectado") return true; await new Promise((r) => setTimeout(r, 50)); } return rtEstado; }, ms, { plazoMs: ms + 5000 });
/** Espera a que el texto aparezca (o desaparezca) en un elemento de la pantalla; devuelve Date.now() del momento o null. */
const verTexto = (d, id, texto, { ms = 8000, ausente = false } = {}) => d.eval(async (a) => {
  const h = Date.now() + a.ms;
  while (Date.now() < h) { const el = document.getElementById(a.id); const hay = !!el && el.textContent.includes(a.texto); if (hay !== a.ausente) return Date.now(); await new Promise((r) => setTimeout(r, 15)); }
  return null;
}, { id, texto, ms, ausente }, { plazoMs: ms + 5000 });

async function recargar(d, rol, o = {}) {
  const marca = "m" + Math.random();
  await d.eval((m) => { window.__marca = m; setTimeout(() => location.reload(), 30); return true; }, marca);
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { if ((await d.eval(() => (document.readyState === "complete" ? window.__marca || "nueva" : "cargando"), null, { plazoMs: 3000 })) === "nueva") break; } catch { /* navegando */ }
  }
  await entrar(d, rol, o);
}

/* Admin: crear/editar la orden por el adaptador REAL (DB.save → outbox → PostgREST), igual que la pantalla. */
const adminNuevaOrden = (d, a) => d.eval(async (a) => {
  await syncMotor.pullTodo();
  const cli = (await DB.getAll("clientes")).find((c) => c.nombre === a.cliente), mo = (await DB.getAll("motos")).find((m) => m.placa === a.placa);
  return DB.save("ordenes", { clienteId: cli.id, motoId: mo.id, estado: "recibido", falla: a.falla, items: [], fotos: [], aprobacion: null, diagnostico: null, reparacionNotas: "nota técnica",
    calidadChecklist: null, mecanico: a.mecNombre || "", mecanicoId: a.mec || null, origenTrabajo: "taller", creadoEn: Date.now() });
}, a);
const adminAsignar = (d, id, mec, mecNombre) => d.eval(async (a) => { const o = await DB.get("ordenes", a.id); return DB.save("ordenes", { ...o, mecanico: a.nombre, mecanicoId: a.mec }); }, { id, mec, nombre: mecNombre });
const uidOrden = (falla) => nube(`select id from public.ordenes where falla = '${falla}'`)[0]?.id;

for (const nav of NAVS) {
  describe(`3.15 · Bloque 3 · Realtime + mensajes · app real · ${nav}`, () => {
    let admin, a1, a2, b;
    before(async () => {
      pila.limpiar();
      uno(`insert into public.clientes (id, nombre, telefono) values ('00000000-0000-4000-9000-00000000b301', 'Cliente RT ${nav}', '9999-3333');
           insert into public.motos (id, cliente_id, marca, modelo, placa) values ('00000000-0000-4000-9000-00000000b302', '00000000-0000-4000-9000-00000000b301', 'Honda', 'XR150', 'RT-${nav}');`);
      admin = await abrir(nav, "admin");
      a1 = await abrir(nav, "mecanico", { producto: "mecanico" });
      a2 = await abrir(nav, "mecanico", { producto: "mecanico" });
      b = await abrir(nav, "mecanico2", { producto: "mecanico" });
      for (const d of [admin, a1, a2, b]) assert.equal(await enVivo(d), true, `${d.nombre}: canal en vivo`);
    });
    after(async () => { for (const d of [admin, a1, a2, b]) await d?.cerrar(); });
    const base = { cliente: `Cliente RT ${nav}`, placa: `RT-${nav}` };

    test("E/F/H · admin ASIGNA → A (en sus DOS dispositivos) la ve en ≤ 2 s; B no recibe nada", async () => {
      const lat = [];
      for (let i = 0; i < 5; i++) {
        const falla = `E-${nav}-${i}`;
        const espera1 = verTexto(a1, "miTrabajoOrdenes", falla), espera2 = verTexto(a2, "miTrabajoOrdenes", falla);
        const t0 = Date.now();
        await adminNuevaOrden(admin, { ...base, falla, mec: PERFILES.mecanico, mecNombre: "Mec Uno" });
        const [t1, t2] = await Promise.all([espera1, espera2]);
        assert.ok(t1 && t2, `A no vio la orden ${falla} (dispositivo 1: ${t1}, 2: ${t2})`);
        lat.push(t1 - t0, t2 - t0);
      }
      LATENCIAS[`${nav}:asignar`] = lat;
      assert.ok(mediana(lat) <= OBJETIVO_MS, `mediana admin→Mi Trabajo ${mediana(lat)} ms (objetivo ≤ ${OBJETIVO_MS})`);
      const vistoB = await b.eval(async () => ({ ordenes: (await DB.getAll("ordenes")).length, avisos: syncRt.metricas().avisos, texto: document.getElementById("miTrabajoOrdenes").textContent }));
      assert.equal(vistoB.ordenes, 0, "B no tiene órdenes de A en su caché"); assert.equal(vistoB.avisos, 0, "B no recibió ni un aviso"); assert.ok(!vistoB.texto.includes("E-"));
      const toasts = await a1.eval(() => window.__toasts);
      assert.ok(toasts.some((t) => /trabajo nuevo/.test(t)), "aviso visible «Te asignaron un trabajo nuevo»");
    });

    test("G · REASIGNACIÓN A→B: A deja de verla y B la recibe, ambas en ≤ 2 s; la nube dice B", async () => {
      const falla = `G-${nav}`;
      const idLocal = await adminNuevaOrden(admin, { ...base, falla, mec: PERFILES.mecanico, mecNombre: "Mec Uno" });
      assert.ok(await verTexto(a1, "miTrabajoOrdenes", falla)); assert.ok(await verTexto(a2, "miTrabajoOrdenes", falla), "los dos dispositivos de A la tienen antes de reasignar");
      const saleA = verTexto(a1, "miTrabajoOrdenes", falla, { ausente: true }), saleA2 = verTexto(a2, "miTrabajoOrdenes", falla, { ausente: true }), entraB = verTexto(b, "miTrabajoOrdenes", falla);
      const t0 = Date.now();
      await adminAsignar(admin, idLocal, PERFILES.mecanico2, "Mec Dos");
      const [tA, tA2, tB] = await Promise.all([saleA, saleA2, entraB]);
      assert.ok(tA && tA2 && tB, `A1 ${tA} A2 ${tA2} B ${tB}`);
      LATENCIAS[`${nav}:reasignar`] = [tA - t0, tA2 - t0, tB - t0];
      assert.ok(Math.max(tA - t0, tB - t0) <= OBJETIVO_MS, `reasignación: A ${tA - t0} ms, B ${tB - t0} ms`);
      assert.equal(nube(`select mecanico_id from public.ordenes where falla = '${falla}'`)[0].mecanico_id, PERFILES.mecanico2);
      const cacheA = await a1.eval(async (f) => (await DB.getAll("ordenes")).some((o) => o.falla === f), falla);
      assert.equal(cacheA, false, "la copia local de A ya no la tiene (no solo oculta)");
    });

    test("I · aviso DUPLICADO (5 veces el mismo) → UNA sola petición del registro", async () => {
      const uid = uidOrden(`E-${nav}-0`);
      const r = await a1.eval(async (uid) => {
        window.__rpcVistas.length = 0;
        for (let i = 0; i < 5; i++) recibirAviso({ e: "ordenes", id: uid });
        await new Promise((ok) => setTimeout(ok, 700));
        return window.__rpcVistas.filter((u) => u.includes("ordenes_tecnico_mias") && u.includes(uid)).length;
      }, uid);
      assert.equal(r, 1);
    });

    test("J · aviso FUERA DE ORDEN (uno viejo después del nuevo) → queda lo último del servidor", async () => {
      const falla = `E-${nav}-1`, uid = uidOrden(falla);
      uno(`update public.ordenes set diagnostico = '{"nota":"ultimo"}'::jsonb where id = '${uid}'`);   // rev nueva
      assert.ok(await a1.eval(async (uid) => { const h = Date.now() + 5000; while (Date.now() < h) { const o = await syncBd.datos.porUid("ordenes", uid); if (o?.diagnostico?.nota === "ultimo") return true; await new Promise((r) => setTimeout(r, 30)); } return false; }, uid));
      const r = await a1.eval(async (uid) => { recibirAviso({ e: "ordenes", id: uid, rev: 1 }); await new Promise((ok) => setTimeout(ok, 600)); const o = await syncBd.datos.porUid("ordenes", uid); return { nota: o?.diagnostico?.nota, rev: o?._rev }; }, uid);
      assert.equal(r.nota, "ultimo"); assert.equal(r.rev, Number(uno(`select rev from public.ordenes where id = '${uid}'`)));
    });

    test("N/O/P/Q · mensaje admin → A (con orden relacionada) en ≤ 2 s; badge; leído visible para el admin; B no lo ve", async () => {
      const lat = [];
      for (let i = 0; i < 3; i++) {
        const texto = `Mensaje ${nav} ${i}: revisa los frenos`;
        const espera = verTexto(a1, "miTrabajoMensajes", texto);
        const t0 = Date.now();
        await admin.eval(async (a) => {
          showView("mensajes"); await renderMensajes();
          const sel = document.getElementById("msgDestinatario"); sel.value = a.dest; sel.dispatchEvent(new Event("change"));
          await poblarOrdenesMensaje(a.orden);
          document.getElementById("msgOrden").value = a.orden;
          document.getElementById("msgTexto").value = a.texto;
          document.getElementById("btnMsgEnviar").click();
          return true;
        }, { dest: PERFILES.mecanico, texto, orden: i === 0 ? uidOrden(`E-${nav}-0`) : "" });
        const t1 = await espera; assert.ok(t1, `A no vio el mensaje ${i}`); lat.push(t1 - t0);
      }
      LATENCIAS[`${nav}:mensaje`] = lat;
      assert.ok(mediana(lat) <= OBJETIVO_MS, `mediana mensaje admin→A ${mediana(lat)} ms`);
      const msg0 = nube(`select id, orden_id, destinatario_id, remitente_nombre, leido_en from public.mensajes where texto = 'Mensaje ${nav} 0: revisa los frenos'`);
      assert.equal(msg0.length, 1); assert.equal(msg0[0].orden_id, uidOrden(`E-${nav}-0`)); assert.equal(msg0[0].destinatario_id, PERFILES.mecanico); assert.equal(msg0[0].leido_en, null);
      assert.equal(uno(`select reparacion_notas from public.ordenes where id = '${msg0[0].orden_id}'`), "nota técnica", "Q: la nota de la orden no cambió");
      const vistaA = await a1.eval(() => ({ badge: document.getElementById("miTrabajoMsgBadge").textContent, texto: document.getElementById("miTrabajoMensajes").textContent }));
      assert.equal(vistaA.badge, "3"); assert.match(vistaA.texto, /Sobre la orden #\d+/); assert.match(vistaA.texto, /Admin/);
      // P: B no tiene nada
      assert.equal(await b.eval(async () => (await mensajesLocales()).length), 0);
      // admin: estado «Enviado · sin leer»
      await admin.eval(() => renderMensajes());
      assert.ok(await verTexto(admin, "mensajesLista", "Enviado · sin leer"));
      // O: A marca leído → el admin lo ve en ≤ 2 s
      const esperaAdmin = verTexto(admin, "mensajesLista", "Leído");
      const t0 = Date.now();
      await a1.eval(async (t) => { const m = (await mensajesLocales()).find((x) => x.texto === t); await marcarMensajeLeido(m.id); return true; }, `Mensaje ${nav} 0: revisa los frenos`);
      const tl = await esperaAdmin; assert.ok(tl, "el admin no vio «Leído»"); LATENCIAS[`${nav}:leido`] = [tl - t0];
      assert.notEqual(nube(`select leido_en from public.mensajes where id = '${msg0[0].id}'`)[0].leido_en, null);
      assert.equal(await a1.eval(() => document.getElementById("miTrabajoMsgBadge").textContent), "2");
      assert.ok(await verTexto(a2, "miTrabajoMsgBadge", "2", { ms: 5000 }), "el otro dispositivo de A también baja el contador");
    });

    test("R · mensaje SIN RED: «pendiente de envío» (nunca «enviado»), sobrevive a reabrir la app, y al volver la red llega UNA vez (también con respuesta perdida)", async () => {
      const texto = `Offline ${nav}`;
      await admin.eval(async (t) => {
        window.__sinRed = true;
        showView("mensajes"); await renderMensajes();
        document.getElementById("msgDestinatario").value = window.__destA; return true;
      }, texto);
      await admin.eval(async (a) => { const s = document.getElementById("msgDestinatario"); s.value = a.dest; document.getElementById("msgOrden").value = ""; document.getElementById("msgTexto").value = a.texto; document.getElementById("btnMsgEnviar").click(); await new Promise((r) => setTimeout(r, 800)); return true; }, { dest: PERFILES.mecanico, texto });
      let lista = await admin.eval(() => document.getElementById("mensajesLista").textContent);
      assert.match(lista, new RegExp(`Offline ${nav}[\\s\\S]*Pendiente de envío`)); assert.ok(!new RegExp(`Offline ${nav}[^]*?Enviado`).test(lista.split("Mensaje")[0] || ""), "nunca «Enviado» sin confirmación");
      assert.equal(nube(`select count(*)::int n from public.mensajes where texto = '${texto}'`)[0].n, 0);
      await recargar(admin, "admin", { sinRed: true });   // cerrar y reabrir la app sin red
      lista = await admin.eval(async () => { showView("mensajes"); await renderMensajes(); return document.getElementById("mensajesLista").textContent; });
      assert.match(lista, new RegExp(`Offline ${nav}[\\s\\S]*Pendiente de envío`), "tras reabrir sigue pendiente (outbox persistente)");
      const espera = verTexto(a1, "miTrabajoMensajes", texto, { ms: 20000 });
      await admin.eval(async () => { window.__sinRed = false; window.__perderRespuestaDe = "enviar_mensaje"; return window.__esperarCola(20000); });
      assert.ok(await espera, "A recibe el mensaje al volver la red");
      assert.equal(nube(`select count(*)::int n from public.mensajes where texto = '${texto}'`)[0].n, 1, "exactamente una vez (aunque se perdió la primera respuesta)");
      assert.ok(await verTexto(admin, "mensajesLista", "Enviado · sin leer"));
    });

    test("mensajes ya descargados siguen visibles en Mi Trabajo SIN RED, tras cerrar y reabrir", async () => {
      await recargar(a2, "mecanico", { producto: "mecanico", sinRed: true });
      const t = await a2.eval(() => document.getElementById("miTrabajoMensajes").textContent);
      assert.match(t, new RegExp(`Mensaje ${nav} 1`)); assert.match(t, new RegExp(`Offline ${nav}`));
      await recargar(a2, "mecanico", { producto: "mecanico" });
      assert.equal(await enVivo(a2), true);
    });

    test("K · se CORTA Realtime: lo asignado durante el corte llega al RECONECTAR (espera creciente) sin descargar todo", async () => {
      pila.realtimeCaido(true);
      assert.ok(await a1.eval(async () => { const h = Date.now() + 8000; while (Date.now() < h) { if (rtEstado !== "conectado") return true; await new Promise((r) => setTimeout(r, 50)); } return false; }));
      const falla = `K-${nav}`;
      await adminNuevaOrden(admin, { ...base, falla, mec: PERFILES.mecanico, mecNombre: "Mec Uno" });
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(await a1.eval((f) => document.getElementById("miTrabajoOrdenes").textContent.includes(f), falla), false, "sin Realtime no llega al instante (red de seguridad a 30 s)");
      const intervalo = await a1.eval(() => syncMotor.intervaloMs()); assert.equal(intervalo, 30000, "sin avisos vuelve la descarga cada 30 s");
      const antes = pila.peticiones.length, t0 = Date.now();
      pila.realtimeCaido(false);
      const t1 = await verTexto(a1, "miTrabajoOrdenes", falla, { ms: 40000 });
      assert.ok(t1, "al reconectar la orden aparece");
      LATENCIAS[`${nav}:reconexion`] = [t1 - t0];
      assert.equal(await enVivo(a1), true);
      assert.equal(await a1.eval(() => syncMotor.intervaloMs()), 300000, "con avisos, la red de seguridad pasa a 5 min");
      const pedidas = pila.peticiones.slice(antes).filter((p) => p.metodo !== "OPTIONS").map((p) => p.ruta);
      LATENCIAS[`${nav}:reconexion-peticiones`] = [pedidas.length];
      assert.ok(pedidas.length < 60, `coste de reconexión acotado (${pedidas.length} peticiones de todos los dispositivos)`);
    });

    test("L · sesión CADUCADA: el canal se cierra, no llega nada a esa sesión; con token nuevo vuelve a recibir", async () => {
      const tokenL = pila.jwt(PERFILES.mecanico, { segundos: 15 }), emitidoL = Date.now();
      const d = await abrir(nav, "mecanico", { producto: "mecanico", token: tokenL });   // lo justo para unirse (Firefox arranca más lento) y verlo caducar
      try {
        const vivoL = await enVivo(d);
        if (vivoL !== true) {
          // 3.15 (Bloque 6) · diagnóstico del rechazo intermitente (KNOWN_INTERMITTENT): el mensaje dice POR QUÉ, sin exponer el token
          const claims = JSON.parse(Buffer.from(tokenL.split(".")[1], "base64url").toString());
          const cliente = await d.eval(() => ({ ahora: Date.now(), estado: rtEstado, canales: syncRt.canales(true), metricas: syncRt.metricas(), sesion: !!window.SupabaseCliente.sesion() }));
          const { spawnSync } = await import("node:child_process");
          const rt = spawnSync("docker", ["logs", "--since", "90s", "entimotors-sync-rt"], { encoding: "utf8" });
          const diag = { emitido_ms: emitidoL, iat: claims.iat, exp: claims.exp, role: claims.role, sub_es_mecanico: claims.sub === PERFILES.mecanico,
            reloj_cliente_ms: cliente.ahora, reloj_lab_pg: pila.sql("select extract(epoch from clock_timestamp())").trim(),
            reloj_contenedor_rt: spawnSync("docker", ["exec", "entimotors-sync-rt", "date", "+%s"], { encoding: "utf8" }).stdout.trim(),
            segundos_desde_emision_al_fallar: (cliente.ahora - emitidoL) / 1000, cliente,
            rt_log: (rt.stdout + rt.stderr).split("\n").filter((l) => /error|denied|expired|nauthori|join|polic|limit|claims|token/i.test(l)).slice(-12) };
          assert.fail("el canal no llegó a unirse: " + JSON.stringify(diag));
        }
        assert.ok(await d.eval(async () => { const h = Date.now() + 40000; while (Date.now() < h) { if (["sin-acceso", "sin-sesion", "desconectado"].includes(rtEstado)) return true; await new Promise((r) => setTimeout(r, 100)); } return rtEstado; }, null, { plazoMs: 45000 }), "el servidor cerró el canal al caducar el token");
        const falla = `L-${nav}`;
        await adminNuevaOrden(admin, { ...base, falla, mec: PERFILES.mecanico, mecNombre: "Mec Uno" });
        await new Promise((r) => setTimeout(r, 1500));
        const r = await d.eval((f) => ({ ve: document.getElementById("miTrabajoOrdenes").textContent.includes(f), avisos: syncRt.metricas().avisos }), falla);
        assert.equal(r.ve, false, "con la sesión caducada no se reciben avisos ni se descarga");
        // (el puente del arnés ejecuta una orden por página a la vez: primero el token nuevo, después la espera)
        await d.eval(async (t) => { window.__token = t; syncMotor.reanudar(); syncRt.reintentar(); await syncMotor.sincronizar(); await renderMiTrabajo(); return true; }, pila.jwt(PERFILES.mecanico));
        assert.ok(await verTexto(d, "miTrabajoOrdenes", falla, { ms: 15000 }), "con token nuevo, la orden aparece");
        const vuelve = await enVivo(d);
        assert.equal(vuelve, true, "y el canal vuelve: " + JSON.stringify(await d.eval(() => ({ canales: syncRt.canales(true), m: syncRt.metricas(), estado: rtEstado }))));
      } finally { await d.cerrar(); }
    });

    test("M · CAMBIO DE USUARIO en el mismo navegador: A sale, entra B → canal y caché de B; nada de A", async () => {
      const d = await abrir(nav, "mecanico", { producto: "mecanico" });
      try {
        assert.equal(await enVivo(d), true);
        const abiertasAntes = pila.realtimeMetricas().abiertas;
        await d.eval(async () => { detenerRealtime(); syncMotor.detener(); return true; });   // lo que hace «Cerrar sesión» antes de recargar
        await new Promise((r) => setTimeout(r, 800));
        assert.equal(pila.realtimeMetricas().abiertas, abiertasAntes - 1, "el socket de A se cerró");
        await entrar(d, "mecanico2");
        await d.eval(async () => { showView("mi-trabajo"); await renderMiTrabajo(); return true; });
        assert.equal(await enVivo(d), true);
        const r = await d.eval(async () => ({ base: syncBd.nombre, temas: Object.keys(syncRt.canales()), ordenes: (await DB.getAll("ordenes")).map((o) => o.falla), msgs: (await mensajesLocales()).length }));
        assert.equal(r.base, `entimotors_sync_mec_${PERFILES.mecanico2}`); assert.deepEqual(r.temas, [`mt:${PERFILES.mecanico2}`]);
        assert.ok(!r.ordenes.some((f) => /^E-/.test(f)), "ninguna orden de A"); assert.equal(r.msgs, 0, "ningún mensaje de A");
        const texto = `Para A tras el cambio ${nav}`;
        await admin.eval(async (a) => { window.__sinRed = false; showView("mensajes"); await renderMensajes(); document.getElementById("msgDestinatario").value = a.dest; document.getElementById("msgOrden").value = ""; document.getElementById("msgTexto").value = a.texto; document.getElementById("btnMsgEnviar").click(); return true; }, { dest: PERFILES.mecanico, texto });
        assert.ok(await verTexto(a1, "miTrabajoMensajes", texto));
        assert.equal(await d.eval((t) => document.getElementById("miTrabajoMensajes").textContent.includes(t), texto), false);
      } finally { await d.cerrar(); }
    });

    test("Z · Mi Trabajo CERRADO: lo que pasó mientras (reasignada fuera + asignada nueva) aparece al reabrir", async () => {
      const salir = `Z-sale-${nav}`, entra = `Z-entra-${nav}`;
      const idSale = await adminNuevaOrden(admin, { ...base, falla: salir, mec: PERFILES.mecanico, mecNombre: "Mec Uno" });
      assert.ok(await verTexto(a2, "miTrabajoOrdenes", salir));
      await a2.eval(() => { detenerRealtime(); syncMotor.detener(); return true; });   // app cerrada: nadie escucha
      await adminAsignar(admin, idSale, PERFILES.mecanico2, "Mec Dos");
      await adminNuevaOrden(admin, { ...base, falla: entra, mec: PERFILES.mecanico, mecNombre: "Mec Uno" });
      await new Promise((r) => setTimeout(r, 800));
      await recargar(a2, "mecanico", { producto: "mecanico" });
      const t = await a2.eval(() => document.getElementById("miTrabajoOrdenes").textContent);
      assert.ok(t.includes(entra), "la nueva está"); assert.ok(!t.includes(salir), "la reasignada ya no");
      assert.equal(await enVivo(a2), true);
    });
  });
}

after(() => { if (Object.keys(LATENCIAS).length) console.log("LATENCIAS_B3 " + JSON.stringify(LATENCIAS)); });
