// 3.15 (Bloque 7) · DATOS SINTÉTICOS DE VOLUMEN para medir rendimiento. Solo la base de pruebas t_e2e (pila local); nada real.
// Un «volumen» se nombra por sus movimientos de caja; el resto crece en proporción (la del Bloque 5 para 3 000 movimientos) y todo
// se reparte en 90 días hacia atrás. «actual» = los tamaños de producción (foto de solo lectura del Bloque 6), sin sus datos.
import { PERFILES } from "./pila.mjs";

export function tamanos(vol) {
  if (vol === "actual") return { caja: 28, clientes: 24, motos: 6, ordenes: 8, itemsPorOrden: 3, inventario: 4, citas: 3, cotizaciones: 1, creditos: 23, abonos: 12, ventas: 5, mensajes: 6, mecanicoCada: 3 };
  const n = Number(vol);
  if (!(n > 0)) throw new Error("volumen inválido: " + vol);
  return { caja: n, clientes: Math.round(n / 10), motos: Math.round(n / 10), ordenes: Math.round(n / 4), itemsPorOrden: 3, inventario: Math.min(1000, Math.round(n / 10)),
    citas: Math.round(n / 30), cotizaciones: Math.round(n / 30), creditos: Math.round(n / 5), abonos: Math.round((2 * n) / 5), ventas: Math.round(n / 6), mensajes: Math.min(200, Math.round(n / 50)), mecanicoCada: 25 };
}

const id = (pref, expr) => `md5('${pref}' || (${expr})::text)::uuid`;

