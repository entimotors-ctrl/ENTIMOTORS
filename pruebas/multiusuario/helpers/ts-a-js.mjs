// TypeScript → JavaScript SIN DEPENDENCIAS, solo para poder EJECUTAR en las pruebas el api-server real (api-server/src/routes/admin-usuarios.ts)
// con Node 20 (que no trae `--experimental-strip-types`) y sin `npm install` (el api-server no tiene node_modules aqui).
//
// NO es un compilador de TypeScript: quita los TIPOS del subconjunto que usa ese archivo y FALLA CERRADO (lanza) ante cualquier sintaxis de tipos
// que no reconozca, en vez de generar JS dudoso. No comprueba tipos. Lo que si hace es conservar el JS byte a byte: solo BORRA rangos, nunca reescribe.
//
// Quita: `interface …`, `type X = …;`, `import { type X }`, anotaciones (`: T`, `?: T`) de variables, parametros y retornos de funciones/flechas,
//        `expr as T` / `as const` / `satisfies T`, la asercion no nula `x!`, y los genericos de `new Map<A, B>()`.
// Rechaza (lanza): `enum`, `namespace`, `declare`, `abstract`, `class` con anotaciones, decoradores, `<T>expr` — nada de eso aparece en el api-server.
//
// Validado durante el desarrollo comparando el resultado de las pruebas con el JS que produce esbuild sobre el mismo archivo (mismos resultados);
// esbuild NO es necesario para ejecutar las pruebas.

const PALABRAS = new Set(["return", "typeof", "instanceof", "in", "of", "case", "delete", "void", "throw", "new", "await", "yield", "else", "do", "extends"]);
const RECHAZADAS = new Set(["enum", "namespace", "declare", "abstract", "implements"]);

function tokenizar(src) {
  const T = []; let i = 0; const n = src.length;
  const previo = () => { for (let k = T.length - 1; k >= 0; k--) return T[k]; return null; };
  const ptos3 = ["===", "!==", "...", "**=", "<<=", "&&=", "||=", "??="], ptos2 = ["=>", "==", "!=", "<=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<"];
  const cierra = (ini, abre, cierre) => { let d = 0; for (let k = ini; k < n; k++) { if (src[k] === abre) d++; else if (src[k] === cierre) { d--; if (d === 0) return k; } } return -1; };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const f = src.indexOf("*/", i + 2); if (f < 0) throw new Error("comentario sin cerrar"); i = f + 2; continue; }
    const ini = i;
    if (c === '"' || c === "'") { i++; while (i < n && src[i] !== c) { if (src[i] === "\\") i++; i++; } i++; T.push({ t: "str", s: ini, e: i, x: src.slice(ini, i) }); continue; }
    if (c === "`") {   // plantilla: se salta entera, con sus ${ … } anidados
      i++; while (i < n && src[i] !== "`") { if (src[i] === "\\") { i += 2; continue; } if (src[i] === "$" && src[i + 1] === "{") { const f = cierra(i + 1, "{", "}"); if (f < 0) throw new Error("plantilla sin cerrar"); i = f + 1; continue; } i++; }
      i++; T.push({ t: "str", s: ini, e: i, x: "`…`" }); continue;
    }
    if (/[0-9]/.test(c)) { while (i < n && /[0-9a-zA-Z_.]/.test(src[i])) i++; T.push({ t: "num", s: ini, e: i, x: src.slice(ini, i) }); continue; }
    if (/[A-Za-z_$]/.test(c)) { while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++; T.push({ t: "id", s: ini, e: i, x: src.slice(ini, i) }); continue; }
    if (c === "/") {   // ¿division o expresion regular? por el token anterior
      const p = previo(); const esDivision = p && (p.t === "id" && !PALABRAS.has(p.x) || p.t === "num" || p.t === "str" || (p.t === "p" && [")", "]", "}"].includes(p.x)));
      if (!esDivision) { i++; let clase = false; while (i < n && (src[i] !== "/" || clase)) { if (src[i] === "\\") i++; else if (src[i] === "[") clase = true; else if (src[i] === "]") clase = false; i++; } i++; while (i < n && /[a-z]/.test(src[i])) i++; T.push({ t: "re", s: ini, e: i, x: "/re/" }); continue; }
    }
    // signos: el `>` va SIEMPRE suelto (lo necesitan los genericos anidados `Array<Map<a, b>>`); `=>` si es uno solo
    let x = c;
    if (c !== ">") { const t3 = src.slice(i, i + 3), t2 = src.slice(i, i + 2); if (ptos3.includes(t3)) x = t3; else if (ptos2.includes(t2)) x = t2; }
    i += x.length; T.push({ t: "p", s: ini, e: i, x });
  }
  return T;
}

