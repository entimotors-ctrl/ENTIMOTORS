// SYNC-7B · PIN ADMINISTRATIVO REAL (secciones 8, 14, 16): api-server de verdad (compilado desde api-server/src,
// lib/api-local.mjs) + PostgREST/Postgres reales + el shim de auth SOLO de pruebas del gateway local (pila.mjs).
// Nada del backend se debilita: mismos límites por defecto (5 por solicitante, 10 globales en 15 min, bloqueo 15 min,
// 3er bloqueo en 24 h → desbloqueo manual), mismo scrypt. El paso del tiempo se simula moviendo hacia atrás los sellos
// en la base LOCAL de pruebas (con los triggers apagados solo en esa sentencia), nunca cambiando la lógica.
//   node --test --test-concurrency=1 pruebas/sync/browser/sync7b-pin.test.mjs   (requiere entorno-local.sh up y Docker)
import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { iniciarPila, PERFILES, CLAVE_CUENTA_PRUEBA, CIERRES } from "./lib/pila.mjs";
import { iniciarApi, llamar } from "./lib/api-local.mjs";

const PIN = "482915";
const id = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const CAJ = { c2: "00000000-0000-4000-8000-000000000012", c3: "00000000-0000-4000-8000-000000000013", c4: "00000000-0000-4000-8000-000000000014" };
let pila, api;

before(async () => {
  pila = await iniciarPila();
  pila.sql(`set session_replication_role = replica;
    insert into auth.users (id, email) values ('${CAJ.c2}','c2@example.test'),('${CAJ.c3}','c3@example.test'),('${CAJ.c4}','c4@example.test') on conflict do nothing;
    insert into public.perfiles (id, nombre, rol, activo) values ('${CAJ.c2}','Caja 2','cajero',true),('${CAJ.c3}','Caja 3','cajero',true),('${CAJ.c4}','Caja 4','cajero',true)
      on conflict (id) do update set rol = 'cajero', activo = true;
    reset session_replication_role;
    insert into public.inventario (id, nombre, precio_venta, costo_compra) values ('${id(801)}', 'Repuesto PIN', 100, 60);
    insert into public.inventario_movimientos (inventario_id, tipo, cantidad) values ('${id(801)}', 'apertura', 50);`);
  api = await iniciarApi(pila);
});
after(async () => { await api?.detener(); await pila?.detener(); });

