#!/usr/bin/env node
// 3.15.0 · BLOQUE 8 · AUDITORÍA DE LA CADENA 15a–15g (solo LABORATORIO: Postgres local de pruebas; nunca producción).
//   1 · base 3.14.1 limpia (referencia = producción 2026-09-21 + SYNC 1..10 + SEC-1C) → foto del catálogo (b8-catalogo.sql)
//   2 · 15a → 15g EN ORDEN (cada una debe aplicar) → foto → DIFERENCIAS: funciones nuevas/cambiadas/quitadas, RLS, dueños, permisos,
//       políticas, triggers
//   3 · reaplicar 15a–15g (idempotencia): la foto NO cambia
//   4 · datos (3 000 movimientos) → verificar_invariantes() = [] y finanzas_invariantes() = []
//   5 · FUERA DE ORDEN sobre 3.14.1: 15c sin 15a/15b, 15e sin 15d, 15g sin 15f → se detiene y no deja nada a medias
//   node pruebas/sync/sql/b8-migraciones.mjs <carpeta-salida>
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sql as sqlPila, FASES, RAIZ } from "../browser/lib/pila.mjs";
import { sembrarVolumen } from "../browser/lib/volumen.mjs";

const OUT = process.argv[2] || "/tmp/b8-migraciones"; fs.mkdirSync(OUT, { recursive: true });
const ENTORNO = path.join(RAIZ, "pruebas/sync/entorno-local.sh");
const SQLDIR = path.join(RAIZ, "taller-demo/supabase/sync");
const CATALOGO = fs.readFileSync(path.join(RAIZ, "pruebas/sync/sql/b8-catalogo.sql"), "utf8");
const DEL_315 = FASES.filter((f) => /^15/.test(f)), BASE_314 = FASES.filter((f) => !/^15/.test(f));
const R = { pasos: [] };
const paso = (x) => { R.pasos.push(x); console.log(JSON.stringify(x)); };
const nueva = (db) => { spawnSync("bash", [ENTORNO, "borra", db]); if (spawnSync("bash", [ENTORNO, "copia", db]).status !== 0) throw new Error("copia " + db);
  const s = (q, o = {}) => sqlPila(q, { db, ...o });
  for (const f of BASE_314) s(`\\i ${path.join(SQLDIR, `sync-${f}.sql`)}`);
  s(`\\i ${path.join(SQLDIR, "sec-1c-clave-intentos.sql")}`);
  return s; };
const aplicar = (s, f) => { try { s(`\\i ${path.join(SQLDIR, `sync-${f}.sql`)}`); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message).split("\n").find((l) => /ERROR|STOP/.test(l)) || String(e.message).slice(0, 200) }; } };
const foto = (s) => s(CATALOGO).split("\n").filter(Boolean);

// 1–3
const s = nueva("t_b8mig");
const f0 = foto(s); fs.writeFileSync(path.join(OUT, "catalogo-3.14.1.txt"), f0.join("\n") + "\n");
for (const f of DEL_315) paso({ paso: "aplicar", fase: f, ...aplicar(s, f) });
const f1 = foto(s); fs.writeFileSync(path.join(OUT, "catalogo-3.15.txt"), f1.join("\n") + "\n");
for (const f of DEL_315) paso({ paso: "reaplicar", fase: f, ...aplicar(s, f) });
const f2 = foto(s);
paso({ paso: "idempotencia", foto_igual: JSON.stringify(f1) === JSON.stringify(f2), diferencias: f1.filter((x) => !f2.includes(x)).length + f2.filter((x) => !f1.includes(x)).length });

