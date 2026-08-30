import { patientResult, payerRulesResult, validateResult } from "./_handlers";
import { patients, payers } from "../src/data/seed";

export const config = { runtime: "edge" };

// MCP server over the Streamable HTTP transport (spec 2025-06-18).
//
// This is a read-only data surface. The interactive workspace tools, the ones
// that fill a form, flag a field or submit, are exposed in the page itself via
// WebMCP, because they act on a live workspace that only exists in the browser.
// A stateless HTTP server has nothing to act on, so it deliberately offers the
// three tools that make sense without a session and says so in its instructions.

const SERVER_INFO = { name: "coauth", title: "CoAuth", version: "1.0.0" };
const LATEST = "2025-06-18";
const SUPPORTED = ["2025-06-18", "2025-03-26"];
/** The spec's fallback when a client sends no version header. */
const ASSUMED_WHEN_ABSENT = "2025-03-26";

const INSTRUCTIONS = [
  "CoAuth prepares health-insurance prior authorizations with a clinician in the loop.",
  "These MCP tools are read-only: they return patient records, payer coverage rules and validation results.",
  "Filling a form, drafting clinician text and submitting happen in the page via WebMCP tools, because they act on a live workspace.",
  "Submission requires an approval minted only for an authenticated clinician session, and cannot be performed through this server.",
].join(" ");

// Derived from the seed data rather than written out here. A hand-maintained
// enum listing two of the three patients meant a model that respected the
// schema could never reach the third, while the endpoint served her happily.
const PATIENT_IDS = Object.keys(patients);
const PAYER_IDS = Object.keys(payers);

const TOOLS = [
  {
    name: "get_patient",
    title: "Get patient record",
    description:
      "Return a patient's clinical record: diagnoses, prior therapies with outcomes, labs and TB screening status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", enum: PATIENT_IDS, description: "Patient identifier." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        dob: { type: "string" },
        memberId: { type: "string" },
        diagnoses: { type: "array", items: { type: "object", properties: { code: { type: "string" }, label: { type: "string" } } } },
        medsTried: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              klass: { type: "string" },
              durationMonths: { type: "number" },
              outcome: { type: "string" },
              result: { type: "string", enum: ["failed", "responded", "ongoing", "unknown"] },
            },
          },
        },
        labs: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, date: { type: "string" }, flag: { type: "string" } } } },
        clinical: {
          type: "object",
          properties: { tbScreen: { type: "string" }, activeInfection: { type: "boolean" }, priorBiologics: { type: "number" } },
        },
      },
      required: ["id", "name", "diagnoses", "medsTried", "labs", "clinical"],
    },
    annotations: { title: "Get patient record", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_payer_rules",
    title: "Get payer coverage rules",
    description:
      "Return an insurer's required fields, numeric coverage criteria and written policy for the requested drug.",
    inputSchema: {
      type: "object",
      properties: {
        payer: { type: "string", enum: PAYER_IDS, description: "Insurer identifier." },
      },
      required: ["payer"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        drug: { type: "string" },
        coveredDrugs: { type: "array", items: { type: "string" } },
        policy: { type: "array", items: { type: "string" } },
        criteria: {
          type: "object",
          properties: { minDmardMonths: { type: "number" }, minDmardCount: { type: "number" }, requiresSpecialist: { type: "boolean" } },
        },
        requiredFields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              type: { type: "string" },
              requiresHumanJudgment: { type: "boolean" },
            },
          },
        },
      },
      required: ["id", "name", "criteria", "requiredFields"],
    },
    annotations: { title: "Get payer coverage rules", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "validate_submission",
    title: "Validate a submission",
    description:
      "Check a set of form fields against a payer's rules and return which fields pass, are missing, are malformed, or need clinician judgment.",
    inputSchema: {
      type: "object",
      properties: {
        payer: { type: "string", enum: PAYER_IDS, description: "Insurer to validate against." },
        formFields: {
          type: "object",
          additionalProperties: true,
          description: 'Field values keyed by field id, for example { "member_id": "UHC-88213" }.',
        },
      },
      required: ["payer", "formFields"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fieldId: { type: "string" },
              label: { type: "string" },
              ok: { type: "boolean" },
              invalid: { type: "boolean" },
              requiresHumanJudgment: { type: "boolean" },
              reason: { type: "string" },
            },
          },
        },
        failCount: { type: "number" },
        judgmentCount: { type: "number" },
        invalidCount: { type: "number" },
        passCount: { type: "number" },
        clearForSignature: { type: "boolean" },
      },
      required: ["results", "failCount", "judgmentCount", "invalidCount", "passCount", "clearForSignature"],
    },
    annotations: { title: "Validate a submission", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** Check arguments against a tool's own declared inputSchema.
 *
 * The server used to coerce whatever arrived - String(args?.id ?? "") - so a
 * call omitting a required property, or passing a string where an object was
 * declared, produced a tool result rather than an error. A schema the server
 * does not itself enforce is a suggestion, and a stricter client would diverge
 * from this one's behaviour for the same call.
 *
 * Deliberately small: this covers the constructs these schemas actually use
 * (required, type, enum, additionalProperties) rather than pretending to be a
 * general JSON Schema validator. */
function schemaViolation(schema: any, args: unknown): string | null {
  if (args === undefined || args === null) {
    return (schema?.required ?? []).length ? `Missing required argument(s): ${schema.required.join(", ")}.` : null;
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    return "Arguments must be a JSON object.";
  }
  const a = args as Record<string, unknown>;

  for (const key of schema?.required ?? []) {
    if (a[key] === undefined || a[key] === null) return `Missing required argument "${key}".`;
  }
  if (schema?.additionalProperties === false) {
    const known = Object.keys(schema.properties ?? {});
    const extra = Object.keys(a).filter((k) => !known.includes(k));
    if (extra.length) return `Unknown argument(s): ${extra.join(", ")}. Accepted: ${known.join(", ")}.`;
  }
  for (const [key, raw] of Object.entries(schema?.properties ?? {})) {
    const spec = raw as any;
    const value = a[key];
    if (value === undefined) continue;
    if (spec.type === "string" && typeof value !== "string") return `"${key}" must be a string.`;
    if (spec.type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
      return `"${key}" must be an object.`;
    }
    if (spec.type === "number" && typeof value !== "number") return `"${key}" must be a number.`;
    if (spec.type === "boolean" && typeof value !== "boolean") return `"${key}" must be a boolean.`;
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      return `"${key}" must be one of: ${spec.enum.join(", ")}.`;
    }
  }
  return null;
}

