// SYNC-4 · piezas PURAS del cliente de sincronización (taller-demo/sync-rest.js y sync-engine.js), sin navegador:
// clasificación de errores, consultas, paginación por cursor, refresco de sesión, fusión de tres vías, esperas y guardas de seguridad.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leer = (f) => fs.readFileSync(path.join(RAIZ, "taller-demo", f), "utf8");
function cargar(extra = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, AbortController, Date, Promise, JSON, Math, ...extra });
  for (const f of ["sync-rest.js", "sync-db.js", "sync-engine.js"]) vm.runInContext(leer(f), ctx, { filename: f });
  return ctx;
}
const J = (x) => JSON.parse(JSON.stringify(x));      // deepEqual sin depender de los prototipos del contexto vm
const ctx0 = cargar();
const { clasificar, construirQuery, condicionCursor, restarMs } = ctx0.SyncRest;
const P = ctx0.SyncEngine.puras;

test("clasificar: cada respuesta de error cae en la clase que decide qué hace la cola", () => {
  const casos = [[401, { code: "PGRST301", message: "JWT expired" }, "auth"], [403, { code: "42501", message: "rls" }, "permiso"], [400, { code: "42501" }, "permiso"],
    [409, { code: "23505" }, "conflicto"], [409, { code: "23503" }, "conflicto"], [404, { code: "PGRST202" }, "esquema"], [404, { code: "PGRST205" }, "esquema"], [404, null, "esquema"],
    [429, null, "limite"], [500, null, "servidor"], [503, null, "servidor"], [504, null, "servidor"], [408, null, "servidor"], [400, { code: "23502" }, "validacion"], [400, { code: "P0001", message: "x" }, "validacion"], [422, null, "validacion"]];
  for (const [st, body, esperado] of casos) assert.equal(clasificar(st, body).clase, esperado, `${st} ${JSON.stringify(body)}`);
  assert.equal(clasificar(400, { code: "P0001", message: "Stock insuficiente" }).mensaje, "Stock insuficiente");
  assert.equal(clasificar(500, "texto plano").clase, "servidor", "un cuerpo que no es JSON no rompe");
});

test("clasificar: SYNC-7 sección 2 — 22000 (clase 22, la reemplazante de 55000) cae en validacion (terminal, no se reintenta)", () => {
  // sync-3-rpc.sql cambió sus 14 validaciones terminales (ya anulado/cerrado/finalizado/revertido) de ERRCODE
  // 55000 a 22000 porque PostgREST mapea la clase 55 a HTTP 500 (confirmado en SYNC-6) y este cliente clasifica
  // CUALQUIER 5xx como "servidor" (reintentable) — ver flush() en sync-engine.js: "validacion" y "conflicto" son
  // las únicas clases que NO se reintentan. Este caso documenta el patrón correcto (400) y el bug histórico (500)
  // para que nadie vuelva a usar 55000 en una validación terminal sin darse cuenta de la consecuencia.
  assert.equal(clasificar(400, { code: "22000", message: "La orden ya está cerrada: no admite más ítems" }).clase, "validacion");
  assert.equal(clasificar(400, { code: "22000", message: "La venta ya está anulada" }).clase, "validacion");
  // documentado a propósito: 55000 a status 500 SIGUE cayendo en "servidor" (reintentable) — es exactamente el bug
  // que sync-3-rpc.sql dejó de usar. Si esta aserción alguna vez fallara sería porque PostgREST cambió su mapeo,
  // no porque el cliente se haya "arreglado solo": conviene revisar sync-3-rpc.sql de nuevo en ese caso.
  assert.equal(clasificar(500, { code: "55000", message: "cualquier cosa" }).clase, "servidor");
});

