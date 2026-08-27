import { signingSecret, digestOf, mint, timingSafeEqual, TOKEN_TTL_MS, type ApprovalPayload } from "../_sign";
import { claimOnce } from "../_nonce";

export const config = { runtime: "edge" };

const H = { "API-Version": "1.0.0" };

function reject(code: string, message: string, hint: string, status = 403) {
  return Response.json({ status: "rejected", error: { code, message, hint } }, { status, headers: H });
}

/** Accept a submission only when it carries a valid clinician approval token
 * that was minted for this exact form. This is where the gate is enforced:
 * the check does not depend on anything the caller can set. */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return reject("method_not_allowed", "Use POST.", "POST { payer, formFields, token }.", 405);
  }

  const secret = signingSecret();
  if (!secret) {
    return Response.json(
      {
        status: "rejected",
        error: {
          code: "signing_unavailable",
          message: "No signing secret is configured on this deployment.",
          hint: "Set COAUTH_SIGNING_SECRET to enforce the approval gate.",
        },
      },
      { status: 503, headers: H }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return reject("invalid_json", "Body must be JSON.", "POST { payer, formFields, token }.", 400);
  }

  const payer = String(body?.payer ?? "");
  const formFields = (body?.formFields ?? {}) as Record<string, unknown>;
  const token = body?.token;

  if (!token || typeof token !== "object" || typeof token.mac !== "string") {
    return reject(
      "approval_required",
      "This submission carries no clinician approval token.",
      "A clinician must review and sign before the submission is accepted."
    );
  }

  const payload: ApprovalPayload = {
    payer: String(token.payer ?? ""),
    attestation: String(token.attestation ?? ""),
    signer: String(token.signer ?? ""),
    ts: Number(token.ts ?? 0),
    digest: String(token.digest ?? ""),
    jti: String(token.jti ?? ""),
  };

  // 1. The token must be one we issued.
  const expected = await mint(secret, payload);
  if (!timingSafeEqual(expected, String(token.mac))) {
    return reject(
      "invalid_signature",
      "The approval token is not valid for this deployment.",
      "Tokens are minted server-side; a fabricated token cannot be accepted."
    );
  }

  // 2. It must not be stale.
  if (!payload.ts || Date.now() - payload.ts > TOKEN_TTL_MS) {
    return reject("approval_expired", "The clinician approval has expired.", "Re-review and sign the submission.");
  }

  // 3. It must have been signed for this payer and this exact form. A field
  //    changed after signing invalidates the approval.
  if (payload.payer !== payer) {
    return reject("payer_mismatch", "The approval was signed for a different payer.", "Re-sign for the current payer.");
  }
  const digest = await digestOf(secret, payer, formFields);
  if (!timingSafeEqual(digest, payload.digest)) {
    return reject(
      "form_modified",
      "The submission changed after it was signed.",
      "The clinician must review and sign the current version."
    );
  }

  const confirmationId = "PA-" + payload.digest.slice(0, 8).toUpperCase();

  // 4. An approval is good for one submission. Claiming it is atomic where a
  //    durable store is configured, so a replay cannot file a second time.
  const claim = await claimOnce(payload.jti, confirmationId, TOKEN_TTL_MS);
  if (!claim.fresh) {
    return Response.json(
      {
        status: "rejected",
        error: {
          code: "approval_already_used",
          message: "This clinician approval has already been submitted.",
          hint: "Each approval is valid for a single submission. Re-sign to submit again.",
        },
        confirmationId: claim.existing,
        replayProtection: claim.protection,
      },
      { status: 409, headers: H }
    );
  }

  return Response.json(
    {
      status: "submitted",
      confirmationId,
      replayProtection: claim.protection,
      audit: {
        signer: payload.signer,
        attestation: payload.attestation,
        signedAt: new Date(payload.ts).toISOString(),
        digest: payload.digest,
        approvalId: payload.jti,
        verifiedBy: "server",
      },
    },
    { status: 200, headers: H }
  );
}
