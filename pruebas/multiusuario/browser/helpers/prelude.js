/* PRELUDE del harness. El servidor local lo inyecta EN MEMORIA como PRIMER script de index.html / panel-tecnico.html, es decir,
   ANTES de que se cargue una sola linea del runtime. No forma parte del runtime ni se sirve nunca a produccion.

   Hace tres cosas, todas contra la ventana que lo carga (un iframe del mismo origen que la pagina del harness):
     1. RED CERRADA: fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon solo permiten (a) los dos hosts SINTETICOS,
        que atiende el mock del harness, y (b) 127.0.0.1. Cualquier otro destino se RECHAZA y se anota como
        UNEXPECTED_EXTERNAL_REQUEST.
     2. CAPTURA de console.* / window.onerror / unhandledrejection en H.errores y H.consola.
     3. Puentes de entorno: bypass propio del codigo para la pantalla «instalar» (sessionStorage enti_dev_bypass) y un
        navigator.serviceWorker de mentira que solo ANOTA el registro (la parte de SW real se prueba en otro origen). */
(function () {
  "use strict";
  var W = window;
  var H = W.parent && W.parent !== W ? W.parent.__H : null;
  if (!H) { throw new Error("prelude: no hay harness padre (__H)"); }
  var esc = H.escenario || {};

  // ── 2. captura ──
  var texto = function (args) { return Array.prototype.map.call(args, function (a) { try { return typeof a === "string" ? a : (a && a.message) || JSON.stringify(a); } catch (e) { return String(a); } }).join(" ").slice(0, 400); };
  ["log", "info", "warn", "error"].forEach(function (nivel) {
    var original = console[nivel];
    console[nivel] = function () {
      try { H.consola.push(nivel + ": " + texto(arguments)); if (nivel === "error") H.errores.push({ tipo: "console.error", texto: texto(arguments) }); } catch (e) { /* nunca romper la pagina */ }
      return original.apply(console, arguments);
    };
  });
  W.addEventListener("error", function (e) { H.errores.push({ tipo: "onerror", texto: String(e.message || "") + " @" + String(e.filename || "").split("/").pop() + ":" + e.lineno }); });
  W.addEventListener("unhandledrejection", function (e) { var r = e.reason; H.errores.push({ tipo: "unhandledrejection", texto: String((r && (r.message || r.stack)) || r).slice(0, 400) }); });

  // ── 1. red cerrada ──
  var HOSTS_SINTETICOS = { "synthetic-test.supabase.co": 1, "api.synthetic.test": 1 };
  var externo = function (via, url) { H.externos.push({ via: via, destino: String(url).slice(0, 160) }); };
  var resolver = function (entrada) { try { return new URL(typeof entrada === "string" ? entrada : (entrada && entrada.url) || String(entrada), W.location.href); } catch (e) { return null; } };
  var nativoFetch = W.fetch.bind(W);
  W.fetch = function (entrada, init) {
    var u = resolver(entrada);
    if (!u) return Promise.reject(new TypeError("URL invalida"));
    if (HOSTS_SINTETICOS[u.host]) {
      var metodo = String((init && init.method) || (entrada && entrada.method) || "GET").toUpperCase();
      return Promise.resolve().then(function () {
        if (H.interceptor) { var r = H.interceptor(u, metodo, init); if (r !== undefined) return r; }
        return H.servidor.fetch(u.href, init);
      });
    }
    if (u.hostname === "127.0.0.1") return nativoFetch(entrada, init);
    externo("fetch", u.origin + u.pathname);
    return Promise.reject(new TypeError("UNEXPECTED_EXTERNAL_REQUEST bloqueado por el harness"));
  };
  var xhrOpen = W.XMLHttpRequest && W.XMLHttpRequest.prototype.open;
  if (xhrOpen) W.XMLHttpRequest.prototype.open = function (m, url) {
    var u = resolver(url);
    if (!u || (u.hostname !== "127.0.0.1" && !HOSTS_SINTETICOS[u.host])) { externo("xhr", url); throw new DOMException("UNEXPECTED_EXTERNAL_REQUEST bloqueado por el harness", "NetworkError"); }
    if (HOSTS_SINTETICOS[u.host]) { externo("xhr-sintetico-no-soportado", url); throw new DOMException("el harness no atiende XHR sintetico", "NetworkError"); }
    return xhrOpen.apply(this, arguments);
  };
  ["WebSocket", "EventSource"].forEach(function (nombre) {
    var Nativo = W[nombre]; if (!Nativo) return;
    W[nombre] = function (url) { var u = resolver(url); if (!u || (u.hostname !== "127.0.0.1")) { externo(nombre, url); throw new DOMException("UNEXPECTED_EXTERNAL_REQUEST bloqueado por el harness", "SecurityError"); } return new Nativo(url, arguments[1]); };
    W[nombre].prototype = Nativo.prototype;
  });
  if (navigator.sendBeacon) navigator.sendBeacon = function (url) { externo("sendBeacon", url); return false; };

  // ── 3. entorno ──
  try { W.sessionStorage.setItem("enti_dev_bypass", "1"); } catch (e) { /* bypass propio del codigo para «Instala la app» */ }
  W.__xss = 0;
  if (esc.sinRed) { try { Object.defineProperty(navigator, "onLine", { configurable: true, get: function () { return false; } }); } catch (e) {} }
  if (!esc.swReal) {
    try {
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
        controller: null,
        register: function (url, opciones) { H.swRegistros.push({ url: String(url), updateViaCache: opciones && opciones.updateViaCache }); return new Promise(function () { /* nunca resuelve */ }); },
        addEventListener: function () {}, removeEventListener: function () {},
        getRegistration: function () { return Promise.resolve(undefined); }, getRegistrations: function () { return Promise.resolve([]); },
      } });
    } catch (e) { /* si el motor no deja, la prueba lo notara por H.swRegistros vacio */ }
  }
})();
