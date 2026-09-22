/* ============================================================================
 * ENTIMOTORS OS · sync-mappers.js  (3.14.0 · SYNC-6)
 * ----------------------------------------------------------------------------
 * Mappers REALES para el motor de sincronización (SyncEngine, sync-engine.js):
 * clientes, motos, citas, categorias_inv, cotizaciones, ordenes. Cada mapper
 * describe, para UNA entidad, cómo se traduce entre el objeto local (mismos
 * nombres que siempre usó app.js) y la fila de la nube (columnas en snake_case).
 *
 * ORDENES (SYNC-6) ES DOS MAPPERS DISTINTOS SEGÚN EL BUILD, NO UNO
 *   SYNC-2 cerró el acceso DIRECTO del mecánico a `ordenes`/`orden_items`: solo
 *   admin/cajero tienen GRANT de columnas sobre la tabla real. Por eso este
 *   archivo lee window.ENTIMOTORS_BUILD (build-target.js, cargado ANTES que
 *   este script — ver el orden de <script> en index.html) y arma un mapper
 *   distinto para cada producto:
 *     · Taller (admin/cajero): tabla = "ordenes" (la tabla real), de solo
 *       cabecera técnica — cliente/moto/estado/falla/diagnóstico/notas/
 *       checklist/mecánico/origen/km/garantía. NO incluye fotos, items, ni
 *       nada de dinero (finalizada, margen, tipo_cobro, metodo_pago, abono*,
 *       credito_id): eso sigue siendo 100% local contra entimotors_os_demo,
 *       tal cual antes de SYNC-6 — conectarlo a las RPC de agregar_item_orden/
 *       finalizar_orden es trabajo de SYNC-7, no de este. Así, cada
 *       DB.save("ordenes", …) del flujo de cobro (que sí toca esos campos)
 *       genera un diff vacío para la nube y no intenta un PATCH que la base
 *       rechazaría por falta de privilegio en esas columnas.
 *     · Mi Trabajo (mecánico): tabla = "rpc/ordenes_tecnico_mias", la función
 *       SECURITY DEFINER de sync-6-mecanicos-ordenes.sql — PostgREST sirve una
 *       función STABLE sin argumentos por GET exactamente como una vista, así
 *       que el motor la pagina con el mismo cursor (updated_at, id) sin saber
 *       que es una función. `columnas` va vacío a propósito: el mecánico NUNCA
 *       empuja cambios por aquí (columnasNube()/escribir() nunca se llaman
 *       para él — ver guardarSincronizado() en app.js), solo por la RPC
 *       avanzar_orden_tecnico, que sync-engine.js ya sabe encolar con
 *       encolarRpc() (mismo patrón que sync_guardar_items_cotizacion, SYNC-5).
 *       aLocal() sí lee fotos/items porque el mecánico no tiene ninguna otra
 *       fuente local con la que puedan chocar (a diferencia del Taller, que
 *       sigue guardando sus propias fotos en base64 sin sincronizar — ver
 *       ENTIMOTORS-SYNC-3.14-STATE.md, "Pendiente" de SYNC-6, antes de asumir
 *       que el Taller refleja solo cambios de fotos del mecánico).
 *
 * QUÉ NO SE SINCRONIZA TODAVÍA (a propósito, ver ENTIMOTORS-SYNC-3.14-STATE.md)
 *   · motos.foto: solo viaja si YA es una ruta/URL (foto_path, columna con CHECK
 *     "sin base64"). Una foto guardada como base64 se queda local hasta que
 *     exista subida real a Storage — no se sube inline.
 *   · cotizaciones.moto: el snapshot {marca,modelo,placa} de la cabecera NO se
 *     reconstruye en un dispositivo nuevo (solo viaja motoDesc, ya sincronizado
 *     como texto). Reabrir "Editar" en un dispositivo que nunca creó esa
 *     cotización muestra esos tres campos vacíos: no afecta motoDesc ni al total.
 *   · cotizaciones.ordenId / aceptadaEn: la conversión a orden de servicio
 *     (inventario, ordenes) sigue siendo 100% local en esta fase — ordenes e
 *     inventario no están en SYNC-5. Solo el campo `estado` (pendiente/aceptada/
 *     rechazada) viaja, para que otro dispositivo sepa que ya se resolvió.
 *   · cotizaciones.items: NO es una columna de `cotizaciones` (no hay tal
 *     columna) ni una entidad propia del motor (cotizacion_items no tiene
 *     rev/updated_at: SYNC-1 lo dejó así porque es hijo de la cotización). Viaja
 *     por dos caminos que sync-integracion.js combina:
 *       - bajada: PostgREST embebe cotizacion_items en cada fila de
 *         cotizaciones (mapper.select), y aLocal() los transforma en `items`.
 *       - subida: una RPC idempotente (sync_guardar_items_cotizacion, SYNC-5,
 *         mismo patrón sync_op_iniciar/sync_op_guardar que agregar_item_orden)
 *         reemplaza TODOS los renglones. item.inventarioId es un id LOCAL
 *         (entero, propio del dispositivo) — como `inventario` no se sincroniza
 *         todavía, no hay forma de resolverlo a un uid de nube: se manda
 *         inventario_id = null a propósito (limitación conocida, no se inventa
 *         una referencia cruzada que no existe).
 * ==========================================================================*/
