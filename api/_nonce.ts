// Single-use enforcement for clinician approvals.
//
// A signed token proves who approved what. It does not, on its own, stop the
// same approval being submitted twice. That needs a record of what has already
// been used, which means durable state.
//
// When a KV store is configured, a claim is atomic (SET NX) and replay is
// impossible. When one is not, we fall back to per-instance memory, which only
// catches replays that reach the same edge instance. The difference is reported
// in the submit response rather than papered over, because a guarantee we
// cannot make should not be presented as one.

export type ReplayProtection = "durable" | "best-effort";

export interface ClaimResult {
  /** False when this approval had already been used. */
  fresh: boolean;
  /** The confirmation issued the first time it was used. */
  existing?: string;
  protection: ReplayProtection;
}

const KV_URL = () => (globalThis as any).process?.env?.KV_REST_API_URL as string | undefined;
const KV_TOKEN = () => (globalThis as any).process?.env?.KV_REST_API_TOKEN as string | undefined;

export function replayProtection(): ReplayProtection {
  return KV_URL() && KV_TOKEN() ? "durable" : "best-effort";
}

/** Per-instance fallback. Bounded so a long-lived instance cannot grow forever. */
const local = new Map<string, { value: string; expires: number }>();

function localClaim(key: string, value: string, ttlMs: number): ClaimResult {
  const now = Date.now();
  if (local.size > 5000) {
    for (const [k, v] of local) if (v.expires <= now) local.delete(k);
  }
  const hit = local.get(key);
  if (hit && hit.expires > now) return { fresh: false, existing: hit.value, protection: "best-effort" };
  local.set(key, { value, expires: now + ttlMs });
  return { fresh: true, protection: "best-effort" };
}

/** Claim an approval id exactly once. */
export async function claimOnce(jti: string, confirmationId: string, ttlMs: number): Promise<ClaimResult> {
  const url = KV_URL();
  const token = KV_TOKEN();
  if (!url || !token) return localClaim(jti, confirmationId, ttlMs);

  const key = `coauth:approval:${jti}`;
  const ttlSeconds = Math.ceil(ttlMs / 1000);
  try {
    // SET key value NX EX ttl - atomic, so two concurrent submits cannot both win.
    const res = await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(confirmationId)}?NX=true&EX=${ttlSeconds}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    if (body?.result === "OK") return { fresh: true, protection: "durable" };

    const prior = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const priorBody = await prior.json();
    return { fresh: false, existing: priorBody?.result ?? undefined, protection: "durable" };
  } catch {
    // The store is configured but unreachable. Fail closed on the guarantee:
    // fall back to per-instance memory and report the weaker protection.
    return localClaim(jti, confirmationId, ttlMs);
  }
}
