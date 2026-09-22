/* ============================================================================
 * ENTIMOTORS OS · sync-engine.js  (3.14.0 · SYNC-4)
 * ----------------------------------------------------------------------------
 * Motor de sincronización: cola de salida (outbox), descarga incremental (pull),
 * fusión de cambios y conflictos. Apagado por defecto: sin
 * `ENTIMOTORS_SYNC.enabled === true` no abre ninguna base ni hace ninguna petición.
 *
 * MODELO
 *   · La NUBE manda. La base local (entimotors_sync) es caché + trabajo sin conexión.
 *   · Cada escritura local es UNA transacción: el registro y su operación en la cola.
 *   · Cada operación lleva un op_id (idempotencia) y la revisión de la que partió.
 *   · Actualizar = PATCH solo de los campos cambiados, condicionado a la revisión conocida.
 *     Si la revisión cambió, se fusiona campo a campo (base, mío, servidor): solo hay
 *     conflicto cuando ambos lados cambiaron el MISMO campo a valores distintos.
 *   · Nada se pierde en silencio: un rechazo o un conflicto queda en la cola/lista, a la vista.
 *   · El PIN administrativo y sus autorizaciones NO entran jamás en la cola: esas acciones
 *     solo corren en línea (se rechaza cualquier intento de encolarlas).
 *   · Solo se envían las operaciones del usuario que las creó (created_by lo sella el servidor
 *     con el token de quien envía): las de otra persona esperan a que ella inicie sesión.
 * ==========================================================================*/
