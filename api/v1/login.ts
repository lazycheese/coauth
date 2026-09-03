import { signingSecret } from "../_sign";
import { rateLimitLogin } from "../_ratelimit";
import {
  CLINICIANS,
  clinicianPassphrase,
  clinicianAuthConfigured,
  issueSession,
  sessionCookie,
  sameOrigin,
  constantTimeEqual,
  SESSION_TTL_MS,
} from "../_session";

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

  // Throttle before doing any work. A guessing attack against a clinician's
  // credential is the weakest hinge in the gate, so it is bounded here.
  const limit = await rateLimitLogin(req);
  if (!limit.allowed) {
    return Response.json(
      {
        error: {
          code: "too_many_attempts",
          message: "Too many sign-in attempts. Try again shortly.",
          hint: `Wait ${limit.retryAfter} second(s) before trying again.`,
        },
      },
      { status: 429, headers: { ...H, "Retry-After": String(limit.retryAfter) } }
    );
  }

  const secret = signingSecret();
  if (!secret || !clinicianAuthConfigured()) {
    return Response.json(
      {
        error: {
          code: "auth_unavailable",
          message: "This deployment cannot authenticate clinicians.",
          hint: "Set COAUTH_SIGNING_SECRET and COAUTH_CLINICIAN_PASSPHRASES (a JSON map of clinician id to passphrase). Without both, no approval can be minted and nothing can be submitted.",
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

  // Own-property lookup. A plain index walks the prototype chain, so
  // clinicianId "constructor" resolved to Object and minted a cookie whose
  // subject could never be read back.
  const id = String(body?.clinicianId ?? "");
  const clinician = Object.prototype.hasOwnProperty.call(CLINICIANS, id) ? CLINICIANS[id] : undefined;
  const supplied = String(body?.passphrase ?? "");

  // Each clinician has their own passphrase, so this resolves the one for the
  // id being claimed. Compared in constant time against a fixed-length stand-in
  // when the clinician or their passphrase is unknown, so neither the answer
  // nor how long it took distinguishes a wrong id from a wrong passphrase. One
  // message for both, so this cannot be used to enumerate clinician ids.
  const expected = clinician ? clinicianPassphrase(id) : null;
  const passphraseOk = constantTimeEqual(supplied, expected ?? "\u0000unmatchable-sentinel-value");
  if (!clinician || !expected || !passphraseOk) {
    return Response.json(
      {
        error: {
          code: "invalid_credentials",
          message: "That clinician id and passphrase were not accepted.",
          hint: "The demo clinician credentials are in the project README, deliberately not in the page.",
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
