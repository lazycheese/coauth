import { validateResult } from "../_handlers";

export const config = { runtime: "edge" };

export default async function handler(req: Request) {
  const { payer, formFields } = await req.json();
  const { status, body } = validateResult(payer ?? "", formFields ?? {});
  return Response.json(body, { status, headers: { "API-Version": "1.0.0" } });
}
