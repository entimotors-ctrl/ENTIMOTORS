# Registro de cambios · ENTIMOTORS OS

## 3.15.0 — release (octubre de 2026)

> **Alcance: base de datos, backend y frontends.** Orden de publicación obligatorio: base de datos
> (sync-15a → 15b → 15c → 15d → 15e → 15f → 15g) → backend → frontends. Cada migración tiene su script de
> reversión; 15b, 15c y 15d se niegan a revertirse si ya hay actividad de 3.15.

### Cotizaciones, presupuestos e inventario
- Los renglones de cotizaciones y órdenes guardan el repuesto de origen y el precio de esa operación; el precio
  es editable por operación y queda congelado aunque el producto cambie después.
- Aceptar una cotización crea su orden en una sola operación del servidor (`convertir_cotizacion`): repetirla o
  hacerlo desde dos dispositivos da una sola orden.
- Presupuesto `pendiente`, `aprobado` o `rechazado`, decidido por el servidor. Los repuestos del negocio salen del
  inventario **una sola vez, al aprobar**; cambiar cantidades o productos después ajusta solo la diferencia. Lo que
  ya se había descontado antes de 3.15 no se descuenta otra vez.

### Tiempo real y mensajes
- Avisos en vivo por canal privado (sin datos en el aviso): el registro afectado se vuelve a pedir con los permisos
  de cada cuenta. Con avisos conectados la revisión periódica baja a cada 5 minutos; sin ellos sigue cada 30 segundos.
- Mensajes del administrador al equipo, con lectura confirmada por el destinatario.

### Seguridad y cuentas
- **PIN del propietario** para acciones destructivas, verificado en el servidor y ligado a la sesión, la acción y
  el dispositivo.
- **Eliminar usuario** con impacto previo (trabajo asignado), baja de la cuenta y cierre de sus sesiones; un correo
  eliminado no se reutiliza.
- Cerrar sesión cierra solo ese dispositivo.

### Almacenamiento y sin conexión
- Si la base local no abre o el navegador la cierra, la app se bloquea con una explicación y no guarda «en modo
  local» trabajo que nunca subiría. La cola pendiente no se borra.
- Sin conexión, lo registrado queda pendiente y se envía una sola vez al volver la red.

### Finanzas y fechas
- Fecha del negocio (America/Tegucigalpa) en toda la app; las cifras de Finanzas coinciden con las del servidor.
- Invariantes de dinero comprobables en la base (`finanzas_invariantes`).

### Rendimiento
- Lectura con permisos evaluados una vez por consulta (sync-15g; misma visibilidad por rol).
- Reabrir muestra lo guardado y se pone al día en segundo plano; descarga por páginas con lecturas agrupadas;
  listas largas por partes; fotos nuevas del Taller comprimidas.

### Datos de la versión 3.13
- El aviso de datos de 3.13 lo decide el servidor y muestra solo lo que falta; el importador y la recuperación
  siguen disponibles. La base 3.13 del dispositivo no se borra ni se marca como migrada.

### Operaciones rechazadas que respaldan datos locales
- Al bajar una versión más nueva de una orden, se conservan los renglones que solo existen en el dispositivo y
  cuya única representación es una operación `agregar_item_orden` rechazada por la nube; si una versión anterior
  de la app ya los había quitado de la orden local, se reponen desde esa misma operación. No se reenvía nada.
- La primera puesta al día de 3.15.0 sobre una caché descargada por una versión anterior la vuelve a leer una vez.
- **Protección temporal:** una operación rechazada que es el único respaldo de datos locales (`agregar_item_orden`
  de un renglón local, `registrar_credito` de un crédito que la nube aún no tiene) **no se puede quitar** de
  «⚠ Por revisar», ni desde la pantalla ni por el motor. Las demás rechazadas se quitan como siempre.
  No es la resolución definitiva: se retirará en una versión posterior.
