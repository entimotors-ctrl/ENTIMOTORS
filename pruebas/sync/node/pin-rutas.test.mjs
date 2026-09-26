// SYNC-3P · rutas HTTP del PIN (api-server/src/routes/pin.ts REAL, con Express y Supabase falsos) + CORS selectivo.
import test from "node:test";
import assert from "node:assert/strict";
import { compilar } from "./helpers/compilar.mjs";

const PEPPER = "pepper-sintetico-solo-para-pruebas-0123456789";
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REG = "00000000-0000-4000-9000-000000000700";
const M = await import(await compilar("api-server/src/lib/pin.ts", { falsos: [], nombre: "pin-lib" }));
const HASH = await M.hashearPin("482913", PEPPER, { ...M.configPin({}), N: 1024 });
const URL_RUTAS = await compilar("api-server/src/routes/pin.ts", { nombre: "pin-rutas" });

/** Carga una copia nueva del módulo real con su «Supabase» falso; `e` es el estado observable de la prueba. */
async function montar({ pepper = PEPPER, entorno = {}, e: extra = {} } = {}) {
  const e = { sesiones: new Map([["tk-admin", { id: uid(1), email: "admin@example.test" }], ["tk-caja", { id: uid(2), email: "caja@example.test" }], ["tk-mec", { id: uid(3), email: "mec@example.test" }], ["tk-baja", { id: uid(6), email: "baja@example.test" }], ["tk-sinperfil", { id: uid(9), email: "x@example.test" }]]),
    perfiles: new Map([[uid(1), { id: uid(1), nombre: "Admin", rol: "admin", activo: true }], [uid(2), { id: uid(2), nombre: "Caja", rol: "cajero", activo: true }],
      [uid(3), { id: uid(3), nombre: "Mec", rol: "mecanico", activo: true }], [uid(6), { id: uid(6), nombre: "Baja", rol: "cajero", activo: false }]]),
    rpc: [], inserts: [], deletes: [], logs: [], hash: HASH, version: 3, rpcError: null, reservar: null, ...extra };
  const rutas = [];
  const nuevoRouter = () => { const r = {}; for (const m of ["get", "post", "put", "patch", "delete"]) r[m] = (ruta, ...h) => { rutas.push({ metodo: m.toUpperCase(), ruta, handlers: h }); return r; }; r.use = () => r; return r; };
  const crearCliente = () => ({
    auth: { getUser: async (tk) => { const u = e.sesiones.get(tk); return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "invalid" } }; } },
    from: (tabla) => {
      const q = { eq: [] }; const api = {
        select() { return api; }, order() { return api; }, limit() { return api; }, eq(c, v) { q.eq.push([c, v]); return api; },
        insert: async (fila) => { e.inserts.push({ tabla, fila }); return { error: null }; },
        delete() { q.del = true; return { eq: async (c, v) => { e.deletes.push({ tabla, c, v }); return { error: null }; } }; },
        maybeSingle: async () => ({ data: tabla === "perfiles" ? (e.perfiles.get(q.eq[0][1]) ?? null) : tabla === "admin_pin" ? { hash: e.hash } : null, error: null }),
        then: (ok) => ok({ data: tabla === "admin_pin" && e.hash ? [{ perfil_id: uid(1), version: e.version, actualizado_en: "2026-09-21T00:00:00Z", bloqueado_hasta: null }] : [], error: null }),
      }; return api;
    },
    rpc: async (nombre, args) => {
      e.rpc.push({ nombre, args });
      if (e.rpcError) return { data: null, error: { message: e.rpcError } };
      if (nombre === "pin_reservar_intento") return { data: e.reservar ? e.reservar() : { permitido: true, admin_id: uid(1), pin_version: e.version, hash: e.hash, intentos_restantes: 4 }, error: null };
      if (nombre === "pin_emitir_autorizacion") return { data: { autorizacion_id: "aut-9", expira_en: "2026-09-21T00:01:30Z" }, error: null };
      if (nombre === "pin_guardar") return { data: ++e.version, error: null };
      return { data: null, error: null };
    },
  });
  const previo = { ...process.env };
  Object.assign(process.env, { SUPABASE_URL: "https://proyecto-sintetico.example.test", SUPABASE_SERVICE_KEY: "SERVICIO-SINTETICO", SUPABASE_ANON_KEY: "ANONIMA-SINTETICA", ...entorno });
  if (pepper === null) delete process.env.ADMIN_PIN_PEPPER; else process.env.ADMIN_PIN_PEPPER = pepper;
  const previoGlobal = globalThis.__PIN;
  globalThis.__PIN = { nuevoRouter, crearCliente, registrar: (n, a) => e.logs.push({ n, a }) };
  await import(`${URL_RUTAS}?n=${Math.random()}`);
  globalThis.__PIN = previoGlobal; Object.assign(process.env, previo);
  async function llamar(metodo, ruta, { token, body, headers = {} } = {}) {
    const r = rutas.find((x) => x.metodo === metodo && x.ruta === ruta); if (!r) throw new Error(`ruta no registrada ${metodo} ${ruta}`);
    const res = { codigo: 200, cuerpo: undefined, cab: {}, status(c) { this.codigo = c; return this; }, json(o) { this.cuerpo = o; return this; }, setHeader(k, v) { this.cab[k.toLowerCase()] = v; return this; } };
    const req = { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body, method: metodo };
    process.env.ADMIN_PIN_PEPPER = pepper ?? ""; if (pepper === null) delete process.env.ADMIN_PIN_PEPPER;
    globalThis.__PIN = { nuevoRouter, crearCliente, registrar: (n, a) => e.logs.push({ n, a }) };
    let seguir = true;
    try { for (const h of r.handlers) { if (!seguir) break; seguir = false; await h(req, res, () => { seguir = true; }); } }
    finally { globalThis.__PIN = previoGlobal; }
    return { status: res.codigo, cuerpo: res.cuerpo, cab: res.cab, req };
  }
  return { e, llamar, rutas };
}
const CUERPO = (x = {}) => ({ accion: "ajustar_stock", entidad: "inventario", registro_id: REG, device_id: "dev-1", pin: "482913", ...x });
const volcado = (e) => JSON.stringify({ rpc: e.rpc, inserts: e.inserts, logs: e.logs });

