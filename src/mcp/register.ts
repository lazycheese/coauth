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
export async function invokeTool(name: string, input: unknown = {}, ctx?: ToolCtx): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) {
    const known = tools.map((t) => t.name).join(", ");
    throw new Error(`Unknown tool "${name}". Registered tools: ${known}`);
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

export function registerTools() {
  const surfaces = modelContexts();
  const toolPayload = (t: ToolDef): WebMcpToolPayload => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: t.readOnlyHint,
      destructiveHint: t.destructiveHint ?? false,
      idempotentHint: t.idempotentHint ?? t.readOnlyHint,
      openWorldHint: false,
    },
    // Agents read content[0].text. Handing them raw JSON is worse for
    // comprehension and costs more tokens than a sentence, so the summary goes
    // in the text and the machine-readable object goes in structuredContent.
    execute: async (input: unknown) => {
      const result = await t.execute(input);
      const { summary, ...rest } = result as { summary?: string };
      return {
        content: [{ type: "text", text: summary ?? JSON.stringify(rest) }],
        structuredContent: result,
        isError: (result as { status?: string }).status === "error",
        // "blocked" is a deliberate outcome, not a failure, so it is not
        // flagged as an error; the summary tells the agent what to do next.
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
        md.registerTool(toolPayload(t), { signal: controller.signal });
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
  useCoAuth.getState().setWebmcpConnected(fullyRegistered);
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
  if (registerTools()) return;
  let tries = 0;
  let id = setInterval(fast, 500);

  function fast() {
    tries++;
    // Each attempt only touches surfaces not already registered, so polling for
    // a late-arriving runtime cannot duplicate tools on one that answered.
    if (registerTools()) return clearInterval(id);
    if (tries >= 20) {
      clearInterval(id);
      // Ten seconds covers a runtime that is merely slow. Past that it is more
      // likely one that has not attached yet, so keep a cheap watch open rather
      // than deciding this page will never have tools.
      id = setInterval(() => {
        if (registerTools()) clearInterval(id);
      }, 5000);
    }
  }
}

