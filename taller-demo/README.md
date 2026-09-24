# ENTIMOTORS OS

Sistema de gestión para un taller de motocicletas. Recibe la moto, la sigue por las
seis etapas de reparación, cobra, controla el inventario, lleva la caja y los
créditos, y le manda al cliente su factura por WhatsApp.

**Versión actual:** 3.14.0 · **Datos del taller:** Supabase (nube) + caché local offline · **Esquema local 3.13:** IndexedDB v6 (se conserva)

---

## Alcance de 3.14.0: el taller en la nube

La 3.14.0 lleva los **datos del taller a Supabase**: todos los dispositivos con sesión ven lo mismo.
Sigue funcionando sin señal: lo que se hace sin conexión queda en una cola y se envía al volver la red.

**Incluye**

- Todo lo de 3.13.0 (cuentas, roles, Mi Trabajo, recuperación mediada, `activo=false` falla cerrado).
- **Sincronización entre dispositivos** de clientes, motos, citas, cotizaciones, inventario, órdenes y dinero
  (ventas, créditos, abonos, caja) por operaciones transaccionales e idempotentes en el servidor.
- **Asignación real de trabajo** a cuentas de mecánico; Mi Trabajo recibe sus órdenes y sube sus fotos.
- **PIN administrativo** para operaciones sensibles (anulaciones, ajustes).
- «⚠ Por revisar»: rechazos, conflictos y dependencias a la vista; nada se pierde en silencio.
- **Importador 3.13 → nube** (Ajustes o aviso en la página principal, solo administrador): vista previa,
  confirmación, importación atómica y verificación. El teléfono y el archivo **no se borran**.
- Con sesión de nube **no hay datos de ejemplo** ni «Restaurar»/«Empezar de cero».
- PWA con caché propia `entimotors-v3.14.0` y actualización controlada.

**No incluye** (limitaciones conocidas, ver más abajo)

- Subir las fotos que la 3.13 guardó dentro del teléfono.
- Asignar automáticamente a cuentas las órdenes históricas de la 3.13 (se asignan a mano).

---

## Cómo funciona hoy

Es una **aplicación web instalable (PWA)**: se instala en el teléfono o la computadora y **funciona sin
internet** con la última copia descargada. Con sesión de nube, la fuente de verdad es **Supabase**;
el dispositivo guarda una caché (`entimotors_sync`) y una cola de cambios pendientes que se envía sola
al volver la red. El dinero y el stock solo cambian por operaciones del servidor (nunca a mano en el
dispositivo), y la base impone invariantes (stock = movimientos, saldo = total − abonos).

La base local de la 3.13 (`entimotors_os_demo`) **no se borra**: sus datos se pasan a la nube con el
importador y quedan en el teléfono como respaldo de la transición.

### Lo que hace

| Sección | Para qué |
|---|---|
| Página principal | Lo pendiente del día de un vistazo |
| Cotizaciones | El precio antes de tocar la moto, con vigencia de 7, 15 o 30 días |
| Órdenes de servicio | Las seis etapas, del recibo a la entrega |
| Citas | Agenda con horarios y mecánicos |
| Clientes y motos | Ficha, historial y semáforo de mantenimiento |
| Inventario | Costo, precio, stock mínimo, categorías y código de barras |
| Venta rápida (TPV) | El mostrador, con contado o crédito |
| Finanzas y caja | Libro de caja, utilidad y cuentas por cobrar |
| Créditos | Lo fiado, con abonos y estado de cuenta |
| Gestor de la web | Lo que ve el público en la página del taller |
| Usuarios y equipo | Cuentas y roles (solo administrador; requiere `apiUrl`, ver más abajo) |
| Ajustes | Respaldos, restauración y estado del sistema |

Además: buscador global (Ctrl+K), centro de avisos, modo claro y oscuro, bitácora de
auditoría y seis documentos imprimibles que se pueden enviar como imagen o PDF.

---

## Dos productos, dos orígenes

| Producto | Quién entra | Caché | Base local |
|---|---|---|---|
| **ENTIMOTORS Taller** | administrador y cajero con cuenta; miembros de la lista local `TEAM` si existe `config-local.js` | `entimotors-v3.14.0` | nube + caché `entimotors_sync` (sin nube: `entimotors_os_demo`) |
| **ENTIMOTORS Mi Trabajo** | únicamente **mecánicos con cuenta activa** | `entimotors-mitrabajo-v3.14.0` | nube + caché propia del perfil (`entimotors_sync_mec_<id>`) |

