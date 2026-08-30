import { useCoAuth } from "../store/coauthStore";
import { tools } from "./tools";
import type { Executor, MaybeModelContextHost, ModelContext, ToolCtx, ToolDef, ToolResult, WebMcpToolPayload } from "./types";

/** Look up a tool by name. Returns undefined rather than throwing so callers
 * can decide; use invokeTool for the common case. */
export function findTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}

/** Invoke a tool by name. A missing tool is a programming error, so it fails
 * loudly here instead of crashing a render through a non-null assertion. */
/** Check an argument object against a tool's declared inputSchema.
 *
 * A page-side runtime is not obliged to validate anything, so a schema only the
 * runtime enforces is enforced at somebody else's discretion. Covers the
 * constructs these schemas actually use rather than pretending to be a general
 * JSON Schema validator. */
function violatesSchema(schema: unknown, args: unknown): string | null {
  const spec = schema as { required?: string[]; properties?: Record<string, { type?: string; enum?: unknown[] }> } | undefined;
  if (!spec) return null;
  const required = spec.required ?? [];
  if (args === undefined || args === null) {
    return required.length ? `missing required argument(s): ${required.join(", ")}` : null;
  }
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const a = args as Record<string, unknown>;
  for (const key of required) {
    if (a[key] === undefined || a[key] === null) return `missing required argument "${key}"`;
  }
  for (const [key, propSpec] of Object.entries(spec.properties ?? {})) {
    const value = a[key];
    if (value === undefined) continue;
    if (propSpec.type === "string" && typeof value !== "string") return `"${key}" must be a string`;
    if (Array.isArray(propSpec.enum) && !propSpec.enum.includes(value)) {
      return `"${key}" must be one of: ${propSpec.enum.join(", ")}`;
    }
  }
  return null;
}

export async function invokeTool(name: string, input: unknown = {}, ctx?: ToolCtx): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) {
    const known = tools.map((t) => t.name).join(", ");
    throw new Error(`Unknown tool "${name}". Registered tools: ${known}`);
  }
  // Enforced here as well as in the schema, so a runtime that passes arguments
  // through unchecked cannot hand a tool something its contract excludes.
  const violation = violatesSchema(tool.inputSchema, input);
  if (violation) {
    useCoAuth.getState().logActivity(ctx?.actor ?? "agent", name, `REFUSED - ${violation}`);
    return {
      status: "refused",
      isError: true,
      summary: `Cannot call ${name}: ${violation}.`,
    } as ToolResult;
  }
  return tool.execute(input, ctx);
}

/** Resolve every WebMCP surface this browser might expose.
 * Spec migrated navigator.modelContext -> document.modelContext (Chrome 150),
 * so we register on whichever exist to survive across browser/agent versions. */
function modelContexts(): ModelContext[] {
  const surfaces: ModelContext[] = [];
  const d = (document as unknown as MaybeModelContextHost).modelContext;
  const n = (navigator as unknown as MaybeModelContextHost).modelContext;
  if (d && typeof d.registerTool === "function") surfaces.push(d as ModelContext);
  if (n && typeof n.registerTool === "function" && n !== d) surfaces.push(n as ModelContext);
  return surfaces;
}

/** Register all tools with WebMCP if available, and always mirror on window for UI + verification. */
// A surface is registered once. Registration is attempted repeatedly, because a
// runtime can attach after the page loads, and a runtime that keeps what it is
// given would otherwise end up holding the same thirteen tools several times
// over. The controller per surface is what lets them be withdrawn again.
const registeredSurfaces = new WeakSet<ModelContext>();
const surfaceControllers = new Map<ModelContext, AbortController>();

/** Withdraw the tools from every surface they were registered on. */
export function unregisterTools() {
  for (const [surface, controller] of surfaceControllers) {
    controller.abort();
    registeredSurfaces.delete(surface);
  }
  surfaceControllers.clear();
  useCoAuth.getState().setWebmcpConnected(false);
}