interface ToolOutcome {
  body: unknown;
  isError: boolean;
  summary: string;
}

function callTool(name: string, args: any): ToolOutcome | null {
  if (name === "get_patient") {
    const r = patientResult(String(args?.id ?? ""));
    const p = r.body as any;
    return {
      body: r.body,
      isError: r.status !== 200,
      summary: r.status === 200
        ? `${p.name}: ${p.diagnoses?.[0]?.label} (${p.diagnoses?.[0]?.code}), ${p.medsTried?.length ?? 0} prior therapy record(s), TB screen ${p.clinical?.tbScreen}.`
        : p?.error?.message ?? "Patient not found.",
    };
  }
  if (name === "get_payer_rules") {
    const r = payerRulesResult(String(args?.payer ?? ""));
    const p = r.body as any;
    return {
      body: r.body,
      isError: r.status !== 200,
      summary: r.status === 200
        ? `${p.name} requires ${p.requiredFields.length} fields for ${p.drug}; criteria: ${p.criteria.minDmardCount} DMARD(s) for ${p.criteria.minDmardMonths}+ months.`
        : p?.error?.message ?? "Payer not found.",
    };
  }
  if (name === "validate_submission") {
    const r = validateResult(String(args?.payer ?? ""), (args?.formFields ?? {}) as Record<string, unknown>);
    const v = r.body as any;
    return {
      body: r.body,
      isError: r.status !== 200,
      summary: r.status === 200
        ? `${Math.max(0, v.failCount - v.invalidCount)} missing, ${v.invalidCount} invalid, ${v.judgmentCount} awaiting clinician judgment.`
        : v?.error?.message ?? "Validation failed.",
    };
  }
  return null;
}

const jsonHeaders = (version: string) => ({
  "content-type": "application/json",
  "MCP-Protocol-Version": version,
  "Cache-Control": "no-store",
});

function rpcResult(id: unknown, result: unknown, version: string) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    status: 200,
    headers: jsonHeaders(version),
  });
}

function rpcError(id: unknown, code: number, message: string, version: string, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), {
    status,
    headers: jsonHeaders(version),
  });
}

