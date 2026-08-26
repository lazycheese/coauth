import { patientResult } from "../../_handlers";

export const config = { runtime: "edge" };

export default function handler(req: Request) {
  const id = new URL(req.url).pathname.split("/").pop() ?? "";
  const { status, body } = patientResult(id);
  return Response.json(body, { status, headers: { "API-Version": "1.0.0" } });
}
