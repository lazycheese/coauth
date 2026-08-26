import { patientResult, payerRulesResult, validateResult } from "./_handlers";

export const config = { runtime: "edge" };

// Minimal MCP server over Streamable HTTP (JSON-RPC 2.0 on a single endpoint).
// Exposes the read-only CoAuth data tools so agents can call them natively.
const SERVER_INFO = { name: "coauth", version: "1.0.0" };
const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "get_patient",
    description: "Get a seeded patient's clinical record. ids: jane-doe, marcus-lee.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", enum: ["jane-doe", "marcus-lee"] } },
      required: ["id"],
    },
  },
  {
    name: "get_payer_rules",
    description: "Get a payer's required fields and coverage policy. payers: uhc, aetna, cigna.",
    inputSchema: {
      type: "object",
      properties: { payer: { type: "string", enum: ["uhc", "aetna", "cigna"] } },
      required: ["payer"],
    },
  },
  {
    name: "validate_submission",
    description: "Validate form fields against a payer's rules; returns a pass/fail summary.",
    inputSchema: {
      type: "object",
      properties: {
        payer: { type: "string", enum: ["uhc", "aetna", "cigna"] },
        formFields: { type: "object", additionalProperties: true },
      },
      required: ["payer", "formFields"],
    },
  },
];

function callTool(name: string, args: any) {
  if (name === "get_patient") return patientResult(args?.id ?? "");
  if (name === "get_payer_rules") return payerRulesResult(args?.payer ?? "");
  if (name === "validate_submission") return validateResult(args?.payer ?? "", args?.formFields ?? {});
  return { status: 404, body: { error: { code: "unknown_tool", message: `No tool "${name}"` } } };
}

function rpc(id: unknown, result?: unknown, error?: { code: number; message: string }) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", id: id ?? null };
  if (error) body.error = error;
  else body.result = result;
  return Response.json(body, { headers: { "MCP-Protocol-Version": PROTOCOL_VERSION } });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "GET") {
    // Advertise the endpoint for discovery; no server-initiated SSE stream here.
    return Response.json(
      { transport: "streamable-http", protocolVersion: PROTOCOL_VERSION, serverInfo: SERVER_INFO, endpoint: "/.well-known/mcp" },
      { headers: { "MCP-Protocol-Version": PROTOCOL_VERSION } }
    );
  }
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return rpc(null, undefined, { code: -32700, message: "Parse error" });
  }

  const { id, method, params } = msg || {};
  switch (method) {
    case "initialize":
      return rpc(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: "Read-only CoAuth data tools. See https://coauth.vercel.app/AGENTS.md",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return new Response(null, { status: 202 });
    case "ping":
      return rpc(id, {});
    case "tools/list":
      return rpc(id, { tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args } = params || {};
      const { body } = callTool(name, args);
      return rpc(id, {
        content: [{ type: "text", text: JSON.stringify(body) }],
        structuredContent: body,
        isError: !!(body as any)?.error,
      });
    }
    default:
      return rpc(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  }
}
