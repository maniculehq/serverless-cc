import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The agent backend (app/api/agent) drives the extracted Claude Code bundle via
  // the Agent SDK, which spawns `bin/cli.js` as a subprocess and uses dynamic
  // requires / wasm. Keep these out of the bundler so they run as plain node_modules.
  // `zod` is here (not just the SDK/just-bash/disk) because the agent runner +
  // worker are loaded from disk AT RUNTIME (see route.ts) and re-import
  // mcp-tools.mjs → which imports `zod`. If zod were bundled into the route
  // chunk it would be absent from node_modules, and the runtime import would
  // fail to resolve it. Keeping it external leaves it in node_modules where the
  // file tracer (anchored by route.ts's static mcp-tools import) picks it up.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk", "just-bash", "disk", "zod"],

  // Files loaded at runtime via process.cwd() (dynamic paths the file tracer
  // can't see) must be forced into the route handler's deployment bundle:
  //   - bin/cli.js   the extracted Claude Code bundle the worker spawns
  //   - lib/**       the worker entry (agent-worker.mjs) + its app-code imports
  //                  (mcp-tools / fs-backend / disk-fs). The worker is referenced
  //                  only by a runtime path string, so the tracer never sees it,
  //                  and outputFileTracingIncludes is a literal copy-glob that
  //                  does NOT recurse imports — hence the whole ./lib/** tree.
  // The worker's node_modules deps (SDK / just-bash / disk) are traced normally:
  // lib/agent-runner.mjs (in the route's static import graph) imports mcp-tools.mjs,
  // which pulls those package trees in.
  // (`includeFiles` in vercel.json is ignored for Next.js — this is the supported way.)
  outputFileTracingIncludes: {
    "/api/agent": ["./bin/**", "./lib/**"],
  },
};

export default nextConfig;
