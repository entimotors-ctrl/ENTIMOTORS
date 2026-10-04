// 3.15.0 · BLOQUE 8 · INVESTIGACIÓN del caso Y de b4-gotrue: «el aviso se escribe pero el socket no recibe NINGÚN broadcast».
// SIN la app: directo contra la infraestructura del laboratorio (GoTrue real + Realtime v2.106 + Postgres), varios CICLOS en frío
// (cada ciclo levanta la pila desde cero) × varios intentos. Por intento registra (nunca tokens):
//   claims del JWT (iat/exp/role/sub corto) · join: tiempo, respuesta, mensajes de sistema · topic privado · COMMIT exacto del aviso
//   (clock_timestamp antes del COMMIT) e inserted_at · recepción (ms desde el COMMIT) o PÉRDIDA · cierres del socket · cleanup.
//   B8Y_CICLOS (4) · B8Y_INTENTOS (8) · B8Y_ETIQUETA. La migración 15c usada es la del árbol (cambiarla en disco para comparar A/B).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { iniciarPila, REST_URL } from "../browser/lib/pila.mjs";

const CICLOS = Number(process.env.B8Y_CICLOS || 4), INTENTOS = Number(process.env.B8Y_INTENTOS || 8), ETQ = process.env.B8Y_ETIQUETA || "B";
const SALIDA = process.env.B8Y_SALIDA || null;
const anotar = (x) => { if (SALIDA) fs.appendFileSync(SALIDA, JSON.stringify({ etq: ETQ, ...x }) + "\n"); };
const claims = (t) => { const p = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()); return { iat: p.iat, exp: p.exp, role: p.role, sub: String(p.sub).slice(0, 8), session: String(p.session_id || "").slice(0, 8) }; };

async function unirse(topic, token) {
  const t0 = Date.now(); const ev = []; const avisos = [];
  const ws = new WebSocket(REST_URL.replace(/^http/, "ws") + "/realtime/v1/websocket?apikey=anon-sintetica&vsn=1.0.0");
  const c = { ws, ev, avisos, cerrado: null, cerrar: () => { try { ws.close(); } catch { /* ya */ } } };
  ws.onclose = (e) => { c.cerrado = { code: e.code, ms: Date.now() - t0 }; };
  await new Promise((ok, mal) => { ws.onopen = ok; ws.onerror = () => mal(new Error("ws error")); setTimeout(() => mal(new Error("ws sin abrir")), 10000); });
  const abierto_ms = Date.now() - t0;
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const ahora = Date.now();
    if (m.event === "broadcast") avisos.push({ t: ahora, p: m.payload?.payload });
    else ev.push({ ms: ahora - t0, event: m.event, status: m.payload?.status, extension: m.payload?.extension, mensaje: String(m.payload?.message || m.payload?.response?.reason || "").slice(0, 80), ref: m.ref }); };
  ws.send(JSON.stringify({ topic: `realtime:${topic}`, event: "phx_join", ref: "1", join_ref: "1", payload: { config: { broadcast: { self: false }, presence: { key: "" }, private: true }, access_token: token } }));
  const h = Date.now() + 10000; while (Date.now() < h && !ev.some((x) => x.event === "phx_reply" && x.ref === "1")) await new Promise((r) => setTimeout(r, 20));
  c.join = { abierto_ms, reply: ev.find((x) => x.event === "phx_reply" && x.ref === "1") || null, ms: Date.now() - t0 };
  c.latido = setInterval(() => { try { ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "hb" })); } catch { /* */ } }, 20000);
  return c;
}

