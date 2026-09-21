// SYNC-3P · lógica pura del PIN: hash, política, paridad con SQL y servicio con base falsa.
import test from "node:test";
import assert from "node:assert/strict";
import { compilar } from "./helpers/compilar.mjs";

const M = await import(await compilar("api-server/src/lib/pin.ts", { falsos: [], nombre: "pin" }));
const PEPPER = "pepper-sintetico-solo-para-pruebas-0123456789";
const CFG = { ...M.configPin({}), N: 1024 };   // N pequeño: rapidez de las pruebas (el real es 32768)
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REG = "00000000-0000-4000-9000-000000000700";

test("hash: correcto, incorrecto, otro pepper, sal distinta, sin el PIN dentro", async () => {
  const h = await M.hashearPin("482913", PEPPER, CFG);
  assert.match(h, /^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!h.includes("482913"), "el hash no contiene el PIN");
  assert.equal(await M.verificarPin("482913", PEPPER, h), true);
  assert.equal(await M.verificarPin("482914", PEPPER, h), false);
  assert.equal(await M.verificarPin("482913", PEPPER + "x", h), false, "con otro pepper el hash no sirve (la base sola no basta)");
  const h2 = await M.hashearPin("482913", PEPPER, CFG);
  assert.notEqual(h, h2, "cada hash lleva su propia sal");
});

