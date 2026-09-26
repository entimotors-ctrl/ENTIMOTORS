// SECURITY-1B · GoTrue REAL (stack LOCAL de laboratorio, nunca producción): verificarClaveCuenta cierra SOLO su sesión temporal.
// Ejerce el código real (api-server/src/lib/clave-cuenta.ts, compilado con esbuild) contra el Auth local y mira auth.sessions en su Postgres.
// No está en pruebas/sync/node/*.test.mjs a propósito: exige el laboratorio encendido y sus claves locales por variables de entorno:
//   SEC1B_GOTRUE_URL (p. ej. http://127.0.0.1:54321) · SEC1B_ANON · SEC1B_SERVICE · SEC1B_DB_CONTENEDOR (contenedor Postgres del laboratorio)
// Falla CERRADO si falta alguna o si la URL no es local. Crea dos cuentas sintéticas *@example.test con contraseñas aleatorias en memoria
// (nunca se imprimen) y las borra al terminar.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { compilar } from "../node/helpers/compilar.mjs";

const URL_AUTH = process.env.SEC1B_GOTRUE_URL, ANON = process.env.SEC1B_ANON, SERVICIO = process.env.SEC1B_SERVICE, PG = process.env.SEC1B_DB_CONTENEDOR;
if (!URL_AUTH || !ANON || !SERVICIO || !PG) throw new Error("Faltan SEC1B_GOTRUE_URL / SEC1B_ANON / SEC1B_SERVICE / SEC1B_DB_CONTENEDOR (laboratorio local).");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(URL_AUTH)) throw new Error("SEC1B_GOTRUE_URL debe ser el laboratorio LOCAL (http://127.0.0.1:puerto).");

const { crearVerificadorClaveCuenta, sesionDelToken, RUTA_CIERRE_TEMPORAL } = await import(await compilar("api-server/src/lib/clave-cuenta.ts", { falsos: [], nombre: "clave-cuenta-gotrue" }));

