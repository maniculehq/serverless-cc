import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Next 16's `proxy` convention (formerly `middleware`). Optimistic auth gate:
// this only checks for the PRESENCE of the session cookie (no DB read), so it
// stays cheap on the edge and gives unauthenticated visitors an instant redirect
// to /sign-in. It is NOT a security boundary — the real, validated checks live
// server-side in the protected page (app/page.tsx) and the agent API route
// (app/api/agent/route.ts), which verify the session against the database.
export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Match everything EXCEPT: the auth API (would block the OAuth callback),
  // other API routes (they answer with 401 JSON, not an HTML redirect), the
  // sign-in page (would redirect-loop), and Next internals / static assets.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sign-in).*)"],
};
