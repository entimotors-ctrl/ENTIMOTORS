// 3.15.0 · CHECKPOINT 8A · CLIENT-STARTUP-07…14: «a veces entra y a veces no» · «me saca». App REAL + GoTrue REAL (pila local, nunca
// producción), inicio de sesión por la pantalla, la sesión de verdad (supabase-client.js + auth.js, SIN la sesión simulada del arnés).
// B8A_VERSION=3.14.1 = la app de PRODUCCIÓN (commit e807f65, esquema sin 15*); por defecto la 3.15 del árbol. Solo observa y clasifica:
//   ABRE_OK · ABRE_Y_EXPULSA · NO_ABRE · SESSION_EXPIRED (login sin expulsión) · PWA_INSTALL_GATE · APP_CRASH · UNKNOWN
// El navegador de prueba no es una PWA instalada: cada apertura pasa por «Usar en esta pestaña sin instalar» (solo de la sesión), como
// haría la app instalada (standalone) — la pantalla de instalar NO cuenta como expulsión.
//   node --test --test-concurrency=1 pruebas/sync/gotrue/b8a-arranque.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { iniciarPila, REST_URL, RAIZ, FASES, AUTH_INTERNO } from "../browser/lib/pila.mjs";
import { abrirDispositivo, NAVEGADORES } from "../browser/lib/dispositivo.mjs";

const NAVS = (process.env.SYNC_NAVEGADORES || "chromium").split(",").filter((n) => NAVEGADORES[n]);
const V = process.env.B8A_VERSION || "3.15";
const RAIZ_APP = V === "3.14.1" ? path.resolve(RAIZ, "../ENTIMOTORS-3.15-bloque8/candidatos/base-3.14.1/taller-demo") : null;
const AUTH_OK = `http://127.0.0.1:${AUTH_INTERNO}`;
let pila, cuenta, lento = null; const R = {};
const SRV = () => pila.jwt(undefined, { role: "service_role" });
async function gt(ruta, { m = "GET", body } = {}) {
  const r = await fetch(REST_URL + ruta, { method: m, headers: { apikey: "anon-sintetica", Authorization: `Bearer ${SRV()}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j };
}
// proxy que RETRASA el Auth (refresco lento): reenvía a GoTrue tras `retrasoMs`
function proxyLento(retrasoMs) {
  const srv = http.createServer((req, res) => { let b = []; req.on("data", (d) => b.push(d)); req.on("end", () => setTimeout(() => {
    const p = http.request({ host: "127.0.0.1", port: AUTH_INTERNO, path: req.url, method: req.method, headers: req.headers }, (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
    p.on("error", () => { res.writeHead(502); res.end(); }); p.end(Buffer.concat(b)); }, retrasoMs)); });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${srv.address().port}`, cerrar: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) })));
}
before(async () => {
  pila = await iniciarPila({ gotrue: true, ...(V === "3.14.1" ? { excluir: FASES.filter((f) => /^15/.test(f)) } : {}) });
  cuenta = { correo: `b8a-${crypto.randomBytes(3).toString("hex")}@example.test`, pass: `frase ${crypto.randomBytes(9).toString("base64url")} lenta` };
  const r = await gt("/auth/v1/admin/users", { m: "POST", body: { email: cuenta.correo, password: cuenta.pass, email_confirm: true } });
  assert.equal(r.s, 200, "alta de la cuenta de laboratorio"); cuenta.id = r.j.id;
  pila.sql(`set session_replication_role = replica; update public.perfiles set nombre = 'Dueño 8A', rol = 'admin', activo = true where id = '${cuenta.id}'; reset session_replication_role;`);
});
after(async () => { await lento?.cerrar(); pila?.authRealUrl(AUTH_OK); spawnSync("docker", ["start", "entimotors-sync-rest"]); await pila?.detener(); console.log(`B8A_ARRANQUE ${V} ${JSON.stringify(R)}`); });

