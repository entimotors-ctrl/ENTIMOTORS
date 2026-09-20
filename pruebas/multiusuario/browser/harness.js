// Punto de entrada de la pagina de prueba. La lanza browser-runner.mjs con ?run=…&suite=…&browser=…&muerto=<puerto sin nadie>.
// Carga la suite pedida, la ejecuta DENTRO del navegador y va enviando cada caso a /__test_result (localhost). Al terminar avisa «fin».
const q = new URLSearchParams(location.search);
const run = q.get("run"), suite = q.get("suite"), navegador = q.get("browser"), muerto = Number(q.get("muerto") || 0);
const estado = document.getElementById("estado");
const enviar = (o) => fetch("/__test_result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run, suite, navegador, ...o }) }).catch(() => {});

// suite → { modulo, modo }. «modo» distingue las variantes de una misma suite.
const SUITES = {
  "app": { modulo: "suite-app.js", modo: "taller" },
  "mt": { modulo: "suite-app.js", modo: "mitrabajo" },
  "mut": { modulo: "suite-mutantes.js", modo: "taller" },
  "pwa-taller": { modulo: "suite-pwa.js", modo: "taller" },
  "pwa-mt": { modulo: "suite-pwa.js", modo: "mitrabajo" },
  "pwa-upg": { modulo: "suite-pwa.js", modo: "upgrade" },
};

window.addEventListener("error", (e) => enviar({ tipo: "log", nivel: "harness-error", texto: String(e.message) }));
window.addEventListener("unhandledrejection", (e) => enviar({ tipo: "log", nivel: "harness-rechazo", texto: String((e.reason && e.reason.message) || e.reason) }));

try {
  const def = SUITES[suite];
  if (!def) throw new Error(`suite desconocida: ${suite}`);
  estado.textContent = `QA en navegador real · ${suite} · ${navigator.userAgent}`;
  const mod = await import(`/__h/helpers/${def.modulo}`);
  await mod.correr({ enviar, run, suite, navegador, muerto, modo: def.modo, userAgent: navigator.userAgent });
} catch (e) {
  enviar({ tipo: "caso", grupo: "harness", nombre: "HARNESS (excepcion no controlada)", estado: "FAIL", detalle: String((e && e.stack) || e).slice(0, 600) });
} finally {
  enviar({ tipo: "fin" });
  estado.textContent += "\nfin";
}
