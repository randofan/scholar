// Cloudflare Workers bindings (R2, Workers AI) captured from the worker's
// fetch entrypoint (src/server.ts) into a module singleton, so server-side
// code anywhere in the app can reach them without threading `env` through
// every call site. Structural types keep us off @cloudflare/workers-types.

export interface R2ObjectBodyLike {
  text(): Promise<string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: string): Promise<unknown>;
}

export interface WorkersAiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface CfBindings {
  /** R2 bucket holding the generator skill files (wrangler.jsonc binding "SKILLS"). */
  SKILLS?: R2BucketLike;
  /** Workers AI binding (wrangler.jsonc binding "AI"), used to distill lessons into skills. */
  AI?: WorkersAiLike;
}

let bindings: CfBindings = {};

/** Called once per request from the worker fetch handler with the live env. */
export function setCfBindings(env: unknown) {
  if (env && typeof env === "object") bindings = env as CfBindings;
}

export function getCfBindings(): CfBindings {
  return bindings;
}
