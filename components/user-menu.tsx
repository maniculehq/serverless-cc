"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOutIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";

type Props = {
  user: { name?: string | null; email?: string | null };
};

function initials(name?: string | null, email?: string | null) {
  const src = name?.trim() || email?.trim() || "?";
  const parts = src.split(/\s+/).filter(Boolean);
  const chars =
    parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : src.slice(0, 2);
  return chars.toUpperCase();
}

export function UserMenu({ user }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const signOut = async () => {
    setPending(true);
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          router.push("/sign-in");
          router.refresh();
        },
        onError: () => setPending(false),
      },
    });
  };

  const label = user.name?.trim() || user.email?.trim() || "Account";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="ember-glow flex size-7 items-center justify-center rounded-full border border-ember/40 bg-ember/10 font-mono text-[11px] font-semibold text-ember outline-none transition-colors hover:bg-ember/20 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {initials(user.name, user.email)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate font-mono text-[12px] text-foreground normal-case">
            {label}
          </span>
          {user.email && user.email !== label && (
            <span className="truncate font-mono text-[11px] text-muted-foreground normal-case">
              {user.email}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={pending}
          onSelect={(e) => {
            // Keep the menu's selection from closing before signOut resolves.
            e.preventDefault();
            void signOut();
          }}
        >
          <LogOutIcon />
          {pending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
