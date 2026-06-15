import { Chat } from "@/components/chat";
import { StatusPill } from "@/components/status-pill";
import { WarningBanner } from "@/components/warning-banner";

export default function Home() {
  return (
    <div className="flex h-dvh flex-col">
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
        <StatusPill />
      </header>
      <WarningBanner />
      <main className="min-h-0 flex-1">
        <Chat />
      </main>
    </div>
  );
}
