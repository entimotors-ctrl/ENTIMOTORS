// ENTIMOTORS 3.15 · Bloque 5 · pruebas B01–B21 del RESPALDO DE NEGOCIO (herramientas reales: respaldar.sh, restaurar-aislado.sh,
// puerta-pre-release.sh, respaldo.mjs). Origen: contenedor de laboratorio SIN RED con la copia real de producción del Bloque 0 + 15a..15e
// (B5_ORIGEN=entimotors-b5-origen, db origen). Nunca toca producción. Si el contenedor no existe, las pruebas se omiten (lo dicen).
//   node --test operacion/respaldo/pruebas/respaldo.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, existsSync, chmodSync, truncateSync, openSync, writeSync, closeSync, unlinkSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarRespaldo, clasificarArchivo, escanearSecretos, sellarManifiesto, compararFotos, inventarioDesdeFoto, verificarStorage } from "../lib/respaldo.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(AQUI, "..");
const ORIGEN = process.env.B5_ORIGEN || "entimotors-b5-origen";
const STORAGE_COPIA = process.env.B5_STORAGE || "/home/wilkin/Escritorio/Sistema-emos/ENTIMOTORS-3.15-bloque0/storage";
const DUMP_B0 = "/home/wilkin/Escritorio/Sistema-emos/ENTIMOTORS-respaldo-pre-3.15-20260929T034502Z/entimotors-prod-pre-3.15-20260929T034502Z.dump";
const IMG = "public.ecr.aws/supabase/postgres:17.6.1.134";
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...o });
const hay = run("docker", ["exec", ORIGEN, "psql", "-U", "supabase_admin", "-d", "origen", "-Atc", "select count(*) from sync_fases where fase='15e'"]).stdout?.trim() === "1";
const SKIP = hay ? false : `sin el contenedor de laboratorio ${ORIGEN} con 15e`;
const T = mkdtempSync(path.join(os.tmpdir(), "entimotors-b5-"));
const R = path.join(T, "respaldo");
let restauracion = null, salidaRespaldo = "";
const psqlO = (q) => run("docker", ["exec", ORIGEN, "psql", "-U", "supabase_admin", "-d", "origen", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-Atc", q]);
function copia(nombre) {   // copia escribible del respaldo para mutarla
  const d = path.join(T, nombre); cpSync(R, d, { recursive: true });
  for (const f of readdirSync(d, { recursive: true })) { try { chmodSync(path.join(d, f), 0o700); } catch {} }
  chmodSync(d, 0o700); return d;
}
const lineas = (t, pre) => t.split("\n").filter((l) => l.startsWith(pre)).sort().join("\n");

before(() => {
  if (SKIP) return;
  // actividad 3.15 en el origen: un mensaje admin → mecánico y un gasto de caja, por las RPC reales (sesión del admin real)
  const adm = psqlO("select id from perfiles where rol='admin' and activo limit 1").stdout.trim();
  const mec = psqlO("select id from perfiles where rol='mecanico' and activo limit 1").stdout.trim();
  const ses = `select set_config('request.jwt.claim.sub','${adm}',false), set_config('request.jwt.claims','{"sub":"${adm}","role":"authenticated"}',false), set_config('role','authenticated',false);`;
  const r = run("docker", ["exec", "-i", ORIGEN, "psql", "-U", "supabase_admin", "-d", "origen", "-X", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: `${ses}\nselect public.enviar_mensaje(gen_random_uuid(), gen_random_uuid(), '${mec}', 'Prueba B5 del respaldo', null, null, 'lab');\n` +
           `select public.registrar_movimiento_caja(gen_random_uuid(), 'egreso', 'Servicios / renta', 25, 'efectivo', 'B5 respaldo', null, 'lab');\n` });
  assert.equal(r.status, 0, r.stderr);
  const s = run("bash", [path.join(KIT, "respaldar.sh"), "--salida", R, "--origen-contenedor", ORIGEN, "--db", "origen", "--storage-copia", STORAGE_COPIA]);
  salidaRespaldo = s.stdout + s.stderr;
  assert.equal(s.status, 0, salidaRespaldo.slice(-3000));
});
after(() => { try { spawnSync("chmod", ["-R", "u+w", T]); rmSync(T, { recursive: true, force: true }); } catch {} });

test("B01 respaldo de la base: pg_dump legible (TOC) con los datos del negocio y el esquema completo", { skip: SKIP }, () => {
  const toc = readFileSync(path.join(R, "toc.txt"), "utf8");
  assert.ok(toc.split("\n").filter((l) => l && !l.startsWith(";")).length > 1000, "TOC con > 1000 entradas");
  for (const t of ["ordenes", "caja_movimientos", "creditos", "abonos", "ventas", "inventario_movimientos", "mensajes", "auditoria"])
    assert.match(toc, new RegExp(`TABLE DATA public ${t} `), t);
  assert.match(toc, /TABLE DATA storage objects /); assert.match(toc, /TABLE DATA storage buckets /);
  assert.match(salidaRespaldo, /RESPALDO VERIFICADO/);
});

test("B02 manifiesto: todos los campos (versión, fecha/zona, PostgreSQL, fases, tablas/conteos, Storage, artefactos, verificación)", { skip: SKIP }, () => {
  const m = JSON.parse(readFileSync(path.join(R, "manifiesto.json"), "utf8"));
  assert.equal(m.formato, "entimotors-respaldo-negocio"); assert.equal(m.version_formato, 1);
  assert.match(m.entimotors_version, /^3\.\d+\.\d+$/); assert.equal(m.zona, "America/Tegucigalpa"); assert.match(m.creado_utc, /Z$/);
  assert.equal(m.postgres_version, "17.6"); assert.match(m.pg_dump_version, /^17/); assert.equal(m.fases, "15b,15c,15d,15e");
  assert.ok(m.tablas["public.ordenes"] > 0 && m.tablas["public.mensajes"] >= 1 && m.tablas["auth.users"] >= 3);
  assert.equal(m.storage.objetos, 13); assert.deepEqual(Object.keys(m.storage.buckets).sort(), ["entimotors-media", "entimotors-taller"]);
  assert.equal(m.storage.bytes, 2850461 + 2293352);
  assert.equal(m.verificacion.resultado, "VERIFICADO"); assert.equal(m.secretos.resultado, "LIMPIO");
  assert.ok(m.no_incluye.some((x) => /contraseñas/.test(x)) && m.no_incluye.some((x) => /PIN/.test(x)));
  assert.match(m.catalogo.funciones, /^\d+\|[0-9a-f]{32}$/);
});

test("B03 hashes: SHA-256 de cada artefacto, sello del manifiesto y archivo .sha256 — la verificación independiente pasa", { skip: SKIP }, async () => {
  const m = JSON.parse(readFileSync(path.join(R, "manifiesto.json"), "utf8"));
  assert.ok(m.artefactos.length >= 17 && m.artefactos.every((a) => /^[0-9a-f]{64}$/.test(a.sha256) && a.bytes > 0));
  assert.ok(m.artefactos.some((a) => a.tipo === "pg_dump") && m.artefactos.filter((a) => a.tipo === "storage_objeto").length === 13);
  const v = await verificarRespaldo(R, { restauradorVersion: m.entimotors_version });
  assert.deepEqual(v.errores, []); assert.equal(v.ok, true);
  const cli = run("node", [path.join(KIT, "respaldo.mjs"), "verificar", "--dir", R]); assert.equal(cli.status, 0, cli.stdout);
});

test("B04 Storage: inventario de la base = archivos (13/13); detecta FALTANTE, EXTRA y MODIFICADO", { skip: SKIP }, async () => {
  const inv = inventarioDesdeFoto(readFileSync(path.join(R, "foto-origen.txt"), "utf8"));
  assert.equal(inv.length, 13);
  const d = copia("b04");
  let r = await verificarStorage(inv, path.join(d, "storage")); assert.equal(r.ok, true); assert.equal(r.verificados.length, 13);
  const uno = path.join(d, "storage", inv[0].bucket, inv[0].ruta);
  unlinkSync(uno); r = await verificarStorage(inv, path.join(d, "storage")); assert.deepEqual(r.faltan, [`${inv[0].bucket}/${inv[0].ruta}`]);
  writeFileSync(path.join(d, "storage", "entimotors-taller", "intruso.jpg"), "x"); r = await verificarStorage(inv, path.join(d, "storage")); assert.ok(r.sobran.includes("entimotors-taller/intruso.jpg"));
  const otro = path.join(d, "storage", inv[1].bucket, inv[1].ruta); const fd = openSync(otro, "r+"); writeSync(fd, Buffer.from([0x41]), 0, 1, 100); closeSync(fd);
  r = await verificarStorage(inv, path.join(d, "storage")); assert.equal(r.diferentes.length, 1);
});

test("B05–B13 restauración AISLADA (contenedor nuevo, sin red): negocio, finanzas, Storage, caja, créditos, inventario, movimientos, mensajes y auditoría iguales", { skip: SKIP }, () => {
  const r = run("bash", [path.join(KIT, "restaurar-aislado.sh"), R]);
  assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-4000));
  restauracion = path.join(T, readdirSync(T).find((f) => f.startsWith("restauracion-respaldo-")));
  const res = readFileSync(path.join(restauracion, "RESUMEN.txt"), "utf8");
  assert.match(res, /red=none/, "B05 sin red"); assert.match(res, /RESULTADO=PASS/);
  const fo = readFileSync(path.join(R, "foto-origen.txt"), "utf8"), fr = readFileSync(path.join(restauracion, "foto-restaurada.txt"), "utf8");
  const Fo = readFileSync(path.join(R, "finanzas-origen.txt"), "utf8"), Fr = readFileSync(path.join(restauracion, "finanzas-restaurada.txt"), "utf8");
  for (const k of ["huella_negocio", "huella_auth_usuarios", "huella_storage_objetos", "huella_tabla|"]) assert.equal(lineas(fr, k), lineas(fo, k), `B06 ${k}`);
  assert.equal(lineas(fr, "invariantes"), lineas(fo, "invariantes")); assert.match(lineas(fr, "invariantes|"), /\[\]/, "B07");
  assert.equal(lineas(Fr, "caja"), lineas(Fo, "caja"), "B08 caja"); assert.ok(lineas(Fo, "caja|").length > 0);
  assert.equal(lineas(Fr, "creditos|") + lineas(Fr, "abonos") + lineas(Fr, "por_cobrar"), lineas(Fo, "creditos|") + lineas(Fo, "abonos") + lineas(Fo, "por_cobrar"), "B09 créditos");
  assert.equal(lineas(fr, "inventario|"), lineas(fo, "inventario|"), "B10 inventario");
  assert.equal(lineas(fr, "ledger_por_tipo|") + lineas(Fr, "inv_mov|"), lineas(fo, "ledger_por_tipo|") + lineas(Fo, "inv_mov|"), "B11 movimientos");
  assert.equal(lineas(fr, "mensajes"), lineas(fo, "mensajes"), "B12 mensajes"); assert.match(lineas(fo, "mensajes"), /mensajes\|[1-9]/);
  assert.equal(lineas(fr, "auditoria"), lineas(fo, "auditoria"), "B13 auditoría");
  assert.match(readFileSync(path.join(restauracion, "storage.txt"), "utf8"), /verificados 13 · faltan 0/);
  assert.equal(compararFotos(fo, fr).ok, true);
});

