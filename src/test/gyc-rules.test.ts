import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
let rules: any;
beforeAll(()=>{ const context=vm.createContext({}); vm.runInContext(readFileSync('public/gyc-rules.js','utf8'),context); rules=context["GycRules"]; });
describe('requested permissions',()=>{
  it('administrator has full access',()=>expect(['collect','edit','users','createClient','createCredit'].every(a=>rules.can('admin',a))).toBe(true));
  it('disburser creates clients and credits but cannot collect or edit',()=>expect(['createClient','createCredit','collect','edit'].map(a=>rules.can('desembolsador',a))).toEqual([true,true,false,false]));
  it('collector can collect, not create credits or edit',()=>expect(['collect','createCredit','edit'].map(a=>rules.can('cobrador',a))).toEqual([true,false,false]));
  it('assistant cannot mutate anything',()=>expect(['collect','edit','users','createClient','createCredit'].map(a=>rules.can('asistente',a))).toEqual([false,false,false,false,false]));
  it('only inactive other users may be deleted',()=>{ expect(rules.canDeleteUser({u:'ana',s:'Inactivo'},'admin')).toBe(true); expect(rules.canDeleteUser({u:'ana',s:'Activo'},'admin')).toBe(false); expect(rules.canDeleteUser({u:'admin',s:'Inactivo'},'otro')).toBe(false); });
});
describe('recovered cash',()=>{
  const db={cre:[{id:'real'},{id:'test',esPrueba:true}],pag:[{id:'1',creId:'real',fechaISO:'2026-10-20',t:105,m:5,g:'Ana'},{id:'2',creId:'real',fechaISO:'2026-10-19',t:50,g:'Luis'},{creId:'test',fechaISO:'2026-10-20',t:999},{creId:'real',fechaISO:'2026-10-20',t:200,tipo:'refinanciamiento'},{creId:'real',fechaISO:'2025-10-20',t:500}]};
  it('day counts actual cash and separates mora',()=>{ const r=rules.cashReport(db,'2026-10-20','2026-10-20'); expect([r.total,r.recovered,r.mora]).toEqual([105,100,5]); });
  it('week runs Monday to Sunday',()=>expect(rules.range('semana','2026-10-20')).toEqual(['2026-10-19','2026-10-25']));
  it('range and collector filter are inclusive',()=>expect(rules.cashReport(db,'2026-10-19','2026-10-20','Luis').total).toBe(50));
});
describe('dashboard daily series',()=>{
  const db={cre:[{id:'real'}],pag:[{creId:'real',fechaISO:'2026-10-19',t:50,g:'Luis'},{creId:'real',fechaISO:'2026-10-19',t:30,g:'Ana'},{creId:'real',fechaISO:'2026-10-21',t:105,m:5,g:'Ana'}]};
  it('adds days across month boundaries',()=>{ expect(rules.addDays('2026-10-31',1)).toBe('2026-11-01'); expect(rules.addDays('2026-10-19',-6)).toBe('2026-10-13'); });
  it('lists every day, adding zero for days without payments',()=>expect(rules.dailySeries(db,'2026-10-19','2026-10-22').map((x:any)=>x.total)).toEqual([80,0,105,0]));
  it('daily series respects the collector filter',()=>expect(rules.dailySeries(db,'2026-10-19','2026-10-21','Luis').map((x:any)=>x.total)).toEqual([50,0,0]));
});
describe('independent searches and partner capital',()=>{
  const db={cli:[{id:'CLI1',nom:'María Aguilar',ced:'001'},{id:'CLI2',nom:'Ana López'}],cre:[{id:'CRE1',cliId:'CLI1'},{id:'CRE2',cliId:'CLI1'},{id:'CRE3',cliId:'CLI2'}]};
  it('searches credits by client name, including all her credits',()=>expect(rules.creditSearch(db,'maria aguilar').map((c:any)=>c.id)).toEqual(['CRE1','CRE2']));
  it('searches credit number without affecting client matching',()=>{expect(rules.creditSearch(db,'CRE3').map((c:any)=>c.id)).toEqual(['CRE3']);expect(rules.matches('Ana','María Aguilar')).toBe(false);});
  it('sums each partner capital independently',()=>{const r=rules.partnerReport([{id:'s1'},{id:'s2'}],[{socioId:'s1',monto:1000},{socioId:'s1',monto:500},{socioId:'s2',monto:200}]);expect(r.rows.map((p:any)=>p.total)).toEqual([1500,200]);expect(r.total).toBe(1700);});
  it('only administrators can record partners or contributions',()=>expect(['owner','admin','desembolsador','cobrador','asistente'].map(r=>rules.can(r,'partners'))).toEqual([true,true,false,false,false]));
  it('contributions require an existing partner, positive capital and a real nonfuture date',()=>{const p=[{id:'s1'}];expect(rules.validContribution(p,'s1',100,'2026-10-21','2026-10-21')).toBe(true);expect([rules.validContribution(p,'other',100,'2026-10-21','2026-10-21'),rules.validContribution(p,'s1',0,'2026-10-21','2026-10-21'),rules.validContribution(p,'s1',100,'2026-10-22','2026-10-21'),rules.validContribution(p,'s1',100,'2026-02-30','2026-10-21')]).toEqual([false,false,false,false]);});
});