Se publican en **dos orígenes distintos** (la política de mismo origen del navegador es la que
separa sus datos). `build-target.js` declara qué producto es cada copia y **lo decide el build,
no el visitante**. La variante de Mi Trabajo se genera desde la misma fuente:

```bash
bash hacer-build-mecanicos.sh <directorio-destino>
```

Un portero común comprueba la sesión **antes** de abrir ninguna base: el taller rechaza a los
mecánicos con cuenta («debe ingresar desde Mi Trabajo») y Mi Trabajo rechaza todo lo que no sea
un mecánico con cuenta activa y perfil.

---

## Cuentas y roles

| Rol | Dónde entra | Qué puede |
|---|---|---|
| **Administrador** | Taller | Todo, incluida la pantalla de usuarios, asignar mecánico y eliminar citas. El sistema admite **uno solo**. |
| **Cajero** | Taller | La operación diaria y las finanzas. Abre y gestiona órdenes y citas (llegada, edición, cambio de horario, ausencia, recordatorios), pero **no** ve Ajustes, Gestor de la web ni Usuarios, no asigna mecánico y **no elimina citas**. |
| **Mecánico** con cuenta | Mi Trabajo | Solo la pantalla «Mi trabajo». |
| **Mecánico** local (`TEAM`) | Taller | Vistas operativas, sin gestión de citas ni finanzas. Solo existe con `config-local.js`. |
| **Desarrollador** | `panel-tecnico.html` | Panel técnico (solo conteos y estado de las políticas). **No** abre el taller ni Mi Trabajo. |

Un **rol desconocido se rechaza** en ambos productos, aunque llegue en una sesión guardada. Una
cuenta con `activo=false` no entra.

> **Qué protege el servidor y qué no.** La administración de **cuentas** (crear, cambiar rol, dar de
> baja) la protege el servidor: el api-server revalida el token y el perfil en cada petición y las
> políticas de la base hacen el resto. Los **datos operativos** los protege la base (RLS por rol y
> funciones del servidor para dinero, stock y avances del mecánico). Lo que llega a la caché del
> dispositivo se puede leer con las herramientas del navegador: por eso cada rol solo descarga lo suyo.

---

## Administración de usuarios (api-server)

La pantalla «Usuarios y equipo» habla con el **api-server** (`/api/admin/usuarios`: listar, crear,
modificar y generar un enlace de recuperación), no con IndexedDB. Para que funcione hace falta:

1. **`apiUrl`** en `supabase-config.js`: la dirección del api-server, **solo el origen** (sin barra
   final ni ruta; por ejemplo `https://<tu-servicio>.onrender.com`: la aplicación añade
   `/api/admin/usuarios`). **Viene ya rellenada con el backend de producción**: es una URL pública,
   no un secreto, y solo hay que cambiarla si el backend se muda; no pongas ahí ningún secreto. Si
   alguien la deja vacía, la pantalla avisa «Falta indicar la dirección del servidor» y el resto de
   la aplicación sigue igual. **Antes de publicar el Taller** se comprueba el archivo que se sube (o
   el ya publicado) con `node pruebas/multiusuario/verificar-config-produccion.mjs [ruta-o-URL]`, y
   la prueba `25-config-produccion-apiurl` lo vigila en el repositorio: la versión 3.13.0 se publicó
   una vez con `apiUrl` vacío y esa pantalla mostró justo ese aviso.
2. En el **api-server**, las variables de entorno `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` y
   `SUPABASE_ANON_KEY`, más **`ENTIMOTORS_ADMIN_ORIGIN`** y **`ENTIMOTORS_MECHANIC_ORIGIN`**: el
   origen de cada producto. El servidor decide con ellas adónde vuelve el enlace de alta según el
   **rol real** guardado en `perfiles`; no tienen valor por defecto y, sin la del producto que
   toca, el alta no devuelve enlace.

El alta **no crea contraseña**: devuelve un enlace de un solo uso con el que la persona elige la suya.
La clave `service_role` va solo en el servidor, nunca en el frontend.

### Recuperación de contraseña (mediada por el administrador)

Si alguien del equipo perdió su contraseña:

1. El administrador abre **Usuarios y equipo** y, en la fila de esa persona, pulsa **Generar enlace**
   (confirma el aviso).
2. Aparece una caja con el enlace: **Copiar enlace** y se lo pasa a la persona (por ejemplo por
   WhatsApp). **No se envía correo.**
3. La persona abre el enlace: aterriza en su producto (los mecánicos en Mi Trabajo, el resto en el
   Taller), elige una contraseña nueva y vuelve a iniciar sesión.

