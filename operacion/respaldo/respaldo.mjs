#!/usr/bin/env node
// ENTIMOTORS 3.15 · Bloque 5 · CLI del respaldo de negocio (la usan respaldar.sh / restaurar-aislado.sh / puerta-pre-release.sh).
//   respaldo.mjs manifiesto --dir D --meta meta.json --sql-plano base.sql     arma, escanea, verifica y SELLA el manifiesto (exit 1 si falla)
//   respaldo.mjs verificar --dir D [--restaurador-version 3.14.1]             relee todo; exit 1 ante cualquier problema
//   respaldo.mjs comparar --origen A --restaurada B                           fotos lógicas iguales (salvo VOLATIL/EXCLUIDO)
//   respaldo.mjs storage-verificar --foto F --raiz R                         inventario de la base contra una carpeta
//   respaldo.mjs storage-descargar --foto F --destino R                      descarga (ENTIMOTORS_STORAGE_URL + ENTIMOTORS_STORAGE_LLAVE)
//   respaldo.mjs secretos ARCHIVO...                                          escaneo de secretos; exit 1 si hay hallazgos
//   respaldo.mjs clasificar ARCHIVO                                           qué clase de respaldo es
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { FORMATO, VERSION_FORMATO, ZONA, DATOS_EXCLUIDOS, sellarManifiesto, sha256Buf, sha256Archivo, verificarRespaldo, clasificarArchivo,
  inventarioDesdeFoto, verificarStorage, descargarStorage, escanearSecretos, compararFotos } from "./lib/respaldo.mjs";

const [, , cmd, ...resto] = process.argv;
const arg = (n, def) => { const i = resto.indexOf("--" + n); return i >= 0 ? resto[i + 1] : def; };
const salir = (ok, msg) => { if (msg) console.log(msg); process.exit(ok ? 0 : 1); };
const lineas = (t, pre) => t.split("\n").filter((l) => l.startsWith(pre));
const valor = (t, clave) => { const l = t.split("\n").find((x) => x.startsWith(clave + "|")); return l ? l.slice(clave.length + 1) : null; };

function archivosBajo(dir, rel = "") {
  const out = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...archivosBajo(dir, r)); else out.push(r.split(path.sep).join("/"));
  }
  return out;
}

async function manifiesto() {
  const dir = arg("dir"), meta = JSON.parse(readFileSync(arg("meta"), "utf8"));
  const foto = readFileSync(path.join(dir, "foto-origen.txt"), "utf8");
  const tipos = { "base.dump": "pg_dump", "auth-usuarios.csv": "auth_usuarios_saneado", "foto-origen.txt": "foto_logica", "finanzas-origen.txt": "foto_financiera", "toc.txt": "pg_restore_list" };
  const artefactos = [];
  for (const r of archivosBajo(dir).sort()) {
    if (r === "manifiesto.json" || r === "manifiesto.json.sha256" || r === "meta.json" || r.startsWith(".")) continue;
    artefactos.push({ ruta: r, tipo: tipos[r] || (r.startsWith("storage/") ? "storage_objeto" : "otro"), bytes: statSync(path.join(dir, r)).size, sha256: await sha256Archivo(path.join(dir, r)) });
  }
  // Storage: lo que la base dice que existe contra lo copiado
  const inv = inventarioDesdeFoto(foto);
  const st = await verificarStorage(inv, path.join(dir, "storage"));
  // secretos: SQL completo del volcado + CSV de usuarios + foto (el manifiesto se escanea al final)
  const textos = { "base.dump (SQL)": readFileSync(arg("sql-plano"), "utf8"), "auth-usuarios.csv": readFileSync(path.join(dir, "auth-usuarios.csv"), "utf8"), "foto-origen.txt": foto };
  let hallazgos = escanearSecretos(textos);
  const conteos = Object.fromEntries(lineas(foto, "conteo|").map((l) => { const p = l.split("|"); return [p[1], Number(p[2])]; }));
  const excluidas = Object.fromEntries(lineas(foto, "EXCLUIDO|").map((l) => { const p = l.split("|"); return [p[1], Number(p[2])]; }));
  const catalogo = Object.fromEntries(lineas(foto, "catalogo|").map((l) => { const p = l.split("|"); return [p[1], p.slice(2).join("|")]; }));
  const buckets = {};
  for (const o of inv) { buckets[o.bucket] = buckets[o.bucket] || { objetos: 0, bytes: 0 }; buckets[o.bucket].objetos++; buckets[o.bucket].bytes += o.bytes; }
  const checks = {
    toc_legible: meta.toc_entradas > 0, origen_estable: meta.origen_estable === true, storage_completo: st.ok,
    invariantes_vacias: valor(foto, "invariantes") === "[]", invariantes_finanzas: ["[]", "-"].includes(valor(foto, "invariantes_finanzas") ?? "-"),
    auth_usuarios_filas: (readFileSync(path.join(dir, "auth-usuarios.csv"), "utf8").trim().split("\n").length - 1) === conteos["auth.users"],
  };
  let m = {
    formato: FORMATO, version_formato: VERSION_FORMATO, entimotors_version: meta.entimotors_version, creado_utc: meta.creado_utc, zona: ZONA,
    creado_local: new Date(meta.creado_utc).toLocaleString("es-HN", { timeZone: ZONA, dateStyle: "short", timeStyle: "medium" }),
    origen: meta.origen, postgres_version: valor(foto, "version"), pg_dump_version: meta.pg_dump_version, fases: valor(foto, "fases") || "-",
    catalogo, tablas: conteos, datos_excluidos: { patrones: DATOS_EXCLUIDOS, conteos_origen: excluidas,
      motivo: "secretos (contraseñas, sesiones, tokens, PIN, vault) o efímeros (colas, realtime): no viajan en un respaldo entregable" },
    storage: { buckets, objetos: inv.length, bytes: inv.reduce((s, o) => s + o.bytes, 0), faltan: st.faltan, sobran: st.sobran, diferentes: st.diferentes,
      verificacion: "tamaño + MD5 (= eTag de Supabase) de cada objeto; SHA-256 en artefactos" },
    artefactos,
    huellas: { negocio: valor(foto, "huella_negocio"), auth_usuarios_sin_secretos: valor(foto, "huella_auth_usuarios"), storage_objetos: valor(foto, "huella_storage_objetos"),
      invariantes: valor(foto, "invariantes"), invariantes_finanzas: valor(foto, "invariantes_finanzas") },
    verificacion: { resultado: Object.values(checks).every(Boolean) ? "VERIFICADO" : "FALLIDO", checks, toc_entradas: meta.toc_entradas },
    secretos: { resultado: "PENDIENTE", patrones: 9, hallazgos: [] },
    no_incluye: ["contraseñas (hash)", "sesiones y refresh tokens", "PIN del propietario (hash) e intentos", "pepper del PIN", "llaves service_role/anon/JWT",
      "secretos del vault", "configuración de Auth/proyecto (SMTP, URLs, proveedores)", "variables del api-server"],
  };
  hallazgos = hallazgos.concat(escanearSecretos({ "manifiesto.json": JSON.stringify(m) }));
  m.secretos = { resultado: hallazgos.length ? "HALLAZGOS" : "LIMPIO", patrones: 9, hallazgos };
  m = sellarManifiesto(m);
  const texto = JSON.stringify(m, null, 2) + "\n";
  writeFileSync(path.join(dir, "manifiesto.json"), texto);
  writeFileSync(path.join(dir, "manifiesto.json.sha256"), `${sha256Buf(Buffer.from(texto))}  manifiesto.json\n`);
  const ok = m.verificacion.resultado === "VERIFICADO" && m.secretos.resultado === "LIMPIO";
  salir(ok, `MANIFIESTO ${ok ? "OK" : "FALLIDO"} · ${artefactos.length} artefactos · verificación ${m.verificacion.resultado} ${JSON.stringify(checks)} · secretos ${m.secretos.resultado}${hallazgos.length ? " " + JSON.stringify(hallazgos) : ""}${st.ok ? "" : " · storage " + JSON.stringify({ faltan: st.faltan, sobran: st.sobran, diferentes: st.diferentes })}`);
}

