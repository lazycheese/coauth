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
    return Response.json(
      { status: "anonymous", clinicians: Object.values(CLINICIANS).map((c) => ({ id: c.id, name: c.name, role: c.role })) },
      { status: 200, headers: H }
    );
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
