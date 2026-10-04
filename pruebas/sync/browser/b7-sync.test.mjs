// 3.15.0 · BLOQUE 7 · RENDIMIENTO DE LA SINCRONIZACIÓN con sus garantías (app real, Chromium y Firefox).
//   · cola de 1 / 10 / 100 / 500 operaciones hechas SIN red (cliente + su moto: padre → hijo) → vuelve la red → todo llega UNA vez, con la
//     moto ligada a SU cliente; tiempo, peticiones por operación; un segundo ciclo no reenvía nada; 3 «sincronizar» a la vez no duplican.
//   · descarga pequeña (1 cambio) y grande (3 000 movimientos nuevos en el servidor) sobre un dispositivo ya al día.
//   B7_RAIZ / B7_ETIQUETA / B7_SALIDA como las demás pruebas del Bloque 7. B7_COLA=1,10,100,500
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";
import { sembrarVolumen } from "./lib/volumen.mjs";
import { prepararSesion, anotar } from "./lib/medir.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
const RAIZ = process.env.B7_RAIZ ? process.env.B7_RAIZ + "/taller-demo" : null;
const ETQ = process.env.B7_ETIQUETA || "despues";
const SALIDA = process.env.B7_SALIDA || null;
const COLAS = (process.env.B7_COLA || "1,10,100,500").split(",").map(Number);
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });
const metodos = (p0) => pila.peticiones.slice(p0).filter((x) => x.metodo !== "OPTIONS").reduce((m, x) => { const k = x.metodo === "GET" ? "GET" : x.ruta.includes("/rpc/") ? "RPC" : x.metodo; m[k] = (m[k] || 0) + 1; return m; }, {});

