// SYNC-7B · clasificación HTTP REAL (sección 5): qué status devuelve PostgREST de verdad para cada SQLSTATE que
// consumen las RPC de dinero, y qué hace con él el cliente real (taller-demo/sync-rest.js cargado tal cual, con
// fetch real contra el gateway local). No se asume la tabla de PostgREST: se mide. Sin navegador (Node + pila real).
//   node --test pruebas/sync/browser/sync7b-http.test.mjs          (requiere pruebas/sync/entorno-local.sh up y Docker)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { iniciarPila, PERFILES, RAIZ, PG } from "./lib/pila.mjs";

let pila, rest;
const id = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
before(async () => {
  pila = await iniciarPila();
  const ctx = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, Promise, JSON, Math, Date, URLSearchParams });
  vm.runInContext(fs.readFileSync(path.join(RAIZ, "taller-demo/sync-rest.js"), "utf8"), ctx);
  rest = (quien) => ctx.SyncRest.crear({ baseUrl: pila.REST_URL, anonKey: "anon-sintetica", getToken: () => pila.jwt(PERFILES[quien]) });
  pila.sql(`insert into public.inventario (id, nombre, precio_venta, costo_compra) values ('${id(901)}', 'HTTP', 10, 5);
            insert into public.inventario_movimientos (inventario_id, tipo, cantidad) values ('${id(901)}', 'apertura', 1);`);
});
after(async () => { await pila?.detener(); });

const item = (n, cant) => [{ inventario_id: id(n), nombre: "HTTP", cantidad: cant, precio: 10 }];
const venta = (op, items, extra = {}) => ({ p_op: op, p_cliente_id: null, p_cliente_nombre: "x", p_metodo_pago: "efectivo", p_efectivo: 0, p_items: items, ...extra });

test("23514 (sin stock online) → HTTP 400 → validacion: terminal", async () => {
  const r = await rest("cajero").rpc("registrar_venta_v2", venta(id(950), item(901, 5)));
  assert.deepEqual([r.ok, r.status, r.codigo, r.clase], [false, 400, "23514", "validacion"]);
});
test("23503 (la referencia no existe) → HTTP 409 → conflicto: terminal", async () => {
  const r = await rest("cajero").rpc("registrar_abono_v2", { p_op: id(951), p_credito_id: id(999), p_monto: 1, p_metodo: "efectivo" });
  assert.deepEqual([r.ok, r.status, r.codigo, r.clase], [false, 409, "23503", "conflicto"]);
});
test("22000 (ya anulada/ya finalizada) → HTTP 400 → validacion; 22023 (datos inválidos) → 400", async () => {
  const c = rest("admin");
  const ok = await c.rpc("registrar_venta_v2", venta(id(952), item(901, 1)));
  assert.equal(ok.ok, true);
  const v = ok.datos.venta_id;
  assert.equal((await c.rpc("reversar_venta", { p_op: id(953), p_venta_id: v, p_motivo: "prueba http" })).ok, true);
  const r = await c.rpc("reversar_venta", { p_op: id(954), p_venta_id: v, p_motivo: "otra vez" });
  assert.deepEqual([r.status, r.codigo, r.clase], [400, "22000", "validacion"]);
  const r2 = await c.rpc("registrar_venta_v2", venta(id(955), []));
  assert.deepEqual([r2.status, r2.codigo, r2.clase], [400, "22023", "validacion"]);
});
test("23505 (operation_id reutilizado con otros datos) → HTTP 409 → conflicto", async () => {
  const r = await rest("admin").rpc("registrar_venta_v2", venta(id(952), item(901, 1), { p_metodo_pago: "tarjeta" }));
  assert.deepEqual([r.status, r.codigo, r.clase], [409, "23505", "conflicto"]);
});
test("42501 (rol sin permiso / AUTORIZACION_REQUERIDA) → HTTP 403 → permiso", async () => {
  const r = await rest("mecanico").rpc("registrar_venta_v2", venta(id(956), item(901, 1)));
  assert.deepEqual([r.status, r.codigo, r.clase], [403, "42501", "permiso"]);
  const r2 = await rest("cajero").rpc("ajustar_stock", { p_op: id(957), p_inventario_id: id(901), p_motivo: "sin pin", p_delta: 1 });
  assert.deepEqual([r2.status, r2.codigo, r2.clase], [403, "42501", "permiso"]);
});
test("temporal REAL: 55P03 lock_timeout (fila bloqueada por otra sesión) → HTTP 5xx → servidor: SÍ reintentable, y nada se escribió", async () => {
  // solo en la base local de pruebas (t_e2e se destruye al final); PostgREST aplica los ajustes del rol que suplanta
  // desde su caché de esquema, así que se recarga explícitamente
  pila.sql(`alter role authenticated set lock_timeout = '800ms'; notify pgrst, 'reload schema';`);
  await new Promise((r) => setTimeout(r, 1500));
  const bloqueo = spawn("psql", ["-X", "-q", "-h", PG.host, "-p", String(PG.port), "-U", "supabase_admin", "-d", "t_e2e",
    "-c", `begin; select 1 from public.inventario where id = '${id(901)}' for update; select pg_sleep(6); commit;`], { env: { ...process.env, PGPASSWORD: "postgres" } });
  const terminado = new Promise((r) => bloqueo.on("exit", r));
  try {
    await new Promise((r) => setTimeout(r, 1200));
    const r = await rest("admin").rpc("ajustar_stock", { p_op: id(958), p_inventario_id: id(901), p_motivo: "conteo bloqueado", p_delta: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.status >= 500, "status real " + r.status);
    assert.equal(r.codigo, "55P03");
    assert.equal(r.clase, "servidor", "temporal de verdad → el outbox la conserva y la reintenta");
    assert.equal(pila.sql(`select count(*) from public.sync_ops where op_id = '${id(958)}'`), "0", "la transacción se revirtió entera");
  } finally {
    await terminado;
    pila.sql(`alter role authenticated reset lock_timeout; notify pgrst, 'reload schema';`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  // el MISMO op_id, ya sin bloqueo, entra UNA vez
  const r2 = await rest("admin").rpc("ajustar_stock", { p_op: id(958), p_inventario_id: id(901), p_motivo: "conteo bloqueado", p_delta: 1 });
  assert.equal(r2.ok, true);
  assert.equal(pila.sql(`select count(*) from public.inventario_movimientos where op_id = '${id(958)}'`), "1");
});
