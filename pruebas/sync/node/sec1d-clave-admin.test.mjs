// SECURITY-1D · cambio de contraseña del admin: lib/clave-admin.ts y lib/clave-cuenta.ts REALES (compilados), con dependencias falsas
// que registran el ORDEN de las llamadas. Canarios aleatorios por corrida: jamás deben aparecer en respuestas, logs, auditoría ni en
// los argumentos de reservar/resolver. El comportamiento contra GoTrue real está en pruebas/sync/gotrue/sec1d-cambio-clave.test.mjs.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { compilar } from "./helpers/compilar.mjs";

const M = await import(await compilar("api-server/src/lib/clave-admin.ts", { falsos: [], nombre: "clave-admin" }));
const V = await import(await compilar("api-server/src/lib/clave-cuenta.ts", { falsos: [], nombre: "clave-cuenta-1d" }));
const ADMIN = { id: "00000000-0000-4000-8000-000000000001", correo: "gerente.taller@example.test", nombre: "Rosa Mejía" };
const ACTUAL = `Actual-${crypto.randomBytes(6).toString("hex")} frase`;
const NUEVA = `nube ${crypto.randomBytes(6).toString("hex")} volcán marzo`;
const TOKEN_S1 = `S1.${crypto.randomBytes(8).toString("hex")}.firma`;
const CUERPO = () => ({ clave_actual: ACTUAL, clave_nueva: NUEVA, clave_confirmacion: NUEVA });
const SECRETOS = [ACTUAL, NUEVA, TOKEN_S1];

/* ───────── política (pura) ───────── */
describe("SECURITY-1D · política de la contraseña nueva", () => {
  const ctx = { actual: "otra-cosa-distinta", nombre: "Rosa Mejía", correo: "gerente.taller@example.test" };
  const debil = (p) => assert.deepEqual(M.politicaClave(p, ctx), { ok: false, codigo: "CLAVE_DEBIL" }, JSON.stringify(p));
  test("acepta frases con espacios, sin exigir mayúsculas/números/símbolos, de 12 caracteres a 72 bytes", () => {
    for (const p of ["caballo correcto bateria", "nube lenta de marzo", "tres pájaros azules", "x".repeat(0) + "q7!mZ2@pL9#w"]) assert.deepEqual(M.politicaClave(p, ctx), { ok: true }, p);
    assert.deepEqual(M.politicaClave("ñandú rápido café", ctx), { ok: true }, "caracteres no ASCII");
  });
  test("longitud: <12 caracteres o >72 bytes UTF-8 → débil (72 bytes exactos sí vale)", () => {
    debil("nube lenta1"); debil("ñ".repeat(37)); debil("azul marino y verde oliva en la cumbre de la sierra al amanecer de marzo!!!");
    assert.equal(Buffer.byteLength("k".repeat(35) + " " + "m".repeat(36)), 72); assert.deepEqual(M.politicaClave("kq".repeat(18) + " " + "mz".repeat(17) + "w", ctx), { ok: true });
  });
  test("igual a la actual → CLAVE_IGUAL_A_LA_ACTUAL", () => assert.deepEqual(M.politicaClave("frase secreta larga", { ...ctx, actual: "frase secreta larga" }), { ok: false, codigo: "CLAVE_IGUAL_A_LA_ACTUAL" }));
  test("no puede contener «entimotors», el nombre del perfil ni el usuario del correo (sin importar mayúsculas, tildes ni espacios)", () => {
    debil("Mi EntiMotors del alma"); debil("ENTI MOTORS es lo mejor"); debil("rosamejia en el taller"); debil("hola MEJIA querida amiga"); debil("soy GERENTE.TALLER siempre");
  });
  test("sin falsos positivos por juntar palabras: «tres pájaros azules» NO contiene «Rosa» (pajaROSAzules)", () => {
    assert.deepEqual(M.politicaClave("tres pájaros azules", ctx), { ok: true });
    debil("pájaro Rosa azul del monte");                                                   // «rosa» como palabra: sí
  });
  test("comunes de la lista local y patrones triviales / repetidos / secuenciales → débil", () => {
    for (const p of ["password1234", "Contraseña123", "123456789012", "qwerty123456", "aaaaaaaaaaaa", "abababababab", "abcabcabcabc", "abcdefghijkl", "987654321098", "123412341234"]) debil(p);
  });
  test("nunca devuelve la contraseña", () => assert.ok(!JSON.stringify(M.politicaClave("password1234", ctx)).includes("password1234")));
});