test("B14 archivo truncado → rechazado (dump truncado y manifiesto truncado)", { skip: SKIP }, async () => {
  const d = copia("b14"); truncateSync(path.join(d, "base.dump"), 4096);
  let v = await verificarRespaldo(d); assert.ok(v.errores.some((e) => e.codigo === "ARTEFACTO_TRUNCADO"), JSON.stringify(v.errores));
  const d2 = copia("b14b"); const man = path.join(d2, "manifiesto.json"); writeFileSync(man, readFileSync(man, "utf8").slice(0, 500));
  v = await verificarRespaldo(d2); assert.equal(v.errores[0].codigo, "MANIFIESTO_ILEGIBLE");
  const r = run("bash", [path.join(KIT, "restaurar-aislado.sh"), d]); assert.notEqual(r.status, 0); assert.match(r.stdout, /RESTAURACIÓN NO INICIADA/);
});

test("B15 hash alterado (mismo tamaño, un byte distinto) → rechazado", { skip: SKIP }, async () => {
  const d = copia("b15"); const f = path.join(d, "base.dump"); const fd = openSync(f, "r+"); writeSync(fd, Buffer.from([0x00]), 0, 1, statSync(f).size - 50); closeSync(fd);
  const v = await verificarRespaldo(d); assert.ok(v.errores.some((e) => e.codigo === "HASH_INCORRECTO" && /base\.dump/.test(e.detalle)));
});