- **PHONE_RESCUE: DEFERRED.** El respaldo fuera del dispositivo de esos datos (los textos de los renglones y del
  crédito afectados) no se ha completado al publicar 3.15.0; queda pendiente y condiciona el retiro de la
  protección temporal y del legado 3.13.

### PWA
- Caché nueva **`entimotors-v3.15.0`** (Mi Trabajo: `entimotors-mitrabajo-v3.15.0`); la de 3.14.1 se borra al
  activar la versión nueva. Sin activación automática: el aviso de versión sigue pidiendo respaldo.
- Publicación por lista explícita de archivos (`hacer-build-taller.sh`, `hacer-build-mecanicos.sh`).

## 3.14.1 — candidato (septiembre de 2026, aún sin publicar)

> **Alcance: mantenimiento de los frontends.** Sin cambios de base de datos ni de backend en esta entrega:
> usa `PUT /api/admin/clave` (backend ya publicado) y la tabla de intentos ya aplicada en la base.

### Seguridad
- **Ajustes → Seguridad** (solo administrador): cambiar la contraseña del administrador. Tres campos
  (actual, nueva, confirmación) con `type=password`, mostrar/ocultar accesible, validación local mínima
  (12 caracteres, 72 bytes, distinta de la actual) y el servidor como autoridad; un solo envío a la vez,
  respeta `Retry-After`, mensajes propios para cada respuesta y nada se guarda en el navegador.
- Los campos de contraseña fijan sus colores (texto, cursor, fondo, borde) con los del tema: legibles en
  modo claro y oscuro.

### Interfaz
- Los accesos rápidos de la página principal siguen los mismos permisos que el menú; el cajero ya no ve
  Ajustes ni el Gestor de la web y un grupo vacío se oculta.
- Iconos SVG propios (sprite en `index.html`, lista cerrada en `app.js`) en lugar de emoji en el menú,
  los accesos rápidos, los widgets y la barra superior.

### PWA
- Caché nueva **`entimotors-v3.14.1`** (Mi Trabajo: `entimotors-mitrabajo-v3.14.1`); la de 3.14.0 se borra
  al activar la versión nueva. Sin activación automática: el aviso de versión sigue pidiendo respaldo.

## 3.14.0 — candidato (septiembre de 2026, aún sin publicar)

> **Alcance: el taller en la nube.** Los datos del taller pasan a Supabase y se comparten entre
> dispositivos; el trabajo se asigna a cuentas reales de mecánico. Orden de publicación obligatorio:
> base de datos (sync-1 → 2 → 3 → 3b → 3p → 5 → 6 → 7a → 9 → 10) → backend → frontends.

### Nube y sincronización
- Cliente de sincronización (`sync-rest.js`, `sync-db.js`, `sync-engine.js`, `sync-mappers.js`): caché local
  `entimotors_sync`, cola de cambios que sobrevive cierres y cortes, reintento idempotente, conflictos a la vista.
- Dinero y stock por operaciones transaccionales del servidor (`sync-finanzas.js`): ventas, créditos, abonos,
  caja y reversos; invariantes verificadas por la base.
- Mi Trabajo recibe sus órdenes y sube fotos a Storage (`sync-fotos.js`); asignación real a cuentas.
- «⚠ Por revisar»: rechazos, dependencias y conflictos visibles, nunca en silencio.
- PIN administrativo (`pin-ui.js` + api-server) para operaciones sensibles.

### Migración desde 3.13
- **Importador 3.13 → nube** (`import-313.js`, `sync-10-importacion.sql`): datos del teléfono o archivo de
  respaldo → validación → vista previa → confirmación → importación atómica (todo o nada) → verificación.
  Idempotente, una sola vez, exige la nube vacía; no borra `entimotors_os_demo` ni el archivo.
- Con sesión de nube no se siembran datos de ejemplo, y «Restaurar»/«Empezar de cero» no están disponibles.

### Correcciones
- Una operación pendiente sobre una orden o cotización ya borrada deja de reintentarse para siempre:
  se rechaza una vez y queda en «⚠ Por revisar».

