// SYNC-6 sección 2 (hallazgo pendiente de SYNC-5): smoke/integration test que carga taller-demo/index.html DE
// VERDAD (no el arnés sintético de las demás pruebas de esta carpeta) y demuestra que el adaptador cloud de
// app.js (prepararModoNube/DB.*) queda conectado de verdad. abrirDispositivo({real:true}) sirve el HTML/JS de
// taller-demo/ tal cual, con el puente de pruebas inyectado justo antes de </body> (index.html en disco no se
// toca), y dispositivo.mjs sustituye supabase-config.js por una versión sintética que apunta al gateway local
// ANTES de que supabase-client.js la lea — así esta prueba NUNCA toca producción.
//   node --test pruebas/sync/browser/sync6-app-real.test.mjs          (requiere pruebas/sync/entorno-local.sh up y Docker)
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarPila, PERFILES } from "./lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "./lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium,firefox").split(",").filter((n) => NAVEGADORES[n]);
let pila;
before(async () => { pila = await iniciarPila(); });
after(async () => { await pila?.detener(); });

for (const nav of NAVS) {
  describe(`SYNC-6 · app real (index.html + app.js de verdad) · ${nav}`, () => {
    test("arranque en modo nube, DB.* conectado al adaptador, lee clientes reales, y entimotors_os_demo (v6) NO se toca", async () => {
      pila.limpiar();
      pila.sql(`insert into public.clientes (nombre) values ('Cliente app real ${nav}')`);

      const d = await abrirDispositivo({ navegador: nav, nombre: `app-real-${nav}`, pagina: "index.html", real: true });
      try {
        const r = await d.eval(async (a) => {
          // Sesión de admin simulada: nunca se pasa por el login UI (ver SYNC-5, "Pendiente") ni por Auth real
          // — se sustituyen los dos métodos que el adaptador consulta, igual que montar.js hace con __sesion.
          window.SupabaseCliente.sesion = function () { return { access_token: a.token }; };
          window.SupabaseCliente.estado = function () { return { activo: true, conSesion: true, usuario: "admin@example.test" }; };
          window.SupabaseCliente.refrescarSesion = async function () { return { ok: true }; };
          // currentUser/prepararModoNube/DB/syncMotor son bindings let/const de app.js: al ser un <script>
          // clásico (no módulo) comparten el mismo entorno léxico global que el puente inyectado, así que se
          // leen/escriben como identificadores sueltos — nunca window.currentUser (eso no existe: no es var).
          currentUser = { uid: a.id, nombre: "Admin", rol: "admin", origen: "supabase", activo: true, perfilId: null, user: null };
          await prepararModoNube({ rol: "admin", origen: "supabase", activo: true, uid: a.id });
          const conectado = typeof syncMotor !== "undefined" && !!syncMotor;
          const clientes = conectado ? await DB.getAll("clientes") : [];
          let bases = null;
          if ("indexedDB" in window && indexedDB.databases) bases = (await indexedDB.databases()).map(function (b) { return b.name; });
          return { conectado, clientes, bases };
        }, { token: pila.jwt(PERFILES.admin), id: PERFILES.admin });

        assert.equal(r.conectado, true, "prepararModoNube() del app.js REAL dejó syncMotor armado (adaptador cloud conectado)");
        assert.ok(r.clientes.some((c) => c.nombre === `Cliente app real ${nav}`), "DB.getAll('clientes') del adaptador real trae lo que hay en la nube (lectura de una entidad SYNC-5)");
        if (r.bases) assert.ok(!r.bases.includes("entimotors_os_demo"), "cargar la app real en modo nube no crea/toca entimotors_os_demo (v6)");
      } finally { await d.cerrar(); }
    });
  });
}
