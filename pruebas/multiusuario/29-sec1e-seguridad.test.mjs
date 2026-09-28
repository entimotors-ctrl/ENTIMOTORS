// SECURITY-1E (3.14.1): Ajustes → Seguridad → «Cambiar contraseña del administrador», cliente de PUT /api/admin/clave (SECURITY-1D).
// Estático sobre los archivos REALES (index.html: marcado, estilos y contraste de ambos temas) y dinámico con el app.js real en vm contra
// el api-server SINTÉTICO (nunca producción): visibilidad por rol, validación local, envío único, mapeo de respuestas, Retry-After,
// limpieza y que ninguna contraseña queda en almacenamiento, consola, HTML ni registro. El render real (colores medidos, caret,
// 360/768/1280, teclado) lo cubre el caso «SEC-1E» de browser/helpers/suite-app.js.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RUNTIME, sinLlamadasAjenas, sinFugas } from "./helpers/entorno.mjs";
import { nuevoEntorno, como, CUENTAS } from "./helpers/flujos.mjs";
import { URL_API } from "./helpers/supabase-mock.mjs";

const INDEX = fs.readFileSync(path.join(RUNTIME, "index.html"), "utf8");
const APP = fs.readFileSync(path.join(RUNTIME, "app.js"), "utf8");
const CARD = INDEX.slice(INDEX.indexOf('<section class="card seguridad-card" id="cardSeguridad"'), INDEX.indexOf("</section>", INDEX.indexOf('id="cardSeguridad"')) + 10);
const BLOQUE = APP.slice(APP.indexOf("/* ================= AJUSTES → SEGURIDAD"), APP.indexOf('window.addEventListener("pagehide"'));
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{23F3}\u{2630}]/u;
const CAMPOS = ["claveActual", "claveNueva", "claveConfirmar"];
const ACTUAL = "clave-actual-sintetica-9Q", NUEVA = "una frase nueva bastante larga", OTRA = "otra frase distinta y larga";

// ── contraste (WCAG) con los tokens REALES de cada tema ──
const bloqueTema = (sel) => { const i = INDEX.indexOf(sel); return INDEX.slice(i, INDEX.indexOf("}", i)); };
const token = (bloque, nombre) => (bloque.match(new RegExp(`--${nombre}:\\s*(#[0-9a-f]{6})`, "i")) || [])[1];
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contraste = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const TEMAS = { oscuro: bloqueTema(':root[data-theme="dark"] {'), claro: bloqueTema(':root[data-theme="light"] {') };

/** Entorno con sesión sintética del admin, api-server sintético y la tarjeta preparada como la dejaría el DOM real. */
function entornoAdmin({ cuenta = CUENTAS.adminActivo, rol = "admin", origen = "supabase", api, conSesion = true, mutar } = {}) {
  const env = nuevoEntorno({ cuenta: conSesion ? cuenta : null, apiUrl: URL_API, ...(mutar ? { mutar } : {}) });
  como(env, { user: cuenta.correo, uid: cuenta.uid, perfilId: cuenta.uid, nombre: cuenta.perfil?.nombre, rol, origen, activo: true });
  for (const id of CAMPOS) env.doc.getElementById(id).type = "password";
  const llamadas = [];
  env.servidor.api = async (metodo, ruta, cuerpo, auth) => {
    llamadas.push({ metodo, ruta, auth, claves: cuerpo && typeof cuerpo === "object" ? Object.keys(cuerpo).sort() : null, igualQueCampos: cuerpo?.clave_actual === env.__actual && cuerpo?.clave_nueva === env.__nueva });
    return typeof api === "function" ? api(metodo, ruta, cuerpo, auth) : { status: 200, body: { ok: true, otras_sesiones_cerradas: true } };
  };
  env.llamadas = llamadas;
  return env;
}
function rellenar(env, actual = ACTUAL, nueva = NUEVA, confirmacion = nueva) {
  env.__actual = actual; env.__nueva = nueva;
  env.doc.getElementById("claveActual").value = actual;
  env.doc.getElementById("claveNueva").value = nueva;
  env.doc.getElementById("claveConfirmar").value = confirmacion;
}
const valores = (env) => CAMPOS.map((id) => env.doc.getElementById(id).value);
const tipos = (env) => CAMPOS.map((id) => env.doc.getElementById(id).type);
const estado = (env) => ({ tipo: env.doc.getElementById("claveEstado").getAttribute("data-tipo"), html: env.doc.getElementById("claveEstado").innerHTML });
async function enviar(env) { await env.win.enviarCambioClave(); await env.asentar(); }

