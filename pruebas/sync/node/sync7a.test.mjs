// SYNC-7A · piezas PURAS/MOCKEABLES sin navegador ni Docker: el mapper "inventario" de taller-demo/sync-mappers.js
// (SOLO el maestro: cantidad nunca viaja por aquí, ver la cabecera de ese archivo) y ENTIMOTORS_SYNC_ORDEN.
// Lo que necesita Postgres+PostgREST reales (registrar_stock_inicial, RLS de D-4, ledger, bootstrap, paginación)
// vive en pruebas/sync/browser/sync7a-core.test.mjs — este archivo NO lo sustituye, solo cubre lo que no
// requiere Docker. Mismo patrón que pruebas/sync/node/sync6.test.mjs (mapper "ordenes").
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leer = (f) => fs.readFileSync(path.join(RAIZ, "taller-demo", f), "utf8");
const J = (x) => JSON.parse(JSON.stringify(x));
function cargar(archivos, extra = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Math, Date, ...extra });
  for (const f of archivos) vm.runInContext(leer(f), ctx, { filename: f });
  return ctx;
}

describe("SYNC-7A · sync-mappers.js — mapper \"inventario\" (solo el maestro, nunca la cantidad)", () => {
  const ctx = cargar(["sync-mappers.js"]);
  const inv = ctx.ENTIMOTORS_SYNC_MAPPERS.inventario;
  const cat = ctx.ENTIMOTORS_SYNC_MAPPERS.categorias_inv;

  test("payload maestro nunca contiene cantidad: ni en columnas, ni en aCloud() aunque el objeto local la traiga", () => {
    assert.ok(!inv.columnas.includes("cantidad"), "columnas no debe listar cantidad (columnasNube() la enviaría si estuviera)");
    const local = { nombre: "Filtro de aire", modelo: "CB190R", cantidad: 999, precio: 250, precioVenta: 250, costoCompra: 150, stockMinimo: 3, codigoBarras: "X1", publicarEnWeb: false, foto: null };
    const nube = inv.aCloud(local);
    assert.ok(!("cantidad" in nube), "aCloud() no debe incluir cantidad aunque local.cantidad exista");
    assert.equal(nube.nombre, "Filtro de aire");
    assert.equal(nube.precio_venta, 250);
  });

  // SYNC-7B cambió este contrato A PROPÓSITO (pendiente nº 3 de SYNC-7A en el STATE): con las ventas/créditos/órdenes
  // del Taller ya por RPC al ledger, la cantidad de la nube es la única verdad y aLocal() la BAJA. Sigue sin SUBIR
  // nunca (prueba de arriba: ni columnas ni aCloud()).
  test("aLocal() trae la cantidad y requiere_revision de la nube (SYNC-7B: la nube es la autoridad del stock)", () => {
    const fila = {
      id: "inv-1", nombre: "Aceite 20W-50", modelo: "Todos", cantidad: 30, requiere_revision: false,
      costo_compra: 110, precio_venta: 180, stock_minimo: 8, codigo_barras: "750100000029", publicar_en_web: true,
      foto_url: null, categoria_id: "cat-uid-1", updated_at: "2026-09-22T10:00:00Z", rev: 1, deleted_at: null,
    };
    const l = inv.aLocal(fila);
    assert.equal(l.cantidad, 30, "la cantidad materializada del ledger baja tal cual");
    assert.equal(l.requiereRevision, false);
    assert.equal(l.nombre, "Aceite 20W-50");
    assert.equal(l.costoCompra, 110);
    assert.equal(l.precio, 180);
    assert.equal(l.precioVenta, 180);
    assert.equal(l.stockMinimo, 8);
    assert.equal(l.publicarEnWeb, true);
  });

  test("categoriaId es una fk hacia categorias_inv (mismo mapa local↔uid que ya usa esa entidad desde SYNC-5)", () => {
    assert.equal(inv.fks.length, 1);
    assert.deepEqual(J(inv.fks[0]), { local: "categoriaId", cloud: "categoria_id", entidad: "categorias_inv" });
  });

  test("foto: una imagen local en base64 nunca sale; una ruta/URL ya subida sí viaja como foto_url (mismo criterio que motos.foto)", () => {
    assert.equal(inv.aCloud({ nombre: "x", foto: "data:image/png;base64,AAAA" }).foto_url, null, "base64 nunca sale");
    assert.equal(inv.aCloud({ nombre: "x", foto: "ordenes/x/foto.jpg" }).foto_url, "ordenes/x/foto.jpg", "una ruta ya subida sí viaja");
    assert.equal(inv.aCloud({ nombre: "x" }).foto_url, null, "sin foto: null, no undefined (columnasNube lo necesita explícito)");
  });

  test("puedeEscribir (D-4): solo admin edita inventario y categorias_inv en modo nube; cajero y mecánico no", () => {
    for (const m of [inv, cat]) {
      assert.equal(typeof m.puedeEscribir, "function", "el mapper debe declarar la regla (ver app.js, puedeEscribirEntidadNube)");
      assert.equal(m.puedeEscribir("admin"), true);
      assert.equal(m.puedeEscribir("cajero"), false);
      assert.equal(m.puedeEscribir("mecanico"), false);
      assert.equal(m.puedeEscribir(undefined), false);
    }
  });

  test('"inventario" está en ENTIMOTORS_SYNC_ORDEN, después de "categorias_inv" (de la que depende por fk)', () => {
    assert.ok(ctx.ENTIMOTORS_SYNC_ORDEN.includes("inventario"), "sin esto, pullTodo() nunca bajaría el inventario (bootstrap roto)");
    assert.ok(ctx.ENTIMOTORS_SYNC_ORDEN.indexOf("categorias_inv") < ctx.ENTIMOTORS_SYNC_ORDEN.indexOf("inventario"));
  });

  test("cantidad nunca es una columna de tiempo ni una fk (defensa extra: ninguna ruta la reintroduce por accidente)", () => {
    assert.ok(!inv.tiempos.includes("cantidad"));
    assert.ok(!inv.fks.some((f) => f.cloud === "cantidad" || f.local === "cantidad"));
  });
});
