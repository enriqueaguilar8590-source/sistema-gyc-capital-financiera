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
describe('partner dashboard and locked contribution edits',()=>{
  const partners=[{id:'s1',nom:'Ana'},{id:'s2',nom:'Luis'}];
  const aportes=[{id:'a1',socioId:'s1',monto:1000,fecha:'2026-09-10'},{id:'a2',socioId:'s1',monto:500,fecha:'2026-10-02'},{id:'a3',socioId:'s2',monto:1500,fecha:'2026-10-05'},{id:'x',socioId:'gone',monto:999,fecha:'2026-10-06'}];
  it('summarises capital, shares, average and largest contribution',()=>{const d=rules.partnerDashboard(partners,aportes);expect([d.total,d.count,d.average,d.largest.id,d.lastDate]).toEqual([3000,3,1000,'a3','2026-10-05']);expect(d.rows.map((p:any)=>[p.nom,p.share,p.last])).toEqual([['Ana',50,'2026-10-02'],['Luis',50,'2026-10-05']]);});
  it('handles an empty workspace without dividing by zero',()=>{const d=rules.partnerDashboard([],[]);expect([d.total,d.count,d.average,d.largest,d.lastDate]).toEqual([0,0,0,null,'']);});
  it('monthly series includes zero months and crosses year boundaries',()=>{expect(rules.addMonths('2026-01',-2)).toBe('2025-11');expect(rules.monthlyContributions(aportes,'2026-10',3).map((m:any)=>[m.month,m.total])).toEqual([['2026-08',0],['2026-09',1000],['2026-10',3000]]);});
  it('edit needs a different positive amount and a reason',()=>{const e=aportes[0];expect([rules.validContributionEdit(e,1200,'error de digitación'),rules.validContributionEdit(e,1000,'igual'),rules.validContributionEdit(e,0,'cero'),rules.validContributionEdit(e,1200,'  '),rules.validContributionEdit(undefined,1200,'motivo')]).toEqual([true,false,false,false,false]);});
  it('edit keeps the previous amount as history and leaves other contributions untouched',()=>{const out=rules.applyContributionEdit(aportes,'a1',1200,' error ','Gabriel','2026-10-21T10:00:00Z');expect(out[0]).toMatchObject({monto:1200,ediciones:[{montoAnterior:1000,montoNuevo:1200,motivo:'error',usuario:'Gabriel'}]});expect(out.slice(1)).toEqual(aportes.slice(1));expect(aportes[0].monto).toBe(1000);expect(rules.applyContributionEdit(aportes,'a1',1000,'x y z','u','t')).toBeNull();});
  it('lock accepts only the Socios credentials',async()=>{const {webcrypto}=await import('node:crypto');const ok=(u:string,p:string)=>rules.verifyPartnerLock(u,p,webcrypto.subtle);expect([await ok('SociosGYL','01071010'),await ok('SociosGYL','0107101'),await ok('sociosgyl','01071010'),await ok('admin','01071010')]).toEqual([true,false,false,false]);expect(JSON.stringify(rules.PARTNER_LOCK)).not.toContain('01071010');});
});
describe('daily notices and payment SMS',()=>{
  it('turns registered phones into international numbers',()=>expect(['8888-1234','+505 8888 1234','50588881234','(505) 88881234','123',''].map(t=>rules.smsNumber(t))).toEqual(['+50588881234','+50588881234','+50588881234','+50588881234','','']));
  it('payment SMS has no accents, fits one message and shows mora and balance',()=>{const m=rules.paymentSms({empresa:'GYC Capital',cliente:'María José Pérez López',monto:1250.5,fecha:'21/10/2026',mora:30,saldo:3749.5,recibo:'RC-0012'});expect(m).toBe('GYC Capital: Maria Jose, recibimos su pago de C$1,250.50 el 21/10/2026. Incluye mora C$30.00. Saldo pendiente: C$3,749.50. Recibo RC-0012.');expect(m.length).toBeLessThanOrEqual(160);expect(rules.paymentSms({cliente:'Ana',monto:10,fecha:'x',saldo:0,recibo:'R1'})).toContain('cancelado');});
  it('builds the SMS link for iPhone and Android',()=>{expect(rules.smsLink('+50588881234','Hola mundo',true)).toBe('sms:+50588881234&body=Hola%20mundo');expect(rules.smsLink('+50588881234','Hola mundo',false)).toBe('sms:+50588881234?body=Hola%20mundo');});
  it('digest lists today collections, overdue clients and mora',()=>{const d=rules.digestText({today:[{nom:'Ana'}],todayAmount:500,overdue:[{nom:'Luis Pérez'},{nom:'Rosa'},{nom:'Jose'},{nom:'Eva'}],overdueAmount:2000,moraAmount:150});expect(d.lines).toEqual(['Hoy cobras 1 cuota por C$500.00','4 clientes en mora: cuotas vencidas C$2,000.00 + mora C$150.00','Mayor atraso: Luis Perez, Rosa, Jose y 1 mas']);expect(rules.digestText({today:[],todayAmount:0,overdue:[],overdueAmount:0,moraAmount:0}).lines).toEqual(['Hoy no tienes cuotas por cobrar','Sin clientes en mora']);});
  it('notifies once per day, from the chosen hour',()=>{expect([rules.shouldNotify(new Date(2026,9,21,7,59),8,''),rules.shouldNotify(new Date(2026,9,21,8,0),8,''),rules.shouldNotify(new Date(2026,9,21,15,0),8,'2026-10-21'),rules.shouldNotify(new Date(2026,9,22,8,0),8,'2026-10-21')]).toEqual(['','2026-10-21','','2026-10-22']);});
});
describe('SMS reminders',()=>{
  it('reminds a client whose installment is due today',()=>expect(rules.reminderSms({kind:'hoy',empresa:'GYC Capital',cliente:'María Aguilar',creId:'CRE1',monto:500})).toBe('GYC Capital: Maria, le recordamos que hoy vence su cuota de C$500.00 del credito CRE1. Gracias por su pago puntual.'));
  it('reminds an overdue client with installments, mora and total',()=>{expect(rules.reminderSms({kind:'mora',empresa:'GYC Capital',cliente:'Luis Pérez',creId:'CRE2',cuotas:2,vencido:1000,mora:50,total:1050})).toBe('GYC Capital: Luis, su credito CRE2 tiene 2 cuotas vencidas por C$1,000.00 mas mora C$50.00. Total a pagar: C$1,050.00. Por favor comuniquese para ponerse al dia.');expect(rules.reminderSms({kind:'mora',cliente:'Ana',creId:'C',cuotas:1,vencido:100,mora:0,total:100})).not.toContain('mora C$');});
});