describe("SEC-1E · marcado de Ajustes → Seguridad (index.html real)", () => {
  test("la tarjeta vive DENTRO de Ajustes, empieza oculta y se titula «Seguridad» / «Cambiar contraseña del administrador»", () => {
    const ajustes = INDEX.slice(INDEX.indexOf('<section class="view" id="view-ajustes">'));
    assert.ok(ajustes.indexOf('id="cardSeguridad"') > 0 && ajustes.indexOf('id="cardSeguridad"') < ajustes.indexOf("</section>\n\n  </div>") + 1e6);
    assert.match(CARD, /id="cardSeguridad" aria-labelledby="tituloSeguridad" style="display:none;"/);
    assert.match(CARD, /<h3[^>]*id="tituloSeguridad"><svg class="ic" aria-hidden="true" focusable="false"><use href="#i-candado"><\/use><\/svg>Seguridad<\/h3>/);
    assert.match(CARD, />Cambiar contraseña del administrador</);
    assert.match(CARD, /Actualiza la contraseña que utilizas para iniciar sesión como administrador\./);
  });
  test("tres campos type=password con label real y el autocomplete correcto; nada precargado", () => {
    const esperado = { claveActual: ["Contraseña actual", "current-password"], claveNueva: ["Nueva contraseña", "new-password"], claveConfirmar: ["Confirmar nueva contraseña", "new-password"] };
    for (const [id, [etiqueta, ac]] of Object.entries(esperado)) {
      assert.match(CARD, new RegExp(`<label for="${id}">${etiqueta}</label>`), id);
      const input = CARD.match(new RegExp(`<input [^>]*id="${id}"[^>]*>`))[0];
      assert.match(input, /^<input type="password" /, id); assert.match(input, new RegExp(`autocomplete="${ac}"`), id);
      assert.doesNotMatch(input, /value=|placeholder=".*[a-z0-9]{8}/i, id);
    }
    assert.equal((CARD.match(/<input /g) || []).length, 3, "solo los tres campos (sin usuario oculto ni otros)");
  });
  test("mostrar/ocultar: un botón por campo, type=button, aria-controls/aria-pressed=false/aria-label «Mostrar contraseña», icono vectorial #i-ojo", () => {
    const botones = [...CARD.matchAll(/<button type="button" class="btn-ver-clave" data-campo="(\w+)" aria-controls="(\w+)" aria-pressed="false" aria-label="Mostrar contraseña"><svg class="ic" aria-hidden="true" focusable="false"><use href="#i-ojo"><\/use><\/svg><\/button>/g)];
    assert.deepEqual(botones.map((b) => b[1]), CAMPOS); for (const b of botones) assert.equal(b[1], b[2]);
  });
  test("ayuda de la política = la del servidor (12 caracteres, 72 bytes, distinta, sin entimotors/nombre/correo, sin comunes/repetitivas) y SIN requisitos inventados", () => {
    const ayuda = CARD.slice(CARD.indexOf('id="claveAyuda"'), CARD.indexOf("</ul>"));
    for (const s of ["12 caracteres", "72 bytes", "Distinta de la contraseña actual", "«entimotors»", "tu nombre", "correo", "común", "repetitivo"]) assert.ok(ayuda.includes(s), s);
    assert.doesNotMatch(ayuda, /mayúscula|minúscula|número|símbolo|carácter especial/i);
    assert.match(CARD, /id="claveNueva"[^>]*aria-describedby="claveAyuda"/);
  });
  test("estado accesible (role=status + aria-live) y botón de envío con nombre visible", () => {
    assert.match(CARD, /<p class="clave-estado" id="claveEstado" role="status" aria-live="polite"><\/p>/);
    assert.match(CARD, /<button type="submit" class="btn primary small" id="btnCambiarClave">Cambiar contraseña<\/button>/);
    assert.match(CARD, /<form id="formClaveAdmin" class="form-clave" aria-labelledby="tituloClaveAdmin" novalidate>/);
  });
  test("sin emoji ni detalles internos (ADMIN_PASSWORD, Render, Supabase, JWT, service_role, token)", () => {
    assert.doesNotMatch(CARD.replace(/<!--[\s\S]*?-->/g, ""), EMOJI);
    assert.doesNotMatch(CARD.replace(/<!--[\s\S]*?-->/g, ""), /ADMIN_PASSWORD|Render|Supabase|JWT|service_role|token/i);
  });
});

describe("SEC-1E · estilos EXPLÍCITOS de los campos (el defecto visual de la aceptación)", () => {
  const regla = INDEX.match(/\.campo-clave-caja input\[type=password\], \.campo-clave-caja input\[type=text\] \{([^}]*)\}/)?.[1] ?? "";
  test("texto, -webkit-text-fill-color, caret, fondo y borde fijados con tokens del tema (no heredados); también con type=text", () => {
    for (const d of ["color: var(--text)", "-webkit-text-fill-color: var(--text)", "caret-color: var(--red)", "background: var(--bg-raise)", "border: 1px solid var(--line)", "font-size: 1rem"]) assert.ok(regla.includes(d), d);
  });
  test("placeholder legible y distinto del texto; autofill del navegador con los mismos colores; foco visible; sin el ojo nativo de Edge", () => {
    assert.match(INDEX, /\.campo-clave-caja input::placeholder \{ color: var\(--text-faint\); -webkit-text-fill-color: var\(--text-faint\); opacity: 1; \}/);
    assert.match(INDEX, /\.campo-clave-caja input:-webkit-autofill, \.campo-clave-caja input:-webkit-autofill:focus \{[^}]*-webkit-text-fill-color: var\(--text\);[^}]*caret-color: var\(--red\);[^}]*box-shadow: 0 0 0 100rem var\(--bg-raise\) inset;/);
    assert.match(INDEX, /\.campo-clave-caja input:focus \{ outline: 2px solid var\(--red-border\);/);
    assert.match(INDEX, /\.btn-ver-clave:focus-visible \{ outline: 2px solid var\(--red-border\);/);
    assert.match(INDEX, /\.campo-clave-caja input::-ms-reveal, \.campo-clave-caja input::-ms-clear \{ display: none; \}/);
    assert.match(INDEX, /:root\[data-theme="dark"\] \.campo-clave-caja input \{ color-scheme: dark; \}/);
    assert.match(INDEX, /:root\[data-theme="light"\] \.campo-clave-caja input \{ color-scheme: light; \}/);
  });
  for (const [nombre, bloque] of Object.entries(TEMAS)) {
    test(`tema ${nombre}: texto ≥ 7:1, caret ≥ 3:1, placeholder ≥ 3:1 y etiqueta ≥ 4.5:1 sobre el fondo del campo`, () => {
      const fondo = token(bloque, "bg-raise"), texto = token(bloque, "text"), caret = token(bloque, "red"), faint = token(bloque, "text-faint"), muted = token(bloque, "text-muted");
      assert.ok(contraste(texto, fondo) >= 7, `texto ${contraste(texto, fondo).toFixed(2)}`);
      assert.ok(contraste(caret, fondo) >= 3, `caret ${contraste(caret, fondo).toFixed(2)}`);
      assert.ok(contraste(faint, fondo) >= 3, `placeholder ${contraste(faint, fondo).toFixed(2)}`);
      assert.ok(contraste(muted, fondo) >= 4.5, `etiqueta ${contraste(muted, fondo).toFixed(2)}`);
    });
  }
});

