// IndexedDB EN MEMORIA, minima: solo lo que usan las funciones de app.js que se ejecutan aqui
// (db.transaction([...]) con add/put/get/getAll, y tx()/openCursor de DB.getAll). No es un IndexedDB completo:
// no modela versiones, indices, ni fallos de cuota. Sirve para comprobar QUE se guarda y en que tabla.
export function idbFalsa(inicial = {}) {
  const tablas = new Map(Object.entries(inicial).map(([n, filas]) => [n, new Map(filas.map((f) => [f.id, structuredClone(f)]))]));
  const contadores = new Map();
  const tabla = (n) => { if (!tablas.has(n)) tablas.set(n, new Map()); return tablas.get(n); };
  const siguiente = (n) => { const t = tabla(n); const s = (contadores.get(n) ?? Math.max(0, ...t.keys())) + 1; contadores.set(n, s); return s; };
  const transacciones = [];

  function crearTransaccion(nombres) {
    const lista = Array.isArray(nombres) ? nombres : [nombres];
    let pendientes = 0, terminada = false;
    const t = { oncomplete: null, onerror: null, onabort: null, error: null };
    const revisar = () => setImmediate(() => { if (!pendientes && !terminada) { terminada = true; t.oncomplete && t.oncomplete({ target: t }); } });
    const solicitar = (fn) => {
      const r = { result: undefined, error: null, onsuccess: null, onerror: null };
      pendientes++;
      setImmediate(() => { r.result = fn(r); r.onsuccess && r.onsuccess({ target: r }); pendientes--; revisar(); });
      return r;
    };
    t.objectStore = (n) => {
      if (!lista.includes(n)) throw new Error(`la transaccion no incluye ${n}`);
      const T = tabla(n);
      return {
        add: (v) => solicitar(() => { const id = v.id ?? siguiente(n); T.set(id, { ...structuredClone(v), id }); return id; }),
        put: (v) => solicitar(() => { T.set(v.id, structuredClone(v)); return v.id; }),
        get: (id) => solicitar(() => { const x = T.get(id); return x ? structuredClone(x) : undefined; }),
        delete: (id) => solicitar(() => { T.delete(id); }),
        getAll: () => solicitar(() => [...T.values()].map((x) => structuredClone(x))),
        openCursor: () => {
          const filas = [...T.values()]; let i = 0;
          const r = { result: null, onsuccess: null, onerror: null };
          const paso = () => setImmediate(() => { r.result = i < filas.length ? { value: structuredClone(filas[i]), continue: () => { i++; paso(); } } : null; r.onsuccess && r.onsuccess({ target: r }); });
          paso(); return r;
        },
      };
    };
    transacciones.push(lista);
    return t;
  }
  const db = { transaction: (n) => crearTransaccion(n), close() {} };
  return { db, filas: (n) => [...tabla(n).values()], transacciones };
}
