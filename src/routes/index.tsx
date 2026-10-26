import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { merge3 } from "@/lib/merge";
import { mayRestorePending, requireSaveResult, type SyncCheckpoint } from "@/lib/workspace-sync";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "GYC Capital Pro — Crecamos juntos" },
      { name: "description", content: "Sistema de créditos y cobros de GYC Capital para dueño y cobradores, sincronizado en la nube." },
      { property: "og:title", content: "GYC Capital Pro" },
      { property: "og:description", content: "Sistema de créditos y cobros de GYC Capital, sincronizado en la nube." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type Obj = Record<string, unknown>;
const KEY = "gyc_v10";
const CHECKPOINT_KEY = "gyc_sync_checkpoint";
const readLocal = (): Obj | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
};

function Index() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [role, setRole] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((e, s) => {
      if (e === "SIGNED_IN" || e === "SIGNED_OUT" || e === "INITIAL_SESSION") setSession(s);
    });
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session) return setRole(undefined);
    supabase.rpc("claim_owner").then(({ data }) => setRole((data as string | null) ?? null));
  }, [session?.user.id]);

  if (session === undefined || (session && role === undefined)) return <Center><Logo /><p>Cargando…</p></Center>;
  if (!session) return <Login />;
  if (!role)
    return (
      <Center>
        <Card>
          <Logo />
          <h1 className="text-center text-lg font-bold">Aún no tienes acceso</h1>
          <p className="text-center text-sm text-muted-foreground">
            Pide al dueño que agregue tu correo <b className="text-foreground">{session.user.email}</b> en “Equipo”, y luego vuelve a entrar.
          </p>
          <button className="btn-brand" onClick={() => location.reload()}>Ya me agregaron</button>
          <button className="btn-ghost" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button>
        </Card>
      </Center>
    );
  return <Sistema role={role} userId={session.user.id} />;
}

function Sistema({ role, userId }: { role: string; userId: string }) {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Sincronizado");
  const [team, setTeam] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const base = useRef<Obj | null>(null);
  const version = useRef(0);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const initialized = useRef(false);

  const sync = useCallback((): Promise<boolean> => {
    if (!initialized.current) return Promise.resolve(false);
    if (inFlight.current) return inFlight.current;
    const run = async () => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
      const local = readLocal();
      const { data: ws, error } = await supabase.from("workspace").select("data, version").eq("id", 1).single();
      if (error) throw error;
      const remote = ws.data as Obj | null;
      let merged = local;
      if (ws.version !== version.current) {
        merged = merge3(base.current, local, remote);
        if (JSON.stringify(merged) !== JSON.stringify(local) && merged) {
          localStorage.setItem(KEY, JSON.stringify(merged));
          (frame.current?.contentWindow as unknown as { __gycApply?: (d: Obj) => void })?.__gycApply?.(merged);
        }
      }
      if (merged && JSON.stringify(merged) !== JSON.stringify(remote)) {
        setStatus("Guardando…");
        const { data: v, error: saveError } = await supabase.rpc("save_workspace", { new_data: merged as never, expected_version: ws.version });
        const saved = requireSaveResult(saveError, v);
        if (saved == null) continue;
        version.current = saved;
      } else version.current = ws.version;
      base.current = merged;
      localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ userId, base: merged }));
      setStatus("Sincronizado");
      return true;
      }
      setStatus("Cambios pendientes — vuelve a intentar");
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      setStatus(/permission|protected|cannot|invalid|balance|installment/i.test(message) ? "No se pudo guardar: revisa tus permisos o los cambios" : "Sin conexión — cambios conservados en este dispositivo");
      return false;
    }
    };
    const promise = run().finally(() => { inFlight.current = null; });
    inFlight.current = promise;
    return promise;
  }, [userId]);

  useEffect(() => {
    (async () => {
      let checkpoint: SyncCheckpoint | null = null;
      try { checkpoint = JSON.parse(localStorage.getItem(CHECKPOINT_KEY) || 'null'); } catch { /* ignore invalid checkpoint */ }
      const { data: ws, error } = await supabase.from("workspace").select("data, version").eq("id", 1).single();
      if (error) { setStatus("No se pudieron descargar los datos. Vuelve a intentar."); return; }
      const remote = (ws?.data as Obj) ?? null;
      const merged = mayRestorePending(checkpoint, userId) ? merge3(checkpoint?.base ?? null, readLocal(), remote) : remote;
      if (merged) localStorage.setItem(KEY, JSON.stringify(merged));
      else localStorage.removeItem(KEY);
      base.current = remote;
      localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ userId, base: remote }));
      version.current = ws.version;
      initialized.current = true;
      setReady(true);
    })();
    const onMsg = (e: MessageEvent) => e.data === "gyc-save" && setTimeout(sync, 300);
    window.addEventListener("message", onMsg);
    const iv = setInterval(sync, 5000);
    return () => {
      clearInterval(iv);
      window.removeEventListener("message", onMsg);
    };
  }, [sync, userId]);

  if (!ready) return <Center><Logo /><p>{status === 'Sincronizado' ? 'Descargando datos de la nube…' : status}</p>{status !== 'Sincronizado' && <Button onClick={() => location.reload()}>Reintentar</Button>}</Center>;
  return (
    <div className="flex h-dvh flex-col bg-background">
      <iframe ref={frame} src={`/sistema.html?role=${encodeURIComponent(role)}`} title="GYC Capital" className="w-full flex-1 border-0" />
      <div className="flex items-center justify-between gap-3 border-t border-border bg-brand-deep px-3 py-1.5 text-xs text-brand-deep-foreground">
        <span>☁ {status}</span>
        <div className="flex gap-4">
          {(role === "owner" || role === "admin") && <Button variant="ghost" size="sm" className="font-semibold text-gold" onClick={() => setTeam(true)}>Equipo</Button>}
          <Button variant="ghost" size="sm" className="font-semibold" onClick={async () => { if (!await sync() || !await sync()) { alert('Tus cambios todavía no están guardados. Reintenta antes de cerrar sesión.'); return; } localStorage.removeItem(KEY); localStorage.removeItem(CHECKPOINT_KEY); await supabase.auth.signOut(); }}>
            Cerrar sesión
          </Button>
        </div>
      </div>
      {team && <Team onClose={() => setTeam(false)} />}
    </div>
  );
}

