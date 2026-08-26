export const config = { runtime: "edge" };

// Catch-all for unknown /api/* paths - always JSON, never an HTML shell.
export default function handler(req: Request) {
  const path = new URL(req.url).pathname;
  return Response.json(
    {
      error: {
        code: "not_found",
        message: `No API route at ${path}.`,
        hint: "See /openapi.json. Routes: /api/patient/{id}, /api/payer-rules?payer=, POST /api/validate.",
      },
    },
    { status: 404 }
  );
}
