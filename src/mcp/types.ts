export type ToolResult = Record<string, unknown>;

/** Who initiated this call. WebMCP runtimes pass no context, so an agent call
 * defaults to "agent"; UI call sites pass { actor: "human" } explicitly. */
export interface ToolCtx {
  actor?: "agent" | "human";
}

/** Each tool knows its own input shape and the registry holds all of them, so
 * the input stays permissive here. TypeScript cannot express "whatever this
 * particular tool takes" across a heterogeneous list without a generic per
 * entry, and pretending otherwise would push casts onto every executor. The
 * shape that does matter, what a runtime is handed, is typed below. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Executor = (input: any, ctx?: ToolCtx) => Promise<ToolResult> | ToolResult;

export const actorOf = (ctx?: ToolCtx): "agent" | "human" => ctx?.actor ?? "agent";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  readOnlyHint: boolean;
  /** Changes state a person would care about; a runtime may confirm first. */
  destructiveHint?: boolean;
  /** Calling twice with the same input has the same effect as calling once. */
  idempotentHint?: boolean;
  execute: Executor;
}

/** What a runtime is handed when a tool is registered. */
export interface WebMcpToolPayload {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  execute: (input: unknown) => Promise<{
    content: { type: "text"; text: string }[];
    structuredContent: ToolResult;
    isError: boolean;
  }>;
}

/** The registration surface a browser or agent runtime exposes.
 *
 * Typed rather than left as any, because this is the one boundary that cannot
 * be exercised against a real runtime from here: if the shape is wrong the
 * tools simply do not appear, so the compiler should be the thing that notices.
 */
export interface ModelContext {
  /** The signal, where a runtime supports it, is how a tool is withdrawn. */
  registerTool(tool: WebMcpToolPayload, options?: { signal?: AbortSignal }): void;
}

/** A window or document that may carry a WebMCP runtime. */
export interface MaybeModelContextHost {
  modelContext?: Partial<ModelContext>;
}