async function abrir(nav) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b7s-${nav}`, pagina: "index.html", real: true, raiz: RAIZ });
  await prepararSesion(d, pila.jwt(PERFILES.admin, { segundos: 7200 }));
  await d.eval(async (a) => {
    const real = window.fetch.bind(window);
    window.fetch = (u, i) => (String(u?.url || u).indexOf(window.ENTIMOTORS_SUPABASE.url) === 0 && window.__sinRed ? Promise.reject(new TypeError("Failed to fetch")) : real(u, i));
    await startApp({ uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null });
    if (window.esperarDescargaArranque) await esperarDescargaArranque();
    syncMotor.detener();   // sin ciclo periódico: la prueba decide cuándo se sincroniza
    return true;
  }, { id: PERFILES.admin }, { plazoMs: 180000 });
  return d;
}

for (const nav of NAVS) {
  test(`COLA SIN RED → RECONEXIÓN · ${nav} · ${ETQ}`, async () => {
    const R = {};
    for (const n of COLAS) {
      sembrarVolumen(pila, "actual");
      const d = await abrir(nav);
      try {
        const loc = await d.eval(async (n) => {
          window.__sinRed = true;
          const t0 = performance.now();
          for (let i = 0; i < n; i++) {
            const c = await DB.save("clientes", { nombre: `B7 cola ${n}-${i}`, telefono: String(i) });
            await DB.save("motos", { clienteId: c, marca: "B7", modelo: "cola", placa: `B7${n}-${i}` });
          }
          return { escritura_local_ms: Math.round(performance.now() - t0), pendientes: (await syncBd.outbox.todos()).filter((x) => x.estado === "pending").length };
        }, n, { plazoMs: 600000 });
        const p0 = pila.peticiones.length;
        const env = await d.eval(async () => {
          window.__sinRed = false;
          const t0 = performance.now();
          // tres «sincronizar» a la vez (volver la red + un aviso + el ciclo): el candado deja UN envío
          await Promise.all([syncMotor.sincronizar(), syncMotor.sincronizar(), syncMotor.sincronizar()]);
          const h = Date.now() + 600000;
          while (Date.now() < h) { if (!(await syncBd.outbox.todos()).some((x) => x.estado === "pending" || x.estado === "syncing")) break; await syncMotor.sincronizar(); }
          return { hasta_confirmado_ms: Math.round(performance.now() - t0), rechazadas: (await syncBd.outbox.todos()).filter((x) => x.estado === "rejected").length };
        }, null, { plazoMs: 700000 });
        const pet = metodos(p0);
        const p1 = pila.peticiones.length;
        await d.eval(async () => { await syncMotor.sincronizar(); return true; }, null, { plazoMs: 60000 });
        const reenvio = metodos(p1);
        const srv = pila.sql(`select count(*) filter (where c.nombre like 'B7 cola ${n}-%') || '|' || count(distinct c.nombre) filter (where c.nombre like 'B7 cola ${n}-%') || '|' ||
          (select count(*) from public.motos m join public.clientes cc on cc.id = m.cliente_id where m.placa like 'B7${n}-%' and replace(m.placa, 'B7${n}-', '') = replace(cc.nombre, 'B7 cola ${n}-', ''))
          from public.clientes c`).split("|").map(Number);
        R[n] = { ...loc, ...env, peticiones: pet, peticiones_por_operacion: Math.round(((pet.POST || 0) + (pet.PATCH || 0) + (pet.RPC || 0)) / (2 * n) * 100) / 100, segundo_ciclo_escrituras: (reenvio.POST || 0) + (reenvio.PATCH || 0) + (reenvio.RPC || 0),
          servidor: { clientes: srv[0], distintos: srv[1], motos_con_su_cliente: srv[2] } };
        assert.equal(loc.pendientes, 2 * n, `${n}: sin red, ${2 * n} operaciones en cola`);
        assert.equal(env.rechazadas, 0, `${n}: nada rechazado`);
        assert.deepEqual(R[n].servidor, { clientes: n, distintos: n, motos_con_su_cliente: n }, `${n}: todo llegó UNA vez y cada moto con SU cliente`);
        assert.equal(R[n].segundo_ciclo_escrituras, 0, `${n}: un segundo ciclo no reenvía lo ya confirmado`);
      } finally { await d.cerrar(); }
    }
    anotar(SALIDA, `${ETQ}|${nav}|sync-cola`, R);
  });

  test(`DESCARGA pequeña y grande sobre un dispositivo al día · ${nav} · ${ETQ}`, async () => {
    sembrarVolumen(pila, "actual");
    const d = await abrir(nav);
    try {
      const R = {};
      let p0 = pila.peticiones.length;
      R.sin_cambios = await d.eval(async () => { const t = performance.now(); await syncMotor.pullTodo(); return { ms: Math.round(performance.now() - t) }; }, null, { plazoMs: 120000 });
      R.sin_cambios.peticiones = metodos(p0);
      await new Promise((r) => setTimeout(r, 1500));   // fuera del solapamiento de 60 s no hace falta: basta con que lo nuevo sea posterior
      pila.sql(`insert into public.clientes (nombre, telefono) values ('B7 pull pequeño', '1')`);
      p0 = pila.peticiones.length;
      R.pequena = await d.eval(async () => { const t = performance.now(); await syncMotor.pullTodo(); return { ms: Math.round(performance.now() - t), llego: (await DB.getAll("clientes")).some((c) => c.nombre === "B7 pull pequeño") }; }, null, { plazoMs: 120000 });
      R.pequena.peticiones = metodos(p0);
      pila.sql(`set session_replication_role = replica; insert into public.caja_movimientos (tipo, categoria, monto, metodo_pago, descripcion, occurred_at)
        select 'ingreso', 'Venta mostrador', 100, 'efectivo', 'grande ' || g, now() - (g % 30) * interval '1 day' from generate_series(1, 3000) g; reset session_replication_role;`);
      p0 = pila.peticiones.length;
      R.grande = await d.eval(async () => { const t = performance.now(); await syncMotor.pullTodo(); return { ms: Math.round(performance.now() - t), caja: (await DB.getAll("caja_movimientos")).length }; }, null, { plazoMs: 600000 });
      R.grande.peticiones = metodos(p0);
      R.grande.kb = Math.round(pila.peticiones.slice(p0).reduce((s, x) => s + (x.bytes || 0), 0) / 1024);
      anotar(SALIDA, `${ETQ}|${nav}|sync-descarga`, R);
      assert.ok(R.pequena.llego, "el cambio pequeño llegó");
      assert.ok(R.grande.caja >= 3000, "los 3 000 movimientos llegaron");
    } finally { await d.cerrar(); }
  });
}
