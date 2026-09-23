// Monta un motor de sincronización con la base indicada. Token y refresco los controla la prueba (window.__token / window.__tokensRefresco).
window.__montar = async function (o) {
  o = o || {};
  var bd = await SyncDB.abrir({ nombre: o.nombreBd || "entimotors_sync" });
  var rest = SyncRest.crear({
    baseUrl: window.__pila.restUrl, anonKey: window.__pila.anonKey, timeoutMs: o.timeoutMs || 15000,
    getToken: async function () { return window.__token || null; },
    refrescar: async function () {
      var l = window.__tokensRefresco || [];
      if (!l.length) return false;
      window.__token = l.shift(); window.__refrescos = (window.__refrescos || 0) + 1; return true;
    },
  });
  // SYNC-5: con usarMappersReales, el motor de la prueba usa taller-demo/sync-mappers.js
  // tal cual (los mismos que carga index.html), no la copia reducida mappers-prueba.js.
  var mappers = (o.usarMappersReales && window.ENTIMOTORS_SYNC_MAPPERS) || window.__mappers;
  var motor = SyncEngine.crearMotor({
    bd: bd, rest: rest, mappers: mappers, orden: o.orden || ["clientes", "motos"],
    sesion: function () { return window.__sesion || null; },
    habilitado: function () { return window.__habilitado !== false; },
    locks: o.sinLocks ? null : undefined, autoenvio: !!o.autoenvio, aleatorio: function () { return 0.5; },
    // SYNC-8: opcionales (sin ellos, el motor se comporta como en SYNC-4..7B)
    validarPerfil: !!o.validarPerfil, leaseMs: o.leaseMs, pausaAuthMs: o.pausaAuthMs,
  });
  window.__bd = bd; window.__rest = rest; window.__motor = motor; window.__eventos = [];
  motor.onCambio(function (e) { window.__eventos.push(e.tipo); });
  return { device: await bd.deviceId() };
};