### PWA
- Caché nueva **`entimotors-v3.14.0`** (Mi Trabajo: `entimotors-mitrabajo-v3.14.0`); las cachés anteriores
  se borran al activar la versión nueva. Sin activación automática: el aviso de versión sigue pidiendo respaldo.

### Limitaciones conocidas
- Las fotos que la 3.13 guardó en el teléfono no se suben; las órdenes importadas llegan sin cuenta de
  mecánico (el administrador asigna las abiertas); un respaldo con datos de «Ver un ejemplo» no se importa.

## 3.13.0 — candidato (septiembre de 2026, aún sin publicar)

> **Alcance: identidad, acceso y roles multiusuario.** Esta versión añade cuentas, roles y
> el producto separado «Mi Trabajo». **No** incluye asignación de trabajo a cuentas de
> mecánico, transporte de órdenes o citas hacia Mi Trabajo, sincronización entre dispositivos
> ni datos operativos compartidos por Supabase: los datos del taller siguen siendo locales a
> cada dispositivo. Ver «Limitaciones conocidas» más abajo.

### Cuentas, acceso y roles

- **Autenticación multiusuario** con Supabase Auth: inicio de sesión con correo y contraseña,
  sesión que se restaura al abrir la aplicación, perfil y rol leídos del servidor.
- **Roles:** administrador (el sistema admite uno solo), cajero, mecánico y desarrollador.
  Cada rol ve solo las secciones que le corresponden.
- **Administración de cuentas:** nueva pantalla «Usuarios y equipo» (solo administrador) que habla
  con el api-server: alta sin contraseña con enlace de un solo uso, cambio de rol, dar de baja y
  reactivar, y edición de nombre y teléfono. Requiere `apiUrl` en `supabase-config.js` (ya viene con el backend de producción).
- **Alta de cuenta** con enlace de un solo uso; el servidor decide a qué producto vuelve el enlace
  según el rol real de la persona.
- **Recuperación de contraseña mediada por el administrador:** si alguien del equipo perdió su
  contraseña, el administrador abre «Usuarios y equipo» → **Generar enlace**, copia el enlace de un
  solo uso y se lo pasa a esa persona (por ejemplo por WhatsApp); ella lo abre y elige una contraseña
  nueva. No se envía correo. Solo para personas **activas** que no son administrador; un enlace nuevo
  reemplaza al anterior. El servidor toma el correo y el rol de la base (nunca de la petición) y
  decide el destino: los mecánicos vuelven a Mi Trabajo y el resto al Taller. El enlace no se
  guarda en ningún sitio y se retira al cerrar la caja, al salir de la pantalla y al cerrar sesión.
  El login muestra: «¿Olvidaste tu contraseña? Pide al administrador que te genere un enlace de
  recuperación.» (`POST /api/admin/usuarios/:id/enlace`.)
- **`activo=false` falla cerrado:** una cuenta dada de baja no entra ni abre ninguna base de datos,
  tampoco con una sesión guardada.
- **Panel técnico** para el rol desarrollador (`panel-tecnico.html`), que no abre el taller.

### ENTIMOTORS Mi Trabajo

- Producto **separado**, con su propio origen y su build (`hacer-build-mecanicos.sh`), para el acceso
  de mecánicos con cuenta activa.
- Base de datos local propia por perfil (`entimotors_os_demo_mec_<id>`), nunca la del taller.
- Cada producto rechaza, **antes de abrir ninguna base**, las cuentas que no le corresponden.
- Su pantalla dice expresamente que la asignación y la sincronización de trabajos entre dispositivos
  llegarán en una versión posterior.

### PWA

- Caché nueva **`entimotors-v3.13.0`** (Mi Trabajo: `entimotors-mitrabajo-v3.13.0`); las cachés
  anteriores se borran al activarse la versión.
- **Actualización controlada** (sin cambios de comportamiento respecto a 3.12.0): la versión nueva
  queda en espera hasta que la persona acepta el aviso y se verifica la copia de seguridad.

### Seguridad

