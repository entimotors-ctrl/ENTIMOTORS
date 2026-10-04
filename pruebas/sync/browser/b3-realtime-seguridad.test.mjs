// 3.15.0 · BLOQUE 3 · SEGURIDAD DE LOS CANALES contra Supabase Realtime REAL (contenedor v2.106.0 de la pila) y PostgREST real, sin
// navegador: clientes Phoenix en Node (WebSocket nativo). Lo que decide es RLS en realtime.messages (políticas entimotors_rt_* de 15c).
//   node --experimental-websocket --test pruebas/sync/browser/b3-realtime-seguridad.test.mjs
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES, REST_URL } from "./lib/pila.mjs";

let pila;
before(async () => { pila = await iniciarPila({ realtime: true }); });
after(async () => { await pila?.detener(); });
const WS_URL = REST_URL.replace(/^http/, "ws") + "/realtime/v1/websocket?apikey=anon-sintetica&vsn=1.0.0";

/** Un cliente Phoenix: se une a `tema` (privado por defecto) con `token` y junta lo que le llega. */
function unirse(tema, token, { privado = true } = {}) {
  return new Promise((ok) => {
    const ws = new WebSocket(WS_URL), avisos = [];
    const c = { ws, avisos, respuesta: null, enviar: (evento, payload) => ws.send(JSON.stringify({ topic: `realtime:${tema}`, event: "broadcast", ref: "9", join_ref: "1", payload: { type: "broadcast", event: evento, payload } })),
      cerrar: () => { try { ws.close(); } catch { /* ya */ } } };
    ws.onopen = () => ws.send(JSON.stringify({ topic: `realtime:${tema}`, event: "phx_join", ref: "1", join_ref: "1",
      payload: { config: { broadcast: { self: false, ack: false }, presence: { key: "", enabled: false }, private: privado }, ...(token ? { access_token: token } : {}) } }));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.event === "phx_reply" && m.ref === "1") { c.respuesta = m.payload; ok(c); } else if (m.event === "broadcast") avisos.push(m.payload); };
    ws.onerror = () => { c.respuesta = { status: "error", response: { reason: "socket" } }; ok(c); };
    setTimeout(() => { if (!c.respuesta) { c.respuesta = { status: "timeout" }; ok(c); } }, 8000);
  });
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const tk = (rol, o) => pila.jwt(PERFILES[rol], o);
const MT = (rol) => `mt:${PERFILES[rol]}`;
const ORDEN = "00000000-0000-4000-9000-00000000a501";

