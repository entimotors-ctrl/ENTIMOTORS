// 3.15.0 · BLOQUE 4 · E2E con GoTrue REAL (v2.197.0) + api-server REAL (compilado de src/) + PostgREST + Supabase Realtime REALES, todo
// en la pila LOCAL (iniciarPila({ gotrue: true, realtime: true })). Cuentas sintéticas *@example.test con contraseñas aleatorias en memoria.
// Nunca toca producción ni usuarios reales.
//   node --experimental-websocket --test --test-concurrency=1 pruebas/sync/gotrue/b4-eliminar-usuario.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { iniciarPila, PERFILES, REST_URL } from "../browser/lib/pila.mjs";
import { iniciarApi } from "../browser/lib/api-local.mjs";

let pila, api; const RES = {};
const clave = () => `frase ${crypto.randomBytes(9).toString("base64url")} lenta`;
const SRV = () => pila.jwt(undefined, { role: "service_role" });
async function gt(ruta, { m = "GET", tok, body, srv } = {}) {
  const r = await fetch(REST_URL + ruta, { method: m, headers: { apikey: "anon-sintetica", Authorization: `Bearer ${srv ? SRV() : tok}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* no JSON */ } return { s: r.status, j, t, h: r.headers };
}
async function apiLl(metodo, ruta, tok, cuerpo) {
  const t0 = performance.now();
  const r = await fetch(api.url + ruta, { method: metodo, headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch { j = txt; } return { s: r.status, j, ms: performance.now() - t0 };
}
async function cuenta(tag, rol, nombre) {
  const c = { correo: `b4-${tag}-${crypto.randomBytes(3).toString("hex")}@example.test`, pass: clave(), rol, nombre };
  const r = await gt("/auth/v1/admin/users", { m: "POST", srv: true, body: { email: c.correo, password: c.pass, email_confirm: true } });
  assert.equal(r.s, 200, `alta ${tag}: ${r.t}`); c.id = r.j.id;
  pila.sql(`set session_replication_role = replica; update public.perfiles set nombre = '${nombre}', rol = '${rol}', activo = true where id = '${c.id}'; reset session_replication_role;`);
  return c;
}
const entrar = async (c, p = c.pass) => { const r = await gt("/auth/v1/token?grant_type=password", { m: "POST", body: { email: c.correo, password: p } }); return r.s === 200 ? { s: 200, a: r.j.access_token, r: r.j.refresh_token } : { s: r.s, code: r.j?.error_code }; };
const renovar = async (x) => (await gt("/auth/v1/token?grant_type=refresh_token", { m: "POST", body: { refresh_token: x.r } }));
const sesiones = (id) => Number(pila.sql(`select count(*) from auth.sessions where user_id = '${id}'`));
function unirse(tema, token) {
  return new Promise((ok) => {
    const ws = new WebSocket(REST_URL.replace(/^http/, "ws") + "/realtime/v1/websocket?apikey=anon-sintetica&vsn=1.0.0"); const avisos = [];
    const c = { ws, avisos, cerrar: () => { try { ws.close(); } catch { /* ya */ } } };
    ws.onopen = () => ws.send(JSON.stringify({ topic: `realtime:${tema}`, event: "phx_join", ref: "1", join_ref: "1", payload: { config: { broadcast: { self: false }, presence: { key: "" }, private: true }, access_token: token } }));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.event === "phx_reply" && m.ref === "1") { c.estado = m.payload.status; ok(c); } else if (m.event === "broadcast") avisos.push(m.payload.payload); };
    ws.onerror = () => { c.estado = "error"; ok(c); }; setTimeout(() => { if (!c.estado) { c.estado = "timeout"; ok(c); } }, 8000);
  });
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const PIN = "739205";

let adm, caj, mec, mec2, S1, S2, SA, enlaceViejo, canal;
before(async () => {
  pila = await iniciarPila({ gotrue: true, realtime: true, fasesExtra: ["sec-1c-clave-intentos"] });   // SEC-1C: límite de intentos de contraseña (en producción ya existe)
  api = await iniciarApi(pila, { origen: "https://taller.lab.test", entorno: { ENTIMOTORS_MECHANIC_ORIGIN: "https://mt.lab.test" } });
  adm = await cuenta("adm", "admin", "Dueña B4"); caj = await cuenta("caj", "cajero", "Caja B4"); mec = await cuenta("mec", "mecanico", "Mecánico B4"); mec2 = await cuenta("mec2", "mecanico", "Mecánico Dos B4");
  // historial y trabajo ACTIVO del mecánico (equivalente al de producción: 3 órdenes activas) + una entregada + un mensaje
  pila.sql(`insert into public.clientes (id, nombre) values ('00000000-0000-4000-9000-00000000b400', 'Cliente B4');
    insert into public.ordenes (id, cliente_id, estado, falla, mecanico, mecanico_id, finalizada) values
      ('00000000-0000-4000-9000-00000000b401', '00000000-0000-4000-9000-00000000b400', 'recibido', 'activa 1', 'Mecánico B4', '${mec.id}', false),
      ('00000000-0000-4000-9000-00000000b402', '00000000-0000-4000-9000-00000000b400', 'diagnostico', 'activa 2', 'Mecánico B4', '${mec.id}', false),
      ('00000000-0000-4000-9000-00000000b403', '00000000-0000-4000-9000-00000000b400', 'reparacion', 'activa 3', 'Mecánico B4', '${mec.id}', false),
      ('00000000-0000-4000-9000-00000000b404', '00000000-0000-4000-9000-00000000b400', 'entregado', 'entregada', 'Mecánico B4', '${mec.id}', true);`);
  SA = await entrar(adm); S1 = await entrar(mec); S2 = await entrar(mec);   // el mecánico en DOS dispositivos
  assert.equal(SA.s, 200); assert.equal(S1.s, 200); assert.equal(S2.s, 200);
  const m = await gt("/rest/v1/rpc/enviar_mensaje", { m: "POST", tok: SA.a, body: { p_op: crypto.randomUUID(), p_mensaje_id: "00000000-0000-4000-9000-00000000b410", p_destinatario: mec.id, p_texto: "mensaje histórico B4" } });
  assert.equal(m.s, 200, m.t);
  const e = await apiLl("POST", `/api/admin/usuarios/${mec.id}/enlace`, SA.a); assert.equal(e.s, 200, JSON.stringify(e.j)); enlaceViejo = e.j.enlaceParaEstablecerClave;
  canal = await unirse(`mt:${mec.id}`, S1.a); assert.equal(canal.estado, "ok", "el mecánico escucha su canal");
  /* 3.15 (Bloque 8 · caso Y, causa medida en b8-realtime-y): Realtime activa el broadcast desde la base con el PRIMER join privado y no
     entrega lo avisado en los ~6–10 s siguientes (ni lo reenvía), aunque el join diga «ok». Antes de probar que el aviso «cuenta» llega,
     se COMPRUEBA que la entrega ya está activa: sondas en el mismo canal hasta recibir una (no es un reintento de lo que se prueba;
     sin esto la prueba fallaba ~50 % de las veces). La app cubre esa ventana con su puesta al día tras la primera conexión
     (b8-realtime-activacion). */
  const tSonda = Date.now(); let sondaRecibida = false;
  while (!sondaRecibida && Date.now() - tSonda < 30000) {
    const id = crypto.randomUUID(); pila.sql(`select public.sync_rt_aviso('mt:${mec.id}', jsonb_build_object('e','sonda','id','${id}'))`);
    await esperar(500); sondaRecibida = canal.avisos.some((a) => a.e === "sonda" && a.id === id) || canal.avisos.some((a) => a.e === "sonda");
  }
  assert.ok(sondaRecibida, "el broadcast desde la base quedó activo para el canal (sonda recibida)");
  RES.realtime_activo_ms = Date.now() - tSonda;
});
after(async () => { canal?.cerrar(); await api?.detener(); await pila?.detener(); console.log("RENDIMIENTO_B4 " + JSON.stringify(RES)); });

test("sin PIN del propietario configurado: lo DESTRUCTIVO queda bloqueado (también para el admin); no hay PIN por defecto", async () => {
  const r2 = await apiLl("POST", "/api/autorizaciones", SA.a, { accion: "eliminar_usuario", entidad: "perfiles", registro_id: mec.id, device_id: "dev-A", pin: PIN });
  assert.equal(r2.s, 409); assert.equal(r2.j.codigo, "SIN_PIN");
  const e = await apiLl("POST", `/api/admin/usuarios/${mec.id}/eliminar`, SA.a, { op_id: crypto.randomUUID(), desasignar: true });
  assert.equal(e.s, 403); assert.equal(e.j.codigo, "AUTORIZACION_REQUERIDA");
});

test("A/B · configurar el PIN (primera vez con la contraseña de la cuenta): hash scrypt, nunca el PIN; auditado", async () => {
  const t0 = performance.now();
  const r = await apiLl("PUT", "/api/admin/pin", SA.a, { pin_nuevo: PIN, pin_confirmacion: PIN, clave_cuenta: adm.pass });
  RES.configurar_pin_ms = Math.round(performance.now() - t0);
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.via, "inicial");
  const h = pila.sql(`select hash from public.admin_pin where perfil_id = '${adm.id}'`);
  assert.match(h, /^scrypt\$/); assert.ok(!h.includes(PIN));
  assert.equal(pila.sql(`select string_agg(accion, ',') from public.auditoria where entidad = 'admin_pin'`), "pin-configurar");
  const e = await apiLl("GET", "/api/admin/pin/estado", SA.a); assert.equal(e.j.configurado, true); assert.ok(!JSON.stringify(e.j).includes("scrypt"), "el estado nunca trae el hash");
});

test("P/Q · el cajero y el mecánico NO eliminan usuarios (ni ven el impacto)", async () => {
  const C = await entrar(caj), M2 = await entrar(mec2);
  for (const t of [C.a, M2.a]) {
    assert.equal((await apiLl("GET", `/api/admin/usuarios/${mec.id}/impacto`, t)).s, 403);
    assert.equal((await apiLl("POST", `/api/admin/usuarios/${mec.id}/eliminar`, t, { op_id: crypto.randomUUID(), desasignar: true })).s, 403);
  }
  const a = await apiLl("POST", "/api/autorizaciones", C.a, { accion: "eliminar_usuario", entidad: "perfiles", registro_id: mec.id, device_id: "dev-C", pin: PIN });
  assert.equal(a.s, 403, "el cajero no puede ni pedir la autorización de eliminar");
});

test("Z/O/AB/AC/AD · impacto → sin decidir se niega → con PIN y desasignando elimina UNA vez; reintentos idempotentes", async () => {
  const imp = await apiLl("GET", `/api/admin/usuarios/${mec.id}/impacto`, SA.a);
  assert.equal(imp.s, 200); assert.equal(imp.j.impacto.ordenes_activas.length, 3, "las 3 órdenes activas"); assert.equal(imp.j.impacto.historial.ordenes, 4);
  const t0 = performance.now();
  const aut = await apiLl("POST", "/api/autorizaciones", SA.a, { accion: "eliminar_usuario", entidad: "perfiles", registro_id: mec.id, device_id: "dev-A", pin: PIN });
  RES.validar_pin_ms = Math.round(performance.now() - t0);
  assert.equal(aut.s, 201, JSON.stringify(aut.j));
  const sin = await apiLl("POST", `/api/admin/usuarios/${mec.id}/eliminar`, SA.a, { op_id: crypto.randomUUID(), autorizacion_id: aut.j.autorizacion_id, device_id: "dev-A", desasignar: false });
  assert.equal(sin.s, 409); assert.equal(sin.j.codigo, "TRABAJO_ACTIVO"); assert.match(sin.j.error, /3 orden/);
  const otroDisp = await apiLl("POST", `/api/admin/usuarios/${mec.id}/eliminar`, SA.a, { op_id: crypto.randomUUID(), autorizacion_id: aut.j.autorizacion_id, device_id: "dev-B", desasignar: true });
  assert.equal(otroDisp.j.codigo, "AUTORIZACION_INVALIDA", "la autorización no se usa desde otro dispositivo");
  const op = crypto.randomUUID();
  assert.equal(sesiones(mec.id), 2);
  const t1 = performance.now();
  const r = await apiLl("POST", `/api/admin/usuarios/${mec.id}/eliminar`, SA.a, { op_id: op, autorizacion_id: aut.j.autorizacion_id, device_id: "dev-A", desasignar: true });
  RES.eliminar_ms = Math.round(performance.now() - t1);
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.acceso_cerrado, true); assert.equal(r.j.sesiones_revocadas, 2, "T: sus DOS sesiones (dos dispositivos)");
  assert.equal(r.j.ordenes_desasignadas.length, 3);
  const rep = await apiLl("POST", `/api/admin/usuarios/${mec.id}/eliminar`, SA.a, { op_id: op, autorizacion_id: aut.j.autorizacion_id, device_id: "dev-A", desasignar: true });
  assert.equal(rep.s, 200); assert.equal(rep.j.repetida, true, "AD: respuesta perdida + reintento con el mismo op → una operación");
  const doble = await apiLl("POST", `/api/admin/usuarios/${mec.id}/eliminar`, SA.a, { op_id: crypto.randomUUID(), device_id: "dev-A", desasignar: true });
  assert.equal(doble.s, 200); assert.equal(doble.j.ya_eliminado, true, "AB: doble clic/otra pestaña → ya eliminado, sin otro PIN");
  assert.equal(Number(pila.sql(`select count(*) from public.auditoria where accion = 'usuario-eliminar'`)), 1, "una sola eliminación auditada");
  const replay = await apiLl("POST", `/api/admin/usuarios/${mec2.id}/eliminar`, SA.a, { op_id: crypto.randomUUID(), autorizacion_id: aut.j.autorizacion_id, device_id: "dev-A" });
  assert.equal(replay.j.codigo, "AUTORIZACION_INVALIDA", "J: la autorización usada (y de otra persona) no se reutiliza");
});

test("R/S/T · Auth real: no entra, no renueva, sus dos sesiones fuera; su token vivo ya no da datos", async () => {
  assert.deepEqual(await entrar(mec), { s: 400, code: "user_banned" }, "R: login rechazado");
  for (const x of [S1, S2]) { const r = await renovar(x); assert.equal(r.s, 400, "S: refresh rechazado"); }
  assert.equal(sesiones(mec.id), 0, "T: ninguna sesión suya queda en Auth");
  assert.equal((await gt("/auth/v1/user", { tok: S1.a })).s, 403, "/user con el token vivo → rechazado");
  const ords = await gt("/rest/v1/rpc/ordenes_tecnico_mias?select=id", { tok: S1.a }), msgs = await gt("/rest/v1/mensajes?select=id", { tok: S1.a });
  assert.deepEqual([ords.j, msgs.j], [[], []], "el access token que aún no caduca ya no le devuelve ni órdenes ni mensajes");
  assert.equal((await apiLl("GET", "/api/admin/pin/estado", S1.a)).s === 200, false, "ni pasa por el api-server");
});

test("AE · el enlace de recuperación generado ANTES no reactiva nada; no se generan enlaces nuevos para él", async () => {
  const token = new URL(enlaceViejo).searchParams.get("token");
  const v = await gt(`/auth/v1/verify?token=${token}&type=recovery&redirect_to=https://mt.lab.test/`);
  assert.equal(v.s, 303); assert.match(v.h.get("location"), /error_code=user_banned/); assert.doesNotMatch(v.h.get("location"), /access_token=/);
  assert.equal(pila.sql(`select activo::text || '|' || (eliminado_en is not null)::text from public.perfiles where id = '${mec.id}'`), "false|true", "sigue eliminado");
  const e = await apiLl("POST", `/api/admin/usuarios/${mec.id}/enlace`, SA.a); assert.equal(e.s, 409, "no hay enlace para una cuenta eliminada");
  const p = await apiLl("PATCH", `/api/admin/usuarios/${mec.id}`, SA.a, { activo: true }); assert.equal(p.s, 409); assert.equal(p.j.codigo, "USUARIO_ELIMINADO", "ni se reactiva");
});

test("mismo correo: no se reutiliza para otra persona (mensaje claro); el trigger de perfiles sigue creando cuentas nuevas", async () => {
  const r = await apiLl("POST", "/api/admin/usuarios", SA.a, { correo: mec.correo, nombre: "Otra Persona", telefono: "", rol: "mecanico" });
  assert.equal(r.s, 409); assert.equal(r.j.codigo, "CORREO_DE_USUARIO_ELIMINADO"); assert.match(r.j.error, /usuario ELIMINADO/);
  const correo = `b4-nuevo-${crypto.randomBytes(3).toString("hex")}@example.test`;
  const n = await apiLl("POST", "/api/admin/usuarios", SA.a, { correo, nombre: "Nuevo B4", telefono: "", rol: "cajero" });
  assert.equal(n.s, 201, JSON.stringify(n.j));
  assert.equal(pila.sql(`select rol || '|' || activo from public.perfiles where id = '${n.j.usuario.id}'`), "cajero|true");
  assert.equal(pila.sql(`select count(*) from auth.users u left join public.perfiles p on p.id = u.id where p.id is null`), "0", "sin cuentas fantasma");
});

test("U/V/W/X · historia intacta: la entregada sigue siendo suya; las activas «sin asignar»; mensaje y lectura; auditoría; su nombre", async () => {
  assert.equal(pila.sql(`select mecanico_id || '|' || mecanico from public.ordenes where id = '00000000-0000-4000-9000-00000000b404'`), `${mec.id}|Mecánico B4`);
  assert.equal(pila.sql(`select count(*) from public.ordenes where mecanico_id is null and id in ('00000000-0000-4000-9000-00000000b401','00000000-0000-4000-9000-00000000b402','00000000-0000-4000-9000-00000000b403')`), "3");
  assert.equal(pila.sql(`select destinatario_id from public.mensajes where id = '00000000-0000-4000-9000-00000000b410'`), mec.id);
  assert.equal(pila.sql(`select nombre || '|' || rol from public.perfiles where id = '${mec.id}'`), "Mecánico B4|mecanico");
  assert.match(pila.sql(`select detalle from public.auditoria where accion = 'usuario-eliminar'`), /historial conservado/);
  const borrar = await gt(`/auth/v1/admin/users/${mec.id}`, { m: "DELETE", srv: true });
  assert.notEqual(borrar.s, 200, "ni el borrado físico desde Auth (panel) pasa: su historia lo impide");
  assert.equal(pila.sql(`select count(*) from public.perfiles where id = '${mec.id}'`), "1");
});

test("Y · realtime: le llegó el aviso «cuenta» por su canal; su token ya no abre el canal", async () => {
  await esperar(1000);
  assert.ok(canal.avisos.some((a) => a.e === "cuenta" && a.id === mec.id), `avisos: ${JSON.stringify(canal.avisos)} · en realtime.messages: ${pila.sql(`select string_agg(topic || chr(32) || payload::text, chr(59)) from realtime.messages where topic like 'mt:%'`)} · ws=${canal.ws.readyState}`);
  const otra = await unirse(`mt:${mec.id}`, S2.a); assert.equal(otra.estado, "error", "no se vuelve a unir"); otra.cerrar();
  const m = await gt("/rest/v1/rpc/enviar_mensaje", { m: "POST", tok: SA.a, body: { p_op: crypto.randomUUID(), p_mensaje_id: crypto.randomUUID(), p_destinatario: mec.id, p_texto: "ya no" } });
  assert.notEqual(m.s, 200, "no recibe mensajes nuevos");
});

test("K/L · cerrar sesión o ser otro usuario inutiliza una autorización aún vigente (aunque el access token siga vivo)", async () => {
  const SB = await entrar(adm);
  const aut = await apiLl("POST", "/api/autorizaciones", SB.a, { accion: "eliminar_usuario", entidad: "perfiles", registro_id: mec2.id, device_id: "dev-K", pin: PIN });
  assert.equal(aut.s, 201);
  const cajT = await entrar(caj);
  const otro = await gt("/rest/v1/rpc/eliminar_usuario", { m: "POST", tok: cajT.a, body: { p_op: crypto.randomUUID(), p_perfil: mec2.id, p_autorizacion: aut.j.autorizacion_id, p_device: "dev-K" } });
  assert.notEqual(otro.s, 200, "L: otro usuario con esa autorización → rechazado");
  assert.equal((await gt("/auth/v1/logout?scope=local", { m: "POST", tok: SB.a })).s, 204);
  const tras = await gt("/rest/v1/rpc/eliminar_usuario", { m: "POST", tok: SB.a, body: { p_op: crypto.randomUUID(), p_perfil: mec2.id, p_autorizacion: aut.j.autorizacion_id, p_device: "dev-K" } });
  assert.notEqual(tras.s, 200); assert.match(tras.t, /AUTORIZACION_INVALIDA/, "K: sesión cerrada → la autorización ya no sirve (vínculo con la sesión)");
  assert.equal(pila.sql(`select activo::text from public.perfiles where id = '${mec2.id}'`), "true", "mec2 intacto");
});

test("AA · último administrador: no se elimina a sí mismo ni a otro administrador", async () => {
  const yo = await apiLl("POST", `/api/admin/usuarios/${adm.id}/eliminar`, SA.a, { op_id: crypto.randomUUID(), desasignar: true });
  assert.equal(yo.s, 400); assert.equal(yo.j.codigo, "PROPIA_CUENTA");
  const aut = await apiLl("POST", "/api/autorizaciones", SA.a, { accion: "eliminar_usuario", entidad: "perfiles", registro_id: PERFILES.admin, device_id: "dev-A", pin: PIN });
  const otro = await apiLl("POST", `/api/admin/usuarios/${PERFILES.admin}/eliminar`, SA.a, { op_id: crypto.randomUUID(), autorizacion_id: aut.j?.autorizacion_id, device_id: "dev-A", desasignar: true });
  assert.equal(otro.s, 403); assert.equal(otro.j.codigo, "NO_PERMITIDO");
});

test("legítimos no afectados: admin, cajero y el otro mecánico entran y renuevan", async () => {
  for (const c of [adm, caj, mec2]) { const x = await entrar(c); assert.equal(x.s, 200, c.rol); assert.equal((await renovar(x)).s, 200, c.rol); }
});

test("C/D/AF · cambiar el PIN (con el actual) y RECUPERARLO (con la contraseña): el anterior deja de servir; nada se muestra", async () => {
  const mal = await apiLl("PUT", "/api/admin/pin", SA.a, { pin_actual: "111333", pin_nuevo: "582047", pin_confirmacion: "582047" });
  assert.equal(mal.j.codigo, "PIN_INCORRECTO");
  const c = await apiLl("PUT", "/api/admin/pin", SA.a, { pin_actual: PIN, pin_nuevo: "582047", pin_confirmacion: "582047" });
  assert.equal(c.s, 200); assert.equal(c.j.via, "pin");
  const viejo = await apiLl("POST", "/api/autorizaciones", SA.a, { accion: "eliminar_usuario", entidad: "perfiles", registro_id: mec2.id, device_id: "dev-A", pin: PIN });
  assert.equal(viejo.j.codigo, "PIN_INCORRECTO", "D: el PIN anterior ya no sirve");
  const rec = await apiLl("PUT", "/api/admin/pin", SA.a, { clave_cuenta: adm.pass, pin_nuevo: "604918", pin_confirmacion: "604918" });
  assert.equal(rec.s, 200); assert.equal(rec.j.via, "clave"); assert.ok(!JSON.stringify(rec.j).match(/582047|604918|scrypt/), "la respuesta no trae PIN ni hash");
  const sinClave = await apiLl("POST", "/api/admin/pin/desbloquear", SA.a, {}); assert.equal(sinClave.j.codigo, "REAUTENTICACION_REQUERIDA", "desbloquear no se hace solo con la sesión");
  assert.equal(pila.sql(`select string_agg(accion, ',' order by creado_en) from public.auditoria where entidad = 'admin_pin'`), "pin-configurar,pin-cambiar,pin-recuperar");
});
