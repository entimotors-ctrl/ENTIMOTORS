// build-target.js y la SEPARACION taller / «Mi Trabajo»: como decide app.js que producto es esta copia,
// que defaults aplica y que no cruza de una app a la otra. Las expectativas salen del diseno documentado
// en build-target.js y en app.js (l. 31-72): «si falta, se asume el taller».
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, leer, sinLlamadasAjenas } from "./helpers/entorno.mjs";
import { nuevoEntorno, enviarLogin, activo, CUENTAS } from "./helpers/flujos.mjs";

const producto = (build) => {
  const env = crearEntorno({ producto: build });
  return { p: env.evaluar("PRODUCTO"), mec: env.evaluar("ES_APP_MECANICOS"), local: env.evaluar("PERMITE_LOGIN_LOCAL"), env };
};

describe("build-target.js — los dos archivos reales", () => {
  test("el build del taller declara producto «admin» y nada mas", () => {
    const env = crearEntorno({ scripts: ["build-target"], producto: "admin" });
    assert.deepEqual(JSON.parse(JSON.stringify(env.win.ENTIMOTORS_BUILD)), { producto: "admin" });
  });
  test("el build de «Mi Trabajo» (build-mecanicos/build-target.js) declara producto «mecanico» y nada mas", () => {
    const env = crearEntorno({ scripts: ["build-target"], producto: "mecanico" });
    assert.deepEqual(JSON.parse(JSON.stringify(env.win.ENTIMOTORS_BUILD)), { producto: "mecanico" });
  });
  test("los dos son archivos distintos y no se pisan (el de mecanicos NO es el que hay en la raiz)", () => {
    assert.notEqual(leer("build-target.js"), leer("build-mecanicos/build-target.js"));
    assert.ok(leer("build-target.js").includes('producto: "admin"') && !leer("build-target.js").includes('producto: "mecanico"'));
    assert.ok(leer("build-mecanicos/build-target.js").includes('producto: "mecanico"') && !leer("build-mecanicos/build-target.js").includes('producto: "admin"'));
  });
});

describe("app.js — PRODUCTO, ES_APP_MECANICOS y PERMITE_LOGIN_LOCAL", () => {
  test("taller: producto admin, sin modo mecanicos, login local permitido", () => {
    const r = producto("admin"); assert.deepEqual([r.p, r.mec, r.local], ["admin", false, true]);
  });
  test("Mi Trabajo: producto mecanico, modo mecanicos, login local PROHIBIDO", () => {
    const r = producto("mecanico"); assert.deepEqual([r.p, r.mec, r.local], ["mecanico", true, false]);
  });
  // «Sin este archivo se asume "admin", que es la operacion historica»: el default documentado.
  const CASOS_ADMIN = [
    ["ausencia de build-target.js (default documentado)", "ninguno"],
    ["producto desconocido «foo»", { producto: "foo" }],
    ["producto vacio", { producto: "" }],
    ["producto undefined", { producto: undefined }],
    ["ENTIMOTORS_BUILD = null", null],
    ["mayusculas «Mecanico» (comparacion estricta)", { producto: "Mecanico" }],
    ["con espacios «mecanico »", { producto: "mecanico " }],
    ["arreglo [«mecanico»]", { producto: ["mecanico"] }],
    ["objeto con toString() «mecanico»", { producto: { toString: () => "mecanico" } }],
    ["numero 1", { producto: 1 }],
  ];
  for (const [nombre, build] of CASOS_ADMIN) {
    test(`target invalido/ausente → cae a «admin» y no activa nada de mecanicos: ${nombre}`, () => {
      const r = producto(build); assert.deepEqual([r.p, r.mec, r.local], ["admin", false, true]);
    });
  }
  test("un build de mecanicos al que le falta build-target.js arranca como TALLER (GAP de diseno: default «admin»)", () => {
    // Documentado en hacer-build-mecanicos.sh: por eso no hay _redirects y se prefiere un 404 franco.
    const r = producto("ninguno"); assert.equal(r.p, "admin");
    assert.ok(leer("hacer-build-mecanicos.sh").includes("Mejor un 404 franco"), "la mitigacion documentada ya no esta");
  });
});

