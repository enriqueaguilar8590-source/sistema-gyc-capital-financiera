import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { merge3 } from "@/lib/merge";

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
  return <Sistema role={role} />;
}

function Sistema({ role }: { role: string }) {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Sincronizado");
  const [team, setTeam] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const base = useRef<Obj | null>(null);
  const version = useRef(0);
  const busy = useRef(false);

  const sync = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
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
        const { data: v } = await supabase.rpc("save_workspace", { new_data: merged as never, expected_version: ws.version });
        if (v == null) { busy.current = false; return sync(); } // otro dispositivo guardó primero
        version.current = v as number;
      } else version.current = ws.version;
      base.current = merged;
      setStatus("Sincronizado");
    } catch {
      setStatus("Sin conexión — se guardará al volver");
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    (async () => {
      const { data: ws } = await supabase.from("workspace").select("data, version").eq("id", 1).single();
      if (ws?.data) localStorage.setItem(KEY, JSON.stringify(ws.data));
      else localStorage.removeItem(KEY);
      base.current = (ws?.data as Obj) ?? null;
      version.current = ws?.version ?? 0;
      setReady(true);
    })();
    const onMsg = (e: MessageEvent) => e.data === "gyc-save" && setTimeout(sync, 300);
    window.addEventListener("message", onMsg);
    const iv = setInterval(sync, 5000);
    return () => {
      clearInterval(iv);
      window.removeEventListener("message", onMsg);
    };
  }, [sync]);

  if (!ready) return <Center><Logo /><p>Descargando datos de la nube…</p></Center>;
  return (
    <div className="flex h-dvh flex-col bg-background">
      <iframe ref={frame} src="/sistema.html" title="GYC Capital" className="w-full flex-1 border-0" />
      <div className="flex items-center justify-between gap-3 border-t border-border bg-brand-deep px-3 py-1.5 text-xs text-brand-deep-foreground">
        <span>☁ {status}</span>
        <div className="flex gap-4">
          {role === "owner" && <button className="font-semibold text-gold" onClick={() => setTeam(true)}>Equipo</button>}
          <button className="font-semibold" onClick={async () => { await sync(); localStorage.removeItem(KEY); await supabase.auth.signOut(); }}>
            Cerrar sesión
          </button>
        </div>
      </div>
      {team && <Team onClose={() => setTeam(false)} />}
    </div>
  );
}

function Team({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<{ email: string; role: string }[]>([]);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const load = () => supabase.from("team_members").select("email, role").order("added_at").then(({ data }) => setList(data ?? []));
  useEffect(() => { load(); }, []);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.from("team_members").insert({ email: email.trim().toLowerCase(), role: "cobrador" });
    setMsg(error ? "No se pudo agregar (¿ya existe?)" : "Agregado. Ya puede crear su cuenta con ese correo.");
    if (!error) { setEmail(""); load(); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-overlay p-3 sm:items-center">
      <div className="w-full max-w-md space-y-3 rounded-2xl bg-card p-5 text-card-foreground shadow-brand">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Equipo de cobradores</h2>
          <button onClick={onClose} className="text-2xl leading-none text-muted-foreground">×</button>
        </div>
        <p className="text-xs text-muted-foreground">Agrega el correo de cada cobrador. Al entrar con ese correo verá la misma cartera. Dentro del sistema sigue usando su usuario y clave de cobrador.</p>
        <form onSubmit={add} className="flex gap-2">
          <input className="field flex-1" type="email" required placeholder="correo@cobrador.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn-brand w-auto px-4">Agregar</button>
        </form>
        {msg && <p className="text-xs text-primary">{msg}</p>}
        <ul className="divide-y divide-border">
          {list.map((m) => (
            <li key={m.email} className="flex items-center justify-between py-2 text-sm">
              <span className="truncate">{m.email} <span className="text-xs text-muted-foreground">({m.role === "owner" ? "dueño" : "cobrador"})</span></span>
              {m.role !== "owner" && (
                <button className="text-xs font-semibold text-destructive" onClick={async () => { await supabase.from("team_members").delete().eq("email", m.email); load(); }}>Quitar</button>
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