describe("SEC-1E · visibilidad por rol (puedeVerVista + rol admin; ningún sistema de roles nuevo)", () => {
  const vis = (rol, origen = "supabase") => { const env = entornoAdmin({ rol, origen }); env.win.prepararSeguridad(); return env; };
  test("admin con cuenta del taller: la ve y el formulario está activo", () => {
    const env = vis("admin");
    assert.equal(env.doc.getElementById("cardSeguridad").style.display, "");
    assert.equal(env.doc.getElementById("formClaveAdmin").style.display, "");
    assert.equal(env.doc.getElementById("claveSinCuenta").style.display, "none");
  });
  for (const rol of ["cajero", "mecanico", "desarrollador", "superadmin"]) {
    test(`${rol}: NO la ve (y tampoco Ajustes)`, () => {
      const env = vis(rol);
      assert.equal(env.doc.getElementById("cardSeguridad").style.display, "none");
      assert.equal(env.win.puedeVerVista("ajustes"), false);
    });
  }
  test("admin con inicio de sesión local (sin cuenta del taller): la tarjeta explica que requiere la cuenta y no muestra el formulario", () => {
    const env = vis("admin", "local");
    assert.equal(env.doc.getElementById("cardSeguridad").style.display, "");
    assert.equal(env.doc.getElementById("formClaveAdmin").style.display, "none");
    assert.equal(env.doc.getElementById("claveSinCuenta").style.display, "");
  });
  test("aplicarPermisosPorRol() prepara la tarjeta (misma pasada que el menú y los accesos rápidos)", () => {
    const env = entornoAdmin({ rol: "cajero" }); env.doc.getElementById("cardSeguridad").style.display = "";
    env.win.aplicarPermisosPorRol();
    assert.equal(env.doc.getElementById("cardSeguridad").style.display, "none");
    assert.match(APP, /function aplicarPermisosPorRol\(\) \{[\s\S]*?prepararSeguridad\(\);\n\}/);
  });
  test("un cajero que llegara a la función igual NO envía nada (el envío vuelve a comprobar el rol)", async () => {
    const env = entornoAdmin({ rol: "cajero" }); rellenar(env); await enviar(env);
    assert.equal(env.llamadas.length, 0);
  });
});

