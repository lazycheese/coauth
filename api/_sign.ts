// Server-side signing for the clinician approval gate.
//
// The point of the gate is that an agent cannot submit on a human's behalf.
// That needs two separate things, and an earlier version of this file had only
// the second:
//
//   1. Minting must require a credential an agent does not have. The signing
//      route demands an authenticated clinician session (see _session.ts) and
//      takes the signer's identity from that session, never from the request
//      body. Without it, minting was open to anyone who could make an HTTP
//      request, and the "signer" was whatever string the caller supplied.
//   2. The token must be unforgeable and bound to what was signed. The MAC is
//      computed here with a secret the browser never sees, over a canonical
//      serialization of the payer, the chart and the exact form.
//
// Together: an agent cannot obtain a token, and a token cannot be altered or
// moved to a different form after the fact.

const enc = new TextEncoder();

export function signingSecret(): string | null {
  const s = (globalThis as any).process?.env?.COAUTH_SIGNING_SECRET;
  return typeof s === "string" && s.length >= 16 ? s : null;
}

/** Stable serialization: key order must not change the signature. */
export function canonicalize(formFields: Record<string, unknown>): string {
  const keys = Object.keys(formFields ?? {}).sort();
  return JSON.stringify(keys.map((k) => [k, formFields[k] ?? null]));
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface ApprovalPayload {
  payer: string;
  /** Chart the submission was prepared from, so it cannot be moved to another. */
  patientId: string;
  attestation: string;
  /** Display name of the authenticated clinician. Never caller-supplied. */
  signer: string;
  /** Directory id of the authenticated clinician, from the session. */
  clinicianId: string;
  /** The clinician's NPI as held by the directory, not as typed. */
  npi: string;
  ts: number;
  digest: string;
  /** Unique id for this approval, covered by the MAC so it cannot be swapped. */
  jti: string;
}

/** Random id for a single approval. */
export function newJti(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Digest of the submission being attested to.
 *
 * Covers the chart as well as the payer and the form, so an approval given for
 * one patient cannot be presented for another whose form happens to match. */
export async function digestOf(
  secret: string,
  payer: string,
  patientId: string,
  formFields: Record<string, unknown>
): Promise<string> {
  return hmac(secret, `${payer}\n${patientId}\n${canonicalize(formFields)}`);
}

export async function mint(
  secret: string,
  payload: ApprovalPayload
): Promise<string> {
  return hmac(secret, JSON.stringify(payload));
}

/** Constant-time comparison so a verifier cannot be probed byte by byte. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const TOKEN_TTL_MS = 30 * 60 * 1000;
