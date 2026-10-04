// 3.15.0 · Bloque 5 · la optimización de fecha-negocio.js (desfase por día UTC + formateadores reutilizados) da EXACTAMENTE lo mismo
// que las llamadas Intl directas de siempre (toLocale*String con timeZone, formatToParts), incluido el horario de verano de Honduras de
// 2006, las medianoches locales y el cambio de mes; en procesos con otra zona de reloj el resultado no cambia.
//   node --test pruebas/sync/node/b5-fecha-rendimiento.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../taller-demo/fecha-negocio.js");
const CODIGO = `const fs=require('fs'),vm=require('vm');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(${JSON.stringify(ARCH)},'utf8'),c);const F=c.FechaNegocio;
const Z='America/Tegucigalpa', L='es-HN', z=(o)=>Object.assign({},o||{},{timeZone:Z});
const p=new Intl.DateTimeFormat('en-CA',{timeZone:Z,year:'numeric',month:'2-digit',day:'2-digit'});
const dia=(ms)=>{const o={};p.formatToParts(new Date(ms)).forEach(x=>{o[x.type]=x.value});return o.year+'-'+o.month+'-'+o.day;};
const ops=[undefined,{month:'long'},{day:'2-digit',month:'short'},{hour:'2-digit'},{weekday:'long'},{dateStyle:'medium'}];
let n=0,mal=[];const chk=(ms)=>{n++;const d=new Date(ms);
 const a=[F.diaDe(ms),F.hora(ms),F.fechaHora(ms),...ops.map(o=>F.fecha(ms,o))];
 const b=[dia(ms),d.toLocaleTimeString(L,z({hour:'2-digit',minute:'2-digit'})),d.toLocaleString(L,z({dateStyle:'short',timeStyle:'short'})),...ops.map(o=>d.toLocaleDateString(L,z(o)))];
 if(JSON.stringify(a)!==JSON.stringify(b)&&mal.length<3)mal.push([d.toISOString(),a,b]);};
for(let ms=Date.parse('2006-04-01T00:00:00Z');ms<Date.parse('2006-09-01T00:00:00Z');ms+=1800000)chk(ms);
for(let d=Date.parse('2026-01-01T00:00:00Z');d<Date.parse('2028-01-01T00:00:00Z');d+=86400000)for(const o of [-1,0,21599999,21600000,64800000])chk(d+o);
for(let i=0;i<4000;i++)chk(Date.parse('1995-01-01T00:00:00Z')+Math.floor(Math.random()*1.3e12));
process.stdout.write(JSON.stringify({n,mal}));`;
for (const TZ of ["UTC", "America/Tegucigalpa", "Asia/Tokyo"]) {
  test(`idéntico a Intl directo · reloj del dispositivo en ${TZ}`, () => {
    const r = spawnSync(process.execPath, ["-e", CODIGO], { env: { ...process.env, TZ }, encoding: "utf8", timeout: 300000 });
    const j = JSON.parse(r.stdout || "{}");
    assert.ok(j.n > 10000, r.stderr); assert.deepEqual(j.mal, []);
  });
}
