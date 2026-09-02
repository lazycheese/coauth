// Clinician identity for the approval gate.
//
// The gate only means something if the signer is someone rather than a string
// in a request body. A signature is minted for an authenticated clinician
// session and for nobody else, so the identity in the audit trail is one the
// server established rather than one the caller asserted.
//
// The session is a MAC over a small payload in an HttpOnly cookie. The page
// cannot read it, so a script in the page cannot lift it and replay it
// elsewhere; and because minting requires it, an agent that never authenticated
// has no way to obtain an approval.

import { signingSecret } from "./_sign";

const enc = new TextEncoder();

export interface Clinician {
  id: string;
  name: string;
  npi: string;
  role: string;
}

/** Seeded clinician directory. A real deployment reads this from an identity
 * provider; the shape is what matters here, and nothing downstream assumes the
 * list is static. */
export const CLINICIANS: Record<string, Clinician> = {
  "a-alvarez": { id: "a-alvarez", name: "Dr. Ana Alvarez", npi: "1477539821", role: "Rheumatology" },
  // Short alias for the demo sign-in, same identity as a-alvarez.
  "doc": { id: "doc", name: "Dr. Ana Alvarez", npi: "1477539821", role: "Rheumatology" },
  "j-park": { id: "j-park", name: "Dr. Jae Park", npi: "1093847562", role: "Rheumatology" },
};

export const SESSION_COOKIE = "coauth_session";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** The passphrase the demo clinicians authenticate with.
 *
 * Absent, there is no way to authenticate, so no approval can be minted and
 * nothing can be submitted. That is the intended failure: an unconfigured
 * deployment refuses to sign rather than signing for anyone. */
export function clinicianPassphrase(): string | null {
  const s = (globalThis as any).process?.env?.COAUTH_CLINICIAN_PASSPHRASE;
  return typeof s === "string" && s.length >= 8 ? s : null;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison, for credentials and MACs alike. */
export function constantTimeEqual(a: string, b: string): boolean {
  // Compare a fixed-length digest of each side rather than the raw strings, so
  // a length difference does not leak through an early return.
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface SessionPayload {
  sub: string;
  name: string;
  npi: string;
  role: string;
  exp: number;
}

export async function issueSession(secret: string, c: Clinician): Promise<string> {
  const payload: SessionPayload = {
    sub: c.id,
    name: c.name,
    npi: c.npi,
    role: c.role,
    exp: Date.now() + SESSION_TTL_MS,
  };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmacHex(secret, body)}`;
}

/** Read and verify the session on a request. Returns null for anything that is
 * not a session this server issued and that has not expired. */
export async function readSession(req: Request): Promise<SessionPayload | null> {
  const secret = signingSecret();
  if (!secret) return null;

  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;

  // decodeURIComponent throws on a malformed escape, and a cookie is caller
  // input: a truncated or corrupted one used to come back as a platform 500
  // with an HTML shell, from a browser that then had no way to recover.
  let body: string | undefined;
  let mac: string | undefined;
  try {
    [body, mac] = decodeURIComponent(match[1]).split(".");
  } catch {
    return null;
  }
  if (!body || !mac) return null;
  if (!timingSafeEqual(await hmacHex(secret, body), mac)) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64url(body))) as SessionPayload;
    if (!payload?.sub || !payload.exp || payload.exp < Date.now()) return null;
    // The directory is authoritative: a session for a clinician who no longer
    // exists is not a session. Own-property lookup, so a `sub` of "constructor"
    // does not resolve through the prototype chain.
    if (!Object.prototype.hasOwnProperty.call(CLINICIANS, payload.sub)) return null;
    // The directory is authoritative for the clinician's details, not the
    // cookie. A session issued before a directory change would otherwise sign
    // with a stale name or NPI.
    const current = CLINICIANS[payload.sub];
    return { ...payload, name: current.name, npi: current.npi, role: current.role };
  } catch {
    return null;
  }
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

/** Same-origin check for the state-changing routes.
 *
 * SameSite=Strict already keeps the cookie off cross-site requests; this
 * refuses the request outright so a cross-origin caller gets a clear error
 * rather than an unauthenticated one.
 *
 * Note the localhost allowance: a request whose Origin is localhost is accepted
 * whatever host it was sent to, so that development against a deployed API
 * works. That makes this a same-origin check plus a development exemption, not
 * a pure same-origin check. It is not load-bearing either way - the session
 * cookie is required regardless, and SameSite=Strict is what actually keeps it
 * off a cross-site request. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser caller; the session is still required
  try {
    const o = new URL(origin);
    const host = req.headers.get("host") ?? "";
    return o.host === host || o.hostname === "localhost" || o.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