test("verificar nunca lanza: hash mal formado, PIN sin formato o tipos raros dan false", async () => {
  const h = await M.hashearPin("482913", PEPPER, CFG);
  for (const malo of [null, undefined, 42, "", "scrypt", "bcrypt$1$2$3$4$5", "scrypt$1024$8$1$AAAA$AAAA", "scrypt$abc$8$1$AAAA$AAAA", h.replace(/\$[^$]+$/, "$AAAA")])
    assert.equal(await M.verificarPin("482913", PEPPER, malo), false, String(malo));
  for (const pin of ["48291", "4829133", "48291a", "", null, 482913, "48 913", "４８２９１３"]) assert.equal(await M.verificarPin(pin, PEPPER, h), false, String(pin));
  assert.equal(await M.verificarPin("482913", PEPPER, "scrypt$1$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(43) + "="), false, "parámetros de coste absurdos se rechazan");
});

test("formato y PIN débiles", () => {
  for (const ok of ["482913", "000001".replace("000001", "580214"), "907315"]) { assert.equal(M.pinConFormato(ok), true); assert.equal(M.pinDebil(ok), false, ok); }
  for (const mal of ["12345", "1234567", "abcdef", " 12345", "12 456", 123456, null]) assert.equal(M.pinConFormato(mal), false, String(mal));
  for (const debil of ["000000", "111111", "777777", "123456", "654321", "234567", "987654", "345678", "121212", "123123", "112233", "445566", "010101"]) assert.equal(M.pinDebil(debil), true, debil);
});

test("hash crítico: idéntico al de SQL (public.sync_hash_critico) para los mismos datos", () => {
  // vectores calculados en PostgreSQL 17 con md5(accion|registro|to_char(round(monto,2),'FM999999999990.00'))
  const V = [
    ["ajustar_stock", "00000000-0000-4000-9000-000000000700", 5, "ded17153a1f22246700aca1d0cfa6c83"],
    ["reversar_venta", "00000000-0000-4000-9000-000000000701", 360.5, "bdffe3643e6cf37983254d858df62220"],
    ["anular_orden", "00000000-0000-4000-9000-000000000702", null, "0ac136247cace8a73e530875fcd80ce2"],
    ["reversar_caja", "00000000-0000-4000-9000-000000000703", 0.005, "72be7d4cba875f931b0662506ba5f355"],
    ["registrar_devolucion", "00000000-0000-4000-9000-000000000704", -3.5, "758c2e7f27879aea4164eb8f57490804"],
    ["reversar_abono", "00000000-0000-4000-9000-000000000705", 1234567.891, "f010e7076cc223cc486facbda9f2e45d"],
  ];
  for (const [a, r, m, esperado] of V) assert.equal(M.hashCritico(a, r, m), esperado, `${a} ${m}`);
  assert.equal(M.hashCritico("x", REG.toUpperCase(), 1), M.hashCritico("x", REG, 1), "el uuid se normaliza a minúsculas como en SQL");
});

test("configuración: valores de Q-6 por defecto, ajustables y acotados", () => {
  const d = M.configPin({});
  assert.deepEqual([d.ttlSegundos, d.maxFallosSolicitante, d.maxFallosGlobal, d.ventanaMin, d.bloqueoMin, d.maxBloqueos24h], [90, 5, 10, 15, 15, 3]);
  assert.equal(M.configPin({ PIN_TTL_SEGUNDOS: "120" }).ttlSegundos, 120);
  assert.equal(M.configPin({ PIN_TTL_SEGUNDOS: "99999" }).ttlSegundos, 90, "un valor fuera de rango se ignora");
  assert.equal(M.configPin({ PIN_MAX_FALLOS_SOLICITANTE: "abc" }).maxFallosSolicitante, 5);
});

test("catálogo: solo el cajero pide PIN; el mecánico y el desarrollador no tienen ninguna acción elevable", () => {
  for (const [accion, def] of Object.entries(M.ACCIONES_CON_PIN)) { assert.deepEqual(def.roles, ["cajero"], accion); assert.ok(def.entidad); }
  assert.deepEqual(Object.keys(M.ACCIONES_CON_PIN).sort(), ["ajustar_stock", "anular_orden", "registrar_devolucion", "reversar_abono", "reversar_caja", "reversar_credito", "reversar_venta"]);
});

/* ───────── servicio con una «base» falsa ───────── */
function nuevoAcceso(over = {}) {
  const e = { llamadas: [], resultados: [], guardados: [], borrados: [], desbloqueos: [], pin: null, version: 3, reservar: null, emitirError: null, ...over };
  const acceso = {
    async estado() { return { configurado: e.pin !== null, version: e.pin !== null ? e.version : null, actualizado_en: "2026-09-21T00:00:00Z", bloqueado_hasta: e.bloqueado ?? null, admin_id: uid(1) }; },
    async leerHash() { return e.pin; },
    async guardar(admin, hash, por) { e.guardados.push({ admin, hash, por }); e.pin = hash; return ++e.version; },
    async borrar(admin) { e.borrados.push(admin); e.pin = null; },
    async desbloquear(admin) { e.desbloqueos.push(admin); },
    async reservar(sol, device, accion, entidad, registro, cfg) { e.llamadas.push({ sol, device, accion, entidad, registro, cfg }); return e.reservar ? e.reservar() : { permitido: true, admin_id: uid(1), pin_version: e.version, hash: e.pin, intentos_restantes: 4 }; },
    async resultado(sol, device, accion, entidad, registro, res) { e.resultados.push({ sol, device, accion, entidad, registro, res }); },
    async emitir(sol, admin, accion, entidad, registro, device, version, payloadHash, ttl) {
      e.emitido = { sol, admin, accion, entidad, registro, device, version, payloadHash, ttl };
      if (e.emitirError) throw new Error(e.emitirError);
      return { autorizacion_id: "aut-0001", expira_en: "2026-09-21T00:01:30Z" };
    },
  };
  return { acceso, e };
}
const cajero = { id: uid(2), rol: "cajero", nombre: "Caja", activo: true, correo: "caja@example.test" };
const admin = { id: uid(1), rol: "admin", nombre: "Admin", activo: true, correo: "admin@example.test" };
async function servicio(over = {}, claveOk = true) {
  const { acceso, e } = nuevoAcceso(over);
  e.pin = over.pin === undefined ? await M.hashearPin("482913", PEPPER, CFG) : over.pin;
  const svc = M.crearServicioPin({ acceso, pepper: PEPPER, cfg: CFG, verificarClaveCuenta: async (c, k) => claveOk && k === "clave-correcta" });
  return { svc, e };
}
const cuerpo = (extra = {}) => ({ accion: "ajustar_stock", entidad: "inventario", registro_id: REG, device_id: "dev-1", pin: "482913", ...extra });

test("autorizar: PIN correcto → 201 con autorización de un solo uso, TTL 90, ligada a usuario/acción/registro/dispositivo/versión", async () => {
  const { svc, e } = await servicio();
  const r = await svc.autorizar(cajero, cuerpo({ monto: 5 }));
  assert.equal(r.status, 201);
  assert.deepEqual(r.cuerpo, { autorizacion_id: "aut-0001", expira_en: "2026-09-21T00:01:30Z", ttl_segundos: 90 });
  assert.deepEqual([e.emitido.sol.id, e.emitido.admin, e.emitido.accion, e.emitido.entidad, e.emitido.registro, e.emitido.device, e.emitido.version, e.emitido.ttl], [uid(2), uid(1), "ajustar_stock", "inventario", REG, "dev-1", 3, 90]);
  assert.equal(e.emitido.payloadHash, M.hashCritico("ajustar_stock", REG, 5), "ligada al monto crítico");
  assert.deepEqual(e.resultados.map((x) => x.res), ["ok"], "el éxito queda registrado");
  assert.equal(e.llamadas[0].cfg.maxFallosSolicitante, 5);
});

test("autorizar sin monto: la autorización no se liga a un monto (payloadHash nulo)", async () => {
  const { svc, e } = await servicio();
  assert.equal((await svc.autorizar(cajero, cuerpo())).status, 201);
  assert.equal(e.emitido.payloadHash, null);
});

test("autorizar: PIN incorrecto → 401, se registra el fallo y NO se emite nada", async () => {
  const { svc, e } = await servicio();
  const r = await svc.autorizar(cajero, cuerpo({ pin: "111112" }));
  assert.equal(r.status, 401); assert.equal(r.cuerpo.codigo, "PIN_INCORRECTO"); assert.equal(r.cuerpo.intentos_restantes, 4);
  assert.deepEqual(e.resultados.map((x) => x.res), ["pin_incorrecto"]);
  assert.equal(e.emitido, undefined);
});

test("autorizar: bloqueos → 429 con Retry-After, 423 si lo bloqueó el admin, y el PIN ni se verifica", async () => {
  let r; const { svc, e } = await servicio();
  e.reservar = () => ({ permitido: false, motivo: "bloqueado_solicitante", reintentar_en_s: 840 });
  r = await svc.autorizar(cajero, cuerpo());
  assert.equal(r.status, 429); assert.equal(r.cabeceras["Retry-After"], "840"); assert.equal(r.cuerpo.reintentar_en_s, 840); assert.equal(r.cuerpo.codigo, "BLOQUEADO_SOLICITANTE");
  e.reservar = () => ({ permitido: false, motivo: "bloqueado_global", reintentar_en_s: 900 });
  assert.equal((await svc.autorizar(cajero, cuerpo())).cuerpo.codigo, "BLOQUEADO_GLOBAL");
  e.reservar = () => ({ permitido: false, motivo: "bloqueado_admin" });
  r = await svc.autorizar(cajero, cuerpo()); assert.equal(r.status, 423); assert.equal(r.cuerpo.codigo, "BLOQUEADO_ADMIN");
  e.reservar = () => ({ permitido: false, motivo: "sin_pin" }); assert.equal((await svc.autorizar(cajero, cuerpo())).status, 409);
  e.reservar = () => ({ permitido: false, motivo: "cuenta_inactiva" }); assert.equal((await svc.autorizar(cajero, cuerpo())).status, 403);
  assert.deepEqual(e.resultados, [], "un intento bloqueado no registra resultado ni verifica el PIN");
});

test("autorizar: mecánico, desarrollador y roles raros → 403 SIN llegar a probar el PIN; el admin no lo necesita", async () => {
  const { svc, e } = await servicio();
  for (const rol of ["mecanico", "desarrollador", "superadmin", ""]) {
    const r = await svc.autorizar({ ...cajero, rol }, cuerpo());
    assert.equal(r.status, 403, rol); assert.equal(r.cuerpo.codigo, "NO_PERMITIDO");
  }
  assert.equal(e.llamadas.length, 0, "no se reservó ningún intento: no pueden adivinar el PIN");
  assert.ok(e.resultados.every((x) => x.res === "no_permitido") && e.resultados.length === 4, "queda constancia de cada intento no permitido");
  const r = await svc.autorizar(admin, cuerpo());
  assert.equal(r.status, 400); assert.equal(r.cuerpo.codigo, "ADMIN_NO_NECESITA_PIN");
  assert.equal((await svc.autorizar({ ...cajero, activo: false }, cuerpo())).status, 403);
});

test("autorizar: entradas inválidas se rechazan antes de tocar la base (no consumen intentos)", async () => {
  const { svc, e } = await servicio();
  const casos = [
    [{ accion: "borrar_todo" }, "ACCION_DESCONOCIDA"], [{ accion: "__proto__" }, "ACCION_DESCONOCIDA"], [{ accion: "constructor" }, "ACCION_DESCONOCIDA"],
    [{ entidad: "ventas" }, "ENTIDAD_INVALIDA"], [{ registro_id: "no-es-uuid" }, "REGISTRO_INVALIDO"], [{ registro_id: undefined }, "REGISTRO_INVALIDO"],
    [{ device_id: "x".repeat(101) }, "DISPOSITIVO_INVALIDO"], [{ device_id: 5 }, "DISPOSITIVO_INVALIDO"],
    [{ monto: "5" }, "MONTO_INVALIDO"], [{ monto: NaN }, "MONTO_INVALIDO"], [{ monto: 1e12 }, "MONTO_INVALIDO"],
    [{ pin: "12345" }, "PIN_INVALIDO"], [{ pin: "abcdef" }, "PIN_INVALIDO"], [{ pin: 482913 }, "PIN_INVALIDO"], [{ pin: undefined }, "PIN_INVALIDO"],
  ];
  for (const [extra, codigo] of casos) { const r = await svc.autorizar(cajero, cuerpo(extra)); assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.cuerpo.codigo, codigo, JSON.stringify(extra)); }
  assert.equal(e.llamadas.length, 0);
});

test("autorizar: si el PIN cambió mientras se verificaba → 409 y no hay autorización", async () => {
  const { svc, e } = await servicio(); e.emitirError = "PIN_CAMBIADO: el PIN cambió mientras se verificaba";
  const r = await svc.autorizar(cajero, cuerpo()); assert.equal(r.status, 409); assert.equal(r.cuerpo.codigo, "PIN_CAMBIADO");
  e.emitirError = "conexión perdida"; await assert.rejects(() => svc.autorizar(cajero, cuerpo()), /conexión perdida/);
});

test("el PIN no aparece en NINGUNA salida ni llamada a la base (solo lo que el propio cliente mandó)", async () => {
  const { svc, e } = await servicio();
  const salidas = [await svc.autorizar(cajero, cuerpo()), await svc.autorizar(cajero, cuerpo({ pin: "111112" })), await svc.estado(),
    await svc.establecer(admin, { pin_nuevo: "739205", clave_cuenta: "clave-correcta" })];
  const todo = JSON.stringify({ salidas, llamadas: e.llamadas, resultados: e.resultados, emitido: e.emitido, guardados: e.guardados });
  for (const pin of ["482913", "111112", "739205"]) assert.ok(!todo.includes(pin), `el PIN ${pin} no debe aparecer`);
  assert.ok(!todo.includes("clave-correcta"));
});

test("estado: informa si hay PIN y el bloqueo, sin hash", async () => {
  const { svc, e } = await servicio();
  let r = await svc.estado(); assert.deepEqual([r.cuerpo.configurado, r.cuerpo.version, r.cuerpo.bloqueado], [true, 3, false]); assert.ok(!("hash" in r.cuerpo));
  e.bloqueado = "infinity"; assert.equal((await svc.estado()).cuerpo.bloqueado, true);
  e.bloqueado = new Date(Date.now() + 60000).toISOString(); assert.equal((await svc.estado()).cuerpo.bloqueado, true);
  e.bloqueado = new Date(Date.now() - 60000).toISOString(); assert.equal((await svc.estado()).cuerpo.bloqueado, false);
  e.pin = null; assert.equal((await svc.estado()).cuerpo.configurado, false);
});

test("establecer PIN: exige 6 dígitos, rechaza los fáciles y pide re-autenticación", async () => {
  const { svc, e } = await servicio();
  for (const pin of ["12345", "abcdef", 123456, undefined]) assert.equal((await svc.establecer(admin, { pin_nuevo: pin, clave_cuenta: "clave-correcta" })).cuerpo.codigo, "PIN_INVALIDO");
  for (const pin of ["000000", "123456", "111111", "654321"]) assert.equal((await svc.establecer(admin, { pin_nuevo: pin, clave_cuenta: "clave-correcta" })).cuerpo.codigo, "PIN_DEBIL");
  assert.equal((await svc.establecer(admin, { pin_nuevo: "739205" })).cuerpo.codigo, "REAUTENTICACION_REQUERIDA");
  assert.equal((await svc.establecer(admin, { pin_nuevo: "739205", clave_cuenta: "otra" })).cuerpo.codigo, "CLAVE_INCORRECTA");
  assert.equal(e.guardados.length, 0);
  const r = await svc.establecer(admin, { pin_nuevo: "739205", clave_cuenta: "clave-correcta" });
  assert.equal(r.status, 200); assert.deepEqual(r.cuerpo, { ok: true, version: 4 });
  assert.match(e.guardados[0].hash, /^scrypt\$/); assert.ok(!e.guardados[0].hash.includes("739205"));
  assert.equal(await M.verificarPin("739205", PEPPER, e.guardados[0].hash), true, "lo guardado verifica el PIN nuevo");
});

test("cambiar el PIN con el PIN actual pasa por el límite de intentos; primera vez solo con la contraseña", async () => {
  const { svc, e } = await servicio();
  let r = await svc.establecer(admin, { pin_nuevo: "739205", pin_actual: "000009" });
  assert.equal(r.status, 401); assert.equal(r.cuerpo.codigo, "PIN_INCORRECTO"); assert.equal(e.llamadas.length, 1, "el intento cuenta para el límite");
  r = await svc.establecer(admin, { pin_nuevo: "739205", pin_actual: "482913" });
  assert.equal(r.status, 200); assert.deepEqual(e.resultados.map((x) => x.res), ["pin_incorrecto", "ok"]);
  const s2 = await servicio({ pin: null });
  assert.equal((await s2.svc.establecer(admin, { pin_nuevo: "739205", pin_actual: "482913" })).cuerpo.codigo, "REAUTENTICACION_REQUERIDA", "sin PIN previo no hay «PIN actual»");
  assert.equal((await s2.svc.establecer(admin, { pin_nuevo: "739205", clave_cuenta: "clave-correcta" })).status, 200);
});

test("eliminar PIN (fail-closed) y desbloquear", async () => {
  const { svc, e } = await servicio();
  assert.equal((await svc.eliminar(admin, {})).cuerpo.codigo, "REAUTENTICACION_REQUERIDA");
  assert.equal(e.borrados.length, 0);
  assert.equal((await svc.eliminar(admin, { clave_cuenta: "clave-correcta" })).status, 200);
  assert.deepEqual(e.borrados, [uid(1)]);
  assert.deepEqual((await svc.eliminar(admin, {})).cuerpo, { ok: true, configurado: false }, "sin PIN, eliminar es un no-op");
  await svc.desbloquear(admin); assert.deepEqual(e.desbloqueos, [uid(1)]);
});