test("las 5 rutas existen con el método correcto", async () => {
  const { rutas } = await montar();
  assert.deepEqual(rutas.map((r) => `${r.metodo} ${r.ruta}`).sort(), ["DELETE /admin/pin", "GET /admin/pin/estado", "POST /admin/pin/desbloquear", "POST /autorizaciones", "PUT /admin/pin"]);
});

test("sin ADMIN_PIN_PEPPER (o corto) todas responden 503 y no tocan la base", async () => {
  for (const pepper of [null, "", "corto"]) {
    const { e, llamar } = await montar({ pepper });
    for (const [m, r] of [["GET", "/admin/pin/estado"], ["PUT", "/admin/pin"], ["DELETE", "/admin/pin"], ["POST", "/admin/pin/desbloquear"], ["POST", "/autorizaciones"]]) {
      const x = await llamar(m, r, { token: "tk-admin", body: CUERPO() });
      assert.equal(x.status, 503, `${m} ${r}`); assert.equal(x.cuerpo.codigo, "PIN_NO_CONFIGURADO_EN_SERVIDOR");
    }
    assert.equal(e.rpc.length, 0);
  }
});

test("autenticación: sin token, token falso, cuenta de baja o sin perfil → nunca llega al servicio", async () => {
  const { e, llamar } = await montar();
  assert.equal((await llamar("POST", "/autorizaciones", { body: CUERPO() })).cuerpo.codigo, "SIN_SESION");
  assert.equal((await llamar("POST", "/autorizaciones", { token: "tk-falso", body: CUERPO() })).cuerpo.codigo, "SESION_INVALIDA");
  assert.equal((await llamar("POST", "/autorizaciones", { headers: { authorization: "Basic abc" }, body: CUERPO() })).status, 401);
  assert.equal((await llamar("POST", "/autorizaciones", { token: "tk-baja", body: CUERPO() })).cuerpo.codigo, "CUENTA_INACTIVA");
  assert.equal((await llamar("POST", "/autorizaciones", { token: "tk-sinperfil", body: CUERPO() })).status, 403);
  assert.equal(e.rpc.length, 0);
});

