// RCV-34 Fase 3C · fixtures automaticos para guard-estatico-funciones.mjs (REV4).
// No toca produccion, no toca Supabase. Todo en memoria salvo el fixture 20 (crea y borra un
// archivo temporal DENTRO del repo, bajo pruebas/rcv34/) y el fixture de baseline corrupto (22),
// que escribe a un directorio temporal del sistema.
// Uso: node guard-estatico-funciones.test.mjs   (exit 0 si todo pasa, 1 si algo falla)
import { writeFileSync, unlinkSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  analizarTexto, validarBaseline, descubrirSql, detectarHuerfanas, REPO_ROOT,
  sha256, validarExcepciones, verificarHashExcepciones, clasificarProhibidos, detectarExcepcionesHuerfanas,
  analizarArchivo, EXCEPCIONES_PATH,
} from "./guard-estatico-funciones.mjs";

const ARCHIVO = "fixture.sql";
let ok = 0, total = 0;
function verificar(nombre, real, esperado) {
  total++;
  const pasa = real.length === esperado.length &&
    esperado.every((e, i) => real[i]?.categoria === e.categoria && real[i]?.ok === e.ok &&
      (e.firma === undefined || real[i]?.firma === e.firma));
  console.log(`${pasa ? "PASS" : "FAIL"}  ${nombre}` +
    (pasa ? "" : `  -> obtenido=${JSON.stringify(real.map(f => ({ categoria: f.categoria, ok: f.ok, firma: f.firma })))} esperado=${JSON.stringify(esperado)}`));
  if (pasa) ok++;
}
function verificarCondicion(nombre, condicion, detalle) {
  total++;
  console.log(`${condicion ? "PASS" : "FAIL"}  ${nombre}${condicion ? "" : "  -> " + detalle}`);
  if (condicion) ok++;
}

// ── 1-10: igual que REV3 ────────────────────────────────────────────────────────────────────
verificar("1 nueva segura", analizarTexto(ARCHIVO, `
  create or replace function public.nueva_segura() returns void language sql as $$ select 1 $$;
  revoke execute on function public.nueva_segura() from public;
  revoke execute on function public.nueva_segura() from anon;
  grant execute on function public.nueva_segura() to authenticated, service_role;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true }]);

verificar("2 nueva sin REVOKE PUBLIC", analizarTexto(ARCHIVO, `
  create or replace function public.nueva_sin_public() returns void language sql as $$ select 1 $$;
  revoke execute on function public.nueva_sin_public() from anon;
  grant execute on function public.nueva_sin_public() to authenticated;
`, new Map()).funciones, [{ categoria: "nueva_insegura", ok: false }]);

verificar("3 nueva sin REVOKE anon", analizarTexto(ARCHIVO, `
  create or replace function public.nueva_sin_anon() returns void language sql as $$ select 1 $$;
  revoke execute on function public.nueva_sin_anon() from public;
  grant execute on function public.nueva_sin_anon() to authenticated;
`, new Map()).funciones, [{ categoria: "nueva_insegura", ok: false }]);

verificar("4 REVOKE solo en comentario", analizarTexto(ARCHIVO, `
  create or replace function public.revoke_en_comentario() returns void language sql as $$ select 1 $$;
  -- revoke execute on function public.revoke_en_comentario() from public;
  revoke execute on function public.revoke_en_comentario() from anon;
  grant execute on function public.revoke_en_comentario() to authenticated;
`, new Map()).funciones, [{ categoria: "nueva_insegura", ok: false }]);

verificar("5 GRANT solo en comentario", analizarTexto(ARCHIVO, `
  create or replace function public.grant_en_comentario() returns void language sql as $$ select 1 $$;
  revoke execute on function public.grant_en_comentario() from public;
  revoke execute on function public.grant_en_comentario() from anon;
  /* grant execute on function public.grant_en_comentario() to authenticated; */
`, new Map()).funciones, [{ categoria: "nueva_insegura", ok: false }]);

const historicaBase = `
  create or replace function public.historica_sin_cerrar(a int, b text) returns void
  language sql as $$ select 1 $$;
`;
const resultado6 = analizarTexto(ARCHIVO, historicaBase, new Map()).funciones[0];
const firmaHistorica = resultado6.firma;
const baseline6 = new Map([[`${ARCHIVO}|${firmaHistorica}`, resultado6.hashActual]]);

verificar("6 historica identica al baseline", analizarTexto(ARCHIVO, historicaBase, baseline6).funciones,
  [{ categoria: "legacy_baseline", ok: true }]);

const historicaModificada = `
  create or replace function public.historica_sin_cerrar(a int, b text) returns void
  language sql as $$ select 2 $$;
`;
verificar("7 historica modificada (hash distinto)", analizarTexto(ARCHIVO, historicaModificada, baseline6).funciones,
  [{ categoria: "legacy_modificada", ok: false }]);

const historicaRenombrada = `
  create or replace function public.historica_sin_cerrar_v2(a int, b text) returns void
  language sql as $$ select 1 $$;
`;
verificar("8 historica renombrada (sin baseline)", analizarTexto(ARCHIVO, historicaRenombrada, baseline6).funciones,
  [{ categoria: "nueva_insegura", ok: false }]);

verificar("9 segura SECURITY DEFINER con ACL", analizarTexto(ARCHIVO, `
  create or replace function public.segura_definer() returns trigger
  language plpgsql security definer set search_path = public as $$ begin return new; end $$;
  revoke execute on function public.segura_definer() from public;
  revoke execute on function public.segura_definer() from anon;
  grant execute on function public.segura_definer() to authenticated, service_role;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true }]);

