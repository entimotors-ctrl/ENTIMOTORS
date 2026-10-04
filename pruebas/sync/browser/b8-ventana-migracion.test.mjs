// 3.15.0 · PRE-RELEASE · LA VENTANA «migraciones aplicadas → el dispositivo todavía en 3.14.1 sincroniza → se actualiza a 3.15.0»
// (navegador real, Service Worker real, MISMO origen; PostgreSQL + PostgREST reales con la cadena 3.14 y luego 15a–15g).
//   O-2 · 3.14.1 baja las órdenes en su revisión nueva (15b las actualiza una vez) SIN los campos de 3.15. Al actualizar, 3.15 relee la
//         caché UNA vez y cada orden toma el estado de presupuesto REAL del servidor (una entregada = «aprobado», no «pendiente»).
//   F-1 · La orden tiene 2 renglones que solo existen en el dispositivo: sus operaciones `agregar_item_orden` están RECHAZADAS.
//         3.14.1 (sin protección) los quita de la orden local al bajar la revisión nueva; 3.15 los repone desde la propia operación
//         rechazada y los conserva. Nunca se reenvían, no cambian de estado y el servidor no recibe nada.
//   B8_CANDIDATOS = carpeta de preparar-candidatos.sh (por defecto ../ENTIMOTORS-3.15-bloque8/candidatos)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { iniciarPila, PERFILES, RAIZ, FASES_315 } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { prepararSesion } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const CAND = path.resolve(process.env.B8_CANDIDATOS || path.join(RAIZ, "../ENTIMOTORS-3.15-bloque8/candidatos"));
const V314 = path.join(CAND, "base-3.14.1/taller-demo"), V315 = path.join(CAND, "taller-3.15.0");
const SQL = path.join(RAIZ, "taller-demo/supabase/sync");
let pila;
before(async () => { for (const r of [V314, V315]) assert.ok(fs.existsSync(path.join(r, "sw.js")), `falta ${r}`); pila = await iniciarPila({ excluir: FASES_315 }); });
after(async () => { await pila?.detener(); });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const U = { uid: PERFILES.admin, nombre: "Admin", rol: "admin", perfilId: null };
async function arrancar(d) {
  await prepararSesion(d, pila.jwt(U.uid, { segundos: 7200 }));
  return d.eval(async (u) => { await startApp({ ...u, origen: "supabase", activo: true, user: null }); if (window.esperarDescargaArranque) await esperarDescargaArranque(); return VERSION_APP; }, U, { plazoMs: 120000 });
}
const sincronizar = (d) => d.eval(async () => { for (let i = 0; i < 2; i++) { await syncMotor.sincronizar(); await new Promise((x) => setTimeout(x, 300)); } return true; }, null, { plazoMs: 90000 });
async function esperarVersion(d, v, ms = 60000) {
  const h = Date.now() + ms; let u = null;
  while (Date.now() < h) { try { u = await d.eval(() => (typeof VERSION_APP !== "undefined" && document.readyState === "complete" ? VERSION_APP : null), null, { plazoMs: 5000 }); } catch { u = null; } if (u === v) return v; await espera(700); }
  return u;
}
// la caché tal como está en disco, sin pasar por la app
const foto = (d, a) => d.eval(async (a) => {
  const db = await new Promise((ok, mal) => { const r = indexedDB.open("entimotors_sync"); r.onsuccess = () => ok(r.result); r.onerror = () => mal(r.error); });
  const T = (s) => new Promise((ok, mal) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => ok(q.result); q.onerror = () => mal(q.error); });
  const ord = await T("ordenes"), ob = await T("outbox"); db.close();
  const de = (uid) => { const o = ord.find((x) => x.uid === uid); return o ? { rev: o._rev, pend: !!o._pend, presupuesto: o.presupuestoEstado === undefined ? "(sin campo)" : o.presupuestoEstado, items: (o.items || []).map((i) => `${i.uid || "-"}|${i.nombre}|${i.cantidad}|${i.precio}`) } : null; };
  return { version: typeof VERSION_APP !== "undefined" ? VERSION_APP : null, abierta: de(a.abierta), entregada: de(a.entregada), outbox: JSON.stringify(ob.slice().sort((x, y) => x.seq - y.seq)) };
}, a, { plazoMs: 30000 });
const PROHIBIDAS = /\/rpc\/(agregar_item_orden|editar_item_orden|quitar_item_orden)/;