test("B16 manifiesto alterado → rechazado (contenido sin re-sellar, y re-sellado pero sin el .sha256)", { skip: SKIP }, async () => {
  const d = copia("b16"); const man = path.join(d, "manifiesto.json"); const m = JSON.parse(readFileSync(man, "utf8"));
  m.tablas["public.caja_movimientos"] += 1; writeFileSync(man, JSON.stringify(m, null, 2));
  let v = await verificarRespaldo(d); assert.ok(v.errores.some((e) => e.codigo === "MANIFIESTO_ALTERADO"));
  writeFileSync(man, JSON.stringify(sellarManifiesto(m), null, 2));   // quien lo altera también recalcula el sello interno
  v = await verificarRespaldo(d); assert.ok(v.errores.some((e) => e.codigo === "MANIFIESTO_ALTERADO" && /sha256/.test(e.detalle)), "el .sha256 aparte lo delata");
});

test("B17 formato/versión incompatibles → rechazados (otro formato, versión futura, copia 3.13 de teléfono, copia de dispositivo 3.14)", { skip: SKIP }, async () => {
  const conManifiesto = async (nombre, obj) => { const d = copia(nombre); const t = JSON.stringify(obj); writeFileSync(path.join(d, "manifiesto.json"), t);
    writeFileSync(path.join(d, "manifiesto.json.sha256"), (await import("node:crypto")).createHash("sha256").update(t).digest("hex") + "  manifiesto.json\n"); return verificarRespaldo(d, { restauradorVersion: "3.14.1" }); };
  const m = JSON.parse(readFileSync(path.join(R, "manifiesto.json"), "utf8"));
  let v = await conManifiesto("b17a", sellarManifiesto({ ...m, version_formato: 2 })); assert.ok(v.errores.some((e) => e.codigo === "VERSION_INCOMPATIBLE"));
  v = await conManifiesto("b17b", sellarManifiesto({ ...m, entimotors_version: "9.0.0" })); assert.ok(v.errores.some((e) => e.codigo === "VERSION_INCOMPATIBLE" && /más nuevo/.test(e.detalle)));
  v = await conManifiesto("b17c", { hola: "mundo" }); assert.equal(v.errores[0].codigo, "FORMATO_INCOMPATIBLE");
  v = await conManifiesto("b17d", { version: 2, versionApp: "3.13.0", esquemaDB: 6, data: { ordenes: [] } });
  assert.equal(v.errores[0].codigo, "FORMATO_INCOMPATIBLE"); assert.match(v.errores[0].detalle, /3\.13/, "backup 3.13 entregado al restaurador 3.15");
  v = await conManifiesto("b17e", { formato: "entimotors-copia-dispositivo", alcance: "cache-nube", version: 2, versionApp: "3.14.1", data: { ordenes: [] } }); assert.match(v.errores[0].detalle, /DISPOSITIVO/);
  // 3.15 (Bloque 6): la clase se decide por el CONTENIDO (base local v6), no por la versión que lo exportó
  assert.equal(clasificarArchivo({ version: 2, versionApp: "3.13.0", esquemaDB: 6, data: {} }), "legado-v6");
  assert.equal(clasificarArchivo(m), "negocio-3.15");
});

