import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The agent backend (app/api/agent) drives the extracted Claude Code bundle via
  // the Agent SDK, which spawns `bin/cli.js` as a subprocess and uses dynamic
  // requires / wasm. Keep these out of the bundler so they run as plain node_modules.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk", "just-bash", "disk"],

  // `bin/cli.js` is loaded at runtime via process.cwd() (a dynamic path the file
  // tracer can't see), so force it into the route handler's deployment bundle.
  // (`includeFiles` in vercel.json is ignored for Next.js — this is the supported way.)
  outputFileTracingIncludes: {
    "/api/agent": ["./bin/**"],
  },
};

export default nextConfig;
