// OBS-9 · PLAN B (4E-C7-FIX-B) — RECUPERACION MEDIADA POR EL ADMINISTRADOR, de punta a punta y TODO SINTETICO (sin Supabase real, sin correo, sin red):
//   admin genera el enlace en «Usuarios y equipo» → la persona abre el enlace en SU producto (Taller o Mi Trabajo) → recovery.js le deja elegir contraseña
//   → el enlace queda gastado → entra con la contraseña nueva (la vieja ya no sirve) → acceso segun su rol.
// Ademas: el texto de ayuda visible en el login (OBS-9 parte visual) y que NO se prometa correo ni se cree formulario de correo.
// El destino (Taller o Mi Trabajo) lo decide el SERVIDOR por rol (probado en 21-backend-enlace-recuperacion); aqui el «servidor» falso hace lo mismo y
// se comprueba que cada persona aterriza y entra en el producto que le corresponde.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { leer } from "./helpers/entorno.mjs";
import { nuevoEntorno, enviarLogin, activo, CUENTAS } from "./helpers/flujos.mjs";
import { crearServidor, URL_API, UUID } from "./helpers/supabase-mock.mjs";

const INDEX = leer("index.html"), HELP = "¿Olvidaste tu contraseña? Pide al administrador que te genere un enlace de recuperación.";
const ORIGEN = { taller: "https://taller.example.test/entimotors-os", mitrabajo: "https://mitrabajo.example.test" };
const CLAVE_NUEVA = "Clave-Nueva-Sintetica-77";
const nodos = (el) => [el, ...((el.children || []).flatMap(nodos))];

/** «Servidor» de la prueba: hace lo que hace el api-server real (destino por ROL, enlace de un solo uso) usando el Supabase falso. */
function apiDelAdmin(servidor, personas) {
  servidor.api = async (metodo, ruta) => {
    if (metodo === "GET") return { status: 200, body: { usuarios: personas.map((p, i) => ({ id: p.uid, nombre: p.perfil.nombre, correo: p.correo, telefono: "", rol: p.perfil.rol, activo: p.perfil.activo, esUsted: false })) } };
    const m = /\/api\/admin\/usuarios\/([^/]+)\/enlace$/.exec(ruta); if (metodo !== "POST" || !m) return null;
    const p = personas.find((x) => x.uid === m[1]); if (!p || !p.perfil.activo) return { status: 409, body: { error: "Esa cuenta está dada de baja." } };
    const origen = p.perfil.rol === "mecanico" ? ORIGEN.mitrabajo : ORIGEN.taller;
    return { status: 200, body: { enlaceParaEstablecerClave: `${origen}/index.html#access_token=${servidor.emitirRecuperacion(p.correo)}&type=recovery&expires_in=3600`, nota: "x" } };
  };
}
/** El admin abre Usuarios, pulsa «Generar enlace» en la fila de `persona` y devuelve el enlace que se ve en la caja. */
async function generarComoAdmin(servidor, persona) {
  apiDelAdmin(servidor, [{ uid: UUID(1), correo: CUENTAS.adminActivo.correo, perfil: { nombre: "Admin", rol: "admin", activo: true } }, persona]);
  const admin = nuevoEntorno({ servidor, producto: "admin", cuenta: CUENTAS.adminActivo, sesionGuardada: null, apiUrl: URL_API }); await admin.asentar();
  admin.win.showConfirm = async () => true; await admin.win.PantallaUsuarios.render(); await admin.asentar();
  const fila = admin.doc.querySelectorAll(".u-enlace").find((b) => b.dataset.id === persona.uid); assert.ok(fila, "el botón «Generar enlace» de la persona");
  await fila.disparar("click"); await admin.asentar();
  const campo = nodos(admin.doc.getElementById("cardEnlaceRecuperacion")).find((n) => String(n.tagName).toLowerCase() === "input"); assert.ok(campo && campo.value, "la caja debe mostrar el enlace");
  return { admin, enlace: campo.value };
}
const persona = (n, rol, correo, clave) => ({ uid: UUID(n), correo, clave, perfil: { nombre: `Persona ${n}`, rol, activo: true } });