test("las rutas de administración son solo del admin (cajero y mecánico → 403)", async () => {
  const { e, llamar } = await montar();
  for (const token of ["tk-caja", "tk-mec"]) for (const [m, r] of [["GET", "/admin/pin/estado"], ["PUT", "/admin/pin"], ["DELETE", "/admin/pin"], ["POST", "/admin/pin/desbloquear"]]) {
    const x = await llamar(m, r, { token, body: { pin_nuevo: "739205", clave_cuenta: "x" } }); assert.equal(x.status, 403, `${token} ${m} ${r}`); assert.equal(x.cuerpo.codigo, "SOLO_ADMIN");
  }
  assert.equal(e.rpc.length + e.inserts.length, 0);
  const ok = await llamar("GET", "/admin/pin/estado", { token: "tk-admin" });
  assert.equal(ok.status, 200); assert.equal(ok.cuerpo.configurado, true); assert.ok(!JSON.stringify(ok.cuerpo).includes("scrypt"), "el estado nunca devuelve el hash");
});

test("cajero + PIN correcto → 201; la identidad sale del token, no del cuerpo; respuesta sin PIN ni hash", async () => {
  const { e, llamar } = await montar();
  const x = await llamar("POST", "/autorizaciones", { token: "tk-caja", body: CUERPO({ rol: "admin", solicitante_id: uid(1), autorizado_por: uid(1), monto: 5 }) });
  assert.equal(x.status, 201); assert.deepEqual(x.cuerpo, { autorizacion_id: "aut-9", expira_en: "2026-09-21T00:01:30Z", ttl_segundos: 90 });
  const reserva = e.rpc.find((r) => r.nombre === "pin_reservar_intento").args;
  assert.equal(reserva.p_solicitante, uid(2), "el solicitante es el del token (cajero), no el que dice el cuerpo");
  assert.equal([reserva.p_max_solicitante, reserva.p_max_global, reserva.p_ventana_min, reserva.p_bloqueo_min, reserva.p_max_bloqueos_24h].join(), "5,10,15,15,3");
  const emi = e.rpc.find((r) => r.nombre === "pin_emitir_autorizacion").args;
  assert.deepEqual([emi.p_solicitante, emi.p_rol, emi.p_admin, emi.p_accion, emi.p_entidad, emi.p_registro, emi.p_device, emi.p_pin_version, emi.p_ttl_seg], [uid(2), "cajero", uid(1), "ajustar_stock", "inventario", REG, "dev-1", 3, 90]);
  assert.equal(emi.p_payload_hash, M.hashCritico("ajustar_stock", REG, 5));
  assert.ok(!JSON.stringify(x.cuerpo).includes("482913"));
});

test("mecánico → 403 NO_PERMITIDO sin reservar intento; PIN incorrecto → 401; bloqueo → 429 con Retry-After", async () => {
  const { e, llamar } = await montar();
  const m = await llamar("POST", "/autorizaciones", { token: "tk-mec", body: CUERPO() });
  assert.equal(m.status, 403); assert.equal(m.cuerpo.codigo, "NO_PERMITIDO"); assert.equal(e.rpc.filter((r) => r.nombre === "pin_reservar_intento").length, 0);
  assert.equal(e.inserts.at(-1).fila.resultado, "no_permitido");
  const mal = await llamar("POST", "/autorizaciones", { token: "tk-caja", body: CUERPO({ pin: "111112" }) });
  assert.equal(mal.status, 401); assert.equal(e.inserts.at(-1).fila.resultado, "pin_incorrecto"); assert.equal(e.inserts.at(-1).tabla, "admin_pin_intentos");
  e.reservar = () => ({ permitido: false, motivo: "bloqueado_solicitante", reintentar_en_s: 600 });
  const bloq = await llamar("POST", "/autorizaciones", { token: "tk-caja", body: CUERPO() });
  assert.equal(bloq.status, 429); assert.equal(bloq.cab["retry-after"], "600");
});

