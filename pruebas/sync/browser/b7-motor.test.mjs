// 3.15.0 · BLOQUE 7 · EQUIVALENCIA de las optimizaciones del MOTOR de sincronización (navegadores reales + PostgREST/Postgres reales):
//   M1 · descarga por páginas con lecturas agrupadas (aplicarPagina): 1 200 clientes (3 páginas) + 600 motos → cada fila UNA vez, con su uid,
//        su mapa y la moto ligada al cliente correcto; re-descargar no duplica ni cambia nada (solapamiento).
//   M2 · fk_pendientes por página (loteFkPendientes): una moto cuyo cliente aún no bajó queda PENDIENTE (anotada) y se resuelve y se quita
//        de la lista al completar la descarga — igual que antes.
//   M3 · cambio local sin enviar + cambio remoto del mismo registro: lo mío se queda a la vista y la revisión NO avanza (regla SYNC-8 intacta).
//   M4 · arrancar({ descargaReciente }): con la cola vacía NO repite la descarga; con algo pendiente envía y hace la descarga correctiva.
//   M5 · sin la opción, arrancar() se comporta como siempre (envío + descarga inmediata).
import test, { describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });
let n = 0;
async function dispositivo(nav) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b7m-${nav}-${++n}` });
  await d.eval((a) => { window.__token = a.token; window.__sesion = { uid: a.id }; window.__habilitado = true; return __montar({ nombreBd: `b7m_${a.n}` }); },
    { token: pila.jwt(PERFILES.admin), id: PERFILES.admin, n: ++n });
  return d;
}
const cli = (i) => `00000000-0000-4000-9000-0000b7${String(i).padStart(6, "0")}`;
const mot = (i) => `00000000-0000-4000-9000-0000b8${String(i).padStart(6, "0")}`;

for (const nav of NAVS) describe(`B7 · motor · ${nav}`, () => {
  const abiertos = [];
  const abrir = async () => { const d = await dispositivo(nav); abiertos.push(d); return d; };
  afterEach(async () => { for (const d of abiertos.splice(0)) await d.cerrar(); });

  test("M1 · 3 páginas de clientes + motos: cada fila una vez, mapa y relación correctos; re-descargar no cambia nada", async () => {
    pila.limpiar();
    pila.sql(`insert into public.clientes (id, nombre, telefono) select ('00000000-0000-4000-9000-0000b7' || lpad(g::text, 6, '0'))::uuid, 'B7 cli ' || g, g::text from generate_series(1, 1200) g;
      insert into public.motos (id, cliente_id, marca, placa) select ('00000000-0000-4000-9000-0000b8' || lpad(g::text, 6, '0'))::uuid, ('00000000-0000-4000-9000-0000b7' || lpad((g * 2)::text, 6, '0'))::uuid, 'M', 'P' || g from generate_series(1, 600) g;`);
    const d = await abrir();
    const r = await d.eval(async () => {
      await __motor.pullTodo();
      const clientes = await __bd.datos.todos("clientes"), motos = await __bd.datos.todos("motos");
      const porId = new Map(clientes.map((c) => [c.id, c]));
      const mapa = await __bd.transaccion(["mapa"], "readonly", (t) => t.todos("mapa"));
      const bien = motos.every((m) => { const c = porId.get(m.clienteId); return c && Number(c.nombre.slice(7)) === Number(m.placa.slice(1)) * 2; });
      const antes = JSON.stringify(clientes.map((c) => [c.id, c.uid, c._rev]).sort());
      await __motor.pullTodo({ solapamientoMs: 3600000 });   // re-lee TODO lo de la última hora (el peor solapamiento)
      const despues = JSON.stringify((await __bd.datos.todos("clientes")).map((c) => [c.id, c.uid, c._rev]).sort());
      return { clientes: clientes.length, uids: new Set(clientes.map((c) => c.uid)).size, motos: motos.length, mapa: mapa.length, bien, igual: antes === despues,
        fk: (await __bd.meta.get("fk_pendientes")) || {} };
    }, null, { plazoMs: 120000 });
    assert.deepEqual({ clientes: r.clientes, uids: r.uids, motos: r.motos, mapa: r.mapa }, { clientes: 1200, uids: 1200, motos: 600, mapa: 1800 });
    assert.ok(r.bien, "cada moto ligada a SU cliente");
    assert.ok(r.igual, "re-descargar no duplica ni cambia nada");
    assert.deepEqual(r.fk, {}, "sin llaves pendientes");
  });

  test("M2 · moto cuyo cliente todavía no bajó: queda pendiente y se resuelve (y sale de la lista) al completar", async () => {
    pila.limpiar();
    const d = await abrir();
    await d.eval(() => __motor.pull("clientes"));
    pila.sql(`insert into public.clientes (id, nombre) values ('${cli(9001)}', 'B7 tardío'); insert into public.motos (id, cliente_id, marca, placa) values ('${mot(9001)}', '${cli(9001)}', 'M', 'TARDE');`);
    const r = await d.eval(async (u) => {
      await __motor.pull("motos");   // la moto baja ANTES que su cliente
      const pend = (await __bd.meta.get("fk_pendientes")) || {};
      const m1 = (await __bd.datos.todos("motos"))[0];
      await __motor.pullTodo();       // baja el cliente y re-resuelve
      const m2 = (await __bd.datos.todos("motos"))[0], c = (await __bd.datos.todos("clientes")).find((x) => x.uid === u.cli);
      return { pendiente: pend.motos || [], clienteAntes: m1.clienteId ?? null, clienteDespues: m2.clienteId, clienteLocal: c.id, fkDespues: (await __bd.meta.get("fk_pendientes")) || {} };
    }, { cli: cli(9001) }, { plazoMs: 60000 });
    assert.deepEqual(r.pendiente, [mot(9001)], "la moto quedó anotada como pendiente");
    assert.equal(r.clienteAntes, null);
    assert.equal(r.clienteDespues, r.clienteLocal, "resuelta al cliente correcto");
    assert.deepEqual(r.fkDespues, {}, "y salió de la lista");
  });

  test("M3 · cambio local sin enviar + cambio remoto del mismo registro: lo local se queda y la revisión no avanza", async () => {
    pila.limpiar();
    pila.sql(`insert into public.clientes (id, nombre, telefono) values ('${cli(9100)}', 'B7 original', '1')`);
    const d = await abrir();
    const r = await d.eval(async (u) => {
      await __motor.pullTodo();
      const c = (await __bd.datos.todos("clientes")).find((x) => x.uid === u);
      window.__red.caida = true;
      await __motor.escribir("clientes", { ...c, telefono: "LOCAL" });
      window.__red.caida = false;
      return { id: c.id, rev: c._rev };
    }, cli(9100), { plazoMs: 60000 });
    pila.sql(`update public.clientes set nombre = 'B7 remoto' where id = '${cli(9100)}'`);
    const r2 = await d.eval(async (id) => { await __motor.pull("clientes", { solapamientoMs: 3600000 }); const c = await __bd.datos.get("clientes", id); return { telefono: c.telefono, rev: c._rev }; }, r.id, { plazoMs: 60000 });
    assert.equal(r2.telefono, "LOCAL", "lo mío sigue a la vista");
    assert.equal(r2.rev, r.rev, "la revisión conocida no avanzó (el envío fusionará)");
  });

  test("M4 · arrancar({ descargaReciente }): cola vacía → no repite la descarga; con algo pendiente → envía y descarga", async () => {
    pila.limpiar();
    const d = await abrir();
    const r = await d.eval(async () => {
      await __motor.pullTodo();
      window.__red.registro = [];
      __motor.arrancar({ descargaReciente: true });
      await new Promise((x) => setTimeout(x, 1500));
      const vacia = window.__red.registro.map((p) => `${p.m} ${p.u.split("?")[0]}`);
      __motor.detener();
      window.__red.caida = true;
      await __motor.escribir("clientes", { nombre: "B7 pendiente", telefono: "2" });
      window.__red.caida = false;
      window.__red.registro = [];
      __motor.arrancar({ descargaReciente: true });
      const h = Date.now() + 15000;
      while (Date.now() < h && (await __bd.outbox.todos()).some((x) => x.estado === "pending" || x.estado === "syncing")) await new Promise((x) => setTimeout(x, 50));
      await new Promise((x) => setTimeout(x, 800));
      const conCola = window.__red.registro.map((p) => `${p.m} ${p.u.split("?")[0]}`);
      __motor.detener();
      return { vacia, conCola };
    }, null, { plazoMs: 60000 });
    assert.ok(!r.vacia.some((x) => x.startsWith("GET /rest/v1/clientes") || x.startsWith("GET /rest/v1/motos")), `cola vacía: sin descarga repetida (${r.vacia.join(", ")})`);
    assert.ok(r.conCola.some((x) => x.startsWith("POST") || x.startsWith("PATCH")), `con cola: envía (${r.conCola.join(", ")})`);
    assert.ok(r.conCola.some((x) => x.startsWith("GET /rest/v1/clientes")), "…y hace la descarga correctiva");
    assert.equal(Number(pila.sql("select count(*) from public.clientes where nombre = 'B7 pendiente'")), 1);
  });

  test("M5 · arrancar() sin opciones: igual que siempre (descarga inmediata aunque la cola esté vacía)", async () => {
    pila.limpiar();
    const d = await abrir();
    const r = await d.eval(async () => {
      await __motor.pullTodo();
      window.__red.registro = [];
      __motor.arrancar();
      await new Promise((x) => setTimeout(x, 1500));
      __motor.detener();
      return window.__red.registro.map((p) => `${p.m} ${p.u.split("?")[0]}`);
    }, null, { plazoMs: 60000 });
    assert.ok(r.some((x) => x.startsWith("GET /rest/v1/clientes")), `descarga como siempre (${r.join(", ")})`);
  });
});
