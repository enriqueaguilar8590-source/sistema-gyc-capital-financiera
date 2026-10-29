CREATE OR REPLACE FUNCTION public.validate_accounting_change(previous jsonb, candidate jsonb, number_key text, origin_key text, audit_key text) RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE a jsonb; n jsonb;
BEGIN
 IF candidate IS NULL AND previous IS NULL THEN RETURN; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(coalesce(previous->'asientos','[]'::jsonb)) WHERE value->>'estado'='contabilizado' LOOP
  SELECT value INTO n FROM jsonb_array_elements(coalesce(candidate->'asientos','[]'::jsonb)) WHERE value->>'id'=a->>'id';
  IF n IS DISTINCT FROM a THEN RAISE EXCEPTION 'ledger: asiento contabilizado inmutable' USING ERRCODE='23000'; END IF;
 END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(coalesce(previous->audit_key,'[]'::jsonb)) LOOP
  SELECT value INTO n FROM jsonb_array_elements(coalesce(candidate->audit_key,'[]'::jsonb)) WHERE value->>'id'=a->>'id';
  IF n IS DISTINCT FROM a THEN RAISE EXCEPTION 'ledger: auditoria inmutable' USING ERRCODE='23000'; END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(candidate->'asientos','[]'::jsonb)) GROUP BY value->>'id' HAVING count(*)>1) THEN RAISE EXCEPTION 'ledger: identificador repetido' USING ERRCODE='23505'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(candidate->'asientos','[]'::jsonb)) WHERE value->>'estado'='contabilizado' GROUP BY value->>number_key HAVING count(*)>1) THEN RAISE EXCEPTION 'ledger: numero repetido' USING ERRCODE='23505'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(candidate->'asientos','[]'::jsonb)) WHERE value->>'estado'='contabilizado' AND coalesce(value->>origin_key,'')<>'' GROUP BY value->>origin_key HAVING count(*)>1) THEN RAISE EXCEPTION 'ledger: operacion repetida' USING ERRCODE='23505'; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(coalesce(candidate->'asientos','[]'::jsonb)) WHERE value->>'estado'='contabilizado' LOOP
  IF coalesce(a->>'id','')='' OR coalesce(a->>number_key,'')='' OR jsonb_typeof(a->'lineas') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'lineas')<2 THEN RAISE EXCEPTION 'ledger: asiento invalido' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(a->'lineas') l WHERE coalesce((l->>'debe')::numeric,0)<0 OR coalesce((l->>'haber')::numeric,0)<0 OR (coalesce((l->>'debe')::numeric,0)>0)=(coalesce((l->>'haber')::numeric,0)>0)) OR (SELECT sum(round(coalesce((l->>'debe')::numeric,0)*100)-round(coalesce((l->>'haber')::numeric,0)*100)) FROM jsonb_array_elements(a->'lineas') l)<>0 THEN RAISE EXCEPTION 'ledger: asiento descuadrado' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(previous->'asientos','[]'::jsonb)) o WHERE o->>'id'=a->>'id' AND o->>'estado'='contabilizado') AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(previous->'periodos','[]'::jsonb)) p WHERE p->>'id'=substr(a->>'fecha',1,7) AND p->>'estado'='cerrado') THEN RAISE EXCEPTION 'ledger: periodo cerrado' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF previous->'apertura'->>'estado'='aprobada' AND candidate->'apertura' IS DISTINCT FROM previous->'apertura' THEN RAISE EXCEPTION 'ledger: apertura aprobada inmutable' USING ERRCODE='23000'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.validate_accounting_change(jsonb,jsonb,text,text,text) FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public.guard_accounting_workspace() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
 PERFORM public.validate_accounting_change(OLD.data,NEW.data,'numero','claveOrigen','auditoriaConta');
 PERFORM public.validate_accounting_change(OLD.data->'pd',NEW.data->'pd','num','clave','auditoria');
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_accounting_workspace() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_accounting_workspace BEFORE UPDATE ON public.workspace FOR EACH ROW EXECUTE FUNCTION public.guard_accounting_workspace();