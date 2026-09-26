// SECURITY-1D · E2E con GoTrue REAL (laboratorio LOCAL, nunca producción): PUT /api/admin/clave del api-server REAL (compilado de src/)
// contra la pila local (Postgres + PostgREST con la cadena SYNC + SECURITY-1C), cuyo gateway reenvía /auth/v1/* al GoTrue v2.189.0 del
// laboratorio. Las sesiones se miran en el auth.sessions REAL del laboratorio (solo lectura) y se prueban renovando tokens de verdad.
//   Requiere: pruebas/sync/entorno-local.sh up · laboratorio 4d con db+auth+kong arriba · variables:
//   SEC1D_GOTRUE_URL (http://127.0.0.1:54321) · SEC1D_ANON · SEC1D_SERVICE · SEC1D_DB_CONTENEDOR (Postgres del laboratorio)
// Cuentas sintéticas *@example.test con contraseñas aleatorias en memoria (nunca se imprimen); se borran al terminar.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { iniciarPila } from "../browser/lib/pila.mjs";
import { iniciarApi } from "../browser/lib/api-local.mjs";

const URL_AUTH = process.env.SEC1D_GOTRUE_URL, ANON = process.env.SEC1D_ANON, SERVICIO = process.env.SEC1D_SERVICE, LAB = process.env.SEC1D_DB_CONTENEDOR;
if (!URL_AUTH || !ANON || !SERVICIO || !LAB) throw new Error("Faltan SEC1D_GOTRUE_URL / SEC1D_ANON / SEC1D_SERVICE / SEC1D_DB_CONTENEDOR (laboratorio local).");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(URL_AUTH)) throw new Error("SEC1D_GOTRUE_URL debe ser el laboratorio LOCAL.");

