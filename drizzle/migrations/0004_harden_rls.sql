-- Hardening pass (security review): every table in public keeps Row Level Security on and exposes only the
-- access the app really uses. No policy is loosened. Idempotent.
--
-- user_data (deprecated, one row per user): add the missing "own delete" policy and make "own update" explicit.
DROP POLICY IF EXISTS "own update" ON public.user_data;
CREATE POLICY "own update" ON public.user_data FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "own delete" ON public.user_data;
CREATE POLICY "own delete" ON public.user_data FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- team_members / workspace are shared by the whole team (owner, admins, cobradores), so their policies are role-based
-- through public.my_role() instead of "own rows". workspace can only be written through save_workspace().
ALTER TABLE public.user_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace ENABLE ROW LEVEL SECURITY;

-- Table privileges: anonymous visitors get nothing; signed-in users get only what the policies can use.
REVOKE ALL ON public.user_data, public.team_members, public.workspace FROM anon;
REVOKE ALL ON public.user_data, public.team_members, public.workspace FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_data TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_members TO authenticated;
GRANT SELECT ON public.workspace TO authenticated;
GRANT ALL ON public.user_data, public.team_members, public.workspace TO service_role;

-- Future tables created in public are not readable by anonymous visitors by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

-- Safety net for the Security Advisor's "RLS disabled" finding: any other table in public gets RLS enabled
-- (without policies it is closed to anon/authenticated; the service role is unaffected).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
