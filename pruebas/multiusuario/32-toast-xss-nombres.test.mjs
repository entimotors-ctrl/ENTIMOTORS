// TOAST-XSS (3.15.1) — REGRESION DE SEGURIDAD: un nombre escrito por un usuario NO controla marcado en el aviso (toast).
// Hasta 3.15.0, toast() de app.js asignaba `<span class="dot …"></span>${msg}` a innerHTML SIN escapar, y varias llamadas
// interpolaban nombres de usuario: cliente («…quedó registrado como cliente», presupuesto por WhatsApp) y repuesto (carrito,
// stock, «se muestra en la web»), que llegan también por CSV importado y por sincronización desde otro dispositivo. Un nombre
// como <img src=x onerror=…> ejecutaba código en la sesión de quien viera el aviso (el token de sesión vive en localStorage).
// Arreglo: toast() escapa su argumento una sola vez para TODAS las llamadas. Propiedad obligatoria: lo que llega al sumidero
// es EXACTAMENTE su <span> + el mensaje escapado; ningún elemento nuevo; quien mira LEE el texto tal cual. No se ejecuta JS.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { escaparHtml, marcadoPeligroso } from "./helpers/dom.mjs";
import { leer } from "./helpers/entorno.mjs";
import { nuevoEntorno, como, dbFalsa } from "./helpers/flujos.mjs";
import { UUID } from "./helpers/supabase-mock.mjs";

const PAYLOADS = [
  ["img/onerror", "<img src=x onerror=alert(1)>"],
  ["svg/onload", "<svg onload=alert(1)>"],
  ["romper atributo", `"'><svg onload=alert(1)>`],
  ["script", "<script>alert(1)</script>"],
  ["iframe/javascript:", '<iframe src="javascript:alert(1)"></iframe>'],
  ["entidades ya codificadas", "&lt;img src=x onerror=alert(1)&gt;"],
  ["caracteres", `a<b>c&d"e'f`],
];
const NORMALES = ["Aceite 20W-50", "Llanta 90/90-18", "José Pérez", "Tom & Jerry", "Filtro <K&N>"];
// Las plantillas REALES de app.js que interpolan un nombre de usuario (se comprueba abajo que siguen existiendo tal cual).
const PLANTILLAS = [
  ["carrito", (n) => `"${n}" agregado al carrito`, "toast(`\"${item.nombre}\" agregado al carrito`);"],
  ["cliente nuevo", (n) => `«${n}» quedó registrado como cliente`, "toast(`«${nombre}» quedó registrado como cliente`); }"],
  ["presupuesto por WhatsApp", (n) => `WhatsApp abierto con el presupuesto para ${n} — falta pulsar enviar`, "toast(`WhatsApp abierto con el presupuesto para ${cliente.nombre} — falta pulsar enviar`);"],
  ["stock insuficiente", (n) => `Solo hay 2 en stock de "${n}"`, 'toast(`Solo hay ${r.cantidad} en stock de "${r.nombre}"`, "off");'],
];

