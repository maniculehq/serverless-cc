// Persistent research/attribution notice shown under the header. Not dismissible
// (a legal/attribution disclaimer should stay visible). Server component — no state.
import { InfoIcon } from "lucide-react";

export function DisclaimerBanner() {
  return (
    <div className="shrink-0 border-border/70 border-b bg-muted/20 px-4 py-2.5 sm:px-7">
      <div className="mx-auto flex max-w-3xl items-start gap-2.5">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
        <p className="min-w-0 flex-1 text-muted-foreground text-[12px] leading-relaxed">
          This project is for research and educational purposes only. Claude and
          Claude Code are exclusive property of Anthropic PBC and/or its affiliates.
        </p>
      </div>
    </div>
  );
}
