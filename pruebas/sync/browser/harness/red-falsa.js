// Interruptor de RED para las pruebas: con __red.caida = true, fetch falla como sin conexión. Cuenta y registra las peticiones a la nube.
// caerTras = N: deja pasar N peticiones más y después la red cae (null = sin efecto).
window.__red = { caida: false, registro: [], soloSiguientes: 0, perderRespuesta: 0, caerTras: null };
(function () {
  var real = window.fetch.bind(window);
  window.fetch = function (url, init) {
    var u = String(url && url.url ? url.url : url), m = (init && init.method) || "GET";
    if (u.indexOf(window.__pila.restUrl) === 0) {
      window.__red.registro.push({ m: m, u: u.replace(window.__pila.restUrl, ""), t: Date.now(), b: init && init.body ? String(init.body) : null });
      if (window.__red.caida) return Promise.reject(new TypeError("Failed to fetch"));
      if (window.__red.caerTras !== null) { if (window.__red.caerTras <= 0) return Promise.reject(new TypeError("Failed to fetch")); window.__red.caerTras--; }
      if (window.__red.soloSiguientes > 0) { window.__red.soloSiguientes--; return Promise.reject(new TypeError("Failed to fetch")); }
      if (window.__red.perderRespuesta > 0) { window.__red.perderRespuesta--; return real(url, init).then(function () { throw new TypeError("Failed to fetch"); }); }
    }
    return real(url, init);
  };
})();