Reglas: el enlace es de **un solo uso** y caduca (el plazo lo fija Supabase); uno nuevo **reemplaza**
al anterior; solo se ofrece para personas **activas** que no son administrador (una cuenta dada de
baja tiene que reactivarse antes; generar el enlace nunca la reactiva). El servidor toma el correo y
el rol **de la base**, nunca de lo que envíe el navegador, y decide el destino con
`ENTIMOTORS_ADMIN_ORIGIN` y `ENTIMOTORS_MECHANIC_ORIGIN`. Las direcciones de vuelta de ambos productos
tienen que estar en Supabase → Authentication → URL Configuration → Redirect URLs (igual que para el
alta). El enlace es un secreto: solo se muestra en esa caja, no se guarda en el navegador ni en la
bitácora, y se retira al cerrarla, al salir de la pantalla y al cerrar sesión.

El login de ambos productos dice: «¿Olvidaste tu contraseña? Pide al administrador que te genere un
enlace de recuperación.»

#### Recuperación de la cuenta administradora

**Este camino no sirve para el propio administrador** (ni para otras cuentas administradoras): la
pantalla no le ofrece «Generar enlace» y el servidor lo rechaza. Si el administrador pierde su
contraseña, se recupera desde el panel de Supabase del proyecto:

1. Entrar al panel de Supabase con la cuenta propietaria del proyecto.
2. **Authentication → Users** y abrir al usuario administrador.
3. Usar la acción de recuperación de contraseña de ese usuario (**Reset password** o **Send password
   recovery**, según la versión del panel): Supabase le envía el enlace **por correo**, así que hace
   falta que ese correo pueda recibir mensajes y que el envío de correo del proyecto funcione. El
   enlace vuelve a la dirección que el proyecto tenga como *Site URL* / *Redirect URLs*: debe ser la
   del Taller. Al abrirlo, sigue el mismo flujo de arriba.

No pegues contraseñas, claves ni enlaces en chats, capturas ni en el repositorio.

---

## Limitaciones conocidas de 3.14.0

Estas limitaciones **no son bugs corregidos**: son lo que 3.14.0 no hace.

- **Las fotos que la 3.13 guardó dentro del teléfono no se suben a la nube.** Se quedan en el
  respaldo y en el teléfono; las fotos nuevas de Mi Trabajo sí van a la nube.
- **Las órdenes importadas de la 3.13 llegan sin cuenta de mecánico.** El nombre se conserva como
  texto; el administrador asigna a mano las órdenes abiertas. En el reporte de producción, el nombre
  antiguo puede verse en una fila aparte de la cuenta nueva.
- **Un respaldo 3.13 con los datos de «Ver un ejemplo» no se importa.** El importador lo rechaza
  entero: los datos de ejemplo nunca llegan a la nube del taller.
- **La importación 3.13 es una sola vez y exige la nube vacía.** Nada se mezcla ni se duplica.
- **El PIN administrativo requiere `ADMIN_PIN_PEPPER` en el servidor**; sin él, esas operaciones responden
  «no disponible» y quedan apagadas.
- **El Taller no muestra las fotos que sube el mecánico.**
- **Cerrar sesión en otra pestaña no es inmediato.** La sesión abierta en otra pestaña no se invalida
  visualmente hasta que se recarga; el servidor sí vuelve a comprobar cada acción.
- **La administración de usuarios requiere configurar `apiUrl`** (arriba; ya viene con el backend
  de producción y se comprueba antes de publicar).
- **No hay recuperación por correo ni autoservicio.** La recuperación de una persona la genera el
  administrador («Generar enlace»).
- **La cuenta administradora se recupera desde el panel de Supabase**, no desde la aplicación.

---

## Ejecutarlo localmente

No hace falta compilar nada: son archivos estáticos.

```bash
cd taller-demo
python3 -m http.server 5500
```

Y abrir <http://localhost:5500>. **Ojo:** `supabase-config.js` apunta al proyecto de Supabase real;
para probar sin tocarlo, la suite de `pruebas/multiusuario` usa un servidor sintético (ver más abajo).

> **Tiene que servirse por HTTP, no abriendo el archivo directamente.** El Service Worker y
> IndexedDB no funcionan con `file://`.

La aplicación pide instalarse como PWA antes de dejar entrar. Para saltarse ese paso durante el
desarrollo hay un enlace al pie de esa pantalla.

### Pruebas

