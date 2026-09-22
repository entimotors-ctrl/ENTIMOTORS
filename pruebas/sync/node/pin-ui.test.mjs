// SYNC-7 · pin-ui.js (taller-demo): la parte PURA (PinUI.crear) sin DOM — el modal real
// (pedirPinConModal) no se prueba aquí a propósito, solo se ejercita en navegador.
// Cubre: sección 23 del prompt de fase — "PIN UI sin persistencia" y "acción PIN offline denegada".
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const leer = (f) => fs.readFileSync(path.join(RAIZ, "taller-demo", f), "utf8");
function cargar() {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, AbortController, Date, Promise, JSON, Math });
  vm.runInContext(leer("pin-ui.js"), ctx, { filename: "pin-ui.js" });
  return ctx;
}
const ctx = cargar();
const PinUI = ctx.PinUI;

/** fetch falso: responde según una lista de {status, cuerpo} en orden; registra cada llamada. */
function fetchFalso(respuestas) {
  const llamadas = [];
  let i = 0;
  const f = async (url, opciones) => {
    llamadas.push({ url, opciones, cuerpo: opciones && opciones.body ? JSON.parse(opciones.body) : null });
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i++;
    return {
      status: r.status,
      text: async () => JSON.stringify(r.cuerpo === undefined ? {} : r.cuerpo),
    };
  };
  f.llamadas = llamadas;
  return f;
}

function base(o) {
  return Object.assign({
    baseApi: () => "https://api.example.test",
    obtenerToken: () => "token-de-sesion",
    enLinea: () => true,
  }, o);
}

test("admin nunca llama al servidor: se resuelve localmente, sin fetch ni pedirPin", async () => {
  let pedirPinLlamado = false;
  const pin = PinUI.crear(base({ fetch: fetchFalso([{ status: 201, cuerpo: { autorizacion_id: "x" } }]), pedirPin: async () => { pedirPinLlamado = true; return "123456"; } }));
  const r = await pin.pedirAutorizacion({ rol: "admin", accion: "reversar_venta", registroId: "11111111-1111-1111-1111-111111111111" });
  assert.equal(r.ok, true);
  assert.equal(r.admin, true);
  assert.equal(r.autorizacion_id, null);
  assert.equal(pedirPinLlamado, false, "el admin no necesita PIN: nunca se le pide");
});

test("mecánico (o cualquier rol que no sea cajero/admin) se rechaza localmente, sin red", async () => {
  const f = fetchFalso([{ status: 201, cuerpo: {} }]);
  const pin = PinUI.crear(base({ fetch: f, pedirPin: async () => "123456" }));
  const r = await pin.pedirAutorizacion({ rol: "mecanico", accion: "ajustar_stock", registroId: "id" });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "sin-permiso");
  assert.equal(f.llamadas.length, 0, "no debe haber ninguna llamada de red para un rol sin permiso");
});

test("acción PIN offline: se deniega ANTES de pedir el PIN y sin ninguna llamada de red (sección 15)", async () => {
  let pedirPinLlamado = false;
  const f = fetchFalso([{ status: 201, cuerpo: {} }]);
  const pin = PinUI.crear(base({ fetch: f, enLinea: () => false, pedirPin: async () => { pedirPinLlamado = true; return "123456"; } }));
  const r = await pin.pedirAutorizacion({ rol: "cajero", accion: "reversar_caja", registroId: "id" });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "sin-conexion");
  assert.match(r.mensaje, /requiere conexión/);
  assert.equal(pedirPinLlamado, false, "sin conexión no se debe ni mostrar el modal de PIN");
  assert.equal(f.llamadas.length, 0);
});

test("cancelar el modal (pedirPin resuelve null) no llama al servidor", async () => {
  const f = fetchFalso([{ status: 201, cuerpo: {} }]);
  const pin = PinUI.crear(base({ fetch: f, pedirPin: async () => null }));
  const r = await pin.pedirAutorizacion({ rol: "cajero", accion: "reversar_credito", registroId: "id" });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "cancelado");
  assert.equal(f.llamadas.length, 0);
});