test("cabeceras: todas las respuestas (también los rechazos) van con Cache-Control: no-store", async () => {
  const { llamar } = await montar();
  for (const x of [await llamar("POST", "/autorizaciones", { body: CUERPO() }), await llamar("GET", "/admin/pin/estado", { token: "tk-caja" }), await llamar("POST", "/autorizaciones", { token: "tk-caja", body: CUERPO() })]) {
    assert.equal(x.cab["cache-control"], "no-store"); assert.equal(x.cab["pragma"], "no-cache");
  }
});

test("cuerpo: arreglos, texto o más de 4 KB → 400 antes de cualquier trabajo", async () => {
  const { e, llamar } = await montar();
  for (const body of [[1, 2], "texto", CUERPO({ relleno: "x".repeat(5000) })]) assert.equal((await llamar("POST", "/autorizaciones", { token: "tk-caja", body })).cuerpo.codigo, "CUERPO_INVALIDO");
  assert.equal(e.rpc.length, 0);
});

test("un fallo interno responde 500 genérico: no filtra el mensaje de la base ni el cuerpo, y el PIN no llega a los logs", async () => {
  const { e, llamar } = await montar({ e: { rpcError: 'relation "admin_pin" does not exist SECRETO-INTERNO' } });
  const x = await llamar("POST", "/autorizaciones", { token: "tk-caja", body: CUERPO() });
  assert.equal(x.status, 500); assert.deepEqual(x.cuerpo, { error: "No se pudo completar la operación.", codigo: "ERROR_INTERNO" });
  assert.ok(!JSON.stringify(x.cuerpo).includes("SECRETO-INTERNO"));
  assert.ok(e.logs.some((l) => l.n === "error"), "el fallo sí se registra");
  assert.ok(!volcado(e).includes("482913"), "el PIN no está en logs ni en llamadas a la base");
});

/* GoTrue FALSO para la re-autenticación con la contraseña de la cuenta (SECURITY-1B): el login devuelve un token con session_id y el
   usuario; /logout contesta según `cierre` (lista de respuestas por intento: número = status, "red" = excepción). Registra cada llamada. */
const SESION_TMP = "00000000-0000-4000-a000-00000000cafe";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN_TMP = `${b64({ alg: "HS256" })}.${b64({ sub: uid(1), session_id: SESION_TMP })}.firma-sintetica-TOKEN`;
function gotrueFalso({ clave = "clave-buena", usuario = { id: uid(1), email: "admin@example.test" }, cierre = [204], sinToken = false } = {}) {
  const llamadas = []; let i = 0;
  const f = async (url, init) => {
    const u = String(url); llamadas.push({ url: u, metodo: init?.method, auth: init?.headers?.Authorization, apikey: init?.headers?.apikey, cuerpo: init?.body });
    if (u.includes("/auth/v1/token?grant_type=password")) {
      const ok = JSON.parse(init.body).password === clave;
      return { ok, status: ok ? 200 : 400, json: async () => (ok ? { access_token: sinToken ? "" : TOKEN_TMP, refresh_token: "REFRESH-SINTETICO", user: usuario } : { error: "invalid_grant" }) };
    }
    if (u.includes("/auth/v1/logout")) { const r = cierre[Math.min(i++, cierre.length - 1)]; if (r === "red") throw new Error("red caída"); return { ok: r >= 200 && r < 300, status: r, json: async () => null }; }
    throw new Error(`petición inesperada ${u}`);
  };
  return { f, llamadas, cierres: () => llamadas.filter((l) => l.url.includes("/auth/v1/logout")) };
}
async function conGotrue(g, fn) { const real = globalThis.fetch; globalThis.fetch = g.f; try { return await fn(); } finally { globalThis.fetch = real; } }
const volcadoSecretos = (e, extra = []) => { const v = JSON.stringify(e.logs); for (const s of ["clave-buena", "clave-mala", "REFRESH-SINTETICO", "firma-sintetica-TOKEN", TOKEN_TMP, ...extra]) assert.ok(!v.includes(s), `el log contiene un secreto (${s.slice(0, 12)}…)`); };

