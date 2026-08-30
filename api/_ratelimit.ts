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
    const incr = await res.json();
    if (!res.ok || incr?.error) return localHit(key, limit, windowMs);
    const count = Number(incr?.result ?? 0);
    if (count === 1) {
      // First hit in this window: give the counter the window's lifetime.
      const exp = await fetch(`${url}/expire/${encodeURIComponent(key)}/${seconds}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // A counter with no TTL would live in the store forever. Window-stamped
      // keys make that harmless for correctness but not for the key count, so
      // a failed EXPIRE is retried once rather than ignored.
      if (!exp.ok) {
        await fetch(`${url}/expire/${encodeURIComponent(key)}/${seconds}`, {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    }
    if (count > limit) return { allowed: false, retryAfter: seconds };
    return { allowed: true, retryAfter: 0 };
  } catch {
    // The store is configured but unreachable. Fall back to per-instance
    // counting rather than letting every attempt through.
    return localHit(key, limit, windowMs);
  }
}

/** Best available identifier for the caller.
 *
 * Order matters, and getting it wrong makes the limit decorative. A client can
 * send its own X-Forwarded-For, and the platform appends rather than replaces -
 * so reading the FIRST entry meant an attacker could rotate that header and
 * mint a fresh budget per request. The platform's own header comes first here,
 * and the fallback takes the LAST entry of X-Forwarded-For, which is the hop
 * closest to the edge and the only one the caller cannot choose.
 *
 * The global window exists because none of this is perfect: an attacker with
 * real addresses to spend still gets a budget per address. */
export function callerKey(req: Request): string {
  const platform = req.headers.get("x-vercel-forwarded-for") ?? req.headers.get("x-real-ip");
  if (platform) return platform.trim();
  const chain = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return chain.length ? chain[chain.length - 1] : "unidentified";
}

// Four per minute sustained, over a short window so an honest caller who does
// trip it is not locked out for long. Guessing a passphrase at this rate is
// hopeless; a person fumbling their credentials, or a verification run doing a
// handful of sign-ins, never reaches it.
const WINDOW_MS = 5 * 60 * 1000;
const PER_CALLER = 20;
const GLOBAL = 300;
// Signing is a legitimate, repeated clinical action, not a credential guess.
// This exists to bound a guessing attack against the step-up credential, not to
// ration real work.
const SIGN_PER_CALLER = 200;

/** Check and consume a login attempt. */
export async function rateLimitLogin(req: Request): Promise<RateVerdict> {
  const window = Math.floor(Date.now() / WINDOW_MS);
  // "ip:" namespaces the caller so no forwarded value can collide with the
  // global counter by being literally "all".
  const caller = await kvHit(`coauth:login:ip:${callerKey(req)}:${window}`, PER_CALLER, WINDOW_MS);
  if (!caller.allowed) return caller;
  return kvHit(`coauth:login:global:${window}`, GLOBAL, WINDOW_MS);
}

/** Check and consume a signing attempt.
 *
 * Signing takes the clinician's credential, so it is a place the credential can
 * be guessed at. Its own budget, separate from the login one, so exhausting
 * either does not lock the clinician out of the other. */
export async function rateLimitSign(req: Request): Promise<RateVerdict> {
  const window = Math.floor(Date.now() / WINDOW_MS);
  // Deliberately far more generous than the login budget, and with NO global
  // window. A clinic behind one NAT egress shares a source address, and a
  // signing limit tuned for credential guessing would be a clinical outage for
  // everyone behind it. A global cap would be worse still: it would let one
  // attacker stop every clinician on the deployment from signing.
  return kvHit(`coauth:sign:ip:${callerKey(req)}:${window}`, SIGN_PER_CALLER, WINDOW_MS);
}