/* ───────── comprobador de la contraseña actual (clave-cuenta) ───────── */
describe("SECURITY-1D · comprobar la contraseña actual: clasificación sin castigar al proveedor", () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const T = `${b64({ alg: "HS256" })}.${b64({ session_id: "00000000-0000-4000-a000-000000000001" })}.f`;
  const comprobador = (resp) => { const llamadas = []; const f = async (u, i) => { llamadas.push(String(u)); if (String(u).includes("/logout")) return { ok: true, status: 204, json: async () => null }; return resp(); };
    return { c: V.crearVerificadorClaveCuenta({ url: "https://x.example.test", anon: "anon", fetch: f, log: { warn() {} }, esperaReintentoMs: 1 }), llamadas }; };
  for (const [nombre, resp, esperado, cierres] of [
    ["200 con token y misma identidad", () => ({ ok: true, status: 200, json: async () => ({ access_token: T, user: { id: ADMIN.id, email: ADMIN.correo } }) }), "ok", 1],
    ["400 invalid_credentials", () => ({ ok: false, status: 400, json: async () => ({ error_code: "invalid_credentials" }) }), "incorrecta", 0],
    ["429 del proveedor", () => ({ ok: false, status: 429, json: async () => ({}) }), "no_disponible", 0],
    ["503 del proveedor", () => ({ ok: false, status: 503, json: async () => ({}) }), "no_disponible", 0],
    ["red caída", () => { throw new Error("ECONNRESET"); }, "no_disponible", 0],
    ["200 sin token", () => ({ ok: true, status: 200, json: async () => ({}) }), "no_disponible", 0],
    ["200 de OTRA cuenta", () => ({ ok: true, status: 200, json: async () => ({ access_token: T, user: { id: "otro", email: ADMIN.correo } }) }), "identidad_distinta", 1],
  ]) test(`${nombre} → ${esperado} (cierres de la temporal: ${cierres})`, async () => {
    const { c, llamadas } = comprobador(resp);
    assert.equal(await c.comprobar(ADMIN, ACTUAL), esperado);
    assert.equal(llamadas.filter((u) => u.endsWith("/auth/v1/logout?scope=local")).length, cierres);
    assert.equal(await c(ADMIN, ACTUAL), esperado === "ok", "la función booleana del PIN sigue igual");
  });
});

/* ───────── adaptador GoTrue: cambio (una sola vez) y cierre de las demás ───────── */
describe("SECURITY-1D · GoTrue: PUT /auth/v1/user con S1 y logout?scope=others", () => {
  const g = (resp) => { const ll = []; const f = async (u, i) => { ll.push({ u: String(u), m: i.method, auth: i.headers.Authorization, cuerpo: i.body }); return resp(ll.length); };
    return { gt: M.crearGotrueClave({ url: "https://x.example.test", anon: "anon", fetch: f, log: { info() {}, warn() {}, error() {} }, esperaReintentoMs: 1 }), ll }; };
  const r = (status, j = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => j });
  for (const [nombre, resp, esperado] of [
    ["200", () => r(200, { id: "x" }), "ok"], ["422 weak_password", () => r(422, { error_code: "weak_password" }), "debil"], ["422 same_password", () => r(422, { error_code: "same_password" }), "igual"],
    ["400 validation_failed (73 bytes)", () => r(400, { error_code: "validation_failed" }), "debil"], ["400 reauthentication_needed", () => r(400, { error_code: "reauthentication_needed" }), "reautenticar"],
    ["401", () => r(401), "sesion_invalida"], ["403 session_not_found", () => r(403, { error_code: "session_not_found" }), "sesion_invalida"],
    ["429", () => r(429), "no_aplicado"], ["500", () => r(500), "desconocido"], ["red/timeout", () => { throw new Error("timeout"); }, "desconocido"],
  ]) test(`cambiar: ${nombre} → ${esperado}; SIEMPRE una sola petición PUT con el token de S1`, async () => {
    const { gt, ll } = g(resp);
    assert.equal(await gt.cambiar(TOKEN_S1, NUEVA), esperado);
    assert.equal(ll.length, 1, "nunca se reintenta un cambio de contraseña");
    assert.deepEqual([ll[0].u, ll[0].m, ll[0].auth], ["https://x.example.test/auth/v1/user", "PUT", `Bearer ${TOKEN_S1}`]);
  });
  test("cerrarOtras: scope=others con S1; 204 → true; 5xx/red → un reintento; 4xx → false sin reintento", async () => {
    let x = g(() => r(204)); assert.equal(await x.gt.cerrarOtras(TOKEN_S1), true); assert.deepEqual(x.ll.map((l) => [l.u, l.auth]), [["https://x.example.test/auth/v1/logout?scope=others", `Bearer ${TOKEN_S1}`]]);
    x = g((n) => (n === 1 ? r(503) : r(204))); assert.equal(await x.gt.cerrarOtras(TOKEN_S1), true); assert.equal(x.ll.length, 2);
    x = g(() => { throw new Error("red"); }); assert.equal(await x.gt.cerrarOtras(TOKEN_S1), false); assert.equal(x.ll.length, 2);
    x = g(() => r(403)); assert.equal(await x.gt.cerrarOtras(TOKEN_S1), false); assert.equal(x.ll.length, 1);
    for (const l of [...x.ll]) assert.doesNotMatch(l.u, /scope=(global|local)|logout$/);
  });
});

