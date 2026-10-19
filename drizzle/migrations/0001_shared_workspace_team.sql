CREATE TABLE public.team_members (
  email text PRIMARY KEY,
  role text NOT NULL DEFAULT 'cobrador',
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.workspace (
  id int PRIMARY KEY DEFAULT 1,
  data jsonb,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.workspace (id, data, version) VALUES (1, NULL, 0);

GRANT SELECT, INSERT, DELETE ON public.team_members TO authenticated;
GRANT ALL ON public.team_members TO service_role;
GRANT SELECT ON public.workspace TO authenticated;
GRANT ALL ON public.workspace TO service_role;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.my_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.team_members WHERE email = lower(auth.jwt()->>'email')
$$;

CREATE POLICY "members read team" ON public.team_members FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);
CREATE POLICY "owner adds" ON public.team_members FOR INSERT TO authenticated WITH CHECK (public.my_role() = 'owner' AND role = 'cobrador');
CREATE POLICY "owner removes" ON public.team_members FOR DELETE TO authenticated USING (public.my_role() = 'owner' AND role <> 'owner');
CREATE POLICY "members read workspace" ON public.workspace FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);

-- First account to call this becomes the owner; imports their earlier personal data.
CREATE OR REPLACE FUNCTION public.claim_owner() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r text; old jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;
  r := public.my_role();
  IF r IS NOT NULL THEN RETURN r; END IF;
  IF EXISTS (SELECT 1 FROM public.team_members) THEN RETURN NULL; END IF;
  INSERT INTO public.team_members (email, role) VALUES (lower(auth.jwt()->>'email'), 'owner');
  SELECT data->>'gyc_v10' INTO r FROM public.user_data WHERE user_id = auth.uid();
  IF r IS NOT NULL THEN
    old := r::jsonb;
    UPDATE public.workspace SET data = old, version = version + 1, updated_at = now() WHERE id = 1 AND data IS NULL;
  END IF;
  RETURN 'owner';
END $$;

CREATE OR REPLACE FUNCTION public.save_workspace(new_data jsonb, expected_version bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v bigint;
BEGIN
  IF public.my_role() IS NULL THEN RAISE EXCEPTION 'not a team member'; END IF;
  UPDATE public.workspace SET data = new_data, version = version + 1, updated_at = now()
    WHERE id = 1 AND version = expected_version RETURNING version INTO v;
  RETURN v; -- NULL means someone else saved first
END $$;

REVOKE EXECUTE ON FUNCTION public.my_role(), public.claim_owner(), public.save_workspace(jsonb, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_role(), public.claim_owner(), public.save_workspace(jsonb, bigint) TO authenticated;
COMMENT ON TABLE public.user_data IS 'DEPRECATED: replaced by shared workspace';