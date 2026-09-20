// OBS-10 (4E-C7-FIX-A) — «Buscar actualización ahora» (Ajustes). ANTES: desregistraba TODOS los Service Workers, borraba TODAS las cachés y recargaba
// (instalaba la versión publicada sin ofrecer la copia de seguridad, pasaba por encima del «Ahora no» y, SIN RED, dejaba el equipo sin caché:
// el navegador mostraba su página de error). AHORA solo COMPRUEBA: si hay versión nueva abre el MISMO aviso (copia y actualizar / solo copia /
// ahora no); quien activa el worker sigue siendo únicamente «Crear copia y actualizar» (mensaje «activar-ya»).
//
// Se ejecuta el app.js REAL con un Service Worker FALSO y controlable (registro, waiting, installing, update, unregister, postMessage) y espías en
// unregister / getRegistrations / caches.delete / postMessage / location. El comportamiento del navegador REAL (Chrome, Firefox) lo cubren los casos
// OBS-10 de la suite de navegador y la prueba con el SW real del entorno PWA.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { leer } from "./helpers/entorno.mjs";
import { nuevoEntorno, toasts } from "./helpers/flujos.mjs";

const APP = leer("app.js");
const YA_AL_DIA = "Ya tienes la última versión";
const MSG = {
  sinRed: "Sin conexión: ahora no se puede buscar actualizaciones. La app sigue funcionando igual.",
  sinSoporte: "Este navegador no permite buscar actualizaciones automáticas.",
  buscando: "Buscando la última versión…",
  fallo: "No se pudo comprobar ahora. Revisa tu conexión e inténtalo de nuevo.",
  tarda: "La comprobación está tardando más de lo normal. Inténtalo de nuevo en un momento.",
  instalacionFalla: "No se pudo preparar la versión nueva. Inténtalo otra vez con conexión.",
  sinSwListo: "Instalación preparada en este dispositivo.",
  sinSwFalla: "No se pudo preparar la instalación en este dispositivo.",
  ahoraNo: "De acuerdo — puedes actualizar cuando quieras desde Ajustes",
};

// ── Service Worker falso y espías ──
function montar({ mutar, online = true, sw = "con-registro", registro = {}, controller = true } = {}) {
  const env = nuevoEntorno({ sesionGuardada: null, ...(mutar ? { mutar } : {}) });
  const t = { unregister: 0, getRegistrations: 0, getRegistration: 0, register: [], update: 0, postMessage: [], cachesKeys: 0, cachesDelete: [], orden: [] };
  const worker = (estado) => {
    const oy = new Set();
    const w = { state: estado, addEventListener: (tipo, fn) => { if (tipo === "statechange") oy.add(fn); }, removeEventListener: (tipo, fn) => { oy.delete(fn); },
      postMessage: (m) => { t.postMessage.push(m); t.orden.push(`postMessage:${m && m.tipo}`); }, oyentes: () => oy.size,
      /** Cambia de estado como lo hace el navegador y avisa a los oyentes de «statechange». */
      _a(nuevo) { w.state = nuevo; [...oy].forEach((f) => f({ type: "statechange" })); } };
    return w;
  };
  const reg = { active: worker("activated"), waiting: null, installing: null, ...registro,
    update: async () => { t.update++; if (reg._alActualizar) await reg._alActualizar(reg); return reg; },
    unregister: async () => { t.unregister++; return true; } };
  if (sw !== "sin-soporte") {
    env.win.navigator.serviceWorker = {
      controller: controller ? { state: "activated" } : null,
      getRegistration: async () => { t.getRegistration++; return sw === "sin-registro" ? undefined : reg; },
      getRegistrations: async () => { t.getRegistrations++; return sw === "sin-registro" ? [] : [reg]; },
      register: async (url, opc) => { t.register.push([url, opc]); if (reg._registrarFalla) throw new Error("SecurityError"); return reg; },
      addEventListener() {}, removeEventListener() {},
    };
  } else delete env.win.navigator.serviceWorker;
  env.win.caches = { keys: async () => { t.cachesKeys++; return ["entimotors-v3.13.0"]; }, delete: async (k) => { t.cachesDelete.push(k); return true; } };
  env.setOnline(online);
  env.t = t; env.reg = reg; env.worker = worker;
  env.boton = () => env.doc.getElementById("btnForzarActualizacion");
  env.modal = () => env.doc.getElementById("modalVersionNueva").classList.contains("active");
  env.pulsar = async () => { const p = env.boton().disparar("click"); await env.asentar(); return p; };
  env.sinDestruir = () => {
    assert.equal(t.unregister, 0, "NO debe desregistrar el Service Worker"); assert.equal(t.getRegistrations, 0, "NO debe recorrer los registros para desregistrarlos");
    assert.deepEqual(t.cachesDelete, [], "NO debe borrar cachés"); assert.equal(t.cachesKeys, 0, "NO debe ni tocar CacheStorage");
    assert.deepEqual(env.navegaciones, [], "NO debe recargar ni navegar");
    assert.deepEqual(t.postMessage, [], "el botón NUNCA activa el worker (nada de «activar-ya»)");
  };
  return env;
}
const textos = (env) => toasts(env);
/** Deja pasar el tiempo (cada toast() se retira a los 3,4 s) y exige que NO quede ningun temporizador propio del handler colgado (el de 20 s). */
async function sinTimersColgados(env) { await env.avanzar(4000); assert.equal(env.timersPendientes(), 0, "timers colgados"); }
/** Los objetos creados DENTRO del vm tienen otro prototipo: se comparan por su forma JSON. */
const json = (x) => JSON.stringify(x);