/** Origin validation, as the spec requires, to prevent DNS rebinding attacks.
 *
 * This used to allow any host ending in ".vercel.app", which is every
 * deployment on the platform and therefore not a restriction. It now allows
 * this deployment, its preview builds, and local development. */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients send no Origin
  try {
    const url = new URL(origin);
    const host = url.hostname;
    const self = (req.headers.get("host") ?? "").split(":")[0];
    return (
      host === self ||
      host === "coauth.vercel.app" ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      // Preview deployments of this project only, not the whole platform.
      /^coauth-[a-z0-9-]+\.vercel\.app$/.test(host)
    );
  } catch {
    return false;
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (!originAllowed(req)) {
    return new Response(JSON.stringify({ error: "origin not allowed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  // The client MUST send a supported MCP-Protocol-Version on requests after
  // initialization; an unsupported one is a 400.
  const headerVersion = req.headers.get("mcp-protocol-version");
  if (headerVersion && !SUPPORTED.includes(headerVersion)) {
    // JSON-RPC shaped, like every other error this server returns. It was the
    // one path emitting a bare object with a string code.
    return rpcError(
      null,
      -32600,
      `Unsupported MCP-Protocol-Version "${headerVersion}". Supported: ${SUPPORTED.join(", ")}.`,
      LATEST,
      400
    );
  }
  const version = headerVersion ?? ASSUMED_WHEN_ABSENT;

  // We do not offer a server-initiated SSE stream, so the spec says 405.
  if (req.method === "GET" || req.method === "DELETE") {
    return new Response(null, { status: 405, headers: { Allow: "POST", "MCP-Protocol-Version": version } });
  }
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  // The client must state that it accepts JSON. An absent Accept header used to
  // pass, because the check only ran when the header was present.
  const accept = req.headers.get("accept") ?? "";
  if (!accept.includes("application/json") && !accept.includes("*/*")) {
    return new Response(
      JSON.stringify({ error: { code: "not_acceptable", message: "This endpoint returns application/json." } }),
      { status: 406, headers: { "content-type": "application/json" } }
    );
  }

  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error: body is not valid JSON.", version, 400);
  }

  // JSON-RPC batching was removed in 2025-06-18.
  if (Array.isArray(msg)) {
    return rpcError(null, -32600, "Batched requests are not supported in MCP 2025-06-18.", version, 400);
  }
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return rpcError(msg?.id ?? null, -32600, "Invalid Request: expected a JSON-RPC 2.0 message.", version, 400);
  }

  const { id, method, params } = msg;

  // A notification or a response carries no id and gets 202 with no body.
  const isNotification = id === undefined || id === null;
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return new Response(null, { status: 202, headers: { "MCP-Protocol-Version": version } });
  }
  if (method === undefined) {
    return isNotification
      ? new Response(null, { status: 202, headers: { "MCP-Protocol-Version": version } })
      : rpcError(id, -32600, "Invalid Request: missing method.", version, 400);
  }

  switch (method) {
    case "initialize": {
      // Negotiate: honour the client's version when we support it.
      const requested = String(params?.protocolVersion ?? "");
      const agreed = SUPPORTED.includes(requested) ? requested : LATEST;
      return rpcResult(
        id,
        {
          protocolVersion: agreed,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
        agreed
      );
    }

    case "ping":
      return rpcResult(id, {}, version);

    case "tools/list":
      return rpcResult(id, { tools: TOOLS }, version);

    case "tools/call": {
      const name = String(params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        // An unknown tool is a protocol-level error, not a tool result.
        return rpcError(id, -32602, `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}.`, version);
      }
      // Invalid params is likewise a protocol-level error.
      const violation = schemaViolation(tool.inputSchema, params?.arguments);
      if (violation) {
        return rpcError(id, -32602, `Invalid arguments for "${name}": ${violation}`, version);
      }
      const outcome = callTool(name, params?.arguments);
      if (!outcome) {
        return rpcError(id, -32602, `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}.`, version);
      }
      // A tool that ran but failed reports through the result, per the spec.
      //
      // The text block carries the serialized structured result as well as the
      // summary line: a client that reads only `content` used to get a one-line
      // precis and lose every field of the record.
      return rpcResult(
        id,
        {
          content: [
            { type: "text", text: outcome.summary },
            { type: "text", text: JSON.stringify(outcome.body, null, 2) },
          ],
          structuredContent: outcome.body,
          isError: outcome.isError,
        },
        version
      );
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`, version);
  }
}
