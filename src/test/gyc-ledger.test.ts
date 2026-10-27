// @ts-nocheck
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let L;
beforeAll(() => { const context = vm.createContext({}); vm.runInContext(readFileSync('public/gyc-ledger.js', 'utf8'), context); L = context['GycLedger']; });

let seq = 0;
const ctxOf = (o = {}) => ({ usuario: 'Ana', rol: 'admin', hoy: '2026-11-30', ahora: '2026-11-30T10:00:00.000Z', uuid: () => 'u' + (++seq), ...o });
const clone = x => JSON.parse(JSON.stringify(x));
function mk(policy = 'devengo_cuota') {
  const db = { cfg: { secuencias: {}, conta: { inicio: '2026-11-01', fechaApertura: '2026-10-31', aperturaAprobada: true, politicaIntereses: policy } }, cre: [], pag: [] };
  L.ensureCatalog(db, ctxOf());
  const r = L.post(db, L.rules.propietario(db, { tipo: 'aporte', fecha: '2026-11-01', monto: 10000, id: 'AP0' }).draft, ctxOf());
  expect(r.ok).toBe(true);
  return db;
}
const credit = (o = {}) => ({ id: 'CRE1', cap: 6000, total: 8760, intPct: 46, schedule: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, amount: 730 })), ...o });
const disburse = (db, cre = credit(), fecha = '2026-11-02') => L.post(db, L.rules.desembolso(db, cre, { confirmado: true, fecha, medio: 'caja' }).draft, ctxOf());
const pay = (db, p, cre = credit()) => { const b = L.rules.cobro(db, p, cre, { medio: 'caja' }); return b.ok ? (b.draft ? L.post(db, b.draft, ctxOf()) : { ok: true, omitido: true }) : b; };
const bal = (db, c) => L.balanceOf(db, c, '2026-12-31');
const balanced = db => L.trialBalance(db, '2026-12-31').cuadra;
const auditHas = (db, a) => (db.auditoriaConta || []).some(x => x.accion === a);

describe('catálogo y permisos', () => {
  it('crea el catálogo sin pisar cuentas ya modificadas', () => {
    const db = { cfg: {} }; L.ensureCatalog(db, ctxOf()); db.ctaCat.find(a => a.code === '1.1.01').nombre = 'Caja Chinandega';
    L.ensureCatalog(db, ctxOf()); expect(db.ctaCat.find(a => a.code === '1.1.01').nombre).toBe('Caja Chinandega');
  });
  it('permite ampliar el catálogo sin tocar el código y valida hijas', () => {
    const db = mk(), r = L.addAccount(db, { code: '5.1.13', nombre: 'Gastos legales', padre: '5.1', tipo: 'gasto', naturaleza: 'deudora' }, ctxOf());
    expect(r.ok).toBe(true);
    expect(L.addAccount(db, { code: '5.1.13', nombre: 'x', padre: '5.1', tipo: 'gasto', naturaleza: 'deudora' }, ctxOf()).ok).toBe(false);
    expect(L.addAccount(db, { code: '5.1.01.1', nombre: 'x', padre: '5.1.01', tipo: 'gasto', naturaleza: 'deudora' }, ctxOf()).ok).toBe(false);
  });
  it('un cobrador no puede contabilizar ni administrar el catálogo', () => {
    const db = mk(), d = L.rules.gasto(db, { fecha: '2026-11-03', monto: 50, cuenta: '5.1.02', pago: 'caja', id: 'G9' }).draft;
    expect(L.post(db, d, ctxOf({ rol: 'cobrador' })).ok).toBe(false);
    expect(L.addAccount(db, { code: '5.1.14', nombre: 'x', padre: '5.1', tipo: 'gasto', naturaleza: 'deudora' }, ctxOf({ rol: 'asistente' })).ok).toBe(false);
  });
  it('rechaza cuentas agrupadoras e inactivas', () => {
    const db = mk(), base = { fecha: '2026-11-03', descripcion: 'x' };
    expect(L.post(db, { ...base, lineas: [{ cuenta: '5.1', debe: 10 }, { cuenta: '1.1.01', haber: 10 }] }, ctxOf()).ok).toBe(false);
    L.setAccountActive(db, '5.1.11', false, ctxOf());
    expect(L.post(db, { ...base, lineas: [{ cuenta: '5.1.11', debe: 10 }, { cuenta: '1.1.01', haber: 10 }] }, ctxOf()).ok).toBe(false);
  });
});

