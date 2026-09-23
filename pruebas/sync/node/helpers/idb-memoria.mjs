// SYNC-8 · IndexedDB EN MEMORIA, mínima, para correr taller-demo/sync-db.js REAL (y el motor encima) dentro de Node.
// Cubre exactamente lo que usa sync-db.js: open/onupgradeneeded, createObjectStore(keyPath, autoIncrement),
// createIndex (clave simple o compuesta, unique), transaction(tablas, modo) con get/put/add/delete/getAll/clear e
// index().get/getAll, oncomplete/onerror/onabort y abort() con vuelta atrás. Las transacciones readwrite de una misma
// base se SERIALIZAN (como en el navegador), así dos «pestañas» que comparten la fábrica compiten de verdad.
// No es una implementación general: es un doble de prueba fiel para este uso.

const clon = (v) => (v === undefined ? undefined : structuredClone(v));
const claveTexto = (k) => JSON.stringify(k);
function comparar(a, b) {
  const ta = typeof a, tb = typeof b;
  if (ta !== tb) return ta === "number" ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function extraer(obj, keyPath) { return Array.isArray(keyPath) ? keyPath.map((k) => obj[k]) : obj[keyPath]; }
const tarde = (f) => setTimeout(f, 0);

function evento(destino, tipo) { const f = destino["on" + tipo]; if (typeof f === "function") f.call(destino, { target: destino }); }

export function crearFabrica() {
  const bases = new Map();   // nombre → {version, stores: Map(nombre → {keyPath, auto, sig, filas: Map(clave texto → {k, v}), indices})}

  function abrirBase(meta) {
    // la cola que serializa las transacciones readwrite es de la BASE, no de la conexión: dos pestañas (dos conexiones)
    // compiten por el mismo turno, como en el navegador
    if (!meta.cola) meta.cola = Promise.resolve();
    const db = {
      get objectStoreNames() { return [...meta.stores.keys()]; },
      get version() { return meta.version; },
      close() {},
      createObjectStore(nombre, o = {}) {
        const st = { keyPath: o.keyPath, auto: !!o.autoIncrement, sig: 1, filas: new Map(), indices: new Map() };
        meta.stores.set(nombre, st);
        return { createIndex(n, kp, oi = {}) { st.indices.set(n, { keyPath: kp, unique: !!oi.unique }); } };
      },
      transaction(nombres, modo = "readonly") {
        const lista = Array.isArray(nombres) ? nombres : [nombres];
        for (const n of lista) if (!meta.stores.has(n)) throw new Error("NotFoundError: " + n);
        const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
        let pendientes = 0, terminada = false, abortada = false, arrancada = modo !== "readwrite";
        const esperaTurno = [];
        // copia para volver atrás si se aborta: se toma cuando la transacción EMPIEZA (tras su turno), no al pedirla
        let copia = null;
        const tomarCopia = () => new Map(lista.map((n) => { const s = meta.stores.get(n); return [n, { sig: s.sig, filas: new Map([...s.filas].map(([k, v]) => [k, clon(v)])) }]; }));
        let liberar = () => {};
        if (modo === "readwrite") {
          const turno = meta.cola.then(() => new Promise((r) => { liberar = r; }));
          const previa = meta.cola; meta.cola = turno;
          previa.then(() => { copia = tomarCopia(); arrancada = true; esperaTurno.splice(0).forEach((f) => f()); });
        }
        function cerrarSiToca() {
          tarde(() => {
            if (terminada || abortada || pendientes > 0 || !arrancada) return;
            terminada = true; liberar(); evento(tx, "complete");
          });
        }
        function abortar(err) {
          if (terminada || abortada) return;
          abortada = true; tx.error = err || new Error("AbortError");
          if (copia) for (const [n, c] of copia) { const s = meta.stores.get(n); s.sig = c.sig; s.filas = c.filas; }
          liberar(); tarde(() => { evento(tx, "error"); evento(tx, "abort"); });
        }
        function pedir(fn) {
          const req = { result: undefined, error: null, onsuccess: null, onerror: null };
          pendientes++;
          const correr = () => tarde(() => {
            if (abortada) { pendientes--; return; }
            try { req.result = fn(); pendientes--; evento(req, "success"); }
            catch (e) { pendientes--; req.error = e; evento(req, "error"); abortar(e); return; }
            cerrarSiToca();
          });
          if (arrancada) correr(); else esperaTurno.push(correr);
          return req;
        }
        function almacen(nombre) {
          const s = () => meta.stores.get(nombre);
          const valores = () => [...s().filas.values()].sort((a, b) => comparar(a.k, b.k)).map((x) => clon(x.v));
          const chequearUnicos = (v, clave) => {
            for (const [n, ix] of s().indices) {
              if (!ix.unique) continue;
              const iv = extraer(v, ix.keyPath);
              if (iv === undefined) continue;
              for (const f of s().filas.values()) if (claveTexto(f.k) !== claveTexto(clave) && claveTexto(extraer(f.v, ix.keyPath)) === claveTexto(iv)) throw new Error("ConstraintError: " + nombre + "." + n);
            }
          };
          const escribir = (valor, soloNuevo) => {
            if (modo !== "readwrite") throw new Error("ReadOnlyError");
            const v = clon(valor), st = s();
            let clave = extraer(v, st.keyPath);
            if ((clave === undefined || clave === null) && st.auto) { clave = st.sig; v[st.keyPath] = clave; }
            if (typeof clave === "number" && st.auto && clave >= st.sig) st.sig = clave + 1;
            if (clave === undefined || clave === null) throw new Error("DataError: sin clave");
            if (soloNuevo && st.filas.has(claveTexto(clave))) throw new Error("ConstraintError: clave repetida");
            chequearUnicos(v, clave);
            st.filas.set(claveTexto(clave), { k: clave, v });
            return clave;
          };
          return {
            get: (k) => pedir(() => { const f = s().filas.get(claveTexto(k)); return f ? clon(f.v) : undefined; }),
            getAll: () => pedir(() => valores()),
            put: (v) => pedir(() => escribir(v, false)),
            add: (v) => pedir(() => escribir(v, true)),
            delete: (k) => pedir(() => { if (modo !== "readwrite") throw new Error("ReadOnlyError"); s().filas.delete(claveTexto(k)); }),
            clear: () => pedir(() => { if (modo !== "readwrite") throw new Error("ReadOnlyError"); s().filas.clear(); }),
            index: (n) => {
              const ix = () => s().indices.get(n);
              const iguales = (k) => valores().filter((v) => claveTexto(extraer(v, ix().keyPath)) === claveTexto(k));
              return { get: (k) => pedir(() => iguales(k)[0]), getAll: (k) => pedir(() => iguales(k)) };
            },
          };
        }
        tx.objectStore = (n) => { if (!lista.includes(n)) throw new Error("NotFoundError: " + n + " fuera de la transacción"); return almacen(n); };
        tx.abort = () => abortar(new Error("AbortError"));
        // una transacción sin peticiones también termina
        if (arrancada) cerrarSiToca(); else esperaTurno.push(() => cerrarSiToca());
        return tx;
      },
    };
    return db;
  }

  return {
    open(nombre, version = 1) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      tarde(() => {
        let meta = bases.get(nombre);
        const nueva = !meta || version > meta.version;
        if (!meta) { meta = { version, stores: new Map() }; bases.set(nombre, meta); }
        req.result = abrirBase(meta);
        if (nueva) { meta.version = version; evento(req, "upgradeneeded"); }
        evento(req, "success");
      });
      return req;
    },
    databases: async () => [...bases.keys()].map((name) => ({ name, version: bases.get(name).version })),
    _bases: bases,
  };
}
