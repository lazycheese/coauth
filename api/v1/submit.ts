import { signingSecret, digestOf, mint, timingSafeEqual, TOKEN_TTL_MS, type ApprovalPayload } from "../_sign";
import { claimOnce } from "../_nonce";
import { clinicalRefusal } from "../_clinical";

export const config = { runtime: "edge" };

const H = { "API-Version": "1.0.0", "Cache-Control": "no-store" };

function reject(code: string, message: string, hint: string, status = 403, detail?: unknown) {
  return Response.json(
    { status: "rejected", error: { code, message, hint, ...(detail ? { detail } : {}) } },
    { status, headers: H }
  );
}

/** Accept a submission only when it carries a valid clinician approval token
 * that was minted for this exact form, and only when the submission still
 * passes the clinical rules.
 *
 * Neither check depends on anything the caller controls. The token cannot be
 * forged without the signing secret and cannot be obtained without an
 * authenticated clinician session; the clinical rules are re-run here from the
 * same module the page uses, so skipping the page skips nothing. */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return reject("method_not_allowed", "Use POST.", "POST { payer, patientId, formFields, token }.", 405);
  }

  const secret = signingSecret();
  if (!secret) {
    return Response.json(
      {
        status: "rejected",
        error: {
          code: "signing_unavailable",
          message: "No signing secret is configured on this deployment.",
          hint: "Set COAUTH_SIGNING_SECRET to enforce the approval gate. Until it is set, nothing can be submitted.",
        },
      },
      { status: 503, headers: H }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return reject("invalid_json", "Body must be JSON.", "POST { payer, patientId, formFields, token }.", 400);
  }

  const payer = String(body?.payer ?? "");
  const patientId = String(body?.patientId ?? "");
  const formFields = (body?.formFields ?? {}) as Record<string, unknown>;
  const overrides = (body?.overrides ?? {}) as Record<string, string>;
  const token = body?.token;

  if (!token || typeof token !== "object" || typeof token.mac !== "string") {
    return reject(
      "approval_required",
      "This submission carries no clinician approval token.",
      "An authenticated clinician must review and sign before the submission is accepted."
    );
  }

  const payload: ApprovalPayload = {
    payer: String(token.payer ?? ""),
    patientId: String(token.patientId ?? ""),
    attestation: String(token.attestation ?? ""),
    signer: String(token.signer ?? ""),
    clinicianId: String(token.clinicianId ?? ""),
    npi: String(token.npi ?? ""),
    ts: Number(token.ts ?? 0),
    digest: String(token.digest ?? ""),
    jti: String(token.jti ?? ""),
  };

  // 1. The token must be one we issued. Every field above is covered by the
  //    MAC, so an altered signer, clinician id or chart fails here.
  const expected = await mint(secret, payload);
  if (!timingSafeEqual(expected, String(token.mac))) {
    return reject(
      "invalid_signature",
      "The approval token is not valid for this deployment.",
      "Tokens are minted server-side for an authenticated clinician; a fabricated token cannot be accepted."
    );
  }

  // 2. It must not be stale.
  if (!payload.ts || Date.now() - payload.ts > TOKEN_TTL_MS) {
    return reject("approval_expired", "The clinician approval has expired.", "Re-review and sign the submission.");
  }

  // 3. It must have been signed for this payer, this chart and this exact form.
  if (payload.payer !== payer) {
    return reject("payer_mismatch", "The approval was signed for a different payer.", "Re-sign for the current payer.");
  }
  if (payload.patientId !== patientId) {
    return reject("patient_mismatch", "The approval was signed for a different patient.", "Re-sign for the current chart.");
  }
  const digest = await digestOf(secret, payer, patientId, formFields, overrides);
  if (!timingSafeEqual(digest, payload.digest)) {
    return reject(
      "form_modified",
      "The submission changed after it was signed.",
      "The clinician must review and sign the current version. This covers the clinical overrides as well as the form fields: an override is part of what was attested to."
    );
  }

  // 4. The clinical rules, independently of the page. A valid signature over an
  //    unsafe submission is still an unsafe submission.
  const refusal = clinicalRefusal(payer, patientId, formFields, overrides);
  if (refusal) {
    return reject(refusal.code, refusal.message, refusal.hint, 422, refusal.detail);
  }

  // Derived from the approval, not the form: two clinicians signing identical
  // forms get distinct confirmations, and no part of the digest is published.
  const confirmationId = "PA-" + payload.jti.slice(0, 8).toUpperCase();

  // 5. An approval is good for one submission. Claiming it is atomic where a
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
        clinicianId: payload.clinicianId,
        npi: payload.npi,
        patientId: payload.patientId,
        attestation: payload.attestation,
        // The rationale the clinician gave for each override they recorded.
        // Filing a biologic over a positive TB screen is a clinical decision,
        // and the decision is not auditable if only its effect is stored.
        overrides,
        signedAt: new Date(payload.ts).toISOString(),
        digest: payload.digest,
        approvalId: payload.jti,
        verifiedBy: "server",
      },
    },
    { status: 200, headers: H }
  );
}
