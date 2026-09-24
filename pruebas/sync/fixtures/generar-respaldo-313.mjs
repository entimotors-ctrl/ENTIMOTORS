// SYNC-10 · Genera un respaldo 3.13 REALISTA y 100 % SINTÉTICO con el CÓDIGO REAL de la versión publicada (tag v3.13.0),
// no a mano: se extrae taller-demo/ del tag a una carpeta temporal, se abre en un navegador real en MODO LOCAL (como el
// teléfono del taller hoy) y se usan sus propias funciones (registrarVentaRapida, cobrarAlCredito,
// registrarAbonoCredito, registrarIngresoTaller, updateOrder, DB.save) para crear datos con relaciones de verdad. El archivo
// sale de armarRespaldo()/verificarRespaldo() de 3.13, idéntico a lo que el taller descarga en «Respaldar».
// Nombres, teléfonos y placas son inventados. Nunca toca datos reales ni la nube.
//   node pruebas/sync/fixtures/generar-respaldo-313.mjs            → pruebas/sync/fixtures/respaldo-313-realista.json
//                                                                    + respaldo-313-demo.json (solo «Ver un ejemplo»)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { abrirDispositivo } from "../browser/lib/dispositivo.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../../..");
const SALIDA = path.join(AQUI, "respaldo-313-realista.json");
const SALIDA_DEMO = path.join(AQUI, "respaldo-313-demo.json");   // «Ver un ejemplo» de la 3.13: debe RECHAZARSE

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entimotors-313-"));
const arch = spawnSync("sh", ["-c", `git -C "${RAIZ}" archive v3.13.0 taller-demo | tar -x -C "${tmp}"`], { encoding: "utf8" });
if (arch.status !== 0) throw new Error("no se pudo extraer v3.13.0: " + arch.stderr);
const raiz = path.join(tmp, "taller-demo");

