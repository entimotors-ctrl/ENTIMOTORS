// MI-TRABAJO-IOS-PWA-REOPEN (3.14.1): ¿cuándo se muestra «Instala ENTIMOTORS …»? Matriz de arranque con el app.js REAL en vm, para
// los dos productos (Taller y Mi Trabajo). iOS señala «instalada» con navigator.standalone === true (y, según versión, también con
// (display-mode: standalone)); Chrome/Android solo con (display-mode: standalone). Una app instalada abierta desde su icono NUNCA debe
// ver la pantalla de instalación —tampoco al cerrarla y volver a abrirla—; una pestaña normal sí. El atajo «Usar en esta pestaña sin instalar» (antes «Continuar aquí solo para
// pruebas de desarrollo» dura lo que dura la sesión de la pestaña (sessionStorage): al cerrar y reabrir, la pestaña vuelve a la pantalla.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno } from "./helpers/entorno.mjs";

const CASOS = {
  "A/E · iOS: app instalada abierta desde el icono (navigator.standalone, sin display-mode)": { navStandalone: true, displayModeStandalone: false, instalar: false },
  "E · iOS reciente: app instalada (navigator.standalone y display-mode)": { navStandalone: true, displayModeStandalone: true, instalar: false },
  "D · Android/Chrome: app instalada (display-mode, sin navigator.standalone)": { navStandalone: "ausente", displayModeStandalone: true, instalar: false },
  "B · iOS: pestaña normal de Safari (navigator.standalone === false)": { navStandalone: false, displayModeStandalone: false, instalar: true },
  "C · Chrome/Android: pestaña normal (sin navigator.standalone)": { navStandalone: "ausente", displayModeStandalone: false, instalar: true },
};

/** Arranca el app.js real con la pantalla de instalación «activa» como en el HTML y dice si quedó a la vista. */
/* Las dos señales se fijan por separado ANTES de cargar los scripts (el entorno por defecto las da ambas a la vez):
   navStandalone "ausente" = el navegador no tiene navigator.standalone (Chrome, Firefox, Android). */
function abrir({ producto, navStandalone, displayModeStandalone, storage = {}, sesion = {} }) {
  const env = crearEntorno({ producto, storage,
    preparar: (e) => {
      if (navStandalone === "ausente") delete e.win.navigator.standalone; else e.win.navigator.standalone = navStandalone;
      e.win.matchMedia = (q) => ({ matches: /display-mode:\s*standalone/.test(q) ? displayModeStandalone : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      e.doc.getElementById("gateInstall").classList.add("active");
      for (const [k, v] of Object.entries(sesion)) e.almacenSesion.setItem(k, v);
    } });
  return { env, pantallaInstalar: env.doc.getElementById("gateInstall").classList.contains("active"), isStandalone: env.win.isStandalone() };
}

for (const producto of ["admin", "mecanico"]) {
  const nombre = producto === "mecanico" ? "Mi Trabajo" : "Taller";
  describe(`${nombre} · pantalla «Instala …» según cómo se abre`, () => {
    for (const [caso, c] of Object.entries(CASOS)) {
      test(`${caso} → ${c.instalar ? "SÍ" : "NO"} muestra la pantalla de instalación`, () => {
        const r = abrir({ producto, ...c });
        assert.equal(r.isStandalone, !c.instalar, "isStandalone()");
        assert.equal(r.pantallaInstalar, c.instalar, "pantalla de instalación");
      });
    }
    test("app instalada (iOS y Android): abrir → cerrar → volver a abrir, tres veces, NUNCA ve la pantalla de instalación", () => {
      for (const senal of [{ navStandalone: true, displayModeStandalone: false }, { navStandalone: "ausente", displayModeStandalone: true }]) {
        const persistente = {};   // localStorage sobrevive al cierre; sessionStorage no
        for (let vez = 1; vez <= 3; vez++) {
          const r = abrir({ producto, ...senal, storage: { ...persistente } });
          assert.equal(r.pantallaInstalar, false, `apertura ${vez} (${JSON.stringify(senal)})`);
          Object.assign(persistente, r.env.almacen.volcado());
        }
      }
    });
    test("F · pestaña normal con el atajo de pruebas: entra mientras dura la pestaña; al cerrarla y reabrirla vuelve la pantalla (el atajo NO es un bypass permanente)", () => {
      const tab = { navStandalone: false, displayModeStandalone: false };
      assert.equal(abrir({ producto, ...tab, sesion: { enti_dev_bypass: "1" } }).pantallaInstalar, false, "misma pestaña con el atajo");
      assert.equal(abrir({ producto, ...tab }).pantallaInstalar, true, "reabierta: sessionStorage vacío");
      const r = abrir({ producto, ...tab, sesion: { enti_dev_bypass: "1" } });
      assert.equal(Object.keys(r.env.almacen.volcado()).includes("enti_dev_bypass"), false, "el atajo nunca se guarda en localStorage");
    });
  });
}

describe("mutantes: la prueba detecta las causas de código posibles", () => {
  const conMutante = (mutar, c) => { const env = crearEntorno({ producto: "mecanico", mutar,
    preparar: (e) => { if (c.navStandalone === "ausente") delete e.win.navigator.standalone; else e.win.navigator.standalone = c.navStandalone;
      e.win.matchMedia = (q) => ({ matches: /display-mode:\s*standalone/.test(q) ? c.displayModeStandalone : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      e.doc.getElementById("gateInstall").classList.add("active"); } });
    return env.doc.getElementById("gateInstall").classList.contains("active"); };
  const iosInstalada = { navStandalone: true, displayModeStandalone: false };
  test("si isStandalone() solo mirara display-mode (sin navigator.standalone), la app instalada en iOS vería la pantalla: DETECTADO", () => {
    assert.equal(conMutante({}, iosInstalada), false, "original");
    assert.equal(conMutante({ app: (t) => t.replace(' || window.navigator.standalone === true', '') }, iosInstalada), true, "mutante");
  });
  test("si isStandalone() solo mirara navigator.standalone, la app instalada en Android vería la pantalla: DETECTADO", () => {
    const android = { navStandalone: "ausente", displayModeStandalone: true };
    assert.equal(conMutante({}, android), false, "original");
    assert.equal(conMutante({ app: (t) => t.replace('window.matchMedia("(display-mode: standalone)").matches || ', '') }, android), true, "mutante");
  });
  test("si el atajo de pruebas se guardara en localStorage, una pestaña normal dejaría de pedir instalación para siempre: DETECTADO", () => {
    const tab = { navStandalone: false, displayModeStandalone: false };
    const m = { app: (t) => t.replace('function devBypassed() { return sessionStorage.getItem("enti_dev_bypass") === "1"; }', 'function devBypassed() { return true; }') };
    assert.equal(conMutante({}, tab), true, "original");
    assert.equal(conMutante(m, tab), false, "mutante (bypass permanente)");
  });
});
