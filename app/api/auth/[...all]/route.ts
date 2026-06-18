// Better Auth mounts every endpoint it needs under /api/auth/* — the GitHub
// OAuth start + callback (/api/auth/callback/github), session lookup, and
// sign-out. `toNextJsHandler` adapts the framework-agnostic handler to the App
// Router's GET/POST exports.
//
// Runs on the Node/Bun runtime (NOT edge): better-auth + pg need node APIs. On
// Vercel this becomes the Bun runtime via vercel.json's `bunVersion`.
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const runtime = "nodejs";

export const { GET, POST } = toNextJsHandler(auth);