describe("SEC-1E · validación local (sin secretos ajenos; el servidor es la autoridad)", () => {
  const env = entornoAdmin();
  const v = (a, n, c) => env.win.validarCambioClave(a, n, c);
  test("vacíos, confirmación distinta, igual a la actual, < 12 caracteres, > 72 bytes, «entimotors» → código y campo a corregir", () => {
    assert.deepEqual({ ...v("", NUEVA, NUEVA) }, { codigo: "CAMPOS_VACIOS", campo: "claveActual" });
    assert.deepEqual({ ...v(ACTUAL, "", "") }, { codigo: "CAMPOS_VACIOS", campo: "claveNueva" });
    assert.deepEqual({ ...v(ACTUAL, NUEVA, "") }, { codigo: "CAMPOS_VACIOS", campo: "claveConfirmar" });
    assert.deepEqual({ ...v(ACTUAL, NUEVA, OTRA) }, { codigo: "CLAVES_NO_COINCIDEN", campo: "claveConfirmar" });
    assert.deepEqual({ ...v(NUEVA, NUEVA, NUEVA) }, { codigo: "CLAVE_IGUAL_A_LA_ACTUAL", campo: "claveNueva" });
    assert.deepEqual({ ...v(ACTUAL, "corta-11chr", "corta-11chr") }, { codigo: "CLAVE_CORTA", campo: "claveNueva" });
    assert.deepEqual({ ...v(ACTUAL, "x".repeat(73), "x".repeat(73)) }, { codigo: "CLAVE_LARGA", campo: "claveNueva" });
    assert.deepEqual({ ...v(ACTUAL, "ñ".repeat(37), "ñ".repeat(37)) }, { codigo: "CLAVE_LARGA", campo: "claveNueva" }, "74 bytes UTF-8");
    assert.deepEqual({ ...v(ACTUAL, "mi taller ENTI motors grande", "mi taller ENTI motors grande") }, { codigo: "CLAVE_DEBIL", campo: "claveNueva" });
  });
  test("límites exactos: 12 caracteres y 72 bytes pasan; 36 «ñ» (72 bytes) pasa; una frase normal pasa", () => {
    assert.equal(v(ACTUAL, "abcd efgh ij", "abcd efgh ij"), null);
    assert.equal(v(ACTUAL, "x".repeat(72), "x".repeat(72)), null);
    assert.equal(v(ACTUAL, "ñ".repeat(36), "ñ".repeat(36)), null);
    assert.equal(v(ACTUAL, NUEVA, NUEVA), null);
  });
  test("sin requisitos inventados: sin mayúscula/número/símbolo también pasa (el servidor no los exige)", () => assert.equal(v(ACTUAL, "solo letras minusculas", "solo letras minusculas"), null));
  test("un fallo local NO llama al servidor, deja los valores para corregir y los oculta", async () => {
    const e = entornoAdmin(); rellenar(e, ACTUAL, NUEVA, OTRA);
    e.doc.getElementById("claveNueva").type = "text";
    await enviar(e);
    assert.equal(e.llamadas.length, 0); assert.deepEqual(valores(e), [ACTUAL, NUEVA, OTRA]); assert.deepEqual(tipos(e), ["password", "password", "password"]);
    assert.equal(estado(e).tipo, "error"); assert.match(estado(e).html, /La confirmación no coincide/);
  });
});

