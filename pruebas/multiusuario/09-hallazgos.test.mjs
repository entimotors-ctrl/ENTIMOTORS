// HALLAZGOS de QA (C3) — los tres CERRADOS. Cada prueba afirma el comportamiento CORRECTO que C3 encontro ausente y que hoy se cumple;
// son el registro ejecutable de que el defecto NO regresa. Ya no hay hallazgos abiertos en esta suite.
//   F-SEC-1  CERRADO en 4E-C3-FIX1 (usuarios.js). Regresion completa en 10-fsec1-mensajes-error.test.mjs.
//   F-SEC-2  CERRADO en 4E-C3-FIX2 (app.js:6002, esc() sobre el rol en «Ajustes»). Regresion completa en 11-fsec2-rol-en-ajustes.test.mjs.
//   F-FUNC-1 CERRADO en 4E-C3-FIX2 (auth.js Auth.establecerClave conserva sin-conexion / tiempo-agotado). Regresion completa en 12-ffunc1-establecer-clave.test.mjs.
// Las pruebas de este archivo son las ORIGINALES de C3 (mismas afirmaciones). Las verificaciones «con una correccion HIPOTETICA» de antes de
// la correccion pasaron a su forma inversa: «si se QUITA el arreglo (en memoria) la prueba vuelve a detectar el defecto».
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { marcadoPeligroso } from "./helpers/dom.mjs";
import { nuevoEntorno, como, dbFalsa } from "./helpers/flujos.mjs";
import { UUID, crearServidor } from "./helpers/supabase-mock.mjs";

// Los tres payloads de la especificacion. En un navegador real: el 1.º y el 3.º EJECUTAN JS al asignarse a innerHTML; el 2.º inyecta
// un <script> que innerHTML NO ejecuta (marcado inerte, pero marcado ajeno al fin).
const PAYLOADS = [
  ["img/onerror (ejecuta)", "<img src=x onerror=alert(1)>"],
  ["script (inerte con innerHTML)", "<script>alert(1)</script>"],
  ["svg/onload tras romper atributo (ejecuta)", `"'><svg onload=alert(1)>`],
];
describe("F-SEC-2 (CERRADO en 4E-C3-FIX2) · app.js:6002 — «Ajustes» ya NO pinta el rol sin escapar cuando no es uno de los cuatro conocidos", () => {
  const marcadoEnAjustes = async (mutar) => {
    const mal = [];
    for (const [nombre, p] of PAYLOADS) {
      const env = nuevoEntorno(mutar ? { mutar } : {}); como(env, { rol: p, origen: "supabase", perfilId: UUID(9), nombre: "Raro", activo: true }); dbFalsa(env, {});
      await env.win.renderAjustes().catch(() => {});
      const marcado = marcadoPeligroso(env.doc.getElementById("ajustesInfo").innerHTML); if (marcado.length) mal.push(`${nombre}: ${[...new Set(marcado)].join(", ")}`);
    }
    return mal;
  };
  test("verificacion de la prueba: si se QUITA el esc() del rol (el codigo original, en memoria) esta misma prueba vuelve a detectar el marcado — la prueba SIGUE mordiendo", async () => {
    const vulnerable = { app: (t) => { const r = t.replace('(${esc(NOMBRE_ROL[currentUser?.rol] || currentUser?.rol || "—")})', '(${NOMBRE_ROL[currentUser?.rol] || currentUser?.rol || "—"})'); assert.notEqual(r, t); return r; } };
    const mal = await marcadoEnAjustes(vulnerable);
    assert.equal(mal.length, PAYLOADS.length, `el codigo original debia marcar los ${PAYLOADS.length} payloads: ${mal.join(" | ")}`);
  });
  test("[F-SEC-2 · CERRADO] una sesion con un rol hostil no debe convertir el rol en marcado dentro de #ajustesInfo", async () => {
    // Alcance: el rol de una sesion de servidor esta acotado por perfiles_rol_check (4 valores) y siempre esta en NOMBRE_ROL;
    // el fallback `|| currentUser.rol` solo es alcanzable con una sesion guardada manipulada en el dispositivo (enti_session).
    // Es un hallazgo de ENDURECIMIENTO (severidad baja), pero es innerHTML con dato no saneado.
    const mal = await marcadoEnAjustes();
    assert.deepEqual(mal, [], `#ajustesInfo recibio marcado ajeno para: ${mal.join(" | ")}`);
  });
  test("contraste: el NOMBRE si se escapa (esc) y los cuatro roles conocidos se muestran con su etiqueta", async () => {
    for (const [, p] of PAYLOADS) { const env = nuevoEntorno(); como(env, { rol: "admin", origen: "supabase", perfilId: UUID(9), nombre: p, activo: true }); dbFalsa(env, {}); await env.win.renderAjustes().catch(() => {}); assert.deepEqual(marcadoPeligroso(env.doc.getElementById("ajustesInfo").innerHTML), [], p); }
    for (const [rol, etiqueta] of [["admin", "administrador"], ["mecanico", "mecánico"], ["cajero", "cajero"], ["desarrollador", "desarrollador"]]) { const env = nuevoEntorno(); como(env, { rol, origen: "supabase", perfilId: UUID(9), nombre: "N", activo: true }); dbFalsa(env, {}); await env.win.renderAjustes().catch(() => {}); assert.match(env.doc.getElementById("ajustesInfo").innerHTML, new RegExp(`\\(${etiqueta}\\)`)); }
  });
});

