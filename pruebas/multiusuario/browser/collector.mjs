// Colector de resultados del QA en navegador real. Vive SOLO en memoria: cada pagina de prueba (dentro de Chrome/Firefox)
// hace POST a /__test_result en 127.0.0.1 y este objeto acumula los casos. Nada se escribe en disco.
export function crearColector() {
  const corridas = new Map();
  const dame = (run) => {
    if (!corridas.has(run)) corridas.set(run, { casos: [], logs: [], fin: null, esperando: [] });
    return corridas.get(run);
  };
  return {
    recibir(cuerpo) {
      if (!cuerpo || typeof cuerpo.run !== "string") return;
      const c = dame(cuerpo.run);
      if (cuerpo.tipo === "caso") c.casos.push(cuerpo);
      else if (cuerpo.tipo === "log") c.logs.push(cuerpo);
      else if (cuerpo.tipo === "fin") { c.fin = cuerpo; c.esperando.splice(0).forEach((f) => f(true)); }
    },
    /** Resuelve true cuando la pagina avisa que termino, false si vence el plazo. */
    esperarFin(run, ms) {
      const c = dame(run);
      if (c.fin) return Promise.resolve(true);
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), ms);
        c.esperando.push((v) => { clearTimeout(t); resolve(v); });
      });
    },
    resultado: (run) => dame(run),
  };
}
