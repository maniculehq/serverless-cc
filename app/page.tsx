import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Chat } from "@/components/chat";
import { StatusPill } from "@/components/status-pill";
import { UserMenu } from "@/components/user-menu";
import { DisclaimerBanner } from "@/components/disclaimer-banner";
import { auth } from "@/lib/auth";

export default async function Home() {
  // Validated, server-side auth gate (the middleware redirect is only optimistic).
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  return (
    <div className="relative flex h-dvh flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-border/70 border-b px-5 py-3 sm:px-7">
        <div className="flex items-center gap-3">
          <div className="ember-glow flex size-9 items-center justify-center rounded-md border border-ember/40 bg-ember/10 font-mono text-[15px] text-ember">
            <span aria-hidden>&gt;_</span>
          </div>
          <div className="leading-tight">
            <h1 className="font-mono font-semibold text-[13px] tracking-tight">
              serverless<span className="text-ember">-cc</span>
            </h1>
            <p className="font-mono text-[11px] text-muted-foreground">
              claude code · vercel bun · isolated /workspace
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill />
          <UserMenu user={session.user} />
        </div>
      </header>
      <DisclaimerBanner />
      <main className="min-h-0 flex-1">
        <Chat />
      </main>
      <footer className="pointer-events-none absolute right-4 bottom-1.5 z-50 sm:right-7">
        <p className="pointer-events-auto font-mono text-[10px] text-muted-foreground/60">
          Built by{" "}
          <a
            className="text-muted-foreground underline-offset-2 transition-colors hover:text-ember hover:underline"
            href="https://x.com/shreyansj"
            rel="noopener noreferrer"
            target="_blank"
          >
            Shreyans
          </a>{" "}
          @{" "}
          <a
            className="text-muted-foreground underline-offset-2 transition-colors hover:text-ember hover:underline"
            href="https://manicule.dev"
            rel="noopener noreferrer"
            target="_blank"
          >
            Manicule
          </a>
        </p>
      </footer>
    </div>
  );
}
