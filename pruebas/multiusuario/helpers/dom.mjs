// DOM SINTETICO para el QA multiusuario. NO es un navegador: solo lo justo para ejecutar el JS real de
// taller-demo/ dentro de node:vm y OBSERVAR sus efectos (textos, HTML asignado, oyentes, clases).
//
// Lo mas importante para seguridad: cada asignacion a `innerHTML` queda registrada en doc.sumideros,
// y `textContent` guarda el texto tal cual (su innerHTML equivalente sale escapado), igual que un DOM
// real. Asi una prueba puede afirmar "este dato llego como TEXTO" o "este dato llego como HTML".

const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'" };
export const escaparHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const decodificar = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => ENT[m]);
const textoDeHtml = (h) => decodificar(String(h).replace(/<[^>]*>/g, ""));

// Etiquetas y atributos que NINGUNA plantilla legitima del producto contiene. Si aparecen en HTML
// asignado por el runtime, un dato de fuera se colo como marcado. Un `onload=` que esta DENTRO de un valor
// de atributo entrecomillado (p. ej. data-nombre="&lt;svg onload=…&gt;") es texto inerte y no cuenta.
const ETIQUETA = /<[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi;
export function marcadoPeligroso(html) {
  const hallazgos = [];
  const s = String(html);
  for (const m of s.matchAll(/<\s*(script|img|svg|iframe|object|embed|link|meta|style|form)\b[^>]*>/gi)) {
    if (/^(form|style)$/i.test(m[1])) continue; // legitimas en otras pantallas; aqui interesan las que ejecutan
    hallazgos.push(`etiqueta <${m[1].toLowerCase()}>`);
  }
  for (const t of s.matchAll(ETIQUETA)) {
    const sinValores = t[0].replace(/"[^"]*"|'[^']*'/g, '""');
    for (const m of sinValores.matchAll(/\s(on[a-z]+)\s*=/gi)) hallazgos.push(`atributo ${m[1].toLowerCase()}=`);
  }
  return hallazgos;
}

function parsearAtributos(txt) {
  const a = {};
  for (const m of txt.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) a[m[1]] = decodificar(m[2]);
  return a;
}

export class Elemento {
  constructor(doc, tag = "div", id = "") {
    this._doc = doc;
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this._html = "";
    this._texto = undefined;
    this._clases = new Set();
    this._oyentes = {};
    this._consultas = new Map();
    this._hijos = [];
    this.value = "";
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this.attributes = {};
    this.parentNode = null;
    this.previousElementSibling = null;
    this.nextElementSibling = null;
    this.selectedOptions = [];
    this.options = [];
    this.files = [];
    this.type = "";
    this.href = "";
    this.src = "";
    this.name = "";
    this.placeholder = "";
    this.closed = false;
    this.location = { href: "" };
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this._texto = undefined;
    this._hijos = [];
    const entrada = { tag: this.tagName, id: this.id, html: this._html };
    this._doc.sumideros.push(entrada);
    this._doc._dueno.set(entrada, this);
    this._ultimo = entrada;
    // Como en un DOM real: los nodos que declara este HTML son NUEVOS (los anteriores con ese id ya no existen).
    for (const m of this._html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*?\sid\s*=\s*"([^"]+)"/gi)) this._doc.ids.set(decodificar(m[2]), new Elemento(this._doc, m[1], decodificar(m[2])));
  }
  get textContent() {
    if (this._texto !== undefined) return this._texto;
    if (this._hijos.length) return this._hijos.map((h) => (h && h.textContent !== undefined ? h.textContent : "")).join("");
    return textoDeHtml(this._html);
  }
  set textContent(v) { this._texto = String(v ?? ""); this._html = escaparHtml(this._texto); this._hijos = []; }
  get className() { return [...this._clases].join(" "); }
  set className(v) { this._clases = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this._clases;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      contains: (c) => s.has(c),
      toggle: (c, f) => { const on = f === undefined ? !s.has(c) : !!f; if (on) s.add(c); else s.delete(c); return on; },
    };
  }
  addEventListener(tipo, fn) { (this._oyentes[tipo] ||= []).push(fn); this._doc.registroOyentes.push({ id: this.id, tag: this.tagName, tipo }); }
  removeEventListener(tipo, fn) { this._oyentes[tipo] = (this._oyentes[tipo] || []).filter((f) => f !== fn); }
  oyentes(tipo) { return (this._oyentes[tipo] || []).slice(); }
  /** Dispara los oyentes en orden y espera a los que devuelvan promesa. */
  async disparar(tipo, extra = {}) {
    const ev = { type: tipo, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const fn of this.oyentes(tipo)) await fn.call(this, ev);
    return ev;
  }
  click() { return this.disparar("click"); }
  appendChild(h) { this._hijos.push(h); this._texto = undefined; if (h && typeof h === "object") h.parentNode = this; return h; }
  append(...hs) { hs.forEach((h) => this.appendChild(h)); }
  remove() { this._removido = true; if (this.parentNode) this.parentNode._hijos = this.parentNode._hijos.filter((x) => x !== this); }
  get children() { return this._hijos; }
  get childNodes() { return this._hijos; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === "id") this.id = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes; }
  focus() {} blur() {} select() {} scrollIntoView() {} close() { this.closed = true; }
  closest() { return null; }
  matches() { return false; }
  contains(x) { return x === this || this._hijos.includes(x); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  /** Elementos que el HTML asignado a este elemento declara con una clase (ver doc.querySelectorAll). */
  querySelector(sel) {
    if (!this._consultas.has(sel)) this._consultas.set(sel, new Elemento(this._doc, "div"));
    return this._consultas.get(sel);
  }
  querySelectorAll(sel) { return this._doc.querySelectorAll(sel, this); }  // solo lo que declara el HTML ASIGNADO A ESTE elemento
}

