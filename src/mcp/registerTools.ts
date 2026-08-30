// Entry point for the WebMCP surface, kept so call sites import one place.
//
// types.ts   what a tool and the runtime surface are
// tools.ts   the tools themselves
// register.ts    registering them and invoking them by name
export * from "./types";
export * from "./tools";
export * from "./register";
