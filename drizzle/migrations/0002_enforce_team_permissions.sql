GRANT UPDATE ON public.team_members TO authenticated;
DROP POLICY "owner adds" ON public.team_members;
DROP POLICY "owner removes" ON public.team_members;
CREATE POLICY "admins add members" ON public.team_members FOR INSERT TO authenticated WITH CHECK (public.my_role() IN ('owner','admin') AND role IN ('admin','desembolsador','cobrador','asistente'));
CREATE POLICY "admins update members" ON public.team_members FOR UPDATE TO authenticated USING (public.my_role() IN ('owner','admin') AND role <> 'owner') WITH CHECK (public.my_role() IN ('owner','admin') AND role IN ('admin','desembolsador','cobrador','asistente'));
CREATE POLICY "admins remove members" ON public.team_members FOR DELETE TO authenticated USING (public.my_role() IN ('owner','admin') AND role <> 'owner');
CREATE OR REPLACE FUNCTION public.save_workspace(new_data jsonb, expected_version bigint) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v bigint; r text; old jsonb; item jsonb; newer jsonb; oldcfg jsonb; newcfg jsonb; added numeric; paid_delta numeric; olditem jsonb;
BEGIN
 r := public.my_role();
 IF r IS NULL OR r NOT IN ('owner','admin','cobrador','desembolsador') THEN RAISE EXCEPTION 'permission denied' USING ERRCODE='42501'; END IF;
 SELECT data, version INTO old,v FROM public.workspace WHERE id=1 FOR UPDATE;
 IF v <> expected_version THEN RETURN NULL; END IF;
 IF jsonb_typeof(new_data) <> 'object' THEN RAISE EXCEPTION 'invalid workspace'; END IF;
 IF r NOT IN ('owner','admin') THEN
  IF old IS NULL THEN RAISE EXCEPTION 'administrator must initialize workspace'; END IF;
  IF (new_data - ARRAY['cli','cre','pag','cfg','hist']) IS DISTINCT FROM (old - ARRAY['cli','cre','pag','cfg','hist']) THEN RAISE EXCEPTION 'protected data'; END IF;
  oldcfg := old->'cfg'; newcfg := new_data->'cfg';
  IF (oldcfg-'secuencias') IS DISTINCT FROM (newcfg-'secuencias') THEN RAISE EXCEPTION 'protected configuration'; END IF;
  IF r='desembolsador' THEN
   IF new_data->'pag' IS DISTINCT FROM old->'pag' THEN RAISE EXCEPTION 'disburser cannot collect'; END IF;
   IF (oldcfg->'secuencias' - ARRAY['cliNext','creNext']) IS DISTINCT FROM (newcfg->'secuencias' - ARRAY['cliNext','creNext']) THEN RAISE EXCEPTION 'protected numbering'; END IF;
   FOR item IN SELECT value FROM jsonb_array_elements(old->'cli') LOOP
    SELECT value INTO newer FROM jsonb_array_elements(new_data->'cli') WHERE value->>'id'=item->>'id';
    IF newer IS DISTINCT FROM item THEN RAISE EXCEPTION 'cannot edit existing clients'; END IF;
   END LOOP;
   FOR item IN SELECT value FROM jsonb_array_elements(old->'cre') LOOP
    SELECT value INTO newer FROM jsonb_array_elements(new_data->'cre') WHERE value->>'id'=item->>'id';
    IF newer IS DISTINCT FROM item THEN RAISE EXCEPTION 'cannot edit existing credits'; END IF;
   END LOOP;
  ELSE
   IF new_data->'cli' IS DISTINCT FROM old->'cli' OR jsonb_array_length(new_data->'cre') <> jsonb_array_length(old->'cre') THEN RAISE EXCEPTION 'collector cannot create or edit clients or credits'; END IF;
   IF (oldcfg->'secuencias'-'recNext') IS DISTINCT FROM (newcfg->'secuencias'-'recNext') THEN RAISE EXCEPTION 'protected numbering'; END IF;
   FOR item IN SELECT value FROM jsonb_array_elements(old->'pag') LOOP
    SELECT value INTO newer FROM jsonb_array_elements(new_data->'pag') WHERE value->>'id'=item->>'id';
    IF newer IS DISTINCT FROM item THEN RAISE EXCEPTION 'cannot alter receipts'; END IF;
   END LOOP;
   FOR item IN SELECT value FROM jsonb_array_elements(new_data->'pag') WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(old->'pag') p WHERE p->>'id'=value->>'id') LOOP
    IF coalesce((item->>'dis')::numeric,0) <> 0 OR (item->>'t')::numeric <= 0 OR coalesce((item->>'m')::numeric,0)<0 OR (item->>'t')::numeric < coalesce((item->>'m')::numeric,0) THEN RAISE EXCEPTION 'invalid collection'; END IF;
   END LOOP;
   FOR item IN SELECT value FROM jsonb_array_elements(old->'cre') LOOP
    SELECT value INTO newer FROM jsonb_array_elements(new_data->'cre') WHERE value->>'id'=item->>'id';
    IF newer IS NULL OR (item-ARRAY['saldo','schedule']) IS DISTINCT FROM (newer-ARRAY['saldo','schedule']) OR jsonb_array_length(item->'schedule')<>jsonb_array_length(newer->'schedule') THEN RAISE EXCEPTION 'protected credit'; END IF;
    SELECT coalesce(sum((p->>'t')::numeric-coalesce((p->>'m')::numeric,0)),0) INTO added FROM jsonb_array_elements(new_data->'pag') p WHERE p->>'creId'=item->>'id' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(old->'pag') op WHERE op->>'id'=p->>'id');
    IF abs((item->>'saldo')::numeric-(newer->>'saldo')::numeric-added)>0.01 OR (newer->>'saldo')::numeric < -0.01 THEN RAISE EXCEPTION 'balance must match collections'; END IF;
    paid_delta := 0;
    FOR olditem IN SELECT value FROM jsonb_array_elements(item->'schedule') LOOP
     SELECT value INTO newcfg FROM jsonb_array_elements(newer->'schedule') WHERE value->>'n'=olditem->>'n';
     IF newcfg IS NULL OR (olditem-ARRAY['paid','status','moraPaidInCycle','moraPaidTotal','moraCycleStartDate','moraLastPaymentDate']) IS DISTINCT FROM (newcfg-ARRAY['paid','status','moraPaidInCycle','moraPaidTotal','moraCycleStartDate','moraLastPaymentDate']) OR (newcfg->>'paid')::numeric < (olditem->>'paid')::numeric OR (newcfg->>'paid')::numeric > (newcfg->>'amount')::numeric+0.01 THEN RAISE EXCEPTION 'protected installment'; END IF;
     paid_delta := paid_delta+(newcfg->>'paid')::numeric-(olditem->>'paid')::numeric;
    END LOOP;
    IF abs(paid_delta-added)>0.01 THEN RAISE EXCEPTION 'installments must match collections'; END IF;
   END LOOP;
  END IF;
 END IF;
 UPDATE public.workspace SET data=new_data,version=version+1,updated_at=now() WHERE id=1 RETURNING version INTO v;
 RETURN v;
END $$;