test(`caso Y · ${CICLOS} ciclos en frío × ${INTENTOS} intentos · ${ETQ}`, async () => {
  const resumen = { recibidos: 0, perdidos: 0, joins_fallidos: 0, ciclos: [] };
  for (let ciclo = 1; ciclo <= CICLOS; ciclo++) {
    const t_pila = Date.now();
    const pila = await iniciarPila({ gotrue: true, realtime: true });
    const listo_ms = Date.now() - t_pila; const rc = { ciclo, listo_ms, intentos: [] };
    try {
      const SRV = pila.jwt(undefined, { role: "service_role" });
      const correo = `b8y-${crypto.randomBytes(3).toString("hex")}@example.test`, pass = `frase ${crypto.randomBytes(9).toString("base64url")} lenta`;
      const alta = await (await fetch(REST_URL + "/auth/v1/admin/users", { method: "POST", headers: { apikey: "anon-sintetica", Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: correo, password: pass, email_confirm: true }) })).json();
      pila.sql(`set session_replication_role = replica; update public.perfiles set nombre = 'Mec Y', rol = 'mecanico', activo = true where id = '${alta.id}'; reset session_replication_role;`);
      const tok = (await (await fetch(REST_URL + "/auth/v1/token?grant_type=password", { method: "POST", headers: { apikey: "anon-sintetica", "Content-Type": "application/json" }, body: JSON.stringify({ email: correo, password: pass }) })).json()).access_token;
      rc.jwt = claims(tok);
      // experimentos: B8Y_ESPERA_MS = esperar antes del primer join (¿tiempo desde el arranque?) · B8Y_MISMO_SOCKET = un solo socket y
      // un aviso cada 500 ms desde el join (¿cuándo empieza a entregar respecto del PRIMER join?)
      if (Number(process.env.B8Y_ESPERA_MS || 0)) await new Promise((x) => setTimeout(x, Number(process.env.B8Y_ESPERA_MS)));
      if (process.env.B8Y_MISMO_SOCKET) {
        const c = await unirse(`mt:${alta.id}`, tok); const tJoin = Date.now(); const ids = [];
        for (let k = 0; k < 40; k++) { const id = crypto.randomUUID(); ids.push({ id, t: Date.now() - tJoin }); pila.sql(`select public.sync_rt_aviso('mt:${alta.id}', jsonb_build_object('e','ordenes','id','${id}'))`); await new Promise((x) => setTimeout(x, 500)); }
        await new Promise((x) => setTimeout(x, 2000));
        const primero = ids.find((x) => c.avisos.some((a) => a.p?.id === x.id));
        rc.mismo_socket = { join_desde_pila_ms: tJoin - t_pila, join: c.join.reply?.status, primer_entregado_ms_tras_join: primero ? primero.t : null,
          perdidos_antes_del_primero: primero ? ids.indexOf(primero) : ids.length, perdidos_despues: primero ? ids.slice(ids.indexOf(primero)).filter((x) => !c.avisos.some((a) => a.p?.id === x.id)).length : null };
        clearInterval(c.latido); c.cerrar(); anotar({ ciclo, mismo_socket: rc.mismo_socket });
      }
      for (let i = 1; i <= (process.env.B8Y_MISMO_SOCKET ? 0 : INTENTOS); i++) {
        const desdePila_ms = Date.now() - t_pila;
        const c = await unirse(`mt:${alta.id}`, tok);
        const r = { i, desdePila_ms, join: c.join.reply ? { status: c.join.reply.status, ms: c.join.ms, abierto_ms: c.join.abierto_ms } : { status: "SIN_RESPUESTA", ms: c.join.ms } };
        if (r.join.status !== "ok") resumen.joins_fallidos++;
        // aviso: commit exacto y momento de escritura (clock_timestamp justo antes del COMMIT)
        const id = crypto.randomUUID();
        const fila = pila.sql(`begin; select public.sync_rt_aviso('mt:${alta.id}', jsonb_build_object('e','ordenes','id','${id}','rev',${i})); select to_char(clock_timestamp(),'HH24:MI:SS.MS') || '|' || extract(epoch from clock_timestamp())*1000; commit;`).split("\n").filter(Boolean).pop();
        const [commit_hora, commit_epoch] = fila.split("|"); const tCommit = Number(commit_epoch);
        const ins = pila.sql(`select to_char(inserted_at,'HH24:MI:SS.MS') from realtime.messages where payload->>'id' = '${id}'`);
        const h = Date.now() + 6000; let llegado = null;
        while (Date.now() < h && !llegado) { llegado = c.avisos.find((a) => a.p?.id === id); if (!llegado) await new Promise((x) => setTimeout(x, 25)); }
        r.commit = commit_hora; r.escrito = ins || "NO_ESCRITO"; r.recibido_ms = llegado ? Math.round(llegado.t - tCommit) : null;
        r.sistema = c.ev.filter((x) => x.event !== "phx_reply" || x.ref !== "1").map((x) => `${x.event}:${x.status || ""}:${x.extension || ""}:${x.mensaje}`).slice(0, 4);
        r.cierre = c.cerrado;
        if (llegado) resumen.recibidos++; else resumen.perdidos++;
        clearInterval(c.latido); c.cerrar(); await new Promise((x) => setTimeout(x, 300));
        // cleanup: ¿queda algún canal colgado del lado del servidor? (contador del gateway)
        r.sockets_abiertos_gateway = pila.realtimeSockets ? pila.realtimeSockets() : undefined;
        rc.intentos.push(r); anotar({ ciclo, ...r });
      }
    } finally { await pila.detener(); }
    resumen.ciclos.push({ ciclo: rc.ciclo, listo_ms: rc.listo_ms, jwt: rc.jwt, mismo_socket: rc.mismo_socket, perdidos: rc.intentos.filter((x) => x.recibido_ms == null).map((x) => ({ i: x.i, desdePila_ms: x.desdePila_ms, join: x.join.status, sistema: x.sistema })),
      recibidos_ms: rc.intentos.filter((x) => x.recibido_ms != null).map((x) => x.recibido_ms) });
    console.log(`B8Y_CICLO ${JSON.stringify(resumen.ciclos.at(-1))}`);
  }
  console.log(`B8Y ${ETQ} ${JSON.stringify({ recibidos: resumen.recibidos, perdidos: resumen.perdidos, joins_fallidos: resumen.joins_fallidos })}`);
  assert.ok(true);
});
