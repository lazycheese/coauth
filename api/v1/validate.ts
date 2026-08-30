import { validateResult } from "../_handlers";

export const config = { runtime: "edge" };

export default async function handler(req: Request) {
  // Every sibling handler wraps this and returns a typed JSON error; this one
  // threw a platform 500 with an HTML shell, contradicting the promise that the
  // API always answers in JSON.
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: { code: "invalid_json", message: "Body must be JSON.", hint: "POST { payer, formFields }." } },
      { status: 400, headers: { "API-Version": "1.0.0" } }
    );
  }
  const result = validateResult(String(body?.payer ?? ""), body?.formFields ?? {});
  return Response.json(result.body, { status: result.status, headers: { "API-Version": "1.0.0" } });
}
