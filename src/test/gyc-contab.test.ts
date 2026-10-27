// @ts-nocheck
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let K;
beforeAll(() => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync('public/gyc-rules.js', 'utf8'), context);
  vm.runInContext(readFileSync('public/gyc-contab.js', 'utf8'), context);
  K = context['GycContab'];
});

const ctx = { usuario: 'Ana', ts: '2026-11-30T10:00:00Z', hoy: '2026-11-30' };
function base() {
  const pd = K.nuevoPd('Ana', ctx.ts);
  pd.cfg.politicaConfirmada = true;
  pd.apertura.lineas = [
    { cuenta: '1.1.01', debe: 10000, haber: 0, fuente: 'Arqueo' },
    { cuenta: '3.1', debe: 0, haber: 10000, fuente: 'Aportes' },
  ];
  expect(K.aprobarApertura(pd, ctx).ok).toBe(true);
  return pd;
}
const sch = Array.from({ length: 4 }, (_, i) => ({ n: i + 1, date: '2026-11-' + String(9 + 7 * i).padStart(2, '0'), amount: 300, paid: 0 }));
const mkDb = () => ({
  cli: [{ id: 'C1', nom: 'D' }],
  cre: [{ id: 'CRE1', cliId: 'C1', cap: 1000, total: 1200, fecDes: '2026-11-02', date: '2/11/2026', plz: 4, freq: 7, schedule: sch }],
  pag: [{ id: 'RC1', creId: 'CRE1', cid: 'C1', nom: 'D', pri: 250, int: 50, m: 0, t: 300, fechaISO: '2026-11-09', f: '9/11/2026', g: 'Ana' }],
});

describe('GycContab', () => {
  it('política por defecto: intereses al cobrarlos', () => {
    expect(K.nuevoPd('Ana', ctx.ts).cfg.politicaInteres).toBe('alCobro');
  });
  it('reconoce el interés en cada cobro, sin duplicar al repetir', () => {
    const pd = base(), db = mkDb();
    K.contabilizarPendientes(db, pd, ctx);
    K.contabilizarPendientes(db, pd, ctx);
    expect(K.saldoCuenta(pd, '4.1.01', '2026-11-30')).toBe(50);
    expect(K.registrarDevengo(db, pd, '2026-11', ctx).vacio).toBe(true);
    expect(K.saldoCuenta(pd, '4.1.01', '2026-11-30')).toBe(50);
    expect(K.balanceGeneral(pd, '2026-11-30').cuadra).toBe(true);
    expect(K.verificarIntegridad(pd).length).toBe(0);
  });
  it('refinanciamiento: solo sale el neto en efectivo y la transitoria queda en cero', () => {
    const pd = base(), db = mkDb();
    K.contabilizarPendientes(db, pd, ctx);
    const antes = K.saldoCuenta(pd, '1.1.01', '2026-11-30');
    db.cre.push({ id: 'CRE2', cliId: 'C1', cap: 1000, total: 1200, fecDes: '2026-11-27', date: '27/11/2026', plz: 4, freq: 7, schedule: sch, descuento: 300, neto: 700, refiDe: 'CRE1' });
    db.pag.push({ id: 'RC9', creId: 'CRE1', cid: 'C1', nom: 'D', pri: 240, int: 60, m: 0, t: 300, tipo: 'refinanciamiento', fechaISO: '2026-11-27', f: '27/11/2026' });
    const r = K.contabilizarPendientes(db, pd, ctx);
    expect(r.errores.length).toBe(0);
    expect(K.saldoCuenta(pd, '1.1.01', '2026-11-30') - antes).toBe(-700);
    expect(K.saldoCuenta(pd, '1.2.99', '2026-11-30')).toBe(0);
    expect(K.balanceGeneral(pd, '2026-11-30').cuadra).toBe(true);
  });
  it('reverso y asiento manual descuadrado', () => {
    const pd = base(), db = mkDb();
    K.contabilizarPendientes(db, pd, ctx);
    const a = pd.asientos.find(x => x.clave === 'cobro:RC1');
    expect(K.reversar(pd, a.id, 'Registrado dos veces por error', ctx).ok).toBe(true);
    expect(K.reversar(pd, a.id, 'otra vez otra vez', ctx).ok).toBe(false);
    const m = { fecha: '2026-11-20', desc: 'prueba', lineas: [{ cuenta: '5.1.01', debe: 100, haber: 0 }, { cuenta: '1.1.01', debe: 0, haber: 90 }] };
    expect(K.asientoManual(pd, m, ctx, true).ok).toBe(false);
  });
});
