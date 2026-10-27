-- PENDIENTE DE APLICAR (no está en drizzle/migrations a propósito).
-- Protege el libro diario en el servidor, para TODOS los roles (incluido administrador):
--   * un asiento contabilizado no se puede cambiar ni quitar del espacio de trabajo;
--   * la bitácora contable (auditoriaConta) solo crece;
--   * no puede haber dos asientos contabilizados con el mismo número ni con la misma operación de origen;
--   * cada asiento contabilizado debe tener débitos = créditos;
--   * no se pueden agregar asientos con fecha en un período que ya estaba cerrado.
-- No reemplaza save_workspace: es un disparador adicional, por lo que se puede quitar con
--   DROP TRIGGER guard_ledger ON public.workspace; DROP FUNCTION public.guard_ledger();
CREATE OR REPLACE FUNCTION public.guard_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a jsonb; n jsonb; cnt int;
BEGIN
 IF NEW.data IS NULL OR OLD.data IS NULL THEN RETURN NEW; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(coalesce(OLD.data->'asientos','[]'::jsonb)) WHERE value->>'estado'='contabilizado' LOOP
  SELECT value INTO n FROM jsonb_array_elements(coalesce(NEW.data->'asientos','[]'::jsonb)) WHERE value->>'id'=a->>'id' LIMIT 1;
  IF n IS DISTINCT FROM a THEN RAISE EXCEPTION 'ledger: el asiento contabilizado % no se puede modificar ni eliminar', a->>'numero' USING ERRCODE='23000'; END IF;
 END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(coalesce(OLD.data->'auditoriaConta','[]'::jsonb)) LOOP
  SELECT value INTO n FROM jsonb_array_elements(coalesce(NEW.data->'auditoriaConta','[]'::jsonb)) WHERE value->>'id'=a->>'id' LIMIT 1;
  IF n IS DISTINCT FROM a THEN RAISE EXCEPTION 'ledger: la bitácora contable no se puede modificar ni eliminar' USING ERRCODE='23000'; END IF;
 END LOOP;
 SELECT count(*) INTO cnt FROM (SELECT 1 FROM jsonb_array_elements(coalesce(NEW.data->'asientos','[]'::jsonb)) WHERE value->>'estado'='contabilizado' GROUP BY value->>'numero' HAVING count(*)>1) x;
 IF cnt > 0 THEN RAISE EXCEPTION 'ledger: número de asiento repetido' USING ERRCODE='23505'; END IF;
 SELECT count(*) INTO cnt FROM (SELECT 1 FROM jsonb_array_elements(coalesce(NEW.data->'asientos','[]'::jsonb)) WHERE value->>'estado'='contabilizado' AND coalesce(value->>'claveOrigen','')<>'' GROUP BY value->>'claveOrigen' HAVING count(*)>1) x;
 IF cnt > 0 THEN RAISE EXCEPTION 'ledger: operación contabilizada dos veces' USING ERRCODE='23505'; END IF;
 SELECT count(*) INTO cnt FROM jsonb_array_elements(coalesce(NEW.data->'asientos','[]'::jsonb)) e
  WHERE e->>'estado'='contabilizado' AND (SELECT coalesce(sum(round((l->>'debe')::numeric*100)),0) - coalesce(sum(round((l->>'haber')::numeric*100)),0) FROM jsonb_array_elements(e->'lineas') l) <> 0;
 IF cnt > 0 THEN RAISE EXCEPTION 'ledger: asiento descuadrado' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO cnt FROM jsonb_array_elements(coalesce(NEW.data->'asientos','[]'::jsonb)) e
  WHERE e->>'estado'='contabilizado'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(OLD.data->'asientos','[]'::jsonb)) o WHERE o->>'id'=e->>'id')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(OLD.data->'periodos','[]'::jsonb)) p WHERE p->>'id'=substr(e->>'fecha',1,7) AND p->>'estado'='cerrado');
 IF cnt > 0 THEN RAISE EXCEPTION 'ledger: período contable cerrado' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_ledger ON public.workspace;
CREATE TRIGGER guard_ledger BEFORE UPDATE ON public.workspace FOR EACH ROW EXECUTE FUNCTION public.guard_ledger();