describe('las 20 pruebas obligatorias', () => {
  it('1. desembolso correcto', () => {
    const db = mk(), r = disburse(db);
    expect(r.ok).toBe(true);
    expect([bal(db, '1.1.01'), bal(db, '1.2.01'), bal(db, '1.2.02'), bal(db, '1.2.03')]).toEqual([4000, 6000, 2760, 2760]);
    expect(balanced(db)).toBe(true);
    expect(L.mayor(db, '1.2.01', '2026-11-01', '2026-11-30').saldoFinal).toBe(6000);
    expect(auditHas(db, 'asiento.contabilizar')).toBe(true);
    expect(L.balanceSheet(db, '2026-11-30').cuadra).toBe(true);
    expect(L.incomeStatement(db, '2026-11-01', '2026-11-30').totalIngresos).toBe(0);   // los intereses futuros no son utilidad al desembolsar
  });
  it('2. desembolso duplicado y no confirmado', () => {
    const db = mk(); disburse(db); const n = db.asientos.length;
    const again = disburse(db);
    expect(again.ok).toBe(false); expect(again.duplicado).toBe(true); expect(db.asientos.length).toBe(n);
    expect(L.integrityCheck(db)).toEqual([]);
    expect(L.rules.desembolso(db, credit({ id: 'CRE2' }), { confirmado: false, fecha: '2026-11-02' }).ok).toBe(false);
    expect(L.rules.desembolso(db, credit({ id: 'CRE3', esPrueba: true }), { confirmado: true, fecha: '2026-11-02' }).ok).toBe(false);
  });
  it('3. cobro parcial', () => {
    const db = mk(); disburse(db);
    const r = pay(db, { id: 'RC1', pri: 205.48, int: 94.52, m: 0, t: 300, fechaISO: '2026-11-09' });
    expect(r.ok).toBe(true);
    expect([bal(db, '1.1.01'), bal(db, '1.2.01'), bal(db, '1.2.02'), bal(db, '1.2.03'), bal(db, '4.1.01')]).toEqual([4300, 5794.52, 2665.48, 2665.48, 94.52]);
    expect(balanced(db)).toBe(true);
  });
  it('4. cobro con capital e intereses (sin reconocer dos veces el interés devengado)', () => {
    const db = mk(); disburse(db);
    L.post(db, L.rules.devengo(db, credit(), 1, '2026-11-09').draft, ctxOf());
    expect(bal(db, '4.1.01')).toBe(230);
    pay(db, { id: 'RC2', pri: 500, int: 230, m: 0, t: 730, fechaISO: '2026-11-09' });
    expect(bal(db, '4.1.01')).toBe(230);                   // el devengo ya lo había reconocido
    expect(bal(db, '1.2.02')).toBe(2530); expect(bal(db, '1.2.03')).toBe(2530);
    expect(L.reconcilePortfolio({ ...db, cre: [credit({ saldo: 8030 })] }, '2026-11-30').cuadra).toBe(true);
    expect(L.post(db, L.rules.devengo(db, credit(), 1, '2026-11-09').draft, ctxOf()).duplicado).toBe(true);
  });
  it('5. cobro con mora', () => {
    const db = mk(); disburse(db);
    pay(db, { id: 'RC3', pri: 500, int: 230, m: 40, t: 770, fechaISO: '2026-11-09' });
    expect([bal(db, '4.1.02'), bal(db, '1.1.01')]).toEqual([40, 4770]);
    expect(L.incomeStatement(db, '2026-11-01', '2026-11-30').totalIngresos).toBe(270);
    expect(pay(db, { id: 'RC3b', pri: 500, int: 230, m: 40, t: 700, fechaISO: '2026-11-09' }).ok).toBe(false);   // no cuadra
  });
  it('6. mora condonada: no genera efectivo ni ingreso', () => {
    const db = mk(); disburse(db); const n = db.asientos.length, cash = bal(db, '1.1.01');
    const r = pay(db, { id: 'RC4', pri: 0, int: 0, m: 0, t: 0, dis: 25, fechaISO: '2026-11-09' });
    expect(r.omitido).toBe(true); expect(db.asientos.length).toBe(n); expect([bal(db, '1.1.01'), bal(db, '4.1.02')]).toEqual([cash, 0]);
  });
  it('7. gasto pagado', () => {
    const db = mk(); const r = L.post(db, L.rules.gasto(db, { id: 'G1', fecha: '2026-11-03', monto: 120, cuenta: '5.1.02', pago: 'caja', descripcion: 'Transporte de cobro' }).draft, ctxOf());
    expect(r.ok).toBe(true); expect([bal(db, '1.1.01'), bal(db, '5.1.02')]).toEqual([9880, 120]);
    expect(L.incomeStatement(db, '2026-11-01', '2026-11-30').resultado).toBe(-120);
  });
  it('8. gasto pendiente de pago y su pago posterior', () => {
    const db = mk(); L.post(db, L.rules.gasto(db, { id: 'G2', fecha: '2026-11-03', monto: 300, cuenta: '5.1.05', pago: 'pendiente', cuentaPorPagar: '2.1.04', proveedor: 'Arrendador' }).draft, ctxOf());
    expect([bal(db, '1.1.01'), bal(db, '2.1.04'), bal(db, '5.1.05')]).toEqual([10000, 300, 300]);
    L.post(db, L.rules.pagoGastoPendiente(db, { id: 'PG2', fecha: '2026-11-20', monto: 300, cuenta: '2.1.04' }).draft, ctxOf());
    expect([bal(db, '1.1.01'), bal(db, '2.1.04'), bal(db, '5.1.05')]).toEqual([9700, 0, 300]);   // el pago no vuelve a ser gasto
  });
  it('9. aporte del propietario no es ingreso', () => {
    const db = mk(); expect([bal(db, '3.1.01'), L.incomeStatement(db, '2026-11-01', '2026-11-30').totalIngresos]).toEqual([10000, 0]);
  });
  it('10. retiro personal no es gasto', () => {
    const db = mk(); L.post(db, L.rules.propietario(db, { tipo: 'retiro', fecha: '2026-11-05', monto: 500, id: 'RT1' }).draft, ctxOf());
    expect([bal(db, '3.2.01'), bal(db, '1.1.01'), L.incomeStatement(db, '2026-11-01', '2026-11-30').totalGastos]).toEqual([500, 9500, 0]);
    expect(L.balanceSheet(db, '2026-11-30').cuadra).toBe(true);
  });
  it('11. préstamo recibido', () => {
    const db = mk(); L.post(db, L.rules.deuda(db, { tipo: 'recibido', fecha: '2026-11-06', monto: 5000, acreedor: 'Banco X', id: 'D1' }).draft, ctxOf());
    expect([bal(db, '1.1.01'), bal(db, '2.1.01')]).toEqual([15000, 5000]);
  });
  it('12. pago de principal de una deuda', () => {
    const db = mk(); L.post(db, L.rules.deuda(db, { tipo: 'recibido', fecha: '2026-11-06', monto: 5000, id: 'D1' }).draft, ctxOf());
    L.post(db, L.rules.deuda(db, { tipo: 'principal', fecha: '2026-11-20', monto: 1000, id: 'D1P' }).draft, ctxOf());
    expect([bal(db, '1.1.01'), bal(db, '2.1.01'), L.incomeStatement(db, '2026-11-01', '2026-11-30').totalGastos]).toEqual([14000, 4000, 0]);
  });
  it('13. pago de intereses de una deuda va a gastos financieros', () => {
    const db = mk(); L.post(db, L.rules.deuda(db, { tipo: 'interes', fecha: '2026-11-20', monto: 80, id: 'D1I' }).draft, ctxOf());
    expect([bal(db, '5.1.09'), bal(db, '1.1.01')]).toEqual([80, 9920]);
  });
  it('14. transferencia entre cuentas propias no es ingreso ni gasto', () => {
    const db = mk(); const before = L.incomeStatement(db, '2026-11-01', '2026-11-30'), cash = L.cashBalance(db, '2026-11-30');
    L.post(db, L.rules.transferencia(db, { desde: 'caja', hacia: 'banco', fecha: '2026-11-07', monto: 2000, id: 'T1' }).draft, ctxOf());
    expect([bal(db, '1.1.01'), bal(db, '1.1.03.01'), L.cashBalance(db, '2026-11-30')]).toEqual([8000, 2000, cash]);
    expect(L.incomeStatement(db, '2026-11-01', '2026-11-30')).toEqual(before);
    expect(L.rules.transferencia(db, { desde: 'caja', hacia: 'caja', fecha: '2026-11-07', monto: 1 }).ok).toBe(false);
    expect(L.cashFlow(db, '2026-11-01', '2026-11-30').cuadra).toBe(true);
  });
  it('15. asiento manual descuadrado', () => {
    const db = mk(), n = db.asientos.length;
    const r = L.post(db, { fecha: '2026-11-08', descripcion: 'Ajuste', tipo: 'manual', lineas: [{ cuenta: '5.1.01', debe: 100 }, { cuenta: '1.1.01', haber: 90 }] }, ctxOf());
    expect(r.ok).toBe(false); expect(r.error).toMatch(/no cuadra/); expect(db.asientos.length).toBe(n);
    expect(L.post(db, { fecha: '2026-11-08', descripcion: 'x', lineas: [{ cuenta: '5.1.01', debe: 0.001 }, { cuenta: '1.1.01', haber: 0.001 }] }, ctxOf()).ok).toBe(false);
  });
  it('16. corrección mediante reverso', () => {
    const db = mk(); disburse(db); const e = db.asientos.find(a => a.claveOrigen === 'desembolso:CRE1');
    const r = L.reverseEntry(db, e.id, { motivo: 'Desembolso registrado por error', fecha: '2026-11-03' }, ctxOf());
    expect(r.ok).toBe(true);
    expect([bal(db, '1.1.01'), bal(db, '1.2.01'), bal(db, '1.2.02'), bal(db, '1.2.03')]).toEqual([10000, 0, 0, 0]);
    expect(db.asientos.find(a => a.id === e.id)).toEqual(e);                     // el original no cambia
    expect(L.reverseEntry(db, e.id, { motivo: 'otra vez' }, ctxOf()).ok).toBe(false);
    expect(L.reverseEntry(db, r.asiento.id, { motivo: 'reverso del reverso' }, ctxOf()).ok).toBe(false);
    expect(L.reverseEntry(db, e.id, { motivo: 'x' }, ctxOf({ rol: 'contador' })).ok).toBe(false);
    expect(auditHas(db, 'asiento.reversar')).toBe(true);
  });
  it('17. intento de modificar un asiento contabilizado', () => {
    const db = mk(); disburse(db); const e = db.asientos.find(a => a.claveOrigen === 'desembolso:CRE1');
    expect(L.editEntry(db, e.id, { descripcion: 'otro' }, ctxOf()).inmutable).toBe(true);
    expect(L.deleteEntry(db, e.id).inmutable).toBe(true);
    const tampered = clone(db); tampered.asientos.find(a => a.id === e.id).lineas[0].debe = 1;
    expect(L.validateWorkspaceChange(db, tampered).length).toBeGreaterThan(0);
    const removed = clone(db); removed.asientos = removed.asientos.filter(a => a.id !== e.id);
    expect(L.validateWorkspaceChange(db, removed).length).toBeGreaterThan(0);
    const trimmed = clone(db); trimmed.auditoriaConta.pop();
    expect(L.validateWorkspaceChange(db, trimmed).length).toBeGreaterThan(0);
    expect(L.validateWorkspaceChange(db, clone(db))).toEqual([]);
  });
  it('18. contabilizar en un período cerrado', () => {
    const db = mk(); L.closePeriodDirect ? 0 : 0;
    db.periodos = [{ id: '2026-11', estado: 'cerrado' }];
    const d = L.rules.gasto(db, { id: 'G7', fecha: '2026-11-10', monto: 10, cuenta: '5.1.01', pago: 'caja' }).draft;
    const r = L.post(db, d, ctxOf({ hoy: '2026-12-05' })); expect(r.ok).toBe(false); expect(r.error).toMatch(/cerrado/);
    expect(L.reopenPeriod(db, '2026-11', { motivo: 'corto' }, ctxOf()).ok).toBe(false);
    expect(L.reopenPeriod(db, '2026-11', { motivo: 'Falta registrar un gasto del mes', autorizadoPor: 'Propietario' }, ctxOf()).ok).toBe(true);
    expect(L.post(db, d, ctxOf({ hoy: '2026-12-05' })).ok).toBe(true);
    expect(auditHas(db, 'periodo.reabrir')).toBe(true);
  });
  it('19. operación simultánea que podría duplicar', () => {
    const base = mk(), a = clone(base), b = clone(base);
    disburse(a); disburse(b);                                                       // dos dispositivos contabilizan el mismo desembolso
    const merged = clone(base); const byId = new Map(); [...a.asientos, ...b.asientos].forEach(x => byId.set(x.id, x)); merged.asientos = [...byId.values()];
    expect(merged.asientos.filter(x => x.claveOrigen === 'desembolso:CRE1').length).toBe(1);
    expect(L.integrityCheck(merged)).toEqual([]);
    // dos asientos distintos con el mismo número: el creado en este dispositivo se renumera
    const c = clone(base), d = clone(base);
    L.post(c, L.rules.gasto(c, { id: 'GA', fecha: '2026-11-03', monto: 10, cuenta: '5.1.01', pago: 'caja' }).draft, ctxOf());
    L.post(d, L.rules.gasto(d, { id: 'GB', fecha: '2026-11-03', monto: 20, cuenta: '5.1.01', pago: 'caja' }).draft, ctxOf());
    const m2 = clone(c); m2.asientos.push(clone(d.asientos[d.asientos.length - 1]));
    expect(L.integrityCheck(m2).some(i => i.tipo === 'numero_repetido')).toBe(true);
    const changed = L.resolveNumberConflicts(m2, ['AS:gasto:GB']);
    expect(changed).toEqual(['AS:gasto:GB']); expect(L.integrityCheck(m2)).toEqual([]);
  });
  it('20. apertura con diferencias pendientes', () => {
    const db = { cfg: { secuencias: {}, conta: { inicio: '2026-11-01', fechaApertura: '2026-10-31', politicaIntereses: 'devengo_cuota' } } }; L.ensureCatalog(db, ctxOf());
    const lines = [{ cuenta: '1.1.01', debe: 5000, haber: 0, fuente: 'Arqueo físico 31/10' }, { cuenta: '3.1.01', debe: 0, haber: 4800, fuente: 'Aportes documentados' }];
    const v = L.validateOpening(db, lines); expect(v.bloqueado).toBe(true); expect(v.diferencia).toBe(200);
    const r = L.approveOpening(db, lines, {}, ctxOf()); expect(r.ok).toBe(false); expect(r.bloqueado).toBe(true); expect(db.cfg.conta.aperturaAprobada).toBeFalsy();
    expect(L.approveOpening(db, lines, { excepcion: { autorizadoPor: 'Propietario', sustento: 'corto' } }, ctxOf()).ok).toBe(false);
    expect(L.validateOpening(db, [{ cuenta: '1.1.01', debe: 5, haber: 0 }, { cuenta: '3.1.01', debe: 0, haber: 5 }]).errores.length).toBeGreaterThan(0);   // sin fuente
    const ok = L.approveOpening(db, [{ cuenta: '1.1.01', debe: 5000, haber: 0, fuente: 'Arqueo' }, { cuenta: '3.1.01', debe: 0, haber: 5000, fuente: 'Aportes' }], { observaciones: 'ok' }, ctxOf());
    expect(ok.ok).toBe(true); expect(db.cfg.conta.aperturaAprobada).toBe(true);
    expect(L.approveOpening(db, lines, {}, ctxOf()).ok).toBe(false);                  // no se aprueba dos veces
    const ex = { cfg: { conta: { inicio: '2026-11-01', fechaApertura: '2026-10-31' } } }; L.ensureCatalog(ex, ctxOf());
    expect(L.approveOpening(ex, lines, { excepcion: { autorizadoPor: 'Propietario', sustento: 'Diferencia pendiente de conciliar con extractos de octubre' } }, ctxOf()).ok).toBe(true);
    expect(L.balanceSheet(ex, '2026-11-30').advertencias.length).toBe(1);
  });
});