describe("3.15 · Bloque 3 · quién escucha cada canal (Realtime real)", () => {
  const abiertos = [];
  after(() => abiertos.forEach((c) => c.cerrar()));
  const u = async (...a) => { const c = await unirse(...a); abiertos.push(c); return c; };

  test("unirse: cada mecánico SOLO a su canal; admin a «taller» y «admin»; cajero solo a «taller»; anon y sin token a nada", async () => {
    const casos = [
      [MT("mecanico"), tk("mecanico"), "ok"], [MT("mecanico"), tk("mecanico2"), "error"], [MT("mecanico"), tk("cajero"), "error"], [MT("mecanico"), tk("admin"), "error"],
      [MT("mecanico"), pila.jwt(null, { role: "anon" }), "error"], [MT("mecanico"), null, "error"],
      ["taller", tk("admin"), "ok"], ["admin", tk("admin"), "ok"], ["taller", tk("cajero"), "ok"], ["admin", tk("cajero"), "error"],
      ["taller", tk("mecanico"), "error"], ["admin", tk("mecanico"), "error"], ["otro-tema", tk("admin"), "error"],
    ];
    for (const [tema, token, esperado] of casos) {
      const c = await u(tema, token);
      assert.equal(c.respuesta.status, esperado, `${tema} con ${token ? "token" : "sin token"}: ${JSON.stringify(c.respuesta).slice(0, 160)}`);
    }
  });

  test("un aviso de asignación llega SOLO al canal privado del mecánico: ni a B, ni a un suscriptor PÚBLICO del mismo tema; y no lleva datos", async () => {
    const a = await u(MT("mecanico"), tk("mecanico")), b = await u(MT("mecanico2"), tk("mecanico2"));
    const publico = await u(MT("mecanico"), pila.jwt(null, { role: "anon" }), { privado: false });
    assert.equal(publico.respuesta.status, "ok", "un canal PÚBLICO con el mismo nombre se puede abrir…");
    await esperar(500);
    pila.sql(`insert into public.clientes (id, nombre, telefono) values ('00000000-0000-4000-9000-00000000a500', 'Cliente Secreto', '9999-1234');
              insert into public.ordenes (id, cliente_id, estado, falla, mecanico, mecanico_id) values ('${ORDEN}', '00000000-0000-4000-9000-00000000a500', 'recibido', 'Falla secreta', 'Mec Uno', '${PERFILES.mecanico}')`);
    await esperar(1500);
    assert.equal(a.avisos.length, 1, "A recibe su aviso"); assert.equal(b.avisos.length, 0, "B no"); assert.equal(publico.avisos.length, 0, "…pero NO recibe los avisos privados");
    const texto = JSON.stringify(a.avisos[0]);
    assert.match(texto, new RegExp(ORDEN)); assert.ok(!/Secreto|secreta|9999/.test(texto), `el aviso no trae datos: ${texto}`);
  });

  test("un CLIENTE no puede emitir por un canal (sin política de INSERT): lo que manda el admin por «taller» no le llega al cajero", async () => {
    const adm = await u("taller", tk("admin")), caj = await u("taller", tk("cajero"));
    adm.enviar("cambio", { e: "ordenes", id: "falso" });
    await esperar(1500);
    assert.equal(caj.avisos.length, 0);
  });

  test("mecánico DESACTIVADO: ya no puede unirse; si ya estaba unido y le llega un aviso, al pedir el registro RLS no le da nada", async () => {
    const unido = await u(MT("mecanico"), tk("mecanico"));
    assert.equal(unido.respuesta.status, "ok");
    pila.sql(`update public.perfiles set activo = false where id = '${PERFILES.mecanico}'`);
    try {
      const nuevo = await u(MT("mecanico"), tk("mecanico"));
      assert.equal(nuevo.respuesta.status, "error", "desactivado: no se une");
      pila.sql(`update public.ordenes set falla = 'cambio tras desactivar' where id = '${ORDEN}'`);
      await esperar(1200);
      const r = await fetch(`${REST_URL}/rest/v1/rpc/ordenes_tecnico_mias?select=*&id=eq.${ORDEN}`, { headers: { apikey: "anon-sintetica", Authorization: `Bearer ${tk("mecanico")}` } });
      assert.deepEqual(await r.json(), [], "el aviso (si llegó) es solo un id: el registro no se entrega a un usuario desactivado");
    } finally { pila.sql(`update public.perfiles set activo = true where id = '${PERFILES.mecanico}'`); }
  });

  test("token CADUCADO: el servidor no admite la unión", async () => {
    const c = await u(MT("mecanico"), tk("mecanico", { segundos: -5 }));
    assert.equal(c.respuesta.status, "error");
  });

  // 3.15 · Bloque 4 (contrato nuevo): ELIMINAR ≠ BORRAR. Un perfil con historial ya no se borra físicamente (trigger
  // perfiles_proteger_historial); «Eliminar usuario» lo deja activo=false + eliminado_en y la historia conserva su destinatario.
  test("usuario ELIMINADO: no se borra físicamente; el mensaje conserva su destinatario, solo el admin lo ve; su token ya no abre su canal", async () => {
    pila.sql(`set session_replication_role = replica;
      insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000077', 'baja@example.test') on conflict do nothing;
      insert into public.perfiles (id, nombre, rol, activo) values ('00000000-0000-4000-8000-000000000077', 'Mec Baja', 'mecanico', true) on conflict (id) do update set activo = true;
      reset session_replication_role;`);
    const r = await fetch(`${REST_URL}/rest/v1/rpc/enviar_mensaje`, { method: "POST", headers: { apikey: "anon-sintetica", Authorization: `Bearer ${tk("admin")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_op: "00000000-0000-4000-9000-00000000a777", p_mensaje_id: "00000000-0000-4000-9000-00000000a778", p_destinatario: "00000000-0000-4000-8000-000000000077", p_texto: "para quien se va" }) });
    assert.equal(r.status, 200, await r.text());
    assert.throws(() => pila.sql(`delete from auth.users where id = '00000000-0000-4000-8000-000000000077'`), /PERFIL_CON_HISTORIAL/, "con historial no se borra");
    // el estado en que lo deja eliminar_usuario (la ruta completa, con PIN y Auth real, la prueba gotrue/b4-eliminar-usuario)
    pila.sql(`set session_replication_role = replica;
      update public.perfiles set activo = false, eliminado_en = now(), eliminado_por = '${PERFILES.admin}' where id = '00000000-0000-4000-8000-000000000077';
      reset session_replication_role;`);
    assert.equal(pila.sql(`select coalesce(destinatario_id::text, 'null') || '|' || texto from public.mensajes where id = '00000000-0000-4000-9000-00000000a778'`), "00000000-0000-4000-8000-000000000077|para quien se va", "el mensaje se conserva CON su destinatario");
    const tokBaja = pila.jwt("00000000-0000-4000-8000-000000000077");
    const c = await u("mt:00000000-0000-4000-8000-000000000077", tokBaja);
    assert.equal(c.respuesta.status, "error", "el token de un usuario eliminado no abre el canal");
    const vistos = await (await fetch(`${REST_URL}/rest/v1/mensajes?select=id`, { headers: { apikey: "anon-sintetica", Authorization: `Bearer ${tokBaja}` } })).json();
    assert.deepEqual(vistos, [], "ni lee mensajes");
    const admin = await (await fetch(`${REST_URL}/rest/v1/mensajes?select=id&id=eq.00000000-0000-4000-9000-00000000a778`, { headers: { apikey: "anon-sintetica", Authorization: `Bearer ${tk("admin")}` } })).json();
    assert.equal(admin.length, 1, "el administrador sí (auditoría)");
  });
});