const acciones = {
  manifiesto,
  async verificar() {
    const r = await verificarRespaldo(arg("dir"), { restauradorVersion: arg("restaurador-version") });
    for (const e of r.errores) console.log(`RECHAZADO  ${e.codigo}  ${e.detalle}`);
    salir(r.ok, r.ok ? `RESPALDO VÁLIDO · ${r.manifiesto.artefactos.length} artefactos · manifiesto ${r.manifiesto.manifiesto_sha256}` : "RESPALDO RECHAZADO");
  },
  async comparar() {
    const r = compararFotos(readFileSync(arg("origen"), "utf8"), readFileSync(arg("restaurada"), "utf8"));
    for (const d of r.diferencias.slice(0, 40)) console.log("  " + d);
    salir(r.ok, `${r.ok ? "IGUALES" : "DIFERENTES"} · ${r.lineas} líneas comparadas · excluidas por diseño: ${r.excluidas.join(", ") || "-"}`);
  },
  async "storage-verificar"() {
    const r = await verificarStorage(inventarioDesdeFoto(readFileSync(arg("foto"), "utf8")), arg("raiz"));
    salir(r.ok, `STORAGE ${r.ok ? "OK" : "FALLA"} · verificados ${r.verificados.length} · faltan ${r.faltan.length} ${JSON.stringify(r.faltan)} · diferentes ${r.diferentes.length} ${JSON.stringify(r.diferentes)} · sobran ${r.sobran.length} ${JSON.stringify(r.sobran)}`);
  },
  async "storage-descargar"() {
    const base = process.env.ENTIMOTORS_STORAGE_URL, llave = process.env.ENTIMOTORS_STORAGE_LLAVE;
    if (!base) salir(false, "falta ENTIMOTORS_STORAGE_URL (la llave va en ENTIMOTORS_STORAGE_LLAVE; nunca como argumento)");
    const r = await descargarStorage(inventarioDesdeFoto(readFileSync(arg("foto"), "utf8")), base, llave, arg("destino"));
    salir(r.errores.length === 0, `descargados ${r.hechos.length} · errores ${r.errores.length} ${JSON.stringify(r.errores)}`);
  },
  async secretos() {
    const h = escanearSecretos(Object.fromEntries(resto.map((f) => [f, readFileSync(f, "utf8")])));
    salir(h.length === 0, h.length ? `SECRETOS ENCONTRADOS: ${JSON.stringify(h)}` : `LIMPIO (${resto.length} archivos)`);
  },
  async clasificar() {
    let obj = null; try { obj = JSON.parse(readFileSync(resto[0], "utf8")); } catch { obj = null; }
    salir(true, clasificarArchivo(obj));
  },
};
if (!acciones[cmd]) salir(false, "uso: respaldo.mjs {manifiesto|verificar|comparar|storage-verificar|storage-descargar|secretos|clasificar} …");
await acciones[cmd]();