- **F-SEC-1:** el texto de error que devolvía el api-server podía llegar como HTML a los avisos de
  «Usuarios y equipo». Ahora se escapa una sola vez y se muestra como texto.
- **F-SEC-2:** el rol de la sesión se pintaba sin escapar en Ajustes. Ahora se escapa.
- **Rol desconocido, cerrado:** el portero del taller ya no admite cualquier rol que no esté en la
  lista de vistas restringidas; solo admite administrador, cajero y mecánico local. Un rol
  desconocido, o el desarrollador, se rechaza también con una sesión guardada, y Mi Trabajo solo
  admite mecánicos con cuenta.

### Correcciones

- **Hotfix previo a la etiqueta estable (4E-C11):** el Taller se publicó una primera vez con
  `apiUrl` vacío en `supabase-config.js` y «Usuarios y equipo» mostraba «Falta indicar la dirección
  del servidor». El archivo versionado ya lleva el backend de producción (URL pública, solo el
  origen). Ninguna prueba miraba el archivo real —todas inyectaban un `apiUrl` sintético—, así que
  se añadieron `verificar-config-produccion.mjs` y la prueba `25-config-produccion-apiurl`, que
  fallan si el archivo se publica sin él o con una dirección inválida.
- **F-FUNC-1:** en la pantalla de contraseña, un fallo de red o un tiempo agotado se mostraba como
  un rechazo del servidor con el texto crudo del navegador («Failed to fetch»). Ahora dice «Sin
  conexión con el servidor. Inténtalo otra vez.».
- **OBS-3:** eliminar una cita es **solo del administrador**, como decía su aviso y la política de
  la base. Antes dejaba pasar también al cajero. El resto de acciones del cajero no cambia.
- **OBS-4:** al establecer la contraseña, una respuesta HTTP 200 que no trae un usuario (HTML, texto,
  vacía, un arreglo o JSON truncado) ya no se toma por éxito: se rechaza con un mensaje seguro y se
  puede reintentar.
- **OBS-5:** un error del servidor con un objeto anidado ya no se muestra como «[object Object]»: se
  usa el primer mensaje de texto disponible (`message`, `msg`, `error_description` o `error`) o un
  mensaje genérico.
- **Panel técnico:** el literal visual de la versión (que decía 3.12.0) muestra ahora 3.13.0.
- **OBS-7:** el chip del usuario en la barra superior (nombre y rol) era una píldora de una línea con
  dos líneas dentro y un nombre largo rompía la barra; ahora es compacto, con elipsis en escritorio,
  y en móvil se ve el nombre completo.
- **OBS-8:** en «Usuarios y equipo», el formulario de «+ Nuevo usuario» (y el enlace generado) caía
  por debajo de la lista; ahora aparece arriba, a la vista.
- **OBS-9:** ver «Recuperación de contraseña mediada por el administrador»; el texto de la pantalla
  «Establecer contraseña» ya no dice «Has sido invitado» para los enlaces de recuperación (solo para
  los de invitación).
- **OBS-10:** «Buscar actualización ahora» ya no borra el Service Worker ni las cachés ni recarga
  (dejaba sin caché al equipo sin señal y se saltaba la copia de seguridad): solo comprueba, y si hay
  una versión nueva abre el mismo aviso con la copia de seguridad; nunca instala sola.
- **Textos que prometían de más:** Mi Trabajo y su manifest ya no hablan de «trabajo asignado», y
  «Usuarios y equipo» ya no dice que el servidor aplica todos los permisos: distingue las cuentas
  (que protege el servidor) de los datos de este dispositivo (que controla la aplicación).

### Limitaciones conocidas

No son bugs corregidos: es lo que esta versión no hace.

- **No incluye asignación de trabajo a cuentas de mecánico.** El selector «Mecánico asignado» usa la
  lista local `TEAM`, sin vínculo con las cuentas.