// ═════════════════════════════ AYUDA EN EL LOGIN ═════════════════════════════
describe("OBS-9 · ayuda visible en el login (sin formulario de correo y sin prometer correo)", () => {
  const login = () => { const a = INDEX.indexOf('<div class="gate" id="gateLogin">'), b = INDEX.indexOf("<!-- GATE R:"); assert.ok(a > 0 && b > a); return INDEX.slice(a, b); };
  test("el login trae el texto de ayuda EXACTO, dentro de la tarjeta y DESPUÉS del formulario", () => {
    const l = login(); assert.ok(l.includes(`<p class="desc" id="loginAyuda"`) && l.includes(`>${HELP}</p>`)); assert.ok(l.indexOf("</form>") < l.indexOf('id="loginAyuda"'), "la ayuda va debajo del formulario");
    assert.equal((INDEX.match(/id="loginAyuda"/g) || []).length, 1);
  });
  test("NO se creó ningún formulario ni campo nuevo: el login sigue con SOLO usuario y contraseña", () => {
    const l = login(); assert.equal((l.match(/<form\b/g) || []).length, 1); assert.deepEqual([...l.matchAll(/<input\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]), ["loginUser", "loginPass"]);
    assert.equal((l.match(/<button\b/g) || []).length, 1, "un solo botón: «Entrar»");
  });
  test("no promete correo: ni «te enviaremos», ni «revisa tu correo», ni «recuperar por correo»", () => {
    const texto = login().replace(/<[^>]*>/g, " "); assert.ok(!/enviar[eé]mos|te enviamos|revisa tu (correo|bandeja)|por correo|correo de recuperaci|enlace por correo/i.test(texto), texto.replace(/\s+/g, " ").slice(0, 200));
  });
  test("Mi Trabajo hereda el mismo texto (el build solo cambia titulo, script de config-local e instalar; no toca el login)", () => {
    const sh = leer("hacer-build-mecanicos.sh"); assert.ok(!/loginAyuda|gateLogin|Olvidaste/.test(sh), "el build no debe tocar el texto del login");
  });
  test("el CSS de la ayuda cabe en móvil y escritorio: es un <p class=desc> con fuente chica dentro de la tarjeta (sin ancho fijo ni nowrap)", () => {
    const m = /<p class="desc" id="loginAyuda" style="([^"]*)">/.exec(INDEX); assert.ok(m); assert.ok(!/width|white-space|position|overflow/.test(m[1]), m[1]); assert.match(m[1], /font-size:\.8rem/);
  });
});