function Team({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<{ email: string; role: string }[]>([]);
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState("cobrador");
  const roleNames: Record<string, string> = { owner: 'Dueño', admin: 'Administrador', desembolsador: 'Desembolsador', cobrador: 'Cobrador', asistente: 'Asistente' };
  const [msg, setMsg] = useState("");
  const load = () => supabase.from("team_members").select("email, role").order("added_at").then(({ data }) => setList(data ?? []));
  useEffect(() => { load(); }, []);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.from("team_members").insert({ email: email.trim().toLowerCase(), role: newRole });
    setMsg(error ? "No se pudo agregar (¿ya existe?)" : "Agregado. Ya puede crear su cuenta con ese correo.");
    if (!error) { setEmail(""); load(); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-overlay p-3 sm:items-center">
      <div className="w-full max-w-md space-y-3 rounded-2xl bg-card p-5 text-card-foreground shadow-brand">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Equipo</h2>
          <Button variant="ghost" size="icon" aria-label="Cerrar Equipo" onClick={onClose} className="text-2xl leading-none text-muted-foreground">×</Button>
        </div>
        <form onSubmit={add} className="flex flex-wrap gap-2">
          <input className="field flex-1" type="email" required placeholder="correo@cobrador.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="field" aria-label="Permiso del nuevo miembro" value={newRole} onChange={e => setNewRole(e.target.value)}>{Object.entries(roleNames).filter(([r]) => r !== 'owner').map(([r,label]) => <option key={r} value={r}>{label}</option>)}</select>
          <Button type="submit">Agregar</Button>
        </form>
        {msg && <p className="text-xs text-primary">{msg}</p>}
        <ul className="divide-y divide-border">
          {list.map((m) => (
            <li key={m.email} className="flex items-center justify-between py-2 text-sm">
              <span className="min-w-0 break-all">{m.email} {m.role === 'owner' && <span className="text-xs text-muted-foreground">(Dueño)</span>}</span>
              {m.role !== "owner" && (
                <div className="flex shrink-0 flex-col gap-1"><select className="field" aria-label={`Permiso de ${m.email}`} value={m.role} onChange={async e => { const {error} = await supabase.from('team_members').update({role:e.target.value}).eq('email',m.email); setMsg(error ? 'No se pudo cambiar el permiso.' : 'Permiso actualizado. Se aplicará al volver a entrar.'); load(); }}>{Object.entries(roleNames).filter(([r]) => r !== 'owner').map(([r,label]) => <option key={r} value={r}>{label}</option>)}</select><Button variant="ghost" size="sm" className="text-destructive" onClick={async () => { if(!confirm('¿Quitar el acceso de este miembro? Su historial se conservará.')) return; const {error} = await supabase.from("team_members").delete().eq("email", m.email); if(error) setMsg('No se pudo quitar el acceso.'); load(); }}>Quitar</Button></div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Login() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    const { error, data } =
      mode === "in"
        ? await supabase.auth.signInWithPassword({ email, password: pass })
        : await supabase.auth.signUp({ email, password: pass, options: { emailRedirectTo: window.location.origin } });
    if (error) setMsg(error.message);
    else if (mode === "up" && !data.session) setMsg("Revisa tu correo para confirmar la cuenta.");
  };
  const google = async () => {
    const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
    if (r.error) setMsg(String(r.error.message ?? r.error));
  };
  return (
    <Center>
      <form onSubmit={submit}>
        <Card>
          <Logo />
          <p className="text-center text-sm text-muted-foreground">
            {mode === "in" ? "Entra con tu cuenta para ver la cartera en cualquier dispositivo" : "Crea tu cuenta"}
          </p>
          <input className="field" type="email" placeholder="Correo" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input className="field" type="password" placeholder="Contraseña" minLength={6} value={pass} onChange={(e) => setPass(e.target.value)} required />
          <button className="btn-brand">{mode === "in" ? "Entrar" : "Crear cuenta"}</button>
          <button type="button" onClick={google} className="btn-ghost">Continuar con Google</button>
          {msg && <p className="text-center text-sm text-destructive">{msg}</p>}
          <button type="button" onClick={() => setMode(mode === "in" ? "up" : "in")} className="w-full text-sm text-gold">
            {mode === "in" ? "¿No tienes cuenta? Crear una" : "Ya tengo cuenta"}
          </button>
        </Card>
      </form>
    </Center>
  );
}

function Logo() {
  return <img src="/gyc-logo.jpg" alt="GYC Capital — Crecamos juntos" className="mx-auto w-64 rounded-xl" />;
}
function Card({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-brand">{children}</div>;
}
function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-brand-hero p-4 text-muted-foreground">{children}</div>;
}