// diferencias por clase
const clave = (l) => l.split("|").slice(0, l.startsWith("F|") || l.startsWith("T|") ? 2 : 3).join("|");
const m0 = new Map(f0.map((l) => [clave(l), l])), m1 = new Map(f1.map((l) => [clave(l), l]));
const dif = { nuevos: [], quitados: [], cambiados: [] };
for (const [k, l] of m1) if (!m0.has(k)) dif.nuevos.push(l); else if (m0.get(k) !== l) dif.cambiados.push({ antes: m0.get(k), despues: l });
for (const [k, l] of m0) if (!m1.has(k)) dif.quitados.push(l);
fs.writeFileSync(path.join(OUT, "diferencias-3.14.1-a-3.15.json"), JSON.stringify(dif, null, 1));
// comprobaciones de seguridad del diff
const campo = (l, i) => l.split("|")[i];
const rlsPerdida = dif.cambiados.filter((c) => c.antes.startsWith("T|") && campo(c.antes, 2) === "true" && campo(c.despues, 2) !== "true");
const duenoCambiado = dif.cambiados.filter((c) => (c.antes.startsWith("T|") && campo(c.antes, 4) !== campo(c.despues, 4)) || (c.antes.startsWith("F|") && campo(c.antes, 5) !== campo(c.despues, 5)));
const secdefCambiado = dif.cambiados.filter((c) => c.antes.startsWith("F|") && campo(c.antes, 2) !== campo(c.despues, 2));
const searchPathPerdido = dif.cambiados.filter((c) => c.antes.startsWith("F|") && /search_path/.test(campo(c.antes, 4)) && !/search_path/.test(campo(c.despues, 4)));
const permisos = (l, i) => new Set((campo(l, i) || "").split(",").filter(Boolean));
const permisosPerdidos = dif.cambiados.filter((c) => (c.antes.startsWith("F|") || c.antes.startsWith("T|")) && (() => { const i = c.antes.startsWith("F|") ? 7 : 5; const a = permisos(c.antes, i), d = permisos(c.despues, i); return [...a].some((x) => !d.has(x)); })())
  .map((c) => ({ objeto: campo(c.antes, 1), antes: campo(c.antes, c.antes.startsWith("F|") ? 7 : 5), despues: campo(c.despues, c.antes.startsWith("F|") ? 7 : 5) }));
const anonGana = f1.filter((l) => (l.startsWith("F|") && /(^|,)anon=X/.test(campo(l, 7)) && !(m0.get(clave(l)) || "").match(/(^|,)anon=X/)));
const funcionesCambiadas = dif.cambiados.filter((c) => c.antes.startsWith("F|")).map((c) => campo(c.antes, 1));
const politicasCambiadas = [...dif.cambiados.filter((c) => c.antes.startsWith("P|")).map((c) => `${campo(c.antes, 1)}.${campo(c.antes, 2)}`), ...dif.nuevos.filter((l) => l.startsWith("P|")).map((l) => `+${campo(l, 1)}.${campo(l, 2)}`), ...dif.quitados.filter((l) => l.startsWith("P|")).map((l) => `-${campo(l, 1)}.${campo(l, 2)}`)];
paso({ paso: "diff", funciones_nuevas: dif.nuevos.filter((l) => l.startsWith("F|")).length, funciones_cambiadas: funcionesCambiadas, funciones_quitadas: dif.quitados.filter((l) => l.startsWith("F|")).map((l) => campo(l, 1)),
  tablas_nuevas: dif.nuevos.filter((l) => l.startsWith("T|")).map((l) => campo(l, 1)), politicas: politicasCambiadas, triggers_nuevos: dif.nuevos.filter((l) => l.startsWith("G|")).length, triggers_quitados: dif.quitados.filter((l) => l.startsWith("G|")).map((l) => `${campo(l, 1)}.${campo(l, 2)}`),
  RLS_PERDIDA: rlsPerdida.length, DUENO_CAMBIADO: duenoCambiado.map((c) => campo(c.antes, 1)), SECURITY_DEFINER_CAMBIADO: secdefCambiado.map((c) => campo(c.antes, 1)), SEARCH_PATH_PERDIDO: searchPathPerdido.map((c) => campo(c.antes, 1)),
  PERMISOS_PERDIDOS: permisosPerdidos, ANON_GANA_EJECUCION: anonGana.map((l) => campo(l, 1)),
  tablas_sin_rls_3_15: f1.filter((l) => l.startsWith("T|") && campo(l, 2) !== "true").map((l) => campo(l, 1)) });

// 4 · datos + invariantes
sembrarVolumen({ sql: s, limpiar() {} }, "3000");
paso({ paso: "invariantes", verificar_invariantes: s("select public.verificar_invariantes()::text"), finanzas_invariantes: s("select public.finanzas_invariantes()::text"),
  fases: s("select string_agg(fase, ',' order by fase) from public.sync_fases") });

// 5 · fuera de orden
for (const [f, requisito] of [["15c-mensajes-realtime", "15a/15b"], ["15e-finanzas", "15d"], ["15g-rendimiento-rls", "15f"], ["15b-presupuestos-stock", "15a"]]) {
  const t = nueva("t_b8mig_orden");
  const antes = foto(t);
  const r = aplicar(t, f);
  const despues = foto(t);
  paso({ paso: "fuera-de-orden", fase: f, sin: requisito, aplicada: r.ok, error: r.error || null, catalogo_intacto: JSON.stringify(antes) === JSON.stringify(despues) });
}
spawnSync("bash", [ENTORNO, "borra", "t_b8mig"]); spawnSync("bash", [ENTORNO, "borra", "t_b8mig_orden"]);
fs.writeFileSync(path.join(OUT, "auditoria-lab.json"), JSON.stringify(R, null, 1));
