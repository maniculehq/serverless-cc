"use client";

// Prominent, dismissible safety notice. Re-shows on reload by design — this is an
// experimental app with a SHARED, non-persisted workspace.
import { useState } from "react";
import { TriangleAlertIcon, XIcon } from "lucide-react";

export function WarningBanner() {
  const [open, setOpen] = useState(true);
  if (!open) {
    return null;
  }

  return (
    <div className="shrink-0 border-amber-500/25 border-b bg-amber-500/10 px-4 py-3.5 sm:px-7">
      <div className="mx-auto flex max-w-3xl items-start gap-3">
        <TriangleAlertIcon className="mt-0.5 size-5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="font-mono font-semibold text-[11px] text-amber-300 uppercase tracking-[0.1em]">
            Experimental · not private · no persistence
          </p>
          <p className="mt-1.5 text-amber-100/85 text-sm leading-relaxed">
            Conversations are <strong className="font-semibold">not saved</strong> and
            reset on reload. The{" "}
            <span className="rounded bg-amber-500/15 px-1 py-0.5 font-mono text-[0.85em]">
              /workspace
            </span>{" "}
            filesystem is <strong className="font-semibold">shared by everyone</strong>{" "}
            using this app — anything you create can be read, changed, or deleted by
            other visitors. Don&apos;t put anything sensitive here.
          </p>
        </div>
        <button
          aria-label="Dismiss warning"
          className="-mr-1 shrink-0 rounded-md p-1 text-amber-300/70 transition-colors hover:bg-amber-500/15 hover:text-amber-200"
          onClick={() => setOpen(false)}
          type="button"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