export function crearDocumento() {
  const ids = new Map();
  const memoSel = new Map();
  const memoClase = new WeakMap();
  const doc = {
    sumideros: [],          // { tag, id, html } por cada asignacion a innerHTML
    _dueno: new WeakMap(),  // asignacion -> elemento que la recibio
    registroOyentes: [],
    ids,
    _oyentes: {},
    cookie: "",
    title: "",
    readyState: "complete",
    getElementById(id) {
      if (!ids.has(id)) ids.set(id, new Elemento(doc, "div", id));
      return ids.get(id);
    },
    createElement(tag) { return new Elemento(doc, tag); },
    createTextNode(t) { return { nodeType: 3, textContent: String(t) }; },
    createDocumentFragment() { return new Elemento(doc, "fragment"); },
    querySelector(sel) {
      if (!memoSel.has(sel)) memoSel.set(sel, new Elemento(doc, "div"));
      return memoSel.get(sel);
    },
    /** Solo entiende ".clase", "tag.clase", ".clase[atributo]" y "[atributo=\"valor\"]": devuelve los elementos que el HTML ya asignado declara. */
    querySelectorAll(sel, dueno) {
      const txtSel = String(sel).trim();
      const porValor = /^\[([\w-]+)="([^"]*)"\]$/.exec(txtSel);           // [data-action="llego"]
      const m = porValor ? null : /^(?:[a-z0-9]*)\.([\w-]+)(?:\[([\w-]+)\])?$/i.exec(txtSel);
      if (!m && !porValor) return [];
      const clase = m ? m[1] : null, atributo = m ? m[2] : null;
      const out = [];
      for (const s of doc.sumideros) {
        if (doc._dueno.get(s)?._ultimo !== s) continue; // el HTML anterior de ese elemento ya no existe
        if (dueno && doc._dueno.get(s) !== dueno) continue;
        for (const t of s.html.matchAll(/<([a-z0-9]+)\b([^>]*)>/gi)) {
          const at = parsearAtributos(t[2]);
          if (clase && !(at.class || "").split(/\s+/).includes(clase)) continue;
          if (porValor && at[porValor[1]] !== porValor[2]) continue;
          if (atributo && at[atributo] === undefined) continue;
          const clave = `${clase}|${t[1]}|${t[2]}|${t.index}`;
          if (!memoClase.has(s)) memoClase.set(s, new Map());
          const memoS = memoClase.get(s);
          if (!memoS.has(clave)) {
            const el = new Elemento(doc, t[1]);
            el.attributes = at;
            el.className = at.class || "";
            for (const [k, v] of Object.entries(at)) if (k.startsWith("data-")) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
            if (at.id) el.id = at.id;
            el.value = at.value || "";
            memoS.set(clave, el);
          }
          out.push(memoS.get(clave));
        }
      }
      return out;
    },
    addEventListener(tipo, fn) { (doc._oyentes[tipo] ||= []).push(fn); },
    removeEventListener(tipo, fn) { doc._oyentes[tipo] = (doc._oyentes[tipo] || []).filter((f) => f !== fn); },
    execCommand() { return true; },
  };
  doc.documentElement = new Elemento(doc, "html");
  doc.body = new Elemento(doc, "body");
  doc.head = new Elemento(doc, "head");
  return doc;
}