(function (global) {
  "use strict";

  /* Acciones que exigen el PIN del administrador: SOLO en línea, jamás en la cola. */
  var ACCIONES_CON_PIN = ["ajustar_stock", "reversar_venta", "registrar_devolucion", "reversar_abono", "reversar_credito", "reversar_caja", "anular_orden"];
  var CLAVES_PROHIBIDAS = /^(pin|pin_nuevo|pin_actual|clave_cuenta|autorizacion_id|p_autorizacion_id|admin_pin)$/i;

  /* ---------------- funciones puras (probadas en Node) ---------------- */
  function estable(v) {
    if (v === undefined) return "null";
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(estable).join(",") + "]";
    return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + estable(v[k]); }).join(",") + "}";
  }
  function igual(a, b) { return estable(a) === estable(b); }

  /** Campos de `nuevo` que difieren de `base` (base puede ser null = todo es nuevo). */
  function diferencias(base, nuevo) {
    var d = {};
    Object.keys(nuevo).forEach(function (k) { if (!base || !igual(base[k], nuevo[k])) d[k] = nuevo[k]; });
    return d;
  }

  /** Fusión de tres vías por campo. base = de donde partí, mios = lo que cambié, servidor = lo que hay ahora. */
  function fusionar(base, mios, servidor) {
    var fusion = {}, conflictos = [];
    Object.keys(mios).forEach(function (c) {
      var s = servidor[c], b = base ? base[c] : undefined, m = mios[c];
      if (igual(s, m)) return;                       // ya está así en el servidor: nada que enviar
      if (igual(s, b)) fusion[c] = m;                // el servidor no lo tocó: mi cambio aplica
      else conflictos.push(c);                       // los dos lo cambiaron a valores distintos
    });
    return { fusion: fusion, conflictos: conflictos };
  }

  /** Espera antes de reintentar: 2 s, 4 s, 8 s… tope 5 min, con variación para no sincronizar todos a la vez. */
  function esperaMs(intentos, aleatorio) {
    var base = Math.min(2000 * Math.pow(2, Math.max(0, intentos - 1)), 300000);
    return Math.round(base * (0.75 + 0.5 * (aleatorio === undefined ? Math.random() : aleatorio)));
  }

  /** Compara dos sellos de tiempo del servidor (texto, microsegundos) sin pasar por Date. -1, 0, 1. */
  function compararTiempo(a, b) {
    var n = function (s) {
      var m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(String(s));
      if (!m) return String(s);
      var frac = (m[3] || "").padEnd(6, "0").slice(0, 6);
      return m[1] + "T" + m[2] + "." + frac;
    };
    var x = n(a), y = n(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  function compararCursor(a, b) {
    var c = compararTiempo(a.t, b.t);
    if (c !== 0) return c;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  /** Rechaza cualquier intento de encolar una acción con PIN o con datos de autorización. */
  function verificarSinPin(nombre, params) {
    if (ACCIONES_CON_PIN.indexOf(nombre) >= 0) throw new Error("La acción «" + nombre + "» requiere el PIN del administrador y solo puede hacerse en línea.");
    (function rec(o, prof) {
      if (!o || typeof o !== "object" || prof > 4) return;
      Object.keys(o).forEach(function (k) {
        if (CLAVES_PROHIBIDAS.test(k)) throw new Error("La cola de sincronización no admite datos de autorización (" + k + ").");
        rec(o[k], prof + 1);
      });
    })(params, 0);
  }

  var puras = { estable: estable, igual: igual, diferencias: diferencias, fusionar: fusionar, esperaMs: esperaMs, compararTiempo: compararTiempo, compararCursor: compararCursor, verificarSinPin: verificarSinPin, ACCIONES_CON_PIN: ACCIONES_CON_PIN };

  /* ---------------- motor ---------------- */
  function crearMotor(o) {
    var bd = o.bd, rest = o.rest, mappers = o.mappers || {};
    var ORDEN = o.orden || Object.keys(mappers);
    var sesion = o.sesion || function () { return null; };
    var reloj = o.ahora || function () { return Date.now(); };
    var nuevoUuid = o.uuid || (global.SyncDB && global.SyncDB.uuid);
    var habilitado = o.habilitado || function () { return !!(global.ENTIMOTORS_SYNC && global.ENTIMOTORS_SYNC.enabled === true); };
    var locks = o.locks !== undefined ? o.locks : (global.navigator && global.navigator.locks);
    var escuchas = [];
    var estadoVivo = { sincronizando: false, ultimaOk: null, ultimoError: null, ultimoPull: null };
    var duenoLease = nuevoUuid();

    function emitir(tipo, datos) { escuchas.slice().forEach(function (f) { try { f({ tipo: tipo, datos: datos }); } catch (e) { /* un oyente roto no rompe la cola */ } }); }
    function apagado() { return !habilitado(); }
    function mapper(entidad) { var m = mappers[entidad]; if (!m) throw new Error("entidad sin mapper: " + entidad); return m; }

    function normalizarTiempo(v) { if (v === null || v === undefined) return null; var d = new Date(v); return isNaN(d.getTime()) ? v : d.toISOString(); }
    /* Instantánea de lo que el cliente escribe (columnas del mapper + llaves foráneas). Del lado del servidor (parcial=false) las
       columnas ausentes valen null; del lado local (parcial=true) una columna `undefined` significa «esta app no la maneja» y se
       omite: así no se envía null a una columna NOT NULL con valor por defecto ni se inventan diferencias. */
    function columnasNube(m, fila, parcial) {
      var s = {}, tiempos = m.tiempos || [];
      var poner = function (c, v) {
        if (v === undefined) { if (parcial) return; v = null; }
        s[c] = tiempos.indexOf(c) >= 0 ? normalizarTiempo(v) : v;
      };
      (m.columnas || []).forEach(function (c) { poner(c, fila[c]); });
      (m.fks || []).forEach(function (f) { poner(f.cloud, fila[f.cloud]); });
      return s;
    }

    /* uid → id local de otra entidad, dentro de la transacción */
    function localDeUid(t, uid) {
      if (uid === null || uid === undefined) return Promise.resolve(null);
      return t.get("mapa", uid).then(function (r) { return r ? r.local_id : null; });
    }
    async function fksALocal(t, m, row) {
      var out = {};
      for (var i = 0; i < (m.fks || []).length; i++) { var f = m.fks[i]; out[f.local] = await localDeUid(t, row[f.cloud]); }
      return out;
    }

    /* ============ ESCRITURA LOCAL (registro + cola en UNA transacción) ============ */
    async function escribir(entidad, local, opciones) {
      if (apagado()) return { omitido: "apagado" };
      opciones = opciones || {};
      var m = mapper(entidad), s = sesion();
      if (!s || !s.uid) throw new Error("No hay sesión: no se puede guardar en modo nube.");
      var dev = await bd.deviceId();
      return bd.transaccion([m.store, "mapa", "outbox"], "readwrite", async function (t) {
        var previo = local.id !== undefined && local.id !== null ? await t.get(m.store, local.id) : null;
        var uid = (previo && previo.uid) || local.uid || nuevoUuid();
        var ops = previo ? await t.todosPorIndice("outbox", "by_registro", [entidad, uid]) : [];
        var pendientes = ops.filter(function (x) { return x.estado === "pending"; });
        var enCurso = ops.filter(function (x) { return x.estado === "syncing"; });

        if (opciones.borrar) {
          if (!previo) return { id: null, uid: null };
          await t.borrar(m.store, previo.id);
          var insertPend = pendientes.filter(function (x) { return x.kind === "insert"; })[0];
          if (insertPend && !enCurso.length) {                        // nunca llegó a la nube: no hay nada que borrar allá
            for (var i = 0; i < ops.length; i++) await t.borrar("outbox", ops[i].seq);
            return { id: previo.id, uid: uid, descartada: true };
          }
          for (var j = 0; j < pendientes.length; j++) if (pendientes[j].kind !== "delete") await t.borrar("outbox", pendientes[j].seq);
          if (!pendientes.some(function (x) { return x.kind === "delete"; })) {
            await t.add("outbox", { op_id: nuevoUuid(), entidad: entidad, tabla: m.tabla, uid: uid, kind: "delete", cambios: {}, base: previo._base || null, base_rev: previo._rev || 0,
              estado: "pending", intentos: 0, siguiente_en: 0, actor_uid: s.uid, device_id: dev, creado_en: reloj(), error: null });
          }
          return { id: previo.id, uid: uid };
        }

        var fkc = {};
        for (var k = 0; k < (m.fks || []).length; k++) {
          var fk = m.fks[k], v = local[fk.local];
          if (v === undefined || v === null) { fkc[fk.cloud] = null; continue; }
          var mp = await t.porIndice("mapa", "by_local", [fk.entidad, v]);
          if (!mp) throw new Error("La referencia " + fk.local + "=" + v + " no existe en «" + fk.entidad + "».");
          fkc[fk.cloud] = mp.uid;
        }
        var nube = columnasNube(m, Object.assign({}, m.aCloud(local), fkc), true);
        var reg = Object.assign({}, local, { uid: uid, _rev: previo ? previo._rev || 0 : 0, _base: previo ? previo._base || null : null, _pend: true });
        if (reg.id === undefined || reg.id === null) delete reg.id;
        var id = await t.put(m.store, reg);
        if (!previo) await t.put("mapa", { uid: uid, entidad: entidad, local_id: id });

        var insertaPend = pendientes.filter(function (x) { return x.kind === "insert"; })[0];
        var insertEnCurso = enCurso.some(function (x) { return x.kind === "insert"; });
        var updPend = pendientes.filter(function (x) { return x.kind === "update"; })[0];
        var nueva = function (kind, cambios, base, baseRev) {
          return { op_id: nuevoUuid(), entidad: entidad, tabla: m.tabla, uid: uid, kind: kind, cambios: cambios, base: base, base_rev: baseRev,
            estado: "pending", intentos: 0, siguiente_en: 0, actor_uid: s.uid, device_id: dev, creado_en: reloj(), error: null };
        };
        var nuncaSincronizado = !previo || (!previo._base && !(previo._rev > 0));
        if (nuncaSincronizado) {
          var fila = Object.assign({ id: uid, local_id: id, dispositivo: dev }, nube);
          if (insertaPend) { insertaPend.cambios = fila; await t.put("outbox", insertaPend); }
          else if (insertEnCurso) {           // el alta va en camino: esta edición se envía después, ya con la revisión que devuelva la nube
            if (updPend) { updPend.cambios = nube; await t.put("outbox", updPend); } else await t.add("outbox", nueva("update", nube, null, 0));
          } else await t.add("outbox", nueva("insert", fila, null, 0));
        } else if (updPend) {
          var d = diferencias(updPend.base, nube);
          if (Object.keys(d).length) { updPend.cambios = d; await t.put("outbox", updPend); }
          else await t.borrar("outbox", updPend.seq);
        } else {
          var d2 = diferencias(previo._base, nube);
          if (Object.keys(d2).length) await t.add("outbox", nueva("update", d2, previo._base, previo._rev || 0));
        }
        var quedan = await t.todosPorIndice("outbox", "by_registro", [entidad, uid]);
        var pend = quedan.some(function (x) { return x.estado === "pending" || x.estado === "syncing"; });
        if (reg._pend !== pend) { reg._pend = pend; reg.id = id; await t.put(m.store, reg); }
        return { id: id, uid: uid };
      }).then(function (r) { programarEnvio(); emitir("cambio-local", { entidad: entidad }); return r; });
    }

    /* ============ DESCARGA ============ */
    async function aplicarPagina(m, filas, nuevoCursor) {
      var tablas = [m.store, "mapa", "outbox", "cursores"];
      // los padres de las llaves foráneas solo se consultan por el mapa
      return bd.transaccion(tablas, "readwrite", async function (t) {
        for (var i = 0; i < filas.length; i++) {
          var row = filas[i], uid = row.id;
          var mp = await t.get("mapa", uid);
          var local = mp ? await t.get(m.store, mp.local_id) : null;
          var ops = local ? await t.todosPorIndice("outbox", "by_registro", [m.entidad, uid]) : [];
          if (row.deleted_at) {
            if (local) {
              await t.borrar(m.store, local.id);
              for (var q = 0; q < ops.length; q++) if (ops[q].estado === "pending") { ops[q].estado = "conflict"; ops[q].error = "borrado_remoto"; await t.put("outbox", ops[q]); }
            }
            continue;
          }
          if (local && (row.rev || 0) <= (local._rev || 0)) continue;             // ya lo tengo (solapamiento)
          var campos = Object.assign({}, m.aLocal(row), await fksALocal(t, m, row));
          var snap = columnasNube(m, row);
          if (local && ops.some(function (x) { return x.estado === "pending" || x.estado === "syncing" || x.estado === "conflict"; })) {
            // Hay un cambio mío sin enviar: lo mío se queda a la vista y la revisión conocida NO avanza: al enviar,
            // el PATCH condicionado detectará el cambio remoto y lo fusionará campo a campo.
            continue;
          }
          var reg = Object.assign({}, local || {}, campos, { uid: uid, _rev: row.rev || 0, _base: snap, _pend: false });
          if (local) reg.id = local.id; else if (mp) reg.id = mp.local_id; else delete reg.id;
          var id = await t.put(m.store, reg);
          if (!mp) await t.put("mapa", { uid: uid, entidad: m.entidad, local_id: id });
        }
        var previo = await t.get("cursores", m.entidad);
        if (!previo || compararCursor(nuevoCursor, previo) > 0) await t.put("cursores", { entidad: m.entidad, t: nuevoCursor.t, id: nuevoCursor.id });
      });
    }

    async function pull(entidad, opciones) {
      if (apagado()) return { omitido: "apagado" };
      var m = mapper(entidad);
      var cur = await bd.cursor.get(entidad);
      // select: para una entidad con hijos embebidos sin cursor propio (SYNC-5: cotizacion_items dentro de
      // cotizaciones), el mapper declara `select` (p. ej. "*,cotizacion_items(...)") y viaja tal cual a PostgREST.
      var r = await rest.paginar(m.tabla, { cursor: cur ? { t: cur.t, id: cur.id } : null, pagina: (opciones && opciones.pagina) || 500, maxPaginas: opciones && opciones.maxPaginas,
        solapamientoMs: opciones && opciones.solapamientoMs, select: m.select, onPagina: function (filas, nuevo) { return aplicarPagina(m, filas, nuevo); } });
      if (!r.ok) return { ok: false, clase: r.clase, codigo: r.codigo, mensaje: r.mensaje, entidad: entidad };
      return { ok: true, total: r.total, completo: r.completo, entidad: entidad };
    }
    async function pullTodo(opciones) {
      var salida = [];
      for (var i = 0; i < ORDEN.length; i++) {
        var r = await pull(ORDEN[i], opciones);
        salida.push(r);
        if (r.ok === false && (r.clase === "red" || r.clase === "auth")) break;
      }
      estadoVivo.ultimoPull = reloj();
      return salida;
    }

    /* ============ ENVÍO ============ */
    function descripcionError(r) { return { clase: r.clase, codigo: r.codigo || "", mensaje: String(r.mensaje || "").slice(0, 300), http: r.status || 0 }; }

    async function aplicarRespuesta(op, row) {
      var m = mapper(op.entidad);
      await bd.transaccion([m.store, "mapa", "outbox"], "readwrite", async function (t) {
        var mp = await t.get("mapa", op.uid);
        var local = mp ? await t.get(m.store, mp.local_id) : null;
        var restantes = (await t.todosPorIndice("outbox", "by_registro", [op.entidad, op.uid])).filter(function (x) { return x.seq !== op.seq; });
        await t.borrar("outbox", op.seq);
        if (!local || !row) return;
        var snap = columnasNube(m, row);
        var hayMas = restantes.some(function (x) { return x.estado === "pending" || x.estado === "syncing" || x.estado === "conflict"; });
        var reg;
        if (!hayMas) {
          reg = Object.assign({}, local, m.aLocal(row), await fksALocal(t, m, row), { _rev: row.rev || 0, _base: snap, _pend: false });
        } else {
          reg = Object.assign({}, local, { _rev: row.rev || 0, _base: snap, _pend: true });
          for (var i = 0; i < restantes.length; i++) if (restantes[i].estado === "pending" && restantes[i].kind !== "insert") { restantes[i].base = snap; restantes[i].base_rev = row.rev || 0; await t.put("outbox", restantes[i]); }
        }
        await t.put(m.store, reg);
      });
    }

    async function marcar(op, estado, extra) {
      var cambios = Object.assign({ estado: estado }, extra || {});
      await bd.outbox.actualizar(op.seq, cambios);
    }

    async function crearConflicto(op, tipo, servidor, campos) {
      await bd.conflictos.agregar({ op_seq: op.seq, op_id: op.op_id, entidad: op.entidad, uid: op.uid, tipo: tipo, campos: campos || [], mio: op.cambios, base: op.base, servidor: servidor, creado_en: reloj() });
      await marcar(op, "conflict", { error: tipo });
      emitir("conflicto", { entidad: op.entidad, uid: op.uid, tipo: tipo });
    }

    /* Resultado de ejecutar UNA operación: {fin:'ok'|'siguiente'|'detener', ...} */
    async function ejecutar(op) {
      var m = mapper(op.entidad);
      if (op.kind === "insert") {
        var r = await rest.insertar(m.tabla, [op.cambios], { ignorarDuplicados: true });
        if (r.ok) {
          var fila = Array.isArray(r.datos) && r.datos[0] ? r.datos[0] : null;
          if (!fila) { var g = await rest.obtener(m.tabla, op.uid); if (!g.ok) return { error: g }; fila = g.datos; }   // reintento tras respuesta perdida
          if (!fila) return { rechazo: { clase: "permiso", codigo: "SIN_FILA", mensaje: "La nube no aceptó el registro." } };
          await aplicarRespuesta(op, fila); return { ok: true };
        }
        return { error: r };
      }
      if (op.kind === "update") {
        var revBase = op.base_rev, cambios = op.cambios;
        for (var intento = 0; intento < 3; intento++) {
          var r2 = await rest.modificar(m.tabla, [["id", "eq", op.uid], ["rev", "eq", revBase]], cambios);
          if (!r2.ok) return { error: r2 };
          if (Array.isArray(r2.datos) && r2.datos.length === 1) { await aplicarRespuesta(op, r2.datos[0]); return { ok: true }; }
          // 0 filas: cambió la revisión (u otra persona borró el registro, o la política lo oculta)
          var srv = await rest.obtener(m.tabla, op.uid);
          if (!srv.ok) return { error: srv };
          if (!srv.datos || srv.datos.deleted_at) { await crearConflicto(op, "borrado_remoto", null, []); return { conflicto: true }; }
          var snap = columnasNube(m, srv.datos);
          var f = fusionar(op.base, op.cambios, snap);
          if (f.conflictos.length) {
            await crearConflicto(op, "campos", { fila: srv.datos, snapshot: snap }, f.conflictos);
            return { conflicto: true };
          }
          if (!Object.keys(f.fusion).length) { await aplicarRespuesta(op, srv.datos); return { ok: true }; }   // el servidor ya tiene lo mío
          cambios = f.fusion; revBase = srv.datos.rev;
        }
        return { error: { clase: "servidor", codigo: "REINTENTOS_AGOTADOS", mensaje: "El registro cambia sin parar en la nube." } };
      }
      if (op.kind === "delete") {
        var r3 = await rest.modificar(m.tabla, [["id", "eq", op.uid]], { deleted_at: new Date(reloj()).toISOString() });
        if (!r3.ok) return { error: r3 };
        if (Array.isArray(r3.datos) && r3.datos.length === 1) { await aplicarRespuesta(op, null); return { ok: true }; }
        var g3 = await rest.obtener(m.tabla, op.uid);
        if (!g3.ok) return { error: g3 };
        if (!g3.datos || g3.datos.deleted_at) { await aplicarRespuesta(op, null); return { ok: true }; }
        return { rechazo: { clase: "permiso", codigo: "SIN_PERMISO", mensaje: "No tienes permiso para eliminar este registro." }, restaurar: g3.datos };
      }
      if (op.kind === "rpc") {
        var r4 = await rest.rpc(op.rpc, op.params);
        if (r4.ok) { await bd.outbox.borrar(op.seq); emitir("rpc-ok", { op_id: op.op_id, rpc: op.rpc, resultado: r4.datos }); return { ok: true }; }
        return { error: r4 };
      }
      return { rechazo: { clase: "validacion", codigo: "TIPO_DESCONOCIDO", mensaje: "Operación desconocida." } };
    }

    /** Cola de una operación de la nube que no es una tabla (RPC de dinero, SYNC-7). Nunca con PIN. */
    async function encolarRpc(nombre, params, meta) {
      if (apagado()) return { omitido: "apagado" };
      verificarSinPin(nombre, params);
      var s = sesion(); if (!s || !s.uid) throw new Error("No hay sesión.");
      var dev = await bd.deviceId();
      var opId = (meta && meta.op_id) || nuevoUuid();
      // p_op: TODAS las RPC de sync-3-rpc.sql (y sync_guardar_items_cotizacion, SYNC-5) llaman a su
      // primer parámetro `p_op`, nunca `p_op_id` — es la clave de idempotencia que lee sync_op_iniciar.
      var op = { op_id: opId, entidad: (meta && meta.entidad) || "rpc", uid: (meta && meta.uid) || opId, kind: "rpc", rpc: nombre, params: Object.assign({}, params, { p_op: opId }),
        estado: "pending", intentos: 0, siguiente_en: 0, actor_uid: s.uid, device_id: dev, creado_en: reloj(), error: null };
      var seq = await bd.transaccion(["outbox"], "readwrite", function (t) { return t.add("outbox", op); });
      programarEnvio();
      return { seq: seq, op_id: opId };
    }

    async function conBloqueo(fn) {
      if (locks && typeof locks.request === "function") {
        return locks.request("entimotors-sync-flush", { ifAvailable: true }, function (lock) { return lock ? fn() : { omitido: "otra-pestana" }; });
      }
      // Sin Web Locks: arrendamiento en la base (una sola pestaña envía a la vez)
      var tomado = await bd.transaccion(["meta"], "readwrite", async function (t) {
        var r = await t.get("meta", "lease"), ahora = reloj();
        if (r && r.v && r.v.until > ahora && r.v.dueno !== duenoLease) return false;
        await t.put("meta", { k: "lease", v: { dueno: duenoLease, until: ahora + 60000 } });
        return true;
      });
      if (!tomado) return { omitido: "otra-pestana" };
      try { return await fn(); } finally { await bd.meta.set("lease", { dueno: duenoLease, until: 0 }); }
    }

    async function flush() {
      if (apagado()) return { omitido: "apagado" };
      var s = sesion(); if (!s || !s.uid) return { omitido: "sin-sesion" };
      return conBloqueo(async function () {
        var res = { enviadas: 0, rechazadas: 0, conflictos: 0, detenido: null };
        // una operación que quedó «syncing» por un cierre brusco se reintenta: es idempotente
        var colgadas = await bd.outbox.porEstado("syncing");
        for (var c = 0; c < colgadas.length; c++) await marcar(colgadas[c], "pending");
        estadoVivo.sincronizando = true; emitir("estado", null);
        try {
          for (var guarda = 0; guarda < 5000; guarda++) {
            var ahora = reloj();
            var lista = (await bd.outbox.porEstado("pending")).sort(function (a, b) { return a.seq - b.seq; });
            var op = lista.filter(function (x) { return x.actor_uid === s.uid && (x.siguiente_en || 0) <= ahora; })[0];
            if (!op) break;
            // si un padre de esta operación fue rechazado, esta no tiene dónde apoyarse
            await marcar(op, "syncing", { intentos: (op.intentos || 0) + 1 });
            var r;
            try { r = await ejecutar(Object.assign({}, op, { estado: "syncing" })); }
            catch (e) { r = { error: { clase: "servidor", codigo: "EXCEPCION", mensaje: e && e.message ? e.message : "error" } }; }
            if (r.ok) { res.enviadas++; continue; }
            if (r.conflicto) { res.conflictos++; continue; }
            if (r.rechazo) {
              await marcar(op, "rejected", { error: descripcionError(r.rechazo) }); res.rechazadas++;
              if (r.restaurar) await restaurar(op, r.restaurar);
              emitir("rechazada", { entidad: op.entidad, uid: op.uid, error: descripcionError(r.rechazo) }); continue;
            }
            var e = r.error, k = e.clase;
            if (k === "permiso" || k === "validacion" || k === "conflicto") {   // no se arregla reintentando
              await marcar(op, "rejected", { error: descripcionError(e) }); res.rechazadas++;
              if (op.kind === "delete") await restaurarBorrado(op);   // al borrar el registro salió de la pantalla: si la nube lo rechazó (403), vuelve
              emitir("rechazada", { entidad: op.entidad, uid: op.uid, error: descripcionError(e) });
              continue;
            }
            // red, servidor, límite, esquema, auth: se conserva y se reintenta más tarde
            var espera = k === "limite" && e.reintentarEnS ? e.reintentarEnS * 1000 : esperaMs(op.intentos + 1, o.aleatorio ? o.aleatorio() : undefined);
            await marcar(op, "pending", { error: descripcionError(e), siguiente_en: reloj() + espera });
            res.detenido = k;
            if (k === "auth") emitir("auth-requerida", null);
            break;
          }
        } finally { estadoVivo.sincronizando = false; }
        if (res.detenido) estadoVivo.ultimoError = { clase: res.detenido, en: reloj() }; else { estadoVivo.ultimaOk = reloj(); estadoVivo.ultimoError = null; }
        emitir("estado", null);
        return res;
      });
    }

    /* Una operación rechazada por permisos deja el registro local distinto de la nube: se vuelve a la versión del servidor. */
    async function restaurar(op, filaServidor) {
      var m = mapper(op.entidad);
      await bd.transaccion([m.store, "mapa"], "readwrite", async function (t) {
        var mp = await t.get("mapa", op.uid);
        var reg = Object.assign({}, m.aLocal(filaServidor), await fksALocal(t, m, filaServidor), { uid: op.uid, _rev: filaServidor.rev || 0, _base: columnasNube(m, filaServidor), _pend: false });
        if (mp) reg.id = mp.local_id;
        var id = await t.put(m.store, reg);
        if (!mp) await t.put("mapa", { uid: op.uid, entidad: op.entidad, local_id: id });
      });
    }

    /* Un borrado que la nube NO aceptó (p. ej. 403: solo el administrador borra). Se devuelve la versión de la nube; si en ese instante no hay
       conexión, la copia que se tenía al borrar (el próximo pull la pone al día). Si la nube ya no tiene la fila viva, no hay nada que devolver. */
    async function restaurarBorrado(op) {
      var m = mapper(op.entidad), g = await rest.obtener(m.tabla, op.uid);
      if (g.ok) { if (g.datos && !g.datos.deleted_at) await restaurar(op, g.datos); return; }
      if (op.base) await restaurar(op, Object.assign({}, op.base, { id: op.uid, rev: op.base_rev || 0 }));
    }

    async function resolverConflicto(idConflicto, decision) {
      var todos = await bd.conflictos.todos();
      var c = todos.filter(function (x) { return x.id === idConflicto; })[0];
      if (!c) return { ok: false, motivo: "no-existe" };
      var op = await bd.outbox.get(c.op_seq);
      var m = mapper(c.entidad);
      if (decision === "mio" && op) {
        var srv = c.servidor && c.servidor.fila ? c.servidor.fila : null;
        if (srv) await bd.outbox.actualizar(op.seq, { estado: "pending", intentos: 0, siguiente_en: 0, error: null, base: c.servidor.snapshot, base_rev: srv.rev });
        else if (c.tipo === "borrado_remoto") return { ok: false, motivo: "registro-borrado-en-la-nube" };
      } else if (decision === "servidor") {
        if (op) await bd.outbox.borrar(op.seq);
        if (c.servidor && c.servidor.fila) await restaurar({ entidad: c.entidad, uid: c.uid }, c.servidor.fila);
        else await bd.transaccion([m.store, "mapa"], "readwrite", async function (t) { var mp = await t.get("mapa", c.uid); if (mp) await t.borrar(m.store, mp.local_id); });
      } else return { ok: false, motivo: "decision-invalida" };
      await bd.conflictos.borrar(idConflicto);
      programarEnvio();
      emitir("cambio-local", { entidad: c.entidad });
      return { ok: true };
    }

    /* ============ CICLO Y DISPAROS ============ */
    var temporizadorEnvio = null, intervalo = null, oyentes = [];
    function programarEnvio() {
      if (apagado() || !o.autoenvio) return;
      if (temporizadorEnvio) return;
      temporizadorEnvio = setTimeout(function () { temporizadorEnvio = null; sincronizar(); }, o.retardoEnvioMs === undefined ? 400 : o.retardoEnvioMs);
    }
    async function sincronizar() {
      if (apagado()) return { omitido: "apagado" };
      if (global.navigator && global.navigator.onLine === false) return { omitido: "sin-conexion" };
      var f = await flush();
      if (f && f.omitido) return { flush: f };
      var p = f.detenido === "auth" || f.detenido === "red" ? [] : await pullTodo();
      return { flush: f, pull: p };
    }
    function arrancar() {
      if (apagado() || intervalo) return;
      var alVolver = function () { if (!global.document || global.document.visibilityState === "visible") sincronizar(); };
      if (global.addEventListener) { global.addEventListener("online", alVolver); oyentes.push(["online", alVolver, global]); }
      if (global.document && global.document.addEventListener) { global.document.addEventListener("visibilitychange", alVolver); oyentes.push(["visibilitychange", alVolver, global.document]); }
      intervalo = setInterval(function () { sincronizar(); }, o.cadaMs || 30000);
      sincronizar();
    }
    function detener() {
      if (intervalo) { clearInterval(intervalo); intervalo = null; }
      if (temporizadorEnvio) { clearTimeout(temporizadorEnvio); temporizadorEnvio = null; }
      oyentes.forEach(function (x) { x[2].removeEventListener(x[0], x[1]); }); oyentes = [];
    }

    async function estado() {
      var cola = await bd.outbox.contar(), conflictos = await bd.conflictos.todos();
      var s = sesion();
      var ajenas = s ? (await bd.outbox.todos()).filter(function (x) { return x.actor_uid !== s.uid; }).length : 0;
      return { habilitado: !apagado(), enLinea: !(global.navigator && global.navigator.onLine === false), sincronizando: estadoVivo.sincronizando, ultimaOk: estadoVivo.ultimaOk,
        ultimoError: estadoVivo.ultimoError, ultimoPull: estadoVivo.ultimoPull, cola: cola, conflictos: conflictos.length, deOtraPersona: ajenas };
    }

    return { escribir: escribir, pull: pull, pullTodo: pullTodo, flush: flush, sincronizar: sincronizar, encolarRpc: encolarRpc, resolverConflicto: resolverConflicto,
      estado: estado, arrancar: arrancar, detener: detener, onCambio: function (f) { escuchas.push(f); return function () { escuchas = escuchas.filter(function (x) { return x !== f; }); }; } };
  }

  global.SyncEngine = { crearMotor: crearMotor, puras: puras };
})(typeof window !== "undefined" ? window : this);