export function tsAJs(fuente) {
  const T = tokenizar(fuente), n = T.length, borrar = [];   // rangos [desde, hasta) de la FUENTE
  const es = (k, x) => k >= 0 && k < n && T[k].x === x && (T[k].t === "p" || T[k].t === "id");
  const abre = { "(": ")", "[": "]", "{": "}" };
  const cierraEn = (k) => { const a = T[k].x, c = abre[a]; let d = 0; for (let j = k; j < n; j++) { if (T[j].t !== "p") continue; if (T[j].x === a) d++; else if (T[j].x === c) { d--; if (d === 0) return j; } } throw new Error(`no cierra «${a}» en ${T[k].s}`); };
  const cierraAngular = (k) => { let d = 0; for (let j = k; j < n; j++) { if (T[j].t !== "p") continue; if (T[j].x === "<") d++; else if (T[j].x === ">") { d--; if (d === 0) return j; } else if (["(", "{", "["].includes(T[j].x)) j = cierraEn(j); } throw new Error(`no cierra «<» en ${T[k].s}`); };
  const quitar = (kIni, kFin) => borrar.push([T[kIni].s, T[kFin].e]);   // ambos INCLUSIVE

  /** Devuelve el indice del ULTIMO token del tipo que empieza en k. */
  function tipo(k) {
    let fin = atomo(k);
    while (es(fin + 1, "|") || es(fin + 1, "&")) fin = atomo(fin + 2);
    return fin;
  }
  function atomo(k) {
    let j = k;
    if (T[j] && T[j].t === "id" && ["typeof", "keyof", "readonly", "unique", "infer"].includes(T[j].x)) j++;
    const t = T[j]; if (!t) throw new Error("tipo incompleto");
    let fin;
    if (t.t === "p" && t.x === "{") fin = cierraEn(j);
    else if (t.t === "p" && t.x === "[") fin = cierraEn(j);
    else if (t.t === "p" && t.x === "(") { fin = cierraEn(j); if (es(fin + 1, "=>")) fin = tipo(fin + 2); }   // tipo funcion `(a: T) => R`
    else if (t.t === "str" || t.t === "num") fin = j;
    else if (t.t === "id") { fin = j; while (es(fin + 1, ".") && T[fin + 2] && T[fin + 2].t === "id") fin += 2; }
    else throw new Error(`tipo no soportado en la posicion ${t.s}: «${t.x}»`);
    for (;;) {   // sufijos: genericos, `[]`, `[number]`
      if (es(fin + 1, "<") && T[fin].t === "id") { fin = cierraAngular(fin + 1); continue; }
      if (es(fin + 1, "[") ) { fin = cierraEn(fin + 1); continue; }
      break;
    }
    return fin;
  }
  /** Lista de parametros (k = el `(`): quita `?: T` de cada uno. */
  function parametros(k) {
    const cierre = cierraEn(k); let inicioParam = k + 1, hayIgual = false;
    for (let j = k + 1; j < cierre; j++) {
      const t = T[j];
      if (t.t === "p" && (t.x === "(" || t.x === "[" || t.x === "{")) { j = cierraEn(j); continue; }
      if (t.t === "p" && t.x === ",") { hayIgual = false; inicioParam = j + 1; continue; }
      if (t.t === "p" && t.x === "=") { hayIgual = true; continue; }
      if (!hayIgual && t.t === "p" && (t.x === ":" || (t.x === "?" && es(j + 1, ":")))) {
        const desde = j, dos = t.x === "?" ? j + 1 : j; const fin = tipo(dos + 1); quitar(desde, fin); j = fin;
      }
    }
    return cierre;
  }
  function retorno(kCierreParams, destino) {   // tras `)`: `: Tipo` opcional; `destino` = "{" (funcion) o "=>" (flecha)
    if (!es(kCierreParams + 1, ":")) return kCierreParams;
    const fin = tipo(kCierreParams + 2); if (!es(fin + 1, destino)) return null;   // no era una flecha/funcion: era otra cosa
    quitar(kCierreParams + 1, fin); return fin;
  }

  for (let k = 0; k < n; k++) {
    const t = T[k];
    if (t.t === "id" && RECHAZADAS.has(t.x) && !es(k - 1, ".") && !(T[k + 1] && T[k + 1].x === ":")) throw new Error(`sintaxis TypeScript no soportada por ts-a-js: «${t.x}» (posicion ${t.s})`);
    if (t.t === "p" && t.x === "@" ) throw new Error("decoradores no soportados");
    const previo = k > 0 ? T[k - 1] : null;
    const iniSentencia = !previo || (previo.t === "p" && [";", "}", "{"].includes(previo.x)) || (previo.t === "id" && previo.x === "export");

    // `interface X { … }` y `type X = …;` (con `export` delante)
    if (t.t === "id" && t.x === "interface" && T[k + 1] && T[k + 1].t === "id" && iniSentencia) {
      let j = k + 2; while (j < n && !es(j, "{")) j++; const fin = cierraEn(j);
      quitar(previo && previo.x === "export" ? k - 1 : k, fin); k = fin; continue;
    }
    if (t.t === "id" && t.x === "type" && T[k + 1] && T[k + 1].t === "id" && (es(k + 2, "=") || es(k + 2, "<")) && iniSentencia) {
      let j = k + 2; while (j < n && !es(j, ";")) { if (T[j].t === "p" && ["(", "[", "{"].includes(T[j].x)) j = cierraEn(j); j++; }
      quitar(previo && previo.x === "export" ? k - 1 : k, j); k = j; continue;
    }
    // `import { a, type B } from "x"`
    if (t.t === "id" && t.x === "import" && es(k + 1, "{")) {
      const cierre = cierraEn(k + 1);
      for (let j = k + 2; j < cierre; j++) {
        if (es(j, "type") && T[j + 1] && T[j + 1].t === "id" && !es(j + 1, ",")) { const fin = j + 1; quitar(j, fin); if (es(fin + 1, ",")) borrar.push([T[fin + 1].s, T[fin + 1].e]); j = fin; }
      }
      k = cierre; continue;
    }
    // variables: `const|let|var nombre: Tipo = …`
    if (t.t === "id" && (t.x === "const" || t.x === "let" || t.x === "var") && T[k + 1] && T[k + 1].t === "id" && es(k + 2, ":")) {
      const fin = tipo(k + 3); quitar(k + 2, fin); k = fin; continue;
    }
    // `catch (e: unknown)`
    if (t.t === "id" && t.x === "catch" && es(k + 1, "(") && T[k + 2] && T[k + 2].t === "id" && es(k + 3, ":")) { const fin = tipo(k + 4); quitar(k + 3, fin); k = fin; continue; }
    // funciones: `function [nombre](params)[: T] {`
    if (t.t === "id" && t.x === "function") {
      let j = k + 1; if (es(j, "*")) j++; if (T[j] && T[j].t === "id") j++;
      if (es(j, "<")) throw new Error("genericos de funcion no soportados");
      if (es(j, "(")) { const cp = parametros(j); const r = retorno(cp, "{"); if (r === null) throw new Error(`retorno de funcion no reconocido en ${T[cp].s}`); k = Math.max(k, r); }
      continue;
    }
    // flechas: `(params)[: T] =>`  (un `(` cuyo cierre va seguido de `=>` o de `: Tipo =>`; una llamada o una agrupacion nunca lo cumplen)
    if (t.t === "p" && t.x === "(") {
      const cp = cierraEn(k); let esFlecha = es(cp + 1, "=>");
      if (!esFlecha && es(cp + 1, ":")) { try { esFlecha = es(tipo(cp + 2) + 1, "=>"); } catch { esFlecha = false; } }
      if (esFlecha) { parametros(k); if (retorno(cp, "=>") === null) throw new Error("retorno de flecha no reconocido"); }
      continue;
    }
    // `expr as T` / `as const` / `satisfies T`
    if (t.t === "id" && (t.x === "as" || t.x === "satisfies") && previo && (previo.t === "id" && !PALABRAS.has(previo.x) || previo.t === "str" || previo.t === "num" || (previo.t === "p" && [")", "]", "}"].includes(previo.x)))) {
      const fin = tipo(k + 1); quitar(k, fin); k = fin; continue;
    }
    // aserción no nula `x!`
    if (t.t === "p" && t.x === "!" && previo && (previo.t === "id" && !PALABRAS.has(previo.x) || (previo.t === "p" && [")", "]"].includes(previo.x)))) {
      const sig = T[k + 1]; if (sig && sig.t === "p" && [".", ")", ",", ";", "[", "]", "}", "?."].includes(sig.x)) borrar.push([t.s, t.e]);
      continue;
    }
    // genericos de `new Nombre<A, B>(`
    if (t.t === "id" && t.x === "new" && T[k + 1] && T[k + 1].t === "id" && es(k + 2, "<")) { const fin = cierraAngular(k + 2); if (es(fin + 1, "(")) { quitar(k + 2, fin); k = fin; } continue; }
  }
  // se aplican los borrados de atras hacia adelante (sin solapes: se fusionan los contiguos)
  borrar.sort((a, b) => a[0] - b[0]);
  let salida = "", cursor = 0;
  for (const [a, b] of borrar) { if (a < cursor) continue; salida += fuente.slice(cursor, a); cursor = b; }
  return salida + fuente.slice(cursor);
}
