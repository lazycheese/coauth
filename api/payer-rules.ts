import { payerRulesResult } from "./_handlers";

export const config = { runtime: "edge" };

export default function handler(req: Request) {
  const payer = new URL(req.url).searchParams.get("payer") ?? "";
  const { status, body } = payerRulesResult(payer);
  return Response.json(body, { status });
}