test("establecer PIN: la contraseña de la cuenta se verifica contra Auth (sin guardarse) y el hash guardado no contiene el PIN", async () => {
  const { e, llamar } = await montar();
  const gt = gotrueFalso(); const peticiones = gt.llamadas;
  await conGotrue(gt, async () => {
    const mala = await llamar("PUT", "/admin/pin", { token: "tk-admin", body: { pin_nuevo: "739205", clave_cuenta: "clave-mala" } });
    assert.equal(mala.status, 401); assert.equal(mala.cuerpo.codigo, "CLAVE_INCORRECTA");
    const buena = await llamar("PUT", "/admin/pin", { token: "tk-admin", body: { pin_nuevo: "739205", clave_cuenta: "clave-buena" } });
    assert.equal(buena.status, 200); assert.deepEqual(buena.cuerpo, { ok: true, version: 4 });
  });
  assert.match(peticiones[0].url, /\/auth\/v1\/token\?grant_type=password$/);
  assert.equal(JSON.parse(peticiones[0].cuerpo).email, "admin@example.test", "usa el correo de la cuenta del token, no uno enviado por el cliente");
  const g = e.rpc.find((r) => r.nombre === "pin_guardar").args;
  assert.match(g.p_hash, /^scrypt\$/); assert.equal(g.p_admin, uid(1)); assert.equal(g.p_por, uid(1));
  assert.ok(!volcado(e).includes("739205") && !volcado(e).includes("clave-buena") && !volcado(e).includes("clave-mala"), "ni el PIN nuevo ni las contraseñas llegan a la base o a los logs");
});

test("desbloquear y eliminar PIN llegan a la base solo con un admin", async () => {
  const { e, llamar } = await montar();
  assert.equal((await llamar("POST", "/admin/pin/desbloquear", { token: "tk-admin" })).status, 200);
  assert.equal(e.rpc.at(-1).nombre, "pin_desbloquear"); assert.equal(e.rpc.at(-1).args.p_admin, uid(1));
  const g = gotrueFalso({ clave: "x" });
  await conGotrue(g, async () => { assert.equal((await llamar("DELETE", "/admin/pin", { token: "tk-admin", body: { clave_cuenta: "x" } })).status, 200); });
  assert.equal(g.cierres().length, 1, "también al quitar el PIN se cierra la sesión temporal");
  assert.deepEqual(e.deletes, [{ tabla: "admin_pin", c: "perfil_id", v: uid(1) }]);
});

/* ───────── SECURITY-1B: sesión temporal de la verificación con la contraseña de la cuenta ───────── */
const cambiarPin = (llamar, clave = "clave-buena") => llamar("PUT", "/admin/pin", { token: "tk-admin", body: { pin_nuevo: "739205", clave_cuenta: clave } });

test("SECURITY-1B · contraseña correcta: 1 login + EXACTAMENTE 1 cierre con scope=local y el token TEMPORAL; nunca global/others/sin scope", async () => {
  const { e, llamar } = await montar(); const g = gotrueFalso();
  const r = await conGotrue(g, () => cambiarPin(llamar));
  assert.equal(r.status, 200);
  assert.deepEqual(g.llamadas.map((l) => l.url), ["https://proyecto-sintetico.example.test/auth/v1/token?grant_type=password", "https://proyecto-sintetico.example.test/auth/v1/logout?scope=local"]);
  const c = g.cierres()[0]; assert.equal(c.metodo, "POST"); assert.equal(c.auth, `Bearer ${TOKEN_TMP}`); assert.equal(c.apikey, "ANONIMA-SINTETICA");
  for (const l of g.llamadas) assert.doesNotMatch(l.url, /scope=(global|others)|\/logout$/);
  assert.equal(e.logs.filter((l) => l.n === "warn").length, 0); volcadoSecretos(e);
  assert.ok(!JSON.stringify(r.cuerpo).includes("TOKEN") && !JSON.stringify(r.cuerpo).includes("clave-buena"));
});

