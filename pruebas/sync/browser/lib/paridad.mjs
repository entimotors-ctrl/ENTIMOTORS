// SYNC-10 · MIGRATION_PARITY_CHECK: respaldo 3.13 vs estado de la NUBE tras importar. No basta con contar filas: compara,
// registro por registro (por su local_id de la 3.13), los campos que importan y las RELACIONES (resueltas a ids locales),
// los renglones de cada venta/crédito/orden/cotización como multiconjunto, los abonos y la caja. Las diferencias se
// informan como RUTAS («ventas_rapidas#3.total»), nunca con valores: un reporte de prueba no lleva datos personales.
const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const t = (v) => (v === null || v === undefined ? "" : String(v));
const fechaDia = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

export function paridad(respaldo, nube) {
  const d = respaldo.data, dif = [];
  const q = (sql) => nube(sql);
  const porLocal = (filas) => new Map(filas.map((x) => [x.local_id, x]));
  const loc = {};   // uuid de la nube → local_id de la 3.13, por tabla
  const cargar = (tabla, cols) => {
    const filas = q(`select id, local_id, ${cols} from public.${tabla} where dispositivo = 'legado-313'`);
    loc[tabla] = new Map(filas.map((x) => [x.id, x.local_id]));
    return porLocal(filas);
  };
  const L = (tabla, uuid) => (uuid ? loc[tabla].get(uuid) ?? "?" : null);
  const existe = (store, id) => id !== null && id !== undefined && d[store].some((x) => x.id === id);
  const refEsperada = (store, id) => (existe(store, id) ? id : null);
  const igual = (ruta, esperado, obtenido) => { if (JSON.stringify(esperado) !== JSON.stringify(obtenido)) dif.push(ruta); };
  const cuenta = (store, mapa) => igual(`${store}.#filas`, d[store].length, mapa.size);
  const multiconjunto = (xs) => xs.map((x) => JSON.stringify(x)).sort();

  const cats = cargar("categorias_inv", "nombre"); cuenta("categorias_inv", cats);
  for (const x of d.categorias_inv) igual(`categorias_inv#${x.id}.nombre`, t(x.nombre).trim(), cats.get(x.id)?.nombre);
  const cli = cargar("clientes", "nombre, telefono"); cuenta("clientes", cli);
  for (const x of d.clientes) { const c = cli.get(x.id); igual(`clientes#${x.id}.nombre`, t(x.nombre).trim(), c?.nombre); igual(`clientes#${x.id}.telefono`, t(x.telefono), t(c?.telefono)); }
  const inv = cargar("inventario", "nombre, cantidad, costo_compra, precio_venta, categoria_id, requiere_revision"); cuenta("inventario", inv);
  const motos = cargar("motos", "cliente_id, marca, modelo, placa, km, cilindraje"); cuenta("motos", motos);
  const ord = cargar("ordenes", "cliente_id, moto_id, estado, falla, mecanico, mecanico_id, finalizada, tipo_cobro, metodo_pago, margen, credito_id"); cuenta("ordenes", ord);
  const cot = cargar("cotizaciones", "cliente_nombre, estado, validez_dias, orden_id, cliente_id"); cuenta("cotizaciones", cot);
  const citas = cargar("citas", "cliente_id, fecha, hora, estado, motivo, orden_id"); cuenta("citas", citas);
  const ven = cargar("ventas", "cliente_id, metodo_pago, total, occurred_at"); cuenta("ventas_rapidas", ven);
  const cre = cargar("creditos", "cliente_id, total, abonado, saldo, estado, orden_id"); cuenta("creditos", cre);
  const caja = cargar("caja_movimientos", "tipo, categoria, monto, venta_id, credito_id, orden_id, id_abono"); cuenta("caja_movimientos", caja);

  for (const x of d.inventario) {
    const c = inv.get(x.id); const r = `inventario#${x.id}`;
    igual(r + ".cantidad", n(x.cantidad), n(c?.cantidad)); igual(r + ".nombre", t(x.nombre).trim(), c?.nombre);
    igual(r + ".costo_compra", n(x.costoCompra) ?? 0, n(c?.costo_compra)); igual(r + ".precio_venta", n(x.precioVenta ?? x.precio) ?? 0, n(c?.precio_venta));
    igual(r + ".categoria", refEsperada("categorias_inv", x.categoriaId), L("categorias_inv", c?.categoria_id));
    igual(r + ".requiere_revision", n(x.cantidad) < 0, c?.requiere_revision);
  }
  for (const x of d.motos) {
    const c = motos.get(x.id); const r = `motos#${x.id}`;
    igual(r + ".cliente", refEsperada("clientes", x.clienteId), L("clientes", c?.cliente_id));
    for (const [k, col] of [["marca", "marca"], ["modelo", "modelo"], ["placa", "placa"], ["cilindraje", "cilindraje"]]) igual(`${r}.${k}`, t(x[k]), t(c?.[col]));
    igual(r + ".km", n(x.km), n(c?.km));
  }
  const renglones = (tabla, fk, cols) => {
    const m = new Map();
    for (const x of q(`select ${fk} as padre, ${cols} from public.${tabla}`)) { const k = x.padre; if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return m;
  };
  const oi = renglones("orden_items", "orden_id", "nombre, cantidad, precio, inventario_id");
  for (const x of d.ordenes) {
    const c = ord.get(x.id); const r = `ordenes#${x.id}`;
    igual(r + ".estado", x.estado, c?.estado); igual(r + ".falla", t(x.falla), t(c?.falla)); igual(r + ".mecanico", t(x.mecanico), t(c?.mecanico));
    igual(r + ".mecanico_id", null, c?.mecanico_id ?? null); igual(r + ".finalizada", x.finalizada === true, c?.finalizada);
    igual(r + ".tipo_cobro", x.tipoCobro || null, c?.tipo_cobro ?? null); igual(r + ".margen", n(x.margen), n(c?.margen));
    igual(r + ".cliente", refEsperada("clientes", x.clienteId), L("clientes", c?.cliente_id)); igual(r + ".moto", refEsperada("motos", x.motoId), L("motos", c?.moto_id));
    igual(r + ".credito", refEsperada("creditos", x.creditoId), L("creditos", c?.credito_id));
    igual(r + ".items", multiconjunto((x.items || []).map((i) => [t(i.nombre), n(i.cantidad), n(i.precio), refEsperada("inventario", i.origenInventarioId)])),
      multiconjunto((oi.get(c?.id) || []).map((i) => [i.nombre, n(i.cantidad), n(i.precio), L("inventario", i.inventario_id)])));
  }
  const ci = renglones("cotizacion_items", "cotizacion_id", "nombre, cantidad, precio, inventario_id");
  for (const x of d.cotizaciones) {
    const c = cot.get(x.id); const r = `cotizaciones#${x.id}`;
    igual(r + ".estado", x.estado || "pendiente", c?.estado); igual(r + ".cliente_nombre", t(x.clienteNombre).trim(), c?.cliente_nombre);
    igual(r + ".orden", refEsperada("ordenes", x.ordenId), L("ordenes", c?.orden_id)); igual(r + ".cliente", refEsperada("clientes", x.clienteId), L("clientes", c?.cliente_id));
    igual(r + ".items", multiconjunto((x.items || []).map((i) => [t(i.nombre), n(i.cantidad), n(i.precio), refEsperada("inventario", i.inventarioId)])),
      multiconjunto((ci.get(c?.id) || []).map((i) => [i.nombre, n(i.cantidad), n(i.precio), L("inventario", i.inventario_id)])));
  }
  for (const x of d.citas) {
    const c = citas.get(x.id); const r = `citas#${x.id}`;
    igual(r + ".fecha", x.fecha, fechaDia(c?.fecha)); igual(r + ".hora", x.hora, c?.hora); igual(r + ".estado", x.estado ?? null, c?.estado ?? null);
    igual(r + ".orden", refEsperada("ordenes", x.ordenId), L("ordenes", c?.orden_id)); igual(r + ".cliente", refEsperada("clientes", x.clienteId), L("clientes", c?.cliente_id));
  }
  const vi = renglones("venta_items", "venta_id", "nombre, cantidad, precio, inventario_id");
  for (const x of d.ventas_rapidas) {
    const c = ven.get(x.id); const r = `ventas_rapidas#${x.id}`;
    igual(r + ".total", n(x.total), n(c?.total)); igual(r + ".metodo_pago", x.metodoPago, c?.metodo_pago);
    igual(r + ".cliente", refEsperada("clientes", x.clienteId), L("clientes", c?.cliente_id));
    igual(r + ".fecha", new Date(x.fechaISO).toISOString(), c?.occurred_at ? new Date(c.occurred_at).toISOString() : null);
    igual(r + ".items", multiconjunto((x.items || []).map((i) => [t(i.nombre), n(i.cantidad), n(i.precio), refEsperada("inventario", i.inventarioId)])),
      multiconjunto((vi.get(c?.id) || []).map((i) => [i.nombre, n(i.cantidad), n(i.precio), L("inventario", i.inventario_id)])));
  }
  const cri = renglones("credito_items", "credito_id", "nombre, cantidad, precio");
  const ab = renglones("abonos", "credito_id", "monto, metodo_pago, anulado");
  for (const x of d.creditos) {
    const c = cre.get(x.id); const r = `creditos#${x.id}`;
    for (const k of ["total", "abonado", "saldo"]) igual(`${r}.${k}`, n(x[k]), n(c?.[k]));
    igual(r + ".estado", x.estado, c?.estado); igual(r + ".orden", refEsperada("ordenes", x.ordenId), L("ordenes", c?.orden_id));
    igual(r + ".items", multiconjunto((x.items || []).map((i) => [t(i.nombre), n(i.cantidad), n(i.precio)])), multiconjunto((cri.get(c?.id) || []).map((i) => [i.nombre, n(i.cantidad), n(i.precio)])));
    igual(r + ".abonos", multiconjunto((x.historialAbonos || []).map((a) => [n(a.monto), a.metodoPago || "efectivo", false])),
      multiconjunto((ab.get(c?.id) || []).map((a) => [n(a.monto), a.metodo_pago, a.anulado])));
  }
  for (const x of d.caja_movimientos) {
    const c = caja.get(x.id); const r = `caja_movimientos#${x.id}`;
    igual(r + ".tipo", x.tipo, c?.tipo); igual(r + ".monto", n(x.monto), n(c?.monto)); igual(r + ".categoria", t(x.categoria), t(c?.categoria));
    igual(r + ".venta", refEsperada("ventas_rapidas", x.ventaId), L("ventas", c?.venta_id)); igual(r + ".credito", refEsperada("creditos", x.creditoId), L("creditos", c?.credito_id));
    igual(r + ".orden", refEsperada("ordenes", x.ordenId), L("ordenes", c?.orden_id)); igual(r + ".abono_ligado", !!(x.idAbono && existe("creditos", x.creditoId)), !!c?.id_abono);
  }
  // nada de más en la nube: ni filas fuera del respaldo ni movimientos de stock que no sean la apertura
  igual("nube.filas_ajenas", 0, Number(q(`select (select count(*) from public.clientes where dispositivo is distinct from 'legado-313') + (select count(*) from public.ventas where dispositivo is distinct from 'legado-313') + (select count(*) from public.caja_movimientos where dispositivo is distinct from 'legado-313') as n`)[0].n));
  igual("nube.ledger_solo_apertura", 0, Number(q(`select count(*) as n from public.inventario_movimientos where tipo <> 'importacion'`)[0].n));
  return dif;
}
