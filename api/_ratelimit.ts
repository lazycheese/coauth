// Rate limiting for the credential endpoint.
//
// One passphrase mints every clinician signature on this deployment, which
// makes /api/v1/login the single most valuable thing to guess at. Unthrottled,
// a guess costs a request; throttled, it costs a request and then a wait.
//
// Two windows, because they stop different things: a per-caller window stops
// one source grinding through candidates, and a global window stops the same
// grind spread across many source addresses. The global limit is deliberately
// generous enough that ordinary use never reaches it.
//
// Like the replay nonce, this uses a durable store when one is configured and
// per-instance memory when one is not. Per-instance memory is weaker - an
// attacker reaching a different edge instance gets a fresh budget - so the
// weakness is stated here rather than implied away.

const KV_URL = () => (globalThis as any).process?.env?.KV_REST_API_URL as string | undefined;
const KV_TOKEN = () => (globalThis as any).process?.env?.KV_REST_API_TOKEN as string | undefined;

export interface RateVerdict {
  allowed: boolean;
  /** Seconds the caller should wait before trying again. */
  retryAfter: number;
}

const local = new Map<string, { count: number; resetAt: number }>();

function localHit(key: string, limit: number, windowMs: number): RateVerdict {
  const now = Date.now();
  if (local.size > 5000) {
    for (const [k, v] of local) if (v.resetAt <= now) local.delete(k);
  }
  const hit = local.get(key);
  if (!hit || hit.resetAt <= now) {
    local.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }
  hit.count++;
  if (hit.count > limit) {
    return { allowed: false, retryAfter: Math.ceil((hit.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

async function kvHit(key: string, limit: number, windowMs: number): Promise<RateVerdict> {
  const url = KV_URL();
  const token = KV_TOKEN();
  if (!url || !token) return localHit(key, limit, windowMs);
  const seconds = Math.ceil(windowMs / 1000);
  try {
    const res = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const count = Number((await res.json())?.result ?? 0);
    if (count === 1) {
      // First hit in this window: give the counter the window's lifetime.
      await fetch(`${url}/expire/${encodeURIComponent(key)}/${seconds}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    if (count > limit) return { allowed: false, retryAfter: seconds };
    return { allowed: true, retryAfter: 0 };
  } catch {
    // The store is configured but unreachable. Fall back to per-instance
    // counting rather than letting every attempt through.
    return localHit(key, limit, windowMs);
  }
}

/** Best available identifier for the caller. Spoofable, which is why the
 *  global window exists alongside the per-caller one. */
export function callerKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return (fwd.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();
}

const WINDOW_MS = 15 * 60 * 1000;
// Two per minute sustained. Tight enough that guessing a passphrase is
// hopeless, loose enough that a person fumbling their credentials, or a
// verification run exercising several sign-ins, is never caught by it.
const PER_CALLER = 30;
const GLOBAL = 200;

/** Check and consume a login attempt. */
export async function rateLimitLogin(req: Request): Promise<RateVerdict> {
  const window = Math.floor(Date.now() / WINDOW_MS);
  const caller = await kvHit(`coauth:login:${callerKey(req)}:${window}`, PER_CALLER, WINDOW_MS);
  if (!caller.allowed) return caller;
  return kvHit(`coauth:login:all:${window}`, GLOBAL, WINDOW_MS);
}