test("SECURITY-1B · contraseña incorrecta: 401 CLAVE_INCORRECTA y NINGÚN cierre (GoTrue no creó sesión)", async () => {
  const { e, llamar } = await montar(); const g = gotrueFalso();
  const r = await conGotrue(g, () => cambiarPin(llamar, "clave-mala"));
  assert.equal(r.status, 401); assert.equal(r.cuerpo.codigo, "CLAVE_INCORRECTA"); assert.equal(g.cierres().length, 0); volcadoSecretos(e);
  assert.equal(e.rpc.filter((x) => x.nombre === "pin_guardar").length, 0);
});

for (const [nombre, usuario] of [["otro id", { id: uid(2), email: "admin@example.test" }], ["otro correo", { id: uid(1), email: "otra@example.test" }], ["sin usuario", null]]) {
  test(`SECURITY-1B · identidad distinta (${nombre}): primero se cierra la temporal y después se rechaza (401); el PIN no se guarda`, async () => {
    const { e, llamar } = await montar(); const g = gotrueFalso({ usuario });
    const r = await conGotrue(g, () => cambiarPin(llamar));
    assert.equal(r.status, 401); assert.equal(r.cuerpo.codigo, "CLAVE_INCORRECTA");
    assert.equal(g.cierres().length, 1); assert.match(g.llamadas[1].url, /\/auth\/v1\/logout\?scope=local$/);
    assert.equal(e.rpc.filter((x) => x.nombre === "pin_guardar").length, 0, "el PIN no cambia");
    assert.ok(e.logs.some((l) => l.n === "warn" && l.a[0]?.evento === "pin-clave-identidad-distinta")); volcadoSecretos(e);
  });
}

test("SECURITY-1B · login correcto pero sin access_token: 401 y ningún cierre", async () => {
  const { llamar } = await montar(); const g = gotrueFalso({ sinToken: true });
  const r = await conGotrue(g, () => cambiarPin(llamar)); assert.equal(r.status, 401); assert.equal(g.cierres().length, 0);
});

for (const [nombre, cierre, llamadas, aviso, estado] of [
  ["5xx y luego 204 → reintento con éxito", [503, 204], 2, false, null],
  ["red caída y luego 204 → reintento con éxito", ["red", 204], 2, false, null],
  ["429 dos veces → reintento y aviso", [429, 429], 2, true, 429],
  ["red caída dos veces → reintento y aviso", ["red", "red"], 2, true, "sin-respuesta"],
  ["401 (GoTrue rechaza el token) → SIN reintento y aviso", [401], 1, true, 401],
]) {
  test(`SECURITY-1B · cierre de la temporal: ${nombre}; la verificación sigue válida y en el log solo el id de sesión`, async () => {
    const { e, llamar } = await montar(); const g = gotrueFalso({ cierre });
    const r = await conGotrue(g, () => cambiarPin(llamar));
    assert.equal(r.status, 200, "la contraseña ya quedó verificada");
    assert.equal(g.cierres().length, llamadas); for (const c of g.cierres()) assert.match(c.url, /\/auth\/v1\/logout\?scope=local$/);
    const avisos = e.logs.filter((l) => l.n === "warn" && l.a[0]?.evento === "pin-sesion-temporal-no-cerrada");
    assert.equal(avisos.length, aviso ? 1 : 0);
    if (aviso) assert.deepEqual(avisos[0].a[0], { evento: "pin-sesion-temporal-no-cerrada", sesion: SESION_TMP, estado });
    volcadoSecretos(e);
  });
}