/** Siembra el volumen `vol` (pila.limpiar() antes). Devuelve los tamaños sembrados. */
export function sembrarVolumen(pila, vol) {
  const t = tamanos(vol);
  pila.limpiar();
  pila.sql(`set session_replication_role = replica;
    insert into public.clientes (id, nombre, telefono, creado_en)
      select ${id("cli", "g")}, 'Cliente ' || g, '9' || lpad(g::text, 7, '0'), now() - (g % 90) * interval '1 day' from generate_series(1, ${t.clientes}) g;
    insert into public.motos (id, cliente_id, marca, modelo, placa, km)
      select ${id("mot", "g")}, ${id("cli", `(g - 1) % ${t.clientes} + 1`)}, 'Marca ' || (g % 7), 'M' || (g % 13), 'P' || lpad(g::text, 6, '0'), 1000 + g from generate_series(1, ${t.motos}) g;
    insert into public.inventario (id, nombre, precio_venta, costo_compra, cantidad, codigo_barras)
      select ${id("inv", "g")}, 'Repuesto ' || g, 100 + g % 400, 60 + g % 200, g % 20, '750' || lpad(g::text, 9, '0') from generate_series(1, ${t.inventario}) g;
    insert into public.citas (id, cliente_id, nombre_tmp, telefono_tmp, fecha, hora, motivo, mecanico_id)
      select ${id("cit", "g")}, ${id("cli", `(g - 1) % ${t.clientes} + 1`)}, 'Cliente ' || g, '9', (now() + ((g % 30) - 10) * interval '1 day')::date, lpad((8 + g % 9)::text, 2, '0') || ':00', 'revisión ' || g,
             case when g % 4 = 0 then '${PERFILES.mecanico}'::uuid end from generate_series(1, ${t.citas}) g;
    insert into public.cotizaciones (id, cliente_id, cliente_nombre, estado, validez_dias, vence_en, creado_en)
      select ${id("cot", "g")}, ${id("cli", `(g - 1) % ${t.clientes} + 1`)}, 'Cliente ' || g, 'pendiente', 15, now() + ((g % 30) - 10) * interval '1 day', now() - (g % 60) * interval '1 day' from generate_series(1, ${t.cotizaciones}) g;
    insert into public.cotizacion_items (cotizacion_id, nombre, cantidad, precio)
      select ${id("cot", `(g - 1) % ${t.cotizaciones} + 1`)}, 'renglón ' || g, 1, 150 from generate_series(1, ${t.cotizaciones * 2}) g;
    insert into public.ordenes (id, cliente_id, moto_id, estado, falla, finalizada, finalizado_en, entregado_en, tipo_cobro, mecanico, mecanico_id, creado_en)
      select ${id("ord", "g")}, ${id("cli", `(g - 1) % ${t.clientes} + 1`)}, ${id("mot", `(g - 1) % ${t.motos} + 1`)},
             (array['recibido','diagnostico','presupuesto','reparacion','calidad','entregado','entregado','entregado'])[g % 8 + 1], 'falla ' || g,
             g % 8 >= 5 and g % 3 <> 0, case when g % 8 >= 5 and g % 3 <> 0 then now() - (g % 90) * interval '1 day' end,
             case when g % 8 >= 5 then now() - (g % 90) * interval '1 day' end, 'contado',
             case when g % ${t.mecanicoCada} = 0 then 'Mec Uno' end, case when g % ${t.mecanicoCada} = 0 then '${PERFILES.mecanico}'::uuid end,
             now() - (g % 90) * interval '1 day' - interval '2 day'
        from generate_series(1, ${t.ordenes}) g;
    insert into public.orden_items (orden_id, nombre, cantidad, precio, costo_unitario)
      select ${id("ord", `(g - 1) % ${t.ordenes} + 1`)}, 'mano de obra ' || g, 1, 200, 0 from generate_series(1, ${t.ordenes * t.itemsPorOrden}) g;
    insert into public.caja_movimientos (tipo, categoria, monto, metodo_pago, descripcion, occurred_at)
      select case when g % 5 = 0 then 'egreso' else 'ingreso' end, case when g % 5 = 0 then 'Planilla' else 'Venta mostrador' end, (g % 900) + 10, 'efectivo', 'v' || g,
             now() - (g % 90) * interval '1 day' - (g % 600) * interval '1 minute' from generate_series(1, ${t.caja}) g;
    insert into public.creditos (id, cliente_nombre, total, abonado, saldo, estado, origen, occurred_at)
      select ${id("cre", "g")}, 'c' || g, 1000, 400, 600, 'parcial', 'pos', now() - (g % 90) * interval '1 day' from generate_series(1, ${t.creditos}) g;
    insert into public.credito_items (credito_id, nombre, cantidad, precio) select ${id("cre", "g")}, 'x', 1, 1000 from generate_series(1, ${t.creditos}) g;
    insert into public.abonos (id_abono, credito_id, monto, metodo_pago, occurred_at)
      select 'P' || g, ${id("cre", `g % ${t.creditos} + 1`)}, 200, 'efectivo', now() - (g % 90) * interval '1 day' from generate_series(1, ${t.abonos}) g;
    insert into public.ventas (id, metodo_pago, total, occurred_at) select ${id("ven", "g")}, 'efectivo', 150, now() - (g % 90) * interval '1 day' from generate_series(1, ${t.ventas}) g;
    insert into public.venta_items (venta_id, nombre, cantidad, precio, costo_unitario) select ${id("ven", "g")}, 'r', 1, 150, 90 from generate_series(1, ${t.ventas}) g;
    insert into public.mensajes (remitente_id, remitente_nombre, destinatario_id, texto, op_id, creado_en)
      select '${PERFILES.admin}', 'Admin', '${PERFILES.mecanico}', 'mensaje ' || g, ${id("msg", "g")}, now() - (g % 30) * interval '1 hour' from generate_series(1, ${t.mensajes}) g;
    -- sello de sincronización REPARTIDO en el pasado (como un taller real): todo sembrado «ahora» cae dentro del solapamiento de 60 s
    -- de la descarga incremental (sync-rest.js) y cada reapertura lo re-leería entero — un artefacto de la siembra, no de la app
    ${["clientes", "motos", "citas", "cotizaciones", "inventario", "ordenes", "caja_movimientos", "creditos", "ventas", "mensajes"]
      .map((x) => `update public.${x} set updated_at = now() - interval '1 day' - (abs(hashtext(id::text)) % 6912000) * interval '1 second';`).join("\n    ")}
    reset session_replication_role; analyze;`);
  return t;
}
