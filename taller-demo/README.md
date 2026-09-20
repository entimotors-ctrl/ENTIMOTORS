# ENTIMOTORS OS

Sistema de gestión para un taller de motocicletas. Recibe la moto, la sigue por las
seis etapas de reparación, cobra, controla el inventario, lleva la caja y los
créditos, y le manda al cliente su factura por WhatsApp.

**Versión actual:** 3.13.0 · **Esquema de datos:** IndexedDB v6

---

## Alcance de 3.13.0: identidad, acceso y roles

La 3.13.0 añade **cuentas, roles y acceso multiusuario** al sistema de siempre. No cambia
dónde viven los datos del taller.

**Incluye**

- Autenticación por cuentas (Supabase Auth): correo y contraseña, sesión que se restaura al abrir.
- Roles: administrador, cajero, mecánico y desarrollador.
- Administración de usuarios desde la pantalla «Usuarios y equipo» (solo administrador).
- **ENTIMOTORS Mi Trabajo**: producto separado, con su propio origen, para el acceso de mecánicos.
- Alta sin contraseña con enlace de un solo uso.
- **Recuperación de contraseña mediada por el administrador:** «Usuarios y equipo» → «Generar enlace»
  → compartir el enlace con la persona (ver más abajo). No hay recuperación por correo ni autoservicio.
- `activo=false` falla cerrado: una cuenta dada de baja no abre ninguna base de datos.
- Endurecimiento de seguridad y correcciones de la fase de QA (ver `CHANGELOG.md`).
- PWA con caché propia `entimotors-v3.13.0` y actualización controlada.

**No incluye** (limitaciones conocidas, ver más abajo)

- Asignación real de trabajo del administrador a una **cuenta** de mecánico.
- Transporte de órdenes o citas hacia Mi Trabajo.
- Sincronización entre dispositivos ni datos operativos compartidos por Supabase.

---

## Cómo funciona hoy

Es una **aplicación web instalable (PWA)** que corre **entera dentro del teléfono o
la computadora** y **funciona sin internet**: el taller no se detiene cuando se cae la señal.
Solo necesitan red iniciar sesión con correo, la recuperación de cuenta y la pantalla de usuarios.

Toda la información operativa (clientes, motos, órdenes, citas, ventas, caja, créditos,
inventario…) se guarda en **IndexedDB, en el dispositivo**. Esa decisión es también su
límite principal: si se borra la aplicación o se pierde el teléfono, los datos se van con él.
Por eso el sistema insiste tanto con las copias de seguridad (Ajustes → respaldo y restauración).

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
| **ENTIMOTORS Taller** | administrador y cajero con cuenta; miembros de la lista local `TEAM` si existe `config-local.js` | `entimotors-v3.13.0` | `entimotors_os_demo` |
| **ENTIMOTORS Mi Trabajo** | únicamente **mecánicos con cuenta activa** | `entimotors-mitrabajo-v3.13.0` | `entimotors_os_demo_mec_<id del perfil>` |

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
> políticas de la base hacen el resto. Los **datos operativos** viven en IndexedDB, en el
> dispositivo, y están sujetos a los controles de la aplicación: IndexedDB no tiene políticas de
> seguridad, y lo que llegue al dispositivo se puede leer con las herramientas del navegador.

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

## Limitaciones conocidas de 3.13.0

Estas limitaciones **no son bugs corregidos**: son lo que 3.13.0 no hace.

- **No incluye asignación de trabajo a cuentas de mecánico.** El selector «Mecánico asignado» usa
  la lista local `TEAM` (por nombre); no está vinculado a las cuentas de Supabase.
- **No incluye sincronización entre dispositivos.** Lo que se hace en un dispositivo no aparece en otro.
- **Mi Trabajo no recibe órdenes ni citas desde otro dispositivo todavía.** Es el acceso de los
  mecánicos, y así lo dice la propia pantalla; sus listas solo mostrarían trabajo que ya estuviera
  en ese mismo dispositivo.
- **Los datos operativos permanecen locales en IndexedDB.** No se leen ni se escriben en Supabase:
  la aplicación solo usa Supabase para cuentas (`perfiles` y las funciones de rol).
- **Cerrar sesión en otra pestaña no es inmediato.** La sesión abierta en otra pestaña no se invalida
  visualmente hasta que se recarga; el servidor sí vuelve a comprobar cada acción de administración.
- **La administración de usuarios requiere configurar `apiUrl`** (arriba; ya viene con el backend
  de producción y se comprueba antes de publicar).
- **No hay recuperación por correo ni autoservicio.** La recuperación de una persona la genera el
  administrador («Generar enlace»).
- **La cuenta administradora se recupera desde el panel de Supabase**, no desde la aplicación.

La sincronización y la asignación de trabajo a cuentas quedan para una versión posterior.

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
2. `index.html` → las **8** etiquetas `<script src="…?v=X.Y.Z">` (`build-target`, `supabase-config`,
   `supabase-client`, `auth`, `recovery`, `config-local`, `app` y `usuarios`).
3. `sw.js` → `CACHE_NAME` y las **7** entradas versionadas de `SHELL`.
4. `panel-tecnico.html` → el literal visual de la versión (cosmético: no afecta a la caché).

El build de Mi Trabajo renombra solo `CACHE_NAME` a `entimotors-mitrabajo-vX.Y.Z`: no se edita a mano.
`pruebas/multiusuario/01-pwa-3.13.0.test.mjs` comprueba la coherencia de todo esto.

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

3.13.0 está lista para un **piloto con cuentas y roles**, con los datos del taller **locales a cada
dispositivo** y respaldo semanal guardado fuera del teléfono. **Todavía no** para trabajo compartido
entre varios dispositivos: eso llega con la sincronización.

Ver [`CHANGELOG.md`](CHANGELOG.md) para el detalle de cada versión.
