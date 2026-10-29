import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

// Transactions exercise real server enforcement but always roll back their test writes.
const sql = (query: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' });
const entry = { id: 'test-entry', num: 1, fecha: '2026-11-01', estado: 'contabilizado', clave: 'test:1', lineas: [{ cuenta: '1', debe: 100, haber: 0 }, { cuenta: '2', debe: 0, haber: 100 }] };
const previous = { asientos: [entry], auditoria: [{ id: 'audit-1', accion: 'contabilizar' }] };
const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const validate = (before: unknown, after: unknown) => `SELECT public.validate_accounting_change(${literal(before)},${literal(after)},'num','clave','auditoria');`;

describe.skipIf(!process.env['GYC_PRIVILEGED_DB_TESTS'])('cloud accounting integrity', () => {
  it('accepts a balanced C$100 entry without changing real data', () => {
    expect(() => sql(`BEGIN; ${validate({}, previous)} ROLLBACK;`)).not.toThrow();
  });
  it('rejects changing a posted C$100 entry', () => {
    expect(() => sql(`BEGIN; ${validate(previous, { ...previous, asientos: [{ ...entry, fecha: '2026-11-02' }] })} ROLLBACK;`)).toThrow(/asiento contabilizado inmutable/);
  });
  it('rejects deleting audit history', () => {
    expect(() => sql(`BEGIN; ${validate(previous, { ...previous, auditoria: [] })} ROLLBACK;`)).toThrow(/auditoria inmutable/);
  });
  it('rejects duplicate operation keys', () => {
    expect(() => sql(`BEGIN; ${validate({}, { asientos: [entry, { ...entry, id: 'second', num: 2 }] })} ROLLBACK;`)).toThrow(/operacion repetida/);
  });
  it('rejects C$100 debit against C$90 credit', () => {
    expect(() => sql(`BEGIN; ${validate({}, { asientos: [{ ...entry, lineas: [{ debe: 100 }, { haber: 90 }] }] })} ROLLBACK;`)).toThrow(/asiento descuadrado/);
  });
  it('rejects posting a draft into the closed November 2026 period', () => {
    expect(() => sql(`BEGIN; ${validate({ asientos: [{ ...entry, estado: 'borrador' }], periodos: [{ id: '2026-11', estado: 'cerrado' }] }, previous)} ROLLBACK;`)).toThrow(/periodo cerrado/);
  });
  it('persists administrator contributions inside a rolled-back transaction', () => {
    const query = `BEGIN;
      SELECT set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM public.team_members WHERE role='owner' LIMIT 1))::text,true);
      DO $$ DECLARE d jsonb; v bigint; BEGIN
        SELECT data,version INTO d,v FROM public.workspace WHERE id=1 FOR UPDATE;
        d:=jsonb_set(d,'{aportes}',coalesce(d->'aportes','[]'::jsonb)||'[{"id":"cloud-test","socioId":"test","monto":100,"fecha":"2026-10-29"}]'::jsonb);
        PERFORM public.save_workspace(d,v);
        IF NOT EXISTS (SELECT 1 FROM public.workspace WHERE data->'aportes' @> '[{"id":"cloud-test","monto":100}]'::jsonb) THEN RAISE EXCEPTION 'contribution not persisted'; END IF;
      END $$; ROLLBACK;`;
    expect(() => sql(query)).not.toThrow();
  });
});