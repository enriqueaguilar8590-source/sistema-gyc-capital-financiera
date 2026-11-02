// CORS + security headers for the server entry (src/server.ts).
// Pure functions over standard Request/Response so they can be unit-tested.

export const PRODUCTION_ORIGIN = "https://one-system-anywhere.lovable.app";
// Cross-origin callers allowed in addition to the app's own origin (same-origin always works).
export const DEFAULT_ALLOWED_ORIGINS = [PRODUCTION_ORIGIN, "http://localhost:3000", "http://localhost:3009"];
// Only what the app uses: page loads (GET/HEAD), server functions (POST) and CORS preflight.
export const ALLOWED_METHODS = ["GET", "HEAD", "POST", "OPTIONS"];
const ALLOWED_HEADERS = ["Content-Type", "Authorization", "X-TSR-ServerFn"];

type Env = Record<string, string | undefined>;
const readEnv = (): Env => (typeof process !== "undefined" && process.env ? (process.env as Env) : {});

export function allowedOrigins(env: Env = readEnv()): string[] {
  const extra = (env["ALLOWED_ORIGINS"] ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}

const first = (value: string | null) => (value ?? "").split(",")[0]!.trim();

// Origins that count as "this same app": the URL the worker sees plus the public host behind a proxy.
export function ownOrigins(request: Request): Set<string> {
  const url = new URL(request.url);
  const out = new Set([url.origin]);
  const host = first(request.headers.get("x-forwarded-host")) || first(request.headers.get("host"));
  const proto = first(request.headers.get("x-forwarded-proto")) || url.protocol.replace(":", "");
  if (host) out.add(`${proto}://${host}`);
  return out;
}

export type OriginCheck = "none" | "same" | "allowed" | "blocked";
export function checkOrigin(request: Request, env: Env = readEnv()): OriginCheck {
  const origin = request.headers.get("origin");
  if (!origin) return "none";
  if (ownOrigins(request).has(origin)) return "same";
  return allowedOrigins(env).includes(origin) ? "allowed" : "blocked";
}

const corsHeaders = (origin: string): Record<string, string> => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
  "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", "),
  "Access-Control-Max-Age": "600",
  Vary: "Origin",
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// Runs before the app. Returns a Response when the request must not reach the app, otherwise null.
// Set CORS_ENFORCE=false to log-only (emergency switch if a legitimate caller is ever blocked).
export function guardRequest(request: Request, env: Env = readEnv()): Response | null {
  const enforce = env["CORS_ENFORCE"] !== "false";
  if (!ALLOWED_METHODS.includes(request.method.toUpperCase())) {
    return json(405, { error: "method not allowed" }, { Allow: ALLOWED_METHODS.join(", ") });
  }
  const check = checkOrigin(request, env);
  if (check === "blocked" && enforce) return json(403, { error: "origin not allowed" }, { Vary: "Origin" });
  if (request.method.toUpperCase() === "OPTIONS") {
    const origin = request.headers.get("origin");
    if (check === "allowed" && origin) return new Response(null, { status: 204, headers: corsHeaders(origin) });
    return new Response(null, { status: 204, headers: { Allow: ALLOWED_METHODS.join(", "), Vary: "Origin" } });
  }
  return null;
}

const LOVABLE_EDITORS = "https://lovable.dev https://*.lovable.dev https://gptengineer.app https://*.gptengineer.app";
const PREVIEW_ZONES = ["lovableproject.com", "lovableproject-dev.com", "gpt-eng.com", "gptengineer.run"];
export const isLocalHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";
export const isPreviewHost = (host: string) =>
  host.startsWith("id-preview") || PREVIEW_ZONES.some((z) => host === z || host.endsWith("." + z));

// The page is a React shell that embeds /sistema.html in a same-origin iframe, so framing is 'self'.
// Only editor previews may also be framed by the Lovable editor; the published site never is.
export function buildCsp(host: string, https: boolean): string {
  const local = isLocalHost(host);
  const connect = ["'self'", "https://*.lovable.cloud", "https://*.supabase.co", "wss://*.lovable.cloud", "wss://*.supabase.co", "https://*.lovable.app", "https://*.lovable.dev"];
  if (local) connect.push("http://localhost:*", "ws://localhost:*");
  const framing = isPreviewHost(host) || local ? `'self' ${LOVABLE_EDITORS} http://localhost:3000` : "'self'";
  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net" + (local ? " 'unsafe-eval'" : ""),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    `connect-src ${connect.join(" ")}`,
    "frame-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `frame-ancestors ${framing}`,
  ];
  if (https && !local) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()";

export function securityHeaders(request: Request): Record<string, string> {
  const url = new URL(request.url);
  const host = (first(request.headers.get("x-forwarded-host")) || first(request.headers.get("host")) || url.host).replace(/:\d+$/, "");
  const https = (first(request.headers.get("x-forwarded-proto")) || url.protocol.replace(":", "")) === "https";
  const out: Record<string, string> = {
    "Content-Security-Policy": buildCsp(host, https),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
  };
  // X-Frame-Options cannot allow the Lovable editor, so it is only sent where no editor preview is expected.
  if (!isPreviewHost(host) && !isLocalHost(host)) out["X-Frame-Options"] = "SAMEORIGIN";
  if (https && !isLocalHost(host)) out["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return out;
}

// Adds security headers (and CORS headers for an allowed cross-origin caller) to the app's response.
export function secureResponse(request: Request, response: Response, env: Env = readEnv()): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(securityHeaders(request))) headers.set(k, v);
  const origin = request.headers.get("origin");
  if (origin) {
    headers.append("Vary", "Origin");
    if (checkOrigin(request, env) === "allowed") headers.set("Access-Control-Allow-Origin", origin);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
