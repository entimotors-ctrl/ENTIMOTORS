/* ============================================================================
 * ENTIMOTORS OS · sync-fotos.js  (3.14.0 · SYNC-6)
 * ----------------------------------------------------------------------------
 * Fotos de órdenes para Mi Trabajo: comprimir, subir a Supabase Storage y, sin
 * conexión, encolar en `blobs` (entimotors_sync, sync-db.js — la tabla ya
 * existía desde SYNC-4, pensada exactamente para esto) hasta poder subirlas.
 *
 * NUNCA base64 en la cola ni en la nube: se sube el Blob tal cual (IndexedDB lo
 * guarda con structured clone, sin pasar por texto) y solo el PATH resultante
 * viaja después a `ordenes.fotos` por avanzar_orden_tecnico (sync-6-*.sql).
 *
 * LA SUBIDA ES EL CHEQUEO DE ASIGNACIÓN. No hay una llamada aparte para
 * comprobar "¿sigue siendo mía esta orden?": la política de Storage
 * (taller_sube_media, SYNC-2) usa mecanico_asignado_a_orden(), así que un
 * PUT a una orden reasignada o ya cerrada lo rechaza el servidor con 403,
 * que aquí se traduce en clase "permiso" — la cola no reintenta eso, lo
 * marca "rechazada" y lo deja a la vista (mismo criterio que sync-engine.js:
 * permiso/validacion no se arreglan reintentando).
 * ==========================================================================*/
