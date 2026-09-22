// Mappers de PRUEBA (clientes y motos con llave foránea). Los reales llegan en SYNC-5 (taller-demo/sync-mappers.js).
window.__mappers = {
  clientes: {
    entidad: "clientes", tabla: "clientes", store: "clientes", columnas: ["nombre", "telefono", "creado_en"], tiempos: ["creado_en"], fks: [],
    aCloud: function (l) { return { nombre: l.nombre, telefono: l.telefono || null, creado_en: l.creadoEn ? new Date(l.creadoEn).toISOString() : undefined }; },
    aLocal: function (r) { return { nombre: r.nombre, telefono: r.telefono, creadoEn: r.creado_en ? new Date(r.creado_en).getTime() : null }; },
  },
  motos: {
    entidad: "motos", tabla: "motos", store: "motos", columnas: ["marca", "modelo", "placa", "km"], tiempos: [], fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }],
    aCloud: function (l) { return { marca: l.marca || null, modelo: l.modelo || null, placa: l.placa || null, km: l.km == null ? 0 : l.km }; },
    aLocal: function (r) { return { marca: r.marca, modelo: r.modelo, placa: r.placa, km: r.km }; },
  },
};
