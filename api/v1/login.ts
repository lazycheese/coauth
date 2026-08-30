import { signingSecret } from "../_sign";
import { CLINICIANS, clinicianPassphrase, issueSession, sessionCookie, sameOrigin, SESSION_TTL_MS } from "../_session";

export const config = { runtime: "edge" };

const H = { "API-Version": "1.0.0" };

/** Authenticate a clinician and start a session.
 *
 * This is the only route that produces the credential the signing service
 * requires. It is deliberately not exposed as a WebMCP tool: an agent driving
 * the page has no tool that authenticates, and cannot read the HttpOnly cookie
 * that results. */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json(
      { error: { code: "method_not_allowed", message: "Use POST.", hint: "POST { clinicianId, passphrase }." } },
      { status: 405, headers: H }
    );
  }
  if (!sameOrigin(req)) {
    return Response.json(
      { error: { code: "cross_origin", message: "Sign-in must come from this origin.", hint: "Use the CoAuth page." } },
      { status: 403, headers: H }
    );
  }

  const secret = signingSecret();
  const passphrase = clinicianPassphrase();
  if (!secret || !passphrase) {
    return Response.json(
      {
        error: {
          code: "auth_unavailable",
          message: "This deployment cannot authenticate clinicians.",
          hint: "Set COAUTH_SIGNING_SECRET and COAUTH_CLINICIAN_PASSPHRASE. Without both, no approval can be minted and nothing can be submitted.",
        },
      },
      { status: 503, headers: H }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: { code: "invalid_json", message: "Body must be JSON.", hint: "POST { clinicianId, passphrase }." } },
      { status: 400, headers: H }
    );
  }

  const clinician = CLINICIANS[String(body?.clinicianId ?? "")];
  const supplied = String(body?.passphrase ?? "");

  // One message for both failure modes, so this cannot be used to enumerate
  // which clinician ids exist.
  if (!clinician || supplied !== passphrase) {
    return Response.json(
      {
        error: {
          code: "invalid_credentials",
          message: "That clinician id and passphrase were not accepted.",
          hint: "Check the credentials shown on the sign-in panel.",
        },
      },
      { status: 401, headers: H }
    );
  }

  const token = await issueSession(secret, clinician);
  return Response.json(
    { status: "authenticated", clinician: { id: clinician.id, name: clinician.name, npi: clinician.npi, role: clinician.role } },
    { status: 200, headers: { ...H, "Set-Cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)) } }
  );
}