(function (global) {
  "use strict";

  var MAX_LADO = 1600;
  var CALIDAD = 0.82;
  var TIMEOUT_MS = 30000;

  function uuid() { return (global.SyncDB && global.SyncDB.uuid) ? global.SyncDB.uuid() : (Date.now() + "-" + Math.random().toString(36).slice(2)); }

  /** Redimensiona/comprime una foto de orden. Usa createImageBitmap (respeta la orientación EXIF
      con {imageOrientation:"from-image"} en los navegadores que lo soportan) y cae a <img> si no existe. */
  function comprimir(file, opciones) {
    opciones = opciones || {};
    var ladoMax = opciones.ladoMax || MAX_LADO, calidad = opciones.calidad || CALIDAD;
    function aBlobDesdeFuente(fuente, anchoOrig, altoOrig) {
      var escala = Math.min(1, ladoMax / Math.max(anchoOrig, altoOrig));
      var w = Math.max(1, Math.round(anchoOrig * escala)), h = Math.max(1, Math.round(altoOrig * escala));
      var lienzo = document.createElement("canvas");
      lienzo.width = w; lienzo.height = h;
      var ctx = lienzo.getContext("2d");
      ctx.drawImage(fuente, 0, 0, w, h);
      return new Promise(function (resolve, reject) {
        lienzo.toBlob(function (blob) {
          if (!blob) { reject(new Error("No se pudo comprimir la imagen")); return; }
          resolve({ blob: blob, ancho: w, alto: h });
        }, "image/jpeg", calidad);
      });
    }
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(file, { imageOrientation: "from-image" })
        .then(function (bmp) { return aBlobDesdeFuente(bmp, bmp.width, bmp.height).then(function (r) { bmp.close && bmp.close(); return r; }); })
        .catch(function () { return comprimirConImg(file, ladoMax, calidad); });
    }
    return comprimirConImg(file, ladoMax, calidad);
  }
  function comprimirConImg(file, ladoMax, calidad) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var escala = Math.min(1, ladoMax / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * escala)), h = Math.max(1, Math.round(img.naturalHeight * escala));
        var lienzo = document.createElement("canvas");
        lienzo.width = w; lienzo.height = h;
        lienzo.getContext("2d").drawImage(img, 0, 0, w, h);
        lienzo.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          if (!blob) { reject(new Error("No se pudo comprimir la imagen")); return; }
          resolve({ blob: blob, ancho: w, alto: h });
        }, "image/jpeg", calidad);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen")); };
      img.src = url;
    });
  }

  /** ordenes/<orden_uuid>/<foto_uuid>.jpg — SINGLE_WORKSHOP, sin taller_id (SYNC-6 sección 10). */
  function ruta(ordenUid, fotoUid) { return "ordenes/" + ordenUid + "/" + (fotoUid || uuid()) + ".jpg"; }

  function conTimeout(promesaFetch, ms) {
    return Promise.race([
      promesaFetch,
      new Promise(function (_, rej) { setTimeout(function () { rej({ falloRed: true, abortado: true, mensaje: "tiempo agotado" }); }, ms); }),
    ]);
  }

  /** PUT directo a Supabase Storage. Nunca lanza: {ok:true,status} | {ok:false, clase, status, mensaje}. */
  function subir(o) {
    var f = o.fetch || global.fetch;
    var url = String(o.baseUrl || "").replace(/\/+$/, "") + "/storage/v1/object/" + encodeURIComponent(o.bucket) + "/" + o.path.split("/").map(encodeURIComponent).join("/");
    function unaVez(token) {
      return conTimeout(f(url, {
        method: "PUT",
        headers: { apikey: o.anonKey, Authorization: "Bearer " + token, "Content-Type": o.blob.type || "image/jpeg", "x-upsert": "false", "cache-control": "3600" },
        body: o.blob,
      }), o.timeout || TIMEOUT_MS).catch(function (e) { return { falloRed: true, mensaje: e && e.mensaje }; });
    }
    return Promise.resolve(o.obtenerToken ? o.obtenerToken() : null).then(function (token) {
      return unaVez(token).then(function (r) {
        if (r && r.falloRed) return { ok: false, clase: "red", status: 0, mensaje: r.mensaje || "sin red" };
        if (r.status === 401 && o.refrescar) {
          return Promise.resolve(o.refrescar()).then(function (ok) {
            if (!ok) return { ok: false, clase: "auth", status: 401, mensaje: "La sesión caducó." };
            return Promise.resolve(o.obtenerToken()).then(unaVez).then(function (r2) { return clasificarStorage(r2); });
          });
        }
        return clasificarStorage(r);
      });
    });
  }
  function clasificarStorage(r) {
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
    var clase = r.status === 401 ? "auth" : r.status === 403 ? "permiso" : r.status === 409 ? "conflicto"
      : r.status === 429 ? "limite" : (r.status === 408 || r.status >= 500) ? "servidor" : "validacion";
    return { ok: false, clase: clase, status: r.status, mensaje: "No se pudo subir la foto (" + r.status + ")" };
  }

  /** URL firmada de UNA foto (SYNC-6 sección 10: nunca una URL pública permanente). Nunca lanza. */
  function firmar(o) {
    var f = o.fetch || global.fetch;
    var base = String(o.baseUrl || "").replace(/\/+$/, "");
    var url = base + "/storage/v1/object/sign/" + encodeURIComponent(o.bucket) + "/" + o.path.split("/").map(encodeURIComponent).join("/");
    function unaVez(token) {
      return conTimeout(f(url, {
        method: "POST", headers: { apikey: o.anonKey, Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: o.expiresIn || 3600 }),
      }), o.timeout || TIMEOUT_MS).then(function (res) {
        return res.text().then(function (txt) {
          var cuerpo = null; if (txt) { try { cuerpo = JSON.parse(txt); } catch (e) { /* respuesta no-json */ } }
          return { status: res.status, cuerpo: cuerpo };
        });
      }).catch(function (e) { return { falloRed: true, mensaje: e && e.mensaje }; });
    }
    function armar(r) {
      if (r.status >= 200 && r.status < 300 && r.cuerpo && r.cuerpo.signedURL) {
        var ruta = r.cuerpo.signedURL;
        var abs = /^https?:\/\//i.test(ruta) ? ruta : base + "/storage/v1" + ruta.replace(/^\/storage\/v1/, "");
        return { ok: true, url: abs };
      }
      return { ok: false, clase: r.status === 403 ? "permiso" : r.status === 401 ? "auth" : "servidor", status: r.status };
    }
    return Promise.resolve(o.obtenerToken ? o.obtenerToken() : null).then(function (token) {
      return unaVez(token).then(function (r) {
        if (r && r.falloRed) return { ok: false, clase: "red", mensaje: r.mensaje || "sin red" };
        if (r.status === 401 && o.refrescar) {
          return Promise.resolve(o.refrescar()).then(function (ok) {
            if (!ok) return { ok: false, clase: "auth" };
            return Promise.resolve(o.obtenerToken()).then(unaVez).then(armar);
          });
        }
        return armar(r);
      });
    });
  }

  /* ---------------- cola offline (bd.blobs, sync-db.js) ---------------- */
  /** Encola una foto pendiente. NUNCA base64: se guarda el Blob tal cual. */
  function encolar(bd, o) {
    var registro = {
      entidad: "ordenes", uid: o.ordenUid, operation_id: uuid(), estado: "pendiente",
      archivo: o.blob, nombre_archivo: o.nombreArchivo || (uuid() + ".jpg"),
      creado_en: Date.now(), intentos: 0,
    };
    return bd.blobs.agregar(registro).then(function (id) { registro.id = id; return registro; });
  }
  function pendientes(bd, ordenUid) {
    return bd.blobs.todos().then(function (todos) {
      return todos.filter(function (b) { return b.entidad === "ordenes" && (!ordenUid || b.uid === ordenUid) && b.estado === "pendiente"; });
    });
  }

  /** Sube en orden cada blob pendiente de una orden. Nunca revienta: cada intento fallido queda registrado.
      o = {bd, ordenUid, baseUrl, anonKey, bucket, obtenerToken, refrescar, alSubirUna(path, registro)}. */
  function procesarCola(o) {
    return pendientes(o.bd, o.ordenUid).then(function (lista) {
      var resultado = { subidas: 0, rechazadas: 0, pendientes: 0 };
      var cadena = Promise.resolve();
      lista.forEach(function (b) {
        cadena = cadena.then(function () {
          var path = ruta(b.uid, b.operation_id);
          return subir({
            baseUrl: o.baseUrl, anonKey: o.anonKey, bucket: o.bucket || "entimotors-taller", path: path, blob: b.archivo,
            obtenerToken: o.obtenerToken, refrescar: o.refrescar, fetch: o.fetch,
          }).then(function (r) {
            if (r.ok) {
              return o.bd.blobs.borrar(b.id).then(function () {
                resultado.subidas++;
                return o.alSubirUna ? o.alSubirUna(path, b) : null;
              });
            }
            if (r.clase === "permiso" || r.clase === "validacion") {
              resultado.rechazadas++;
              return o.bd.transaccion(["blobs"], "readwrite", function (t) {
                var reg = Object.assign({}, b, { estado: "rechazada", error: r.mensaje });
                return t.put("blobs", reg);
              });
            }
            resultado.pendientes++; // red/servidor/auth: se reintenta en el próximo procesarCola()
          });
        });
      });
      return cadena.then(function () { return resultado; });
    });
  }

  global.SyncFotos = { comprimir: comprimir, ruta: ruta, subir: subir, firmar: firmar, encolar: encolar, pendientes: pendientes, procesarCola: procesarCola };
})(typeof window !== "undefined" ? window : this);