/* ───────── servicio: orden, respuestas y fallos parciales ───────── */
function montar(o = {}) {
  const orden = [], logs = [], auditoria = [], resoluciones = [];
  let nIntento = 40;
  const dep = {
    comprobar: async (admin, clave) => { orden.push("comprobar"); assert.deepEqual(admin, { id: ADMIN.id, correo: ADMIN.correo }); assert.equal(clave, ACTUAL); return o.comprobar ?? "ok"; },
    cambiar: async (tok, nueva) => { orden.push("cambiar"); assert.equal(tok, TOKEN_S1, "se cambia con S1"); assert.equal(nueva, NUEVA); return o.cambiar ?? "ok"; },
    cerrarOtras: async (tok) => { orden.push("cerrarOtras"); assert.equal(tok, TOKEN_S1); return o.cerrarOtras ?? true; },
    reservar: async (id, cfg) => { orden.push("reservar"); if (o.reservarFalla) throw new Error("db caída"); return o.reserva ?? { permitido: true, intento_id: ++nIntento, intentos_restantes: 4 }; },
    resolver: async (id, intento, r) => { orden.push(`resolver:${r}`); resoluciones.push({ id, intento, r }); if (o.resolverFalla) throw new Error("db caída"); return { resultado: r }; },
    auditar: async (fila) => { orden.push("auditar"); if (o.auditarFalla) throw new Error("db caída"); auditoria.push(fila); },
    log: { info: (x, m) => logs.push(["info", x, m]), warn: (x, m) => logs.push(["warn", x, m]), error: (x, m) => logs.push(["error", x, m]) },
    cfg: { max: 5, ventanaMin: 15, bloqueoMin: 15, ttlSeg: 90 },
  };
  const svc = M.crearServicioClaveAdmin(dep);
  return { cambiar: (body = CUERPO()) => svc.cambiar(ADMIN, TOKEN_S1, body), orden, logs, auditoria, resoluciones };
}
const sinSecretos = (m, r) => { const todo = JSON.stringify([r, m.logs, m.auditoria, m.resoluciones]); for (const s of SECRETOS) assert.ok(!todo.includes(s), "aparece un secreto"); };

