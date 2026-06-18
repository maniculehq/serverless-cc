// Server-only Better Auth instance. GitHub OAuth is the ONLY sign-in method —
// email/password is left disabled (it's off unless `emailAndPassword.enabled`).
//
// Storage: PlanetScale Postgres via a node-postgres pool. Better Auth's built-in
// (Kysely) adapter speaks Postgres directly, so no ORM is needed. The Pool is a
// module-level singleton: under Vercel Fluid Compute one warm instance serves
// many concurrent invocations, so we want ONE pool per instance, not per request.
// Prefer PlanetScale's PgBouncer endpoint (port 6432) in DATABASE_URL so a fleet
// of warm instances doesn't exhaust the cluster's connection limit.
//
// Required env (see .env.example) is declared + validated with t3-env in
// lib/env.ts, which fails loud on misconfiguration at request time:
//   DATABASE_URL          PlanetScale Postgres URL (…?sslmode=verify-full)
//   GITHUB_CLIENT_ID      GitHub OAuth app client id
//   GITHUB_CLIENT_SECRET  GitHub OAuth app client secret
//   BETTER_AUTH_SECRET    >=32-char secret  (openssl rand -base64 32)
//   BETTER_AUTH_URL       deployment origin (http://localhost:3000 in dev)
// `secret` is read automatically by Better Auth from BETTER_AUTH_SECRET (still
// validated via env). `baseURL` is set explicitly below (from BETTER_AUTH_URL) so
// the GitHub callback origin is deterministic across prod/preview deployments.
//
// After changing this config (adding a provider/plugin), re-create the tables:
//   npx @better-auth/cli@latest migrate
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { Pool, type PoolConfig } from "pg";
import { env } from "@/lib/env";

// PlanetScale's connection string carries libpq's `sslrootcert=system` ("use the
// OS trust store"), but node-postgres' parser (pg-connection-string) doesn't
// understand it — it tries to read a file literally named "system" → ENOENT.
// Since PlanetScale uses publicly-trusted certs, strip the URL's SSL params and
// verify against Node's built-in CA store instead. `rejectUnauthorized: true` is
// full verification — equivalent to the `verify-full` the URL asked for.
function pgPoolConfig(databaseUrl: string): PoolConfig {
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslrootcert");
  url.searchParams.delete("sslmode");
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true } };
}

export const auth = betterAuth({
  appName: "serverless-cc",
  // Explicit so the OAuth callback origin is deterministic, not header-derived.
  baseURL: env.BETTER_AUTH_URL,
  database: new Pool(pgPoolConfig(env.DATABASE_URL)),
  socialProviders: {
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    },
  },
  // nextCookies() must be the LAST plugin: it forwards Set-Cookie headers from
  // server-side auth calls (e.g. signOut) onto the Next.js response.
  plugins: [nextCookies()],
});