```bash
# desde la raíz del repositorio (Node >= 20, sin dependencias)
node --test pruebas/multiusuario/*.test.mjs                      # pruebas locales con DOM sintético
node pruebas/multiusuario/browser/browser-runner.mjs             # Chrome y Firefox reales (headless, sin red)
node pruebas/multiusuario/verificar-backend-manifest.mjs         # MATCH si api-server/ sigue siendo el congelado
```

Detalle en [`../pruebas/multiusuario/README.md`](../pruebas/multiusuario/README.md) y
[`../pruebas/multiusuario/browser/README.md`](../pruebas/multiusuario/browser/README.md).

### Estructura

```
taller-demo/
  index.html            interfaz completa y estilos
  app.js                lógica del taller y de Mi Trabajo
  auth.js               sesión: perfil, rol y recuperación de contraseña
  supabase-client.js    cliente HTTP de Supabase (sin lógica de negocio)
  supabase-config.js    configuración pública (URL, anon key, apiUrl)
  recovery.js           pantalla de alta y recuperación de contraseña
  usuarios.js           pantalla «Usuarios y equipo»
  build-target.js       declara el producto: taller o Mi Trabajo
  sw.js                 Service Worker (caché y actualización controlada)
  manifest.json         datos de instalación de la PWA
  panel-tecnico.html    panel del rol desarrollador (no forma parte de la PWA)
  hacer-build-mecanicos.sh   genera el build de Mi Trabajo
  build-mecanicos/      lo que distingue a Mi Trabajo (build-target, manifest, _headers)
  config-local.example.js    plantilla del login local TEAM (config-local.js no se publica)
  icons/                iconos y marca de agua de los documentos
  supabase/             scripts SQL (ver abajo)
api-server/             backend: usuarios, y el sitio web público (independiente del taller)
pruebas/                verificaciones locales
```

Los scripts SQL viven en `supabase/` (`entimotors-usuarios.sql`, `entimotors-fase4c-identidad.sql`,
`entimotors-fase4d-rls.sql` y su rollback, `entimotors-fase3a.sql`, `entimotors-rcv34-source-sync.sql`).
Aplicarlos es una operación aparte del despliegue de la aplicación; ver
[`../pruebas/rcv34/RCV34-SOURCE-SYNC.md`](../pruebas/rcv34/RCV34-SOURCE-SYNC.md).

### Publicar una versión nueva

Al cambiar el código hay que subir el número de versión en **todos** estos sitios, o el dispositivo
se queda con la copia vieja:

1. `app.js` → `const VERSION_APP`.
2. `index.html` → las **16** etiquetas `<script src="…?v=X.Y.Z">` (`build-target`, `supabase-config`,
   `supabase-client`, `auth`, `recovery`, `config-local`, `sync-rest`, `sync-db`, `sync-engine`,
   `sync-mappers`, `sync-fotos`, `sync-finanzas`, `pin-ui`, `import-313`, `app` y `usuarios`).
3. `sw.js` → `CACHE_NAME` y las **15** entradas versionadas de `SHELL` (todas menos `config-local`).
4. `panel-tecnico.html` → el literal visual de la versión (cosmético: no afecta a la caché).

No se toca `versionApp: "3.13.0"` de `armarRespaldoLocal313` (app.js): identifica el formato de los
datos de la 3.13, no la versión de la app.

El build de Mi Trabajo renombra solo `CACHE_NAME` a `entimotors-mitrabajo-vX.Y.Z`: no se edita a mano.
`pruebas/multiusuario/01-pwa-3.14.0.test.mjs` comprueba la coherencia de todo esto (y `01-pwa-3.13.0` la del
release 3.13.0 sobre la instantánea inmutable del tag `v3.13.0`).

---

## Seguridad

- **Nunca** poner la clave `service_role` de Supabase en el frontend: se salta todas las políticas
  de seguridad. Va solo en el servidor, por variable de entorno.
- La clave `anon` de `supabase-config.js` es pública por diseño; por sí sola no da acceso a nada.
- Las contraseñas de la lista local `TEAM` **no** están en el código: viven en `config-local.js`,
  que está en `.gitignore` y no llega a la PWA publicada. Sin ese archivo el login local queda
  deshabilitado y solo entran las cuentas con correo.
- El archivo `api-server/.env` está en `.gitignore` y nunca ha entrado al historial de Git.

---

## Estado

3.14.0 es el **release de la nube**: datos compartidos entre dispositivos, asignación real de trabajo y
el importador para traer los datos de la 3.13. El orden de publicación es **base de datos → backend →
frontends**; la 3.13 sigue funcionando contra la base nueva (rollback de código sin tocar la base).

Ver [`CHANGELOG.md`](CHANGELOG.md) para el detalle de cada versión.
