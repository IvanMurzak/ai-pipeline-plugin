// Daemon-wide host binding + token auth — applied by server.ts's fetch
// handler to EVERY request (static bundle, SSE, all /api/* routes).
//
// The daemon binds 127.0.0.1 by default. PIPELINE_UI_HOST widens the bind
// (phone access) but then PIPELINE_UI_TOKEN is MANDATORY — the UI can launch
// runs and edit pipeline files, so a non-loopback bind without a token falls
// back to loopback with a loud warning. With a token configured every request
// must carry it (Authorization: Bearer, ?token=, or the cookie the first
// tokened page-load pins).

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface HostConfig {
  host: string;
  token: string | null;
  /** Set when a non-loopback host was requested without a token — the config
   *  fell back to loopback and the caller should log this loudly. */
  warning: string | null;
}

export function resolveHostConfig(env: Record<string, string | undefined>): HostConfig {
  const requested = (env.PIPELINE_UI_HOST ?? "").trim() || "127.0.0.1";
  const token = (env.PIPELINE_UI_TOKEN ?? "").trim() || null;
  if (!LOOPBACK.has(requested) && !token) {
    return {
      host: "127.0.0.1",
      token: null,
      warning: `PIPELINE_UI_HOST=${requested} requires PIPELINE_UI_TOKEN (the UI can launch runs and edit pipelines) — falling back to 127.0.0.1`,
    };
  }
  return { host: requested, token, warning: null };
}

const TOKEN_COOKIE = "pipeline_ui_token";

/** null = authorized (or no token configured); otherwise the 401 response. */
export function checkAuth(req: Request, url: URL, token: string | null): Response | null {
  if (!token) return null;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${token}`) return null;
  if (url.searchParams.get("token") === token) return null;
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === TOKEN_COOKIE && rest.join("=") === token) return null;
  }
  return new Response("unauthorized (append ?token=<PIPELINE_UI_TOKEN> once — a cookie keeps you signed in)", {
    status: 401,
  });
}

/** After a valid ?token= request, pin the session with a cookie so asset and
 *  SSE requests (which can't carry the query) pass checkAuth. */
export function maybeSetTokenCookie(res: Response, url: URL, token: string | null): Response {
  if (!token || url.searchParams.get("token") !== token) return res;
  try {
    res.headers.append("Set-Cookie", `${TOKEN_COOKIE}=${token}; Path=/; SameSite=Lax`);
    return res;
  } catch {
    // Immutable headers (rare) — clone.
    const clone = new Response(res.body, res);
    clone.headers.append("Set-Cookie", `${TOKEN_COOKIE}=${token}; Path=/; SameSite=Lax`);
    return clone;
  }
}
