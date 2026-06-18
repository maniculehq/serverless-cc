// Browser auth client. Import ONLY from client components — `better-auth/react`
// pulls in React hooks/stores and must not be evaluated on the server.
// baseURL is inferred from window.location.origin, so same-origin usage needs no
// config. GitHub is the only configured provider (see lib/auth.ts).
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;