test("B18 no contiene secretos: escaneo LIMPIO del SQL completo + sin DATOS de auth/vault/PIN; control positivo con el volcado completo del Bloque 0", { skip: SKIP }, () => {
  const toc = readFileSync(path.join(R, "toc.txt"), "utf8");
  for (const t of ["auth users", "auth refresh_tokens", "auth sessions", "vault secrets", "public admin_pin ", "auth oauth_clients"])
    assert.doesNotMatch(toc, new RegExp(`TABLE DATA ${t}`), `sin datos de ${t}`);
  const csv = readFileSync(path.join(R, "auth-usuarios.csv"), "utf8");
  assert.doesNotMatch(csv.split("\n")[0], /password|token/i, "el CSV de usuarios no tiene columnas de contraseña ni tokens");
  const plano = path.join(T, "b18.sql");
  let r = run("docker", ["run", "--rm", "-u", `${process.getuid()}:${process.getgid()}`, "-v", `${R}:/in:ro`, "-v", `${T}:/out`, "--entrypoint", "pg_restore", IMG, "-f", "/out/b18.sql", "/in/base.dump"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(escanearSecretos({ sql: readFileSync(plano, "utf8"), csv, manifiesto: readFileSync(path.join(R, "manifiesto.json"), "utf8") }), []);
  unlinkSync(plano);
  // control positivo: un pg_dump COMPLETO de Supabase (como el del Bloque 0) SÍ trae secretos, y el escaneo lo detecta
  if (existsSync(DUMP_B0)) {
    r = run("docker", ["run", "--rm", "-u", `${process.getuid()}:${process.getgid()}`, "-v", `${path.dirname(DUMP_B0)}:/in:ro`, "-v", `${T}:/out`, "--entrypoint", "pg_restore", IMG, "-f", "/out/b0.sql", "/in/" + path.basename(DUMP_B0)]);
    const h = escanearSecretos({ b0: readFileSync(path.join(T, "b0.sql"), "utf8") }).map((x) => x.patron);
    unlinkSync(path.join(T, "b0.sql"));
    assert.ok(h.includes("bcrypt") && h.includes("datos_auth_secretos"), "el escaneo detecta hashes de contraseña y tokens en un volcado completo: " + h.join(","));
  }
});

test("B19 restaurar sobre producción (u otro destino) está bloqueado: no se crea ningún contenedor ni se conecta a nada", { skip: SKIP }, () => {
  const antes = run("docker", ["ps", "-aq", "--filter", "name=entimotors-restore"]).stdout.trim();
  for (const a of [["--destino", "service=entimotors_prod"], ["service=entimotors_prod"], ["postgresql://postgres@db.x.supabase.co:5432/postgres"], ["host=aws-0-us-west-2.pooler.supabase.com"]]) {
    const r = run("bash", [path.join(KIT, "restaurar-aislado.sh"), ...a, R]);
    assert.equal(r.status, 3, a.join(" ")); assert.match(r.stderr, /DESTINO EXTERNO PROHIBIDA/);
  }
  assert.equal(run("docker", ["ps", "-aq", "--filter", "name=entimotors-restore"]).stdout.trim(), antes);
  const src = readFileSync(path.join(KIT, "restaurar-aislado.sh"), "utf8");
  assert.match(src, /--network none/); assert.doesNotMatch(src.replace(/^#.*$/gm, ""), /pg_service|PGSERVICE|psql "service=|--network host/);
});

test("B20 una restauración en la nube es DESTRUCTIVA: catálogo OWNER-PIN (backend, UI y base) y ninguna ruta del backend restaura", { skip: SKIP }, () => {
  const raiz = path.resolve(KIT, "../..");
  assert.match(readFileSync(path.join(raiz, "api-server/src/lib/pin.ts"), "utf8"), /restaurar_respaldo: \{ entidad: "respaldos", roles: \["admin"\], destructiva: true \}/);
  assert.match(readFileSync(path.join(raiz, "taller-demo/pin-ui.js"), "utf8"), /restaurar_respaldo: true/);
  assert.match(readFileSync(path.join(raiz, "taller-demo/supabase/sync/sync-15e-finanzas.sql"), "utf8"), /'eliminar_usuario', 'restaurar_respaldo'\]/);
  const rutas = readdirSync(path.join(raiz, "api-server/src/routes")).map((f) => readFileSync(path.join(raiz, "api-server/src/routes", f), "utf8")).join("\n");
  assert.doesNotMatch(rutas, /restaur/i, "no existe endpoint de restauración");
});

test("B21 un fallo del respaldo BLOQUEA el release (respaldo corrupto y respaldo con Storage incompleto)", { skip: SKIP }, () => {
  const d = copia("b21"); truncateSync(path.join(d, "base.dump"), 1000);
  let r = run("bash", [path.join(KIT, "puerta-pre-release.sh"), "--respaldo-existente", d]);
  assert.equal(r.status, 1); assert.match(r.stdout, /RELEASE BLOQUEADO/);
  const incompleto = path.join(T, "storage-incompleto"); cpSync(STORAGE_COPIA, incompleto, { recursive: true });
  const f = readdirSync(path.join(incompleto, "entimotors-taller/ordenes"), { recursive: true }).find((x) => x.endsWith(".jpg"));
  unlinkSync(path.join(incompleto, "entimotors-taller/ordenes", f));
  r = run("bash", [path.join(KIT, "puerta-pre-release.sh"), "--salida", path.join(T, "b21-sal"), "--origen-contenedor", ORIGEN, "--db", "origen", "--storage-copia", incompleto]);
  assert.equal(r.status, 1, r.stdout.slice(-1500)); assert.match(r.stdout, /RELEASE BLOQUEADO: el respaldo no quedó VERIFICADO/); assert.match(r.stdout, /faltan 1/);
});