verificar("10 sintaxis no reconocible", analizarTexto(ARCHIVO, `
  create or replace function public.raro() returns void language sql select 1;
`, new Map()).funciones, [{ categoria: "unparseable", ok: false }]);

verificar("11 overloads: uno cerrado, otro no", analizarTexto(ARCHIVO, `
  create or replace function public.demo(a integer) returns void language sql as $$ select 1 $$;
  create or replace function public.demo(a text) returns void language sql as $$ select 1 $$;
  revoke execute on function public.demo(integer) from public, anon;
  grant execute on function public.demo(integer) to authenticated;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true }, { categoria: "nueva_insegura", ok: false }]);

verificar("12 REVOKE/GRANT dentro de string", analizarTexto(ARCHIVO, `
  create or replace function public.demo12() returns void language sql as $$ select 1 $$;
  select 'revoke execute on function public.demo12() from public, anon; grant execute on function public.demo12() to authenticated;';
`, new Map()).funciones, [{ categoria: "nueva_insegura", ok: false }]);

verificar("13 REVOKE/GRANT dentro de cuerpo $$...$$", analizarTexto(ARCHIVO, `
  create or replace function public.demo13() returns void language plpgsql as $$
  begin
    raise notice 'revoke execute on function public.demo13() from public, anon;';
    raise notice 'grant execute on function public.demo13() to authenticated;';
  end
  $$;
`, new Map()).funciones, [{ categoria: "nueva_insegura", ok: false }]);

verificar("14 CREATE FUNCTION dentro de body", analizarTexto(ARCHIVO, `
  create or replace function public.demo14() returns void language plpgsql as $$
  begin
    execute 'create or replace function public.fake14() returns void language sql as $x$ select 1 $x$;';
  end
  $$;
  revoke execute on function public.demo14() from public, anon;
  grant execute on function public.demo14() to authenticated;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true }]);

verificar("15 comentario con CREATE/REVOKE/GRANT", analizarTexto(ARCHIVO, `
  -- create or replace function public.fake15() returns void language sql as $$ select 1 $$;
  -- revoke execute on function public.fake15() from public, anon;
  create or replace function public.demo15() returns void language sql as $$ select 1 $$;
  revoke execute on function public.demo15() from public, anon;
  grant execute on function public.demo15() to authenticated;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true }]);

// ── 16-19: fixtures de tipos, ahora verificando la firma literal (bug J) ────────────────────
verificar("16 numeric(12,2) firma correcta", analizarTexto(ARCHIVO, `
  create or replace function public.demo16(a numeric(12,2)) returns void language sql as $$ select 1 $$;
  revoke execute on function public.demo16(numeric) from public, anon;
  grant execute on function public.demo16(numeric) to authenticated;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true, firma: "public.demo16(numeric)" }]);

verificar("17 timestamp with time zone firma correcta", analizarTexto(ARCHIVO, `
  create or replace function public.demo17(a timestamp with time zone) returns void language sql as $$ select 1 $$;
  revoke execute on function public.demo17(timestamp with time zone) from public, anon;
  grant execute on function public.demo17(timestamp with time zone) to authenticated;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true, firma: "public.demo17(timestamp with time zone)" }]);

verificar("18 double precision firma correcta", analizarTexto(ARCHIVO, `
  create or replace function public.demo18(a double precision) returns void language sql as $$ select 1 $$;
  revoke execute on function public.demo18(double precision) from public, anon;
  grant execute on function public.demo18(double precision) to authenticated;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true, firma: "public.demo18(double precision)" }]);