const d = await abrirDispositivo({ navegador: process.env.NAV || "chromium", nombre: "genera-313", pagina: "index.html", real: true, raiz });
try {
  const r = await d.eval(async () => {
    const hace = (dias, h = 10) => { const x = new Date(Date.now() - dias * 86400000); x.setHours(h, 0, 0, 0); return x; };
    window.toast = () => {};
    localStorage.setItem("enti_modo_datos", "blanco");
    db = await openDb("entimotors_os_demo");
    currentUser = { user: "admin", nombre: "Admin Sintético", rol: "admin", origen: "local", perfilId: null };
    // SIN seedIfEmpty(): el importador rechaza a propósito los datos de «Ver un ejemplo» (SYNC-10 · B2). Todo lo de aquí
    // es sintético propio, creado con las funciones reales de la 3.13.
    for (const n of ["Repuestos", "Aceites y lubricantes", "Frenos", "Accesorios"]) await DB.save("categorias_inv", { nombre: n });
    await DB.save("web_cms", { key: "landing_hero", titulo: "Taller sintético", subtitulo: "Solo para pruebas" });

    // clientes/motos extra (acentos, sin moto, moto sin cliente)
    const cli = [];
    for (const [n, t] of [["Ñoño Pérez Álvarez", "9900-0001"], ["Ana María Ruíz", "9900-0002"], ["José «Chepe» Díaz", ""], ["Cliente Sin Moto", "9900-0004"]]) cli.push(await DB.save("clientes", { nombre: n, telefono: t }));
    const moto1 = await DB.save("motos", { clienteId: cli[0], marca: "Honda", modelo: "XR150", cilindraje: "150cc", placa: "SIN-0001", km: 12000, foto: "data:image/png;base64,iVBORw0KGgo=", mantenimiento: null });
    const moto2 = await DB.save("motos", { clienteId: cli[1], marca: "Yamaha", modelo: "FZ", cilindraje: "150cc", placa: "SIN-0002", km: 3000, foto: null, mantenimiento: null });
    await DB.save("motos", { clienteId: null, marca: "Bajaj", modelo: "Boxer", cilindraje: "100cc", placa: "SIN-HUERF", km: 0, foto: null, mantenimiento: null });

    // inventario: 0, 1 y alto; uno que se vende y luego se BORRA (referencia colgante en la venta)
    const cats = await DB.getAll("categorias_inv");
    const inv0 = await DB.save("inventario", { nombre: "Bujía NGK", modelo: "Varios", cantidad: 0, precio: 90, precioVenta: 90, costoCompra: 45, stockMinimo: 5, codigoBarras: "SIN-BUJ", categoriaId: cats[0].id, publicarEnWeb: false });
    const inv1 = await DB.save("inventario", { nombre: "Cadena 428", modelo: "125-150", cantidad: 1, precio: 520, precioVenta: 520, costoCompra: 300, stockMinimo: 1, codigoBarras: "SIN-CAD", categoriaId: cats[0].id, publicarEnWeb: true });
    const invAlto = await DB.save("inventario", { nombre: "Aceite 2T (litro)", modelo: "Todos", cantidad: 250, precio: 150, precioVenta: 150, costoCompra: 95, stockMinimo: 20, codigoBarras: "SIN-2T", categoriaId: null, publicarEnWeb: false });
    await DB.save("inventario", { nombre: "Filtro de aire", modelo: "XR150", cantidad: 1, precio: 210, precioVenta: 210, costoCompra: 120, stockMinimo: 1, codigoBarras: "SIN-FIL", categoriaId: cats[1].id, publicarEnWeb: false });   // queda en 1
    const invBorrar = await DB.save("inventario", { nombre: "Espejo retrovisor", modelo: "Universal", cantidad: 6, precio: 180, precioVenta: 180, costoCompra: 80, stockMinimo: 2, codigoBarras: "SIN-ESP", categoriaId: null, publicarEnWeb: false });

    // ventas de mostrador: inventario + manual, tres métodos
    const v1 = await registrarVentaRapida({ items: [{ inventarioId: invAlto, nombre: "Aceite 2T (litro)", cantidad: 3, precio: 150 }, { inventarioId: null, nombre: "Revisión rápida", cantidad: 1, precio: 100 }], clienteId: cli[0], clienteNombre: "Ñoño Pérez Álvarez", metodoPago: "efectivo", efectivoRecibido: 600 });
    await registrarVentaRapida({ items: [{ inventarioId: inv1, nombre: "Cadena 428", cantidad: 1, precio: 520 }], metodoPago: "tarjeta" });
    await registrarVentaRapida({ items: [{ inventarioId: invBorrar, nombre: "Espejo retrovisor", cantidad: 2, precio: 180 }], clienteId: cli[1], clienteNombre: "Ana María Ruíz", metodoPago: "transferencia" });
    await DB.delete("inventario", invBorrar);               // 3.13 permite borrar el repuesto aunque ya se haya vendido

    // créditos: sin entrada, con entrada, abono parcial y pago completo
    const c1 = await cobrarAlCredito({ clienteId: cli[2], clienteNombre: "José «Chepe» Díaz", clienteTelefono: "", items: [{ inventarioId: invAlto, nombre: "Aceite 2T (litro)", cantidad: 2, precio: 150 }], abono: 0 });
    const c2 = await cobrarAlCredito({ clienteId: cli[1], clienteNombre: "Ana María Ruíz", clienteTelefono: "9900-0002", items: [{ inventarioId: null, nombre: "Pintura de tanque", cantidad: 1, precio: 1200 }], abono: 200, abonoMetodo: "efectivo" });
    await registrarAbonoCredito(c2.id, 300, "transferencia");
    const c3 = await cobrarAlCredito({ clienteId: cli[0], clienteNombre: "Ñoño Pérez Álvarez", clienteTelefono: "9900-0001", items: [{ inventarioId: null, nombre: "Soldadura de parrilla", cantidad: 1, precio: 400 }], abono: 0 });
    await registrarAbonoCredito(c3.id, 400, "efectivo");   // queda pagado

    // órdenes: una por cada etapa, una cobrada de contado y una cobrada a crédito (con ítems e histórico de costo)
    const mk = async (o) => DB.save("ordenes", { fotos: [], aprobacion: null, diagnostico: null, reparacionNotas: "", calidadChecklist: null, citaId: null, citaFechaISO: null, creadoEn: hace(5).getTime(), origenTrabajo: "taller", ...o });
    for (const [estado, mec] of [["recibido", "Mec Uno"], ["diagnostico", "Juan Legado"], ["reparacion", "Juan Legado"], ["calidad", ""]]) {
      await mk({ clienteId: cli[0], motoId: moto1, estado, falla: "Ruido en " + estado, mecanico: mec, items: [{ nombre: "Mano de obra", cantidad: 1, precio: 250, origenInventarioId: null, costoUnitario: 0, costoEstimado: false }],
        fotos: estado === "reparacion" ? ["data:image/jpeg;base64,/9j/4AAQSkZJRg=="] : [] });
    }
    const oCont = await mk({ clienteId: cli[1], motoId: moto2, estado: "entregado", falla: "Cambio de aceite", mecanico: "Mec Uno", tipoCobro: "contado", metodoPago: "efectivo",
      items: [{ nombre: "Aceite 2T (litro)", cantidad: 1, precio: 150, origenInventarioId: invAlto, costoUnitario: 95, costoEstimado: false }, { nombre: "Mano de obra", cantidad: 1, precio: 200, origenInventarioId: null, costoUnitario: 0, costoEstimado: false }] });
    await registrarIngresoTaller(await DB.get("ordenes", oCont), 350, "efectivo");
    await updateOrder(oCont, (x) => { x.finalizada = true; x.finalizadoEn = hace(1).getTime(); x.entregadoEn = hace(1).getTime(); x.margen = 255; });
    const oCred = await mk({ clienteId: cli[2], motoId: null, estado: "entregado", falla: "Frenos", mecanico: "Juan Legado", tipoCobro: "credito", origenTrabajo: "negocio",
      items: [{ nombre: "Pastillas", cantidad: 2, precio: 160, origenInventarioId: null, costoUnitario: 90, costoEstimado: true }] });
    const cr = await cobrarAlCredito({ clienteId: cli[2], clienteNombre: "José «Chepe» Díaz", clienteTelefono: "", items: [{ inventarioId: null, nombre: "Pastillas", cantidad: 2, precio: 160 }], abono: 100, abonoMetodo: "efectivo", origen: "orden", ordenId: oCred });
    await updateOrder(oCred, (x) => { x.finalizada = true; x.finalizadoEn = hace(0).getTime(); x.creditoId = cr.id; x.abonoInicial = 100; x.abonoMetodo = "efectivo"; });

    // cotizaciones (pendiente, aceptada → orden, rechazada) y citas (pendiente, atendida → orden, reprogramada)
    const fecha = hace(0).toISOString();
    await DB.save("cotizaciones", { clienteId: cli[0], clienteNombre: "Ñoño Pérez Álvarez", clienteTelefono: "9900-0001", motoId: moto1, moto: { marca: "Honda", modelo: "XR150", placa: "SIN-0001" }, motoDesc: "Honda XR150",
      diagnostico: "Kit de arrastre", notas: "", items: [{ nombre: "Kit de arrastre", cantidad: 1, precio: 1450, inventarioId: null }], validezDias: 15, fechaISO: fecha, venceISO: new Date(Date.now() + 15 * 86400000).toISOString(), estado: "pendiente", ordenId: null, creadoPor: "Admin Sintético" });
    await DB.save("cotizaciones", { clienteId: cli[1], clienteNombre: "Ana María Ruíz", clienteTelefono: "9900-0002", motoId: moto2, moto: null, motoDesc: "Yamaha FZ",
      diagnostico: "Cambio de aceite", notas: "aceptó por WhatsApp", items: [{ nombre: "Aceite", cantidad: 1, precio: 150, inventarioId: invAlto }], validezDias: 10, fechaISO: fecha, venceISO: new Date(Date.now() + 10 * 86400000).toISOString(), estado: "aceptada", ordenId: oCont, aceptadaEn: Date.now(), creadoPor: "Admin Sintético" });
    await DB.save("cotizaciones", { clienteId: null, clienteNombre: "Walk-in", clienteTelefono: "", motoId: null, moto: null, motoDesc: "", diagnostico: "Pintura", notas: "", items: [], validezDias: 7, fechaISO: fecha, venceISO: new Date(Date.now() - 86400000).toISOString(), estado: "rechazada", ordenId: null, creadoPor: "Admin Sintético" });
    const hoy = new Date().toISOString().slice(0, 10);
    await DB.save("citas", { clienteId: cli[3], nombreTmp: "", telefonoTmp: "", fecha: hoy, hora: "09:00", mecanico: "Mec Uno", mecanicoId: null, motivo: "Revisión", origen: "taller", estado: undefined, reprogramaciones: [], recordatorioEnviado: false });
    await DB.save("citas", { clienteId: cli[1], nombreTmp: "", telefonoTmp: "", fecha: hoy, hora: "10:30", mecanico: "Juan Legado", mecanicoId: null, motivo: "Aceite", origen: "web", estado: "atendida", ordenId: oCont, cerradaEn: Date.now(),
      reprogramaciones: [{ de: { fecha: hoy, hora: "08:00", mecanico: "Mec Uno" }, a: { fecha: hoy, hora: "10:30", mecanico: "Juan Legado" }, motivo: "cliente llegó tarde", fechaISO: fecha }], recordatorioEnviado: true, confirmada: true });
    await DB.save("citas", { clienteId: null, nombreTmp: "Persona de la web", telefonoTmp: "9900-0099", fecha: hoy, hora: "15:00", mecanico: "", mecanicoId: null, motivo: "Cotizar", origen: "web", estado: "ausente", cerradaEn: Date.now(), reprogramaciones: [], recordatorioEnviado: false });

    // caja manual
    await DB.save("caja_movimientos", { tipo: "ingreso", categoria: "Otro ingreso", monto: 75.5, metodoPago: "efectivo", descripcion: "Venta de chatarra", fechaISO: fecha, creadoEn: Date.now() });
    await DB.save("caja_movimientos", { tipo: "egreso", categoria: "Pago de servicios", monto: 1234.56, metodoPago: "transferencia", descripcion: "Luz del local", fechaISO: fecha, creadoEn: Date.now() });

    const respaldo = await armarRespaldo();
    const verif = await verificarRespaldo(respaldo);
    // segundo archivo: un teléfono que arrancó con «Ver un ejemplo» (seedIfEmpty de la propia 3.13) → el importador lo rechaza
    for (const s of ALL_STORES) await DB.clear(s);
    localStorage.setItem("enti_modo_datos", "demo");
    await seedIfEmpty();
    const demo = await armarRespaldo();
    const verifDemo = await verificarRespaldo(demo);
    return { ok: verif.ok && verifDemo.ok, problemas: verif.problemas.concat(verifDemo.problemas), texto: verif.texto, textoDemo: verifDemo.texto,
      conteos: respaldo.conteos, versionApp: respaldo.versionApp, esquema: respaldo.esquemaDB };
  }, null, { plazoMs: 120000 });
  if (!r.ok) throw new Error("3.13 no verificó su propio respaldo: " + r.problemas.join("; "));
  for (const [txt, archivo] of [[r.texto, SALIDA], [r.textoDemo, SALIDA_DEMO]]) {
    const obj = JSON.parse(txt);
    obj.dispositivo = "generador-sintetico";                   // sin user-agent de la máquina
    obj.exportadoPor = "Admin Sintético";
    fs.writeFileSync(archivo, JSON.stringify(obj, null, 1) + "\n");
  }
  console.log(`respaldo 3.13 (${r.versionApp}, esquema ${r.esquema}) → ${path.relative(RAIZ, SALIDA)}`, JSON.stringify(r.conteos));
} finally {
  await d.cerrar();
  fs.rmSync(tmp, { recursive: true, force: true });
}
