import { readSession, sessionCookie, CLINICIANS } from "../_session";

export const config = { runtime: "edge" };

const H = { "API-Version": "1.0.0", "Cache-Control": "no-store" };

/** Who is signed in, and end the session.
 *
 * GET is what the page calls on load to decide whether to show the sign-in
 * panel or the review panel. DELETE signs out. */
export default async function handler(req: Request): Promise<Response> {
  if (req.method === "DELETE") {
    return Response.json({ status: "signed_out" }, { status: 200, headers: { ...H, "Set-Cookie": sessionCookie("", 0) } });
  }
  if (req.method !== "GET") {
    return Response.json(
      { error: { code: "method_not_allowed", message: "Use GET or DELETE.", hint: "GET reads the session; DELETE ends it." } },
      { status: 405, headers: { ...H, Allow: "GET, DELETE" } }
    );
  }

  const session = await readSession(req);
  if (!session) {
    // Deliberately no directory. Handing the full list of valid clinician ids
    // to anonymous callers supplied exactly the input the login throttle exists
    // to defend against - the two controls were working against each other.
    // The sign-in control asks for the id, the way a sign-in normally does.
    return Response.json({ status: "anonymous" }, { status: 200, headers: H });
  }
  return Response.json(
    {
      status: "authenticated",
      clinician: { id: session.sub, name: session.name, npi: session.npi, role: session.role },
      expiresAt: new Date(session.exp).toISOString(),
    },
    { status: 200, headers: H }
  );
}