verificar("19 alias int/int4/integer firma correcta", analizarTexto(ARCHIVO, `
  create or replace function public.demo19(a int) returns void language sql as $$ select 1 $$;
  revoke execute on function public.demo19(integer) from public, anon;
  grant execute on function public.demo19(int4) to authenticated;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true, firma: "public.demo19(integer)" }]);

// ── 20: descubrimiento --repo ────────────────────────────────────────────────────────────────
{
  const rutaTmp = path.join(REPO_ROOT, "pruebas", "rcv34", "_fixture_tmp_20_descubrimiento.sql");
  writeFileSync(rutaTmp, "-- fixture temporal, se borra al terminar este test\nselect 1;\n");
  let encontrado = false;
  try {
    const archivos = descubrirSql();
    const relEsperado = path.relative(REPO_ROOT, rutaTmp).split(path.sep).join("/");
    encontrado = archivos.some(a => path.relative(REPO_ROOT, a).split(path.sep).join("/") === relEsperado);
  } finally { unlinkSync(rutaTmp); }
  verificarCondicion("20 archivo nuevo descubierto por --repo", encontrado, "el archivo temporal no aparecio en descubrirSql()");
}

verificar("21 dollar-quote sin cerrar", analizarTexto(ARCHIVO, `
  create or replace function public.demo21() returns void language plpgsql as $$
  begin
    return;
  end
`, new Map()).funciones, [{ categoria: "unparseable", ok: false }]);

// ── 22: baseline corrupto (estructural) ──────────────────────────────────────────────────────
{
  const dirTmp = mkdtempSync(path.join(tmpdir(), "rcv34-baseline-"));
  const rutaTmp = path.join(dirTmp, "baseline-corrupto.json");
  writeFileSync(rutaTmp, JSON.stringify([
    { archivo: "a.sql", firma: "public.foo()", hash: "no-es-un-sha256-valido" },
    { archivo: "a.sql", firma: "public.bar()", hash: "a".repeat(64) },
    { archivo: "a.sql", firma: "public.bar()", hash: "b".repeat(64) },
    { archivo: "a.sql" },
  ]));
  let resultado;
  try { resultado = validarBaseline(rutaTmp); } finally { rmSync(dirTmp, { recursive: true, force: true }); }
  verificarCondicion("22 baseline duplicado/corrupto detectado", resultado.ok === false && resultado.problemas.length >= 3,
    `ok=${resultado.ok} problemas=${JSON.stringify(resultado.problemas)}`);
}

// ══════════════════════════════════════════ REV4: fixtures 23-38 ═════════════════════════════

// 23. REVOKE correcto + GRANT posterior a anon -> FAIL
verificar("23 GRANT posterior reabre anon", analizarTexto(ARCHIVO, `
  create or replace function public.demo23() returns void language sql as $$ select 1 $$;
  revoke execute on function public.demo23() from public, anon;
  grant execute on function public.demo23() to authenticated;
  grant execute on function public.demo23() to anon;
`, new Map()).funciones, [{ categoria: "nueva_insegura", ok: false }]);

// 24. REVOKE correcto + GRANT posterior a PUBLIC -> FAIL
verificar("24 GRANT posterior reabre PUBLIC", analizarTexto(ARCHIVO, `
  create or replace function public.demo24() returns void language sql as $$ select 1 $$;
  revoke execute on function public.demo24() from public, anon;
  grant execute on function public.demo24() to authenticated;
  grant execute on function public.demo24() to public;
`, new Map()).funciones, [{ categoria: "nueva_insegura", ok: false }]);

// 25. GRANT ALL PRIVILEGES posterior a anon -> FAIL
verificar("25 GRANT ALL PRIVILEGES reabre anon", analizarTexto(ARCHIVO, `
  create or replace function public.demo25() returns void language sql as $$ select 1 $$;
  revoke execute on function public.demo25() from public, anon;
  grant execute on function public.demo25() to authenticated;
  grant all privileges on function public.demo25() to anon;
`, new Map()).funciones, [{ categoria: "nueva_insegura", ok: false }]);

// 26. ACL aparece antes de CREATE nuevo -> FAIL (no cuenta como cierre)
verificar("26 ACL antes del CREATE no cuenta", analizarTexto(ARCHIVO, `
  revoke execute on function public.demo26() from public, anon;
  grant execute on function public.demo26() to authenticated;
  create or replace function public.demo26() returns void language sql as $$ select 1 $$;
`, new Map()).funciones, [{ categoria: "nueva_insegura", ok: false }]);

// 27. archivo sin CREATE pero GRANT EXECUTE a anon -> FAIL (prohibited_grant)
{
  const r = analizarTexto(ARCHIVO, `
    grant execute on function public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) to anon;
  `, new Map());
  verificarCondicion("27 GRANT a anon sin CREATE en el archivo", r.funciones.length === 0 && r.prohibidos.length === 1,
    `funciones=${JSON.stringify(r.funciones)} prohibidos=${JSON.stringify(r.prohibidos)}`);
}

// 28. archivo sin CREATE pero GRANT EXECUTE a PUBLIC -> FAIL (prohibited_grant)
{
  const r = analizarTexto(ARCHIVO, `
    grant execute on function public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) to public;
  `, new Map());
  verificarCondicion("28 GRANT a PUBLIC sin CREATE en el archivo", r.funciones.length === 0 && r.prohibidos.length === 1,
    `funciones=${JSON.stringify(r.funciones)} prohibidos=${JSON.stringify(r.prohibidos)}`);
}

// 29. GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon -> FAIL
{
  const r = analizarTexto(ARCHIVO, `grant execute on all functions in schema public to anon;`, new Map());
  verificarCondicion("29 GRANT ON ALL FUNCTIONS IN SCHEMA", r.prohibidos.length === 1, `prohibidos=${JSON.stringify(r.prohibidos)}`);
}

// 30. ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ... PUBLIC -> FAIL
{
  const r = analizarTexto(ARCHIVO, `alter default privileges in schema public grant execute on functions to public;`, new Map());
  verificarCondicion("30 ALTER DEFAULT PRIVILEGES peligroso", r.prohibidos.length === 1, `prohibidos=${JSON.stringify(r.prohibidos)}`);
}

// 31. legacy 'ADMIN' -> 'admin' (cambio de mayus/minus dentro del literal) -> hash cambia
{
  const base = `create or replace function public.legacy31() returns text language sql as $$ select 'ADMIN' $$;`;
  const mod  = `create or replace function public.legacy31() returns text language sql as $$ select 'admin' $$;`;
  const base31 = analizarTexto(ARCHIVO, base, new Map()).funciones[0];
  const bl = new Map([[`${ARCHIVO}|${base31.firma}`, base31.hashActual]]);
  verificar("31 'ADMIN' vs 'admin' cambia el hash", analizarTexto(ARCHIVO, mod, bl).funciones, [{ categoria: "legacy_modificada", ok: false }]);
}

// 32. espacios dentro de un literal cambian -> hash cambia
{
  const base = `create or replace function public.legacy32() returns text language sql as $$ select 'texto  con  espacios' $$;`;
  const mod  = `create or replace function public.legacy32() returns text language sql as $$ select 'texto con espacios' $$;`;
  const base32 = analizarTexto(ARCHIVO, base, new Map()).funciones[0];
  const bl = new Map([[`${ARCHIVO}|${base32.firma}`, base32.hashActual]]);
  verificar("32 espacios en literal cambia el hash", analizarTexto(ARCHIVO, mod, bl).funciones, [{ categoria: "legacy_modificada", ok: false }]);
}

// 33. comentario de bloque anidado con GRANT falso -> no cuenta
verificar("33 comentario anidado con GRANT falso", analizarTexto(ARCHIVO, `
  create or replace function public.demo33() returns void language sql as $$ select 1 $$;
  /*
    /*
       grant execute on function public.demo33() to anon;
    */
  */
  revoke execute on function public.demo33() from public, anon;
  grant execute on function public.demo33() to authenticated;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true }]);