test("un PIN con formato inválido devuelto por pedirPin se rechaza sin llamar al servidor", async () => {
  const f = fetchFalso([{ status: 201, cuerpo: {} }]);
  const pin = PinUI.crear(base({ fetch: f, pedirPin: async () => "12" }));
  const r = await pin.pedirAutorizacion({ rol: "cajero", accion: "reversar_abono", registroId: "id" });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "pin-invalido");
  assert.equal(f.llamadas.length, 0);
});

test("acción desconocida se rechaza localmente (no está en ACCIONES_CON_PIN)", async () => {
  const f = fetchFalso([{ status: 201, cuerpo: {} }]);
  const pin = PinUI.crear(base({ fetch: f, pedirPin: async () => "123456" }));
  const r = await pin.pedirAutorizacion({ rol: "cajero", accion: "borrar_todo", registroId: "id" });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "accion-desconocida");
  assert.equal(f.llamadas.length, 0);
});

test("éxito (201): arma el cuerpo correcto, redondea el monto a 2 decimales y devuelve autorizacion_id+expira_en", async () => {
  const f = fetchFalso([{ status: 201, cuerpo: { autorizacion_id: "auth-1", expira_en: "2026-09-21T23:00:00Z" } }]);
  const pin = PinUI.crear(base({ fetch: f, pedirPin: async () => "654321" }));
  const r = await pin.pedirAutorizacion({ rol: "cajero", accion: "reversar_venta", registroId: "venta-1", monto: 123.4567, deviceId: "dev-1" });
  assert.equal(r.ok, true);
  assert.equal(r.autorizacion_id, "auth-1");
  assert.equal(r.expira_en, "2026-09-21T23:00:00Z");
  assert.equal(f.llamadas.length, 1);
  const c = f.llamadas[0];
  assert.equal(c.url, "https://api.example.test/api/autorizaciones");
  assert.equal(c.opciones.headers.Authorization, "Bearer token-de-sesion");
  assert.deepEqual(c.cuerpo, { accion: "reversar_venta", entidad: "ventas", registro_id: "venta-1", device_id: "dev-1", pin: "654321", monto: 123.46 });
});

test("PIN nunca sobrevive en el resultado ni en el cuerpo enviado más allá del campo `pin`", async () => {
  const f = fetchFalso([{ status: 401, cuerpo: { error: "x", codigo: "PIN_INCORRECTO", intentos_restantes: 3 } }]);
  const pin = PinUI.crear(base({ fetch: f, pedirPin: async () => "111111" }));
  const r = await pin.pedirAutorizacion({ rol: "cajero", accion: "reversar_venta", registroId: "v1" });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "PIN_INCORRECTO");
  assert.match(r.mensaje, /Intentos restantes: 3/);
  // el objeto de resultado que ve el resto de la app no contiene el PIN en ningún campo
  assert.equal(JSON.stringify(r).toLowerCase().includes("111111"), false);
});

test("clasificación de códigos de error del servidor (SIN_PIN, CUENTA_INACTIVA, BLOQUEADO_ADMIN, BLOQUEADO_*, PIN_CAMBIADO)", async () => {
  const casos = [
    [{ status: 409, cuerpo: { codigo: "SIN_PIN" } }, "SIN_PIN", /todavía no configuró/],
    [{ status: 403, cuerpo: { codigo: "CUENTA_INACTIVA" } }, "CUENTA_INACTIVA", /no está activa/],
    [{ status: 423, cuerpo: { codigo: "BLOQUEADO_ADMIN" } }, "BLOQUEADO_ADMIN", /debe desbloquearlas/],
    [{ status: 429, cuerpo: { codigo: "BLOQUEADO_SOLICITANTE", reintentar_en_s: 900 } }, "BLOQUEADO_SOLICITANTE", /15 minutos/],
    [{ status: 429, cuerpo: { codigo: "BLOQUEADO_GLOBAL", reintentar_en_s: 60 } }, "BLOQUEADO_GLOBAL", /1 minuto\./],
    [{ status: 409, cuerpo: { codigo: "PIN_CAMBIADO" } }, "PIN_CAMBIADO", /cambió mientras/],
  ];
  for (const [resp, motivoEsperado, msgRe] of casos) {
    const f = fetchFalso([resp]);
    const pin = PinUI.crear(base({ fetch: f, pedirPin: async () => "123456" }));
    const r = await pin.pedirAutorizacion({ rol: "cajero", accion: "reversar_venta", registroId: "v1" });
    assert.equal(r.ok, false, motivoEsperado);
    assert.equal(r.motivo, motivoEsperado);
    assert.match(r.mensaje, msgRe, motivoEsperado);
  }
});