async function rpc(sub, nombre, params) {
  const r = await fetch(`${pila.REST_URL}/rest/v1/rpc/${nombre}`, { method: "POST", headers: { apikey: "anon-sintetica", Authorization: "Bearer " + pila.jwt(sub), "Content-Type": "application/json" }, body: JSON.stringify(params) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, datos: d };
}
async function venta(n, cant = 1) {
  const r = await rpc(PERFILES.cajero, "registrar_venta_v2", { p_op: crypto.randomUUID(), p_cliente_id: null, p_cliente_nombre: "PIN", p_metodo_pago: "efectivo", p_efectivo: 0,
    p_items: [{ item_id: id(n), inventario_id: id(801), nombre: "Repuesto PIN", cantidad: cant, precio: 100 }], p_device: "dev-A" });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  return { venta: r.datos.venta_id, item: id(n), total: Number(r.datos.total) };
}
const pedir = (sub, cuerpo) => llamar(pila, api, "POST", "/api/autorizaciones", { sub, cuerpo: { device_id: "dev-A", pin: PIN, ...cuerpo } });
const desplazarReloj = (min) => pila.sql(`set session_replication_role = replica;
  update public.admin_pin_intentos set creado_en = creado_en - interval '${min} minutes';
  update public.admin_pin set actualizado_en = actualizado_en - interval '${min} minutes';
  reset session_replication_role;`);

describe("SYNC-7B · PIN real (api-server real + PostgREST real)", () => {
  test("shim de auth: un token firmado con OTRO secreto no pasa (401 SESION_INVALIDA); sin token → 401", async () => {
    const [h, p] = pila.jwt(PERFILES.cajero).split(".");
    const falso = `${h}.${p}.${crypto.createHmac("sha256", "otro-secreto").update(`${h}.${p}`).digest("base64url")}`;
    const r = await llamar(pila, api, "POST", "/api/autorizaciones", { token: falso, cuerpo: { accion: "reversar_venta" } });
    assert.equal(r.status, 401); assert.equal(r.datos.codigo, "SESION_INVALIDA");
    assert.equal((await llamar(pila, api, "POST", "/api/autorizaciones", { cuerpo: {} })).status, 401);
  });

  test("admin configura el PIN por la ruta real (re-autenticación por contraseña de cuenta); la clave mala se rechaza", async () => {
    const antes = CIERRES.length;
    const mal = await llamar(pila, api, "PUT", "/api/admin/pin", { sub: PERFILES.admin, cuerpo: { pin_nuevo: PIN, clave_cuenta: "otra" } });
    assert.equal(mal.status, 401); assert.equal(mal.datos.codigo, "CLAVE_INCORRECTA");
    assert.equal(CIERRES.length, antes, "SECURITY-1B: con la clave mala no hay sesión temporal que cerrar");
    const ok = await llamar(pila, api, "PUT", "/api/admin/pin", { sub: PERFILES.admin, cuerpo: { pin_nuevo: PIN, clave_cuenta: CLAVE_CUENTA_PRUEBA } });
    assert.equal(ok.status, 200, JSON.stringify(ok.datos));
    assert.deepEqual(CIERRES.slice(antes), [{ scope: "local", sub: PERFILES.admin }], "SECURITY-1B: la sesión temporal se cierra una vez, con scope=local");
    assert.ok(!pila.sql(`select hash from public.admin_pin`).includes(PIN), "el PIN nunca se guarda en claro");
    assert.equal((await llamar(pila, api, "PUT", "/api/admin/pin", { sub: PERFILES.cajero, cuerpo: { pin_nuevo: "739164", clave_cuenta: CLAVE_CUENTA_PRUEBA } })).status, 403, "solo el admin");
  });

  test("PIN correcto → autorización (TTL 90 s, ligada a solicitante/acción/registro/dispositivo/monto) → el reverso se aplica", async () => {
    const v = await venta(1);
    const a = await pedir(PERFILES.cajero, { accion: "reversar_venta", entidad: "ventas", registro_id: v.venta, monto: v.total });
    assert.equal(a.status, 201, JSON.stringify(a.datos));
    const [fila] = JSON.parse(pila.sql(`select coalesce(json_agg(t),'[]') from (select extract(epoch from expira_en - creado_en)::int ttl, device_id, solicitante_id, registro_id, payload_hash is not null hash from public.autorizaciones_admin where id = '${a.datos.autorizacion_id}') t`));
    assert.deepEqual(fila, { ttl: 90, device_id: "dev-A", solicitante_id: PERFILES.cajero, registro_id: v.venta, hash: true });
    const r = await rpc(PERFILES.cajero, "reversar_venta", { p_op: crypto.randomUUID(), p_venta_id: v.venta, p_motivo: "cliente devolvió", p_autorizacion: a.datos.autorizacion_id, p_device: "dev-A" });
    assert.equal(r.status, 200, JSON.stringify(r.datos));
    assert.equal(pila.sql(`select anulada from public.ventas where id = '${v.venta}'`), "t");
    assert.equal(pila.sql(`select count(*) from public.auditoria where accion = 'autorizacion' and resultado = 'emitida' and entidad_id = '${v.venta}'`), "1");
  });

  test("PIN incorrecto → 401 PIN_INCORRECTO con intentos restantes; no emite nada", async () => {
    const v = await venta(2);
    const antes = pila.sql(`select count(*) from public.autorizaciones_admin`);
    const r = await pedir(PERFILES.cajero, { accion: "reversar_venta", entidad: "ventas", registro_id: v.venta, monto: v.total, pin: "907315" });
    assert.equal(r.status, 401); assert.equal(r.datos.codigo, "PIN_INCORRECTO"); assert.equal(typeof r.datos.intentos_restantes, "number");
    assert.equal(pila.sql(`select count(*) from public.autorizaciones_admin`), antes);
    assert.ok(!JSON.stringify(r.datos).includes("907315"));
  });

  test("la autorización NO sirve: desde otro dispositivo, para otra acción, para otro registro, caducada, ni reutilizada", async () => {
    const v = await venta(3, 3), w = await venta(4);
    const emitir = async (extra) => (await pedir(PERFILES.cajero, { accion: "registrar_devolucion", entidad: "ventas", registro_id: v.venta, monto: 100, ...extra })).datos.autorizacion_id;
    const devolver = (aut, dev = "dev-A", venta_id = v.venta, item = v.item) => rpc(PERFILES.cajero, "registrar_devolucion",
      { p_op: crypto.randomUUID(), p_venta_id: venta_id, p_items: [{ venta_item_id: item, cantidad: 1 }], p_motivo: "prueba pin", p_autorizacion: aut, p_device: dev });
    const esInvalida = (r) => r.status === 403 && /AUTORIZACION_INVALIDA/.test(JSON.stringify(r.datos));

    assert.ok(esInvalida(await devolver(await emitir(), "dev-B")), "otro dispositivo");
    const aOtra = (await pedir(PERFILES.cajero, { accion: "reversar_venta", entidad: "ventas", registro_id: v.venta, monto: v.total })).datos.autorizacion_id;
    assert.ok(esInvalida(await devolver(aOtra)), "otra acción");
    assert.ok(esInvalida(await devolver(await emitir(), "dev-A", w.venta, w.item)), "otro registro");
    const aVieja = await emitir();
    pila.sql(`set session_replication_role = replica; update public.autorizaciones_admin set creado_en = creado_en - interval '91 seconds', expira_en = expira_en - interval '91 seconds' where id = '${aVieja}'; reset session_replication_role;`);
    assert.ok(esInvalida(await devolver(aVieja)), "caducada (90 s cumplidos)");
    const aBuena = await emitir();
    assert.equal((await devolver(aBuena)).status, 200, "la buena sí");
    assert.ok(esInvalida(await devolver(aBuena)), "reutilizada");
    assert.equal(pila.sql(`select count(*) from public.reversos where registro_id = '${v.venta}' and tipo = 'devolucion'`), "1", "una sola devolución entró");
  });

  test("usuario inactivo, mecánico y admin: nunca obtienen elevación por PIN", async () => {
    const v = await venta(5);
    const cuerpo = { accion: "reversar_venta", entidad: "ventas", registro_id: v.venta, monto: v.total };
    pila.sql(`update public.perfiles set activo = false where id = '${PERFILES.cajero}'`);
    try {
      const r = await pedir(PERFILES.cajero, cuerpo);
      assert.equal(r.status, 403); assert.equal(r.datos.codigo, "CUENTA_INACTIVA");
    } finally { pila.sql(`update public.perfiles set activo = true where id = '${PERFILES.cajero}'`); }
    const m = await pedir(PERFILES.mecanico, cuerpo);
    assert.equal(m.status, 403); assert.equal(m.datos.codigo, "NO_PERMITIDO");
    const ad = await pedir(PERFILES.admin, cuerpo);
    assert.equal(ad.datos.codigo, "ADMIN_NO_NECESITA_PIN");
    const x = await rpc(PERFILES.mecanico, "reversar_venta", { p_op: crypto.randomUUID(), p_venta_id: v.venta, p_motivo: "intento", p_autorizacion: null });
    assert.equal(x.status, 403);
  });

  test("RATE LIMIT solicitante: 5 fallos → 6º bloqueado 15 min (aun con el PIN correcto); otro cajero sigue pudiendo", async () => {
    await llamar(pila, api, "POST", "/api/admin/pin/desbloquear", { sub: PERFILES.admin });   // contadores a cero para esta prueba
    const v = await venta(6);
    const c = { accion: "reversar_venta", entidad: "ventas", registro_id: v.venta, monto: v.total };
    for (let i = 0; i < 5; i++) {
      const r = await pedir(PERFILES.cajero, { ...c, pin: "907315" });
      assert.equal(r.datos.codigo, "PIN_INCORRECTO", "intento " + (i + 1));
      assert.equal(r.datos.intentos_restantes, 4 - i);
    }
    const b = await pedir(PERFILES.cajero, c);
    assert.equal(b.status, 429); assert.equal(b.datos.codigo, "BLOQUEADO_SOLICITANTE");
    assert.ok(b.datos.reintentar_en_s > 880 && b.datos.reintentar_en_s <= 900, "15 min: " + b.datos.reintentar_en_s);
    assert.equal(b.cabeceras.get("retry-after"), String(b.datos.reintentar_en_s));
    assert.equal((await pedir(CAJ.c2, c)).status, 201, "el bloqueo es por solicitante");
    desplazarReloj(16);
    assert.equal((await pedir(PERFILES.cajero, c)).status, 201, "pasados 15 min vuelve a poder");
  });

  test("RATE LIMIT global: 10 fallos entre varios cajeros en 15 min → bloqueo global; 3er bloqueo en 24 h → solo el admin desbloquea", async () => {
    await llamar(pila, api, "POST", "/api/admin/pin/desbloquear", { sub: PERFILES.admin });
    const v = await venta(7);
    const c = { accion: "reversar_venta", entidad: "ventas", registro_id: v.venta, monto: v.total };
    const fallar = async (sub, n) => { for (let i = 0; i < n; i++) assert.equal((await pedir(sub, { ...c, pin: "907315" })).datos.codigo, "PIN_INCORRECTO"); };
    await fallar(CAJ.c2, 4); await fallar(CAJ.c3, 4); await fallar(CAJ.c4, 2);          // 10 fallos, nadie llegó a 5
    const g = await pedir(PERFILES.cajero, c);                                        // un cajero SIN fallos, con el PIN correcto
    assert.equal(g.status, 429); assert.equal(g.datos.codigo, "BLOQUEADO_GLOBAL");     // bloqueo nº 1
    desplazarReloj(16);
    await fallar(CAJ.c2, 5);
    assert.equal((await pedir(CAJ.c2, c)).datos.codigo, "BLOQUEADO_SOLICITANTE");      // bloqueo nº 2
    desplazarReloj(16);
    await fallar(CAJ.c3, 5);
    const t = await pedir(CAJ.c3, c);                                                  // bloqueo nº 3 en 24 h
    assert.equal(t.status, 423); assert.equal(t.datos.codigo, "BLOQUEADO_ADMIN");
    desplazarReloj(60);
    const sigue = await pedir(CAJ.c4, c);
    assert.equal(sigue.datos.codigo, "BLOQUEADO_ADMIN", "no caduca solo: requiere al administrador");
    assert.equal((await llamar(pila, api, "POST", "/api/admin/pin/desbloquear", { sub: PERFILES.cajero })).status, 403, "el cajero no se desbloquea a sí mismo");
    assert.equal((await llamar(pila, api, "POST", "/api/admin/pin/desbloquear", { sub: PERFILES.admin })).status, 200);
    assert.equal((await pedir(CAJ.c4, c)).status, 201, "tras el desbloqueo del admin, vuelve a funcionar");
  });

  test("ni el PIN ni el pepper aparecen en los registros del backend", async () => {
    assert.ok(!api.salida().includes(PIN) && !api.salida().includes("907315"));
    assert.equal(pila.sql(`select count(*) from public.auditoria where detalle like '%${PIN}%'`), "0");
  });
});