describe("SECURITY-1D · servicio: camino feliz y orden exacto", () => {
  test("éxito: reservar → comprobar (T) → cambiar con S1 → scope=others → resolver ok → auditar; 200 {ok, otras_sesiones_cerradas}", async () => {
    const m = montar(); const r = await m.cambiar();
    assert.deepEqual(r, { status: 200, cuerpo: { ok: true, otras_sesiones_cerradas: true } });
    assert.deepEqual(m.orden, ["reservar", "comprobar", "cambiar", "cerrarOtras", "resolver:ok", "auditar"]);
    assert.deepEqual(m.auditoria, [{ usuario_id: ADMIN.id, usuario: ADMIN.nombre, rol: "admin", accion: "cambio-clave-admin", entidad: "cuenta", entidad_id: ADMIN.id, detalle: '{"otras_sesiones_cerradas":true}', resultado: "ok" }]);
    sinSecretos(m, r);
  });
});
describe("SECURITY-1D · servicio: validación local (no reserva, no llama a GoTrue)", () => {
  for (const [nombre, body, codigo] of [
    ["sin cuerpo", null, "CUERPO_INVALIDO"], ["arreglo", [], "CUERPO_INVALIDO"], ["falta un campo", { clave_actual: ACTUAL, clave_nueva: NUEVA }, "CUERPO_INVALIDO"],
    ["campo extra (p. ej. correo o user id)", { ...CUERPO(), correo: "x@example.test" }, "CUERPO_INVALIDO"], ["user_id alternativo", { ...CUERPO(), user_id: ADMIN.id }, "CUERPO_INVALIDO"],
    ["no texto", { clave_actual: 1, clave_nueva: NUEVA, clave_confirmacion: NUEVA }, "CUERPO_INVALIDO"], ["vacío", { clave_actual: "", clave_nueva: NUEVA, clave_confirmacion: NUEVA }, "CUERPO_INVALIDO"],
    ["confirmación distinta", { ...CUERPO(), clave_confirmacion: NUEVA + "x" }, "CLAVES_NO_COINCIDEN"],
    ["débil", { clave_actual: ACTUAL, clave_nueva: "password1234", clave_confirmacion: "password1234" }, "CLAVE_DEBIL"],
    ["igual a la actual", { clave_actual: ACTUAL, clave_nueva: ACTUAL, clave_confirmacion: ACTUAL }, "CLAVE_IGUAL_A_LA_ACTUAL"],
  ]) test(`${nombre} → 400 ${codigo}; sin reserva ni GoTrue`, async () => {
    const m = montar(); const r = await m.cambiar(body);
    assert.equal(r.status, 400); assert.equal(r.cuerpo.codigo, codigo); assert.deepEqual(m.orden, []); sinSecretos(m, r);
  });
});
describe("SECURITY-1D · servicio: límite de intentos (SECURITY-1C)", () => {
  for (const [nombre, reserva, st, codigo, retry] of [
    ["en_curso", { permitido: false, motivo: "en_curso", reintentar_en_s: 42 }, 409, "CAMBIO_EN_CURSO", "42"],
    ["bloqueado", { permitido: false, motivo: "bloqueado", reintentar_en_s: 870 }, 429, "DEMASIADOS_INTENTOS", "870"],
    ["no_admin", { permitido: false, motivo: "no_admin" }, 403, "SOLO_ADMIN", undefined],
    ["respuesta rara", { permitido: false, motivo: "¿?" }, 500, "ERROR_INTERNO", undefined],
  ]) test(`${nombre} → ${st} ${codigo}${retry ? " + Retry-After " + retry : ""}; no se verifica ni se cambia nada`, async () => {
    const m = montar({ reserva }); const r = await m.cambiar();
    assert.equal(r.status, st); assert.equal(r.cuerpo.codigo, codigo); assert.equal(r.cabeceras?.["Retry-After"], retry); assert.deepEqual(m.orden, ["reservar"]);
  });
  test("la base no responde al reservar → 500 genérico, sin tocar GoTrue", async () => {
    const m = montar({ reservarFalla: true }); const r = await m.cambiar(); assert.deepEqual([r.status, r.cuerpo.codigo, m.orden], [500, "ERROR_INTERNO", ["reservar"]]);
  });
});
describe("SECURITY-1D · servicio: verificación de la actual", () => {
  test("A · contraseña actual incorrecta → resolver FALLIDO → 401 CLAVE_INCORRECTA; no se cambia nada", async () => {
    const m = montar({ comprobar: "incorrecta" }); const r = await m.cambiar();
    assert.deepEqual([r.status, r.cuerpo.codigo], [401, "CLAVE_INCORRECTA"]); assert.deepEqual(m.orden, ["reservar", "comprobar", "resolver:fallido"]); sinSecretos(m, r);
  });
  test("identidad distinta (la contraseña abre OTRA cuenta) → FALLIDO → 401 CLAVE_INCORRECTA", async () => {
    const m = montar({ comprobar: "identidad_distinta" }); const r = await m.cambiar(); assert.deepEqual([r.status, m.orden.at(-1)], [401, "resolver:fallido"]);
  });
  test("B · GoTrue no disponible al verificar (red/5xx/429) → ANULADO (no cuenta) → 503 AUTH_NO_DISPONIBLE", async () => {
    const m = montar({ comprobar: "no_disponible" }); const r = await m.cambiar();
    assert.deepEqual([r.status, r.cuerpo.codigo], [503, "AUTH_NO_DISPONIBLE"]); assert.deepEqual(m.orden, ["reservar", "comprobar", "resolver:anulado"]);
  });
});
describe("SECURITY-1D · servicio: el cambio en GoTrue", () => {
  for (const [c, st, codigo, res] of [
    ["debil", 400, "CLAVE_DEBIL", "ok"], ["igual", 400, "CLAVE_IGUAL_A_LA_ACTUAL", "ok"],
    ["reautenticar", 401, "SESION_INVALIDA", "anulado"], ["sesion_invalida", 401, "SESION_INVALIDA", "anulado"], ["no_aplicado", 503, "AUTH_NO_DISPONIBLE", "anulado"],
  ]) test(`GoTrue responde «${c}» → ${st} ${codigo}; reserva ${res.toUpperCase()}; sin scope=others ni auditoría de cambio`, async () => {
    const m = montar({ cambiar: c }); const r = await m.cambiar();
    assert.deepEqual([r.status, r.cuerpo.codigo], [st, codigo]); assert.deepEqual(m.orden, ["reservar", "comprobar", "cambiar", `resolver:${res}`]); sinSecretos(m, r);
    if (c === "reautenticar") assert.equal(r.cuerpo.error, "Vuelve a iniciar sesión e inténtalo de nuevo.");
  });
  test("F-ambiguo · el PUT termina sin respuesta clara (red/timeout/5xx): NO se reintenta; ANULADO; auditoría «incierto»; 503 con estado_cambio desconocido", async () => {
    const m = montar({ cambiar: "desconocido" }); const r = await m.cambiar();
    assert.deepEqual([r.status, r.cuerpo.codigo, r.cuerpo.estado_cambio], [503, "AUTH_NO_DISPONIBLE", "desconocido"]);
    assert.deepEqual(m.orden, ["reservar", "comprobar", "cambiar", "resolver:anulado", "auditar"]);
    assert.equal(m.orden.filter((x) => x === "cambiar").length, 1); assert.equal(m.auditoria[0].resultado, "incierto");
    assert.ok(m.logs.some((l) => l[1].evento === "cambio-clave-resultado-desconocido")); sinSecretos(m, r);
  });
});
describe("SECURITY-1D · servicio: fallos DESPUÉS de que GoTrue confirmó el cambio (nunca se deshace ni se reintenta; nunca «contraseña incorrecta»)", () => {
  test("C · falla scope=others → 200 con otras_sesiones_cerradas:false; aviso en el log; reserva ok; auditoría con el dato", async () => {
    const m = montar({ cerrarOtras: false }); const r = await m.cambiar();
    assert.deepEqual(r, { status: 200, cuerpo: { ok: true, otras_sesiones_cerradas: false } });
    assert.ok(m.logs.some((l) => l[0] === "warn" && l[1].evento === "clave-otras-sesiones-sin-confirmar"));
    assert.equal(m.auditoria[0].detalle, '{"otras_sesiones_cerradas":false}'); assert.equal(m.orden.filter((x) => x === "cambiar").length, 1);
  });
  test("D · falla resolver (dos intentos) → igual 200; error en el log con el id de la reserva (sin secretos); auditoría sí", async () => {
    const m = montar({ resolverFalla: true }); const r = await m.cambiar();
    assert.equal(r.status, 200); assert.deepEqual(m.orden, ["reservar", "comprobar", "cambiar", "cerrarOtras", "resolver:ok", "resolver:ok", "auditar"]);
    assert.ok(m.logs.some((l) => l[1].evento === "clave-reserva-no-resuelta" && l[1].intento_id === 41)); sinSecretos(m, r);
  });
  test("E · falla la auditoría → igual 200; error en el log (la reserva ok queda como evidencia)", async () => {
    const m = montar({ auditarFalla: true }); const r = await m.cambiar();
    assert.equal(r.status, 200); assert.ok(m.logs.some((l) => l[1].evento === "auditoria-cambio-clave-no-registrada")); assert.deepEqual(m.resoluciones.map((x) => x.r), ["ok"]);
  });
  test("F/G · respuesta perdida y la MISMA petición reenviada con la contraseña anterior: el 2.º intento NO cambia nada (la actual ya no vale) → 401 FALLIDO", async () => {
    const primera = montar(); assert.equal((await primera.cambiar()).status, 200);
    const reenvio = montar({ comprobar: "incorrecta" }); const r = await reenvio.cambiar();
    assert.deepEqual([r.status, r.cuerpo.codigo], [401, "CLAVE_INCORRECTA"]); assert.ok(!reenvio.orden.includes("cambiar"), "nunca se vuelve a cambiar");
  });
  test("H · dos cambios simultáneos: el segundo recibe «en_curso» → 409 (la exclusión la da SECURITY-1C; la prueba real está en correr-sql.sh sec1c y en GoTrue real)", async () => {
    const m = montar({ reserva: { permitido: false, motivo: "en_curso", reintentar_en_s: 88 } }); const r = await m.cambiar();
    assert.deepEqual([r.status, r.cuerpo.codigo], [409, "CAMBIO_EN_CURSO"]);
  });
});