- **No incluye sincronización entre dispositivos.**
- **Mi Trabajo no recibe trabajo todavía:** ni órdenes ni citas desde otro dispositivo.
- **Los datos operativos siguen locales** (IndexedDB); Supabase solo se usa para cuentas.
- **Cerrar sesión en otra pestaña no invalida de inmediato la sesión abierta** en la primera: se
  refleja al recargar. El servidor sí vuelve a comprobar cada acción de administración.
- **La administración de usuarios requiere configurar `apiUrl`** y las variables del api-server
  (`ENTIMOTORS_ADMIN_ORIGIN` y `ENTIMOTORS_MECHANIC_ORIGIN`).
- **No hay recuperación por correo ni autoservicio:** la persona le pide el enlace al administrador.
- **La cuenta administradora no se recupera desde la aplicación:** «Generar enlace» no se ofrece para
  el propio administrador ni para otras cuentas administradoras. Si el administrador pierde su
  contraseña, se recupera desde el panel de Supabase (Authentication → Users → el usuario → Reset
  password). Ver el README, «Recuperación de la cuenta administradora».

## 3.12.0 — 4 de septiembre de 2026

> **Esta versión NO constituye todavía el piloto multiusuario con Supabase.**
> El sistema sigue funcionando entero en el dispositivo, con IndexedDB. La base de
> datos en Supabase quedó creada y verificada, pero la aplicación todavía no se
> conecta con ella.

Actualización centrada en **integridad del dinero y seguridad de los datos**. Corrige
errores que estaban en producción y podían costar plata de verdad.

### Seguridad

- La aplicación **ya no se actualiza sola**. Antes, al haber versión nueva, el
  Service Worker tomaba el control y recargaba sin avisar — con datos que solo
  existen en ese teléfono. Ahora aparece un aviso con tres opciones (crear copia y
  actualizar · solo crear copia · ahora no), y **si la copia no se verifica, no se
  actualiza**.
- La cuenta `prueba` ya no siembra datos de ejemplo encima de información real.
  Como su contraseña está en el código, bastaba con entrar con ella en el celular
  del cliente para mezclarle clientes y repuestos inventados con los suyos.
- Los modales de confirmación pasan por encima de cualquier otro. Antes quedaban
  tapados y el botón no se podía tocar: el aviso de choque de horario al mover una
  cita era imposible de responder.

### Base de datos

- Esquema de IndexedDB de la **v5 a la v6**.
- Nuevas tablas locales: `auditoria` (bitácora) y `sync_cola` (cola de cambios
  pendientes de subir).
- La migración v5 → v6 se probó **contra la versión 3.11 real descargada de
  producción**, con datos de taller: cliente, moto, inventario, venta, crédito con
  abono, orden, cotización y cita. **Ningún registro perdido**; saldos y caja
  idénticos antes y después.

### Finanzas

- **Costos históricos.** Ni las ventas ni los créditos ni las órdenes guardaban a
  cuánto había costado el repuesto, así que la ganancia se recalculaba con el costo
  de hoy: subirle el precio a un repuesto **cambiaba hacia atrás la ganancia de
  ventas ya cerradas**, y borrarlo del inventario la inflaba a costo cero. Ahora el
  costo se congela en el momento exacto de la operación. Los registros anteriores a
  esta versión se rellenaron con el costo actual y quedan **marcados como
  estimados**, nunca presentados como exactos.
- **El abono ya es atómico.** Bajaba el saldo del crédito y metía el dinero en caja
  en dos guardados separados: si el segundo fallaba, el crédito quedaba cobrado y
  la plata no aparecía en el libro. Ahora las dos escrituras van en la misma
  transacción.
- **El abono ya no se puede cobrar dos veces.** Lleva identificador único;
  repetirlo —doble toque o reintento por mala señal— se ignora.
- **Se acabó el cobro triplicado al finalizar una orden.** Tres toques seguidos en
  «Finalizar trabajo» registraban tres ingresos: medido, **L.3 600 por una orden de
  L.1 200**. Ahora hay guarda de doble toque y comprobación del estado guardado.