const clave = () => `frase ${crypto.randomBytes(9).toString("base64url")} lenta de marzo`;
const labSql = (q) => { const r = spawnSync("docker", ["exec", LAB, "psql", "-U", "postgres", "-tA", "-c", q], { encoding: "utf8" }); if (r.status !== 0) throw new Error("psql lab: " + r.stderr); return r.stdout.trim(); };
const sesionesDe = (uid) => labSql(`select id from auth.sessions where user_id='${uid}' order by id`).split("\n").filter(Boolean);
const sid = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).session_id;
async function gt(ruta, { m = "GET", tok, body, srv } = {}) {
  const r = await fetch(URL_AUTH + ruta, { method: m, headers: { apikey: srv ? SERVICIO : ANON, Authorization: `Bearer ${srv ? SERVICIO : tok ?? ANON}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* no JSON */ } return { s: r.status, j };
}
let pila, api; const cuentas = [], secretos = [];
async function cuenta(tag, rol, nombre) {
  const c = { correo: `sec1d-${tag}-${crypto.randomBytes(3).toString("hex")}@example.test`, pass: clave(), rol, nombre };
  const r = await gt("/auth/v1/admin/users", { m: "POST", srv: true, body: { email: c.correo, password: c.pass, email_confirm: true } });
  assert.ok([200, 201].includes(r.s), `alta ${tag}`); c.id = r.j.id; cuentas.push(c); secretos.push(c.pass);
  // su perfil en la base de la pila (el 2.º, 3.º… admin solo existe en esta base de pruebas: se salta el trigger de admin único)
  pila.sql(`set session_replication_role = replica; insert into auth.users (id, email) values ('${c.id}', '${c.correo}') on conflict do nothing;
            insert into public.perfiles (id, nombre, rol, activo) values ('${c.id}', '${nombre}', '${rol}', true) on conflict (id) do update set rol = excluded.rol, activo = true;`);
  return c;
}
const entrar = async (c, p = c.pass) => { const r = await gt("/auth/v1/token?grant_type=password", { m: "POST", body: { email: c.correo, password: p } }); if (r.s !== 200) return { s: r.s, code: r.j?.error_code }; secretos.push(r.j.access_token, r.j.refresh_token); return { s: 200, a: r.j.access_token, r: r.j.refresh_token, sid: sid(r.j.access_token) }; };
const renovar = async (x) => { const r = await gt("/auth/v1/token?grant_type=refresh_token", { m: "POST", body: { refresh_token: x.r } }); if (r.s === 200) { secretos.push(r.j.access_token, r.j.refresh_token); return { s: 200, a: r.j.access_token, r: r.j.refresh_token, sid: sid(r.j.access_token) }; } return { s: r.s }; };
const cerrarLocal = (x) => gt("/auth/v1/logout?scope=local", { m: "POST", tok: x.a });
async function cambiar(s1, cuerpo) {
  const r = await fetch(api.url + "/api/admin/clave", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${s1.a}` }, body: JSON.stringify(cuerpo) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* no JSON */ } return { s: r.status, j, retry: r.headers.get("retry-after"), cc: r.headers.get("cache-control"), crudo: t };
}
const intentos = (uid) => pila.sql(`select string_agg(resultado, ',' order by id) from public.admin_clave_intentos where perfil_id = '${uid}'`);
const auditoriaDe = (uid) => pila.sql(`select coalesce(json_agg(json_build_object('usuario_id', usuario_id, 'usuario', usuario, 'rol', rol, 'entidad', entidad, 'entidad_id', entidad_id, 'detalle', detalle, 'resultado', resultado) order by creado_en), '[]') from public.auditoria where accion = 'cambio-clave-admin' and rol = 'admin' and usuario_id = '${uid}'`);

before(async () => {
  pila = await iniciarPila({ fasesExtra: ["sec-1c-clave-intentos"], authReal: { url: URL_AUTH, anon: ANON } });
  api = await iniciarApi(pila);
});
after(async () => {
  for (const c of cuentas) await gt(`/auth/v1/admin/users/${c.id}`, { m: "DELETE", srv: true });
  await api?.detener(); await pila?.detener();
});

test("E2E · éxito: se cambia con S1; T desaparece; S1 sigue y renueva; S2 revocada; cajero y mecánico intactos; A no entra, B sí; auditoría real", async () => {
  const adm = await cuenta("adm", "admin", "Rosa Mejía"), caj = await cuenta("caj", "cajero", "Caja"), mec = await cuenta("mec", "mecanico", "Mec");
  const S1 = await entrar(adm), S2 = await entrar(adm), C1 = await entrar(caj), M1 = await entrar(mec);
  assert.deepEqual(sesionesDe(adm.id), [S1.sid, S2.sid].sort());
  const B = clave(); secretos.push(B);
  const r = await cambiar(S1, { clave_actual: adm.pass, clave_nueva: B, clave_confirmacion: B });
  assert.deepEqual([r.s, r.j], [200, { ok: true, otras_sesiones_cerradas: true }]); assert.equal(r.cc, "no-store");
  assert.deepEqual(sesionesDe(adm.id), [S1.sid], "del admin queda SOLO S1 (S2 y la temporal T ya no existen)");
  assert.equal((await gt("/auth/v1/user", { tok: S1.a })).s, 200, "S1: su token sigue valiendo");
  const S1b = await renovar(S1); assert.deepEqual([S1b.s, S1b.sid], [200, S1.sid], "S1 renueva y sigue siendo la misma sesión");
  assert.equal((await gt("/auth/v1/user", { tok: S2.a })).s, 403, "S2: su access token ya no vale en GoTrue");
  assert.equal((await renovar(S2)).s, 400, "S2: no renueva (revocada)");
  for (const [n, x, c] of [["cajero", C1, caj], ["mecánico", M1, mec]]) { const y = await renovar(x); assert.equal(y.s, 200, `${n} renueva`); assert.deepEqual(sesionesDe(c.id), [x.sid], `${n}: su sesión intacta`); }
  const vieja = await entrar(adm); assert.deepEqual([vieja.s, vieja.code], [400, "invalid_credentials"], "la contraseña ANTERIOR ya no entra");
  const nueva = await entrar(adm, B); assert.equal(nueva.s, 200, "la NUEVA sí"); await cerrarLocal(nueva);
  assert.deepEqual(sesionesDe(adm.id), [S1.sid], "no quedan sesiones inesperadas");
  assert.equal(intentos(adm.id), "reservado,ok");
  assert.deepEqual(JSON.parse(auditoriaDe(adm.id)), [{ usuario_id: adm.id, usuario: "Rosa Mejía", rol: "admin", entidad: "cuenta", entidad_id: adm.id, detalle: '{"otras_sesiones_cerradas":true}', resultado: "ok" }]);
  const anterior = adm.pass; adm.pass = B; Object.assign(S1, S1b); globalThis.__e2e = { adm, S1, anterior };
});

test("E2E · F/G: la MISMA petición reenviada (respuesta perdida) con la contraseña anterior → 401 CLAVE_INCORRECTA (fallido); NO se vuelve a cambiar", async () => {
  const { adm, S1, anterior } = globalThis.__e2e;
  const r = await cambiar(S1, { clave_actual: anterior, clave_nueva: adm.pass, clave_confirmacion: adm.pass });
  // (la «nueva» del reenvío es la que YA está puesta; aunque no lo fuera, con la actual incorrecta no se llega a cambiar)
  assert.deepEqual([r.s, r.j.codigo], [401, "CLAVE_INCORRECTA"]);
  assert.equal((await entrar(adm)).s, 200, "la contraseña vigente sigue siendo la del cambio");
  assert.equal(intentos(adm.id), "reservado,ok,reservado,fallido");
  assert.equal(JSON.parse(auditoriaDe(adm.id)).length, 1, "un solo evento de cambio");
  assert.deepEqual(sesionesDe(adm.id).filter((x) => x !== S1.sid).length, 1, "solo S1 + la del login de comprobación de arriba");
});

test("E2E · A: contraseña actual incorrecta → 401 CLAVE_INCORRECTA (fallido); sesiones legítimas intactas y renovando; sin sesión temporal colgada", async () => {
  const adm = await cuenta("mala", "admin", "Admin Dos"); const S1 = await entrar(adm), S2 = await entrar(adm);
  const r = await cambiar(S1, { clave_actual: clave(), clave_nueva: "otra frase muy distinta", clave_confirmacion: "otra frase muy distinta" });
  assert.deepEqual([r.s, r.j.codigo], [401, "CLAVE_INCORRECTA"]);
  assert.deepEqual(sesionesDe(adm.id), [S1.sid, S2.sid].sort()); for (const x of [S1, S2]) assert.equal((await renovar(x)).s, 200);
  assert.equal(intentos(adm.id), "reservado,fallido"); assert.equal((await entrar(adm)).s, 200, "la contraseña no cambió");
});

test("E2E · H: dos cambios SIMULTÁNEOS del mismo admin → uno 200 y el otro 409 CAMBIO_EN_CURSO (con Retry-After); la contraseña cambia UNA vez", async () => {
  const adm = await cuenta("conc", "admin", "Admin Tres"); const S1 = await entrar(adm);
  const B = clave(); secretos.push(B);
  const cuerpo = { clave_actual: adm.pass, clave_nueva: B, clave_confirmacion: B };
  const [x, y] = await Promise.all([cambiar(S1, cuerpo), cambiar(S1, cuerpo)]);
  const st = [x.s, y.s].sort(); assert.deepEqual(st, [200, 409]);
  const r409 = x.s === 409 ? x : y; assert.equal(r409.j.codigo, "CAMBIO_EN_CURSO"); assert.ok(Number(r409.retry) >= 1);
  assert.equal(JSON.parse(auditoriaDe(adm.id)).length, 1); assert.equal((await entrar(adm, B)).s, 200);
  assert.equal(intentos(adm.id), "reservado,ok", "el rechazado por «en curso» no dejó reserva");
});

test("E2E · GoTrue caído: 503 AUTH_NO_DISPONIBLE y NO se consume ningún intento; al volver, todo funciona", async () => {
  const adm = await cuenta("caida", "admin", "Admin Cuatro"); const S1 = await entrar(adm);
  pila.authRealUrl("http://127.0.0.1:9");
  try {
    const r = await cambiar(S1, { clave_actual: adm.pass, clave_nueva: "frase nueva de prueba larga", clave_confirmacion: "frase nueva de prueba larga" });
    assert.deepEqual([r.s, r.j.codigo], [503, "AUTH_NO_DISPONIBLE"]);
  } finally { pila.authRealUrl(URL_AUTH); }
  assert.equal(intentos(adm.id), "", "ninguna reserva: el proveedor caído no cuenta (psql: sin filas → vacío)");
  assert.equal((await renovar(S1)).s, 200);
});

test("E2E · sin secretos: ni contraseñas ni tokens en los logs del backend, en auditoria ni en admin_clave_intentos", async () => {
  const logs = api.salida();
  const aud = pila.sql("select coalesce(string_agg(row_to_json(a)::text, E'\\n'), '') from public.auditoria a");
  const ints = pila.sql("select coalesce(string_agg(row_to_json(i)::text, E'\\n'), '') from public.admin_clave_intentos i");
  for (const s of secretos) {
    for (const [donde, texto] of [["logs", logs], ["auditoria", aud], ["admin_clave_intentos", ints]]) assert.ok(!texto.includes(s) && !texto.includes(s.slice(0, 16)), `secreto en ${donde}`);
  }
  assert.doesNotMatch(logs, /SyntaxError|is not valid JSON/);
});