describe("SEC-1E · envío a PUT /api/admin/clave (api-server sintético)", () => {
  test("200: UNA petición PUT con Bearer de la sesión actual y EXACTAMENTE los tres campos; campos vacíos y ocultos; mensaje de éxito con otras sesiones", async () => {
    const env = entornoAdmin(); rellenar(env); env.doc.getElementById("claveActual").type = "text";
    await enviar(env);
    assert.equal(env.llamadas.length, 1);
    assert.deepEqual({ ...env.llamadas[0], claves: [...env.llamadas[0].claves] }, { metodo: "PUT", ruta: "/api/admin/clave", auth: "sesion", claves: ["clave_actual", "clave_confirmacion", "clave_nueva"], igualQueCampos: true });
    assert.deepEqual(valores(env), ["", "", ""]); assert.deepEqual(tipos(env), ["password", "password", "password"]);
    assert.equal(estado(env).tipo, "ok"); assert.match(estado(env).html, /Contraseña actualizada correctamente\. Las demás sesiones de administrador fueron cerradas\./);
    assert.match(estado(env).html, /#i-check/, "no solo color: símbolo de éxito");
    assert.equal(env.doc.getElementById("btnCambiarClave").disabled, false, "se puede seguir usando");
    assert.deepEqual(env.navegaciones ?? [], [], "no recarga ni navega");
    sinLlamadasAjenas(env); sinFugas(env, [ACTUAL, NUEVA]);
  });
  test("200 sin otras_sesiones_cerradas=true: solo «Contraseña actualizada correctamente.»", async () => {
    const env = entornoAdmin({ api: () => ({ status: 200, body: { ok: true, otras_sesiones_cerradas: false } }) }); rellenar(env); await enviar(env);
    assert.match(estado(env).html, /<span>Contraseña actualizada correctamente\.<\/span>/);
  });
  test("doble clic / Enter repetido: una sola petición concurrente; el botón queda deshabilitado mientras envía", async () => {
    let soltar; const espera = new Promise((r) => { soltar = r; });
    const env = entornoAdmin({ api: async () => { await espera; return { status: 200, body: { ok: true, otras_sesiones_cerradas: true } }; } }); rellenar(env);
    const p1 = env.win.enviarCambioClave(), p2 = env.win.enviarCambioClave(); await env.asentar();
    assert.equal(env.doc.getElementById("btnCambiarClave").disabled, true);
    assert.equal(env.doc.getElementById("btnCambiarClave").getAttribute("aria-busy"), "true");
    assert.ok(CAMPOS.every((id) => env.doc.getElementById(id).disabled), "campos bloqueados durante el envío");
    await env.win.enviarCambioClave();
    soltar(); await Promise.all([p1, p2]); await env.asentar();
    assert.equal(env.llamadas.length, 1);
    assert.equal(env.doc.getElementById("btnCambiarClave").disabled, false);
  });

  const CASOS = [
    ["CLAVE_INCORRECTA", 401, "La contraseña actual no es correcta.", "error", ["", NUEVA, NUEVA]],
    ["CLAVE_DEBIL", 400, "no cumple los requisitos", "error", [ACTUAL, "", ""]],
    ["CLAVES_NO_COINCIDEN", 400, "La confirmación no coincide", "error", [ACTUAL, NUEVA, ""]],
    ["CLAVE_IGUAL_A_LA_ACTUAL", 400, "distinta de la actual", "error", [ACTUAL, "", ""]],
    ["SESION_INVALIDA", 401, "Cierra sesión, vuelve a entrar", "error", ["", "", ""]],
    ["SIN_SESION", 401, "Cierra sesión, vuelve a entrar", "error", ["", "", ""]],
    ["SOLO_ADMIN", 403, "Solo un administrador activo", "error", ["", "", ""]],
    ["CUENTA_INACTIVA", 403, "Solo un administrador activo", "error", ["", "", ""]],
    ["ERROR_INTERNO", 500, "No se pudo cambiar la contraseña. Inténtalo de nuevo más tarde.", "error", ["", "", ""]],
    ["CUALQUIER_OTRO", 418, "No se pudo cambiar la contraseña.", "error", ["", "", ""]],
  ];
  for (const [codigo, status, texto, tipo, quedan] of CASOS) {
    test(`${status} ${codigo} → «${texto}»; ocultas; se borra lo que ya no sirve; una sola petición`, async () => {
      const env = entornoAdmin({ api: () => ({ status, body: { error: "Detalle interno del servidor xyz", codigo, stack: "at secreto (x.ts:1)" } }) }); rellenar(env);
      env.doc.getElementById("claveNueva").type = "text";
      await enviar(env);
      assert.equal(env.llamadas.length, 1); assert.equal(estado(env).tipo, tipo);
      assert.ok(estado(env).html.includes(texto), estado(env).html);
      assert.doesNotMatch(estado(env).html, /Detalle interno|secreto|x\.ts|stack/, "nunca el cuerpo del servidor");
      assert.deepEqual(valores(env), quedan); assert.deepEqual(tipos(env), ["password", "password", "password"]);
      sinFugas(env, [ACTUAL, NUEVA]);
    });
  }
  test("respuesta que no es JSON (p. ej. página de error de un proxy) → mensaje genérico, sin mostrarla", async () => {
    const env = entornoAdmin({ api: () => ({ status: 502, body: "<html>Bad gateway secreto</html>" }) }); rellenar(env); await enviar(env);
    assert.match(estado(env).html, /No se pudo cambiar la contraseña/); assert.doesNotMatch(estado(env).html, /Bad gateway|secreto/);
  });

  test("409 CAMBIO_EN_CURSO: respeta Retry-After (segundos); el botón no se reactiva antes; después sí", async () => {
    const env = entornoAdmin({ api: () => ({ status: 409, body: { codigo: "CAMBIO_EN_CURSO" }, cabeceras: { "Retry-After": "40" } }) }); rellenar(env); await enviar(env);
    assert.equal(estado(env).tipo, "aviso"); assert.match(estado(env).html, /Ya hay un cambio de contraseña en curso[\s\S]*40 s\./);
    assert.equal(env.doc.getElementById("btnCambiarClave").disabled, true);
    rellenar(env); await enviar(env); assert.equal(env.llamadas.length, 1, "durante la espera no se envía");
    await env.avanzar(39000); assert.equal(env.doc.getElementById("btnCambiarClave").disabled, true);
    await env.avanzar(1500); assert.equal(env.doc.getElementById("btnCambiarClave").disabled, false);
    rellenar(env); await enviar(env); assert.equal(env.llamadas.length, 2);
  });
  test("429 DEMASIADOS_INTENTOS: Retry-After 900 → «15 min»; sin cabecera usa reintentar_en_s del cuerpo; fecha HTTP también vale", async () => {
    const e1 = entornoAdmin({ api: () => ({ status: 429, body: { codigo: "DEMASIADOS_INTENTOS", reintentar_en_s: 5 }, cabeceras: { "Retry-After": "900" } }) }); rellenar(e1); await enviar(e1);
    assert.match(estado(e1).html, /Demasiados intentos[\s\S]*15 min\./); assert.equal(e1.doc.getElementById("btnCambiarClave").disabled, true);
    const e2 = entornoAdmin({ api: () => ({ status: 429, body: { codigo: "DEMASIADOS_INTENTOS", reintentar_en_s: 120 } }) }); rellenar(e2); await enviar(e2);
    assert.match(estado(e2).html, /2 min\./);
    const w = entornoAdmin();
    const fecha = new w.win.Date(w.win.Date.now() + 300000).toUTCString();
    assert.equal(w.win.segundosDeEspera(fecha, null), 300);
    assert.equal(w.win.segundosDeEspera("basura", { reintentar_en_s: 7 }), 7);
    assert.equal(w.win.segundosDeEspera(null, null), null);
    assert.equal(w.win.segundosDeEspera("999999999", null), 86400, "nunca más de 24 h");
  });
  test("503 AUTH_NO_DISPONIBLE: mensaje temporal y una pausa de 60 s (no invita a insistir)", async () => {
    const env = entornoAdmin({ api: () => ({ status: 503, body: { codigo: "AUTH_NO_DISPONIBLE" } }) }); rellenar(env); await enviar(env);
    assert.equal(estado(env).tipo, "aviso"); assert.match(estado(env).html, /no está disponible en este momento[\s\S]*1 min\./);
    assert.equal(env.doc.getElementById("btnCambiarClave").disabled, true);
    await env.avanzar(60500); assert.equal(env.doc.getElementById("btnCambiarClave").disabled, false);
  });
  test("503 con estado_cambio «desconocido» y red caída tras enviar: «No se pudo confirmar el cambio…», NUNCA se reintenta", async () => {
    const e1 = entornoAdmin({ api: () => ({ status: 503, body: { codigo: "AUTH_NO_DISPONIBLE", estado_cambio: "desconocido" } }) }); rellenar(e1); await enviar(e1);
    assert.match(estado(e1).html, /No se pudo confirmar el cambio/); assert.equal(e1.llamadas.length, 1);
    const e2 = entornoAdmin(); rellenar(e2);
    const fetchOriginal = e2.win.fetch; let n = 0;
    e2.win.fetch = async (url, init) => { if (String(url).includes("/api/admin/clave")) { n++; throw new TypeError("Failed to fetch"); } return fetchOriginal(url, init); };
    e2.evaluar("fetch = window.fetch");
    await enviar(e2);
    assert.equal(n, 1); assert.match(estado(e2).html, /No se pudo confirmar el cambio/); assert.deepEqual(valores(e2), ["", "", ""]);
  });
  test("sin sesión vigente (ni renovable): SESION_INVALIDA sin llamar al servidor", async () => {
    const env = entornoAdmin({ conSesion: false }); rellenar(env); await enviar(env);
    assert.equal(env.llamadas.length, 0); assert.match(estado(env).html, /Cierra sesión, vuelve a entrar/);
  });
  test("sin conexión: no envía nada y lo dice", async () => {
    const env = entornoAdmin(); env.setOnline(false); rellenar(env); await enviar(env);
    assert.equal(env.llamadas.length, 0); assert.match(estado(env).html, /Necesitas conexión/);
  });
});

describe("SEC-1E · mostrar/ocultar y limpieza", () => {
  test("alternar: solo cambia type + aria-pressed + aria-label + icono; el valor no se toca", () => {
    const env = entornoAdmin(); rellenar(env);
    const btn = env.doc.createElement("button"); btn.dataset.campo = "claveNueva";
    env.win.alternarVerClave(btn);
    assert.equal(env.doc.getElementById("claveNueva").type, "text");
    assert.equal(btn.getAttribute("aria-pressed"), "true"); assert.equal(btn.getAttribute("aria-label"), "Ocultar contraseña");
    assert.equal(btn.querySelector("use").getAttribute("href"), "#i-ojo-tachado");
    assert.equal(env.doc.getElementById("claveNueva").value, NUEVA);
    env.win.alternarVerClave(btn);
    assert.equal(env.doc.getElementById("claveNueva").type, "password"); assert.equal(btn.getAttribute("aria-label"), "Mostrar contraseña");
    assert.equal(btn.querySelector("use").getAttribute("href"), "#i-ojo");
  });
  test("un botón que apunte a otro campo cualquiera no hace nada", () => {
    const env = entornoAdmin(); const otro = env.doc.getElementById("loginPass"); otro.type = "password";
    const btn = env.doc.createElement("button"); btn.dataset.campo = "loginPass";
    env.win.alternarVerClave(btn); assert.equal(otro.type, "password");
  });
  test("salir de Ajustes (showView a otra vista) borra y oculta los tres campos", () => {
    const env = entornoAdmin(); rellenar(env); env.doc.getElementById("claveActual").type = "text";
    env.win.showView("dashboard");
    assert.deepEqual(valores(env), ["", "", ""]); assert.deepEqual(tipos(env), ["password", "password", "password"]);
  });
  test("cerrar sesión borra los campos antes de recargar; pagehide también", () => {
    assert.match(APP, /getElementById\("btnLogout"\)\.addEventListener\("click", async \(\) => \{[\s\S]{0,300}?limpiarFormClave\(\);/);
    const env = entornoAdmin(); rellenar(env);
    for (const f of env.oyentesVentana?.pagehide ?? []) f({ type: "pagehide" });
    if (!(env.oyentesVentana?.pagehide ?? []).length) env.win.limpiarFormClave();
    assert.deepEqual(valores(env), ["", "", ""]);
    assert.match(APP, /window\.addEventListener\("pagehide", \(\) => limpiarFormClave\(\)\);/);
  });
});

describe("SEC-1E · ninguna contraseña ni token persiste o se registra", () => {
  test("tras éxito y error: nada en localStorage, sessionStorage, cookies, consola, HTML asignado ni en el registro del servidor; no abre IndexedDB", async () => {
    for (const api of [() => ({ status: 200, body: { ok: true, otras_sesiones_cerradas: true } }), () => ({ status: 401, body: { codigo: "CLAVE_INCORRECTA" } })]) {
      const env = entornoAdmin({ api }); const idbAntes = env.idbAbiertas.length; rellenar(env); await enviar(env);
      sinFugas(env, [ACTUAL, NUEVA]);
      const pajar = JSON.stringify(env.almacenSesion.volcado?.() ?? {}) + env.doc.cookie + JSON.stringify(env.servidor.llamadas);
      for (const s of [ACTUAL, NUEVA]) assert.ok(!pajar.includes(s), "secreto en sessionStorage/cookie/registro");
      assert.equal(env.idbAbiertas.length, idbAntes, "no abre IndexedDB");
      assert.deepEqual(Object.values(env.consola).flat().filter((l) => /clave|contrase/i.test(l)), [], "nada de claves en consola");
    }
  });
  test("el bloque SECURITY-1E de app.js no usa console, localStorage, sessionStorage, indexedDB ni cookies, y no muestra el token", () => {
    assert.ok(BLOQUE.length > 3000);
    const codigo = BLOQUE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");   // sin comentarios (los comentarios SÍ nombran lo prohibido)
    assert.doesNotMatch(codigo, /console\.|localStorage|sessionStorage|indexedDB|document\.cookie/i);
    assert.doesNotMatch(BLOQUE, /access_token[^;]*(textContent|innerHTML|toast|pintarEstado)/);
    assert.match(BLOQUE, /credentials: "omit"/); assert.match(BLOQUE, /cache: "no-store"/);
  });
});

describe("SEC-1E · mutantes (cada garantía sostenida por su línea)", () => {
  const exito = { status: 200, body: { ok: true, otras_sesiones_cerradas: true } };
  const M = {
    "sin la guarda de envío único, un doble clic manda dos peticiones": {
      mutar: { app: (t) => t.replace("  if (enviandoClave) return;                                      // doble clic / Enter repetido: una sola petición\n", "") },
      prueba: async (e) => { let soltar; const p = new Promise((r) => { soltar = r; }); e.servidor.api = async () => { e.llamadas.push(1); await p; return exito; };
        rellenar(e); const a = e.win.enviarCambioClave(), b = e.win.enviarCambioClave(); await e.asentar(); soltar(); await Promise.all([a, b]); return e.llamadas.length === 1; },
    },
    "sin limpiar tras el éxito, la contraseña se queda escrita": {
      mutar: { app: (t) => t.replace("  limpiarFormClave(resultado.limpiar);\n", "") },
      prueba: async (e) => { rellenar(e); await enviar(e); return valores(e).every((v) => v === ""); },
    },
    "sin ocultar al enviar, un campo mostrado se queda en texto": {
      mutar: { app: (t) => t.replace("  bloquearFormClave(true);\n  ocultarClaves();\n", "  bloquearFormClave(true);\n").replace("function limpiarFormClave(campos = CAMPOS_CLAVE) {\n  for (const id of campos) {\n    const input = campoClave(id);\n    if (input) input.value = \"\";\n  }\n  ocultarClaves();", "function limpiarFormClave(campos = CAMPOS_CLAVE) {\n  for (const id of campos) {\n    const input = campoClave(id);\n    if (input) input.value = \"\";\n  }") },
      prueba: async (e) => { rellenar(e); e.doc.getElementById("claveNueva").type = "text"; await enviar(e); return tipos(e).every((t) => t === "password"); },
    },
    "sin respetar Retry-After, se puede volver a enviar enseguida": {
      mutar: { app: (t) => t.replace("  if (Date.now() < claveEsperaHasta) return;\n", "").replace("    btn.disabled = bloquear || esperando;", "    btn.disabled = bloquear;") },
      prueba: async (e) => { e.servidor.api = async () => { e.llamadas.push(1); return { status: 429, body: { codigo: "DEMASIADOS_INTENTOS" }, cabeceras: { "Retry-After": "900" } }; };
        rellenar(e); await enviar(e); rellenar(e); await enviar(e); return e.llamadas.length === 1; },
    },
    "sin la guarda de rol en el envío, un cajero envía": {
      mutar: { app: (t) => t.replace('  if (!(currentUser?.rol === "admin" && puedeVerVista("ajustes"))) return;\n', "") },
      prueba: async (e) => { e.evaluar('currentUser = { ...currentUser, rol: "cajero" }'); rellenar(e); await enviar(e); return e.llamadas.length === 0; },
    },
    "sin limpiar al salir de Ajustes, la contraseña sigue escrita": {
      mutar: { app: (t) => t.replace('  if (name !== "ajustes") limpiarFormClave();\n', "") },
      prueba: async (e) => { rellenar(e); e.win.showView("dashboard"); return valores(e).every((v) => v === ""); },
    },
  };
  for (const [nombre, { mutar, prueba }] of Object.entries(M)) {
    test(`original cumple · mutante detectado: ${nombre}`, async () => {
      assert.equal(await prueba(entornoAdmin()), true, "el original debe cumplir");
      assert.equal(await prueba(entornoAdmin({ mutar })), false, "el mutante debe detectarse");
    });
  }
});