describe('reglas adicionales', () => {
  it('sin política de intereses o sin apertura aprobada no se contabilizan operaciones', () => {
    const db = mk(null); expect(L.rules.desembolso(db, credit(), { confirmado: true, fecha: '2026-11-02' }).ok).toBe(false);
    const nb = { cfg: { conta: { inicio: '2026-11-01', politicaIntereses: 'al_cobro' } } }; L.ensureCatalog(nb, ctxOf());
    expect(L.post(nb, L.rules.gasto(nb, { id: 'G', fecha: '2026-11-03', monto: 5, cuenta: '5.1.01', pago: 'caja' }).draft, ctxOf()).ok).toBe(false);
  });
  it('no se recontabilizan operaciones anteriores al inicio contable', () => {
    const db = mk(); expect(L.post(db, L.rules.gasto(db, { id: 'GV', fecha: '2026-10-15', monto: 5, cuenta: '5.1.01', pago: 'caja' }).draft, ctxOf()).ok).toBe(false);
  });
  it('política al cobro: los intereses son ingreso solo cuando se cobran', () => {
    const db = mk('al_cobro'); disburse(db);
    expect([bal(db, '1.2.01'), bal(db, '1.2.02'), bal(db, '4.1.01')]).toEqual([6000, 0, 0]);
    pay(db, { id: 'RCa', pri: 500, int: 230, m: 0, t: 730, fechaISO: '2026-11-09' });
    expect(bal(db, '4.1.01')).toBe(230);
  });
  it('refinanciamiento: la compensación transitoria queda en cero y bloquea el cierre si no', () => {
    const db = mk(); disburse(db, credit({ id: 'CRE2', cap: 1000, total: 1200, descuento: 300, neto: 700 }));
    expect([bal(db, '1.1.01'), bal(db, '1.2.99')]).toEqual([9300, -300]);
    pay(db, { id: 'RCr', tipo: 'refinanciamiento', pri: 300, int: 0, m: 0, t: 300, fechaISO: '2026-11-02' }, credit({ id: 'CRE0' }));
    expect(bal(db, '1.2.99')).toBe(0);
    expect(L.closePeriod(db, '2026-11', ctxOf()).ok).toBe(false);                     // tareas sin aprobar
  });
  it('aporte de gasto personal exige decidir el tratamiento', () => {
    const db = mk();
    expect(L.rules.propietario(db, { tipo: 'gasto_personal', fecha: '2026-11-04', monto: 50 }).ok).toBe(false);
    L.post(db, L.rules.propietario(db, { tipo: 'gasto_personal', tratamiento: 'por_cobrar', fecha: '2026-11-04', monto: 50, id: 'GP' }).draft, ctxOf());
    expect([bal(db, '1.3.02'), L.incomeStatement(db, '2026-11-01', '2026-11-30').totalGastos]).toEqual([50, 0]);
    expect(L.rules.gasto(db, { fecha: '2026-11-04', monto: 10, cuenta: '5.1.01', pago: 'propietario' }).ok).toBe(false);
  });
  it('cierre de caja no ajusta el saldo; el ajuste exige aprobación', () => {
    const db = mk(); const c = L.cashClose(db, { cuenta: '1.1.01', fecha: '2026-11-10', fisico: 9990 }, ctxOf());
    expect(c.cierre.diferencia).toBe(-10); expect(c.cierre.estado).toBe('pendiente_investigacion'); expect(bal(db, '1.1.01')).toBe(10000);
    expect(L.rules.diferenciaCaja(db, { fecha: '2026-11-10', teorico: 10000, fisico: 9990, cuenta: 'caja', motivo: 'faltante' }).ok).toBe(false);
    L.post(db, L.rules.diferenciaCaja(db, { id: 'DC1', fecha: '2026-11-10', teorico: 10000, fisico: 9990, cuenta: 'caja', motivo: 'Faltante investigado y aceptado', aprobadoPor: 'Propietario' }).draft, ctxOf());
    expect([bal(db, '1.1.01'), bal(db, '5.1.12')]).toEqual([9990, 10]);
  });
  it('conciliación bancaria compara importes', () => {
    const db = mk(); L.post(db, L.rules.transferencia(db, { desde: 'caja', hacia: 'banco', fecha: '2026-11-07', monto: 2000, id: 'T1' }).draft, ctxOf());
    L.bankMovement(db, { id: 'B1', fecha: '2026-11-07', monto: 1999, descripcion: 'Depósito' }, ctxOf()); L.bankMovement(db, { id: 'B2', fecha: '2026-11-07', monto: 2000 }, ctxOf());
    expect(L.reconcileBank(db, 'B1', 'AS:transf:T1', ctxOf()).ok).toBe(false);
    expect(L.reconcileBank(db, 'B2', 'AS:transf:T1', ctxOf()).ok).toBe(true);
    expect(L.bankReport(db).pendientes.length).toBe(1);
  });
  it('informes cuadran entre sí y proceden del mayor', () => {
    const db = mk(); disburse(db); pay(db, { id: 'RC1', pri: 500, int: 230, m: 40, t: 770, fechaISO: '2026-11-09' });
    L.post(db, L.rules.gasto(db, { id: 'G1', fecha: '2026-11-10', monto: 100, cuenta: '5.1.01', pago: 'caja' }).draft, ctxOf());
    const bs = L.balanceSheet(db, '2026-11-30'), is = L.incomeStatement(db, '2026-11-01', '2026-11-30'), cf = L.cashFlow(db, '2026-11-01', '2026-11-30');
    expect(bs.cuadra).toBe(true); expect(bs.resultadoEjercicio).toBe(is.resultado); expect(is.resultado).toBe(170);
    expect(cf.cuadra).toBe(true); expect(cf.efectivoFinal).toBe(L.cashBalance(db, '2026-11-30'));
    expect(L.dashboard(db, '2026-11-30').efectivo.valor).toBe(L.cashBalance(db, '2026-11-30'));
  });
  it('activos fijos: no todo se convierte en activo', () => {
    const db = mk(); expect(L.registerAsset(db, { descripcion: 'Moto', costo: 30000, vidaMeses: 60, fechaAdq: '2026-11-05' }, ctxOf()).ok).toBe(false);
    db.cfg.conta.umbralActivoFijo = 5000;
    expect(L.registerAsset(db, { descripcion: 'Engrapadora', costo: 300, vidaMeses: 60 }, ctxOf()).ok).toBe(false);
    const a = L.registerAsset(db, { descripcion: 'Moto', costo: 30000, vidaMeses: 60, fechaAdq: '2026-11-05' }, ctxOf()).activo;
    const dep = L.rules.depreciacion(db, a, '2026-11'); expect(dep.ok).toBe(true);
    expect(dep.draft.lineas[0].debe).toBe(500);
  });
});