- **Una orden ya no se cierra sin su registro financiero.** Antes se marcaba
  finalizada *antes* de crear el crédito o el ingreso; si eso fallaba, la orden
  quedaba cerrada, el cliente debiendo y sin rastro de la deuda. Ahora primero el
  cobro y solo si sale bien se cierra.
- **No se puede borrar la contraparte contable** de una venta, un abono o una
  orden. Esas líneas muestran un candado en vez del botón de borrar. Los
  movimientos escritos a mano se siguen borrando normalmente.
- Nueva **bitácora de auditoría**: quién, qué, cuándo y sobre qué registro. Cubre
  ventas, abonos, finalización de órdenes, movimientos de caja, respaldos y
  restauraciones. Sobrevive a una restauración y no se puede editar ni borrar.

### Inventario

- Cuando no alcanza la existencia, **se informa cuánto faltó** con nombre y
  cantidad. Antes el faltante se convertía en cero en silencio.
- Corregido: los repuestos **importados por CSV se ofrecían a L. 0.00** al
  agregarlos a una orden, porque la importación guardaba el precio en un solo
  campo. Ahora guarda los dos, más el stock mínimo y la categoría.

### Backup

- El respaldo **se verifica solo**: se relee la base y se compara tabla por tabla.
  Si no cuadra, no se entrega la copia y se dice por qué.
- Cabecera completa: identificador, versión de app, versión de esquema, fecha,
  quién la hizo, dispositivo y conteo por tabla.
- **Compartir la copia** con el menú del teléfono — WhatsApp, Archivos o a otra
  persona.
- El sistema **recuerda cuándo fue la última copia** y avisa en rojo si pasó una
  semana.
- **Restaurar guarda antes una copia de lo actual**, automáticamente. Se puede
  elegir entre reemplazar o combinar, explicado en palabras. Probado con seis tipos
  de archivo inválido: ninguno alteró la base.

### PWA

- El Service Worker ya no llama a `skipWaiting()` por su cuenta: espera a que la
  persona acepte y solo entonces se activa.
- IndexedDB sobrevive a la actualización — comprobado con datos reales.

### Correcciones

- El buscador global no encontraba las cotizaciones y mostraba **L. 0.00** en los
  repuestos importados.
- Una cotización hecha de noche decía «16 días» en vez de 15, por mezclar días con
  horas sueltas.
- Una cotización ya aceptada seguía mostrando su fecha de vencimiento, como si
  siguiera contando.
- Un cliente sin teléfono dejaba un guion colgando en la factura y en el estado de
  cuenta.
- El sistema decía haber **enviado** mensajes de WhatsApp que en realidad solo
  abría. Ahora dice «WhatsApp abierto… falta pulsar enviar».
- El indicador de conexión decía **«sincronizado»** sin que existiera ningún
  servidor. Ahora dice «Solo en este dispositivo · respalda seguido».

### Preparación Supabase

- Nuevo `supabase/entimotors-completo.sql`: 18 tablas, 56 políticas RLS, 5
  funciones, 12 índices y 2 disparadores. Idempotente. **Ya ejecutado y verificado
  contra el proyecto real.**
- Nuevo bucket privado `entimotors-taller` para las fotos de las motos. El bucket
  público del catálogo web no se tocó.
- `supabase/README-MAPA.md` con la correspondencia IndexedDB → Supabase y la
  estrategia de identificadores para no romper relaciones al migrar.
- Nuevos `SUPABASE-CONFIG.md` y `SUPABASE-STATUS.md`.
- La cola `sync_cola` ya anota cada cambio, en orden y con identificador único,
  esperando a que exista a dónde subirlo.

### Pruebas

101 pruebas de aplicación, 41 de regresión, 16 de permisos en PostgreSQL local y 9
de restricciones contra el proyecto real de Supabase. **0 fallos. 0 errores de
consola. 0 promesas rechazadas.**

---

## 3.11.0 — versión en producción

Cotizaciones con vigencia, envío de facturas por WhatsApp como imagen o PDF.
Es la versión que el cliente usa hoy.