describe("Separacion de apps: nombre de base, vistas y login local", () => {
  const perfilMec = "11111111-1111-4111-8111-111111111111";
  const sMecSB = { rol: "mecanico", origen: "supabase", perfilId: perfilMec, activo: true };
  const sAdminLocal = { rol: "admin", origen: "local" }, sMecLocal = { rol: "mecanico", origen: "local" };
  const sAdminSB = { rol: "admin", origen: "supabase", perfilId: "22222222-2222-4222-8222-222222222222", activo: true };

  test("TALLER: la base es entimotors_os_demo para admin/cajero/local; el mecanico con cuenta usa una base PROPIA por perfilId", () => {
    const { env } = producto("admin"), f = env.win.nombreBaseParaSesion;
    assert.equal(f(sAdminLocal), "entimotors_os_demo");
    assert.equal(f(sAdminSB), "entimotors_os_demo");
    assert.equal(f(sMecLocal), "entimotors_os_demo");
    assert.equal(f(sMecSB), `entimotors_os_demo_mec_${perfilMec}`);
    assert.equal(env.evaluar("BASE_TALLER"), "entimotors_os_demo");
  });
  test("MI TRABAJO: NUNCA abre la base del taller — todo lo que no es un mecanico con cuenta devuelve null", () => {
    const { env } = producto("mecanico"), f = env.win.nombreBaseParaSesion;
    assert.equal(f(sMecSB), `entimotors_os_demo_mec_${perfilMec}`);
    for (const s of [sAdminLocal, sAdminSB, sMecLocal, { rol: "cajero", origen: "supabase", perfilId: perfilMec }, { rol: "mecanico", origen: "supabase" }, null, undefined, {}]) assert.equal(f(s), null, JSON.stringify(s));
  });
  test("las bases de dos mecanicos distintos son distintas y no colisionan con la del taller", () => {
    const { env } = producto("admin"), f = env.win.nombreBaseParaSesion;
    const a = f({ ...sMecSB, perfilId: "aaaaaaaa-0000-4000-8000-000000000001" }), b = f({ ...sMecSB, perfilId: "bbbbbbbb-0000-4000-8000-000000000002" });
    assert.notEqual(a, b); assert.notEqual(a, "entimotors_os_demo"); assert.notEqual(b, "entimotors_os_demo");
  });
  test("vista inicial: «mi-trabajo» solo para el mecanico con cuenta; el resto arranca en dashboard", () => {
    const { env } = producto("admin");
    const con = (u) => { env.evaluar(`currentUser = ${JSON.stringify(u)}`); return env.evaluar("vistaInicial()"); };
    assert.equal(con(sMecSB), "mi-trabajo");
    for (const u of [sAdminSB, sAdminLocal, sMecLocal, null]) assert.equal(con(u), "dashboard", JSON.stringify(u));
  });
  test("el CACHE del taller y el de mecanicos no se comparten (el build renombra el prefijo)", () => {
    assert.match(leer("sw.js"), /const CACHE_NAME = "entimotors-v3\.14\.0";/);   // 3.14.0 (3.13.0 lo vigila 01-pwa-3.13.0 sobre el tag)
    assert.match(leer("hacer-build-mecanicos.sh"), /s\/\^const CACHE_NAME = "entimotors-\/const CACHE_NAME = "entimotors-mitrabajo-\//);
  });
});

describe("Login local por producto (aunque alguien inyecte window.ENTIMOTORS_LOCAL)", () => {
  const LOCAL = { teamPasswords: { prueba: "clave-local-sintetica" } };
  test("TALLER: con la clave local correcta, la cuenta de la lista TEAM entra (origen local) y la sesion se guarda", async () => {
    const env = nuevoEntorno({ producto: "admin", local: LOCAL }); await env.asentar();
    const r = await enviarLogin(env, "prueba", "clave-local-sintetica");
    assert.equal(r.error, ""); assert.equal(r.claveEnDom, "", "la clave no debe quedarse en el DOM");
    const s = JSON.parse(env.almacen.getItem("enti_session"));
    assert.deepEqual([s.user, s.rol, s.origen], ["prueba", "admin", "local"]);
    assert.equal(env.startApp.length, 1); sinLlamadasAjenas(env);
  });
  test("TALLER: sin config-local (ENTIMOTORS_LOCAL ausente) el login local queda deshabilitado", async () => {
    const env = nuevoEntorno({ producto: "admin" }); await env.asentar();
    const r = await enviarLogin(env, "prueba", "lo-que-sea");
    assert.equal(r.error, "Usuario o contraseña incorrectos."); assert.equal(env.almacen.getItem("enti_session"), null); assert.equal(env.startApp.length, 0);
  });
  test("TALLER: clave local incorrecta o vacia NO entra", async () => {
    const env = nuevoEntorno({ producto: "admin", local: LOCAL }); await env.asentar();
    for (const clave of ["mala", "", "clave-local-sintetica "]) { const r = await enviarLogin(env, "prueba", clave); assert.equal(r.error, "Usuario o contraseña incorrectos.", JSON.stringify(clave)); }
    assert.equal(env.startApp.length, 0);
  });
  test("MI TRABAJO: el login local se corta ANTES de mirar la lista TEAM, aunque la clave local sea correcta", async () => {
    const env = nuevoEntorno({ producto: "mecanico", local: LOCAL }); await env.asentar();
    const r = await enviarLogin(env, "prueba", "clave-local-sintetica");
    assert.equal(r.error, "Aquí se entra solo con tu correo y contraseña de ENTIMOTORS.");
    assert.equal(env.almacen.getItem("enti_session"), null, "no debe guardarse ninguna sesion"); assert.equal(env.startApp.length, 0);
    assert.deepEqual(env.idbAbiertas, [], "no debe abrirse ninguna base"); sinLlamadasAjenas(env);
  });
  test("MI TRABAJO: un usuario de TEAM de rol mecanico tampoco entra por el camino local", async () => {
    const env = nuevoEntorno({ producto: "mecanico", local: { teamPasswords: { mecanico1: "x-sintetica" } } }); await env.asentar();
    const r = await enviarLogin(env, "mecanico1", "x-sintetica");
    assert.match(r.error, /solo con tu correo/); assert.equal(env.startApp.length, 0);
  });
  test("el arranque sin sesion muestra el login en ambos productos y no llama al servidor", async () => {
    for (const p of ["admin", "mecanico"]) {
      const env = nuevoEntorno({ producto: p }); await env.asentar();
      assert.equal(activo(env, "gateLogin"), true, p); assert.equal(env.startApp.length, 0, p); assert.equal(env.servidor.llamadas.length, 0, p);
    }
  });
});
