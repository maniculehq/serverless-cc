import { createEnv } from "@t3-oss/env-nextjs";
import * as z from "zod";

// Type-safe, validated environment for the auth layer. Validation runs when this
// module is first imported — i.e. on the server at request time (cold start) —
// and is skipped during `next build` so an unfilled .env doesn't break
// compilation. `emptyStringAsUndefined` makes a blank `FOO=` in .env count as
// missing rather than a present empty string, so the messages stay accurate.
//
// Importing `env` instead of reading process.env gives us fail-loud config and
// real `string` types (no `as string` casts): a missing GITHUB_* would otherwise
// surface as a malformed OAuth `client_id=undefined`, a missing DATABASE_URL as
// an opaque pg ECONNREFUSED.
export const env = createEnv({
  server: {
    // PlanetScale Postgres connection string (postgresql://… is a valid URL).
    DATABASE_URL: z.url(),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z
      .url()
      .refine(
        (url) =>
          process.env.NODE_ENV !== "production" ||
          !/localhost|127\.0\.0\.1/.test(url),
        "BETTER_AUTH_URL must be the deployment origin in production, not localhost — the GitHub OAuth callback won't match otherwise",
      ),
  },
  // No NEXT_PUBLIC_* client vars; server vars are read straight from process.env.
  experimental__runtimeEnv: {},
  // Validate at runtime, but not during the production build (env may be absent
  // there); the server still validates on first request.
  skipValidation: process.env.NEXT_PHASE === "phase-production-build",
  emptyStringAsUndefined: true,
});
