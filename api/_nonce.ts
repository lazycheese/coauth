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

/** Per-instance fallback.
 *
 * Bounded, but only loosely: the sweep runs when the map passes 5000 entries
 * and removes only entries that have already expired, so a burst of live
 * approvals can sit above that mark until they age out. Entries are small and
 * expire with the token TTL, which is what keeps this finite. */
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
    // SET key value EX ttl NX - atomic, so two concurrent submits cannot both
    // win. The arguments are path segments, not query parameters: sent as
    // ?NX=true&EX=n the store answers "ERR syntax error", which the old code
    // read as "not OK, therefore already claimed" and used to reject every
    // submission on the deployment.
    const res = await fetch(
      `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(confirmationId)}/EX/${ttlSeconds}/NX`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = await res.json();

    // An error from the store is not an answer about this approval. Treating it
    // as one turns an outage into a blanket refusal; fall back to per-instance
    // memory and report the weaker protection, as when the store is absent.
    if (!res.ok || body?.error) return localClaim(jti, confirmationId, ttlMs);

    if (body?.result === "OK") return { fresh: true, protection: "durable" };

    // result null means the key already existed: this approval has been used.
    //
    // That verdict is already final. The GET below only fetches the earlier
    // confirmation id to show the caller, and a failure of it must not reach
    // the catch below - falling back to per-instance memory there would turn a
    // known replay into an accepted duplicate because a cosmetic lookup blipped.
    let existing: string | undefined;
    try {
      const prior = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const priorBody = await prior.json();
      existing = priorBody?.result ?? undefined;
    } catch {
      /* the id is a nicety; the refusal is not */
    }
    return { fresh: false, existing, protection: "durable" };
  } catch {
    // The store is configured but unreachable.
    //
    // This falls OPEN, not closed: the submission still proceeds, protected
    // only by this instance's memory. That is a deliberate availability
    // trade-off - refusing every submission because a cache is down would be
    // worse - but it is not a guarantee, and the response says so by reporting
    // "best-effort" rather than "durable".
    return localClaim(jti, confirmationId, ttlMs);
  }
}
