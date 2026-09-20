# QA en navegador real (Chrome/Chromium + Firefox) — candidato multiusuario 3.13.0 (FASE 4E-C3-BROWSER)

Complementa la suite de `node:test` (`pruebas/multiusuario/*.test.mjs`, que usa un DOM sintético) ejecutando el **runtime real**
(`taller-demo/`) dentro de motores de navegador **reales**, con DOM real, `IndexedDB`/`localStorage` reales, `fetch` real y
Service Worker + `CacheStorage` reales. **Solo la red es sintética.** Local, sin producción, sin dependencias, sin `npm install`.

```bash
# desde la raiz del repositorio (Node >= 20). Usa los navegadores YA instalados (google-chrome/chromium y firefox)
node pruebas/multiusuario/browser/browser-runner.mjs                       # todo: 6 suites × cada navegador (≈ 5 min)
node pruebas/multiusuario/browser/browser-runner.mjs --navegador=firefox --suite=app,pwa-upg
node pruebas/multiusuario/browser/browser-runner.mjs --json                # informe completo por stdout (no escribe nada en disco)
```

Sale con `0` solo si todo pasa: ningún caso falla, ninguna suite queda sin terminar, **0 peticiones externas de la página**,
0 peticiones externas inesperadas en el sumidero y los archivos de runtime recibidos son idénticos a los del repositorio.
Este directorio **no** entra en `node --test pruebas/multiusuario/*.test.mjs` (no hay `*.test.mjs` aquí) ni toca `pruebas/package.json`.

## Cómo funciona

| Pieza | Qué hace |
|---|---|
| `browser-runner.mjs` | Localiza los navegadores (sin instalar nada), genera **en `/tmp`** el build de «Mi Trabajo» con `hacer-build-mecanicos.sh`, lee el `sw.js` de `HEAD` (3.12.2) con `git show`, arranca los servidores, lanza cada suite con un **perfil temporal nuevo** y un **proxy-sumidero**, espera el resultado, mata el navegador y borra perfiles y build. |
| `server.mjs` | Servidores HTTP en `127.0.0.1` (puerto dinámico; **un origen por suite** = almacenamiento/CacheStorage aislados). Sirve el runtime **sin modificarlo en disco**. Incluye el proxy-sumidero. |
| `collector.mjs` | Recibe en `/__test_result` los casos que la página envía; solo en memoria. |
| `harness.html` / `harness.js` | Página autoejecutable que carga la suite y reporta cada caso. |
| `helpers/prelude.js` | Se inyecta **en memoria** como primer script de `index.html`/`panel-tecnico.html`: cierra la red, captura errores y puentea el entorno (ver abajo). |
| `helpers/mock-navegador.js` | Carga en el navegador el **mismo** servidor sintético que usa la suite de node (`helpers/supabase-mock.mjs`), dándole solo el `Buffer` que necesita. |
| `helpers/pagina.js` | Banco de casos, apertura de la app en un iframe, esperas, canario de contraseña, clasificación de errores. |
| `helpers/suite-app.js` | Aplicación real: F-SEC-1, F-SEC-2, F-FUNC-1, OBS-3/4/5, rol desconocido, auth/activo, usuarios, panel técnico, IndexedDB, copy de Mi Trabajo, copy sin sincronización (chip y avisos de «Simular sin conexión» en el DOM real), controles. Variante «Mi Trabajo». |
| `helpers/suite-mutantes.js` | Sirve el runtime con **siete correcciones revertidas en memoria** (F-SEC-1, F-SEC-2, F-FUNC-1, OBS-3, OBS-4, OBS-5 y la lista blanca de roles) y exige que cada defecto se **detecte** (la suite puede fallar). |
| `helpers/suite-pwa.js` | Service Worker y cachés reales: taller, Mi Trabajo y actualización 3.12.2 → 3.13.0. |
| `helpers/suite-c7fixb.js` | 4E-C7-FIX-B (lo invoca `suite-app.js` al final): **OBS-9 plan B**. Taller: Usuarios → «Generar enlace» (solo personas activas que no son admin), confirmación, caja de resultado **a la vista** en 1024×640, «Copiar enlace» exacto (API y `execCommand`), vida del enlace (reemplazo, «Cerrar», salir de la vista, cerrar sesión) y que **no queda** en localStorage, sessionStorage ni IndexedDB (contenido real), consola ni bitácora; errores/XSS como texto; recorrido completo de un **cajero** (enlace → abrirlo → contraseña nueva → entra al Taller). Mi Trabajo: recorrido de un **mecánico** (entra a Mi Trabajo). Ambos: ayuda del login en escritorio y móvil, y texto de recovery vs invite. |
| `helpers/suite-c7fixa.js` | 4E-C7-FIX-A (lo invoca `suite-app.js` al final): **OBS-7** (chip del usuario MEDIDO en el motor real, escritorio 1280 y móvil 390, nombre normal y de 56 letras), **OBS-8** («+ Nuevo usuario» deja el formulario y el enlace generado a la vista en 1280×900, 1024×640 y 390×844, y antes de la lista) y **OBS-10** («Buscar actualización ahora» contra un Service Worker FALSO y controlable: ACTIVE, WAITING, INSTALLING, OFFLINE, sin SW, «Ahora no», «Solo crear copia» y «Crear copia y actualizar» con la copia real de IndexedDB). El SW REAL de este flujo se prueba aparte, en el entorno PWA. |