for (const nav of NAVS) test(`ventana migraciones → 3.14.1 sincroniza → 3.15.0 · ${nav}`, async () => {
  // servidor en la cadena 3.14 (como producción antes del release)
  pila.sql("drop table if exists public.sync_fases cascade", { tolerar: true });
  pila.limpiar();
  const cli = crypto.randomUUID(), moto = crypto.randomUUID(), abierta = crypto.randomUUID(), entregada = crypto.randomUUID(), s1 = crypto.randomUUID(), s2 = crypto.randomUUID(), e1 = crypto.randomUUID();
  const L = [{ uid: crypto.randomUUID(), nombre: "Renglón local A", cantidad: 4, precio: 70 }, { uid: crypto.randomUUID(), nombre: "Renglón local B", cantidad: 1, precio: 1200 }];
  assert.equal(pila.sql("select count(*) from information_schema.columns where table_schema='public' and table_name='ordenes' and column_name='presupuesto_estado'"), "0", "el servidor empieza SIN 3.15");
  pila.sql(`insert into public.clientes (id, nombre) values ('${cli}', 'Cliente V'); insert into public.motos (id, cliente_id, marca, modelo, placa) values ('${moto}', '${cli}', 'Honda', 'CB', 'V-1');
    set session_replication_role = replica;
    insert into public.ordenes (id, cliente_id, moto_id, estado, falla, origen_trabajo, finalizada, finalizado_en) values ('${abierta}', '${cli}', '${moto}', 'presupuesto', 'Abierta', 'taller', false, null), ('${entregada}', '${cli}', '${moto}', 'entregado', 'Entregada', 'taller', true, now());
    insert into public.orden_items (id, orden_id, nombre, cantidad, precio) values ('${s1}', '${abierta}', 'Servidor 1', 1, 300), ('${s2}', '${abierta}', 'Servidor 2', 1, 110), ('${e1}', '${entregada}', 'Entregado 1', 1, 500);
    reset session_replication_role;`);
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8ventana-${nav}`, pagina: "index.html", real: true, raiz: V314, plazoApertura: 60000 });
  const A = { abierta, entregada };
  try {
    assert.equal(await arrancar(d), "3.14.1");
    await d.eval(async () => { await navigator.serviceWorker.ready; const h = Date.now() + 20000; while (!navigator.serviceWorker.controller && Date.now() < h) await new Promise((x) => setTimeout(x, 100)); return true; }, null, { plazoMs: 30000 });
    // el dispositivo queda como el teléfono: 2 renglones solo locales y sus 2 operaciones RECHAZADAS por la nube (terminales)
    await d.eval(async (a) => {
      const db = await new Promise((ok, mal) => { const r = indexedDB.open("entimotors_sync"); r.onsuccess = () => ok(r.result); r.onerror = () => mal(r.error); });
      const pedir = (q) => new Promise((ok, mal) => { q.onsuccess = () => ok(q.result); q.onerror = () => mal(q.error); });
      const t = db.transaction(["ordenes", "mapa", "outbox", "meta"], "readwrite"), dev = (await pedir(t.objectStore("meta").get("device_id")))?.v || "dev-prueba";
      const mp = await pedir(t.objectStore("mapa").get(a.abierta)), o = await pedir(t.objectStore("ordenes").get(mp.local_id));
      o.items = o.items.concat(a.L.map((l) => ({ ...l, costoUnitario: 0, costoEstimado: false, inventarioUid: null, origenInventarioId: null }))); o._pend = true; t.objectStore("ordenes").put(o);
      a.L.forEach((l, i) => { const op = crypto.randomUUID(); t.objectStore("outbox").put({ op_id: op, entidad: "ordenes", uid: a.abierta, kind: "rpc", rpc: "agregar_item_orden", crea: false, estado: "rejected", intentos: 1, siguiente_en: 0, enviando_en: Date.now() - 1000,
        actor_uid: a.actor, device_id: dev, creado_en: Date.now() - 5000 + i, error: { clase: "conflicto", codigo: "23505", mensaje: "OP_ID_REUTILIZADO", http: 409 },
        params: { p_orden_id: a.abierta, p_inventario_id: null, p_nombre: l.nombre, p_cantidad: l.cantidad, p_precio: l.precio, p_item_id: l.uid, p_offline: false, p_occurred_at: new Date().toISOString(), p_device: dev, p_op: op } }); });
      await new Promise((ok, mal) => { t.oncomplete = ok; t.onerror = () => mal(t.error); }); db.close(); return true;
    }, { abierta, L, actor: U.uid }, { plazoMs: 30000 });
    await sincronizar(d);
    const f0 = await foto(d, A);
    assert.deepEqual([f0.abierta.items.length, f0.abierta.rev, f0.abierta.presupuesto, f0.entregada.presupuesto], [4, 1, "(sin campo)", "(sin campo)"], "punto de partida: 2 del servidor + 2 locales; sin campos 3.15");

    // ── release: se aplican las migraciones 15a–15g (15b actualiza todas las órdenes una vez) ──
    const p0 = pila.peticiones.length;
    for (const f of FASES_315) pila.sql(`\\i ${path.join(SQL, `sync-${f}.sql`)}`);
    pila.sql("notify pgrst, 'reload schema'"); await espera(1500);
    const srv = () => pila.sql(`select string_agg(left(id::text, 8) || ':' || presupuesto_estado || ':rev' || rev, ',' order by id) from public.ordenes`);
    const srv0 = srv();
    assert.equal(pila.sql(`select presupuesto_estado || '|' || rev from public.ordenes where id = '${entregada}'`), "aprobado|2", "15b: la entregada queda aprobada y sube de revisión");

    // ── el dispositivo, todavía en 3.14.1, sincroniza contra el servidor migrado ──
    await sincronizar(d);
    const f1 = await foto(d, A);
    assert.equal(f1.version, "3.14.1");
    assert.deepEqual([f1.abierta.rev, f1.entregada.rev, f1.abierta.presupuesto, f1.entregada.presupuesto], [2, 2, "(sin campo)", "(sin campo)"], "O-2 (causa): 3.14.1 baja la revisión nueva SIN los campos de 3.15");
    assert.equal(f1.abierta.items.length, 2, "F-1 (comportamiento de 3.14.1, ya publicada): quita de la orden local los 2 renglones cuyas operaciones están rechazadas");
    assert.equal(f1.outbox, f0.outbox, "pero las 2 operaciones rechazadas siguen intactas en la cola");

    // ── llega 3.15.0 al mismo origen y la persona actualiza ──
    d.servir(V315);
    const aviso = await d.eval(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); let h = Date.now() + 40000; while (!reg.waiting && Date.now() < h) await new Promise((x) => setTimeout(x, 150));
      h = Date.now() + 10000; while (!document.getElementById("modalVersionNueva")?.classList.contains("active") && Date.now() < h) await new Promise((x) => setTimeout(x, 100));
      return !!reg.waiting && !!document.getElementById("modalVersionNueva")?.classList.contains("active"); }, null, { plazoMs: 70000 });
    assert.equal(aviso, true);
    await d.eval(() => { setTimeout(() => document.getElementById("btnCopiaYActualizar").click(), 50); return true; }, null, { plazoMs: 10000 });
    assert.equal(await esperarVersion(d, "3.15.0"), "3.15.0");
    const f2 = await foto(d, A);
    assert.deepEqual([f2.abierta.items.length, f2.entregada.presupuesto, f2.outbox === f0.outbox], [2, "(sin campo)", true], "actualizar la app, por sí solo, no cambia la caché");
    assert.equal(await arrancar(d), "3.15.0"); await sincronizar(d);
    const f3 = await foto(d, A);
    assert.deepEqual([f3.entregada.presupuesto, f3.abierta.presupuesto], ["aprobado", "pendiente"], "O-2: tras la relectura, cada orden tiene el estado REAL del servidor");
    assert.deepEqual(f3.abierta.items, [`${s1}|Servidor 1|1|300`, `${s2}|Servidor 2|1|110`, ...L.map((l) => `${l.uid}|${l.nombre}|${l.cantidad}|${l.precio}`)], "F-1: los 2 renglones locales vuelven a la orden, con los datos de su operación rechazada");
    assert.deepEqual([f3.abierta.rev, f3.entregada.rev], [2, 2]);
    assert.equal(f3.outbox, f0.outbox, "las rechazadas: mismas filas, mismo estado, mismos intentos");
    // más sincronizaciones, cerrar y reabrir: estable, sin duplicar
    await sincronizar(d); await espera(7000); await d.reabrir(90000); assert.equal(await esperarVersion(d, "3.15.0"), "3.15.0"); assert.equal(await arrancar(d), "3.15.0"); await sincronizar(d);
    const f4 = await foto(d, A);
    assert.deepEqual([f4.abierta, f4.entregada, f4.outbox], [f3.abierta, f3.entregada, f3.outbox]);
    // el servidor no recibió nada: ni renglones, ni reenvíos, ni revisiones nuevas
    assert.deepEqual(pila.peticiones.slice(p0).filter((x) => x.metodo !== "OPTIONS" && PROHIBIDAS.test(x.ruta)).map((x) => x.ruta), [], "ninguna RPC de renglones salió del dispositivo");
    assert.equal(pila.sql(`select count(*) || '|' || coalesce(sum(cantidad * precio), 0)::int from public.orden_items where orden_id = '${abierta}'`), "2|410");
    assert.equal(srv(), srv0, "revisiones y presupuestos del servidor sin cambio");
    assert.equal(pila.sql("select public.verificar_invariantes()::text"), "[]");
    // la pantalla de revisión dice que esas 2 respaldan un dato local
    const rev = await d.eval(async () => (await syncMotor.revision()).rechazadas.map((x) => [x.rpc, x.retieneLocal]), null, { plazoMs: 20000 });
    assert.deepEqual(rev, [["agregar_item_orden", true], ["agregar_item_orden", true]]);

    // ── PROTECCIÓN TEMPORAL (2026-10-04): lo que respalda datos que solo existen aquí NO se puede quitar; lo demás, como siempre ──
    // se añaden un crédito provisional con su `registrar_credito` rechazado (como el del teléfono; textos de prueba) y un abono rechazado
    const cred = crypto.randomUUID();
    await d.eval(async (a) => {
      const db = await new Promise((ok, mal) => { const r = indexedDB.open("entimotors_sync"); r.onsuccess = () => ok(r.result); r.onerror = () => mal(r.error); });
      const pedir = (q) => new Promise((ok, mal) => { q.onsuccess = () => ok(q.result); q.onerror = () => mal(q.error); });
      const t = db.transaction(["creditos", "mapa", "outbox", "meta"], "readwrite"), dev = (await pedir(t.objectStore("meta").get("device_id")))?.v || "dev-prueba";
      const items = [["Concepto de prueba 1", 1, 980], ["Concepto de prueba 2", 2, 300], ["Concepto de prueba 3", 1, 450], ["Concepto de prueba 4", 1, 250]];
      const id = await pedir(t.objectStore("creditos").put({ clienteNombre: "Cliente V", clienteTelefono: "", items: items.map(([nombre, cantidad, precio]) => ({ nombre, cantidad, precio })), total: 2280, abonado: 0, saldo: 2280, estado: "pendiente",
        vencimiento: null, nota: "Nota de prueba", origen: null, ordenId: null, historialAbonos: [], fechaISO: new Date().toISOString(), creadoEn: Date.now(), uid: a.cred, _rev: 0, _base: null, _pend: true }));
      t.objectStore("mapa").put({ uid: a.cred, entidad: "creditos", local_id: id });
      const base = (rpc, uid, params, i) => { const op = crypto.randomUUID(); return { op_id: op, entidad: "creditos", uid, kind: "rpc", rpc, crea: rpc === "registrar_credito", estado: "rejected", intentos: 1, siguiente_en: 0, enviando_en: Date.now() - 1000,
        actor_uid: a.actor, device_id: dev, creado_en: Date.now() - 100 + i, error: { clase: "conflicto", codigo: "23505", mensaje: "OP_ID_REUTILIZADO", http: 409 }, params: { ...params, p_device: dev, p_op: op } }; };
      t.objectStore("outbox").put(base("registrar_credito", a.cred, { p_credito_id: a.cred, p_cliente_id: a.cli, p_cliente_nombre: "Cliente V", p_cliente_telefono: "", p_items: items.map(([nombre, cantidad, precio]) => ({ item_id: crypto.randomUUID(), nombre, cantidad, precio, inventario_id: null })),
        p_nota: "Nota de prueba", p_abono_inicial: 0, p_abono_metodo: null, p_vencimiento: null, p_origen: null, p_orden_id: null, p_offline: true, p_occurred_at: new Date().toISOString() }, 0));
      t.objectStore("outbox").put(base("registrar_abono_v2", a.cred, { p_credito_id: a.cred, p_monto: 100, p_metodo: "efectivo", p_occurred_at: new Date().toISOString() }, 1));
      await new Promise((ok, mal) => { t.oncomplete = ok; t.onerror = () => mal(t.error); }); db.close(); return true;
    }, { cred, cli, actor: U.uid }, { plazoMs: 30000 });
    const disco = () => d.eval(async (c) => {
      const db = await new Promise((ok, mal) => { const r = indexedDB.open("entimotors_sync"); r.onsuccess = () => ok(r.result); r.onerror = () => mal(r.error); });
      const T = (s) => new Promise((ok, mal) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => ok(q.result); q.onerror = () => mal(q.error); });
      const r = { outbox: JSON.stringify((await T("outbox")).sort((x, y) => x.seq - y.seq)), credito: JSON.stringify((await T("creditos")).find((x) => x.uid === c)), cursores: JSON.stringify(await T("cursores")), ordenes: JSON.stringify(await T("ordenes")) }; db.close(); return r;
    }, cred, { plazoMs: 30000 });
    const g0 = await disco(), p1 = pila.peticiones.length;
    const lista = () => d.eval(async () => { await abrirRevisionSync(); const l = document.getElementById("revisionSyncLista");
      return { botones: [...l.querySelectorAll("[data-rev-descartar]")].map((b) => Number(b.dataset.revDescartar)), protegidas: [...l.querySelectorAll("[data-rev-protegida]")].map((b) => Number(b.dataset.revProtegida)),
        otros: l.querySelectorAll("button").length, texto: l.textContent, rev: (await syncMotor.revision()).rechazadas.map((x) => [x.seq, x.rpc, x.retieneLocal, x.protegida]) }; }, null, { plazoMs: 30000 });
    const l0 = await lista();
    assert.deepEqual(l0.rev.map((x) => x.slice(1)), [["agregar_item_orden", true, true], ["agregar_item_orden", true, true], ["registrar_credito", true, true], ["registrar_abono_v2", false, false]]);
    const protegidas = l0.rev.filter((x) => x[3]).map((x) => x[0]), abono = l0.rev.find((x) => x[1] === "registrar_abono_v2")[0];
    assert.deepEqual([l0.protegidas, l0.botones, l0.otros], [protegidas, [abono], 1], "la pantalla NO ofrece quitar las 3 protegidas: el único botón es el del abono");
    assert.match(l0.texto, /Se conservará aquí hasta que soporte pueda respaldarla/); assert.ok(!/sincroniz/i.test(l0.texto) && !/Concepto de prueba|Nota de prueba|Renglón local/.test(l0.texto), "sin tecnicismos ni el contenido de la operación");
    // invocación directa al motor (sin pasar por la pantalla): rechazada, y nada cambia en disco
    const directo = await d.eval(async (seqs) => { const r = []; for (const s of seqs) r.push([await syncMotor.descartarRechazadaDetalle(s), await syncMotor.descartarRechazada(s)]); return r; }, protegidas, { plazoMs: 30000 });
    assert.deepEqual(directo, protegidas.map(() => [{ ok: false, motivo: "protegida", protegida: true }, false]));
    assert.deepEqual(await disco(), g0, "cola (contenido incluido), crédito provisional, órdenes y cursores idénticos tras los intentos");
    await sincronizar(d); await espera(7000); await d.reabrir(90000); assert.equal(await esperarVersion(d, "3.15.0"), "3.15.0"); assert.equal(await arrancar(d), "3.15.0"); await sincronizar(d);
    const g1 = await disco();
    assert.deepEqual([g1.outbox, g1.credito], [g0.outbox, g0.credito], "tras sincronizar, cerrar y reabrir: las 4 rechazadas y el crédito de L 2,280 siguen idénticos");
    assert.deepEqual((await foto(d, A)).abierta.items, f3.abierta.items, "y la orden conserva sus renglones");
    assert.equal(pila.sql(`select count(*) from public.creditos where id = '${cred}'`), "0", "el crédito no aparece en la nube");
    assert.deepEqual(pila.peticiones.slice(p1).filter((x) => x.metodo !== "OPTIONS" && /\/rpc\/(registrar_credito|registrar_abono|agregar_item_orden)/.test(x.ruta)).map((x) => x.ruta), [], "sin reenvíos");
    // lo que no respalda nada (el abono) se quita como siempre desde la pantalla
    await d.eval(async (seq) => { await abrirRevisionSync(); document.querySelector(`#revisionSyncLista [data-rev-descartar="${seq}"]`).click(); await new Promise((x) => setTimeout(x, 800)); return true; }, abono, { plazoMs: 30000 });
    const l1 = await lista();
    assert.deepEqual([l1.rev.map((x) => x[0]), l1.botones, l1.protegidas], [protegidas, [], protegidas], "el abono salió de la lista; las 3 protegidas siguen, sin acción para quitarlas");
  } finally {
    await d.cerrar();
    for (const f of [...FASES_315].reverse()) pila.sql(`\\i ${path.join(SQL, `sync-${f.split("-")[0]}-rollback.sql`)}`, { tolerar: true });   // deja la base de pruebas en la cadena 3.14 para el siguiente navegador
  }
});