async function entorno(mutar) {
  const env = nuevoEntorno(mutar ? { mutar: { app: mutar } } : {});
  como(env, { origen: "supabase", perfilId: UUID(9), nombre: "Cajero", rol: "cajero", activo: true }); dbFalsa(env, {});
  return env;
}
const toastsHtml = (env) => env.doc.sumideros.filter((s) => /^<span class="dot /.test(s.html)).map((s) => s.html);
const etiquetas = (html) => html.match(/<\/?[A-Za-z!?][^>]*>/g) || [];
const textoVisible = (env, html) => { const d = env.doc.createElement("div"); d.innerHTML = html; return d.textContent; };

async function violaciones(nombre, mutar) {
  const mal = [];
  for (const [donde, plantilla] of PLANTILLAS) for (const kind of ["on", "off"]) {
    const env = await entorno(mutar); const msg = plantilla(nombre);
    env.win.toast(msg, kind); const t = toastsHtml(env);
    if (t.length !== 1) { mal.push(`${donde}: ${t.length} toasts`); continue; }
    const v = [];
    if (JSON.stringify(etiquetas(t[0])) !== JSON.stringify([`<span class="dot ${kind}">`, "</span>"])) v.push(`etiquetas ${JSON.stringify(etiquetas(t[0]))}`);
    if (marcadoPeligroso(t[0]).length) v.push(`marcado activo: ${[...new Set(marcadoPeligroso(t[0]))].join(", ")}`);
    if (t[0] !== `<span class="dot ${kind}"></span>${escaparHtml(msg)}`) v.push("no llego escapado exactamente una vez");
    if (textoVisible(env, t[0]) !== msg) v.push(`se leeria «${textoVisible(env, t[0])}»`);
    if (v.length) mal.push(`${donde}/${kind}: ${v.join("; ")}`);
  }
  return mal;
}

describe("TOAST-XSS · un nombre de cliente o repuesto NO llega como marcado al aviso", () => {
  for (const [nombre, payload] of PAYLOADS) test(`${nombre} → el sumidero recibe solo su <span> + el mensaje escapado`, async () => {
    assert.deepEqual(await violaciones(payload), []);
  });
  test("nombres normales (acentos, «/», «&», «<K&N>») se leen EXACTAMENTE igual que antes", async () => {
    for (const n of NORMALES) assert.deepEqual(await violaciones(n), [], n);
  });
  test("los avisos de texto fijo no cambian ni un caracter", async () => {
    const env = await entorno(); env.win.toast("Repuesto agregado"); env.win.toast("Sin conexión: el mensaje queda pendiente y se envía solo al volver la red", "off");
    assert.deepEqual(toastsHtml(env), ['<span class="dot on"></span>Repuesto agregado', '<span class="dot off"></span>Sin conexión: el mensaje queda pendiente y se envía solo al volver la red']);
  });
});

describe("guardas estaticas sobre app.js", () => {
  const app = leer("app.js");
  test("las plantillas probadas siguen existiendo tal cual en app.js (si cambian, esta prueba se actualiza a conciencia)", () => {
    for (const [donde, , literal] of PLANTILLAS) assert.ok(app.includes(literal), donde);
  });
  test("ninguna llamada a toast() escapa por su cuenta (toast ya escapa: seria escape DOBLE, «&amp;lt;»)", () => {
    const dobles = [...app.matchAll(/toast\(([^;]*)\);/g)].map((m) => m[1]).filter((a) => /\besc\(/.test(a));
    assert.deepEqual(dobles, []);
  });
  test("ningun aviso de app.js le pasa HTML a proposito a toast() (no hay etiquetas literales en sus argumentos)", () => {
    const conHtml = [...app.matchAll(/toast\(([^;]*)\);/g)].map((m) => m[1]).filter((a) => /<\/?[a-z][a-z0-9]*[\s>\/]/i.test(a.replace(/<K&N>/g, "")));
    assert.deepEqual(conHtml, []);
  });
});

describe("mutantes (en memoria; ningun archivo real se toca)", () => {
  const cambiar = (de, a) => (t) => { const r = t.split(de).join(a); if (r === t) throw new Error(`mutante sin efecto: ${de}`); return r; };
  test("linea base: con el codigo REAL la propiedad se cumple para todos los payloads", async () => {
    for (const [, p] of PAYLOADS) assert.deepEqual(await violaciones(p), []);
  });
  test("mutante: toast() vuelve a pintar el mensaje SIN escapar (3.15.0) → la propiedad FALLA", async () => {
    const mut = cambiar("${esc(msg)}`;", "${msg}`;");
    assert.notDeepEqual(await violaciones(PAYLOADS[0][1], mut), []);
  });
  test("mutante: toast() escapa DOS veces → los nombres normales con «&» se leerian mal", async () => {
    const mut = cambiar("${esc(msg)}`;", "${esc(esc(msg))}`;");
    assert.notDeepEqual(await violaciones("Tom & Jerry", mut), []);
  });
});