describe("F-FUNC-1 (CERRADO en 4E-C3-FIX2) · recuperacion de contraseña: el aviso «sin conexion» YA se muestra (la rama de recovery.js es alcanzable)", () => {
  // recovery.js:171 espera motivo «sin-conexion» / «tiempo-agotado»; antes Auth.establecerClave (auth.js:245-260) solo distinguia
  // «sin-permiso» y devolvia TODO lo demas como «rechazada-por-el-servidor» con el texto crudo del navegador. Hoy conserva los dos motivos de red.
  const avisoAlEnviar = async (red, mutar) => {
    const s = crearServidor(); const tok = s.emitirRecuperacion("persona-nueva@example.test");
    const env = nuevoEntorno({ servidor: s, hash: `#access_token=${tok}&type=recovery`, ...(mutar ? { mutar } : {}) }); await env.asentar();
    s.red = red; env.doc.getElementById("rcvClave").value = "Clave-Sintetica-9"; env.doc.getElementById("rcvClave2").value = "Clave-Sintetica-9";
    await env.doc.getElementById("rcvForm").disparar("submit"); await env.asentar();
    return env.doc.getElementById("rcvError").textContent;
  };
  const ESPERADO = "Sin conexión con el servidor. Inténtalo otra vez.";
  for (const [nombre, red] of [["red caida", "caida"], ["tiempo agotado", "timeout"]]) test(`[F-FUNC-1 · CERRADO] al enviar la contraseña con ${nombre} se debe avisar «${ESPERADO}»`, async () => {
    assert.equal(await avisoAlEnviar(red), ESPERADO);
  });
  test("verificacion de la prueba: si se RESTAURA la clasificacion anterior (el codigo original, en memoria) el aviso correcto DEJA de aparecer — la prueba SIGUE mordiendo", async () => {
    const original = { auth: (t) => { const r = t.replace('          if (r.motivo === "sin-conexion" || r.motivo === "tiempo-agotado") return mal(r.motivo, r.detalle);\n', ""); assert.notEqual(r, t); return r; } };
    for (const red of ["caida", "timeout"]) assert.notEqual(await avisoAlEnviar(red, { auth: original.auth }), ESPERADO, red);
  });
  test("contraste: al COMPROBAR el enlace (antes de escribir la contraseña) SI se muestra la pantalla «Sin conexión»", async () => {
    const s = crearServidor(); const tok = s.emitirRecuperacion("persona-nueva@example.test"); s.red = "caida";
    const env = nuevoEntorno({ servidor: s, hash: `#access_token=${tok}&type=recovery` }); await env.asentar(); assert.match(env.doc.getElementById("rcvCuerpo").innerHTML, /<b>Sin conexión<\/b>/);
  });
});