test("sin apiUrl configurado: se rechaza local, sin llamar pedirPin ni fetch", async () => {
  const f = fetchFalso([{ status: 201, cuerpo: {} }]);
  let pedirPinLlamado = false;
  const pin = PinUI.crear(base({ fetch: f, baseApi: () => "", pedirPin: async () => { pedirPinLlamado = true; return "123456"; } }));
  const r = await pin.pedirAutorizacion({ rol: "cajero", accion: "reversar_venta", registroId: "v1" });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "sin-servidor");
  assert.equal(pedirPinLlamado, false);
  assert.equal(f.llamadas.length, 0);
});

test("sin token de sesión: se rechaza local, sin llamar pedirPin ni fetch", async () => {
  const f = fetchFalso([{ status: 201, cuerpo: {} }]);
  const pin = PinUI.crear(base({ fetch: f, obtenerToken: () => null, pedirPin: async () => "123456" }));
  const r = await pin.pedirAutorizacion({ rol: "cajero", accion: "reversar_venta", registroId: "v1" });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "sin-sesion");
  assert.equal(f.llamadas.length, 0);
});

test("una respuesta de red rota (fetch lanza) se traduce a sin-conexion, no revienta la promesa", async () => {
  const pin = PinUI.crear(base({ fetch: async () => { throw new Error("network down"); }, pedirPin: async () => "123456" }));
  const r = await pin.pedirAutorizacion({ rol: "cajero", accion: "reversar_venta", registroId: "v1" });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "sin-conexion");
});

test("mensajeParaCodigo es pura y cubre el catálogo completo de códigos del backend", () => {
  const codigos = ["PIN_INCORRECTO", "SIN_PIN", "CUENTA_INACTIVA", "BLOQUEADO_ADMIN", "BLOQUEADO_GLOBAL", "BLOQUEADO_SOLICITANTE",
    "PIN_CAMBIADO", "PIN_INVALIDO", "ACCION_DESCONOCIDA", "ENTIDAD_INVALIDA", "NO_PERMITIDO", "ADMIN_NO_NECESITA_PIN",
    "SIN_SESION", "PIN_NO_CONFIGURADO_EN_SERVIDOR", "ALGO_NO_CATALOGADO"];
  for (const c of codigos) assert.equal(typeof PinUI.mensajeParaCodigo(c, { reintentar_en_s: 60 }), "string");
});

test("ACCIONES_CON_PIN coincide exactamente con el catálogo del backend (api-server/src/lib/pin.ts)", () => {
  assert.deepEqual(Object.keys(PinUI.ACCIONES_CON_PIN).sort(), [
    "ajustar_stock", "anular_orden", "registrar_devolucion", "reversar_abono", "reversar_caja", "reversar_credito", "reversar_venta",
  ]);
  assert.equal(PinUI.ACCIONES_CON_PIN.reversar_venta, "ventas");
  assert.equal(PinUI.ACCIONES_CON_PIN.ajustar_stock, "inventario");
  assert.equal(PinUI.ACCIONES_CON_PIN.anular_orden, "ordenes");
});
