import { signingSecret, digestOf, mint, type ApprovalPayload } from "../_sign";

export const config = { runtime: "edge" };

/** Mint a clinician approval token over the exact submission being attested to.
 * Only a human review step in the UI should call this. */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json(
      { error: { code: "method_not_allowed", message: "Use POST.", hint: "POST { payer, formFields, attestation, signer }." } },
      { status: 405, headers: { "API-Version": "1.0.0" } }
    );
  }

  const secret = signingSecret();
  if (!secret) {
    return Response.json(
      {
        error: {
          code: "signing_unavailable",
          message: "No signing secret is configured on this deployment.",
          hint: "Set COAUTH_SIGNING_SECRET. Without it the approval gate cannot be enforced server-side.",
        },
      },
      { status: 503, headers: { "API-Version": "1.0.0" } }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: { code: "invalid_json", message: "Body must be JSON.", hint: "POST { payer, formFields, attestation, signer }." } },
      { status: 400, headers: { "API-Version": "1.0.0" } }
    );
  }

  const payer = String(body?.payer ?? "");
  const attestation = String(body?.attestation ?? "");
  const signer = String(body?.signer ?? "");
  const formFields = (body?.formFields ?? {}) as Record<string, unknown>;

  if (!payer || !attestation || !signer) {
    return Response.json(
      {
        error: {
          code: "incomplete_approval",
          message: "payer, attestation and signer are all required.",
          hint: "An attestation with no identifiable signer is not an approval.",
        },
      },
      { status: 400, headers: { "API-Version": "1.0.0" } }
    );
  }

  const payload: ApprovalPayload = {
    payer,
    attestation,
    signer,
    ts: Date.now(),
    digest: await digestOf(secret, payer, formFields),
  };
  const mac = await mint(secret, payload);

  return Response.json(
    { status: "signed", token: { ...payload, mac } },
    { status: 200, headers: { "API-Version": "1.0.0" } }
  );
}
