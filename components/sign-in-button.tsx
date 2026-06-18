"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

// lucide-react (pinned here) no longer ships brand glyphs, so the GitHub mark is
// inlined. Button auto-sizes child svgs to size-4.
function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.74.5 12.04c0 5.1 3.29 9.41 7.86 10.94.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.55-3.88-1.55-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.2 1.77 1.2 1.03 1.78 2.7 1.27 3.36.97.1-.75.4-1.27.73-1.56-2.55-.29-5.24-1.29-5.24-5.74 0-1.27.45-2.3 1.19-3.12-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.19a11 11 0 0 1 5.79 0c2.2-1.5 3.17-1.19 3.17-1.19.63 1.59.23 2.76.11 3.05.74.82 1.19 1.85 1.19 3.12 0 4.46-2.69 5.44-5.25 5.73.41.36.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.68.8.56A10.96 10.96 0 0 0 23.5 12.04C23.5 5.74 18.27.5 12 .5Z" />
    </svg>
  );
}

export function SignInButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signInWithGitHub = async () => {
    setPending(true);
    setError(null);
    await authClient.signIn.social(
      { provider: "github", callbackURL: "/" },
      {
        // On success the browser is redirected to GitHub, so `pending` stays
        // true until navigation. Only reset it (and surface a message) on error.
        onError: ({ error }) => {
          setError(error.message || "Sign-in failed. Try again.");
          setPending(false);
        },
      },
    );
  };

  return (
    <div className="flex flex-col items-stretch gap-2">
      <Button onClick={signInWithGitHub} disabled={pending} size="lg">
        {pending ? <Spinner /> : <GitHubMark />}
        Sign in with GitHub
      </Button>
      {error && (
        <p className="text-center font-mono text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