test("SYNC-7 · flush(): las clases 'validacion' y 'conflicto' se rechazan sin reintentar; 'servidor'/'red'/'limite'/'esquema'/'auth' sí se conservan para reintentar", () => {
  const codigo = leer("sync-engine.js");
  const m = codigo.match(/if \(k === "permiso" \|\| k === "validacion" \|\| k === "conflicto"\) \{[\s\S]{0,40}\/\/ no se arregla reintentando/);
  assert.ok(m, "flush() debe seguir tratando 'validacion' y 'conflicto' como terminales (no reintentables) igual que 'permiso'");
});

test("construirQuery codifica todo (incluido el + de los husos horarios) y respeta el orden", () => {
  assert.equal(construirQuery({ select: "*", filtros: [["id", "eq", "a b"], ["rev", "eq", 3]], orden: "updated_at.asc,id.asc", limite: 500 }), "?select=*&id=eq.a%20b&rev=eq.3&order=updated_at.asc%2Cid.asc&limit=500".replace("select=*", "select=*"));
  const c = condicionCursor({ t: "2026-09-21T23:12:30.123456+00:00", id: "u1" });
  assert.equal(c, "(updated_at.gt.2026-09-21T23:12:30.123456+00:00,and(updated_at.eq.2026-09-21T23:12:30.123456+00:00,id.gt.u1))");
  assert.ok(construirQuery({ or: c }).includes("%2B00%3A00"), "el + no puede viajar sin codificar (sería un espacio)");
  assert.equal(construirQuery({}), "");
});

test("restarMs solo ENSANCHA la ventana: nunca redondea hacia adelante", () => {
  assert.equal(restarMs("2026-09-21T23:12:30.999999+00:00", 60000), "2026-09-21T23:11:30.999Z");
  assert.ok(new Date(restarMs("2026-09-21T23:12:30.123456+00:00", 0)) <= new Date("2026-09-21T23:12:30.123456+00:00"));
  assert.equal(restarMs("no es fecha", 1000), null);
});

/** Servidor falso: responde según una función y registra las peticiones. */
function servidor(responder) {
  const reg = [];
  const fetch = async (url, init) => {
    const u = new URL(url); const i = { m: init.method, ruta: u.pathname, q: Object.fromEntries(u.searchParams), h: init.headers, cuerpo: init.body ? JSON.parse(init.body) : undefined };
    reg.push(i);
    const r = await responder(i, reg.length);
    return { status: r.status ?? 200, headers: { get: (k) => (r.h || {})[k.toLowerCase()] ?? null }, text: async () => (r.cuerpo === undefined ? "" : typeof r.cuerpo === "string" ? r.cuerpo : JSON.stringify(r.cuerpo)) };
  };
  return { fetch, reg };
}
const cliente = (srv, extra = {}) => { const ctx = cargar({ fetch: srv.fetch }); return ctx.SyncRest.crear({ baseUrl: "https://x.example.test/", anonKey: "ANON", getToken: async () => "TOKEN-1", fetch: srv.fetch, ...extra }); };
const fila = (n, t) => ({ id: `id-${String(n).padStart(3, "0")}`, updated_at: t || `2026-09-21T10:00:${String(n).padStart(2, "0")}.${n}+00:00`, rev: 1 });

test("paginar: sigue hasta una página VACÍA aunque el servidor recorte, usa solapamiento solo en la primera y cursor exacto después", async () => {
  const filas = [1, 2, 3, 4, 5].map((n) => fila(n));
  let sirvio = 0;
  const srv = servidor((p) => { if (p.q.limit !== "10") return { status: 400 }; const r = filas.slice(sirvio, sirvio + 2); sirvio += r.length; return { cuerpo: r }; });   // el servidor da 2 por respuesta aunque se pidan 10
  const vistas = [];
  const r = await cliente(srv).paginar("clientes", { cursor: { t: "2026-09-21T10:00:00.000000+00:00", id: "id-000" }, pagina: 10, onPagina: async (f, c) => { vistas.push(...f.map((x) => x.id)); } });
  assert.equal(r.ok, true); assert.equal(r.completo, true); assert.equal(r.total, 5); assert.deepEqual(vistas, filas.map((x) => x.id));
  assert.deepEqual(J(r.cursor), { t: filas[4].updated_at, id: filas[4].id }, "el cursor conserva el texto EXACTO del servidor");
  assert.equal(srv.reg.length, 4, "3 páginas con datos + 1 vacía");
  assert.ok(srv.reg[0].q["updated_at"].startsWith("gte."), "la primera pide con solapamiento");
  assert.ok(!srv.reg[0].q.or); assert.ok(srv.reg[1].q.or.startsWith("(updated_at.gt."), "las siguientes usan el cursor exacto"); assert.ok(!srv.reg[1].q["updated_at"]);
  assert.equal(srv.reg[0].q.order, "updated_at.asc,id.asc");
  assert.equal(srv.reg[0].h.Authorization, "Bearer TOKEN-1"); assert.equal(srv.reg[0].h.apikey, "ANON");
});

test("paginar: onPagina devolviendo false detiene la descarga y maxPaginas la acota sin fingir que terminó", async () => {
  const srv = servidor(() => ({ cuerpo: [fila(1)] }));
  const a = await cliente(srv).paginar("clientes", { onPagina: () => false });
  assert.equal(a.detenido, true); assert.equal(a.completo, false); assert.equal(srv.reg.length, 1);
  const srv2 = servidor((p, n) => ({ cuerpo: [fila(n)] }));
  const b = await cliente(srv2).paginar("clientes", { maxPaginas: 3 });
  assert.equal(b.completo, false); assert.equal(srv2.reg.length, 3);
});

test("paginar sin cursor (primera vez) no usa solapamiento ni filtro de tiempo", async () => {
  const srv = servidor((p, n) => ({ cuerpo: n === 1 ? [fila(1)] : [] }));
  await cliente(srv).paginar("clientes", {});
  assert.ok(!srv.reg[0].q.or && !srv.reg[0].q.updated_at);
});

test("un 401 se refresca UNA vez y se reintenta; sin refresco posible → clase auth; el token nuevo se usa", async () => {
  let refrescos = 0, token = "VIEJO";
  const srv = servidor((p) => (p.h.Authorization === "Bearer NUEVO" ? { cuerpo: [{ ok: 1 }] } : { status: 401, cuerpo: { code: "PGRST301", message: "JWT expired" } }));
  const c = cliente(srv, { getToken: async () => token, refrescar: async () => { refrescos++; token = "NUEVO"; return true; } });
  const r = await c.seleccionar("clientes"); assert.equal(r.ok, true); assert.equal(refrescos, 1); assert.equal(srv.reg.length, 2);
  const srv2 = servidor(() => ({ status: 401, cuerpo: { code: "PGRST301" } }));
  const c2 = cliente(srv2, { refrescar: async () => true });
  const r2 = await c2.seleccionar("clientes"); assert.equal(r2.ok, false); assert.equal(r2.clase, "auth"); assert.equal(srv2.reg.length, 2, "solo UN reintento, no un bucle");
  const c3 = cliente(servidor(() => ({ status: 401 })), { refrescar: async () => false });
  assert.equal((await c3.seleccionar("clientes")).clase, "auth");
  const c4 = cliente(servidor(() => ({ status: 401 })), { refrescar: async () => { throw new Error("boom"); } });
  assert.equal((await c4.seleccionar("clientes")).clase, "auth", "un refresco que revienta no rompe la cola");
});

test("los fallos de red y los tiempos agotados son clase «red» y NUNCA lanzan; un getToken que revienta tampoco", async () => {
  const c = cliente({ fetch: async () => { throw new TypeError("Failed to fetch"); } }, { fetch: async () => { throw new TypeError("Failed to fetch"); } });
  const r = await c.insertar("clientes", [{ a: 1 }]); assert.equal(r.ok, false); assert.equal(r.clase, "red"); assert.equal(r.codigo, "SIN_RED");
  const lento = cliente({}, { timeoutMs: 20, fetch: (u, i) => new Promise((ok, mal) => { i.signal.addEventListener("abort", () => { const e = new Error("abortado"); e.name = "AbortError"; mal(e); }); }) });
  const r2 = await lento.seleccionar("clientes"); assert.equal(r2.clase, "red"); assert.equal(r2.codigo, "TIMEOUT");
  const srv = servidor(() => ({ cuerpo: [] }));
  const c3 = cliente(srv, { getToken: async () => { throw new Error("sin sesión"); } });
  assert.equal((await c3.seleccionar("clientes")).ok, true, "sin token la petición sale sin Authorization (la nube decidirá)");
  assert.equal(srv.reg[0].h.Authorization, undefined);
});

test("errores de servidor y límites: clase, código de Postgres y Retry-After; el token no aparece en los resultados", async () => {
  const srv = servidor(() => ({ status: 429, h: { "retry-after": "12" }, cuerpo: { message: "Too many" } }));
  const r = await cliente(srv).rpc("registrar_abono_v2", { p: 1 }); assert.equal(r.clase, "limite"); assert.equal(r.reintentarEnS, 12);
  const s2 = servidor(() => ({ status: 400, cuerpo: { code: "P0001", message: "Stock insuficiente", details: "d", hint: "h" } }));
  const r2 = await cliente(s2).rpc("x", {}); assert.deepEqual(J({ c: r2.clase, k: r2.codigo, m: r2.mensaje }), { c: "validacion", k: "P0001", m: "Stock insuficiente" });
  assert.ok(!JSON.stringify(r).includes("TOKEN-1") && !JSON.stringify(r2).includes("TOKEN-1"));
  assert.equal(s2.reg[0].ruta, "/rest/v1/rpc/x");
});

test("insertar idempotente y PATCH condicionado usan las cabeceras Prefer correctas", async () => {
  const srv = servidor(() => ({ cuerpo: [] }));
  const c = cliente(srv);
  await c.insertar("clientes", [{ id: "a" }], { ignorarDuplicados: true });
  await c.modificar("clientes", [["id", "eq", "a"], ["rev", "eq", 4]], { nombre: "x" });
  assert.equal(srv.reg[0].h.Prefer, "return=representation,resolution=ignore-duplicates"); assert.equal(srv.reg[0].m, "POST");
  assert.equal(srv.reg[1].m, "PATCH"); assert.equal(srv.reg[1].h.Prefer, "return=representation"); assert.equal(srv.reg[1].q.rev, "eq.4"); assert.deepEqual(J(srv.reg[1].cuerpo), { nombre: "x" });
});

test("fusionar (tres vías): cambios en campos distintos se combinan; el mismo campo distinto es conflicto; igual en ambos no es nada", () => {
  const base = { nombre: "A", tel: "1", nota: null };
  assert.deepEqual(J(P.fusionar(base, { tel: "2" }, { nombre: "B", tel: "1", nota: null })), { fusion: { tel: "2" }, conflictos: [] });
  assert.deepEqual(J(P.fusionar(base, { nombre: "C" }, { nombre: "B", tel: "1", nota: null })), { fusion: {}, conflictos: ["nombre"] });
  assert.deepEqual(J(P.fusionar(base, { nombre: "B" }, { nombre: "B", tel: "1", nota: null })), { fusion: {}, conflictos: [] }, "el servidor ya tiene lo mío");
  assert.deepEqual(J(P.fusionar(base, { nombre: "C", tel: "9" }, { nombre: "B", tel: "1", nota: null })), { fusion: { tel: "9" }, conflictos: ["nombre"] });
  assert.deepEqual(J(P.fusionar(null, { nombre: "C" }, { nombre: "B" })), { fusion: {}, conflictos: ["nombre"] });
  assert.deepEqual(J(P.fusionar({ j: { a: 1, b: 2 } }, { j: { b: 2, a: 1 } }, { j: { a: 1, b: 2 } })), { fusion: {}, conflictos: [] }, "comparación de JSON independiente del orden de claves");
});

test("diferencias y estable: undefined = null; objetos por contenido", () => {
  assert.deepEqual(J(P.diferencias({ a: 1, b: null }, { a: 1, b: null, c: undefined })), {});
  assert.deepEqual(J(P.diferencias({ a: 1 }, { a: 2, b: 3 })), { a: 2, b: 3 });
  assert.deepEqual(J(P.diferencias(null, { a: 1 })), { a: 1 });
  assert.equal(P.estable({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
});

test("esperaMs: 2 s, 4 s, 8 s… con tope de 5 min y variación acotada", () => {
  const con = (n, a) => P.esperaMs(n, a);
  assert.equal(con(1, 0.5), 2000); assert.equal(con(2, 0.5), 4000); assert.equal(con(3, 0.5), 8000); assert.equal(con(10, 0.5), 300000); assert.equal(con(99, 0.5), 300000);
  for (let n = 1; n < 12; n++) for (const a of [0, 0.5, 1]) { const v = con(n, a), b = Math.min(2000 * 2 ** (n - 1), 300000); assert.ok(v >= b * 0.75 - 1 && v <= b * 1.25 + 1, `${n} ${a} ${v}`); }
  for (let n = 1; n < 8; n++) assert.ok(con(n + 1, 0.5) >= con(n, 0.5));
});

test("compararTiempo: microsegundos, ceros finales, husos y formatos sin fracción se ordenan como tiempo, no como texto", () => {
  const t = P.compararTiempo;
  assert.equal(t("2026-09-21T10:00:00.12+00:00", "2026-09-21T10:00:00.123456+00:00"), -1);
  assert.equal(t("2026-09-21T10:00:00.9+00:00", "2026-09-21T10:00:00.12+00:00"), 1);
  assert.equal(t("2026-09-21T10:00:00+00:00", "2026-09-21T10:00:00.000000+00:00"), 0);
  assert.equal(t("2026-09-21T10:00:00.123456Z", "2026-09-21T10:00:00.123456+00:00"), 0);
  assert.equal(t("2026-09-21T10:00:00.1234567+00:00", "2026-09-21T10:00:00.123456+00:00"), 0, "más de 6 decimales se truncan");
  assert.equal(t("2026-09-22T00:00:00+00:00", "2026-09-21T23:59:59.999999+00:00"), 1);
  assert.equal(P.compararCursor({ t: "2026-09-21T10:00:00+00:00", id: "b" }, { t: "2026-09-21T10:00:00.000000+00:00", id: "a" }), 1, "a igual tiempo desempata el id");
});

test("verificarSinPin: las siete acciones con PIN y cualquier dato de autorización, a cualquier profundidad, se rechazan", () => {
  for (const a of P.ACCIONES_CON_PIN) assert.throws(() => P.verificarSinPin(a, {}), /PIN/);
  assert.equal(P.ACCIONES_CON_PIN.length, 7);
  for (const k of ["pin", "PIN", "pin_nuevo", "pin_actual", "clave_cuenta", "autorizacion_id", "p_autorizacion_id", "admin_pin"]) {
    assert.throws(() => P.verificarSinPin("registrar_credito", { [k]: "x" }), /autorización/, k);
    assert.throws(() => P.verificarSinPin("registrar_credito", { a: { b: { c: { [k]: "x" } } } }), /autorización/, `profundo ${k}`);
  }
  assert.doesNotThrow(() => P.verificarSinPin("registrar_venta_v2", { p_items: [{ id: 1, cantidad: 2 }], p_monto: 5, p_op_id: "x" }));
});

/* ---------------- SYNC-7: rpcInmediato (motor) — las acciones con PIN nunca se encolan (verificarSinPin
   las rechaza en encolarRpc), así que necesitan una llamada directa que NO pase por el outbox. ---------------- */
function motorFalso(o = {}) {
  const llamadasRpc = [];
  const rest = { rpc: async (nombre, params) => { llamadasRpc.push({ nombre, params }); return o.respuestaRpc || { ok: true, datos: { ok: true } }; } };
  const motor = ctx0.SyncEngine.crearMotor({
    bd: {}, rest, mappers: {}, uuid: o.uuid || (() => "op-fijo-de-prueba"),
    sesion: o.sesion || (() => ({ uid: "u1" })), habilitado: o.habilitado || (() => true),
  });
  return { motor, llamadasRpc };
}

test("rpcInmediato: llama la RPC AHORA (nunca por la cola), inyecta p_op y devuelve el resultado tal cual", async () => {
  const { motor, llamadasRpc } = motorFalso({ respuestaRpc: { ok: true, datos: { reverso_id: "r1" } } });
  const r = await motor.rpcInmediato("reversar_venta", { p_venta_id: "v1", p_motivo: "cliente se arrepintió", p_autorizacion: "auth-1" });
  assert.equal(llamadasRpc.length, 1);
  assert.equal(llamadasRpc[0].nombre, "reversar_venta");
  assert.equal(llamadasRpc[0].params.p_op, "op-fijo-de-prueba", "p_op (no p_op_id) es la clave de idempotencia que lee sync_op_iniciar");
  assert.equal(llamadasRpc[0].params.p_venta_id, "v1");
  assert.equal(llamadasRpc[0].params.p_autorizacion, "auth-1");
  assert.equal(r.ok, true);
  assert.equal(r.op_id, "op-fijo-de-prueba");
  assert.deepEqual(r.datos, { reverso_id: "r1" });
});

test("rpcInmediato: sin sesión no llama a la red; devuelve clase auth", async () => {
  const { motor, llamadasRpc } = motorFalso({ sesion: () => null });
  const r = await motor.rpcInmediato("reversar_caja", { p_caja_id: "c1" });
  assert.equal(r.ok, false);
  assert.equal(r.clase, "auth");
  assert.equal(llamadasRpc.length, 0);
});

test("rpcInmediato: motor apagado (sin ENTIMOTORS_SYNC.enabled) no llama a la red", async () => {
  const { motor, llamadasRpc } = motorFalso({ habilitado: () => false });
  const r = await motor.rpcInmediato("ajustar_stock", { p_inventario_id: "i1" });
  assert.equal(r.ok, false);
  assert.equal(llamadasRpc.length, 0);
});

test("guardas estáticas de los tres módulos: sin claves de servidor, sin almacenamiento del navegador para credenciales, sin registrar tokens", () => {
  for (const f of ["sync-rest.js", "sync-db.js", "sync-engine.js"]) {
    const t = leer(f);
    assert.ok(!/service_role|sb_secret_|SERVICE_KEY/i.test(t), `${f}: nada de claves de servidor`);
    assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(t), `${f}: no toca localStorage/sessionStorage/cookies`);
    assert.ok(!/console\.(log|info|warn|error|debug)/.test(t), `${f}: no escribe en consola (podría filtrar tokens o datos)`);
    assert.ok(!/eval\(|new Function\(|innerHTML/.test(t), `${f}: sin eval ni innerHTML`);
  }
  assert.ok(!/entimotors_os_demo/.test(leer("sync-db.js").replace(/^\s*\*.*$/gm, "")), "el código de sync no abre la base de siempre");
});
