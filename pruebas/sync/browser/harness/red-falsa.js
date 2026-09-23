// Interruptor de RED para las pruebas: con __red.caida = true, fetch falla como sin conexión. Cuenta y registra las peticiones a la nube.
// caerTras = N: deja pasar N peticiones más y después la red cae (null = sin efecto).
// SYNC-8: respuestas = [{ruta (texto que debe contener la URL), metodo?, status, cuerpo, aplicar?}] → respuesta HTTP SINTÉTICA
// (5xx, 4xx) una vez; con aplicar:true la petición SÍ llega al servidor y solo se cambia la respuesta. colgar = N: las N
// siguientes quedan colgadas hasta que el cliente las aborte (tiempo agotado). El registro anota si llevaba Authorization.
window.__red = { caida: false, registro: [], soloSiguientes: 0, perderRespuesta: 0, caerTras: null, respuestas: [], colgar: 0 };
(function () {
  var real = window.fetch.bind(window);
  window.fetch = function (url, init) {
    var u = String(url && url.url ? url.url : url), m = (init && init.method) || "GET";
    if (u.indexOf(window.__pila.restUrl) === 0) {
      var cab = (init && init.headers) || {};
      window.__red.registro.push({ m: m, u: u.replace(window.__pila.restUrl, ""), t: Date.now(), b: init && init.body ? String(init.body) : null, a: !!(cab.Authorization || cab.authorization) });
      if (window.__red.caida) return Promise.reject(new TypeError("Failed to fetch"));
      var iR = window.__red.respuestas.findIndex(function (x) { return u.indexOf(x.ruta) >= 0 && (!x.metodo || x.metodo === m); });
      if (iR >= 0) {
        var x = window.__red.respuestas.splice(iR, 1)[0];
        var sint = function () { return new Response(x.cuerpo === undefined ? "" : JSON.stringify(x.cuerpo), { status: x.status, headers: { "Content-Type": "application/json" } }); };
        return x.aplicar ? real(url, init).then(sint) : Promise.resolve(sint());
      }
      if (window.__red.colgar > 0) {
        window.__red.colgar--;
        return new Promise(function (ok, mal) { var s = init && init.signal; if (s) s.addEventListener("abort", function () { var e = new Error("abortado"); e.name = "AbortError"; mal(e); }); });
      }
      if (window.__red.caerTras !== null) { if (window.__red.caerTras <= 0) return Promise.reject(new TypeError("Failed to fetch")); window.__red.caerTras--; }
      if (window.__red.soloSiguientes > 0) { window.__red.soloSiguientes--; return Promise.reject(new TypeError("Failed to fetch")); }
      if (window.__red.perderRespuesta > 0) { window.__red.perderRespuesta--; return real(url, init).then(function () { throw new TypeError("Failed to fetch"); }); }
    }
    return real(url, init);
  };
})();