// 34. E'...' con GRANT falso -> no cuenta
verificar("34 E-string con GRANT falso", analizarTexto(ARCHIVO, `
  create or replace function public.demo34() returns void language sql as $$ select 1 $$;
  select E'grant execute on function public.demo34() to anon; \\' sigue dentro del string';
  revoke execute on function public.demo34() from public, anon;
  grant execute on function public.demo34() to authenticated;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true }]);

// 35. CREATE FUNCTION en schema excluido -> conteo consistente, sin funciones reportadas
{
  const r = analizarTexto(ARCHIVO, `create or replace function auth.algo() returns void language sql as $$ select 1 $$;`, new Map());
  verificarCondicion("35 schema excluido: conteo consistente", r.funciones.length === 0 && r.createTopLevelCount === 1 &&
    r.createAppScope === 0 && r.createExcludedScope === 1 && r.createTopLevelCount === r.createAppScope + r.createExcludedScope,
    `funciones=${r.funciones.length} total=${r.createTopLevelCount} app=${r.createAppScope} excl=${r.createExcludedScope}`);
}

// 36. modo explicito: baseline de OTRO archivo no escaneado no cuenta como huerfano
{
  const baselineClaves = new Set(["otro_archivo.sql|public.foo()"]);
  const clavesEncontradas = new Set();
  const archivosEscaneados = new Set(["fixture.sql"]);
  const huerfanas = detectarHuerfanas(baselineClaves, clavesEncontradas, archivosEscaneados, false);
  verificarCondicion("36 modo explicito no marca huerfano de otro archivo", huerfanas.length === 0, `huerfanas=${JSON.stringify(huerfanas)}`);
}

// 37. --repo: baseline realmente huerfano -> FAIL
{
  const baselineClaves = new Set(["otro_archivo.sql|public.foo()"]);
  const clavesEncontradas = new Set();
  const archivosEscaneados = new Set(["fixture.sql", "otro.sql"]);
  const huerfanas = detectarHuerfanas(baselineClaves, clavesEncontradas, archivosEscaneados, true);
  verificarCondicion("37 --repo marca huerfano real", huerfanas.length === 1, `huerfanas=${JSON.stringify(huerfanas)}`);
}

// 38. uuid[] firma literal (cierra la lista de tipos exigida en J)
verificar("38 uuid[] firma correcta", analizarTexto(ARCHIVO, `
  create or replace function public.demo38(a uuid[]) returns void language sql as $$ select 1 $$;
  revoke execute on function public.demo38(uuid[]) from public, anon;
  grant execute on function public.demo38(uuid[]) to authenticated;
`, new Map()).funciones, [{ categoria: "segura_actual", ok: true, firma: "public.demo38(uuid[])" }]);

// ══════════════════════════════════════════ REV5: fixtures 39-48 ═════════════════════════════
// 39/40/47/48 usan un archivo real (temporal o el 02 real) para probar de verdad la lectura del
// SHA-256 del archivo; 41-46 prueban la logica pura de emparejamiento/validacion sin tocar disco.

// 39. prohibited_grant exacto + excepcion exacta + hash correcto -> PASS
{
  const rutaTmp = path.join(REPO_ROOT, "pruebas", "rcv34", "_fixture_tmp_39.sql");
  writeFileSync(rutaTmp, `grant execute on function public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) to anon;\n`);
  let resultado;
  try {
    const r = analizarArchivo(rutaTmp, new Map());
    const hashReal = sha256(readFileSync(rutaTmp, "utf8"));
    const exc = [{ archivo: r.archivo, sha256_archivo: hashReal, tipo: "prohibited_grant",
                   firma: "public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text)", roles: ["anon"], privilegio: "execute", razon: "fixture" }];
    const conHash = verificarHashExcepciones(exc);
    resultado = clasificarProhibidos([{ archivo: r.archivo, prohibidos: r.prohibidos }], conHash);
  } finally { unlinkSync(rutaTmp); }
  verificarCondicion("39 excepcion exacta + hash correcto", resultado.exceptuados.length === 1 && resultado.noExceptuados.length === 0,
    `exceptuados=${resultado.exceptuados.length} noExceptuados=${resultado.noExceptuados.length}`);
}

// 40. mismo archivo pero el SHA del manifest no coincide -> FAIL
{
  const rutaTmp = path.join(REPO_ROOT, "pruebas", "rcv34", "_fixture_tmp_40.sql");
  writeFileSync(rutaTmp, `grant execute on function public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) to anon;\n`);
  let resultado;
  try {
    const r = analizarArchivo(rutaTmp, new Map());
    const hashFalso = "0".repeat(64);
    const exc = [{ archivo: r.archivo, sha256_archivo: hashFalso, tipo: "prohibited_grant",
                   firma: "public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text)", roles: ["anon"], privilegio: "execute", razon: "fixture" }];
    const conHash = verificarHashExcepciones(exc);
    resultado = clasificarProhibidos([{ archivo: r.archivo, prohibidos: r.prohibidos }], conHash);
  } finally { unlinkSync(rutaTmp); }
  verificarCondicion("40 SHA del archivo no coincide", resultado.exceptuados.length === 0 && resultado.noExceptuados.length === 1,
    `exceptuados=${resultado.exceptuados.length} noExceptuados=${resultado.noExceptuados.length}`);
}

// 41. misma excepcion pero firma distinta -> FAIL
{
  const finding = { tipo: "prohibited_grant", exceptionable: true, firma: "public.foo()", privilegio: "execute", roles: ["anon"], detalle: "x" };
  const exc = [{ archivo: "a.sql", sha256_archivo: "x", tipo: "prohibited_grant", firma: "public.bar()", roles: ["anon"], privilegio: "execute", razon: "r", _hashArchivoOk: true }];
  const r = clasificarProhibidos([{ archivo: "a.sql", prohibidos: [finding] }], exc);
  verificarCondicion("41 firma distinta no aplica excepcion", r.exceptuados.length === 0 && r.noExceptuados.length === 1, JSON.stringify(r));
}

// 42. misma firma pero rol adicional no exceptuado -> FAIL
{
  const finding = { tipo: "prohibited_grant", exceptionable: true, firma: "public.foo()", privilegio: "execute", roles: ["anon", "public"], detalle: "x" };
  const exc = [{ archivo: "a.sql", sha256_archivo: "x", tipo: "prohibited_grant", firma: "public.foo()", roles: ["public"], privilegio: "execute", razon: "r", _hashArchivoOk: true }];
  const r = clasificarProhibidos([{ archivo: "a.sql", prohibidos: [finding] }], exc);
  verificarCondicion("42 rol adicional no exceptuado", r.exceptuados.length === 0 && r.noExceptuados.length === 1, JSON.stringify(r));
}

// 43. excepcion huerfana -> FAIL
{
  const exc = [{ archivo: "a.sql", sha256_archivo: "x", tipo: "prohibited_grant", firma: "public.foo()", roles: ["anon"], privilegio: "execute", razon: "r", _hashArchivoOk: true }];
  const r = clasificarProhibidos([{ archivo: "a.sql", prohibidos: [] }], exc);
  const huerfanas = detectarExcepcionesHuerfanas(exc, r.consumidas, new Set(["a.sql"]), true);
  verificarCondicion("43 excepcion huerfana detectada", huerfanas.length === 1, JSON.stringify(huerfanas));
}

// 44. excepcion duplicada -> FAIL (validarExcepciones)
{
  const dirTmp = mkdtempSync(path.join(tmpdir(), "rcv34-excep-"));
  const rutaTmp = path.join(dirTmp, "dup.json");
  const entrada = { archivo: "a.sql", sha256_archivo: "a".repeat(64), tipo: "prohibited_grant", firma: "public.foo()", roles: ["anon"], privilegio: "execute", razon: "r" };
  writeFileSync(rutaTmp, JSON.stringify([entrada, entrada]));
  let resultado;
  try { resultado = validarExcepciones(rutaTmp); } finally { rmSync(dirTmp, { recursive: true, force: true }); }
  verificarCondicion("44 excepcion duplicada detectada", resultado.ok === false, JSON.stringify(resultado.problemas));
}

// 45. excepcion intenta autorizar ALTER DEFAULT PRIVILEGES -> FAIL (tipo no soportado)
{
  const dirTmp = mkdtempSync(path.join(tmpdir(), "rcv34-excep-"));
  const rutaTmp = path.join(dirTmp, "default-priv.json");
  writeFileSync(rutaTmp, JSON.stringify([{ archivo: "a.sql", sha256_archivo: "a".repeat(64), tipo: "prohibited_grant_global",
    firma: "public.foo()", roles: ["anon"], privilegio: "execute", razon: "intento de autorizar ALTER DEFAULT PRIVILEGES" }]));
  let resultado;
  try { resultado = validarExcepciones(rutaTmp); } finally { rmSync(dirTmp, { recursive: true, force: true }); }
  verificarCondicion("45 excepcion no puede autorizar DEFAULT PRIVILEGES", resultado.ok === false, JSON.stringify(resultado.problemas));
}

// 46. excepcion intenta autorizar GRANT ON ALL FUNCTIONS -> FAIL (tipo no soportado)
{
  const dirTmp = mkdtempSync(path.join(tmpdir(), "rcv34-excep-"));
  const rutaTmp = path.join(dirTmp, "all-functions.json");
  writeFileSync(rutaTmp, JSON.stringify([{ archivo: "a.sql", sha256_archivo: "a".repeat(64), tipo: "grant_all_functions_in_schema",
    firma: "public.foo()", roles: ["anon"], privilegio: "execute", razon: "intento de autorizar GRANT ON ALL FUNCTIONS" }]));
  let resultado;
  try { resultado = validarExcepciones(rutaTmp); } finally { rmSync(dirTmp, { recursive: true, force: true }); }
  verificarCondicion("46 excepcion no puede autorizar GRANT ON ALL FUNCTIONS", resultado.ok === false, JSON.stringify(resultado.problemas));
}

// 47. archivo exceptuado contiene un prohibited_grant ADICIONAL no cubierto -> ese FAIL, el otro PASS
{
  const rutaTmp = path.join(REPO_ROOT, "pruebas", "rcv34", "_fixture_tmp_47.sql");
  writeFileSync(rutaTmp,
    `grant execute on function public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text) to anon;\n` +
    `grant execute on function public.registrar_abono(uuid,numeric,text,text) to anon;\n`);
  let resultado;
  try {
    const r = analizarArchivo(rutaTmp, new Map());
    const hashReal = sha256(readFileSync(rutaTmp, "utf8"));
    const exc = [{ archivo: r.archivo, sha256_archivo: hashReal, tipo: "prohibited_grant",
                   firma: "public.registrar_venta(uuid,text,text,numeric,jsonb,integer,text)", roles: ["anon"], privilegio: "execute", razon: "fixture" }];
    const conHash = verificarHashExcepciones(exc);
    resultado = clasificarProhibidos([{ archivo: r.archivo, prohibidos: r.prohibidos }], conHash);
  } finally { unlinkSync(rutaTmp); }
  verificarCondicion("47 hallazgo adicional no cubierto sigue en FAIL", resultado.exceptuados.length === 1 && resultado.noExceptuados.length === 1,
    `exceptuados=${resultado.exceptuados.length} noExceptuados=${resultado.noExceptuados.length}`);
}

// 48. excepcion exacta del 02 REAL -> sus 3 hallazgos conocidos quedan exceptuados y ninguno mas
{
  const baseline = validarBaseline();
  const r = analizarArchivo(path.join(REPO_ROOT, "pruebas/rcv34/02-rollback-cierre-triggers.sql"), baseline.indice);
  const excepciones = validarExcepciones(EXCEPCIONES_PATH);
  const conHash = verificarHashExcepciones(excepciones.lista);
  const resultado = clasificarProhibidos([{ archivo: r.archivo, prohibidos: r.prohibidos }], conHash);
  verificarCondicion("48 excepciones reales del 02 cubren exactamente sus 3 hallazgos",
    excepciones.ok && resultado.detectados.length === 3 && resultado.exceptuados.length === 3 && resultado.noExceptuados.length === 0 &&
    conHash.every(e => e._hashArchivoOk),
    `excepciones.ok=${excepciones.ok} detectados=${resultado.detectados.length} exceptuados=${resultado.exceptuados.length} noExceptuados=${resultado.noExceptuados.length}`);
}

// ══════════════════════════════════════════ REV6: fixtures 49-61 ═════════════════════════════

// 49/50/51: un baseline legacy (hash de CREATE identico) NO puede ocultar un GRANT explicito nuevo
const legacyBase49 = `create or replace function public.legacy49() returns void language sql as $$ select 1 $$;`;
const base49 = analizarTexto(ARCHIVO, legacyBase49, new Map()).funciones[0];
const bl49 = new Map([[`${ARCHIVO}|${base49.firma}`, base49.hashActual]]);

{
  const r = analizarTexto(ARCHIVO, legacyBase49 + `\ngrant execute on function public.legacy49() to anon;\n`, bl49);
  verificarCondicion("49 legacy + GRANT posterior a anon sigue en FAIL", r.funciones[0].categoria === "legacy_baseline" &&
    r.prohibidos.length === 1 && r.prohibidos[0].roles.includes("anon"), JSON.stringify(r));
}
{
  const r = analizarTexto(ARCHIVO, legacyBase49 + `\ngrant execute on function public.legacy49() to public;\n`, bl49);
  verificarCondicion("50 legacy + GRANT posterior a PUBLIC sigue en FAIL", r.funciones[0].categoria === "legacy_baseline" &&
    r.prohibidos.length === 1 && r.prohibidos[0].roles.includes("public"), JSON.stringify(r));
}
{
  const r = analizarTexto(ARCHIVO, legacyBase49, bl49);
  verificarCondicion("51 legacy sin ACL nuevo sigue PASS", r.funciones[0].categoria === "legacy_baseline" &&
    r.funciones[0].ok === true && r.prohibidos.length === 0, JSON.stringify(r));
}

// 52. referencia ACL con tipo no soportado -> FAIL CLOSED (UNPARSEABLE_ACL_REFERENCE), no 0 hallazgos
{
  const r = analizarTexto(ARCHIVO, `grant execute on function public.foo(tipo_no_soportado) to anon;`, new Map());
  verificarCondicion("52 ACL con tipo no soportado falla cerrado", r.aclNoParseables.length === 1 && r.prohibidos.length === 0, JSON.stringify(r));
}

// 53. WITH GRANT OPTION no debe esconder al rol
{
  const r = analizarTexto(ARCHIVO, `grant execute on function public.foo() to anon with grant option;`, new Map());
  verificarCondicion("53 WITH GRANT OPTION reconoce anon", r.prohibidos.length === 1 && r.prohibidos[0].roles.includes("anon"), JSON.stringify(r));
}

// 54/55. REVOKE ... FROM anon CASCADE/RESTRICT deben revocar de verdad, no crear un rol "anon cascade"
{
  const r = analizarTexto(ARCHIVO, `
    grant execute on function public.foo() to anon;
    revoke execute on function public.foo() from anon cascade;
  `, new Map());
  verificarCondicion("54 REVOKE ... FROM anon CASCADE revoca de verdad", r.prohibidos.length === 0, JSON.stringify(r));
}
{
  const r = analizarTexto(ARCHIVO, `
    grant execute on function public.foo() to anon;
    revoke execute on function public.foo() from anon restrict;
  `, new Map());
  verificarCondicion("55 REVOKE ... FROM anon RESTRICT revoca de verdad", r.prohibidos.length === 0, JSON.stringify(r));
}

// 56/57. ALTER DEFAULT PRIVILEGES ... GRANT ALL [PRIVILEGES] ON FUNCTIONS tambien es peligroso
{
  const r = analizarTexto(ARCHIVO, `alter default privileges in schema public grant all on functions to anon;`, new Map());
  verificarCondicion("56 ALTER DEFAULT PRIVILEGES GRANT ALL a anon", r.prohibidos.some(p => p.tipo === "prohibited_grant_global"), JSON.stringify(r));
}
{
  const r = analizarTexto(ARCHIVO, `alter default privileges in schema public grant all privileges on functions to public;`, new Map());
  verificarCondicion("57 ALTER DEFAULT PRIVILEGES GRANT ALL PRIVILEGES a PUBLIC", r.prohibidos.some(p => p.tipo === "prohibited_grant_global"), JSON.stringify(r));
}

// 58-61. integridad global del lexer: cualquier region sin cerrar falla, aun sin CREATE FUNCTION
verificarCondicion("58 comentario de bloque sin cerrar",
  analizarTexto(ARCHIVO, `select 1; /* comentario que nunca cierra`, new Map()).erroresLexicos.length === 1, "");
verificarCondicion("59 string normal sin cerrar",
  analizarTexto(ARCHIVO, `select 'cadena que nunca cierra;`, new Map()).erroresLexicos.length === 1, "");
verificarCondicion("60 E-string sin cerrar",
  analizarTexto(ARCHIVO, `select E'cadena escape que nunca cierra;`, new Map()).erroresLexicos.length === 1, "");
verificarCondicion("61 dollar-quote top-level sin cerrar",
  analizarTexto(ARCHIVO, `select $$ texto que nunca cierra`, new Map()).erroresLexicos.length === 1, "");

// ══════════════════════════════════════════ REV7: fixtures 62-70 ═════════════════════════════

// 62. ROUTINES es sinonimo de FUNCTIONS en GRANT ... ON ALL ... IN SCHEMA
{
  const r = analizarTexto(ARCHIVO, `grant execute on all routines in schema public to anon;`, new Map());
  verificarCondicion("62 GRANT ON ALL ROUTINES IN SCHEMA", r.prohibidos.some(p => p.tipo === "prohibited_grant_global"), JSON.stringify(r));
}

// 63. WITH GRANT OPTION en el detector global (ON ALL FUNCTIONS) no debe esconder a anon
{
  const r = analizarTexto(ARCHIVO, `grant execute on all functions in schema public to anon with grant option;`, new Map());
  verificarCondicion("63 GRANT ON ALL FUNCTIONS WITH GRANT OPTION detecta anon", r.prohibidos.some(p => p.tipo === "prohibited_grant_global"), JSON.stringify(r));
}

// 64. ALTER DEFAULT PRIVILEGES ... ON ROUTINES tambien es peligroso
{
  const r = analizarTexto(ARCHIVO, `alter default privileges in schema public grant execute on routines to public;`, new Map());
  verificarCondicion("64 ALTER DEFAULT PRIVILEGES ON ROUTINES a PUBLIC", r.prohibidos.some(p => p.tipo === "prohibited_grant_global"), JSON.stringify(r));
}

// 65. ALTER DEFAULT PRIVILEGES ... ON ROUTINES + ALL PRIVILEGES + WITH GRANT OPTION combinados
{
  const r = analizarTexto(ARCHIVO, `alter default privileges in schema public grant all privileges on routines to anon with grant option;`, new Map());
  verificarCondicion("65 ALTER DEFAULT PRIVILEGES ROUTINES/ALL PRIVILEGES/WITH GRANT OPTION", r.prohibidos.some(p => p.tipo === "prohibited_grant_global"), JSON.stringify(r));
}

// 66. GROUP <rol> se normaliza al mismo rol en el detector global
{
  const r = analizarTexto(ARCHIVO, `grant execute on all routines in schema public to group anon;`, new Map());
  verificarCondicion("66 GRANT ON ALL ROUTINES TO GROUP anon", r.prohibidos.some(p => p.tipo === "prohibited_grant_global"), JSON.stringify(r));
}

// 67. ON ROUTINE individual (sin CREATE local) se detecta igual que ON FUNCTION
{
  const r = analizarTexto(ARCHIVO, `grant execute on routine public.foo() to anon;`, new Map());
  verificarCondicion("67 GRANT ON ROUTINE individual sin CREATE", r.funciones.length === 0 && r.prohibidos.length === 1 &&
    r.prohibidos[0].roles.includes("anon"), JSON.stringify(r));
}

// 68. GRANT + REVOKE sobre ROUTINE: el estado final cerrado sigue siendo PASS
{
  const r = analizarTexto(ARCHIVO, `
    grant execute on routine public.foo() to anon;
    revoke execute on routine public.foo() from anon;
  `, new Map());
  verificarCondicion("68 GRANT+REVOKE sobre ROUTINE cierra correctamente", r.prohibidos.length === 0, JSON.stringify(r));
}

// 69. GRANTED BY no debe esconder el rol real en un GRANT individual
{
  const r = analizarTexto(ARCHIVO, `grant execute on function public.foo() to anon granted by postgres;`, new Map());
  verificarCondicion("69 GRANTED BY no oculta a anon", r.prohibidos.length === 1 && r.prohibidos[0].roles.includes("anon"), JSON.stringify(r));
}

// 70. WITH GRANT OPTION + GRANTED BY combinados tampoco deben esconder el rol real
{
  const r = analizarTexto(ARCHIVO, `grant execute on function public.foo() to anon with grant option granted by postgres;`, new Map());
  verificarCondicion("70 WITH GRANT OPTION + GRANTED BY combinados no ocultan a anon", r.prohibidos.length === 1 &&
    r.prohibidos[0].roles.includes("anon"), JSON.stringify(r));
}

// ══════════════════════════════════════════ REV8: fixtures 71-77 ═════════════════════════════

// 71. "anon" citado (minusculas exactas) ES el rol real anon
{
  const r = analizarTexto(ARCHIVO, `grant execute on function public.foo() to "anon";`, new Map());
  verificarCondicion("71 \"anon\" citado se reconoce como el rol real", r.prohibidos.length === 1 &&
    r.prohibidos[0].roles.includes("anon"), JSON.stringify(r));
}

// 72. GROUP "anon" (GROUP + identificador citado) tambien se reconoce
{
  const r = analizarTexto(ARCHIVO, `grant execute on routine public.foo() to group "anon";`, new Map());
  verificarCondicion("72 GROUP \"anon\" se reconoce como el rol real", r.prohibidos.length === 1 &&
    r.prohibidos[0].roles.includes("anon"), JSON.stringify(r));
}

// 73. "ANON" citado (otra capitalizacion) NO se asume el mismo rol real anon: comportamiento
// documentado explicitamente (ver comentario de rolPeligrosoDe en guard-estatico-funciones.mjs).
{
  const r = analizarTexto(ARCHIVO, `grant execute on function public.foo() to "ANON";`, new Map());
  verificarCondicion("73 \"ANON\" citado no se confunde con el rol anon", r.prohibidos.length === 0, JSON.stringify(r));
}

// 74. lista de varios schemas en ALL FUNCTIONS IN SCHEMA sigue detectando anon
{
  const r = analizarTexto(ARCHIVO, `grant execute on all functions in schema public, privado to anon;`, new Map());
  verificarCondicion("74 ALL FUNCTIONS IN SCHEMA con lista de schemas", r.prohibidos.some(p => p.tipo === "prohibited_grant_global"), JSON.stringify(r));
}

// 75. lista de varios schemas en ALL ROUTINES IN SCHEMA + rol citado
{
  const r = analizarTexto(ARCHIVO, `grant execute on all routines in schema public, privado to "anon";`, new Map());
  verificarCondicion("75 ALL ROUTINES IN SCHEMA con lista de schemas + rol citado", r.prohibidos.some(p => p.tipo === "prohibited_grant_global"), JSON.stringify(r));
}

// 76. ALTER DEFAULT PRIVILEGES con rol citado "anon"
{
  const r = analizarTexto(ARCHIVO, `alter default privileges in schema public grant execute on functions to "anon";`, new Map());
  verificarCondicion("76 ALTER DEFAULT PRIVILEGES con \"anon\" citado", r.prohibidos.some(p => p.tipo === "prohibited_grant_global"), JSON.stringify(r));
}

// 77. GRANT + REVOKE con "anon" citado: estado final cerrado -> PASS
{
  const r = analizarTexto(ARCHIVO, `
    grant execute on function public.foo() to "anon";
    revoke execute on function public.foo() from "anon";
  `, new Map());
  verificarCondicion("77 GRANT+REVOKE con \"anon\" citado cierra correctamente", r.prohibidos.length === 0, JSON.stringify(r));
}

console.log(`\n${ok}/${total} PASS`);
process.exit(ok === total ? 0 : 1);