const clave = () => crypto.randomBytes(18).toString("base64url") + "Aa1!";
const sql = (q) => { const r = spawnSync("docker", ["exec", PG, "psql", "-U", "postgres", "-tA", "-c", q], { encoding: "utf8" }); if (r.status !== 0) throw new Error(`psql: ${r.stderr}`); return r.stdout.trim(); };
const sesionesDe = (uid) => sql(`select id from auth.sessions where user_id='${uid}' order by id`).split("\n").filter(Boolean);
const refreshVivosDe = (uid) => Number(sql(`select count(*) from auth.refresh_tokens where user_id='${uid}' and not revoked`));
async function gt(ruta, { metodo = "GET", token, cuerpo, servicio = false } = {}) {
  const r = await fetch(URL_AUTH + ruta, { method: metodo, headers: { apikey: servicio ? SERVICIO : ANON, Authorization: `Bearer ${servicio ? SERVICIO : token ?? ANON}`, ...(cuerpo ? { "Content-Type": "application/json" } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* no JSON */ } return { status: r.status, j };
}
async function crearCuenta(tag) {
  const correo = `sec1b-${tag}-${crypto.randomBytes(4).toString("hex")}@example.test`, pass = clave();
  const r = await gt("/auth/v1/admin/users", { metodo: "POST", servicio: true, cuerpo: { email: correo, password: pass, email_confirm: true } });
  assert.ok(r.status === 200 || r.status === 201, `alta ${tag}: ${r.status}`);
  return { id: r.j.id, correo, pass };
}
const entrar = async (c) => { const r = await gt("/auth/v1/token?grant_type=password", { metodo: "POST", cuerpo: { email: c.correo, password: c.pass } }); assert.equal(r.status, 200); return { access: r.j.access_token, refresh: r.j.refresh_token, sesion: sesionDelToken(r.j.access_token) }; };
const renovar = async (s) => { const r = await gt("/auth/v1/token?grant_type=refresh_token", { metodo: "POST", cuerpo: { refresh_token: s.refresh } }); return { status: r.status, access: r.j?.access_token, refresh: r.j?.refresh_token, sesion: r.j?.access_token ? sesionDelToken(r.j.access_token) : null }; };

const cuentas = [];
after(async () => { for (const c of cuentas) await gt(`/auth/v1/admin/users/${c.id}`, { metodo: "DELETE", servicio: true }); });

/** Verificador REAL con un fetch que solo OBSERVA (anota rutas y el session_id del token temporal; no guarda tokens). */
function verificadorEspiado() {
  const obs = { rutas: [], temporales: [], cierres: [], logs: [] };
  const f = async (url, init) => {
    const ruta = String(url).slice(URL_AUTH.length); obs.rutas.push(ruta);
    const r = await fetch(url, init);
    if (ruta.startsWith("/auth/v1/token?grant_type=password") && r.ok) { const j = await r.clone().json(); obs.temporales.push(sesionDelToken(j.access_token)); }
    if (ruta.startsWith("/auth/v1/logout")) obs.cierres.push({ ruta, status: r.status });
    return r;
  };
  const verificar = crearVerificadorClaveCuenta({ url: URL_AUTH, anon: ANON, fetch: f, log: { warn: (o, m) => obs.logs.push({ o, m }) } });
  return { verificar, obs };
}

test("GoTrue real: la sesión temporal desaparece; las 2 sesiones legítimas del admin (y la de otra cuenta) siguen y renuevan", async () => {
  const admin = await crearCuenta("admin"), otra = await crearCuenta("otra"); cuentas.push(admin, otra);
  const s1 = await entrar(admin), s2 = await entrar(admin), so = await entrar(otra);
  const antesAdmin = sesionesDe(admin.id), antesOtra = sesionesDe(otra.id);
  assert.deepEqual(antesAdmin, [s1.sesion, s2.sesion].sort(), "2 sesiones legítimas del admin");
  assert.deepEqual(antesOtra, [so.sesion]);

  const { verificar, obs } = verificadorEspiado();
  assert.equal(await verificar({ id: admin.id, correo: admin.correo }, admin.pass), true, "contraseña correcta → true");
  assert.equal(obs.temporales.length, 1); const temporal = obs.temporales[0];
  assert.ok(temporal && !antesAdmin.includes(temporal), "se creó UNA sesión temporal nueva");
  assert.deepEqual(obs.cierres, [{ ruta: RUTA_CIERRE_TEMPORAL, status: 204 }], "un único cierre, scope=local, 204");
  assert.ok(obs.rutas.every((r) => !r.startsWith("/auth/v1/logout") || r === "/auth/v1/logout?scope=local"), "nunca global/others/sin scope");
  assert.equal(Number(sql(`select count(*) from auth.sessions where id='${temporal}'`)), 0, "la sesión temporal YA NO existe en auth.sessions");
  assert.equal(Number(sql(`select count(*) from auth.refresh_tokens where session_id='${temporal}' and not revoked`)), 0, "ni refresh token vivo de la temporal");
  assert.deepEqual(sesionesDe(admin.id), antesAdmin, "las 2 sesiones legítimas del admin siguen, exactamente");
  assert.deepEqual(sesionesDe(otra.id), antesOtra, "la otra cuenta no se toca");
  assert.equal(refreshVivosDe(admin.id), 2);

  for (const [n, s] of [["s1", s1], ["s2", s2]]) {
    assert.equal((await gt("/auth/v1/user", { token: s.access })).status, 200, `${n}: su access token sigue valiendo`);
    const r = await renovar(s); assert.equal(r.status, 200, `${n}: renueva`); assert.equal(r.sesion, s.sesion, `${n}: misma sesión tras renovar`);
    assert.equal((await gt("/auth/v1/user", { token: r.access })).status, 200, `${n}: el token renovado vale`);
    Object.assign(s, r);
  }
  assert.equal((await renovar(so)).status, 200, "la otra cuenta también renueva");
  assert.deepEqual(obs.logs, [], "sin avisos");
  assert.ok(!JSON.stringify(obs).includes(admin.pass), "la contraseña no aparece en lo observado");
});

test("GoTrue real: contraseña incorrecta → false, no se crea sesión y no se llama a logout", async () => {
  const admin = await crearCuenta("mala"); cuentas.push(admin);
  const s1 = await entrar(admin); const antes = sesionesDe(admin.id);
  const { verificar, obs } = verificadorEspiado();
  assert.equal(await verificar({ id: admin.id, correo: admin.correo }, clave()), false);
  assert.deepEqual(obs.temporales, []); assert.deepEqual(obs.cierres, []);
  assert.deepEqual(sesionesDe(admin.id), antes); assert.equal((await renovar(s1)).status, 200);
});

test("GoTrue real: identidad distinta (el login es válido pero no es el admin autenticado) → primero se cierra la temporal, luego se rechaza", async () => {
  const admin = await crearCuenta("ident"), otra = await crearCuenta("ident-otra"); cuentas.push(admin, otra);
  const s1 = await entrar(admin), s2 = await entrar(admin); const antes = sesionesDe(admin.id);
  const { verificar, obs } = verificadorEspiado();
  // el admin «autenticado» es OTRA cuenta; la contraseña y el correo son los de `admin`
  assert.equal(await verificar({ id: otra.id, correo: admin.correo }, admin.pass), false);
  assert.equal(obs.temporales.length, 1); assert.deepEqual(obs.cierres, [{ ruta: RUTA_CIERRE_TEMPORAL, status: 204 }]);
  const iCierre = obs.rutas.findIndex((r) => r.startsWith("/auth/v1/logout")); assert.ok(iCierre > 0, "el cierre ocurre (después del login)");
  assert.equal(Number(sql(`select count(*) from auth.sessions where id='${obs.temporales[0]}'`)), 0, "temporal cerrada");
  assert.deepEqual(sesionesDe(admin.id), antes, "las sesiones legítimas siguen");
  assert.deepEqual(obs.logs.map((l) => l.o.evento), ["pin-clave-identidad-distinta"]);
  for (const s of [s1, s2]) assert.equal((await renovar(s)).status, 200);
});

test("GoTrue real: control — logout SIN scope cerraría TODAS las sesiones (por eso está prohibido); scope=local solo la del token", async () => {
  const admin = await crearCuenta("control"); cuentas.push(admin);
  const a = await entrar(admin), b = await entrar(admin), c = await entrar(admin);
  assert.equal(sesionesDe(admin.id).length, 3);
  assert.equal((await gt("/auth/v1/logout?scope=local", { metodo: "POST", token: c.access })).status, 204);
  assert.deepEqual(sesionesDe(admin.id), [a.sesion, b.sesion].sort(), "local: solo cae la sesión de ese token");
  assert.equal((await gt("/auth/v1/logout", { metodo: "POST", token: b.access })).status, 204);
  assert.deepEqual(sesionesDe(admin.id), [], "sin scope (= global): caen todas, también la de `a`");
});
