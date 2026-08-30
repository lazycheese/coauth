import { signingSecret, digestOf, mint, newJti, type ApprovalPayload } from "../_sign";
import { readSession, sameOrigin, clinicianPassphrase, constantTimeEqual } from "../_session";
import { rateLimitSign } from "../_ratelimit";
import { clinicalRefusal } from "../_clinical";

export const config = { runtime: "edge" };

const H = { "API-Version": "1.0.0", "Cache-Control": "no-store" };

function err(status: number, code: string, message: string, hint: string, detail?: unknown) {
  return Response.json({ error: { code, message, hint, ...(detail ? { detail } : {}) } }, { status, headers: H });
}

/** Mint a clinician approval token over the exact submission being attested to.
 *
 * Four things must hold, and each is checked here rather than in the page:
 *   - the caller holds an authenticated clinician session;
 *   - the caller can produce the clinician's credential again, now;
 *   - the submission passes the same clinical rules the page runs;
 *   - the identity recorded in the token comes from the session.
 *
 * The second one is here because the first is not enough on its own. A session
 * lives in a cookie, and a cookie is attached to every same-origin request the
 * page makes - including one made by a script. So while a clinician was signed
 * in, any JavaScript running in the tab could call this endpoint directly and
 * mint a valid, correctly-attributed approval under their NPI, without a click
 * and without touching the form. Guarding the button was no defence, because
 * nothing made the button the only route.
 *
 * Requiring the credential per signature makes the session insufficient: a
 * signature needs something the clinician knows and supplies at the moment of
 * signing, which a script sitting in the page does not have.
 *
 * This does not make a hostile script in the page harmless - one that can watch
 * the field can watch the credential being typed. It moves the attack from
 * "mint silently, at will" to "wait for a human to sign and race them", which
 * is a materially different thing and the same trade-off any step-up
 * re-authentication makes. */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return err(405, "method_not_allowed", "Use POST.", "POST { payer, patientId, formFields, attestation }.");
  }
  if (!sameOrigin(req)) {
    return err(403, "cross_origin", "Approvals are minted for this origin only.", "Sign from the CoAuth page.");
  }

  const secret = signingSecret();
  if (!secret) {
    return err(
      503,
      "signing_unavailable",
      "No signing secret is configured on this deployment.",
      "Set COAUTH_SIGNING_SECRET. Without it the approval gate cannot be enforced, so nothing is signed and nothing can be submitted."
    );
  }

  // The gate. An agent driving the page has no tool that authenticates and
  // cannot read the HttpOnly session cookie, so it cannot reach this point.
  const session = await readSession(req);
  if (!session) {
    return err(
      401,
      "authentication_required",
      "Only an authenticated clinician can sign a prior authorization.",
      "POST /api/v1/login with a clinician id and passphrase first. An agent cannot obtain this session."
    );
  }

  // Throttled like the credential endpoint, because this now takes a credential.
  const limit = await rateLimitSign(req);
  if (!limit.allowed) {
    return err(
      429,
      "too_many_attempts",
      "Too many signing attempts. Try again shortly.",
      `Wait ${limit.retryAfter} second(s) before trying again.`
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid_json", "Body must be JSON.", "POST { payer, patientId, formFields, attestation }.");
  }

  const payer = String(body?.payer ?? "");
  const patientId = String(body?.patientId ?? "");
  const attestation = String(body?.attestation ?? "");
  const formFields = (body?.formFields ?? {}) as Record<string, unknown>;
  const overrides = (body?.overrides ?? {}) as Record<string, string>;

  // Step-up: the session says who is here, the credential says they are the one
  // asking for this signature.
  const expected = clinicianPassphrase();
  if (!expected || !constantTimeEqual(String(body?.passphrase ?? ""), expected)) {
    return err(
      403,
      "reauthentication_required",
      "Signing requires the clinician's credential, not just an active session.",
      "The clinician re-enters their passphrase to sign. A session cookie alone is not enough, because any script in the page carries it."
    );
  }

  if (!payer || !patientId || !attestation) {
    return err(
      400,
      "incomplete_approval",
      "payer, patientId and attestation are all required.",
      "An attestation with no chart behind it is not an approval."
    );
  }

  // The same rules the page ran, run again here. A submission that cannot be
  // submitted should not be signable either: refusing at mint time means the
  // clinician is never asked to attest to something the server will reject.
  const refusal = clinicalRefusal(payer, patientId, formFields, overrides);
  if (refusal) {
    return err(422, refusal.code, refusal.message, refusal.hint, refusal.detail);
  }

  const payload: ApprovalPayload = {
    payer,
    patientId,
    attestation,
    signer: session.name,
    clinicianId: session.sub,
    npi: session.npi,
    ts: Date.now(),
    digest: await digestOf(secret, payer, patientId, formFields, overrides),
    jti: newJti(),
  };
  const mac = await mint(secret, payload);

  return Response.json({ status: "signed", token: { ...payload, mac } }, { status: 200, headers: H });
}