// ═════════════════════════════ EXTREMO A EXTREMO ═════════════════════════════
describe("OBS-9 · recuperación mediada, extremo a extremo (sintético)", () => {
  test("CAJERO → Taller: el admin genera el enlace, la persona lo abre en el Taller, elige contraseña, el enlace se gasta, la vieja ya no sirve y entra como cajero", async () => {
    const s = crearServidor(); const c = persona(4, "cajero", "cajero@example.test", "clave-sintetica-5A");
    const { enlace } = await generarComoAdmin(s, c);
    const url = new URL(enlace); assert.equal(url.origin + url.pathname.replace(/\/index\.html$/, ""), ORIGEN.taller, "un cajero aterriza en el Taller"); assert.equal(new URLSearchParams(url.hash.slice(1)).get("type"), "recovery");
    // la persona abre el enlace: recovery.js lo recibe (el arranque NO abre ni la instalación ni el login)
    const persona1 = nuevoEntorno({ servidor: s, producto: "admin", hash: url.hash }); await persona1.asentar();
    assert.equal(activo(persona1, "gateRecovery"), true); assert.equal(persona1.doc.getElementById("rcvIntro").textContent, "Elige tu contraseña para entrar a ENTIMOTORS OS.");
    assert.match(persona1.doc.getElementById("rcvCuerpo").innerHTML, /Cuenta: <b>cajero@example\.test<\/b>/); assert.equal(persona1.startApp.length, 0);
    persona1.doc.getElementById("rcvClave").value = CLAVE_NUEVA; persona1.doc.getElementById("rcvClave2").value = CLAVE_NUEVA; await persona1.doc.getElementById("rcvForm").disparar("submit"); await persona1.asentar();
    assert.match(persona1.doc.getElementById("rcvCuerpo").innerHTML, /Contraseña establecida correctamente\./); assert.deepEqual(s.clavesEstablecidas, [CLAVE_NUEVA.length]);
    assert.equal(persona1.win.Auth.estado().conSesion, false, "poner la contraseña NO inicia sesión sola");
    // el enlace era de UN solo uso
    const reabre = nuevoEntorno({ servidor: s, producto: "admin", hash: url.hash }); await reabre.asentar(); assert.match(reabre.doc.getElementById("rcvCuerpo").innerHTML, /Enlace no válido o expirado/); assert.match(reabre.doc.getElementById("rcvCuerpo").innerHTML, /administrador/);
    // la contraseña VIEJA ya no entra; la nueva sí, como cajero
    const viejo = nuevoEntorno({ servidor: s, producto: "admin", storageExtra: { enti_modo_datos: "blanco" } }); await viejo.asentar(); const rv = await enviarLogin(viejo, "cajero@example.test", "clave-sintetica-5A"); assert.equal(rv.error, "Correo o contraseña incorrectos."); assert.equal(viejo.startApp.length, 0);
    const nuevo = nuevoEntorno({ servidor: s, producto: "admin", storageExtra: { enti_modo_datos: "blanco" } }); await nuevo.asentar(); const rn = await enviarLogin(nuevo, "cajero@example.test", CLAVE_NUEVA);
    assert.equal(rn.error, ""); assert.equal(nuevo.startApp.length, 1); assert.equal(nuevo.startApp[0][0].rol, "cajero"); assert.equal(nuevo.startApp[0][0].origen, "supabase");
  });

  test("MECÁNICO → Mi Trabajo: el enlace apunta a Mi Trabajo, se abre allí, elige contraseña y entra a Mi Trabajo como mecánico", async () => {
    const s = crearServidor(); const m = persona(3, "mecanico", "mecanico@example.test", "clave-sintetica-3A");
    const { enlace } = await generarComoAdmin(s, m); const url = new URL(enlace);
    assert.equal(url.origin, ORIGEN.mitrabajo, "un mecánico aterriza en Mi Trabajo, no en el Taller");
    const persona1 = nuevoEntorno({ servidor: s, producto: "mecanico", hash: url.hash }); await persona1.asentar();
    assert.equal(activo(persona1, "gateRecovery"), true); assert.equal(persona1.doc.getElementById("rcvIntro").textContent, "Elige tu contraseña para entrar a ENTIMOTORS OS.");
    persona1.doc.getElementById("rcvClave").value = CLAVE_NUEVA; persona1.doc.getElementById("rcvClave2").value = CLAVE_NUEVA; await persona1.doc.getElementById("rcvForm").disparar("submit"); await persona1.asentar();
    assert.match(persona1.doc.getElementById("rcvCuerpo").innerHTML, /Contraseña establecida correctamente\./);
    const nuevo = nuevoEntorno({ servidor: s, producto: "mecanico", storageExtra: { enti_modo_datos: "blanco" } }); await nuevo.asentar(); const r = await enviarLogin(nuevo, "mecanico@example.test", CLAVE_NUEVA);
    assert.equal(r.error, ""); assert.equal(nuevo.startApp.length, 1); assert.equal(nuevo.startApp[0][0].rol, "mecanico");
  });

  test("el destino por rol es el que hace falta: si un enlace de CAJERO llegara a Mi Trabajo, la contraseña se puede poner pero el login allí se RECHAZA (por eso el servidor decide el destino)", async () => {
    const s = crearServidor(); const c = persona(4, "cajero", "cajero@example.test", "x");
    const { enlace } = await generarComoAdmin(s, c); const url = new URL(enlace);
    const mal = nuevoEntorno({ servidor: s, producto: "mecanico", hash: url.hash }); await mal.asentar(); mal.doc.getElementById("rcvClave").value = CLAVE_NUEVA; mal.doc.getElementById("rcvClave2").value = CLAVE_NUEVA; await mal.doc.getElementById("rcvForm").disparar("submit"); await mal.asentar();
    assert.match(mal.doc.getElementById("rcvCuerpo").innerHTML, /Contraseña establecida correctamente\./);
    const login = nuevoEntorno({ servidor: s, producto: "mecanico", storageExtra: { enti_modo_datos: "blanco" } }); await login.asentar(); const r = await enviarLogin(login, "cajero@example.test", CLAVE_NUEVA);
    assert.equal(login.startApp.length, 0, "Mi Trabajo no admite a un cajero"); assert.notEqual(r.error, "");
  });

  test("una persona INACTIVA no obtiene enlace (el servidor lo rechaza) y no hay caja de resultado", async () => {
    const s = crearServidor(); const baja = { ...persona(6, "mecanico", "baja@example.test", "x"), perfil: { nombre: "Persona 6", rol: "mecanico", activo: false } };
    apiDelAdmin(s, [{ uid: UUID(1), correo: "admin-activo@example.test", perfil: { nombre: "Admin", rol: "admin", activo: true } }, baja]);
    const admin = nuevoEntorno({ servidor: s, producto: "admin", cuenta: CUENTAS.adminActivo, sesionGuardada: null, apiUrl: URL_API }); await admin.asentar(); admin.win.showConfirm = async () => true; await admin.win.PantallaUsuarios.render(); await admin.asentar();
    assert.equal(admin.doc.querySelectorAll(".u-enlace").length, 0, "ni siquiera se ofrece el botón");
  });

  test("todo el recorrido es local: el Supabase falso no vio ningún host ajeno ni ninguna llamada inesperada, y ninguna contraseña sintética quedó en el almacenamiento", async () => {
    const s = crearServidor(); const c = persona(4, "cajero", "cajero@example.test", "x"); const { admin, enlace } = await generarComoAdmin(s, c); const url = new URL(enlace);
    const p = nuevoEntorno({ servidor: s, producto: "admin", hash: url.hash }); await p.asentar(); p.doc.getElementById("rcvClave").value = CLAVE_NUEVA; p.doc.getElementById("rcvClave2").value = CLAVE_NUEVA; await p.doc.getElementById("rcvForm").disparar("submit"); await p.asentar();
    assert.deepEqual(s.ajenas, []); assert.deepEqual(s.inesperadas, []);
    for (const env of [admin, p]) { const t = JSON.stringify({ l: env.almacen.volcado(), s: env.almacenSesion.volcado(), c: env.consola }); assert.ok(!t.includes(CLAVE_NUEVA), "la contraseña llegó a un almacén o a la consola"); assert.ok(!t.includes("type=recovery"), "un enlace de recuperación llegó a un almacén o a la consola"); }
  });
});
