import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "GYC Capital Pro — Sistema Integral" },
      { name: "description", content: "Sistema de créditos y cobros GYC Capital, sincronizado en la nube." },
      { property: "og:title", content: "GYC Capital Pro" },
      { property: "og:description", content: "Sistema de créditos y cobros GYC Capital, sincronizado en la nube." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

const KEYS = ["gyc_v10", "gyc_theme"];

function snapshot() {
  const o: Record<string, string | null> = {};
  KEYS.forEach((k) => (o[k] = localStorage.getItem(k)));
  return o;
}

function Index() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    return () => data.subscription.unsubscribe();
  }, []);
  if (session === undefined) return <Center>Cargando…</Center>;
  if (!session) return <Login />;
  return <Sistema userId={session.user.id} />;
}

function Sistema({ userId }: { userId: string }) {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Sincronizado");
  const last = useRef("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from("user_data").select("data").eq("user_id", userId).maybeSingle();
      const cloud = (data?.data ?? {}) as Record<string, string | null>;
      if (Object.keys(cloud).length) {
        KEYS.forEach((k) => (cloud[k] != null ? localStorage.setItem(k, cloud[k]!) : localStorage.removeItem(k)));
      } else {
        await supabase.from("user_data").upsert({ user_id: userId, data: snapshot() });
      }
      last.current = JSON.stringify(snapshot());
      if (alive) setReady(true);
    })();
    const iv = setInterval(async () => {
      const s = JSON.stringify(snapshot());
      if (s === last.current) return;
      last.current = s;
      setStatus("Guardando…");
      const { error } = await supabase
        .from("user_data")
        .upsert({ user_id: userId, data: JSON.parse(s), updated_at: new Date().toISOString() });
      setStatus(error ? "Sin conexión" : "Sincronizado");
      if (error) last.current = "";
    }, 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [userId]);

  if (!ready) return <Center>Descargando tus datos de la nube…</Center>;
  return (
    <div className="flex h-dvh flex-col bg-background">
      <iframe src="/sistema.html" title="GYC Capital" className="w-full flex-1 border-0" />
      <div className="flex items-center justify-between border-t border-border bg-card px-3 py-1 text-xs text-muted-foreground">
        <span>☁ {status}</span>
        <button
          className="font-semibold text-primary"
          onClick={async () => {
            KEYS.forEach((k) => localStorage.removeItem(k));
            await supabase.auth.signOut();
          }}
        >
          Cerrar sesión
        </button>
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
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-card p-6 shadow-sm">
        <img src="/icon-192.png" alt="" className="mx-auto h-16 w-16 rounded-2xl" />
        <h1 className="text-center text-xl font-bold text-foreground">GYC Capital Pro</h1>
        <p className="text-center text-sm text-muted-foreground">
          {mode === "in" ? "Entra para ver tus datos en cualquier dispositivo" : "Crea tu cuenta en la nube"}
        </p>
        <input className="w-full rounded-lg border border-input bg-background px-3 py-2" type="email" placeholder="Correo" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="w-full rounded-lg border border-input bg-background px-3 py-2" type="password" placeholder="Contraseña" minLength={6} value={pass} onChange={(e) => setPass(e.target.value)} required />
        <button className="w-full rounded-lg bg-primary py-2 font-semibold text-primary-foreground">
          {mode === "in" ? "Entrar" : "Crear cuenta"}
        </button>
        <button type="button" onClick={google} className="w-full rounded-lg border border-input py-2 font-semibold text-foreground">
          Continuar con Google
        </button>
        {msg && <p className="text-center text-sm text-destructive">{msg}</p>}
        <button type="button" onClick={() => setMode(mode === "in" ? "up" : "in")} className="w-full text-sm text-primary">
          {mode === "in" ? "¿No tienes cuenta? Crear una" : "Ya tengo cuenta"}
        </button>
      </form>
    </Center>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center bg-background p-4 text-muted-foreground">{children}</div>;
}