export async function registerTools() {
  const surfaces = modelContexts();
  const toolPayload = (t: ToolDef): WebMcpToolPayload => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    // WebMCP's ToolAnnotations dictionary carries only readOnlyHint and
    // untrustedContentHint. The MCP-server annotations - title,
    // destructiveHint, idempotentHint, openWorldHint - are not members of it,
    // and WebIDL discards unknown members silently, so sending them achieved
    // nothing except making this look more thorough than it was.
    //
    // untrustedContentHint is the one that matters here and was missing: it
    // marks a tool whose result carries text written by someone other than the
    // page, which is exactly what a chart note or a scanned outside record is.
    annotations: {
      readOnlyHint: t.readOnlyHint,
      untrustedContentHint: t.untrustedContentHint ?? false,
    },
    // The runtime serializes whatever execute returns, so the summary and the
    // structured object both travel. The summary leads because a sentence is
    // cheaper to read than a JSON blob and says what to do next.
    execute: async (input: unknown) => {
      const result = await t.execute(input);
      const { summary, ...rest } = result as { summary?: string };
      return {
        content: [{ type: "text", text: summary ?? JSON.stringify(rest) }],
        structuredContent: result,
        // A refusal is an error from the caller's point of view: the call did
        // not do what was asked and must not be retried unchanged. "blocked" is
        // different - it is a deliberate outcome of a correct call, so it is
        // not flagged, and the summary tells the agent what to do next.
        isError:
          (result as { status?: string }).status === "error" ||
          (result as { status?: string }).status === "refused" ||
          (result as { isError?: boolean }).isError === true,
      };
    },
  });
  let registered = 0;
  const failures: string[] = [];
  const fresh = surfaces.filter((md) => !registeredSurfaces.has(md));

  for (const md of fresh) {
    const controller = new AbortController();
    let acceptedAll = true;
    for (const t of tools) {
      try {
        // registerTool returns a promise and rejects on a duplicate name, an
        // invalid descriptor or an already-aborted signal. Calling it without
        // awaiting counted a rejection as a success and raised an unhandled
        // rejection, so a page could report itself connected over a
        // registration the runtime had refused.
        await md.registerTool(toolPayload(t), { signal: controller.signal });
        registered++;
      } catch (e) {
        // A surface rejected this tool shape. Record it: a partial registration
        // must never be reported to the user as "connected".
        acceptedAll = false;
        failures.push(`${t.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Only remember a surface that took everything, so a partial attempt can be
    // retried without the successful half being registered twice.
    if (acceptedAll) {
      registeredSurfaces.add(md);
      surfaceControllers.set(md, controller);
    } else {
      controller.abort();
    }
  }

  const expected = fresh.length * tools.length;
  const alreadyDone = surfaces.length > 0 && fresh.length === 0;
  const fullyRegistered = alreadyDone || (expected > 0 && registered === expected);
  // Development-only inspection surface. Production ships no handle to the
  // store or to the tool executors: the app drives itself through the action
  // layer, so nothing in the product depends on this existing.
  if (import.meta.env.DEV) {
    const mirror: Record<string, Executor> = {};
    for (const t of tools) mirror[t.name] = t.execute;
    const w = window as unknown as Record<string, unknown> & { __coauth?: Record<string, unknown> };
    w.__coauth = w.__coauth ?? {};
    // Assign props (do NOT spread - that would snapshot the `state` getter).
    w.__coauth.tools = mirror;
    w.__coauth.webmcp = fullyRegistered;
    w.__coauth.surfaces = surfaces.length;
    w.__coauth.registeredCount = registered;
    w.__coauth.expectedCount = expected;
    w.__coauth.registrationFailures = failures;
    w.__coauth.toolCount = tools.length;
    w.__coauth._registerTools = registerTools;
  }
  if (failures.length) {
    useCoAuth.getState().setToast(`WebMCP registration incomplete: ${failures.length} tool(s) rejected.`);
  }
  // Report the count a runtime actually accepted, so a partial registration is
  // not displayed as the full set. Per surface, since a second surface
  // registering the same tools is not thirteen more tools.
  const acceptedHere = fresh.length ? Math.round(registered / fresh.length) : null;
  useCoAuth.getState().setWebmcpConnected(fullyRegistered, acceptedHere ?? undefined);
  return fullyRegistered;
}

/** Keep looking for a model-context surface.
 *
 * A runtime can attach at any point - a judge enabling an agent panel after
 * reading the page, an extension loading late - so giving up after a fixed
 * window left the page permanently toolless with no way back. After the initial
 * fast attempts this drops to a slow poll and keeps going for the life of the
 * page; registration is idempotent per surface, so a late success costs nothing
 * and a surface is never registered twice. */
export function registerToolsWithRetry() {
  let tries = 0;
  let id: ReturnType<typeof setInterval>;

  const attempt = async () => {
    // Each attempt only touches surfaces not already registered, so polling for
    // a late-arriving runtime cannot duplicate tools on one that answered.
    if (await registerTools()) {
      clearInterval(id);
      return true;
    }
    return false;
  };

  void registerTools().then((done) => {
    if (done) return;
    id = setInterval(() => {
      tries++;
      void attempt().then((ok) => {
        if (ok || tries < 20) return;
        clearInterval(id);
        // Ten seconds covers a runtime that is merely slow. Past that it is
        // more likely one that has not attached yet, so keep a cheap watch open
        // rather than deciding this page will never have tools.
        id = setInterval(() => void attempt(), 5000);
      });
    }, 500);
  });
}