// abrir «como app instalada»: bypass de la pestaña (solo sesión) y recarga
async function entrarComoApp(d) {
  await d.eval(() => { sessionStorage.setItem("enti_dev_bypass", "1"); if (!localStorage.getItem("enti_modo_datos")) localStorage.setItem("enti_modo_datos", "blanco"); setTimeout(() => location.reload(), 50); return true; }, null, { plazoMs: 10000 }).catch(() => {});
  await esperarPagina(d);
}
async function esperarPagina(d, ms = 30000) {
  const h = Date.now() + ms;
  while (Date.now() < h) { try { const ok = await d.eval(() => document.readyState === "complete" && typeof VERSION_APP !== "undefined", null, { plazoMs: 4000 }); if (ok) return; } catch { /* recargando */ } await new Promise((r) => setTimeout(r, 400)); }
  throw new Error("la página no volvió");
}
// foto de la pantalla y de la sesión (sin tokens: solo si existen y cuándo caducan)
const pantalla = (d) => d.eval(() => {
  let s = null; try { s = JSON.parse(localStorage.getItem("entimotors_sb_sesion") || "null"); } catch { s = "ILEGIBLE"; }
  const act = (id) => !!document.getElementById(id)?.classList.contains("active");
  return { shell: act("shell"), login: act("gateLogin"), install: act("gateInstall"), almacen: act("gateAlmacen"), loginError: document.getElementById("loginError")?.textContent.slice(0, 120) || "",
    toast: [...document.querySelectorAll(".toast, #toast")].map((t) => t.textContent.trim()).filter(Boolean).slice(-2),
    sesion_sb: s === "ILEGIBLE" ? s : s ? { exp_en_s: s.expires_at ? Math.round(s.expires_at - Date.now() / 1000) : null, refresh: !!s.refresh_token } : null,
    enti_session: !!localStorage.getItem("enti_session"), errores: (window.__errores || []).slice(-3) };
}, null, { plazoMs: 10000 });
function clasificar(p, { antesDentro = false } = {}) {
  if (p.install) return "PWA_INSTALL_GATE";
  if (p.shell) return "ABRE_OK";
  if (p.login) return antesDentro ? "ABRE_Y_EXPULSA" : (p.sesion_sb ? "SESSION_EXPIRED" : "NO_ABRE");
  if (p.almacen) return "APP_CRASH";
  return "UNKNOWN";
}
async function login(d) {
  await d.eval((c) => { document.getElementById("loginUser").value = c.correo; document.getElementById("loginPass").value = c.pass;
    document.getElementById("loginForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); return true; }, cuenta, { plazoMs: 10000 });
  const h = Date.now() + 30000; let p;
  while (Date.now() < h) { p = await pantalla(d).catch(() => null); if (p?.shell) return p; await new Promise((r) => setTimeout(r, 300)); }
  return p;
}
// mueve el vencimiento del access token guardado (simula el paso del tiempo) sin tocar el refresh token
const fijarVencimiento = (d, segundos) => d.eval((s) => { const x = JSON.parse(localStorage.getItem("entimotors_sb_sesion")); x.expires_at = Math.floor(Date.now() / 1000) + s; localStorage.setItem("entimotors_sb_sesion", JSON.stringify(x)); return true; }, segundos, { plazoMs: 10000 });
const escribirYVer = async (d, nombre, ms = 25000) => {   // ¿la nube recibe lo que se hace? (sesión de verdad usable)
  await d.eval((n) => DB.save("clientes", { nombre: n, telefono: "" }).then(() => true), nombre, { plazoMs: 15000 }).catch(() => null);
  const h = Date.now() + ms; while (Date.now() < h) { if (pila.sql(`select count(*) from public.clientes where nombre = '${nombre}'`) === "1") return true; await new Promise((r) => setTimeout(r, 500)); }
  return false;
};
async function sesionAbierta(nav, et) {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8a-ini-${et}-${nav}`, pagina: "index.html", real: true, raiz: RAIZ_APP });
  await entrarComoApp(d);
  const p = await login(d);
  assert.equal(p?.shell, true, `login real (${et}): ${JSON.stringify(p)}`);
  return d;
}

if (process.env.B8A_DIAG_LOGIN) for (const nav of NAVS) test(`diag login · ${V} · ${nav}`, async () => {
  const d = await abrirDispositivo({ navegador: nav, nombre: `b8a-diag-${nav}`, pagina: "index.html", real: true, raiz: RAIZ_APP });
  try { await entrarComoApp(d);
    const r = await d.eval(async (c) => ({ disponible: Auth.disponible(), cfg: { url: !!window.ENTIMOTORS_SUPABASE?.url, hab: window.ENTIMOTORS_SUPABASE?.habilitado }, estado: SupabaseCliente.estado(),
      gates: [...document.querySelectorAll(".active")].map((x) => x.id).filter(Boolean), r: await Auth.iniciarSesion(c.correo, c.pass) }), cuenta, { plazoMs: 30000 });
    console.log("DIAG_LOGIN " + JSON.stringify(r));
  } finally { await d.cerrar(); }
});
for (const nav of NAVS) if (!process.env.B8A_DIAG_LOGIN) {
  test(`STARTUP-07 sesión válida (abre y escribe en la nube) + STARTUP-14 cerrar/reabrir ×3 · ${V} · ${nav}`, async () => {
    const d = await sesionAbierta(nav, "07"); const r = {};
    try {
      r.s07 = { pantalla: clasificar(await pantalla(d)), nube: await escribirYVer(d, "STARTUP-07") };
      r.s14 = [];
      for (let i = 1; i <= 3; i++) { await new Promise((x) => setTimeout(x, 7000)); await d.reabrir(90000); await esperarPagina(d); const g = clasificar(await pantalla(d)); await entrarComoApp(d);
        const p = await pantalla(d); r.s14.push({ al_reabrir: g, como_app: clasificar(p, { antesDentro: true }), sesion: p.sesion_sb }); }
    } finally { R[`07_14_${nav}`] = r; await d.cerrar(); }
  });
  test(`STARTUP-08 access token VENCIDO al abrir (refresh token válido) y a punto de vencer · ${V} · ${nav}`, async () => {
    const d = await sesionAbierta(nav, "08"); const r = {};
    try {
      await fijarVencimiento(d, -60); await entrarComoApp(d); await new Promise((x) => setTimeout(x, 3000));
      const p = await pantalla(d); r.vencido_al_abrir = { pantalla: clasificar(p, { antesDentro: true }), sesion: p.sesion_sb, login: p.loginError };
      r.vencido_nube = p.shell ? await escribirYVer(d, "STARTUP-08") : "no entró";
      const p2 = await pantalla(d); r.vencido_tras_trabajar = { pantalla: clasificar(p2, { antesDentro: true }), sesion: p2.sesion_sb };
      // a punto de vencer (el refresco programado salta a los ~5 s)
      if (p2.shell) { await fijarVencimiento(d, 125); await entrarComoApp(d); await new Promise((x) => setTimeout(x, 15000)); const p3 = await pantalla(d);
        r.casi_vencido = { pantalla: clasificar(p3, { antesDentro: true }), sesion: p3.sesion_sb }; }
    } finally { R[`08_${nav}`] = r; await d.cerrar(); }
  });
  test(`STARTUP-09 refresco LENTO (3 s y 12 s) · STARTUP-10 refresco que FALLA por red un momento · ${V} · ${nav}`, async () => {
    const d = await sesionAbierta(nav, "09"); const r = {};
    try {
      for (const ms of [3000, 12000]) {
        lento = await proxyLento(ms); pila.authRealUrl(lento.url);
        await fijarVencimiento(d, 125); await entrarComoApp(d); await new Promise((x) => setTimeout(x, 8000 + ms + 3000));
        const p = await pantalla(d); r[`lento_${ms}`] = { pantalla: clasificar(p, { antesDentro: true }), sesion: p.sesion_sb, toast: p.toast };
        pila.authRealUrl(AUTH_OK); await lento.cerrar(); lento = null;
        if (!p.shell) { await entrarComoApp(d); await login(d); }
      }
      // STARTUP-10: el refresco programado coincide con 20 s sin Auth (red caída un momento) y después vuelve
      await fijarVencimiento(d, 125); await entrarComoApp(d);
      pila.authRealUrl("http://127.0.0.1:1"); await new Promise((x) => setTimeout(x, 12000));
      const p = await pantalla(d); r.falla_temporal = { pantalla: clasificar(p, { antesDentro: true }), sesion: p.sesion_sb, toast: p.toast };
      pila.authRealUrl(AUTH_OK); await new Promise((x) => setTimeout(x, 10000)); await esperarPagina(d).catch(() => {});
      const p2 = await pantalla(d).catch(() => ({})); r.falla_temporal_despues = { pantalla: clasificar(p2, { antesDentro: true }), sesion: p2.sesion_sb, loginError: p2.loginError };
      r.refresh_token_seguia_valido = (await gt("/auth/v1/admin/users/" + cuenta.id)).s === 200;
    } finally { pila.authRealUrl(AUTH_OK); R[`09_10_${nav}`] = r; await d.cerrar(); }
  });
  test(`STARTUP-11 backend sí / Auth no · STARTUP-12 Auth sí / backend no · STARTUP-13 excepción en el arranque · ${V} · ${nav}`, async () => {
    const d = await sesionAbierta(nav, "11"); const r = {};
    try {
      pila.authRealUrl("http://127.0.0.1:1"); await entrarComoApp(d); await new Promise((x) => setTimeout(x, 4000));
      let p = await pantalla(d); r.s11 = { pantalla: clasificar(p, { antesDentro: true }), sesion: p.sesion_sb }; pila.authRealUrl(AUTH_OK);
      spawnSync("docker", ["stop", "-t", "1", "entimotors-sync-rest"]); await entrarComoApp(d); await new Promise((x) => setTimeout(x, 12000));
      p = await pantalla(d); r.s12 = { pantalla: clasificar(p, { antesDentro: true }), sesion: p.sesion_sb, loginError: p.loginError };
      spawnSync("docker", ["start", "entimotors-sync-rest"]); await new Promise((x) => setTimeout(x, 4000));
      if (!p.shell) { await entrarComoApp(d); await login(d); }
      await d.eval(() => { localStorage.setItem("enti_session", "{roto"); return true; }, null, { plazoMs: 5000 }); await entrarComoApp(d); await new Promise((x) => setTimeout(x, 4000));
      p = await pantalla(d); r.s13 = { pantalla: clasificar(p, { antesDentro: true }), sesion: p.sesion_sb, loginError: p.loginError };
    } finally { pila.authRealUrl(AUTH_OK); spawnSync("docker", ["start", "entimotors-sync-rest"]); R[`11_13_${nav}`] = r; await d.cerrar(); }
  });
}