(function (global) {
  "use strict";

  function esRuta(v) { return typeof v === "string" && v.length > 0 && !/^data:/i.test(v); }
  // Mismo criterio que build-target.js/app.js (ES_APP_MECANICOS), leído aquí de forma independiente porque
  // este script se carga ANTES que app.js: build-target.js ya corrió, así que window.ENTIMOTORS_BUILD existe.
  var esMecanico = !!(global.ENTIMOTORS_BUILD && global.ENTIMOTORS_BUILD.producto === "mecanico");

  var mappers = {
    clientes: {
      entidad: "clientes", tabla: "clientes", store: "clientes",
      columnas: ["nombre", "telefono"], tiempos: [], fks: [],
      aCloud: function (l) { return { nombre: l.nombre || "", telefono: l.telefono || null }; },
      aLocal: function (r) { return { nombre: r.nombre, telefono: r.telefono || "" }; },
    },

    motos: {
      entidad: "motos", tabla: "motos", store: "motos",
      columnas: ["marca", "modelo", "placa", "km", "cilindraje", "foto_path", "mantenimiento"], tiempos: [],
      fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }],
      aCloud: function (l) {
        return {
          marca: l.marca || null, modelo: l.modelo || null, placa: l.placa || null, km: l.km == null ? 0 : l.km,
          cilindraje: l.cilindraje || null,
          foto_path: esRuta(l.foto) ? l.foto : null,
          mantenimiento: l.mantenimiento || null,
        };
      },
      aLocal: function (r) {
        var campos = { marca: r.marca, modelo: r.modelo, placa: r.placa, km: r.km, cilindraje: r.cilindraje || "", mantenimiento: r.mantenimiento || null };
        // foto NO se toca aquí: si el dispositivo ya tenía una foto local (base64), se conserva tal cual.
        return campos;
      },
    },

    citas: {
      entidad: "citas", tabla: "citas", store: "citas",
      columnas: ["nombre_tmp", "telefono_tmp", "fecha", "hora", "mecanico", "mecanico_id", "motivo", "origen", "estado",
        "cerrada_en", "recordatorio_enviado", "reprogramaciones", "aviso_cliente_wa", "confirmada"],
      tiempos: ["cerrada_en"],
      fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }],
      aCloud: function (l) {
        return {
          nombre_tmp: l.nombreTmp || null, telefono_tmp: l.telefonoTmp || null,
          fecha: l.fecha || null, hora: l.hora || null,
          // mecanico_id YA es el uuid de perfiles (currentUser.perfilId): no pasa por el mapa local↔uid.
          mecanico: l.mecanico || null, mecanico_id: l.mecanicoId || null,
          motivo: l.motivo || null, origen: l.origen || null, estado: l.estado || null,
          cerrada_en: l.cerradaEn || undefined,
          recordatorio_enviado: !!l.recordatorioEnviado,
          reprogramaciones: l.reprogramaciones || [],
          aviso_cliente_wa: l.avisoClienteWA || null,
          confirmada: !!l.confirmada,
        };
      },
      aLocal: function (r) {
        return {
          nombreTmp: r.nombre_tmp || "", telefonoTmp: r.telefono_tmp || "", fecha: r.fecha, hora: r.hora,
          mecanico: r.mecanico || "", mecanicoId: r.mecanico_id || null,
          motivo: r.motivo || "", origen: r.origen || "", estado: r.estado,
          cerradaEn: r.cerrada_en ? new Date(r.cerrada_en).getTime() : null,
          recordatorioEnviado: !!r.recordatorio_enviado,
          reprogramaciones: r.reprogramaciones || [],
          avisoClienteWA: r.aviso_cliente_wa || null,
          confirmada: !!r.confirmada,
        };
      },
    },

    categorias_inv: {
      entidad: "categorias_inv", tabla: "categorias_inv", store: "categorias_inv",
      columnas: ["nombre"], tiempos: [], fks: [],
      aCloud: function (l) { return { nombre: l.nombre || "" }; },
      aLocal: function (r) { return { nombre: r.nombre }; },
    },

    cotizaciones: {
      entidad: "cotizaciones", tabla: "cotizaciones", store: "cotizaciones",
      // embebe los renglones hijos en la misma bajada (ver la nota de cabecera): no hay entidad "cotizacion_items".
      select: "*,cotizacion_items(id,inventario_id,nombre,cantidad,precio)",
      columnas: ["cliente_nombre", "cliente_telefono", "moto_desc", "diagnostico", "notas", "validez_dias", "vence_en", "estado"],
      tiempos: ["vence_en"],
      fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }, { local: "motoId", cloud: "moto_id", entidad: "motos" }],
      aCloud: function (l) {
        return {
          cliente_nombre: l.clienteNombre || "", cliente_telefono: l.clienteTelefono || null,
          moto_desc: l.motoDesc || null, diagnostico: l.diagnostico || null, notas: l.notas || null,
          validez_dias: l.validezDias || 15, vence_en: l.venceISO || null, estado: l.estado || "pendiente",
        };
      },
      aLocal: function (r) {
        var venceMs = r.vence_en ? new Date(r.vence_en).getTime() : null;
        var diasMs = (r.validez_dias || 15) * 86400000;
        return {
          clienteNombre: r.cliente_nombre || "", clienteTelefono: r.cliente_telefono || "",
          motoDesc: r.moto_desc || "", diagnostico: r.diagnostico || "", notas: r.notas || "",
          validezDias: r.validez_dias || 15, venceISO: r.vence_en || null,
          // fechaISO no tiene columna propia: se deriva de vence_en - validez_dias (ver cabecera del archivo).
          fechaISO: venceMs ? new Date(venceMs - diasMs).toISOString() : (r.creado_en || null),
          estado: r.estado || "pendiente",
          items: Array.isArray(r.cotizacion_items) ? r.cotizacion_items.map(function (it) {
            return { nombre: it.nombre, cantidad: Number(it.cantidad), precio: Number(it.precio), inventarioId: null };
          }) : [],
        };
      },
    },
    // SYNC-6: ver la cabecera del archivo — el Taller y Mi Trabajo usan objetos
    // MUY distintos aquí, elegidos una sola vez al cargar el script.
    ordenes: esMecanico ? {
      entidad: "ordenes", tabla: "rpc/ordenes_tecnico_mias", store: "ordenes",
      columnas: [], tiempos: [], fks: [],
      // El mecánico nunca empuja por aquí (ver cabecera): devuelve vacío por si algo llamara a escribir() por error.
      aCloud: function () { return {}; },
      aLocal: function (r) {
        return {
          estado: r.estado, falla: r.falla || "", diagnostico: r.diagnostico || null,
          reparacionNotas: r.reparacion_notas || "", calidadChecklist: r.calidad_checklist || null,
          fotos: Array.isArray(r.fotos) ? r.fotos : [],
          kmSalida: r.km_salida == null ? null : Number(r.km_salida),
          garantiaDias: r.garantia_dias == null ? null : Number(r.garantia_dias),
          mecanico: r.mecanico || "", mecanicoId: r.mecanico_id || null,
          origenTrabajo: r.origen_trabajo || "taller",
          finalizada: !!r.finalizada,
          finalizadoEn: r.finalizado_en ? new Date(r.finalizado_en).getTime() : null,
          entregadoEn: r.entregado_en ? new Date(r.entregado_en).getTime() : null,
          clienteNombre: r.cliente_nombre || "", clienteTelefono: r.cliente_telefono || "",
          motoMarca: r.moto_marca || "", motoModelo: r.moto_modelo || "", motoPlaca: r.moto_placa || "",
          // Solo nombre y cantidad: nunca precio ni costo (SYNC-6 sección 7 — nada financiero para el mecánico).
          items: Array.isArray(r.items) ? r.items.map(function (it) { return { nombre: it.nombre, cantidad: Number(it.cantidad) }; }) : [],
        };
      },
    } : {
      entidad: "ordenes", tabla: "ordenes", store: "ordenes",
      // Sin fotos ni items a propósito (ver cabecera): eso queda 100% local en el Taller hasta SYNC-7.
      columnas: ["estado", "falla", "diagnostico", "reparacion_notas", "calidad_checklist",
        "mecanico", "mecanico_id", "origen_trabajo", "km_salida", "garantia_dias"],
      tiempos: [],
      fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }, { local: "motoId", cloud: "moto_id", entidad: "motos" }],
      aCloud: function (l) {
        return {
          estado: l.estado || "recibido", falla: l.falla || null,
          diagnostico: l.diagnostico || null, reparacion_notas: l.reparacionNotas || null,
          calidad_checklist: l.calidadChecklist || null,
          mecanico: l.mecanico || null, mecanico_id: l.mecanicoId || null,
          origen_trabajo: l.origenTrabajo || "taller",
          km_salida: l.kmSalida == null ? null : l.kmSalida,
          garantia_dias: l.garantiaDias == null ? null : l.garantiaDias,
        };
      },
      aLocal: function (r) {
        return {
          estado: r.estado, falla: r.falla || "", diagnostico: r.diagnostico || null,
          reparacionNotas: r.reparacion_notas || "", calidadChecklist: r.calidad_checklist || null,
          mecanico: r.mecanico || "", mecanicoId: r.mecanico_id || null,
          origenTrabajo: r.origen_trabajo || "taller",
          kmSalida: r.km_salida == null ? null : Number(r.km_salida),
          garantiaDias: r.garantia_dias == null ? null : Number(r.garantia_dias),
        };
      },
    },
  };

  var orden = ["clientes", "motos", "citas", "categorias_inv", "cotizaciones", "ordenes"];

  global.ENTIMOTORS_SYNC_MAPPERS = mappers;
  global.ENTIMOTORS_SYNC_ORDEN = orden;
})(typeof window !== "undefined" ? window : this);