/* ───────── CORS selectivo ───────── */
const C = await import(await compilar("api-server/src/lib/cors-origenes.ts", { falsos: ["cors"], nombre: "cors" }));
const ENV = { ENTIMOTORS_ADMIN_ORIGIN: "https://taller.example.test/entimotors-os/", ENTIMOTORS_MECHANIC_ORIGIN: "https://mitrabajo.example.test", CORS_ORIGINS_EXTRA: "https://extra.example.test, http://localhost:5173 ,ftp://malo.test,no-es-url" };
function peticion(url, { origin, metodo = "GET", host = "api.example.test" } = {}) {
  const cab = { ...(origin !== undefined ? { origin } : {}), host };
  const res = { cab: {}, codigo: 200, cuerpo: undefined, fin: false, status(c) { this.codigo = c; return this; }, json(o) { this.cuerpo = o; this.fin = true; return this; }, end() { this.fin = true; return this; }, setHeader(k, v) { this.cab[k.toLowerCase()] = v; return this; }, getHeader(k) { return this.cab[k.toLowerCase()]; } };
  return { req: { originalUrl: url, url, method: metodo, get: (k) => cab[k.toLowerCase()], headers: cab }, res };
}
function pasar(mw, p) { let siguio = false; mw(p.req, p.res, () => { siguio = true; }); return siguio; }

test("CORS: orígenes aprobados = las dos apps + extras válidos (https, o http en localhost); lo demás no abre nada", () => {
  assert.deepEqual(C.origenesAprobados(ENV), ["https://taller.example.test", "https://mitrabajo.example.test", "https://extra.example.test", "http://localhost:5173"]);
  assert.deepEqual(C.origenesAprobados({}), []);
});

test("CORS: las rutas sensibles solo aceptan a las apps aprobadas y al mismo origen; el sitio público sigue abierto", () => {
  const mw = C.crearCorsSelectivo(ENV);
  for (const url of ["/api/admin/pin/estado", "/api/admin/pin", "/api/autorizaciones", "/api/admin/usuarios", "/api/admin/usuarios/123/enlace"]) {
    let p = peticion(url, { origin: "https://taller.example.test" }); assert.equal(pasar(mw, p), true, url); assert.equal(p.res.cab["access-control-allow-origin"], "https://taller.example.test"); assert.equal(p.res.cab["vary"], "Origin");
    p = peticion(url, { origin: "https://malo.example.test" }); assert.equal(pasar(mw, p), false, url); assert.equal(p.res.codigo, 403); assert.equal(p.res.cuerpo.codigo, "ORIGEN_NO_PERMITIDO");
    p = peticion(url, { origin: "https://api.example.test" }); assert.equal(pasar(mw, p), true, "mismo origen");
    p = peticion(url, {}); assert.equal(pasar(mw, p), true, "sin Origin (curl/servidor): pasa, el token es la defensa"); assert.equal(p.res.cab["access-control-allow-origin"], undefined);
  }
  const pre = peticion("/api/autorizaciones", { origin: "https://mitrabajo.example.test", metodo: "OPTIONS" });
  assert.equal(pasar(mw, pre), false); assert.equal(pre.res.codigo, 204); assert.match(pre.res.cab["access-control-allow-headers"], /authorization/);
});

test("CORS: un origen malo no puede ni pasar el preflight de una ruta sensible", () => {
  const mw = C.crearCorsSelectivo(ENV);
  const p = peticion("/api/admin/pin", { origin: "https://malo.example.test", metodo: "OPTIONS" });
  assert.equal(pasar(mw, p), false); assert.equal(p.res.codigo, 403);
});

test("CORS: rutas públicas y de login del panel NO cambian (siguen con el CORS abierto de siempre)", () => {
  const mw = C.crearCorsSelectivo(ENV);
  for (const url of ["/api/products", "/api/projects", "/api/videos", "/api/healthz", "/api/admin/login", "/api/admin/logout", "/api/admin/sesion"]) {
    assert.equal(C.RUTAS_SENSIBLES.test(url), false, url);
    const p = peticion(url, { origin: "https://cualquiera.example.test" });
    assert.equal(pasar(mw, p), true, url); assert.equal(p.res.cab["access-control-allow-origin"], "*", "sigue usando el cors() abierto de siempre");
  }
  assert.equal(C.RUTAS_SENSIBLES.test("/api/admin/pinx"), false, "un prefijo parecido no cuenta");
});
