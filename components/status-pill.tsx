"use client";

// At-a-glance backend health, read from GET /api/agent on mount.
import { useEffect, useState } from "react";

type Health = {
  ok: boolean;
  backend: string;
  cliExists: boolean;
  anthropic: boolean;
  runtime: string;
};

const pill =
  "inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em]";

export function StatusPill() {
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/agent")
      .then((r) => r.json())
      .then((h) => alive && setHealth(h))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return (
      <span className={`${pill} border-destructive/40 text-destructive`}>
        <span className="size-1.5 rounded-full bg-destructive" />
        offline
      </span>
    );
  }
  if (!health) {
    return (
      <span className={`${pill} text-muted-foreground`}>
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
        booting
      </span>
    );
  }

  const ready = health.cliExists && health.anthropic;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <span className={`${pill} text-foreground/80`}>
        <span
          className={
            ready
              ? "size-1.5 rounded-full bg-ember shadow-[0_0_8px] shadow-ember/70"
              : "size-1.5 rounded-full bg-destructive"
          }
        />
        {health.backend}
      </span>
      <span className={`${pill} text-muted-foreground`}>{health.runtime}</span>
      {!health.anthropic && (
        <span className={`${pill} border-destructive/40 text-destructive`}>
          no model key
        </span>
      )}
      {!health.cliExists && (
        <span className={`${pill} border-destructive/40 text-destructive`}>
          no cli
        </span>
      )}
    </div>
  );
}