### Qué se sustituye y qué no

* **Byte a byte del repositorio:** `app.js`, `auth.js`, `usuarios.js`, `recovery.js`, `build-target.js`, `supabase-client.js`, `sw.js`,
  `manifest.json`, iconos, `panel-tecnico.html` salvo lo indicado abajo. La suite `INTEGRIDAD` hashea en el navegador cada archivo y el runner lo compara con el disco.
* **Solo en las suites de aplicación (`app`, `mt`, `mut`) y solo EN MEMORIA del servidor local:**
  1. `index.html` / `panel-tecnico.html`: se antepone `prelude.js` y se cambia el `<script>` de Chart.js del CDN por un archivo vacío local
     (el runtime ya contempla «sin Chart»: `typeof Chart === "undefined"`).
  2. `supabase-config.js`: se sirve una configuración **sintética** (el real trae la URL de producción de Supabase).
* **Suites de PWA/SW (`pwa-*`): nada se sustituye**; ni siquiera hay prelude.
* En las suites de aplicación se usa el **bypass propio del código** (`sessionStorage.enti_dev_bypass = "1"`) para saltar «Instala la app», y
  `navigator.serviceWorker` es un stub que solo anota el registro (el SW real se prueba en sus propios orígenes).

### Red cerrada (tres capas)

1. **En la página** (`prelude.js`): `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` y `sendBeacon` solo admiten los dos hosts sintéticos
   (`synthetic-test.supabase.co`, `api.synthetic.test`, atendidos por el mock) y `127.0.0.1`. Cualquier otro destino se rechaza y se anota como
   `UNEXPECTED_EXTERNAL_REQUEST` → el caso **falla**. Además se audita `PerformanceResourceTiming` (imágenes, scripts, hojas de estilo…).
2. **En el navegador:** proxy-sumidero (`--proxy-server` en Chrome; `network.proxy.*` en Firefox; `127.0.0.1` exento). Todo lo demás llega a un
   servidor local que lo anota y responde 502: **no existe salida real a Internet**. Se clasifica en `BROWSER_BACKGROUND` (telemetría/actualizaciones del
   propio navegador: dominios de Google/Mozilla), `EXPECTED_SW_EXTRAS` (el `sw.js` real intenta bajar `html2canvas` y `jspdf` del CDN con `.catch`) y
   `UNEXPECTED_EXTERNAL_REQUEST` (cualquier otra cosa → el runner falla).
3. **Producción intocable:** el `supabase-config.js` real nunca se sirve a la app bajo prueba.

### Canarios (sin `alert()`)

`window.__xss` arranca en `0`; los payloads (`<img src=x onerror="window.__xss=N">`, `<svg onload=…>`, `<script>…</script>`, `"'><svg onload=…>`) lo
cambiarían si se ejecutaran. Se comprueba (a) que sigue en `0`, (b) que el DOM **no** ganó `img/svg/script/iframe/manejadores` y (c) que el texto visible
es el literal. Un **caso de control** demuestra que el detector funciona en cada motor (`img/onerror` **sí** ejecuta si se inyecta sin escapar;
`<script>` por `innerHTML` queda inerte; en Chrome 153 y Firefox 155 `<svg onload>` por `innerHTML` tampoco dispara, por eso también se valida la estructura).
La **contraseña sintética** se genera en memoria, nunca se imprime ni se envía: solo se busca (`PRESENTE`/`AUSENTE`) en DOM, `localStorage`, `sessionStorage` y consola.

## Límites (qué NO prueba)

* No es un navegador «de usuario»: cada suite corre en **headless** con perfil vacío. No se prueba render/CSS/responsive ni accesibilidad.
* El **api-server**, Supabase Auth/PostgREST/RLS reales y la publicación (Render/Netlify) quedan fuera; la red es sintética.
* **Multi-pestaña:** se usan dos *iframes* del mismo origen (comparten `localStorage`), no pestañas reales; sin WebDriver no se abren ventanas de forma fiable.
* Safari/WebKit (iOS) **no** está cubierto: la app es una PWA pensada también para iPhone.
* Las diferencias de política de Service Worker entre «pestaña abierta» y «app instalada» (modo standalone) no se reproducen.
* Este QA no sustituye a una revisión visual manual.
