#!/usr/bin/env node
// 3.15 · BLOQUE 7 · RENDIMIENTO SQL (solo LABORATORIO: base aislada t_b7sql en el Postgres local de pruebas; nunca producción).
// Por volumen: tiempos (mediana de 5) y plan (EXPLAIN ANALYZE, BUFFERS) de lo que la app pide al servidor:
//   finanzas_resumen (día, mes, año), finanzas_invariantes, estadisticas_tecnicas, una página de la descarga incremental de
//   caja_movimientos / ordenes (como la pide PostgREST), ordenes_tecnico_mias y migracion_313_estado.
//   node pruebas/sync/sql/b7-rendimiento-sql.mjs [3000,10000,25000,100000] > salida.txt
import { spawnSync } from "node:child_process";
import path from "node:path";
import { sql as sqlPila, FASES, PERFILES, RAIZ } from "../browser/lib/pila.mjs";
import { sembrarVolumen } from "../browser/lib/volumen.mjs";

const DB = "t_b7sql";
const ENTORNO = path.join(RAIZ, "pruebas/sync/entorno-local.sh");
const SQLDIR = path.join(RAIZ, "taller-demo/supabase/sync");
const sql = (q, o = {}) => sqlPila(q, { db: DB, ...o });
const vols = (process.argv[2] || "3000,10000,25000,100000").split(",");

spawnSync("bash", [ENTORNO, "borra", DB]);
if (spawnSync("bash", [ENTORNO, "copia", DB]).status !== 0) throw new Error("no se pudo crear " + DB);
// B7_SIN_15G=1: la cadena SIN sync-15g (para medir ANTES de optimizar las políticas de lectura)
for (const f of FASES.filter((x) => !(process.env.B7_SIN_15G === "1" && x === "15g-rendimiento-rls"))) sql(`\\i ${path.join(SQLDIR, `sync-${f}.sql`)}`);
sql(`\\i ${path.join(SQLDIR, "sec-1c-clave-intentos.sql")}`);
sql(`set session_replication_role = replica;
  insert into auth.users (id, email) values ${Object.entries(PERFILES).map(([k, v]) => `('${v}', '${k}@example.test')`).join(",")} on conflict do nothing;
  insert into public.perfiles (id, nombre, rol, activo) values ('${PERFILES.admin}','Admin','admin',true),('${PERFILES.mecanico}','Mec Uno','mecanico',true)
  on conflict (id) do update set rol = excluded.rol, activo = true;`);
sql(`create or replace function auth.uid() returns uuid language sql stable as $f$
       select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;`);

const pilaFalsa = {
  sql,
  limpiar() {
    sql(`set session_replication_role = replica;
      truncate public.clientes, public.motos, public.citas, public.categorias_inv, public.cotizaciones, public.cotizacion_items, public.ordenes, public.orden_items,
        public.inventario, public.inventario_movimientos, public.ventas, public.venta_items, public.creditos, public.credito_items, public.abonos, public.caja_movimientos,
        public.reversos, public.sync_ops, public.mensajes cascade;`);
  },
};
const como = (uid, q) => `begin; set local role authenticated; set local request.jwt.claim.sub = '${uid}'; ${q}; commit;`;
function tiempo(q, uid = PERFILES.admin) {
  // UNA sola sentencia cronometrada por sesión (el rol y el usuario se fijan antes, sin cronómetro), sobre TODO el resultado (count(*))
  const v = [];
  for (let i = 0; i < 5; i++) {
    const out = sql(`set role authenticated; set request.jwt.claim.sub = '${uid}';\n\\timing on\nselect sum(length(x::text)) from (${q}) x;`);   // usa TODA la fila: con count(*) Postgres ni evalúa una función que nadie lee
    const m = String(out).match(/Time: ([\d.,]+) ms/);
    v.push(m ? Number(m[1].replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")) : NaN);   // «1.234,5 ms» (configuración regional es)
  }
  v.sort((a, b) => a - b); return v[2];
}
const plan = (q, uid = PERFILES.admin) => String(sql(como(uid, `explain (analyze, buffers, costs off, timing on) ${q}`))).split("\n").filter((l) => !/^(BEGIN|SET|COMMIT)$/.test(l.trim())).join("\n");

const CONSULTAS = {
  finanzas_resumen_dia: "select public.finanzas_resumen(current_date, current_date)",
  finanzas_resumen_mes: "select public.finanzas_resumen(date_trunc('month', now())::date, current_date)",
  finanzas_resumen_30d: "select public.finanzas_resumen(current_date - 30, current_date)",
  finanzas_resumen_anio: "select public.finanzas_resumen(current_date - 365, current_date)",
  finanzas_invariantes: "select public.finanzas_invariantes()",
  estadisticas_tecnicas: "select public.estadisticas_tecnicas()",
  pagina_pull_caja: "select * from public.caja_movimientos where updated_at >= now() - interval '100 days' order by updated_at, id limit 500",
  pagina_pull_caja_incremental: "select * from public.caja_movimientos where updated_at > now() - interval '2 days' order by updated_at, id limit 500",
  pagina_pull_ordenes: "select *, orden_items(*) from public.ordenes o where updated_at >= now() - interval '100 days' order by updated_at, id limit 500",
  migracion_313_estado: "select public.migracion_313_estado()",
};
for (const vol of vols) {
  const t = sembrarVolumen(pilaFalsa, vol);
  sql("vacuum analyze;");
  console.log(`\n## volumen ${vol} · filas: caja ${t.caja}, órdenes ${t.ordenes}, créditos ${t.creditos}, ventas ${t.ventas}`);
  for (const [k, q] of Object.entries(CONSULTAS)) {
    if (k === "pagina_pull_ordenes") { try { console.log(`${k}_ms|${tiempo("select * from public.ordenes where updated_at >= now() - interval '100 days' order by updated_at, id limit 500")}`); } catch (e) { console.log(`${k}|error ${e.message}`); } continue; }
    try { console.log(`${k}_ms|${tiempo(q)}`); } catch (e) { console.log(`${k}|error ${String(e.message).slice(0, 120)}`); }
  }
  try { console.log(`ordenes_tecnico_mias_ms|${tiempo("select * from public.ordenes_tecnico_mias()", PERFILES.mecanico)}`); } catch (e) { console.log(`ordenes_tecnico_mias|error ${String(e.message).slice(0, 120)}`); }
  if (vol === vols[vols.length - 1] || vol === "10000") {
    console.log(`\n### planes (volumen ${vol})`);
    for (const k of ["pagina_pull_caja", "pagina_pull_caja_incremental"]) console.log(`\n-- ${k}\n${plan(CONSULTAS[k])}`);
    // lo que finanzas_resumen hace por dentro: su recorrido de caja del rango (misma expresión e índice que la función)
    console.log(`\n-- caja del mes (recorrido interno de finanzas_resumen)\n${plan("select count(*), sum(monto) from public.caja_movimientos where coalesce(occurred_at, creado_en) >= date_trunc('month', now()) and coalesce(occurred_at, creado_en) < now() + interval '1 day'")}`);
    console.log(`\n-- finanzas_resumen mes\n${plan(CONSULTAS.finanzas_resumen_mes)}`);
  }
}
spawnSync("bash", [ENTORNO, "borra", DB]);