// ── el código del handler, sin comentarios (para afirmar lo que NO contiene) ──
function sinComentarios(js) {
  let salida = "", bloque = false, cadena = null;
  for (let i = 0; i < js.length; i++) {
    const c = js[i], d = js[i + 1];
    if (bloque) { if (c === "*" && d === "/") { bloque = false; i++; } continue; }
    if (cadena) { salida += c; if (c === "\\") { salida += d ?? ""; i++; } else if (c === cadena) cadena = null; continue; }
    if (c === "/" && d === "*") { bloque = true; i++; continue; }
    if (c === "/" && d === "/") { while (i < js.length && js[i] !== "\n") i++; salida += "\n"; continue; }
    if (c === '"' || c === "'" || c === "`") cadena = c;
    salida += c;
  }
  return salida;
}
const INICIO = "/* ---- Buscar actualización ahora ----", FIN = 'alHacerClicUnaVez(document.getElementById("btnForzarActualizacion"), buscarActualizacion);';
const handlerDe = (fuente) => { const a = fuente.indexOf(INICIO), b = fuente.indexOf(FIN); assert.ok(a >= 0 && b > a, "no se encontró el bloque del handler"); return sinComentarios(fuente.slice(a, b + FIN.length)); };
const PROHIBIDO = [/unregister\s*\(/, /getRegistrations/, /\bcaches\b/, /location\s*[.=]/, /\.reload\s*\(/, /postMessage/, /skipWaiting/, /activar-ya/, /\?_=/, /waiting\s*=/];
/** Devuelve lo que el handler NO debería contener y si contiene. */
const destructivoEn = (fuente) => PROHIBIDO.filter((rx) => rx.test(handlerDe(fuente))).map(String);

// ═════════════════════════════ ESTÁTICO ═════════════════════════════
describe("OBS-10 · el handler nuevo NO puede destruir nada (afirmado sobre el código real)", () => {
  test("NO desregistra (unregister / getRegistrations), NO toca cachés, NO recarga, NO navega, NO manda mensajes al worker", () => {
    assert.deepEqual(destructivoEn(APP), []);
  });
  test("en TODO app.js ya no existe ningún unregister(), ningún caches.delete() ni el «?_=» del handler viejo", () => {
    const codigo = sinComentarios(APP);
    assert.ok(!/unregister\s*\(/.test(codigo), "queda un unregister()"); assert.ok(!/caches\.delete\s*\(/.test(codigo), "queda un caches.delete()");
    assert.ok(!/\?_=/.test(codigo), "queda el «?_=» del handler viejo"); assert.ok(!/getRegistrations\s*\(/.test(codigo), "queda un getRegistrations()");
  });
  test("«activar-ya» se envía en UN solo lugar y es el handler de «Crear copia y actualizar» (btnCopiaYActualizar)", () => {
    const codigo = sinComentarios(APP);
    assert.equal((codigo.match(/tipo:\s*"activar-ya"/g) || []).length, 1, "«activar-ya» debe enviarse una sola vez");
    const i = codigo.indexOf('tipo: "activar-ya"'), inicioBtn = codigo.indexOf('alHacerClicUnaVez(document.getElementById("btnCopiaYActualizar")');
    const finBtn = codigo.indexOf("\n});", inicioBtn);
    assert.ok(inicioBtn > 0 && i > inicioBtn && i < finBtn, "«activar-ya» no está dentro del handler de btnCopiaYActualizar");
  });
  test("el botón sigue cableado a buscarActualizacion con alHacerClicUnaVez (no se puede pulsar dos veces a la vez)", () => assert.ok(APP.includes(FIN)));
  test("el flujo automático sigue: updatefound → statechange «installed» + controller → abrirAvisoVersionNueva()", () => {
    assert.match(APP, /reg\.addEventListener\("updatefound"/); assert.match(APP, /nuevo\.state === "installed" && navigator\.serviceWorker\.controller/); assert.match(APP, /abrirAvisoVersionNueva\(\);/);
    assert.match(APP, /navigator\.serviceWorker\.register\("\.\/sw\.js", \{ updateViaCache: "none" \}\)/, "el registro del arranque no cambia");
  });
  test("sw.js sigue SIN skipWaiting automático (solo se llama al recibir «activar-ya»)", () => {
    const sw = sinComentarios(leer("sw.js"));
    assert.equal((sw.match(/skipWaiting\s*\(/g) || []).length, 1); assert.match(sw, /event\.data\?\.tipo === "activar-ya"\) \{ self\.skipWaiting\(\); return; \}/);
  });
  test("la versión NO cambió: VERSION_APP 3.13.0", () => assert.match(APP, /const VERSION_APP = "3\.13\.0";/));
});

// ═════════════════════════════ COMPORTAMIENTO ═════════════════════════════
describe("OBS-10 · ACTIVE y sin versión nueva", () => {
  test("«Ya tienes la última versión»; se llamó a update() UNA vez; sin modal; sin destruir; sin timers colgados; botón liberado", async () => {
    const env = montar(); await env.pulsar();
    assert.equal(env.t.update, 1); assert.deepEqual(textos(env), [MSG.buscando, YA_AL_DIA]); assert.equal(env.modal(), false);
    await sinTimersColgados(env); env.sinDestruir(); assert.notEqual(env.boton().disabled, true, "el botón debe quedar libre");
  });
  test("el botón se bloquea mientras comprueba (no se lanzan dos comprobaciones a la vez)", async () => {
    const env = montar(); let soltar; env.reg._alActualizar = () => new Promise((r) => { soltar = r; });
    const p = env.boton().disparar("click"); await env.asentar(); assert.equal(env.boton().disabled, true);
    await env.boton().disparar("click"); assert.equal(env.t.update, 1, "el segundo clic se ignora");
    soltar(); await p; assert.equal(env.boton().disabled, false);
  });
  test("update() que falla (red/servidor): aviso seguro, sin modal, sin destruir", async () => {
    const env = montar(); env.reg._alActualizar = async () => { throw new TypeError("Failed to update a ServiceWorker: network error"); };
    await env.pulsar(); assert.deepEqual(textos(env), [MSG.buscando, MSG.fallo]); assert.equal(env.modal(), false); await sinTimersColgados(env); env.sinDestruir();
  });
  test("update() que no responde: a los 20 s avisa de que tarda; sin modal; sin destruir", async () => {
    const env = montar(); env.reg._alActualizar = () => new Promise(() => {});
    const p = env.boton().disparar("click"); await env.asentar(); assert.deepEqual(textos(env), [MSG.buscando]);
    await env.avanzar(19999); assert.deepEqual(textos(env), [MSG.buscando], "aún no"); await env.avanzar(2); await p;
    assert.deepEqual(textos(env), [MSG.buscando, MSG.tarda]); assert.equal(env.modal(), false); env.sinDestruir();
  });
});

describe("OBS-10 · WAITING (ya hay una versión esperando, p. ej. tras «Ahora no» y una recarga)", () => {
  test("abre el MISMO modal, sin llamar a update(), sin activar el worker y sin destruir", async () => {
    const env = montar(); env.reg.waiting = env.worker("installed");
    await env.pulsar();
    assert.equal(env.modal(), true); assert.equal(env.t.update, 0, "no hace falta buscar: ya está esperando");
    assert.match(env.doc.getElementById("versionNuevaDetalle").textContent, /Hay una versión nueva de ENTIMOTORS OS lista para instalarse/);
    assert.equal(env.doc.getElementById("versionNuevaEstado").style.display, "none");
    env.sinDestruir(); assert.equal(env.reg.waiting.state, "installed", "el worker sigue esperando");
  });
  test("las tres opciones del modal existen y son las de siempre (Crear copia y actualizar / Solo crear copia / Ahora no)", () => {
    const html = leer("index.html"); const m = /<div class="modal-bg" id="modalVersionNueva">[\s\S]*?<\/div>\s*<\/div>/.exec(html); assert.ok(m);
    for (const id of ["btnCopiaYActualizar", "btnSoloCopia", "btnActualizarDespues"]) assert.ok(m[0].includes(`id="${id}"`), id);
    assert.match(m[0], /Crear copia y actualizar/); assert.match(m[0], /Solo crear copia de seguridad/); assert.match(m[0], /Ahora no/);
  });
  test("sin controller (p. ej. recarga forzada que salta el SW) y con un worker esperando: también lo ofrece", async () => {
    const env = montar({ controller: false }); env.reg.waiting = env.worker("installed"); await env.pulsar(); assert.equal(env.modal(), true); env.sinDestruir();
  });
});

describe("OBS-10 · INSTALLING (hay un worker nuevo instalándose)", () => {
  test("ya estaba instalando al pulsar: NO llama a update(), espera a «installed» y ENTONCES abre el modal", async () => {
    const env = montar(); const w = env.worker("installing"); env.reg.installing = w;
    const p = env.boton().disparar("click"); await env.asentar();
    assert.equal(env.modal(), false, "todavía no: no ha terminado de instalarse"); assert.equal(env.t.update, 0); assert.equal(w.oyentes(), 1, "escucha statechange");
    w._a("installed"); await p; await env.asentar();
    assert.equal(env.modal(), true); assert.equal(w.oyentes(), 0, "deja de escuchar al terminar"); await sinTimersColgados(env); env.sinDestruir();
  });
  test("update() lo crea: update() resuelve al EMPEZAR a instalar; el botón espera a «installed» y abre el modal", async () => {
    const env = montar(); const w = env.worker("installing"); env.reg._alActualizar = async (r) => { r.installing = w; };
    const p = env.boton().disparar("click"); await env.asentar();
    assert.equal(env.t.update, 1); assert.equal(env.modal(), false, "update() ya resolvió pero el worker aún instala"); assert.ok(!textos(env).includes(YA_AL_DIA), "no debe decir «al día» mientras instala");
    w._a("installed"); await p; assert.equal(env.modal(), true); env.sinDestruir();
  });
  test("si el navegador lo activa directo (no había clientes a los que esperar) también lo ofrece", async () => {
    const env = montar(); const w = env.worker("installing"); env.reg.installing = w;
    const p = env.boton().disparar("click"); await env.asentar(); w._a("activating"); await p; assert.equal(env.modal(), true); env.sinDestruir();
  });
  test("la instalación FALLA (worker «redundant»): aviso seguro, sin modal, sin destruir", async () => {
    const env = montar(); const w = env.worker("installing"); env.reg.installing = w;
    const p = env.boton().disparar("click"); await env.asentar(); w._a("redundant"); await p;
    assert.deepEqual(textos(env), [MSG.buscando, MSG.instalacionFalla]); assert.equal(env.modal(), false); assert.equal(w.oyentes(), 0); env.sinDestruir();
  });
  test("no termina en 20 s: avisa de que tarda, deja de escuchar, sin modal, sin destruir", async () => {
    const env = montar(); const w = env.worker("installing"); env.reg.installing = w;
    const p = env.boton().disparar("click"); await env.asentar(); await env.avanzar(20001); await p;
    assert.deepEqual(textos(env), [MSG.buscando, MSG.tarda]); assert.equal(env.modal(), false); assert.equal(w.oyentes(), 0); await sinTimersColgados(env); env.sinDestruir();
  });
  test("el modal no se DUPLICA si el flujo automático (updatefound) ya lo abrió durante la comprobación", async () => {
    const env = montar(); const w = env.worker("installing"); env.reg._alActualizar = async (r) => { r.installing = w; };
    const p = env.boton().disparar("click"); await env.asentar();
    w._a("installed"); env.evaluar("abrirAvisoVersionNueva()"); await p;    // el aviso automático ya lo abrió
    assert.equal(env.modal(), true); const abiertas = env.doc.sumideros.filter((s) => s.id === "versionNuevaDetalle").length; assert.ok(abiertas <= 1, "no se reescribe el modal abierto");
  });
});

describe("OBS-10 · OFFLINE: nada se destruye y la app conserva su capacidad offline", () => {
  test("sin conexión: mensaje de red; NO se toca el registro, NO se llama a update(), NO se borra nada, NO se recarga", async () => {
    const env = montar({ online: false }); await env.pulsar();
    assert.deepEqual(textos(env), [MSG.sinRed]); assert.equal(env.t.getRegistration, 0, "ni siquiera consulta el registro"); assert.equal(env.t.update, 0); assert.equal(env.modal(), false);
    env.sinDestruir(); assert.equal(env.reg.active.state, "activated", "el SW activo sigue activo");
  });
  test("sin conexión y con un worker esperando: TAMPOCO abre el modal (no se puede actualizar sin red) ni toca nada", async () => {
    const env = montar({ online: false }); env.reg.waiting = env.worker("installed"); await env.pulsar();
    assert.deepEqual(textos(env), [MSG.sinRed]); assert.equal(env.modal(), false); env.sinDestruir();
  });
  test("sin conexión y SIN Service Worker: mismo aviso de red (y no intenta registrar)", async () => {
    const env = montar({ online: false, sw: "sin-registro" }); await env.pulsar(); assert.deepEqual(textos(env), [MSG.sinRed]); assert.deepEqual(env.t.register, []); env.sinDestruir();
  });
  test("vuelve la red: el mismo botón ya comprueba con normalidad", async () => {
    const env = montar({ online: false }); await env.pulsar(); env.setOnline(true); await env.pulsar();
    assert.equal(env.t.update, 1); assert.ok(textos(env).includes(YA_AL_DIA));
  });
});

describe("OBS-10 · SIN Service Worker: falla seguro o registra según el contrato (sin actualización forzada, sin recargar)", () => {
  test("el navegador NO soporta Service Worker: informa, no lanza y no hace nada más", async () => {
    const env = montar({ sw: "sin-soporte" }); await env.pulsar();
    assert.deepEqual(textos(env), [MSG.sinSoporte]); assert.equal(env.modal(), false); env.sinDestruir();
  });
  test("soporta pero no hay registro: registra el sw.js actual (misma llamada del arranque, updateViaCache «none»), SIN update(), SIN recargar", async () => {
    const env = montar({ sw: "sin-registro" }); await env.pulsar();
    assert.equal(json(env.t.register), json([["./sw.js", { updateViaCache: "none" }]])); assert.equal(env.t.update, 0);
    assert.deepEqual(textos(env), [MSG.buscando, MSG.sinSwListo]); assert.equal(env.modal(), false); env.sinDestruir();
  });
  test("el registro FALLA: aviso seguro, sin lanzar y sin destruir", async () => {
    const env = montar({ sw: "sin-registro" }); env.reg._registrarFalla = true; await env.pulsar();
    assert.deepEqual(textos(env), [MSG.buscando, MSG.sinSwFalla]); env.sinDestruir();
  });
  test("getRegistration() lanza: aviso seguro, sin destruir", async () => {
    const env = montar(); env.win.navigator.serviceWorker.getRegistration = async () => { throw new Error("SecurityError"); };
    await env.pulsar(); assert.deepEqual(textos(env), [MSG.buscando, "No se pudo comprobar en este dispositivo."]); env.sinDestruir();
  });
});

// ═════════════════════════════ EL MODAL: «Ahora no», «Solo copia», «Copia y actualizar» ═════════════════════════════
/** Deja el modal abierto por la vía del botón (WAITING) y prepara respaldo/descarga falsos que anotan el orden. */
function conModal({ respaldoOk = true } = {}) {
  const env = montar(); env.reg.waiting = env.worker("installed");
  env.espiar("generarRespaldoVerificado", async () => { env.t.orden.push("copia"); return respaldoOk ? { respaldo: { totalRegistros: 7, idRespaldo: "r-1" }, verif: { texto: "{}" } } : null; });
  env.espiar("nombreArchivoRespaldo", () => "copia.json");
  env.espiar("descargarArchivo", (nombre) => { env.t.orden.push(`descarga:${nombre}`); });
  return env;
}
describe("OBS-10 · «Ahora no» (respeta la decisión y no instala)", () => {
  test("cierra el aviso, no manda «activar-ya», no recarga, no destruye; el worker sigue esperando", async () => {
    const env = conModal(); await env.pulsar(); assert.equal(env.modal(), true);
    await env.doc.getElementById("btnActualizarDespues").disparar("click"); await env.asentar();
    assert.equal(env.modal(), false); assert.ok(textos(env).includes(MSG.ahoraNo)); await sinTimersColgados(env); env.sinDestruir(); assert.equal(env.reg.waiting.state, "installed");
  });
  test("tras «Ahora no» el aviso AUTOMÁTICO no vuelve a molestar en la sesión…", async () => {
    const env = conModal(); await env.pulsar(); await env.doc.getElementById("btnActualizarDespues").disparar("click");
    env.evaluar("abrirAvisoVersionNueva()"); assert.equal(env.modal(), false, "el aviso automático respeta el «Ahora no»");
  });
  test("…pero la PERSONA puede reabrirlo cuando quiera con «Buscar actualización ahora» (es lo que promete el aviso: «desde Ajustes»)", async () => {
    const env = conModal(); await env.pulsar(); await env.doc.getElementById("btnActualizarDespues").disparar("click"); assert.equal(env.modal(), false);
    await env.pulsar(); assert.equal(env.modal(), true, "reabre el mismo modal"); env.sinDestruir();
  });
});

describe("OBS-10 · «Solo crear copia de seguridad» (descarga y verifica; no instala)", () => {
  test("genera la copia verificada y la descarga; NO manda «activar-ya», NO recarga, el aviso sigue abierto y el worker esperando", async () => {
    const env = conModal(); await env.pulsar();
    await env.doc.getElementById("btnSoloCopia").disparar("click"); await env.asentar();
    assert.deepEqual(env.t.orden, ["copia", "descarga:copia.json"]); assert.ok(textos(env).includes("Copia verificada · 7 registros"));
    assert.equal(env.modal(), true); assert.equal(env.reg.waiting.state, "installed"); await sinTimersColgados(env); env.sinDestruir();   // sinDestruir tras dejar pasar el tiempo: prueba que NO habia ninguna recarga programada
  });
});

describe("OBS-10 · «Crear copia y actualizar» (la ÚNICA vía que activa el worker; la copia va PRIMERO)", () => {
  test("orden exacto: copia → descarga → «activar-ya»; y solo después la recarga (a los 2,5 s)", async () => {
    const env = conModal(); await env.pulsar();
    await env.doc.getElementById("btnCopiaYActualizar").disparar("click"); await env.asentar();
    assert.deepEqual(env.t.orden, ["copia", "descarga:copia.json", "postMessage:activar-ya"]); assert.equal(json(env.t.postMessage), json([{ tipo: "activar-ya" }]));
    assert.deepEqual(env.navegaciones, [], "todavía no se recargó");
    await env.avanzar(2500); assert.deepEqual(env.navegaciones, [{ tipo: "reload" }], "recarga de respaldo si el worker no cambia de control");
    assert.equal(env.t.unregister, 0); assert.deepEqual(env.t.cachesDelete, []);
  });
  test("si la copia NO se pudo verificar: NO se actualiza (ni «activar-ya» ni recarga)", async () => {
    const env = conModal({ respaldoOk: false }); await env.pulsar();
    await env.doc.getElementById("btnCopiaYActualizar").disparar("click"); await env.asentar(); await env.avanzar(5000);
    assert.deepEqual(env.t.postMessage, []); assert.deepEqual(env.navegaciones, []); assert.ok(textos(env).includes("No se actualizará hasta tener una copia verificada")); assert.deepEqual(env.t.orden, ["copia"]);
  });
  test("«activar-ya» va al worker que estaba ESPERANDO (no a otro)", async () => {
    const env = conModal(); const espera = env.reg.waiting; await env.pulsar();
    await env.doc.getElementById("btnCopiaYActualizar").disparar("click"); await env.asentar(); assert.equal(env.t.postMessage.length, 1); assert.equal(env.reg.active.state, "activated");
    assert.equal(espera.state, "installed", "el falso no lo activa solo: solo se le envió el mensaje");
  });
});

// ═════════════════════════════ MUTACIÓN ═════════════════════════════
describe("OBS-10 · pruebas de MUTACIÓN: cada garantía se rompe si se altera la línea que la sostiene", () => {
  const sustituir = (de, a) => (t) => { assert.ok(t.includes(de), `el mutante no encuentra: ${de}`); return t.replace(de, a); };
  // El mutante tiene que APLICARSE de verdad (si el texto a sustituir tuviera una errata, «fallar» por eso seria un falso positivo) y el fallo tiene
  // que ser una AFIRMACION del escenario (ERR_ASSERTION), no un error de sintaxis o de montaje.
  const debeFallar = async (nombre, mutante, escenario) => test(`mutante «${nombre}» → el escenario FALLA`, async () => {
    const mutado = mutante.app(APP); assert.notEqual(mutado, APP, "el mutante no cambió nada"); assert.doesNotThrow(() => new vm.Script(mutado), "el mutante no compila");
    await assert.rejects(async () => escenario(mutante), { code: "ERR_ASSERTION" }, `el mutante «${nombre}» sobrevivió o falló por otra causa`);
  });

  test("control: los escenarios pasan sobre el código real", async () => {
    for (const e of [escWaiting, escOffline, escAhoraNo, escYaAlDia]) await e(undefined);
  });
  async function escWaiting(mutar) { const env = montar({ mutar }); env.reg.waiting = env.worker("installed"); await env.pulsar(); assert.equal(env.modal(), true); env.sinDestruir(); }
  async function escOffline(mutar) { const env = montar({ mutar, online: false }); await env.pulsar(); assert.deepEqual(textos(env), [MSG.sinRed]); assert.equal(env.t.update, 0); env.sinDestruir(); }
  async function escYaAlDia(mutar) { const env = montar({ mutar }); await env.pulsar(); assert.ok(textos(env).includes(YA_AL_DIA)); env.sinDestruir(); }
  async function escAhoraNo(mutar) {
    const env = montar({ mutar }); env.reg.waiting = env.worker("installed"); await env.pulsar(); await env.doc.getElementById("btnActualizarDespues").disparar("click");
    await env.pulsar(); assert.equal(env.modal(), true);
  }
  debeFallar("el botón vuelve a desregistrar el SW (handler viejo)", { app: sustituir("if (reg.waiting) { abrirAvisoVersionNueva({ forzar: true }); return \"nueva\"; }", "await reg.unregister(); if (reg.waiting) { abrirAvisoVersionNueva({ forzar: true }); return \"nueva\"; }") }, escWaiting);
  debeFallar("el botón manda «activar-ya» al worker que espera", { app: sustituir("if (reg.waiting) { abrirAvisoVersionNueva({ forzar: true }); return \"nueva\"; }", "if (reg.waiting) { reg.waiting.postMessage({ tipo: \"activar-ya\" }); abrirAvisoVersionNueva({ forzar: true }); return \"nueva\"; }") }, escWaiting);
  debeFallar("sin la comprobación de conexión", { app: sustituir("if (navigator.onLine === false) {\n    toast(\"Sin conexión: ahora no se puede", "if (false) {\n    toast(\"Sin conexión: ahora no se puede") }, escOffline);
  debeFallar("el aviso pierde `forzar` (no se puede reabrir tras «Ahora no»)", { app: sustituir("if (avisoVersionMostrado && !forzar) return;", "if (avisoVersionMostrado) return;") }, escAhoraNo);
  debeFallar("no dice «Ya tienes la última versión»", { app: sustituir('toast("Ya tienes la última versión");', 'toast("Hay cambios");') }, escYaAlDia);

  test("mutante ESTÁTICO: reintroducir caches.delete en el handler → el comprobador de «no destructivo» lo detecta", () => {
    const mutado = sustituir('toast("Buscando la última versión…");', 'toast("Buscando la última versión…"); await caches.delete("x");')(APP);
    assert.ok(destructivoEn(mutado).length > 0, "no se detectó caches"); assert.deepEqual(destructivoEn(APP), []);
  });
  test("mutante ESTÁTICO: reintroducir location.href / unregister() en el handler → detectado", () => {
    assert.ok(destructivoEn(sustituir('return "sin-conexion";', 'location.href = "/?_=1"; return "sin-conexion";')(APP)).length > 0);
    assert.ok(destructivoEn(sustituir('return "sin-soporte";', 'reg.unregister(); return "sin-soporte";')(APP)).length > 0);
  });
});
